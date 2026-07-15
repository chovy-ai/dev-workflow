import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, type GroupRecord, type RunConfig, type RunRecord } from './types';
import { Store } from './store';
import { Pipeline } from './pipeline';
import { git } from './exec';

/**
 * Next.js 开发模式会按需重编译模块；用 globalThis 缓存保证
 * Store（含事件总线）与推进锁在整个 node 进程内是同一份。
 */
type G = typeof globalThis & { __shipStore?: Store; __shipAdvancing?: Set<string> };
const g = globalThis as G;

export function getStore(): Store {
  if (!g.__shipStore) g.__shipStore = new Store();
  return g.__shipStore;
}

function advancing(): Set<string> {
  if (!g.__shipAdvancing) g.__shipAdvancing = new Set();
  return g.__shipAdvancing;
}

/** 异步推进流水线（同一 run 不并发）。fire-and-forget，进度看事件流。 */
export function advance(run: RunRecord): boolean {
  const lock = advancing();
  if (lock.has(run.id)) return false;
  lock.add(run.id);
  new Pipeline(run, getStore()).advance().finally(() => lock.delete(run.id));
  return true;
}

export function isAdvancing(runId: string): boolean {
  return advancing().has(runId);
}

/**
 * 单仓创建前置校验（是 git 仓库）。组创建与单仓创建共用这套校验，保证组的原子创建与单仓语义一致。
 * 通过则返回 git toplevel 路径。
 * 同仓库允许多条 run 并行——每条 run 各自建独立 worktree，互不碰原仓库工作目录；
 * 分支名带随机后缀（见 pipeline.branchName），避免并行 run 撞名。
 */
export async function validateRepoForRun(
  repoPath: string,
): Promise<{ repo?: string; error?: string; status: number }> {
  const top = await git(repoPath, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) return { error: `${repoPath} 不是 git 仓库`, status: 400 };
  return { repo: top.out, status: 200 };
}

/** 组装 run 配置：请求体 > 仓库 ship.config.json > 默认 */
function buildConfig(repo: string, override?: Partial<RunConfig>): RunConfig {
  let repoCfg: Partial<RunConfig> = {};
  const cfgFile = path.join(repo, 'ship.config.json');
  if (fs.existsSync(cfgFile)) {
    try {
      repoCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch {
      /* 配置损坏则忽略 */
    }
  }
  const config: RunConfig = { ...DEFAULT_CONFIG, ...repoCfg, ...override };
  config.engines = {
    ...DEFAULT_CONFIG.engines,
    ...(repoCfg.engines ?? {}),
    ...(override?.engines ?? {}),
  };
  return config;
}

/** 配置里引用了未定义的 engine 名则返回错误文案（创建时拦截，别等跑到一半才 Halt） */
function unknownEngineError(config: RunConfig): string | null {
  const referenced = [
    config.engine,
    ...Object.values(config.stageEngines ?? {}),
    ...config.reviewEngines,
  ];
  const bad = referenced.find((n) => !config.engines[n]);
  return bad ? `未知 engine：${bad}（可用：${Object.keys(config.engines).join(' / ')}）` : null;
}

/** 落盘一条新 run 并异步推进（repo 须已通过 validateRepoForRun 校验、config 已 buildConfig+校验） */
function startRun(input: {
  repo: string;
  plan: string;
  title?: string;
  groupId?: string;
  config: RunConfig;
}): RunRecord {
  const store = getStore();
  const now = new Date().toISOString();
  const firstLine = input.plan.split('\n').find((l) => l.trim());
  const run: RunRecord = {
    id: `r-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    title: input.title ?? firstLine?.replace(/^#+\s*/, '').slice(0, 60) ?? 'ship run',
    repoPath: input.repo,
    branch: null,
    worktreePath: null,
    groupId: input.groupId,
    plan: input.plan,
    stage: 'worktree',
    status: 'running',
    statusDetail: '',
    reviewRound: 0,
    findings: [],
    prUrl: null,
    sdkSessions: {},
    createdAt: now,
    updatedAt: now,
    config: input.config,
  };
  store.save(run);
  store.event(run, 'log', { msg: `运行创建：${run.title}（${input.repo}）` });
  advance(run);
  return run;
}

export async function createRun(input: {
  repoPath: string;
  plan: string;
  title?: string;
  config?: Partial<RunConfig>;
}): Promise<{ run?: RunRecord; error?: string; status: number }> {
  const { repo, error, status } = await validateRepoForRun(input.repoPath);
  if (!repo) return { error, status };
  const config = buildConfig(repo, input.config);
  const engineErr = unknownEngineError(config);
  if (engineErr) return { error: engineErr, status: 400 };
  const run = startRun({ repo, plan: input.plan, title: input.title, config });
  return { run, status: 201 };
}

/**
 * 原子创建运行组：先对每个仓库做与单仓相同的校验，任一不通过则一个 run 都不创建、返回 4xx；
 * 全过后创建 GroupRecord，逐仓创建 run（带 groupId）并各自 advance。
 * 组是纯聚合层：组内各 run 完全并行、各自独立推进。
 */
export async function createGroup(input: {
  title: string;
  repos: { repoPath: string; plan: string; config?: Partial<RunConfig> }[];
}): Promise<{ group?: GroupRecord; runs?: RunRecord[]; error?: string; status: number }> {
  const store = getStore();
  if (!input.repos.length) return { error: '组至少需要一个仓库', status: 400 };

  // 1. 原子校验：所有仓库先过一遍（含组内去重、engine 名校验），任一失败整组不创建
  const resolved: { repo: string; plan: string; config: RunConfig }[] = [];
  const seen = new Set<string>();
  for (const item of input.repos) {
    const { repo, error, status } = await validateRepoForRun(item.repoPath);
    if (!repo) return { error, status };
    if (seen.has(repo)) return { error: `${item.repoPath} 在组内重复出现`, status: 400 };
    seen.add(repo);
    const config = buildConfig(repo, item.config);
    const engineErr = unknownEngineError(config);
    if (engineErr) return { error: `${item.repoPath}: ${engineErr}`, status: 400 };
    resolved.push({ repo, plan: item.plan, config });
  }

  // 2. 创建组 + 逐仓创建 run
  const group: GroupRecord = {
    id: `g-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    title: input.title,
    runIds: [],
    createdAt: new Date().toISOString(),
  };
  const runs = resolved.map((item) => {
    const run = startRun({ repo: item.repo, plan: item.plan, groupId: group.id, config: item.config });
    group.runIds.push(run.id);
    return run;
  });
  store.saveGroup(group);
  return { group, runs, status: 201 };
}

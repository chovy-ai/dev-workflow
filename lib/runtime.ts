import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, type RunConfig, type RunRecord } from './types';
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

export async function createRun(input: {
  repoPath: string;
  plan: string;
  title?: string;
  config?: Partial<RunConfig>;
}): Promise<{ run?: RunRecord; error?: string; status: number }> {
  const store = getStore();
  const top = await git(input.repoPath, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) return { error: `${input.repoPath} 不是 git 仓库`, status: 400 };
  const repo = top.out;

  const existing = store.activeRunForRepo(repo);
  if (existing)
    return { error: `该仓库已有进行中的运行 ${existing.id}（一个仓库同时只跑一条流水线）`, status: 409 };

  // 配置优先级：请求体 > 仓库 ship.config.json > 默认
  let repoCfg: Partial<RunConfig> = {};
  const cfgFile = path.join(repo, 'ship.config.json');
  if (fs.existsSync(cfgFile)) {
    try {
      repoCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch {
      /* 配置损坏则忽略 */
    }
  }
  const config: RunConfig = { ...DEFAULT_CONFIG, ...repoCfg, ...input.config };
  config.engines = {
    ...DEFAULT_CONFIG.engines,
    ...(repoCfg.engines ?? {}),
    ...(input.config?.engines ?? {}),
  };

  const now = new Date().toISOString();
  const firstLine = input.plan.split('\n').find((l) => l.trim());
  const run: RunRecord = {
    id: `r-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    title: input.title ?? firstLine?.replace(/^#+\s*/, '').slice(0, 60) ?? 'ship run',
    repoPath: repo,
    branch: null,
    plan: input.plan,
    stage: 'branch',
    status: 'running',
    statusDetail: '',
    reviewRound: 0,
    feedback: [],
    findings: [],
    prUrl: null,
    sdkSessions: {},
    createdAt: now,
    updatedAt: now,
    config,
  };
  store.save(run);
  store.event(run, 'log', { msg: `运行创建：${run.title}（${repo}）` });
  advance(run);
  return { run, status: 201 };
}

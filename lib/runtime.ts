import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, deriveGroupStatus, type GroupRecord, type RunConfig, type RunRecord } from './types';
import { Store } from './store';
import { Pipeline } from './pipeline';
import { git } from './exec';

/**
 * Next.js 开发模式会按需重编译模块；用 globalThis 缓存保证
 * Store（含事件总线）与推进锁在整个 node 进程内是同一份。
 */
type G = typeof globalThis & { __shipStore?: Store; __shipAdvancing?: Set<string>; __shipBooted?: boolean };
const g = globalThis as G;

/** server 重启后自动续跑的次数上限：防止"续跑→再崩→再续跑"死循环 */
const MAX_AUTO_RESUMES = 3;
/** 每次启动补扫复盘的条数上限：避免积压的历史 run 一次性打爆 engine */
const RETRO_SWEEP_LIMIT = 3;

export function getStore(): Store {
  if (!g.__shipStore) g.__shipStore = new Store();
  if (!g.__shipBooted) {
    g.__shipBooted = true;
    const store = g.__shipStore;
    setTimeout(() => bootRecover(store), 0);
  }
  return g.__shipStore;
}

/**
 * 启动恢复：
 * 1) 上个 server 进程中断时仍在推进的 run 自动续跑（状态机 stage / SDK 会话都已持久化，
 *    worktree 被清了会从保留的分支重建；自动续跑超过上限才判失败）；
 * 2) 复盘补扫：已终态但没总结过（无 retroAt）的 run 补跑 retro，保证"每条 run 都被总结过一次"。
 */
function bootRecover(store: Store) {
  for (const id of store.interruptedAtLoad) {
    const run = store.get(id);
    if (!run || run.status !== 'running' || isAdvancing(id)) continue;
    const resumes = (run.resumes ?? 0) + 1;
    if (resumes > MAX_AUTO_RESUMES) {
      run.status = 'failed';
      run.statusDetail = `自动续跑达到上限 ${MAX_AUTO_RESUMES} 次仍被中断，运行终止（可手动 ship resume 再试）`;
      store.save(run);
      store.event(run, 'status', { status: run.status, detail: run.statusDetail });
      continue;
    }
    run.resumes = resumes;
    store.save(run);
    store.event(run, 'log', { msg: `⟲ server 重启，自动续跑（第 ${resumes} 次，从阶段 ${run.stage} 继续）` });
    advance(run);
  }
  void sweepRetro(store);
}

/** 复盘补扫：串行、每次启动最多 RETRO_SWEEP_LIMIT 条、只看最近 14 天（老账不追） */
async function sweepRetro(store: Store) {
  const cutoff = Date.now() - 14 * 86400_000;
  const targets = store
    .list()
    .filter((r) => r.status !== 'running' && !r.retroAt && Date.parse(r.createdAt) > cutoff)
    .slice(0, RETRO_SWEEP_LIMIT);
  for (const run of targets) {
    if (isAdvancing(run.id)) continue;
    await new Pipeline(run, store).retroOnly();
  }
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

/** 方案最小体量：符合性审查把方案当合同逐条核对，太短的方案两边审查都没有依据 */
const MIN_PLAN_CHARS = 300;

function planTooSimpleError(plan: string): string | null {
  const len = plan.trim().length;
  if (len >= MIN_PLAN_CHARS) return null;
  return (
    `方案太简单（${len} 字 < ${MIN_PLAN_CHARS}），拒绝创建：双边审查需要方案作为"合同"——` +
    `请补齐目标/背景、逐项改动点、约束、验收标准后重试`
  );
}

/**
 * 同仓库已有「相同方案且还在跑」的 run 时拒绝重复创建——同一方案并行跑两份纯属烧算力
 * （worktree 隔离下两份都能跑完，但只会合并出两个重复 PR）。方案不同的并行 run 不受影响。
 */
function duplicateRunError(repo: string, plan: string): string | null {
  const dup = getStore()
    .list()
    .find((r) => r.repoPath === repo && r.status === 'running' && r.plan.trim() === plan.trim());
  return dup ? `该仓库已有相同方案的 run 正在运行（${dup.id}），拒绝重复创建` : null;
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
    advisories: [],
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

/**
 * 手动续跑：中断/失败的 run 从持久化的 stage 继续（worktree 没了就从保留的分支重建）。
 * 与自动续跑不同，手动是人的明确意图，不受 MAX_AUTO_RESUMES 限制。
 */
export function resumeRun(id: string): { run?: RunRecord; error?: string; status: number } {
  const store = getStore();
  const run = store.get(id);
  if (!run) return { error: `run 不存在：${id}`, status: 404 };
  if (run.status === 'done') return { error: '已完成的 run 不能续跑', status: 400 };
  if (isAdvancing(id)) return { error: '该 run 正在推进中，无需续跑', status: 409 };
  run.resumes = (run.resumes ?? 0) + 1;
  run.status = 'running';
  run.statusDetail = '';
  // 归档不影响断点续跑：续跑一个已归档 run 先自动取消归档，回到活跃列表
  delete run.archivedAt;
  store.save(run);
  // 组成员的归档是两层的（组自身 archivedAt 是 GET /api/groups 的过滤口径）：若该成员属于一个
  // 已归档的组，只清成员 archivedAt 会让 running 成员因组仍归档而从活跃侧边栏消失——必须级联清组。
  if (run.groupId) {
    const group = store.getGroup(run.groupId);
    if (group?.archivedAt) {
      delete group.archivedAt;
      store.saveGroup(group);
    }
  }
  store.event(run, 'log', { msg: `⟲ 手动续跑（从阶段 ${run.stage} 继续）` });
  advance(run);
  return { run, status: 200 };
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
  const dupErr = duplicateRunError(repo, input.plan);
  if (dupErr) return { error: dupErr, status: 409 };
  const planErr = planTooSimpleError(input.plan);
  if (planErr) return { error: planErr, status: 400 };
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
    const dupErr = duplicateRunError(repo, item.plan);
    if (dupErr) return { error: `${item.repoPath}: ${dupErr}`, status: 409 };
    const planErr = planTooSimpleError(item.plan);
    if (planErr) return { error: `${item.repoPath}: ${planErr}`, status: 400 };
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

// ---------------------------------------------------------------- 归档（纯展示/管理层，不碰执行语义）

/**
 * 归档 / 还原单个 run。archived=true 置 archivedAt 为当前时间，false 清除（还原）。
 * running 不可归档（400，进行中不可归档）——failed / done 才能归档。
 */
export function archiveRun(
  id: string,
  archived: boolean,
): { run?: RunRecord; error?: string; status: number } {
  const store = getStore();
  const run = store.get(id);
  if (!run) return { error: `run 不存在：${id}`, status: 404 };
  if (archived && run.status === 'running')
    return { error: '运行进行中，不可归档（failed / done 才能归档）', status: 400 };
  if (archived) run.archivedAt = new Date().toISOString();
  else delete run.archivedAt;
  store.save(run);
  return { run, status: 200 };
}

/**
 * 归档 / 还原运行组，级联作用于全部成员 run。
 * archived=true 时若有任一成员 running 则整组拒绝（400），且不做部分归档（原子：一个成员都不写）。
 * 成员集合由真实 group.runIds 经 Store.groupRuns 解析（已丢弃不存在的 id）。
 */
export function archiveGroup(
  id: string,
  archived: boolean,
): { group?: GroupRecord; runs?: RunRecord[]; error?: string; status: number } {
  const store = getStore();
  const group = store.getGroup(id);
  if (!group) return { error: `组不存在：${id}`, status: 404 };
  const members = store.groupRuns(group);
  if (archived && members.some((r) => r.status === 'running'))
    return { error: '组内有成员进行中，整组不可归档', status: 400 };
  const now = new Date().toISOString();
  for (const r of members) {
    if (archived) r.archivedAt = now;
    else delete r.archivedAt;
    store.save(r);
  }
  if (archived) group.archivedAt = now;
  else delete group.archivedAt;
  store.saveGroup(group);
  return { group, runs: members, status: 200 };
}

/**
 * 一键归档：归档全部「未归档且为 done」的散 run，以及「未归档且推导状态为 done」的组（连成员）。
 * failed 不纳入（需要人看过再手动归档）。返回实际发生变更的数量 { runs, groups }——
 * 已归档项不重复计数（幂等：二次调用返回 0，且不刷新既有 archivedAt）。
 */
export function archiveDone(): { runs: number; groups: number } {
  const store = getStore();
  const now = new Date().toISOString();
  let runs = 0;
  let groups = 0;
  // 推导状态为 done 的组：整组 + 未归档成员一起置 archivedAt
  for (const g of store.listGroups()) {
    if (g.archivedAt) continue;
    const members = store.groupRuns(g);
    if (deriveGroupStatus(members) !== 'done') continue;
    for (const r of members) {
      if (r.archivedAt) continue;
      r.archivedAt = now;
      store.save(r);
    }
    g.archivedAt = now;
    store.saveGroup(g);
    groups++;
  }
  // done 的散 run（组成员只经组归档，不在这里单独计入）
  for (const r of store.list()) {
    if (r.groupId || r.archivedAt || r.status !== 'done') continue;
    r.archivedAt = now;
    store.save(r);
    runs++;
  }
  return { runs, groups };
}

// 仓库间依赖的纯函数层：组清单依赖校验、name→runId 解析、版本发布判定、
// awaitDeps 等待决策。全部无 IO，供 runtime/pipeline 调用与测试直接覆盖。
import type { AwaitingDep, RunStatus } from './types';

/** 组清单 repos 项里与依赖相关的字段（其余字段本模块不关心） */
export interface GroupRepoDeps {
  name?: string;
  dependsOn?: string[];
  publishes?: { package: string; check?: string; timeoutMinutes?: number };
}

/**
 * 组创建时的依赖声明校验（原子：返回错误文案则整组不创建）：
 * - 声明了 dependsOn 或被别人依赖的成员必须有 name，且 name 组内唯一
 * - dependsOn 不得指向不存在的 name、不得自依赖
 * - 依赖图不得成环（DFS 三色标记）
 */
export function validateGroupDeps(repos: GroupRepoDeps[]): string | null {
  const names = new Map<string, number>();
  for (let i = 0; i < repos.length; i++) {
    const n = repos[i].name;
    if (!n) continue;
    if (names.has(n)) return `成员 name 重复：${n}`;
    names.set(n, i);
  }
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i];
    if (r.dependsOn?.length && !r.name) return `第 ${i + 1} 个成员声明了 dependsOn 但缺少 name`;
    for (const dep of r.dependsOn ?? []) {
      if (dep === r.name) return `成员 ${r.name} 不能依赖自己`;
      if (!names.has(dep)) return `成员 ${r.name} 的 dependsOn 指向不存在的 name：${dep}`;
    }
  }
  // 环检测：0=未访问 1=在栈上 2=已完成
  const color = new Map<string, 0 | 1 | 2>();
  const dfs = (name: string): string | null => {
    color.set(name, 1);
    const i = names.get(name)!;
    for (const dep of repos[i].dependsOn ?? []) {
      const c = color.get(dep) ?? 0;
      if (c === 1) return `依赖成环：${dep} ↔ ${name}`;
      if (c === 0) {
        const err = dfs(dep);
        if (err) return err;
      }
    }
    color.set(name, 2);
    return null;
  };
  for (const n of names.keys()) {
    if ((color.get(n) ?? 0) === 0) {
      const err = dfs(n);
      if (err) return err;
    }
  }
  return null;
}

/**
 * 组创建后把 name 依赖解析成 run id 依赖：
 * 返回每个成员的 { dependsOn: runId[], awaiting: 模板（baselineVersion 由调用方探测后填充）}。
 * 输入顺序与 runIds 一一对应；无依赖的成员返回空。
 */
export function resolveDeps(
  repos: GroupRepoDeps[],
  runIds: string[],
): { dependsOn: string[]; awaiting: Omit<AwaitingDep, 'baselineVersion'>[] }[] {
  const idByName = new Map<string, number>();
  repos.forEach((r, i) => r.name && idByName.set(r.name, i));
  return repos.map((r) => {
    const dependsOn: string[] = [];
    const awaiting: Omit<AwaitingDep, 'baselineVersion'>[] = [];
    for (const dep of r.dependsOn ?? []) {
      const i = idByName.get(dep)!;
      dependsOn.push(runIds[i]);
      const pub = repos[i].publishes;
      if (pub)
        awaiting.push({
          runId: runIds[i],
          package: pub.package,
          ...(pub.check ? { check: pub.check } : {}),
          ...(pub.timeoutMinutes ? { timeoutMinutes: pub.timeoutMinutes } : {}),
        });
    }
    return { dependsOn, awaiting };
  });
}

/** 发布判定：探测到非空版本，且与基线不同（无基线时任何可见版本即算发布） */
export function versionAdvanced(baseline: string | null, current: string | null | undefined): boolean {
  if (!current) return false;
  return baseline === null || current.trim() !== baseline.trim();
}

export type AwaitTick =
  | { kind: 'halt'; reason: string }
  | { kind: 'wait' }
  | { kind: 'ready' };

/**
 * awaitDeps 单次轮询的决策（纯函数，超时判定由调用方传 now/deadline）：
 * - 任一上游缺失或 failed → halt（statusDetail 指明卡在哪个上游）
 * - 超时 → halt
 * - 上游未全 done，或声明的发布物尚未全部探测到新版本 → wait
 * - 否则 ready
 */
export function evalAwaitTick(p: {
  upstreams: { id: string; status?: RunStatus }[];
  /** 每个等待项是否已探测到新版本（与 awaiting 一一对应） */
  published: boolean[];
  nowMs: number;
  deadlineMs: number;
  timeoutMinutes: number;
}): AwaitTick {
  const missing = p.upstreams.find((u) => !u.status);
  if (missing) return { kind: 'halt', reason: `上游 run 不存在：${missing.id}` };
  const failed = p.upstreams.find((u) => u.status === 'failed');
  if (failed) return { kind: 'halt', reason: `上游 ${failed.id} 已终止，本 run 阻塞于依赖` };
  if (p.nowMs > p.deadlineMs)
    return { kind: 'halt', reason: `等待上游超时（${p.timeoutMinutes} 分钟）——确认上游合并/发布后可从断点续跑` };
  if (p.upstreams.some((u) => u.status !== 'done')) return { kind: 'wait' };
  if (p.published.some((ok) => !ok)) return { kind: 'wait' };
  return { kind: 'ready' };
}

/** 等待项的默认探测命令 */
export const defaultCheckCmd = (pkg: string) => `npm view ${JSON.stringify(pkg)} version`;

/** 组内最大等待超时（分钟）：各等待项的 timeoutMinutes 取大者，无等待项按 30 */
export function awaitTimeoutMinutes(awaiting: { timeoutMinutes?: number }[]): number {
  return Math.max(30, ...awaiting.map((a) => a.timeoutMinutes ?? 30));
}

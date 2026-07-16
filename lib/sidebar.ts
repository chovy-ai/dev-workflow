// 侧边栏分区/排序纯函数：与 UI 解耦，供 app/page.tsx 与测试共用。
// 分区归属由真实 API 返回的 status / 推导状态驱动；排序键只认 updatedAt（不认 createdAt / 插入序）。
import type { GroupStatus, RunRecord, RunStatus } from './types';

/** GET /api/groups 的列表项形状（成员摘要带 updatedAt，供推导组的最大 updatedAt） */
export type GroupSummary = {
  id: string;
  title: string;
  runIds: string[];
  createdAt: string;
  archivedAt?: string;
  status: GroupStatus;
  runs: { id: string; repoPath: string; stage: string; status: string; updatedAt: string }[];
};

/** 侧边栏统一条目：散 run 或 组，各带用于排序的 updatedAt 与用于分区的 status */
export type SidebarItem =
  | { kind: 'run'; id: string; updatedAt: string; status: RunStatus; run: RunRecord }
  | { kind: 'group'; id: string; updatedAt: string; status: GroupStatus; group: GroupSummary };

/** 组的排序键：成员 run 的最大 updatedAt；无成员则退回组自身 createdAt */
export function groupUpdatedAt(g: GroupSummary): string {
  let max = '';
  for (const r of g.runs) if (r.updatedAt > max) max = r.updatedAt;
  return max || g.createdAt;
}

/** 把散 run（无 groupId）与组归一成侧边栏条目 */
export function toItems(runs: RunRecord[], groups: GroupSummary[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const g of groups)
    items.push({ kind: 'group', id: g.id, updatedAt: groupUpdatedAt(g), status: g.status, group: g });
  for (const r of runs)
    if (!r.groupId)
      items.push({ kind: 'run', id: r.id, updatedAt: r.updatedAt, status: r.status, run: r });
  return items;
}

/** 按 updatedAt 倒序（最近活动在前）；updatedAt 相同用 id 兜底保证稳定 */
export function sortByUpdatedAtDesc(items: SidebarItem[]): SidebarItem[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

/** 四分区中的三个活跃分区（已归档来自单独的 ?archived=1 数据，见 archivedItems） */
export type Partitions = {
  running: SidebarItem[];
  needAttention: SidebarItem[]; // failed
  done: SidebarItem[];
};

/**
 * 从「未归档」的 runs + groups 计算三个活跃分区，区内 updatedAt 倒序。
 * running→进行中、failed→需要处理、done→已完成。
 */
export function partition(runs: RunRecord[], groups: GroupSummary[]): Partitions {
  const items = toItems(runs, groups);
  const pick = (s: RunStatus | GroupStatus) => sortByUpdatedAtDesc(items.filter((it) => it.status === s));
  return {
    running: pick('running'),
    needAttention: pick('failed'),
    done: pick('done'),
  };
}

/**
 * 已归档分区：任意状态，统一按 updatedAt 倒序。
 * 结构性互斥：剔除已出现在活跃集（activeIds）里的条目——即便 ?archived=1 缓存短暂陈旧
 * （如 resume 自动取消归档后活跃列表已更新、但已归档缓存尚未刷新），也不让同一条目同时
 * 出现在活跃分区与已归档分区。默认不传时保持全部保留（向后兼容）。
 */
export function archivedItems(
  runs: RunRecord[],
  groups: GroupSummary[],
  activeIds: Set<string> = new Set(),
): SidebarItem[] {
  return sortByUpdatedAtDesc(toItems(runs, groups).filter((it) => !activeIds.has(it.id)));
}

/**
 * 相对时间（纯函数，随现有 5s 轮询自然刷新）：
 * <1 分钟「刚刚」；<60 分钟「N 分钟前」；<24 小时「N 小时前」；
 * 昨天「昨天」；<7 天「N 天前」；否则显示 M-DD 日期。
 */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = nowMs - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

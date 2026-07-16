import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partition, archivedItems, toItems, type GroupSummary } from '../../lib/sidebar';
import { DEFAULT_CONFIG, type RunRecord } from '../../lib/types';

function mkRun(over: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    title: over.id,
    repoPath: '/repo/x',
    branch: null,
    worktreePath: null,
    plan: 'plan',
    stage: 'done',
    status: 'done',
    statusDetail: '',
    reviewRound: 0,
    findings: [],
    advisories: [],
    prUrl: null,
    sdkSessions: {},
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    config: DEFAULT_CONFIG,
    ...over,
  };
}

function mkGroup(id: string, status: GroupSummary['status'], updatedAt: string): GroupSummary {
  return {
    id,
    title: id,
    runIds: [`${id}-m`],
    createdAt: '2020-01-01T00:00:00.000Z',
    status,
    runs: [{ id: `${id}-m`, repoPath: '/repo/x', stage: 'done', status, updatedAt }],
  };
}

// 复现 finding：resume 自动取消归档后，活跃列表已把 run 放进「进行中」，但 ?archived=1
// 缓存仍保留同一条目 → 四分区不再互斥。archivedItems 必须结构性剔除已在活跃集里的 id。
test('archivedItems 剔除已出现在活跃集里的散 run（互斥）', () => {
  // 陈旧的已归档缓存仍含 X
  const archivedRuns = [mkRun({ id: 'X', status: 'failed', updatedAt: '2022-01-01T00:00:00.000Z' })];
  // 活跃数据：X 已 running（resume 后），另有真正已归档的 Y 不在活跃集
  const activeRuns = [mkRun({ id: 'X', status: 'running', updatedAt: '2022-03-01T00:00:00.000Z' })];
  const activeIds = new Set(toItems(activeRuns, []).map((i) => i.id));

  const parts = partition(activeRuns, []);
  const arch = archivedItems(archivedRuns, [], activeIds);

  assert.deepEqual(parts.running.map((i) => i.id), ['X'], 'X 应在「进行中」');
  assert.ok(!arch.some((i) => i.id === 'X'), 'X 不应再残留在「已归档」（互斥）');
});

test('archivedItems 保留真正已归档、不在活跃集里的条目', () => {
  const archivedRuns = [mkRun({ id: 'Y', status: 'done', updatedAt: '2022-01-01T00:00:00.000Z' })];
  const activeIds = new Set<string>(); // 活跃集不含 Y
  const arch = archivedItems(archivedRuns, [], activeIds);
  assert.deepEqual(arch.map((i) => i.id), ['Y']);
});

test('archivedItems 对组同样互斥（陈旧已归档组缓存 vs 活跃组）', () => {
  const archivedGroups = [mkGroup('g1', 'done', '2022-01-01T00:00:00.000Z')];
  const activeGroups = [mkGroup('g1', 'running', '2022-05-01T00:00:00.000Z')];
  const activeIds = new Set(toItems([], activeGroups).map((i) => i.id));

  const parts = partition([], activeGroups);
  const arch = archivedItems([], archivedGroups, activeIds);
  assert.deepEqual(parts.running.map((i) => i.id), ['g1']);
  assert.ok(!arch.some((i) => i.id === 'g1'), '组 g1 不应同时出现在活跃与已归档');
});

// 默认参数（不传 activeIds）保持旧行为，向后兼容
test('archivedItems 不传 activeIds 时全部保留', () => {
  const archivedRuns = [mkRun({ id: 'a', updatedAt: '2022-01-01T00:00:00.000Z' })];
  assert.deepEqual(archivedItems(archivedRuns, []).map((i) => i.id), ['a']);
});

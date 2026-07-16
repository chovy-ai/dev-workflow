import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partition,
  groupUpdatedAt,
  relativeTime,
  type GroupSummary,
} from '../../lib/sidebar';
import { DEFAULT_CONFIG, type RunRecord } from '../../lib/types';
import { freshHome, loadStore } from '../helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function mkGroup(id: string, status: GroupSummary['status'], memberUpdatedAts: string[]): GroupSummary {
  return {
    id,
    title: id,
    runIds: memberUpdatedAts.map((_, i) => `${id}-m${i}`),
    createdAt: '2020-01-01T00:00:00.000Z',
    status,
    runs: memberUpdatedAts.map((updatedAt, i) => ({
      id: `${id}-m${i}`,
      repoPath: '/repo/x',
      stage: 'done',
      status: 'done',
      updatedAt,
    })),
  };
}

test('排序键来自 Store.save 刷新的 updatedAt：先建后更新仍浮到顶部（双向）', async () => {
  const home = freshHome();
  const store = loadStore(home);
  // a 创建更早，b 创建更晚
  const a = mkRun({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' });
  const b = mkRun({ id: 'b', createdAt: '2020-06-01T00:00:00.000Z' });
  store.save(a); // a.updatedAt = t1（真实写盘时间戳）
  await sleep(3);
  store.save(b); // b.updatedAt = t2 > t1
  await sleep(3);
  store.save(a); // a.updatedAt = t3 > t2 —— a 后更新

  // Store.list 按 createdAt 排序（a 在前）；partition 只认 updatedAt
  const parts = partition(store.list(), []);
  assert.deepEqual(
    parts.done.map((i) => i.id),
    ['a', 'b'],
    'a 虽创建更早，但最近更新 → 浮到顶部',
  );

  // 反向：让 b 后更新，b 应浮到顶
  await sleep(3);
  store.save(b);
  const parts2 = partition(store.list(), []);
  assert.deepEqual(
    parts2.done.map((i) => i.id),
    ['b', 'a'],
    '排序只认 updatedAt，不认 createdAt/插入序',
  );
});

test('组用成员 run 的最大 updatedAt 作排序键', () => {
  const g = mkGroup('g', 'done', [
    '2021-01-01T00:00:00.000Z',
    '2023-05-05T00:00:00.000Z', // 最大
    '2022-02-02T00:00:00.000Z',
  ]);
  assert.equal(groupUpdatedAt(g), '2023-05-05T00:00:00.000Z');
});

test('分区按 status 归属，区内 updatedAt 倒序（组与散 run 混排）', () => {
  const runs = [
    mkRun({ id: 'run-1', status: 'running', updatedAt: '2022-01-01T00:00:00.000Z' }),
    mkRun({ id: 'fail-1', status: 'failed', updatedAt: '2022-01-02T00:00:00.000Z' }),
    mkRun({ id: 'done-old', status: 'done', updatedAt: '2022-03-01T00:00:00.000Z' }),
    mkRun({ id: 'done-new', status: 'done', updatedAt: '2022-05-01T00:00:00.000Z' }),
  ];
  // 组的最大成员 updatedAt = 2022-06，比任何散 done 都新
  const groups = [mkGroup('grp-done', 'done', ['2022-06-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'])];

  const parts = partition(runs, groups);
  assert.deepEqual(parts.running.map((i) => i.id), ['run-1']);
  assert.deepEqual(parts.needAttention.map((i) => i.id), ['fail-1']);
  // done 区：组(06) > done-new(05) > done-old(03)
  assert.deepEqual(parts.done.map((i) => i.id), ['grp-done', 'done-new', 'done-old']);
});

test('分区忽略带 groupId 的散 run（它们只经组呈现）', () => {
  const runs = [
    mkRun({ id: 'lone', status: 'done', updatedAt: '2022-05-01T00:00:00.000Z' }),
    mkRun({ id: 'member', status: 'done', groupId: 'g', updatedAt: '2022-09-01T00:00:00.000Z' }),
  ];
  const parts = partition(runs, []);
  assert.deepEqual(parts.done.map((i) => i.id), ['lone']);
});

test('relativeTime：刚刚 / N 分钟前 / 昨天 / 超 7 天显示日期', () => {
  const now = Date.parse('2026-07-16T12:00:00.000Z');
  assert.equal(relativeTime('2026-07-16T11:59:30.000Z', now), '刚刚');
  assert.equal(relativeTime('2026-07-16T11:40:00.000Z', now), '20 分钟前');
  assert.equal(relativeTime('2026-07-16T09:00:00.000Z', now), '3 小时前');
  assert.equal(relativeTime('2026-07-15T10:00:00.000Z', now), '昨天');
  // 超过 7 天 → 显示 M-DD 日期
  assert.match(relativeTime('2026-06-01T10:00:00.000Z', now), /^\d{1,2}-\d{2}$/);
});

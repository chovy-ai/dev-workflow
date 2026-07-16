import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeRun, getStore } from '../../lib/runtime';
import { GET as runsGET } from '../../app/api/runs/route';
import { GET as groupsGET } from '../../app/api/groups/route';
import { deriveGroupStatus, type RunRecord } from '../../lib/types';
import { partition, type GroupSummary } from '../../lib/sidebar';
import { freshHome, loadStore, readGroup, readRun, writeRun, writeGroup, getReq } from '../helpers';

const TS = '2026-05-05T00:00:00.000Z';

/** 按 GET /api/groups 的口径把 store 里的组映射成侧边栏用的 GroupSummary（同步，用于即时断言） */
function toSummary(store: ReturnType<typeof getStore>, id: string): GroupSummary {
  const g = store.getGroup(id)!;
  const members = store.groupRuns(g);
  return {
    ...g,
    status: deriveGroupStatus(members),
    runs: members.map((r) => ({
      id: r.id,
      repoPath: r.repoPath,
      stage: r.stage,
      status: r.status,
      updatedAt: r.updatedAt,
    })),
  };
}

// 复现 finding：组级联归档后，续跑一个 failed 成员只清了 run.archivedAt，
// 组仍保持 archivedAt → running 成员从活跃侧边栏消失。修复要求 resume 级联清组 archivedAt。
test('resume 已归档组的成员：级联清组 archivedAt，running 成员回到「进行中」', async () => {
  const home = freshHome();
  // 组与成员都通过组级联归档（archiveGroup 语义）落到已归档态
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2'], archivedAt: TS });
  writeRun(home, {
    id: 'm1',
    status: 'failed',
    stage: 'implement',
    branch: null,
    worktreePath: null,
    groupId: 'g1',
    archivedAt: TS,
  });
  writeRun(home, { id: 'm2', status: 'done', groupId: 'g1', archivedAt: TS });
  loadStore(home);

  const { run, status } = resumeRun('m1');

  // --- 同步断言：此刻后台 advance 尚未在微任务里回退状态 ---
  assert.equal(status, 200);
  assert.equal(run!.status, 'running');
  assert.equal(run!.archivedAt, undefined, '成员 archivedAt 应清除');
  const store = getStore();
  assert.equal(store.getGroup('g1')!.archivedAt, undefined, '组 archivedAt 必须被级联清除');
  // 落盘保真：group.json 的 archivedAt 已清
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);

  // 真实 deriveGroupStatus + 真实 partition：running 成员 → 组进入「进行中」，不落已归档
  const activeGroups = [toSummary(store, 'g1')].filter((g) => !g.archivedAt);
  const activeRuns = store.list().filter((r) => !r.archivedAt);
  const parts = partition(activeRuns, activeGroups);
  assert.deepEqual(
    parts.running.map((i) => i.id),
    ['g1'],
    'running 成员所在组必须出现在「进行中」分区',
  );

  // --- 等后台 advance（无 worktree/branch）回退，再从磁盘经真实 GET 路由验证默认过滤口径 ---
  await new Promise((r) => setTimeout(r, 80));
  loadStore(home); // 从磁盘重载，证明 archivedAt 清除是落盘事实

  const defGroups = (await (await groupsGET(getReq('/groups'))).json()) as { id: string }[];
  assert.ok(
    defGroups.some((g) => g.id === 'g1'),
    'GET /api/groups 默认必须重新包含该组（组 archivedAt 已清）',
  );
  const archGroups = (await (await groupsGET(getReq('/groups?archived=1'))).json()) as {
    id: string;
  }[];
  assert.ok(!archGroups.some((g) => g.id === 'g1'), '?archived=1 不应再包含该组');

  const defRuns = (await (await runsGET(getReq('/runs'))).json()) as RunRecord[];
  assert.ok(defRuns.some((r) => r.id === 'm1'), 'GET /api/runs 默认必须包含该成员（archivedAt 已清）');
});

// 边界：resume 无组的散 run 不应误触组逻辑；resume 组成员但组本就未归档时不改组
test('resume 组成员时组未归档则不动组', () => {
  const home = freshHome();
  writeGroup(home, { id: 'g1', runIds: ['m1'] }); // 组未归档
  writeRun(home, {
    id: 'm1',
    status: 'failed',
    stage: 'implement',
    branch: null,
    worktreePath: null,
    groupId: 'g1',
    archivedAt: TS, // 仅成员单独归档
  });
  loadStore(home);

  resumeRun('m1');
  assert.equal(getStore().getGroup('g1')!.archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);
});

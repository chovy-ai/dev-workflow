import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as resumePOST } from '../../app/api/runs/[id]/resume/route';
import { GET as runsGET } from '../../app/api/runs/route';
import { GET as groupsGET } from '../../app/api/groups/route';
import type { RunRecord } from '../../lib/types';
import { archivedItems, partition, type GroupSummary } from '../../lib/sidebar';
import {
  freshHome,
  loadStore,
  readGroup,
  readRun,
  writeRun,
  writeGroup,
  getReq,
  postReq,
  paramCtx,
} from '../helpers';

const TS = '2026-05-05T00:00:00.000Z';

// 复现 finding：组级联归档后，续跑一个 failed 成员只清了 run.archivedAt，
// 组仍保持 archivedAt → running 成员从活跃侧边栏消失。回归必须从真实 resume POST 开始，
// 并把真实列表 GET 的响应原样交给 sidebar partition，防止任一生产边界断开时测试仍误通过。
test('resume 已归档组的成员：级联清组 archivedAt，running 成员回到「进行中」', async () => {
  const home = freshHome();
  // 组与成员都通过组级联归档（archiveGroup 语义）落到已归档态
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2'], archivedAt: TS });
  writeRun(home, {
    id: 'm1',
    status: 'failed',
    // 从 worktree 阶段续跑会真实异步进入 git 工作；POST 返回后的列表窗口稳定保持 running，
    // 避免 implement + 无 branch/worktree 被真实 advance 立即判回 failed，掩盖本用例要验证的边界。
    stage: 'worktree',
    branch: null,
    worktreePath: null,
    groupId: 'g1',
    archivedAt: TS,
  });
  writeRun(home, { id: 'm2', status: 'done', groupId: 'g1', archivedAt: TS });
  loadStore(home);

  const resumeRes = await resumePOST(postReq(), paramCtx('m1'));
  const resumed = (await resumeRes.json()) as RunRecord;

  // POST 返回的是 runtime 刚进入推进态的真实响应；此刻后台 advance 尚未在微任务里回退状态。
  assert.equal(resumeRes.status, 200);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.archivedAt, undefined, '成员 archivedAt 应清除');
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);

  // 不从 Store 手工拼摘要：真实 GET 响应直接进入真实 partition / archivedItems。
  const [activeRunsRes, activeGroupsRes, archivedRunsRes, archivedGroupsRes] = await Promise.all([
    runsGET(getReq('/runs')),
    groupsGET(getReq('/groups')),
    runsGET(getReq('/runs?archived=1')),
    groupsGET(getReq('/groups?archived=1')),
  ]);
  const activeRuns = (await activeRunsRes.json()) as RunRecord[];
  const activeGroups = (await activeGroupsRes.json()) as GroupSummary[];
  const archivedRuns = (await archivedRunsRes.json()) as RunRecord[];
  const archivedGroups = (await archivedGroupsRes.json()) as GroupSummary[];
  const parts = partition(activeRuns, activeGroups);
  const archived = archivedItems(archivedRuns, archivedGroups);
  assert.deepEqual(
    parts.running.map((i) => i.id),
    ['g1'],
    'running 成员所在组必须出现在「进行中」分区',
  );
  assert.ok(!archived.some((i) => i.id === 'g1'), '该组不得仍出现在「已归档」分区');

  // 等后台 advance（无 worktree/branch）回退，再从磁盘重载，证明取消归档已持久化。
  await new Promise((r) => setTimeout(r, 80));
  loadStore(home);
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);
});

// 边界：resume 无组的散 run 不应误触组逻辑；resume 组成员但组本就未归档时不改组
test('resume 组成员时组未归档则不动组', async () => {
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

  const res = await resumePOST(postReq(), paramCtx('m1'));
  assert.equal(res.status, 200);
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);
});

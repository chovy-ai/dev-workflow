import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as runsGET } from '../../app/api/runs/route';
import { GET as groupsGET } from '../../app/api/groups/route';
import type { RunRecord } from '../../lib/types';
import { freshHome, loadStore, writeRun, writeGroup, getReq } from '../helpers';

type GroupSummary = { id: string };

async function runIds(query = ''): Promise<string[]> {
  const res = await runsGET(getReq(`/runs${query}`));
  return ((await res.json()) as RunRecord[]).map((r) => r.id).sort();
}
async function groupIds(query = ''): Promise<string[]> {
  const res = await groupsGET(getReq(`/groups${query}`));
  return ((await res.json()) as GroupSummary[]).map((g) => g.id).sort();
}

// 错位归档态：过滤口径必须各看各的字段（组看组自身、散 run 看 run 自身）
test('组已归档但成员未归档：GET /api/groups 只看组自身 archivedAt', async () => {
  const home = freshHome();
  const ts = '2026-03-03T00:00:00.000Z';
  // 组归档，但成员未归档
  writeRun(home, { id: 'm1', status: 'done', groupId: 'gA' }); // 成员无 archivedAt
  writeGroup(home, { id: 'gA', runIds: ['m1'], archivedAt: ts });
  loadStore(home);

  assert.deepEqual(await groupIds(), [], '组已归档 → 默认组列表不含');
  assert.deepEqual(await groupIds('?archived=1'), ['gA'], '组已归档 → 归档组列表含');
  // 散 run 视角：m1 有 groupId 但自身没 archivedAt → 默认 run 列表包含它（run 过滤只看 run 自身）
  assert.ok((await runIds()).includes('m1'), 'GET /api/runs 只看 run 自身 archivedAt');
  assert.ok(!(await runIds('?archived=1')).includes('m1'));
});

test('成员归档但组未归档：GET /api/runs 只看 run 自身 archivedAt', async () => {
  const home = freshHome();
  const ts = '2026-03-03T00:00:00.000Z';
  // 成员归档，但组未归档
  writeRun(home, { id: 'm1', status: 'done', groupId: 'gB', archivedAt: ts });
  writeRun(home, { id: 's1', status: 'done' }); // 散 run 未归档
  writeGroup(home, { id: 'gB', runIds: ['m1'] }); // 组无 archivedAt
  loadStore(home);

  // run 过滤按 run 自身：m1 已归档 → 默认不含、归档视图含；s1 未归档 → 默认含
  assert.deepEqual(await runIds(), ['s1']);
  assert.deepEqual(await runIds('?archived=1'), ['m1']);
  // 组过滤按组自身：gB 未归档 → 默认组列表含，归档视图不含
  assert.deepEqual(await groupIds(), ['gB']);
  assert.deepEqual(await groupIds('?archived=1'), []);
});

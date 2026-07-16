import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as archivePOST } from '../../app/api/runs/[id]/archive/route';
import { GET as runsGET } from '../../app/api/runs/route';
import type { RunRecord } from '../../lib/types';
import { freshHome, loadStore, writeRun, readRun, postReq, getReq, paramCtx } from '../helpers';

/** 默认列表里的 id 集合（穿过真实 GET 过滤） */
async function listIds(query = ''): Promise<string[]> {
  const res = await runsGET(getReq(`/runs${query}`));
  const runs = (await res.json()) as RunRecord[];
  return runs.map((r) => r.id);
}

test('归档 running run 返回 400，且不写入 archivedAt', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-run', status: 'running', stage: 'implement' });
  loadStore(home);

  const res = await archivePOST(postReq({ archived: true }), paramCtx('r-run'));
  assert.equal(res.status, 400);
  // 门禁不得被短路：磁盘上的 run.json 依然没有 archivedAt
  assert.equal(readRun(home, 'r-run').archivedAt, undefined);
});

test('归档 done run 后默认列表不含、?archived=1 含；还原后回到默认列表', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-done', status: 'done' });
  writeRun(home, { id: 'r-other', status: 'failed' });
  loadStore(home);

  // 归档
  const res = await archivePOST(postReq({ archived: true }), paramCtx('r-done'));
  assert.equal(res.status, 200);
  // archivedAt 真落盘
  const onDisk = readRun(home, 'r-done').archivedAt;
  assert.ok(onDisk, 'archivedAt 应已写入 run.json');

  // 从磁盘重载，证明过滤消费的是落盘字段
  loadStore(home);
  assert.deepEqual((await listIds()).sort(), ['r-other']); // 默认不含已归档
  assert.deepEqual(await listIds('?archived=1'), ['r-done']); // 归档视图只含它

  // 还原
  const res2 = await archivePOST(postReq({ archived: false }), paramCtx('r-done'));
  assert.equal(res2.status, 200);
  assert.equal(readRun(home, 'r-done').archivedAt, undefined, '还原应清除 archivedAt');

  loadStore(home);
  assert.deepEqual((await listIds()).sort(), ['r-done', 'r-other']); // 重新回到默认列表
  assert.deepEqual(await listIds('?archived=1'), []); // 归档视图已空
});

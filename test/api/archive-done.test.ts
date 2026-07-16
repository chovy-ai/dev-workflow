import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as archiveDonePOST } from '../../app/api/runs/archive-done/route';
import { freshHome, loadStore, writeRun, writeGroup, readRun, readGroup } from '../helpers';

test('archive-done 只归档 done（散 run + 全 done 组连成员），failed 不动，计数精确', async () => {
  const home = freshHome();
  // 2 个 done 散 run
  writeRun(home, { id: 'd1', status: 'done' });
  writeRun(home, { id: 'd2', status: 'done' });
  // 1 个 failed 散 run（不动）
  writeRun(home, { id: 'f1', status: 'failed' });
  // 1 个全 done 组（推导状态 done）
  writeRun(home, { id: 'gm1', status: 'done', groupId: 'gA' });
  writeRun(home, { id: 'gm2', status: 'done', groupId: 'gA' });
  writeGroup(home, { id: 'gA', runIds: ['gm1', 'gm2'] });
  loadStore(home);

  const res = await archiveDonePOST();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { runs: 2, groups: 1 });

  // 散 done 已归档
  assert.ok(readRun(home, 'd1').archivedAt);
  assert.ok(readRun(home, 'd2').archivedAt);
  // failed 未动
  assert.equal(readRun(home, 'f1').archivedAt, undefined, 'failed 不纳入一键归档');
  // 组连成员归档
  assert.ok(readGroup(home, 'gA').archivedAt);
  assert.ok(readRun(home, 'gm1').archivedAt);
  assert.ok(readRun(home, 'gm2').archivedAt);
});

test('archive-done 不归档「含 failed 成员」的组（推导状态非 done）', async () => {
  const home = freshHome();
  writeRun(home, { id: 'gm1', status: 'done', groupId: 'gB' });
  writeRun(home, { id: 'gm2', status: 'failed', groupId: 'gB' });
  writeGroup(home, { id: 'gB', runIds: ['gm1', 'gm2'] });
  loadStore(home);

  const res = await archiveDonePOST();
  assert.deepEqual(await res.json(), { runs: 0, groups: 0 });
  assert.equal(readGroup(home, 'gB').archivedAt, undefined);
  assert.equal(readRun(home, 'gm1').archivedAt, undefined);
});

test('archive-done 幂等：二次调用返回 0 且不刷新既有 archivedAt', async () => {
  const home = freshHome();
  writeRun(home, { id: 'd1', status: 'done' });
  writeRun(home, { id: 'gm1', status: 'done', groupId: 'gA' });
  writeGroup(home, { id: 'gA', runIds: ['gm1'] });
  loadStore(home);

  const first = await (await archiveDonePOST()).json();
  assert.deepEqual(first, { runs: 1, groups: 1 });
  const runTs = readRun(home, 'd1').archivedAt;
  const grpTs = readGroup(home, 'gA').archivedAt;
  const memberTs = readRun(home, 'gm1').archivedAt;
  assert.ok(runTs && grpTs && memberTs);

  // 从磁盘重载（既有已归档记录带 archivedAt），再调一次
  loadStore(home);
  const second = await (await archiveDonePOST()).json();
  assert.deepEqual(second, { runs: 0, groups: 0 }, '已归档项不得重复计数');
  // 时间戳未被刷新
  assert.equal(readRun(home, 'd1').archivedAt, runTs);
  assert.equal(readGroup(home, 'gA').archivedAt, grpTs);
  assert.equal(readRun(home, 'gm1').archivedAt, memberTs);
});

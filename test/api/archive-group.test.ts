import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as groupArchivePOST } from '../../app/api/groups/[id]/archive/route';
import { freshHome, loadStore, writeRun, writeGroup, readRun, readGroup, postReq, paramCtx } from '../helpers';

test('组归档级联全部非-running 成员（组 + 成员一起置 archivedAt）', async () => {
  const home = freshHome();
  writeRun(home, { id: 'm1', status: 'done', groupId: 'g1' });
  writeRun(home, { id: 'm2', status: 'failed', groupId: 'g1' });
  writeRun(home, { id: 'm3', status: 'done', groupId: 'g1' });
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2', 'm3'] });
  loadStore(home);

  const res = await groupArchivePOST(postReq({ archived: true }), paramCtx('g1'));
  assert.equal(res.status, 200);

  // 逐个读 run.json 断言成员 archivedAt 实际落盘
  for (const id of ['m1', 'm2', 'm3'])
    assert.ok(readRun(home, id).archivedAt, `成员 ${id} 应已归档`);
  assert.ok(readGroup(home, 'g1').archivedAt, '组自身应已归档');
});

test('含 running 成员的组归档返回 400，且全组零 archivedAt 落盘（不做部分归档）', async () => {
  const home = freshHome();
  writeRun(home, { id: 'm1', status: 'done', groupId: 'g1' });
  writeRun(home, { id: 'm2', status: 'running', stage: 'implement', groupId: 'g1' });
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2'] });
  loadStore(home);

  const res = await groupArchivePOST(postReq({ archived: true }), paramCtx('g1'));
  assert.equal(res.status, 400);

  // 关键：不得静默跳过 running 成员而归档其余——组自身与任一成员都没有 archivedAt
  assert.equal(readRun(home, 'm1').archivedAt, undefined, 'done 成员不应被部分归档');
  assert.equal(readRun(home, 'm2').archivedAt, undefined);
  assert.equal(readGroup(home, 'g1').archivedAt, undefined, '组自身不应被写 archivedAt');
});

test('组还原级联清除成员 archivedAt', async () => {
  const home = freshHome();
  const ts = '2026-02-02T00:00:00.000Z';
  writeRun(home, { id: 'm1', status: 'done', groupId: 'g1', archivedAt: ts });
  writeRun(home, { id: 'm2', status: 'done', groupId: 'g1', archivedAt: ts });
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2'], archivedAt: ts });
  loadStore(home);

  const res = await groupArchivePOST(postReq({ archived: false }), paramCtx('g1'));
  assert.equal(res.status, 200);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);
  assert.equal(readRun(home, 'm2').archivedAt, undefined);
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
});

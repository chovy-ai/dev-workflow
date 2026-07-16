import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as runArchivePOST } from '../../app/api/runs/[id]/archive/route';
import { POST as groupArchivePOST } from '../../app/api/groups/[id]/archive/route';
import { freshHome, loadStore, writeRun, writeGroup, readRun, readGroup, postReq, paramCtx } from '../helpers';

/** 构造一个非法 JSON body 的 POST（解析必失败） */
function badJsonReq(): Request {
  return new Request('http://test.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json{',
  });
}

// 合同：archived 必须是明确的布尔；缺失/非布尔/坏 JSON 一律 400，且零落盘副作用。
test('run archive 拒绝非法 body（缺失/非布尔/坏 JSON）→ 400 且 run.json 不变', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r1', status: 'done' }); // 未归档
  loadStore(home);

  for (const body of [{}, { archived: 'false' }, { archived: 1 }, { archived: null }]) {
    const res = await runArchivePOST(postReq(body), paramCtx('r1'));
    assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
    assert.equal(readRun(home, 'r1').archivedAt, undefined, '非法 body 不得写 archivedAt');
  }
  // 坏 JSON
  const res = await runArchivePOST(badJsonReq(), paramCtx('r1'));
  assert.equal(res.status, 400);
  assert.equal(readRun(home, 'r1').archivedAt, undefined);
});

test('run archive 布尔 true/false 仍正常归档/还原', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r1', status: 'done' });
  loadStore(home);

  assert.equal((await runArchivePOST(postReq({ archived: true }), paramCtx('r1'))).status, 200);
  assert.ok(readRun(home, 'r1').archivedAt, 'true 应归档');
  assert.equal((await runArchivePOST(postReq({ archived: false }), paramCtx('r1'))).status, 200);
  assert.equal(readRun(home, 'r1').archivedAt, undefined, 'false 应还原');
});

test('group archive 拒绝非法 body → 400 且组与成员均不变', async () => {
  const home = freshHome();
  writeRun(home, { id: 'm1', status: 'done', groupId: 'g1' });
  writeRun(home, { id: 'm2', status: 'failed', groupId: 'g1' });
  writeGroup(home, { id: 'g1', runIds: ['m1', 'm2'] });
  loadStore(home);

  for (const req of [postReq({}), postReq({ archived: 'false' }), badJsonReq()]) {
    const res = await groupArchivePOST(req, paramCtx('g1'));
    assert.equal(res.status, 400);
    assert.equal(readGroup(home, 'g1').archivedAt, undefined, '组不得被写 archivedAt');
    assert.equal(readRun(home, 'm1').archivedAt, undefined, '成员不得被级联写 archivedAt');
    assert.equal(readRun(home, 'm2').archivedAt, undefined);
  }
});

test('group archive 布尔 true/false 仍正常级联归档/还原', async () => {
  const home = freshHome();
  writeRun(home, { id: 'm1', status: 'done', groupId: 'g1' });
  writeGroup(home, { id: 'g1', runIds: ['m1'] });
  loadStore(home);

  assert.equal((await groupArchivePOST(postReq({ archived: true }), paramCtx('g1'))).status, 200);
  assert.ok(readGroup(home, 'g1').archivedAt);
  assert.ok(readRun(home, 'm1').archivedAt);
  assert.equal((await groupArchivePOST(postReq({ archived: false }), paramCtx('g1'))).status, 200);
  assert.equal(readGroup(home, 'g1').archivedAt, undefined);
  assert.equal(readRun(home, 'm1').archivedAt, undefined);
});

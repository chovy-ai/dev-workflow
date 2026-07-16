// cancelRun 状态机：孤儿 running 可取消；本进程推进中 409；终态 400；404。
// 穿过真实 route handler + Store 落盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshHome, loadStore, writeRun, readRun, paramCtx } from '../helpers';
import { POST as cancelRoute } from '../../app/api/runs/[id]/cancel/route';

test('孤儿 running run 可取消：转 failed、detail 说明可恢复、落盘保真', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-zombie', status: 'running', stage: 'autoReview' });
  loadStore(home);
  const res = await cancelRoute(new Request('http://t.local'), paramCtx('r-zombie'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'failed');
  assert.match(body.statusDetail, /人工取消/);
  assert.match(body.statusDetail, /resume/);
  assert.equal(readRun(home, 'r-zombie').status, 'failed');
});

test('本进程内正在推进的 run 拒绝取消（409）且不落盘', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-live', status: 'running', stage: 'implement' });
  loadStore(home);
  ((globalThis as any).__shipAdvancing as Set<string>).add('r-live');
  const res = await cancelRoute(new Request('http://t.local'), paramCtx('r-live'));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /先停 server/);
  assert.equal(readRun(home, 'r-live').status, 'running');
});

test('终态 run 取消返回 400；未知 id 返回 404', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-done', status: 'done', stage: 'done' });
  loadStore(home);
  assert.equal((await cancelRoute(new Request('http://t.local'), paramCtx('r-done'))).status, 400);
  assert.equal((await cancelRoute(new Request('http://t.local'), paramCtx('r-nope'))).status, 404);
});

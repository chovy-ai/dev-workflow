// /api/meta：server 自述 pid/startedAt/codeSha。测试进程 cwd 是本仓库（git 内），
// codeSha 应为合法 sha；dirty 为布尔。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshHome, loadStore } from '../helpers';
import { GET as metaRoute } from '../../app/api/meta/route';

test('GET /api/meta 返回 pid、startedAt、codeSha', async () => {
  loadStore(freshHome());
  const res = await metaRoute();
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(meta.startedAt)));
  assert.match(meta.codeSha, /^[0-9a-f]{40}$/);
  assert.equal(typeof meta.dirty, 'boolean');
});

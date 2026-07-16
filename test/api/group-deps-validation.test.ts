// 组创建的依赖校验（路由级，原子性）：成环 / 未知 name → 整组 400，一个 run 都不创建。
// 依赖校验在仓库校验之前，用假 repoPath 即可穿过真实 route + createGroup。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshHome, loadStore, postReq } from '../helpers';
import { POST } from '../../app/api/groups/route';

test('依赖成环 → 400，且不创建任何 run/组', async () => {
  const home = freshHome();
  const store = loadStore(home);
  const res = await POST(
    postReq({
      title: 'g',
      repos: [
        { repoPath: '/tmp/fake-a', plan: 'p', name: 'a', dependsOn: ['b'] },
        { repoPath: '/tmp/fake-b', plan: 'p', name: 'b', dependsOn: ['a'] },
      ],
    }) as any,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /依赖成环/);
  assert.equal(store.list().length, 0);
  assert.equal(store.listGroups().length, 0);
});

test('dependsOn 指向未知 name → 400 并指明成员与目标', async () => {
  const home = freshHome();
  loadStore(home);
  const res = await POST(
    postReq({
      title: 'g',
      repos: [
        { repoPath: '/tmp/fake-a', plan: 'p', name: 'a', dependsOn: ['ghost'] },
        { repoPath: '/tmp/fake-b', plan: 'p', name: 'b' },
      ],
    }) as any,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /a.*不存在的 name：ghost/);
});

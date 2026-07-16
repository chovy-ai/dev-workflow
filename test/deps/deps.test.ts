// 仓库间依赖纯函数层：清单校验（环/未知名/自依赖/重名）、name→runId 解析、
// 版本发布判定、awaitDeps 等待决策（上游失败/超时/正常放行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitTimeoutMinutes,
  defaultCheckCmd,
  evalAwaitTick,
  resolveDeps,
  validateGroupDeps,
  versionAdvanced,
} from '../../lib/deps';

test('validateGroupDeps：合法 DAG 通过（含菱形），无依赖清单通过', () => {
  assert.equal(validateGroupDeps([{}, {}]), null);
  assert.equal(
    validateGroupDeps([
      { name: 'lib' },
      { name: 'a', dependsOn: ['lib'] },
      { name: 'b', dependsOn: ['lib'] },
      { name: 'app', dependsOn: ['a', 'b'] },
    ]),
    null,
  );
});

test('validateGroupDeps：未知 name / 自依赖 / 重名 / 缺 name 都拒绝', () => {
  assert.match(validateGroupDeps([{ name: 'a', dependsOn: ['ghost'] }])!, /不存在的 name：ghost/);
  assert.match(validateGroupDeps([{ name: 'a', dependsOn: ['a'] }])!, /不能依赖自己/);
  assert.match(validateGroupDeps([{ name: 'a' }, { name: 'a' }])!, /name 重复/);
  assert.match(validateGroupDeps([{ dependsOn: ['x'] }, { name: 'x' }])!, /缺少 name/);
});

test('validateGroupDeps：两节点环与传递环都检出', () => {
  assert.match(
    validateGroupDeps([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ])!,
    /依赖成环/,
  );
  assert.match(
    validateGroupDeps([
      { name: 'a', dependsOn: ['c'] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['b'] },
    ])!,
    /依赖成环/,
  );
});

test('resolveDeps：name 依赖解析成 run id；只有声明 publishes 的上游产生等待项', () => {
  const repos = [
    { name: 'lib', publishes: { package: '@acme/lib', timeoutMinutes: 10 } },
    { name: 'svc' },
    { name: 'app', dependsOn: ['lib', 'svc'] },
  ];
  const out = resolveDeps(repos, ['r-1', 'r-2', 'r-3']);
  assert.deepEqual(out[0], { dependsOn: [], awaiting: [] });
  assert.deepEqual(out[2].dependsOn, ['r-1', 'r-2']);
  // svc 没有 publishes → 只等 done，不产生等待项
  assert.equal(out[2].awaiting.length, 1);
  assert.deepEqual(out[2].awaiting[0], { runId: 'r-1', package: '@acme/lib', timeoutMinutes: 10 });
});

test('versionAdvanced：无基线任何版本算发布；有基线须版本变化', () => {
  assert.equal(versionAdvanced(null, '1.0.0'), true);
  assert.equal(versionAdvanced(null, null), false);
  assert.equal(versionAdvanced('1.0.0', '1.0.0'), false);
  assert.equal(versionAdvanced('1.0.0', ' 1.0.0 '), false); // 空白容错
  assert.equal(versionAdvanced('1.0.0', '1.0.1'), true);
  assert.equal(versionAdvanced('1.0.0', undefined), false);
});

test('evalAwaitTick：上游缺失/failed → halt 并指明；超时 → halt', () => {
  const base = { published: [], nowMs: 0, deadlineMs: 100, timeoutMinutes: 30 };
  let t = evalAwaitTick({ ...base, upstreams: [{ id: 'r-x', status: undefined }] });
  assert.equal(t.kind, 'halt');
  assert.match((t as any).reason, /r-x/);
  t = evalAwaitTick({ ...base, upstreams: [{ id: 'r-up', status: 'failed' }] });
  assert.equal(t.kind, 'halt');
  assert.match((t as any).reason, /r-up.*阻塞于依赖/);
  t = evalAwaitTick({ ...base, nowMs: 101, upstreams: [{ id: 'r-up', status: 'running' }] });
  assert.equal(t.kind, 'halt');
  assert.match((t as any).reason, /超时.*30 分钟/);
});

test('evalAwaitTick：上游未全 done 或发布未探测到 → wait；全就绪 → ready', () => {
  const base = { nowMs: 0, deadlineMs: 100, timeoutMinutes: 30 };
  assert.equal(
    evalAwaitTick({ ...base, published: [], upstreams: [{ id: 'a', status: 'running' }, { id: 'b', status: 'done' }] }).kind,
    'wait',
  );
  assert.equal(
    evalAwaitTick({ ...base, published: [true, false], upstreams: [{ id: 'a', status: 'done' }] }).kind,
    'wait',
  );
  assert.equal(
    evalAwaitTick({ ...base, published: [true], upstreams: [{ id: 'a', status: 'done' }] }).kind,
    'ready',
  );
  // 无发布物等待项：上游全 done 即放行
  assert.equal(
    evalAwaitTick({ ...base, published: [], upstreams: [{ id: 'a', status: 'done' }] }).kind,
    'ready',
  );
});

test('辅助：默认探测命令与组超时取大', () => {
  assert.equal(defaultCheckCmd('@acme/lib'), 'npm view "@acme/lib" version');
  assert.equal(awaitTimeoutMinutes([]), 30);
  assert.equal(awaitTimeoutMinutes([{ timeoutMinutes: 10 }, { timeoutMinutes: 45 }]), 45);
});

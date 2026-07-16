import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeRun, isAdvancing } from '../../lib/runtime';
import { freshHome, loadStore, writeRun, readRun } from '../helpers';

// 归档不影响断点续跑：resume 一个已归档的 failed run 会先自动取消归档再续跑。
// 走真实 resumeRun（真实 Store 载入 + 真实 advance），不 mock advance。
test('resume 已归档 failed run：先清 archivedAt，再回到 running 并真实进入 advance', () => {
  const home = freshHome();
  // 已归档、失败、无 worktree/无分支（advance 会在 prepareResume 处 Halt，不触发引擎/网络）
  writeRun(home, {
    id: 'r-arch',
    status: 'failed',
    stage: 'implement',
    branch: null,
    worktreePath: null,
    archivedAt: '2026-04-04T00:00:00.000Z',
    statusDetail: '上次失败',
  });
  loadStore(home);

  const { run, status } = resumeRun('r-arch');
  assert.equal(status, 200);
  assert.ok(run);
  // 返回对象：archivedAt 清空、status 回到 running
  assert.equal(run!.archivedAt, undefined, 'resume 应先取消归档');
  assert.equal(run!.status, 'running');
  // 落盘保真：run.json 同样清了 archivedAt、status=running
  const onDisk = readRun(home, 'r-arch');
  assert.equal(onDisk.archivedAt, undefined);
  assert.equal(onDisk.status, 'running');
  // 真实进入 advance（同步加入推进锁）
  assert.equal(isAdvancing('r-arch'), true, '应已真实进入 advance');
});

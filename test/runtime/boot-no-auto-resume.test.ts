// bootRecover 护栏：SHIP_NO_AUTO_RESUME=1 时检测到中断 run 只写事件、不自动续跑
// （不 bump resumes、不进入流水线）。走真实 getStore 启动路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshHome, writeRun } from '../helpers';
import { getStore } from '../../lib/runtime';

test('SHIP_NO_AUTO_RESUME=1：孤儿 running run 保持原状，只留一条说明事件', async () => {
  const home = freshHome();
  writeRun(home, { id: 'r-orphan', status: 'running', stage: 'implement', resumes: 1 });
  // 走真实 boot 路径：清掉 helpers 预置的 booted 标记，让 getStore 触发 bootRecover
  (globalThis as any).__shipStore = undefined;
  (globalThis as any).__shipBooted = undefined;
  process.env.SHIP_NO_AUTO_RESUME = '1';
  try {
    const store = getStore();
    await new Promise((r) => setTimeout(r, 50)); // bootRecover 在 setTimeout(0) 里跑
    const run = store.get('r-orphan')!;
    assert.equal(run.status, 'running'); // 未被续跑也未被判失败
    assert.equal(run.resumes, 1); // 不 bump
    const events = fs.readFileSync(path.join(home, 'runs', 'r-orphan', 'events.ndjson'), 'utf8');
    assert.match(events, /SHIP_NO_AUTO_RESUME/);
  } finally {
    delete process.env.SHIP_NO_AUTO_RESUME;
    (globalThis as any).__shipBooted = true; // 恢复测试全局约定，避免影响同进程其它用例
  }
});

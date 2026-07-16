// attach 重连策略纯函数：指数退避封顶、持续不可达才放弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTACH_GIVE_UP_MS, nextBackoffMs, shouldGiveUp } from '../../lib/attachPolicy';

test('退避：1s→2s→4s…封顶 30s，负数/超大 attempt 不越界', () => {
  assert.equal(nextBackoffMs(0), 1000);
  assert.equal(nextBackoffMs(1), 2000);
  assert.equal(nextBackoffMs(2), 4000);
  assert.equal(nextBackoffMs(4), 16_000);
  assert.equal(nextBackoffMs(5), 30_000);
  assert.equal(nextBackoffMs(100), 30_000);
  assert.equal(nextBackoffMs(-1), 1000);
});

test('放弃判定：达到时限才放弃，默认时限 5 分钟', () => {
  const t0 = 1_000_000;
  assert.equal(shouldGiveUp(t0, t0 + ATTACH_GIVE_UP_MS - 1), false);
  assert.equal(shouldGiveUp(t0, t0 + ATTACH_GIVE_UP_MS), true);
  assert.equal(shouldGiveUp(t0, t0 + 10, 10), true); // 自定义时限
});

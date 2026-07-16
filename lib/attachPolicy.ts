// attach 断线重连策略（纯函数，单测覆盖）：SSE 断开不裸崩——指数退避重连、
// 按 seq 续读；只有 server 持续不可达才放弃。与 CLI 解耦，便于测试。

/** 持续不可达多久后放弃跟踪（run 本身在 server 侧不受影响） */
export const ATTACH_GIVE_UP_MS = 5 * 60_000;

/** 第 attempt 次重连（从 0 起）前的等待：1s → 2s → 4s … 封顶 30s */
export function nextBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(attempt, 0), 10));
}

/** 自 failedSinceMs 起持续失败是否应放弃（server 持续不可达） */
export function shouldGiveUp(
  failedSinceMs: number,
  nowMs: number,
  limitMs: number = ATTACH_GIVE_UP_MS,
): boolean {
  return nowMs - failedSinceMs >= limitMs;
}

// SSE 事件流 ?filter=core：不含 engine-line，其余事件照旧（回放段验证）。
// 穿过真实 route handler + 真实 Store 落盘的 events.ndjson。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { freshHome, loadStore, writeRun, paramCtx } from '../helpers';
import { GET } from '../../app/api/runs/[id]/events/route';

/** 读 SSE Response 的回放段：收满 n 条 data: 行即取消流（实时段不结束，不能等 EOF） */
async function readSse(res: Response, n: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: string[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (chunk.startsWith('data: ')) out.push(chunk.slice(6));
    }
  }
  await reader.cancel();
  return out;
}

test('?filter=core 不推 engine-line；默认流包含全部事件', async () => {
  const home = freshHome();
  const store = loadStore(home);
  const run = writeRun(home, { id: 'r-ev1', status: 'running', stage: 'implement' });
  loadStore(home); // 重新载入让 store 认识新写入的 run
  const s = (globalThis as any).__shipStore as typeof store;
  const r = s.get('r-ev1')!;
  s.event(r, 'stage', { stage: 'implement' });
  s.event(r, 'engine', { label: 'implement', state: 'start', engine: 'claude' });
  s.event(r, 'engine-line', { label: 'implement', line: 'noisy agent output' });
  s.event(r, 'engine-line', { label: 'implement', line: 'more noise' });
  s.event(r, 'engine', { label: 'implement', state: 'end', code: 0 });

  // 默认：5 条事件 + sync 标记
  const full = await readSse(
    await GET(new NextRequest('http://t.local/api/runs/r-ev1/events?after=0'), paramCtx('r-ev1')),
    6,
  );
  assert.equal(full.filter((d) => d.includes('"engine-line"')).length, 2);

  // core：跳过 engine-line，3 条事件 + sync 标记
  const core = await readSse(
    await GET(
      new NextRequest('http://t.local/api/runs/r-ev1/events?after=0&filter=core'),
      paramCtx('r-ev1'),
    ),
    4,
  );
  assert.equal(core.filter((d) => d.includes('"engine-line"')).length, 0);
  assert.equal(core.filter((d) => d.includes('"engine"')).length, 2);
  assert.ok(core.some((d) => d.includes('"sync"')));
});

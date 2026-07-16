import type { NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import type { RunEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * SSE 事件流：先回放历史（?after=seq 之后的），再实时推送。web 和 CLI 共用。
 * ?filter=core 时不含 engine-line（agent 逐行输出）——只推核心进展事件，
 * 供只关心进度/错误的订阅方降载；回放与实时推送同一口径。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getStore();
  if (!store.get(id)) return new Response('unknown run', { status: 404 });
  const after = Number(req.nextUrl.searchParams.get('after') ?? 0);
  const coreOnly = req.nextUrl.searchParams.get('filter') === 'core';

  const encoder = new TextEncoder();
  // 清理必须同时挂在 req.signal abort（HTTP 断开）和 stream cancel（消费端 cancel）上：
  // 只挂 abort 的话，reader.cancel() 场景下 ping interval 和 bus listener 会永久泄漏
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: RunEvent) => {
        if (coreOnly && ev.type === 'engine-line') return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };
      for (const ev of store.readEvents(id, after)) send(ev);
      // 回放/实时的分界标记：客户端在此之前看到的 status 都是历史，不能当作当前状态
      send({ seq: -1, ts: new Date().toISOString(), type: 'sync', data: {} });

      const listener = (runId: string, ev: RunEvent) => {
        if (runId !== id) return;
        try {
          send(ev);
        } catch {
          /* controller 已关闭 */
        }
      };
      store.bus.on('event', listener);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* ignore */
        }
      }, 15000);
      cleanup = () => {
        store.bus.off('event', listener);
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener('abort', () => cleanup?.());
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

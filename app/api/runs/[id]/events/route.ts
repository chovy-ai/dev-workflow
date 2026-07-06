import type { NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import type { RunEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** SSE 事件流：先回放历史（?after=seq 之后的），再实时推送。web 和 CLI 共用。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getStore();
  if (!store.get(id)) return new Response('unknown run', { status: 404 });
  const after = Number(req.nextUrl.searchParams.get('after') ?? 0);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: RunEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
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
      req.signal.addEventListener('abort', () => {
        store.bus.off('event', listener);
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
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

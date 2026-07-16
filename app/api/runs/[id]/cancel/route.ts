import { NextResponse } from 'next/server';
import { cancelRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 取消孤儿 running run（server 中断遗留的记录）。
 * 正在本进程推进的 run 返回 409——流水线没有暂停点，先停 server 再取消。
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { run, error, status } = cancelRun(id);
  if (!run) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

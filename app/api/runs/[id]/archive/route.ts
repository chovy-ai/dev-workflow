import { NextResponse } from 'next/server';
import { archiveRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 归档 / 还原一个 run。body: { archived: boolean }（true 归档、false 还原）。
 * running 归档返回 400（进行中不可归档）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const archived = body?.archived !== false; // 缺省视为归档
  const { run, error, status } = archiveRun(id, archived);
  if (!run) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

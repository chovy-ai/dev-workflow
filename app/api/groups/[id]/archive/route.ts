import { NextResponse } from 'next/server';
import { archiveGroup } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 归档 / 还原一个组，级联全部成员 run。body: { archived: boolean }。
 * 组内有 running 成员时归档返回 400，且不做部分归档（原子）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const archived = body?.archived !== false;
  const { group, runs, error, status } = archiveGroup(id, archived);
  if (!group) return NextResponse.json({ error }, { status });
  return NextResponse.json({ group, runs }, { status });
}

import { NextResponse } from 'next/server';
import { archiveRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 归档 / 还原一个 run。body: { archived: boolean }（true 归档、false 还原）。
 * running 归档返回 400（进行中不可归档）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  // 合同：archived 必须是明确的布尔（缺失/非布尔/坏 JSON 一律拒绝，不得偷换成归档而落盘）
  if (!body || typeof body.archived !== 'boolean')
    return NextResponse.json({ error: 'body 需要布尔字段 archived' }, { status: 400 });
  const { run, error, status } = archiveRun(id, body.archived);
  if (!run) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

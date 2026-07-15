import { NextResponse } from 'next/server';
import { resumeRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/** 手动续跑一个中断/失败的 run（从持久化的 stage 继续） */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { run, error, status } = resumeRun(id);
  if (!run) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

import { NextRequest, NextResponse } from 'next/server';
import { createSuccessorRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/** 从 failed run 的保留分支创建一条新预算的后继执行。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const { run, error, status } = await createSuccessorRun({
    parentRunId: id,
    plan: typeof body.plan === 'string' ? body.plan : undefined,
    config:
      body.config && typeof body.config === 'object'
        ? body.config as Parameters<typeof createSuccessorRun>[0]['config']
        : undefined,
  });
  if (!run) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

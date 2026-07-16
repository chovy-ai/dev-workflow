import { NextRequest, NextResponse } from 'next/server';
import { getStore, createRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/** 默认过滤掉已归档 run（按 run 自身 archivedAt）；?archived=1 只返回已归档项 */
export async function GET(req: NextRequest) {
  const archived = new URL(req.url).searchParams.get('archived') === '1';
  const runs = getStore()
    .list()
    .filter((r) => !!r.archivedAt === archived);
  return NextResponse.json(runs);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body.repoPath || !body.plan)
    return NextResponse.json({ error: '需要 repoPath 和 plan' }, { status: 400 });
  const { run, error, status } = await createRun(body);
  if (error) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

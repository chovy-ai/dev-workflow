import { NextRequest, NextResponse } from 'next/server';
import { getStore, createRun } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getStore().list());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body.repoPath || !body.plan)
    return NextResponse.json({ error: '需要 repoPath 和 plan' }, { status: 400 });
  const { run, error, status } = await createRun(body);
  if (error) return NextResponse.json({ error }, { status });
  return NextResponse.json(run, { status });
}

import { NextResponse } from 'next/server';
import { getStore } from '@/lib/runtime';
import { deriveGroupStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 组详情：{ group, status, runs }（runs 为完整 RunRecord 数组） */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getStore();
  const group = store.getGroup(id);
  if (!group) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const runs = store.groupRuns(group);
  return NextResponse.json({ group, status: deriveGroupStatus(runs), runs });
}

import { NextResponse } from 'next/server';
import { getStore } from '@/lib/runtime';
import { git } from '@/lib/exec';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getStore().get(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = await git(run.repoPath, 'diff', `${run.config.base}...HEAD`);
  return NextResponse.json({ diff: r.code === 0 ? r.out : `git diff 失败：${r.out}` });
}

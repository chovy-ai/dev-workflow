import { NextRequest, NextResponse } from 'next/server';
import { getStore, createGroup } from '@/lib/runtime';
import { deriveGroupStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 组列表：每项带推导状态与成员 run 摘要 */
export async function GET() {
  const store = getStore();
  const groups = store.listGroups().map((g) => {
    const runs = store.groupRuns(g);
    return {
      ...g,
      status: deriveGroupStatus(runs),
      runs: runs.map((r) => ({
        id: r.id,
        repoPath: r.repoPath,
        stage: r.stage,
        status: r.status,
      })),
    };
  });
  return NextResponse.json(groups);
}

/**
 * 原子创建运行组。body：{ title, repos: [{ repoPath, plan }] }
 * plan 是方案文本（CLI 负责读文件，server 不解析相对路径）。
 * 任一仓库校验不通过 → 4xx 并指明是哪个仓库、什么原因，一个 run 都不创建。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body.title || !Array.isArray(body.repos) || body.repos.length === 0)
    return NextResponse.json({ error: '需要 title 和非空 repos' }, { status: 400 });
  for (const r of body.repos)
    if (!r?.repoPath || !r?.plan)
      return NextResponse.json({ error: '每个 repo 需要 repoPath 和 plan' }, { status: 400 });

  const { group, runs, error, status } = await createGroup(body);
  if (error) return NextResponse.json({ error }, { status });
  return NextResponse.json({ group, runs }, { status });
}

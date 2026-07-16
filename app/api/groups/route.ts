import { NextResponse } from 'next/server';
import { getStore, createGroup } from '@/lib/runtime';
import { deriveGroupStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * 组列表：每项带推导状态与成员 run 摘要。
 * 默认过滤掉已归档组（按组自身 archivedAt，与成员各自的 archivedAt 独立）；?archived=1 只返回已归档组。
 * 成员摘要带 updatedAt，供侧边栏推导组的最大 updatedAt 用于排序。
 */
export async function GET(req: Request) {
  const archived = new URL(req.url).searchParams.get('archived') === '1';
  const store = getStore();
  const groups = store
    .listGroups()
    .filter((g) => !!g.archivedAt === archived)
    .map((g) => {
      const runs = store.groupRuns(g);
      return {
        ...g,
        status: deriveGroupStatus(runs),
        runs: runs.map((r) => ({
          id: r.id,
          repoPath: r.repoPath,
          stage: r.stage,
          status: r.status,
          updatedAt: r.updatedAt,
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
export async function POST(req: Request) {
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

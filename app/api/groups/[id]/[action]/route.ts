import { NextRequest, NextResponse } from 'next/server';
import { getStore, advance, isAdvancing } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 组级批量操作：
 * approve —— 对组内所有 awaiting_review 成员执行与单 run approve 完全相同的逻辑（stage→pr、advance）
 * reject  —— 对指定成员注入联动打回意见（stage→autoReview、advance）
 * 组是纯聚合层：这里只是对成员逐个套用单 run 的既有语义，不引入跨仓库耦合。
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const store = getStore();
  const group = store.getGroup(id);
  if (!group) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const runs = store.groupRuns(group);

  switch (action) {
    case 'approve': {
      const targets = runs.filter((r) => r.status === 'awaiting_review');
      if (targets.length === 0)
        return NextResponse.json({ error: '组内没有等待人工 review 的成员' }, { status: 409 });
      const runIds: string[] = [];
      for (const run of targets) {
        // 与单 run approve 完全一致
        store.event(run, 'log', { msg: '✔ 人工 review 通过（整组）→ 提 PR' });
        run.stage = 'pr';
        store.save(run);
        advance(run);
        runIds.push(run.id);
      }
      return NextResponse.json({ runIds });
    }
    case 'reject': {
      const body = await req.json().catch(() => ({}));
      const feedback = String(body?.feedback ?? '').trim();
      if (!feedback) return NextResponse.json({ error: '打回必须附意见 feedback' }, { status: 400 });
      const runIds: unknown = body?.runIds;
      if (!Array.isArray(runIds) || runIds.length === 0)
        return NextResponse.json({ error: '需要非空 runIds' }, { status: 400 });

      // 校验：每个目标必须属于该组、存在，且没有推进中——任一不满足整个请求 4xx，不改动任何成员
      const targets = [];
      for (const rid of runIds) {
        if (!group.runIds.includes(rid))
          return NextResponse.json({ error: `${rid} 不属于该组` }, { status: 400 });
        const run = store.get(rid);
        if (!run) return NextResponse.json({ error: `${rid} 不存在` }, { status: 404 });
        if (run.status === 'running' || isAdvancing(run.id))
          return NextResponse.json(
            { error: `${rid} 正在推进中，等它停下（或到人工门禁）再打回` },
            { status: 409 },
          );
        targets.push(run);
      }

      for (const run of targets) {
        // 与单 run reject 语义一致，仅意见加 [联动打回] 前缀
        run.feedback.push('[联动打回] ' + feedback);
        run.stage = 'autoReview';
        store.save(run);
        store.event(run, 'log', { msg: `⟲ 联动打回：${feedback}` });
        advance(run);
      }
      return NextResponse.json({ runIds: targets.map((r) => r.id) });
    }
    default:
      return NextResponse.json({ error: `未知操作 ${action}` }, { status: 404 });
  }
}

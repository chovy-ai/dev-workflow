import { NextRequest, NextResponse } from 'next/server';
import { getStore, advance, isAdvancing } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/** 人工控制：approve（review 通过）/ reject（打回）/ continue（阻塞后续跑） */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const store = getStore();
  const run = store.get(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });

  switch (action) {
    case 'approve': {
      if (run.status !== 'awaiting_review')
        return NextResponse.json(
          { error: `当前状态 ${run.status}，不在人工 review 门禁` },
          { status: 409 },
        );
      store.event(run, 'log', { msg: '✔ 人工 review 通过 → 提 PR' });
      run.stage = 'pr';
      store.save(run);
      advance(run);
      return NextResponse.json(run);
    }
    case 'reject': {
      const body = await req.json().catch(() => ({}));
      const feedback = String(body?.feedback ?? '').trim();
      if (!feedback) return NextResponse.json({ error: '打回必须附意见 feedback' }, { status: 400 });
      if (run.status === 'running' || isAdvancing(run.id))
        return NextResponse.json(
          { error: '流水线推进中，等它停下（或到人工门禁）再打回' },
          { status: 409 },
        );
      run.feedback.push(feedback);
      run.stage = 'autoReview'; // 修复 → LLM 复审 → 重新到人工门禁 → (若有 PR) push 更新
      store.save(run);
      store.event(run, 'log', { msg: `⟲ 人工打回：${feedback}` });
      advance(run);
      return NextResponse.json(run);
    }
    case 'cancel': {
      if (run.status === 'running' || isAdvancing(run.id))
        return NextResponse.json({ error: '流水线推进中，等它停下再取消' }, { status: 409 });
      if (run.status === 'done') return NextResponse.json({ error: '该运行已完成' }, { status: 409 });
      run.status = 'failed';
      run.statusDetail = '人工取消';
      store.save(run);
      store.event(run, 'log', { msg: '✖ 人工取消该运行' });
      store.event(run, 'status', { status: 'failed', detail: '人工取消' });
      return NextResponse.json(run);
    }
    case 'continue': {
      if (run.status === 'running' || isAdvancing(run.id))
        return NextResponse.json({ error: '已在推进中' }, { status: 409 });
      if (run.status === 'done') return NextResponse.json({ error: '该运行已完成' }, { status: 409 });
      store.event(run, 'log', { msg: `从阶段 ${run.stage} 继续` });
      advance(run);
      return NextResponse.json(run);
    }
    default:
      return NextResponse.json({ error: `未知操作 ${action}` }, { status: 404 });
  }
}

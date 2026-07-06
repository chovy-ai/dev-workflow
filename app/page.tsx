'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunEvent, RunRecord } from '@/lib/types';

const STAGES = ['branch', 'implement', 'autoReview', 'humanReview', 'pr', 'ci', 'done'] as const;
const STAGE_LABEL: Record<string, string> = {
  branch: '建分支', implement: '实现', autoReview: 'LLM 审查',
  humanReview: '人工 Review', pr: '提 PR', ci: 'CI/冲突', done: '完成',
};
const STATUS_LABEL: Record<string, string> = {
  running: '进行中', awaiting_review: '等待人工 Review',
  blocked: '需人工处理', failed: '失败', done: '完成·等人工合并',
};

type LogLine = { key: number; cls: string; text: string };

function formatEvent(ev: RunEvent): LogLine | null {
  const ts = ev.ts.slice(11, 19);
  const d = ev.data as any;
  switch (ev.type) {
    case 'log':
      return { key: ev.seq, cls: '', text: `${ts}  ${d.msg}` };
    case 'stage':
      return { key: ev.seq, cls: 'stage-line', text: `${ts}  ══ 阶段 ${STAGE_LABEL[d.stage] ?? d.stage} ══` };
    case 'engine-line':
      return { key: ev.seq, cls: 'engine-line', text: `${ts}    │ ${d.line}` };
    case 'status':
      return { key: ev.seq, cls: '', text: `${ts}  → ${STATUS_LABEL[d.status] ?? d.status}${d.detail ? '：' + d.detail : ''}` };
    case 'review':
      return { key: ev.seq, cls: '', text: `${ts}  review 第 ${d.round} 轮：${d.passed ? '通过 ✓' : `${d.findings.length} 个问题`}` };
    case 'error':
      return { key: ev.seq, cls: 'error-line', text: `${ts}  ✖ ${d.error}` };
    default:
      return null;
  }
}

export default function Page() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [diff, setDiff] = useState('');
  const [tab, setTab] = useState<'log' | 'diff' | 'findings' | 'plan'>('log');
  const logRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLDialogElement>(null);
  const [rejectText, setRejectText] = useState('');
  const runIdRef = useRef<string | null>(null);

  const loadRuns = useCallback(async () => {
    setRuns(await (await fetch('/api/runs')).json());
  }, []);

  const refreshRun = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`);
    if (res.ok) setRun(await res.json());
  }, []);

  const loadDiff = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}/diff`);
    if (res.ok) setDiff((await res.json()).diff ?? '');
  }, []);

  // 选中 run：加载详情 + 订阅 SSE 事件流
  const openRun = useCallback(
    (id: string) => {
      runIdRef.current = id;
      setLines([]);
      setDiff('');
      refreshRun(id);
      loadDiff(id);
      const es = new EventSource(`/api/runs/${id}/events?after=0`);
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as RunEvent;
        const line = formatEvent(ev);
        if (line) setLines((prev) => (prev.some((l) => l.key === line.key) ? prev : [...prev, line]));
        if (ev.type === 'status' || ev.type === 'stage' || ev.type === 'review') {
          refreshRun(id);
          loadRuns();
          loadDiff(id);
        }
      };
      return () => es.close();
    },
    [refreshRun, loadDiff, loadRuns],
  );

  // hash 路由：#/run/<id>
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const route = () => {
      const m = location.hash.match(/^#\/run\/(.+)$/);
      cleanup?.();
      cleanup = undefined;
      if (m) cleanup = openRun(m[1]);
      else {
        runIdRef.current = null;
        setRun(null);
      }
    };
    route();
    window.addEventListener('hashchange', route);
    return () => {
      window.removeEventListener('hashchange', route);
      cleanup?.();
    };
  }, [openRun]);

  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 5000);
    return () => clearInterval(t);
  }, [loadRuns]);

  // 日志自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, tab]);

  const act = async (action: string, body?: unknown) => {
    if (!run) return;
    const res = await fetch(`/api/runs/${run.id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) alert((await res.json()).error);
    refreshRun(run.id);
    loadRuns();
  };

  const submitReject = () => {
    const fb = rejectText.trim();
    if (fb) act('reject', { feedback: fb });
    rejectRef.current?.close();
  };

  const stageIdx = run ? STAGES.indexOf(run.stage) : -1;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>⛵ ship</h1>
          <span className="sub">方案 → PR 交付流水线 · 本地</span>
        </header>
        <div className="run-list">
          {runs.length === 0 && (
            <div className="empty-list">
              还没有运行。在仓库里执行：
              <br />
              <code>ship start --plan plan.md</code>
            </div>
          )}
          {runs.map((r) => (
            <div
              key={r.id}
              className={`run-item${run?.id === r.id ? ' active' : ''}`}
              onClick={() => (location.hash = `#/run/${r.id}`)}
            >
              <div className="t">
                <span className="name">{r.title}</span>
                <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
              <div className="meta">
                {r.id} · {r.branch ?? ''}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {!run ? (
          <div className="empty">
            ← 选择一个运行，或在仓库里 <code>ship start --plan plan.md</code>
          </div>
        ) : (
          <div className="detail">
            <div className="run-header">
              <div>
                <h2>{run.title}</h2>
                <div className="meta">
                  {run.repoPath} · {run.branch ?? '(分支未建)'} → {run.config.base} · engine:{' '}
                  {run.config.engine}
                </div>
              </div>
              <span className={`badge ${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
            </div>

            <div className="stepper">
              {STAGES.map((s, i) => {
                const cls = run.status === 'done' || i < stageIdx ? 'done' : i === stageIdx ? 'current' : '';
                return (
                  <div key={s} className={`step ${cls}`}>
                    {cls === 'done' ? '✓' : cls === 'current' ? '●' : '○'} {STAGE_LABEL[s]}
                  </div>
                );
              })}
            </div>

            {run.status !== 'running' && (
              <div className={`banner ${run.status}`}>
                <div className="detail-text">{run.statusDetail || STATUS_LABEL[run.status]}</div>
                <div className="actions">
                  {run.status === 'awaiting_review' && (
                    <>
                      <button className="btn primary" onClick={() => act('approve')}>
                        ✓ 通过，去提 PR
                      </button>
                      <button className="btn danger" onClick={() => rejectRef.current?.showModal()}>
                        ⟲ 打回
                      </button>
                    </>
                  )}
                  {(run.status === 'blocked' || run.status === 'failed') && (
                    <>
                      <button className="btn primary" onClick={() => act('continue')}>
                        继续
                      </button>
                      <button className="btn danger" onClick={() => rejectRef.current?.showModal()}>
                        ⟲ 打回
                      </button>
                    </>
                  )}
                  {run.status === 'done' && (
                    <>
                      {run.prUrl && (
                        <a className="btn primary" href={run.prUrl} target="_blank">
                          打开 PR 合并 ↗
                        </a>
                      )}
                      <button className="btn danger" onClick={() => rejectRef.current?.showModal()}>
                        ⟲ 还有问题，打回
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            <nav className="tabs">
              {(['log', 'diff', 'findings', 'plan'] as const).map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); if (t === 'diff' && run) loadDiff(run.id); }}>
                  {{ log: '日志', diff: 'Diff', findings: '审查发现', plan: '方案' }[t]}
                </button>
              ))}
            </nav>

            <div className="tab-body" ref={tab === 'log' ? logRef : undefined}>
              {tab === 'log' && (
                <pre className="log">
                  {lines.map((l) => (
                    <span key={l.key} className={l.cls}>
                      {l.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              )}
              {tab === 'diff' && (
                <pre className="diff">
                  {(diff || '（暂无改动）').split('\n').map((raw, i) => {
                    const cls = raw.startsWith('diff --git')
                      ? 'file'
                      : raw.startsWith('@@')
                        ? 'hunk'
                        : raw.startsWith('+') && !raw.startsWith('+++')
                          ? 'add'
                          : raw.startsWith('-') && !raw.startsWith('---')
                            ? 'del'
                            : '';
                    return (
                      <span key={i} className={cls}>
                        {raw}
                      </span>
                    );
                  })}
                </pre>
              )}
              {tab === 'findings' &&
                (run.findings?.length ? (
                  <>
                    <div className="findings-note">最近一轮（第 {run.reviewRound} 轮）的 must_fix 发现：</div>
                    {run.findings.map((f, i) => (
                      <div key={i} className="finding">
                        <div className="file">{f.file}</div>
                        <div>{f.issue}</div>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="findings-note">
                    最近一轮 LLM 审查没有 must_fix 发现
                    {run.reviewRound ? `（共跑了 ${run.reviewRound} 轮）` : ''}。
                  </div>
                ))}
              {tab === 'plan' && <pre className="plan">{run.plan}</pre>}
            </div>
          </div>
        )}
      </main>

      <dialog ref={rejectRef}>
        <h3>打回意见</h3>
        <textarea
          rows={6}
          value={rejectText}
          onChange={(e) => setRejectText(e.target.value)}
          placeholder="说明哪里不行、期望改成什么样。会交给 engine 修复后重新进入复审循环。"
        />
        <div className="dialog-actions">
          <button className="btn" onClick={() => rejectRef.current?.close()}>
            取消
          </button>
          <button className="btn danger" onClick={submitReject}>
            打回
          </button>
        </div>
      </dialog>
    </div>
  );
}

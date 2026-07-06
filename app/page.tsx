'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupRecord, RunEvent, RunRecord } from '@/lib/types';

const STAGES = ['branch', 'implement', 'autoReview', 'humanReview', 'pr', 'ci', 'done'] as const;
const STAGE_LABEL: Record<string, string> = {
  branch: '建分支', implement: '实现', autoReview: 'LLM 审查',
  humanReview: '人工 Review', pr: '提 PR', ci: 'CI/冲突', done: '完成',
};
// run 与 group 状态共用一套标签（组状态是 running/awaiting_review/blocked/done 的子集）
const STATUS_LABEL: Record<string, string> = {
  running: '进行中', awaiting_review: '等待人工 Review',
  blocked: '需人工处理', failed: '失败', done: '完成·等人工合并',
};

/** 组状态标签（比单 run 略简） */
const GROUP_STATUS_LABEL: Record<string, string> = {
  running: '推进中', awaiting_review: '有成员待 Review', blocked: '有成员需处理', done: '全部完成',
};

/** 取路径最后一段目录名 */
const dirName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

type LogLine = { key: number; cls: string; text: string };

/** 组列表项（GET /api/groups） */
type GroupSummary = {
  id: string;
  title: string;
  runIds: string[];
  createdAt: string;
  status: string;
  runs: { id: string; repoPath: string; stage: string; status: string }[];
};
/** 组详情（GET /api/groups/:id） */
type GroupDetail = { group: GroupRecord; status: string; runs: RunRecord[] };

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

/** diff 单行着色（run 与 group 视图共用） */
function diffLineClass(raw: string): string {
  if (raw.startsWith('diff --git')) return 'file';
  if (raw.startsWith('@@')) return 'hunk';
  if (raw.startsWith('+') && !raw.startsWith('+++')) return 'add';
  if (raw.startsWith('-') && !raw.startsWith('---')) return 'del';
  return '';
}

/** 着色 diff 块（复用现有单仓的着色逻辑） */
function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {(diff || '（暂无改动）').split('\n').map((raw, i) => (
        <span key={i} className={diffLineClass(raw)}>
          {raw}
        </span>
      ))}
    </pre>
  );
}

/** 最近一轮 LLM 审查的 must_fix 发现 */
function FindingsBody({ run }: { run: RunRecord }) {
  if (run.findings?.length)
    return (
      <>
        <div className="findings-note">最近一轮（第 {run.reviewRound} 轮）的 must_fix 发现：</div>
        {run.findings.map((f, i) => (
          <div key={i} className="finding">
            <div className="file">{f.file}</div>
            <div>{f.issue}</div>
          </div>
        ))}
      </>
    );
  return (
    <div className="findings-note">
      最近一轮 LLM 审查没有 must_fix 发现
      {run.reviewRound ? `（共跑了 ${run.reviewRound} 轮）` : ''}。
    </div>
  );
}

export default function Page() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [diff, setDiff] = useState('');
  const [groupDiffs, setGroupDiffs] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'log' | 'diff' | 'findings' | 'plan'>('log');
  const [groupTab, setGroupTab] = useState<'diff' | 'findings' | 'plan'>('diff');
  const logRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLDialogElement>(null);
  const groupRejectRef = useRef<HTMLDialogElement>(null);
  const [rejectText, setRejectText] = useState('');
  const [groupRejectText, setGroupRejectText] = useState('');
  const [rejectChecks, setRejectChecks] = useState<Record<string, boolean>>({});
  const runIdRef = useRef<string | null>(null);
  const groupIdRef = useRef<string | null>(null);

  // 侧边栏数据：runs + groups 一起刷新
  const loadRuns = useCallback(async () => {
    const [rs, gs] = await Promise.all([
      fetch('/api/runs').then((r) => r.json()).catch(() => []),
      fetch('/api/groups').then((r) => r.json()).catch(() => []),
    ]);
    setRuns(rs);
    setGroups(gs);
  }, []);

  const refreshRun = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`);
    if (res.ok) setRun(await res.json());
  }, []);

  const loadDiff = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}/diff`);
    if (res.ok) setDiff((await res.json()).diff ?? '');
  }, []);

  // 组详情 + 各成员 diff
  const refreshGroup = useCallback(async (gid: string) => {
    const res = await fetch(`/api/groups/${gid}`);
    if (!res.ok) return;
    const data = (await res.json()) as GroupDetail;
    setGroup(data);
    for (const r of data.runs) {
      const dr = await fetch(`/api/runs/${r.id}/diff`);
      if (dr.ok) {
        const j = await dr.json();
        setGroupDiffs((prev) => ({ ...prev, [r.id]: j.diff ?? '' }));
      }
    }
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

  // 选中 group：加载详情 + 5s 轮询（组视图不走 SSE，保持简单）
  const openGroup = useCallback(
    (gid: string) => {
      groupIdRef.current = gid;
      setGroup(null);
      setGroupDiffs({});
      setGroupTab('diff');
      refreshGroup(gid);
      const t = setInterval(() => refreshGroup(gid), 5000);
      return () => {
        clearInterval(t);
        groupIdRef.current = null;
      };
    },
    [refreshGroup],
  );

  // hash 路由：#/run/<id> 或 #/group/<gid>
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const route = () => {
      cleanup?.();
      cleanup = undefined;
      const rm = location.hash.match(/^#\/run\/(.+)$/);
      const gm = location.hash.match(/^#\/group\/(.+)$/);
      if (rm) {
        setGroup(null);
        groupIdRef.current = null;
        cleanup = openRun(rm[1]);
      } else if (gm) {
        setRun(null);
        runIdRef.current = null;
        cleanup = openGroup(gm[1]);
      } else {
        runIdRef.current = null;
        groupIdRef.current = null;
        setRun(null);
        setGroup(null);
      }
    };
    route();
    window.addEventListener('hashchange', route);
    return () => {
      window.removeEventListener('hashchange', route);
      cleanup?.();
    };
  }, [openRun, openGroup]);

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

  // ---------- 组操作 ----------
  const groupApprove = async () => {
    if (!group) return;
    const res = await fetch(`/api/groups/${group.group.id}/approve`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error);
    refreshGroup(group.group.id);
    loadRuns();
  };

  // 打回对话框默认全组勾选；running 成员不可勾选
  const openGroupReject = () => {
    if (!group) return;
    const init: Record<string, boolean> = {};
    for (const r of group.runs) init[r.id] = r.status !== 'running';
    setRejectChecks(init);
    setGroupRejectText('');
    groupRejectRef.current?.showModal();
  };

  const submitGroupReject = async () => {
    if (!group) return;
    const fb = groupRejectText.trim();
    const runIds = Object.entries(rejectChecks).filter(([, v]) => v).map(([k]) => k);
    if (!fb || !runIds.length) return;
    const res = await fetch(`/api/groups/${group.group.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: fb, runIds }),
    });
    if (!res.ok) alert((await res.json()).error);
    groupRejectRef.current?.close();
    refreshGroup(group.group.id);
    loadRuns();
  };

  const stageIdx = run ? STAGES.indexOf(run.stage) : -1;
  const groupCanApprove = group?.runs.some((r) => r.status === 'awaiting_review') ?? false;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>⛵ ship</h1>
          <span className="sub">方案 → PR 交付流水线 · 本地</span>
        </header>
        <div className="run-list">
          {runs.length === 0 && groups.length === 0 && (
            <div className="empty-list">
              还没有运行。在仓库里执行：
              <br />
              <code>ship start --plan plan.md</code>
              <br />
              或多仓库联动：
              <br />
              <code>ship start --group manifest.json</code>
            </div>
          )}

          {/* 组块：带 groupId 的 run 归入组显示 */}
          {groups.map((g) => (
            <div key={g.id} className={`group-block${group?.group.id === g.id ? ' active' : ''}`}>
              <div className="group-head" onClick={() => (location.hash = `#/group/${g.id}`)}>
                <span className="name">🧩 {g.title}</span>
                <span className={`badge ${g.status}`}>{GROUP_STATUS_LABEL[g.status] ?? g.status}</span>
              </div>
              <div className="group-members">
                {g.runs.map((r) => (
                  <div
                    key={r.id}
                    className={`group-member${run?.id === r.id ? ' active' : ''}`}
                    onClick={() => (location.hash = `#/run/${r.id}`)}
                  >
                    <span className="mname">{dirName(r.repoPath)}</span>
                    <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* 无组的 run 照旧平铺 */}
          {runs
            .filter((r) => !r.groupId)
            .map((r) => (
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
        {group ? (
          <div className="detail">
            <div className="run-header">
              <div>
                <h2>🧩 {group.group.title}</h2>
                <div className="meta">
                  运行组 · {group.group.runIds.length} 个仓库 · {group.group.id}
                </div>
              </div>
              <span className={`badge ${group.status}`}>
                {GROUP_STATUS_LABEL[group.status] ?? group.status}
              </span>
            </div>

            <table className="group-table">
              <thead>
                <tr>
                  <th>仓库</th>
                  <th>分支</th>
                  <th>阶段</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {group.runs.map((r) => (
                  <tr key={r.id} onClick={() => (location.hash = `#/run/${r.id}`)}>
                    <td>{dirName(r.repoPath)}</td>
                    <td className="mono">{r.branch ?? '(未建)'}</td>
                    <td>{STAGE_LABEL[r.stage] ?? r.stage}</td>
                    <td>
                      <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="group-ops">
              <button className="btn primary" disabled={!groupCanApprove} onClick={groupApprove}>
                ✓ 整组通过
              </button>
              <button className="btn danger" onClick={openGroupReject}>
                ⟲ 打回…
              </button>
            </div>

            <nav className="tabs">
              {(['diff', 'findings', 'plan'] as const).map((t) => (
                <button key={t} className={groupTab === t ? 'active' : ''} onClick={() => setGroupTab(t)}>
                  {{ diff: 'Diff', findings: '审查发现', plan: '方案' }[t]}
                </button>
              ))}
            </nav>

            {/* 内容按仓库分节（节标题 = 仓库目录名） */}
            <div className="tab-body">
              {group.runs.map((r) => (
                <section key={r.id} className="repo-section">
                  <div className="repo-section-head">{dirName(r.repoPath)}</div>
                  {groupTab === 'diff' && <DiffBody diff={groupDiffs[r.id] ?? ''} />}
                  {groupTab === 'findings' && <FindingsBody run={r} />}
                  {groupTab === 'plan' && <pre className="plan">{r.plan}</pre>}
                </section>
              ))}
            </div>
          </div>
        ) : !run ? (
          <div className="empty">
            ← 选择一个运行或运行组，或在仓库里 <code>ship start --plan plan.md</code>
          </div>
        ) : (
          <div className="detail">
            <div className="run-header">
              <div>
                {run.groupId && (
                  <a className="back-group" href={`#/group/${run.groupId}`}>
                    ← 返回组
                  </a>
                )}
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
              {tab === 'diff' && <DiffBody diff={diff} />}
              {tab === 'findings' && <FindingsBody run={run} />}
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

      <dialog ref={groupRejectRef}>
        <h3>联动打回</h3>
        <textarea
          rows={5}
          value={groupRejectText}
          onChange={(e) => setGroupRejectText(e.target.value)}
          placeholder="说明哪里不行、期望改成什么样。会给勾选的成员注入意见（带 [联动打回] 前缀），各自修复→复审→回到人工门禁。"
        />
        <div className="reject-members">
          {group?.runs.map((r) => {
            const running = r.status === 'running';
            return (
              <label key={r.id} className={`reject-member${running ? ' disabled' : ''}`}>
                <input
                  type="checkbox"
                  disabled={running}
                  checked={!!rejectChecks[r.id]}
                  onChange={(e) => setRejectChecks((prev) => ({ ...prev, [r.id]: e.target.checked }))}
                />
                <span className="mname">{dirName(r.repoPath)}</span>
                <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                {running && <span className="hint">推进中</span>}
              </label>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => groupRejectRef.current?.close()}>
            取消
          </button>
          <button className="btn danger" onClick={submitGroupReject}>
            打回
          </button>
        </div>
      </dialog>
    </div>
  );
}

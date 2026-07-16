'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupRecord, RunEvent, RunRecord } from '@/lib/types';
import {
  partition,
  archivedItems,
  toItems,
  relativeTime,
  type GroupSummary,
  type SidebarItem,
} from '@/lib/sidebar';

const STAGES = ['worktree', 'implement', 'autoReview', 'pr', 'ci', 'done'] as const;
const STAGE_LABEL: Record<string, string> = {
  worktree: '建 Worktree', implement: '实现', autoReview: '双边审查',
  pr: '提 PR', ci: 'CI/冲突', done: '完成',
};
// run 与 group 状态共用一套标签（组状态是 running/failed/done 的子集）
const STATUS_LABEL: Record<string, string> = {
  running: '进行中', failed: '已终止', done: '完成·PR 已自动合并',
};

/** 组状态标签（比单 run 略简） */
const GROUP_STATUS_LABEL: Record<string, string> = {
  running: '推进中', failed: '有成员已终止', done: '全部完成',
};

/** 取路径最后一段目录名 */
const dirName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

type LogLine = { key: number; cls: string; text: string };

/**
 * 把文本里的 URL 渲染成新页面打开的链接（日志里的 PR 地址等）。
 * split 带捕获组：奇数下标必是 URL。
 */
const URL_RE = /(https?:\/\/[^\s"'`<>()（）]+)/g;
function Linkified({ text }: { text: string }) {
  if (!text.includes('http')) return <>{text}</>;
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} className="log-link" href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

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

/** 最近一轮 LLM 审查的 must_fix 发现 + 各轮累计的 advisory（不阻塞，附在 PR 描述） */
function FindingsBody({ run }: { run: RunRecord }) {
  return (
    <>
      {run.findings?.length ? (
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
      )}
      {!!run.advisories?.length && (
        <>
          <div className="findings-note">advisory（不阻塞流程，随 PR 描述附给人看）：</div>
          {run.advisories.map((f, i) => (
            <div key={i} className="finding advisory">
              <div className="file">
                {f.file}
                {f.reviewer ? `（${f.reviewer}）` : ''}
              </div>
              <div>{f.issue}</div>
            </div>
          ))}
        </>
      )}
      {!!run.lessons?.length && (
        <>
          <div className="findings-note">复盘经验（随该仓库下一条 run 同步进 ship.lessons.md）：</div>
          {run.lessons.map((l, i) => (
            <div key={i} className="finding lesson">
              <div className="file">[{l.type}]</div>
              <div>
                {l.lesson}
                {l.suggestion ? `（建议：${l.suggestion}）` : ''}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

export default function Page() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  // 已归档分区：默认折叠，展开后才懒加载 ?archived=1
  const [archivedRuns, setArchivedRuns] = useState<RunRecord[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<GroupSummary[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [run, setRun] = useState<RunRecord | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [diff, setDiff] = useState('');
  const [groupDiffs, setGroupDiffs] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'log' | 'diff' | 'findings' | 'plan'>('log');
  const [groupTab, setGroupTab] = useState<'diff' | 'findings' | 'plan'>('diff');
  const logRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef<string | null>(null);
  const groupIdRef = useRef<string | null>(null);

  // 侧边栏活跃数据：未归档 runs + groups 一起刷新（不含已归档，已归档单独懒加载）
  const loadRuns = useCallback(async () => {
    setNow(Date.now());
    const [rs, gs] = await Promise.all([
      fetch('/api/runs').then((r) => r.json()).catch(() => []),
      fetch('/api/groups').then((r) => r.json()).catch(() => []),
    ]);
    setRuns(rs);
    setGroups(gs);
  }, []);

  // 已归档数据：仅在展开时请求（懒加载）
  const loadArchived = useCallback(async () => {
    const [rs, gs] = await Promise.all([
      fetch('/api/runs?archived=1').then((r) => r.json()).catch(() => []),
      fetch('/api/groups?archived=1').then((r) => r.json()).catch(() => []),
    ]);
    setArchivedRuns(rs);
    setArchivedGroups(gs);
  }, []);

  // 归档 / 还原 run 或 group，然后刷新活跃 + 已归档（若展开）
  const doArchive = useCallback(
    async (kind: 'run' | 'group', id: string, archived: boolean) => {
      const url = kind === 'run' ? `/api/runs/${id}/archive` : `/api/groups/${id}/archive`;
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      await loadRuns();
      if (archivedOpen) await loadArchived();
    },
    [loadRuns, loadArchived, archivedOpen],
  );

  // 「全部归档」：一键归档所有已完成，然后刷新
  const archiveAllDone = useCallback(async () => {
    await fetch('/api/runs/archive-done', { method: 'POST' });
    await loadRuns();
    if (archivedOpen) await loadArchived();
  }, [loadRuns, loadArchived, archivedOpen]);

  // 展开/折叠已归档分区；展开的那一刻才发 ?archived=1 请求
  const toggleArchived = useCallback(() => {
    setArchivedOpen((open) => {
      const next = !open;
      if (next) loadArchived();
      return next;
    });
  }, [loadArchived]);

  const refreshRun = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`);
    if (res.ok) setRun(await res.json());
  }, []);

  // 从断点续跑：resume 会自动取消归档（含级联清组），必须同时刷新活跃与已归档缓存，
  // 否则同一 run 会残留在「已归档」缓存里，直到用户折叠再展开才消失。
  const doResume = useCallback(
    async (id: string) => {
      await fetch(`/api/runs/${id}/resume`, { method: 'POST' });
      await Promise.all([refreshRun(id), loadRuns(), archivedOpen ? loadArchived() : Promise.resolve()]);
    },
    [refreshRun, loadRuns, loadArchived, archivedOpen],
  );

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

  const stageIdx = run ? STAGES.indexOf(run.stage) : -1;

  // 四分区：活跃三区从未归档数据推导，已归档区来自懒加载的 ?archived=1 数据。
  // 把活跃条目 id 传给 archivedItems 做结构性互斥：即便已归档缓存短暂陈旧（如 resume
  // 自动取消归档后活跃列表已更新、缓存未刷新），也不让同一条目同时出现在两个分区。
  const parts = partition(runs, groups);
  const activeIds = new Set(toItems(runs, groups).map((i) => i.id));
  const archived = archivedItems(archivedRuns, archivedGroups, activeIds);
  const listEmpty = runs.length === 0 && groups.length === 0;

  // 渲染一个侧边栏条目（散 run 或组）。inArchived=true 时归档按钮变「还原」。
  const renderItem = (item: SidebarItem, inArchived: boolean) => {
    const canArchive = !inArchived && item.status !== 'running'; // running 不可归档
    const actionBtn = (kind: 'run' | 'group', id: string) =>
      (canArchive || inArchived) && (
        <button
          className="si-arch"
          onClick={(e) => {
            e.stopPropagation();
            doArchive(kind, id, !inArchived);
          }}
        >
          {inArchived ? '还原' : '归档'}
        </button>
      );

    if (item.kind === 'group') {
      const g = item.group;
      return (
        <div key={g.id} className={`side-item group${group?.group.id === g.id ? ' active' : ''}`}>
          <div className="si-row" onClick={() => (location.hash = `#/group/${g.id}`)}>
            <div className="si-head">
              <span className="si-title">🧩 {g.title}</span>
              <span className={`badge ${g.status}`}>{GROUP_STATUS_LABEL[g.status] ?? g.status}</span>
            </div>
            <div className="si-meta">
              <span className="repo-tag">{g.runIds.length} 仓库</span>
              <span className="si-time">{relativeTime(item.updatedAt, now)}</span>
              {actionBtn('group', g.id)}
            </div>
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
      );
    }

    const r = item.run;
    return (
      <div
        key={r.id}
        className={`side-item run${run?.id === r.id ? ' active' : ''}`}
        onClick={() => (location.hash = `#/run/${r.id}`)}
      >
        <div className="si-head">
          <span className="si-title">{r.title}</span>
          <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
        </div>
        <div className="si-meta">
          <span className="repo-tag">{dirName(r.repoPath)}</span>
          <span className="si-time">{relativeTime(item.updatedAt, now)}</span>
          {actionBtn('run', r.id)}
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>⛵ ship</h1>
          <span className="sub">方案 → 自动合并 PR · 全自动 · 本地</span>
        </header>
        <div className="run-list">
          {listEmpty && (
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

          {/* 进行中 */}
          {parts.running.length > 0 && (
            <div className="side-section">
              <div className="side-section-head">
                <span>进行中</span>
                <span className="cnt">{parts.running.length}</span>
              </div>
              {parts.running.map((it) => renderItem(it, false))}
            </div>
          )}

          {/* 需要处理（failed，红色强调——唯一需要人介入） */}
          {parts.needAttention.length > 0 && (
            <div className="side-section attention">
              <div className="side-section-head">
                <span>需要处理</span>
                <span className="cnt">{parts.needAttention.length}</span>
              </div>
              {parts.needAttention.map((it) => renderItem(it, false))}
            </div>
          )}

          {/* 已完成（分区头带「全部归档」） */}
          {parts.done.length > 0 && (
            <div className="side-section">
              <div className="side-section-head">
                <span>已完成</span>
                <button className="head-btn" onClick={archiveAllDone} title="归档全部已完成">
                  全部归档
                </button>
              </div>
              {parts.done.map((it) => renderItem(it, false))}
            </div>
          )}

          {/* 已归档（默认折叠；展开时才请求 ?archived=1 懒加载） */}
          <div className="side-section archived">
            <div className="side-section-head clickable" onClick={toggleArchived}>
              <span>
                {archivedOpen ? '▾' : '▸'} 已归档
              </span>
            </div>
            {archivedOpen &&
              (archived.length > 0 ? (
                archived.map((it) => renderItem(it, true))
              ) : (
                <div className="side-empty-hint">（暂无已归档）</div>
              ))}
          </div>
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
                  {run.repoPath} · {run.branch ?? '(worktree 未建)'} → {run.config.base} · engine:{' '}
                  {run.config.engine} · review: {run.config.reviewEngines.join('+')}
                </div>
              </div>
              <div className="header-actions">
                {run.prUrl && (
                  <a className="btn primary" href={run.prUrl} target="_blank" rel="noreferrer">
                    打开 PR ↗
                  </a>
                )}
                <span className={`badge ${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
              </div>
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
                {run.status === 'failed' && (
                  <div className="actions">
                    <button
                      className="btn"
                      onClick={() => doResume(run.id)}
                    >
                      ⟲ 从断点续跑
                    </button>
                  </div>
                )}
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
                      <Linkified text={l.text} />
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
    </div>
  );
}

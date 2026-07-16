// 进度图推导纯函数：从既有事件流 + run 快照推导流水线 DAG（节点/边），
// 与 UI 解耦，供 app/ProgressFlow.tsx 与测试共用。
// 事实来源分两层：run.stage/status 是主干骨架的真相；事件流补充动态细节
// （审查轮次/findings、循环步骤计数与耗时、错误归属）。识别不了的 engine label
// 归入「其他步骤」节点容错，绝不抛错——旧 run 的历史事件必须能渲染。
import { STAGES, type ReviewFinding, type RunEvent, type RunRecord } from './types';

export type NodeStatus = 'pending' | 'active' | 'ok' | 'bad';

export interface GraphNode {
  id: string;
  /** 节点主标题（中文） */
  title: string;
  /** 副标题：engine 名/审查角色等 */
  sub?: string;
  /** stage=主干阶段 review=审查引擎 loop=循环步骤（修复/CI修复/解冲突/复盘/其他） */
  kind: 'stage' | 'review' | 'loop';
  status: NodeStatus;
  /** review 节点：最近审查轮次；loop 节点：已执行次数 */
  round?: number;
  /** review 节点：最近一轮该 engine 的 must_fix 数 */
  findings?: number;
  /** 累计工作耗时（engine start→end 求和；主干阶段为阶段驻留时长） */
  durationMs?: number;
  /** 失败/错误归属到本节点时的错误摘要 */
  error?: string;
  /** 该节点关联的全部 engine label（抽屉按 label 过滤 engine-line 用） */
  labels: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** 循环回边（修复→审查、CI修复→CI 等），渲染为虚线 */
  back?: boolean;
}

export interface ProgressGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * 主干节点标题（autoReview 阶段由 review:* 并行节点呈现，不单独成节点；
 * awaitDeps 仅在 run.dependsOn 非空时进骨架——无依赖 run 的图保持不变）
 */
const STAGE_TITLE: Record<string, string> = {
  worktree: '建 Worktree',
  implement: '实现',
  awaitDeps: '等待上游',
  pr: '提 PR',
  ci: 'CI/合并',
  done: '完成',
};

/** 审查分工角色的中文名（与 RunConfig.reviewRoles 对应） */
const ROLE_TITLE: Record<string, string> = {
  architecture: '架构',
  fidelity: '方案符合性',
};

/** 循环节点标题与其挂载的主干锚点（决定布局列与回边指向） */
const LOOP_META: Record<string, { title: string; anchor: string }> = {
  fix: { title: '审查修复', anchor: 'review' },
  'test-fix': { title: '测试修复', anchor: 'implement' },
  'dep-bump': { title: '依赖更新', anchor: 'awaitDeps' },
  'ci-fix': { title: 'CI 修复', anchor: 'ci' },
  conflicts: { title: '解冲突', anchor: 'ci' },
  retro: { title: '复盘', anchor: 'done' },
  other: { title: '其他步骤', anchor: 'implement' },
};

/**
 * engine label → 节点 id。label 命名来自 pipeline：
 * implement / review-{轮}-{engine}[-recheck|-delta] / review-{轮}-rescue-{engine} /
 * fix-r{轮}[-rescue] / test-fix-{n} / ci-fix-{n} / conflicts / retro，均可带 -retry 后缀。
 * engine 名可能含连字符（如 claude-cli），review 类靠剥前后缀取中段，不按连字符切分。
 */
export function classifyLabel(label: string): string {
  const l = label.replace(/-retry$/, '');
  if (l === 'implement') return 'implement';
  if (l === 'conflicts') return 'conflicts';
  if (l === 'retro') return 'retro';
  if (l === 'dep-bump') return 'dep-bump';
  if (/^fix-r\d+/.test(l)) return 'fix';
  if (/^test-fix-\d+$/.test(l)) return 'test-fix';
  if (/^ci-fix-\d+$/.test(l)) return 'ci-fix';
  const review = l.match(/^review-\d+-(.+)$/);
  if (review) {
    const engine = review[1].replace(/^rescue-/, '').replace(/-(recheck|delta)$/, '');
    return `review:${engine}`;
  }
  return 'other';
}

const ts = (iso: string) => Date.parse(iso) || 0;

export function deriveGraph(run: RunRecord, events: RunEvent[]): ProgressGraph {
  const nodes = new Map<string, GraphNode>();
  const node = (id: string, init: Omit<GraphNode, 'id' | 'status' | 'labels'>): GraphNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, status: 'pending', labels: [], ...init };
      nodes.set(id, n);
    }
    return n;
  };

  // —— 固定骨架：主干阶段 + 配置声明的审查引擎（无论事件是否到达都存在）——
  // awaitDeps 只有带依赖的 run 才有（无依赖 run 的图与从前完全一致）
  const hasDeps = !!run.dependsOn?.length;
  for (const s of STAGES)
    if (STAGE_TITLE[s] && (s !== 'awaitDeps' || hasDeps)) node(s, { title: STAGE_TITLE[s], kind: 'stage' });
  if (hasDeps && run.awaiting?.length) {
    // 等待节点副标题：等哪些包，探测到版本后带上版本号
    nodes.get('awaitDeps')!.sub = run.awaiting
      .map((a) => (a.resolvedVersion ? `${a.package}@${a.resolvedVersion}` : a.package))
      .join('、');
  }
  const reviewEngines = run.config?.reviewEngines ?? [];
  for (const e of reviewEngines) {
    const role = run.config?.reviewRoles?.[e];
    node(`review:${e}`, {
      title: `审查 ${e}`,
      sub: role ? ROLE_TITLE[role] ?? role : undefined,
      kind: 'review',
    });
  }

  // —— 单遍扫事件：耗时/轮次/findings/错误归属 ——
  const openStart = new Map<string, number>(); // label → start ts
  let lastActiveNode: string | null = null; // 最近开始工作的节点（错误归属兜底）
  let stageEnteredAt: number | null = null;
  let prevStage: string | null = null;
  let lastEventTs = 0;

  const bump = (id: string, ms: number) => {
    const n = nodes.get(id);
    if (n) n.durationMs = (n.durationMs ?? 0) + ms;
  };
  // 阶段驻留时长单独累计，扫描结束后只赋给没有 engine 工作时长的阶段节点
  // （implement 等有 engine 步骤的节点用工作时长，避免驻留+工作双重计数）
  const stageResidency = new Map<string, number>();
  const bumpStage = (id: string, ms: number) =>
    stageResidency.set(id, (stageResidency.get(id) ?? 0) + ms);

  for (const ev of events) {
    if (ev.seq < 0) continue; // sync 标记（SSE 专用）
    lastEventTs = ts(ev.ts);
    const d = ev.data as Record<string, any>;
    switch (ev.type) {
      case 'stage': {
        // 上一主干阶段的驻留时长；autoReview 不是独立节点，驻留时长不记
        if (prevStage && STAGE_TITLE[prevStage] && stageEnteredAt !== null)
          bumpStage(prevStage, lastEventTs - stageEnteredAt);
        prevStage = String(d.stage);
        stageEnteredAt = lastEventTs;
        break;
      }
      case 'engine': {
        const label = String(d.label ?? '');
        const id = classifyLabel(label);
        const meta = LOOP_META[id];
        const n = nodes.get(id) ?? (meta ? node(id, { title: meta.title, kind: 'loop' }) : node(id, { title: id.startsWith('review:') ? `审查 ${id.slice(7)}` : LOOP_META.other.title, kind: id.startsWith('review:') ? 'review' : 'loop' }));
        if (!n.labels.includes(label)) n.labels.push(label);
        if (d.state === 'start') {
          openStart.set(label, lastEventTs);
          lastActiveNode = id;
        } else if (d.state === 'end') {
          const st = openStart.get(label);
          openStart.delete(label);
          if (st !== undefined) bump(id, lastEventTs - st);
          if (n.kind === 'loop') n.round = (n.round ?? 0) + 1;
        }
        break;
      }
      case 'review': {
        const round = Number(d.round ?? 0);
        const findings = (d.findings ?? []) as ReviewFinding[];
        for (const e of reviewEngines) {
          const n = nodes.get(`review:${e}`)!;
          n.round = round;
          n.findings = findings.filter((f) => f.reviewer === e).length;
        }
        break;
      }
      case 'error': {
        const target = lastActiveNode ?? (prevStage && STAGE_TITLE[prevStage] ? prevStage : null);
        if (target) {
          const n = nodes.get(target);
          if (n) n.error = String(d.error ?? '');
        }
        break;
      }
    }
  }
  // 仍在进行的阶段/步骤：驻留时长记到最后一个事件为止
  if (prevStage && STAGE_TITLE[prevStage] && stageEnteredAt !== null && run.status === 'running')
    bumpStage(prevStage, lastEventTs - stageEnteredAt);
  for (const [label, st] of openStart) bump(classifyLabel(label), lastEventTs - st);
  // 驻留时长只赋给没有 engine 工作时长的阶段节点
  for (const [id, ms] of stageResidency) {
    const n = nodes.get(id);
    if (n && n.durationMs === undefined) n.durationMs = ms;
  }

  // —— 终局状态叠加：run.stage/status 是骨架真相 ——
  const stageIdx = (s: string) => (STAGES as readonly string[]).indexOf(s);
  const curIdx = stageIdx(run.stage);
  const openNodes = new Set([...openStart.keys()].map(classifyLabel));
  const failed = run.status === 'failed';
  const allDone = run.status === 'done';

  for (const n of nodes.values()) {
    if (n.kind === 'stage') {
      const i = stageIdx(n.id);
      if (allDone || i < curIdx) n.status = 'ok';
      else if (i === curIdx) n.status = failed ? 'bad' : openNodes.has(n.id) || run.status === 'running' ? 'active' : 'ok';
      else n.status = 'pending';
      // done 节点只有真正 done 才亮
      if (n.id === 'done') n.status = allDone ? 'ok' : failed && curIdx >= stageIdx('done') ? 'bad' : n.status === 'ok' ? 'pending' : n.status;
      continue;
    }
    if (n.kind === 'review') {
      const reviewIdx = stageIdx('autoReview');
      if (openNodes.has(n.id)) n.status = 'active';
      else if (allDone || curIdx > reviewIdx) n.status = 'ok';
      else if (curIdx === reviewIdx) {
        // 审查阶段内：打回（该 engine 有 must_fix）为 bad，已裁决无发现为 ok，未裁决为 pending/active
        if (failed) n.status = n.findings || n.error ? 'bad' : n.round ? 'ok' : 'pending';
        else if (n.findings) n.status = 'bad';
        else n.status = n.round ? 'ok' : 'pending';
      } else n.status = 'pending';
      continue;
    }
    // loop：出现即代表执行过；开着的 active，错误归属的 bad，其余 ok
    n.status = openNodes.has(n.id) ? 'active' : failed && n.error ? 'bad' : 'ok';
  }
  // 失败但错误没归属到任何 engine 步骤：把 statusDetail 挂到当前主干（或审查）节点
  if (failed) {
    const holder =
      [...nodes.values()].find((n) => n.error) ??
      nodes.get(run.stage) ??
      (run.stage === 'autoReview' ? nodes.get(`review:${reviewEngines[0]}`) : undefined);
    if (holder) {
      holder.error ??= run.statusDetail || '运行终止';
      holder.status = 'bad';
    }
  }

  // —— 边 ——
  const edges: GraphEdge[] = [];
  const edge = (source: string, target: string, back = false) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    edges.push({ id: `${source}->${target}${back ? ':back' : ''}`, source, target, back });
  };
  edge('worktree', 'implement');
  // 有依赖时主干经过 awaitDeps：实现 → 等待上游 → 双边审查
  const reviewSrc = nodes.has('awaitDeps') ? 'awaitDeps' : 'implement';
  if (nodes.has('awaitDeps')) edge('implement', 'awaitDeps');
  for (const e of reviewEngines) {
    edge(reviewSrc, `review:${e}`);
    edge(`review:${e}`, 'pr');
  }
  edge('pr', 'ci');
  edge('ci', 'done');
  // 循环子图（节点存在才连）：修复挂审查、测试修复挂实现、CI 修复/解冲突挂 CI、复盘挂完成
  for (const e of reviewEngines) {
    edge(`review:${e}`, 'fix');
    edge('fix', `review:${e}`, true);
  }
  edge('implement', 'test-fix');
  edge('test-fix', 'implement', true);
  edge('awaitDeps', 'dep-bump');
  edge('dep-bump', 'awaitDeps', true);
  edge('ci', 'ci-fix');
  edge('ci-fix', 'ci', true);
  edge('ci', 'conflicts');
  edge('conflicts', 'ci', true);
  edge('done', 'retro');
  edge('implement', 'other');

  return { nodes: [...nodes.values()], edges };
}

'use client';

// 进度图渲染（React Flow 只读画布）：布局手算固定坐标——流水线形状固定
// （主干横排、审查引擎纵排、循环步骤挂下方、回边虚线），不引布局库。
// 数据一律来自 lib/progressGraph 的纯函数推导，本文件只管摆放与样式。
import { useMemo } from 'react';
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphEdge, GraphNode, NodeStatus } from '@/lib/progressGraph';

const STATUS_ICON: Record<NodeStatus, string> = { pending: '○', active: '●', ok: '✓', bad: '✖' };

function fmtDuration(ms?: number): string {
  if (!ms || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? `${s % 60}s` : ''}` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 自定义节点：标题 + 副标题 + 轮次/findings/耗时徽标，状态用类名着色 */
function StepNode({ data }: NodeProps) {
  const n = data.node as GraphNode;
  return (
    <div className={`pg-node ${n.status} ${n.kind}`}>
      {/* 边的锚点（自定义节点必须有 Handle 边才会渲染）；视觉上隐藏 */}
      <Handle type="target" position={Position.Left} className="pg-handle" />
      <Handle type="source" position={Position.Right} className="pg-handle" />
      <div className="pg-title">
        <span className="pg-ico">{STATUS_ICON[n.status]}</span> {n.title}
      </div>
      {n.sub && <div className="pg-sub">{n.sub}</div>}
      <div className="pg-badges">
        {n.kind === 'review' && !!n.round && <span className="pg-badge">第 {n.round} 轮</span>}
        {n.kind === 'review' && !!n.findings && <span className="pg-badge bad">{n.findings} 个问题</span>}
        {n.kind === 'loop' && !!n.round && <span className="pg-badge">×{n.round}</span>}
        {fmtDuration(n.durationMs) && <span className="pg-badge dim">{fmtDuration(n.durationMs)}</span>}
        {n.error && <span className="pg-badge bad">!</span>}
      </div>
    </div>
  );
}

export const nodeTypes = { step: StepNode };

const X = (col: number) => 30 + col * 215;
const MAIN_Y = 150;

/**
 * 手算布局：主干横排、审查引擎纵排、循环步骤挂下方。
 * 带依赖的 run 多一列「等待上游」，后续列整体右移。
 * idPrefix/yOffset 供组视图泳道复用（每仓库一条泳道纵向排布）。
 */
export function layout(nodes: GraphNode[], opts?: { idPrefix?: string; yOffset?: number }): Node[] {
  const prefix = opts?.idPrefix ?? '';
  const dy = opts?.yOffset ?? 0;
  const shift = nodes.some((n) => n.id === 'awaitDeps') ? 1 : 0;
  // 主干与循环节点的列槽位（awaitDeps 存在时 review 及之后的列右移一格）
  const COL: Record<string, number> = {
    worktree: 0, implement: 1, 'test-fix': 1, other: 1,
    awaitDeps: 2, 'dep-bump': 2,
    review: 2 + shift, fix: 2 + shift,
    pr: 3 + shift, ci: 4 + shift, 'ci-fix': 4 + shift,
    conflicts: 5 + shift, done: 5 + shift, retro: 6 + shift,
  };
  const reviews = nodes.filter((n) => n.kind === 'review');
  return nodes.map((n) => {
    let x: number;
    let y: number;
    if (n.kind === 'review') {
      // 审查引擎在 review 列纵向围绕主干线展开（2 个即 40/220）
      const i = reviews.indexOf(n);
      x = X(COL.review);
      y = 40 + i * 180;
    } else if (n.kind === 'loop') {
      x = X(COL[n.id] ?? 1) + (n.id === 'conflicts' ? -40 : 0);
      y = n.id === 'retro' ? MAIN_Y : 330;
    } else {
      x = X(COL[n.id] ?? 0);
      y = MAIN_Y;
    }
    return {
      id: prefix + n.id,
      type: 'step',
      position: { x, y: y + dy },
      data: { node: n },
      draggable: false,
      connectable: false,
      selectable: true,
    };
  });
}

export function toFlowEdges(edges: GraphEdge[], nodes: GraphNode[], idPrefix = ''): Edge[] {
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  return edges.map((e) => ({
    id: idPrefix + e.id,
    source: idPrefix + e.source,
    target: idPrefix + e.target,
    animated: !e.back && status.get(e.target) === 'active',
    style: e.back ? { strokeDasharray: '5 4', opacity: 0.6 } : undefined,
    type: 'default',
  }));
}

export default function ProgressFlow({
  nodes,
  edges,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelect: (id: string | null) => void;
}) {
  const flowNodes = useMemo(() => layout(nodes), [nodes]);
  const flowEdges = useMemo(() => toFlowEdges(edges, nodes), [edges, nodes]);
  return (
    <div className="pg-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}

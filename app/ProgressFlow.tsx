'use client';

// 进度图渲染（React Flow 画布）：布局手算固定坐标——流水线形状固定
// （主干横排、审查引擎纵排、循环步骤挂下方、回边虚线），不引布局库。
// 节点支持手动拖拽（数据刷新时保留拖过的位置），右上角「一键布局」恢复自动布局。
// 数据一律来自 lib/progressGraph 的纯函数推导，本文件只管摆放与样式。
import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type XYPosition,
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
      connectable: false,
      selectable: true,
    };
  });
}

/**
 * 可拖拽画布的公共钩子逻辑：数据推导出的自动布局 + 手动拖拽覆盖位置表。
 * 数据刷新（SSE/轮询）重建节点时保留拖过的位置；relayout() 清空覆盖并恢复自动布局。
 */
export function useDraggableLayout(derived: Node[]) {
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const overrides = useRef<Record<string, XYPosition>>({});
  const { fitView } = useReactFlow();
  useEffect(() => {
    setFlowNodes(
      derived.map((n) => (overrides.current[n.id] ? { ...n, position: overrides.current[n.id] } : n)),
    );
  }, [derived, setFlowNodes]);
  const onNodeDragStop = (_: unknown, node: Node) => {
    overrides.current[node.id] = node.position;
  };
  const relayout = () => {
    overrides.current = {};
    setFlowNodes(derived);
    requestAnimationFrame(() => fitView({ duration: 300 }));
  };
  return { flowNodes, onNodesChange, onNodeDragStop, relayout };
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

type ProgressFlowProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelect: (id: string | null) => void;
};

function ProgressFlowInner({ nodes, edges, onSelect }: ProgressFlowProps) {
  const derived = useMemo(() => layout(nodes), [nodes]);
  const flowEdges = useMemo(() => toFlowEdges(edges, nodes), [edges, nodes]);
  const { flowNodes, onNodesChange, onNodeDragStop, relayout } = useDraggableLayout(derived);
  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable
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
      <Panel position="top-right">
        <button className="pg-relayout" title="恢复自动布局并适配视野" onClick={relayout}>
          ⊞ 一键布局
        </button>
      </Panel>
    </ReactFlow>
  );
}

export default function ProgressFlow(props: ProgressFlowProps) {
  return (
    <div className="pg-canvas">
      <ReactFlowProvider>
        <ProgressFlowInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}

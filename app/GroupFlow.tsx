'use client';

// 组视图泳道 DAG：每个仓库一条泳道（复用单 run 的推导与布局），
// 跨泳道依赖边从上游「完成」节点连到下游「等待上游」节点。
// 数据源是组详情轮询到的 run 快照（不拉各成员事件流）——泳道展示主干骨架级进度，
// 循环细节点进单 run 的进度图看。点击节点跳转对应 run。
// 节点可手动拖拽（轮询刷新保留拖过的位置），右上角「一键布局」恢复自动布局。
import { useMemo } from 'react';
import { Background, Panel, ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { deriveGraph } from '@/lib/progressGraph';
import type { RunRecord } from '@/lib/types';
import { layout, nodeTypes, toFlowEdges, useDraggableLayout } from './ProgressFlow';

const LANE_H = 430;

/** 泳道标题（仓库目录名）节点 */
function LaneLabel({ data }: { data: { label: string } }) {
  return <div className="gf-lane-label">{data.label}</div>;
}

const groupNodeTypes = { ...nodeTypes, lane: LaneLabel };

const dirName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

function GroupFlowInner({ runs }: { runs: RunRecord[] }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    runs.forEach((run, lane) => {
      const g = deriveGraph(run, []);
      const prefix = `${run.id}:`;
      nodes.push({
        id: `${prefix}lane`,
        type: 'lane',
        position: { x: 30, y: lane * LANE_H },
        data: { label: dirName(run.repoPath) },
        draggable: false,
        selectable: false,
      });
      nodes.push(...layout(g.nodes, { idPrefix: prefix, yOffset: lane * LANE_H + 40 }));
      edges.push(...toFlowEdges(g.edges, g.nodes, prefix));
    });
    // 跨泳道依赖边：上游 done → 下游 awaitDeps（虚线；下游等待中时高亮流动）
    for (const run of runs) {
      for (const up of run.dependsOn ?? []) {
        if (!runs.some((r) => r.id === up)) continue;
        edges.push({
          id: `dep:${up}->${run.id}`,
          source: `${up}:done`,
          target: `${run.id}:awaitDeps`,
          animated: run.status === 'running' && run.stage === 'awaitDeps',
          style: { strokeDasharray: '5 4' },
          type: 'default',
        });
      }
    }
    return { nodes, edges };
  }, [runs]);

  const { flowNodes, onNodesChange, onNodeDragStop, relayout } = useDraggableLayout(nodes);
  return (
    <ReactFlow
      nodes={flowNodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodeTypes={groupNodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={1.5}
      nodesDraggable
      nodesConnectable={false}
      edgesFocusable={false}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const runId = String(node.id).split(':')[0];
        if (runId.startsWith('r-')) location.hash = `#/run/${runId}`;
      }}
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

export default function GroupFlow({ runs }: { runs: RunRecord[] }) {
  return (
    <div className="gf-canvas" style={{ height: Math.min(720, runs.length * 300 + 120) }}>
      <ReactFlowProvider>
        <GroupFlowInner runs={runs} />
      </ReactFlowProvider>
    </div>
  );
}

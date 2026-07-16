'use client';

// 组视图泳道 DAG：每个仓库一条泳道（复用单 run 的推导与布局），
// 跨泳道依赖边从上游「完成」节点连到下游「等待上游」节点。
// 数据源是组详情轮询到的 run 快照（不拉各成员事件流）——泳道展示主干骨架级进度，
// 循环细节点进单 run 的进度图看。点击节点跳转对应 run。
import { useMemo } from 'react';
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { deriveGraph } from '@/lib/progressGraph';
import type { RunRecord } from '@/lib/types';
import { layout, nodeTypes, toFlowEdges } from './ProgressFlow';

const LANE_H = 430;

/** 泳道标题（仓库目录名）节点 */
function LaneLabel({ data }: { data: { label: string } }) {
  return <div className="gf-lane-label">{data.label}</div>;
}

const groupNodeTypes = { ...nodeTypes, lane: LaneLabel };

const dirName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export default function GroupFlow({ runs }: { runs: RunRecord[] }) {
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

  return (
    <div className="gf-canvas" style={{ height: Math.min(720, runs.length * 300 + 120) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={groupNodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const runId = String(node.id).split(':')[0];
          if (runId.startsWith('r-')) location.hash = `#/run/${runId}`;
        }}
      >
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}

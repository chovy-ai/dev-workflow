// deriveGraph 纯函数测试：覆盖方案要求的四种事件序列（一次通过 / 审查打回多轮 /
// CI 修复循环 / 中途 failed），以及断点续跑重复事件、未知 label 容错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLabel, deriveGraph, type GraphNode } from '../../lib/progressGraph';
import { DEFAULT_CONFIG, type RunEvent, type RunRecord } from '../../lib/types';

function mkRun(over: Partial<RunRecord>): RunRecord {
  return {
    id: 'r-test',
    title: 't',
    repoPath: '/tmp/x',
    branch: 'feat/x',
    worktreePath: null,
    plan: 'plan',
    stage: 'done',
    status: 'done',
    statusDetail: '',
    reviewRound: 0,
    findings: [],
    advisories: [],
    prUrl: null,
    sdkSessions: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: DEFAULT_CONFIG,
    ...over,
  };
}

/** 事件构造：秒数递增的时间戳，seq 自增 */
function evs(list: [type: RunEvent['type'], data: Record<string, unknown>][]): RunEvent[] {
  return list.map(([type, data], i) => ({
    seq: i + 1,
    ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 10_000).toISOString(),
    type,
    data,
  }));
}

const byId = (g: { nodes: GraphNode[] }, id: string) => g.nodes.find((n) => n.id === id);

test('label 分类：review 引擎名含连字符、rescue/recheck/delta/retry 后缀', () => {
  assert.equal(classifyLabel('implement'), 'implement');
  assert.equal(classifyLabel('review-1-claude'), 'review:claude');
  assert.equal(classifyLabel('review-2-codex-recheck'), 'review:codex');
  assert.equal(classifyLabel('review-2-claude-cli-delta'), 'review:claude-cli');
  assert.equal(classifyLabel('review-2-rescue-codex'), 'review:codex');
  assert.equal(classifyLabel('review-1-claude-retry'), 'review:claude');
  assert.equal(classifyLabel('fix-r2'), 'fix');
  assert.equal(classifyLabel('fix-r2-rescue'), 'fix');
  assert.equal(classifyLabel('test-fix-3'), 'test-fix');
  assert.equal(classifyLabel('ci-fix-1'), 'ci-fix');
  assert.equal(classifyLabel('conflicts'), 'conflicts');
  assert.equal(classifyLabel('retro'), 'retro');
  assert.equal(classifyLabel('whatever-new-step'), 'other');
});

test('序列 1：一次通过到 done——主干全绿，审查双节点 ok，无循环节点', () => {
  const run = mkRun({ stage: 'done', status: 'done', reviewRound: 1 });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'worktree' }],
      ['stage', { stage: 'implement' }],
      ['engine', { label: 'implement', state: 'start', engine: 'claude' }],
      ['engine', { label: 'implement', state: 'end', code: 0 }],
      ['stage', { stage: 'autoReview' }],
      ['engine', { label: 'review-1-claude', state: 'start', engine: 'claude' }],
      ['engine', { label: 'review-1-codex', state: 'start', engine: 'codex' }],
      ['engine', { label: 'review-1-claude', state: 'end', code: 0 }],
      ['engine', { label: 'review-1-codex', state: 'end', code: 0 }],
      ['review', { round: 1, passed: true, findings: [] }],
      ['stage', { stage: 'pr' }],
      ['stage', { stage: 'ci' }],
      ['stage', { stage: 'done' }],
      ['status', { status: 'done', detail: '' }],
    ]),
  );
  for (const id of ['worktree', 'implement', 'pr', 'ci', 'done', 'review:claude', 'review:codex'])
    assert.equal(byId(g, id)?.status, 'ok', id);
  assert.equal(byId(g, 'fix'), undefined);
  assert.equal(byId(g, 'ci-fix'), undefined);
  assert.equal(byId(g, 'review:claude')?.round, 1);
  assert.equal(byId(g, 'review:claude')?.findings, 0);
  // implement 节点累计了 engine 工作时长（1 个间隔 = 10s）
  assert.equal(byId(g, 'implement')?.durationMs, 10_000);
  // 审查双节点有分工副标题
  assert.equal(byId(g, 'review:claude')?.sub, '架构');
  assert.equal(byId(g, 'review:codex')?.sub, '方案符合性');
});

test('序列 2：审查打回一轮再通过——fix 节点计数与回边存在，轮次=2', () => {
  const run = mkRun({ stage: 'done', status: 'done', reviewRound: 2 });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'autoReview' }],
      ['engine', { label: 'review-1-claude', state: 'start', engine: 'claude' }],
      ['engine', { label: 'review-1-claude', state: 'end', code: 0 }],
      ['review', { round: 1, passed: false, findings: [{ file: 'a.ts', issue: 'x', must_fix: true, reviewer: 'claude' }] }],
      ['engine', { label: 'fix-r1', state: 'start', engine: 'claude' }],
      ['engine', { label: 'fix-r1', state: 'end', code: 0 }],
      ['engine', { label: 'test-fix-1', state: 'start', engine: 'claude' }],
      ['engine', { label: 'test-fix-1', state: 'end', code: 0 }],
      ['engine', { label: 'review-2-claude-recheck', state: 'start', engine: 'claude' }],
      ['engine', { label: 'review-2-claude-recheck', state: 'end', code: 0 }],
      ['review', { round: 2, passed: true, findings: [] }],
      ['stage', { stage: 'done' }],
    ]),
  );
  const fix = byId(g, 'fix')!;
  assert.equal(fix.status, 'ok');
  assert.equal(fix.round, 1); // 执行了 1 次修复
  assert.equal(byId(g, 'test-fix')?.round, 1);
  assert.equal(byId(g, 'review:claude')?.round, 2);
  assert.equal(byId(g, 'review:claude')?.findings, 0); // 最近一轮无发现
  // 回边：fix → 各审查节点
  assert.ok(g.edges.some((e) => e.source === 'fix' && e.target === 'review:claude' && e.back));
  assert.ok(g.edges.some((e) => e.source === 'test-fix' && e.target === 'implement' && e.back));
});

test('序列 3：CI 修复循环 + 解冲突后合并——循环节点计数正确', () => {
  const run = mkRun({ stage: 'done', status: 'done' });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'ci' }],
      ['engine', { label: 'ci-fix-1', state: 'start', engine: 'claude' }],
      ['engine', { label: 'ci-fix-1', state: 'end', code: 0 }],
      ['engine', { label: 'ci-fix-2', state: 'start', engine: 'claude' }],
      ['engine', { label: 'ci-fix-2', state: 'end', code: 0 }],
      ['engine', { label: 'conflicts', state: 'start', engine: 'claude' }],
      ['engine', { label: 'conflicts', state: 'end', code: 0 }],
      ['stage', { stage: 'done' }],
    ]),
  );
  assert.equal(byId(g, 'ci-fix')?.round, 2);
  assert.equal(byId(g, 'ci-fix')?.status, 'ok');
  assert.equal(byId(g, 'conflicts')?.round, 1);
  assert.ok(g.edges.some((e) => e.source === 'ci-fix' && e.target === 'ci' && e.back));
});

test('序列 4：实现中途 failed——失败归属 implement，后续节点 pending，错误文本可见', () => {
  const run = mkRun({ stage: 'implement', status: 'failed', statusDetail: '测试修复 5 轮后仍失败' });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'worktree' }],
      ['stage', { stage: 'implement' }],
      ['engine', { label: 'implement', state: 'start', engine: 'claude' }],
      ['engine', { label: 'implement', state: 'end', code: 0 }],
      ['error', { error: '测试修复 5 轮后仍失败' }],
      ['status', { status: 'failed', detail: '测试修复 5 轮后仍失败' }],
    ]),
  );
  assert.equal(byId(g, 'worktree')?.status, 'ok');
  const impl = byId(g, 'implement')!;
  assert.equal(impl.status, 'bad');
  assert.match(impl.error ?? '', /测试修复 5 轮/);
  for (const id of ['pr', 'ci', 'done', 'review:claude', 'review:codex'])
    assert.equal(byId(g, id)?.status, 'pending', id);
});

test('运行中：当前打开的 engine 步骤 active（审查阶段 codex 审查中）', () => {
  const run = mkRun({ stage: 'autoReview', status: 'running', reviewRound: 1 });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'worktree' }],
      ['stage', { stage: 'implement' }],
      ['stage', { stage: 'autoReview' }],
      ['engine', { label: 'review-1-claude', state: 'start', engine: 'claude' }],
      ['engine', { label: 'review-1-claude', state: 'end', code: 0 }],
      ['engine', { label: 'review-1-codex', state: 'start', engine: 'codex' }],
    ]),
  );
  assert.equal(byId(g, 'implement')?.status, 'ok');
  assert.equal(byId(g, 'review:codex')?.status, 'active');
  assert.equal(byId(g, 'pr')?.status, 'pending');
  // 打开中的步骤累计到最后事件的耗时（0——它自己就是最后一个事件）
  assert.equal(byId(g, 'review:codex')?.durationMs, 0);
  assert.equal(byId(g, 'review:claude')?.durationMs, 10_000);
});

test('容错：断点续跑的重复 stage 事件与未知 label 不炸、归入其他步骤', () => {
  const run = mkRun({ stage: 'implement', status: 'running', resumes: 1 });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'worktree' }],
      ['stage', { stage: 'implement' }],
      ['log', { msg: '⟲ 手动续跑（从阶段 implement 继续）' }],
      ['stage', { stage: 'implement' }], // 续跑后重复进入同一阶段
      ['engine', { label: 'brand-new-step-9', state: 'start', engine: 'claude' }],
      ['engine', { label: 'brand-new-step-9', state: 'end', code: 0 }],
    ]),
  );
  // 节点不重复：implement 只有一个
  assert.equal(g.nodes.filter((n) => n.id === 'implement').length, 1);
  const other = byId(g, 'other')!;
  assert.equal(other.title, '其他步骤');
  assert.equal(other.round, 1);
  assert.ok(other.labels.includes('brand-new-step-9'));
});

test('审查打回进行中：有 must_fix 的引擎节点为 bad（打回态），修复节点 active', () => {
  const run = mkRun({ stage: 'autoReview', status: 'running', reviewRound: 1 });
  const g = deriveGraph(
    run,
    evs([
      ['stage', { stage: 'autoReview' }],
      ['engine', { label: 'review-1-claude', state: 'start', engine: 'claude' }],
      ['engine', { label: 'review-1-claude', state: 'end', code: 0 }],
      ['engine', { label: 'review-1-codex', state: 'start', engine: 'codex' }],
      ['engine', { label: 'review-1-codex', state: 'end', code: 0 }],
      ['review', { round: 1, passed: false, findings: [{ file: 'a.ts', issue: 'x', must_fix: true, reviewer: 'codex' }] }],
      ['engine', { label: 'fix-r1', state: 'start', engine: 'claude' }],
    ]),
  );
  assert.equal(byId(g, 'review:codex')?.status, 'bad');
  assert.equal(byId(g, 'review:codex')?.findings, 1);
  assert.equal(byId(g, 'review:claude')?.status, 'ok');
  assert.equal(byId(g, 'fix')?.status, 'active');
});

test('依赖 run：图含 awaitDeps/dep-bump 节点与改道边；无依赖 run 不含', () => {
  const dep = mkRun({
    stage: 'awaitDeps',
    status: 'running',
    dependsOn: ['r-up'],
    awaiting: [{ runId: 'r-up', package: '@acme/lib', baselineVersion: '1.0.0' }],
  });
  const g = deriveGraph(
    dep,
    evs([
      ['stage', { stage: 'worktree' }],
      ['stage', { stage: 'implement' }],
      ['stage', { stage: 'awaitDeps' }],
      ['engine', { label: 'dep-bump', state: 'start', engine: 'claude' }],
      ['engine', { label: 'dep-bump', state: 'end', code: 0 }],
    ]),
  );
  const await_ = byId(g, 'awaitDeps')!;
  assert.equal(await_.status, 'active');
  assert.match(await_.sub ?? '', /@acme\/lib/);
  assert.equal(byId(g, 'dep-bump')?.round, 1);
  // 主干改道：实现 → 等待上游 → 双边审查；直连边不存在
  assert.ok(g.edges.some((e) => e.source === 'implement' && e.target === 'awaitDeps'));
  assert.ok(g.edges.some((e) => e.source === 'awaitDeps' && e.target === 'review:claude'));
  assert.ok(!g.edges.some((e) => e.source === 'implement' && e.target === 'review:claude'));

  // 无依赖 run 完全不受影响
  const plain = deriveGraph(mkRun({ stage: 'implement', status: 'running' }), []);
  assert.equal(byId(plain, 'awaitDeps'), undefined);
  assert.ok(plain.edges.some((e) => e.source === 'implement' && e.target === 'review:claude'));
});

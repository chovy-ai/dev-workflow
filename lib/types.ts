// 共享类型：server / cli / web(经 JSON) 都以此为准

export const STAGES = [
  'worktree',
  'implement',
  'autoReview',
  'pr',
  'ci',
  'done',
] as const;
export type StageName = (typeof STAGES)[number];

/**
 * running  流水线推进中（含内部 review/测试/CI 修复循环，全自动，无暂停点）
 * failed   遇到无法自动恢复的问题（环境问题，或修复循环达到轮数上限），运行终止；
 *          没有 continue：需要人处理好环境后重新 `ship start`
 * done     全自动跑完：LLM review 通过、测试/CI 绿、PR 已自动合并
 */
export type RunStatus = 'running' | 'failed' | 'done';

/**
 * 引擎规格：
 * - string[]  外部 CLI 命令模板（"{prompt}" 占位符会被替换），如 codex
 * - object    Claude Agent SDK 引擎（进程内调用，支持流式输出、会话续传、精确工具白名单）
 */
export type EngineSpec =
  | string[]
  | {
      type: 'claude-sdk';
      /** 不填用 claude code 默认模型 */
      model?: string;
      /** 默认 acceptEdits */
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
      /** 默认 Bash/Edit/Write/Read/Glob/Grep/TodoWrite */
      allowedTools?: string[];
      maxTurns?: number;
    }
  | {
      type: 'codex-sdk';
      /** 不填用 codex 默认模型 */
      model?: string;
      /** 默认 workspace-write（可写工作区、默认禁网） */
      sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
      modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      /** workspace-write 下是否放开网络（装依赖等场景） */
      networkAccessEnabled?: boolean;
    };

export interface RunConfig {
  engine: string;
  base: string;
  /** null = 自动探测 */
  testCmd: string | null;
  maxReviewRounds: number;
  maxCiRounds: number;
  maxFixRounds: number;
  /** engine 名 → 引擎规格 */
  engines: Record<string, EngineSpec>;
  /**
   * 按步骤类型覆盖引擎，不配则用默认 engine。
   * key: implement | fix | testFix | ciFix | conflict（review 不走这里，见 reviewEngines）
   */
  stageEngines?: Partial<Record<StepKind, string>>;
  /**
   * autoReview 阶段双边独立审查的引擎名列表，默认 ['claude', 'codex']——两边跨厂商各自独立审查，
   * 都通过（pass=true 且无 must_fix）才算这一轮过；任一方打回都要修复后重新双边复审。
   * 没有人工兜底了，双边审查是唯一的质量把关。
   */
  reviewEngines: string[];
}

/** engine 调用的步骤类型（用于 stageEngines / reviewEngines 路由） */
export type StepKind = 'implement' | 'review' | 'fix' | 'testFix' | 'ciFix' | 'conflict';

export interface ReviewFinding {
  file: string;
  issue: string;
  must_fix: boolean;
  /** 哪个 engine 提出的这条发现（双边审查下用于区分来源） */
  reviewer?: string;
}

export interface RunRecord {
  id: string;
  title: string;
  repoPath: string;
  branch: string | null;
  /** git worktree 的绝对路径；worktree 阶段建好后才有值，运行终态后清理为 null */
  worktreePath: string | null;
  /** 所属运行组（run group）id；无组的单仓运行不带此字段 */
  groupId?: string;
  plan: string;
  stage: StageName;
  status: RunStatus;
  /** status 的补充说明（失败原因等） */
  statusDetail: string;
  reviewRound: number;
  /** 最近一轮 LLM 审查的 must_fix 发现（给 web 展示） */
  findings: ReviewFinding[];
  prUrl: string | null;
  /**
   * SDK 引擎的工作线程会话，按引擎名分桶（claude 的 session_id 和 codex 的 thread_id 不通用）。
   * 工作步骤（实现/修复/CI修复/解冲突）续用同一会话，修复时带着实现的上下文；
   * review 永远开新会话——独立审查靠的就是没有实现过程的上下文。
   */
  sdkSessions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  config: RunConfig;
}

/**
 * 运行组（run group）：一组仓库的 run 的纯聚合层。
 * 组不引入跨仓库执行耦合，没有依赖顺序，组内各 run 完全并行、各自独立推进。
 * 组状态不落盘，由成员 run 的状态实时推导（见 deriveGroupStatus）。
 */
export interface GroupRecord {
  id: string;
  title: string;
  /** 成员 run id（创建顺序） */
  runIds: string[];
  createdAt: string;
}

/**
 * 组状态（推导，不落盘）：
 * running  有成员推进中
 * failed   无推进中，但有成员 failed
 * done     全部完成
 */
export type GroupStatus = 'running' | 'failed' | 'done';

/** 从成员 run 推导组状态（供 API 与 web 复用）。空成员按 done 处理。 */
export function deriveGroupStatus(runs: RunRecord[]): GroupStatus {
  if (runs.some((r) => r.status === 'running')) return 'running';
  if (runs.some((r) => r.status === 'failed')) return 'failed';
  return 'done';
}

export type RunEventType =
  | 'log' // 普通进展文本
  | 'stage' // 进入某阶段 {stage}
  | 'status' // 状态变化 {status, detail}
  | 'engine' // engine 调用 {label, state: 'start'|'end', code?}
  | 'engine-line' // engine 输出行 {line}
  | 'review' // 一轮审查结论 {round, passed, findings}
  | 'error'
  | 'sync'; // SSE 专用（不落盘）：历史回放完毕，此后均为实时事件

export interface RunEvent {
  seq: number;
  ts: string;
  type: RunEventType;
  data: Record<string, unknown>;
}

export const DEFAULT_CONFIG: RunConfig = {
  engine: 'claude',
  base: 'main',
  testCmd: null,
  // 没有人工兜底了，熔断前多给几轮自动修复的机会再放弃
  maxReviewRounds: 5,
  maxCiRounds: 5,
  maxFixRounds: 5,
  reviewEngines: ['claude', 'codex'],
  engines: {
    // 默认走各家官方 SDK（进程内、流式、会话续传）；-cli 变体是外部命令后备
    claude: { type: 'claude-sdk' },
    codex: { type: 'codex-sdk' },
    'claude-cli': [
      'claude',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash,Edit,Write,Read,Glob,Grep',
      '-p',
      '{prompt}',
    ],
    'codex-cli': ['codex', 'exec', '--full-auto', '{prompt}'],
  },
};

export const DEFAULT_PORT = 4870;

// 共享类型：server / cli / web(经 JSON) 都以此为准

export const STAGES = [
  'branch',
  'implement',
  'autoReview',
  'humanReview',
  'pr',
  'ci',
  'done',
] as const;
export type StageName = (typeof STAGES)[number];

/**
 * running          流水线推进中
 * awaiting_review  停在人工 review 门禁，等 web 上 通过/打回
 * blocked          需要人工决策/环境处理（熔断、gh 缺失等），可 continue 续跑
 * failed           意外错误
 * done             全部完成，等人工合并 PR
 */
export type RunStatus = 'running' | 'awaiting_review' | 'blocked' | 'failed' | 'done';

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
   * 典型用法：跨厂商交叉审查（claude 实现、codex 审查），避免模型审自己代码的盲区。
   * key: implement | review | fix | testFix | ciFix | conflict
   */
  stageEngines?: Partial<Record<StepKind, string>>;
}

/** engine 调用的步骤类型（用于 stageEngines 路由） */
export type StepKind = 'implement' | 'review' | 'fix' | 'testFix' | 'ciFix' | 'conflict';

export interface ReviewFinding {
  file: string;
  issue: string;
  must_fix: boolean;
}

export interface RunRecord {
  id: string;
  title: string;
  repoPath: string;
  branch: string | null;
  plan: string;
  stage: StageName;
  status: RunStatus;
  /** status 的补充说明（阻塞原因等） */
  statusDetail: string;
  reviewRound: number;
  feedback: string[];
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
  maxReviewRounds: 3,
  maxCiRounds: 3,
  maxFixRounds: 3,
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

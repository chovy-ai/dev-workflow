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
 *          failureRecovery 明确标记应 resume 还是 supersede
 * done     全自动跑完：LLM review 通过、测试/CI 绿、PR 已自动合并
 */
export type RunStatus = 'running' | 'failed' | 'done';
/** failed run 的唯一合法恢复动作；旧记录没有该字段时由 runtime 做兼容推断。 */
export type FailureRecovery = 'resume' | 'supersede';

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
  /**
   * 分层测试门禁。仓库配置里的命令是不可被实现 engine 覆盖的最低门槛；
   * engine 可通过 .ship/testplan.json 追加本次改动的定向命令。
   */
  testPlan?: Partial<ShipTestPlan>;
  maxReviewRounds: number;
  maxCiRounds: number;
  maxFixRounds: number;
  /** engine 名 → 引擎规格 */
  engines: Record<string, EngineSpec>;
  /**
   * 按步骤类型覆盖引擎，不配则用默认 engine。
   * key: preflight | implement | fix | testFix | ciFix | conflict（review 不走这里，见 reviewEngines）
   */
  stageEngines?: Partial<Record<StepKind, string>>;
  /**
   * autoReview 阶段双边独立审查的引擎名列表，默认 ['claude', 'codex']——两边跨厂商各自独立审查，
   * 都通过（pass=true 且无 must_fix）才算这一轮过；任一方打回都要修复后复审。
   * 第 1 轮全量审查（分支累计 diff）；第 2 轮起为复审：打回方复核旧意见 + 修复增量，
   * 放行方只扫修复增量，must_fix 只能来自「旧意见未修好」或「增量新问题」，旧范围新发现降级 advisory。
   * 没有人工兜底了，双边审查是唯一的质量把关。
   */
  reviewEngines: string[];
  /**
   * 审查分工：engine 名 → 审查角色（架构/符合性各扫各的盲区，避免两个 engine 重复做同一类审查）。
   * architecture  全局架构视角：设计是否困于"只为实现而实现"、模块边界、可演进性
   * fidelity      方案符合性：把 plan 当合同逐条核对实现是否走样
   * 未配置角色的 engine 用通用审查 prompt。默认 claude→architecture、codex→fidelity。
   */
  reviewRoles?: Record<string, string>;
  /** 终局限域救援使用的 engine；缺省自动选择与主实现 engine 不同的可用 review engine。 */
  rescueEngine?: string;
}

export interface ShipTestPlan {
  /** 全套门禁中优先运行，宜为秒级定向测试。 */
  fast: string[];
  /** 包含类型检查/相关完整测试；CI 修复至少运行这一层。 */
  required: string[];
  /** 进入 reviewer 前与最终只读复验时运行；只放方案明确要求且环境稳定的 E2E。 */
  e2e: string[];
}

/** engine 调用的步骤类型（用于 stageEngines / reviewEngines 路由） */
export type StepKind =
  | 'preflight'
  | 'implement'
  | 'review'
  | 'fix'
  | 'testFix'
  | 'ciFix'
  | 'conflict'
  | 'retro';

/**
 * 复盘经验：run 终态后由 retro 步骤提炼，先暂存在 SHIP_HOME/knowledge/，
 * 由同仓库的下一条 run 同步进仓库根的 ship.lessons.md（进 git、团队共享），
 * 并注入后续 run 的 implement / 全量审查 prompt 作为避坑上下文。
 */
export interface Lesson {
  /** plan | implement | review | test | ci | harness */
  type: string;
  /** 一句话说清可复用的事实/坑 */
  lesson: string;
  /** 一句话说清后续 run 应该怎么做 */
  suggestion?: string;
}

/** 暂存区里的经验条目（带来源，便于追溯与去重清理） */
export interface PendingLesson extends Lesson {
  runId: string;
  ts: string;
}

export interface ReviewFinding {
  /** 跨修复/复审轮稳定追踪的 finding id；旧 reviewer 未提供时由 pipeline 补齐。 */
  id?: string;
  file: string;
  issue: string;
  must_fix: boolean;
  /** 被破坏的可复用不变量，而不是仅描述表面症状。 */
  invariant?: string;
  /** 审查者在代码中看到的直接证据。 */
  evidence?: string;
  /** 最小复现或会失败的用户/调用顺序。 */
  reproduction?: string;
  /** 回归测试必须穿过的真实生产边界，防止 mock 掉问题点。 */
  required_test_boundary?: string;
  /** 哪个 engine 提出的这条发现（双边审查下用于区分来源） */
  reviewer?: string;
  /**
   * 复审轮（第 2 轮起）的发现来源，用于收敛裁决：
   * previous = 上一轮意见未修好；delta = 修复增量引入的新问题；
   * other = 增量之外旧代码里的新发现（第 1 轮已双边背书过的范围，默认降级 advisory 不阻塞）。
   * 第 1 轮全量审查的发现不带此字段。
   */
  origin?: 'previous' | 'delta' | 'other';
  /**
   * origin=other 的逃生门：审查者确信旧范围新发现严重到必须现在阻塞时，
   * 在 must_fix=true 之外还必须写明理由（第 1 轮为何没发现、为何不能后续处理）；
   * 没有理由的 other must_fix 会被 pipeline 强制降级 advisory。
   */
  escape_reason?: string;
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
  /** 失败 run 的后继执行：保留审计谱系，不复用同一个已耗尽预算的 run。 */
  parentRunId?: string;
  /** 后继 run 建 worktree 时作为起点的失败 feature branch。 */
  sourceBranch?: string;
  /** 后继 run 在 implement 阶段优先修复的终局 findings。 */
  inheritedFindings?: ReviewFinding[];
  plan: string;
  stage: StageName;
  status: RunStatus;
  /** status 的补充说明（失败原因等） */
  statusDetail: string;
  failureRecovery?: FailureRecovery;
  reviewRound: number;
  /** 最近一轮 LLM 审查的 must_fix 发现（给 web 展示） */
  findings: ReviewFinding[];
  /** 各轮累计的 advisory 发现（不阻塞流程，最终附在 PR 描述里）。旧 run 记录可能没有此字段。 */
  advisories?: ReviewFinding[];
  /** run 终态后 retro 步骤提炼的复盘经验（同时进入 knowledge 暂存区，随下一条 run 进 git） */
  lessons?: Lesson[];
  /** 复盘完成时间：已总结过的标记（server 启动补扫据此跳过；knowledge/summarized.ndjson 是集中台账） */
  retroAt?: string;
  /** 续跑次数（server 重启自动续跑 + 手动 resume 都计入；自动续跑有上限防死循环） */
  resumes?: number;
  prUrl: string | null;
  /**
   * SDK 引擎的工作线程会话，按引擎名分桶（claude 的 session_id 和 codex 的 thread_id 不通用）。
   * 工作步骤（实现/修复/CI修复/解冲突）续用同一会话，修复时带着实现的上下文；
   * review 永远开新会话——独立审查靠的就是没有实现过程的上下文。
   */
  sdkSessions: Record<string, string>;
  /** lessons 等 harness 提交完成后的基点，用于识别后续是否有人改动 harness-managed 文件。 */
  harnessManagedBaseSha?: string;
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
  | 'review' // 一轮审查结论 {round, passed, findings, advisories?, rescue?}
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
  testPlan: { fast: [], required: [], e2e: [] },
  // 第 1 轮全量 + 第 2 轮复审（打回方复核 + 放行方扫增量）。终局轮若只剩「旧意见未修净」
  // 还有一次锁定范围的窄门补救（见 pipeline.rescueRound），所以 2 轮足够，不再多轮开荒。
  maxReviewRounds: 2,
  maxCiRounds: 5,
  maxFixRounds: 5,
  reviewEngines: ['claude', 'codex'],
  reviewRoles: { claude: 'architecture', codex: 'fidelity' },
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

import { Codex } from '@openai/codex-sdk';

export interface CodexSdkSpec {
  type: 'codex-sdk';
  model?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  networkAccessEnabled?: boolean;
}

export interface CodexSdkResult {
  /** 0 = turn 正常完成；1 = turn.failed / error 事件；127 = SDK 调用本身失败 */
  code: number;
  sessionId: string | null;
}

// Codex 实例可复用（无状态，线程状态在 ~/.codex/sessions）
let codexSingleton: Codex | null = null;

/**
 * 用 OpenAI Codex SDK 跑一步。与 claude 的 sdkEngine 同构：
 * resume 传上一次 thread_id 则带上下文续跑；review 步骤必须传 null。
 * 不传 CodexOptions.env / apiKey —— 让底层 codex CLI 复用本机登录（~/.codex/auth.json）。
 */
export async function runCodexSdkEngine(p: {
  prompt: string;
  cwd: string;
  spec: CodexSdkSpec;
  resume: string | null;
  onLine: (line: string) => void;
}): Promise<CodexSdkResult> {
  let sessionId: string | null = p.resume;
  try {
    codexSingleton ??= new Codex();
    const threadOpts = {
      workingDirectory: p.cwd,
      sandboxMode: p.spec.sandboxMode ?? ('workspace-write' as const),
      skipGitRepoCheck: true,
      approvalPolicy: 'never' as const, // headless：没有人能答复审批请求
      ...(p.spec.model ? { model: p.spec.model } : {}),
      ...(p.spec.modelReasoningEffort ? { modelReasoningEffort: p.spec.modelReasoningEffort } : {}),
      ...(p.spec.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: p.spec.networkAccessEnabled }
        : {}),
    };
    const thread = p.resume
      ? codexSingleton.resumeThread(p.resume, threadOpts)
      : codexSingleton.startThread(threadOpts);

    const { events } = await thread.runStreamed(p.prompt);
    let failed = false;
    for await (const ev of events) {
      switch (ev.type) {
        case 'thread.started':
          sessionId = ev.thread_id;
          break;
        case 'item.completed': {
          const it = ev.item;
          if (it.type === 'agent_message') {
            for (const line of it.text.split('\n')) if (line.trim()) p.onLine(line);
          } else if (it.type === 'command_execution') {
            const tail = it.exit_code !== undefined && it.exit_code !== 0 ? ` (exit ${it.exit_code})` : '';
            p.onLine(`⚙ ${it.command.slice(0, 120)}${tail}`);
          } else if (it.type === 'file_change') {
            p.onLine(`✎ ${it.changes.map((c) => `${c.kind} ${c.path}`).join(', ')}`);
          } else if (it.type === 'error') {
            p.onLine(`✖ ${it.message}`);
          }
          break;
        }
        case 'turn.completed':
          p.onLine(`— 完成（${ev.usage.output_tokens} out-tokens，cached ${ev.usage.cached_input_tokens}）`);
          break;
        case 'turn.failed':
          p.onLine(`— 失败：${ev.error.message}`);
          failed = true;
          break;
        case 'error':
          p.onLine(`✖ ${ev.message}`);
          failed = true;
          break;
      }
    }
    return { code: failed ? 1 : 0, sessionId: sessionId ?? thread.id };
  } catch (e) {
    p.onLine(`codex SDK 错误：${e instanceof Error ? e.message : e}`);
    return { code: 127, sessionId };
  }
}

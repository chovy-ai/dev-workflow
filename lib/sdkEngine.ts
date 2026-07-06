import { query } from '@anthropic-ai/claude-agent-sdk';

export interface SdkSpec {
  type: 'claude-sdk';
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowedTools?: string[];
  maxTurns?: number;
}

export interface SdkEngineResult {
  /** 0 = result:success；1 = result:error 或流异常结束；127 = SDK 调用本身失败 */
  code: number;
  sessionId: string | null;
  costUsd: number | null;
}

const DEFAULT_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'TodoWrite'];

/**
 * 用 Claude Agent SDK 跑一步。进程内调用（底层由 SDK 管理 claude 运行时），
 * 相比 shell `claude -p`：流式拿到每条助手消息与工具调用、可 resume 会话、能读 token 成本。
 */
export async function runSdkEngine(p: {
  prompt: string;
  cwd: string;
  spec: SdkSpec;
  /** 传入上一次的 session_id 则带上下文续跑；review 步骤必须传 null（独立审查） */
  resume: string | null;
  onLine: (line: string) => void;
}): Promise<SdkEngineResult> {
  let sessionId: string | null = null;
  try {
    const q = query({
      prompt: p.prompt,
      options: {
        cwd: p.cwd,
        permissionMode: p.spec.permissionMode ?? 'acceptEdits',
        allowedTools: p.spec.allowedTools ?? DEFAULT_TOOLS,
        ...(p.spec.model ? { model: p.spec.model } : {}),
        ...(p.spec.maxTurns ? { maxTurns: p.spec.maxTurns } : {}),
        ...(p.resume ? { resume: p.resume } : {}),
      },
    });

    for await (const msg of q) {
      const anyMsg = msg as { session_id?: string };
      if (anyMsg.session_id) sessionId = anyMsg.session_id;

      if (msg.type === 'assistant') {
        const content: Array<{ type: string; text?: string; name?: string }> =
          (msg as { message?: { content?: [] } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            for (const line of block.text.split('\n')) if (line.trim()) p.onLine(line);
          } else if (block.type === 'tool_use') {
            p.onLine(`⚙ ${block.name}`);
          }
        }
      } else if (msg.type === 'result') {
        const r = msg as unknown as {
          subtype: string;
          is_error: boolean;
          num_turns: number;
          total_cost_usd: number;
          usage?: { output_tokens?: number };
        };
        const ok = r.subtype === 'success' && !r.is_error;
        p.onLine(
          `— ${ok ? '完成' : '异常结束'}（${r.num_turns} turns` +
            (typeof r.total_cost_usd === 'number' ? `，$${r.total_cost_usd.toFixed(4)}` : '') +
            (r.usage?.output_tokens ? `，${r.usage.output_tokens} out-tokens` : '') +
            '）',
        );
        return { code: ok ? 0 : 1, sessionId, costUsd: r.total_cost_usd ?? null };
      }
    }
    return { code: 1, sessionId, costUsd: null }; // 流结束却没有 result 消息
  } catch (e) {
    p.onLine(`SDK engine 错误：${e instanceof Error ? e.message : e}`);
    return { code: 127, sessionId, costUsd: null };
  }
}

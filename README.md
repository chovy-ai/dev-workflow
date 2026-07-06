# ship — 方案 → PR 的代码化交付 harness（Next.js · 本地）

把「聊完方案之后」的流程固化为**代码状态机**：流程推进、门禁判定、循环上限全部由代码裁决；
LLM（claude code / codex）只被调用来完成单个步骤。人只在三个点介入：
**确认方案**（入口）、**web 上 review**（中间门禁）、**合并 PR**（出口）。

```
方案确认 ─► branch ─► implement ─► LLM审查 ⟲ fix ─► 人工Review(web) ─► pr ─► ci ⟲ fix/冲突 ─► 等人工合并
                       │测试门禁     │JSON结论,代码裁决   │通过/打回          │gh轮询,代码裁决
                       │            │≤3轮熔断           │打回→修复→复审⟲    │≤3轮熔断
```

## 架构（本地单机）

- **server + web**：Next.js（App Router）。API Routes 承载状态机与 engine 调度，
  React 页面承载 review 控制台，SSE 推实时事件。数据落盘 `~/.ship-server/`（可用 `SHIP_HOME` 覆盖）。
- **CLI**：薄客户端，HTTP 连接 server；在目标仓库目录里发起/跟踪/控制流水线。
- **engine**：默认走官方 SDK 进程内调用——claude 用 `@anthropic-ai/claude-agent-sdk`、codex 用
  `@openai/codex-sdk`，两者都复用本机 CLI 登录凭据。SDK 引擎带来：流式输出逐行进 web 日志、
  **会话续传**（修复步骤带着实现的上下文，review 永远新会话保证独立性）、token 用量记录。
  `claude-cli` / `codex-cli` 是外部命令后备，engines 配置也可接任意自定义 CLI。

## 为什么是代码而不是提示词

- **merge 没有代码路径**——物理上不可能发生；push 只推 feature 分支，force 只用 `--force-with-lease`
- LLM 审查结论必须写成 `.ship/review.json`，**通过与否由代码解析裁决**
- 测试门禁由代码运行、看退出码；review/CI/测试修复各 3 轮熔断，超限交还人工
- 实测无约束的 LLM 在打回场景会直接 merge main——所以红线必须代码兜底

## 使用

```bash
# 1. 启动 server + web（一次即可，常驻）
npm run serve                      # http://localhost:4870

# 2. 在目标仓库目录：聊完方案存成 plan.md，然后
alias ship="npx tsx ~/Desktop/dev-workflow/cli/index.ts"
ship start --plan plan.md          # 自动：建分支→实现→LLM审查循环→停在人工门禁

# 3. 打开 web review（CLI 会打印链接）：看 Diff / 审查发现 / 日志
#    ✓ 通过 → 自动提 PR → CI 循环 → 完成（等你人工合并）
#    ⟲ 打回（附意见）→ 修复 → LLM 复审 → 重新回到人工门禁

# 其他
ship ls                            # 所有运行
ship attach <id>                   # 实时跟踪
ship approve/reject/continue <id>  # 不开 web 也能操作
```

状态含义：`running` 推进中 · `awaiting_review` 等人工 review · `blocked` 需人工处理后 continue ·
`done` 等人工合并。

## 配置（目标仓库的 ship.config.json，可选）

```json
{
  "engine": "claude",
  "base": "main",
  "testCmd": null,
  "maxReviewRounds": 3,
  "maxCiRounds": 3,
  "maxFixRounds": 3,
  "engines": { "自定义名": ["命令", "参数", "{prompt}"] }
}
```

`testCmd: null` 时自动探测（npm test / make test / pytest / tests.py）。
优先级：API 请求体 > 仓库 ship.config.json > 默认值。

## 在流程中使用 agent

三个层面：

1. **engine 本身就是完整 agent**：`claude -p` / `codex exec` 在每个步骤里自主读代码、跑测试、
   调工具，也能调用目标仓库 `.claude/agents/` 里定义的自定义 subagent。
2. **按步骤路由不同引擎**（`stageEngines`）：典型用法是跨厂商交叉审查——claude 实现、codex 审查，
   避免模型审自己代码的盲区；或审查用更强的模型：

   ```json
   {
     "engine": "claude",
     "stageEngines": { "review": "codex" },
     "engines": {
       "claude-opus": ["claude", "--model", "opus", "--permission-mode", "acceptEdits",
                        "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep", "-p", "{prompt}"]
     }
   }
   ```

   可路由的步骤：`implement` / `review` / `fix` / `testFix` / `ciFix` / `conflict`。
3. **方案阶段（流程入口之前）**：照常在 claude code / codex 里用 Plan、Explore 等 agent 打磨方案，
   harness 只消费最终确认的 plan.md。

## 代码结构

```
lib/        核心（与框架无关）：types / store(落盘+事件流) / pipeline(状态机) / exec / prompts / runtime(单例)
app/        Next.js：page.tsx(review 控制台) + api/runs/**(REST + SSE)
cli/        CLI：serve / start / ls / status / attach / approve / reject / continue
```

## 已验证（mock 引擎确定性端到端）

- 全流程：建分支 → 实现 → 测试门禁 → LLM 审查拦截 → 修复 → 复审通过 → 人工门禁暂停
- web/CLI 打回：意见 → 修复 → 复审 → 重回门禁；通过 → push → PR 阶段
- `.ship/` 自动写入 `.git/info/exclude`，不会混进提交
- 熔断与优雅降级：remote 非 GitHub / 缺 gh 时 blocked 并给出指引，处理后 continue
- 全程 origin/main 零改动；`next build` 生产构建通过

CI / 冲突阶段（`gh pr checks --watch`、mergeable 轮询）尚未在真实 GitHub 仓库跑过，
首次使用建议挑一个低风险仓库全流程走一遍。

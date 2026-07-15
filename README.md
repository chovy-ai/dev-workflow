# ship — 方案 → 自动合并 PR 的代码化交付 harness（Next.js · 本地）

把「聊完方案之后」的流程固化为**代码状态机**：流程推进、门禁判定、循环上限、PR 合并全部由代码裁决；
LLM（claude code / codex）只被调用来完成单个步骤。**全程无需人工介入**：人只在一个点参与——
**确认方案**（入口，在 harness 之外的对话里完成）。之后 `ship start` 一路跑到 PR 自动合并，
web 只是一个只读的进度看板。

```
方案确认 ─► worktree ─► implement ─► 双边审查 ⟲ fix ─► pr ─► ci ⟲ fix/冲突 ─► 合并确认 ─► cleanup ─► done
          │origin/base │测试门禁      │claude+codex 各自独立     │挂auto-merge       │auto-merge      │删 worktree
          │最新代码建   │              │JSON结论,代码裁决          │gh轮询,代码裁决    │或兜底squash      （成功/失败都清）
          │独立 worktree│             │第1轮全量,第2轮复审增量     │修复≤5轮熔断       │
          │             │             │任一方打回即不通过,≤2轮熔断│
          └── 任一环节修复仍失败 → 运行终止（failed），不等人，需重新 `ship start` ──┘
```

## 架构（本地单机）

- **server + web**：Next.js（App Router）。API Routes 承载状态机与 engine 调度，
  React 页面承载**只读**进度看板（日志/Diff/审查发现），SSE 推实时事件。数据落盘 `~/.ship-server/`
  （可用 `SHIP_HOME` 覆盖）。
- **CLI**：薄客户端，HTTP 连接 server；在目标仓库目录里发起/跟踪一条流水线。
- **worktree 隔离**：每条 run 在 `git worktree add` 出的独立目录里跑（基于最新 `origin/base`），
  不碰原仓库的工作目录——原仓库有没有未提交改动都不影响 run。**同一个仓库支持并行跑多条 run**，
  分支名带 run id 后缀避免撞车，各 run 完全独立互不打架。
  run 结束（无论成功还是失败）都会自动 `git worktree remove` 清掉，不在磁盘上留残留检出；
  失败时本地分支仍保留（不删），方便事后排查。
- **engine**：默认走官方 SDK 进程内调用——claude 用 `@anthropic-ai/claude-agent-sdk`、codex 用
  `@openai/codex-sdk`，两者都复用本机 CLI 登录凭据。SDK 引擎带来：流式输出逐行进 web 日志、
  **会话续传**（修复步骤带着实现的上下文，review 永远新会话保证独立性）、token 用量记录。
  `claude-cli` / `codex-cli` 是外部命令后备，engines 配置也可接任意自定义 CLI。

## 为什么是代码而不是提示词

- **worktree 是隔离红线**——LLM 在自己的检出目录里改代码，物理上碰不到原仓库当前签出的分支/改动
- **双边审查是质量红线**——`reviewEngines`（默认 `claude` + `codex`）各自独立跑一遍审查、各写各的
  `.ship/review-<engine>.json`，**必须两边都 pass 才算过**；任一方打回都要修复后复审，
  没有人工兜底，靠两个厂商互相盯梢补盲区。审查按轮收窄保证收敛：第 1 轮双边全量（分支累计 diff），
  第 2 轮起打回方复核自己的旧意见 + 修复增量、放行方只扫修复增量，must_fix 只能来自
  「旧意见未修好」或「增量新问题」；旧范围新发现默认降级 advisory 附进 PR 描述（审查者给出
  escape_reason 才能例外阻塞）。终局轮若只剩「旧意见未修净」，还有一次锁定范围的窄门补救
  （追加修复 + 打回方复核），补救后仍不过才熔断
- **merge 有代码路径，但受代码红线约束**——ci 阶段一进入就挂 GitHub 原生 auto-merge
  （`gh pr merge --squash --auto`）：required check 一绿 GitHub 立即自动合并，不等非必需的慢 check，
  分支落后 base 但无冲突也照合（不做 update-branch 处理）。harness 只轮询裁决：CI 失败交 engine 修
  （非必需 check 挂了也修，但合并不等它们跑完）、冲突走 rebase 解决、合并完成即放行。
  仓库未启用 auto-merge 时退回旧路径：全绿后由 `stageMerge` 调用一次 `gh pr merge --squash` 兜底。
  push 全程只推 feature 分支，force 只用 `--force-with-lease`
- 测试门禁由代码运行、看退出码；review 2 轮（+终局窄门补救一次）、CI/测试修复各 5 轮熔断——
  **熔断即终止**（`failed`），不会挂起等人工决策
- 实测无约束的 LLM 在打回场景会直接 merge main——所以红线必须代码兜底：合并动作只有两个受控出口，
  都在 pipeline 代码里、都以 required checks 全绿为前提——`stageCi` 挂的 GitHub auto-merge，
  和 `stageMerge` 的兜底 squash；engine 的 prompt 一律禁止 push/merge
- **复盘闭环（lessons）**——每条 run 终态后（成败都算）跑一步 retro：代码把事件流压成执行摘要
  （阶段耗时、审查各轮结论、CI 结果），engine 把这次**犯过的错**（审查打回根因、CI 失败原因、
  返工/熔断根因）提炼成 ≤5 条凝练的仓库级经验，先落 `SHIP_HOME/knowledge/` 暂存区；
  同仓库**下一条** run 在 implement 前把暂存经验同步进仓库根的 `ship.lessons.md` 并单独 commit
  （进 git、团队共享——一条 run 的复盘发生在自己 PR 合并之后，只能搭下一条 PR 的车），
  同时注入 implement 与第 1 轮全量审查的 prompt 作为避坑上下文；暂存条目在确认已落盘进仓库文件后
  自动清理，PR 没合并也不会丢。已总结的 run 由 `run.json` 的 `retroAt` 标记 +
  `knowledge/<repo>/summarized.ndjson` 台账双重记录，绝不重复总结；server 启动时会补扫
  「已终态但没总结过」的 run（每次最多 3 条、只追 14 天内），保证每条 run 都被总结过一次
- **中断续跑（resume）**——状态机 stage 与 SDK 会话全程持久化在 `run.json`，中断天然可续：
  server 重启后原本推进中的 run **自动从当前阶段续跑**（worktree 被清理过就从保留的分支重建，
  卡在 rebase 一半先 abort；自动续跑最多 3 次防死循环）；失败终止的 run（如网络抖动导致 push 失败）
  可手动 `ship resume <id>` / web「从断点续跑」按钮 / `POST /api/runs/:id/resume` 从断点继续

## 使用

```bash
# 1. 启动 server + web（一次即可，常驻；web 是只读看板）
npm run serve                      # http://localhost:4870

# 2. 在目标仓库目录：聊完方案存成 plan.md，然后
alias ship="npx tsx ~/Desktop/dev-workflow/cli/index.ts"
ship start --plan plan.md          # 全自动：worktree→实现→双边审查循环→提PR→CI循环→自动合并→cleanup→done
ship start --plan plan.md --engine codex   # 实现/修复用 codex（默认 claude；devflow 入口按"engine 跟随发起方"传这个参数）

# 3. 打开 web 看板（CLI 会打印链接）：看 Diff / 审查发现 / 日志，纯观察，无需操作
#    done   → PR 已自动合并，worktree 已清理
#    failed → 运行已终止（轮数熔断或环境问题），看 statusDetail；环境类问题处理好后
#             ship resume <id> 从断点续跑（分支保留，worktree 会自动重建），或重新 ship start

# 其他
ship ls                            # 所有运行
ship attach <id>                   # 阻塞到该运行到达终态（done/failed）才返回，期间打印实时输出
ship resume <id>                   # 中断/失败的运行从持久化的阶段继续（自动重建 worktree）
```

`ship attach <id>` 阻塞到终态才退出这个特性，是给 agent 编排用的原语：agent 触发 `ship start
--no-attach` 后，把 `ship attach <id>` 丢进自己所在环境的后台执行能力里（不同步等待），run 跑完时
agent 会收到"后台任务完成"通知，从而在不占用当前对话轮次的情况下被自动唤醒继续——不需要用户回来
盯着问"跑完了没"。`devflow` skill（`~/.claude/skills/devflow`、`~/.codex/skills/devflow`）已经按这个
模式写好了。

状态含义：`running` 全自动推进中（内含 worktree/双边审查/测试/CI 修复循环） · `failed` 运行终止，
无 continue，需重新发起 · `done` PR 已自动合并。

## 配置（目标仓库的 ship.config.json，可选）

```json
{
  "engine": "claude",
  "base": "main",
  "testCmd": null,
  "maxReviewRounds": 2,
  "maxCiRounds": 5,
  "maxFixRounds": 5,
  "reviewEngines": ["claude", "codex"],
  "engines": { "自定义名": ["命令", "参数", "{prompt}"] }
}
```

`testCmd: null` 时自动探测：优先读 implement 阶段 engine 写下的 `.ship/testcmd`
（monorepo 等根目录探测不到命令的场景），再退到通用探测（npm test / make test / pytest / tests.py）。
优先级：API 请求体 > 仓库 ship.config.json > 默认值。
review 轮上限是 2：第 1 轮全量已双边背书，第 2 轮复审收窄到「旧意见 + 修复增量」，
再多轮就是重新开荒（每轮挖新问题、不收敛，实测 4 个 run 全部跑满轮数）；
终局轮只剩旧意见未修净时另有一次不占轮次的窄门补救。CI/测试修复保持 5 轮预算。
超限后依然直接判失败，不会挂起。

`reviewEngines` 决定 autoReview 阶段哪几个 engine 参与双边审查，默认两家官方 SDK 都上；
改成 `["claude"]` 可以退回单边审查，也可以填第三个自定义 engine 名做三边审查。

## 在流程中使用 agent

三个层面：

1. **engine 本身就是完整 agent**：`claude -p` / `codex exec` 在每个步骤里自主读代码、跑测试、
   调工具，也能调用目标仓库 `.claude/agents/` 里定义的自定义 subagent。
2. **按步骤路由不同引擎**（`stageEngines`）：给实现/修复/CI修复/解冲突这些步骤单独指定 engine，
   不配则用默认 `engine`：

   ```json
   {
     "engine": "claude",
     "stageEngines": { "ciFix": "codex" },
     "engines": {
       "claude-opus": ["claude", "--model", "opus", "--permission-mode", "acceptEdits",
                        "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep", "-p", "{prompt}"]
     }
   }
   ```

   可路由的步骤：`implement` / `fix` / `testFix` / `ciFix` / `conflict`。
   `review` 不走这里——review 由 `reviewEngines` 双边审查，见上一节。
3. **方案阶段（流程入口之前）**：照常在 claude code / codex 里用 Plan、Explore 等 agent 打磨方案，
   harness 只消费最终确认的 plan.md。

## 代码结构

```
lib/        核心（与框架无关）：types / store(落盘+事件流) / pipeline(状态机) / exec / prompts / runtime(单例)
app/        Next.js：page.tsx(只读看板) + api/runs/**(REST + SSE)
cli/        CLI：serve / start / ls / status / attach
```

## 已验证（mock 引擎确定性端到端）

- 全流程：建 worktree → 实现 → 测试门禁 → 双边审查拦截 → 修复 → 复审通过 → 提 PR → CI 循环 → 自动合并 → cleanup
- `.ship/` 自动写入 worktree 的 git-dir `info/exclude`，不会混进提交
- 熔断：任一环节达到轮数上限直接判失败，不挂起；remote 非 GitHub / 缺 gh 时同样直接判失败
- 全程 origin/main 除最终 squash merge 外零改动；`next build` 生产构建通过

CI / 冲突 / 自动合并阶段（`gh pr checks --watch`、mergeable 轮询、`gh pr merge`）、以及 worktree 在
真实仓库上的 add/remove 尚未跑过全流程，**首次使用强烈建议挑一个低风险仓库、允许被自动合并的分支保护
规则较松的仓库走一遍**，确认行为符合预期后再接入重要仓库。

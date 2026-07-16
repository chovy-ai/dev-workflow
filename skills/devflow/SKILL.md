---
name: devflow
description: 方案在对话中聊完并确认后，把方案交给 ship harness 全自动交付（worktree 隔离实现 → claude+codex 双边审查 → 提 PR → CI/冲突修复 → 自动合并 → 清理 worktree，全程无需人工介入）。支持单仓库和多仓库联动（run group）。当用户说「交付」「ship」「走流程」「按流程执行」「开始执行方案」「交给流水线」时使用。前提是方案已经讨论并确认；方案还没确认时不要触发。
---

# devflow：把确认的方案交给全自动交付流水线（底层是 ship harness）

你只做三件事：**把方案写成文件、确保 server 在跑、触发流水线**。不要自己实现方案、不要建分支、不要 commit——那些是 harness 状态机的职责，它有 worktree 隔离、测试门禁、双边独立审查循环，全程代码裁决。

> 本文件的真相源在 `~/Desktop/dev-workflow/skills/devflow/SKILL.md`（`~/.claude/skills/devflow`
> 与 `~/.codex/skills/devflow` 是指向它的软链）。要改内容请改仓库里这份并提交。

## 单仓库 or 多仓库？

方案只涉及一个仓库 → 走下面的「单仓库步骤」。
方案横跨多个仓库（用户聊出了各仓库各自的改动）→ 走「多仓库步骤」（run group）。

## 单仓库步骤

1. **整理方案（必须足够详细——方案是流水线的合同）**：把对话中最终确认的方案写入仓库根目录 `plan.md`。第一行 `# 简短标题`（会成为分支名和 PR 标题的来源），正文必须包含这四部分：
   - **目标/背景**：要解决什么问题、为什么做
   - **改动点**：逐项列出——改哪些模块/文件、各自怎么改、新行为的语义
   - **约束**：不许动什么（协议/依赖/架构边界）、遵循哪些既有惯例
   - **验收标准**：怎么算做完——可验证的行为描述 + 应有的测试

   写到「没参与讨论的人拿着它能独立实现和验收」的程度。审查阶段是分工制：codex 拿方案**逐条核对实现有没有走样**、claude 从**全局架构视角**审设计——方案太粗，两边审查都没有依据。**太短的方案（<300 字）server 会直接拒绝创建**。只写确认过的内容，不要夹带讨论过程。方案不明确或用户没确认过 → 先向用户确认，不要触发。

2. **确保 server 在跑**——不要问用户、不要让用户自己去开，自己检查、自己拉起：
   ```bash
   curl -sf http://localhost:4870/api/runs > /dev/null
   ```
   不可达就在后台拉起（不要占用前台等待，也不要重复拉起——已经在跑时 curl 会直接成功）：
   ```bash
   (cd ~/Desktop/dev-workflow && nohup npm run serve > /tmp/ship-serve.log 2>&1 &)
   ```
   然后轮询到可达为止（间隔 1s，最多等 ~20 次）：
   ```bash
   for i in $(seq 1 20); do curl -sf http://localhost:4870/api/runs > /dev/null && break; sleep 1; done
   ```
   20 次后仍不可达 → 读 `/tmp/ship-serve.log` 找报错（常见：端口被占、依赖没装），把报错内容告诉用户，不要继续触发流水线。

3. **触发流水线**（在目标仓库根目录）：
   ```bash
   npx tsx ~/Desktop/dev-workflow/cli/index.ts start --plan plan.md --engine <claude|codex> --no-attach
   ```
   记下输出里的 run id，后面两步都要用。
   **`--engine` 跟随发起方**：方案是在哪个 agent 的对话里聊定的，实现就用哪个 engine——你是 Claude Code 就传 `--engine claude`，你是 Codex 就传 `--engine codex`。用户明确点名用另一个 engine 时听用户的。双边审查恒为 claude+codex，不受此参数影响。

4. **用后台监听拿完成通知，而不是自己傻等或撒手不管**：`ship attach <run-id>` 本身就是一条会阻塞到该 run
   到达终态（`done`/`failed`）才退出的命令，退出时的输出就是最终结果（PR 链接，或失败原因）。**不要同步
   调用它**——用你所在环境提供的"后台跑命令、命令结束时会通知你"的能力去跑：
   ```bash
   npx tsx ~/Desktop/dev-workflow/cli/index.ts attach <run-id>
   ```
   （Claude Code 里就是 Bash 工具的 `run_in_background: true`；别的环境找等价能力。）
   然后正常继续手头其它事或者结束这一轮——**收到"后台任务完成"的通知后再回来读这条命令的输出**，
   据此告诉用户结果、或者接着做下一步（比如触发依赖它的下一个任务）。
   如果你所在的环境没有这种后台+完成通知的能力，退回旧办法：跳过这步，直接执行下一步。

5. **交还给用户**：把 run id 和 web 链接（http://localhost:4870/#/run/<id>）告诉用户，说明：流水线全自动跑完——建 worktree（基于最新 origin/base，不碰用户当前的工作目录）→ 实现 → claude+codex 双边分工审查（claude 审全局架构、codex 逐条核对方案符合性；第 1 轮全量、第 2 轮复审收窄到旧意见+修复增量，都通过才放行，打回未过即熔断）→ 提 PR → 挂 GitHub auto-merge + CI/冲突修复循环（required 检查一绿即自动合并，不等非必需检查）→ 清理 worktree。**不会停下来等任何人操作**。跑完是 `done`（PR 已自动合并）或 `failed`（某环节熔断或环境问题，看 web 上的 statusDetail）。如果第 4 步挂了后台监听，等它通知你之后可以直接把结果告诉用户，不用用户自己去 web 上看。

6. **失败后的处置**：
   - 环境类问题（网络抖动、push 失败、server 重启）使用**断点续跑**：
   ```bash
   npx tsx ~/Desktop/dev-workflow/cli/index.ts resume <run-id>
   ```
   它会从持久化阶段继续（worktree 被清理过会从保留分支自动重建）。
   - 审查轮数熔断使用**后继执行**，保留已有实现、终局 findings 和分支成果，同时获得新的审查预算：
   ```bash
   npx tsx ~/Desktop/dev-workflow/cli/index.ts supersede <run-id> --plan plan.md --engine <claude|codex> --no-attach
   ```
   原方案不需要修订时可省略 `--plan`。后继 run 会从失败 feature branch 建新分支、rebase 最新
   origin/base、只修终局 findings，再重新走测试与双边审查；不要对审查熔断 run 使用 `resume`。

## 多仓库步骤（run group）

1. **各仓库分别写方案**：把每个仓库的方案写入**该仓库自己的** `plan.md`（各写各的确认稿）。

2. **写组清单 JSON**（放在任意位置，如当前目录 `ship-group.json`）：
   ```json
   {
     "title": "组的简短标题",
     "engine": "claude",
     "repos": [
       { "path": "~/code/api-lib",   "plan": "plan.md" },
       { "path": "~/code/service-a", "plan": "plan.md" }
     ]
   }
   ```
   `path` 支持 `~` 展开和相对清单文件的相对路径；`plan` 是该仓库内的方案文件路径。
   `engine` 跟随发起方（Claude Code → `"claude"`，Codex → `"codex"`），也可在单个 repo 项里覆盖。

   **仓库间有依赖时**（例如 lib 发包、a/b 等它发布后更新依赖），用 `name`/`dependsOn`/`publishes` 声明：
   ```json
   {
     "title": "升级 @acme/lib 并适配",
     "repos": [
       { "name": "lib",  "path": "~/code/lib", "plan": "plan.md",
         "publishes": { "package": "@acme/lib" } },
       { "name": "app-a", "path": "~/code/a", "plan": "plan.md", "dependsOn": ["lib"] }
     ]
   }
   ```
   语义：各仓库 implement 照常并行；下游在 implement 后进入 `awaitDeps` 阶段——等上游 run 全部
   `done`（PR 已合并），且探测到 `publishes.package` 发布了相对组创建时的新版本（默认轮询
   `npm view <pkg> version`，可用 `publishes.check` 自定义命令、`timeoutMinutes` 调超时，默认 30 分钟），
   然后自动执行 depBump（依赖更新到探测版本 + 修适配 + 过测试门禁）再进入双边审查。
   上游没有 `publishes` 时下游只等其 done。等待超时 → failed，人工确认发布后 `ship resume` 从等待处续跑。
   依赖成环 / 指向不存在的 name → 整组创建被拒（400）。

3. **确保 server 在跑**（同单仓步骤 2，逻辑完全一样）。

4. **触发整组**：
   ```bash
   npx tsx ~/Desktop/dev-workflow/cli/index.ts start --group ship-group.json
   ```
   创建是**原子的**：任一仓库不是 git 仓库，整组都不会创建，错误会指明是哪个仓库。
   输出里每行是一个成员的 `<run-id>  <仓库目录名>`，记下来。

5. **（可选）给每个成员分别挂后台监听**：跟单仓步骤 4 一样，对组里每个 run id 分别用后台方式跑
   `npx tsx ~/Desktop/dev-workflow/cli/index.ts attach <run-id>`（并行挂多个，互不影响）。全部收到完成通知后再汇总结果给用户。

6. **交还给用户**：给出组 id 和组视图链接（http://localhost:4870/#/group/<id>），说明：各仓库各自建独立 worktree、完全并行、全自动跑到 `done`/`failed`，组视图能一屏看所有仓库的进度和 diff，不需要人工操作。

## 注意

- **同一仓库支持并行发起多条 run**——每条 run 各自建独立 worktree，互不干扰，不用等前一条跑完再触发新的。但**同方案的重复 run 会被创建接口直接拒绝**（409），别对同一份 plan 连发两次。
- **没有 approve/reject/cancel 这类人工门禁命令**：流水线要么全自动跑到底，要么终止为 `failed`。
  环境中断使用 `resume`；审查熔断使用 `supersede` 创建后继 run。
- **复盘自动累积，不用你操心**：每条 run 终态后 harness 会自动把犯过的错提炼进仓库的 `ship.lessons.md`（随后续 PR 进 git），并注入后续 run 的实现/审查上下文。你不需要做任何事，但方案里别去改这个文件。
- `ship ls` 看所有运行、`ship groups` 看所有组、`ship attach <id>` 阻塞到该运行到达终态才返回（在它还在 `running` 时接上能看到实时输出）——这就是"监听完成"的原语，配合你所在环境的后台执行能力用，见上面第 4 步。

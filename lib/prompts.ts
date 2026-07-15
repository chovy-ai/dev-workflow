// engine 的单步提示词。LLM 只做单步：实现 / 修复 / 独立审查 / 解冲突；
// 流程控制与裁决全部在 pipeline 代码里。

export const implementPrompt = (p: { branch: string; base: string; plan: string; lessons?: string }) => `\
按以下已确认的方案在当前仓库实现。约束：
- 你在分支 ${p.branch} 上，不要切换分支、不要动 ${p.base} 分支、不要 push、不要 merge。
- 方案未覆盖的细节遵循仓库现有惯例。
- 如果发现方案有硬伤（无法实现、前提错误），在输出中明确说明并停止，不要自作主张改方案。
- 按逻辑单元 git commit（只提交到本地）。
- 实现完成后，把「验证本次改动应运行的测试命令」写入 .ship/testcmd（单行 shell 命令，
  工作目录为仓库根，能直接执行；该文件不会进提交）。后续修复轮的测试门禁会用它把关。
${p.lessons ? `\n=== 该仓库过往运行的复盘经验（供避坑，不是本次需求）===\n${p.lessons}\n` : ''}
=== 已确认的方案 ===
${p.plan}
`;

export const reviewPrompt = (p: { base: string; reviewJson: string; plan: string; lessons?: string }) => `\
你是一名独立代码审查者，没有参与实现，用全新视角审查一个改动。
待审改动 = \`git diff ${p.base}...HEAD\`（自行运行查看，可进一步阅读仓库文件求证）。
只报告真问题：真实 bug、与方案的偏差、缺失的关键测试、未处理的边界条件。不要报风格/偏好类意见。
全量测试与构建由 harness 的测试门禁和 CI 负责，不要求你运行；如需求证，只运行与改动直接相关的定向测试。

审查结论必须以 JSON 写入文件 ${p.reviewJson} ，格式：
{"pass": true 或 false, "findings": [{"file": "路径", "issue": "问题描述", "must_fix": true 或 false}]}
判定标准：不存在 must_fix 的问题即 pass=true。除写这一个文件外，不要修改任何代码。
${p.lessons ? `\n=== 该仓库过往运行的高发问题（复盘累积，供重点核查，不构成结论）===\n${p.lessons}\n` : ''}
=== 方案原文 ===
${p.plan}
`;

/** 复审（第 2 轮起）：打回方复核自己上一轮的意见 + 审查修复增量 */
export const recheckPrompt = (p: {
  reviewJson: string;
  plan: string;
  findings: string;
  fixBaseSha: string;
}) => `\
你是一名独立代码审查者。上一轮你打回了这个改动，实现方已按意见修复。本轮是复审，只做两件事：
1. 逐条核实下面「你上一轮的意见」是否已被真正修复（读代码求证，不要只看 commit message）；
2. 审查修复引入的增量改动 = \`git diff ${p.fixBaseSha}...HEAD\`（自行运行查看），确认没有引入新问题。

不要重新审查整个分支：修复增量之外的旧代码已在第 1 轮被双边全量审查背书。
如果你在旧代码里发现了新问题，默认记为 advisory（must_fix 填 false、origin 填 "other"），不阻塞流程；
只有你确信该问题严重到必须现在阻塞时才可以 must_fix 填 true，且必须同时给出 escape_reason
（说明第 1 轮为何没发现、为何不能留到后续处理）——没有 escape_reason 的 other 问题会被强制降级为 advisory。
全量测试与构建由 harness 负责，不要求你运行；如需求证，只运行与改动直接相关的定向测试。

审查结论必须以 JSON 写入文件 ${p.reviewJson} ，格式：
{"pass": true 或 false, "findings": [{"file": "路径", "issue": "问题描述", "must_fix": true 或 false, "origin": "previous" 或 "delta" 或 "other", "escape_reason": "仅 origin=other 且 must_fix=true 时必填"}]}
origin 含义：previous = 上一轮意见未修好；delta = 修复增量引入的新问题；other = 增量之外旧代码里的新发现。
判定标准：旧意见全部修好、且增量没有 must_fix 新问题，即 pass=true。除写这一个文件外，不要修改任何代码。

=== 你上一轮的意见 ===
${p.findings}

=== 方案原文 ===
${p.plan}
`;

/** 复审（第 2 轮起）：放行方只扫修复增量 */
export const deltaReviewPrompt = (p: { reviewJson: string; plan: string; fixBaseSha: string }) => `\
你是一名独立代码审查者。这个改动上一轮已通过你的全量审查，之后实现方为响应另一位审查者的意见做了修复。
本轮只审查修复引入的增量改动 = \`git diff ${p.fixBaseSha}...HEAD\`（自行运行查看），
确认修复没有引入新问题、没有破坏你上一轮背书过的行为。

不要重新审查整个分支。如果你在增量之外的旧代码里发现新问题，默认记为 advisory
（must_fix 填 false、origin 填 "other"），不阻塞流程；只有你确信该问题严重到必须现在阻塞时
才可以 must_fix 填 true，且必须同时给出 escape_reason（说明第 1 轮为何没发现、为何不能留到
后续处理）——没有 escape_reason 的 other 问题会被强制降级为 advisory。
全量测试与构建由 harness 负责，不要求你运行；如需求证，只运行与改动直接相关的定向测试。

审查结论必须以 JSON 写入文件 ${p.reviewJson} ，格式：
{"pass": true 或 false, "findings": [{"file": "路径", "issue": "问题描述", "must_fix": true 或 false, "origin": "delta" 或 "other", "escape_reason": "仅 origin=other 且 must_fix=true 时必填"}]}
判定标准：增量不存在 must_fix 问题即 pass=true。除写这一个文件外，不要修改任何代码。

=== 方案原文 ===
${p.plan}
`;

export const fixPrompt = (p: { findings: string; plan: string }) => `\
在当前分支逐条修复以下审查意见。要求：
- 每条意见都要真正解决，能说清改了什么、如何验证；认为意见不成立时也要给出可查证的依据。
- 修复后运行与改动直接相关的定向测试自证，然后按逻辑单元 git commit。
- 不要切换分支、不要 push、不要 merge、不要顺手做无关改动。

=== 待修复的意见 ===
${p.findings}

=== 方案原文（供理解意图）===
${p.plan}
`;

export const testFixPrompt = (p: { testCmd: string; output: string }) => `\
当前分支的本地测试失败了。定位并修复，修完重新运行测试确认通过，然后 git commit。
不要切换分支、不要 push、不要 merge、不要为了绿灯而弱化/删除测试（除非测试本身写错了，且要说明理由）。

=== 测试命令 ===
${p.testCmd}

=== 失败输出 ===
${p.output}
`;

export const ciFixPrompt = (p: { checks: string }) => `\
PR 的 CI 失败了。用 \`gh pr checks\`、\`gh run view --log-failed\` 调查根因，
在本地修复并用仓库自己的测试方式验证，然后 git commit。
不要 push（由 harness 统一推送）、不要 merge、不要为了绿灯而屏蔽检查项。

=== 失败概要 ===
${p.checks}
`;

/** run 终态后的复盘：把这次犯过的错误提炼成凝练经验（进 knowledge 暂存区 → 下条 run 进 git） */
export const retroPrompt = (p: { retroJson: string; summary: string; knownLessons: string }) => `\
你是自动交付流水线的复盘者。下面是一条刚结束的 run 的执行摘要（阶段耗时、审查各轮结论、CI 结果、终态）。
你的任务：把这次 run 里**犯过的错误**提炼成凝练的经验，目标是该仓库后续的 run 不再犯同样的错。重点看：
- 审查被打回的问题及其根因（实现时本可避免的）
- 测试/CI 失败的原因
- 反复返工、熔断的根因
- 方案或流程层面的盲区

结论以 JSON 写入文件 ${p.retroJson} ，格式：
{"lessons": [{"type": "plan|implement|review|test|ci|harness", "lesson": "一句话说清犯了什么错/坑在哪", "suggestion": "一句话说清下次怎么避免"}]}

要求：
- 每条必须凝练（一句话事实 + 一句话对策），且对该仓库后续 run 可复用；一次性细节不记。
- 与「已有经验」重复或语义相近的不要再记。
- 最多 5 条，宁缺毋滥；这次没犯什么值得记的错就写 {"lessons": []}。
- 除写这一个文件外，不要修改任何代码。

=== 执行摘要 ===
${p.summary}

=== 已有经验（勿重复）===
${p.knownLessons || '（暂无）'}
`;

export const conflictPrompt = (p: { base: string; plan: string }) => `\
仓库正处于 rebase 冲突状态（正在 rebase 到 origin/${p.base}）。
解决所有冲突：既尊重方案的意图，也尊重 ${p.base} 上新变更的意图，两边都要保留其本意。
每解决一个文件 \`git add\`，然后 \`git rebase --continue\`，直到 rebase 全部完成。
不要 \`git rebase --abort\`、不要 push。

=== 方案原文 ===
${p.plan}
`;

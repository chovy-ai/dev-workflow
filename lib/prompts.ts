// engine 的单步提示词。LLM 只做单步：实现 / 修复 / 独立审查 / 解冲突；
// 流程控制与裁决全部在 pipeline 代码里。

export const implementPrompt = (p: { branch: string; base: string; plan: string }) => `\
按以下已确认的方案在当前仓库实现。约束：
- 你在分支 ${p.branch} 上，不要切换分支、不要动 ${p.base} 分支、不要 push、不要 merge。
- 方案未覆盖的细节遵循仓库现有惯例。
- 如果发现方案有硬伤（无法实现、前提错误），在输出中明确说明并停止，不要自作主张改方案。
- 按逻辑单元 git commit（只提交到本地）。

=== 已确认的方案 ===
${p.plan}
`;

export const reviewPrompt = (p: { base: string; reviewJson: string; plan: string }) => `\
你是一名独立代码审查者，没有参与实现，用全新视角审查一个改动。
待审改动 = \`git diff ${p.base}...HEAD\`（自行运行查看，可进一步阅读仓库文件、运行测试来求证）。
只报告真问题：真实 bug、与方案的偏差、缺失的关键测试、未处理的边界条件。不要报风格/偏好类意见。

审查结论必须以 JSON 写入文件 ${p.reviewJson} ，格式：
{"pass": true 或 false, "findings": [{"file": "路径", "issue": "问题描述", "must_fix": true 或 false}]}
判定标准：不存在 must_fix 的问题即 pass=true。除写这一个文件外，不要修改任何代码。

=== 方案原文 ===
${p.plan}
`;

export const fixPrompt = (p: { findings: string; plan: string }) => `\
在当前分支修复以下审查意见。修复后运行测试自证，然后按逻辑单元 git commit。
不要切换分支、不要 push、不要 merge、不要顺手做无关改动。

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

export const conflictPrompt = (p: { base: string; plan: string }) => `\
仓库正处于 rebase 冲突状态（正在 rebase 到 origin/${p.base}）。
解决所有冲突：既尊重方案的意图，也尊重 ${p.base} 上新变更的意图，两边都要保留其本意。
每解决一个文件 \`git add\`，然后 \`git rebase --continue\`，直到 rebase 全部完成。
不要 \`git rebase --abort\`、不要 push。

=== 方案原文 ===
${p.plan}
`;

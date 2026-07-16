# 运行详情进度图视图(React Flow)

## 目标/背景

run 详情页目前默认 tab 是全量日志:agent(engine)的每一行输出(engine-line 事件)都直接
铺出来,信息过载;用户实际只需要大概进度 + 核心信息 + 错误信息。且流水线并非纯线性
(双边审查是并行双节点、审查打回/修复/复审是循环、CI 修复也是循环),线性 stepper 表达不了。

本方案把详情页默认视图改为用 React Flow 渲染的流水线进度图,全量日志降级为兜底 tab。
数据完全从既有事件流推导,pipeline.ts 的执行语义与事件产出不做任何改动
(如需要,仅允许对 engine 事件的 label 命名做最小规范化,并保持对旧事件的兼容解析)。

## 改动点

### 1. 依赖

- 新增 `@xyflow/react`(React Flow v12,MIT,支持 React 19),仅用于只读渲染:
  关闭节点拖拽/连线交互,保留缩放平移。不引入 dagre/elk 等布局库,布局手写。

### 2. 图推导纯函数(新文件 lib/progressGraph.ts)

- `deriveGraph(run: RunRecord, events: RunEvent[]): { nodes, edges }`,纯函数、可单测。
- 节点来源与映射:
  - 主干节点来自 STAGES:建 Worktree → 实现 → 双边审查 → 提 PR → CI → 完成;
    `stage` 事件标记进入,下一个 stage 事件或终态标记完成。
  - 双边审查展开为并行子节点:每个 reviewEngine 一个节点(节点上标注 engine 名 +
    reviewRoles 角色,如「claude·架构」「codex·符合性」),由 `engine` 事件
    (kind=review 的 label)与 `review` 事件(round/passed/findings)驱动状态与轮次徽标。
  - 循环子节点:审查修复(fix-rN / fix-rN-rescue)、测试修复(test-fix-N)、
    CI 修复(ci-fix-N)、解冲突(conflicts)、复盘(retro),按 `engine` 事件 label
    前缀归类;同类多轮聚合为一个节点,徽标显示当前轮次/总轮次。
  - 循环用回边表达(审查→修复→回审查;CI→修复→回 CI)。
- 节点状态四态:未到达(灰)/进行中(高亮 + 呼吸动画)/成功(绿)/失败或打回(红),
  附带耗时(由相邻事件 ts 差计算)、review 节点附 findings 计数。
- run.status === 'failed' 时,失败发生处的节点标红,并携带 statusDetail / 最近 error 事件文本。

### 3. 详情页改造(app/page.tsx + app/globals.css)

- tab 顺序改为:**进度(默认)** / 日志 / Diff / 审查发现 / 方案。
- 进度 tab:React Flow 画布渲染 deriveGraph 结果;布局手算固定坐标——主干横向排列,
  审查双节点纵向并排,循环节点挂在对应主干节点下方,回边用贝塞尔边。
- 点击节点打开右侧抽屉(drawer):显示该节点对应步骤的核心信息——步骤名、engine、状态、
  耗时、该 label 的 engine-line 输出**尾部若干行**(如最后 40 行,按 label 过滤既有 lines),
  以及该步骤相关的 error 事件全文。再次点击或点关闭收起。
- 图上方常驻信息条:当前 stage、statusDetail(失败原因)、最近一条 error 事件、
  PR 链接按钮(沿用现有)。现有 failed banner 与「从断点续跑」按钮保留。
- 原「日志」tab 完整保留现状行为(全量 engine-line 滚动 + 自动到底),作为排查兜底。
- 组视图暂不引入图(留给后续「仓库间依赖」方案统一做泳道 DAG),本方案只把组成员表格里的
  阶段列换成迷你横向进度条(复用同一状态色系),视觉与单 run 图一致。

### 4. SSE 降载(app/api/runs/[id]/events/route.ts)

- events 接口支持 `?filter=core`:不推送 engine-line 事件,其余照旧。
- 前端:进度 tab 激活时订阅 core 流;切到日志 tab 时切换为全量流(重放靠现有 after 参数)。
  实现上允许简化为:始终订阅全量、仅渲染层过滤——二选一,以代码简单为准,但接口参数要做。

## 约束

- 不改 pipeline 执行语义、事件类型定义与落盘格式;旧 run 的历史事件必须能正确渲染出图
  (label 解析要容错:识别不了的 label 归入「其他步骤」节点,不许崩)。
- 不引入布局库与状态管理库;React Flow 相关代码集中在独立组件文件,page.tsx 不再膨胀。
- 深浅色下节点状态色对比度可读;图区域必须可缩放平移以适应窄窗口。
- 保持现有 SSE 去重(seq)与 hash 路由机制不变。

## 验收标准

- deriveGraph 有单测覆盖至少四种事件序列:一次通过、审查打回两轮后通过、
  CI 修复循环后合并、中途 failed;断点续跑(resumes>0)的事件流渲染不重复不错乱。
- 打开 running 中的 run,图上节点状态随 SSE 实时推进;done 的 run 全绿,failed 的 run
  在失败节点标红且信息条显示 statusDetail。
- 点击审查节点能看到该 engine 的输出尾部与 findings 计数;点击失败节点能看到 error 全文。
- 日志 tab 行为与现在完全一致;`?filter=core` 的 SSE 流不含 engine-line。
- typecheck 通过;旧 run(改造前产生的 events.ndjson)打开不报错、能出图。

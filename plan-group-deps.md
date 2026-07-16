# 运行组仓库间依赖:awaitDeps 等待与 depBump 更新

## 目标/背景

run group 目前是纯聚合层:组内各仓库完全并行、零耦合(GroupRecord 只有 runIds)。
但真实的多仓库联动常有依赖:例如仓库 lib-x 发布一个共享包,仓库 a、b 依赖它——
三方的**实现可以并行**(a、b 按方案里约定的新 API 先写),但 a、b 在自己的 PR 走
审查/合并之前,必须等 lib-x 的 PR 合并且新版本**发布**后,把依赖版本更新进来再继续。

本方案给组清单引入依赖声明,在下游 run 的流水线中插入两个节点:
awaitDeps(等待上游完成/发布)与 depBump(更新依赖并修适配),
使组成为有依赖边的 DAG,同时无依赖场景的行为保持完全不变。

## 改动点

### 1. 组清单与创建校验(cli/index.ts、app/api/groups/route.ts、lib/runtime.ts)

- 清单 repos 项新增可选字段:
  - `name`:成员标识,声明了 dependsOn 或被依赖时必填;
  - `dependsOn: string[]`:上游成员 name 列表;
  - `publishes: { package: string, check?: string, timeoutMinutes?: number }`:
    该成员合并后会发布的包。`check` 是自定义探测命令(退出码 0 且 stdout 输出版本号即视为
    已发布),缺省用 npm 策略:轮询 `npm view <package> version`,直到版本号相比该组创建时
    记录的基线版本发生变化。`timeoutMinutes` 缺省 30。
- 创建组时(server 侧统一校验,保持原子性):dependsOn 指向不存在的 name、自依赖、
  成环 → 400 并指明成员与原因,一个 run 都不创建。校验通过后把依赖边解析成 run id
  写入下游 `RunRecord.dependsOn`;若上游声明了 publishes,同时在下游 run 上记录
  `awaiting: { runId, package, baselineVersion, check?, timeoutMinutes? }[]`
  (baselineVersion 在创建时探测一次并落盘,探测失败视为无基线、任何可见版本即算发布)。

### 2. 数据模型(lib/types.ts)

- `STAGES` 在 implement 与 autoReview 之间插入 `awaitDeps`
  (阶段判断均按名称进行,旧 run.json 不受数组变化影响)。
- `StepKind` 增加 `depBump`(可通过 stageEngines 路由引擎,默认走主 engine)。
- `RunRecord` 增加 `dependsOn?: string[]`(上游 run id)与上文的 `awaiting?: [...]`。
- web 的 STAGE_LABEL 增加对应中文标签(如「等待上游」);无依赖的 run 不显示该阶段。

### 3. 流水线(lib/pipeline.ts、lib/prompts.ts)

- 新增 stageAwaitDeps,仅当 `run.dependsOn?.length` 时执行,否则整阶段跳过:
  1. 轮询(间隔 30s)所有上游 run 状态:任一上游 `failed` → 本 run 立即 Halt,
     statusDetail 指明卡在哪个上游;全部 `done` 后进入发布探测。
  2. 对每个 awaiting 项执行探测(check 命令或 npm 策略),全部探测到新版本
     (记录具体版本号)→ 阶段完成。超时(timeoutMinutes)→ Halt,statusDetail 写明
     等的是哪个包、基线版本、已等时长。
  3. 事件降噪:进入等待、每个上游 done、探测到版本、超时才发 log 事件;
     常规轮询不发事件(避免刷屏)。
- 新增 depBump 步骤,在 awaitDeps 完成后、autoReview 之前,仅当有 awaiting 项时执行:
  engine prompt 给出「包名 → 探测到的版本」清单,要求把依赖更新到该精确版本、
  安装依赖、修复编译/适配问题;完成后走 autoCommitIfDirty 与现有测试门禁(gateTests)。
  这样双边审查覆盖的是含依赖更新的最终代码。
- 断点续跑天然兼容:stage=awaitDeps 持久化在 run.json,server 重启或手动 resume 后
  从等待处继续;超时 failed 的 run 在人工确认发布后 resume 即从探测处继续。

### 4. web 展示(app/page.tsx)

- 单 run 视图:stepper/进度图中体现「等待上游」节点,展示等待详情
  (等哪个包、基线版本 → 已探测到的版本、已等时长);depBump 归入实现类步骤展示。
- 组视图:成员表格增加「依赖」列(显示上游成员名);若进度图方案已合并,
  组视图升级为泳道 DAG——每仓库一条泳道,依赖边从上游「完成」节点连到下游
  「等待上游」节点。若进度图方案尚未合并,本方案只做表格列,不阻塞。

## 约束

- 无 dependsOn 的 run(含全部存量单仓 run)行为与事件序列完全不变;
  组的「纯聚合、成员并行」语义对无依赖成员保持不变。
- 不引入跨 run 的进程内耦合:下游只通过 store 读上游 run 状态,不直接调用上游对象;
  组状态推导(deriveGroupStatus)规则不变。
- 探测命令在下游仓库目录执行,不写任何文件;探测失败按未发布处理并继续轮询,不 Halt
  (只有超时才 Halt)。
- 不改 GroupRecord 结构(依赖边存在 RunRecord 上,组保持聚合层)。

## 验收标准

- 清单含 dependsOn 成环 / 指向未知 name / 自依赖时,创建整组失败返回 400 且指明原因。
- 三仓库场景(lib-x 被 a、b 依赖):a、b 与 lib-x 的 implement 并行推进;
  a、b 在 awaitDeps 停住;lib-x 合并且探测到新版本后,a、b 自动执行 depBump
  (依赖更新到探测版本的提交进入分支)、通过测试门禁后继续双边审查直至合并。
- 上游 failed 时下游在等待处 failed 且 statusDetail 指明上游;上游经后继 run 完成后,
  下游 resume 能继续。
- 等待超时 failed;resume 后从探测处继续而非重跑 implement。
- 上游无 publishes 时,下游只等其 done、跳过 depBump。
- 有单测覆盖:依赖校验(环/未知名)、npm 版本比对逻辑、awaitDeps 状态机
  (上游失败/超时/正常放行)。typecheck 通过;无依赖组的既有行为回归不变。

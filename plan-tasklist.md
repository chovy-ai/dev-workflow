# 任务列表分区排序与一键归档

## 目标/背景

web 侧边栏目前只有「组 + 散 run」两坨,统一按 createdAt 倒序,且 run/group 没有归档概念,
所有历史运行永远堆在列表里。导致:新增任务不易识别(新活动不会浮上来)、无法区分
「要管的」(failed)和「不用管的」(done),列表随使用无限膨胀。

本方案给 run/group 加归档能力,并把侧边栏重构为按状态分区、区内按最近活动排序的结构。

## 改动点

### 1. 数据模型(lib/types.ts)

- `RunRecord` 增加可选字段 `archivedAt?: string`(ISO 时间,存在即视为已归档)。
- `GroupRecord` 增加可选字段 `archivedAt?: string`。
- 旧记录没有该字段,语义为未归档,无需迁移。

### 2. API(app/api/ 下)

- `POST /api/runs/[id]/archive`:body `{ archived: boolean }`,true 置 `archivedAt` 为当前时间,
  false 清除该字段(还原)。目标 run `status === 'running'` 时拒绝(400,说明进行中不可归档);
  failed / done 均可归档。
- `POST /api/groups/[id]/archive`:同上语义作用于组,且级联作用于全部成员 run
  (组归档 = 组和所有非 running 成员一起归档;若有成员 running 则整组拒绝 400)。
- `POST /api/runs/archive-done`:一键归档——把所有 `status === 'done'` 且未归档的散 run,
  以及推导状态为 done 且未归档的组(连同其成员)全部归档,返回归档数量 `{ runs, groups }`。
  failed 不纳入一键归档(需要人看过再手动归档)。
- `GET /api/runs`、`GET /api/groups`:默认过滤掉已归档项;带查询参数 `?archived=1` 时只返回已归档项。
  组的过滤以组自身 `archivedAt` 为准;散 run 以 run 自身为准。
- Store 不改动持久化布局,归档字段随 run.json / group.json 落盘即可。

### 3. 侧边栏重构(app/page.tsx + app/globals.css)

- 取代现在「组块 + 散 run 平铺」的结构,改为四个状态分区,自上而下:
  1. **进行中**(running)
  2. **需要处理**(failed,视觉上红色强调——这是唯一需要人介入的分区)
  3. **已完成**(done 且未归档,分区头带「全部归档」按钮,点击调 archive-done 后刷新)
  4. **已归档**(默认折叠;展开时才请求 `?archived=1` 数据,懒加载)
- 组作为一个条目按组推导状态归入对应分区,条目内仍可展开成员 run(沿用现有 group-member 交互);
  散 run 直接归入分区。
- 每个分区内按 `updatedAt` 倒序(最近有活动的在最上面);组用成员 run 的最大 updatedAt。
- 条目显示:标题、状态徽标、仓库目录名标签、相对时间(如「3 分钟前」「昨天」,
  超过 7 天显示日期)。相对时间用纯函数从 updatedAt 计算,随现有 5s 轮询自然刷新。
- done / failed 条目 hover 时出现「归档」小按钮;已归档分区里的条目出现「还原」按钮。
- 空分区不渲染分区头(全空时保留现有的空列表引导文案)。

### 4. CLI(cli/index.ts)

- `ship ls` / `ship groups` 默认不列已归档项,加 `--archived` 开关列出已归档项。
- 新增 `ship archive <run-id|group-id>`(自动识别 id 属于 run 还是 group)与
  `ship archive --done`(等价 archive-done)。

## 约束

- 不改 pipeline.ts 的任何执行语义;归档是纯展示/管理层概念,不影响断点续跑
  (resume 一个已归档的 failed run 应先自动取消归档再续跑)。
- 不引入新依赖;不改 SHIP_HOME 持久化目录布局。
- API 响应结构保持向后兼容:GET /api/runs 仍返回 RunRecord 数组,只是默认过滤。
- 遵循仓库现有代码风格:中文注释、单文件组件、无状态管理库。

## 验收标准

- 归档 running run 返回 400;归档 done/failed run 后,GET /api/runs 默认不再包含它,
  `?archived=1` 包含它;还原后回到默认列表。
- 组归档级联全部成员;含 running 成员的组归档返回 400。
- archive-done 只归档 done(散 run 与全 done 的组),failed 不动,返回准确计数。
- 侧边栏按四分区展示,分区内 updatedAt 倒序;新触发的 run 出现在「进行中」顶部;
  失败的 run 出现在「需要处理」并有红色强调;「全部归档」一键清空「已完成」分区。
- 已归档分区默认折叠且不发请求,展开后能看到并可还原。
- `ship ls` 默认不含已归档,`--archived` 可见;`ship archive` 两种形态可用。
- 有针对 API 过滤/级联/400 规则的测试;typecheck 通过。

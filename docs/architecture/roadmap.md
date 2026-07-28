# Symphony架构实施Roadmap

状态：目标架构实施顺序。本文定义可验收增量，不声明当前实现已满足目标，也不提供旧持久化设计的迁移或兼容路径。

## 1. 实施原则

1. [Workflow Authority与恢复](workflow-authority-recovery.md)是native Linear + Git recovery的唯一规格。
2. 每个功能点只有一个named concern owner；其他文档、代码注释和测试只引用。
3. Conductor保持deterministic；Root Reconciler是唯一model-driven next-step role。
4. 每个增量都能从fresh current Linear/Git facts收敛，不依赖旧command或process memory。
5. 删除旧surface和实现replacement属于同一次hard cut；不加dual-read、adapter、flag、backfill或fallback。
6. 每个实现slice先写失败测试，并在真实cross-process/Linear/Git边界提供证据。

## 2. R0：Native object graph与contracts

- Podium-Conductor支持完整active/archived Root object graph分页；
- snapshot覆盖Issues、statuses、labels、parents、relations、archive、comments、threads、reactions、attachments和Activity；
- Linear mutation只暴露bounded native commands与fresh semantic read-back；
- Conductor-Performer定义RootNextAction和Plan/Work/Verify transient typed contracts；
- transport JSON不进入Linear content；
- 删除comment/description machine payload parser、writer和schema。

## 3. R1：Root discovery、process fencing与recovery host

- 未delegate Root零副作用；
- Project header discovery与完整graph读取分层；
- Root使用唯一native routing label；Host保证每Binding一个live process，Conductor只使用进程内iteration guard；
- 每次Root iteration先执行worktree gate；
- 实现normal state convergence、`In Progress -> Interrupted`和terminal no-dispatch；
- 实现worktree missing时的Git-authority判断：branch可验证则rematerialize，Git execution facts无效才fresh rebuild；
- Conductor中不存在model、Agent SDK、workflow DB、queue、checkpoint或command log。

## 4. R2：Root Reconciler与Human comments

- 每Root一个Reconciler thread，fresh session完整bootstrap，live session可用delta；
- session/delta/digest只在runtime，baseline丢失直接fresh-open；
- Root Reconciler每turn返回one bounded RootNextAction；
- Conductor把action收敛为native Linear/Git facts后丢弃transport object；
- Human Action硬切为Root native comment threads，无JSON；
- ordinary human comments使用native reply/check/cross receipt；
- requirement-changing answer在thread resolve前进入Root description；
- 删除Root/Cycle event stream、publisher和subscriber。

## 5. R3：Plan、Work、Verify native materialization

- 每Cycle创建隔离Plan、Work、Verify threads；Work thread跨多个Work Issues复用；
- Plan/Verify read-only，Work仅获matching worktree-write capability；
- Work-only agent tree使用独立session containment、bounded recursive collaboration、tree-wide limits、mechanical write grants与
  irreversible turn-epoch retirement；
- Plan Result渲染为Plan description与status，approval使用Root Human Action thread；
- Work Result转成Work status、Git/check evidence和必要comment；
- Verify Result转成Verify status/conclusion label、native Finding Issues和Git evidence；
- Stage process loss使attempt terminal/interrupted，fresh successor使用new Issue identity；
- actual model/usage只进入sanitized logs/metrics，不写Linear。

## 6. R4：DAG、convergence与worktree generations

- initial DAG只使用native Issue IDs、kind labels、parent和relations；
- approved Plan immutable；replan创建fresh Plan并supersede旧Plan；
- retry/rerun创建fresh Issue和predecessor/replacement relation，不重开terminal Issue；
- attempts、progress和limits从native tree/timestamps/current policy推导；
- worktree和required Git execution facts都不可恢复时归档旧execution descendants，fresh branch/worktree和fresh Cycle从
  Root Reconstruction Set开始；
- old approvals、Done nodes和Git branch不为fresh generation提供authority。

## 7. R5：Git与delivery

- 一个active Root一个deterministic branch/worktree；
- Work不commit，Conductor独占commit/push/PR/cleanup；
- Verify绑定immutable revision；内容变化要求fresh Verify；
- delivery由Git/SCM read-back、native PR attachment/relation和Root `In Review`表达；
- 删除delivery payload/receipt和internal completion comment。

## 8. R6：Hard-cut inventory与架构审计

审计production code、contracts、generated bindings、tests、fixtures和docs，要求以下retired surfaces零reachable reference：

- projected Root/Cycle comment stream；
- comment/description machine JSON；
- ownership/next-action/result/execution/usage/delivery/failure persisted objects；
- local workflow state、replay cursor或Provider pointer；
- 把Human Action建成descendant Issue的替代模型；
- legacy parser、writer、compatibility fixture或dual path。

每个finding是独立修复项，标明唯一architecture owner、删除范围、acceptance和verification。不得用allowlist、baseline或waiver
保留reachable旧路径。

## 9. R7：真实边界验收

- 使用真实Linear Project、Podium SDK boundary、Git repository和Performer process；
- 至少三个Conductor实例并发启动，以唯一routing、Host process fencing和fresh mutation precondition证明同Root single writer
  domain；Work tree内部协作不创建第二个domain；
- 独立E2E Human Actor只通过Linear公开surface操作；
- all-settled后丢弃poll cache，fresh-read Linear/Git Final Evidence Snapshot；
- 验证normal restart不重跑Done，process loss创建fresh successor；
- 验证missing worktree在Git完整时rematerialize、Git execution authority无效时才触发fresh generation；
- 验证Plan approval、information answer、rejection和Finding waiver不丢失且不跨target继承；
- 验证Linear中没有机器JSON或自动event comments。

完整Case topology和verdict只由[并行黑盒端到端验收](black-box-e2e.md)定义。

## 10. Final acceptance

1. 完整native Root object graph与Git足以从cold restart推导current state。
2. `Todo`是唯一dispatchable Node；所有terminal attempts保持不可重跑。
3. worktree存在或可从valid branch重建时保留current tasks；Git execution facts也无效时new identities组成fresh task tree。
4. Human confirmations保存在Root threads/Activity和materialized Root/target facts；Root requirement重建不丢信息。
5. Stage/Root transport results不落盘，native postconditionsfresh read-back后才推进。
6. Linear可见内容只包含用户需求、计划、任务、Findings、直接交互和有意义结论。
7. hard-cut inventory无retired reachable surface；没有compatibility code。
8. 全部mandatory black-box Cases通过。

## 11. 明确延期

- 第二Provider；
- 同一Root多个active Cycles或并行workspace writers；
- durable Provider transcript、vector memory或workflow database；
- Desktop Workflow、Root/Stage/Human Action View或approval control；
- 精确cross-restart token/cost accounting。

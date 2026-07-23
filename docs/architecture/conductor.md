# Conductor无数据库Root调度、Cycle Policy与Linear DAG Execution设计

状态：目标架构提案。Conductor通过自己的Conductor Project Label解析Resolved Conductor Project，
再通过Root Conductor Label只调度路由给自己的Root；它没有
Workflow数据库、DAG镜像、durable Queue或checkpoint。

## 1. 职责

Conductor负责：

- 通过`LinearGatewayInterface`解析Project Conductor Pool、过滤Root routing并按需读取完整Cycle Tree；
- 从Root、Cycle/node markers、comments、relations和Git重建可丢弃`RootDagView`；
- 验证Team workflow status catalog和每类Issue允许的status/transition；
- 判断Root是runnable、waiting human、needs attention还是terminal；
- 按blocker、Linear Priority、Root order和identifier选择一个Root；
- 使用`RootWorkflowPolicyInterface`从fresh DAG/Git派生一个业务decision；
- 使用`LinearDagExecutionInterface`执行一个ready Plan、Work或Verify Node；
- 构造closed `StageContextEnvelope`、创建caller-owned StageWire并调用Performer；
- 在node claim、Result materialization和delivery前验证remote/Git precondition并read-back；
- 维护Root deterministic branch/worktree、commit和delivery；
- 保存Performer Profiles，并把错误、Human action、Cycle和delivery投影到Linear/Desktop。

Conductor不负责：

- Linear OAuth、Token、SDK或GraphQL；
- Provider SDK、Codex-owned文件或Provider transcript；
- 保存current Cycle、current node、ready Queue、accepted Result或Provider thread；
- 在本地保存Workflow DB、DAG、dispatch、convergence gate、attempt或checkpoint；
- 自动merge target branch。

## 2. 两层Workflow设计

### 2.1 Root Workflow Policy

上层是纯业务Policy：

```text
RootWorkflowPolicyInterface
  assess(root_dag_view, git_view) -> RootWorkflowDecision
```

它先从Linear全Root历史计算convergence gate，再判断：创建初始Cycle、等待Human、执行一个ready node、
创建successor Cycle、delivery、等待In Review、terminal或needs attention。它不调用Performer、不更新Linear、
不保存上次decision。

### 2.2 Linear DAG Execution

低层执行上层明确选择的node：

```text
LinearDagExecutionInterface
  executePlan(node, input) -> PlanStageOutcome
  executeWork(node, input) -> WorkStageOutcome
  executeVerify(node, input) -> VerifyStageOutcome
```

低层验证Cycle bootstrap/approved Plan Contract和ready条件，构造matching StageContext、写Stage execution marker、启动Performer、materialize accepted Result
并read-back。它不能创建successor Cycle、决定Root delivery或把runtime failure解释成Verify changes。

两层完整语义只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

## 3. 模块

```text
apps/conductor/src/
  main.ts
  composition/
  linear-gateway/
  root-discovery/
  root-scheduling/
  root-workflow/
  linear-dag/
  performer-profiles/
  performer-stage-client/
  git-workspaces/
  root-delivery/
  runtime-reporting/
  private-ipc/
```

| 模块 | 职责 | 关键接口 |
|---|---|---|
| `linear-gateway` | Podium private protocol adapter | `LinearGatewayInterface` |
| `root-discovery` | Project解析、Root发现、blocker和ownership | `LinearGatewayInterface` |
| `root-scheduling` | 跨Root readiness、Priority和Root order | `RootSchedulingPolicyInterface` |
| `root-workflow` | 从fresh Cycle DAG/Git派生业务decision | `RootWorkflowPolicyInterface` |
| `linear-dag` | validate/reconcile DAG并执行selected typed node | `LinearDagExecutionInterface` |
| `performer-profiles` | Profile store、active选择和SDK login/status control | `PerformerProfileStoreInterface`、`PerformerProfileControlInterface` |
| `performer-stage-client` | StageContext/Result transport | `PerformerStageClientInterface` |
| `git-workspaces` | deterministic branch/worktree、safe commit/checks | `GitWorkspaceInterface` |
| `root-delivery` | push并交付PR、remote branch或local branch | `RootDeliveryInterface` |
| `runtime-reporting` | 脱敏日志、usage和Desktop views | `ConductorRuntimeReporterInterface` |

`root-workflow`不能import Performer client；`linear-dag`不能决定successor Cycle或delivery。composition层的
`ReconcileRootUseCase`按上层decision调用matching mutation或低层execution。

## 4. 可重建View

```text
RootDagView
  root_issue
  root_routing
  resolved_conductor_project
  root_primary_status_comment
  pending_human_action?
  ordered_cycles[]
    cycle_issue
    plan_contract_digest?
    plan_node
    work_nodes[]
    verify_node?
    dependency_edges[]
    managed_outcomes[]
    cycle_state
    findings[]
    progress_assessment?
  convergence_policy
  convergence_view
  blocker_relations
  performer_profile
  git_workspace
  delivery
```

`RootDagView`是一次reconciliation的内存组合，不持久化。Root/Cycle/Node status、Finding、attempt、token reservation和
progress来自Linear；branch、commit、diff和PR来自Git/SCM。View不能包含本地cursor、Queue entry或next
action directive，任何字段丢失都必须通过fresh read重建。

## 5. Watch与主循环

Conductor以同一个reconciliation入口处理startup、webhook wake-up和periodic poll：

```text
startup:
  resolve Binding/Profile/Project
  immediately reconcile once
  start webhook observation and periodic poll

on wake-up or poll:
  discover ordered Root headers and validate Root routing
  discard Roots routed to another pool member
  for each candidate Root:
    view = fresh read complete Cycle Tree + Git
    assessment = rootWorkflowPolicy.assess(view, git) including convergence gate
    if assessment is runnable:
      selected = fresh read Root DAG + Git again
      decision = rootWorkflowPolicy.assess(selected, git)
      ReconcileRootUseCase performs at most one bounded decision
      fresh read-back
      break
  discard all views and decisions
```

Webhook只唤醒，不是业务Event或Queue message；lost/duplicate/reordered webhook由periodic poll和幂等marker
收敛。启动后的首次reconciliation不能等待第一个poll interval。

没有background business Queue。waiting Human的Root释放Agent lane，其他Root可以运行。poll interval、
rate-limit backoff和runtime capacity只影响何时再次读取，不改变Linear Priority、Root order或DAG readiness。

## 6. Root readiness与调度

```text
RootDispatchAssessment
  readiness: runnable | waiting_human | needs_attention | terminal
  sanitized_reason?
```

- `runnable`：Root ownership/Profile/Tree/Git有效，且上层Policy可派生bounded decision；
- `waiting_human`：Root自身为`Needs Approval`或`Needs Info`且matching action有效；
- `needs_attention`：ownership、status catalog、Cycle DAG、Profile、Linear marker或Git事实冲突；
- `terminal`：Root Done/Canceled，或In Review且没有review change trigger。

Cycle或Stage node不得进入Needs Approval/Needs Info。问题消失后下一次fresh assessment自然恢复，不需要
local resume command。

Project Conductor Pool只声明成员资格，Root Conductor Label只声明路由，Root Primary Status Comment
才是已claim后的durable ownership。Conductor只能claim路由给自己的Root，并在每次Cycle/Node mutation、
Stage dispatch、Result materialization和delivery前fresh验证以下事实：自己的Project Label仍在pool、Root
恰有一个匹配自己的routing Label、Root Primary ownership为空或匹配自己的full `conductor_id`。任一事实
变化都使Root进入`needs_attention`并终止active Stage Wire；不得自动接管或热迁移。

## 7. DAG node claim与Stage execution

在调用Performer前，Conductor必须：

1. fresh读取Root、Cycle和selected node；
2. 验证kind、parent、dependencies、custom status、managed marker、Root convergence gate和Git baseline；
3. 构造matching `StageContextEnvelope`和digest，但尚不调用Performer；
4. 把完整source manifest、coverage、context digest、deadline与包含token reservation的limits写入
   `StageExecutionComment`，并按规则更新Cycle/node status；
5. semantic read-back；
6. 创建StageWire并调用Performer。

Result返回后，低层重新读取scope/precondition并materialize。旧execution Result、stale digest、Root terminal、
node被用户移动或Git HEAD冲突时一律拒绝。

Stage execution identity、reservation和terminal outcome在Linear而不在本地dispatch table；attempt数由
matching execution records派生。process crash后新generation不会恢复旧process；它从Linear/Git重建Root级
cycle/open Finding persistence/no-progress/token/deadline gate，再决定是否为同一node创建fresh execution。
普通progress和tool heartbeat始终只是runtime
observation。

## 8. Git与delivery

一个Root固定一个branch和worktree，所有Cycles复用它。Work Performer可以修改文件并运行工具，但commit、
Git topology和delivery只由Conductor执行。

Conductor提交Work Result时检查Root/Cycle/node scope、Git HEAD和worktree，并生成stable commit identity。
Delivery只接受最新Cycle status `Succeeded`、matching passed Verify Result和verified
HEAD；然后创建或复用PR/branch。

Verify dispatch前，Conductor把Root contract、Cycle Plan、Work evidence、历史open Findings、baseline、
target commit和verification methods封装为immutable input并写Linear。Result与target revision不匹配时拒绝，
不能验证仍在变化的worktree。

Verify `changes_required`不reset或clean worktree。上层Policy先持久化structured Findings与progress，再过
Root convergence gate并按耦合关系形成repair group；新Plan读取Root goal、previous Plan、当前Git diff、
Verify evidence、完整unresolved Findings和attempted approaches。`Inconclusive`留在当前Cycle并有界retry，
`Escalated`必须匹配Root Human action。

## 9. Human action

Plan approval和Stage input/approval全部写Root Pending Human Action并把Root置对应custom state。Cycle/node
只保存target identity和resolved projection，不拥有waiting state。Conductor在Root state、action comment、
answer/decision和target projection全部read-back后才重新执行fresh Stage。

## 10. 重启与单generation

Conductor启动顺序：

1. 读取Binding和Profile配置；
2. 验证当前Conductor generation唯一；
3. 连接Podium private channel；
4. 解析Conductor Project Label和完整Project Conductor Pool；
5. 立即执行一次完整Root discovery/reconciliation；
6. 启动webhook observation和periodic poll；
7. 每次dispatch前fresh读取selected Root DAG和Git。

Conductor不恢复旧snapshot、decision、Wire、process或Result。若旧generation未退出，Host
不得启动同一Binding的第二实例；没有DB不等于允许同一身份双控制器。一个Project可以运行多个不同Binding，
但每个Root通过Root Conductor Label和full ownership只允许一个writer。Cycle/node create使用deterministic key和semantic read-back；发现
duplicate key时停止该Root mutation并进入attention，不能任选一份继续。

## 11. 错误与可见性

同一错误进入structured log、Root Timeline/Primary status、Desktop Root Detail和Attention Item。原因必须
脱敏、稳定、可执行。Cycle create/terminal、Plan approval、terminal Stage error、Verify findings和delivery
进入Linear；heartbeat、tool progress和普通Stage observation只进入Event/Desktop。

activity Label是best-effort投影。写Label失败不能改变Root assessment；Linear/Git事实修复后，下一轮自然
恢复，不需要本地operation状态。

## 12. 接口命名

```text
LinearGatewayInterface           <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface    <- LinearPriorityRootSchedulingPolicyImpl
RootWorkflowPolicyInterface      <- LinearCycleRootWorkflowPolicyImpl
LinearDagExecutionInterface      <- LinearDagExecutionImpl
PerformerProfileStoreInterface   <- FilePerformerProfileStoreImpl
PerformerProfileControlInterface <- SubprocessPerformerProfileControlImpl
PerformerStageClientInterface    <- ShortProcessPerformerStageClientImpl
GitWorkspaceInterface            <- NativeGitWorkspaceImpl
RootDeliveryInterface            <- GitRootDeliveryImpl
ConductorRuntimeReporterInterface <- PodiumConductorRuntimeReporterImpl
```

## 13. 不变量

1. Conductor按Root排序，上层从fresh Linear status/Cycle DAG/Git派生一个业务decision。
2. Cycle bootstrap、approved Plan Contract、DAG、Finding、convergence和Stage execution facts全部落Linear；
   Conductor没有镜像DAG或Workflow DB。
3. 低层一次只执行一个明确selected Plan、Work或Verify Node。
4. Work dependency由Linear relation表达，Conductor不保存ready Queue。
5. Root是Needs Approval和Needs Info的唯一state owner；Cycle和Node使用各自允许的custom status子集。
6. Verify changes_required必须引用与固定artifact绑定的structured findings；repair grouping按耦合关系，
   inconclusive/runtime failure不创建Cycle，escalation等待Root。
7. 每个Stage使用fresh Provider context，不持久化conversation pointer。
8. Linear SDK只在Podium，Provider SDK只在Performer。
9. 一个Root一个worktree，当前同时最多一个writer。
10. startup立即reconcile，webhook只唤醒，periodic poll补漏。
11. Result/Event/process exit不能替代Linear/Git read-back。
12. Work只在matching nodes/relations完整物化、Plan批准且predecessor Node均为Done并有completion evidence后ready。
13. Stage execution identity、token reservation和terminal outcome是Linear事实，attempt数由execution records派生；
    普通runtime progress和process handle可丢弃。
14. 每个Root同时最多一个active Cycle。
15. Root convergence gate统计完整Root历史，创建successor Cycle不会重置cycle、open Finding
    persistence或no-progress计数。
16. Conductor不为sub-agent或跨Stage memory建立控制面。
17. Plan是bootstrap node；只有引用approved `plan_contract_digest`的exact graph read-back后Cycle才可
    Sealed和调度。

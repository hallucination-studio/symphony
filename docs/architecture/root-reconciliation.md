# Root Reconciliation Loop

状态：目标架构提案。本文是Conductor如何跨Cycle、跨重启推进一个Root的唯一事实源。Cycle内需要
模型判断的Plan、Work、Verify调度只由[Cycle Supervisor](cycle-supervisor.md)定义；三个执行角色的
request/result contract只由[Performer Stage Contracts](stage-orchestration.md)定义。Root用户可见时间轴只由
[Workflow Timeline](workflow-timeline.md)定义。

## 1. 决定

Root Reconciliation Loop是Conductor中的确定性控制循环，不调用模型，不包含Agent SDK，也不解释
Plan、Work或Verify的自然语言结果。它反复读取Linear/Git权威事实，执行一个有界mutation或一次明确的
Performer调用，然后read-back并丢弃本轮派生状态。

```text
wake
-> read fresh Root Tree, including archived Cycle children
-> read fresh Git facts
-> validate ownership, workflow catalog and convergence gates
-> derive one mechanical Root action
-> when Cycle semantics are required, call the current Cycle Supervisor
-> validate and materialize one accepted directive or Stage Result
-> semantic read-back
-> discard the transient view
```

Root Loop存在于Conductor process lifetime中，但它没有durable cursor、Queue、checkpoint、conversation或
Workflow数据库。重启后从Linear/Git执行同一个入口。

## 2. 与Cycle Supervisor的区别

| 维度 | Root Reconciliation Loop | Cycle Supervisor |
|---|---|---|
| owner | Conductor TypeScript | Performer Python |
| 是否调用模型 | 否 | 是 |
| 时间范围 | 整个Root、全部Cycles、跨重启 | 一个Cycle |
| 输入 | 完整Root Tree、Git、ownership和Root policy | 当前完整Cycle Tree、Stage Results、Human Actions和Git facts |
| 决策性质 | mechanical gate与materialization | semantic next-step decision |
| durable authority | Linear/Git | 无；只返回proposal |
| Provider thread | 无 | 每个Cycle一个独立Supervisor thread |

Root Loop不能根据错误文本自行决定重试、调整DAG、创建Cycle级Human Action或进入Verify。这些语义选择
必须来自matching Cycle Supervisor directive。Supervisor不能创建Issue、更新Linear、操作Git topology或
绕过Root gate；这些副作用只由Conductor执行。

## 3. 输入与可重建View

```text
RootReconciliationView
  root_issue
  root_routing
  root_ownership
  performer_profile
  ordered_cycles[]
    cycle_issue
    is_archived
    terminal_outcome?
    complete_cycle_tree
  root_human_actions[]
  blocker_relations[]
  convergence_policy
  convergence_view
  git_workspace
  delivery
```

Linear原生`archive` flag是Cycle Tree结构成员资格的权威事实。Root读取必须显式包含archived Issues；不能因
Linear默认查询省略它们。archived Cycle或Node不参与active readiness，但仍参与历史Cycle计数、Finding
persistence、attempt、budget、审计和Supervisor恢复输入。

## 4. Root状态机动作

每次reconciliation最多执行一个下列动作：

```text
RootAction =
  | claim_root
  | create_initial_cycle
  | open_cycle_supervisor
  | advance_cycle_supervisor
  | materialize_cycle_directive
  | execute_plan_turn
  | execute_work_turn
  | execute_verify_turn
  | reconcile_human_action_resolution
  | create_successor_cycle
  | apply_convergence_breaker
  | deliver_root
  | wait
  | mark_attention
```

`RootAction`是Conductor内部派生值，不进入公共wire，也不成为durable Queue。凡是会改变Linear或Git的动作
都必须携带fresh remote precondition、stable write ID并执行semantic read-back。read-back完成后发布closed
Root Timeline event；Root业务模块不直接拼接comment。

## 5. 主流程

### 5.1 创建与启动Cycle

```text
Root Todo/In Progress with no active Cycle
-> validate Root convergence gate
-> create initial or successor Cycle
-> read back parent, marker, status and archive=false
-> open one Supervisor session in Performer
-> send the complete Cycle observation
```

一个Root同时最多有一个nonterminal、nonarchived Cycle。重复Cycle key、多个active Cycle或无法完整读取
archived历史时进入`needs_attention`，不能任选一个继续。

### 5.2 推进Cycle

```text
fresh Cycle Tree has no unmaterialized accepted directive
-> call Cycle Supervisor with full current facts
-> validate returned CycleDirective against its observed_tree_digest
-> persist the accepted directive record
-> materialize exactly one directive
-> read back
```

若directive要求执行Plan、Work或Verify，Conductor构造matching强类型request并调用对应Performer thread。
Stage Result先被验证、持久化和read-back；下一次Root reconciliation再把更新后的完整Tree交给Supervisor。
Conductor不能把Result直接映射为下一个Stage。

### 5.3 Human等待

Cycle级Human Action只能由accepted `request_human_action` directive产生。Conductor创建Action、relations和
managed marker并read-back后，把Root投影到matching waiting状态并释放runtime capacity。用户修改Action
status或comment只会wake Root Loop；Conductor验证并持久化resolution，再把完整Action及resolution作为下一次
Supervisor observation。Root级机械convergence action仍由Root gate创建，语义由
[Human Action](human-actions.md)定义。

### 5.4 Cycle terminal与successor

Supervisor只能提出Cycle terminal conclusion；Conductor验证budget、required Result、Git revision和状态前置
条件后才materialize：

```text
succeeded
-> persist Cycle outcome
-> close Cycle sessions
-> delivery preconditions satisfied ? deliver : Root In Review

repair_required | exhausted
-> persist Findings, attempts, progress and Cycle outcome
-> close Cycle sessions
-> apply Root convergence gate
-> gate allows ? create successor Cycle : create Root convergence Human Action

canceled
-> close Cycle sessions
-> honor authoritative Root/Cycle cancellation
```

Cycle预算耗尽只结束当前Cycle。只有Root级cycle、token、deadline、same-finding或no-progress gate触发时才
升级给用户；successor Cycle不会重置任何Root convergence计数。

## 6. Conductor到Performer方向

所有调用始终由Conductor发起：

```text
Conductor -> openSupervisor(request)       -> Performer
Conductor <- SupervisorOpened(result)      <- Performer

Conductor -> advanceSupervisor(observation)-> Performer
Conductor <- CycleDirective                <- Performer

Conductor -> executePlan|Work|Verify(request) -> Performer
Conductor <- Plan|Work|VerifyResult           <- Performer
```

response和event不是Performer反向调用。Performer不能连接Conductor endpoint、调用Linear、执行workflow
mutation或要求Conductor执行任意callback。需要workflow副作用时只能返回closed proposal，等待Conductor下一次
主动调用。

## 7. Restart与session丢失

Supervisor、Plan、Work和Verify thread是Performer runtime continuity，不是Workflow authority。Conductor可以在
内存中持有opaque Symphony session handle，但不能持久化Provider thread ID或transcript。

```text
Performer/session仍存活
-> Conductor在matching role thread上继续turn

process、connection或thread丢失
-> 丢弃runtime handle
-> 从完整Linear/Git facts打开fresh matching thread
-> 已接受directive、Result和mutation不会重放
```

每次调用都携带当前Tree digest、source versions和上一个accepted decision/result identity。旧thread返回的
stale output在materialization前被拒绝。

## 8. 不变量

1. Root Reconciliation Loop不调用模型，不依赖Agent SDK。
2. Root Loop是Conductor唯一Root/Cycle lifecycle writer。
3. Cycle下一步语义只来自当前Cycle Supervisor的closed directive。
4. Conductor每轮最多执行一个bounded call或一个durable mutation。
5. Linear/Git是恢复authority；Provider thread和Conductor view都可丢弃。
6. archived Issues必须被读取，不能参与active DAG readiness但不能从历史事实中消失。
7. Cycle耗尽先经过Root convergence gate；不会机械升级给用户。
8. Performer从不反向调用Conductor。

# Symphony目标架构总览

状态：目标架构提案。本文定义Linear-authoritative、Conductor无Workflow数据库的目标架构；不代表
当前实现已经匹配，也不包含迁移计划。

## 1. 核心结论

Symphony是一个产品，由Podium Desktop、Podium、Conductor和Performer四个职责组成：

```text
Podium Desktop
  -> Podium TypeScript library
     -> Linear OAuth / Token / Project catalog / Conductor Bindings
     -> LinearGatewayProtocolHandlerImpl -> LinearSdkImpl

Conductor TypeScript daemon
  -> resolve Project and read Linear through LinearGatewayInterface
  -> discover and schedule Root Issues
  -> AgentSymphonyHarnessInterface
     -> build one Root context and scoped command broker
     -> open/resume one Root Conversation
     -> launch one bounded Performer Root Turn
  -> one deterministic Git worktree and delivery per Root

Performer Python process per bootstrap/Turn
  -> ProviderBackendInterface -> CodexBackendImpl
  -> opaque Provider Conversation
```

目标架构不变量：

- Linear Issue Tree是Workflow authority，Git是code/delivery authority；
- Conductor不保存Workflow DB、Root Queue、Leaf dispatch、attempt、checkpoint或mirrored Issue state；
- Root是唯一调度、Conversation和retry单元；
- Leaf只是Root内部Linear可见工作结构，不对应独立Conversation或恢复单元；
- V3把Symphony状态机校正为Agent Symphony Harness；
- V4才增加Agent Cluster，V5才增加多Provider Backend；
- Podium独占Linear OAuth、Token和SDK，Performer独占Provider SDK；
- cross-process communication使用closed versioned schemas和generated types。

## 2. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Identity、Binding、Repository Context | `podium.db` | Podium Desktop |
| Resolved Conductor Project | Linear Project上的Conductor Project Label | Conductor |
| Root ownership、current Conversation、fixed Profile、delivery summary | Root Primary Status Comment | Conductor |
| Root Workflow structure、Human input、Work/Gate/Rework evidence | Linear Root Issue Tree和comments | Root Agent，经Harness约束 |
| Root/Tree order、Priority、blockers、native state | Linear | Conductor/Root Agent |
| current Provider Conversation | Root上的opaque `performer_id` | Performer resume；Conductor只转发 |
| Profile定义和active Profile | Conductor `performer-profiles/profiles.json` | Conductor |
| Codex auth/session/config runtime | Profile独立`CODEX_HOME` | Codex SDK / Performer |
| branch、commits、diff、checks | Git | Conductor/Root Agent |
| PR或branch delivery | Git/SCM和Root comment | Conductor |
| runtime progress、heartbeat、usage | best-effort Event/Desktop | 不参与Workflow |

Conductor内存中的`RootRunView`、`RootDispatchAssessment`、process handle、Event和Result都
可以丢弃；下一轮重新读取Linear/Git。

## 3. 一个Root的V3流程

```text
Root delegated to Symphony
-> Root In Progress
-> pin active Performer Profile
-> create deterministic branch/worktree
-> open Provider Conversation and persist performer_id on the Root
-> schedule the Root
-> Root Agent reads the full Root/Tree/Git context
-> Plan comment + ordered Work/Human children
-> user approves through a Human child
-> Root Agent advances children in Linear order
-> Root Gate and Rework when needed
-> Conductor-owned delivery command creates/reuses PR or branch
-> Root In Review
-> user/SCM eventually marks Root Done
```

Plan、Human、Work、Root Gate、Rework和Delivery仍然完整存在，但它们不是Conductor内部action
variants，也不是不同Performer business Turns。Agent通过closed commands把事实
写入Linear/Git，Conductor read-back后重新判断Root是否可运行。

Root activity Label可以best-effort显示planning、awaiting-human、working、reviewing、delivering、
blocked或failed，但不参与eligibility、mutation authority或恢复。

## 4. 多Root调度

Conductor每个周期全量发现绑定Project中的Root headers，但不读取所有active Root Trees：

```text
resolve Project
-> full-page delegated non-terminal Root headers
-> order by blockers, Linear Priority, Root order and identifier
-> lazily load and assess candidate Trees in that order
-> fresh-read the selected complete Root Tree and Git facts
-> run one bounded Root Turn for the selected Root
-> read back and discard transient state
```

`RootDispatchAssessment`只有`runnable | waiting_human | needs_attention | terminal`，不包含Plan、Leaf、
Gate或Delivery action。等待Human的Root释放单机lane；Priority/order变化在下一个Root Turn边界生效。
memory cache只减少Linear读取，不能决定readiness、Conversation、mutation或完成。

## 5. Conversation与Root retry

正常process crash或Turn timeout保留current `performer_id`，下一次Root Turnresume同一Conversation。
Provider明确报告Conversation不存在/不可恢复，或current pointer丢失时：

```text
cancel the old Turn and terminate its process tree
-> preserve Linear Tree and Git workspace
-> append a sanitized Root retry comment
-> open a new Conversation with the pinned Profile
-> compare-and-set the new performer_id on the Root
-> rebuild the entire Root from Linear/Git
-> reschedule the same Root
```

Root retry是重新启动Root执行，不是重置Root事实。它不恢复Leaf process、cursor、attempt或checkpoint，
不统一重开children，也不reset/clean worktree。旧Conversation的迟到commands和Results因current
pointer不匹配而失效。

## 6. Agent Symphony Harness

V3 Harness提供：

- typed Root context：trusted harness、untrusted human context、executable commands；
- bounded context和显式partial/truncation/include errors；
- Profile-owned Provider-native sandbox mode和有界command allowlist/denylist；
- launch前context limit、整个Turn wall deadline、broker/mutation command limits；
- Provider token在完整Turn结束后观察，不作为精确中途interrupt；
- 同源command help/catalog/schema/broker validation；
- mutation scope、remote/Git precondition、stable write identity和semantic read-back；
- complete-Turn accounting、heartbeat、cancellation和child-process cleanup；
- stale Result/old Conversation rejection；
- sanitized、人类可执行的Linear/Desktop错误。

参考Orca的是这些运行机制，不是它的`orchestration.db`、task DAG、dispatch rows、mailbox或failure
counter。Symphony所有durable workflow结论必须在Linear/Git，人机运行对象全部可丢弃。

## 7. 进程与边界

```text
Podium Desktop / Podium / Conductor: TypeScript
Performer: Python
Desktop host: Tauri / Rust
Cross-process contracts: generated JSON Schema types
```

依赖规则：

- roles只依赖contracts/interfaces，不导入另一role实现；
- Conductor通过`LinearGatewayInterface`访问Linear；
- Conductor通过`PerformerProcessInterface`bootstrap/resume Root Conversation并运行Root Turn；
- Performer通过private command channel调用Conductor broker，不直接调用Linear/Git topology；
- Provider差异只在Performer `*BackendImpl`；
- secrets、SDK objects、process handles、raw metadata不跨public boundary。

## 8. 版本边界

| 版本 | 主题 | 边界 |
|---|---|---|
| V1 | 单Root完整闭环 | 一个Root、一个worktree、一个Conversation、Plan/Human/Work/Gate/Delivery |
| V2 | 多Root稳定调度 | blocker、Priority、Root order和Human等待切换 |
| V3 | Agent Symphony Harness | Root级dispatch/Conversation/retry、closed commands和runtime hardening |
| V4 | Agent Cluster | Root内trusted roles、child Turns、fresh review和single-writer并发 |
| V5 | 多Provider Performer | 更多Backend复用相同RootTurn/Harness contract |

## 9. 文档导航

- [V3 Agent Symphony Harness](agent-symphony-harness.md)：Root dispatch、Conversation retry、context和broker。
- [Root Issue工作流](root-issue.md)：Linear上的Plan/Human/Work/Gate/Rework/Delivery事实。
- [Linear端到端流转](linear-flow.md)：Project解析、Root发现、blocker、排序和SDK ownership。
- [Conductor](conductor.md)：无DB主循环、Root readiness、process和read-back。
- [Performer](performer.md)：Root Conversation、Root Turn和Provider boundary。
- [Performer Command/Result](performer-command-contracts.md)：bootstrap与RootTurn closed schemas。
- [V4 Agent Cluster](agent-cluster.md)
- [Performer Profile与Codex配置](performer-profiles.md)
- [Git Worktree与交付](git-worktree-delivery.md)
- [Performer Event](performer-events.md)
- [契约与接口](contracts.md)
- [代码模块与命名规范](code-organization.md)
- [目标仓库目录](repository-directory.md)
- [Roadmap](roadmap.md)
- [架构术语表](glossary.md)
- [Podium](podium.md)
- [Podium Desktop](podium-desktop.md)
- [Runtime Hardening](runtime-hardening.md)

命名、模块和字段的唯一事实源分别由上述named concern文档拥有；其他文档只做角色说明或总览。

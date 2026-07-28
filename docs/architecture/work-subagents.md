# Work Subagents

状态：目标架构提案。本文是 Work role 内部 `normal` / `workflow` execution mode、flat `WorkSubtaskDag`、
Symphony-owned child thread orchestration、上下文隔离、并发、预算、共享 worktree、turn closure 和恢复的唯一事实源。
它不增加 Linear Issue kind、status、label、parent topology 或 Stage，也不改变 Cycle 是外层主循环。

## 1. Scope record

```text
authorized
  - 同一个 selected Work Issue 内的 normal 与 workflow 两种 runtime execution mode
  - approved Plan 预先给出的完整 WorkSubtask DAG
  - 一个 persistent Work main thread 调度多个 fresh direct child threads
  - Performer 只使用官方 Codex Python SDK public thread/turn API
  - bounded active children、internal rounds、context/result bytes 和 current-epoch registry
  - stable snapshot 上的并行只读与整个 Root worktree 的串行独占写
  - WorkResult 前不可重开的 epoch retirement、child interruption 和 writer fence

required_consequences
  - Linear workflow 仍只有既有 Root、Cycle、Plan、Work、Verify 和 Finding facts
  - WorkSubtask 不是 Linear Issue、Stage、workflow node、attempt 或 durable identity
  - 一个 external Work turn 可以包含多个 Performer-internal Provider rounds
  - workflow mode 只有一个 main agent 和一层 direct child agents
  - child 使用 fresh Provider thread，不 fork main、sibling 或旧 child history
  - Codex native multi-agent 对 main 和 child threads 都关闭
  - 全部 children 仍执行同一个 selected Work Issue，并只形成一个 WorkResult
  - Conductor 仍只发起一个 Work turn，不调度、控制或解释 child threads
  - Linear 与 Git 仍是唯一 durable workflow/code authority

out_of_scope
  - 新 Linear Issue kind、label、status、parent topology 或 child lifecycle
  - nested workflow mode、recursive subagents 或 dynamic WorkSubtask creation
  - child 独立 Stage Result、retry chain、Cycle、Human Action 或 progress comment
  - parallel workspace writers、path-subset write grants、per-agent branch/worktree/commit/merge
  - Codex native agent path、agent graph、mailbox、collaboration tools 或 persistence
  - Desktop agent tree、progress、approval或control UI

assumptions_requiring_approval
  - none

deferred_ideas
  - parallel mutation through isolated per-child worktrees
```

## 2. 决定与 authority

每个 external Work turn 仍只执行一个 selected Work Issue。Performer 在 admission 时冻结 execution mode：

```text
WorkExecutionMode.normal
  persistent Work main thread
  one or more ordinary Work Provider rounds
  main executes the selected Work Issue directly

WorkExecutionMode.workflow
  persistent Work main thread
  frozen WorkSubtaskDag for the selected Work Issue
  zero or more fresh direct child threads per accepted dispatch batch
  main accepts child outcomes, reviews the workspace and produces the only WorkResult
```

Mode 必须在任何 child dispatch 或 workspace mutation 前冻结。Workflow admission 后不能降级到 normal；capacity、budget、
child 或 Provider failure 由 main 返回 matching existing Work Result，或由 Performer 返回 existing mechanical
`StageTurnFailure`。这样不会让 partial child work 被 normal mode 静默重复执行。

Plan 必须在 approved selected Work proposal 中预先给出完整 subtask 集合、每个 subtask 的目标、scope、expected outcome、
required checks 和 dependency。这里的“sub-issue”canonical 命名为 `WorkSubtask`，避免与 native Linear Issue 混淆。

Workflow admission 必须取得一个 lossless、structured、approved `WorkSubtaskDag` projection。本文不拥有 Plan-to-Work
cross-process contract；该 projection 由 Stage contract 的事实源定义并随 approved Work context 到达 Performer。在该 contract
存在前 workflow mode 必须 disabled。Performer不得从 free-form description、private JSON、hidden marker、repository task file、
旧 Plan thread 或 Provider transcript 猜测 DAG。

Main agent 拥有执行策略，不拥有 workflow 或 scope authority。它可以：

- 在 mechanically ready subtasks 中选择 dispatch 顺序和并发度；
- 为 predefined subtask 提供更具体但不扩权的 child instruction；
- 对同一 subtask 请求 bounded follow-up；
- 因风险、capacity 或 workspace access 把可并行 subtasks 串行执行；
- 接受或拒绝 child outcome、检查完整 diff 并生成唯一 WorkResult。

Main agent 不能：

- 新增、删除、replace、拆分或合并 WorkSubtask；
- 修改 scope、expected outcome、required checks 或 dependency；
- dispatch approved DAG 外的工作；
- 把一个 subtask 的实质工作静默转移到另一个 subtask；
- 修改 Linear、Cycle DAG、Git topology 或选择 workflow 下一步。

发现 DAG 或 scope 需要变化时，main 只能在 matching existing Work Result 中返回 bounded observation 和
`suggested_dag_changes`；fresh Root Reconciler 决定后续动作。

## 3. Provider SDK boundary

`CodexBackendImpl`只使用官方 Codex Python SDK public API。Workflow mode 的最低 capability 是：

```text
Codex / AsyncCodex
  thread_start(...)
  close()

Thread / AsyncThread
  run(...)
  turn(...)

TurnHandle / AsyncTurnHandle
  interrupt()
  stream()
  run()
```

Main使用persistent SDK client/thread；每个child runtime拥有一个短生命周期SDK client和其中唯一一个fresh thread，因而可以通过
public `close()`独立retire。Performer不调用 Codex native `spawn_agent`、`send_message`、
`followup_task`、`wait_agent`、`list_agents`，不读取 Codex agent graph，也不依赖 `/root/...` path 或 persisted spawn edge。

Performer通过 SDK thread start config 对 main 与 child 关闭 Codex native multi-agent。该 gate 必须由实际 SDK/runtime read-back
或 acceptance test 证明；prompt 中写“不要 spawn”不构成 capability denial。SDK无法关闭 native multi-agent 时 workflow mode
disabled，normal mode 也不能把 native delegation 当成 Symphony WorkSubtask execution。

Provider SDK object、raw thread ID、process handle、rollout、transcript 和 `CODEX_HOME` content 不离开 backend。Symphony不调用
Codex CLI、不依赖 private SDK members，也不读取或改写 Codex-owned state 协调 threads。

## 4. Runtime model 与 identity

Performer内部 runtime model：

```text
WorkRoleSession
  role_session_id
  main_provider_thread
  current_epoch?

WorkTurnEpoch
  stage_execution_id
  target_issue_id
  execution_mode: normal | workflow
  phase: coordinating | finalizing | closed
  frozen_subtask_dag?
  coordinator_round
  child_registry
  accepted_subtask_outcomes
  budget_ledger
  workspace_access
  mutation_containment

WorkSubtask
  subtask_key
  title
  instruction
  expected_outcome
  required_checks[]
  dependency_keys[]

WorkChildRuntime
  child_runtime_id
  subtask_key
  provider_client_handle
  provider_thread_handle
  active_turn_handle?
  access_mode: read_only | exclusive_write
  runtime_status
  completion_record?
```

`subtask_key`只在 matching turn 中寻址 frozen DAG node，不是 Linear ID、stable proposal identity 或 cross-restart identity。
`child_runtime_id`由 Performer 创建，仅用于 current epoch correlation；它不是 Provider thread ID，也不进入 model-visible authority。

Runtime status 至少区分：

```text
starting | running | completed | interrupted | errored | retiring | retired
```

Provider turn completion不等于 subtask acceptance。只有 main 基于 structured child outcome、fresh workspace facts 和 check evidence
明确接受后，该 subtask 才能满足 downstream dependency。Epoch closure 后全部 subtask/runtime handle/status 永久失效。

## 5. Main coordinator protocol

一个 external Work turn 可以包含多个 internal main rounds。Main 每轮只返回一个 closed、versioned internal action：

```text
WorkCoordinatorActionV1 =
  | DispatchBatchAction
  | ContinueChildAction
  | AcceptOutcomesAndContinueAction
  | FinalizeWorkAction
  | ReturnWorkResultAction
```

最小语义：

```text
DispatchBatchAction
  accept_outcomes[]
  dispatches[]
    subtask_key
    bounded_instruction
    access_mode: read_only | exclusive_write

ContinueChildAction
  child_runtime_id
  subtask_key
  bounded_instruction

AcceptOutcomesAndContinueAction
  accept_outcomes[]

FinalizeWorkAction
  accept_outcomes[]

ReturnWorkResultAction
  result: existing WorkResult
```

该 union 是 Performer backend internal schema，不进入 Conductor contract。Performer必须验证 action version、epoch、DAG membership、
ready set、dependency、duplicate dispatch、instruction bounds、access mode、capacity、budget 和 deadline。Validation failure返回 bounded
internal observation给 main，不能产生 child thread 或 mutation。

Action transition必须closed：`DispatchBatchAction`、`ContinueChildAction`和`AcceptOutcomesAndContinueAction`只在`coordinating`
有效；满足全部required subtask coverage且没有active/pending child work时，`FinalizeWorkAction`把phase不可逆地推进到`finalizing`；
完成child/runtime/writer barrier后，Performer才启动tools-disabled main round，并且该round只接受`ReturnWorkResultAction`。
Validated Result handoff后phase变为`closed`。任何skip、rollback或closed epoch action都机械拒绝。

Main action不是 durable workflow fact。Performer执行一个 accepted action、收集 bounded results，再向同一个 main thread追加下一轮
command和新增/替换/tombstone context fragments。Main 不直接获得 SDK handles，也不能绕过 Performer 创建 thread。

## 6. Fresh child context 与 capability

每个 accepted dispatch 创建一个fresh SDK client，并使用该client的`thread_start`创建唯一的fresh child Provider thread；不得使用
`thread_fork`、`thread_resume` 或旧 child thread。Child只接收：

- Work child stable instructions；
- current selected Work Issue 的 bounded context；
- exact WorkSubtask 与 accepted predecessor evidence；
- main 的 bounded instruction；
- matching workspace access mode；
- current epoch limits 与 correlation。

Child不接收 main transcript、完整Root Tree、Root Reconciler transcript、Plan/Verify conversation、sibling transcript、旧 Work turn、
DAG 外 task、old authority 或 write capability。Performer显式构造 initial child context；Provider memory projection不是 child input。

Child output 使用 closed `WorkSubtaskOutcomeV1`，至少包含 outcome kind、bounded summary、changed facts、checks 和 discovered risks。
它不能生成 `WorkResult`、coordinator action、Human Action 或 DAG patch。Child input、follow-up 和 output 都是不可信数据，不能改变
target、scope、checks、dependency、permission 或 workspace access。

## 7. Scheduling、follow-up 与 capacity

Main从 frozen DAG ready set 调度。Initial ready nodes没有 predecessor；后续 node 只有在全部 predecessor outcomes 被 main 接受后
ready。Parallelism只能改变执行时间，不能改变 dependency 或 completion 标准。

Performer维护 current-epoch `child_registry`，并原子执行 admission。Registry 是完整 runtime closure source；SDK `thread_list`、
Provider history 和 filesystem state 都不能替代它。Release-owned finite bounds 至少覆盖：

- active child turns；
- total child threads per epoch；
- coordinator rounds；
- per-child follow-ups；
- input、follow-up、output 和 aggregate result bytes；
- wall time 与 deadline。

Follow-up 在 matching child thread 上启动下一次 turn。Main只在Performer交付bounded child completion/failure后请求follow-up；
它不在child active期间获得stream或turn handle。Outer cancel、deadline和runtime failure由Performer使用matching
`TurnHandle.interrupt()`处理。Completed、interrupted或errored child只能在同一个predefined subtask与既有bounds内follow-up，
不能借follow-up改成新task。

## 8. Tree-wide budget与hard reservation

Conductor仍只发送既有 role-generic `StageLimits`。Main、全部 children、ordinary tools 和 internal coordinator rounds 共同消耗
matching Work turn budget。Subagent layer不得创造私有免费预算或把 child usage排除在 aggregate observation之外。

Performer必须在启动 main/child round 前检查剩余 context bytes、result bytes、tool-call allowance、wall time、deadline 和可执行的
Provider token limit，并为 final main inspection、aggregate checks、Result generation 和 response handoff保留 release-owned reserve。
Concurrent admissions必须原子，不能共同观察同一余额后全部通过。

SDK只提供 post-turn usage observation 时，Performer不能把该 observation描述成 pre-dispatch hard token proof。若 existing Stage
contract要求的任一 hard limit不能对每个并发 Provider round真实强制，workflow mode disabled。Capacity不足只拒绝新 dispatch；
workflow admission 后不能退回 normal mode。

## 9. Shared worktree与机械write grant

全部 threads 针对同一个 Root worktree，不创建 per-agent branch、worktree、commit 或 merge。SDK只提供 coarse sandbox时，
Symphony只定义两种 child access mode：

```text
read_only
  child SDK turn uses read-only sandbox
  multiple children may run against the same stable workspace snapshot

exclusive_write
  child SDK turn uses workspace-write sandbox
  matching epoch holds the only whole-worktree writer token
  main and every other child are barred from workspace tools until retirement barrier
```

不存在 `write_paths`、path lease 或 parallel workspace writers。Read-only batch必须绑定一个稳定 workspace observation；一旦写者
admit，依赖旧 snapshot 的未完成 read-only results 必须先 settle，或被标记 stale 并重新执行。Writer结束后 Performer必须完成
turn termination、runtime/process containment barrier 和 fresh workspace read，才能把 writer token交给 main或下一个 child。

SDK/runtime不能证明 workspace-write child 已停止产生 mutation 时，workflow mode只允许 read-only children，由 main统一修改；
不能用 prompt、sleep 或单独观察 PID 代替 writer proof。

这里的 mechanical write grant 只表示 matching epoch 对整个 Root worktree 的一个 exclusive writer token，不表示 SDK 支持
path-subset grant。任何更细粒度的 write scope 都必须等独立 worktree 方案获得批准后再定义。

## 10. Work runtime containment与writer fence

Main runtime、每个child SDK client、Provider turn、tool process和workspace capability都必须归属matching `WorkTurnEpoch`。
Child client close、turn completion或interrupt response本身都不是writer proof；Performer还必须完成其拥有的runtime/process containment
barrier，并拒绝所有携带retired epoch correlation的late output。

如果SDK client或tool runtime能够产生脱离matching containment的后台writer，workflow mode不能admit `exclusive_write` child。
Root writer permit只有在current epoch没有active producer、pending output或unfenced mutation后才能handoff。

## 11. Terminal closure protocol

只有 Work main 可以生成 semantic `WorkResult`。Child final answer、status 或 check只是 runtime input。Main进入 finalization 前必须：

1. 覆盖 frozen DAG 中全部 required subtasks；
2. 确认 dependency 只由 accepted predecessor outcome满足；
3. 确认没有 active child turn、pending follow-up 或未处理 child outcome；
4. review完整 diff、workspace scope和fresh Git facts；
5. 运行 selected Work Issue要求的 aggregate checks；
6. 把 child事实整合进 existing WorkResult fields，不暴露 thread trace。

`FinalizeWorkAction`被接受后，matching epoch永久关闭 new child admission、follow-up和ordinary mutation。Performer interrupt/drain
active handles、关闭 child SDK runtimes、完成 writer/process containment barrier，再允许 main执行 tools-disabled final Result round。

Workflow与normal返回完全相同的public `WorkResult` union。Conductor、Linear和Root Reconciler不能判断或依赖是否使用children。
Closure proof失败时Performer返回existing mechanical `StageTurnFailure`，不能伪造semantic Result。

## 12. Abort、session close与恢复

Cancel、deadline、budget、Provider failure或session close时，Performer停止new admission，interrupt active turns，关闭child SDK
runtimes，retire registry并完成writer/process containment barrier。只有证明writer domain empty或被effective fence隔离后才能释放Root
writer permit。

Process/session loss后不恢复WorkSubtask DAG、child registry、thread、turn handle、coordinator action、completion或budget ledger，
也不从Codex thread list/persistence重放task。Partial edits只作为fresh Git/worktree facts进入existing Root recovery；matching Work Issue
按既有workflow规则收敛。

Fresh execution如再次选择workflow mode，必须从current approved structured Plan projection与selected Work context创建新的epoch和
fresh child threads。旧thread ID、child outcome或subtask key不能跨epoch复用。

## 13. Provider 与 public contract boundary

Conductor仍只观察一个`WorkTurnRequest | WorkTurnResponse`。Agent count、internal rounds、child runtime ID、thread status、sandbox mode、
coordinator action、transcript或delegation trace不进入Result或Desktop。

Plan-to-Work `WorkSubtaskDag` projection 是 workflow admission的必要approved input，但它不创建新的Linear workflow node，也不允许
Conductor调度children。其closed transport schema由Stage contract事实源拥有；本文只拥有Performer收到projection后的runtime语义。

## 14. Observability 与安全

Runtime logs/metrics可以记录sanitized mode、coordinator round、child count、dispatch duration、capacity/budget refusal、access mode、
closure latency和aggregate usage availability。不得记录prompt、follow-up或result body、raw transcript、reasoning、secret、credential、
authorization header、absolute profile path、Provider thread ID或raw SDK payload。

Work usage observation聚合main与children，不按child runtime ID进入public contract。Runtime progress不写Linear comment，也不进入Desktop。

## 15. Failure matrix

| Failure | Runtime consequence | Workflow consequence |
|---|---|---|
| structured DAG缺失、ambiguous、nested或cyclic | workflow admission拒绝；使用normal mode | Linear workflow不变 |
| unknown、duplicate或non-ready dispatch | action拒绝并给main bounded observation | Linear workflow不变 |
| child Provider/tool failure | main可在同一subtask内follow-up或返回matching Work Result | 不创建child attempt |
| budget/capacity exhausted | stop new dispatch，保留finalization reserve | matching Work turn处理 |
| write containment不可证明 | exclusive-write dispatch拒绝；只允许read-only child或由main写入 | matching Work turn处理 |
| child late output/write | epoch/fence拒绝并记录 | fresh Git facts决定后续 |
| closure proof失败 | StageTurnFailure | Root Reconciler按既有规则决定 |
| process/session loss | 丢弃全部child runtime | 从Linear/Git恢复selected Work attempt |

## 16. 验收边界

真实Provider/runtime acceptance必须证明：

- normal与workflow main threads都关闭Codex native multi-agent；
- workflow只能为frozen DAG中的ready node创建fresh direct child thread；
- child context不包含main/sibling/旧turn history；
- child不能创建thread、修改DAG或生成WorkResult；
- nested、cyclic与dynamic task被机械拒绝；
- independent read-only subtasks可在stable snapshot上并行，dependency不能越过；
- shared worktree同时最多一个writer，writer barrier前不发生handoff；
- coordinator rounds、children、bytes、capacity、deadline和Provider-enforceable budgets有界；
- main审阅全部accepted outcomes并只生成一个existing WorkResult；
- cancel、crash或close后没有accepted late output或unfenced mutation；
- restart不依赖Codex thread list、history或runtime task state；
- Linear object graph与不开启workflow mode时完全相同。

Local mocks只能覆盖codec和policy，不能单独证明SDK config生效、fresh-thread context isolation、sandbox、interrupt、runtime close、
writer containment或真实Provider limits。

## 17. 不变量

1. Subagents不改变Linear workflow、Issue topology、Stage lifecycle或Cycle loop。
2. 每个Work turn仍只执行一个selected Work Issue并返回一个WorkResult。
3. normal mode只有main；workflow mode只有main与一层fresh direct children。
4. WorkSubtask DAG由approved Plan预先给出，完整、有向、无环且不能动态修改。
5. WorkSubtask不是Linear Issue、Stage、attempt、durable identity或cross-restart fact。
6. Main只拥有调度策略；scope、checks、dependencies和workflow next step不可修改。
7. Main与child都关闭Codex native multi-agent；只有Performer可以创建child thread。
8. Child使用fresh `thread_start`，不fork、resume或继承另一Provider thread。
9. 全部threads共享一个Work turn和Root worktree；同时最多一个workspace writer。
10. 只有main生成semantic WorkResult；child和thread details不进入public result。
11. Provider thread不是durable authority；restart只依赖Linear与Git facts。
12. 任一required SDK、budget或context proof缺失时workflow mode disabled；writer proof缺失时只admit read-only children。

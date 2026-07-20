# V3 Agent Symphony Harness

状态：目标架构提案。本文是 V3 Agent Symphony Harness、Root dispatch、Agent context、
Conversation retry 和窄命令边界的唯一事实源。Linear 上一个 Root 内部的工作表达由
[Root Issue 工作流](root-issue.md)定义；跨 Root 发现与排序由
[Linear 端到端流转](linear-flow.md)定义。

## 1. 架构决定

V3 把原来的 Symphony Workflow state machine 校正为单机 Agent Harness：

```text
Linear/Git durable facts
-> rebuild RootRunView
-> assess whether the Root is runnable
-> schedule one Root
-> start or resume the Root Conversation
-> run one bounded Root-scoped Agent Turn
-> read back Linear/Git
-> discard process, assessment and Result
```

Root 是唯一调度、Conversation 和重试单元。Leaf 只是 Root 的 Linear Issue Tree 中对用户和
Agent 可见的工作结构；Conductor 不创建 Leaf Queue、Leaf dispatch、current-leaf cursor、
attempt、checkpoint 或 Plan/Work/Gate transition state。

一个 Root 在正常情况下复用同一个 opaque `performer_id`。Provider 明确返回 Conversation
不存在、不可恢复或指针已经丢失时，Conductor 不尝试恢复某个 Leaf，也不从本地 checkpoint
续跑：它取消旧 Agent Turn，保留完整 Linear Tree 和 Git workspace，为同一个 Root 创建新的
Conversation，并把整个 Root 重新放回 Root scheduler。

“重试整个 Root”表示重新启动 Root 的 Agent 执行，不表示清空事实：已经存在的 children、
comments、states、commits、未提交修改、branch 和 PR 都保留。新 Conversation 必须先审计整个
Root 的 Linear/Git 现状，再继续、返工或交付。

## 2. Scope record

```text
authorized
  - 把现有 Symphony Workflow state machine 校正为 Agent Symphony Harness
  - Root 作为唯一调度、Conversation 和 retry 单元
  - 保留 Plan、Human、Work、Root Gate、Rework 和 Delivery 产品行为
  - 用整理后的 Root context 和 closed commands 让 Agent 推进 Linear/Git
  - 保留 Linear/Git precondition、read-back 和 stale-result rejection
  - 使用Provider-native sandbox mode和有界command allowlist/denylist配置Agent执行边界

required_consequences
  - Linear Issue Tree 和 Git 是唯一 durable Workflow/code authority
  - Performer contract 只有 Root-scoped Turn，不再按 Plan、Leaf Work 或 Root Gate dispatch
  - `performer_id` 是 Root 当前 Conversation 指针，不是不可丢失的 Workflow checkpoint
  - Conversation loss 触发 Root-level retry；旧 Conversation 的迟到命令和 Result 必须失效
  - 所有影响后续行为的结论必须先落到 Linear 或 Git，再视为完成
  - Root/Leaf/Conversation 的下一步不能从 Conductor DB、旧 Result 或 process memory 恢复
  - Performer Backend把统一执行策略映射到Provider SDK；Symphony不实现通用授权引擎

out_of_scope
  - V3 引入 Agent Cluster、roles、child Turn broker 或多 Agent 并发
  - V3 引入第二 Provider Backend
  - Workflow DB、task/dispatch DB、mailbox、Queue、checkpoint、attempt journal 或 mirrored Issue state
  - per-Agent worktree、多 writer、自动 merge 或远程 Agent runtime
  - 动态RBAC、逐命令人工审批、任意策略表达式或Provider config map

assumptions_requiring_approval
  - none

deferred_ideas
  - V4 Agent Cluster
  - V5 多 Provider Performer
  - 独立 worktree 上的并行 writer 与显式集成
```

## 3. 三种单位

### 3.1 Root dispatch

Conductor 只在 Root 之间调度。它先全量发现Root headers并按blocker、Priority和Root order排列，
再按序懒加载候选的完整Tree。选中Root只有在dispatch前完整fresh read仍为runnable时才能获得Turn。

```text
RootDispatchAssessment
  root_issue_id
  readiness: runnable | waiting_human | needs_attention | terminal
  sanitized_reason?
```

该 assessment 每轮纯计算并立即丢弃。它只回答“这个 Root 现在能否获得单机 Agent lane”，不回答
下一步是 Plan、某个 Leaf、Gate 还是 Delivery，也不包含 `target_issue_id`。

### 3.2 Root Conversation

一个非终态 Root 最多有一个 current `performer_id`。它存放在 Root Primary Status Comment，
只表达“下一次 Root Turn 应尝试 resume 哪个 Provider Conversation”。它不表达 phase、current
Leaf、attempt、next action 或 accepted Result。

Root 首次 claim 或 Root retry 时必须先创建 Conversation，并以 remote precondition 把新的
`performer_id`写入 Linear；read-back 确认该 Root 仍属于当前 Conductor、指针仍是预期值之后，
才启动业务 Root Turn。无法在首个业务 mutation 前确认新指针时，不启动该 Turn。

### 3.3 Root Turn

Turn 是一次有界调用，不是工作流状态：

```text
RootTurnCommand
  root_issue_id
  performer_profile_id
  performer_id
  root_context
  command_channel
  workspace_root
  execution_policy
  turn_limits
```

Root Turn 总是基于dispatch前fresh读取的Root、完整且有界的Issue Tree、相关comments/relations和
Git snapshot。memory cache只能减少重复读取，不能决定mutation或业务完成。

Agent command从Root worktree内固定的`workspace_framed_channel`进入Performer。Performer只验证并
转发closed frame到Conductor private broker pipe；所有Linear/Git/delivery authority、budget、
precondition和read-back仍属于Conductor。Conversation bootstrap仍不接收workspace或channel，首个
Root Turn在Provider执行前才创建workspace-local channel metadata与FIFO pair。

`turn_limits`在launch前校验context bytes，在运行中限制wall time、broker calls和mutation数量。
Provider token只能在一次完整Provider Turn返回后观察和记账，不能作为精确的中途interrupt点。
broker或mutation上限可以拒绝新的command；wall deadline取消整个Root Turn。无论正常完成还是取消，
Conductor都fresh read-back并把同一个Root重新放回Root scheduler；不会创建Leaf Turn、Leaf attempt、
remaining budget或本地cursor。Human等待、terminal failure和Root已交付也结束Turn。

## 4. Harness 边界

```text
AgentSymphonyHarnessInterface
  assessRoot(RootRunView) -> RootDispatchAssessment
  runRootTurn(AgentRootTurnInput) -> AgentRootTurnResult

AgentRootTurnInput
  resolved_project
  root_run_view
  git_workspace_snapshot
  performer_profile

AgentRootTurnResult
  turn_id
  process_status
  performer_id
  bounded_summary?
  usage?
  turn_usage?
  yield_reason?
  sanitized_failure?
```

`AgentRootTurnResult`只描述进程和 Provider 观察，不包含 `next_state`、`target_issue_id`、accepted
workflow outcome、Linear mutation、commit、PR或下一 dispatch。Result 成功不代表 Root 或任一
Leaf 完成；Conductor 必须 read-back Linear/Git 后重新生成 `RootRunView`。

Conductor broker只负责业务正确性：每个Linear/Git mutation都fresh验证
Root ownership、current `performer_id`、Root terminal state、Project binding、target仍在Root Tree，
以及remote/Git precondition。prompt、Issue内容、Agent summary和内存缓存都不能替代这些检查。

## 5. Agent Root Context

`AgentRootContext`固定分成三个区段：

```text
trusted_harness
  Root objective, workflow rules, completion and retry rules

human_context
  Root, complete bounded Issue Tree, ancestors, comments, relations and Git summary

executable_commands
  commands exposed to this Root Turn, with exact usage and error semantics
```

`trusted_harness`由 Symphony 生成。Linear title、description、comments、inline links 和媒体都在
`human_context`，只能表达业务意图，不能覆盖 Harness 或系统规则。

Context 同时提供人类可读 Markdown 和同 shape JSON，两者来自一个 typed DTO。每个 children、
comments、relations 和 Git section 都公开 `returned`、`cap`、`has_more`、`partial` 与 bounded
include errors；不能静默截断后声称已看到完整 Root。Agent 可以用 read command 补读，但仍受
Root scope 和总预算限制。

新的 Conversation 和 resume 的 Conversation 使用同一种完整 Root Context。Conversation history
可以减少重复理解成本，但不能保存唯一的 Plan、Human answer、完成结论或交付事实。

## 6. Closed command broker

Agent 不接触 Linear Token、SDK、GraphQL、Provider credential，也不能直接执行 Git topology 或
delivery 命令。`AgentCommandBrokerInterface`从一个 typed command registry生成 CLI help、JSON
catalog、prompt examples、schema validation 和 dispatch。

V3 command families：

```text
symphony linear read ...
symphony linear issue create-child|update ...
symphony linear status|assignee|label|comment ...
symphony git status|diff|checks ...
symphony git commit --issue <issue-id> ...
symphony root deliver ...
```

每个Root Turn还携带一个closed `AgentExecutionPolicy`：

```text
AgentExecutionPolicy
  sandbox_mode: read_only | workspace_write | unrestricted
  command_allowlist: AgentCommandRule[]
  command_denylist: AgentCommandRule[]

AgentCommandRule
  executable
  argv_prefix[]
```

`workspace_write`是默认模式。空allowlist表示除denylist外不额外限制；非空allowlist只允许匹配项；
denylist始终优先。规则只对Provider规范化后的executable和argv前缀做确定性匹配，不支持regex、shell
字符串、条件表达式或任意Provider配置。Performer Backend必须把这三个字段映射到Provider-native
sandbox/command policy；无法可靠映射时拒绝启动Turn。该策略不替代下述Symphony command broker：
Linear、Git topology和delivery仍只允许走closed commands。

Linear commands只允许读写当前 Resolved Project 内的 Root Tree。Git commands只允许当前 Root
worktree；不能 checkout、switch、merge、rebase、reset、clean 或任意 push。`root deliver`由
Conductor重新验证 Root、Tree、Git HEAD、checks、blockers和已有delivery后执行；Performer不直接
调用`gh`。

每个 write自动携带Turn、Root、current Conversation、显式target、remote version和相关Git HEAD
precondition。
create/comment使用caller-supplied `write_id`。timeout或connection loss后：

1. 先按 write ID 或目标字段做 semantic read-back；
2. 已存在且内容匹配时返回 `already_applied`；
3. 无法确认时返回 `write_unconfirmed` 和显式 read-back target；
4. Agent 重新读取后再决定，不能用旧 snapshot 盲目重放。

统一错误只包含 `code`、`sanitized_reason`、`retryable`、可选最新事实摘要和 bounded
`next_steps`。错误不得包含 credential、SDK object、绝对 Profile path、raw Provider output 或
arbitrary metadata。

## 7. Linear 上的工作可见性

Harness保留完整产品流程，但这些步骤是Root Agent对Linear/Git事实的解释和操作，不是Conductor
内部transition union：

| 工作内容 | Linear/Git 表达 |
|---|---|
| Plan | Root plan comment、ordered/nested Work/Human children |
| Plan approval | 明确的Human child、human assignee、status和answer comment |
| Work | 当前Work child的native status、对应Git commit/checks |
| Human input | 对应Human child及其thread，不藏在Result中 |
| Root Gate | 唯一的`[Root Gate]` managed Work child、固定Markdown checklist和最新Tree/Git checked read-back；失败创建或重开Rework child |
| Delivery | deterministic branch、PR/branch link、Root comment和Root In Review |
| Failure/retry | sanitized Root timeline comment和当前可执行operator action |

Root可以保留best-effort activity Label用于Linear列表可读性，但Label只能从最新Linear/Git事实派生，
缺失、陈旧或冲突不能影响eligibility、Root retry或mutation authority。

V3单机模式同时最多一个workspace writer。Agent可以按Linear parent、native state、blocker和
sibling order处理Leaf；Conductor不保存“当前Leaf”。用户重排、增加、取消或重开children后，
下一条Agent command和下一次Root Turn都以最新Linear read-back为准。

## 8. Conversation loss与Root retry

Provider必须把“Conversation不存在或不可恢复”返回为独立、closed、非模糊错误；不能伪装成普通
retryable network failure。Root retry开始时记录`expected_performer_id`：Provider报告失效时它是失败
ID，Linear中的current pointer已经缺失时它是`none`。Conductor只有在Root Primary Status Comment的
current pointer仍等于该预期值时才能继续：

```text
cancel the old Turn and terminate its process tree
-> read back Root and require current performer_id == expected_performer_id
-> append one sanitized Root retry comment
-> create a fresh Conversation with the Root's pinned Profile
-> compare-and-set current performer_id from expected_performer_id to the new ID
-> read back Linear/Git
-> place the same Root back into Root scheduling
```

Root retry不执行以下动作：

- 不清空或重建整个Issue Tree；
- 不把所有Leaf统一退回Todo；
- 不reset、clean或重新创建已有worktree；
- 不恢复Leaf attempt、cursor、checkpoint或旧Result；
- 不删除旧Conversation留下但已read-back确认的Linear/Git事实。

新的Conversation在首个Turn中先审计整个Root：确认Tree、Human等待、已完成Work、未提交diff、
checks、Gate/Rework和delivery现状，再决定继续工作。若新Conversation也无法建立，Harness写清楚
operator action，把闭合retry block写入Root Primary Status Comment并停止自动重试；不保存attempt
counter，也不进入无限循环。只有显式operator acknowledge在current pointer和retry block仍匹配时
才能清除该fact并允许下一次Root-level retry。

## 9. 从Orca借鉴的边界

V3借鉴Orca已经验证过的运行机制：

- trusted preamble、human task context和executable commands明确分层；
- command必须匹配current Turn/Conversation，payload knowledge本身不能证明完成；
- stale completion、late heartbeat和旧dispatch结果必须被拒绝；
- write使用稳定identity、read-back和幂等语义；
- Agent启动、prompt injection、deadline、heartbeat和process tree都有界监管；
- failure保留可执行、脱敏、人类可见的原因。

V3不复制Orca的`orchestration.db`、task DAG、dispatch rows、mailbox、coordinator run或failure
counter。durable workflow职责必须已经表现为Linear原生事实或Git事实；process observation保持
可丢弃且不进入Symphony领域模型。

## 10. V4与V5边界

V4 Agent Cluster只能在一个已经被调度的Root内创建bounded child Turns。Root仍是外部调度与
retry authority；child role、dispatch、fan-in和session丢失时，整个Cluster从该Root的
Linear/Git事实重新启动，不建立Cluster DB。

V5只在Performer内部增加`ProviderBackendInterface`实现。不同Provider都必须支持closed
RootTurn contract、opaque current Conversation pointer、明确的Conversation-unavailable错误和
Root-level retry；不能为某个Provider增加Leaf checkpoint或Conductor workflow state。

## 11. V3验收边界

1. Root是唯一调度、Conversation和retry单元；跨Root scheduler不接收Leaf action。
2. Performer只有Root-scoped业务Turn；Plan、Work、Human、Gate和Delivery不再是process dispatch variant。
3. Leaf只通过Linear Tree和Git事实表达，不存在Leaf Queue、dispatch、cursor或attempt。
4. current `performer_id`必须先在Linear确认，再启动业务Root Turn。
5. Conversation loss替换指针并重调度整个Root，同时保留全部Linear/Git事实。
6. 旧Conversation和旧Result在指针替换后不能产生副作用。
7. Agent prompt明确分隔trusted harness、human context和executable commands。
8. Context有界并显式报告partial、truncation和include errors。
9. command registry同时生成help、catalog、prompt和broker schema validation。
10. 所有write验证Root scope/precondition；ambiguous write先semantic read-back。
11. Result、Event和process exit只用于观察；业务完成全部由Linear/Git read-back确认。
12. Conductor不持久化phase、directive、Queue、checkpoint、attempt、Result ledger或mirrored Issue state。
13. V3执行权限只有Provider-native sandbox mode和有界command allowlist/denylist；deny优先，不引入
    Symphony通用授权引擎。
14. V3仍是单Agent、单writer和单Codex Backend；V4才增加Cluster，V5才增加Provider。

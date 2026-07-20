# Performer Command 与 Result 契约

状态：目标架构提案。本文只定义 Conductor 与 Performer 之间的 Conversation bootstrap 和一次性
Root Turn 契约，不定义 Linear 工作流、Git 交付或本地恢复数据库。

## 1. 契约模型

V3只有一种业务Turn：`RootTurnCommand`。Plan、Work、Human、Root Gate、Rework和Delivery是
Root Agent通过closed commands推进的Root内部工作，不是Conductor向Performer发送的不同Turn
variant。

```text
PerformerProcessInterface
  openRootConversation(OpenRootConversationCommand)
    -> RootConversationOpenedResult | ConversationOpenFailedResult

  runRootTurn(RootTurnCommand)
    -> RootTurnCompletedResult
     | RootConversationUnavailableResult
     | RootTurnFailedResult
     | RootTurnCanceledResult
```

`openRootConversation`只创建Provider Conversation并返回opaque `performer_id`，不接收Root业务
内容、command channel或workspace。Conductor把该ID写入Root Primary Status Comment并
read-back后，才可启动有副作用的`RootTurnCommand`。

## 2. Conversation bootstrap

```text
OpenRootConversationCommand
  protocol_version
  request_id
  performer_profile_id
  codex_turn_settings
  hard_deadline_at

RootConversationOpenedResult
  protocol_version
  request_id
  performer_profile_id
  performer_id
  completed_at

ConversationOpenFailedResult
  protocol_version
  request_id
  performer_profile_id
  error_code
  sanitized_reason
  retryable
  action_required?
  completed_at
```

`performer_id`必须是identifier，不能包含Token、credential、绝对Profile path或Provider配置。
Conversation创建成功但ID写入Linear前进程中断时，可能留下orphan Conversation；因为bootstrap
没有业务context、command channel或workspace，它不能留下Linear或Git副作用，后续可以安全创建
新的Conversation。

## 3. RootTurnCommand

```text
RootTurnCommand
  protocol_version
  turn_id
  root_issue_id
  performer_profile_id
  performer_id
  codex_turn_settings
  execution_policy
  root_context
  context_digest
  command_channel
  workspace_root
  started_at
  turn_limits
```

```text
RootTurnLimits
  max_wall_time_ms
  max_context_bytes
  max_broker_calls
  max_mutations
```

约束：

- `turn_id`只用于当前process、Event和Result correlation，不是工作流ID；
- `root_issue_id`是唯一业务target；契约没有`work_issue_id`或`target_issue_id`；
- `performer_id`必须与Linear Root当前Conversation指针一致；
- `performer_profile_id`选择Root固定Profile和对应`CODEX_HOME`；
- `codex_turn_settings`是该Turn启动时的closed设置快照；
- `execution_policy`是Provider-neutral sandbox mode和command allowlist/denylist快照；
- `root_context`包含完整且有界的Root、Issue Tree、comments/relations和Git摘要；
- `context_digest`只保护当前输入/输出关联，不持久化为Revision或checkpoint；
- `command_channel`是Conductor批准、Performer在当前Root worktree内创建的private、turn-scoped
  broker channel描述，不包含credential；
- `workspace_root`必须是当前Root的deterministic worktree；
- `turn_limits`的四个上限同时生效，任一字段都不能省略或由另一字段替代；

Agent可以通过broker读取或修改Root Tree、提交当前Root worktree、请求delivery。每个command都有
独立remote/Git precondition和read-back；Turn启动时的`root_context`不能让旧snapshot通过最新
precondition。

`workspace_framed_channel`只允许closed schema规定的workspace-relative metadata、request FIFO和
response FIFO路径。Performer在Provider Turn启动前创建并验证channel，只在该channel和Conductor
private process pipes之间转发closed frame，不执行command、不保存workflow state，也不成为mutation
authority。Turn结束、取消或失败时必须关闭并删除全部artifact。absolute path、`..`、symlink、
regular file、credential或可跨Turn复用的capability都不能成为channel。

## 4. Root Turn Result

公共字段：

```text
protocol_version
turn_id
root_issue_id
performer_profile_id
performer_id
context_digest
completed_at
usage?
turn_usage
```

正常结束：

```text
RootTurnCompletedResult
  bounded_summary?
  yield_reason?
```

`yield_reason`可以说明`command_limit_reached`、`waiting_human`、`delivered`或`agent_finished`，只用于观察。
`RootTurnCompletedResult`只表示Provider Turn和Performer process正常结束，不表示Root、Plan、Leaf、
Gate或Delivery已经完成，也不携带下一动作。所有业务效果必须已经通过broker落到Linear/Git并被
read-back。

Conversation不可恢复：

```text
RootConversationUnavailableResult
  error_code: conversation_not_found | conversation_unrecoverable
  sanitized_reason
```

该Result是Root-level retry的唯一Provider触发条件。普通network timeout、rate limit、model错误或
Profile未ready不能伪装成Conversation loss。Conductor只有在Linear Root仍指向Result中的
`performer_id`时才替换Conversation；否则Result已经stale，直接丢弃。

其他失败：

```text
RootTurnFailedResult
  error_code
  sanitized_reason
  retryable
  action_required?

RootTurnCanceledResult
  sanitized_reason
```

可选usage：

```text
PerformerTurnUsageSnapshot
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens

RootTurnUsage
  wall_time_ms
  context_bytes
  provider_tokens
  broker_calls
  mutations
```

token breakdown可以缺失，但`turn_usage`必须存在。`context_bytes`记录launch前发送给Agent的Root
context bytes；`provider_tokens`在完整Provider Turn返回后记录该Turn全部Provider tokens；每个broker request计一次
`broker_calls`，每个提交的mutation request计一次`mutations`，无论结果是成功、冲突或未确认。
Result禁止包含Linear mutation、next state、current Leaf、branch/commit/PR
动作、raw transcript、reasoning、SDK object、Token、Header或任意未声明metadata。

context bytes在Provider调用前验证，超限则不启动Turn。broker call或mutation达到硬上限后，broker
拒绝新的command并让Provider完成当前Turn；若wall time耗尽，Performer取消整个Turn并终止process
tree。Provider token没有中途硬上限：SDK只有在完整Turn返回后才提供usage，Symphony不得声称按精确
token数停止Provider。正常结束和硬取消都把同一个Root重新交给Root scheduler，不产生Leaf dispatch、
retry attempt或半个Turn accounting unit。

## 5. Result验收

Conductor只接受同时满足以下条件的Result：

1. protocol、`turn_id`、Root、Profile、Conversation和`context_digest`与原Command匹配；
2. current Resolved Conductor Project和full `conductor_id`仍匹配；
3. Linear Root仍指向同一个current `performer_id`；
4. Root尚未Done/Canceled；
5. Turn尚未因retry、timeout、shutdown或ownership变化而取消。

即使Result有效，Conductor也只接受usage和bounded process summary。下一次Root eligibility、Human
等待、Work进度、Gate和Delivery全部从新的Linear/Git read-back派生。

当Root已Done/Canceled或current `performer_id`已经替换时，旧process仍可能退出并写Result文件；
Conductor必须丢弃该Result，旧broker request也必须已经被拒绝。

## 6. Conversation loss与retry

```text
RootConversationUnavailableResult
-> cancel the old Turn and terminate its process tree
-> verify Root still points to failed performer_id
-> append one sanitized retry comment
-> openRootConversation with the same pinned Profile
-> compare-and-set new performer_id in Linear
-> read back Root and Git
-> return the Root to Root scheduling
```

retry不携带旧Leaf、旧Turn、旧Result或旧checkpoint。新Conversation收到完整Root Context并审计
保留下来的Tree、branch、commits和worktree diff。

## 7. Provider设置

唯一允许进入公共契约的Provider相关产品DTO：

```text
CodexTurnSettings
  model
  reasoning_effort: none | minimal | low | medium | high | xhigh
  is_fast_mode_enabled
```

Provider-neutral执行DTO：

```text
AgentExecutionPolicy
  sandbox_mode: read_only | workspace_write | unrestricted
  command_allowlist: AgentCommandRule[]
  command_denylist: AgentCommandRule[]

AgentCommandRule
  executable
  argv_prefix[]
```

空allowlist表示允许sandbox mode内除denylist外的命令；非空allowlist要求命中；denylist始终优先。
规则是有界exact executable/argv-prefix match，不支持regex、shell policy language或arbitrary config。
各`ProviderBackendInterface`实现负责映射到Provider-native sandbox/command settings，不能映射时fail
closed。Symphony不维护逐工具RBAC、动态审批流或第二套Provider权限模型。

API Key、Codex auth、`CODEX_HOME`路径、任意Provider config map和SDK type不得进入Command/Result。
用户在当前Turn运行时修改Profile设置不撤销当前Turn；下一次Conversation bootstrap或Root Turn读取
新设置。

## 8. 无Operation控制面

目标架构不定义：

- `StartOperation`、`GetOperationStatus`或Result ACK；
- 按Leaf、Plan、Root Gate或Human input拆分的业务Turn/Result；
- operation journal、attempt、lease或dispatch row；
- `performer-runtime.db`；
- Provider call跨process继续运行的保证。

Profile login和account/status使用独立`PerformerProfileControlProtocol`，不属于Root Turn。

## 9. 不变量

1. Root是Command唯一业务target。
2. Conversation bootstrap没有Linear/Git副作用。
3. current `performer_id`在Linear确认后才能启动有副作用的Root Turn。
4. `performer_id`失效触发Root-level retry，不触发Leaf recovery。
5. Result不决定Linear、Git或下一dispatch。
6. `turn_id`和`context_digest`不是持久工作流状态。
7. 契约是closed schema，Provider类型不得泄漏。
8. 每个Root Turn携带并回显Root固定的Profile和current Conversation。
9. Root Turn以完整Turn为最小执行和记账单位；context launch前校验，wall time取消整个Turn，broker
   calls和mutations限制后续command。
10. Provider token只在完整Turn后观察，不能作为精确中途interrupt或Leaf调度边界。
11. Token usage和turn usage是观察值，不决定业务完成。
12. V4 roles和V5 Provider复用该RootTurn contract，不增加另一套顶层业务Turn。

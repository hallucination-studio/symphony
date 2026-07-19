# Performer Turn Command 与 Result 契约

状态：目标架构提案。本文只定义 Conductor 与 Performer 之间的一次性 Turn 契约，不定义 Linear 工作流、Git 交付或本地恢复数据库。

## 1. 契约模型

Conductor 每次启动一个 Python Performer process，并发送一个 Turn：

```text
PerformerTurnCommand
  = PlanTurnCommand
  | WorkTurnCommand
  | RootGateTurnCommand
```

Performer 返回一个封闭 Result：

```text
PerformerTurnResult
  = PlanReadyResult
  | WorkCompletedResult
  | HumanInputRequiredResult
  | RootGatePassedResult
  | RootGateFailedResult
  | TurnFailedResult
  | TurnCanceledResult
```

`Turn` 是 Symphony 对 Performer 的一次有界调用。Provider内部可以有自己的request/turn名称，但这些类型不能进入公共契约。

## 2. 公共 Envelope

Command 公共字段：

```text
protocol_version
turn_id
turn_kind
root_issue_id
work_issue_id?
performer_profile_id
codex_turn_settings
performer_id?
turn_input_hash
workspace_root
started_at
hard_deadline_at
body
```

Result 公共字段：

```text
protocol_version
turn_id
turn_kind
root_issue_id
work_issue_id?
performer_profile_id
performer_id?
turn_input_hash
completed_at
usage?
body
```

约束：

- `turn_id`只用于当前process、日志和Result关联，不是持久工作流ID；
- `performer_profile_id`选择Root固定的Performer Profile和`CODEX_HOME`；
- `codex_turn_settings`是当前Profile在该Turn启动时的model、reasoning和Fast快照；
- 首次Plan可以不带`performer_id`，成功Result必须返回新ID；
- 首次Plan在Conversation创建前失败或取消时，Result可以没有`performer_id`；
- 后续Turn必须携带同一个opaque `performer_id`；
- Conductor只接受与当前Command的`turn_id`、Root和Work相符的Result；
- Conductor只接受与原始Command和Root固定Profile回显同一
  `performer_profile_id`的Result；不与当前active Profile比较；
- `turn_input_hash`覆盖该Turn的全部业务输入，Result必须回显；
- Result返回后，Conductor重新读取Linear和Git；
- Root已经Done/Canceled、full `conductor_id`不匹配、Resolved Conductor Project变化或远端
  version/state precondition不成立时，不应用Result；
- hash不匹配时不应用Result，而是从最新`RootRunView`重新计算`RootAction`。

可选`usage`使用：

```text
PerformerTurnUsageSnapshot
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens
```

Usage缺失不改变业务Result。API Key、Codex auth、`CODEX_HOME`路径、任意Provider
config map和SDK type不得进入Turn Command/Result。唯一允许的Codex设置是closed
`CodexTurnSettings`产品DTO：

```text
CodexTurnSettings
  model
  reasoning_effort: none | minimal | low | medium | high | xhigh
  is_fast_mode_enabled
```

`codex_turn_settings`不进入`turn_input_hash`。用户在当前Turn运行时修改Profile设置，
不使当前业务Result失效；下一Turn重新读取并携带新值。

## 3. PlanTurnCommand

```text
PlanTurnCommand
  root_issue
    title
    description
  current_tree[]
```

`current_tree[]`包含Root当前所有Workflow Nodes，包括用户手工添加的Sub Issues。
Performer必须在现有Workflow Tree基础上规划，不能假设Tree为空。

Plan Turn的`turn_input_hash`覆盖Root和当前Tree。该Turn只读：可以读取repository和worktree，但不能修改文件。

`PlanReadyResult`：

```text
PlanReadyResult
  summary
  nodes[]

PlannedWorkflowNode
  client_node_key
  parent_client_node_key?
  kind: work | human
  order
  title
  description
  existing_issue_id?
  target_client_node_key?  # human only
```

规则：

- `nodes[]`可以嵌套；
- `client_node_key`在同一个`turn_input_hash`下必须稳定；
- 非叶子`work`表示Work Group；
- `human`必须是Human Node叶子；
- `human.target_client_node_key`必须指向一个Work Node；Conductor把Human Node创建为
  目标Work Node之前的同级节点；
- `existing_issue_id`用于把用户已有Sub Issue纳入Plan；
- Performer不创建Linear Issue，也不创建Plan Approval Node；
- Conductor在接受Plan后reconcile未完成Tree，并额外创建或复用一个Root级Plan
  Approval Node；其Linear title使用`[Human Action] Approve Plan`；
- In Review/Done节点不被Plan改写；新需求需要补充工作时创建新节点；
- 用户创建的无Managed Marker Workflow Node不能被Plan删除或覆盖。

Plan创建marker使用`root_issue_id + turn_input_hash + client_node_key`。同一Result重试
必须复用已有Issue；新Plan必须通过`current_tree.existing_issue_id`复用仍然有效但
只完成部分写入的Symphony-origin Workflow Nodes，不能留下两个同时有效的同身份
Workflow Nodes。

Root title/description变化时，不创建Plan Revision对象。Conductor保留worktree，把最新Root和Tree重新送入同一个`performer_id`，由同一Conversation重新规划。新Plan批准后才继续Work。

首次Plan Result因Root/Tree hash变化而过期时，Conductor不应用其nodes；Root仍非
Done/Canceled时可以保存其中合法的`performer_id`，随后在同一Conversation中重新Plan。

## 4. WorkTurnCommand

```text
WorkTurnCommand
  root_issue
    title
    description
  work_leaf
    identifier
    title
    description
  human_inputs[]
```

`human_inputs[]`只包含与当前Work关联的已解决Human：

```text
human_issue_id
status: answered | canceled
answer?
```

Work Turn只处理当前被Linear Tree解释器选中的一个最深层Work Leaf。

Work Turn的`turn_input_hash`覆盖Root、Work title、业务description、当前`human_inputs[]`和“该Issue仍是叶子”这一结构条件。普通Root/Work Comment和其他Tree节点不进入。

`WorkCompletedResult`：

```text
WorkCompletedResult
  summary
```

`HumanInputRequiredResult`：

```text
HumanInputRequiredResult
  sanitized_prompt
```

Conductor收到Human请求后，把当前Work Leaf退回Todo，并在它之前创建同parent的
Runtime Input Node；其Linear title使用`[Human Action]` prefix，Managed Marker用
`target_work_issue_id`关联原Work Node。用户完成该Runtime Input Node后，Linear遍历
再次选择原Work Leaf，Conductor用同一个`performer_id`启动新的Work Turn，并把准确
回答放入`human_inputs[]`。

Result不能直接把Work置为In Review。Conductor必须先重新读取Work：

- Root仍非Done/Canceled、Work version/state precondition和`turn_input_hash`仍匹配：
  commit当前修改，更新`completed_input_hash`，再把Work置为In Review；
- `turn_input_hash`不匹配：不应用Result，从最新View重新决定重新Plan、重跑Work或重新解释Tree；
- Work已Canceled：不应用完成状态，重新解释Tree。

In Review/Done Work Leaf后来被修改时，Conductor不重新Plan，而是把该Work重新置为
In Progress，并用最新hash启动新的Work Turn。

## 5. RootGateTurnCommand

```text
RootGateTurnCommand
  root_issue
    title
    description
  complete_tree[]
```

Root Gate只判断整个Root Run是否已经满足其目标。它不是Work Node Gate，不创建Gate
Issue，也不运行第二套verification pipeline。

Root Gate的`turn_input_hash`覆盖Root和完整Tree。该Turn只读，不能修改worktree。

通过：

```text
RootGatePassedResult
  summary
```

失败：

```text
RootGateFailedResult
  summary
  findings[]
```

Conductor把findings写入唯一的Root Gate Rework Node：不存在时创建，存在时更新并
重开。完成Rework后再次运行Root Gate。

Gate Result应用前必须重新读取Root和Tree。`turn_input_hash`或Tree完成条件变化时，旧Result失效并从最新View重新决定下一动作。

## 6. 失败与取消

```text
TurnFailedResult
  error_code
  sanitized_reason
  retryable
  action_required

TurnCanceledResult
  sanitized_reason
```

Conductor对失败的处理只由这些封闭字段决定：

- `retryable=true`：保留当前phase和业务节点，append对应error Timeline Event并有界重试；
- `retryable=false`且存在可执行`action_required`：Root进入blocked，等待对应事实修复；
- 当前Root事实下无法安全继续：Root进入failed，并给出取消或修改Root重新Plan的下一动作。

Result禁止包含：

- Linear mutation或next state；
- branch、commit、push或PR动作；
- Token、Header、Provider credential；
- Provider SDK object、raw exception、reasoning或完整transcript；
- 任意未声明metadata。

## 7. 无Operation控制面

目标架构不定义：

- `StartOperation`、`GetOperationStatus`或Result ACK；
- operation journal、attempt、lease或fencing token；
- `performer-runtime.db`；
- Provider call跨process继续运行的保证。

Profile登录和account/status不属于Operation，也不属于Performer Turn；它们通过
`PerformerProfileControlProtocol`和secret pipe执行，见
[Performer Profile与Codex配置](performer-profiles.md)。

Turn中断后，Conductor根据Linear节点状态、Git worktree和同一`performer_id`启动新Turn。恢复单位是Conversation和业务节点，不是旧Python process。

## 8. 不变量

1. 一个Command只执行一个Plan、Work或Root Gate Turn。
2. `performer_id`是唯一Provider continuation信息。
3. `turn_id`不是工作流状态。
4. Result不决定Linear或Git状态。
5. Plan Approval Node由Conductor创建，不由Performer规划。
6. Gate只针对Root。
7. 契约是closed union，Provider类型不得泄漏。
8. `turn_input_hash`只用于防止旧snapshot Result推进，不持久化为Revision。
9. 每个Turn必须携带并回显Root固定的`performer_profile_id`。
10. Token usage是可选观察值，不决定Result variant或Workflow。
11. 每个Turn携带一个closed `CodexTurnSettings`，不允许任意Provider配置。

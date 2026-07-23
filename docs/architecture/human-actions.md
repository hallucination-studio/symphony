# Human Action交互与恢复

状态：目标架构提案。本文是Human Action用户交互、状态、durable facts、恢复和Plan
revision语义的唯一事实源。Stage如何产生挂起请求由
[Stage Orchestration](stage-orchestration.md)定义；Root/Cycle/Node通用状态由
[Root Issue工作流](root-issue.md)定义；Linear读取和mutation ownership由
[Linear端到端流转](linear-flow.md)定义。

## 1. 目标与边界

Human Action把Conductor无法自行决定的业务问题变成一个真实Linear用户可以理解、处理和审计的
工作项。用户不需要输入机器命令、action ID、digest或JSON，也不直接修改Root、Cycle、Plan、Work
或Verify状态。

本设计覆盖：

- Plan review的批准与拒绝；
- Stage缺少需求信息时的补充；
- Stage继续前所需的明确权限或授权；
- Finding waiver和Root convergence override；
- restart、重复输入、stale输入和partial mutation恢复。

本设计不覆盖：

- 通用聊天、任意自然语言意图分类或LLM审批判断；
- 每条shell命令、tool call或Provider操作的交互式审批；
- 用户通过编辑Root/Cycle/Node状态直接驱动内部Workflow；
- 同一Root同时等待多个Human Action；
- Desktop内新增一套独立于Linear的审批authority。

Scope record：

- `authorized`：定义Human Action专用Issue、用户交互、状态、durable records和实现计划。
- `required_consequences`：Plan reject必须supersede旧Contract并fresh replan；approval、info、permission
  和override必须有可恢复的closed resolution。
- `out_of_scope`：本次不实现代码、不运行E2E、不增加Workflow数据库或第二套审批状态。
- `assumptions_requiring_approval`：none。
- `deferred_ideas`：Desktop快捷入口、通知策略、批量审批和更多Human transport。

## 2. 核心决定

每个未解决请求是一个Conductor创建的Linear `human` Issue，称为Human Action Issue：

```text
Root Issue
├── Cycle Issue
│   └── Plan | Work | Verify Node
│       └── Human Action Issue
└── Human Action Issue              # Root-level override only
```

Human Action不是DAG执行节点，不被Conductor调度，也不调用Performer。它是用户交互和审计载体：

| Linear字段 | 所有者 | 用途 |
|---|---|---|
| title | Conductor | 简短动作，例如`Review Plan`、`Provide API scope` |
| description | Conductor | 请求、上下文、影响、明确选项和目标摘要 |
| comments | Human | 拒绝原因、补充信息或解释 |
| status | Human | 表达处理中、完成或拒绝/无法完成 |
| managed marker | Conductor | action、Root、Cycle、target、context和版本关联 |

用户不编辑title、description、parent、labels或managed marker。description保存原始请求，comment保存用户
响应，两者不能合并：如果用户覆盖description，请求与回答的作者、顺序和审计边界会丢失。

Root仍是等待状态的唯一owner。Conductor创建并read-back Human Action后才把Root置为
`Needs Approval`或`Needs Info`。Human Action status表达用户决定；Root status表达Conductor当前是否可继续。

## 3. 用户如何操作

### 3.1 批准

用户打开Human Action，确认description中的完整提案，然后把Human Action从`Todo`或`In Progress`
移动到`Done`。不要求comment；`Done`表示无条件接受description中精确描述的提案。

如果用户只同意修改后的范围，不应先`Done`再写附加条件。用户应写明修改意见并把Action置为
`Canceled`，由Conductor按拒绝语义重新产生一个精确的新提案。

### 3.2 拒绝

用户先在Human Action下写普通comment说明原因，再把Action移到`Canceled`。拒绝comment是必需事实；
只有`Canceled`而没有fresh Human comment时，Conductor保持Root等待并报告
`human_rejection_reason_missing`，不会猜测原因。

### 3.3 补充信息

用户在Human Action下用普通comment回答description中的问题，然后把Action移到`Done`。description必须
列出具体问题、所需格式和信息将影响的Stage；comment是回答。用户无需修改Root或target Node。

如果无法提供信息，用户写明原因并把Action移到`Canceled`。Conductor持久化`unavailable` resolution，
把Root置为`Escalated`，不会用缺失信息继续Stage。

### 3.4 批准权限

Permission Action的description必须是一个closed grant：resource、operation、scope、有效边界、风险和
不批准的影响都明确。用户把Action移到`Done`即批准该精确grant；移到`Canceled`即拒绝。

Permission Action不能扩大已有产品capability，不能变成通用shell/tool逐命令批准，也不能授权读取
secret。若用户要求不同scope，按拒绝处理并由Conductor创建新请求。批准结果只进入下一次fresh
StageContext或matching Conductor mutation，不恢复旧Provider thread。

## 4. Human Action类型

`action_kind`是closed union：

| action kind | Root state | target | `Done`语义 | `Canceled`语义 |
|---|---|---|---|---|
| `plan_review` | `Needs Approval` | Plan Node + Contract digest | 批准该Plan | 拒绝并fresh replan |
| `clarification` | `Needs Info` | Plan/Work/Verify Node | comment作为answer | 信息不可获得，Root escalates |
| `permission` | `Needs Approval` | Plan/Work/Verify Node | 授予精确scope | 拒绝授权，Stage不继续 |
| `finding_waiver` | `Needs Approval` | Verify Node + Finding IDs | waiver accepted | Findings保持open |
| `convergence_override` | `Needs Approval` | Root + breaker record | 应用精确override | breaker保持生效 |

Performer只能返回`needs_info`或`needs_approval`的Stage suspension；Conductor必须把它收敛为上述一个
明确`action_kind`。无法分类的请求fail closed为`human_action_kind_unsupported`，不能创建通用“请确认”项。

## 5. 状态模型

### 5.1 Human Action status子集

Human Action只允许：

```text
Todo -> In Progress -> Done
Todo -> Done
Todo | In Progress -> Canceled
```

| status | 含义 |
|---|---|
| `Todo` | 请求已发布，等待用户处理 |
| `In Progress` | 用户已认领或正在准备答复；Conductor仍等待 |
| `Done` | 用户给出positive resolution；具体语义由`action_kind`决定 |
| `Canceled` | 用户拒绝、无法提供或不接受请求；具体语义由`action_kind`决定 |

`Done`或`Canceled`是terminal。用户重新打开terminal Action不会恢复旧action；Conductor视为
`human_action_terminal_reopened`并进入attention。需要再次交互时必须创建新action ID和新Issue。

### 5.2 Root和target状态

| 场景 | Root | Cycle | target Node | Human Action |
|---|---|---|---|---|
| Plan等待review | `Needs Approval` | `Planning` | Plan `In Review` | `Todo/In Progress` |
| Plan已批准、正在materialize | `In Progress` | `Planning` | Plan `In Review` | `Done` |
| Plan已批准并sealed | `In Progress` | `Sealed` | Plan `Done` | `Done` |
| Plan被拒绝、等待replan | `In Progress` | `Planning` | Plan `In Progress` | old Action `Canceled` |
| Stage等待信息 | `Needs Info` | 保持当前phase | target保持`In Progress` | `Todo/In Progress` |
| 信息已提供、fresh Stage待执行 | `In Progress` | 保持当前phase | target `In Progress` | `Done` |
| 等待permission/waiver/override | `Needs Approval` | 保持当前phase | target不完成 | `Todo/In Progress` |
| 信息不可获得或权限拒绝 | `Escalated` | `Escalated`或保持不可运行 | target不完成 | `Canceled` |

Root不能在没有一个matching non-terminal Human Action时处于`Needs Approval`或`Needs Info`；反过来，
存在non-terminal Action而Root不是matching等待状态也进入`needs_attention`。一个Root最多一个non-terminal
Human Action。

## 6. Action内容

Human Action description必须是稳定的人类可读模板，不包含secret或原始Provider transcript：

```text
Requested action
Why this is needed
Target Root / Cycle / Node
Proposal or questions
Impact if approved or answered
Impact if rejected or unavailable
How to respond in Linear
```

### 6.1 Plan review内容

Plan review必须展示足够信息让用户做真实决定，而不是只显示digest：

- Root objective和本轮trigger；
- included scope与excluded scope；
- assumptions和明确不做的内容；
- acceptance criteria及verification method；
- ordered Work Nodes、dependency和每项可见产物；
- Verify checks和delivery preconditions；
- 主要风险、权限需求和预计影响；
- immutable Plan Contract digest与source Plan execution identity，作为审计信息而非用户输入。

如果这些内容不能在bounded description中完整表达，Conductor不得请求approval；Plan Result应先被拒绝为
`plan_review_content_incomplete`。

## 7. Durable facts

Linear中持久化以下closed records；不存在本地approval table或conversation pointer。

### 7.1 PendingHumanActionRecord

```text
action_id
action_issue_id
action_kind
request_kind: needs_approval | needs_info
root_issue_id
cycle_issue_id?
target_issue_id
target_context_digest
source_stage_execution_id?
target_plan_contract_digest?
target_finding_ids[]?
expected_root_remote_version
expected_target_remote_version
created_at
```

canonical record写在Human Action Issue。Root Primary Status只投影当前`action_id`、`action_issue_id`和
request kind以支持Root header discovery；投影不是第二份authority。

### 7.2 HumanActionResolutionRecord

```text
resolution_id
action_id
action_issue_id
outcome:
  approved | rejected | answered | unavailable |
  granted | denied | waived | override_applied | override_rejected
source_comment_ids[]
source_comment_versions[]
action_terminal_status: Done | Canceled
action_terminal_remote_version
actor_kind: human
target_context_digest
resolved_at
```

Resolution由Conductor在fresh read验证后写入，Linear user comment或status本身不是未经验证的Workflow
authority。稳定`resolution_id`用于幂等read-back；同一action只能有一个resolution。

### 7.3 PlanContractRecord与supersession

每个Plan Contract immutable，并增加来源关联：

```text
plan_contract_digest
source_plan_execution_id
predecessor_plan_contract_digest?
```

同一Plan Node允许多份按execution关联的Plan Contract；active Contract是存在review Action且尚未被
supersede的唯一Contract。拒绝时追加：

```text
PlanContractSupersessionRecord
  superseded_plan_contract_digest
  rejected_by_resolution_id
  replacement_plan_execution_id
  superseded_at
```

旧Contract、旧execution、旧Action和用户reason永久保留，但不能再次成为active Plan或materialization输入。

## 8. Plan批准与拒绝

### 8.1 Approve durable chain

```text
Plan execution completed
-> persist immutable Plan Contract(source execution + digest)
-> Plan In Review
-> create plan_review Human Action Todo under Plan
-> read back Action marker/description/status
-> Root Needs Approval

user moves Action to Done
-> fresh read Action transition and optional comments
-> validate Human actor, target, digest, ordering and no prior resolution
-> persist HumanActionResolution(approved)
-> read back resolution
-> Root In Progress
-> materialize exact Work/Verify graph from approved digest
-> read back complete graph
-> Plan Done + Cycle Sealed
```

批准不要求用户写`Approved`、action ID或digest。Action `Done`状态就是明确选择。

### 8.2 Reject -> supersede -> fresh replan durable chain

```text
user writes rejection reason on plan_review Action
-> user moves Action to Canceled
-> fresh read terminal Action + complete comments
-> validate Human actor, reason freshness, target execution/Contract and no prior resolution
-> persist HumanActionResolution(rejected, source comment)
-> read back resolution
-> allocate deterministic fresh replacement Plan execution ID
-> persist PlanContractSupersession(old digest, resolution, replacement execution ID)
-> read back supersession
-> Root In Progress + Plan In Progress; Cycle remains Planning
-> build fresh PlanContext with Root goal, old Contract and rejection feedback
-> append fresh StageExecutionRecord
-> invoke a fresh isolated Plan Performer context
-> persist a new immutable Plan Contract with predecessor digest
-> create a new plan_review Human Action with a new action ID
-> Root Needs Approval
```

新Plan必须真正响应用户反馈。它不能只复制旧Contract并更换digest；Conductor把rejection comment作为
bounded `resolved_human_input`和attempted approach注入fresh PlanContext，Verify/Work仍不能启动。

partial failure可恢复：如果resolution已写但supersession未写，restart继续写supersession；如果
supersession已写但replacement execution缺失，restart按record中的确定性ID创建execution；旧Action或旧
comment永远不能批准新Contract。

## 9. Clarification、permission和override恢复

### Clarification

`Done`必须同时有至少一个晚于Action创建的Human comment。Conductor写`answered` resolution，把comment
作为下一次fresh StageContext的`resolved_human_input`；旧Stage execution保持terminal suspended。

### Permission

`Done`写`granted` resolution并绑定description中的exact permission scope；下一次fresh Stage只获得该scope。
`Canceled`写`denied`，target不继续并进入bounded escalation。不得把comment中的附加文字解释为隐式扩大scope。

### Finding waiver

Action必须列出完整Finding IDs、证据、风险和waiver影响。`Done`写`waived` resolution及matching
FindingDispositionRecord；`Canceled`保持Findings open。waiver不改变Git evidence。

### Convergence override

Action必须引用触发的breaker record和一个closed override proposal，例如新的deadline或token ceiling。
`Done`只应用该proposal并写`override_applied`；`Canceled`保持breaker生效。不存在自由文本override。

## 10. 验证与fail-closed规则

Conductor只接受：

- action属于当前Project、Root和target；
- action marker、parent和`action_kind`一致；
- terminal status transition由Human actor完成；
- required comment由Human actor写入且晚于Action创建；
- target context、Plan digest、Finding IDs和remote versions仍匹配；
- action没有resolution，Root没有另一个pending action；
- comments和Issue history已完整分页读取。

普通target Node comment、Root comment、emoji、reaction、title/description编辑和Root状态修改都不是Human
resolution。ambiguous、stale、duplicate、reopened或冲突输入不推进Workflow，产生脱敏且可执行的
attention reason。

## 11. Contract和ownership影响

Podium继续独占Linear SDK和credential。Podium通过closed contract向Conductor提供：

- Human Action Issue identity、kind、parent、status和remote version；
- terminal status transition timestamp与`actor_kind`；
- bounded comments及comment author kind/version/timestamp；
- complete pagination proof。

Conductor拥有action materialization、validation、resolution、supersession和fresh Stage selection。Performer
只能提出suspension，不创建Action、不等待用户、不读取Linear。Desktop只投影pending Action摘要和Linear
deep link，不成为approval authority。

## 12. 实施计划

每项是一个独立commit，完成并验证后再进入下一项：

1. **Contracts and codecs**：增加Human Action Issue snapshot、Human author/transition facts、
   `PendingHumanActionRecord`、`HumanActionResolutionRecord`和`PlanContractSupersessionRecord`。
2. **Action materialization**：Conductor创建一个target-scoped Human Action Issue并维护Root pending投影；
   证明同一Root最多一个pending action。
3. **Plan approval**：用Action `Done`替代“任意comment即批准”，持久化approved resolution后才materialize。
4. **Plan rejection and replan**：实现reason校验、Contract supersession、deterministic replacement execution、
   fresh PlanContext和新review Action。
5. **Clarification**：comment + `Done`形成answered resolution并只注入fresh Stage。
6. **Permission**：实现closed grant、granted/denied resolution和scope-bound fresh capability。
7. **Waiver and override**：实现Finding waiver与convergence override的closed proposal。
8. **Projection and UX**：Desktop只显示pending摘要、状态、action kind和Linear deep link。
9. **Boundary verification**：补真实Linear author/status history boundary证据、restart tests和之后恢复的并行E2E。

每项先写失败测试；focused checks后运行Conductor tests、contracts validation、lint、typecheck和build。第9项
才恢复credentialed E2E，仍受一个300000ms绝对deadline约束。

## 13. 不变量

1. 用户通过Human Action status做决定，通过comment提供内容；不输入机器命令。
2. Root是`Needs Approval`/`Needs Info`唯一state owner，Human Action是唯一交互载体。
3. 同一Root最多一个non-terminal Human Action，同一action最多一个resolution。
4. 所有resolution、supersession和replacement execution都可仅从Linear恢复。
5. Reject永远产生fresh Plan execution、fresh Provider context、fresh Contract和fresh Action。
6. 旧Contract、Action、comment和execution保留审计，但不能被新决策复用。
7. User comment不直接成为Workflow authority；Conductor验证并写closed resolution后才推进。
8. Human Action不能扩大产品capability、读取secret或绕过Root convergence gate。
9. Performer不调用Conductor、不等待Human，也不恢复旧thread。
10. Desktop不是第二个approval authority。

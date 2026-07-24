# Human Action交互与恢复

状态：目标架构提案。本文是Human Action Issue层级、labels、用户交互、状态、resolution和恢复语义的唯一
事实源。Cycle和Root Action内容、后续语义与materialization由
[Root Reconciliation](root-reconciliation.md)控制。

## 1. 目标

Human Action把Agent无法自行决定的业务问题变成真实、可分配、可流转、可审计的Linear Issue。用户只需要
阅读请求、写普通评论并改变Action状态，不输入JSON、command、action ID或digest，也不直接操作内部
Plan/Work/Verify状态。

Human Action覆盖：

- Plan review批准或拒绝；
- 补充信息；
- 授予或拒绝精确权限；
- Finding waiver；
- convergence override；
- 用户主动改变目标、scope或执行要求后的确认与恢复。

## 2. Issue层级与links

Human Action是独立Issue，不是Plan/Work/Verify的child，也不是可执行DAG node：

```text
Root Issue
├── Cycle Issue
│   ├── Plan Issue
│   ├── Work Issues
│   ├── Verify Issue
│   └── Human Action Issues
└── Root Human Action Issues
```

- Cycle相关Action是Cycle直接子Issue，并通过relation链接相关Plan、Work或Verify；
- Root全局Action是Root直接子Issue；
- Action拥有自己的assignee、description、comments、status、archive flag和审计历史；
- Action不参与Work DAG ready/dependency计算，不被Plan/Work/Verify executor dispatch；
- archived Action仍属于完整Root Tree；已有session通过delta获知，fresh session通过bootstrap获知。

## 3. Labels与Project初始化

Project初始化必须创建并验证以下managed labels：

```text
Human Action
Plan Review
Clarification
Permission
Finding Waiver
Convergence Override
```

每个Action必须有`Human Action`和恰好一个kind label。Label只表达Issue/action kind，不表达生命周期或
resolution；生命周期只由Action status和原生archive flag表达。用户造成的缺失、重复或错误kind label作为
mechanical violation进入Root Reconciler；Conductor不能根据title猜测类型或主动修正。

## 4. 状态模型

### 4.1 Approval Action

```text
Todo -> In Progress -> Approved | Rejected | Canceled
Todo -> Approved | Rejected | Canceled
```

适用于`plan_review`、`permission`、`finding_waiver`和`convergence_override`。

| status | 用户含义 |
|---|---|
| `Todo` | 尚未处理 |
| `In Progress` | 已认领或正在评估 |
| `Approved` | 无条件接受description中的精确提案 |
| `Rejected` | 明确拒绝提案；必须有fresh reason comment |
| `Canceled` | 请求已失效或无需继续，不等于批准或拒绝 |

### 4.2 Clarification Action

```text
Todo -> In Progress -> Answered | Canceled
Todo -> Answered | Canceled
```

| status | 用户含义 |
|---|---|
| `Answered` | comment中已经提供请求的信息 |
| `Canceled` | 无法或不再需要提供信息 |

`Approved`、`Rejected`、`Answered`和`Canceled`都是terminal Action lifecycle。恢复旧terminal Action不恢复旧
workflow；需要新的交互时创建新Action。原生archive flag独立于status：archive保留terminal或当前status，
但使Action退出active Tree membership；restore后仍需Root Reconciler决定是否创建新Action，不能隐式重放旧结果。

## 5. 用户如何操作

### 5.1 Approved

用户阅读description中的完整提案，将Action移到`Approved`。comment可选；`Approved`表示接受原提案，评论
不能附加条件或悄悄改变scope。有条件同意应使用`Rejected`并写清希望如何修改，由Root Reconciler基于reason
形成新的Plan、DAG patch或Action。

### 5.2 Rejected

用户先写普通comment说明原因，再将Action移到`Rejected`。用户不需要结构化reason。

若Action已进入`Rejected`但没有符合时序和author要求的reason comment：

```text
preserve original Action as Rejected
-> do not approve, supersede Plan or advance Work
-> pass missing-reason fact to Root Reconciler
-> Root Reconciler normally requests a linked Clarification Action
-> Root remains waiting until a valid resolution path is durable
```

Conductor不能从title、其他Issue comment或模型猜测拒绝原因。

### 5.3 Answered

Clarification description列出明确问题、为什么需要、期望内容和回答后的影响。用户在Action下写普通comment，
再将其移到`Answered`。没有fresh answer comment的`Answered`不产生answer resolution，并按missing-answer fact
交给Root Reconciler处理。

### 5.4 Canceled

`Canceled`表示本次请求已失效或用户无法完成，不等于`Rejected`。后续由Root Reconciler决定：
可以换方法、创建新Action、调整DAG或结束Cycle。Root convergence Action被取消后，Root gate继续生效，
不能自动恢复执行。

## 6. Action description contract

`RequestHumanActionDirective`必须提供足够语义，Conductor再以固定模板渲染description：

```text
Requested action
What is being reviewed or requested
Target Root / Cycle and linked Plan / Work / Verify
Relevant proposal, evidence and risk
Available terminal statuses and exact meaning
Whether a comment is required
What happens after Approved / Rejected / Answered / Canceled
```

Action必须让用户无需阅读Provider transcript即可做决定。description不能包含secret、raw reasoning、内部command
或要求用户输入机器标识。内容超过bound时，Root Reconciler必须缩小请求；仍不合法则directive失败并写matching
Linear managed failure record。Conductor不能创建内容
不完整的审批。

## 7. Durable records

### 7.1 HumanActionRequestRecord

```text
action_id
action_issue_id
action_kind
parent_scope: root | cycle
root_issue_id
cycle_issue_id?
related_issue_ids[]
source_root_directive_id?
source_root_convergence_record_id?
based_on_tree_digest?
proposal_digest
expected_parent_remote_version
created_at
```

canonical record写在Action Issue managed comment。Root waiting status由matching active Action机械约束；Root Control
Record Comment不复制Action identity、status或resolution。

### 7.2 HumanActionResolutionRecord

```text
resolution_id
action_id
action_issue_id
action_kind
outcome:
  approved | rejected | answered | canceled |
  granted | denied | waived | override_applied | override_rejected
terminal_status
terminal_remote_version
source_comment_ids[]
source_comment_versions[]
actor_kind: human
proposal_digest
resolved_at
```

Conductor从fresh Linear facts验证actor、source version、Action scope和schema，再把status/comment及proposal事实
作为delta交给Root Reconciler。Root Reconciler通过`RootDirective.human_action_resolutions[]`决定是否形成record；
Conductor只验证matching status、comment requirement、proposal digest和无既有resolution后写入并read-back。
同一Action最多一个resolution；status本身是用户选择事实，resolution是Root Reconciler接受该输入的不可变证据。

Action下的普通human comment也会按Root Reconciliation规则得到reply，但在matching terminal status和
`HumanActionResolutionRecord`成立前，Root Reconciler不能仅凭评论文本产生Approved、Rejected或Answered后果。

## 8. Materialization与Root Reconciler恢复

### 8.1 创建Cycle Action

```text
Root Reconciler returns request_human_action directive
-> Conductor validates parent scope, links, labels and description completeness
-> create Human Action as direct child of Cycle
-> create relations to relevant Plan/Work/Verify
-> append HumanActionRequestRecord
-> read back Issue, labels, relations, status and marker
-> project Root to Needs Approval or Needs Info
-> stop dispatching the blocked Cycle path
```

Cycle Action只能来自matching Root Reconciler directive。Plan、Work和Verify只能返回typed需要事实，
不能直接创建Action或提供未经Root Reconciler选择的用户交互。

### 8.2 处理结果

```text
user changes Action status/comments
-> webhook wakes Root Reconciliation
-> fresh read complete Action and Root Tree, including archived Issues
-> derive delta from the current session baseline
-> advance the same Root Reconciler thread with delta, or bootstrap a fresh one after recovery
-> Root Reconciler chooses the next directive
-> if valid, materialize and read back HumanActionResolutionRecord with the directive
```

Conductor不硬编码“Approved后执行Work”或“Rejected后replan”。具体下一步必须由Root Reconciler基于thread baseline
和本轮delta决定，但Conductor仍机械执行Plan Contract、permission、budget和status schema约束。

## 9. Plan review durable facts

Plan Contract immutable。Plan Thread每次completed turn产生新的Plan Result和Contract digest；Root Reconciler决定是否
请求review。

```text
Plan Result durable
-> Root Reconciler requests Plan Review Action
-> Conductor creates Cycle child Action linked to Plan

Approved resolution durable
-> resolution enters the next Root delta
-> Root Reconciler may materialize proposed DAG and continue Work

Rejected resolution with reason durable
-> resolution enters the next Root delta
-> Root Reconciler may supersede old Contract and request a fresh Plan turn
-> fresh Plan Result has new execution ID and Contract digest
-> any new review uses a new Action
```

旧Contract、旧Action、reason、supersession和所有Result永久保留。原生archive可以把不再active的Plan/Action
移出active Tree，但archive/current value必须进入下一份delta；fresh session bootstrap仍包含它们。

## 10. Permission与capability

Permission Action description必须定义resource、operation、scope、有效边界、风险和拒绝影响。批准只产生
closed grant；不能扩大产品本身不支持的capability、读取secret或变成任意shell/tool许可。

Permission resolution进入下一份delta后由Root Reconciler选择下一步。Conductor只在matching turn request中授予精确
capability，并再次验证当前Root/Cycle/target和grant digest。

## 11. Archive、stale与冲突

- archived Action和linked archived targets始终进入Conductor完整读取、Root delta或fresh bootstrap；
- archive不是resolution，不能把Todo/In Progress视为Canceled；
- restore不是reopen，不能重放旧resolution；
- stale status/comment、非Human actor、旧proposal digest、重复terminal transition不推进workflow；
- 用户修改Root/Cycle/DAG或Action期间产生的旧Root directive在digest检查时被拒绝；
- relation或parent冲突使matching Root fail closed并写Linear timeline，不能按title或时间猜测target。

## 12. 不变量

1. Cycle Human Action是Cycle直接子Issue，只link相关Plan/Work/Verify。
2. Root全局Human Action是Root直接子Issue。
3. 用户用专用status表达结果，用普通comment提供reason或answer。
4. Project初始化创建并验证Human Action kind labels和专用statuses。
5. Cycle和Root Action内容及后续语义由Root Reconciler决定；Conductor拥有materialization和校验。
6. Rejected必须有reason，Answered必须有answer，Approved不要求comment。
7. 原生archive flag不删除Action、comment、resolution或links；完整Tree始终包含archived facts。
8. Human Action不能绕过Plan Contract、Root convergence gate或产品capability。

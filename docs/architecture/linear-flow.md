# Linear端到端流转、全Root调度与SDK所有权

状态：目标架构提案。本文描述一个Binding内所有Root Issues如何从Linear进入Conductor、如何排序，以及谁拥有Linear SDK调用。

## 1. Linear SDK所有权

Podium是唯一Linear SDK所有者：

```text
Conductor
  -> LinearGatewayInterface
     <- PodiumLinearGatewayClientImpl
        -> private Podium-Conductor protocol
           -> LinearGatewayProtocolHandlerImpl
              -> LinearSdkImpl
                 -> Linear
```

| 职责 | 所有者 |
|---|---|
| OAuth、refresh token、access token | Podium |
| Linear SDK client和GraphQL/SDK类型 | Podium |
| Project Catalog、Conductor Identity、Conductor Binding | Podium |
| Resolved Conductor Project | Conductor Project Label |
| Root发现、Tree解释、调度决策 | Conductor |
| Issue/Comment/Label/state mutation决策 | Conductor |
| mutation实际SDK调用 | Podium `LinearGatewayProtocolHandlerImpl` / `LinearSdkImpl` |
| Provider SDK | Performer |

Conductor不接触Token、Linear SDK类型、GraphQL字符串或refresh lifecycle。Podium不解释
Workflow Tree、不选择Root或Work Node。

## 2. 登录与Project选择

```text
Podium Desktop
-> Linear OAuth
-> Podium stores credential in podium.db
-> paginate accessible Projects
-> user selects Project + Repository Context
-> create stable conductor_id
-> add symphony:conductor/<short-hash> to selected Project
-> store Conductor Binding
-> Desktop starts Conductor
```

一个Conductor拥有稳定full `conductor_id`和一个Repository Context。
Resolved Conductor Project不由Podium数据库指定，而由Conductor Project Label指定：

```text
symphony:conductor/<short-hash>
```

Conductor Short Hash从Conductor ID确定性生成，并在当前installation内做唯一性检查。
Podium保存Token、Conductor Identity和Conductor Binding；Conductor无数据库。

## 3. LinearGatewayInterface

Conductor只依赖封闭、分页的业务DTO：

```text
LinearGatewayInterface
  ResolveConductorProjectQuery
  ListRootIssuesQuery
  GetIssueTreeQuery
  ListRootUsageQuery
  LinearMutationCommand
    CreateManagedNodeCommand
    UpdateManagedNodeCommand
    UpdateIssueStateCommand
    ReorderIssueNodeCommand
    ReplaceRootPhaseLabelCommand
    UpsertRootManagedCommentCommand
```

`LinearMutationCommand`是closed union，不是任意mutation入口。返回类型不包含SDK
object、Token、Header或arbitrary GraphQL data。所有外部内容在Podium边界完成shape、
organization、project、size和pagination验证。

## 4. Resolved Conductor Project解析

Conductor每个轮询周期先执行`ResolveConductorProjectQuery(short_hash)`：

- 恰好一个Project带该Label，且该Project没有第二个Conductor Project Label：
  返回该`ResolvedConductorProject`；
- 没有Project匹配：Conductor是`unbound`，不扫描或修改任何Root；
- 多个Project匹配：`conductor_project_ambiguous`；
- 一个Project存在多个Conductor Project Labels：`conductor_project_label_conflict`。

Label变化在下一个Turn边界自然生效，不创建Conductor Binding版本对象或迁移状态。
active Turn不被抢占；Result应用前必须重新解析Label并确认Root仍属于当前Project，
否则旧Result不推进。

所有Project级Gateway mutation携带：

```text
conductor_short_hash
expected_project_id
```

`LinearGatewayProtocolHandlerImpl`把Conductor Project Label、Project remote version和
目标Issue remote version作为同一个Gateway Command的precondition。任一事实已变化时返回
`linear_precondition_conflict`或`conductor_project_resolution_changed`且不写Linear。
Conductor不复用该Snapshot。

Root Managed Comment保存full `conductor_id`。Conductor只恢复自己claim的Root；
Resolved Conductor Project变化后，新Conductor不能接管旧Root。Label移回原Conductor
时，原Root可继续。

### Conductor Project Label移动语义

移动Conductor Project Label只改变“下一轮扫描哪个Project”，不会迁移Root、branch、worktree或
Conversation：

- 旧Project中由该Conductor拥有的非终态Root暂停，保留原状态；
- 新Project中的eligible Root可以由同一Conductor开始处理；
- 旧Root不会被新Conductor接管；
- 用户把Label移回旧Project后，原Conductor从Linear和Git恢复旧Root；
- 多Project匹配或一个Project有多个Conductor Project Labels时，Conductor不扫描任何Root。

Podium把`last_resolved_project_id`和Project Resolution conflict原因保存为runtime
observation，只用于Desktop显示和恢复提示，不作为Resolved Conductor Project权威。
Label移动时若旧Project仍有已知
Active Roots，Desktop明确显示这些Root已暂停，并提示用户移回Label才能继续。该观察
可以过期，Conductor每轮仍以Linear Label为准。

## 5. 无checkpoint读取

Conductor不保存polling checkpoint。每个调度周期通过Gateway完整分页读取：

- delegated Root candidates；
- Root Priority、project/list order和blocker relations；
- active Root的完整descendant Tree；
- Root Managed Comments和Root Phase Labels。
- managed terminal Roots的Profile、delivery和usage摘要。

这是用额外Linear read换取无DB和无增量状态。Podium可以做单次请求内缓存和rate-limit合并，但不能把缓存变成Workflow权威。

## 6. Root识别

Root candidate必须：

```text
project_id == resolved_project.id
parent_issue_id is null
delegated/assigned to Symphony app user
state not Done/Canceled
```

已经带`symphony:run/*` Label的Root是active/recoverable Root。没有Label的eligible Root可以被claim：

```text
Root -> In Progress
create Root Managed Comment
write full conductor_id
write active performer_profile_id
set symphony:run/planning
start/resume performer_id
```

同一个Root Managed Marker重复观察只返回现有Root Run。
没有ready active Performer Profile时，Conductor不claim新Root；这不是Root blocker，
而是Conductor级`NextActionView`。

## 7. Blocker eligibility

Linear原生`blockedBy/blocks`是唯一Root依赖：

- 任一`blockedBy` target未Done：Root不可运行；
- blocker Priority更低也必须先完成；
- dependency cycle中的Roots全部blocked；
- active Turn不因新blocker被强制抢占，当前Turn结束后重新判断；
- Root Gate/Delivery也必须在最新blocker检查后继续。

Conductor不保存dependency graph；每个周期从Linear relations重建。

## 8. Root排序

对`eligible=true`且存在runnable `RootAction`的Roots排序：

```text
1. Linear Priority
   urgent -> high -> normal -> low -> no_priority
2. Linear Project/List order
3. issue identifier as stable tie-breaker
```

不使用本地FIFO、aging、ready sequence或Queue。用户修改Priority或Linear顺序后，下一个Turn边界生效。正在运行的Turn不被抢占。

## 9. 调度单位

Conductor同时最多启动一个Performer Turn。每个Root通过当前Linear事实产生一个
`RootAction`：

```text
ClaimRootAction
PlanRootAction
WaitForHumanNodeAction
ExecuteWorkLeafAction
RunRootGateAction
DeliverRootAction
IdleRootAction
BlockedRootAction
```

等待Human的Root没有runnable Performer action，因此调度器可以选择其他Root。

一个调度周期：

```text
resolve Project by Conductor Project Label
-> list Roots
-> check blockers
-> reconstruct RootRunView
-> compute RootAction
-> sort eligible `RootAction` instances
-> execute first action
-> discard in-memory snapshots
```

## 10. 单Root解释边界

Linear Gateway必须返回完整parent、sibling order、state、title、description、Comments和
Managed Marker。Conductor按最新Workflow Tree解释单Root，不使用API返回顺序或本地排序。

单Root内部规则由[Root Issue工作流](root-issue.md)唯一规定：

- Root变化重新Plan；
- Work Leaf或关联Human Node输入变化只重跑该Work；
- 普通Comment不驱动Workflow；
- Work Node/Human Node顺序完全服从Linear；
- Root Gate通过后才交付。

本文不重复Workflow Tree遍历、Human Node和Root Gate状态机。

## 11. Mutation规则

Conductor产生封闭Gateway Command，Podium执行SDK调用：

- Managed Marker使create幂等；
- Project级mutation验证`conductor_short_hash + expected_project_id`；
- 修改已有对象时验证`expected_updated_at`、预期state/parent和Managed Marker；
- update timeout后Gateway先read-back；
- `ReplaceRootPhaseLabelCommand`只替换Root Phase Label；
- 用户拥有Root Issue和`origin: user` Work Node的title/description；
- Conductor只更新Symphony-origin Workflow Nodes、Root Phase Label、Root Managed Comment和
  Work Managed Metadata；
- Root Managed Comment中的Profile ID和usage字段只由Conductor更新；
- timeout后先read-back，不盲目重复mutation。

`linear_precondition_conflict`不是失败状态：Conductor丢弃Snapshot并从最新Linear事实
重新计算。可重试SDK错误保留当前phase、记录安全原因并有界重试；需要用户修复的错误
进入blocked；只有当前事实下无法安全继续的终止性错误才进入failed。任何错误都不能
假装节点或交付已经完成。

## 12. 全流程

```text
Podium login/select Project and attach Conductor Project Label
-> Conductor resolves Project from Conductor Project Label
-> Conductor selects ready active Performer Profile
-> Conductor full-scans Root candidates
-> blocker filter
-> Priority + Linear order selection
-> claim Root
-> Plan creates ordered/nested Workflow Tree
-> user approves
-> depth-first leaf Turns
-> Root Gate
-> delivery
-> Root In Review
-> user Done
```

## 13. 不变量

1. Podium是唯一Linear SDK/Token所有者。
2. Conductor是唯一Workflow决策者。
3. Performer永不调用Linear。
4. Conductor没有数据库，也不保存checkpoint、dispatch或operation Queue。
5. Root Priority不能绕过blocker。
6. Linear order是Root和Tree的用户排序输入。
7. active Turn不被Priority/order变化抢占。
8. 所有SDK response和用户内容都是不可信输入。
9. Root变化重做Plan，Work Leaf变化只重跑该Work。
10. input hash是覆盖式消费位置，不是Revision历史。
11. Resolved Conductor Project只由Conductor Project Label决定。
12. Root的full `conductor_id`不匹配时禁止接管。
13. 旧Issue Snapshot不能覆盖用户更新后的state、parent或内容。
14. Conductor Project Label移动暂停旧Project Root，不迁移或转移其所有权。
15. 新Root只有在active Performer Profile ready时才可claim。
16. Root claim后固定`performer_profile_id`，active Profile切换不迁移已有Root。
17. `ListRootUsageQuery`只服务Desktop指标，不参与Root eligibility或排序。

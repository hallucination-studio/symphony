# Linear端到端流转、全Root调度与SDK所有权

状态：目标架构提案。本文描述一个Binding内Root Issues如何从Linear进入Conductor、如何按Root排序，
以及谁拥有Linear SDK调用；单Root内部工作由[Root Issue工作流](root-issue.md)定义。

## 1. Linear SDK所有权

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
| OAuth、refresh/access token | Podium |
| Linear SDK、GraphQL/SDK类型 | Podium |
| Project Catalog、Conductor Identity/Binding | Podium |
| Resolved Conductor Project | Linear Project上的Conductor Project Label |
| Root发现、readiness和排序 | Conductor |
| Root内部Plan/Work/Human/Gate意图 | 当前Root Agent，经Harness约束 |
| Root scope、remote/Git precondition和mutation read-back | Conductor |
| mutation实际SDK调用 | Podium |
| Provider SDK | Performer |

Conductor不接触Token、SDK type或GraphQL。Podium不解释Root Tree、不选择Root/Leaf，也不把缓存或
`podium.db`记录变成Workflow authority。

## 2. Project绑定

Podium完成OAuth、Project catalog和Binding创建；Linear Project上的Label决定当前Project：

```text
symphony:conductor/<short-hash>
```

Conductor每个poll/Turn边界重新执行`ResolveConductorProjectQuery`：

- 唯一Project且没有第二个Conductor Label：返回Resolved Project；
- 无匹配：`unbound`；
- 多Project匹配：`conductor_project_ambiguous`；
- 一个Project有多个Conductor Labels：`conductor_project_label_conflict`。

Project级mutation携带`conductor_short_hash + expected_project_id`和remote precondition。Label移动只
改变下一个周期扫描哪个Project，不迁移Root、Conversation、branch或worktree。旧Project Root暂停；
Label移回后从Linear/Git继续。

## 3. LinearGatewayInterface

Conductor只依赖closed、分页、业务DTO：

```text
LinearGatewayInterface
  ResolveConductorProjectQuery
  ListRootIssuesQuery
  GetIssueTreeQuery
  GetIssueCommentsQuery
  GetIssueRelationsQuery
  ListRootUsageQuery
  LinearMutationCommand
    CreateManagedChildCommand
    UpdateManagedChildCommand
    UpdateIssueStateCommand
    UpdateIssueAssigneeCommand
    UpdateIssueLabelsCommand
    ReorderIssueNodeCommand
    UpsertRootManagedCommentCommand
    AddManagedCommentCommand
```

没有arbitrary GraphQL或arbitrary mutation入口。Gateway验证organization、Project、shape、pagination、
payload大小和remote version，返回值不包含SDK object、Token、Header或任意metadata。

## 4. 无checkpoint读取

Conductor不保存poll cursor或Workflow checkpoint。每个调度周期按三层读取：

1. 完整分页发现delegated、非终态Root headers，包括Root identity/state、Priority、Linear order、
   delegation、`updated_at`、blocker references和bounded Root Primary Comment snapshots；不在这一层
   读取任何Root descendants、phase、Human answers或完整active Root Trees。
2. 按blocker、Priority、Linear order和identifier排列headers，再按顺序懒加载候选Root的完整分页
   Tree、必要comments/relations、Primary Status、evidence和Git摘要，直到找到可运行候选。
3. dispatch前对选中Root再次fresh读取header、完整Tree、blockers、Primary/evidence和Git HEAD，重新
   计算readiness。任何变化或partial read都丢弃该候选并继续正常调度。

Podium可以在单次请求或rate-limit窗口内做request coalescing和memory cache以减少读取。缓存只优化
I/O；不能决定Root readiness、mutation scope、current Conversation、remote precondition或业务完成。

## 5. Root识别与claim

Root candidate：

```text
project_id == resolved_project.id
parent_issue_id is null
delegated/assigned to Symphony app user
state not Done/Canceled
```

Root Primary Status Comment中的full `conductor_id`是Root ownership事实。未claim Root只有在active
Performer Profile ready时按以下顺序claim：

```text
Root -> In Progress
-> create deterministic branch/worktree
-> create Root Primary Status Comment with conductor/profile identity
-> open a side-effect-free Provider Conversation
-> compare-and-set current performer_id
-> read back Root
-> make Root runnable
```

activity projection Label不能用于识别Root是否active。重复claim通过Root marker和remote precondition
返回既有Root；另一个Conductor的full ID不匹配时禁止接管。

## 6. Blocker与readiness

Linear原生`blockedBy/blocks`是唯一Root依赖。任一blocker未Done时Root不可运行；dependency cycle中
的Roots都进入`needs_attention`。Priority不能绕过blocker。

对每个已懒加载的候选Root从最新Root/Tree/Git纯计算：

```text
runnable
waiting_human
needs_attention
terminal
```

等待Tree中当前Human child的Root释放Agent lane。readiness不包含Plan、ExecuteWork、RunGate、Deliver
或target Leaf；它不是Workflow directive或持久state。

active Turn不因新blocker、Priority或order变化被强制抢占，但每个broker mutation和Turn结束read-back
都会验证Root ownership/terminal state。新的blocker至少在下次Root dispatch前生效；delivery必须再次
检查blockers。

## 7. Root排序

Root headers先按以下顺序排列；Conductor再按该顺序懒加载并评估候选：

```text
1. Linear Priority
   urgent -> high -> normal -> low -> no_priority
2. Linear Project/List order
3. issue identifier as stable tie-breaker
```

首个通过dispatch前fresh read的`runnable` Root获得Turn。不使用本地FIFO、aging、ready sequence、
Leaf Queue或dispatch table。用户修改Priority和Linear顺序后，下一个Root Turn边界生效。

## 8. 调度单位

Root是唯一调度单位。V3单机Conductor同时最多运行一个Root Turn：

```text
resolve Project
-> full-page Root headers
-> sort headers by blockers, Priority and Linear order
-> lazily load and assess candidate Trees in that order
-> fresh-read the selected complete Root Tree and Git facts
-> start/resume the selected Root Conversation
-> run one bounded Root Turn
-> read back Linear/Git
-> discard views, assessment and Result
```

Root Turn输入包含整个Root Context，不包含`work_issue_id`/`target_issue_id`。Leaf只是Root Agent通过
Linear Tree解释和更新的工作结构。

## 9. Root内部解释边界

Gateway返回parent、sibling order、native state、title、description、assignee、comments、relations和
Managed Markers。Root Agent在trusted Harness下：

- 创建/更新Plan和Plan Approval child；
- 按Linear order处理Work/Human children；
- 把重要完成证据写入Linear/Git；
- 执行Root Gate并通过Rework child表达findings；
- 请求Conductor-owned delivery。

Conductor执行Root scope、precondition、idempotency和read-back，不保存next Leaf或把Agent Result
翻译成业务transition。普通Linear文本是untrusted context，不能扩大mutation scope。

## 10. Mutation语义

所有mutation：

- 验证current Conductor Project和full `conductor_id`；
- 验证Turn、Root和current `performer_id`；
- target必须是Root或其当前descendant；
- 验证`expected_updated_at`、预期state/parent和必要Git HEAD；
- create/comment使用稳定`write_id`和Managed Marker；
- timeout/connection loss后先semantic read-back；
- precondition冲突丢弃旧snapshot并返回最新事实摘要；
- 不允许覆盖全labels的模糊写或任意parent跨Project移动。

Symphony-created child只能在未完成且marker匹配时由Harness reconcile；用户创建的业务内容不由
Harness改写。Root Primary Status Comment的ownership、Profile、Conversation和delivery字段只由
Conductor写。

activity Label是best-effort人类投影，写失败不阻塞Root。Timeline只append Plan、retry、terminal
error、Gate findings和delivery等重要事件；heartbeat/progress不作为Linear Workflow事实。

## 11. Conversation retry

正常process crash和Turn timeout不替换`performer_id`。Provider明确报告current Conversation不存在/
不可恢复，或Root current pointer缺失时：

```text
cancel the old Turn and terminate its process tree
-> set expected performer_id to the failed ID or none, matching the observed loss
-> verify Root current performer_id still equals that expected value
-> append Root retry comment
-> open a new Conversation with the pinned Profile
-> compare-and-set current performer_id from the expected value to the new ID
-> rebuild the full Root from Linear/Git
-> re-enter normal Root scheduling
```

该流程不创建retry row、attempt counter或Leaf checkpoint。新Conversation保留Tree、states、comments、
commits、diff和delivery；旧Conversation的迟到mutation/Result被current pointer precondition拒绝。

若新Conversation创建失败，Conductor在Primary marker写入closed Root Retry Block：expected current
pointer、`ConversationOpenFailedResult` closed code和`observed_at`。只要block与current pointer匹配，
Root保持`needs_attention`且poll/restart不再自动open。operator修复原因后必须通过带exact
`retry_observed_at`的`AcknowledgeRootRetryBlockCommand`清除；普通comment、Root编辑和restart都无效。

## 12. 端到端流程

```text
Podium login and attach Conductor Project Label
-> Conductor resolves Project
-> full-scan Root headers
-> blocker + Priority + Linear Root order
-> lazily load candidate Trees
-> fresh-read the selected complete Root
-> claim one Root and persist its Conversation pointer
-> Root Agent plans and creates visible children
-> Human approves in Linear
-> Root Agent processes ordered Work/Human facts
-> Root Agent performs Root Gate and Rework when needed
-> broker delivers branch/PR
-> Root In Review
-> user/SCM marks Done
```

Conversation loss anywhere in该流程只替换Root Conversation并重新调度同一个Root，不恢复某个Leaf
process，也不清空已经落地的Linear/Git事实。

## 13. 不变量

1. Linear是唯一Workflow authority，Git是唯一code/delivery authority。
2. Podium是唯一Linear SDK/Token owner；Performer是唯一Provider SDK owner。
3. Conductor只调度Root，不调度Leaf或业务Turn variant。
4. Linear Priority不能绕过blocker；Linear order是Root和Tree的用户排序输入。
5. Conductor没有poll checkpoint、Queue、dispatch、attempt或Workflow DB。
6. current Conversation pointer存于Linear并受remote precondition保护。
7. Conversation loss触发Root-level retry，旧Conversation不能继续写。
8. Root/Tree/Git read-back而非Result决定业务完成。
9. Project Label移动暂停旧Project Root，不迁移ownership或Conversation。
10. activity projection和runtime observations不参与Root readiness或恢复。
11. Root headers全量发现、候选Tree按序懒加载；dispatch必须基于选中Root的完整fresh read。
12. memory cache只减少读取，不能参与mutation或Workflow判断。
13. `ListRootIssuesQuery`不得为每个Root触发完整Tree读取；header中的bounded Primary Comment只用于
    ownership/retry发现。

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
| Root Cycle Policy、DAG node选择与结果materialization | Conductor |
| Root scope、remote/Git precondition和mutation read-back | Conductor |
| mutation实际SDK调用 | Podium |
| 被选中Stage的Provider执行 | Performer |

Conductor不接触Token、SDK type或GraphQL。Podium不解释Root Tree、不选择Root/Leaf，也不把缓存或
`podium.db`记录变成Workflow authority。

## 2. Project绑定

Podium完成OAuth、Project catalog和Binding创建；Linear Project上的Label决定当前Project：

```text
symphony:conductor/<short-hash>
```

Conductor每个poll/Stage边界重新执行`ResolveConductorProjectQuery`：

- 唯一Project且没有第二个Conductor Label：返回Resolved Project；
- 无匹配：`unbound`；
- 多Project匹配：`conductor_project_ambiguous`；
- 一个Project有多个Conductor Labels：`conductor_project_label_conflict`。

Project级mutation携带`conductor_short_hash + expected_project_id`和remote precondition。Label移动只
改变下一个周期扫描哪个Project，不迁移Root、Stage、branch或worktree。旧Project Root暂停；
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
    CreateManagedCycleCommand
    CreateManagedDagNodeCommand
    UpdateManagedDagNodeCommand
    UpdateDagNodeRelationsCommand
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

Conductor不保存poll cursor或Workflow checkpoint。Gateway protocol调用是Conductor观察到的业务操作；
physical Linear request是Podium transport实际发出的每个HTTP请求，包括SDK lazy read、显式GraphQL和
connection续页。两者分别计数，不能用protocol调用数推断physical request成本。每个调度周期按三层读取：

1. 按上游稳定顺序分页发现delegated、非终态Root headers，包括Root identity/state、Priority、Linear
   order、delegation、`updated_at`、blocker references和bounded Root Primary Comment snapshots；不在
   这一层读取任何Root descendants、phase、pending Human action details或完整active Root Trees。只有当前已读边界
   能证明所有未读Root都严格低于已选候选时才可早停；边界并列必须继续读取，上游顺序不支持或证明不充分
   时fail closed并读完剩余header pages。
2. 按blocker、Priority、Linear order和identifier排列headers，再按顺序懒加载候选Root的完整分页
   Tree、必要comments/relations、Primary Status、evidence和Git摘要，直到找到可运行候选。
3. dispatch前对选中Root再次fresh读取header、完整Tree、blockers、Primary/evidence和Git HEAD，重新
   计算readiness。任何变化或partial read都丢弃该候选并继续正常调度。

Podium可以在单次操作或rate-limit窗口内做bounded request coalescing和memory cache以减少读取。
compact mutation-specific fresh read可以只返回ownership、terminal和bounded scope identity/version facts；
但不返回SDK object或任意metadata。缓存与compact read都只优化I/O；不能替代dispatch完整事实，不能
决定Root readiness、mutation scope、remote precondition或业务完成。mutation及其semantic read-back
始终使用last-responsible-point fresh facts。

## 5. Root识别与claim

Root candidate：

```text
project_id == resolved_project.id
parent_issue_id is null
delegated/assigned to Symphony app user
Root status not Done/Canceled
```

Root Primary Status Comment中的full `conductor_id`是Root ownership事实。未claim Root只有在active
Performer Profile ready时按以下顺序claim：

```text
Root -> In Progress
-> create deterministic branch/worktree
-> create Root Primary Status Comment with conductor/profile identity
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

Root自身处于`Needs Approval`/`Needs Info`时释放执行capacity。Cycle和typed nodes不能进入这两个custom
states。readiness不保存当前Cycle、Stage或target Work；
它不是Workflow directive或持久state。Human等待和恢复语义由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

active Stage不因新blocker、Priority或order变化被强制抢占，但每次materialization和Stage结束read-back
都会验证Root ownership/terminal state。新的blocker至少在下次Root selection前生效；delivery必须再次
检查blockers。

## 7. Root排序

Root headers先按以下顺序排列；Conductor再按该顺序懒加载并评估候选：

```text
1. Linear Priority
   urgent -> high -> normal -> low -> no_priority
2. Linear Project/List order
3. issue identifier as stable tie-breaker
```

首个通过selection前fresh read的`runnable` Root获得admission。不使用本地FIFO、aging、ready sequence、
Leaf Queue或dispatch table。用户修改Priority和Linear顺序后，下一个Stage边界生效。

## 8. Root admission、Workflow Policy与DAG execution

Root是全局排序、admission、workspace和single-writer单位。Conductor选中Root后，先由上层Policy从fresh
Linear Cycle DAG/Git派生一个业务decision，再由低层执行一个selected ready node：

```text
resolve Project
-> progressively page Root headers until an ordering proof or exhaustion
-> sort headers by blockers, Priority and Linear order
-> lazily load and assess candidate Root DAGs in that order
-> fresh-read the selected complete Cycle Tree and Git facts
-> derive create Cycle | await Human | execute node | deliver | terminal
-> when execute node: claim one Plan | Work | Verify Node
-> build StageContextEnvelope and call Performer
-> materialize accepted Result to Linear/Git
-> read back Linear/Git
-> discard views, assessment and Result
```

Cycle Issue是DAG container且不可dispatch；Plan、Work、Verify Nodes是Stage targets，但不是Conductor本地
Queue中的dispatch records。两层Policy/execution、Stage context、Wire和Result只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

## 9. Root内部边界

Gateway返回Team workflow status catalog以及Cycle/node parent、sibling order、custom status、title、description、assignee、comments、relations
和Managed Markers。Conductor解释这些事实以重建DAG、选择ready node、验证Result并执行closed mutation。
Performer不持有Linear Gateway或Git topology capability。普通Linear文本是untrusted context，不能
扩大Stage权限或mutation scope。

## 10. Mutation语义

所有mutation：

- 验证current Conductor Project和full `conductor_id`；
- 验证Root、target、Stage context digest和当前remote/Git precondition；
- 验证status ID/category、managed Issue kind和allowed transition；
- target必须是Root或其当前descendant；
- 验证`expected_updated_at`、预期state/parent和必要Git HEAD；
- create/comment使用稳定`write_id`和Managed Marker；
- timeout/connection loss后先semantic read-back；
- precondition冲突丢弃旧snapshot并返回最新事实摘要；
- 不允许覆盖全labels的模糊写或任意parent跨Project移动。

Symphony-created Cycle/node只能在marker、remote precondition和当前lifecycle允许时由Conductor reconcile；
已终结Cycle保持审计不可变。Root Primary Status Comment的ownership、Profile、waiting和delivery字段只由
Conductor写。

activity Label是best-effort人类投影，写失败不阻塞Root。Timeline只append Plan、terminal Stage
error、Verify findings和delivery等重要事件；heartbeat/progress不作为Linear Workflow事实。

## 11. 端到端流程

```text
Podium login and attach Conductor Project Label
-> Conductor resolves Project
-> full-scan Root headers
-> blocker + Priority + Linear Root order
-> lazily load candidate Cycle DAGs
-> fresh-read the selected complete Root DAG
-> claim one Root and establish its worktree/Profile ownership
-> create initial Cycle Draft and Bootstrap Plan Node Todo
-> claim Plan: Cycle Planning + Plan In Progress
-> accepted Plan Result establishes plan_contract_digest: Plan In Review + Root Needs Approval
-> Human approves the Plan
-> materialize/read-back exact Work/Verify DAG referencing plan_contract_digest, Plan Done, Cycle Sealed, Root In Progress
-> Conductor runs one fresh Work Stage per selected ready Work Node
-> Work uses Cycle Executing; Verify uses Cycle Verifying
-> Verify passed sets Cycle Succeeded and allows delivery
-> accepted findings pass Root convergence gate, set Cycle Changes Required, then group a repair Cycle
-> Inconclusive stays in the current Cycle; Escalated waits on Root; execution failure does not create a Cycle
-> each successor Cycle repeats Plan -> approval -> Work DAG -> Verify
-> Conductor delivers branch/PR
-> Root In Review
-> user/SCM marks Done
```

任一Stage中断都结束当前runtime attempt。Conductor只从Linear/Git重新选择并创建fresh Stage，不恢复
旧Provider thread，也不清空已经落地的Linear/Git事实。

## 12. 不变量

1. Linear是唯一Workflow authority，Git是唯一code/delivery authority。
2. Podium是唯一Linear SDK/Token owner；Performer是唯一Provider SDK owner。
3. Root是全局admission/workspace单位；Cycle是authoritative-status DAG container；typed node是Stage target。
4. Linear Priority不能绕过blocker；Linear order和relations是Root/Cycle DAG排序与依赖输入。
5. Conductor没有poll checkpoint、Queue、DAG mirror、dispatch table、gate table或Workflow DB。
6. Provider thread、Wire和Stage Result都不是durable workflow state。
7. Root/Tree/Git read-back而非Result决定业务完成。
8. Project Label移动暂停旧Project Root，不迁移ownership或Stage runtime。
9. activity projection和runtime observations不参与Root readiness或恢复。
10. Root headers按页发现且只在严格ordering-boundary proof后早停；否则读完剩余页。候选Tree按序懒加载，
    dispatch必须基于选中Root的完整fresh read。
11. memory cache和webhook只减少读取/延迟，不能参与mutation或Workflow判断。
12. `ListRootIssuesQuery`不得为每个Root触发完整Tree读取；header中的bounded Primary Comment只用于
    ownership和运行问题发现。
13. DAG readiness要求matching nodes/relations已完整materialize并read-back，dependency Node为Done且有matching completion evidence。
14. Stage execution identity、attempt、token reservation、Finding、progress和Verify immutable input是Linear managed facts，不是Conductor内存状态。
15. 当前每个Binding/Root只有一个writer；deterministic key不宣称替代跨writer CAS。
16. 每个Root最多一个active Cycle；all required Work必须直接阻塞Verify。
17. Team status catalog必须完整且唯一；Issue kind/state或transition不合法时相关Root fail closed。
18. Root convergence gate跨所有Cycles计算，successor Cycle不能重置attempt或token budget。
19. Cycle graph分阶段物化：先创建Bootstrap Plan，引用approved `plan_contract_digest`的exact graph在
    `Sealed`后才可调度。

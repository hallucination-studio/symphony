# Linear端到端流转、Root调度与SDK所有权

状态：目标架构提案。本文定义一个Binding内Root如何从Linear进入Conductor、跨Root排序、完整Tree读取和
Linear SDK所有权。单Root控制由[Root Reconciliation](root-reconciliation.md)定义。

## 1. Linear SDK所有权

```text
Conductor
  -> LinearGatewayInterface
     -> generated Podium-Conductor protocol
        -> LinearGatewayProtocolHandlerImpl
           -> LinearClientInterface
              <- LinearSdkImpl
```

Podium独占OAuth、Token、Linear SDK和installation rate-limit。Conductor只依赖closed业务DTO；Performer不能
访问Linear Gateway。

## 2. Project与Root routing

Conductor通过自己的Conductor Project Label解析唯一Project。Project上的全部Conductor Labels形成pool；Root
上的Root Conductor Label决定routing：

- pool只有一个member时，未标记Root隐式路由给该member；
- pool多个member时，Root必须恰有一个pool内routing label；
- missing、multiple或pool外routing fail closed；
- Root Control Record Comment中的full `conductor_id`是claim后的ownership；
- routing变化不自动迁移ownership或live sessions。

## 3. Root header discovery

Podium通过一个Project-scoped `ListProjectRootIndexPageQuery`分页读取顶层Root headers；Conductor消费closed、versioned
`ProjectRootIndexPage`后才按自身routing过滤和排序。Index page包括带ownership record的terminal Roots；不能因为用户把
Root改成Done、Canceled或其他status就使该修改绕过Root Reconciler。每个`RootHeader`只包含`root_issue_id`、`identifier`、
`project_id`、当前`state`、`is_archived`、规范化的`updated_at`、`priority`、blockers、routing labels、native delegation和
[Human Action](human-actions.md)要求的Root assignee snapshot。
可选`root_ownership`只包含已验证的`conductor_id`、`source_comment_id`和`source_comment_remote_version`；缺失即unowned。
Header不包含title、description、order、parent、完整Cycle descendants、普通comments或任何current Cycle/ready node副本。

`ListProjectRootIndexPageQuery`是Root discovery唯一的Linear读取路径。Podium必须使用一份显式、字段有界的GraphQL document
在一个physical request中读取一页Root所需的全部header facts；禁止在page返回后逐Root调用SDK model的`state`、
`labels()`、`comments()`、`inverseRelations()`或其他lazy relation。Root ownership discovery只选择潜在
`root_ownership` managed comments的至多两条bounded候选，并在返回后按actor、strict `json` code block、record kind、
Root identity和唯一性完整校验：零条表示unowned，一条有效记录表示owned，两条或`hasNextPage = true`表示duplicate并
fail closed。不得为发现ownership读取Root全部comment历史。

如果Linear不能在同一document中完整返回某个bounded relation，Podium只能针对本page Root IDs执行一次显式批量
continuation query；不得退回逐Root读取。缺cursor、relation coverage不完整、ownership候选溢出或任一header shape
不可证明时，整页fail closed，不能把缺失值解释成unowned、unblocked或unrouted。

同一Linear installation和Project的一个Index refresh generation对全部Conductor共享。generation由startup、Project
webhook wake、matching mutation invalidation或idle safety boundary建立；重复wake只使当前generation失效一次。page
fresh-read identity固定为`linear_installation_id + project_id + refresh_generation + page_cursor + page_size`，不得包含
`binding_id`、`conductor_id`或`conductor_short_hash`。Podium必须先独立验证每个调用Binding对该installation和Project的
访问范围，再从同一generation的bounded in-flight/read-through结果提供page；后到达的Conductor不能仅因调用时间不同而
创建第二次Project scan。generation和page只存在于bounded process memory，matching mutation、下一次wake/safety boundary
或process restart即失效，不是Workflow authority、durable Root cache或poll checkpoint。每个Conductor在本地对同一page
执行routing filter，Podium不为不同Conductor重复扫描Project；任何candidate admission仍必须执行第4节的完整fresh Tree读取。

Root discovery physical request budget固定为：每个refresh generation常态每个Project page恰好一次请求，与page中的Root数、Root relation数和
Conductor数无关；仅在前述批量continuation确有必要时允许每page最多再有一次请求。以单页12个Root、3个Conductor为
验收fixture时，常态budget是1，fallback budget是2。任何实现把请求数扩展为`O(Roots)`或`O(Conductors)`都违反架构，
不能通过提高并发、延长timeout或增加rate limit修复。

Root首次进入候选集还有两个独立且必须先满足的原生准入条件：用户已经在Linear将该Root的`delegate_id`设置为
当前Binding验证过的Symphony actor，并满足[Human Action](human-actions.md)定义的Root assignee约束。Podium只投影
closed delegation与assignee facts，Conductor只消费这些闭合事实，不能
创建、补偿或推断delegation。没有matching ownership record的undelegated Root必须被发现阶段排除；因此它不得被claim、
不得变更status、不得写managed record/timeline/reply、不得创建Git workspace，也不得打开或调用Performer。已拥有
matching ownership的Root可继续恢复，即使随后native delegation已被用户撤销；撤销本身作为owned Root的普通当前事实
进入Root Reconciler，而不是将它重新解释为未准入。

blocker是eligibility gate，不是可排序的priority：存在unresolved blocker或Root dependency cycle的Root不进入本次
admission候选。其余候选的唯一排序为：

```text
Linear Priority: urgent -> high -> normal -> low -> no_priority
-> normalized updatedAt: descending
-> stable identifier: ascending
```

Podium将Linear时间戳规范化为UTC ISO instant后才跨边界传给Conductor，因此`updatedAt`比较是同一时间尺度上的确定性
比较。Linear `sortOrder`/sub-issue order仍是Root Tree内节点展示和`reorder_nodes` materialization的事实，但绝不参与
跨Root admission。Root header分页必须读到完整；当前协议没有可证明的服务端全局排序frontier，不能因为已读page看似足够
优先而早停。

## 4. Lazy完整Tree读取

按header顺序逐个加载candidate Root：

```text
RootTreeQuery
  root_issue_id
  include_archived: true
  include_comments: true
  include_comment_threads_and_reactions: true
  include_relations: true
  include_labels: true
  include_status_catalog: true
  include_source_changes: true
```

查询必须分页到完整并返回每个Issue的native archive flag。无法读取archived children、comments、relations或
remote versions时，Root不能进入Root Reconciler或mutation。返回的`WorkflowRootTreeSnapshot`必须带完整的
`source_manifest`和`coverage`：manifest为Issue、comment、relation、status catalog提供稳定source identity、version、
actor kind，并在可证明时提供Symphony stable write correlation；coverage必须列出任何遗漏及原因。普通advance仍只发送
变化source的当前值或tombstone，不发送activity history。无法证明required source或coverage完整时，Root必须fail closed。

这里的完整Tree是Podium到Conductor的fresh source read和Conductor单轮内存计算输入，不是已有Root Reconciler session
的跨进程输入。Conductor只把相对session baseline的`RootDelta`发送给Performer；只有open fresh session时才把完整
`RootBootstrapSnapshot`发送一次。

没有pending input、未完成directive或到期事实的waiting/terminal Root释放execution lane。ownership不可证明或读取
不完整时fail closed；可读取的invalid lifecycle/Tree进入delta中的mechanical violations，不能在调用Root Reconciler前
由Conductor修正或跳过。memory cache只能减少读取，不能决定readiness或mutation。

## 5. Root scheduling

```text
wake / periodic poll
-> resolve Project and current pool
-> list routed Root headers and discard unowned Roots not natively delegated by the user
-> order the remaining eligible headers
-> lazily read candidate complete Trees + Git
-> reject only ownership-unsafe, out-of-scope or incomplete candidates
-> establish barrier for every Root with pending user inputs
-> choose first eligible Root by the preemptive header order
-> fresh read selected complete Tree + Git again
-> finish an incomplete accepted directive; otherwise bootstrap a fresh session or send one RootDelta
-> read back and stop this scheduling pass
```

前节定义的header排序在每次wake和periodic poll都从fresh Root headers重新派生。因此，同一priority中刚更新的Root会在下一次admission boundary抢占较早Root；更高priority的Root始终抢占任何更低priority的Root。

抢占只选择下一次Root admission。它绝不允许Conductor自行取消已经accepted的directive或in-flight Stage turn：取消、重跑、replan、supersession和user-input barrier仍然是Root Reconciler的决定。selected Root到达其bounded read-back boundary后，下一次wake/poll会在选择另一个Root前重新计算抢占顺序。

webhook只wake，不是业务event或Queue。同一Project的并发/重复wake在Podium freshness window内合并为一次Index refresh。
lost、duplicate和reordered webhook由低频periodic full discovery和stable IDs收敛；默认idle safety interval是30秒并带
jitter，而不是每个Conductor每秒扫描。启动后立即reconcile一次，不能等待首个poll interval。存在明确到期事实时，
Conductor按最近deadline唤醒，但不能把deadline或wake保存为durable Queue/checkpoint。

## 6. Root内部调用

Conductor host不直接从Result选择ready Stage：

```text
fresh complete Root/Cycle Tree inside Conductor
-> safety/coverage gate and mechanical violation derivation
-> open Root Reconciler once with complete bootstrap, or advance it with delta only
-> obtain one closed RootReconcilerTurnResult
-> directive: persist consumed input IDs and user-comment replies, then materialize its one action or execute its matching role turn
-> failure: persist and fresh-read-back RootReconcilerFailureRecord, then stop at its retry barrier
-> each durable Stage Result returns through a next fresh-derived delta
```

Root Reconciler、Plan、Work和Verify全部运行在Performer，且由Conductor主动调用。contract分别见
[Root Reconciliation](root-reconciliation.md)和[Stage Contracts](stage-orchestration.md)。

## 7. Mutation语义

Linear mutation在本架构中只是accepted `RootDirective`或其他已定义managed action的机械写入，不是独立的业务输入、
revision、change event或workflow状态。Root Reconciler不能发Linear mutation；它只能返回closed directive，由Conductor
的materializer生成受限写入。

所有这类Linear写入必须：

- 验证binding、Project pool、Root routing和full ownership；
- target属于owned Root Tree；
- 验证expected remote version、status、archive flag、parent和relation；
- 使用stable write/directive/event ID；
- ambiguous timeout后先semantic read-back；
- partial domain patch按同一directive ID幂等收敛；
- precondition conflict丢弃旧View并返回fresh facts；
- 不允许arbitrary GraphQL、全labels覆盖或跨Root/Project parent移动。

archive/restore使用Linear原生archive API和explicit precondition。归档后完整Tree查询仍必须返回Issue及历史事实。

用户对Linear的status、description、archive、parent、relation和comment修改不经过该写入路径的“修正”步骤。Conductor
在fresh read中观察当前source version/hash，计算相对Root Reconciler session baseline的`RootDelta`，再由Root Reconciler
决定是否需要directive。不存在用户修改的Linear revision record、mutation queue或独立pending状态。

## 8. Timeline comment materialization

业务mutation和accepted Result read-back后发布typed timeline event。Root/Cycle comment subscriber通过Linear
Gateway创建对应Issue comment。每个event生成一条同时包含用户Markdown和唯一`json` code block的comment。
Root Reconciler对普通human comment的reply由matching `RootDirective`
materializer写回原Issue。业务模块不直接拼接comment；任何required comment create/read-back失败都停止当前Root，
记录correlated error，并在恢复后按同一stable ID重试，成功前不推进下一动作。规则见
[Workflow Timeline](workflow-timeline.md)。

## 9. 端到端流程

```text
Podium configures Linear and Project Conductor Pool
-> Root is routed and claimed
-> Root Reconciler receives initial complete bootstrap
-> Root Reconciler directs creation of initial Cycle
-> Root Reconciler requests Plan turn
-> Plan Result becomes durable
-> Root Reconciler requests a Plan Review Human Action comment on the Root
-> user replies in that request thread and the resolution becomes durable
-> Root Reconciler materializes/adjusts active Work DAG
-> one Work thread executes selected ready Work Issues across turns
-> every Work Result returns through durable Root Tree to Root Reconciler
-> Root Reconciler adjusts DAG, requests Human, continues Work or requests Verify
-> independent Verify Result returns to Root Reconciler
-> Root Reconciler concludes, replans or supersedes Cycle within mechanical gates
-> Conductor applies convergence and creates successor Cycle when directed and allowed
-> passed Root is delivered and enters In Review
```

普通Work错误在当前Work turn内由Agent诊断和修复。Provider/session丢失时从Linear/Git重新open matching role；
不会恢复raw thread pointer，也不会清空已落地事实。

### 9.1 黑盒验收边界

本文只拥有生产业务流转，不拥有测试拓扑、actor、证据predicate或verdict。完整的多Conductor生产边界验收由
[并行黑盒端到端验收](black-box-e2e.md)唯一规定；E2E实现不能从本节推导第二套串行runner或完成判定。

## 10. 不变量

1. Podium是唯一Linear SDK和Token owner。
2. Conductor是唯一Linear workflow writer和Performer caller。
3. Performer不能访问Linear或反向调用Conductor。
4. `ProjectRootIndexPage`只用于routing、eligibility和排序；dispatch/mutation必须基于selected Root完整fresh Tree。
5. 完整Tree包括active和archived descendants。
6. Conductor无poll checkpoint、Queue、DAG mirror、dispatch table或Workflow DB。
7. Conductor不运行模型；Root和Cycle语义来自Root Reconciler。
8. mutation、Reconciler reply、native reaction/thread action和timeline comment都以Linear durable read-back和stable identity收敛。
9. Root convergence跨所有active/archived Cycle历史计算。
10. 完整Tree只用于Conductor fresh derivation和fresh Reconciler bootstrap；已有session的advance严格只发送delta。
11. 生产边界验收只使用[并行黑盒端到端验收](black-box-e2e.md)定义的一套Campaign和证据规则。
12. Root discovery physical request只随Project page数增长，不随Root数、relation数或Conductor数增长。

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
- Root Primary Status managed record中的full `conductor_id`是claim后的ownership；
- routing变化不自动迁移ownership或live sessions。

## 3. Root header discovery

Conductor分页读取nonterminal Root headers，不为每个Root立即读取完整Tree。Header包含Priority、order、blockers、
routing和bounded Primary Status projection，不包含完整Cycle descendants。

排序固定为：

```text
unblocked before blocked
-> Linear Priority
-> Linear Root order
-> stable identifier
```

blocker优先于Priority。分页只有在能够证明后续页不可能出现更优Root时才允许早停，否则必须读完。

## 4. Lazy完整Tree读取

按header顺序逐个加载candidate Root：

```text
RootTreeQuery
  root_issue_id
  include_archived: true
  include_comments: true
  include_relations: true
  include_labels: true
  include_status_catalog: true
```

查询必须分页到完整并返回每个Issue的native archive flag。无法读取archived children、comments、relations或
remote versions时，Root不能进入Root Reconciler或mutation。

waiting Human、terminal、ownership conflict和invalid Tree释放execution lane，继续检查下一个Root。memory cache
只能减少读取，不能决定readiness或mutation。

## 5. Root scheduling

```text
wake / periodic poll
-> resolve Project and current pool
-> list and order routed Root headers
-> lazily read candidate complete Trees + Git
-> Root Reconciliation assessment
-> choose first runnable Root
-> fresh read selected complete Tree + Git again
-> execute one bounded Root action
-> read back and stop this scheduling pass
```

webhook只wake，不是业务event或Queue。lost、duplicate和reordered webhook由periodic full discovery和stable IDs
收敛。启动后立即reconcile一次，不能等待首个poll interval。

## 6. Root内部调用

Conductor host不直接从Result选择ready Stage：

```text
fresh complete Root/Cycle Tree
-> deterministic Root gate
-> call Root Reconciler when semantic action is required
-> persist accepted RootDirective and user-comment dispositions
-> materialize directive or execute matching role turn
-> persist Result
-> next full observation returns to Root Reconciler
```

Root Reconciler、Plan、Work和Verify全部运行在Performer，且由Conductor主动调用。contract分别见
[Root Reconciliation](root-reconciliation.md)和[Stage Contracts](stage-orchestration.md)。

## 7. Mutation语义

所有Linear mutation必须：

- 验证binding、Project pool、Root routing和full ownership；
- target属于owned Root Tree；
- 验证expected remote version、status、archive flag、parent和relation；
- 使用stable write/directive/event ID；
- ambiguous timeout后先semantic read-back；
- partial domain patch按同一directive ID幂等收敛；
- precondition conflict丢弃旧View并返回fresh facts；
- 不允许arbitrary GraphQL、全labels覆盖或跨Root/Project parent移动。

archive/restore使用Linear原生archive API和explicit precondition。归档后完整Tree查询仍必须返回Issue及历史事实。

## 8. Timeline comment投影

业务mutation和accepted Result read-back后发布typed timeline event。Root/Cycle projection subscriber通过Linear
Gateway创建对应Issue comment。Root Reconciler对普通human comment的reply由matching `RootDirective`
materializer写回原Issue。业务模块不直接拼接comment；任何required comment create/read-back失败都停止当前Root，
记录correlated error，并在恢复后按同一stable ID重试，成功前不推进下一动作。规则见
[Workflow Timeline](workflow-timeline.md)。

## 9. 端到端流程

```text
Podium configures Linear and Project Conductor Pool
-> Root is routed and claimed
-> Conductor creates initial Cycle
-> Root Reconciler observes complete Root Tree
-> Root Reconciler requests Plan turn
-> Plan Result becomes durable
-> Root Reconciler requests Plan Review Human Action
-> user resolution becomes durable
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

## 10. 不变量

1. Podium是唯一Linear SDK和Token owner。
2. Conductor是唯一Linear workflow writer和Performer caller。
3. Performer不能访问Linear或反向调用Conductor。
4. Root headers用于排序；dispatch/mutation必须基于selected Root完整fresh Tree。
5. 完整Tree包括active和archived descendants。
6. Conductor无poll checkpoint、Queue、DAG mirror、dispatch table或Workflow DB。
7. Conductor不运行模型；Root和Cycle语义来自Root Reconciler。
8. mutation、Reconciler reply和timeline comment都以Linear durable read-back和stable identity收敛。
9. Root convergence跨所有active/archived Cycle历史计算。

# Root Issue工作流

状态：目标架构提案。本文描述一个Linear Root Issue如何承载多轮Cycle、Root状态、Root managed
comments和delivery；Cycle内Plan、Work、Verify执行语义只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义，跨Root排序由
[Linear端到端流转](linear-flow.md)定义。

## 1. Root模型

Root是Symphony跨Root调度、workspace和恢复单位：

```text
RootRunView
  = Root Issue custom status
  + Root Primary Status Comment
  + ordered Cycle Issues
  + each Cycle's Bootstrap Plan or sealed Work | Verify DAG
  + Finding、attempt、token budget和Human action managed records
  + relevant comments and relations
  + deterministic Git branch/worktree
  + delivery facts
```

`RootRunView`每轮从Linear/Git重建并丢弃。一个Root对应：

```text
1 pinned performer_profile_id
1 delivery branch
1 worktree
0..N sibling Cycle Issues
```

Cycle Issue是Root direct child和一轮bootstrap-to-sealed DAG lifecycle的container。Cycle自身不可dispatch；它的children是closed
typed Plan、Work、Verify Nodes。Root、Cycle和Node都使用Linear Team workflow中的真实Issue status；
新Cycle复用Root branch/worktree，不创建独立workspace。

## 2. Linear Team workflow与三层状态

Linear custom status按Team配置，不按Root/Cycle/Node类型分别配置。承载Symphony Root Tree的Team必须存在
下表全部display status；Symphony再通过managed kind marker限制每类Issue允许使用的状态子集。官方Linear
workflow语义见[Issue status](https://linear.app/docs/configuring-workflows)：Team可以在固定category中添加、
排序和命名status。

| Linear category | display status | canonical enum |
|---|---|---|
| Backlog | `Draft` | `DRAFT` |
| Unstarted | `Todo` | `TODO` |
| Started | `Planning`, `Sealed`, `Executing`, `Verifying` | `PLANNING`, `SEALED`, `EXECUTING`, `VERIFYING` |
| Started | `In Progress`, `In Review`, `Needs Approval`, `Needs Info` | `IN_PROGRESS`, `IN_REVIEW`, `NEEDS_APPROVAL`, `NEEDS_INFO` |
| Started | `Inconclusive`, `Escalated` | `INCONCLUSIVE`, `ESCALATED` |
| Completed | `Succeeded`, `Changes Required`, `Done` | `SUCCEEDED`, `CHANGES_REQUIRED`, `DONE` |
| Canceled | `Canceled`, `Failed` | `CANCELED`, `FAILED` |

`CHANGES_REQUIRED`属于Completed，因为它终结当前Cycle；repair由successor Cycle承载。`FAILED`属于Canceled，
因为它终结当前Node而不代表业务成功。Conductor启动和每次Project重新解析时按status ID、精确名称和category
验证catalog。缺失、同名重复、category错误、Issue kind与状态子集不匹配或非法transition都使相关Root
fail closed；Symphony不按相似名称猜测，也不声称Linear原生提供三套独立状态机。

### 2.1 Root Workflow State

```text
Todo -> In Progress -> In Review -> Done
In Progress -> Needs Approval | Needs Info -> In Progress
In Review -> In Progress  when a successor Cycle is required
Todo | In Progress | Needs Approval | Needs Info | In Review -> Canceled
```

| Root state | 含义 |
|---|---|
| `Todo` | 尚未被Symphony claim |
| `In Progress` | Conductor可以reconcile Cycle DAG、执行ready node或delivery |
| `Needs Approval` | Root有一个已materialize且尚未解决的approval action |
| `Needs Info` | Root有一个已materialize且尚未解决的input action |
| `In Review` | 最新passed Cycle对应HEAD已经交付，等待人工或SCM接受 |
| `Done` | 用户或SCM automation确认接受 |
| `Canceled` | 用户取消；任何旧Stage不得继续产生副作用 |

`Needs Approval`和`Needs Info`始终只应用于Root，不能应用于Cycle或Plan/Work/Verify Node。Root custom state
和matching Pending Human Action必须同时存在；任一缺失都进入`needs_attention`，不能猜测恢复。

pre-delivery Verify运行时Root仍为`In Progress`。只有已经In Review的Root出现外部review changes、有效
新工作或verified HEAD失效时，Root才回到`In Progress`并创建successor Cycle。

用户在Stage期间把Root置为Done/Canceled时，Conductor取消Stage并拒绝旧Result。已经产生的Git修改作为
事实保留，但旧Result不能更新DAG、运行delivery或改变Root状态。

### 2.2 Cycle State

```text
Draft -> Planning -> Sealed -> Executing -> Verifying
           |                    |             |-> Succeeded
           |                    |             |-> Changes Required
           |                    |             |-> Inconclusive -> Verifying
           |                    |             |-> Escalated
           |                    |-> Escalated
           |-> Escalated

Escalated -> Planning | Executing | Verifying
any nonterminal -> Canceled
```

| Cycle state | 含义 |
|---|---|
| `Draft` | Cycle与唯一Bootstrap Plan Node已经创建，execution DAG尚不存在，Plan尚未claim |
| `Planning` | Bootstrap Plan正在生成/review approved Plan Contract，execution DAG尚不可调度 |
| `Sealed` | Plan已批准，完整Work/Verify DAG已materialize并read-back，结构不可再隐式改变 |
| `Executing` | 正在选择或执行approved Work DAG |
| `Verifying` | Verify针对固定Git revision执行 |
| `Succeeded` | Verify通过；当前Cycle终结且允许delivery precondition检查 |
| `Changes Required` | Verify接受了可修复Finding且Root convergence gate通过；当前Cycle终结，可创建repair Cycle |
| `Inconclusive` | Verify成功执行但证据不足；允许有界fresh Verify retry |
| `Escalated` | 收敛熔断或Human decision阻止自动继续；必须由matching Root Human action解决 |
| `Canceled` | 当前Cycle终止，旧Stage Result无效 |

`Succeeded`、`Changes Required`和`Canceled`是terminal Cycle state。`Inconclusive`和`Escalated`不是
成功，也不能delivery。`Escalated`只有在Root matching Human action被解决且Root回到`In Progress`后，
才能按原阻塞位置进入`Planning`、`Executing`或`Verifying`。每个Root同时最多一个非terminal Cycle。

### 2.3 Stage Node State

所有Node使用同一`StageNodeState` enum，但kind限制transition：

```text
Plan:   Todo -> In Progress -> In Review -> Done
                    |    ^        |
                    |    +--------+  explicit Plan Contract revision
                    +-> Failed | Canceled

Work:   Todo -> In Progress -> Done | Failed | Canceled
Verify: Todo -> In Progress -> Done | Failed | Canceled
```

- Plan `In Review`与Root `Needs Approval`及matching Pending Human Action同时存在；approval后才进入`Done`；
- retriable execution failure创建新的Stage execution comment，Node保持`In Progress`，不会靠状态来计数；
- 任一Stage Node只有在non-retryable failure或Root级熔断后才进入`Failed`；resolved Root override可以把
  matching `Failed` Node显式恢复为`In Progress`并创建fresh execution；
- Verify Node可以为`Done`，同时Cycle以`Changes Required`、`Inconclusive`或`Escalated`记录业务结论；
- `Inconclusive -> Verifying`或resolved `Escalated -> Verifying` retry会显式把同一Verify Node从`Done`
  重新置为`In Progress`，并创建新的`stage_execution_id`；
- dependency readiness只使用Linear `blockedBy`和predecessor `Done`，不增加冗余`Blocked` status；
- Root/Cycle取消时，当前非terminal Node进入`Canceled`；已完成审计记录不重写。

## 3. Root Managed Comments

### 3.1 Root Primary Status Comment

Root claim时创建一条用户可读、按comment ID更新的Primary Status Comment：

```text
Symphony
Conductor: <stable full id>
Performer profile: <profile id>
Activity: <waiting | working | failed | delivered | none>
Evidence: <source identities, versions and observations>
Observed at: <timestamp>
Current cycle: <cycle issue id or none>
Current node: <node issue id or none>
Branch: <delivery branch>
Pull request: <url when available>
Current problem: <sanitized operator action when applicable>

<!-- symphony root
conductor_id: <stable full id>
performer_profile_id: <profile id>
delivery_branch: <branch>
pull_request: <url or none>
-->
```

`Current cycle`和`Current node`只是fresh DAG observation，不是cursor。下一轮仍从完整Tree派生；Primary
缺失、过期或冲突不能决定node readiness。

Activity evidence最少满足：

| Activity | 客观evidence source |
|---|---|
| `waiting` | Root custom state、pending action ID、target node和`updated_at` |
| `working` | Cycle/node ID、node state、Stage execution marker和最近runtime observation |
| `failed` | stable error code、相关Cycle/node、Git HEAD/check result（如相关） |
| `delivered` | passed Cycle/Verify、verified HEAD、PR/branch identity和required checks |

Primary marker保存closed ownership、Profile和delivery identity，不保存authoritative current Cycle、ready
node、accepted Result、Queue或Provider transcript。

### 3.2 Stage execution comments

Stage execution identity、terminal outcome和token reservation写入matching typed Node的closed managed comments。
这些事实用于拒绝stale Result、累计Root级usage并在restart后决定是否允许fresh execution。
Root和Node的attempt数都由matching `stage_execution_id`记录数量派生，不另存单调序号。Stage启动前先写
token reservation；Result接受后写actual usage并结算。Result或usage丢失时reservation继续计入Root
token budget，不能因进程崩溃而少计。不在Workflow Tree外建立本地ledger。

### 3.3 Root Convergence Control

Root managed comment持久化closed `RootConvergencePolicy`，默认值和Root级累计规则由
[Stage Orchestration](stage-orchestration.md)定义。policy、deadline、token reservation、Cycle outcomes、
Finding disposition、progress assessments和override action全部可从Linear恢复。Root `Canceled`是manual kill
switch：它先使所有旧execution失效，再由Conductor收敛active Cycle/Node到`Canceled`。

### 3.4 Pending Human Action

Pending action写Root managed comment并包含action、Cycle、node、digest和remote precondition。Work/Verify
action解决后，Conductor把必要的closed resolution投影到target Node comment，使fresh Work context仍只读取
自己的Issue。完整字段和恢复条件由Stage Orchestration定义。

### 3.5 Finding与Cycle evidence records

Finding不要求成为可dispatch Issue。Accepted Verify Result在matching Verify Node managed comment中持久化
immutable `FindingRecord`；后续Verify通过`FindingDispositionRecord`引用原`finding_id`记录`resolved`、
`still_open`或经Human approval的`waived`。当前unresolved set由完整Root Tree重建，不能用Primary Status中的
计数替代。

Successor Cycle marker保存它承接的`finding_ids[]`和repair group identity。强耦合、相同affected scope或
必须共同验收的Findings可进入同一个repair Cycle；互相独立的Findings才拆分。Finding本身不可dispatch，
也不存在“一条Finding自动创建一个Cycle”的规则。

### 3.6 Root Timeline Comments

只把人需要理解的关键事实append到Root Timeline：Cycle创建和终结、Plan approval、terminal Stage error、
Verify findings、review changes和delivery。Heartbeat、tool activity和普通progress只进入Event/Desktop。

Timeline create使用稳定`write_id`和hidden marker去重。Comment正文是人类上下文，不作为命令；machine
marker只提供identity/correlation，不能编码未声明的transition graph。

## 4. Workflow Tree与Cycle DAG

Root descendants分阶段物化。Cycle bootstrap形态：

```text
Root Issue
└── Cycle Issue*
    └── Bootstrap Plan Node
```

Plan Contract批准后才形成sealed execution graph：

```text
Cycle Issue(Sealed)
├── Bootstrap Plan Node(Done, plan_contract_digest)
├── Work Node*(plan_contract_digest)
└── Verify Node(plan_contract_digest)
```

规则：

- Cycle Issues是Root direct children并按创建顺序排列；
- Bootstrap Plan Node由Conductor随Cycle创建，不是它所生成execution DAG中的调度节点；
- Cycle创建时只有唯一Bootstrap Plan Node，不声称完整DAG已经存在；
- accepted Plan Contract输出closed Work/Verify graph，Conductor为它计算`plan_contract_digest`；
- Plan approval后，Conductor才创建/reconcile所有引用matching digest的Work/Verify Nodes和relations；
- 只有expected node/relation集合与matching digest全部read-back后，Cycle才进入`Sealed`；
- partial materialization期间Cycle保持`Planning`；已经创建的children只能按approved Plan Contract
  补齐或判冲突，绝不参与readiness；
- `Sealed`以后graph结构不可原地修改；新需求或Findings进入successor Cycle的新Plan Contract；
- Work/Verify只有在全部matching nodes/relations创建并read-back且Plan已批准后参与readiness；
- Work dependency使用同一Cycle内Linear `blockedBy` relation；每个入口Work直接依赖Done Bootstrap Plan作为
  materialization/approval guard，但Bootstrap Plan不由该DAG反向调度；
- Verify直接依赖全部required Work Nodes；
- Cycle之间不使用execution dependency，以`triggeredBy` provenance形成审计链；
- successor Plan Contract保存previous Plan、Verify evidence、unresolved Finding records、实际Git change
  identity和attempt summaries的closed引用；
- 旧Cycle终结后不可在其中新增隐式Rework；changes必须进入successor Cycle；
- Canceled Cycle/Node不再执行；
- Linear parent、relation、custom status和managed comment共同构成唯一Workflow DAG事实。

普通Issue文本是untrusted业务上下文。只有matching managed marker可以声明Cycle/node kind、stable key、
contract digest或terminal outcome。

每个Issue的authoritative custom status、derived scheduling readiness和Verify conclusion相互独立。
Dependency由predecessor Node `Done`和matching completion evidence共同满足，不能只从Linear category
`Completed`推断。Stage execution identity、attempt和terminal outcome写在Node managed comments；它们不形成
Conductor本地Queue或数据库。

## 5. Cycle结果

Cycle进入`Succeeded`或`Changes Required`时必须有唯一closed result：

```text
CycleOutcome
  succeeded
    verify_node_id
    verified_git_head
  changes_required
    verify_node_id
    finding_ids[]
    progress_assessment
    successor_cycle_key
```

`succeeded`允许上层Policy在fresh Git/Linear验证后delivery。`changes_required`必须引用同一immutable
artifact revision上的scope内blocking findings。Root级convergence gate通过后，Conductor按耦合关系形成
一个或多个deterministic repair groups；当前只允许一个active Cycle，因此逐个创建successor。每个新Cycle
重新走Plan、mandatory approval、Work DAG和Verify。`Inconclusive`、`Escalated`以及Provider/runtime failure
不能直接创建successor。

## 6. Delivery

Conductor在delivery前重新验证Root ownership、Root state、最新Cycle outcome、DAG、blockers、verified
Git HEAD、checks和已有delivery：

```text
gh available + push + PR success -> pull_request
otherwise push succeeds           -> remote_branch
otherwise                         -> local_branch
```

交付事实写入Git/SCM和Root Primary Status Comment，Root进入In Review但不自动Done。重复请求先查找
deterministic branch/PR并收敛，不能创建重复PR。

Root In Review后出现review changes时，Root回到In Progress并创建successor Cycle；完成新Cycle后重新
Verify和delivery。所有Cycles复用同一Root branch/worktree。

## 7. Root变化与用户编辑

变化处理只使用Linear remote version、Cycle DAG、managed comments和Git事实：

- Root目标在非终态变化：当前execution precondition失效，创建或修订current Cycle Plan；
- Todo/In Progress Work Node变化：下次Work只使用该Node的fresh内容；
- Done Work业务内容晚于Completion Comment：当前Cycle进入`Escalated`，不在旧Node上隐式继续；
- Human answer变化且影响已完成Node：创建review change successor Cycle；
- 用户新增、移动或跨Cycle连接managed node：DAG validation失败并进入`needs_attention`；
- Done/Canceled Root不自动重开。

Conductor只reconcile自己创建且marker匹配的Cycle和Node。用户业务输入可以修改title、description和
relations，但不能通过伪造marker扩大Conductor权限。

## 8. 错误与恢复

`needs_attention`不是持久Conductor状态。Conductor从fresh事实发现DAG、ownership、Profile或Git冲突时：

- 在Root Timeline写去重、脱敏、可执行原因；
- 在Primary投影`failed`及客观evidence；
- 释放Agent lane；
- 后续reconciliation重新读取，问题消失后自然恢复。

Stage process、connection或Provider thread丢失本身不把Node标Done。Conductor保留Linear/Git事实并为同一
Node创建fresh execution。旧Result缺少matching execution marker或precondition时必须拒绝。

任何多Issue mutation只保证逐项幂等，不假设Linear事务。partial success、timeout或read-back不一致时，
Conductor丢弃内存计划，重新读取完整Root Tree，按stable write IDs补齐唯一合法状态或进入attention；不得从
已发送的mutation推断最终状态。

## 9. 不变量

1. Root是跨Root排序、workspace和恢复单位。
2. Linear custom status、Cycle DAG和managed records是唯一Workflow authority，Git是唯一code/delivery authority。
3. Cycle Issue是bootstrap-to-sealed graph container，不是executable node或独立workspace。
4. Cycle child kind只允许plan、work、verify。
5. Finding是Linear中的一等structured record；repair grouping按耦合关系，不按Finding数量机械创建Cycle。
6. Root是Needs Approval和Needs Info的唯一state owner。
7. 已终结Cycle DAG结构不可变，跨Cycle只使用Linear中的stable provenance。
8. Conductor没有current Cycle cursor、Queue、dispatch table、gate table或Workflow DB。
9. Verify绑定immutable Git artifact revision；Git HEAD变化使旧Verify Result失效。
10. 每个deterministic repair group最多一个successor Cycle；多个独立group按stable order逐个执行；当前只支持每个Binding/Root一个writer。
11. Stage retry和Root convergence gate只从Linear全历史与Git事实计算，创建新Cycle不会重置计数。
12. waiting/working/failed/delivered投影必须带客观evidence；它们不是Workflow authority。
13. Result/Event/process exit不能替代Linear/Git read-back。
14. 每个Root同时最多一个active Cycle。
15. Issue kind、status ID/category和transition必须同时有效；status catalog或partial mutation含糊时fail closed。
16. Cycle先有Bootstrap Plan、后有引用approved `plan_contract_digest`的execution DAG；`Sealed`前
    不存在可调度的完整DAG。

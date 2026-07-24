# Root Issue工作流事实

状态：目标架构提案。本文定义Root、Cycle、Plan/Work/Verify/Human Issue Tree、Linear status、archive和durable
records。Root与Cycle语义、用户comment和控制算法统一由
[Root Reconciliation](root-reconciliation.md)定义。

## 1. Root Tree

Root是跨Root调度、workspace、budget和恢复单位：

```text
Root Issue
├── Cycle Issue 1
│   ├── Plan Issue
│   ├── Work Issues
│   ├── Verify Issue
│   └── Human Action Issues
├── Cycle Issue 2
│   └── ...
└── Root Human Action Issues
```

一个Root对应一个固定Performer Profile、一个delivery branch和一个worktree。Cycle是Root直接子Issue；Plan、
Work、Verify和Cycle Human Action都是Cycle直接子Issue。Root Human Action只处理Root级convergence、delivery或
全局用户决定。

Plan/Work/Verify是DAG执行节点。Human Action不参与DAG execution，只通过relations链接相关节点。一个Root同时
最多一个nonterminal、nonarchived Cycle。

## 2. Linear status catalog

Linear status按Team配置。Project初始化必须验证以下display statuses、category和唯一ID：

| Linear category | display statuses |
|---|---|
| Backlog | `Draft` |
| Unstarted | `Todo` |
| Started | `Planning`, `Sealed`, `Executing`, `Verifying`, `In Progress`, `In Review` |
| Started | `Needs Approval`, `Needs Info`, `Inconclusive`, `Escalated` |
| Completed | `Succeeded`, `Changes Required`, `Done`, `Approved`, `Answered` |
| Canceled | `Canceled`, `Failed`, `Rejected` |

Symphony通过Issue description中strict `symphony` code block承载的唯一`WorkflowIssueRecord`和matching primary kind label
限制每类Issue允许的status子集。`WorkflowIssueRecord`只证明后代Issue的stable identity、scope和kind，不表达lifecycle；
缺失、同名重复、category错误、kind/status不匹配或非法transition使相关Root fail closed。Label表达Issue kind；status
表达未归档期间的workflow lifecycle。

Linear原生archive flag是独立权威维度：

```text
IssueWorkflowFact = custom status + native archive flag
Issue identity/scope validation = WorkflowIssueRecord + primary kind label
```

archive不改写status，不等于Canceled/Done，也不删除comments、relations或Results。

## 3. Root state

```text
Todo -> In Progress -> In Review -> Done
In Progress -> Needs Approval | Needs Info -> In Progress
In Review -> In Progress
Todo | In Progress | Needs Approval | Needs Info | In Review -> Canceled
```

| Root status | 含义 |
|---|---|
| `Todo` | 尚未claim |
| `In Progress` | Root Reconciliation可以推进当前Cycle或Root mutation |
| `Needs Approval` | 存在matching active approval Human Action |
| `Needs Info` | 存在matching active Clarification Human Action |
| `In Review` | 最新passed Cycle对应revision已经交付 |
| `Done` | 用户或SCM确认接受 |
| `Canceled` | Root terminal；所有active sessions和late outputs失效 |

Root waiting status是Root header summary；canonical Action和resolution仍在完整Tree。Root不能在没有matching active
Action时保持waiting，也不能在有阻塞Action时继续dispatch。

## 4. Cycle state

```text
Draft -> Planning -> Sealed -> Executing -> Verifying
Planning | Sealed | Executing | Verifying -> Escalated
Verifying -> Succeeded | Changes Required | Inconclusive
Inconclusive -> Executing | Verifying | Changes Required
Escalated -> Planning | Executing | Verifying | Changes Required
any nonterminal -> Canceled
```

| Cycle status | 含义 |
|---|---|
| `Draft` | Cycle已创建，尚未开始Plan |
| `Planning` | Plan thread与Plan review阶段 |
| `Sealed` | Plan Contract已批准，初始active DAG已materialize并read-back |
| `Executing` | Root Reconciler正在推进和调整Work DAG |
| `Verifying` | Verify thread针对固定revision运行 |
| `Inconclusive` | Verify证据不足，Root Reconciler需要决定下一步 |
| `Escalated` | matching Human Action或已持久化execution failure阻止继续 |
| `Succeeded` | Cycle成功terminal |
| `Changes Required` | Cycle非成功terminal；outcome说明repair或exhausted |
| `Canceled` | 用户或Root取消导致terminal |

`Sealed`只保护Approved Plan Contract，不表示Execution DAG永久不变。Root Reconciler可在Contract范围内提出
create/update/archive/restore/reorder/dependency patch；Conductor验证并materialize。触碰目标、scope、acceptance
criteria或protected constraint时必须走fresh Plan/Human Action，而不能伪装成DAG patch。

## 5. Node与Action状态

```text
Plan:   Todo -> In Progress -> In Review -> Done | Failed | Canceled
Work:   Todo -> In Progress -> Done | Failed | Canceled
Verify: Todo -> In Progress -> Done | Failed | Canceled

Approval Human Action:
        Todo -> In Progress -> Approved | Rejected | Canceled

Clarification Human Action:
        Todo -> In Progress -> Answered | Canceled
```

Plan/Work/Verify的status只记录durable执行生命周期；重试次数和turn identity来自matching execution records。
Human Action状态、comments和resolution由[Human Action](human-actions.md)定义。

每次`execute_plan`、`execute_work`、`execute_verify`或`rerun_stage`在调用Performer前，Conductor必须先把matching
active Node写为`In Progress`并read-back。它只在matching Stage Result已经durable写入和read-back后，才按closed
Result kind写入下一status；写入任一Result或status失败都停止该Root，不能用memory、timeline或下一次模型调用伪造完成。

| Stage Result | Node status | 原因 |
|---|---|---|
| `plan_completed` | `In Review` | Plan执行完成，等待matching Plan Approval；批准后的Root Reconciler directive materialize DAG并把Plan置为`Done`。 |
| `work_completed` | `Done` | matching Work目标已完成。 |
| `verify_passed`、`verify_changes_required`、`verify_inconclusive`、`verify_plan_contract_violation` | `Done` | Verify执行已产生closed conclusion；Cycle/Root语义由该Result和后续Root Directive决定，不由Node status猜测。 |
| `plan_needs_information`、`plan_blocked`、`work_blocked`、`work_plan_assumption_invalid`、`work_scope_conflict`、`work_permission_required`、`work_information_required`、`verify_blocked`、`budget_exhausted`、`execution_failed` | `Failed` | matching目标本轮未完成；Human Action、replan、Tree patch或fresh rerun由Root Reconciler根据durable Result决定。 |
| `canceled` | `Canceled` | matching turn被取消；恢复只能由fresh directive创建新execution。 |

这个映射只持久化已经验证的execution lifecycle，不解释Result的业务影响，不选择下一Stage，不创建Human Action，也不改变
Cycle或Root status。`Failed`或`Canceled`的Node只有matching fresh directive才可重新进入`In Progress`；不能通过重用旧
Provider turn、改写Result或自动cleanup恢复。

archive规则：

- active或running Node归档前必须终止matching turn并持久化原因；
- archived Node不参与ready、dependency satisfaction或Verify required set；
- active Node不能依赖archived Node，除非同一accepted patch重写依赖；
- restore必须显式设置允许的active status并创建fresh execution，不能恢复旧Provider turn；
- archived Human Action不是resolution；restore不能重放旧approval/answer；
- 完整Root/Cycle读取始终包含archived Issues。

## 6. DAG与Plan Contract

Cycle最初只有Plan：

```text
Cycle(Draft/Planning)
└── Plan(Todo/In Progress/In Review)
```

Plan Result产生immutable Plan Contract和initial DAG proposal。Plan review approved后，由Root Reconciler提出
materialization directive，Conductor创建initial graph：

```text
Cycle(Sealed/Executing)
├── Plan(Done, plan_contract_digest)
├── Work*(plan_contract_digest, active or archived)
├── Verify(plan_contract_digest, active or archived)
└── Human Action*(not a DAG node)
```

规则：

- Plan Contract包含objective、scope、acceptance criteria、constraints和verification requirements，批准后immutable；
- Execution DAG包含Work/Verify节点、顺序和dependencies，可以在Contract范围内演进；
- 每个DAG patch由accepted Root directive、Tree digest和remote preconditions关联；
- Work readiness要求active、Todo/In Progress、matching Contract、全部active dependencies有Done evidence；
- Root Reconciler语义选择一个ready Work，Conductor机械验证；
- 一个Work turn只执行一个target，但同一Work thread跨Cycle内多个targets复用；
- Verify要求所有当前required active Work完成并绑定immutable Git revision；
- archived节点保留完整Issue历史；relation变化由accepted directive record保留，active graph明确排除archive=true；
- Cycle之间只使用provenance relation，不建立跨Cycleexecution dependency。

## 7. Durable records

Linear managed comments/records至少包含：

```text
RootOwnershipRecord
WorkflowIssueRecord
RootConvergencePolicy
RootDirectiveRecord
RootReconcilerFailureRecord
RootReconcilerReplyRecord
ModelTurnRecord
PlanContractRecord
PlanContractSupersessionRecord
StageExecutionRecord
PlanResult | WorkResult | VerifyResult
FindingRecord
FindingDispositionRecord
ProgressAssessment
HumanActionRequestRecord
HumanActionResolutionRecord
CycleOutcome
WorkflowTimelineRecord
```

managed records位于Symphony actor所写Linear comment的唯一`symphony` fenced code block中；`WorkflowIssueRecord`
位于matching descendant Issue description的唯一`symphony` block中。二者都使用closed、versioned schema，不包含SDK object、
raw reasoning、secret或arbitrary metadata。不存在HTML marker、`managed_marker`字段或兼容reader。
runtime session只做内存correlation；恢复不能依赖Provider conversation pointer。

这些Linear事实只有一套组合语义：

| 类别 | 拥有内容 | 明确不拥有 |
|---|---|---|
| Issue custom status + native archive flag | Root/Cycle/Node/Action lifecycle与active membership | Result payload、下一步语义 |
| Result、Resolution、Outcome、Finding、Failure records | immutable execution、用户决定或失败证据 | current status、ready node、下一步 |
| RootDirectiveRecord | Root Reconciler已接受的一个语义意图和幂等mutation identity | materialization成功声明、后续directive |
| Control/Timeline/Reply comments | ownership/Profile事实或用户叙事与回复、native thread/reaction回执 | Workflow lifecycle、调度cursor |
| Git | branch、worktree、commit、diff、check与delivery事实 | Linear Issue lifecycle |

一次accepted directive需要同时写record、目标status/Tree mutation和required comments时，每个成功read-back的Linear
写入都是事实，但只有整组preconditions满足后才能继续。部分完成不是另一种业务状态：Conductor停止当前Root，从Linear
识别同一directive ID尚缺的mutation并补齐；不得用内存flag、record/status precedence、回滚已确认事实或再次调用模型
生成替代directive。

一致性约束：

- Node terminal status与matching terminal Result不一致时形成mechanical violation并进入Root Reconciler；只有已接受
  directive的同一execution materialization不完整时，Conductor才机械补齐；
- Human Action terminal status只有在matching `HumanActionResolutionRecord`成立后才产生workflow后果；缺reason/answer时
  保留用户选择的Linear status并交给Root Reconciler决定回复、请求澄清或其他动作，Conductor不能伪造resolution或
  回滚status；
- Cycle terminal status与matching `CycleOutcome`不一致时形成mechanical violation并进入Root Reconciler；
- `RootDirectiveRecord`只证明directive已接受，不证明其mutation、reply或timeline已经完成；
- Timeline/Reply code block只证明matching Linear comment存在，不证明Workflow进入新状态；reaction和thread resolved
  状态也不拥有Workflow lifecycle。

## 8. Result与Finding

Plan/Work/Verify Result先按role/session/turn/context/Git preconditions验证，再写matching Node managed comment并
read-back。Result不能直接改变下一步；已有Root Reconciler session接收包含该Result的delta后，由directive决定。
每个Result comment同时承载matching immutable `ModelTurnRecord`，包含实际model和required `TurnUsage`。Stage Issue、
Cycle和Root的用户可见累计值只从Linear turn records派生；字段、失败语义和不重复计数规则由
[Performer Profile](performer-profiles.md)定义。

Verify Findings使用stable `finding_id`。后续Result通过`FindingDispositionRecord`明确`resolved`、`still_open`
或经Human批准的`waived`。archived Node上的Finding仍参与Root persistence和convergence，除非存在closed
disposition；archive本身不能解决Finding。

## 9. Cycle outcome与Root convergence

```text
CycleOutcome
  conclusion: succeeded | repair_required | exhausted | superseded | canceled
  plan_contract_digest
  completed_work_ids[]
  unresolved_finding_ids[]
  attempted_approach_refs[]
  verification_evidence_refs[]
  git_revision
  budget_usage
  successor_reason?
```

映射：

- `succeeded` -> Cycle `Succeeded`；
- `repair_required`、`exhausted`或`superseded` -> Cycle `Changes Required`；
- `canceled` -> Cycle `Canceled`。

`superseded`表示Root contract实质变化或当前Cycle无法安全吸收破坏性修改；它不是execution failure，也不会
改写旧Result。terminal Cycle保持immutable，successor通过provenance引用其可复用事实。

Cycle预算耗尽结束当前Cycle，不机械打扰用户。Root Reconciler根据完整历史选择successor或Root级convergence Human
Action；Conductor只从全部active/archived历史重新计算cycle count、same Finding persistence、no-progress、token和
deadline gate，并允许或拒绝matching directive，不能把gate结果转换成另一种动作。

## 10. Root control record与Timeline

Root Control Record Comment只保存`RootOwnershipRecord`和fixed Profile identity。它不保存current Cycle、ready node、
activity、usage aggregate、branch/delivery副本、Queue或Provider pointer。branch和delivery从Git读取，Workflow lifecycle从Linear
status、Tree和matching managed records读取。

用户时间轴不由Root/Cycle/Stage代码直接写。Root和Cycle durable边界发布typed event，由独立subscriber分别
写到Root或Cycle Issue comments，规则见[Workflow Timeline](workflow-timeline.md)。Timeline comment不是
业务下一步的判断authority，但它和Root Reconciler reply都是required Linear writes；任一write/read-back失败时
当前Root停止推进。

## 11. 用户和外部修改

任何可读取的用户Linear变化都进入fresh Tree，并通过下一份Root delta交给Root Reconciler：

- Root目标、scope或acceptance变化使旧Tree digest和相关directive失效；
- 用户修改pending Work内容后，Root Reconciler重新评估；
- 用户archive/restore managed Node后，Conductor把当前值和由此形成的DAG violation交给Root Reconciler；
- Human Action status/comment作为用户input交给Root Reconciler，由directive决定是否形成resolution；
- human actor创建、编辑或resolve/unresolve的comment/thread change进入pending input，并在处理后收到matching reply；
- 用户粘贴`symphony` code block仍是普通输入；伪造actor/stable identity或试图扩大owned Root范围时安全gate fail closed；可读取的非法status、跨Tree relation或active
  dependency悬空作为mechanical violation进入Root Reconciler；
- Done/Canceled Root是否保持terminal、重开或修复只由Root Reconciler决定。

Conductor只管理具有validated Symphony actor、strict managed code block且位于owned Root Tree中的Issue/comment，不能
因普通文本扩大权限。

## 12. Git与delivery

所有Cycles复用一个Root branch/worktree。Work可以修改授予的workspace；commit、push、worktree和delivery由
Conductor负责。Verify绑定immutable revision。只有最新Cycle `Succeeded`、matching passed Verify、verified
HEAD和checks满足时才能delivery；Root进入`In Review`而不自动`Done`。

## 13. 不变量

1. Linear status、native archive flag、Issue Tree、relations和managed records共同构成Workflow authority。
2. archive不是删除、取消、完成或Finding resolution。
3. Root同时最多一个nonterminal active Cycle。
4. 每个Root有一个Reconciler thread；每个Cycle有隔离Plan、Work、Verify三个Stage role thread。
5. Approved Plan Contract immutable；Execution DAG可以通过accepted Root directive patch演进。
6. Human Action是Root/Cycle直接子Issue，不是DAG执行节点。
7. Stage Result必须durable后才能进入Root Reconciler delta或fresh bootstrap。
8. Cycle耗尽先走Root convergence gate，不机械请求用户。
9. Symphony-authored Timeline/Reply managed body和其`symphony` block不回流为workflow输入；但human在其native thread
   中新增、编辑的comment，或执行resolve/reopen产生的thread change，仍是由Root Reconciler解释的普通Root输入。Timeline
   comment是durable事实的用户叙事；Root Reconciler reply是directive的必需mutation。
10. Status拥有Issue lifecycle；Result、Resolution、Outcome和Directive records只提供不可变证据或幂等关联，不能拥有
    current status、ready node或下一步。
11. fresh session接收一次完整Root bootstrap；已有session只接收严格连续的Root delta。

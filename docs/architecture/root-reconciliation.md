# Root Reconciliation

状态：目标架构提案。本文是Root inputs、Root Reconciler语义决策和one-action materialization的唯一事实源。
durable authority、restart和worktree-loss规则只见
[Workflow Authority与恢复](workflow-authority-recovery.md)。

## 1. 决定

每个Root只有一个model-driven workflow decision role：Root Reconciler。

```text
complete current native Linear/Git facts
-> Root Reconciler returns one closed RootNextAction or failure
-> Conductor validates and materializes one bounded change
-> fresh read-back
-> repeat from current reality
```

Conductor host不解释Plan/Work/Verify output或human comment来选择下一步。Plan、Work和Verify只报告matching execution事实；
Root Reconciler决定是否执行Stage、创建Human Action、调整DAG、结束Cycle、创建successor或交付。

`RootNextAction`是一次Conductor-Performer调用的transient typed output，不持久化到Linear。不存在持久化next-action、accepted
command log或replay cursor。

## 2. 职责

Root Reconciler同时承担：

- `DEFINE`：把用户需求和已确认信息收敛到Root current description；
- `PLAN CONTROL`：请求fresh Plan、解释Plan outcome并创建Plan Approval；
- `BUILD CONTROL`：选择ready Work、处理attempt结果并演进DAG；
- `VERIFY CONTROL`：选择immutable revision、解释Verify与Findings；
- `REVIEW`：在terminal Cycle后检查完整Root requirement是否满足；
- `SHIP DECISION`：满足条件时请求Conductor执行mechanical delivery；
- `HUMAN INPUT`：处理普通comments及Human Action current facts。

REVIEW不是第四个Stage，SHIP也不允许模型直接执行Git command。Conductor仍独占机械validation、Linear mutation、Git
topology和delivery。

## 3. Session与输入边界

Performer为每个Root维护至多一个live Root Reconciler thread。fresh session接收完整current Root projection；live且baseline
连续时可接收bounded current-value delta以减少context。session、delta baseline和Provider history都是runtime continuity，
不能参与restart authority。

fresh projection覆盖[Workflow Authority与恢复](workflow-authority-recovery.md)定义的完整native Root object graph、Git
facts、mechanical violations和当前Project/Profile limits。Conductor必须完成active/archived分页和required activity coverage；
coverage不完整不调用模型。

`root_digest`只用于当前runtime调用的stale-output rejection。它可以覆盖canonical current facts，但不写入Linear、comment、
description或本地checkpoint。baseline无法证明时关闭session并fresh-open，不能补猜delta或重放旧turn。

Root Reconciler不接收Linear SDK object、credentials、raw Provider transcript、Desktop state或其他Root facts。

### 3.1 Root Provider memory与冻结观察批次

五层Provider注入方式只由[Performer](performer.md#51-provider注入分层)定义。本文件只定义Root role的context projection：

- fresh Root session只注入一次完整Root bootstrap；
- live session每turn注入current command，以及从已确认Provider-visible baseline到fresh observation的changes；
- 一个reconciliation turn冻结一份完整observation；同一批中的多个Issue、comment、Activity和Git changes可以共享一个turn；
- 每个change仍保留独立source identity、version、actor、input identity和reply/disposition coverage；
- turn执行期间到达的新事实不能修改当前request，只进入下一批。

Root change是逻辑context fragment，不要求一个fragment对应一个Provider SDK item。backend可以把同一冻结批次编码为一个或
多个bounded incremental items，但不能丢失fragment correlation，也不能重新序列化完整baseline。

Provider history只append：new source使用current-value fragment，更新source使用带旧source identity/version的replacement，
删除或脱离scope使用tombstone。已经进入conversation的old fragment不修改、不摘要替换，也不在后续turn重新注入。

### 3.2 Provider-visible baseline与durable disposition

Root session必须严格分开两类状态：

| 状态 | 作用 | 生命周期 |
|---|---|---|
| Provider-visible fact baseline | 证明Provider已经看过哪些fragments，决定下一turn注入什么 | live session memory |
| Human input disposition | 证明comment body是否已采用/拒绝/转成Human Action，以及target consequence是否成立 | native Linear reactions/replies/target facts |

Performer能够证明matching append进入opaque Provider continuation后，fact baseline可以推进，即使本turn随后返回closed failure或
RootNextAction validation失败。这只表示模型已经看过facts，不表示human input已处理或workflow已推进。尚无native
disposition的input identity继续出现在下一turn current command中；其正文已经存在于同一live Provider history时不得重复注入。

若append是否进入Provider history、opaque continuation或baseline连续性无法证明，立即关闭session并从fresh Linear/Git
facts创建new session和一次initial bootstrap。不能在同一thread补发、猜测或重建完整messages transcript。

### 3.3 Root initial/delta transient contract

Root Reconciler跨进程输入只有两种closed shape，不能在同一request中混用：

```text
OpenRootReconcilerRequest
  protocol_version
  request_id
  reconciler_session_id
  reconciler_turn_id
  observed_at
  command
    trigger
    pending_input_refs[]
    expected_output_contract
  bootstrap
    root_projection
      root
      active_and_archived_descendants[]
      relations[]
      attachments[]
      human_comments[]
      human_action_threads[]
      native_activity[]
      git_facts
      mechanical_violations[]
    source_manifest[]
    coverage
    target_root_digest
  limits

RootReconcilerOpenedResult
  reconciler_session_id
  bootstrap_root_digest
  initial_result: RootReconcilerTurnResult
```

`open`把stable base instructions、一次完整Root role initial context和首轮command送入fresh Provider session，并执行首个
turn；不能再用空delta取得第一步。完整projection必须覆盖active/archived分页和required Activity/Git facts，
`coverage`不完整时不得调用Performer。`expected_output_contract`只携带contract identity；matching structured-output schema
仍是独立Provider request metadata，不展开进command或initial context。

```text
AdvanceRootReconcilerRequest
  protocol_version
  request_id
  reconciler_session_id
  reconciler_turn_id
  observed_at
  command
    trigger
    pending_input_refs[]
    expected_output_contract
  delta
    base_root_digest
    target_root_digest
    changes[]: RootContextChange
  limits

RootContextChange
  source_kind: issue | comment | comment_thread | activity | relation | attachment | git | mechanical_violation
  source_id
  source_version_or_digest
  actor_kind
  observed_at
  operation:
    RootContextCurrentValue { kind: current_value, value: RootContextSourceValue } |
    RootContextReplacement {
      kind: replacement,
      replaces_source_version_or_digest,
      value: RootContextSourceValue
    } |
    RootContextTombstone {
      kind: tombstone,
      removes_source_version_or_digest,
      reason: deleted | left_role_scope
    }

RootContextSourceValue =
  issue -> matching WorkflowIssueSnapshot |
  comment -> matching WorkflowCommentSnapshot |
  comment_thread -> matching native thread state plus current reactions/replies |
  activity -> matching WorkflowActivitySnapshot |
  relation -> matching WorkflowRelationSnapshot |
  attachment -> matching WorkflowAttachmentSnapshot |
  git -> matching closed Git/worktree/check/SCM fact |
  mechanical_violation -> matching closed MechanicalViolation

PendingRootInputRef
  source_kind: comment_body | comment_thread_state | issue_activity
  native_source_identity
  source_version_or_digest
```

`pending_input_refs[]`只引用本轮仍需处理的native source identity和current version/digest。它从comment receipt/reply、
target consequence和native Activity现算，不是私有consumed-input ID，也不写入Linear。已经进入同一live Provider history但
尚无durable disposition的input只在后续command再次引用；其body/current value不得作为change重复注入。

`base_root_digest`必须等于该session已确认的Provider-visible baseline；`target_root_digest`覆盖本轮完整fresh observation。
每个change只携带matching source的current value、带被替换source version的replacement或明确tombstone，不携带人为生成的
before/after diff。advance不得包含完整Root projection、完整source manifest、旧transcript或另一个role context。

`source_kind + source_id`是fragment identity；version/digest只标识该identity的某个current value。一个冻结批次内每个
identity最多出现一次，并按`source_kind, source_id` canonical排序。`current_value`要求该identity不在base manifest；
`replacement.replaces_source_version_or_digest`和`tombstone.removes_source_version_or_digest`必须精确匹配base manifest中的
current version。operation的payload必须与`source_kind`匹配；actor、observed time和native value都来自fresh observation，
不能由模型或delta builder补造。任一重复identity、version前置条件不匹配、payload kind不匹配或target digest无法由
`base + changes`重算得到时，整个request fail closed并关闭session。

上面的`RootContextSourceValue`是按`source_kind`判别的closed union，不是arbitrary object。Linear variants直接复用
Podium-Conductor native graph的closed snapshot字段；Git、worktree、check、SCM和mechanical violation复用各自架构契约中的
closed fact，不复制SDK object、command output或metadata map。一个change只能有matching discriminator对应的一个value；
tombstone没有value。后续wire schema不得额外提供`unknown`、generic JSON或兼容旧delta的variant。

Conductor在开始一次reconciliation turn前冻结`command`、完整fresh projection、source manifest、coverage和
`target_root_digest`。冻结后到达的Linear/Git事实只进入下一批；不能修改已发送request，也不能把一个source的多个中间版本
塞进同一批。若projection未变化，允许`changes[]`为空且`base_root_digest == target_root_digest`，此时只有fresh command会被
append；空delta不能用来打开session或补取首轮Result。

Conductor可以每轮完整读取Linear/Git来证明coverage、计算diff和验证precondition，但完整读取不等于完整传输。只有fresh
session、session丢失或continuation/baseline无法证明时，才关闭旧session并重新发送一次`OpenRootReconcilerRequest`。
这些request、digest、manifest、changes和pending refs全是transient runtime data，不进入Linear、Git、workflow database、
queue、checkpoint或replay log。

## 4. Root inputs

Root input包括：

- Root current description、status、labels、relations、attachments和Activity；
- 全部active/archived descendants及其current native fields；
- human-authored comments、edits和thread changes；
- Human Action Root threads和Finding Issues；
- Git/worktree/branch/commit/diff/check/PR facts；
- structural、lifecycle、coverage和actor violations。

Symphony-authored comments不是用户input。普通human comment的current body在以下任一条件成立时pending：

- 没有matching Symphony native receipt；
- human edit Activity晚于现有receipt；
- receipt所表示的处理结果与Root current facts矛盾。

Root Reconciler为每个pending comment返回一个disposition：

```text
applied          -> materialize native consequence, then add check reaction
not_applied      -> add cross reaction and concise human-readable reason
needs_response   -> create Human Action Root thread and add concise reply
answer_only      -> write one direct reply; no workflow mutation
```

reaction只表示comment body已处理，不表达approval、permission、Finding waiver或Issue lifecycle。human edit后必须按native
Activity重新处理。无需回复的状态变化不生成comment。

## 5. DEFINE Root requirement

Root Reconciler可以基于Root description和pending human inputs提出更新Root description，但必须：

- 保留用户明示objective、scope、constraints和acceptance criteria；
- 只归一化已经存在或已由human确认的内容；
- 对无法推导的业务选择创建Information Human Action；
- 在同一bounded action中声明source human comments的receipt disposition；
- fresh read-back description后才把matching Information Action置为answered。

不得创建`SPEC.md`、`PLAN.md`、Root contract record或第二个Spec Issue。destructive requirement change如何影响current Cycle
由Root Reconciler显式决定，不能由Conductor字符串比较自动执行。

## 6. Closed RootNextAction

```text
RootNextAction =
  | UpdateRootRequirementAction
  | CreateCycleAction
  | CreateRootWorkspaceAction
  | RecordStageInterruptionAction
  | InvalidateExecutionGenerationAction
  | ExecuteStageAction
  | MaterializePlanNodeAction
  | PatchCycleTreeAction
  | CreateHumanActionAction
  | SupersedeTargetAction
  | ConcludeCycleAction
  | DeliverRootAction
  | ReplyToHumanAction
  | WaitAction
  | EscalateAction
```

公共字段至少包含protocol version、Root/session/turn correlation、observed current digest、evidence native IDs、bounded
preconditions和comment dispositions。字段是transient wire contract，只用于本次validation/materialization。

每个action必须closed且只表达一个语义目的。Issue create action一次最多创建一个Issue；创建后设置matching parent、relation和
status的writes可以构成同一bounded convergence target。跨多个Issue的DAG、generation rebuild或delivery步骤必须由fresh
Root Reconciler基于read-back current facts逐轮选择，不能藏在一个可持久化command sequence中。

Root Reconciler不拥有generic relation creation。Work dependency必须使用`replace_dependencies`；Plan/DAG、Cycle predecessor、
Stage successor和Finding relation分别由其owning typed action/materializer生成。`PatchCycleTreeAction`可以删除已存在且被完整
precondition约束的relation，但不能用任意source/target/kind创建关系。这样relation intent不能退化成无业务语义的自由组合。

Root Reconciler不能返回arbitrary GraphQL、Git shell、Linear SDK payload、raw Markdown comment或unbounded metadata。

## 7. Materialization

Conductor对每个RootNextAction执行：

1. fresh-read action引用的native facts；
2. 在任何side effect前验证整份action的Root binding、worktree gate、digest、cross-field、reference、actor、status、archive、
   parent、relation和Git preconditions；
3. 计算一个closed native postcondition；
4. 执行必要的Linear/Git mutations；
5. fresh-read完整postcondition；
6. 只在成功后处理matching comment receipt并进入下一轮。

Provider structured-output schema通过只证明closed wire shape，不证明action可materialize。整份action的pre-side-effect
validation必须证明所有引用对象存在且current，并满足kind、parent、archive与canonical direction约束。Generic relation
creation不属于closed action contract；Conductor不能把非法relation当作no-op、替换endpoint或推导另一workflow动作。

整份action的pre-side-effect validation通过后，remote mutation仍可能因部分写入、timeout或ambiguous response失败；这不会触发
command replay。Conductor重新读取current tree；若postcondition已经成立则
接受；若remote明确确认未发生且precondition仍成立才可重试；若出现竞争对象或语义不明确则停止当前Root，并把closed
mechanical violation交给fresh Root Reconciler。Conductor不能自行选择`Escalated`或另一业务状态。完整原则只由Workflow
Authority文档定义。

用户可见comment只用于直接回复、阻塞原因、验证结论或delivery结果。不得写ownership、decision accepted、Stage started、
read-back succeeded、usage或内部correlation receipts。

## 8. Stage执行

`ExecuteStageAction`只能选择matching kind的active `Todo` Issue。Conductor先将其置`In Progress`并read-back，再调用matching
Plan/Work/Verify thread。

Stage返回closed transient response后，Conductor先区分semantic Result与mechanical `StageTurnFailure`。只有semantic Result按
[Root Issue工作流](root-issue.md)materialize为native result facts；failure必须先完成matching runtime fencing并转换为closed
mechanical fact。只有native postcondition与required Git facts已fresh read-back、mechanical fact已validated后，Root Reconciler才能
看到结果。

Provider/process loss的证明、恢复和terminal no-dispatch只见
[Workflow Authority与恢复](workflow-authority-recovery.md)。本模块只接收已证明的mechanical fact，并允许fresh Root
Reconciler返回matching `RecordStageInterruptionAction`；它不维护第二份process-loss算法。

## 9. Plan approval与DAG演进

Plan completed后，Conductor将human-readable Plan写入Plan description并置`In Review`。Root Reconciler创建related Plan
Approval Human Action；只有matching human批准且target内容未变化时，才可返回`MaterializePlanNodeAction`。

initial DAG按`MaterializePlanNodeAction`逐Issue创建Work/Verify及matching relations。每次fresh read-back后Root Reconciler比较
approved human-readable Plan与current topology，再选择下一个缺失节点；全部节点和relations存在后才把Plan置`Done`、Cycle置
`Sealed`。Plan不得包含两个native postcondition不可区分的节点，架构不承诺create exactly-once；ambiguous create停止并进入
fresh reconciliation或Human Action，不能盲目创建duplicate。

approved scope内可以`PatchCycleTreeAction`创建或archive节点、调整relations。触碰objective、scope、constraints、acceptance
criteria或verification requirements必须supersede旧Plan并创建fresh Plan/Approval，不能原地编辑approved Plan。

## 10. Human、Finding与failure

Human Action rules只见[Human Action](human-actions.md)。Root Reconciler可以提出create、reply、supersede或根据已验证human
mutation继续；不能把reaction、thread resolve或沉默解释为批准。

Verify发现的问题materialize为native Finding Issues。Root Reconciler根据severity、evidence和approved waiver决定repair、
fresh Verify、Cycle conclusion或Human Action。Finding不嵌入Verify机器Result。

schema-invalid output、Provider failure、budget exhaustion或mechanical mutation failure不会写private failure payload。Conductor
只保留sanitized correlated logs，并在matching runtime fencing完成后生成closed mechanical fact；`StageTurnFailure`不能伪装成
semantic Stage Result或由Conductor直接映射业务结论。Fresh Root Reconciler根据该fact返回
`RecordStageInterruptionAction`，把matching `In Progress` attempt收敛为允许的terminal failure status。Cycle/Root escalation、
用户comment和后续动作全部由fresh Root Reconciler选择；Conductor不能根据错误字符串或本地retry结果运行另一套failure lifecycle。

## 11. Cycle conclusion、REVIEW与delivery

Cycle conclusion只通过Cycle native terminal status、Finding states、Issue topology和Git evidence表达，不保存parallel
outcome object。

terminal Cycle后，Root Reconciler REVIEW完整Root requirement：

- 已满足且exact revision可交付：`DeliverRootAction`；
- 需要repair或新方案：创建successor Cycle；
- 需要human选择：创建Root-scope Human Action；
- 明确无法完成：Root `Escalated`或`Canceled`。

delivery mechanics和Root `In Review` gate只见[Git Worktree与交付](git-worktree-delivery.md)。Root Reconciler不push、不创建
PR、不把Root直接设为`Done`。

## 12. Convergence与budget

机械limits来自Project/Profile当前配置，并从native timestamps、Cycle count、attempt relation chains、terminal statuses和
Finding states重算。Conductor可以拒绝超过hard limit的action，但不能选择替代业务动作。

progress只从current DAG和Git facts推导。model/token usage是runtime observability，不进入RootNextAction、Linear或跨重启
limit authority。

## 13. Recovery引用

process restart、session loss、normal no-replay、worktree gate和missing-worktree full rebuild全部只由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。本文件不维护第二份recovery algorithm。

## 14. 不变量

1. Root Reconciler是唯一model-driven next-step role；Conductor只机械validate/materialize。
2. RootNextAction与Stage terminal response都是transient typed outputs，不是Linear durable facts。
3. 每轮只收敛一个bounded semantic action，并fresh read-back。
4. comments只处理human communication，不形成workflow event log。
5. Stage只dispatch `Todo`；terminal attempts永不重跑。
6. Plan approval、Human resolution、Finding和delivery都由native Linear/Git facts证明。
7. live Provider memory遵守incremental injection；session/delta/digest丢失后fresh bootstrap，restart不回放command。

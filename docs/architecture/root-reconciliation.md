# Root Reconciliation

状态：目标架构提案。本文是Root inputs、deterministic convergence和Root Reconciler语义gate的唯一事实源。
durable authority、restart和worktree-loss规则只见
[Workflow Authority与恢复](workflow-authority-recovery.md)。

## 1. 决定

每个Root只有一个model-driven语义决策role：Root Reconciler。它不决定可由current native facts唯一推导的workflow transition。

```text
complete current native Linear/Git facts
-> validate coverage, graph and canonical lineage
-> deterministic transition
     mechanical_target -> compile, simulate, apply one effect, targeted read-back -> repeat
     semantic_gate     -> Root Reconciler returns one gate-specific intent -> compile/read-back -> repeat
     external_wait     -> stop until a relevant native fact or runtime event changes
     terminal          -> expose the final native state and stop
     invalid_facts     -> fail closed with owner-specific facts; no model call or mutation
```

Conductor不解释业务歧义，但必须解释closed Plan/Work/Verify Result和native graph来执行唯一合法的机械transition。Plan、Work和
Verify只报告matching execution事实；Root Reconciler只在本文定义的semantic gate选择业务intent。

`RootSemanticIntent`是一次Conductor-Performer调用的gate-specific transient typed output，不持久化到Linear。不存在持久化
next-action、accepted command log或replay cursor。

## 2. 职责

Root Reconciler只承担四类closed semantic gate：

- `requirement_and_comment`：定义需求，解释普通human comment或需求变化；
- `plan_human_decision`：解释Plan approval、rejection和需要业务澄清的human answer；
- `recovery_strategy`：对blocked、failed、inconclusive或Finding选择repair、replan、waiver request或结束策略；
- `terminal_review`：terminal Cycle后选择successor、delivery intent、human decision、cancel或conclude。

workspace创建、initial Cycle creation、complete Plan DAG materialization、ready Work selection、Stage dispatch、immutable Verify target
preparation、successful Cycle closure、wait和已由native facts唯一确定的invalidation不是semantic gate，不调用Root Reconciler。

terminal review不是第四个Stage，delivery intent也不允许模型直接执行Git command。Conductor仍独占机械validation、Linear mutation、Git
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
RootSemanticIntent validation失败。这只表示模型已经看过facts，不表示human input已处理或workflow已推进。尚无native
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
  input_id
  native_source_identity
  source_version_or_digest
```

`command`是按`semantic_gate`判别的closed union，不是一个generic trigger字符串：

```text
RequirementAndCommentCommand
  semantic_gate: requirement_and_comment
  trigger: initial_definition | human_comment | requirement_change
  pending_input_refs[]
  expected_output_contract: requirement_and_comment_intent.v1
  subject
    root_definition_version_or_digest
    active_cycle_state: absent | nonterminal | terminal

PlanHumanDecisionCommand
  semantic_gate: plan_human_decision
  trigger: plan_approval_reply
  pending_input_refs[]
  expected_output_contract: plan_human_decision_intent.v1
  subject
    plan_issue_id
    plan_content_digest
    approval_thread_root_comment_id
    decision_reply_comment_id
    decision_reply_body_digest
    actor_id
    actor_authorization: authorized

RecoveryStrategyCommand
  semantic_gate: recovery_strategy
  trigger: stage_interrupted | stage_blocked | stage_failed | stage_inconclusive |
           finding_set_open | plan_rejected | execution_generation_invalidated |
           convergence_limit_reached
  pending_input_refs[]
  expected_output_contract: recovery_strategy_intent.v1
  subject
    kind: stage_attempt | plan | cycle | execution_generation | finding_set
    subject_id
    subject_version_or_digest
    source_kind: stage_result | human_decision | native_activity | finding_state |
                 mechanical_convergence

TerminalReviewCommand
  semantic_gate: terminal_review
  trigger: cycle_terminal
  pending_input_refs[]
  expected_output_contract: terminal_review_intent.v1
  subject
    terminal_cycle_issue_id
    terminal_cycle_version_or_digest
    cycle_outcome: successful | recovery_exhausted | recovery_abandoned | canceled
    root_requirement_digest
    exact_revision
    verify_classification: passed | failed | inconclusive | absent
    finding_classification: none_open | open
    successor_cycle_policy: allowed | cycle_limit_reached | root_deadline_reached
```

这些subject是Conductor对本轮业务选择对象的冻结索引，不是第二份Root projection。字段只允许native identity、current version/digest和
由complete fresh facts唯一推导的closed classification；description、comment body、Plan正文、Finding正文、Git diff和Verify证据仍只从
matching bootstrap/delta fact读取。Performer必须同时验证request gate、`expected_output_contract`和success result gate一致；任一不一致
返回`schema_invalid`且zero workflow side effects。Open和Advance使用同一个command union，不能按session阶段选择不同的gate协议，
也不能保留`RootDirective` fallback。

`pending_input_refs[]`只引用本轮仍需处理的deterministic transient input ID、native source identity和current version/digest。
`input_id`从source kind、native identity和current version/digest确定性计算，用于与success output中的`consumed_input_ids`和
comment disposition关联；它不是durable workflow ID且不写入Linear。整个ref从comment receipt/reply、
target consequence和native Activity现算。已经进入同一live Provider history但
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
applied          -> materialize/read-back native consequence, concise child reply, check reaction, resolve source thread
not_applied      -> concise child reply with reason, cross reaction, resolve source thread
needs_response   -> create/read-back Human Action Root thread, concise child reply, check reaction, resolve source thread
answer_only      -> direct child reply, check reaction, resolve source thread; no workflow-state mutation
```

reaction只表示comment body已处理，不表达approval、permission、Finding waiver或Issue lifecycle。human edit后必须按native
Activity重新处理。fresh bootstrap只在exactly one current check/cross reaction与matching post-edit Symphony child reply同时存在时
认定该comment body已经disposition；reaction或reply单独存在都不足够。`needs_response`只resolve ordinary source thread，matching
Human Action top-level thread继续作为独立barrier。无需回复的状态变化不生成comment。

## 5. DEFINE Root requirement

Root Reconciler可以基于Root description和pending human inputs提出更新Root description，但必须：

- 保留用户明示objective、scope、constraints和acceptance criteria；
- 只归一化已经存在或已由human确认的内容；
- 对无法推导的业务选择创建Information Human Action；
- 在同一bounded intent中声明source human comments的receipt disposition；
- fresh read-back description后才把matching Information Action置为answered。

不得创建`SPEC.md`、`PLAN.md`、Root contract record或第二个Spec Issue。destructive requirement change如何影响current Cycle
由Root Reconciler显式决定，不能由Conductor字符串比较自动执行。

fresh Root的可重建边界固定为：Root `Todo`、valid workspace且没有Cycle时进入`requirement_and_comment`。accepted
`define_requirement`由Conductor compiler收敛为同一个native Root effect：normalized Root description与Root `In Progress`，两者都
必须targeted read-back。`request_information`保持或进入matching Human Action barrier；`answer_comments`本身不把Root从`Todo`
推进。Root status不是模型字段，也不是private receipt；它是Root workflow的native current fact。

Root `In Progress`、valid workspace且没有任何Cycle，或只存在唯一partial initial `Planning` Cycle但尚无Plan时，pure transition返回
`converge_initial_cycle_plan` mechanical target。该target描述一个desired state：唯一initial Cycle处于`Planning`，其下唯一initial
Plan处于`Todo`，Plan goal、scope与checks从fresh Root requirement机械生成。compiler先模拟完整target，再一次执行一个
independently durable effect并read-back；crash后从current Root/Cycle/Plan facts返回同一remaining target。Cycle与Plan之间不调用Root Reconciler，
不保存phase，也不让模型生成Issue ID、title、status ID、remote version、relation endpoint或mutation precondition。

同一进程内也不得把首次transition的digest或command当作跨effect checkpoint；每个effect后使用fresh facts重新编译remaining effect。
target只保留domain desired state，下一条command的project、status、parent、remote version与precondition始终来自current internal
Linear view。initial Plan只是`Todo` shell，其goal、scope与checks是Plan role的机械输入投影，不得伪装成approved Plan Contract；只有
validated `PlanCompletedResult`完成native materialization与read-back后，Plan description才成为等待human approval的完整Plan Contract。

## 6. Closed Root semantic intent

```text
RootSemanticIntent =
  | RequirementAndCommentIntent
  | PlanHumanDecisionIntent
  | RecoveryStrategyIntent
  | TerminalReviewIntent
```

每个gate使用独立schema，只包含protocol version、Root/session/turn correlation、observed current digest、evidence native IDs、
gate-specific intent、bounded rationale和matching comment dispositions。remote version、mutation precondition、native status、target
selection和关系操作由Conductor从fresh facts生成，不能由模型返回。

intent必须closed且只表达一个业务目的。它不是mutation program，也不限制Conductor只能推进一个机械effect后停止。Conductor可在
没有新semantic gate的情况下持续收敛，直到`semantic_gate | external_wait | terminal | invalid_facts`，但每个independently durable external
effect仍必须有独立closed outcome和targeted read-back。

Root Reconciler不拥有generic relation creation。Work dependency、Plan/DAG、Stage successor和Finding relation
都由typed compiler从approved domain contract生成。模型不能返回任意source/target/kind组合、arbitrary GraphQL、Git shell、
Linear SDK payload、raw Markdown comment或unbounded metadata。
Cycle lineage不创建relation，由Root下native Cycle的`(created_at, issue_id)`全序、archive状态和唯一active Cycle机械推导。

### 6.1 `requirement_and_comment` intent contract

`RequirementAndCommentIntent`的success envelope固定包含`protocol_version`、`request_id`、`kind`、`semantic_gate`、
`intent_id`、Root/session/turn correlation、`model_turn`、`based_on_target_root_digest`、bounded `rationale`、native
`evidence_refs`、`consumed_input_ids`和每个pending comment的`comment_dispositions`。`semantic_gate`固定为
`requirement_and_comment`，不能用同一schema返回其他gate结果。

业务intent只允许：

```text
define_requirement
  requirement:
    objective
    requested_scope
    constraints[]
    acceptance_criteria[]
  active_cycle_impact:
    initial | compatible | requires_recovery

request_information
  question
  context
  options[]

answer_comments
  reason: no_requirement_change
```

`active_cycle_impact`只表达需求变化是否需要后续`recovery_strategy`业务选择，不授权Cycle status、archive、successor或relation
mutation。Conductor从fresh facts决定initial case；若output声称的impact与current topology不兼容，intent validation失败且zero side effects。

每个pending comment必须恰有一个matching disposition：

```text
applied        -> source identity + concise summary
not_applied    -> source identity + concise reason
needs_response -> source identity + concise reply
answer_only    -> source identity + direct answer
```

source identity沿用current comment body或thread-state identity。Disposition不包含reaction、thread-state mutation、remote version、
native status或target precondition；Conductor只在matching intent postcondition read-back后推导reaction/reply/thread consequence。
`consumed_input_ids`精确覆盖全部pending inputs；`comment_dispositions`只精确覆盖其中的comment body与comment thread-state inputs。
human-authored Issue Activity作为semantic evidence被消费，但不伪装成comment disposition，也不生成无来源的reaction或thread reply。
`answer_comments`要求全部disposition都是`not_applied | answer_only`。当一个或多个pending comment inputs触发澄清时，
`request_information`至少有一个matching `needs_response`；当complete initial Root facts本身证明definition gap且没有pending human input时，
允许`consumed_input_ids`与`comment_dispositions`同时为空，并创建Root-scope Information Human Action。
`define_requirement`至少有一个`applied` disposition或由fresh Root definition gate证明为initial definition。这些cross-field规则由
Performer和Conductor做deterministic semantic validation，JSON Schema shape validation不代替它们。

### 6.2 `recovery_strategy` intent contract

Conductor只在complete current facts证明存在业务取舍时选择`recovery_strategy`，并在request中冻结一个exact recovery subject。
subject只允许`stage_attempt | plan | cycle | execution_generation | finding_set | delivery`，包含matching current native identity、source kind、
actor/resolution classification和触发该gate的input identities。它是Conductor生成的输入事实，不由模型在output中重选或回显。
`delivery` subject由Symphony-authored Root delivery attachment identity和provider-neutral observation digest冻结，source固定为
`remote_scm`；trigger只允许`delivery_changes_requested | delivery_closed_unmerged | delivery_head_changed`。PR URL、SHA、provider enum
和raw SCM payload不得进入semantic command。无可信delivery subject的invalid observation仍是机械诊断，不调用Root模型。
Delivery recovery的Human Action只允许`information | permission`；`waiver`专属于Finding语义，不能把delivery rejection伪装成
Finding waiver。

`RecoveryStrategyIntent`使用与其他Root semantic intent相同的correlation、digest、evidence、consumed input和comment disposition
envelope，`semantic_gate`固定为`recovery_strategy`。业务intent只允许：

```text
continue_with_successor_attempt
  attempt_goal
  success_evidence_requirements[]

repair_current_cycle
  repair_objective
  acceptance_focus[]

replan_current_cycle
  planning_objective
  preserved_constraints[]

request_human_decision
  decision_kind: information | permission | waiver
  question
  context
  options[]

end_current_cycle
  outcome: recovery_exhausted | recovery_abandoned
  explanation
```

`replan_current_cycle`的首个且唯一即时effect是在current Cycle下创建带`Cycle Replan`授权label的fresh Todo Plan；canonical
human-readable description保留`planning_objective`、`preserved_constraints`和interrupted role。只有targeted read-back证明fresh Plan
的exact version与Symphony actor后，Conductor才从native facts机械归档旧Plan/DAG；模型不选择Plan identity、archive target、顺序或
Cycle status。Interrupted Plan的Cycle已在Planning，旧Plan归档后即可dispatch fresh Plan；Interrupted Work/Verify必须在旧DAG全部
leaf-first归档后，用独立effect把同一Cycle回到Planning。restart不得重开recovery gate或重新dispatch任何terminal identity。

这些purpose表达一个业务后果，不表达native operation。output不得包含Cycle、Plan、Stage或Finding target ID、successor ID、native
status、archive flag、remote version、relation endpoint、mutation precondition或write ordering。Conductor只接受与frozen recovery
subject兼容的purpose，并从fresh facts编译candidate graph和remaining effects。

`continue_with_successor_attempt`只授权创建fresh native successor；任何terminal Issue identity都不能再次dispatch。
当exact subject是`Interrupted` Plan时，compiler必须先在同一Planning Cycle创建带Symphony-authored recovery provenance的fresh Todo
Plan，使高层授权先成为native fact；fresh transition随后只archive旧Interrupted Plan，normal Plan admission只选择唯一active successor。
任意archived Plan history继续保留且不计入active Plan唯一性。

当exact subject是`Interrupted` Work或Verify时，不在current Cycle内复制Stage Issue，也不改写approved DAG或复用旧Verify target。
compiler的首个effect是创建带`Interrupted Stage Recovery` provenance的fresh `Planning` successor Cycle；其description保留
`attempt_goal`与`success_evidence_requirements`。只有exact Symphony actor/version read-back成立后，fresh transition才允许这个严格的
双active Cycle中间态，leaf-first archive旧Cycle subtree和Cycle，再创建fresh Todo Plan。该中间态不得由普通双Cycle、human label、
`relates_to`或模型生成的relation endpoint触发。lost create response或restart从successor Cycle授权恢复，不重复Root turn。
`repair_current_cycle`只允许Interrupted Work或Verify，并先创建一个Symphony-authored、带`Cycle Repair` label的fresh Todo repair
Work；canonical description只保留模型选择的`repair_objective`、`acceptance_focus`与interrupted role。Interrupted Plan没有approved
execution scope，因此该purpose不兼容。对于Interrupted Work，Conductor按原方向逐一复制其全部`blocks | blocked_by`依赖到repair Work，
读回完整关系集合后才archive旧Work，并保留已有Todo Verify。对于Interrupted Verify，Conductor先机械复制其title、description与order为
带`Cycle Repair Verify` provenance的fresh Todo Verify，读回exact Symphony actor/version后archive旧Verify，再把Cycle以独立effect
改回`Executing`并dispatch repair Work。repair Work完成后，normal phase convergence进入`Verifying`；fresh Verify必须准备自己的
immutable target，不能复用旧Verify attachment或terminal identity。`relates_to`不是DAG依赖，不得复制或解释为replacement。所有identity、
relation endpoint、archive target、status与write ordering均由fresh native facts机械推导；lost response或restart不得重复Root turn。

`replan_current_cycle`表示现有Plan不能继续，必须生成fresh Plan/approval lineage，不能原地重写approved Plan或复用terminal identity。`request_human_decision`形成matching Human Action barrier，不能把模型输出本身当作
permission或waiver。`end_current_cycle.outcome`是业务disposition，不是native status name。对于exact Interrupted Plan、Work或Verify，
`end_current_cycle`只编译一个fresh-preconditioned Cycle update：status变为`Canceled`，并恰好增加`Recovery Exhausted`或
`Recovery Abandoned`之一；canonical human-readable description保留bounded explanation和closed outcome。只有targeted read-back证明
exact Cycle version、Symphony actor和canonical content时该后果才成立。fresh transition随后从这些native facts进入non-success
`terminal_review`，不重放recovery intent。recovery gate不能越权结束Root。

所有pending human inputs必须由matching comment disposition恰好覆盖。purpose与subject、evidence、input coverage、Human Action kind和
current topology的兼容性由Performer与Conductor deterministic validation；JSON Schema只证明closed wire shape。

### 6.3 `plan_human_decision` intent contract

Conductor只在complete native facts证明存在一个active Plan Approval thread、一个exact `In Review` Plan target和至少一个fresh
authorized human reply时选择`plan_human_decision`。request冻结Plan、request thread、reply、actor authorization、Plan content digest和
pending input identities；这些facts不由模型在output中重选或回显。

`PlanHumanDecisionIntent`使用common Root semantic intent envelope，`semantic_gate`固定为`plan_human_decision`。业务intent只允许：

```text
approve_plan

reject_plan
  reason
  consequence: continue_with_fresh_plan | end_current_cycle
  root_requirement_impact: unchanged | requires_update
  requested_changes[]

request_plan_decision_clarification
  question
  context
  options[]
```

`approve_plan`只表达human reply对frozen exact Plan的业务批准；Conductor仍必须机械验证actor、mention、request/reply thread、unchanged
Plan content和current lifecycle，再编译完整candidate DAG。`reject_plan`使current Plan attempt terminal；
`continue_with_fresh_plan`授权创建fresh Plan/Approval lineage，不能原地编辑或重新dispatch旧Plan；`end_current_cycle`只进入Cycle
ending convergence，不能直接结束Root。`root_requirement_impact=requires_update`要求先进入`requirement_and_comment`把confirmed
requirement change写入Root description并read-back，不能直接基于stale Root requirement生成Plan。`requested_changes`只表达human要求；当consequence是`continue_with_fresh_plan`时至少一项，
当consequence是`end_current_cycle`时必须为空，这一规则由deterministic semantic validation执行。

`request_plan_decision_clarification`保持Human Action barrier active并对同一thread直接追问，不能创建第二个Plan approval request。
每个pending reply必须由matching comment disposition恰好覆盖：approval/rejection reply使用`applied`，ambiguous reply使用
`needs_response`。output不得包含Plan/Cycle ID、native status、archive flag、remote version、relation、DAG node、mutation
precondition或reaction/thread-state mutation。

### 6.4 `terminal_review` intent contract

Conductor只在complete native/Git facts证明current Cycle terminal、没有未收敛的mechanical consequence且Root仍nonterminal时选择
`terminal_review`。request冻结terminal Cycle、Root requirement、Verify/Finding/check facts和exact Git revision；delivery policy不进入
模型contract，而由后续Conductor compiler从Project Binding读取。request中的
pending human inputs；模型不能在output中重选这些facts。

`TerminalReviewIntent`使用common Root semantic intent envelope，`semantic_gate`固定为`terminal_review`。业务intent只允许：

```text
deliver_verified_revision
  delivery_summary

start_successor_cycle
  successor_objective
  required_outcomes[]
  preserved_constraints[]

request_root_decision
  question
  context
  options[]

halt_root
  disposition: unachievable | abandoned
  explanation
```

`deliver_verified_revision`只声明frozen exact revision满足Root requirement并可进入delivery convergence；Project policy机械决定PR或
direct delivery，Conductor验证repository、branch、SHA、checks、Finding、push/PR/attachment和`In Review` read-back。该intent不证明
remote acceptance，不能直接把Root设为`Done`。

当terminal Cycle由`Recovery Exhausted`或`Recovery Abandoned`结论产生时，`terminal_review`是non-success review；
`deliver_verified_revision`与该frozen subject不兼容，Performer与Conductor都必须在任何SCM effect前拒绝。recovery结论本身不结束
Root；当前可请求Root decision，其他successor或`halt_root`后果只有在各自compiler已实现并验证时才能materialize。

`start_successor_cycle`表达尚未满足的Root outcome。compiler的第一个且唯一即时effect是创建一个fresh `Planning` Cycle：
Cycle使用Conductor选择的identity、`Terminal Review Successor`授权label与canonical description，description完整保留
`successor_objective`、`required_outcomes`和`preserved_constraints`。只有fresh read-back证明该Cycle的精确version与Symphony actor
provenance后，native transition才逐effect、leaf-first归档terminal predecessor并为successor创建`Todo` Plan；丢失create response或
Conductor restart不得再次调用Root Reconciler。模型不能提供successor identity、复用terminal Issue、批准archive或直接创建Plan。
`request_root_decision`机械映射为`root_decision` kind的Root-scope Human Action barrier，不能降级成Permission或
Information，也不能让模型选择Human Action kind。`halt_root.disposition`是停止自动推进的业务结论而非native status：
Conductor依据fresh facts和policy编译可见的escalation/cancellation consequence。

output不得包含Cycle/Stage/Finding ID、Git SHA、branch、PR/SCM target、delivery policy、native status、archive flag、relation、remote
version或mutation precondition。purpose与terminal Cycle outcome、Root requirement、Git evidence、pending input dispositions和policy的
兼容性由Performer与Conductor deterministic validation。

## 7. Materialization

Conductor对每个mechanical target或Root semantic intent执行：

1. fresh-read mechanical target或semantic intent引用的native facts；
2. 编译完整candidate Root graph，并在任何side effect前验证Root binding、worktree gate、digest、cross-field、reference、actor、status、archive、
   parent、relation和Git preconditions；
3. 计算一个closed native postcondition；
4. 把target拆成independently durable effects；
5. 每个effect取得closed outcome并fresh targeted read-back；
6. 只在全部required postconditions成立后处理matching comment receipt并进入下一轮。

Provider structured-output schema通过只证明gate intent wire shape，不证明intent可materialize。candidate graph simulation必须证明
所有引用对象存在且current，并满足kind、parent、archive、cardinality、canonical lineage与relation direction约束。

effect outcome只允许`not_applied | applied | acceptance_unknown | precondition_failed | readback_mismatch`。timeout或lost response先
targeted read-back，不能command replay；已成立则接受，明确未发生且precondition仍成立才可重试。机械冲突保留为native/runtime
fact并停止在`external_wait`或进入真正的`recovery_strategy` gate，不能从错误字符串直接选择业务状态。

用户可见comment只用于直接回复、阻塞原因、验证结论或delivery结果。不得写ownership、decision accepted、Stage started、
read-back succeeded、usage或内部correlation receipts。

## 8. Stage执行

deterministic transition只有在matching kind、active `Todo`、DAG prerequisites、human barrier、writer fence和capacity都成立时才
产生Stage dispatch target。Conductor将target置`In Progress`并read-back，再调用matching Plan/Work/Verify thread；不调用Root
Reconciler批准这个唯一可推导的dispatch。

Stage返回closed transient response后，Conductor先区分semantic Result与mechanical `StageTurnFailure`。只有semantic Result按
[Root Issue工作流](root-issue.md)materialize为native result facts；failure必须先完成matching runtime fencing并转换为closed
mechanical fact。只有native postcondition与required Git facts已fresh read-back、mechanical fact已validated后，下一次transition
才可消费结果。

Provider/process loss的证明、恢复和terminal no-dispatch只见
[Workflow Authority与恢复](workflow-authority-recovery.md)。可唯一确定的interruption materialization由Conductor执行；存在repair、
replan、cancel等业务选择时才进入`recovery_strategy`。

## 9. Plan approval与DAG演进

Plan completed后，Conductor将human-readable Plan写入Plan description并置`In Review`，并机械创建exact Plan Approval Human Action。
每个Plan approval reply都进入`plan_human_decision`解释业务含义；Conductor只机械验证actor、exact target和unchanged version，不能
从heading、reaction或字符串自行推断批准。

`approve_plan`先只把exact unchanged Plan从`In Review`置为`Approved`并read-back，形成跨restart可重建的native authorization
barrier。Conductor随后从lossless canonical Plan description编译完整candidate DAG，先验证全部Work/Verify proposal identities、parents、
dependencies、cardinality与acyclicity，再按one-effect outcome逐项写入并targeted read-back。全部节点和relations存在且recomputed seal
匹配后才把Plan置`Done`和Cycle置`Sealed`。restart从`Approved` Plan与current native DAG计算remaining effects，不再请求模型选择
缺失节点。ambiguous create停止并read-back，不能盲目创建duplicate。

需要调整approved scope时进入`recovery_strategy`并返回高层repair/replan intent；compiler生成合法successor topology。触碰objective、
scope、constraints、acceptance criteria或verification requirements必须supersede旧Plan并创建fresh Plan/Approval，不能原地编辑。

## 10. Human、Finding与failure

Human Action rules只见[Human Action](human-actions.md)。明确Plan approval request可由Plan Result机械创建；information、permission、
waiver和ordinary comment reply属于matching semantic gate。不能把reaction、thread resolve或沉默解释为批准。

Verify发现的问题materialize为native Finding Issues。Root Reconciler根据severity、evidence和approved waiver决定repair、
fresh Verify、Cycle conclusion或Human Action。Finding不嵌入Verify机器Result。

schema-invalid output、Provider failure、budget exhaustion或mechanical mutation failure不会写private failure payload。Conductor保留
closed correlated diagnostic和可重建mechanical fact；`StageTurnFailure`不能伪装成semantic Result。唯一合法的interruption/status
consequence机械收敛；存在repair、rerun、replan、escalate或cancel选择时进入`recovery_strategy`。

Stage terminal workflow status保持粗粒度：`Failed`或`Done`本身不能决定recovery trigger。对于非Finding的Plan/Work/Verify terminal
Result，pure transition只在role、owning Cycle phase、terminal status、canonical human-readable `## Outcome`和matching current
field-specific provenance同时成立时，冻结exact `stage_attempt` subject并选择`stage_blocked | stage_failed | stage_inconclusive`。
human/external edit、unknown outcome、status/outcome mismatch或多个candidate一律fail closed。这个分类不把description变成machine
payload，也不增加one-status-per-outcome workflow；它验证Conductor已经写入并read-back的visible native conclusion。accepted
`request_human_decision`只能创建target该terminal Stage的bounded information/permission Human Action，不能redispatch或改写terminal identity。
`verify_changes_required`由native Finding set拥有recovery subject，不得降级为generic Stage failure。
该subject是一个active Verifying Cycle中一个current Symphony-authored Changes Required Verify所拥有的完整开放Finding集合，而不是单个
Finding或`has_open_findings`布尔值。`subject_id`使用Cycle Issue ID；`subject_version_or_digest`必须覆盖Cycle ID/current version、Verify
ID/current version、按native ID规范排序的Todo/In Progress Finding ID/current version/status，以及涉及这些Finding的全部native relation topology。compiler从fresh Tree
重算该集合；Finding waiver intent只可materialize为一个`finding_waiver` Root Human Action并target全部开放Finding，不得同时修改Finding、
Verify或relation。

Finding-set provenance不能依赖test-only Issue actor。Changes Required Verify必须用field-specific conclusion proof取得exact Symphony
delegate actor；每个Finding的immutable creator必须是同一actor，且其latest status/description/parent/archive Activity仍指向current value。
Finding label history继续采用保守的single-actor规则。Relation actor在当前Linear projection中不可证明，因此relation只作为complete canonical
topology参与集合identity，不能单独授权一个human-created Finding或绕过Verify actor proof。
Finding-set `end_current_cycle`只编译为owning Cycle的一个fresh-preconditioned terminal update，增加exactly one `Recovery Exhausted`或
`Recovery Abandoned` outcome并保留bounded explanation；不得修改、关闭、archive或relabel任何Finding。targeted read-back后，fresh
transition以相同open Finding facts进入non-success `terminal_review`，不得重开Finding recovery turn。

`request_human_decision(decision_kind: waiver)`只创建覆盖完整Finding set的Human Action，不表示human已经批准。
matching authorized human reply进入同一`finding_set_open` gate时，Root Reconciler必须返回独立
`resolve_finding_waiver(resolution: accepted | rejected | needs_clarification)`；output仍不能返回Finding ID、version、status或mutation。
`accepted`的第一个且唯一即时后果是对exact human reply写一条canonical、用户可见的Symphony adoption reply。该adoption reply不得
提前写receipt或resolve thread，也不得改变Finding。fresh transition只从current waiver request、authorized human reply、adoption reply、
originally mentioned完整Finding集合和current Issue/Activity provenance建立native authorization barrier；进程内intent、Provider thread、
bare reaction或匹配正文都不是authority。之后Conductor每次只把一个仍匹配授权集合且未被编辑的Finding收敛为`Canceled`并targeted
read-back。全部originally mentioned Findings均确认waived后，才写check receipt、resolve request thread并消费human input；任一中间
restart从native comments、Findings和Activity继续，不再次调用Root Reconciler。

`rejected`不改变Finding，并以cross receipt和可见reason结束该waiver request；fresh Finding-set recovery可再选择repair、replan、
end Cycle或新Human Action。`needs_clarification`只在同一thread追问并保持request active，不创建第二个waiver request。request target集合、
reply actor、Finding current fields或relation topology发生歧义或变化时均fail closed。

## 11. Cycle conclusion、REVIEW与delivery

Cycle conclusion只通过Cycle native terminal status、Finding states、Issue topology和Git evidence表达，不保存parallel
outcome object。

terminal Cycle后，Root Reconciler REVIEW完整Root requirement：

- 已满足且exact revision可交付：delivery intent；
- 需要repair或新方案：创建successor Cycle；
- 需要human选择：创建Root-scope Human Action；
- 明确无法完成：Root `Escalated`或`Canceled`。

delivery mechanics和Root `In Review` gate只见[Git Worktree与交付](git-worktree-delivery.md)。Root Reconciler不push、不创建
PR、不把Root直接设为`Done`。

## 12. Convergence与budget

机械limits来自Project/Profile当前配置，并从native timestamps、canonical Cycle lineage、attempt relation chains、terminal
statuses和Finding states重算。Conductor把唯一确定的limit consequence机械收敛；只有存在业务取舍才进入semantic gate。

target architecture不定义`max_consecutive_no_progress`。一个合法`Changes Required` Cycle来自Verify，而Verify admission要求approved
DAG中的全部Work已经`Done`；因此“没有Done Work的Changes Required Cycle”是invalid topology，不是可计数的policy event。Git revision
变化只证明代码变化，不证明Root业务进展；开放Finding persistence和总Cycle次数已经分别由下述两个可观测limit覆盖。不得让模型主观评估
progress，也不得为兼容保留一个无producer的policy或snapshot字段。未来若增加progress limit，必须先定义独立的native/Git可观测单位和
不与现有limits重复的机械后果。

`max_cycle_repair_attempts`是hard active-Cycle policy：当fresh Tree重算的Failed/Interrupted Work或Verify以及Changes Required、
Inconclusive、Contract Violation Verify attempt数严格大于配置值时，不调用Root Reconciler，也不产生
`convergence_limit_reached` semantic turn。Conductor先完成matching Stage session fence，再以一个fresh-preconditioned effect把exact
active Cycle收敛为`Canceled + Recovery Exhausted`并targeted read-back。descendants保持native evidence；restart直接进入non-success
`terminal_review`。snapshot与fresh Tree计数不一致时fail closed且零mutation。

`max_same_open_finding_cycles`限制的不是Finding总数，也不是无向relation component大小。一个可计数单位必须是
Finding-to-Finding `triggered_by`的有向单链：successor Finding指向predecessor Finding，每个节点至多一个predecessor和一个
successor，边的两个parent Cycle在Root严格时间序列中相邻，且exactly one tip保持Todo/In Progress。只有archived且仍为Todo/In Progress的
predecessor继续累计；predecessor已经Done/Canceled表示旧缺陷已解决或waive，当前recurrence从1重新计数。反向、分叉、合并、self relation、
跳过Cycle、并列Cycle时间或open tip不属于latest active/terminal Cycle都属于invalid facts；不得退化为零计数或semantic choice。
由于当前target architecture尚未持久化独立Cycle predecessor relation，该严格时间序列只在存在Finding lineage relation时要求Cycle
`created_at`唯一；未来增加Cycle lineage authority必须单独迁移，不能暗中改变此计数。

当exact active Cycle中的任一合法lineage长度达到`max_same_open_finding_cycles`时，policy已经关闭继续waiver/repair/replan或再次执行该
Finding recovery的能力。Conductor不调用`finding_set_open`或generic `convergence_limit_reached` Root turn；它先完成matching Stage
session fence，fresh-read并重算完整lineage、complete source coverage、snapshot与Cycle/Finding version，然后以一个
fresh-preconditioned effect把exact active Cycle写为`Canceled + Recovery Exhausted`并targeted read-back。全部Finding、Verify、Work和relation
事实保持不变。fresh restart仍保留terminal tip的persistence evidence，但hard-limit trigger只对active Cycle生效，因此下一步进入既有
non-success `terminal_review`而不会重复terminalize。

Linear当前不暴露Issue/Relation创建者的可靠current provenance，Podium source manifest会将这些actor分类为`unknown`。因此该mechanical
limit不能把`actor_kind: symphony`设为正确性前提；完整Tree coverage、exact source version、canonical lineage与fresh mutation
precondition才是可观测authority。测试伪造Symphony actor不能替代真实边界事实。

这一限制同样适用于terminal Stage recovery，但不能据此把`unknown`全局当成Symphony。Stage conclusion只在exact current Issue
version、complete Activity coverage、Symphony delegate创建者，以及status、description和该gate依赖的labels/parent/archive Activity
共同证明当前postcondition时成立。Status、description、parent和archive使用各字段latest Activity actor与current target；被later Symphony
write完整覆盖的旧edit不永久污染Issue。Labels因Activity只暴露ID而Issue projection只暴露name，必须保守拒绝完整label history中的任一
human、unknown或foreign automation actor。该field-specific proof不自动授权Cycle、successor或relation。

`max_cycles_per_root`关闭的是successor capability，不创建第二个generic limit gate。final allowed Cycle terminal后仍进入同一个
`terminal_review`，其subject必须携带closed
`successor_cycle_policy: allowed | cycle_limit_reached | root_deadline_reached`。达到上限时Root Reconciler仍可选择
delivery、Root Human decision或halt，但不得返回`start_successor_cycle`。Conductor在compiler中从fresh Tree重新计算完整Cycle数，并与
current policy、snapshot和command classification逐项一致后才允许successor effect；达到上限、classification stale或terminal snapshot仍
声称存在active Cycle时zero successor mutation。若native Cycle数已经严格超过policy，则属于admission/policy violation，transition在
model call和mutation之前fail closed；不得通过取消active Cycle掩盖越界事实，也不产生`convergence_limit_reached` turn。

Root lifetime `deadline_at`只关闭新的execution admission，不等同于单个Stage turn的`deadline_exceeded`。Fresh facts已经包含clean exact
revision、passed Verify、无open Finding且唯一可成功收口时，deadline不得抹除该证据：Conductor仍机械关闭successful Cycle；terminal
successful Cycle仍进入delivery-capable `terminal_review`，但subject固定为`successor_cycle_policy: root_deadline_reached`且compiler从
post-model fresh `observed_at`、policy deadline和snapshot重新验证，禁止successor effect。除此以外，deadline优先于workspace creation、
Cycle/Plan/DAG convergence、Stage dispatch、repair、replan和任何successor execution，不调用Root recovery turn。

过期时若存在exact active unfinished Cycle，Conductor先关闭全部matching Stage sessions，再以一个fresh-preconditioned effect将该Cycle
写为`Canceled + Recovery Abandoned`并targeted read-back；下一次fresh convergence才用第二个独立effect将非terminal Root写为
`Canceled + Deadline Exceeded`。若没有active Cycle，则直接执行Root effect。Root cancellation保留原description和已有labels，只增加native
deadline classification；不能把Cycle与Root两个可独立失败的writes合成composite mutation。Root已在`In Review`时，open unchanged remote
acceptance可继续等待、exact merge可完成Root；changes-requested、closed-unmerged或head-changed不得在deadline后重新打开recovery或创建
successor execution。

progress只从current DAG和Git facts推导。model/token usage是runtime observability，不进入RootSemanticIntent、Linear或跨重启
limit authority。

## 13. Recovery引用

process restart、session loss、normal no-replay、worktree gate和missing-worktree full rebuild全部只由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。本文件不维护第二份recovery algorithm。

## 14. 不变量

1. Root Reconciler是唯一model-driven语义决策role；唯一可推导的workflow transition由Conductor机械执行。
2. RootSemanticIntent与Stage terminal response都是transient typed outputs，不是Linear durable facts。
3. Conductor持续机械收敛到下一个semantic gate、external wait、terminal或invalid facts；每个durable effect独立outcome并fresh read-back。
4. comments只处理human communication，不形成workflow event log。
5. Stage只dispatch `Todo`；terminal attempts永不重跑。
6. Plan approval、Human resolution、Finding和delivery都由native Linear/Git facts证明。
7. live Provider memory遵守incremental injection；session/delta/digest丢失后fresh bootstrap，restart不回放command。

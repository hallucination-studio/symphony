# 契约与接口边界

状态：目标架构提案。本文是public/cross-process schema、validation、correlation和error semantics的唯一事实源。
Linear durable object shape由[Root Issue工作流](root-issue.md)和
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。

## 1. 主要接口

```text
PodiumClientInterface               <- PodiumProcessClientImpl
LinearGatewayInterface              <- PodiumLinearGatewayClientImpl
RootReconcilerClientInterface       <- PerformerRootReconcilerClientImpl
StagePerformerClientInterface       <- PerformerStageClientImpl
RootTransitionInterface             <- NativeFactRootTransitionImpl
RootIntentMaterializerInterface     <- LinearGitRootIntentMaterializerImpl
GitWorkspaceInterface              <- GitWorktreeImpl
DeliveryInterface                  <- GitHubDeliveryImpl
PerformerProfileControlInterface   <- PerformerProfileProcessClientImpl
```

Interfaces返回closed Result unions。roles依赖contracts/interfaces，不能import另一role implementation或SDK types。

## 2. Podium-Conductor boundary

Podium独占Linear SDK、OAuth、tokens、installation和Project catalog。Conductor只通过versioned protocol读写workflow facts。

主要query：

```text
GetConductorProjectQuery
GetRootHeadersQuery
GetCompleteRootObjectGraphQuery
GetWorkflowStatusCatalogQuery
```

完整Root graph必须支持active/archived分页，并包含Issues、statuses、labels、parents、relations、comments、threads、reactions、
attachments、SCM links和required native Activity/actor/timestamps。Podium返回closed coverage；不完整coverage不能伪装成功。

唯一mutation union：

```text
CreateWorkflowIssueCommand
UpdateWorkflowIssueCommand
SetIssueLabelsCommand
SetIssueRelationsCommand
SetIssueArchiveStateCommand
AppendHumanReadableCommentCommand
CreateCommentReplyCommand
SetCommentReceiptReactionCommand
SetCommentThreadStateCommand
SetIssueAttachmentCommand
```

每个command只表达一个independently durable native effect，并携带explicit target、expected remote version/current preconditions和
bounded desired state。Podium执行后返回closed `NativeEffectOutcome`：

```text
not_applied | applied | acceptance_unknown | precondition_failed | readback_mismatch
```

`applied`必须包含matching fresh targeted read-back；timeout或lost response不得伪装成`not_applied`。协议不提供multi-effect partial
success、arbitrary GraphQL、SDK passthrough、JSON comment writer或private metadata字段。物理transport可以batch，但每个effect仍有
独立correlation与outcome。

description/comment body是ordinary bounded Markdown。Gateway不得解析或生成Symphony JSON block、HTML marker、stable key或
machine envelope。

## 3. Conductor-Performer boundary

Conductor始终是caller：

```text
OpenRootReconcilerRequest    | RootReconcilerOpenedResult
AdvanceRootReconcilerRequest | RootReconcilerTurnResult
PlanTurnRequest              | PlanTurnResponse
WorkTurnRequest              | WorkTurnResponse
VerifyTurnRequest            | VerifyTurnResponse
CloseCycleStageSessionsCommand | CloseCycleStageSessionsResult
```

`CloseCycleStageSessionsCommand | Result`使用exact plan/work/verify keys，并为每个role携带
`ExpectedStageRoleSession | CloseRoleSessionResult`；完整closed union、CAS和retry语义由
[Stage Contracts](stage-orchestration.md#32-stage-session-close-contract)拥有。它不是agent-tree batch API。

Root Reconciler字段由[Root Reconciliation](root-reconciliation.md)定义；Stage字段由
[Performer Stage Contracts](stage-orchestration.md)定义。本文不复制字段表。

cross-process payload使用closed versioned JSON Schema和generated TypeScript/Python/Rust types。这里的JSON只存在于process
transport；response验证并materialize后即可丢弃，绝不复制到Linear description/comment或Git workflow file。

Protocol传输Symphony session/turn correlation，不传raw Provider conversation pointer。Performer不能callback Conductor，也不
返回Linear/Git SDK command。

Work subagent tree不是新的cross-process actor、protocol resource或Conductor policy。Conductor仍只发送一个
`WorkTurnRequest`并接收一个`WorkTurnResponse`；request只有role-generic `StageLimits`，不包含agent count、depth、mailbox、
residency、write lease或Provider config。Semantic `WorkResult`不得包含agent path、thread status、transcript或delegation trace。
Close result只有在matching workspace write capability永久撤销且required containment proof成立后才能success；PID或process-group
exit本身不是proof。

## 4. Transient Result边界

每类`RootReconcilerTurnResult`使用gate-specific closed union：

```text
RootSemanticIntent | RootReconcilerTurnFailure
```

Open和Advance Root request都必须携带同一个按`semantic_gate`判别的closed `command` union。每个variant冻结gate-specific subject和
matching `expected_output_contract` identity；subject只携带identity、version/digest与closed mechanical classification，不能复制
Root projection正文。Performer按该identity选择唯一structured-output schema，并在接受success前验证request gate、expected contract和
result gate三者一致。不存在generic Root success schema，也不存在`RootDirective` compatibility fallback。

`requirement_and_comment` success使用独立`RequirementAndCommentIntent` schema；其业务payload只允许
`define_requirement | request_information | answer_comments`，并使用closed
`applied | not_applied | needs_response | answer_only` comment disposition。该schema不引用`RootDirectiveAction`、Tree operation、
remote version、native status、relation或Stage dispatch contract。其精确语义由
[Root Reconciliation](root-reconciliation.md#61-requirementandcomment-intent-contract)拥有。

`recovery_strategy` success使用独立`RecoveryStrategyIntent` schema；其业务payload只允许fresh successor attempt、current Cycle
repair、current Cycle replan、Human decision request、Finding waiver reply resolution或current Cycle ending intent。创建请求使用
`request_human_decision`；解释已有Finding waiver reply使用独立`resolve_finding_waiver`，其resolution只允许
`accepted | rejected | needs_clarification`，不能把同一variant同时解释为提问和接受授权。Exact recovery subject由Conductor request冻结，
模型output不返回target identity、successor identity、native status、relation、remote version或mutation precondition。其精确语义由
[Root Reconciliation](root-reconciliation.md#62-recoverystrategy-intent-contract)拥有。
远端交付拒绝复用该contract family：Conductor只传递provider-neutral trigger，并用Symphony-authored Root delivery attachment ID与
observation digest冻结`delivery` subject。PR URL、revision、provider enum和raw SCM payload不属于Root semantic contract。

`plan_human_decision` success使用独立`PlanHumanDecisionIntent` schema；其业务payload只允许approve、reject或clarification。
Exact Plan、Human Action thread、reply、actor authorization与Plan content version由Conductor request冻结，模型output不返回target
identity、native status、DAG operation、relation、remote version或mutation precondition。其精确语义由
[Root Reconciliation](root-reconciliation.md#63-planhumandecision-intent-contract)拥有。

`terminal_review` success使用独立`TerminalReviewIntent` schema；其业务payload只允许verified-revision delivery、successor Cycle、
Root Human decision或stopped Root。Exact Cycle/Git revision由Conductor request冻结；subject还携带closed
`successor_cycle_policy: allowed | cycle_limit_reached | root_deadline_reached`，只表达当前terminal gate能否选择successor，不携带limit数值或
mutation字段。Performer prompt和Conductor compiler都必须拒绝policy-incompatible successor；compiler以post-model fresh native Cycle count、
Tree `observed_at`和current deadline重新验证该classification。
delivery policy由后续Conductor compiler从
Project Binding读取，不进入模型request或output。模型output不返回SHA、branch、
SCM target、successor identity、native status、relation、remote version或mutation precondition。其精确语义由
[Root Reconciliation](root-reconciliation.md#64-terminalreview-intent-contract)拥有。

Plan/Work/Verify各返回matching closed response：model-generated semantic Result或Performer-generated `StageTurnFailure`。
Semantic Result只属于当前call，至少关联request、role、Root/Cycle/target、observed digest、session/turn和evidence references。
Plan、Work和Verify分别使用自己的discriminated union，不共享`outcome.kind: string`。Mechanical failure不伪造业务evidence或Result
字段，并携带closed Provider acceptance/continuation result。

Conductor必须先验证Result，再将其收敛成native Linear/Git postcondition并fresh read-back。不得：

- 把Result整体写入Linear；
- 保存Result副本/reference或accepted next-action；
- 用Result替代native status、relation、Finding、Human Action或Git evidence；
- 在restart时重放Result；
- 从comment文本反序列化Result。

runtime correlation只拒绝stale/duplicate outputs，不成为durable workflow identity。

## 5. Performer Profile protocol

```text
GetPerformerProfileStatusQuery
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
```

API Key通过bounded secret stdin frame进入Performer，不进入transport JSON日志、View或Podium storage。Provider login handle只
存在于当前control process。Profile配置和runtime usage语义由[Performer Profile](performer-profiles.md)定义。

## 6. Validation与correlation

所有third-party response、Linear snapshot、Root semantic intent和Stage terminal response在边界strict validate。JSON Schema使用
`additionalProperties: false`；unknown variant/field、invalid enum、oversized payload、stale correlation、digest mismatch或
incomplete coverage一律fail closed。

JSON Schema通过只证明wire shape合法，不证明output在current native facts上可执行。字段间相等/不等、reference membership、
actor/kind/parent/archive兼容性和canonical relation direction等约束由owning boundary执行deterministic semantic validation。
Root intent必须在第一条Linear/Git side effect前编译并模拟完整candidate graph；validation失败时返回closed failure并保持zero
side effects，不能自动修正endpoint或选择替代业务intent。Prompt prose不能增加或放宽contract，也不能替代机械validation。

Root/Stage runtime envelope可以包含：

```text
protocol_version
request_id
root_issue_id
cycle_issue_id?
target_issue_id?
session_id
turn_id
observed_current_digest
source_manifest
coverage
limits
```

`StageLimits`对三个Stage roles使用同一closed shape；其中`max_weighted_tokens`、`max_tool_calls`、`max_wall_time_ms`和
`deadline_at`在Work中覆盖root与全部descendants。Agent-tree-specific limits和policy只由Performer内部派生，出现在public
envelope属于schema error。完整runtime语义见
[Work Subagents](work-subagents.md#8-tree-wide-budget与hard-reservation)。

这些字段不写入Linear。`observed_current_digest`只证明Result针对本轮current view；materialization前必须fresh-read target
preconditions，不能仅凭digest写入。

live session使用initial/delta transport。fresh role session只接收一次initial；之后只追加current command以及current value、
replacement或tombstone fragments。Conductor按turn冻结fresh observation，多个changes可共享turn但保留独立identity。
Root的closed initial/delta shape由[Root Reconciliation](root-reconciliation.md#33-root-initialdelta-transient-contract)拥有；
Stage的closed role projection与fragment union由
[Performer Stage Contracts](stage-orchestration.md#31-role-context初始化与增量)拥有。cross-process schema必须直接表达这些互斥
variants，不能用arbitrary object、可选字段组合或完整context字段兼容旧request shape。

Provider-visible fact baseline只在live session memory中，决定哪些fragments无需重复注入。human input是否已处理则从native
Linear receipt/reply和materialized target facts推导；两者不能合并成checkpoint。append/continuation不连续或无法证明时关闭
session并fresh-open。Provider acceptance的三态证据与恢复规则只由
[Performer](performer.md#52-provider-append确认与失败)定义；transport failure不能暗示baseline已推进或未推进。restart不能从
Linear寻找delta cursor、Provider memory或private consumed-input ID。没有validated业务output的Root/Stage failure必须显式携带
该节定义的closed `ProviderTurnContinuity`；调用方不得从error category猜测session或baseline disposition。

## 7. Linear source与actor

每个source snapshot保留native ID、remote version或updated time、actor kind和current value。actor kind只允许：

```text
human | symphony | linear_integration | external_automation | unknown
```

无法证明actor时返回`unknown`。Comment snapshot包含body、author、created/updated time、thread state、reactions和required
Activity；reaction不能转换成approval语义。Root ordinary comment receipt只允许Symphony自己的check/cross reaction，并按
[Root Reconciliation](root-reconciliation.md)解释。

## 8. Error语义

每个protocol使用显式terminal union，不混用throw、null和partial success表达同一失败。跨进程错误包含closed code、category、
sanitized reason、retryability、continuity和action required，不返回raw exception、stack、secret或arbitrary details map。

业务blocked、budget exhausted、Provider transport failure、schema-invalid output、Linear coverage failure和Git identity conflict是
不同variants。失败不会创建machine receipt或private failure payload；durable consequence必须是native terminal/interrupted status、
Human Action或用户可理解的bounded comment。

## 9. Linear内容边界

Linear description/comment允许：

- user-authored Markdown；
- Root requirement、Plan、Work/Verify evidence和Finding内容；
- Human Action request/answer；
- concise failure、verification或delivery explanation。

明确禁止：

- Symphony machine JSON或其他private serialization；
- hidden marker、private metadata、digest或transport envelope；
- Root/Cycle event stream或每步receipt；
- model turn、token usage、next-action、Result或delivery payload；
- 为compatibility保留的reader/writer/parser。

Linear native IDs、fields、topology和Activity本身就是durable schema。若native object graph不足以证明postcondition，系统fail
closed或创建有明确用户语义的Issue；不得回退到private comment protocol。

## 10. Interface ownership

- Conductor定义Root transition、Root Reconciler client、Stage client、intent materializer和Git/delivery interfaces；
- Podium实现Linear protocol和内部SDK；
- Performer定义Provider backend与role session runtime；
- Performer独占Work Agent Tree、Provider collaboration tools、turn mutation epoch、write grants和runtime containment；
  Conductor只拥有matching session transport、Root writer permit与outer Binding fence；
- schemas是唯一手写wire source，generated code不含business policy；
- Impl不从public exports导出，role不能deep import另一role implementation。

## 11. 不变量

1. public/cross-process input和output使用closed versioned schema。
2. transport JSON是transient，不进入Linear/Git durable workflow content。
3. Semantic Result必须materialize为native postcondition并fresh read-back才有业务效果；StageTurnFailure不伪造业务Result。
4. 一个mutation outcome只代表一个independently durable effect；unknown acceptance必须targeted read-back后才能继续。
5. Linear Gateway只暴露bounded native query/mutation，不暴露SDK或arbitrary GraphQL。
6. session、turn、digest和delta baseline都不是durable checkpoint。
7. secret、SDK object、database record、process handle和raw transcript不跨public boundary。
8. 不存在generated workflow-comment stream、private persistence或legacy comment compatibility interface。
9. Podium-Conductor mutation envelope携带当前private channel绑定的transient Binding generation correlation；Podium按实际
   channel identity验证，不能信任caller提供的generation字符串，旧channel不能提交late mutation。
10. Work subagent tree不形成public workflow API；外部只观察matching `WorkTurnRequest | WorkTurnResponse`，tree policy保持internal。

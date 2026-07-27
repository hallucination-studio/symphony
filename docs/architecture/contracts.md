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
RootActionMaterializerInterface     <- LinearGitRootActionMaterializerImpl
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

每个command携带explicit native target、expected remote version/current preconditions和bounded desired state。Podium执行后返回
fresh semantic read-back。协议不提供arbitrary GraphQL、SDK passthrough、JSON comment writer或private metadata字段。

description/comment body是ordinary bounded Markdown。Gateway不得解析或生成Symphony JSON block、HTML marker、stable key或
machine envelope。

## 3. Conductor-Performer boundary

Conductor始终是caller：

```text
OpenRootReconcilerRequest    | RootReconcilerOpenedResult
AdvanceRootReconcilerRequest | RootReconcilerTurnResult
PlanTurnRequest              | PlanResult
WorkTurnRequest              | WorkResult
VerifyTurnRequest            | VerifyResult
CloseRoleSessionCommand      | CloseRoleSessionResult
```

Root Reconciler字段由[Root Reconciliation](root-reconciliation.md)定义；Stage字段由
[Performer Stage Contracts](stage-orchestration.md)定义。本文不复制字段表。

cross-process payload使用closed versioned JSON Schema和generated TypeScript/Python/Rust types。这里的JSON只存在于process
transport；response验证并materialize后即可丢弃，绝不复制到Linear description/comment或Git workflow file。

Protocol传输Symphony session/turn correlation，不传raw Provider conversation pointer。Performer不能callback Conductor，也不
返回Linear/Git SDK command。

## 4. Transient Result边界

`RootReconcilerTurnResult`是closed union：

```text
RootNextAction | RootReconcilerTurnFailure
```

Plan/Work/Verify各返回matching closed Result variant。所有Result只属于当前call，至少关联request、role、Root/Cycle/target、
observed digest、session/turn和evidence references。

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

所有third-party response、Linear snapshot、Root action和Stage Result在边界strict validate。JSON Schema使用
`additionalProperties: false`；unknown variant/field、invalid enum、oversized payload、stale correlation、digest mismatch或
incomplete coverage一律fail closed。

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

每个protocol使用显式Result union，不混用throw、null和partial success表达同一失败。跨进程错误包含closed code、category、
sanitized reason、retryability和action required，不返回raw exception、stack、secret或arbitrary details map。

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

- Conductor定义Root safety policy、Root Reconciler client、Stage client、materializer和Git/delivery interfaces；
- Podium实现Linear protocol和内部SDK；
- Performer定义Provider backend与role session runtime；
- schemas是唯一手写wire source，generated code不含business policy；
- Impl不从public exports导出，role不能deep import另一role implementation。

## 11. 不变量

1. public/cross-process input和output使用closed versioned schema。
2. transport JSON是transient，不进入Linear/Git durable workflow content。
3. Result必须materialize为native postcondition并fresh read-back才有业务效果。
4. Linear Gateway只暴露bounded native query/mutation，不暴露SDK或arbitrary GraphQL。
5. session、turn、digest和delta baseline都不是durable checkpoint。
6. secret、SDK object、database record、process handle和raw transcript不跨public boundary。
7. 不存在generated workflow-comment stream、private persistence或legacy comment compatibility interface。
8. Podium-Conductor mutation envelope携带当前private channel绑定的transient Binding generation correlation；Podium按实际
   channel identity验证，不能信任caller提供的generation字符串，旧channel不能提交late mutation。

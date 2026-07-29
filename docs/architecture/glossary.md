# Symphony架构术语表

状态：目标架构提案。本文只规范canonical vocabulary和代码名称，不复制named concern文档中的字段表、状态迁移或恢复算法。

## 1. 使用规则

1. 产品、文档、contracts和代码使用本表canonical term。
2. 代码类型使用给出的PascalCase；wire字段使用`lower_snake_case`。
3. Linear description/comment是ordinary Markdown，不存在private wire field naming。
4. 一个术语的业务规则只在链接的owner文档定义。

## 2. 产品角色

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Symphony | product | Podium Desktop、Podium、Conductor和Performer组成的一个产品 |
| Podium Desktop | `@symphony/podium-desktop` | Tauri control-plane UI；不承载workflow UI |
| Podium | `@symphony/podium` | Linear OAuth、tokens、catalog、Binding、SDK和`podium.db` owner |
| Conductor | `@symphony/conductor` | deterministic Root host、Linear/Git materializer和Performer caller |
| Performer | `symphony_performer` | Python Provider runtime和role sessions owner |
| Root Reconciler | role | 唯一model-driven workflow next-step role |
| Plan Role | role | 生成Plan proposal，不决定下一步 |
| Work Role | role | 修改matching Root worktree中的selected Work target |
| Verify Role | role | 只读验证immutable revision |

## 3. Project与Binding

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Conductor Binding | `ConductorBinding` | Podium持久化的Conductor、Linear installation、repository和Profile binding |
| Conductor Project Label | `ConductorProjectLabel` | Root到Binding/Project pool的native Linear routing label |
| Resolved Conductor Project | `ResolvedConductorProject` | 唯一matching label解析出的Project |
| Repository Context | `RepositoryContext` | repository identity、root、base branch和delivery policy |
| Root Iteration Guard | `RootIterationGuard` | 单个Conductor进程内合并matching Root duplicate wake；不是跨进程lease或Linear workflow fact |
| Binding Process Fence | `BindingProcessFence` | OS-backed exclusive runtime lock + Podium channel generation；证明同Binding旧writer不能再mutation，不是workflow authority |

`ConductorBinding`包含`bindingId`、`conductorId`、Linear installation/organization和`RepositoryContext`。
credential、SDK object和process handle不属于该DTO。

## 4. Workflow authority与恢复

完整语义只见[Workflow Authority与恢复](workflow-authority-recovery.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Native Root Object Graph | `NativeRootObjectGraphSnapshot` | Root及全部active/archived descendants、native fields、comments和Activity的fresh snapshot |
| Root Reconstruction Set | `RootReconstructionSet` | worktree loss后用于fresh generation的Root current facts与repository base facts |
| Root Reconciliation View | `RootReconciliationView` | native graph + Git派生的单次runtime view |
| Worktree Gate | `RootWorktreeGateResult` | 任何恢复前验证expected worktree existence与identity的closed result |
| Execution Generation | domain term | 一个Root worktree与其Cycle/Stage execution descendants；worktree loss使当前generation失效 |
| Normal Convergence | domain term | worktree有效时从current native facts选择one next action |
| Full Execution-tree Rebuild | domain term | worktree与required Git execution facts都不可恢复时，逐action archive old tree并创建fresh branch/worktree/tasks |
| Native Activity | Linear object | status、label、description、relation、comment/thread变化的actor/timestamp history |

## 5. Root与DAG

具体status和topology只见[Root Issue工作流](root-issue.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Root Issue | `RootHeader` / `root_issue_id` | matching routing/delegation的top-level Linear Issue |
| Root Run | domain term | Symphony处理一个Root的完整lifecycle |
| Cycle Issue | `CycleIssueSnapshot` | Root direct child；一轮Plan/Build/Verify attempt container |
| Plan Node | `PlanNodeSnapshot` | Plan Stage native Issue |
| Work Node | `WorkNodeSnapshot` | 一个self-contained Work target native Issue |
| Verify Node | `VerifyNodeSnapshot` | immutable target verification native Issue |
| Finding Issue | `FindingIssueSnapshot` | Verify发现的native Cycle child Issue |
| Native Archive Membership | `is_archived` | 是否参与active DAG；archived object仍属于Root history |
| Node Readiness | `NodeReadiness` | 从current status/dependencies/Git派生的runtime值 |
| Cycle Lineage | native Root children + `(created_at, issue_id)` order | Cycle predecessor/successor顺序；不伪造Linear relation |
| Replacement Relation | native relation | fresh Issue替代terminal/invalidated target |

`Todo`是唯一dispatchable node state。`Interrupted`、`Done`、`Failed`和`Canceled`是terminal attempt states。

## 6. Root Reconciliation

具体contract只见[Root Reconciliation](root-reconciliation.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Requirement And Comment Gate | `requirement_and_comment` | 定义需求并解释ordinary human input |
| Plan Human Decision Gate | `plan_human_decision` | 解释Plan rejection、clarification或有歧义的approval reply |
| Recovery Strategy Gate | `recovery_strategy` | 对blocked、failed、inconclusive或Finding选择业务策略 |
| Terminal Review Gate | `terminal_review` | terminal Cycle后判断successor、human decision或delivery intent |
| Root Semantic Intent | `RootSemanticIntent` | matching gate的一次closed transient semantic output |
| Root Transition | `RootTransition` | native facts到mechanical target、semantic gate、external wait或terminal的pure decision |
| Root Bootstrap Snapshot | `RootBootstrapSnapshot` | fresh session首次接收的完整current projection |
| Root Delta | `RootDelta` | live session current-value/replacement/tombstone transport optimization |
| Root Digest | `RootDigest` | 当前runtime stale-output correlation；不持久化 |
| Mechanical Violation | `MechanicalViolation` | coverage/topology/lifecycle/actor/Git safety finding；不选择业务修复 |

禁止使用持久化next-action object、accepted command log或replay cursor。需要泛指model output时使用`RootSemanticIntent`。

## 7. Human interaction

完整语义只见[Human Action](human-actions.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Human Action Request | `HumanActionRequestThreadSnapshot` | Root top-level Symphony-authored native comment thread |
| Human Reply | `HumanCommentInput` | authorized human在matching thread中的ordinary Markdown reply |
| Human Resolution Reply | `HumanResolutionReply` | target consequence read-back后写入同thread的concise Symphony reply |
| Comment Receipt | `CommentReceiptDisposition` | Symphony check/cross reaction；只表示body已处理 |
| Active Human Action | derived fact | 业务resolution尚未materialize的request thread |
| Plan Approval | domain term | exact mentioned Plan的人类批准，不跨replacement target继承 |

Human Action不是Issue、private payload或Desktop View。native thread resolved state和reaction本身不表示approval。

## 8. Stage contracts

完整语义只见[Performer Stage Contracts](stage-orchestration.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Stage Turn Request | `PlanTurnRequest` / `WorkTurnRequest` / `VerifyTurnRequest` | closed transient role input |
| Stage Turn Response | `PlanTurnResponse` / `WorkTurnResponse` / `VerifyTurnResponse` | semantic Stage Result或mechanical Stage Turn Failure的closed transient envelope |
| Stage Result | `PlanResult` / `WorkResult` / `VerifyResult` | model-generated semantic role output；必须materialize为native facts |
| Stage Turn Failure | `StageTurnFailure` | Performer-generated mechanical terminal failure；不能伪造Stage Result |
| Stage Role Session | `StageRoleSession` | Cycle-scoped Provider runtime continuity |
| Work Agent Tree | `WorkAgentTree` | 一个persistent Work root与matching turn-scoped recursive descendants组成的runtime tree；完整语义见[Work Subagents](work-subagents.md) |
| Work Agent Tree Root | `WorkAgentTreeRoot` | tree中唯一生成matching `WorkResult`的Work Provider thread；不是Linear Root Reconciler |
| Work Subagent | `WorkSubagent` | Work-owned独立Provider thread；不是Stage、Issue或workflow actor |
| Work Agent Path | `WorkAgentPath` | `/root/...` runtime寻址；descendant path在turn epoch结束后失效，不是durable identity |
| Work Turn Epoch | `WorkTurnEpoch` | 绑定一个`stage_execution_id`且只能retire或fence一次的descendant、budget与mutation lifetime |
| Work Write Lease | `WorkWriteLease` | 从parent lease原子切分给matching dispatch、按generation在每次mutation强制并从叶到根归还的workspace path subset |
| Work Runtime Containment | `WorkSessionContainment` / `WorkMutationContainment` | 防止tool writer逃逸并支持write revocation与empty/isolated proof的runtime boundary |
| Runtime Model Observation | `RuntimeModelObservation` | actual model/usage日志观测；不写Linear |
| Immutable Verify Target | `immutable_target_revision` | Verify与delivery共同绑定的Git commit |

Stage response、execution correlation、approved Plan和model observation都不得命名成durable private object。

## 9. Linear Gateway

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Linear Gateway | `LinearGatewayInterface` | Conductor定义的bounded native Linear能力边界 |
| Project Root Index Page | `ProjectRootIndexPage` | bounded Root header page；不是durable cache |
| Root Header | `RootHeader` | admission/scheduling所需bounded native facts |
| Native Linear Mutation | `WorkflowMutationCommand` | explicit target/preconditions/desired native state |
| Mutation Read-back | `WorkflowMutationResult` | fresh semantic postcondition或closed failure |
| Source Coverage | `WorkflowSourceCoverage` | complete/omissions证明 |

`LinearGatewayInterface <- PodiumLinearGatewayClientImpl -> LinearGatewayProtocol -> LinearGatewayProtocolHandlerImpl ->
LinearClientInterface <- LinearSdkImpl`。只有最后一层可以使用Linear SDK。

## 10. Conductor modules

| Module | Canonical responsibility |
|---|---|
| `root-discovery` | Project/routing/delegation/header discovery |
| `root-scheduling` | eligibility、fairness和进程内`RootIterationGuard` |
| `root-reconciliation` | current view、coverage、delta与mechanical safety |
| `root-transition` | pure native-fact transition与mechanical target derivation |
| `root-reconciler-client` | Root Reconciler session transport |
| `root-intent-materialization` | RootSemanticIntent compile、validation与native postcondition convergence |
| `performer-agent-client` | Reconciler/Stage request-response transport |
| `human-actions` | Root request thread与human dispositions |
| `performer-profiles` | Profile store/control |
| `git-workspaces` | Root worktree、branch和commit mechanics |
| `root-delivery` | push、PR/link和Root delivery gate |
| `runtime-logs` | sanitized logs/metrics |

## 11. Performer与Profile

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Provider Backend | `ProviderBackendInterface` | Performer内部Provider能力边界 |
| Codex Backend | `CodexBackendImpl` | 当前唯一Provider implementation |
| Performer Profile | `PerformerProfile` | Conductor保存的Codex login context和turn settings |
| Active Performer Profile | `activeProfileId` | 新Root使用的Profile |
| Root Profile Label | native Linear label | Root首次执行前固定matching Performer Profile；不使用comment payload |
| Codex Home | `CODEX_HOME` | Codex SDK-owned auth/session/runtime root |
| Codex Turn Settings | `CodexTurnSettings` | model、reasoning effort、speed和execution policy |
| Profile Readiness | `PerformerProfileReadiness` | login-required、ready或invalid |

## 12. Git与delivery

完整语义只见[Git Worktree与交付](git-worktree-delivery.md)。

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Git Workspace | `GitWorkspaceSnapshot` | deterministic Root branch + worktree |
| Delivery Branch | `DeliveryBranch` | Root-scoped Git branch |
| Root Delivery Result | `RootDeliveryResult` | current call的transient PR/branch delivery output |
| Pull Request Link | native attachment/relation | Root到SCM PR的durable Linear reference |

Git/SCM current facts和Root native status/link共同证明delivery；不存在Delivery Record或receipt。

## 13. Podium与Desktop

| Canonical term | 代码名 | 定义 |
|---|---|---|
| Podium Client Protocol | `PodiumClientProtocol` | React与Podium backend的closed protocol |
| Desktop Host Protocol | `DesktopHostProtocol` | Podium backend与Tauri host的local protocol |
| Conductor Runtime Protocol | `ConductorRuntimeProtocol` | handshake、health和shutdown protocol |
| Desktop View | `PodiumView` | connection/process/Profile control read model；不含workflow state |

## 14. E2E

| Canonical term | 定义 |
|---|---|
| Parallel Black-Box E2E Campaign | test-only foreground runner；不是product control plane |
| E2E Human Actor | 独立Linear human identity |
| Final Evidence Snapshot | settle后fresh-read的native Linear/Git facts |
| E2E Case Verdict | runner内存`passed | failed | incomplete`；不写产品系统 |

完整语义只见[并行黑盒端到端验收](black-box-e2e.md)。

## 15. 禁止的旧术语

以下概念不属于目标架构：

```text
comment/description中的private machine payload
durable ownership、next-action、Stage Result或delivery object
persisted model-turn或usage aggregate
generated Root/Cycle event comment stream
把Human Action建成descendant Issue
workflow DB / checkpoint / replay cursor
```

看到这些名称应删除或改为本表对应的native/transient概念，不能增加compatibility alias。

## 16. 文档审阅规则

- 状态与tree规则引用`root-issue.md`；
- durable/recovery规则引用`workflow-authority-recovery.md`；
- Human comment规则引用`human-actions.md`；
- Stage wire规则引用`stage-orchestration.md`；
- Work内部agent-tree规则引用`work-subagents.md`；
- Git规则引用`git-worktree-delivery.md`；
- public schema规则引用`contracts.md`；
- glossary只命名，不定义第二套行为。

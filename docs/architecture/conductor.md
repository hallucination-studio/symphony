# Conductor职责与模块边界

状态：目标架构提案。本文定义Conductor角色和模块边界。Root语义由
[Root Reconciliation](root-reconciliation.md)定义；恢复由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。

## 1. 职责

Conductor负责：

- 通过`LinearGatewayInterface`解析Project、routing、delegation和完整native Root object graph；
- 运行不调用模型的Root deterministic convergence host；
- 验证active/archived coverage、status catalog、actor、remote preconditions、capability和Git facts；
- 从complete native facts推导`mechanical_target | semantic_gate | external_wait | terminal | invalid_facts`；
- 编译并模拟candidate Root graph，执行initial Cycle creation、complete Plan DAG materialization、ready Work selection、Stage dispatch、
  immutable Verify target preparation和successful Cycle closure；
- 把存在业务歧义的topology/lifecycle/Git恢复选择送入matching Root semantic gate；
- 调用Performer Root Reconciler与Plan/Work/Verify roles；
- 验证transient typed Stage response，将semantic Result或mechanical failure收敛为native Linear/Git facts；
- materialize Human Action Root comment threads及ordinary human receipts/replies；
- 管理Root branch/worktree、immutable revision、PR和delivery；
- 输出sanitized structured logs/metrics。

Conductor不负责：

- Provider SDK、model prompt loop或transcript；
- 在存在业务歧义时替代Root Reconciler作决定；
- 保存workflow DB、DAG mirror、queue、checkpoint或durable command log；
- 写Root/Cycle event stream、机器JSON comment或内部receipt；
- Linear OAuth、token、SDK或GraphQL implementation。

## 2. 模块

```text
apps/conductor/src/
  composition/
  linear-gateway/
  root-discovery/
  root-scheduling/
  root-reconciliation/
  root-reconciler-client/
  root-transition/
  root-intent-materialization/
  performer-agent-client/
  human-actions/
  git-workspaces/
  root-delivery/
  performer-profiles/
  runtime-logs/
  private-ipc/
```

| 模块 | 职责 |
|---|---|
| `root-discovery` | Project、routing、native delegation与header discovery；未委派Root零副作用 |
| `root-scheduling` | eligibility、Priority和runtime single-owner lease；不拥有Root语义 |
| `root-reconciliation` | current view、coverage、diff、graph validation和mechanical limits |
| `root-transition` | pure native facts到mechanical target、semantic gate、external wait、terminal或invalid facts的transition |
| `root-reconciler-client` | fresh bootstrap/live delta transport与Root Reconciler调用 |
| `root-intent-materialization` | 编译RootSemanticIntent并收敛required native postconditions和human dispositions |
| `performer-agent-client` | Root Reconciler与Stage session/turn transport |
| `human-actions` | Root request thread、actor、reply/reaction/thread-state materialization与Root summary |
| `git-workspaces` | Root branch/worktree、commit和Git facts |
| `root-delivery` | push、PR/link和Root `In Review` delivery gate |

`root-reconciliation`不能import Provider SDK；`root-reconciler-client`不能materialize intent；
`root-transition`和`root-intent-materialization`不能调用模型。

## 3. 可重建View

```text
RootReconciliationView
  root_header
  complete_active_and_archived_object_graph
  human_comment_threads
  mechanical_violations
  current_project_and_profile_limits
  git_workspace_and_delivery_facts
```

View只存在于单次runtime iteration。Podium/Linear coverage不完整时fail closed；不得从旧View、webhook cache或Provider
conversation补齐。

## 4. 调用与materialization

Conductor首先执行Workflow Authority文档的worktree gate，再运行deterministic transition。只有结果为`semantic_gate`时才打开或
推进matching Root Reconciler；live session可以使用delta，session丢失或baseline不连续时fresh bootstrap。

Root Reconciler返回一个gate-specific closed `RootSemanticIntent`或failure。Conductor不持久化output object：它从fresh facts生成
preconditions，编译完整candidate graph，将target拆为independently durable effects，并在每个targeted read-back后继续机械收敛。

Stage response同样只在当前call中存在；semantic Result按[Root Issue工作流](root-issue.md)转成native facts，mechanical
`StageTurnFailure`先收敛唯一合法的mechanical consequence；存在业务取舍时按
[Root Reconciliation](root-reconciliation.md#10-humanfinding与failure)进入`recovery_strategy`。

## 5. Session client

```text
PerformerAgentClientInterface
  openRootReconciler(input)
  advanceRootReconciler(input)
  executePlanTurn(input)
  executeWorkTurn(input)
  executeVerifyTurn(input)
  closeCycleStageSessions(input)
  closeRootReconciler(input)
```

Conductor拥有process/channel/cancellation。opaque Provider/session handle只存在runtime memory，不进入Linear或public business
contract。late output必须通过session/turn/digest validation拒绝。

## 6. Human Action

Conductor可从Plan Result机械创建exact Plan approval request；其他request由matching semantic gate提出。它验证author、target
mentions、human actor、replies、reactions和thread state，不能自行解释有歧义的human选择。完整模型只见
[Human Action](human-actions.md)。

## 7. Git与delivery

一个Root固定一个active branch/worktree。Work只能修改workspace；Conductor独占commit、Git topology、push、PR和cleanup。
Verify与delivery绑定same immutable revision。完整mechanics只见
[Git Worktree与交付](git-worktree-delivery.md)。

## 8. 错误与恢复

- malformed/stale Root semantic intent或Stage response不materialize；
- process crash不恢复memory decision，按Workflow Authority文档fresh converge；
- target `In Progress`在process loss后不能重新dispatch；
- routing/process generation/profile/worktree无法验证时取消matching sessions并拒绝late output；
- required native mutation/read-back失败时停止Root并记录sanitized actionable error；
- 只有用户需要采取行动时才写一条human-readable comment；内部细节只进入logs/metrics；
- Project discovery transient failure进入bounded degraded/backoff，不终止其他Bindings。

## 9. 不变量

1. Conductor运行deterministic convergence host，不运行模型或Provider SDK。
2. 唯一可推导的workflow transition来自fresh native facts；业务歧义只来自matching Root semantic gate。
3. Conductor是Linear/Git副作用和Performer调用的唯一owner。
4. active和archived descendants都必须读取；只有active `Todo` node可dispatch。
5. Result materialize为native facts并read-back后才影响下一轮。
6. Conductor不保存workflow数据库、queue、checkpoint、command log或Provider pointer。
7. Conductor不发布Root/Cycle comment stream，也不持久化机器payload。
8. transition policy可以选择唯一合法的mechanical status、Stage、DAG和Cycle target，但不能替代semantic gate选择业务策略。
9. repair-attempt hard limit的唯一后果由fresh native facts编译为mechanical Cycle closure；Root模型不批准hard-policy enforcement。
10. max-Cycles只关闭terminal review的successor capability；Conductor用fresh Cycle count复核command并在越界topology上zero mutation
    fail closed，不创建generic limit turn或机械取消Cycle。
11. Root deadline关闭execution admission但保留已完成success evidence；unfinished Cycle经session fence后先机械`Recovery Abandoned`，
    下一fresh pass再机械取消Root，terminal delivery review不能在deadline后创建任何successor或delivery recovery execution。
12. repeated-Finding hard limit只接受相邻Cycle上的directed single-chain lineage；达到上限后Conductor完成session fence并机械关闭exact
    active Cycle，保留全部Finding evidence，restart进入non-success review而不重复调用Finding recovery gate。

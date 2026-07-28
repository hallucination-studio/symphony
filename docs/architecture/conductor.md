# Conductor职责与模块边界

状态：目标架构提案。本文定义Conductor角色和模块边界。Root语义由
[Root Reconciliation](root-reconciliation.md)定义；恢复由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。

## 1. 职责

Conductor负责：

- 通过`LinearGatewayInterface`解析Project、routing、delegation和完整native Root object graph；
- 运行不调用模型的Root Reconciliation host；
- 验证active/archived coverage、status catalog、actor、remote preconditions、capability和Git facts；
- 把topology/lifecycle/Git矛盾作为mechanical violations交给Root Reconciler，不自行选择修复；
- 调用Performer Root Reconciler与Plan/Work/Verify roles；
- 验证transient typed Stage response，将semantic Result或mechanical failure收敛为native Linear/Git facts；
- materialize Human Action Root comment threads及ordinary human receipts/replies；
- 管理Root branch/worktree、immutable revision、PR和delivery；
- 输出sanitized structured logs/metrics。

Conductor不负责：

- Provider SDK、model prompt loop或transcript；
- 解释Stage Result或human input来选择下一步；
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
  root-action-materialization/
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
| `root-reconciliation` | current view、coverage、diff、safety validation和mechanical limits |
| `root-reconciler-client` | fresh bootstrap/live delta transport与Root Reconciler调用 |
| `root-action-materialization` | 验证并收敛one RootNextAction及required human dispositions |
| `performer-agent-client` | Root Reconciler与Stage session/turn transport |
| `human-actions` | Root request thread、actor、reply/reaction/thread-state materialization与Root summary |
| `git-workspaces` | Root branch/worktree、commit和Git facts |
| `root-delivery` | push、PR/link和Root `In Review` delivery gate |

`root-reconciliation`不能import Provider SDK；`root-reconciler-client`不能materialize action；
`root-action-materialization`不能调用模型。

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

Conductor首先执行Workflow Authority文档的worktree gate，再打开或推进Root Reconciler。live session可以使用delta；session
丢失或baseline不连续时fresh bootstrap。该transport优化不改变每轮都以current Linear/Git facts验证materialization的要求。

Root Reconciler返回一个closed `RootNextAction`或failure。Conductor不持久化output object：它验证preconditions，收敛一个
bounded native postcondition，fresh read-back后丢弃output。partial/ambiguous mutation重新读取current state；不回放旧action。

Stage response同样只在当前call中存在；semantic Result按[Root Issue工作流](root-issue.md)转成native facts，mechanical
`StageTurnFailure`按[Root Reconciliation](root-reconciliation.md#10-humanfinding与failure)进入fresh next-action判断。

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

Conductor只materialize Root Reconciler提出的Root request comment和resolution consequences，并验证author、target mentions、
human actor、replies、reactions和thread state。它不能自行创建request或解释human选择。完整模型只见
[Human Action](human-actions.md)。

## 7. Git与delivery

一个Root固定一个active branch/worktree。Work只能修改workspace；Conductor独占commit、Git topology、push、PR和cleanup。
Verify与delivery绑定same immutable revision。完整mechanics只见
[Git Worktree与交付](git-worktree-delivery.md)。

## 8. 错误与恢复

- malformed/stale Root action或Stage response不materialize；
- process crash不恢复memory decision，按Workflow Authority文档fresh converge；
- target `In Progress`在process loss后不能重新dispatch；
- routing/process generation/profile/worktree无法验证时取消matching sessions并拒绝late output；
- required native mutation/read-back失败时停止Root并记录sanitized actionable error；
- 只有用户需要采取行动时才写一条human-readable comment；内部细节只进入logs/metrics；
- Project discovery transient failure进入bounded degraded/backoff，不终止其他Bindings。

## 9. 不变量

1. Conductor运行deterministic host，不运行模型或Provider SDK。
2. workflow next step只来自Root Reconciler transient result。
3. Conductor是Linear/Git副作用和Performer调用的唯一owner。
4. active和archived descendants都必须读取；只有active `Todo` node可dispatch。
5. Result materialize为native facts并read-back后才影响下一轮。
6. Conductor不保存workflow数据库、queue、checkpoint、command log或Provider pointer。
7. Conductor不发布Root/Cycle comment stream，也不持久化机器payload。
8. safety policy只返回mechanical findings，不能选择status、Stage、Human Action、DAG、Cycle或delivery动作。

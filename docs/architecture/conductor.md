# Conductor职责与模块边界

状态：目标架构提案。本文定义Conductor的角色和模块边界。Root与Cycle控制算法、用户comment处理和
Root Reconciler协议由[Root Reconciliation](root-reconciliation.md)定义。

## 1. 职责

Conductor负责：

- 通过`LinearGatewayInterface`解析Project、routing、ownership和完整Root Tree；
- 运行不调用模型的Root Reconciliation host；
- 显式读取active和archived Cycle children；
- 验证status catalog、archive membership、DAG、remote version、budget和Git preconditions；
- 构造完整Root observation并主动调用Performer Root Reconciler；
- 校验、持久化和materialize accepted `RootDirective`；
- 构造Plan/Work/Verify强类型request并调用对应Performer role thread；
- 验证和持久化Stage Results，再交给Root Reconciler；
- 创建Human Action、处理Human status/comments并持久化resolution；
- 过滤普通human comment，并把disposition/reply作为accepted directive的required Linear materialization；
- 管理Root worktree、commit、delivery和Root convergence；
- 发布typed workflow timeline events。

Conductor不负责：

- Provider SDK、模型prompt loop、thread或transcript；
- 解释Plan/Work/Verify Result并自行选择Cycle下一步；
- 保存Workflow DB、DAG mirror、Queue、checkpoint或durable event bus；
- 直接拼接Root/Cycle用户时间轴comment；
- Linear OAuth、Token、SDK或GraphQL实现。

## 2. 模块

```text
apps/conductor/src/
  composition/
  linear-gateway/
  root-discovery/
  root-scheduling/
  root-reconciliation/
  root-reconciler-client/
  root-directive-materialization/
  performer-agent-client/
  human-actions/
  git-workspaces/
  root-delivery/
  workflow-events/
  timeline-projections/
  performer-profiles/
  runtime-reporting/
  private-ipc/
```

| 模块 | 职责 |
|---|---|
| `root-discovery` | Project、Root routing、ownership和header discovery |
| `root-scheduling` | blocker、Priority、Root order和capacity |
| `root-reconciliation` | deterministic host、Root action和convergence gate |
| `root-reconciler-client` | 构造完整Root observation并调用Root Reconciler |
| `root-directive-materialization` | 校验、幂等执行和read-back Root directive及required user replies |
| `performer-agent-client` | Root Reconciler和三个Stage role session/turn transport |
| `human-actions` | Action Issue、labels、status/comment validation和resolution |
| `workflow-events` | 发布closed timeline events |
| `timeline-projections` | Root/Cycle timeline subscriber和closed renderer |
| `git-workspaces` | Root branch/worktree、commit和Git facts |
| `root-delivery` | PR/branch delivery |

`root-reconciliation`不能import Provider或Agent SDK。`timeline-projections`不能决定workflow mutation。
`root-reconciler-client`不能materialize directive；`root-directive-materialization`不能调用模型。

## 3. 可重建View

```text
RootReconciliationView
  root
  routing_and_ownership
  ordered_cycles[]
    cycle
    is_archived
    complete_tree
  root_human_actions[]
  convergence_policy_and_view
  performer_profile
  git_workspace
  delivery
```

View是单次reconciliation内存对象，不持久化。Linear SDK默认省略archived Issues时，gateway必须使用明确的
include-archived读取并分页到完整；无法证明完整时fail closed。

## 4. 调用和materialization

```text
fresh view
-> deterministic Root action
-> if semantic workflow decision required:
     advance Root Reconciler
     validate RootDirective
     persist accepted directive
-> materialize one action
-> semantic read-back
-> materialize and read back required user-comment replies
-> publish and materialize typed timeline event
-> discard view
```

所有mutation使用stable write/directive/execution ID和remote preconditions。一次directive可以描述一个领域级
Tree patch；其内部多条Linear mutation必须幂等收敛，不能在partial failure后要求模型重新生成另一份patch。

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

Conductor拥有process/channel和cancellation。opaque session handle只存在于runtime内存，不进入Linear或公共
业务contract。handle丢失时使用完整durable facts重新open，不恢复raw Provider pointer。

## 6. Human Action

Root Reconciler通过closed directive请求Cycle或Root Action；Conductor验证后创建matching直接子Issue、kind labels、
relations、description和managed record。用户Action status/comment变化由Conductor验证并形成resolution，再把完整
Root Tree交回Reconciler。Plan/Work/Verify不能直接创建Action。

Root convergence Action由机械Root gate产生，不能被Reconciler放宽。完整交互由
[Human Action](human-actions.md)定义。

## 7. Timeline事件

业务模块在durable read-back后发布`WorkflowTimelineEvent`。Root和Cycle subscriber分别把matching comment写入
Linear并read-back。create/read-back失败时当前Root停止推进并记录correlated error；恢复后从Linear source record
重试同一deterministic event ID，成功前不调用模型或执行下一动作。完整机制由
[Workflow Timeline](workflow-timeline.md)定义。

## 8. Git与delivery

一个Root固定一个branch/worktree，所有Cycles复用。Work Performer可以修改授予的workspace，但commit、Git
topology和delivery只由Conductor执行。Verify绑定immutable revision；delivery要求matching passed Verify和
verified HEAD。

## 9. 错误与恢复

- malformed/stale directive或Result不materialize，错误作为durable observation/attention进入下一轮；
- process crash后不恢复内存decision，从Linear/Git重建；
- duplicate webhook只wake，同一stable ID不会产生重复mutation/comment；
- Root terminal、ownership/Profile变化立即取消matching sessions并拒绝late output；
- 任何required Linear mutation、Reconciler reply或timeline comment写入/read-back失败时停止当前Root并记录错误；
- 所有用户可见错误必须sanitized、actionable并有source correlation。

## 10. 不变量

1. Conductor运行确定性Root Reconciliation host，不运行模型或Agent SDK。
2. Root和Cycle语义只来自Root Reconciler directive。
3. Conductor是Linear/Git workflow副作用和Performer调用的唯一owner。
4. active和archived Issues都必须读取；只有active DAG可dispatch。
5. 每次accepted Result先durable，再交给Root Reconciler。
6. 时间轴通过event subscriber解耦；用户comment reply属于RootDirective materialization，两者都必须Linear read-back。
7. Conductor不保存Workflow数据库、durable Queue或Providerconversation pointer。

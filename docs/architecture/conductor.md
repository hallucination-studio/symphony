# Conductor无数据库Root调度与Harness设计

状态：目标架构提案。Conductor使用一个Conductor Binding，并通过Conductor Project Label解析
Resolved Conductor Project；它没有Workflow、Root Run、dispatch或checkpoint数据库。

## 1. 职责

Conductor负责：

- 通过`LinearGatewayInterface`解析Project、全量发现含bounded Primary Comment的Root headers并按需
  读取完整Issue Trees；
- 从Root Primary Status Comment、Tree和Git重建可丢弃`RootRunView`；
- 判断Root是runnable、waiting human、needs attention还是terminal；
- 按blocker、Linear Priority、Root order和identifier选择一个Root；
- 创建或resume该Root的Provider Conversation；
- 组装trusted Root Harness、human context和closed command catalog；
- 启动一个Python Performer Root Turn并监管其process tree；
- 在每个Agent command前fresh验证Root scope、remote/Git precondition；
- 维护Root deterministic branch/worktree、commit和delivery；
- 保存Performer Profiles和active Profile ID，并通过Performer执行SDK login/status；
- 把错误、retry和delivery以脱敏、人可理解的方式显示在Linear/Desktop。

Conductor不负责：

- Linear OAuth、Token、SDK或GraphQL；
- Provider SDK、Codex-owned文件或Provider transcript；
- 决定或保存current Leaf、Plan/Work/Gate transition；
- 保存Workflow DB、Root Queue、Leaf dispatch、attempt、checkpoint或Result ledger；
- 自动merge target branch。

## 2. 模块

```text
apps/conductor/src/
  main.ts
  composition/
  linear-gateway/
  root-discovery/
  root-scheduling/
  linear-tree/
  agent-symphony-harness/
  performer-profiles/
  performer-turns/
  git-workspaces/
  root-delivery/
  runtime-reporting/
  private-ipc/
```

| 模块 | 职责 | 关键接口 |
|---|---|---|
| `linear-gateway` | Podium private protocol adapter | `LinearGatewayInterface` |
| `root-discovery` | Project解析、Root发现、blocker和ownership | `LinearGatewayInterface` |
| `root-scheduling` | Root readiness、Priority和Root order | `RootSchedulingPolicyInterface` |
| `linear-tree` | validate/normalize完整Root Tree和bounded context | `LinearTreeContextInterface` |
| `agent-symphony-harness` | Conversation、Root context、broker、Root Turn和read-back | `AgentSymphonyHarnessInterface`、`AgentCommandBrokerInterface` |
| `performer-profiles` | Profile store、active选择、SDK login/status control | `PerformerProfileStoreInterface`、`PerformerProfileControlInterface` |
| `performer-turns` | Conversation bootstrap和Root Turn subprocess | `PerformerProcessInterface` |
| `git-workspaces` | deterministic branch/worktree、safe commit/checks | `GitWorkspaceInterface` |
| `root-delivery` | push并交付PR/remote/local branch | `RootDeliveryInterface` |
| `runtime-reporting` | 脱敏日志、usage和Desktop views | `ConductorRuntimeReporterInterface` |

`linear-tree`不选择下一Leaf；Root Agent按Harness规则和最新Linear顺序解释Tree。其他模块不能另建
Agent command入口或业务调度循环。

## 3. 可重建View

```text
RootRunView
  root_issue
  resolved_conductor_project
  root_primary_status_comment
  optional_activity_projection
  complete_issue_tree
  blocker_relations
  performer_profile
  git_workspace
  delivery
```

`RootRunView`是一次poll/Turn的内存组合，不持久化。`performer_id`来自Linear Root；branch、commit、
diff和PR来自Git/SCM；Profile定义来自Conductor明文配置。Profile配置是运行前提，不承载Workflow。

## 4. 主循环

```text
while running:
  project = resolve Project from the Conductor Project Label
  headers = progressively page delegated non-terminal Root headers
  ordered = preserve blockers, Priority, Linear order and identifier ordering

  stop header paging only when the visible boundary proves every unseen Root
    ranks strictly below the selected candidate; otherwise read the next page

  for header in ordered:
    view = lazily reconstruct this candidate from complete Linear Tree and Git
    assessment = agentSymphonyHarness.assessRoot(view)
    if assessment.readiness == runnable:
      selected = fresh-read the complete Root, blockers and Git again
      if selected is still runnable:
        agentSymphonyHarness.runRootTurn(selected)
        break

  discard views, assessments, process results and events
```

没有background business Queue。等待Human的Root释放单机Agent lane，其他Root可以运行。poll interval、
rate-limit backoff和runtime capacity只影响何时再次读取，不改变Linear Priority或Root order。memory
cache只能合并/减少读取；assessment、Conversation和mutation都以fresh facts为准。

分页早停是等价执行优化，不是新的调度语义。边界Priority/order并列、unsupported upstream ordering或
缺少证明时必须继续分页，最终选择必须与完整发现一致。一次Agent command可以使用一个closed、compact、
command-specific fresh scope snapshot完成authority和local scope验证；该snapshot不能用于另一个command，
也不能替代dispatch完整Tree/Git事实或mutation后的semantic read-back。

## 5. Root readiness与调度

```text
RootDispatchAssessment
  readiness: runnable | waiting_human | needs_attention | terminal
  sanitized_reason?
```

assessment只控制Root是否进入scheduler：

- `runnable`：Root仍由当前Conductor拥有、无未解决Root blocker、Profile可用，且Tree/Git存在Agent可推进内容；
- `waiting_human`：Tree顺序要求先完成一个Human child；
- `needs_attention`：ownership、Profile、Tree或Git事实冲突，不能安全运行；
- `terminal`：Root Done/Canceled，或In Review且没有新增/重开工作。

assessment不是closed workflow action union，不包含Plan、Work、Gate、Delivery或target Leaf。每轮从
最新事实重算；问题消失后Root自然恢复。

## 6. Conversation bootstrap与retry

未claim Root只有在active Profile ready时开始。Conductor先写Root ownership、固定Profile和
deterministic branch，再调用无业务副作用的`openRootConversation`。新`performer_id`通过remote
precondition写入Root Primary Status Comment并read-back成功后，才启动业务Root Turn。

正常Turn crash/timeout保留current `performer_id`，下一次Root Turn尝试resume。只有closed
`RootConversationUnavailableResult`或确实缺失current pointer时，Harness执行Root-level retry：

1. 取消旧Turn并终止旧process tree；
2. 记录预期current pointer：Provider失效路径为失败ID，pointer缺失路径为`none`；
3. read-back确认Linear current pointer仍等于该预期值；
4. append一条去重的Root retry comment；
5. 使用Root固定Profile创建新Conversation；
6. 从该预期值compare-and-set新ID并read-back；
7. 重建整个RootRunView并把Root重新交给Root scheduler。

retry不修改Leaf states、不reset worktree、不删除commits，也不恢复旧Leaf/attempt/checkpoint。current
pointer替换后，旧Conversation的command和Result因`performer_id`不匹配而失效。

## 7. Agent command broker

Conductor通过`AgentCommandBrokerInterface`向Root Turn提供private、turn-scoped command channel。
每个command验证：

- Turn、Root和current `performer_id`；
- current Resolved Project和full `conductor_id`；
- Root尚未Done/Canceled；
- target仍在当前Root Tree且command/effect被允许；
- expected remote version、state、parent和Git HEAD；
- mutation完成后的semantic read-back。

每个command在last responsible point只获取一次与该command匹配的fresh scope snapshot，并在该command
内部复用。mutation、commit和delivery仍在副作用前验证各自remote/Git precondition；不得用Turn启动时
的view、memory cache或前一个command的snapshot授权副作用。

Broker只调用`LinearGatewayInterface`、`GitWorkspaceInterface`或`RootDeliveryInterface`。Agent看不到
Linear Token、SDK、GraphQL、Profile credential、process handle或arbitrary mutation。

CLI help、JSON catalog、prompt examples、schema和broker dispatch来自同一command registry。create和
comment使用稳定`write_id`；unconfirmed write先read-back，不盲目重放。

## 8. Performer Result

Performer contract只有Conversation bootstrap和Root Turn。Conductor验证protocol、Turn、Root、Profile、
current Conversation、context digest、Project和Root terminal state。

`RootTurnCompletedResult`只接受bounded summary、yield reason和Turn/Provider usage。任何Plan、
Human、Work、Gate或Delivery结论
如果没有通过broker写入Linear/Git，都视为丢失，不能在Result返回后由Conductor补成业务状态。

`command_limit_reached`只表示broker/mutation上限拒绝了后续command，不是Root failure。Conductor完成
fresh read-back并让该Root重新参与Priority调度；它不立即续跑同一Leaf，也不保存remaining limit。
Provider token usage只在完整Turn后观察，不能触发精确的中途取消。

`RootConversationUnavailableResult`走Root retry。其他retryable failure保留事实并有界重调度Root；
需要operator action的failure写Linear/Desktop并使assessment成为`needs_attention`。Conductor不保存
failure count或attempt journal。

新Conversation创建失败时，Conductor以current pointer和Primary remote version为precondition写入
closed Root Retry Block。`AcknowledgeRootRetryBlockCommand`只有在Root ownership、非终态、block
observation和current pointer全部匹配时才能清除；清除read-back前不得重新open Conversation。

## 9. Git与delivery

一个Root固定一个branch和worktree。Performer可以修改文件和运行工具，但commit、Git topology和
delivery只能经broker调用Conductor-owned接口。

`git commit --issue <id>`重新检查Root/Issue scope、Git HEAD和worktree，并使用稳定Root/Issue identity
生成message。`root deliver`重新检查blockers、Tree、completion evidence、checks和delivery identity，
然后创建或复用PR/branch。Conductor不信任Agent Result声明“checks passed”或“delivered”。

Root retry、process crash或Desktop restart都复用同一worktree；不得reset/clean用户或旧Turn留下的
修改。发现identity冲突时进入`needs_attention`。

## 10. 重启

Conductor启动顺序：

1. 读取Binding和Profile配置；
2. 验证当前Conductor generation是唯一实例；
3. 连接Podium private channel；
4. 解析Conductor Project Label；
5. 渐进读取Root headers，仅在严格ordering-boundary proof后早停，否则读完并按Priority/order排列；
6. 按序懒加载候选Tree和current Conversation；
7. dispatch前fresh-read选中Root并inspect其branch/worktree/delivery；
8. 进入正常Root scheduling。

Conductor不恢复旧process、assessment、current Leaf、Turn Result或retry attempt。若旧Conductor
未退出，Host不得启动第二实例；无DB不等于允许双控制器。

## 11. 错误与可见性

同一错误进入structured log、Root Timeline/Primary status、Desktop Root Detail和Attention Item。
原因必须脱敏、稳定、可执行。Heartbeat、tool progress和Turn completion只作为runtime observation，
不写成Workflow事实；Linear只保留Plan、retry、terminal error、Gate findings和delivery等人需要理解
的关键事件。

activity Label是best-effort投影。写Label失败不能改变Root assessment；Root/Tree/Git事实修复后，
下一轮自然恢复，不需要“resume operation”命令。

## 12. 接口命名

```text
LinearGatewayInterface          <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface   <- LinearPriorityRootSchedulingPolicyImpl
LinearTreeContextInterface      <- BoundedLinearTreeContextImpl
AgentSymphonyHarnessInterface   <- AgentSymphonyHarnessImpl
AgentCommandBrokerInterface     <- ScopedAgentCommandBrokerImpl
PerformerProfileStoreInterface  <- FilePerformerProfileStoreImpl
PerformerProfileControlInterface <- SubprocessPerformerProfileControlImpl
PerformerProcessInterface       <- SubprocessPerformerProcessImpl
GitWorkspaceInterface           <- NativeGitWorkspaceImpl
RootDeliveryInterface           <- GitRootDeliveryImpl
ConductorRuntimeReporterInterface <- PodiumConductorRuntimeReporterImpl
```

## 13. 不变量

1. Conductor只调度Root，不调度Plan、Leaf、Gate或Delivery Turn。
2. Root readiness每轮纯计算，不是状态机或持久directive。
3. Leaf顺序由Root Agent从Linear Tree解释，Conductor不保存current Leaf。
4. current Conversation先在Linear确认，再启动业务Root Turn。
5. Conversation loss触发Root-level retry并拒绝旧Conversation副作用。
6. Conductor不保存Workflow、Queue、dispatch、attempt、checkpoint或Result数据库。
7. Result/Event/process exit不能替代Linear/Git read-back。
8. Linear SDK只在Podium，Provider SDK只在Performer。
9. 一个Root一个worktree，V3同时最多一个writer。
10. V4/V5复用Root Harness，不复制顶层调度或恢复控制面。

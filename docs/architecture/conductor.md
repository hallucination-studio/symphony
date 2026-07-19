# Conductor无数据库解释器与调度设计

状态：目标架构提案。Conductor使用一个Conductor Binding，并通过Conductor Project
Label解析Resolved Conductor Project；它没有任何Conductor-owned数据库，只使用明文
Profile配置文件、Git workspace和Codex-owned `CODEX_HOME`。

## 1. 职责

Conductor负责：

- 从`LinearGatewayInterface`读取Roots和Issue Trees；
- 按Conductor Project Label解析Resolved Conductor Project；
- 从Root Phase Label、Root Primary Status Comment、Workflow Tree和Git重建`RootRunView`；
- 比较Root/Work当前输入与最新已消费hash；
- 选择跨Root `RootAction`；
- 解释单Root Workflow Tree并选择最深层Work Leaf；
- 启动Python Performer Turn；
- 保存多个`PerformerProfile`、active Profile ID和deterministic Profile
  `CODEX_HOME`；
- 通过`PerformerProfileControlInterface`触发SDK登录和account/status读取；
- 创建deterministic branch/worktree和commit；
- 决定Linear node/Label/state mutation；
- 执行Root Gate和PR/branch交付。

Conductor不负责：

- Linear OAuth、Token、SDK或GraphQL；
- Provider SDK、SDK登录、Codex-owned文件或thread/session解释；
- 保存`workflow.db`、Queue、checkpoint、Plan Revision或Work Node镜像；
- Podium/Tauri生命周期；
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
  root-workflow/
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
| `root-discovery` | 获取Root、Priority、blocker | `LinearGatewayInterface` |
| `root-scheduling` | Root eligibility和排序 | `RootSchedulingPolicyInterface` |
| `linear-tree` | validate/normalize Workflow Tree、选择Work Leaf/Human Node | `LinearTreeTraversalPolicyInterface` |
| `root-workflow` | 从事实计算`RootAction` | `RootActionPolicyInterface` |
| `performer-profiles` | 保存Profile、active选择并启动SDK login/status control | `PerformerProfileStoreInterface`、`PerformerProfileControlInterface` |
| `performer-turns` | Plan Turn、Work Turn和Root Gate Turn process调用 | `PerformerProcessInterface` |
| `git-workspaces` | deterministic branch/worktree/commit | `GitWorkspaceInterface` |
| `root-delivery` | push并交付PR/remote branch/local branch | `RootDeliveryInterface` |
| `runtime-reporting` | 脱敏日志、Profile/usage和named Desktop View所需报告 | `ConductorRuntimeReporterInterface` |

模块只通过`*Interface`交互；`*Impl`留在Composition Root或模块内部。

## 3. 可重建View

```text
RootRunView
  rootIssue
  resolvedConductorProject
  rootPhase
  rootPrimaryStatusComment
  workflowTree
  blockerRelations
  performerProfile
  gitWorkspace
```

`RootRunView`是一次调度周期的内存对象，不持久化。任何时刻都可以重新通过Linear/Git生成。

## 4. 主循环

```text
while running:
  project = linearGateway.resolveConductorProject(conductorShortHash)
  if project is unbound or conflicted:
    report and wait
    continue
  roots = linearGateway.listRootIssues(project.id)
  candidates = []

  for root in roots:
    view = reconstruct(root)
    action = rootActionPolicy.compute(view)
    if action is runnable:
      candidates.append(action)

  selected = rootSchedulingPolicy.select(candidates)
  execute(selected)
  discard snapshots
```

没有background business queue。Conductor Project Label在每个周期重新解析；poll
interval、backoff和SDK rate-limit属于运行机制，不改变业务顺序。

未claim Root只在active Performer Profile为`ready`时产生`ClaimRootAction`。已有Root
使用Root Primary Status Comment中的`performer_profile_id`，不因active Profile变化而迁移。

## 5. Root Action

`RootActionPolicyInterface`暴露纯决策并返回`RootAction`：

```text
Root state/phase/tree/git
  -> ClaimRootAction
   | PlanRootAction
   | WaitForHumanNodeAction
   | ExecuteWorkLeafAction
   | RunRootGateAction
   | DeliverRootAction
   | IdleRootAction
   | BlockedRootAction
```

`PlanRootAction`同时覆盖首次Plan和Root变化后的重新Plan。
`ExecuteWorkLeafAction`同时覆盖
Todo、In Progress和内容变化后需要重跑的叶子。

In Review或Done Work缺少合法`completed_input_hash`时，Conductor不能建立完成基线，
而是返回`BlockedRootAction`。用户把它移回In Progress后重新执行，或置为Canceled后从
有效Workflow Tree中排除。Blocked条件在每个周期重新计算；事实修复后自然回到对应
Root Phase，不维护单独恢复命令。

选择Work Leaf时只调用`LinearTreeTraversalPolicyInterface`，不得在Conductor另写第二套排序。

## 6. Linear mutation

Conductor不调用SDK，只调用Gateway：

```text
LinearGatewayInterface
  <- PodiumLinearGatewayClientImpl
     -> generated Podium-Conductor Protocol
```

`PodiumLinearGatewayClientImpl`属于Conductor的`linear-gateway`模块，只负责Protocol调用；Podium端的Handler
负责SDK执行。Conductor拥有mutation决策，Podium拥有SDK执行。所有create使用Managed
Marker，所有update只修改Conductor拥有的surface。

每个Project级mutation都携带当前`conductor_short_hash`、`expected_project_id`和
Project remote precondition。修改已有对象时还携带目标Issue/Comment的remote
version、预期state/parent和Managed Marker。任一precondition冲突时，Conductor丢弃
旧View并开始下一轮解析，不能用旧Command覆盖用户刚刚执行的修改。

## 7. Performer Turn

Conductor每次只启动一个Performer process：

```text
build Turn Command
-> resolve performer_profile_id
-> set selected Profile CODEX_HOME
-> load current CodexTurnSettings
-> put closed CodexTurnSettings in Turn Command
-> invoke installed performer command
-> consume bounded Event frames from Turn stdout while process is running
-> read closed Result
-> inspect latest Root/Work inputs and Git state
-> apply result or continue next Turn
```

每个Command只携带一个`turn_input_hash`。Result返回后重新读取Linear/Git：

- Conductor Project Label已不再解析到该Root所属Project：旧Result不推进；
- Result的`performer_profile_id`与Root Primary Status Comment或原始Command不匹配：旧Result
  不推进；不得与当前active Profile比较；
- Root已经Done/Canceled或full `conductor_id`不匹配：旧Result不推进；
- Root/Work state、phase、input hash和结构precondition匹配：按Result执行下一状态；
- hash不匹配：保留worktree，不应用Result，从最新`RootRunView`重新计算下一动作。

Conductor不保留active operation journal。进程中断时：

- Linear Work仍为In Progress；
- Root Primary Status Comment仍有performer_id；
- worktree保留当前文件；
- 下次调度使用同一performer_id和最新Issue snapshot继续。

同一时刻只能有一个Conductor实例控制一个Binding。Performer必须属于Conductor的受控process tree；Desktop Host必须先确认旧Conductor及其Performer child全部退出，再启动replacement。

Profile login、Profile status和业务Performer Turn共享一个全局Performer lane；一个
Conductor同一时刻最多只有一个Performer子进程。Profile配置文件的Update/Activate使用
原子文件替换，不接触`CODEX_HOME`，可以在Turn运行时完成：

- Activate立即改变“新Root使用哪个Profile”；
- 编辑当前Profile的Turn设置只在该Profile下一Turn生效；
- 当前Turn不被抢占；
- login/status在当前Turn结束后执行。

Result返回后，Conductor按固定顺序处理：

1. 重新读取Linear和Git并验证Root、Work、Profile、`turn_id`和input hash；
2. 对合法Result尝试把usage累计到Root Primary Status Comment；
3. usage写入失败时记录warning并继续，不让观察指标阻塞业务；
4. 按Result和最新事实执行commit、节点状态、Root Gate或错误收敛。

## 8. Git

每个Root路径可推导：

```text
branch:   symphony/runs/<root-identifier-lower>
worktree: <conductor-data-root>/worktrees/<root-issue-id>
```

Conductor拥有branch/worktree/commit/push/PR。Performer只修改给定worktree文件。

Work Turn成功：

```text
commit current changes
-> update Work Managed Metadata completed_input_hash
-> Work In Review
```

若在三步之间退出：

- matching hash已经写入但Work仍为In Progress：只补写In Review；
- hash尚未写入：用同一Conversation和当前worktree重新执行Work Turn；
- In Review/Done Work缺少合法hash：blocked，不自动建立完成基线。

Root Gate通过后：

```text
non-Canceled In Review Work -> Done
-> delivery
```

## 9. 重启

启动不需要任何数据库migration或lock：

1. 与Podium完成Conductor Runtime handshake；
2. 打开`PerformerProfileStoreInterface`并验证Profile目录；
3. 通过Performer SDK重新读取所有Profile account/status，并确认active Profile；
4. 获取Linear Gateway session；
5. 验证repository；
6. 按Conductor Project Label解析当前Project；
7. full-scan Roots；
8. 对每个active Root重建View；
9. 检查固定Profile、多Root Phase Labels、多In Progress Work Leaves和Git冲突；
10. 正常进入调度循环。

若旧Conductor未退出，Host不得启动新实例；无DB不意味着允许双控制器。

## 10. 错误可见性

Root级业务或调度错误同时进入：

- structured log；
- Root Primary Status Comment中的当前非Turn阻塞原因；
- Root Phase Label `blocked`或`failed`；
- `RootDetailView`。

Performer warning/error和Turn completion属于观察事件：warning/error/completion append Root
Timeline Comment，连续状态按保存的Primary `comment_id`实时upsert。观察日志或Linear
projection失败不得改变closed Result、retry或Workflow mutation。

Conductor级错误，例如Conductor Project Label缺失、重复或冲突，没有对应Root，只进入
structured log和`ConductorDetailView`。错误不写Root Description，不泄露Token、绝对
路径、Provider输出或SDK exception。

Profile级登录、status或设置错误进入`PerformerProfileDetailView`。API Key、Codex auth
内容和`CODEX_HOME`绝对路径不得进入Runtime report。

Conductor Project Label移动到另一个Project时，旧Project Root暂停但不转移所有权。
Conductor把Previous/Current Resolved Conductor Project和已知Active Root摘要报告给
Podium；用户把Label移回后，原
Root按正常重启路径继续。

## 11. 接口命名

```text
LinearGatewayInterface       <- PodiumLinearGatewayClientImpl
RootSchedulingPolicyInterface <- LinearPriorityRootSchedulingPolicyImpl
LinearTreeTraversalPolicyInterface <- LinearDepthFirstTreeTraversalPolicyImpl
RootActionPolicyInterface    <- RootRunActionPolicyImpl
PerformerProfileStoreInterface <- FilePerformerProfileStoreImpl
PerformerProfileControlInterface <- SubprocessPerformerProfileControlImpl
PerformerProcessInterface     <- SubprocessPerformerProcessImpl
GitWorkspaceInterface         <- NativeGitWorkspaceImpl
RootDeliveryInterface         <- GitRootDeliveryImpl
ConductorRuntimeReporterInterface  <- PodiumConductorRuntimeReporterImpl
```

## 12. 不变量

1. Conductor没有任何数据库。
2. Linear/Git/Provider是恢复事实。
3. 每个调度周期重新计算，不复用旧Queue/Cursor。
4. 一个Binding只有一个有效Conductor。
5. 一个Conductor同时最多一个Performer Turn。
6. Conductor不接触Linear Token/SDK。
7. Performer Event不能改变Workflow。
8. 所有下一步都能从`RootRunView`纯计算得到。
9. Root变化触发重新Plan，Work Leaf变化只触发该Work重跑。
10. Conductor只保存覆盖式input hash到Linear，不保存Revision历史。
11. Conductor不持久化project_id；每轮从Conductor Project Label解析。
12. full `conductor_id`不匹配的Root不能恢复。
13. Root Done/Canceled后，任何在途Result都不能推进。
14. 缺失或损坏的Work Managed Metadata不能被静默接受。
15. Conductor只保存Profile业务字段，不读取或改写Codex-owned文件。
16. active Profile切换只影响新Root；已有Root固定原Profile。
17. Profile control与业务Turn共享一个全局Performer lane，不并发启动子进程。

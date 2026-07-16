# Symphony 目标架构总览

状态：目标架构提案。本文定义Linear-authoritative、Conductor无任何数据库的目标架构；
不代表当前代码已经实现，也不包含迁移计划。

## 1. 核心结论

Symphony是一个产品，由Podium Desktop、Podium、Conductor和Performer四个职责组成：

```text
Podium Desktop
  -> Podium TypeScript library
     -> OAuth / Token / Project catalog
     -> Conductor Identity / Conductor Binding
     -> Conductor Project Label assignment
     -> LinearGatewayProtocolHandlerImpl
        -> LinearSdkImpl

Conductor TypeScript daemon
  -> LinearGatewayInterface
     <- PodiumLinearGatewayClientImpl
        -> private protocol
  -> linear-tree / LinearTreeTraversalPolicyInterface
  -> root-workflow / RootActionPolicyInterface
  -> root-scheduling / RootSchedulingPolicyInterface
  -> performer-profiles / PerformerProfileControlInterface
  -> git-workspaces / GitWorkspaceInterface
  -> performer-turns / PerformerProcessInterface
     -> Performer Python process per Turn
        -> Provider conversation
```

最重要的架构决定：

- Linear Issue Tree是工作流权威，不在Conductor复制Work Node、Queue或Root Run数据库；
- Conductor没有任何数据库，启动后从Linear、Git和`performer_id`重建当前
  `RootRunView`；
- Root Run不是本地Aggregate，而是一个Root Issue的可重建运行生命周期；
- Linear Project上的Conductor Project Label用于解析Resolved Conductor Project；
- Root上的Root Phase Label保存`RootPhase`；
- Root Managed Comment保存opaque `performer_id`、最新已Plan的Root input hash和交付信息；
- Work Managed Metadata保存最新已完成的Work input hash；Root变化重做Plan，Work Leaf变化只重跑该Work；
- 一个Root对应一个deterministic delivery branch和一个worktree；
- Work Group只负责分组，只有最深层Work Leaf执行；
- Linear sibling order是唯一任务顺序，Conductor不建立第二套排序；
- Root Gate只审核整个Root，在Workflow Tree完成后执行；
- Podium独占Linear SDK、access/refresh token和OAuth；Conductor只依赖`LinearGatewayInterface`；
- Performer独占Provider SDK，并通过`performer_id`start/resume同一个Conversation。
- Conductor保存多个`PerformerProfile`和active Profile ID，每个Profile分配独立
  `CODEX_HOME`；
- Performer通过Codex SDK直接执行ChatGPT/API Key登录，并把model、reasoning和Fast映射
  为SDK参数；Symphony不修改Codex-owned配置文件；
- Desktop可无重启切换active Profile；新Root立即使用它，已有Root保持原Profile；
- Desktop展示best-effort Token usage和Completed Roots，Podium不持久化这些指标。

## 2. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Identity与Repository Context | `podium.db` | Podium Desktop |
| Resolved Conductor Project | Project的Conductor Project Label | Conductor |
| Linear远端Issue、Relation、Comment、Label、state、order | Linear | `LinearGatewayProtocolHandlerImpl` / `LinearSdkImpl` |
| Root Phase | Root Phase Label | Conductor |
| Root工作流结构 | Linear Issue Tree | Conductor |
| 当前执行节点 | 唯一`In Progress`叶子节点 | Conductor |
| Workflow Node kind | Managed Marker或Work Managed Metadata；无Managed Marker的用户Sub Issue默认Work Node | Conductor |
| Provider Conversation | Root Managed Comment中的`performer_id` | Performer |
| Root使用的Profile | Root Managed Comment中的`performer_profile_id` | Conductor |
| Profile定义与active Profile | Conductor `performer-profiles/profiles.json` | Conductor |
| Codex auth/session/config state | Profile独立`CODEX_HOME` | Codex SDK / Performer |
| 最新已消费需求位置 | Root Managed Comment与Work Managed Metadata中的覆盖式input hash | Conductor |
| Token usage | Root Managed Comment中的累计SDK usage | Conductor |
| 代码与已完成修改 | Git branch/worktree/commits | Conductor |
| Root Delivery | Git remote、`gh`与Root Managed Comment | Conductor |

Conductor内存中的`RootRunView`、`LinearIssueTreeSnapshot`和调度结果都可以丢弃。
下一轮重新读取Linear和Git即可重建。

## 3. 一个Root的生命周期

```text
Root delegated to Symphony
-> Root In Progress
-> pin active Performer Profile
-> Root Phase = planning
-> Performer Plan Turn
-> create ordered/nested Work Nodes + Human Nodes
-> Root Phase = awaiting-human
-> user approves Plan
-> Root Phase = working
-> ordered depth-first leaf execution
-> all non-Canceled Work Leaves In Review and Human Nodes Done
-> Root Phase = gating
-> Performer Root Gate Turn
-> Root Gate pass: non-Canceled Work Nodes Done
-> Root Phase = delivering
-> PR when possible, otherwise branch
-> Root In Review
-> Root Phase = in-review
-> user/SCM automation eventually moves Root Done
```

详细单Root状态、节点语义、树遍历和Root Gate见[Root Issue工作流](root-issue.md)。

Root title/description在任一非终态阶段变化时，当前Turn结束后使用同一Conversation
重新Plan、reconcile未完成Workflow Nodes并重新批准。Work Leaf变化不重做整棵Plan，
只在下一个Turn重跑该Work；两种变化都会使旧Root Gate结果失效。

## 4. 多Root调度

Conductor每个调度周期重新读取绑定Project中的Root Issues，不保存本地Queue：

```text
filter delegated roots
-> remove unresolved blocker roots
-> compute RootAction for every Root Issue
-> Linear Priority
-> Linear root order
-> stable identifier
-> execute selected RootAction
```

等待Human的Root不阻塞其他Root。Priority变化、blocker变化和用户调整Linear顺序在下一个Turn边界生效。详细规则见[Linear端到端流转](linear-flow.md)。

## 5. 无DB恢复

Conductor重启：

```text
read conductor identity + repository from Podium
-> resolve the unique Project carrying its Conductor Project Label
-> fetch candidate Roots through LinearGatewayInterface
-> read Root Phase Label + Root Managed Comment
-> resolve performer_profile_id to its CODEX_HOME
-> fetch complete Issue Tree with parent/order/state
-> derive branch/worktree path from Root identity
-> inspect Git
-> recompute RootAction
```

典型恢复：

| Linear/Git事实 | 恢复动作 |
|---|---|
| 0个Project带当前Conductor Project Label | unbound，不轮询Root |
| 多个Project匹配或Project有多个Conductor Project Labels | blocked，不猜测Project归属 |
| Conductor Project Label移到其他Project | 旧Project Root暂停；移回Label后继续 |
| 一个Work Leaf为In Progress | 用Root的`performer_id`继续该Work |
| 所有非Canceled Work Leaves为In Review/Done | 执行Root Gate |
| phase为delivering | 查找deterministic branch/PR并继续交付 |
| Root为In Review且input hash未变化 | idle，等待用户 |
| Root input hash变化 | 回到planning并重新Plan |
| 已完成Work input hash变化 | 重新打开该Work并在下一Turn重跑 |
| 新增Todo Sub Issue | 按当前Linear顺序进入下一轮Plan/执行 |
| 多个叶子同时In Progress | phase设为blocked，要求人工修复Linear状态 |
| In Review/Done Work缺少合法Work Managed Metadata | blocked；回到In Progress重跑或Canceled |
| Root在Turn期间Done/Canceled | 丢弃旧Result，不再推进 |
| Root固定Profile缺失或未ready | blocked，等待用户修复该Profile |

无DB模式依赖Provider能够通过opaque `performer_id`可靠resume；不能满足的Backend不受支持。

## 6. 进程与语言边界

```text
Podium Desktop / Podium / Conductor: TypeScript
Performer: Python
Tauri Host: Rust
Cross-process contracts: generated JSON Schema types
```

依赖规则：

- Podium、Conductor、Performer只能依赖契约，不导入彼此实现；
- Linear SDK只存在于Podium的`LinearSdkImpl`；
- Provider SDK只存在于Performer的`*BackendImpl`；
- Conductor通过`LinearGatewayInterface`访问Linear，通过`PerformerProcessInterface`启动Turn；
- Conductor通过`PerformerProfileControlInterface`调用Performer Profile control process；
- Performer不调用Linear，不创建branch/PR；
- Podium不解释Workflow Tree、不选择下一Work Leaf。

## 7. 命名规则

命名、后缀和public/internal组织只由
[代码模块与命名规范](code-organization.md)定义。总览只保留一条原则：模块间依赖
`*Interface`，内部实现使用`*Impl`且不从public exports导出。

## 8. 文档导航

- [Root Issue工作流](root-issue.md)：一个Root、Root Phase Label、Workflow Tree、Work Nodes/Human Nodes、Root Gate。
- [Linear端到端流转](linear-flow.md)：所有Root的发现、Priority、blocker、调度和SDK所有权。
- [Conductor](conductor.md)：无DB解释器、调度循环和恢复。
- [Performer](performer.md)：Performer ID、Provider Conversation和Turn执行。
- [Performer Profile与Codex配置](performer-profiles.md)：独立`CODEX_HOME`、SDK登录、Profile切换和usage。
- [Performer Command/Result](performer-command-contracts.md)
- [Performer Event](performer-events.md)
- [Podium](podium.md)
- [Podium Desktop](podium-desktop.md)：页面、用户状态、信息边界与本地Runtime。
- [Git Worktree与交付](git-worktree-delivery.md)
- [契约与接口](contracts.md)
- [代码组织与命名](code-organization.md)
- [目标仓库目录](repository-directory.md)
- [Roadmap](roadmap.md)
- [架构术语表](glossary.md)：业务词、代码类型名、字段名和禁止别名。

文档唯一事实源约定：

- Root状态、Tree、Human、Gate：`root-issue.md`；
- 全Root发现、Priority、blocker、Binding和Linear mutation：`linear-flow.md`；
- Turn Command/Result字段：`performer-command-contracts.md`；
- Event字段：`performer-events.md`；
- Performer Profile、Codex登录、SDK设置和usage：`performer-profiles.md`；
- 模块与命名规则：`code-organization.md`；
- branch/worktree/交付：`git-worktree-delivery.md`；
- Desktop页面、用户状态和named Desktop Views：`podium-desktop.md`；
- 业务词和代码类型名：`glossary.md`。

其他文档只做角色说明、总览或版本边界，不重复定义这些规则。

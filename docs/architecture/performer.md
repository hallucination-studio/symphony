# Performer Python Agent Runtime

状态：目标架构提案。Performer是Python Agent和Provider SDK边界；它承载Root Reconciler以及Plan、Work、
Verify执行角色，但不拥有Linear workflow、Root lifecycle或Git topology。

## 1. 职责

Performer负责：

- 通过官方Provider SDK创建、继续、interrupt和关闭role thread；
- 每个Root一个Root Reconciler thread，每个Cycle隔离Plan、Work、Verify三个Stage threads；
- open时接收一次完整Root bootstrap，后续ReAct turn只接收严格连续的delta；
- 返回closed `RootReconcilerTurnResult`；只有directive variant携带matching用户comment replies和下一步语义，
  failure variant只提供durable failure evidence；
- 执行Plan/Work/Verify turn并返回matching强类型Result；
- Work turn内部运行有界coding-agent tool loop；
- 映射model、effort、Fast、sandbox、deadline和structured output；
- 校验generated wire contracts并归一化Provider failure；
- 使用isolated Performer Profile `CODEX_HOME`。

Performer不负责：

- 调用Linear SDK/GraphQL、Podium或Conductor endpoint；
- 创建、更新、archive或restore Issue；
- materialize `RootDirective`、Human Action、comment reply或Stage Result；
- 判断Root convergence、创建successor Cycle或delivery；
- commit、push、创建worktree或修改Git topology；
- 把Provider transcript/thread当作durable workflow authority。

## 2. Session模型

```text
RootAgentRuntime
  root_reconciler_session -> one Provider thread across Root Cycles
  cycle_sessions[]
    plan_session          -> separate Provider thread
    work_session          -> separate Provider thread, multiple Work targets
    verify_session        -> separate Provider thread
```

同一Root最多一个active Reconciler session，同一Cycle每个Stage角色最多一个active Symphony session。每个
session可以有多个Conductor驱动的turn；Work session跨多个Work Issues复用。Stage角色不能兼任Root Reconciler
或共享Provider conversation。

session handle是Performer内部或opaque Symphony runtime identity，不能暴露raw Provider thread ID。Cycle terminal
关闭该Cycle三个Stage sessions；Root Reconciler-directed cancel、ownership变化或Profile失效时关闭Root Reconciler并拒绝late
output。

## 3. 调用协议

Conductor始终是caller：

```text
PerformerAgentClientInterface
  openRootReconciler(bootstrap) -> RootReconcilerOpenedResult + initial RootReconcilerTurnResult
  advanceRootReconciler(delta) -> RootReconcilerTurnResult
  executePlanTurn(request) -> PlanResult
  executeWorkTurn(request) -> WorkResult
  executeVerifyTurn(request) -> VerifyResult
  closeCycleStageSessions(command) -> CloseCycleStageSessionsResult
  closeRootReconciler(command) -> CloseRootReconcilerResult
```

底层transport可以是Conductor创建的长连接process channel或等价的request/response协议，但不能变成Performer
主动callback。Performer返回的event和response只是当前Conductor call的输出。

Root Reconciler contract由[Root Reconciliation](root-reconciliation.md)定义；Plan/Work/Verify contract由
[Performer Stage Contracts](stage-orchestration.md)定义。Performer内部不能维护另一份字段或enum定义。

## 4. Provider边界

```text
ProviderBackendInterface
  openSession(role, profile, settings)
  executeTurn(session, request, workspaceCapability?)
  interruptTurn(session)
  closeSession(session)
```

当前实现目标为`CodexBackendImpl`。Backend差异只存在于`*BackendImpl`，公共Result不包含SDK object、Token、
raw error、reasoning、transcript或credential path。

`CodexBackendImpl`只使用官方SDK public API；不得调用Codex CLI、读取/改写`config.toml`或`auth.json`、依赖
private SDK成员或静默放宽sandbox。无法表达完整policy时fail closed。

## 5. Role prompt资源

Performer使用四个与role一一对应、随应用打包的英文Markdown资源：

```text
src/performer/prompts/
├── root-reconciler.md
├── plan.md
├── work.md
└── verify.md
```

这些文件是代码仓库内的只读应用资源，不是Profile、用户或部署配置。Performer不提供prompt locale、运行时覆盖、
文件监听、热加载、管理UI或外部prompt path。修改prompt等同于修改应用代码，必须经过代码评审、测试、构建和重新
部署；已经打开的Provider session继续使用其创建时的base instructions，新进程中的fresh session才使用新资源。

Performer内部prompt loader在process composition时一次性读取全部四个打包资源，校验后形成不可变的closed
role-to-prompt mapping；创建matching Provider session时只从该内存映射取得完整Markdown并作为base instructions交给
backend。resource缺失、不可读、空白、不是打包资源或role未知时必须fail closed；不得回退到backend中的内联字符串、
另一个role的prompt、Provider默认prompt或Profile配置。process运行期间不重新读取文件。prompt正文、文件路径和loader
对象不跨Conductor-Performer contract，不进入Linear、日志、Result或Provider Profile。

Markdown只拥有稳定的role identity、职责、禁止事项和决策/执行方法。每轮bootstrap、delta、Stage context、
`instruction_bundle`和其他dynamic facts仍来自validated request；matching structured-output schema仍从
[`packages/contracts/schemas`](contracts.md)的closed contract生成并单独传给Provider。`instruction_bundle`是本轮
Stage目标与上下文的一部分，不是base prompt名称、resource selector或运行时prompt覆盖。prompt不能增加directive、
Result variant、字段、workflow状态或capability；Provider输出即使符合自然语言要求，只要不符合matching schema、
correlation或Conductor gate仍必须拒绝。

四个prompt统一使用明确的`Role and Authority`、`Trigger Conditions`、编号`Workflow`、
`Anti-Rationalization`、`Red Flags`、可验证`Exit Criteria`和`Output Contract`。这些章节把何时执行、如何逐步处理、
哪些常见理由不能放宽边界、何时必须停止以及何种证据允许返回terminal output写清楚；它们不能创建第二套contract。

`root-reconciler.md`必须同时包含[Root Reconciliation](root-reconciliation.md)定义的Mermaid决策循环和等价的英文
规则，并明确Root级`DEFINE`、terminal Cycle后的`REVIEW`和默认`SHIP`决策。`plan.md`、`work.md`和`verify.md`
必须分别实现[Performer Stage Contracts](stage-orchestration.md)定义的role边界和Mermaid分支流程。Mermaid只表达
既有closed directive或Result之间的判断顺序，不能成为第二套状态机；prompt不得复制或重新定义wire schema。

## 6. Agent行为

### 6.1 Root Reconciler

Root Reconciler在session open时消费一次完整bootstrap，此后只消费`base_root_digest`连续的delta，并返回一个closed
`RootReconcilerTurnResult`。其directive variant可包含matching用户comment replies；failure variant不包含下一步动作或
回复。它
不能访问workspace write tool、Linear、Git mutation或其他role thread transcript。其rationale必须是bounded、
可审计解释，不包含raw chain-of-thought。

同一Root Reconciler role在现有turn模型内承担三个Root级语义phase：用`DEFINE`把可证明的用户需求规范化到Root
description；在每个terminal `CycleOutcome` read-back后执行`REVIEW`并决定successor Cycle或收敛处理；满足Root且没有
明示manual-delivery instruction时用`SHIP`语义返回`conclude_root(ready_for_delivery)`。这些phase不是新role、thread、
Stage、Result、record或workflow state，实际Linear/Git materialization和delivery仍全部由Conductor完成。

### 6.2 Plan

Plan read-only，生成Plan Contract和initial Work DAG proposal。它不创建Issue或Action，不能直接调用Work。

### 6.3 Work

Work workspace-write。一个turn只接收一个selected Work target，但内部可以反复读取、编辑、运行命令、观察错误
和修复，直到完成、blocked或预算耗尽。它不能修改Cycle DAG；发现调整需要时返回structured facts。

### 6.4 Verify

Verify使用独立read-only thread，绑定immutable target revision。它不继承Work conversation，不修改代码或
Finding，不决定successor Cycle。

## 7. Runtime与恢复

Performer不保存workflow数据库。live session可以在进程内维持Provider continuity；恢复只依赖Linear/Git：

| 故障 | 处理 |
|---|---|
| turn transport失败 | interrupt matching turn；无validated Result则不产生业务结论 |
| Provider thread丢失 | close Symphony session；Conductor用fresh facts打开fresh role session |
| Performer process崩溃 | Reconciler和Stage sessions全部丢弃；Conductor从Root facts重建 |
| Work留下部分修改 | fresh Git/worktree facts进入下一份delta；session已丢失则进入fresh bootstrap。Root Reconciler决定继续、rerun、replan或supersede |
| stale/late Result | correlation/digest/precondition检查拒绝 |
| Human等待 | turn结束并释放active execution；session可保留或丢弃，恢复结果相同 |

Provider session retention是性能优化，不是完成条件。系统必须在任意thread丢失后仍能从完整durable facts继续。

## 8. 资源与安全

- 每个Root Reconciler/Plan/Work/Verify turn有独立token、tool、context、result和wall-time limits；
- Cycle和Root预算由Conductor机械gate，Performer只执行授予的turn limits；
- stdout/stderr、event frame和tool output必须bounded和sanitized；
- Plan、Verify、Root Reconciler是read-only；只有Work获得matching workspace-write capability；
- cancellation必须interrupt active Provider turn并清理child process；
- secrets和auth material不进入request/result/log/timeline。

## 9. Profile Control

Profile control仍是独立closed protocol，负责SDK login/status和受支持设置验证。Profile复用认证与设置，不复用
跨Cycleconversation。完整规则由[Performer Profile](performer-profiles.md)定义。

## 10. 不变量

1. Performer拥有全部Agent SDK和Provider thread实现。
2. 每个Root有一个Reconciler thread；每个Cycle有Plan、Work、Verify三个隔离角色thread。
3. Conductor是唯一caller；Performer不反向调用Conductor。
4. Root Reconciler只返回directive/comment reply，执行角色只返回Result。
5. Work thread可以跨Work Issues复用，但每turn只有一个target。
6. Performer不直接拥有Linear/Git workflow副作用。
7. Provider thread和transcript不是durable authority。
8. 只有open request允许完整Root snapshot；advance request只允许delta，baseline mismatch必须fresh bootstrap。
9. 四个role各自只加载一个随Performer打包的英文Markdown resource；不存在运行时覆盖、locale或inline fallback。
10. Markdown定义稳定role行为，validated request提供本轮事实，generated schema和Conductor gate始终拥有机械执行边界。
11. 四个prompt都明确trigger、分步workflow、anti-rationalization、red flags、evidence exit criteria和output contract；
    Mermaid只解释既有closed flow，不新增schema或状态。

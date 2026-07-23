# Performer Python Agent Runtime

状态：目标架构提案。Performer是Python Agent和Provider SDK边界；它承载Cycle Supervisor以及Plan、Work、
Verify执行角色，但不拥有Linear workflow、Root lifecycle或Git topology。

## 1. 职责

Performer负责：

- 通过官方Provider SDK创建、继续、interrupt和关闭role thread；
- 每个Cycle隔离Supervisor、Plan、Work、Verify四个thread；
- 执行Cycle Supervisor ReAct turn并返回closed `CycleDirective`；
- 执行Plan/Work/Verify turn并返回matching强类型Result；
- Work turn内部运行有界coding-agent tool loop；
- 映射model、effort、Fast、sandbox、deadline和structured output；
- 校验generated wire contracts并归一化Provider failure；
- 使用isolated Performer Profile `CODEX_HOME`。

Performer不负责：

- 调用Linear SDK/GraphQL、Podium或Conductor endpoint；
- 创建、更新、archive或restore Issue；
- materialize `CycleDirective`、Human Action或Stage Result；
- 判断Root convergence、创建successor Cycle或delivery；
- commit、push、创建worktree或修改Git topology；
- 把Provider transcript/thread当作durable workflow authority。

## 2. 四角色session模型

```text
CycleAgentRuntime
  supervisor_session -> one Provider thread
  plan_session       -> separate Provider thread
  work_session       -> separate Provider thread, multiple Work targets
  verify_session     -> separate Provider thread
```

同一Cycle每个角色最多一个active Symphony session。每个session可以有多个Conductor驱动的turn；Work session
跨多个Work Issues复用。任何角色都不能兼任Supervisor或共享Provider conversation。

session handle是Performer内部或opaque Symphony runtime identity，不能暴露raw Provider thread ID。Cycle terminal、
Root cancel、ownership变化或Profile失效时关闭四个session并拒绝late output。

## 3. 调用协议

Conductor始终是caller：

```text
PerformerAgentClientInterface
  openCycleSupervisor(request) -> SupervisorOpenedResult
  advanceCycleSupervisor(observation) -> CycleDirective
  executePlanTurn(request) -> PlanResult
  executeWorkTurn(request) -> WorkResult
  executeVerifyTurn(request) -> VerifyResult
  closeCycleSessions(command) -> CloseResult
```

底层transport可以是Conductor创建的长连接process channel或等价的request/response协议，但不能变成Performer
主动callback。Performer返回的event和response只是当前Conductor call的输出。

Supervisor contract由[Cycle Supervisor](cycle-supervisor.md)定义；Plan/Work/Verify contract由
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

## 5. Agent行为

### 5.1 Supervisor

Supervisor只消费完整Cycle observation并返回一个closed directive。它不能访问workspace write tool、Linear、
Git mutation或其他role thread transcript。其rationale必须是bounded、可审计解释，不包含raw chain-of-thought。

### 5.2 Plan

Plan read-only，生成Plan Contract和initial Work DAG proposal。它不创建Issue或Action，不能直接调用Work。

### 5.3 Work

Work workspace-write。一个turn只接收一个selected Work target，但内部可以反复读取、编辑、运行命令、观察错误
和修复，直到完成、blocked或预算耗尽。它不能修改Cycle DAG；发现调整需要时返回structured facts。

### 5.4 Verify

Verify使用独立read-only thread，绑定immutable target revision。它不继承Work conversation，不修改代码或
Finding，不决定successor Cycle。

## 6. Runtime与恢复

Performer不保存workflow数据库。live session可以在进程内维持Provider continuity；恢复只依赖Linear/Git：

| 故障 | 处理 |
|---|---|
| turn transport失败 | interrupt matching turn；无validated Result则不产生业务结论 |
| Provider thread丢失 | close Symphony session；Conductor用fresh facts打开fresh role session |
| Performer process崩溃 | 四个session全部丢弃；Root Loop重建 |
| Work留下部分修改 | fresh Git/worktree facts进入恢复request，由Conductor决定是否继续 |
| stale/late Result | correlation/digest/precondition检查拒绝 |
| Human等待 | turn结束并释放active execution；session可保留或丢弃，恢复结果相同 |

Provider session retention是性能优化，不是完成条件。系统必须在任意thread丢失后仍能从完整durable facts继续。

## 7. 资源与安全

- 每个Supervisor/Plan/Work/Verify turn有独立token、tool、context、result和wall-time limits；
- Cycle和Root预算由Conductor机械gate，Performer只执行授予的turn limits；
- stdout/stderr、event frame和tool output必须bounded和sanitized；
- Plan、Verify、Supervisor是read-only；只有Work获得matching workspace-write capability；
- cancellation必须interrupt active Provider turn并清理child process；
- secrets和auth material不进入request/result/log/timeline。

## 8. Profile Control

Profile control仍是独立closed protocol，负责SDK login/status和受支持设置验证。Profile复用认证与设置，不复用
跨Cycleconversation。完整规则由[Performer Profile](performer-profiles.md)定义。

## 9. 不变量

1. Performer拥有全部Agent SDK和Provider thread实现。
2. 每个Cycle有Supervisor、Plan、Work、Verify四个隔离角色thread。
3. Conductor是唯一caller；Performer不反向调用Conductor。
4. Supervisor只返回directive，执行角色只返回Result。
5. Work thread可以跨Work Issues复用，但每turn只有一个target。
6. Performer不直接拥有Linear/Git workflow副作用。
7. Provider thread和transcript不是durable authority。

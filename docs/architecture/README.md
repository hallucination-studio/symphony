# Symphony目标架构总览

状态：目标架构提案。本文定义Linear-authoritative、Conductor无Workflow数据库的目标架构；不代表当前实现
已经匹配，也不包含迁移计划。

## 1. 核心模型

Symphony是一个产品，由Podium Desktop、Podium、Conductor和Performer四个职责组成：

```text
Podium Desktop
  -> Podium TypeScript library
     -> Linear OAuth / Token / Project catalog / Linear SDK

Conductor TypeScript daemon
  -> Root Reconciliation host and deterministic materializer
  -> read and materialize Linear/Git durable facts
  -> call Performer; never host Agent SDK
  -> publish typed timeline events and materialize user-comment replies

Performer Python runtime
  -> one Root Reconciler ReAct thread per Root
  -> isolated Plan, Work and Verify role threads per Cycle
  -> ProviderBackendInterface -> CodexBackendImpl
```

每个Root只有一个语义决策角色：

```text
Root Reconciler
  model-driven ReAct in Performer
  observes the complete active + archived Root Tree
  handles human comments and replies
  spans all Cycles
  proposes the next closed directive
```

Root Reconciler thread不能兼任Stage role。每个Cycle有三个隔离Provider thread：Plan、Work、Verify。Work
thread跨该Cycle多个Work Issues和turn复用；三个Stage roles不能共享thread或跨Cycle复用。

## 2. 目标架构不变量

- Linear Issue Tree、custom status、原生archive flag和managed records是Workflow authority，Git是code/delivery
  authority；
- Conductor不保存Workflow DB、Root Queue、DAG mirror、durable event queue、gate table或checkpoint；
- Conductor host不运行模型，只执行ownership、status、budget、convergence、materialization和delivery；
- Root/Cycle下一步语义只来自matching Root Reconciler的closed `RootDirective`；
- Root Reconciler读取完整active和archived Root Tree，但不直接调用Linear、Git或Conductor；
- Plan、Work、Verify通过强类型request/result contract报告事实，不决定下一步或创建Human Action；
- Conductor始终是Performer caller；Performer只响应closed command，不反向调用Conductor；
- Cycle Human Action是Cycle直接子Issue并link目标；Root Action是Root直接子Issue；
- Root Reconciler可以提出create/update/archive/restore/reorder/dependency patch、replan和successor Cycle；
  Conductor验证并materialize；
- 原生archive flag决定active DAG membership，archived Issues仍完整进入Tree、审计和恢复；
- Finding、attempt、budget、Stage Result、Root directive、Human resolution、用户comment处理和progress持久化
  到Linear；
- Provider thread只提供runtime continuity，丢失后从Linear/Git facts打开fresh thread；
- Podium独占Linear OAuth、Token和SDK，Performer独占Provider SDK；
- cross-process communication使用closed versioned schemas和generated types；
- Root/Cycle timeline通过typed event和subscriber投影到Linear comments，不由业务模块直接渲染。
- 普通human comment按actor和managed marker过滤；每个处理后的comment version收到read-back后的Reconciler
  reply，系统、timeline、status和reply comments不会回流为用户输入。

## 3. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Binding和Repository Context | `podium.db` | Podium Desktop |
| Root routing和Project Conductor Pool | Linear labels | Podium / Conductor |
| Root ownership、Profile和convergence policy | Root managed records | Conductor |
| Root/Cycle/Node status与archive membership | Linear | Conductor reconciles |
| Cycle DAG、relations、Plan Contract和Human Action | Linear Issue Tree | Root Reconciler proposes; Conductor writes |
| Root directives和Plan/Work/Verify Results | Linear managed records | Conductor validates |
| Human status/comments/resolutions | Linear | Human / Conductor / Root Reconciler |
| 用户comment disposition与reply | Linear managed comments | Root Reconciler proposes; directive materializer writes |
| branch、commits、diff、checks和delivery | Git | Conductor / Performer Work |
| Provider auth/session runtime | Profile `CODEX_HOME` and live Performer | Codex SDK / Performer |
| Root/Cycle user timeline | Linear comments | Timeline subscribers |
| Conductor online/offline | 当前private channel | Podium Desktop只观察，不持久化 |
| heartbeat和tool progress | process memory/log | 不进入Desktop Workflow View，不参与Workflow |

Conductor内存View、runtime event、process handle、opaque session handle和Provider thread都可丢弃。accepted业务
事实只有在Linear/Git read-back后才成立。

Podium Desktop不显示或修改Root、Cycle、Node、Human Action、Result、Finding、delivery或Workflow next action。
所有Workflow查看和人工交互只在Linear完成；Desktop只显示Linear connected/disconnected和Conductor
online/offline，并提供Conductor/Profile配置与脱敏运行日志。

## 4. 调用与恢复

```text
Conductor -> advanceRootReconciler(complete Root observation) -> Performer
Conductor <- RootDirective                                   <- Performer

Conductor -> executePlan|Work|Verify(strong request)     -> Performer
Conductor <- Plan|Work|VerifyResult                      <- Performer
```

Result先持久化，再进入Root Reconciler下一轮observation。Performer/session丢失不回滚durable facts；Conductor从完整
Tree打开fresh matching role thread。旧session output因digest或remote version不匹配而失效。

## 5. 时间轴

```text
read-back durable fact
-> publish typed WorkflowTimelineEvent
-> Root or Cycle projection subscriber
-> append idempotent, structured Linear comment
```

Root Timeline只写Root Issue；Cycle Timeline只写matching Cycle Issue。Reconciler comment reply作为matching
`RootDirective`的必需Linear mutation写回原Issue。event机制不是
durable queue或workflow authority；任一required comment write/read-back失败时Root停在当前materialization，
打印correlated error，并在恢复后使用同一deterministic ID继续，成功前不推进。

## 6. 进程与边界

```text
Podium Desktop / Podium / Conductor: TypeScript
Performer: Python
Desktop host: Tauri / Rust
Cross-process contracts: JSON Schema -> generated TypeScript/Python/Rust types
```

- roles只依赖contracts/interfaces，不导入另一role实现；
- Conductor通过`LinearGatewayInterface`访问Linear；
- Conductor通过session-capable Performer client调用Root Reconciler和三个Stage role thread；
- Performer backend独占model、thread、turn、sandbox和structured output映射；
- SDK objects、credentials、raw transcript、process handles和arbitrary metadata不跨public boundary。

## 7. 文档导航

- [Root Reconciliation](root-reconciliation.md)：唯一语义Reconciler、完整Root Tree、用户comment回复、
  `RootDirective`、Root/Cycle revision和确定性materialization。
- [Performer Plan、Work与Verify Contracts](stage-orchestration.md)：三个role thread的强类型request/result。
- [Root与Cycle Workflow Timeline](workflow-timeline.md)：事件发布、订阅和Linear comment投影。
- [Human Action交互与恢复](human-actions.md)：Issue层级、labels、专用状态和resolution。
- [Root Issue工作流](root-issue.md)：Linear status、Cycle Tree、Finding和delivery事实。
- [Linear端到端流转](linear-flow.md)：Project解析、Root发现、blocker、排序和SDK ownership。
- [Conductor](conductor.md)：Conductor模块和副作用边界。
- [Performer](performer.md)：Python Agent runtime和Provider边界。
- [Performer Profile与Codex配置](performer-profiles.md)
- [Git Worktree与交付](git-worktree-delivery.md)
- [契约与接口](contracts.md)
- [代码模块与命名规范](code-organization.md)
- [目标仓库目录](repository-directory.md)
- [Roadmap](roadmap.md)
- [架构术语表](glossary.md)
- [Podium](podium.md)
- [Podium Desktop](podium-desktop.md)
- [Runtime Hardening](runtime-hardening.md)

上述named concern文档各自是唯一事实源。其他文档只能引用，不能复制第二份字段表、transition或thread规则。

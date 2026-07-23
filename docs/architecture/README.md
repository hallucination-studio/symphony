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
  -> deterministic Root Reconciliation Loop
  -> read and materialize Linear/Git durable facts
  -> call Performer; never host Agent SDK
  -> publish typed Root/Cycle timeline events

Performer Python runtime
  -> Cycle Supervisor ReAct thread
  -> isolated Plan, Work and Verify role threads
  -> ProviderBackendInterface -> CodexBackendImpl
```

每个Root由两个不同层次推进：

```text
Root Reconciliation Loop
  deterministic, no model
  spans Cycles and restarts

Cycle Supervisor
  model-driven ReAct
  observes the complete active + archived Cycle Tree
  proposes the next closed directive
```

每个Cycle有四个隔离Provider thread：Supervisor、Plan、Work、Verify。Work thread跨该Cycle多个Work Issues和
turn复用；四个角色不能共享thread，也不能跨Cycle复用。

## 2. 目标架构不变量

- Linear Issue Tree、custom status、原生archive flag和managed records是Workflow authority，Git是code/delivery
  authority；
- Conductor不保存Workflow DB、Root Queue、DAG mirror、durable event queue、gate table或checkpoint；
- Root Loop不调用模型，只执行ownership、status、budget、convergence、materialization和delivery；
- Cycle下一步语义只来自matching Cycle Supervisor的closed `CycleDirective`；
- Cycle Supervisor读取完整active和archived Tree，但不直接调用Linear、Git或Conductor；
- Plan、Work、Verify通过强类型request/result contract报告事实，不决定下一步或创建Human Action；
- Conductor始终是Performer caller；Performer只响应closed command，不反向调用Conductor；
- Cycle Human Action是Cycle直接子Issue并link目标；Root Action是Root直接子Issue；
- Supervisor可以提出create/update/archive/restore/reorder/dependency patch；Conductor验证并materialize；
- 原生archive flag决定active DAG membership，archived Issues仍完整进入Tree、审计和恢复；
- Finding、attempt、budget、Stage Result、Supervisor directive、Human resolution和progress持久化到Linear；
- Provider thread只提供runtime continuity，丢失后从Linear/Git facts打开fresh thread；
- Podium独占Linear OAuth、Token和SDK，Performer独占Provider SDK；
- cross-process communication使用closed versioned schemas和generated types；
- Root/Cycle timeline通过typed event和subscriber投影到Linear comments，不由业务模块直接渲染。

## 3. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Binding和Repository Context | `podium.db` | Podium Desktop |
| Root routing和Project Conductor Pool | Linear labels | Podium / Conductor |
| Root ownership、Profile、convergence policy、delivery | Root managed records | Conductor |
| Root/Cycle/Node status与archive membership | Linear | Conductor reconciles |
| Cycle DAG、relations、Plan Contract和Human Action | Linear Issue Tree | Supervisor proposes; Conductor writes |
| Supervisor directives和Plan/Work/Verify Results | Linear managed records | Conductor validates |
| Human status/comments/resolutions | Linear | Human / Conductor / Supervisor |
| branch、commits、diff、checks | Git | Conductor / Performer Work |
| Provider auth/session runtime | Profile `CODEX_HOME` and live Performer | Codex SDK / Performer |
| Root/Cycle user timeline | Linear comments | Timeline subscribers |
| heartbeat和tool progress | best-effort Event/Desktop | 不参与Workflow |

Conductor内存View、runtime event、process handle、opaque session handle和Provider thread都可丢弃。accepted业务
事实只有在Linear/Git read-back后才成立。

## 4. 调用与恢复

```text
Conductor -> advanceSupervisor(complete Cycle observation) -> Performer
Conductor <- CycleDirective                              <- Performer

Conductor -> executePlan|Work|Verify(strong request)     -> Performer
Conductor <- Plan|Work|VerifyResult                      <- Performer
```

Result先持久化，再进入Supervisor下一轮observation。Performer/session丢失不回滚durable facts；Conductor从完整
Tree打开fresh matching role thread。旧session output因digest或remote version不匹配而失效。

## 5. 时间轴

```text
read-back durable fact
-> publish typed WorkflowTimelineEvent
-> Root or Cycle projection subscriber
-> append idempotent, structured Linear comment
```

Root Reconciliation Timeline只写Root Issue；Cycle Supervisor Timeline只写matching Cycle Issue。event机制不是
durable queue或workflow authority，漏投影由下一次reconciliation使用deterministic event ID补齐。

## 6. 进程与边界

```text
Podium Desktop / Podium / Conductor: TypeScript
Performer: Python
Desktop host: Tauri / Rust
Cross-process contracts: JSON Schema -> generated TypeScript/Python/Rust types
```

- roles只依赖contracts/interfaces，不导入另一role实现；
- Conductor通过`LinearGatewayInterface`访问Linear；
- Conductor通过session-capable Performer client调用Supervisor和三个role thread；
- Performer backend独占model、thread、turn、sandbox和structured output映射；
- SDK objects、credentials、raw transcript、process handles和arbitrary metadata不跨public boundary。

## 7. 文档导航

- [Root Reconciliation Loop](root-reconciliation.md)：确定性Root/Cycle lifecycle、恢复、convergence和调用方向。
- [Cycle Supervisor](cycle-supervisor.md)：Supervisor ReAct、完整Tree、DAG patch和`CycleDirective`。
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

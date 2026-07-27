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
  -> publish typed timeline events and materialize native user-comment thread replies/reactions

Performer Python runtime
  -> one Root Reconciler ReAct thread per Root
  -> isolated Plan, Work and Verify role threads per Cycle
  -> ProviderBackendInterface -> CodexBackendImpl
```

每个Root只有一个语义决策角色：

```text
Root Reconciler
  model-driven ReAct in Performer
  receives one complete bootstrap, then strict Root deltas
  handles every user Linear change and comment reply
  spans all Cycles
  returns one closed turn result: a next-step directive or a failure variant
  whose durable failure evidence must be written before the Root stops
```

Root Reconciler thread不能兼任Stage role。每个Cycle有三个隔离Provider thread：Plan、Work、Verify。Work
thread跨该Cycle多个Work Issues和turn复用；三个Stage roles不能共享thread或跨Cycle复用。

## 2. 目标架构不变量

- Linear Issue Tree、custom status、原生archive flag和managed records是Workflow authority，Git是code/delivery
  authority；
- Conductor不保存Workflow DB、Root Queue、DAG mirror、durable event queue、gate table或checkpoint；
- 用户在Linear原生将Root delegate给当前Binding验证过的Symphony actor，是唯一的Root初始准入事实；未delegate的
  Root不是Conductor可claim的候选，不能触发任何状态/ownership/timeline写入、Git workspace或Performer调用；
- Conductor host不运行模型，只执行ownership、coverage、schema、capability、budget、convergence、materialization和delivery；
- Root/Cycle下一步语义只来自matching Root Reconciler的closed `RootDirective`；每个已进入Provider的
  Reconciler turn以`RootReconcilerTurnResult`结束：其failure variant只携带必须strict-write/read-back的
  `RootReconcilerFailureRecord`，不拥有下一步语义；
- fresh Root Reconciler session接收一次完整active和archived Root bootstrap；后续turn只接收严格连续的Root delta；
- Conductor可以在内存中完整读取Linear以计算source diff和校验digest，但已有session的advance request绝不携带完整Tree；session新建、丢失或baseline无法证明时才重新发送一次`RootBootstrapSnapshot`；
- 所有用户status、content、archive、parent、relation和comment修改都由Root Reconciler解释，Conductor不主动纠正；
- Plan、Work、Verify通过强类型request/result contract报告事实，不决定下一步或创建Human Action；
- Conductor始终是Performer caller；Performer只响应closed command，不反向调用Conductor；
- Human Action只存在于Root special managed comment threads；其scope可以是Root或Cycle；
- Root Reconciler可以提出create/update/archive/restore/reorder/dependency patch、replan和successor Cycle；
  Conductor验证并materialize；
- 原生archive flag决定active DAG membership，archived Issues仍完整进入Tree、审计和恢复；
- Finding、attempt、budget、Stage Result、Root directive、Human resolution、用户comment处理、model/usage和progress
  以strict `json` fenced code block持久化到Linear comments；不存在HTML managed marker；
- Provider thread只提供runtime continuity，丢失后从Linear/Git facts打开fresh thread；
- Podium独占Linear OAuth、Token和SDK，Performer独占Provider SDK；
- cross-process communication使用closed versioned schemas和generated types；
- Root/Cycle timeline通过typed event和subscriber写入Linear comments，不由业务模块直接渲染；一个event恰好写一条
  同时包含结构化用户说明层和一个machine-readable `json` block记录层的comment。两层是同一event的
  同一次Linear materialization，不得fan-out为两条comment或两种可恢复事实。
- 每个Stage Result只在matching Plan、Work或Verify Issue的canonical managed comment中持久化一次，并嵌套唯一的
  `ModelTurnRecord`；Cycle timeline只引用并展示该事实，不能成为第二个Result、usage或Root input来源。
- Root、Cycle和Node的lifecycle只由Linear custom status与native archive flag表达；Human Action active/resolved只由其
  Root request/resolution records派生。directive、Result、timeline、reaction和`RootDelta`不得形成并行状态机。
- 除Linear原生的Issue current facts（status、archive、parent和relation）及comment current facts（body、thread
  state和reaction set）外，任何需要跨重启恢复的Symphony workflow record只能位于strict `json` code block；
  Symphony不得把前述原生事实镜像成第二份managed record、Markdown约定、HTML marker、local checkpoint或状态表。
- 普通human comment按actor与strict managed code block过滤；每个处理后的comment body version或non-Symphony native
  thread-state revision收到native thread reply、closed reaction disposition和resolve/keep-open action。Symphony-authored
  timeline/reply body不会回流；human在这些thread中的新comment，或当前线程状态的close/reopen revision，仍是Root输入。
- 每个Root Reconciler/Plan/Work/Verify调用都记录实际model和required Turn Usage；Stage、Cycle和Root累计只从Linear
  immutable turn records派生，Root累计等于全部Cycle Stage usage加全部Root Reconciler usage。

## 3. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Binding和Repository Context | `podium.db` | Podium Desktop |
| Root routing和Project Conductor Pool | Linear labels | Podium / Conductor |
| Root initial delegation | Linear native `delegate_id` | Human / Podium read-only projection |
| Root ownership、Profile和convergence policy | Root managed records | Conductor |
| Root/Cycle/Node status与archive membership | Linear | Root Reconciler interprets; Conductor materializes directives |
| Cycle DAG、relations和Plan Contract | Linear Issue Tree | Root Reconciler proposes; Conductor writes |
| Human Action requests、replies和resolutions | Root managed comment threads | Root Reconciler proposes; Conductor writes |
| Root directives、Plan/Work/Verify Results、model和turn usage | Linear managed comment code blocks | Conductor validates |
| Human Action replies/resolutions | Linear Root comment threads | Human / Root Reconciler / Conductor |
| 用户comment input与reply | Linear managed comments | Root Reconciler interprets; directive materializer writes |
| branch、commits、diff、checks和delivery | Git | Conductor / Performer Work |
| Provider auth/session runtime | Profile `CODEX_HOME` and live Performer | Codex SDK / Performer |
| Root/Cycle user timeline | Linear Markdown + `json` block comments | Timeline subscribers |
| Conductor online/offline | 当前private channel | Podium Desktop只观察，不持久化 |
| heartbeat和tool progress | process memory/log | 不进入Desktop Workflow View，不参与Workflow |

Conductor内存View、runtime event、process handle、opaque session handle和Provider thread都可丢弃。accepted业务
事实只有在Linear/Git read-back后才成立。

Podium Desktop不显示或修改Root、Cycle、Node、Human Action、Result、Finding、delivery或Workflow next action。
所有Workflow查看和人工交互只在Linear完成；Desktop只显示Linear connected/disconnected和Conductor
online/offline，并提供Conductor/Profile配置与脱敏运行日志。

## 4. 调用与恢复

```text
Conductor -> openRootReconciler(complete bootstrap once)     -> Performer
Conductor <- RootReconcilerOpenedResult + initial RootReconcilerTurnResult <- Performer
Conductor -> advanceRootReconciler(strict RootDelta)     -> Performer
Conductor <- RootReconcilerTurnResult                    <- Performer

Conductor -> executePlan|Work|Verify(strong request)     -> Performer
Conductor <- Plan|Work|VerifyResult                      <- Performer
```

Result先持久化，再进入Root Reconciler下一份delta。Performer/session丢失不回滚durable facts；Conductor从完整Tree
bootstrap fresh matching role thread。旧session output因digest或remote version不匹配而失效。

## 5. 时间轴

```text
read-back durable fact
-> publish typed WorkflowTimelineEvent
-> Root or Cycle comment subscriber
-> append one idempotent Linear comment with user Markdown + one json block
```

Root Timeline只写Root Issue；Cycle Timeline只写matching Cycle Issue。Reconciler comment reply、reaction和native
thread resolve/reopen作为matching `RootDirective`的必需Linear mutation写回原thread。event机制不是
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
- restart-required Linear managed facts只有strict `json` code block这一种格式；旧HTML marker和` s y m p h o n y `
  info string均不读取、不迁移、不兼容。

## 7. 文档导航

- [Root Reconciliation](root-reconciliation.md)：唯一语义Reconciler、bootstrap/delta、全部用户Linear输入与回复、
  closed `RootReconcilerTurnResult`、Root/Cycle用户修改和确定性materialization。
- [Performer Plan、Work与Verify Contracts](stage-orchestration.md)：三个role thread的强类型request/result。
- [Root与Cycle Workflow Timeline](workflow-timeline.md)：事件发布、订阅和Linear comment materialization。
- [Human Action交互与恢复](human-actions.md)：Root comment threads、并发requests、structured questions、actor与resolution。
- [Root Issue工作流](root-issue.md)：Linear status、Cycle Tree、Finding和delivery事实。
- [Linear端到端流转](linear-flow.md)：Project解析、Root发现、blocker、排序和SDK ownership。
- [并行黑盒端到端验收](black-box-e2e.md)：前台Campaign、真实用户模拟、并行Case断言和最终Linear/Git证据。
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

### 7.1 Named concern ownership

下表只划分文档边界；每个命名文档内的具体规则才是其事实来源。其他架构文档、任务计划、代码注释和测试都只能
引用，不能重述出另一份有独立语义的字段表、状态迁移、comment thread规则、恢复算法或Result链。

| Sole owner | Fact or behavior |
|---|---|
| [Root Issue工作流](root-issue.md) | Linear Root/Cycle/Plan/Work/Verify status catalog and native archive membership |
| [Human Action](human-actions.md) | Human Action comment/thread model, active-request derivation, DEFINE questions, actor, resolution and recovery |
| [Root Reconciliation](root-reconciliation.md) | ordinary user input filtering, native comment reply/receipt/thread behavior, bootstrap/delta and closed directives |
| [Performer Stage Contracts](stage-orchestration.md) | canonical Plan/Work/Verify Result and nested `ModelTurnRecord` materialization |
| [Performer Profile](performer-profiles.md) | actual model/Turn Usage semantics and Stage/Cycle/Root aggregation scope |
| [Workflow Timeline](workflow-timeline.md) | typed event publication and one-event/one-comment rendering |
| [契约与接口](contracts.md) | cross-process schema and strict managed-record wire format |
| [并行黑盒端到端验收](black-box-e2e.md) | foreground parallel E2E, immutable user inputs, Case assertions, final evidence and verdict |

一个事实在两处出现时，非owner必须链接到owner，而不是重新定义。例如其他文档可以说明某个边界消费Human Action
事实，但comment/thread、并发、提问、actor、resolution和恢复规则只能链接到`human-actions.md`。

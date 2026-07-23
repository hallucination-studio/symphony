# Podium Desktop 产品与Runtime设计

状态：目标架构提案。Podium Desktop是Symphony的上层产品；Podium是其内部
TypeScript类库。本文同时定义Desktop的用户信息架构和本地Runtime边界，不包含UI代码
实施计划。

## 1. 产品目标

Desktop必须让用户在任意时刻快速回答六个问题：

1. Symphony现在是否可以工作；
2. 当前正在处理的Root进行到哪一步；
3. 是否有事情需要用户去Linear处理；
4. 当前使用哪个Performer Profile、是否已经登录；
5. 当前Stage使用了多少Token；
6. 发生问题时，用户下一步应该做什么。

设计原则：

- `NextActionView`优先于统计数据；
- Linear是Workflow操作面，Desktop是解释、观察和Runtime管理面；
- 同一个事实只显示一个主要状态，不同时堆叠Root state、Root Activity投影和Stage state；
- 错误必须说明影响和下一动作，不能只显示`failed`；
- 默认页面不显示credential/token字符串、内部hash、绝对路径、Provider原始输出或
  实现类型；
- 页面保持安静、单列、可扫描，不做密集运维Dashboard。

视觉上沿用Podium现有的克制设计系统：近白背景、单一indigo交互色、语义状态色、
细边框和系统字体。颜色不能成为状态的唯一表达。

MVP中的Symphony只在Podium Desktop运行时工作，不是系统后台服务。Setup和Settings
必须明确说明：关闭Desktop会暂停本地Conductor；下次打开后从Linear和Git恢复，并按需创建fresh role
session/turn。

当前slice不设计多Root列表、聚合Workflow图、跨Root统计或并行进度。Linear是全部Roots的浏览和操作面；
Desktop只解释当前Root摘要、当前Stage observation和一个最高优先级`NextActionView`。

## 2. 顶层信息架构

Desktop只有三个常驻顶层入口：

```text
Overview
Conductors
Settings
```

| 页面 | 用户目标 | 主要信息 | 主要动作 |
|---|---|---|---|
| Overview | 知道系统是否正常、当前Root和是否需要自己处理 | `NextActionView`、连接/Runtime状态、当前Root、当前Stage、问题 | Open in Linear或进入最高优先级事项 |
| Conductors | 管理本地Runtime与Performer Profiles | Project、Repository Context、Profile、process状态、heartbeat、当前Root | Create、Start、Stop、Restart、Configure Profile |
| Settings | 查看连接和应用级信息 | Linear workspace、connection health、Desktop/runtime版本 | Reconnect Linear |

首次连接和Create Conductor是条件式Setup Flow，不是第五个常驻页面。

不增加独立的Projects、Logs、Errors、Human Actions、Verify Gates或Root Deliveries页面：

- Project选择属于Create Conductor；
- Runtime日志属于Conductor Detail；
- Root问题和Human Action以当前Root摘要进入Overview；完整Tree仍在Linear；
- Cycle DAG、Verify和Delivery不增加独立Desktop页面；
- Performer Profile属于Conductor Detail，不增加独立Agent或Profiles顶层页面。

多Root聚合显示未来若被授权，应新增明确的View contract；当前不预留空列表或隐藏页面。

## 3. 首次使用与Setup Flow

Desktop启动后根据现有事实进入第一个未完成步骤：

```text
Linear disconnected
-> Connect Linear
-> Linear connected, no Conductor
-> Create Conductor
-> Conductor starting
-> Conductor ready, no ready Performer Profile
-> Configure Codex
-> Ready
```

完成过的步骤不会因为后续步骤失败而被清空。例如Conductor启动失败时保留Linear连接
和Conductor Binding，用户不需要重新OAuth或重新选择repository。

### 3.1 Connect Linear

页面显示：

- 简短说明：Symphony通过Linear接收任务和展示人工操作；
- 当前连接状态；
- 将要打开的Linear授权动作；
- 需要的能力摘要，不显示Token或底层OAuth参数；
- 一个主按钮：`Connect Linear`或`Reconnect Linear`。

成功后显示workspace/organization名称和`Connected`，直接进入Create Conductor。

失败时显示：

- 用户可理解的原因；
- 已完成的授权是否仍然有效；
- `Try again`；
- 若需要用户在Linear处理，提供`Open Linear`。

### 3.2 Create Conductor

这是一个连续表单，不拆成多个独立页面：

1. 选择一个当前未绑定的accessible Linear Project；
2. 通过Tauri native picker选择本地Git repository；
3. 选择base branch；
4. 检查摘要并创建。

表单只显示用户可验证的信息：

| 字段 | 显示内容 |
|---|---|
| Linear Project | Project名称、所属workspace/team |
| Repository | repository display name、remote host/repository；不返回原始绝对路径 |
| Base branch | 可选branch名称 |
| Validation | Git可用、repository匹配、base branch存在 |

创建期间主按钮进入明确的`Creating…`状态并防止重复提交。创建成功后立即显示
Conductor从`Starting`到`Ready`的过程，然后进入第一个Performer Profile配置，不要求
用户运行shell命令。

### 3.3 Configure Codex

首个Profile使用一个连续表单：

1. 输入Profile display name；
2. 选择`Sign in with ChatGPT`或`Use API Key`；
3. 填写model；
4. 选择reasoning effort；
5. 在当前登录方式支持时选择Fast on/off；
6. 选择sandbox mode，默认`workspace_write`；
7. 按需编辑command allowlist/denylist，默认均为空；
8. 保存Profile；
9. 完成ChatGPT Login或输入API Key；
10. Profile变为Ready后设为active。

ChatGPT登录由Performer通过Codex SDK启动官方verification flow。API Key只在当前表单
显示一次，提交后Desktop只能显示`Configured`。API Key Profile的Fast在V1显示为
`Unavailable`；Desktop不能把其他API service tier解释成Codex Fast。

提交Login Command只显示`Signing in…`。Desktop必须等待Succeeded Event或后续Status
Query确认认证，不能把“Command已接收”显示成“登录成功”。

## 4. Overview页面

Overview是默认首页，按以下顺序展示。

### 4.1 Next action

页面顶部最多显示一个最高优先级的用户动作：

```text
Reconnect Linear
Resolve Conductor Project conflict
Start stopped Conductor
Configure Codex Profile
Sign in to active Codex Profile
Choose active Performer Profile
Approve Plan in Linear
Provide requested info in Linear
Repair blocked Root
Review delivered Root
```

每个`NextActionView`包含：

- 发生在哪个Project、Conductor或Root；
- 为什么需要用户处理；
- 不处理会暂停什么；
- 一个主按钮，例如`Open in Linear`或`View Conductor`。

如果没有用户动作，显示简短的`Symphony is working`或`No action needed`，不制造空告警。

### 4.2 System readiness

以紧凑列表显示：

- Linear：Connected / Reconnect required；
- Conductors：Ready数量、Starting数量、Needs attention数量；
- Execution：Ready、Unknown或Needs attention，仅使用最近一次脱敏Runtime观察；
- Performer Profile：active Profile、login/readiness和当前model；
- 数据新鲜度：最近一次Desktop/Conductor heartbeat时间。

Execution readiness不是第二套Workflow状态。它只显示SDK返回的sanitized account
label和Profile设置，不暴露credential、配置文件、`CODEX_HOME`或Provider thread ID。
未知状态必须显示`Not checked yet`，不能伪装成Ready。

### 4.3 Usage

以两个低密度指标显示：

- Current Stage tokens。

Total tokens可以展开Input、Cached input、Output和Reasoning output。指标必须显示
`observedAt`；stale时保留最后值并明确标记。Usage不是账单，不显示货币成本或Fast
credit multiplier。

Token usage只在完整Stage Result后累计；当前Stage不显示推测的实时token数。usage缺失或应用重启时
直接回到Conductor从Linear读取的累计值，不显示虚构的连续实时曲线。

### 4.4 Current work

最多显示当前正在执行或等待Human的一个Root：

- Root identifier和title；
- Project；
- 用户可见Root状态；
- 当前Cycle authoritative status、Root Reconciler decision、Plan/Work/Verify Node或Human Action；
- 当前Root固定的Performer Profile；
- 最近活动时间；
- `Open in Linear`。

处于`Needs Approval`/`Needs Info`、被blocker阻止或因Conductor Project Label移动而暂停的Root必须说明
“为什么当前没有
继续运行”。不显示虚构的Queue position或完成时间预测。

### 4.5 Ready for review

当当前Root处于In Review时显示：

- Root identifier和title；
- Project；
- 交付类型的安全摘要；
- 进入In Review的时间；
- `Open in Linear`。

Desktop不是branch交付成立的前置条件。branch、commit和PR的权威交付信息仍由Root
Managed Comment表达；Desktop只是可以显示已有的安全摘要，不能因为缺少额外Desktop
入口而阻止Root进入In Review。

### 4.6 Recent problems

只显示仍然影响当前工作的warning/error：

- affected object；
- sanitized summary；
- first/last observed time；
- current impact；
- `NextActionView`。

已恢复问题从默认列表移除，不构建长期审计中心。

## 5. 当前Root摘要

Overview中的当前Root摘要只显示：

- Root identifier、title、Project和用户可见状态；
- 当前Plan、Work或Verify Node的title；
- Human Action或blocked reason；
- 当前Root固定的Performer Profile；
- delivery摘要和`Open in Linear`；
- 最近活动和数据新鲜度。

完整Cycle Tree、所有Roots、Priority排序、attempt history、Findings和convergence records留在Linear。Desktop不提供Root列表、
Tree编辑、Plan approval、Human answer、取消Work或强制Done按钮。

当前有Performer Stage时，可以显示closed Event：

- Starting；
- Planning / Analyzing / Editing / Checking / Reviewing；
- Waiting for provider；
- Warning；
- Token usage；
- last heartbeat。

Event只表示实时观察，不能显示为Work完成、Verify通过或Workflow推进。Stage结束状态必须来自Result和
Linear/Git read-back。

## 6. Conductors页面

Conductors页面管理Desktop拥有的本地Runtime。

### 6.1 Conductor列表

每个Conductor显示：

- display name和short hash；
- 当前Project；
- repository display name和base branch；
- Runtime状态；
- active Performer Profile和readiness；
- 当前Root摘要；
- last heartbeat；
- 是否存在paused Root或Conductor Project conflict。

页面只有一个主要动作：`Create Conductor`。

### 6.2 Conductor Detail

分为七个区域：

1. **Conductor Binding**：当前Project、repository display、base branch、Label状态；
2. **Runtime**：desired state、observed state、heartbeat、process recovery；
3. **Performer Profiles**：Profile列表、active Profile、登录和SDK设置；
4. **Usage**：当前Stage完整Result的Token breakdown；
5. **Execution**：最近已知的Ready/Unknown/Needs attention和脱敏下一动作；
6. **Current work**：当前Root、当前节点和等待原因；
7. **Recent runtime events**：脱敏、单行、按时间排序。

允许的Desktop动作：

- Start；
- Stop；
- Restart；
- Create/Edit Performer Profile；
- Sign in with ChatGPT；
- Set/Replace API Key；
- Activate Profile；
- Open Resolved Conductor Project in Linear。

动作语义：

- `Stop`把desired state设为Stopped，不再启动新Stage；若存在当前Stage，进行有界取消并
  保留Linear/Git恢复事实；
- `Start`按同一Conductor Binding重建Conductor；
- `Restart`等价于安全Stop后Start；旧process tree未确认退出前不能启动replacement；
- 关闭Desktop执行同样的有界shutdown，下一次打开时恢复desired running Conductor
  Bindings。

不提供：

- 直接修改Conductor Binding的数据库字段；
- 强制接管其他Conductor的Root；
- 直接启动Performer Stage；
- 清空worktree或删除branch；
- 跳过Plan approval、Human action或Verify。

### 6.3 Performer Profiles

每个`PerformerProfileSummaryView`显示：

- display name；
- authentication method；
- sanitized account label；
- model；
- reasoning effort；
- Fast on/off/unavailable；
- sandbox mode；
- command allowlist/denylist；
- readiness；
- active标记；
- last status time。

Profile Detail不显示API Key、Token、`CODEX_HOME`、auth文件或SDK response。API Key
提交成功后只显示`Configured`。

`authenticationMethod`创建后不可编辑。用户需要从ChatGPT切到API Key或反向切换时，
创建新Profile、完成登录，再Activate；现有Root不会迁移。

`Activate`不重启Conductor，立即改变新Root使用的Profile。若当前turn或已有Root使用
旧Profile，页面同时显示：

```text
Current Root Profile
Active Profile for new Roots
```

编辑同一个Profile的model、reasoning、Fast或execution policy后，该Profile下一个role turn使用新设置；当前
turn继续。Desktop必须区分保存成功与Conductor拒绝：Update失败时保留并显示原设置，不能
乐观显示尚未被Conductor接受的新值。

若用户在role turn运行时发起Login或Status refresh，Desktop显示`Waiting for current
turn`；Edit和Activate不需要等待。

### 6.4 Project Conductor Pool与Root routing变化

若Label移动到另一个Project：

- Detail显示Previous Project、Current Project和`Project changed`；
- 若当前Root属于旧Project，其摘要显示为Paused；
- 明确显示Project Conductor Pool成员和每个Root的唯一routing Conductor；
- 多Project匹配显示`Project conflict`；同一Project的多个合法Conductor Labels显示为pool而不是冲突；
- Project有多个pool member时，未标记、多个Label或pool外Label的Root显示`Routing conflict`且不可执行；
- active Root的routing与Primary ownership不一致时显示`Ownership conflict`，不得提供静默接管；
- conflict期间Start/Restart不伪装成Ready。

`last_resolved_project_id`只是用于解释变化，不参与调度。

## 7. Settings页面

Settings保持小而稳定，只包含Desktop级配置和连接状态。
Performer Profiles按Conductor隔离，因此不进入Settings。

### 7.1 Linear

显示：

- workspace/organization；
- connection health；
- authorized identity的安全display信息；
- connected/last refreshed time；
- `Reconnect Linear`。

不显示access token、refresh token、Authorization Header、scope原始payload或OAuth
attempt secret。

### 7.2 Application

显示：

- Desktop版本；
- Runtime bundle版本；
- app-data health；
- 最近一次启动时间。

V1不增加自启动、更新channel、远程Runtime或高级调度设置。

## 8. 用户可见状态模型

UI使用面向用户的统一状态，不直接把多个内部枚举并排显示。

### 8.1 Desktop readiness

| 状态 | 含义 | 主要动作 |
|---|---|---|
| `Setup required` | Linear未连接、没有Conductor或没有ready Performer Profile | 继续Setup |
| `Starting` | Podium或Conductor正在启动 | 等待；显示当前步骤 |
| `Ready` | 至少一个Conductor及其active Performer Profile可工作 | 无 |
| `Paused` | 已完成Setup，但所有Conductor都由用户停止 | Start Conductor |
| `Needs attention` | 连接、Binding或Runtime需要用户处理 | 打开最高优先级问题 |
| `Unavailable` | 本地Backend无法提供`DesktopOverviewView` | Retry或查看错误 |

### 8.2 Conductor状态

| observed state | UI label | 说明 |
|---|---|---|
| desired stopped | `Stopped` | 用户已停止 |
| process starting | `Starting` | 正在建立private channel |
| handshake complete | `Ready` | 可以读取Linear并调度 |
| replacement starting | `Recovering` | 旧process已退出，正在恢复 |
| no matching Conductor Project Label | `Unbound` | 需要在Project恢复Label |
| one Conductor Label resolves multiple Projects | `Project conflict` | 不扫描任何Root |
| missing/ambiguous/out-of-pool Root Conductor Label | `Routing conflict` | 不claim或dispatch该Root |
| heartbeat stale, process not confirmed dead | `Not responding` | 不启动第二实例 |
| process exited | `Crashed` | Desktop准备或正在replacement |

### 8.3 Performer Profile状态

| readiness | UI label | 主要动作 |
|---|---|---|
| `login-required` | `Sign in required` | ChatGPT Login或Set API Key |
| `ready` | `Ready` | Activate或Edit |
| `invalid` | `Action required` | 修复登录或SDK设置 |

Conductor Runtime的`Ready`只表示process可通信。没有ready active Profile时，Desktop
整体仍为`Setup required`或`Needs attention`，不能显示Symphony可执行新Root。

### 8.4 Root状态

Linear terminal state优先于activity projection：

| Linear/activity事实 | UI label |
|---|---|
| Root Done | `Completed` |
| Root Canceled | `Canceled` |
| paused by Conductor Project Label move | `Paused` |
| `planning` | `Planning` |
| `awaiting-human` | `Needs your attention` |
| `working` | `Working` |
| `reviewing` | `Reviewing result` |
| `delivering` | `Preparing delivery` |
| Root In Review | `Ready for review` |
| `blocked` | `Action required` |
| `failed` | `Failed` |

状态旁必须显示文字和图标；不能只显示颜色。内部Root Activity投影Label可以放在Advanced details，
但不能要求用户理解`symphony:run/*`才能操作产品。

## 9. 状态优先级与Next Action

同一个对象只显示一个主状态，优先级为：

```text
Done/Canceled
-> failed
-> blocked/Conductor Project conflict
-> Performer Profile login/config required
-> paused
-> needs human
-> active activity
-> idle
```

Next action也只选一个最高优先级动作。其余问题显示在Detail中，避免Overview同时出现
多个互相竞争的主按钮。

每个named Desktop View的状态字段包含：

```text
status
statusLabel
sanitizedSummary
impact
nextAction
observedAt
isStale
```

`isStale=true`时必须显示最后更新时间，不能继续用绿色Ready误导用户。

## 10. 操作所有权

| 操作 | 用户在哪里完成 |
|---|---|
| Connect/Reconnect Linear | Desktop |
| Create/Start/Stop/Restart Conductor | Desktop |
| 选择Project/repository/base branch | Desktop Create Conductor |
| Create/Edit/Activate Performer Profile | Desktop Conductor Detail |
| ChatGPT官方登录 | Desktop触发，Performer调用Codex SDK |
| Set/Replace Codex API Key | Desktop输入一次，Performer调用Codex SDK |
| 查看当前Stage Token usage | Desktop |
| 创建或编辑Root | Linear |
| 设置Priority、blocker、Root order | Linear |
| Approve Plan或Stage action | Root Issue `Needs Approval` + Root Pending Action Comment |
| 提供Stage所需信息 | Root Pending Action Comment + Root `Needs Info` state |
| 查看、编辑或取消Cycle/typed node业务内容 | Linear |
| 移动Conductor Project Label | Linear |
| 审核交付并将Root置为Done | Linear/SCM automation |
| 推进Plan、Work、Verify、commit和delivery | Conductor/Performer，用户无强制按钮 |

Desktop可以提供`Open in Linear`，但不能复制一套Linear编辑器或用本地按钮绕过
Workflow。

## 11. Loading、Empty与Error状态

每个页面必须定义四种非成功状态：

- **Loading**：显示内容结构skeleton和正在读取的对象，不使用无限全屏spinner；
- **Empty**：说明为什么为空以及唯一下一动作；
- **Error**：显示具体类别、影响、是否可重试和下一动作；
- **Stale**：保留最后安全Snapshot，同时明确它不是当前确认状态。

典型Empty：

| 页面 | Empty文案和动作 |
|---|---|
| Overview | 尚未创建Conductor → Create Conductor |
| Conductors | 没有Conductor → Create Conductor |
| Performer Profiles | 没有Profile → Configure Codex |
| Recent problems | No current problems |

后台重试不能让页面长期停留在Loading。已知错误一旦出现，立即进入Error或Stale状态。

## 12. Desktop View契约

React只消费Podium生成的closed View：

```text
DesktopOverviewView
LinearConnectionView
ConductorSummaryView
ConductorDetailView
RootSummaryView
RootDetailView
AttentionItemView
RuntimeEventView
NextActionView
PerformerProfileSummaryView
PerformerProfileDetailView
PerformerUsageView
```

View按页面需要组合，不返回database record、SDK object或任意metadata。公共状态字段使用
封闭union；unknown variant拒绝而不是显示空白。

Root的`RootDispatchAssessment`和等待原因来自Conductor的当前报告；Podium只做安全字段
allowlist和跨页面attention排序，不重新解释Linear Tree。Linear连接和Conductor
Runtime `NextActionView`由Podium自己的control-plane事实产生。

默认View允许：

- display name、Linear identifier和安全URL；
- Project/repository display信息和base branch；
- 用户状态、`NextActionView`、时间和脱敏原因；
- Profile display、登录方式、model、reasoning、Fast和readiness；
- 当前Stage Token usage；
- 当前Root和target Node的有界摘要；
- closed Performer Event stage；
- 安全delivery摘要。

默认View禁止：

- Linear Token、OAuth secret、Header或cookie；
- Codex API Key、access/refresh token、auth文件内容；
- 绝对repository/worktree/profile路径；
- `CODEX_HOME`；
- Provider thread ID、Provider handle、SDK response或raw reasoning；
- 完整stdout/stderr、自由命令、diff或未脱敏exception；
- Podium数据库row或Conductor Profile配置文件原文。

## 13. 可访问性与窗口适配

- 所有页面只有一个`h1`，heading层级连续；
- sidebar、主内容和Detail导航支持键盘；
- 状态更新使用`aria-live="polite"`，阻塞错误使用`role="alert"`；
- 状态不只依赖颜色，同时使用文字和图标；
- focus在Dialog关闭后返回触发按钮；
- Loading、Empty、Error和Stale都有screen-reader可理解的说明；
- Desktop窗口变窄时先收起次要metadata，不隐藏`NextActionView`或错误；
- 不使用固定高度截断Root title、error summary或Human prompt。

## 14. 进程拓扑

```text
Podium Desktop
  Tauri Host
    -> Podium Backend
       -> podium.db
       -> Linear SDK
       -> one Conductor process per active Conductor Binding

Conductor
  -> performer-profiles/profiles.json
  -> one CODEX_HOME per Performer Profile
  -> one short-lived Python Performer control process per login/status operation
  -> one session-capable Performer runtime for Cycle role threads
```

Desktop不直接调用Performer。Conductor主动驱动每Root Reconciler session和每Cycle隔离的Plan、Work、Verify
sessions；Reconciler/Stage contracts不暴露给Desktop。

## 15. Create Conductor Runtime结果

Podium保存一个`ConductorBinding`：

```text
bindingId
conductorId
conductorShortHash
linearInstallationId
organizationId
repositoryContext
desiredState
```

Podium同时在所选Project上分配`symphony:conductor/<short-hash>`。一个Conductor
Binding对应一个Conductor和repository；当前Project由Conductor Project Label决定，
不由`podium.db`中的
`project_id`决定。

## 16. Desktop Host职责

Desktop Host负责：

- 启动Podium Backend；
- 启动、监控、停止和替换Conductor；
- 为Conductor创建继承式private IPC；
- 把Conductor Binding和运行路径传给Conductor；
- 在Desktop启动时reconcile所有active Conductor Bindings；
- 确认旧Conductor退出后再启动replacement。

Desktop Host不解释Linear Tree、不调度Root/Work、不启动Performer Stage、不持有
Provider SDK，也不直接调用Linear SDK。
Desktop Host不读取Profile配置文件、`CODEX_HOME`或API Key。

## 17. Podium Backend职责

Podium Backend负责：

- OAuth和Token refresh；
- Project Catalog与Conductor Binding；
- `podium.db`；
- Linear SDK Gateway；
- Performer Profile Command transient relay；
- Conductor health和named Desktop View。

React只通过`PodiumClientProtocol`访问Backend，永远不能获得Linear Token、refresh
token、private IPC handle、Codex auth、`CODEX_HOME`或原始process environment。

## 18. Podium-Conductor private channel

```text
ConductorRuntimeProtocol
  handshake
  heartbeat
  sanitized status
  shutdown

LinearGatewayProtocol
  closed Query
  closed Command
  closed Result

PerformerProfileProtocol
  closed Query
  closed Command
  closed Result/Event
  one bounded secret frame for SetCodexApiKeyCommand
```

Conductor不接收Linear Token。Podium Backend在本进程内给Linear SDK注入credential，
并把验证后的DTO返回Conductor。Codex API Key例外地通过Profile Protocol secret frame
瞬时转发，但Podium不保存、不回显。

Profile Create/Update/Activate和Login状态都以Conductor Result/Event为准。Podium或
React不得在本地预先提交active、ready或configured状态。

## 19. 生命周期

Desktop启动：

1. 打开`podium.db`；
2. 恢复Linear credential；
3. 读取active Conductor Bindings；
4. 对每个Conductor Binding确认repository仍匹配；
5. 确认没有旧Conductor或先停止旧实例；
6. 创建private channel并启动Conductor；
7. Conductor打开Profile配置文件并通过Performer SDK读取所有Profile account/status；
8. Conductor通过Linear Gateway解析Resolved Conductor Project；
9. 观察handshake、Profile readiness和heartbeat。

Conductor崩溃：

1. Desktop立即把状态变为Crashed或Not responding；
2. 确认旧Conductor process tree已经退出，包括短生命周期Performer child；
3. 按同一Conductor Binding启动replacement并显示Recovering；
4. replacement从Linear、Git、Profile配置文件和Codex-owned `CODEX_HOME`重建状态；
5. handshake完成后显示Ready。

Desktop关闭或用户Stop：

1. 将目标Conductor Binding置为Stopped或开始应用级shutdown；
2. 不再启动新的Performer Stage；
3. 对当前Performer child执行有界取消；
4. 等待并确认Conductor process tree退出；
5. 保留Linear、branch、worktree、Profile配置文件和Codex-owned `CODEX_HOME`；
6. 下次Start或Desktop启动时按同一Conductor Binding恢复。

不需要`workflow.db` lock、Performer controller transfer或operation reattach。

单Conductor Binding的退出检测、process-tree终止确认和replacement属于V1重启闭环；
多Conductor Binding批量reconcile、升级期间替换和长期资源治理属于后续Runtime硬化。

## 20. 单控制器约束

Conductor没有数据库不等于允许双实例。Desktop Host必须保证同一Conductor Binding同一时刻
只有一个控制Conductor：

- replacement前等待旧process退出；
- replacement前确认旧process tree中没有仍在运行的Performer Stage；
- channel携带不可复用的instance identity；
- Podium拒绝同一Conductor Binding的第二个active handshake；
- 失联但未确认退出时，不启动replacement。

失联但未退出时UI显示`Not responding`，不能显示`Recovering`或`Ready`。

## 21. `podium.db`

Desktop只持久化control-plane事实：

- Linear installation和credential；
- Project catalog cache；
- Conductor Binding；
- desired/observed runtime health；
- Last Resolved Project和Project Resolution conflict摘要；
- OAuth attempt。

不保存：

- Root、Tree、Root Reconciler、Work、Verify或Human Action状态；
- Root Activity投影；
- Performer session、Stage Result或Provider thread identity；
- Performer Profile、active Profile、Codex auth和`CODEX_HOME`；
- Token usage；
- polling checkpoint、dispatch Queue；
- branch、Gate或delivery receipt。

Desktop中的Root和Tree View是从Conductor当前报告组合的可丢弃Snapshot，不能反向成为
Workflow权威。

## 22. 未来Web形态

未来若增加Web产品，应建立独立`podium-web`应用并复用Podium公开接口。当前Desktop
架构不预先实现Web部署、远程Conductor、账号系统或云端credential模型。

## 23. 不变量

1. Podium Desktop是唯一上层产品外壳，Podium是可复用类库。
2. Desktop只有Overview、Conductors和Settings三个常驻入口。
3. Desktop展示`NextActionView`，但Workflow编辑和人工动作仍在Linear。
4. Desktop只管理Podium Backend和Conductor，不直接管理Performer。
5. Performer由Conductor通过caller-owned session/turn protocol调用，不能反向调用Conductor。
6. Linear Token只在Podium Backend。
7. 同一Conductor Binding只有一个active Conductor。
8. Conductor没有数据库，重启从Linear、Git、Profile配置文件和Codex-owned
   `CODEX_HOME`恢复。
9. replacement开始前旧Conductor及其Performer child必须全部终止。
10. UI状态必须可解释、可操作、可判断新鲜度，不能只暴露内部枚举。
11. Desktop View不包含secret、绝对路径或Provider原始数据。
12. branch-only交付不依赖Desktop额外入口才成立。
13. Desktop关闭或Conductor Stop只暂停工作，不清除Root、branch、worktree或Linear/Git事实。
14. Podium只转发Profile操作和组合View，不保存Profile、active选择、Codex auth或usage。
15. API Key只在一次性输入和secret relay中出现，Desktop不能重新显示。
16. Profile切换无需重启，但已有Root保持固定Profile。
17. 当前不提供多Root列表、聚合Workflow图或并行Root进度展示；完整Workflow在Linear中查看。

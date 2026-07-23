# Podium Desktop 产品与Runtime设计

状态：目标架构提案。Podium Desktop是Symphony的本地control-plane外壳；Podium是其内部TypeScript类库。
本文定义Desktop配置、连接、进程管理和运行观测边界，不包含Workflow UI或UI代码实施计划。

## 1. 产品边界

Desktop只让用户完成三类事情：

1. 连接Linear；
2. 创建和配置本地Conductor及Performer Profile；
3. 查看Linear连接、Conductor在线性、版本、日志和基础健康观测。

Linear是唯一Workflow浏览和操作面。Desktop不得读取、组合、解释、显示或修改Root、Cycle、Plan、Work、Verify、
Finding、Human Action、delivery或任何Workflow下一步。用户审批、拒绝、补充信息、修改需求、取消工作和验收交付
全部在Linear完成。

Desktop公开的状态只有：

```text
LinearConnection = connected | disconnected
ConductorPresence = online | offline
```

`online`只表示matching Conductor private channel当前可通信；不表示Project有效、Profile ready、Root可执行、Stage
运行或Workflow健康。`offline`不区分stopped、starting、recovering、not-responding或crashed；原因只作为当前命令
结果或脱敏日志展示，不能形成另一套持久状态。

## 2. 信息架构

Desktop只有三个常驻入口：

```text
Overview
Conductors
Settings
```

| 页面 | 内容 | 动作 |
|---|---|---|
| Overview | Linear connected/disconnected、Conductor online/offline、最近运行错误 | Connect、Open Conductors |
| Conductors | Binding、repository、Profile配置、在线性、版本和运行日志 | Create、Start、Stop、Restart、Configure Profile |
| Settings | Linear连接和Desktop应用信息 | Connect或Reconnect Linear |

Desktop不提供Root列表、当前工作、当前Stage、Workflow状态、Timeline、Human Action、审批入口、Next Action、Token
usage、Finding、Verify、交付摘要或`Open Root in Linear`快捷动作。用户从Linear本身进入这些对象。

## 3. Setup

首次使用按配置缺口进入对应步骤：

```text
Linear disconnected
-> Connect Linear
-> no Conductor Binding
-> Create Conductor
-> no Performer Profile
-> Configure Codex
-> configuration complete
```

这是配置流程，不是Workflow或daemon状态机。步骤只由当前credential、Binding和Profile配置是否存在派生，不持久化
`current_step`。

### 3.1 Connect Linear

页面显示workspace安全名称、connected/disconnected、最近一次连接检查时间和`Connect Linear`或`Reconnect Linear`。
成功必须由真实Linear SDK调用确认；Command已接收不能显示为connected。失败显示脱敏原因，不显示Token、OAuth payload
或Authorization Header。

### 3.2 Create Conductor

创建表单包含：

1. accessible Linear Project；
2. native picker选择的本地Git repository；
3. base branch；
4. 配置摘要。

Podium创建`ConductorBinding`并在所选Project维护对应Conductor Project Label。Project只用于这次配置；运行时仍由
Conductor从Linear label解析Project。Desktop不读取该Project中的Roots或Workflow统计。

### 3.3 Configure Codex

Profile配置包括display name、ChatGPT或API Key认证、model、reasoning effort、Fast、sandbox mode以及command
allowlist/denylist。API Key只在一次性输入和secret relay中出现，不能保存或重新显示。

登录和Profile mutation必须等待Conductor/Performer真实Result；失败保留原配置。Login pending URL、user code和expiry
是一次操作输出，不是daemon或Workflow状态。

## 4. Overview

Overview只显示：

- Linear connected/disconnected和最近检查时间；
- 每个Conductor的display name与online/offline；
- Desktop、Podium、Conductor bundle版本；
- 最近仍相关的连接或process错误摘要。

它不显示“Symphony is working”“等待审批”“当前Root”“Ready for review”等由Workflow推导的结论，也不根据
Conductor在线性推断执行能力。

## 5. Conductors

### 5.1 列表

每个Binding显示display name、repository display name、base branch、online/offline和最后一次presence检查时间。列表
不得显示Project中的Root数量、当前Root、队列、运行阶段或blocked原因。

### 5.2 Detail

Detail只包含：

1. **Binding**：Conductor identity、repository display、base branch和resolved Project安全名称；
2. **Presence**：online/offline、last observed time和private channel版本；
3. **Performer Profiles**：配置、认证操作和active Profile选择；
4. **Runtime Logs**：有界、脱敏、可丢弃日志；
5. **Versions**：Desktop、Podium、Conductor和Performer bundle版本。

允许Start、Stop、Restart、Create/Edit/Activate Profile和认证操作。Start/Stop/Restart只控制本地process，不写Linear
Workflow status，不取消、重排或完成任何Issue。Conductor收到shutdown后自行按其runtime contract有界停止；Desktop
只等待process退出并把presence更新为offline。

不提供强制接管Root、启动Stage、清空worktree、删除branch或任何Workflow mutation。

### 5.3 Performer Profile

Profile页面显示配置字段和认证操作的最后一次真实Result。Desktop不显示当前Root使用的Profile、当前Stage usage或
Provider thread。Activate只改变Conductor保存的active Profile，已有Root如何使用固定Profile属于Conductor事实，
Desktop不解释或展示。

## 6. Settings

Settings只包含：

- Linear workspace安全名称、connected/disconnected、last checked和Reconnect；
- Desktop与runtime bundle版本；
- app-data health和最近启动时间。

当前不增加Workflow设置、调度策略、Root统计、自启动、更新channel或远程Runtime。

## 7. View契约

```text
DesktopOverviewView
LinearConnectionView
ConductorSummaryView
ConductorDetailView
ConductorPresenceView
RuntimeLogView
PerformerProfileSummaryView
PerformerProfileDetailView
ApplicationInfoView
```

```text
LinearConnectionView
  connection: connected | disconnected
  workspace_display_name?
  observed_at
  sanitized_error?

ConductorPresenceView
  presence: online | offline
  observed_at
  protocol_version?
  sanitized_error?
```

View不包含Root identity、Issue、Tree、status、directive、Human Action、Stage、Result、Finding、delivery、Git revision、
token usage、Provider session或Workflow next action。View是当前查询结果，不写入`podium.db`，不支持从旧View恢复。

## 8. 进程拓扑

```text
Podium Desktop
  Tauri Host
    -> Podium Backend
       -> podium.db
       -> Linear SDK
       -> one Conductor process per started Conductor Binding

Conductor
  -> performer-profiles/profiles.json
  -> one CODEX_HOME per Performer Profile
  -> Python Performer processes
```

Desktop不直接调用Performer。Root Reconciler和Stage contracts不暴露给Desktop或Podium View边界。

## 9. Conductor Binding

```text
ConductorBinding
  binding_id
  conductor_id
  conductor_short_hash
  linear_installation_id
  organization_id
  repository_context
```

Binding不保存`project_id`或daemon desired/observed state。Desktop启动不会把历史online/offline当作恢复依据；用户启动
一个Binding后，Host根据实际process和private channel重新观察presence。

## 10. Desktop Host

Desktop Host负责启动Podium Backend，按用户命令启动、停止或替换Conductor，创建private IPC，传入Binding和运行
路径，并在replacement前确认旧process tree退出。

Host不解释Linear Tree、不调度Root/Work、不启动Stage、不持有Provider SDK，也不直接调用Linear SDK。Host不得把
process exit或日志翻译成Workflow状态。

## 11. Podium Backend

Podium Backend负责OAuth与Token refresh、Project Catalog、Conductor Binding、`podium.db`、Linear SDK Gateway、Profile
Command瞬时转发以及Desktop View查询。

React只通过`PodiumClientProtocol`访问Backend，不能获得Linear Token、private IPC handle、Codex auth、`CODEX_HOME`
或原始process environment。

## 12. Private channel

```text
ConductorRuntimeProtocol
  handshake
  shutdown
  bounded sanitized log event

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

handshake只能更新当前内存presence。它不是lease、workflow cursor、Root ownership或恢复事实。Podium
不得把Runtime Event持久化为状态机。

## 13. Process生命周期

Start成功的判据是matching process完成private-channel handshake并可通信，随后View显示online。Stop成功的判据是
matching process tree确认退出，随后显示offline。中间过程只显示命令进行中，不增加starting、stopping、recovering、
crashed或not-responding等持久或公共状态。

unexpected exit或private channel断开使当前presence变为offline并产生脱敏日志。Desktop不根据该事件修改任何Linear对象，
也不声称Workflow失败、暂停或恢复。再次Start创建fresh process；Conductor自己从Linear/Git恢复Workflow。

同一Binding同时最多一个Conductor process。旧process未确认退出时，replacement失败并保持当前真实presence，不启动
第二个实例。

## 14. `podium.db`

`podium.db`只保存：

- Linear installation和credential；
- Project catalog cache；
- Conductor Binding；
- OAuth attempt。

它不保存online/offline、heartbeat、日志、Root、Tree、Root Reconciler、Plan/Work/Verify、Human Action、Profile、active
Profile、Codex auth、usage、poll checkpoint、Queue、Git或delivery事实。

Performer Profile和active Profile由Conductor自己的Profile配置边界保存；Podium只在当前请求中转发和展示。

## 15. 可访问性

- 状态同时使用文字和图标，不只依赖颜色；
- 连接变化使用`aria-live="polite"`，命令失败使用`role="alert"`；
- focus在Dialog关闭后返回触发按钮；
- offline、empty和error有独立说明；
- 窗口变窄时不隐藏连接状态或错误；
- 日志区域有明确边界，不让动态内容改变主要布局。

## 16. 不变量

1. Linear是唯一Workflow浏览、交互和状态面；Desktop没有Workflow功能。
2. Desktop不展示或修改Root、Cycle、Node、Human Action、Result、Finding、delivery或Workflow next action。
3. Desktop公开状态只有Linear connected/disconnected和Conductor online/offline。
4. online/offline来自当前真实连接，不持久化、不参与Conductor或Workflow恢复。
5. Desktop只管理Podium Backend和Conductor process，不直接管理Performer。
6. Linear Token只在Podium Backend；Codex secret只经过一次性relay。
7. 同一Conductor Binding同时最多一个Conductor process。
8. Desktop View不包含secret、绝对路径、Provider原始数据或Workflow事实。
9. Desktop关闭或Stop不清除Linear、Git、Profile或`CODEX_HOME`事实。
10. 完整工作流、审批、补充信息、需求修改和交付验收全部在Linear完成。

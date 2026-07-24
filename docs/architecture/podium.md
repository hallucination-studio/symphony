# Podium TypeScript类库设计

状态：目标架构提案。Podium是Desktop使用的control-plane类库，也是唯一Linear SDK与credential所有者。

## 1. 职责

Podium拥有：

- Linear OAuth、installation、access/refresh token；
- accessible Project catalog；
- stable Conductor Identity + Repository Context；
- 在用户所选Project上创建/维护Project Conductor Pool，并为Root分配唯一Root Conductor Label；
- `podium.db`中的credential、Conductor Identity和Conductor Binding；
- Linear SDK client；
- 面向Conductor的`LinearGatewayProtocolHandlerImpl`；
- Conductor online/offline observation和命名明确的Desktop View；
- 面向Desktop的Performer Profile Command转发和Profile配置View组合。

Podium不拥有：

- Workflow Tree解释；
- 任何Root、Cycle、Node、Human Action、Result、Finding、delivery或Workflow View；
- Root scheduling、Stage选择和Verify；
- Git worktree/branch/PR；
- Provider SDK、Performer session transport或Provider thread解释；
- Performer Profile、Codex auth、API Key或`CODEX_HOME`持久化；
- Conductor workflow database。

## 2. 模块

```text
packages/podium/src/
  public/
    PodiumDesktopInterface.ts
    DesktopViewInterface.ts
  internal/
    linear-auth/
    project-catalog/
    conductor-bindings/
    linear-gateway/
    performer-profile-relay/
    conductor-presence/
    desktop-views/
```

| 模块 | 职责 |
|---|---|
| `linear-auth` | OAuth、refresh、credential |
| `project-catalog` | Project pagination |
| `conductor-bindings` | Conductor Identity、Repository Context、Project Conductor Pool与Root routing assignment |
| `linear-gateway` | closed Linear query/mutation |
| `performer-profile-relay` | 把Desktop Profile Command转发给目标Conductor，不保存payload |
| `conductor-presence` | 从当前private channel派生online/offline，不持久化 |
| `desktop-views` | 组合Overview、Conductor和Settings所需的named Desktop View |

## 3. Linear Gateway

```text
generated LinearGatewayProtocol
  -> LinearGatewayProtocolHandlerImpl
     -> LinearClientInterface
        <- LinearSdkImpl
```

Conductor内部的`LinearGatewayInterface`由`PodiumLinearGatewayClientImpl`实现；Podium
不导入该Interface。Podium只实现generated `LinearGatewayProtocolHandlerImpl`并执行
SDK调用，但不决定调用时机或Workflow含义。`LinearGatewayProtocolHandlerImpl`只接受
封闭Command/Query：

- resolve Resolved Conductor Project and its Project Conductor Pool by Conductor Project Label；
- validate and mutate one Root Conductor Label from that pool；
- create a Root only after validating one selected pool member and write only the
  matching `symphony:conductor/<short-hash>` Issue Label；
- list Roots；
- fetch complete Workflow Issue Tree；
- fetch resolved Team workflow status catalog；
- read Priority、normalized `updatedAt`、blocker和comments；Root `sortOrder`不定义跨Root调度；
- execute closed Issue mutation；
- execute `WorkflowMutationCommand`；
- read-back ambiguous mutation。

不暴露arbitrary GraphQL、SDK object、Token或Header。

每个Project级mutation必须携带`conductor_short_hash + expected_project_id`和Project
remote precondition。修改已有Issue、Comment或Label时还携带目标对象的
`expected_updated_at`、预期status ID/parent和Managed Marker。Podium校验SDK response shape，Conductor
解释status category、Issue kind和allowed transition。任一precondition不匹配时
fail closed，不执行mutation，并返回封闭conflict Result供Conductor重新读取。

## 4. Credential

Refresh token和access token只存在于Podium-owned`podium.db`和Podium内存。Conductor通过private protocol调用Gateway，不获得Token bytes。

这消除了：

- access token generation发放；
- Conductor token rotation；
- Conductor SDK dependency；
- Token进入Conductor memory/log的风险。

Codex credential不属于Podium Credential。ChatGPT登录和API Key只由Desktop触发，经
`PerformerProfileProtocol`瞬时转发到Conductor，再由Performer SDK处理。

Podium：

- 不保存`PerformerProfile`；
- 不保存active Profile ID；
- 不保存API Key或Codex auth；
- 不读取`CODEX_HOME`；
- 不把secret写入log、request cache或View。

Desktop点击Activate只是在Podium发出
`ActivatePerformerProfileCommand`。Conductor验证Profile并提交`activeProfileId`后，
Podium才展示新的active状态；Podium不能预写、缓存或在Conductor不可达时乐观提交该
事实。

## 5. Conductor Binding

```text
CreateConductorCommand
  projectId
  repositoryContext
```

Podium验证Project属于当前installation，并保存：

```text
bindingId
conductorId
conductorShortHash
linearInstallationId
organizationId
repositoryContext
```

`projectId`只用于本次Command把Conductor Project Label加入Project Conductor Pool，不作为
Conductor Binding权威字段持久化。一个Project可以有多个不同的Conductor Project Labels；
一个Conductor Project Label仍然必须最多出现在一个Project，因而每个Conductor仍只解析一个
Resolved Conductor Project。

Project Conductor Pool mutation使用closed desired-member set、fresh current-member set和remote
precondition。加入第二个member前，所有非终态Root必须已有一个仍在desired set中的唯一Root
Conductor Label；移除member前，不得存在route或Root Control Record ownership仍指向它的非终态Root。
任一条件不满足都fail closed，不做partial pool mutation。

Conductor runtime必须遍历全部Binding。Desktop只显示每个Binding的resolved Project安全名称；Project pool、
Root routing、ownership和conflict细节只在Linear和Conductor日志中存在，不进入Desktop View。

创建Root时，调用方可以从Project Conductor Pool中选择一个`conductor_id`。Podium必须在同一
Root creation boundary fresh读取Project pool和目标 Issue Label：Project pool必须包含且只接受一个
selected member，目标 Issue Label必须唯一；随后`issueCreate`只能写入对应的
`symphony:conductor/<short-hash>` Issue Label，并 read-back确认Root仍是顶层、属于目标Project且保留该
label。Podium不写Root Control Record ownership、Cycle、Node或Workflow evidence。Project只有一个pool member时，
省略Root选择可解析为该唯一member；Project有多个member时省略、指定多个或指定pool外member都必须在
Root创建边界失败。Project Conductor Label是Project membership，Root Conductor Issue Label是routing，
两者不能混为ownership或lease。

## 6. Podium数据库

`podium.db`只保存control-plane事实：

- installation/credential；
- Project catalog cache；
- Conductor Binding；
- Conductor Identity与Conductor Short Hash；
- OAuth attempt。

不保存权威project_id、Conductor online/offline、heartbeat、log、Root、Issue Tree、polling checkpoint、dispatch、
Stage Result、Performer Profile、active Profile、Codex credential、usage、Verify或delivery。

## 7. 接口

```text
PodiumDesktopInterface
PodiumDesktopImpl
DesktopViewInterface
PodiumDesktopViewImpl

LinearInstallationStoreInterface
ConductorBindingStoreInterface
PerformerProfileRelayInterface
ConductorPerformerProfileRelayImpl

DesktopOverviewView
LinearConnectionView
ConductorSummaryView
ConductorDetailView
ConductorPresenceView
RuntimeLogView
PerformerProfileSummaryView
PerformerProfileDetailView
ApplicationInfoView

LinearClientInterface
LinearSdkImpl
SqlitePodiumStoreImpl
LinearGatewayProtocolHandlerImpl
```

`DesktopViewInterface`只组合Linear连接、Conductor当前online/offline、Podium control-plane配置和安全display
信息。它不接收或输出任何Workflow事实，也不把View写回`podium.db`或Linear。
页面、状态和字段边界见[Podium Desktop产品与Runtime设计](podium-desktop.md)。

`PodiumDesktopImpl`和`PodiumDesktopViewImpl`都属于Podium内部实现，不进入package
exports。

`PerformerProfileRelayInterface <- ConductorPerformerProfileRelayImpl`只负责private
protocol调用和bounded Event转发。它不缓存Profile内容，API Key Command完成后立即清除relay内存引用。

两个Store Interface分别由`linear-auth`和`conductor-bindings`定义；`SqlitePodiumStoreImpl`可以同时实现它们。
Conductor presence没有Store Interface，只从当前private channel读取。Interface不导出
Impl、SDK type或database record。

## 8. 不变量

1. Podium是唯一Linear SDK/Token所有者。
2. Podium不解释Workflow。
3. Linear Gateway mutation必须来自Conductor封闭Command。
4. Browser/UI永远拿不到Token。
5. `podium.db`不是Workflow数据库。
6. 业务词和代码类型名遵守[架构术语表](glossary.md)。
7. Podium不持久化Performer Profile、active Profile、Codex credential或usage。
8. Profile设置和登录语义由Conductor/Performer拥有，Podium只转发和展示。
9. Desktop View不包含任何Workflow事实；公开运行状态只有Linear connected/disconnected和Conductor online/offline。

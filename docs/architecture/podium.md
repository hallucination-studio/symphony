# Podium TypeScript类库设计

状态：目标架构提案。Podium是Desktop使用的control-plane类库，也是唯一Linear SDK与credential所有者。

## 1. 职责

Podium拥有：

- Linear OAuth、installation、access/refresh token；
- accessible Project catalog；
- stable Conductor Identity + Repository Context；
- 在用户所选Project上创建/分配Conductor Project Label；
- `podium.db`中的credential、Conductor Identity和Conductor Binding；
- Linear SDK client；
- 面向Conductor的`LinearGatewayProtocolHandlerImpl`；
- Conductor desired/observed state和命名明确的Desktop View。
- 面向Desktop的Performer Profile Command转发和Profile/usage View组合。

Podium不拥有：

- Workflow Tree解释；
- Root Activity投影或Root readiness派生；
- Root scheduling、Stage选择和Verify；
- Git worktree/branch/PR；
- Provider SDK、StageWire或Provider thread解释；
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
    runtime-observations/
    desktop-views/
```

| 模块 | 职责 |
|---|---|
| `linear-auth` | OAuth、refresh、credential |
| `project-catalog` | Project pagination |
| `conductor-bindings` | Conductor Identity、Repository Context与Conductor Project Label assignment |
| `linear-gateway` | closed Linear query/mutation |
| `performer-profile-relay` | 把Desktop Profile Command转发给目标Conductor，不保存payload |
| `runtime-observations` | Conductor health |
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

- resolve Resolved Conductor Project by Conductor Project Label；
- list Roots；
- fetch complete Issue Tree；
- fetch resolved Team workflow status catalog；
- read Priority/blocker/order/comments；
- execute closed Issue mutation；
- execute `LinearMutationCommand`；
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
desiredState
```

`projectId`只用于本次Command把Conductor Project Label添加到Project，不作为
Conductor Binding权威字段持久化。一个Project必须最多有一个Conductor Project
Label；一个Conductor Project Label必须最多出现在一个Project。

## 6. Podium数据库

`podium.db`只保存control-plane事实：

- installation/credential；
- Project catalog cache；
- Conductor Binding；
- Conductor Identity与Conductor Short Hash；
- Runtime desired/observed health；
- `last_resolved_project_id`和Project Resolution conflict摘要，仅作为可丢弃
  runtime observation；
- OAuth attempt。

不保存权威project_id、Root、Issue Tree、polling checkpoint、dispatch、Stage Result、
Performer Profile、active Profile、Codex credential、usage、Verify或delivery。

## 7. 接口

```text
PodiumDesktopInterface
PodiumDesktopImpl
DesktopViewInterface
PodiumDesktopViewImpl

LinearInstallationStoreInterface
ConductorBindingStoreInterface
RuntimeObservationStoreInterface

PerformerProfileRelayInterface
ConductorPerformerProfileRelayImpl

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

LinearClientInterface
LinearSdkImpl
SqlitePodiumStoreImpl
LinearGatewayProtocolHandlerImpl
```

`DesktopViewInterface`只组合Conductor当前报告、Podium control-plane事实和安全display
信息。它不解释Workflow Tree、不产生`RootDispatchAssessment`，也不把View写回为Workflow状态。
页面、状态和字段边界见[Podium Desktop产品与Runtime设计](podium-desktop.md)。

`PodiumDesktopImpl`和`PodiumDesktopViewImpl`都属于Podium内部实现，不进入package
exports。

`PerformerProfileRelayInterface <- ConductorPerformerProfileRelayImpl`只负责private
protocol调用和bounded Event转发。它不缓存Profile内容或usage，API Key Command完成后
立即清除relay内存引用。`PerformerUsageView`来自Conductor当前报告；Podium只在一次
View请求内汇总，不建立计数器。

三个Store Interface分别由`linear-auth`、`conductor-bindings`和
`runtime-observations`定义；`SqlitePodiumStoreImpl`可以同时实现它们。Interface不导出
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

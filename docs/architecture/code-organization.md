# 代码模块与命名规范

状态：目标架构提案。本文定义如何用一致的模块边界和命名组织Symphony代码，不描述实施顺序。

## 1. 组织原则

1. 按业务能力拆模块，不按controller/model/utils等技术层横切整个项目。
2. 模块对外只暴露`api`和`*Interface`，实现放在`internal`并以`*Impl`命名。
3. 调用方定义自己需要的Interface；提供方实现跨进程Protocol或本地Impl。
4. Podium、Conductor和Performer不能导入彼此实现。
5. SDK、数据库record、process handle和transport类型不能穿过业务Interface。
6. 只有确实跨进程共享的closed schema进入`contracts`。

## 2. 固定后缀

本节是整个`docs/architecture`的命名唯一事实源。其他文档可以给出本模块示例，但
不得重新定义完整后缀表。

| 类型 | 后缀 | 示例 |
|---|---|---|
| 稳定能力边界 | `*Interface` | `LinearGatewayInterface` |
| 具体实现 | `*Impl` | `LinearSdkImpl` |
| 改变状态的输入 | `*Command` | `UpdateIssueStateCommand` |
| 读取输入 | `*Query` | `GetIssueTreeQuery` |
| 封闭结果 | `*Result` | `WorkStageResult` |
| 结构化失败 | `*Error` | `ProtocolError` |
| 可丢弃观察 | `*Event` | `PerformerHeartbeatEvent` |
| 外部事实副本 | `*Snapshot` | `LinearIssueTreeSnapshot` |
| 组合后的当前视图 | `*View` | `RootRunView` |
| 模块间纯决策边界 | `*PolicyInterface` | `RootSchedulingPolicyInterface` |
| 模块内纯规则 | `*Policy` | `LinearPriorityPolicy` |
| 应用编排 | `*UseCase` | `RunRootStageUseCase` |
| 跨进程封闭协议 | `*Protocol` | `LinearGatewayProtocol` |

禁止把`Manager`、`Service`、`Helper`、`Utils`作为默认命名。只有当领域本身就叫Service时才允许使用。

## 3. Interface与Impl

```text
root-scheduling/api/RootSchedulingPolicyInterface.ts
root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.ts
```

规则：

- Interface只包含调用方真正需要的方法；
- Interface不返回任意`dict`、SDK object或database row；
- Impl不能从app/package public API导出；
- 业务模块之间导入目标模块的`api`，不深路径导入`internal`；
- composition root是唯一可以同时看见Interface和Impl的地方。
- `*UseCase`是app composition/main调用的应用编排，不作为另一个业务模块的依赖；
  业务模块需要该能力时仍依赖对应`*Interface`。

跨模块使用的Policy也属于Interface，统一命名为`*PolicyInterface`；只有不离开模块内部的纯规则对象才使用`*Policy`。

## 4. 角色边界

### Podium TypeScript

模块：

```text
linear-auth
project-catalog
conductor-bindings
linear-gateway
performer-profile-relay
runtime-observations
desktop-views
```

Linear SDK只能出现在：

```text
linear-gateway/internal/LinearSdkImpl.ts
```

Podium内部使用`LinearClientInterface <- LinearSdkImpl`。Podium还包含
`LinearGatewayProtocolHandlerImpl`，但不导入Conductor的`LinearGatewayInterface`。
Linear OAuth/credential只能出现在Podium。Codex credential由SDK保存在Profile
`CODEX_HOME`中。Podium模块不能包含Root调度、Tree遍历、Provider SDK或Profile登录
语义，只能通过`performer-profile-relay`转发closed Command。

### Conductor TypeScript

模块：

```text
linear-gateway
root-discovery
root-scheduling
root-reconciliation
cycle-supervisor-client
cycle-directive-materialization
performer-agent-client
human-actions
workflow-events
timeline-projections
performer-profiles
git-workspaces
root-delivery
runtime-reporting
```

Conductor不能出现Linear SDK、Provider SDK或workflow persistence repository。
`RootReconciliationView`和`LinearIssueTreeSnapshot`只存在于内存。

`root-reconciliation`拥有不调用模型的`RootReconciliationPolicyInterface`；
`cycle-supervisor-client`构造完整Cycle observation并调用Performer；
`cycle-directive-materialization`验证和执行closed directive；`performer-agent-client`拥有四role session/turn
transport。`workflow-events`只发布typed event，`timeline-projections`只渲染和投影Root/Cycle comments。
完整边界分别由[Root Reconciliation](root-reconciliation.md)、[Cycle Supervisor](cycle-supervisor.md)、
[Stage Contracts](stage-orchestration.md)和[Workflow Timeline](workflow-timeline.md)定义。

Conductor可以保存`PerformerProfile`明文配置文件，但不能读取或修改Profile
`CODEX_HOME`中的Codex-owned文件。Profile配置文件不是数据库。
Profile的Create/Update/Activate由Conductor提交；Podium只能经Protocol转发。
`PerformerProfile`和`CodexTurnSettings`放在`performer-profiles/api`，因为Store
Interface需要它们；SDK account/login类型和Profile View wire types不进入这两个领域
对象。

Conductor的`linear-gateway/internal/PodiumLinearGatewayClientImpl`实现
`linear-gateway/api/LinearGatewayInterface`并调用generated Protocol；它不含Token或
SDK逻辑。

### Performer Python

模块：

```text
agent_protocol
cycle_supervisor
role_execution
session_runtime
profile_control
backends
```

Provider SDK只能出现在：

```text
backends/<provider>/<Provider>BackendImpl.py
```

`ProviderBackendInterface`和registry属于Performer内部，不进入跨角色contracts。
`CodexTurnSettings`是批准的产品DTO；Codex SDK类型、login handle、auth/account payload
和SDK参数映射仍只能存在于`CodexBackendImpl`。
Supervisor observation和Stage turn request可以携带approved `CodexTurnSettings`；不能携带任意Provider config
map。四个role session和Provider thread mapping只存在于Performer `session_runtime`。

### Podium Desktop

- React只负责UI；
- Podium Backend组合Podium类库；
- Tauri Rust Host只负责本地窗口和process生命周期；
- Desktop不包含Conductor workflow模块。

## 5. 跨进程契约

```text
contracts/
  podium-client/
  desktop-host/
  podium-conductor/
  conductor-performer/
```

每条Protocol有独立schema和generated types。Schema只包含：

- closed Command/Query/Request/Response/Result/Event和Protocol envelope；
- ID、时间、枚举、有界文本；
- 明确版本。
- secret input metadata；API Key值使用独立bounded secret frame。

Schema不包含：

- Interface或Impl；
- SDK/generated provider types；
- database record；
- arbitrary metadata；
- API Key、Token、Codex auth或`CODEX_HOME`绝对路径；
- 多版本兼容逻辑。

## 6. 文件命名

TypeScript：

```text
LinearGatewayInterface.ts
RootReconciliationPolicyInterface.ts
CycleSupervisorClientInterface.ts
CycleDirectiveMaterializerInterface.ts
PerformerAgentClientInterface.ts
WorkflowTimelinePublisherInterface.ts
PodiumLinearGatewayClientImpl.ts
LinearGatewayProtocolHandlerImpl.ts
GetIssueTreeQuery.ts
RootRunView.ts
```

Python：

```text
provider_backend_interface.py
codex_backend_impl.py
execute_work_request.py
work_result.py
cycle_supervisor_runtime.py
```

语言内遵守各自惯例，但类型后缀保持一致。缩写只使用产品已确认词汇，例如`OAuth`、`SDK`、`PR`。

字段命名：

- TypeScript业务对象和View使用`camelCase`；
- Python内部对象使用`snake_case`；
- generated JSON Schema、跨进程wire和Linear Managed Marker字段统一使用
  `lower_snake_case`；
- 不为了TypeScript方便修改wire字段，也不把wire字段风格扩散到TypeScript业务对象。

## 7. 依赖方向

```text
podium-desktop -> podium + contracts
conductor      -> contracts
performer      -> generated contracts

Podium internal modules    -> Podium-owned Interfaces
Conductor internal modules -> Conductor-owned Interfaces
Performer internal modules -> Performer-owned Interfaces

Podium -X-> Conductor implementation
Conductor -X-> Podium implementation
Conductor -X-> Performer implementation
Performer -X-> Linear
```

跨角色调用只能通过Protocol。即使两个项目都使用TypeScript，也不能通过源码import绕过runtime boundary。

## 8. 测试边界

每个模块至少有：

- Policy纯逻辑测试；
- Interface contract fixtures；
- Impl与外部系统的边界测试；
- dependency boundary guard。

架构测试必须拒绝：

- Linear SDK出现在Podium之外；
- Provider SDK出现在Performer backend之外；
- `internal`被跨角色导入；
- Conductor workflow database/repository；
- 未带规定后缀的public contract。

## 9. 不变量

1. 模块交互只依赖Interface。
2. 实现统一以Impl结尾并保持内部可见。
3. SDK所有权不能跨模块漂移。
4. Snapshot/View不伪装成持久事实。
5. contracts只保存必要的wire schema。
6. Interface只服务当前模块交互，不预建未来能力。
7. 业务词和代码类型名必须遵守[架构术语表](glossary.md)。

# 目标仓库目录

状态：目标架构提案。本文只定义目标目录，不包含迁移步骤或兼容层。

## 1. 顶层

```text
symphony/
├── apps/
│   ├── podium-desktop/
│   ├── conductor/
│   └── performer/
├── packages/
│   ├── podium/
│   └── contracts/
├── docs/
│   └── architecture/
└── tests/
    ├── architecture/
    ├── contracts/
    └── integration/
```

Podium保留独立类库，因为Desktop使用它，未来独立Web应用也可以复用。Conductor和Performer当前各只有一个进程宿主，业务模块直接放在对应app中，不再增加一层同名package。

## 2. Podium Desktop

```text
apps/podium-desktop/
├── src/                     # React UI
├── src-backend/             # TypeScript Podium composition
└── src-tauri/               # Rust Host
    └── src/
        ├── conductor_process/
        ├── private_ipc/
        └── desktop_lifecycle/
```

Desktop Backend依赖`@symphony/podium`和generated contracts。Tauri Host只负责窗口与process生命周期。

## 3. Conductor

```text
apps/conductor/
└── src/
    ├── main.ts
    ├── composition/
    ├── linear-gateway/
    │   ├── api/
    │   │   └── LinearGatewayInterface.ts
    │   ├── internal/
    │   │   └── PodiumLinearGatewayClientImpl.ts
    │   └── tests/
    ├── root-discovery/
    ├── root-scheduling/
    │   ├── api/
    │   │   └── RootSchedulingPolicyInterface.ts
    │   └── internal/
    │       └── LinearPriorityRootSchedulingPolicyImpl.ts
    ├── linear-tree/
    │   ├── api/
    │   │   └── LinearTreeTraversalPolicyInterface.ts
    │   └── internal/
    │       └── LinearDepthFirstTreeTraversalPolicyImpl.ts
    ├── root-workflow/
    │   ├── api/
    │   │   └── RootActionPolicyInterface.ts
    │   └── internal/
    │       ├── RootRunActionPolicyImpl.ts
    │       └── ExecuteRootActionUseCase.ts
    ├── performer-turns/
    │   ├── api/
    │   │   └── PerformerProcessInterface.ts
    │   └── internal/
    │       └── SubprocessPerformerProcessImpl.ts
    ├── performer-profiles/
    │   ├── api/
    │   │   ├── PerformerProfile.ts
    │   │   ├── CodexTurnSettings.ts
    │   │   ├── PerformerProfileStoreInterface.ts
    │   │   └── PerformerProfileControlInterface.ts
    │   └── internal/
    │       ├── FilePerformerProfileStoreImpl.ts
    │       ├── SubprocessPerformerProfileControlImpl.ts
    │       └── PerformerProfileProtocolHandlerImpl.ts
    ├── git-workspaces/
    │   ├── api/
    │   │   └── GitWorkspaceInterface.ts
    │   └── internal/
    │       └── NativeGitWorkspaceImpl.ts
    ├── root-delivery/
    │   ├── api/
    │   │   └── RootDeliveryInterface.ts
    │   └── internal/
    │       └── GitRootDeliveryImpl.ts
    ├── runtime-reporting/
    │   ├── api/
    │   │   └── ConductorRuntimeReporterInterface.ts
    │   └── internal/
    │       └── PodiumConductorRuntimeReporterImpl.ts
    └── private-ipc/
```

每个业务模块使用：

```text
<module>/
├── api/
├── internal/
└── tests/
```

`linear-gateway/internal/PodiumLinearGatewayClientImpl.ts`实现Conductor自己的
`LinearGatewayInterface`。Conductor没有数据库、通用`persistence/`、
`workflow-db/`或`operation-journal/`目录；Profile配置文件只由
`performer-profiles`模块读写。

Conductor data root中的Profile数据：

```text
performer-profiles/
├── profiles.json
└── <profile-id>/
    └── codex-home/    # Codex SDK owned
```

## 4. Performer

```text
apps/performer/
├── pyproject.toml
└── src/performer/
    ├── __main__.py
    ├── composition/
    ├── turn_protocol/
    ├── turn_runtime/
    ├── profile_control/
    ├── planning/
    ├── work_execution/
    ├── root_gate/
    ├── events/
    └── backends/
        ├── provider_backend_interface.py
        ├── registry.py
        └── codex/
            └── codex_backend_impl.py
```

Performer app提供Turn和Profile control两个process入口。Provider SDK只允许在对应
backend目录中导入。

## 5. Podium类库

```text
packages/podium/
└── src/
    ├── public/
    │   ├── PodiumDesktopInterface.ts
    │   ├── DesktopViewInterface.ts
    │   └── index.ts
    └── internal/
        ├── composition/
        │   └── PodiumDesktopImpl.ts
        ├── linear-auth/
        │   └── api/
        │       └── LinearInstallationStoreInterface.ts
        ├── project-catalog/
        ├── conductor-bindings/
        │   └── api/
        │       └── ConductorBindingStoreInterface.ts
        ├── linear-gateway/
        │   ├── api/
        │   │   └── LinearClientInterface.ts
        │   └── internal/
        │       ├── LinearSdkImpl.ts
        │       └── LinearGatewayProtocolHandlerImpl.ts
        ├── performer-profile-relay/
        │   ├── api/
        │   │   └── PerformerProfileRelayInterface.ts
        │   └── internal/
        │       └── ConductorPerformerProfileRelayImpl.ts
        ├── runtime-observations/
        │   └── api/
        │       └── RuntimeObservationStoreInterface.ts
        ├── desktop-views/
        │   └── internal/
        │       └── PodiumDesktopViewImpl.ts
        └── storage/
            └── SqlitePodiumStoreImpl.ts
```

只有`public/`进入package exports。

## 6. Contracts

```text
packages/contracts/
├── schemas/
│   ├── podium-client/
│   ├── desktop-host/
│   ├── podium-conductor/
│   └── conductor-performer/
├── generated/
│   ├── typescript/
│   ├── python/
│   └── rust/
├── fixtures/
└── tools/
    └── generate.ts
```

`schemas`是唯一手写wire source；generated code不包含业务Policy或Impl。

## 7. 依赖

```text
podium-desktop -> podium + contracts
conductor      -> contracts
performer      -> generated conductor-performer contracts

Podium -X-> Conductor implementation
Conductor -X-> Podium implementation
Conductor -X-> Performer implementation
Performer -X-> Linear
```

跨角色只通过Protocol交互。

## 8. 文档边界

本文只定义物理目录和依赖方向。模块职责与命名以后缀规范见
[代码模块与命名规范](code-organization.md)，跨进程字段见
[契约与接口边界](contracts.md)及其链接的具体Protocol文档。这里的目录树不是第二套
业务模块定义。

## 9. 不变量

1. Podium是可复用类库；Conductor和Performer是独立应用。
2. public Interface与internal Impl物理分离。
3. 一个功能模块只归一个角色。
4. Linear SDK只在Podium，Provider SDK只在Performer backend。
5. Conductor不包含工作流持久化。
6. 未来Podium Web是新app，不塞进Desktop目录。

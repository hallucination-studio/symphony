# Symphony目标架构总览

状态：目标架构提案。本文定义Linear-authoritative、Conductor无Workflow数据库的目标架构；不代表
当前实现已经匹配，也不包含迁移计划。

## 1. 核心结论

Symphony是一个产品，由Podium Desktop、Podium、Conductor和Performer四个职责组成：

```text
Podium Desktop
  -> Podium TypeScript library
     -> Linear OAuth / Token / Project catalog / Conductor Bindings
     -> LinearGatewayProtocolHandlerImpl -> LinearSdkImpl

Conductor TypeScript daemon
  -> resolve Project and read Linear through LinearGatewayInterface
  -> discover and schedule Root Issues
  -> RootWorkflowPolicyInterface derives one decision from fresh Cycle DAG/Git
  -> LinearDagExecutionInterface executes one ready Plan | Work | Verify Node
     -> create StageWire, call Performer and materialize accepted output
  -> one deterministic Git worktree and delivery per Root

Performer Python process
  -> ProviderBackendInterface -> CodexBackendImpl
  -> consume one closed StageContextEnvelope
  -> fresh isolated Provider context per Stage invocation
```

目标架构不变量：

- Linear custom status、Issue Tree和managed records就是Workflow authority，Git是code/delivery authority；
- Conductor不保存Workflow DB、Root Queue、DAG mirror、dispatch、gate或checkpoint；
- Root是跨Root调度单位；Cycle Issue是一轮DAG container；Plan、Work、Verify Nodes是Stage targets；
- Root、Cycle、Plan/Work/Verify使用同一Team workflow中kind-restricted的status子集；
- Cycle先创建Bootstrap Plan；引用approved Plan Contract的graph完整物化并read-back后才可调度；
- Cycle graph sealed且Plan approved后Work才ready；每个Root同时最多一个active Cycle；
- Finding、attempt、token reservation、progress和Human override持久化到Linear，Root级convergence gate机械执行；
- Conductor构造StageContextEnvelope并调用Performer；Performer不反向调用Conductor；
- Plan、每个Work和Verify使用隔离Provider context，不共享thread；
- 不设计sub-agents或独立memory；跨Stage连续性只从Linear/Git重建；
- Podium独占Linear OAuth、Token和SDK，Performer独占Provider SDK；
- cross-process communication使用closed versioned schemas和generated types。

## 2. 权威事实

| 事实 | 权威来源 | 解释者/执行者 |
|---|---|---|
| OAuth、Token、installation、Project catalog | `podium.db` | Podium |
| Conductor Identity、Binding、Repository Context | `podium.db` | Podium Desktop |
| Resolved Conductor Project | Linear Project上的Conductor Project Label | Conductor |
| Root ownership、fixed Profile、execution/convergence policy、delivery summary | Root managed comments | Conductor |
| Root/Cycle/Node status、Cycle Issues、typed DAG nodes、Stage execution、Plan Contract、Finding、token budget、Human action和Stage outcome | Linear Issue Tree、relations和comments | Conductor reconciles |
| Root/Tree order、Priority、blockers、Team workflow status catalog | Linear | Conductor |
| Profile定义和active Profile | Conductor `performer-profiles/profiles.json` | Conductor |
| Codex auth/session/config runtime | Profile独立`CODEX_HOME` | Codex SDK / Performer |
| branch、commits、diff、checks | Git | Conductor/Performer Work Stage |
| PR或branch delivery | Git/SCM和Root comment | Conductor |
| ordinary runtime progress、tool/process heartbeat | best-effort Event/Desktop | 不参与Workflow |
| Stage token reservation与validated usage settlement | Linear managed comments | Root convergence gate |

Conductor内存中的`RootDagView`、`RootDispatchAssessment`、process handle、Event和Result都
可以丢弃；下一轮重新读取Linear/Git。

## 3. Stage orchestration

Conductor Loop、Plan/Work/Verify的公共注入Envelope、三个context variants、tool capability、Result和Human
挂起恢复只由[Stage Context](stage-orchestration.md)定义。本文不重复该设计。

## 4. 多Root调度

Conductor每个周期全量发现绑定Project中的Root headers，但不读取所有active Root Trees：

```text
resolve Project
-> full-page delegated non-terminal Root headers
-> order by blockers, Linear Priority, Root order and identifier
-> lazily load and assess candidate Trees in that order
-> fresh-read the selected complete Root Tree and Git facts
-> derive one business decision and execute at most one ready typed node
-> read back and discard transient state
```

等待Human的Root释放lane；Priority/order变化在下一个Stage boundary生效。memory cache只减少Linear
读取，不能决定Stage、mutation或完成。

## 5. 进程与边界

```text
Podium Desktop / Podium / Conductor: TypeScript
Performer: Python
Desktop host: Tauri / Rust
Cross-process contracts: generated JSON Schema types
```

依赖规则：

- roles只依赖contracts/interfaces，不导入另一role实现；
- Conductor通过`LinearGatewayInterface`访问Linear；
- Conductor通过`PerformerStageClientInterface`创建StageWire并调用Performer；
- Performer只返回closed Event和一个terminal Result；
- Provider差异只在Performer `*BackendImpl`；
- secrets、SDK objects、process handles、raw metadata不跨public boundary。

## 6. 版本边界

| 版本 | 主题 | 边界 |
|---|---|---|
| V1 | 单Root完整闭环 | 一个Root、一个worktree、Plan/Work/Verify/Human/Delivery |
| V2 | 多Root稳定调度 | blocker、Priority、Root order和Human等待切换 |
| V3 | Stage Context与Runtime | closed injection envelope、isolated contexts和bounded runtime |

sub-agents、独立memory和Desktop多Root聚合展示不在当前版本边界内，也不为它们预建contract。

## 7. 文档导航

- [Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)：Loop、注入context、capability、Human action和Result。
- [Root Issue工作流](root-issue.md)：Linear Team status、分阶段Cycle graph、Finding、Human action和Delivery事实。
- [Linear端到端流转](linear-flow.md)：Project解析、Root发现、blocker、排序和SDK ownership。
- [Conductor](conductor.md)：无DB主循环、Root readiness、process和read-back。
- [Performer](performer.md)：Provider执行和Profile boundary。
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

命名、模块和字段的唯一事实源分别由上述named concern文档拥有；其他文档只做角色说明或总览。

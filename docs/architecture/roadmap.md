# Symphony架构实施Roadmap

状态：目标架构的实施顺序。本文定义可验收增量，不声明当前实现已经满足目标，也不建立旧架构兼容路径。

## 1. 实施原则

1. Linear Issue Tree始终是Workflow authority，Git始终是code/delivery authority。
2. 先固定closed contracts和单Root闭环，再接回已有多Root调度。
3. 每个增量必须能从fresh Linear/Git事实恢复，不能依赖Provider conversation、本地Queue或checkpoint。
4. 复用仍符合边界的基础设施；旧Conversation、Turn、Agent Command和Root Gate实现不翻译成新模型。
5. 新旧composition切换后立即删除旧路径，不保留compatibility shim或双写。
6. 每个任务先写失败测试，再实现最小行为，并在真实跨进程或Linear边界补充证据。

## 2. 当前基线处理

| 处理 | 当前能力 | 目标 |
|---|---|---|
| 复用 | Podium Linear OAuth、SDK、private IPC和Binding | 扩展为closed status catalog、Root Tree和mutation DTO |
| 复用 | Root discovery、Priority/blocker scheduling | 在单Root闭环完成后接入新的RootWorkflow decision |
| 复用 | Git worktree、commit和delivery | 继续保持一个Root一个worktree，由Conductor拥有Git topology |
| 复用 | Performer Profile control和runtime reporting | Stage使用同一Profile边界，但每次调用创建fresh Provider context |
| 替换 | Root Conversation、Root Turn和Agent Command Broker | 一个caller-owned、一次性Plan/Work/Verify Stage Wire |
| 替换 | Work/Human/Root Gate child模型 | Root -> Cycle -> Bootstrap Plan -> sealed Work/Verify DAG |
| 替换 | 本地retry/conversation lifecycle状态 | Linear managed execution、Finding disposition和Root convergence records |
| 延期 | sub-agents、跨Stage memory、Desktop多Root图、parallel Work、第二Provider | 不进入当前contract |

## 3. R0：Contract与权威数据

完成边界：

- `podium-conductor`提供closed workflow status catalog、Root header、完整Root Tree和受限mutation；
- `conductor-performer`中的target定义只包含`StageContextEnvelope`、`StageEvent`和`StageResult`；
- Conductor拥有closed managed-record codecs，能够从Linear records重建Root workflow facts；
- generated TypeScript、Python和Rust types以及cross-language fixtures一致。

R0不实现业务推进，但禁止在新contract中出现Conversation、Turn、Agent Command、semantic fingerprint或任意metadata。
旧wire在R4 composition切换前冻结，不增加adapter、双写或新consumer；切换后从current schema和generated types删除。

## 4. R1：Bootstrap Plan与sealed DAG

完成边界：

```text
Root In Progress
-> Cycle Draft + Bootstrap Plan Todo
-> Cycle Planning + fresh Plan Stage
-> Plan Contract In Review + Root Needs Approval
-> Human approval read-back
-> Work/Verify Nodes和blockedBy relations完整物化
-> matching plan_contract_digest read-back
-> Plan Done + Cycle Sealed
```

partial Linear mutation必须停留在`Planning`并在下一次reconciliation补齐或fail closed；`Sealed`前没有Work或
Verify可以dispatch。

## 5. R2：单Cycle Work与Verify

完成边界：

- Work只获得当前Node、必要Root boundary、dependency completion和read-write workspace；
- Conductor验证diff、scope和checks后commit，并写matching completion evidence；
- Verify针对immutable Git revision运行，获得approved Plan、Work evidence、prior Findings和required checks；
- passed Verify使Cycle `Succeeded`，structured Finding使Cycle进入受Root convergence gate约束的结论；
- Performer不调用Linear、不commit、不delivery，也不选择下一Stage。

## 6. R3：Repair、熔断与恢复

完成边界：

- Conductor为accepted Finding分配`finding_id`，后续Verify逐一返回exact disposition；
- repair grouping按dependency、affected scope和共同acceptance criteria形成successor Cycle；
- Root级机械执行cycle、open Finding persistence、no-progress、token、deadline和cancel gates；
- crash、stale Result、Human suspension、partial mutation和restart都从Linear/Git重建；
- cost仅作为telemetry，不进入当前Workflow gate。

## 7. R4：Delivery、调度与旧路径移除

完成边界：

- passed Cycle和matching verified HEAD通过fresh precondition后交付PR、remote branch或local branch；
- Root进入`In Review`，而不是由Symphony自动置`Done`；
- 已有Root discovery、blocker、Priority和Root order调度接入新的RootWorkflow decision；
- waiting Human的Root释放execution lane；
- Conductor和Performer的Conversation、Turn、Agent Command、Root Gate旧代码与schemas全部删除。

Desktop仍只需要显示当前Root和`Open in Linear`；多Root产品展示不属于本增量。

## 8. R5：真实边界验收

最终验收必须证明：

1. Podium通过真实Linear SDK读取status catalog、Root Tree并执行带precondition的mutation。
2. Conductor通过真实短进程Stage Wire调用Performer，Plan、Work、Verify均使用fresh Provider context。
3. 一个Root完成initial Cycle；一个Finding场景完成repair Cycle或机械升级。
4. process restart后只靠Linear/Git恢复，并拒绝旧execution Result。
5. delivery read-back与Root `In Review`一致。
6. 多Root调度只改变选择顺序，不改变Stage contract或引入Queue。

## 9. 明确延期

当前不设计：

- sub-agents、maker/checker或Stage内部fan-out；
- Provider memory、跨Stage transcript、vector store或conversation resume；
- Desktop多Root列表、聚合Workflow图和并行进度；
- parallel Work、同一Root多个writer和remote Performer；
- 第二Provider；
- authoritative monetary cost gate、pricing snapshot或cost reservation。

这些能力若被授权，必须先说明如何保持Linear/Git authority，再扩展对应事实源；不能在当前schema中预留future
variant或任意metadata。

## 10. 完成标准

Roadmap完成要求：

- 本文R0-R5的完成边界全部满足，并通过对应implementation checkpoint；
- target contracts没有旧variant，architecture guards拒绝旧模块和词汇重新出现；
- build、lint、typecheck、contracts、unit、integration和real-boundary checks全部通过；
- 所有影响恢复和下一Stage选择的事实都可从Linear/Git重建；
- Human审阅并批准最终实现。

# Symphony架构Roadmap与版本边界

状态：目标版本边界。本文描述五个大版本如何扩大能力，不包含日期、人员、迁移步骤或当前代码
实施计划。

## 1. Roadmap原则

1. 每个版本都形成Podium Desktop、Linear、Conductor、Performer和Git的完整纵向闭环。
2. Linear始终是Workflow authority，Git始终是code/delivery authority。
3. Root始终是顶层调度和恢复边界；后续版本不能退回Leaf Queue或Stage state machine。
4. Interface只为已授权能力建立，不为未来版本预建空表、空状态或不可达分支。
5. Conductor所有版本都没有Workflow、Queue、dispatch、attempt或checkpoint数据库。

## 2. 五个大版本

| 版本 | 主题 | 完成边界 |
|---|---|---|
| V1 | 单Root完整闭环 | 一个Root、一个worktree、一个Codex Conversation、Plan/Human/Work/Root Gate/Delivery和重启恢复 |
| V2 | 多Root稳定调度 | blocker、Linear Priority、Root order、等待Human时切换Root和用户Tree调整 |
| V3 | Agent Symphony Harness与Runtime硬化 | Root作为唯一dispatch/Conversation/retry单元；Agent以closed commands推进Linear/Git |
| V4 | Agent Cluster | 一个已调度Root内的trusted roles、bounded child Turns、fresh review和capacity |
| V5 | 多Provider Performer | 更多Provider Backend复用同一个RootTurn、Harness和Root retry contract |

V5只说明架构允许Provider扩展，不代表当前已授权具体第二Provider。

## 3. V1：单Root完整闭环

V1证明最小产品闭环：

```text
Podium Desktop connects Linear
-> bind Project + repository + base branch
-> claim one Root
-> pin one ready Codex Profile and Conversation
-> create one deterministic worktree
-> Plan + Plan Approval child
-> ordered Work/Human children
-> Root Gate and Rework
-> PR or branch delivery
-> Root In Review
```

V1要求Linear Token只在Podium、Provider SDK只在Performer、Conductor无数据库、Root restart后复用
同一Tree/branch/worktree/Conversation。它不包含多Root fairness、并行Agent或第二Provider。

V1恢复保证process crash、Turn interruption、部分Git修改、commit/Linear写入中断和delivery重入都可从
Linear/Git收敛；它不保证旧Provider call跨process继续运行，也不保证磁盘故障后未落盘修改。

## 4. V2：多Root稳定调度

V2增加：

- 一个Conductor Binding发现多个delegated Roots；
- Linear blocker优先于Priority；
- runnable Roots按Priority、Root order、identifier排序；
- waiting Human的Root释放唯一Agent lane；
- Root headers全量发现，按Priority/order懒加载候选Tree，dispatch前完整fresh read；
- dependency cycle、ownership和Tree冲突人类可见。

V2仍然不增加FIFO、aging、ready sequence、Leaf Queue、checkpoint或dispatch table。

## 5. V3：Agent Symphony Harness

V3不是给旧状态机改名。它删除Conductor对Plan、Leaf Work、Human、Root Gate和Delivery的closed
transition/directive控制面，把这些行为放进一个Root-scoped Agent Harness：

```text
read Linear/Git
-> assess runnable Roots
-> schedule one Root
-> start/resume its Conversation
-> run one bounded RootTurn with scoped commands
-> read back Linear/Git
-> discard transient runtime objects
```

### 5.1 Root单位

- Root是唯一dispatch target；Performer contract没有`work_issue_id`/`target_issue_id`；
- Root最多一个current `performer_id`和一个worktree；
- Leaf只是Linear Tree中的工作结构；
- Conductor不保存current Leaf、Leaf attempt或Leaf recovery checkpoint；
- Plan/Work/Human/Gate/Delivery全部通过Linear/Git事实可见。

### 5.2 Conversation retry

正常crash/timeout resume同一Conversation。Provider明确报告Conversation不存在或不可恢复时：

- 取消旧Turn并终止process tree；
- 保留全部Tree、comments、states、commits和worktree diff；
- 使用固定Profile创建新Conversation；
- compare-and-set Root current pointer；
- 把整个Root重新放回Root scheduler；
- 新Conversation先审计完整Root，不接收Leaf recovery prompt。

Root retry不清空事实、不reset worktree、不恢复attempt，也不把旧Result作为checkpoint。

### 5.3 Harness能力

V3增加：

- trusted harness / untrusted human context / executable commands分层；
- bounded context和显式partial/truncation；
- Profile-owned Provider-native sandbox mode和有界command allowlist/denylist；
- context launch limit、whole-Turn wall deadline、broker/mutation command limits；
- Provider token只在完整Turn结束后观察和记账；
- typed command registry和closed Linear/Git/delivery broker；
- stable write ID、semantic read-back和ambiguous-write handling；
- stale Result、old Conversation和late command rejection；
- process readiness、complete-Turn accounting、heartbeat、cancellation和child-process cleanup；
- Linear/Desktop上的脱敏、人可执行错误。

这些机制参考Orca，但不复制其task DAG、orchestration DB、dispatch rows、mailbox或failure counter。

### 5.4 V3明确不做

- Agent roles、child Turn broker、fan-out/fan-in或多Agent并发；
- 第二Provider Backend；
- Workflow/Root/Leaf/dispatch/attempt/checkpoint数据库；
- per-Agent worktree、多writer、自动merge；
- Provider transcript或raw reasoning持久化。

### 5.5 V3验收

1. Root是唯一调度、Conversation和retry单元。
2. Performer只有Root-scoped业务Turn。
3. current Conversation先写Linear并read-back，再启动业务Root Turn。
4. Conversation loss替换ID并重新调度整个Root，保留Linear/Git事实。
5. 旧Conversation和旧Result不能在retry后继续写。
6. Leaf没有dispatch、Conversation、worktree、cursor、attempt或recovery checkpoint。
7. Agent所有durable结论通过closed commands落到Linear/Git。
8. Result/Event/process exit不决定业务完成。
9. Root discovery只读取bounded headers/Primary Comments；完整Issue Tree只为按序评估的候选和dispatch前
   fresh read加载，不得对每个header串行执行`GetIssueTreeQuery`。
10. V3没有Agent Cluster或第二Provider。

## 6. V4：Agent Cluster

V4只在一个已由V3调度的Root内部扩展协作：

- coordinator、planner、writer、reviewer是trusted Turn roles，不是Issue states；
- coordinator可请求bounded child Turns；
- analysis可fan-out，所有participant计入真实capacity；
- 同一Root worktree同时最多一个writer；
- reviewer使用fresh Conversation且不修改workspace；
- child dispatch、fan-in和session全部transient；
- Cluster crash或coordinator Conversation loss走Root-level retry，从Linear/Git重启整个Root Cluster。

V4不增加task/dispatch DB、mailbox、Stage checkpoint、per-Agent delivery或第二Provider。

## 7. V5：多Provider Performer

当第二Provider被明确授权时：

- 只在Performer内部新增`ProviderBackendInterface`实现；
- Profile选择已注册Backend；
- Backend实现相同Conversation bootstrap、`RootTurnCommand`和Result/Event；
- Backend必须明确区分Conversation unavailable与transient failure；
- Conversation loss仍触发相同Root-level retry；
- Linear、Harness、Cluster、Git和Root scheduling不增加Provider-specific分支。

无法满足closed RootTurn和Root-level retry的Provider不接入，而不是为它增加
Conductor state或Leaf checkpoint。

## 8. 不变量

1. V1闭合单Root，V2扩大到多Root，V3校正为Root-level Agent Harness。
2. V4只扩展Root内部Agent协作，V5只扩展Provider Backend。
3. Linear/Git是所有版本唯一durable Workflow/code authority。
4. Root始终是顶层调度和retry authority。
5. 后续版本不能重新引入Workflow DB、Leaf Queue、Stage checkpoint或mirrored Issue state。

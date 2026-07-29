# Conductor

状态：Phase 1 目标设计。Conductor 是静态、机械、串行的状态机。

## 职责

Conductor 负责：

- 发现 Root，重新读取 Linear / Git，并计算内存 diff。
- 串行选择 Root；任意时刻最多执行一个 Root。
- 创建、暂停、恢复和回收每个 Root 的独立 runtime。
- 向 `RootReconcill` 提供 `plan | work | verify` tools，并校验调用目标和前置条件。
- 调用 Performer、校验 Handoff，然后重新读取实际结果。
- 机械执行 Cycle create/close、worktree、commit、push、PR 和 Root `In Review` transition。

Conductor 不理解需求，不生成 Plan，不写代码，不判断 Verify 结论，也不根据 Handoff 补写事实。所有语义决策属于 `RootReconcill`。

## 状态机

```text
discover
-> admit_root
-> observe
-> reconcile
-> apply_mechanical_action
-> observe | suspend_in_review | stop

suspend_in_review -> discover
fresh_done -> retire_root -> discover
```

状态与 transition 是 closed union。执行任何 action 前，Conductor 都重新读取并校验前置条件；不匹配时不执行，而是把新的实际 diff 交回对应 `RootReconcill`。

## Discovery, admission, and configuration

Root discovery 只查询配置的单一 Linear workspace/team 中带
`symphony:kind/root`、状态为 `Todo | In Progress | In Review | Done` 的 Issue。
Conductor 按 `(priority, created_at, issue_id)` 的稳定顺序扫描，但任意时刻只 admit 一个
可执行 Root。`In Review` 只保留/检查 runtime，`Done` 只触发匹配 runtime 回收，不进入
执行槽。

Root 只有同时满足以下 fresh facts 才可 admit：kind label 唯一且正确；没有超过一个
active Cycle；repository identity 和 base branch 能从启动时的静态 Root routing 配置
唯一解析；该 repository/base branch 可读；不存在已被另一个 Root 占用的 head branch
或 worktree。缺失、重复或冲突都 fail closed，并记录 sanitized 可操作原因。

Phase 1 启动配置只包含 Linear workspace/team、Root-to-repository routing、每个 repository
的 base branch、program-data path、Performer Home、Codex executable 和 delivery provider
endpoint。配置在进程启动时完成解析和验证，运行中不从 Profile、Podium、Issue
description 或任意 metadata 推导或覆盖。一个 Root 必须精确匹配一条 routing rule。

## Per-Root runtime

每个 Root 独占：

```text
RootReconcill object
private CodexReconcill
app-server process
Root thread
accepted observation baseline
Root Home
```

Root Home 位于：

```text
<program-data>/root-reconcills/<root-id>/
  symphony/state.json
```

`state.json` 只保存恢复 Root thread 所需的最小 continuity，例如 Root identity、runtime generation、thread identity、accepted observation digest 和 in-flight correlation。它不保存 Stage、DAG、下一步动作、Handoff 或 Linear / Git 镜像，也不使用 workflow SQLite。

Root 进入 `In Review` 后暂停但保留 runtime。Linear 确认 `Done` 后，Conductor 停止对应 process 和 turn，隔离 tools 与迟到输出，验证 Home owner，再销毁对象并删除整个对应 Root Home。这些资源不得跨 Root 共享或复用。

## 观察与重启

同一进程、同一 runtime generation 的连续 turn 只发送相邻两个已接受 observation 之间
的 frozen in-memory diff。digest 仅校验这条连续链，不能重建旧 observation。

进程启动或 Root runtime 丢失内存 baseline 后只允许一个 primary restart transition：

1. 读取并验证 `state.json` identity；取消/隔离其中的 in-flight correlation，旧输出永不接受。
2. fresh read 完整 Linear / Git facts；若 worktree ownership、branch、HEAD、active Cycle 或
   PR identity 不唯一，保留现有事实并 fail closed。
3. 创建递增的 `runtime_generation` 和全新 Root thread，atomic replace `state.json`，向
   新 thread 发送当前完整 `RootBootstrap`。
4. 新 thread 接受 bootstrap 后，以当前 observation digest 建立唯一 baseline；此后才可
   产生 action 和相邻 diff。

旧 thread 不恢复、不继续，也不作为第二执行路径。旧 command、Handoff、transcript、
digest 或 session content 均不 replay；外部 facts 在停机期间是否变化不影响这条规则。
完整 bootstrap 是 restart 的正式输入，不是 fallback。任何一步无法证明安全都停止推进，
并给出 sanitized 可检查原因。

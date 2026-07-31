# Root Issue 模型

状态：Phase 1 目标设计。本文只定义 Task Manager 中持久化的 Symphony 工作流事实。Root Reconcill 只写 Cycle 边界事实；Conductor 只写 approved Cycle 的机械执行事实。

## 结构

```text
Root Issue (one description Markdown)
├── Requirement / Domain Knowledge / Root ADR / Acceptance sections
├── Cycle Issue 1 (Draft, executing, awaiting acceptance, or terminal)
│   ├── Plan Issue
│   ├── Work Issue 1
│   ├── Work Issue 2
│   └── Verify Issue
└── Cycle Issue 2 (successor, only after Cycle 1 is terminal)
```

Root 是用户完整需求和最终 PR 的单位。Cycle 是按一个 frozen design 完成该需求的一次尝试。Plan、Work、Verify 是该 Cycle 的执行记录，并使用：

```text
symphony:kind/root
symphony:kind/cycle
symphony:kind/plan
symphony:kind/work
symphony:kind/verify
```

Task Manager 原生 Issue identity 是唯一标识。Root description 是一个带 closed named sections 的 Markdown document；Root ADR 是其中的显式 section，不是第二个 provider field 或 hidden payload。Root description、Root ADR、Cycle description、Stage description 和所有 handoff 都必须是 bounded Markdown；不得保存 hidden Symphony JSON、model transcript、provider receipt、correlation、credential 或 runtime state。

## Define 和 Root ADR

delegated Root 首先处于 Define。Root Reconcill 对用户代码目录只有 read-only capability，可以读取和搜索代码，但不能修改文件。Define 必须在同一个 Root description Markdown 中形成完整 Requirement、Domain Knowledge、Root ADR 和 Acceptance sections；Root ADR section 记录跨全部 Cycles 通用的架构决策、约束与后果。

Root ADR 是 Root 的共享知识，但不是活动 Cycle 的可变输入。创建 Cycle Draft 时，Root Reconcill 必须把本次适用的完整需求、ADR 内容与版本、功能设计、架构设计、代码设计和验收映射写入 Cycle description Markdown。Cycle 因而持有本次尝试可独立审查的完整 decision snapshot；Plan 和 restart 都不能改读较新的 Root 内容来改变该 snapshot。

Root requirement 或 ADR 后续变化只影响未来 Cycle。若已有 approved Cycle，该 Cycle 继续使用自己的 frozen snapshot；需要采用新决策时，必须先让旧 Cycle terminal，再创建 successor。

## Lifecycle facts

```text
Root:  Todo -> In Progress -> In Review -> Done
Cycle: Draft -> In Progress -> Awaiting Acceptance -> Succeeded | Rejected
       Draft | In Progress | Awaiting Acceptance -> Failed | Canceled
Stage: Todo -> In Progress -> Done | Failed | Canceled
```

- `Draft` 是尚未批准的 proposal；Root Reconcill 可以在 review 期间修正其 Markdown description。
- 从 `Draft` 到 `In Progress` 是 seal 和一次性执行授权。进入 `In Progress` 后，Cycle 的规格事实不可变。
- `Awaiting Acceptance` 表示 Plan、全部 Work、exact commit 和 fresh Verify 已机械完成，但尚未经过 Root semantic acceptance。
- `Succeeded | Rejected | Failed | Canceled` 是 terminal Cycle；terminal Cycle 保留为历史事实，不 reopen。
- `Done | Failed | Canceled` Stage 不 reopen。任何重试都在 successor Cycle 中获得新 Stage identity。
- 一个 Root 任意时刻最多有一个 non-terminal Cycle，包括 `Draft | In Progress | Awaiting Acceptance`。
- Root 只有在 accepted exact revision 已交付并 fresh read-back 后才能进入 `In Review`。
- Root `Done` 只由用户或外部流程设置；Symphony 不自动 merge 或设置 `Done`。

状态、identity、revision、parent 和 relation 是结构化 Task Manager facts。Conductor 不从 Markdown 文本猜测状态；Root Reconcill 和 Conductor 都通过 exact provider state identity、fresh precondition 和 read-back 执行各自被授权的 transition。

上述 semantic state 在启动时通过 `list_states` 解析为唯一 provider identity。任一 required state 缺失、重复或归类不符都 fail closed；状态名本身不能被当作 provider identity。

## Cycle review 和 seal

Root Reconcill 创建 Cycle Draft 后必须 review：确认 Cycle description 已包含完整需求 snapshot、适用 Root ADR snapshot、明确功能与代码设计、边界、验收标准和失败策略。该 review 是语义批准与 seal，不宣称是独立 adversarial review。

review 通过后，Root Reconcill 以 fresh revision 把 Cycle 设为 `In Progress`。这一个 transition 同时授权 Conductor 执行整个 Cycle。Root Reconcill 此后不得修改 Cycle/Stage description、调用 Performer、增删 Stage 或改变 relation；外部对 sealed 规格或执行图的修改是 invariant violation，不会被吸收到当前尝试。

## Plan 和 sealed execution graph

Conductor 在 approved Cycle 上首先创建并运行恰好一个 Plan Issue。Plan 只把已经批准的设计分解为 executable Work Items、dependency DAG 和 Verify intent，不得新增或修改 architecture、feature 或 code design。

Plan `completed` 只有在 closed validation 同时证明以下条件后才算通过：

1. 每个 Work 和 Verify description 都是 bounded Markdown。
2. Work key 唯一、DAG 完整且无环，Verify 依赖全部 required Work。
3. 每项 Cycle acceptance criterion 都映射到 Work 或 Verify evidence。
4. 结果没有新增 decision、Task Manager identity、credential 或任意 metadata。

通过后，Conductor 根据 typed Plan result 一次性物化全部 Work/Verify Issues 与 relations，并立即 seal execution graph。物化后不得新增、删除、archive、reparent 或改写 description/relation；只能按状态机更新 status 和追加外部执行事实。partial、重复、歧义或被外部修改的 graph 无法修补，当前 Cycle terminally fails。

required Work 是 sealed graph 中全部且仅有的、parent 直接指向该 Cycle、kind 为 `symphony:kind/work` 且 identity 唯一的 Work Issues。Conductor按稳定拓扑顺序机械判断 readiness，并在一个 Cycle-bound Work thread 中以独立 turns 串行执行。

全部 Work `Done` 后，Conductor fresh read worktree、创建 immutable commit，并用一个 fresh isolated Verify context 检查 exact revision。`passed` 进入 `Awaiting Acceptance`；`failed | inconclusive` 或任何无法唯一确认的执行事实使 Cycle 进入 `Failed`。

## Acceptance 和 successor

`Awaiting Acceptance` 时，Root Reconcill 对用户代码仍只有 read-only capability。它根据 sealed Cycle description、Root ADR snapshot、exact diff/revision 和 Verify evidence进行语义验收：

- 接受：把 Cycle 设为 `Succeeded`，授权 exact revision 交付。
- 拒绝：把 Cycle 设为 `Rejected`，记录 sanitized Markdown reason。
- 无法确认：不猜测接受；保留可见状态或终止为 `Rejected`。

需要修复、重规划或采用新需求时，只能在 predecessor fresh read 为 terminal 后创建新 Cycle identity。successor 可以引用 predecessor，但不得修改、复制续跑或 reopen 旧 execution graph。

## Fact authority

Task Manager 的 Markdown descriptions、Issue identity/revision/status/parent/labels/relations 是需求和执行事实；Git 的 worktree、diff、commit、remote ref 和 PR 是交付事实。Performer result 只有被 Conductor 通过 typed validation 并 fresh materialization/read-back 接受后，才会形成对应 Task/Git facts。

model transcript、raw Plan result、MCP receipt、polling cursor/event 和 in-memory diff 都不是持久事实。任何外部变化由下一次 scheduled fresh poll 观察；sealed Cycle 只按 frozen snapshot 推进，不把后到变化隐式合并进当前尝试。

# Root Reconciliation

状态：Phase 1 目标设计。每个 eligible Root Issue 对应一个独立 ReAct `RootReconcill`。它只在 Define、Cycle approval 和 exact-revision acceptance 边界做语义决策，不驱动 Cycle 内部执行。

## 边界和权限

Root identity 在实例创建时绑定。一个实例只处理一个 Root，并独占 private Codex app-server process、thread、accepted observation baseline 和 Root Home；这些资源不能 rebind、share、pool、fork 或跨 Root 复用。

Root Reconcill 对用户代码目录始终只读。它可以在 Define 和 acceptance 中读取、搜索、比较非敏感代码与 exact diff，但不能读取 `.env*`、private key、credential store 或 remote credential configuration，不能创建、修改、删除代码文件，不能运行带写效果的 shell，也不能借 Git/Performer capability 间接修改 worktree。Root Home 是它唯一的本地 writable directory。

## Semantic boundary loop

```text
Observe: complete RootBootstrap 或 fresh Root/Git facts
Reason:  Define、review、approve、accept、reject、deliver 或创建 successor
Act:     一个 boundary-scoped generic Task/Delivery call
Observe: typed result 与 fresh read-back
...直到 quiescent、stopped、timed_out 或 canceled
```

Root Reconcill 只在 Cycle 边界运行语义 loop。Cycle 为 `In Progress` 时，它不选择 ready Work、不调用 Stage、不修改执行图，Conductor 依据 sealed facts机械推进。

## Define

没有 non-terminal Cycle 时，Root Reconcill先完成 Define：

1. 只读检查用户代码、现有架构和必要领域信息。
2. 把完整需求、范围、领域知识和验收标准写入 Root description Markdown 的 closed named sections。
3. 把跨 Cycles 通用的架构决策、约束与后果写入同一 document 的 Root ADR Markdown section。
4. 创建 Cycle Draft，在其 description Markdown 中冻结本次 requirement/ADR snapshot，并补全架构、功能、代码设计与验收映射。

transcript、搜索结果和临时推理不是事实；只有 fresh Task Manager read-back 的 Markdown 和结构化 Issue facts 是后续输入。

## Cycle approval

Root Reconcill review Cycle Draft 的完整性与一致性，可以在 Draft 期间修正 description。review 通过后，它以 fresh revision 把 Cycle 改为 `In Progress`；该 transition 是 seal，也是授权 Conductor 完整执行本次尝试的唯一批准。

批准后 Root Reconcill 不得调用 Plan、Work 或 Verify Performer，不得更新 sealed Cycle/Stage description，不得增加、删除或重连 Work/Verify。Root requirement 或 ADR 的新变化不会进入当前 Cycle；需要采用时，只能在当前 Cycle terminal 后创建 successor。

## Acceptance

Cycle 到达 `Awaiting Acceptance` 后，Root Reconcill获得 sealed Cycle Markdown、exact revision/diff 和 Verify evidence 的 read-only view。它必须逐项对照需求、ADR、功能/代码设计和验收映射：

| 结果 | 唯一动作 |
|---|---|
| 满足 sealed design | fresh update Cycle 为 `Succeeded`，授权 exact revision 交付 |
| 不满足或需求已变化 | fresh update Cycle 为 `Rejected`，写 bounded Markdown reason |
| 证据不完整或 identity/revision 冲突 | 不接受，fresh read 后重新验收或 fail closed |

Root Reconcill 对自己创建的 Draft 所做 review 是 approval/seal gate，不宣称独立审查。独立执行证据来自 fresh Verify context，最终语义责任仍在 Root Reconcill。

## Successor

只有 `Succeeded | Rejected | Failed | Canceled` predecessor 才允许 successor。Root Reconcill先 fresh read 确认 terminal identity，然后重新 Define 必要变化并创建新 Cycle Draft。successor 可以复用 Root-scoped domain knowledge 和 ADR，但必须冻结自己的完整 Markdown snapshot，并使用全新 Plan/Work/Verify contexts。

当前 Cycle 不能被修补、reopen、复制 thread 或继续旧 turn。外部对 sealed facts 的修改由 Conductor作为 invariant violation 处理，不交给 Root 在 Cycle 中选择适配。

## Tool surface

Root thread 只获得：

- [Task Manager generic functions](task-management.md#generic-functions)，并按 Define/Draft/Acceptance boundary 限制 mutation capability。
- 用户代码和 exact revision 的 read-only inspection capability。
- accepted exact revision 所需的 provider-neutral Delivery capability。

Root thread 不获得 Plan/Work/Verify calls、Linear 原生 skill、provider SDK、writable shell、worktree write、commit capability、credential 或未声明内部函数。它不返回让 Conductor解释的 `RootDecision` enum；语义决定通过 exact Task status/description mutation 表达。

## Conflict handling

fresh precondition失败表示 Root 推理后外部事实又变化。tool 返回 `precondition_failed` 和新的 concrete facts，Root Reconcill重新 Observe/Reason；这不是 runtime restart，也不授权修改 active Cycle。`acceptance_unknown` 必须先对同一 identity fresh read，不能直接重复写入。

每轮有明确 tool/时间预算。预算耗尽、连续无法形成完整 snapshot 或 capability/schema 违规时 fail closed，并把 Root 保留在实际外部状态；不得进入隐藏 retry loop。

# Git Worktree and Delivery

状态：Phase 1 目标设计。本文定义 Conductor mechanical Cycle 和 Root acceptance boundary 使用的 provider-neutral Git/Delivery operations，以及从 Work 修改到 exact-revision PR 的事实边界。

## Generic tools

Git 与 Delivery surface 只暴露资源级 functions：

```text
get_workspace
prepare_worktree
get_status
get_diff
create_commit
get_remote_ref
push_revision
list_pull_requests
create_pull_request
get_pull_request
```

这些 functions 不包含 “complete Work”“accept Cycle” 或 “move In Review”等语义命令。Conductor Cycle machine按 sealed graph 调用 Git operations；Root Reconcill在 acceptance 后只授权 exact revision 的 Delivery operations。每个 call 都校验 ownership、capability、revision/precondition并 fresh read-back。

## Worktree authority

每个 Root 使用独立 deterministic branch 和 canonical worktree，不同 Root 不得共享。权限固定为：

- Root Reconcill 对用户 repository、worktree 和 exact revision 始终 read-only。
- Plan 不挂载用户代码。
- 当前 Cycle 的 Work Performer 对唯一 Root worktree read/write。
- Verify 对 exact-revision worktree read-only，只能写 process-owned scratch。
- Conductor只能通过 `GitWorkspaceInterface` 执行 prepared worktree、read、commit 等 typed operations，不向模型暴露 shell。

worktree missing、path/owner conflict、unexpected dirty state 或 branch mismatch 返回 fresh Git facts并 fail closed。Phase 1不自动 reset、clean、repair 或切换 alternate worktree。

## Commit and Verify

sealed graph 的全部 required Work `Done` 后，Conductor mechanical Cycle machine：

1. fresh `get_status`/`get_diff`，确认 HEAD、worktree ownership 和 sealed Cycle correlation。
2. 以 exact diff digest 调用 `create_commit`，fresh read-back immutable revision。
3. 创建 fresh isolated Verify context，只读检查该 exact revision。
4. Verify 后再次确认 HEAD、diff 和 revision 未变化。
5. `passed` 时把 Cycle 置为 `Awaiting Acceptance`；`failed | inconclusive` 或 mismatch 时置为 `Failed`。

Verify 检查的 revision、Root Reconcill验收的 revision、push 的 revision、remote ref 和 PR head 必须相同。任何 mismatch 都是可见 terminal 或 delivery conflict；不得验证一个 revision 后交付另一个 revision。

## Acceptance and delivery

Root Reconcill 在 `Awaiting Acceptance` 对 sealed Cycle design 和 exact revision 做 code-read-only semantic review。接受时把 Cycle fresh update 为 `Succeeded`；拒绝时为 `Rejected`。Cycle terminal 后不 reopen，不在同一 worktree turn 中修复。

`Succeeded` 是 exact revision 的交付授权。Root Reconcill只能指定该 accepted revision 和 closed PR identity；Conductor执行：

```text
push_revision
-> fresh get_remote_ref
-> list/get or create one exact pull request
-> fresh get_pull_request
-> generic Task Manager update_issue(Root, In Review)
```

Symphony不自动 merge，也不自动将 Root 设为 `Done`。delivery失败不改变 accepted revision，不 force-push、不回退到其他 commit，也不重开 Cycle。

## PR identity and conflicts

每个 Root 的 delivery identity 是 closed tuple：

```text
(provider, repository_id, base_branch, head_branch)
head_branch = symphony/root-<normalized-task-root-id>
```

Root identity normalization 必须 injective、deterministic 且仅生成 provider 允许的 ref characters。PR title、body、URL 或 description 不参与 identity matching。相同 identity 的重复 call 只能读取/确认同一个 open PR，不能创建第二个。

| Fresh read result | Tool result |
|---|---|
| remote ref 不存在，matching open PR 为 0 | 可按 accepted exact revision push/create，再 read-back |
| remote ref 等于 exact revision，matching open PR 为 0 | 可创建一个 PR，再 read-back |
| remote ref 和唯一 open PR head 都等于 exact revision | 返回 existing exact match |
| remote ref 指向其他 revision | `precondition_failed`；不 force-push |
| matching open PR 多于 1 | fail closed；不选择或关闭 PR |
| matching PR identity 不符或 closed/merged | fail closed；不 reopen、不创建 replacement |
| mutation `acceptance_unknown` | fresh read 同一 identity；仅 exact match 时接受 |

任何 mutation 后都重新读取 remote ref 与 PR。Phase 1 不提供 fallback provider、alternate branch、force push、自动 conflict repair、compatibility adapter 或 migration path。

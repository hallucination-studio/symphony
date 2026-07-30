# Git Worktree and Delivery

状态：Phase 1 目标设计。本文定义 Root Reconcill 可调用的 provider-neutral Git/Delivery tools，以及从 Work 修改到 exact-revision PR 的事实边界。

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

这些 functions 不包含 “complete Work”“deliver Root” 或 “move In Review”等 Symphony 领域语义。Root Reconcill 根据 fresh Task/Git facts 决定 exact call；Conductor 校验 ownership、capability、revision/precondition，执行 command/provider boundary 并 fresh read-back。

## Worktree

每个 Root 使用独立 deterministic branch 和 worktree，不同 Root 不得共享。Work turn 期间只有对应 Work Performer 可以写代码。Plan 和 Verify 只读；Root Reconcill 不获得 shell，只能调用 declared generic Git functions。

worktree missing、path/owner conflict、unexpected dirty state 或 branch mismatch 返回 fresh Git facts 并 fail closed。Phase 1 不自动 reset、clean、repair 或切换 alternate worktree。

## Commit and Verify

Root Reconcill fresh read 确认全部 required Work `Done` 后：

1. 调用 `get_status`/`get_diff` 获取 exact current facts。
2. 调用 `create_commit` 并 read-back immutable revision。
3. 调用 Verify Performer 检查该 exact revision。
4. Verify 返回后再次确认 HEAD、diff 和 revision 未变化。

Verify 检查的 revision、push 的 revision、remote ref 和 PR head 必须相同。任何 mismatch 都作为 fresh fact 返回 Root Reconcill；Conductor 不替它选择重新 Plan、修复或交付其他 revision。

## Delivery

Verify `passed` 后，Root Reconcill 通过 generic tools 指定 exact revision 和 PR identity：

```text
push_revision
-> fresh get_remote_ref
-> list/get or create one exact pull request
-> fresh get_pull_request
-> generic Task Manager update_issue(Root, In Review)
```

Symphony 不自动 merge，也不自动将 Root 设为 `Done`。不存在一个聚合的 Symphony delivery command。

## PR identity and conflicts

每个 Root 的 delivery identity 是 closed tuple：

```text
(provider, repository_id, base_branch, head_branch)
head_branch = symphony/root-<normalized-task-root-id>
```

Root identity normalization 必须 injective、deterministic 且仅生成 provider 允许的 ref characters。PR title、body、URL 或 description 不参与 identity matching。相同 identity 的重复 call 只能读取/确认同一个 open PR，不能创建第二个。

| Fresh read result | Tool result |
|---|---|
| remote ref 不存在，matching open PR 为 0 | 可按 Root 指定 exact revision push/create，再 read-back |
| remote ref 等于 exact revision，matching open PR 为 0 | 可创建一个 PR，再 read-back |
| remote ref 和唯一 open PR head 都等于 exact revision | 返回 existing exact match |
| remote ref 指向其他 revision | `precondition_failed`；不 force-push |
| matching open PR 多于 1 | fail closed；不选择或关闭 PR |
| matching PR identity 不符或 closed/merged | fail closed；不 reopen、不创建 replacement |
| mutation `acceptance_unknown` | fresh read 同一 identity；仅 exact match 时接受 |

任何 mutation 后都重新读取 remote ref 与 PR。Phase 1 不提供 fallback provider、alternate branch、force push、自动 conflict repair、compatibility adapter 或 migration path。

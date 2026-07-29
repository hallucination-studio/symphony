# Git Worktree and Delivery

状态：Phase 1 目标设计。本文定义从代码修改到 PR 的 Git 事实和机械动作。

## Worktree

每个 Root 使用独立 branch 和 worktree。Conductor 创建并验证 worktree；不同 Root 不得共享。

Work turn 期间只有对应 Work Performer 可以写代码。Plan 和 Verify 只读；Conductor 不写代码，只执行机械 Git 和交付动作。

worktree 缺失、路径冲突或 branch 不匹配时停止推进。Phase 1 不自动 reset、clean 或重建。

## Commit 与 Verify

全部 required Work 为 `Done` 后，Conductor：

1. 重新读取 Git status 和完整 diff。
2. 创建一个 immutable commit。
3. 将该 commit revision 传给 Verify。
4. Verify 返回后再次确认 HEAD 和 revision 未变化。

Verify 检查的 revision、push 的 revision 和 PR head 必须相同。任何不一致都返回实际 Git observation，由 `RootReconcill` 决定重新 Plan 或停止。

## Delivery

Verify 结论为 `passed` 且 `RootReconcill` 返回 `DeliverVerifiedRevision` 后，Conductor 再次校验前置条件，然后：

```text
push verified revision
-> read or create the one PR selected by delivery identity
-> read back PR head and URL
-> set Root In Review
```

Phase 1 到此结束。Symphony 不自动 merge，也不自动将 Root 设为 `Done`。

## PR identity and conflicts

每个 Root 的 delivery identity 是 closed tuple：

```text
(provider, repository_id, base_branch, head_branch)
head_branch = symphony/root-<normalized-linear-root-id>
```

Root identity 的 normalization 必须是 injective、deterministic 且只产生 provider 允许的
ref 字符；无法无歧义编码时 fail closed。PR title、body、URL 或 description 不参与身份
匹配。相同 identity 的重复 delivery 只能读取/确认同一个 open PR，不能创建第二个 PR。

| Fresh read result | Mechanical behavior |
|---|---|
| head remote ref 不存在，matching PR 为 0 | 以 verified revision 创建 ref，创建一个 PR，再回读 ref 和 PR |
| head remote ref 已等于 verified revision，matching open PR 为 0 | 创建一个 PR，再回读 |
| head remote ref 和唯一 open PR head 都等于 verified revision | 接受现有 PR，再回读 URL/state/head |
| head remote ref 指向其他 revision | fail closed；不 force-push、不改写 ref |
| matching open PR 多于 1 | fail closed；不选择、不关闭任何 PR |
| matching PR 的 provider/repository/base/head 任一不符 | 视为不匹配；若它占用 head ref 或导致歧义则 fail closed |
| matching PR 已 closed 或 merged | fail closed；不 reopen、不创建 replacement PR |
| push/create/read 返回 `acceptance_unknown` | fresh read 同一 identity；仅在 ref 与唯一 open PR 都精确匹配 verified revision 时接受，否则 fail closed |

任何 mutation 后都重新读取 remote ref 与 PR。只有 remote revision、PR head 和 verified
revision 三者相同，且 PR state 为 open，才可将 Root 设为 `In Review`。delivery 不提供
fallback provider、alternate branch、force push 或自动冲突修复。

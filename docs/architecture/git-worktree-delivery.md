# Git Worktree与Root交付

状态：目标架构提案。本文是Root worktree validation、immutable revision、PR和delivery mechanics的唯一事实源。
恢复分支选择、worktree rematerialization与invalid-generation rebuild只由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。

## 1. 固定模型

每个active Root恰有：

```text
one repository context
one deterministic delivery branch
one deterministic Git worktree path
at most one active delivery PR
```

Performer Work只能修改授予的worktree capability。Plan和Verify只读；Conductor独占worktree创建、branch、commit、push、
PR、cleanup和Git topology mutation。

## 2. Repository Context

Repository Context由Project Binding提供repository identity、local path、base branch、remote和delivery policy。Root可以在
description中覆盖明确允许的delivery instruction；不得从comment机器payload或Provider output改变repository identity。

Root branch/path由repository identity和Root native ID确定性派生。不得使用title或本地自增序号。

## 3. 创建与验证

Conductor在首次执行前：

1. 验证repository、remote和base revision；
2. 确认没有其他Root占用matching branch/path；
3. 创建fresh delivery branch和worktree；
4. 通过`git worktree list`、branch、HEAD和repository identity fresh read-back；
5. 只有全部postconditions成立才dispatch Stage。

每次process恢复先执行同样的existence与identity gate。存在但identity、branch或repository不一致时fail closed，保留现场；
不能reset、clean、move或猜测修复。worktree不存在时先按Git authority验证existing branch/commits：可证明时从该branch
重建worktree；Git execution facts也不可证明时才进入
[invalid-generation convergence](workflow-authority-recovery.md#6-worktree丢失时的rematerialization与invalid-generation-rebuild)。

## 4. Work与immutable Verify target

Work不commit或push。全部required Work完成后，Conductor：

1. 验证worktree没有越界路径或未预期Git topology变化；
2. 运行mechanical required checks；
3. 创建一个可read-back的immutable target commit；
4. 记录commit SHA、tree和diff facts到当前runtime request；
5. Verify只读检查该exact revision。

Verify后任何内容变化都会产生new revision，并要求fresh Verify Issue。旧Verify approval或Finding conclusion不适用于new
revision。

## 5. Delivery

Root只有在以下native事实同时成立时进入`In Review`：

- matching Cycle为`Succeeded`；
- matching Verify为`Done + Passed`；
- Verify检查的commit仍是delivery branch exact target；
- required checks通过；
- delivery policy要求的push/PR已完成并从Git/SCM fresh read-back；
- Root存在native PR attachment/relation，或direct-delivery policy有可验证remote revision；
- Root status `In Review` mutation已经fresh read-back。

这些事实本身就是delivery authority，不再创建parallel delivery object、receipt comment或machine JSON。用户可见comment只在交付结果或
失败需要解释时写一次简短摘要；native SCM link提供详细证据。

Root `Done`只能由用户或SCM接受事实触发。`In Review`不自动cleanup worktree，review changes创建fresh Cycle或fresh Work
Issue，不能重新派发旧`Done`节点。

## 6. Cleanup

只在Root `Done`或`Canceled`且没有live Stage、uncommitted changes、unreadable Git state或pending delivery时cleanup。
cleanup必须先验证exact Root path、repository和branch，再使用Git-aware worktree removal。失败保留现场并记录sanitized log；
不得递归删除宽泛路径。

## 7. 不变量

1. 一个active Root一个branch和worktree；Git facts由Git fresh read-back。
2. Work只改文件，Conductor独占commit/push/PR/worktree mutation。
3. Verify和delivery绑定同一immutable revision。
4. delivery由Git/SCM facts加Linear native status/link表达，不保存私有record。
5. worktree missing的行为只由Workflow Authority文档定义，本文件不复制恢复算法。
6. ambiguous或mismatched workspace永不自动reset/clean。

# Git Worktree与Root交付

状态：目标架构提案。Symphony只接受Git repository；一个Root对应一个deterministic branch和worktree。

## 1. 固定模型

```text
Linear Root
  -> symphony/runs/<root-identifier-lower> branch
  -> <conductor-data-root>/worktrees/<root-issue-id> worktree
  -> all Cycle Work Nodes edit the same worktree
  -> latest Cycle Verify Node
  -> PR when gh is usable, otherwise branch delivery
```

不存在非Git目录模式、per-Leaf branch/worktree或把修改复制回普通目录。

## 2. Repository Context

Conductor Binding保存用户选择的local Git repository和base branch。Conductor启动时验证repository
identity、Git binary、base branch、deterministic run branch和worktree identity。原工作目录中的
未提交修改不进入Root worktree，也不被Conductor清理或覆盖。

Branch和worktree名称只从稳定Root identity推导，不使用Issue title、Comment或Agent输出：

```text
branch:   symphony/runs/<root-identifier-lower>
worktree: <conductor-data-root>/worktrees/<root-issue-id>
```

## 3. Stage integration边界

Work Stage对workspace的权限、Work Result提交、Verify Node和delivery eligibility只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

本文只补充Git所有权：Conductor拥有branch/worktree lifecycle、checks、commit、push、PR和delivery；
Performer不能commit、修改Git topology、push、调用`gh`或执行delivery。

## 4. 创建与恢复

首次claim Root时，Conductor验证repository/base branch，创建或验证deterministic branch/worktree并把
branch写入Root Primary Status Comment。Crash/restart复用matching worktree，保留未提交修改；identity
冲突进入`needs_attention`，不得reset/clean猜测恢复。

## 5. In Review之后

Root In Review表示代码已经以PR或branch交付。只有用户或外部SCM/Linear automation把Root置为Done。

Root/Work内容没有变化时不继续修改branch。外部review changes、新工作或verified HEAD失效时，Root回到
In Progress并创建successor Cycle；继续复用同一branch/worktree，在新Cycle中重新Plan、审批、执行delta
Work DAG和Verify，随后重新delivery。

Done/Canceled Root不自动重开。

## 6. Cleanup

cleanup不是Root完成条件。只有Root Done/Canceled或用户明确请求，且没有live process或writer、
worktree identity完全匹配、没有未提交/未push/未交付修改时才能删除。任何证明不足都停止并显示原因。

## 7. 不变量

1. Symphony只处理Git repository。
2. 一个Root只有一个deterministic branch和worktree。
3. Stage retry和successor Cycle不创建第二branch/worktree。
4. Performer不能直接修改Git topology或delivery。
5. commit和delivery由Conductor执行并read-back。
6. Verify通过前不交付；Root不自动Done。
7. Git与Linear足以重建代码/交付状态，不保存Delivery Receipt或Leaf checkpoint。
8. Stage retry保留worktree、commits和未提交修改。
9. Verify绑定immutable target commit；验证期间HEAD变化使Result失效且禁止delivery。

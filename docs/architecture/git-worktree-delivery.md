# Git Worktree与Root交付

状态：目标架构提案。Symphony只接受Git repository；一个Root对应一个deterministic branch和worktree。

## 1. 固定模型

```text
Linear Root
  -> symphony/runs/<root-identifier-lower> branch
  -> <conductor-data-root>/worktrees/<root-issue-id> worktree
  -> Root Agent edits + brokered commits/checks
  -> Root Gate
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

## 3. 所有权

Conductor拥有：

- branch/worktree创建、发现、identity验证和safe cleanup；
- brokered commit和checks correlation；
- push、`gh`检查、PR查找/创建和branch delivery；
- delivery写回Root Primary Status Comment。

Performer/Root Agent可以读取和修改给定worktree、运行开发工具，并通过closed broker请求commit或
delivery；不能直接创建/切换/删除branch/worktree，不能commit、merge、rebase、reset、clean、push或
调用`gh`。

## 4. 创建与恢复

首次claim Root：

1. 验证Repository Context和base branch；
2. 创建或验证deterministic branch；
3. 创建或验证该branch的worktree；
4. 把branch写入Root Primary Status Comment；
5. 才bootstrap Root Conversation并开放Root Turn。

重启或Root retry：

- branch/worktree都存在且identity匹配：复用；
- branch存在、worktree缺失：从该branch重建；
- worktree存在但branch/Root identity不匹配：`needs_attention`；
- worktree有未提交修改：作为Root Git事实保留，新Root Turn审计后继续或返工；
- 不读取workspace receipt，不reset/clean猜测恢复。

Conversation替换不创建新branch/worktree，也不改变Git HEAD。

## 5. Brokered commit

Root Agent完成一个Work Leaf时调用：

```text
symphony git commit --issue <work-issue-id> ...
```

Broker在commit前验证：

- Root、current `performer_id`和worktree identity；
- Work仍属于当前Root且remote precondition成立；
- worktree identity和expected Git HEAD；
- staged/unstaged changes均位于Root worktree；
- requested checks的真实结果。

Commit message使用稳定Root/Work identifiers，不拼接未转义自由文本。Commit成功后Agent写可读的
Work Completion Comment，包含summary、checks和commit SHA，再把Work置为In Review。无代码任务也
必须在Linear留下明确完成证据；Performer Result本身不负责完成。

中断后从Linear/Git收敛：

- commit存在但Completion Comment缺失：新Root Turn审计commit并补写或返工；
- Completion Comment存在但Work仍In Progress：read-back evidence和Issue version后补写In Review；
- Work业务内容晚于Completion Comment：重开Work；
- remote state/parent/version冲突：不覆盖用户更新，重新读取Root。

Completion evidence是Linear/Git事实，不是Conductor Leaf checkpoint或Result ledger。

## 6. Root Gate与delivery

Root Agent在最新Tree/Git上创建或复用唯一的`[Root Gate]` Work child，并执行fresh Gate。Gate child
description必须包含Root Issue规范中定义的五项固定Markdown checklist；只有五项都被更新为`[x]`
并read-back确认后，才可继续交付。失败时保留未勾选项、写findings并创建/重开Rework child，不push
或创建PR。通过时调用：

```text
symphony root deliver ...
```

Conductor在命令时重新验证Root ownership/state、blockers、Tree completion evidence、Gate child的
完整checked checklist、Git HEAD、checks和已有delivery。交付顺序：

```text
find/reuse existing PR for deterministic head
-> push branch when possible
-> create PR when GitHub remote + authenticated gh are available
-> otherwise record remote or local branch delivery
-> write Root delivery facts
-> Root In Review
```

Symphony不自动merge、rebase、squash、cherry-pick或把Root置为Done。重复delivery必须先查找既有PR，
避免crash/retry后重复创建。

## 7. In Review之后

Root In Review表示代码已经以PR或branch交付。只有用户或外部SCM/Linear automation把Root置为Done。

Root/Work内容没有变化时不继续修改branch。Root目标变化、新增/reopen Work或completion evidence失效
时，Root回到In Progress并重新进入Root scheduling；继续复用同一branch/worktree。若current
Conversation仍可用就resume，失效则Root-level retry后使用新Conversation。完成后重新Gate和delivery。

Done/Canceled Root不自动重开。

## 8. Cleanup

cleanup不是Root完成条件。只有Root Done/Canceled或用户明确请求，且没有live process或writer、
worktree identity完全匹配、没有未提交/未push/未交付修改时才能删除。任何证明不足都停止并显示原因。

## 9. 不变量

1. Symphony只处理Git repository。
2. 一个Root只有一个deterministic branch和worktree。
3. Leaf和Conversation retry不创建第二branch/worktree。
4. Performer不能直接修改Git topology或delivery。
5. commit和delivery通过Conductor broker并在执行时read-back。
6. Root Gate通过前不交付；Root不自动Done。
7. Git与Linear足以重建代码/交付状态，不保存Delivery Receipt或Leaf checkpoint。
8. Root retry保留worktree、commits和未提交修改。

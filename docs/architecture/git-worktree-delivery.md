# Git Worktree 与代码交付

状态：目标架构提案。Symphony只接受Git repository；一个Root对应一个deterministic branch和worktree。

## 1. 固定模型

```text
Linear Root
  -> symphony/runs/<root-identifier-lower> branch
  -> <conductor-data-root>/worktrees/<root-issue-id> worktree
  -> Work Turns and Conductor commits
  -> Root Gate
  -> PR when gh is usable
     otherwise branch delivery
```

不存在非Git目录模式，也不把修改复制回普通目录。

## 2. Conductor Binding与Repository Context

创建Conductor时，Podium Desktop让用户选择：

- 一个Linear Project；
- 一个本地Git repository；
- 一个base branch。

Conductor Binding保存稳定Repository Context。Conductor启动时验证：

- 路径仍是同一个Git repository；
- `git`可用；
- base branch存在；
- deterministic run branch没有指向冲突身份；
- worktree可以创建或重新发现。

原工作目录中的未提交修改不自动进入Root worktree，也不被Conductor清理或覆盖。

## 3. 所有权

Conductor拥有：

- branch/worktree命名、创建、发现和清理；
- Work完成后的commit；
- push、`gh`检查和PR创建；
- Root Delivery信息写回Root Managed Comment。

Performer只拥有给定worktree中的文件修改。Performer不得：

- 创建、切换或删除branch/worktree；
- commit、merge、rebase、reset、clean或push；
- 调用`gh`；
- 修改Git topology。

Podium只保存Conductor Binding，不操作Root branch或PR。

## 4. 创建与恢复

Branch名称固定为：

```text
symphony/runs/<root-identifier-lower>
```

Worktree路径固定从Root issue ID推导。名称不使用Issue title或Comment。

首次处理Root：

1. 验证Conductor Binding中的Repository Context和base branch；
2. 从base branch创建deterministic run branch；
3. 为该branch创建worktree；
4. 把branch写入Root Managed Comment；
5. 才启动Plan Turn。

重启时不读取workspace receipt：

- branch和worktree都存在且匹配：复用；
- branch存在、worktree缺失：从该branch重建worktree；
- worktree存在但branch不匹配：Root blocked；
- branch指向其他Root身份：Root blocked，不删除或接管；
- worktree中有未commit修改：视为中断Turn留下的代码，使用同一`performer_id`继续。

## 5. Work提交

一个Work Leaf的Work Turn成功且Linear read-back仍允许应用时：

```text
inspect worktree
-> create one Conductor-owned commit for current Work
-> record current Work input hash in Work Managed Metadata
-> update Work to In Review
```

Commit message使用稳定Root/Work identifier，不使用未转义自由文本。若Turn没有代码变化但任务本身可以无代码完成，Conductor仍可把Work置为In Review；是否完成由Performer Result负责，Conductor不附加独立Verification、Manifest或Evidence层。

三步中的任意一步都允许重启后继续收敛：

- commit成功但`completed_input_hash`未写：Work仍为In Progress，下一Turn使用同一
  Conversation和当前worktree重新确认完成，再补齐Linear状态；
- hash已写但Work仍为In Progress：Conductor直接补写In Review，不重新执行；
- Work已经In Review/Done但hash缺失或损坏：Root blocked，不把当前内容自动当作完成；
- 任何Linear写入都必须使用最新Issue version/state precondition，冲突时重新读取，
  不能覆盖用户刚刚执行的Canceled或状态修改。

Conductor不把多个Root放在同一branch，也不把Work commit直接写入base branch。

## 6. Root Gate与交付

全部有效Work Leaves完成后，Performer执行Root Gate。

Gate失败：

- branch/worktree保留；
- Conductor创建或更新Root Gate Rework Node；
- 不push、不创建PR。

Gate通过：

1. 把非Canceled的In Review Work Nodes/Work Groups置为Done；
2. Root Phase变为`delivering`；
3. 确认branch包含最新Work commit；
4. 尝试GitHub PR交付；
5. 无法创建PR时交付branch；
6. 写回branch、commit、PR或明确的branch-only原因；
7. Root进入In Review。

Symphony不自动merge、rebase、squash、cherry-pick或把Root置为Done。

## 7. PR与branch策略

PR路径只在以下条件成立时使用：

- repository有GitHub remote；
- `gh`命令可用且已认证；
- branch可以push；
- 可以查找或创建对应PR。

Conductor先按deterministic head branch查找现有PR，再决定是否创建，避免重启后重复PR。

不能创建PR时，branch就是交付物：

- 能push时，写remote branch；
- 不能push时，保留local branch并写清楚原因；
- 不因PR不可用重新执行Work或Root Gate；
- 不伪造PR成功。

## 8. In Review之后

Root进入In Review表示代码已经以PR或branch形式交付，等待用户审核。只有用户或外部SCM/Linear automation把Root置为Done。

In Review期间：

- Root/Work输入没有变化时，Conductor不继续修改该Root branch；
- Root title/description变化时，Root自动回到In Progress + planning；
- 已完成Work Leaf的title/description变化时，该Work重新进入In Progress，Root回到working；
- 新增Todo Work Node时，Root回到working并按最新Linear顺序执行；
- 继续处理时复用同一Root、branch、worktree和`performer_id`，并在完成后重新Root Gate和交付；
- Done/Canceled Root不自动重开。

## 9. 不变量

1. Symphony只处理Git repository。
2. 一个Root只有一个deterministic branch和worktree。
3. Performer不能修改Git topology。
4. Work成功后由Conductor commit。
5. Root Gate通过前不交付。
6. PR是优先交付面，branch是必备交付面。
7. Symphony不自动合并base branch。
8. Git与Linear足以重建交付状态，不保存Delivery Receipt。
9. Root或Work变化后的新交付继续使用同一branch，不创建第二个Root branch。

# Root Issue工作流

状态：目标架构提案。本文只描述一个Linear Root Issue，不讨论Root之间的Priority、blocker或Project调度。

## 1. Root Issue与Root Run

Conductor没有数据库。一个Root的运行状态从以下远端/文件系统事实重建：

```text
RootRunView
  = Root Issue state
  + one Root Phase Label
  + Root Managed Comment
  + complete descendant Issue Tree
  + deterministic Git branch/worktree
```

一个Root对应：

```text
1 persisted active performer_id
1 persisted active Provider Conversation
1 delivery branch
1 worktree
1 Root Gate
```

## 2. Root Linear状态

```text
Todo -> In Progress -> In Review -> Done
Todo | In Progress | In Review -> Canceled
In Review -> In Progress  when Root input changes
```

| Root state | 含义 |
|---|---|
| `Todo` | 尚未开始 |
| `In Progress` | planning、working、awaiting-human、gating、delivering、blocked或failed |
| `In Review` | PR/branch已交付，等待人工审核 |
| `Done` | 用户或SCM automation确认接受/merge |
| `Canceled` | 用户取消 |

Root只表达整个任务处于什么大阶段，不镜像当前Work Leaf的细节。

用户在任一Turn期间把Root置为`Done`或`Canceled`时，当前Turn不被强制抢占，
但其Result不得再开始创建节点、提交代码或推进任何Linear状态。Conductor在Result
应用前重新读取Root state，并丢弃已终止Root的旧Result。若用户取消恰好与本地commit
竞态，已经产生的commit只作为未交付Git事实保留；Conductor不得再更新Work/Root状态、
运行Gate或交付该branch。

## 3. Root Phase Label

Root始终最多有一个Conductor管理的Root Phase Label：

```text
symphony:run/planning
symphony:run/awaiting-human
symphony:run/working
symphony:run/gating
symphony:run/delivering
symphony:run/in-review
symphony:run/blocked
symphony:run/failed
```

Conductor只创建、删除和替换Root Phase Label，不修改用户其他Labels。

Label缺失时可以从Root/Workflow Tree/Git推导并补写；存在多个Root Phase Labels时
不能猜测。此时blocked是Root Managed Comment和`RootDetailView`中的派生状态，
Conductor不得再追加第三个Root Phase Label；用户清理冲突Label后重新计算。

## 4. Root Managed Comment

Root只有一条可更新的Root Managed Comment：

```text
Symphony Root Run
conductor_id: <stable full id>
performer_profile_id: <profile id>
performer_id: <opaque id>
planned_root_input_hash: <hash or none>
usage_input_tokens: <integer>
usage_cached_input_tokens: <integer>
usage_output_tokens: <integer>
usage_reasoning_output_tokens: <integer>
usage_total_tokens: <integer>
last_usage_turn_id: <turn id or none>
delivery_branch: <branch>
pull_request: <url when available>
last_error: <sanitized summary when applicable>
<!-- symphony root marker -->
```

`performer_id`是Provider-neutral opaque string：

- Codex Backend可以使用Codex thread id；
- 未来Backend可以使用自己的session/conversation id；
- Conductor不解析、不转换；
- Performer根据配置的Backend解释并resume；
- `performer_id`不能包含Token或credential。

`performer_profile_id`在Root首次claim时从Conductor的active Performer Profile复制。
它确定该Root后续Turn使用的`CODEX_HOME`和`CodexTurnSettings`。Root得到
`performer_id`后不得切换Profile；Desktop切换active Profile只影响之后claim的Root。
Profile身份固定不等于设置版本固定：用户编辑该Profile的model、reasoning或Fast后，
这个Root的下一Turn使用新设置，当前Turn不被抢占。

`planned_root_input_hash`是当前Plan已消费的Root title + description规范化hash。它只保留最新值，不形成Revision历史。

active Root必须恰好存在一条合法Root Managed Comment。缺失、重复、Managed Marker
损坏、`performer_profile_id`无效或已有`performer_id`不可解析时，拥有该Root的
Conductor不能猜测、改用active Profile或创建新Conversation伪装恢复，必须把Root置为
blocked并给出明确原因。

首次Plan尚未成功时`performer_id`可以为空，但`performer_profile_id`必须已经固定。
Provider已经创建Conversation、但process
在Result返回前中断时，可能留下一个无法引用的orphan Conversation；Plan只读，因此它
不能改变Linear或Git。下一轮可以创建新Conversation。第一个成功Plan Result返回ID后，
Conductor立即写入comment，之后不得静默替换。

若`conductor_id`与当前Conductor不匹配，当前Conductor只跳过并报告
`root_owned_by_other_conductor`，不得修改该Root。Conductor Project Label移回原
Conductor后，由原Conductor继续。

Root Phase只以Root Phase Label为准；current Workflow Node从Workflow Tree推导；Root Gate
状态从Root Phase、Work Node状态和Root Gate Rework Node推导。三者不再写入Root
Managed Comment，避免事实双写。

每个由Symphony执行的Work Leaf，在description末尾有一个Work Managed Metadata block：

```text
kind: work
origin: user | symphony
completed_input_hash: <hash or none>
```

业务description不包含该block；input hash计算时排除该block。用户创建的无marker
Work在首次执行前补充`origin: user`，Plan创建的Work使用`origin: symphony`。
补充metadata不会改变title/description所有权。该hash用于判断Work内容是否在完成
后被用户修改；它不是Work状态、Attempt或历史账本。

Work Managed Metadata是无DB恢复所需的受管事实，不能在缺失或损坏时猜测：

- Todo或In Progress的无marker用户Work可以补充`origin: user`后正常执行；
- In Review或Done Work缺少合法`completed_input_hash`时不能自动建立完成基线；
- 用户若希望重新执行该Work，将它移回In Progress，Conductor重新补充metadata并执行；
- 用户若确认该Work不再需要执行，将它置为Canceled；
- `origin: symphony`、kind或hash marker损坏时Root进入
  `blocked`，直到Work回到In Progress重跑或被用户Canceled。

Token usage字段是best-effort operator指标，不是Workflow状态。Conductor只在Result
correlation有效且`last_usage_turn_id`不等于当前`turn_id`时累计一次。usage缺失不阻止
Workflow；Root已经Done/Canceled时不为补指标而修改Root Managed Comment。

## 5. Workflow Node类型

Root的descendant Issues形成Workflow Tree。

```text
LinearIssueNodeSnapshot
  = WorkNodeSnapshot
  | HumanNodeSnapshot

common wire fields
  issue_id
  parent_issue_id
  sibling_order
  kind: work | human
  state
  title
  description
  updated_at
```

Workflow Node类型规则：

- Plan创建的Workflow Node带Managed Marker；Work Node的`kind`来自Work Managed
  Metadata，Human Node的`kind`来自Managed Marker；
- 用户手工创建、没有Managed Marker的普通Sub Issue默认是Work Node；
- 用户Work Node首次执行前补充`origin: user` Work Managed Metadata，但不改写其业务title/description；
- Human Node必须是叶子；
- 有children的Work Node派生为`WorkGroupView`，不直接交给Performer；
- 没有children的Work Node派生为可执行`WorkLeafView`。

Root Gate不是Tree中的普通排序节点，而是Workflow Tree完成后的固定Root Phase。

## 6. Plan Turn与节点创建

Root首次进入planning，或Root title/description相对`planned_root_input_hash`发生变化时，Conductor用最新Root、当前完整Tree和worktree调用Performer Plan Turn。

Plan Result输出有界树：

```text
PlannedWorkflowNode
  client_node_key
  parent_client_node_key?
  kind: work | human
  order
  title
  description
  existing_issue_id?
  target_client_node_key?  # human only
```

Conductor按Result对当前Workflow Tree做最小reconcile：

- `work`创建Work Node；
- `human`创建带`[Human Action]` title prefix的Human Node；
- 每个普通Human Node必须关联一个目标Work Node，并作为该Work之前的同级叶子；
- parent关系和sibling order来自Plan；
- Conductor不额外排序；
- 引用`existing_issue_id`的未完成`origin: symphony`节点就地更新；
- Result未引用的未完成`origin: symphony`节点置为Canceled；
- `origin: user`节点始终保留，不能被Plan删除或覆盖；
- In Review/Done节点保留；若新需求还需要工作，Plan创建新的Work，而不是抹掉已完成历史；
- Root Gate不由Plan创建。

Result应用前，Conductor重新计算Root和Tree input hash；任一已经变化时，不应用nodes
并重新Plan。若Root仍非Done/Canceled、这是首次Plan且Result已返回合法
`performer_id`，仍先保存该ID，再用同一Conversation处理最新输入。

每个Plan创建的节点marker包含`root_issue_id + turn_input_hash +
client_node_key`。同一个Plan Result的重复create必须返回同一个Issue；timeout后先按
Managed Marker read-back。Workflow Tree reconcile的完成顺序是：

1. 幂等创建或更新Result引用的节点；
2. read-back确认parent、order、kind和marker；
3. 将未引用的未完成`origin: symphony`节点置为Canceled；
4. 创建或更新Plan Approval Node；
5. 最后覆盖`planned_root_input_hash`并进入`awaiting-human`。

若Conductor在中间退出，`planned_root_input_hash`仍是旧值。下一轮重新Plan，并把
Linear中已经存在但只完成部分写入的Symphony-origin Workflow Nodes作为
`current_tree`输入；新的reconcile复用仍被引用的节点，取消不再引用的节点。部分写入
不得形成两个同时有效的同身份Workflow Nodes。

若Workflow Tree和Plan Approval Node已经完成，但进程在最终Root Managed Comment和
Root Phase Label写入之间退出：

- `planned_root_input_hash`已更新且phase仍为planning：补写`awaiting-human`；
- Root Phase mutation timeout：read-back Root Phase Labels，不盲目追加第二个Label；
- Plan Approval Node、hash或Tree任一不匹配：保持planning并重新Plan/reconcile。

Plan完整应用后的结果必须同时满足：

- Root Managed Comment中的`planned_root_input_hash`已经覆盖；
- 固定的Root级Plan Approval Node已经创建或复用，Linear title使用
  `[Human Action] Approve Plan`，最新Plan
  summary已经写入其description，并处于In Progress；
- Root Phase已经变为`awaiting-human`。

批准前不执行Work。Plan Approval Node不属于Plan输出，也不参与普通Work
Nodes/Human Nodes顺序。

## 7. Tree遍历

Conductor每个Turn边界重新读取完整Tree，使用纯`LinearTreeTraversalPolicyInterface`：

```text
for child in linear sibling order:
  if child is Canceled:
    continue

  if child has incomplete descendants:
    descend into child

  if child is an In Review/Done Work
     and has no valid completed_input_hash:
    return blocked

  if child is an In Review/Done Work
     and current input hash differs from completed_input_hash:
    reopen and select child

  if child is In Review or Done:
    continue

  if child is a leaf Work:
    select child

  if child is a leaf Human:
    wait for child

if current level has no incomplete child:
  return to parent level
```

选择结果是第一个最深层、按Linear顺序出现的未完成叶子。

规则：

- 不保存Queue或Cursor；
- 不根据title、创建时间或本地序号重新排序；
- 当前Turn不因用户拖动节点而被抢占；
- 下一个Turn使用最新Linear顺序；
- Canceled节点永远跳过；
- In Review/Done Work只有在其title/description hash没有变化时才跳过；
- In Review/Done Work缺少合法`completed_input_hash`时不能静默视为完成；
- Plan Approval Node由Root Phase处理，不由Tree遍历选择。

## 8. Work状态

```text
Todo -> In Progress -> In Review -> Done
Todo | In Progress | In Review -> Canceled
In Review | Done -> In Progress  when Work input changes
```

| state | 含义 |
|---|---|
| `Todo` | 等待Tree解释器选择 |
| `In Progress` | 当前Turn正在处理；重启后应resume |
| `In Review` | Performer完成、Conductor已commit且`completed_input_hash`匹配，等待Root Gate |
| `Done` | Root Gate通过；内容变化时可重新进入In Progress |
| `Canceled` | 用户或新Plan取消；不再调度 |

Work完成是一个可重放的收敛过程：

```text
commit current changes
-> write completed_input_hash
-> Work In Review
```

重启时：

- Work为In Progress且`completed_input_hash`已经匹配：直接补写In Review，不再启动Performer；
- Work为In Progress且hash尚未写入：使用同一`performer_id`和当前worktree重新执行该Work Turn；
- Work为In Review或Done但hash缺失或损坏：blocked，不自动建立基线；
- commit成功但后续Linear写入失败：保留commit，并按以上规则重新执行或补齐Linear状态。

这保证三步中的任意一步中断后都能从Git、Linear和Conversation收敛，不需要operation journal。

Work Group的显示状态由非Canceled descendants推导：

- 任一非Canceled descendant In Progress：Group In Progress；
- 全部非Canceled Work descendants In Review/Done且非Canceled Human已Done：Group In Review；
- Root Gate通过：Group Done。

Canceled Group的整个subtree不参与投影。Group state只是descendants的Linear投影；
遍历始终先看children，不允许Group自身state隐藏未完成descendant。

## 9. Human Node

```text
Todo -> In Progress -> Done | Canceled
Canceled -> In Progress  when the user reopens the same Human
```

Human Node分为：

- `plan_approval` `PlanApprovalNodeView`：Root级固定Plan Approval Node，Done表示批准当前Plan，
  不要求回答Comment；Canceled表示拒绝，Root进入blocked；
- `planned_input` `PlannedInputNodeView`：Plan创建的Planned Input Node；
- `runtime_input` `RuntimeInputNodeView`：Performer在Work Turn中请求的Runtime Input Node。

解释器遇到第一个Planned Input Node或Runtime Input Node：

1. Human置为In Progress；
2. Root Phase置为`awaiting-human`；
3. 等待用户Comment和Done/Canceled；
4. 只有同时存在明确回答Comment并进入Done，才把该回答作为下一个Turn输入；
5. Canceled表示该Human步骤被放弃；下一个关联Work Turn收到`canceled`输入。

普通Root/Work Comment不是命令。只有当前Human Node的Comment会作为明确输入。

Human回答使用该Issue当前所有非Symphony Comment，按Linear顺序组成一个确定输入。目标Work的完成hash包含title、业务description以及这些已解决Human输入；因此Human回答在Work完成后被编辑时，只重跑关联Work。

Performer在Work Turn中请求Human时：

1. 当前Work从In Progress退回Todo；
2. Conductor在同一parent下、当前Work之前创建或复用一个`runtime_input` Human sibling；
3. marker中的`target_issue_id`指向该Work；
4. Human进入In Progress；
5. Human完成后遍历器自然再次选择原Work。

Runtime Input Node不能创建为当前Work的child，否则Work会变成非叶子Work Group而无法继续执行。

Plan Approval Node被Canceled后，用户可以：

- 将同一个Plan Approval Node重新置为Todo或In Progress，继续审核当前Plan；或
- 修改Root title/description，让Conductor重新Plan并重新打开该Plan Approval Node。

Conductor观察到Approval重新可处理后，把Root从`blocked`恢复为
`awaiting-human`。普通Comment本身不恢复Approval。

## 10. blocked与failed恢复

`blocked`表示当前事实需要用户修复；它不是一个只能手工删除的永久Label。每个调度
周期都重新计算阻塞条件，条件消失后Conductor替换Root Phase Label并继续原Root。

| 原因 | 用户动作 | 恢复结果 |
|---|---|---|
| Plan Approval Node Canceled | 重新打开该Node，或修改Root触发重新Plan | `awaiting-human`或`planning` |
| 多个In Progress叶子 | 只保留一个In Progress，其余置为Todo或Canceled | `working` |
| 多个Root Phase Labels | 删除冲突Label，只保留或恢复一个有效Root Phase | 重新计算Root Phase |
| Work Managed Metadata缺失/损坏 | Work回到In Progress重跑，或置为Canceled | `working` |
| Git branch/worktree冲突 | 恢复匹配的branch/worktree，或清除冲突身份后重建 | 回到原phase |
| retryable SDK/Provider错误 | 无需改变业务内容；Conductor按有界backoff重试 | 回到原phase |

`failed`只用于在当前Root事实下无法安全重试的终止性错误。它必须写明具体原因和下一
动作；修复底层事实后，用户修改Root输入可重新进入`planning`。如果该错误无法修复，
用户将Root置为Canceled并创建新Root。可重试错误不得进入`failed`。

## 11. Root Issue与Work Node内容变化

不创建Source Revision或Plan Revision。Conductor只比较当前输入和Root Managed Comment
中的最新已消费hash。

### Root变化

这里的Root变化只指title或description变化，不包括Symphony自己的state、Label或
Root Managed Comment更新。

任一非Done/Canceled Root发生变化：

1. 当前Turn不被抢占；
2. Turn结束后重新读取Root；
3. 旧Root hash上的Plan、Work或Gate Result不能推进状态；
4. 保留worktree中的代码；
5. Root回到In Progress + `planning`；
6. 使用同一`performer_id`重新Plan并reconcile未完成Work Nodes/Human Nodes；
7. 重新批准；
8. revised Tree完成后重新执行Root Gate。

Root在In Review时发生变化也走同一路径，不要求用户先手工改回In Progress。Root已经Done或Canceled后不自动重开。

### Work Leaf变化

这里的Work只指Work Leaf；Work Group不是执行单元。

- Todo Work变化：首次执行时直接使用最新title/description；
- In Progress Work的title、description或关联Human输入在Turn期间变化：旧Result不完成该Work，下一个Turn用同一`performer_id`和最新输入重跑；
- In Review或Done Work的title、description或关联Human输入变化：`completed_input_hash`不再匹配，Conductor把该Work重新置为In Progress，Root回到`working`，下一个Turn重跑；
- Work重跑后，全部Work再次完成时重新Gate；
- Work Group内容变化：只影响Linear组织展示和Root Gate，不重跑Work Leaf。

## 12. 用户修改Tree

用户可以：

- 新增普通Sub Issue：默认成为Work Node；
- 嵌套Sub Issue：父Work Node变为Work Group；
- 拖动同级顺序：下一个Turn按新顺序；
- 把节点Canceled：解释器跳过；
- 添加Human：只有带有效Managed Marker且`kind: human`时才作为Human Node，否则仍是Work Node。

Root处于In Review时新增Todo Work，不重新Plan；Conductor把Root移回In Progress + `working`，按最新Linear顺序执行该节点，之后重新Root Gate和交付。

当前Work执行期间：

- 当前Turn使用启动时Issue snapshot；
- Result返回后Conductor重新读取Root和当前Work；
- 当前Turn输入已变化时不应用旧Result；
- 新增/重排其他节点只影响下一个Turn。

## 13. Root Gate

当以下条件全部成立时进入gating：

```text
no Todo/In Progress Work leaf in the non-Canceled tree
all non-Canceled Work leaves are In Review or Done
all non-Canceled Work leaves have matching completed_input_hash
all non-Canceled Human leaves are Done
```

Canceled节点及其整个subtree不属于Gate有效集合。Canceled Work不会阻止Gate，
也不会被Gate重新置为Done。

Conductor：

1. Root Phase设为`gating`；
2. 使用同一`performer_id`执行Root Gate Turn；
3. Gate读取最新Root、完整Tree和当前worktree。

Gate通过：

```text
all non-Canceled In Review Work Nodes/Work Groups -> Done
Root Phase -> delivering
```

Gate失败：

```text
keep existing Work in In Review
create or reuse one Symphony-origin Todo Work Leaf:
  [Rework] Root Gate Findings
Root Phase -> working
```

首次失败时把`RootGateReworkNodeView`对应的Root Gate Rework Node追加到Root末尾；
再次失败时更新并重开同一个
Rework Node，不累计Gate Revision或第二个Root Gate。Rework完成后重新运行Root Gate。
Root Gate只审核Root Run，不存在Work Node Gate。

Gate Turn完成后、进入交付前，Conductor必须重新读取Root和Tree。以下任一变化都使Gate Result失效：

- Root input hash变化；
- 有效Tree中新增Todo Work；
- 任一非Canceled Work的当前input hash与`completed_input_hash`不匹配；
- 任一非Canceled Human尚未Done。

Conductor先重新Plan或执行Work，再重新Gate。

## 14. 交付

Root Gate通过后，Conductor使用deterministic branch/worktree交付：

```text
gh available + push + PR success -> pull_request
otherwise push succeeds           -> remote_branch
otherwise                         -> local_branch
```

交付完成：

- Root Managed Comment写branch、commit和PR；
- Root state变为In Review；
- Root Phase Label变为`symphony:run/in-review`；
- Root不自动Done。

交付期间若Root或已完成Work内容变化，停止交付并回到对应的planning或working流程；不能发布旧Gate结果。

## 15. 重启重建

Conductor不读取本地Run数据库：

```text
read Root state
read one Root Phase Label
read Root Managed Comment
read complete Tree
read Work Managed Metadata
inspect deterministic Git workspace
derive RootAction
```

唯一In Progress Work就是当前恢复节点。多个In Progress叶子是Linear状态冲突，必须blocked而不是任选一个。

## 16. 不变量

1. Linear Tree是唯一Workflow结构。
2. Linear sibling order是唯一Work Nodes/Human Nodes顺序。
3. Work Group不执行。
4. 当前最多一个In Progress可执行叶子。
5. Canceled节点不再执行；Done Work内容变化后可以重跑。
6. performer_id只存在于Root Managed Comment和Turn contract。
7. performer_profile_id只存在于Root Managed Comment、Turn contract和Conductor Profile Store。
8. Root Gate只审核Root且只在Tree完成后运行。
9. Root Gate失败通过Root Gate Rework Node表达，不写本地rework状态。
10. Root Phase只由一个Root Phase Label表达。
11. Conductor没有Work Node、Queue、Root Gate或Root Run数据库。
12. Root变化触发重新Plan；Work Leaf变化只重跑该Work。
13. 输入hash只保存最新消费位置，不形成Revision模型。
14. Canceled节点和subtree不属于Root Gate有效集合。
15. 缺失或损坏的Work Managed Metadata不能被静默视为已完成。
16. Root Done/Canceled后，任何在途Result都不能继续推进。
17. Profile切换不迁移已有Root Conversation。

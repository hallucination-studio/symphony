# Root Issue工作流

状态：目标架构提案。本文只描述一个Linear Root Issue内部如何表达Plan、Human、Work、Root Gate、
Rework和Delivery；跨Root Priority、blocker和调度由[Linear端到端流转](linear-flow.md)拥有。

## 1. Root模型

Root是Symphony V3唯一调度、Conversation和retry单元：

```text
RootRunView
  = Root Issue native fields and state
  + Root Primary Status Comment
  + complete descendant Issue Tree
  + relevant comments and relations
  + deterministic Git branch/worktree
  + delivery facts
```

`RootRunView`每轮从Linear/Git重建并丢弃。一个Root对应：

```text
0..1 current performer_id
1 pinned performer_profile_id
1 delivery branch
1 worktree
0..1 managed `[Root Gate]` Work child
```

Leaf不对应独立Conversation、worktree、dispatch、attempt或recovery checkpoint。Plan、Work、Human、
Gate和Delivery是Root Agent根据最新Linear/Git事实推进的工作内容，不是Conductor内部状态机。

## 2. Root Linear状态

```text
Todo -> In Progress -> In Review -> Done
Todo | In Progress | In Review -> Canceled
In Review -> In Progress  when the Root needs more work
```

| Root state | 含义 |
|---|---|
| `Todo` | 尚未被Symphony claim |
| `In Progress` | Root Agent正在推进、等待Human、返工或准备交付 |
| `In Review` | branch/PR已交付，等待人工或SCM接受 |
| `Done` | 用户或SCM automation确认接受 |
| `Canceled` | 用户取消；任何旧Turn不得继续产生副作用 |

Root state只表达整个Root的大生命周期。当前工作、Human等待和Rework必须从children、comments和
Git中看见，不能编码成Conductor私有phase。

Root Primary Status Comment可以投影`waiting | working | failed | delivered`。每个投影必须同时显示
evidence sources和`observed_at`；可选`symphony:run/*` Label只能镜像已经写入并read-back的Primary
投影。缺失、陈旧或冲突时不显示这四种确定状态，也不能据此决定Root eligibility、Conversation
retry、Leaf选择或业务完成。

用户在Root Turn期间把Root置为Done/Canceled时，broker立即拒绝新的mutation。已经产生的Git
修改或commit作为事实保留，但旧Turn Result不能再更新children、运行delivery或改变Root状态。

## 3. Root Managed Comments

### 3.1 Root Primary Status Comment

Root claim时创建一条用户可读、按comment ID更新的Primary Status Comment：

```text
Symphony
Conductor: <stable full id>
Performer profile: <profile id>
Conversation: <active | restarting | action required>
Activity: <waiting | working | failed | delivered | none>
Evidence: <source identities, versions and observations>
Observed at: <timestamp>
Branch: <delivery branch>
Pull request: <url when available>
Current problem: <sanitized operator action when applicable>
Explanation: <optional Agent summary; never evidence>

<!-- symphony root
conductor_id: <stable full id>
performer_profile_id: <profile id>
performer_id: <opaque current id or none>
delivery_branch: <branch>
pull_request: <url or none>
retry_blocked: true | false
retry_expected_performer_id: <opaque failed id or none>
retry_failure_code: <closed ConversationOpenFailedResult code or none>
retry_observed_at: <timestamp or none>
-->
```

受管marker保存closed identity和唯一的Root retry interlock，不保存phase、current Leaf、attempt、
next action、accepted Result或Provider transcript。`performer_id`是current Conversation pointer；
它可以在Root-level retry时由remote precondition保护的compare-and-set替换。

Activity evidence最少满足：

| Activity | 客观evidence source |
|---|---|
| `waiting` | 具体Human Issue ID、native state、`updated_at`和等待的未完成条件 |
| `working` | 具体Work Issue ID/state/`updated_at`、dispatch前Git HEAD，以及最近Turn observation time |
| `failed` | stable error code、失败边界、相关Issue或Conversation identity、Git HEAD/check result（如相关） |
| `delivered` | PR/branch identity、delivered Git HEAD、required check IDs/conclusions |

每个Linear/SCM/check引用都带自身version、`updated_at`或observation time；Primary的`observed_at`表示
Conductor何时完成这一组read-back。Agent bounded summary只能进入`Explanation`，不能填充或替代
evidence，也不能把`working`、`failed`或`delivered`变成事实。

Root首次claim时固定`performer_profile_id`。Root retry使用同一个Profile和`CODEX_HOME`创建新
Conversation；Desktop切换active Profile只影响之后claim的Root。

Primary缺失、重复或identity损坏时，Conductor停止该Root并给出修复动作；不得猜测Root ownership。
首次claim的bootstrap可以从`performer_id: none`写入第一个ID；claim完成后，只有current pointer缺失或
Provider明确报告不可恢复时才允许创建新Conversation，这必须走Root retry，不能静默接管某个Leaf。

### 3.2 Root Retry Block

`retry_blocked: true`是唯一允许阻止自动Root retry的durable fact，并且其余三个retry字段必须都非
`none`。它只在一次Root-level retry的`openRootConversation`失败后写入：

```text
retry_expected_performer_id = the failed current performer_id | none
retry_failure_code = closed ConversationOpenFailedResult.error_code
retry_observed_at = the completed Linear read-back time
```

该block只有在Root当前`performer_id`仍等于`retry_expected_performer_id`时有效；不匹配表示旧fact，
Conductor停止并报告identity conflict，不能自行选择一边。有效block使Root assessment稳定为
`needs_attention`，重启和poll都不得再次调用`openRootConversation`。

operator修复Profile/auth/Provider原因后，通过Desktop发送closed
`AcknowledgeRootRetryBlockCommand(root_issue_id, retry_observed_at)`。Conductor重新验证Resolved Project、
full ownership、Root非终态、block仍为true、timestamp和current pointer全部匹配，才把四个字段原子
改为`false/none/none/none`并read-back。下一次scheduler随后允许一次正常Root retry。stale acknowledge、
普通Root comment、Issue内容修改、进程重启或仅修复Profile readiness都不能清除block。

### 3.3 Root Timeline Comments

只把人需要理解的关键事实append到Root Timeline：Plan发布、Conversation retry、terminal error、
Root Gate findings和delivery。Heartbeat、tool activity和普通progress只进入Event/Desktop，不刷屏
Linear。

Timeline create使用稳定`write_id`和hidden marker去重。Comment正文是人类上下文，不作为命令；
machine marker只提供identity/correlation，不能编码next action或transition graph。

## 4. Workflow Tree

Root descendants形成Workflow Tree：

```text
LinearIssueNodeSnapshot
  issue_id
  parent_issue_id
  sibling_order
  kind: work | human
  state
  title
  description
  assignee
  updated_at
```

节点规则：

- 普通Sub Issue默认是Work Node；
- Plan创建的Human Node带closed Managed Marker和`[Human Action]` title prefix；
- Human Node必须是叶子；
- Root Gate是一个managed Work Node，title必须以`[Root Gate]`开头，marker必须是
  `<root_issue_id>:root-gate`，description必须包含本Root声明的完整Gate checklist；
- 有children的Work Node是Work Group，只组织范围；
- 没有children的Work Node是Work Leaf；
- Canceled节点及其subtree不再执行；
- Linear parent和sibling order是Root内部唯一结构与顺序权威。

Managed Marker只提供Symphony-created对象的稳定identity和幂等create，不保存Leaf attempt、owner
lease、current cursor或完成状态。Symphony只reconcile自己创建且仍未完成的受管节点；用户创建的
业务内容仍由用户维护。

## 5. Plan与批准

Root首次运行，或Root目标变化需要重新规划时，Root Agent：

1. 读取Root、完整Tree和repository/Git摘要；
2. 在Root上创建或更新一条人类可读Plan comment；
3. 幂等创建、复用、移动或取消未完成的Symphony-origin Work/Human children；
4. 保留用户创建的children和已经完成的历史；
5. 创建或重开`[Human Action] Approve Plan` child；
6. 把该Human child分配给用户并结束当前Root Turn。

Plan comment marker记录它基于哪个Root remote version生成，只用于判断用户是否在批准前修改了
目标，不形成Plan Revision、checkpoint或Conductor state。任何部分写入在下一次Root Turn通过
stable node marker和Linear read-back收敛。

批准前不执行后续Work。Approval child进入Done表示批准；Canceled表示拒绝。普通Root comment不
等价于批准，Issue title/description中的文本也不能绕过Harness规则。

## 6. Root内部工作顺序

Root Agent每次都从完整Tree解释可行动内容：

```text
walk children in Linear sibling order
-> skip Canceled subtrees
-> descend through Work Groups
-> stop at the first unresolved Human leaf
-> otherwise work on the first incomplete Work leaf
-> when no incomplete Work/Human remains, create or resume the Root Gate Work child
-> check every declared Gate checklist item and read it back as checked
-> only then deliver the Root
```

这是Harness给Agent的确定性工作规则，不是Conductor生成的Leaf dispatch。Conductor不保存Queue、
Cursor或“当前Leaf”；RootTurn contract也没有`target_issue_id`。

V3只有一个writer，因此同一Root最多一个Agent-owned Work Leaf处于In Progress。Human child可以在
等待期间处于In Progress并分配给用户。多个Agent-owned In Progress Work是Linear冲突；Harness
停止Root并要求修复，不能任选一个作为恢复checkpoint。

用户新增、嵌套、重排、取消或重开children后，当前command的remote precondition可能失败；Agent
必须read-back，并在同一个或下一个Root Turn按最新Tree重新解释。

## 7. Work完成证据

Work使用Linear native state：

```text
Todo -> In Progress -> In Review -> Done
Todo | In Progress | In Review -> Canceled
In Review | Done -> In Progress  when more work is required
```

Agent处理Work Leaf时：

1. read-back确认它仍属于当前Root且是当前顺序下可行动的Leaf；
2. 将其置为In Progress；
3. 修改Root worktree并运行相关checks；
4. 通过broker创建Git commit；
5. 写一条可读的Work Completion Comment，包含summary、checks和commit SHA；
6. read-back确认后把Work置为In Review。

Completion Comment marker可以记录`issue_updated_at + commit_sha + write_id`，用于幂等补写和判断
完成后业务内容是否被修改。它是Linear/Git上的完成证据，不是Conductor内部checkpoint，也不表示
下一Leaf。缺失或不匹配时，Root Agent重新审计该Work；不能根据旧Result直接补成完成。

进程在任一步中断时，新的Root Turn看到当前Linear state、既有commit和worktree diff后收敛：可以
补写缺失证据、继续工作或返工，但不会恢复旧Leaf process/attempt。

## 8. Human输入

Human Node分为Plan Approval、planned input和runtime input，但都使用同一种Linear表达：

- 一个真实child Issue；
- `[Human Action]` title prefix和closed kind marker；
- human assignee；
- In Progress表示等待回答；
- answer写在该Issue thread；
- Done表示回答可被Root Agent消费；
- Canceled表示该输入被放弃。

Agent需要新输入时必须先创建或复用Human child并写清问题，再结束Root Turn。下一次Root scheduling
从Tree看出该Root `waiting_human`，不会启动Performer。用户完成Human child后，Root自然重新变为
runnable；不需要Conductor恢复命令或checkpoint。

普通Comment不是命令。只有对应Human child thread中的回答作为业务输入，且仍受untrusted human
context规则约束。

## 9. Root Gate与Rework

当非Canceled Tree中没有未完成Work/Human时，Root Agent必须创建或复用唯一的`[Root Gate]` managed
Work child，并对整个Root目标、Tree、Git diff、commits和checks执行fresh Root Gate。Root Gate仍
不是Performer Turn variant或Conductor phase；它必须作为Linear Tree中的可读、可read-back的Sub Issue
存在。

Gate child description必须包含以下严格、可解析的Markdown checklist，项目顺序和文字不可改变：

```markdown
## Root Gate Checklist
- [ ] `root-facts`: Root目标和最新Root facts仍然一致
- [ ] `work-evidence`: 每个有效Work child都有匹配的completion evidence
- [ ] `git-checks`: 声明的Git checks通过，且worktree状态符合交付要求
- [ ] `blockers`: 所有Root blocker都处于Done或Canceled
- [ ] `delivery`: 当前commit和delivery branch满足Root delivery precondition
```

只有每一项都由Root Agent在本次fresh检查后更新为`[x]`，并通过Linear read-back确认顺序、
文本和Root parent都正确，Gate child才可进入Done；Gate checklist缺失、重复、乱序、未知项或
任何未勾选项都使Gate失败。任何Gate child都不得由E2E fixture预置。

Gate失败：

- 在Root写可读findings；
- 保留Gate child及其未通过的checkbox；
- 创建或重开一个`[Rework] Root Gate Findings` Work child；
- 保留已经完成的Work和Git事实；
- 结束Turn，等待该Rework按正常Tree顺序处理。

Gate通过：

- 确认所有有效Work completion evidence仍匹配；
- 把仍在In Review的有效Work置为Done；
- read-back确认Gate child的五个checklist item均为`[x]`；
- 调用closed `symphony root deliver` command。

Gate结论不保存为本地checkpoint。Gate通过后若在delivery前崩溃，新Conversation或新Turn必须从
最新Tree/Git重新审核；重复Gate允许且必须幂等。Root或Work内容、blocker、Git HEAD或checks变化会
使旧delivery precondition失败。

## 10. Delivery

`symphony root deliver`由Conductor执行并在命令时重新验证Root ownership、Root state、Tree、
blockers、Git HEAD、checks和已有delivery：

```text
gh available + push + PR success -> pull_request
otherwise push succeeds           -> remote_branch
otherwise                         -> local_branch
```

交付事实写入Git/SCM和Root Primary Status Comment，Root进入In Review但不自动Done。重复请求先查找
deterministic branch/PR并收敛，不能创建重复PR。

Root处于In Review后新增或重开Work时，Root回到In Progress并重新进入Root scheduling；完成新Work
后重新Gate和交付。

## 11. Conversation loss与Root retry

正常process crash或Turn timeout保留current `performer_id`，下一次Root Turn尝试resume。只有Provider
明确返回`conversation_not_found`/`conversation_unrecoverable`，或Root current指针确实缺失时，
触发Root-level retry：

```text
cancel the old Turn and terminate its process tree
-> preserve all Linear/Git facts
-> require current performer_id == failed ID or none, matching the observed loss
-> append Root retry comment
-> open a new Conversation with the pinned Profile
-> compare-and-set current performer_id from that expected value to the new ID
-> rebuild the entire RootRunView
-> return the Root to Root scheduling
```

新Conversation首先审计整个Root，不接收“恢复这个Leaf”的prompt。Root retry不统一重置Leaf状态、
不删除children、不reset worktree、不清除commits，也不恢复旧Result。旧Conversation的迟到command、
Event和Result因为current pointer不匹配而失效。

若这次新Conversation创建也失败，Conductor不执行pointer CAS，也不再自动调用
`openRootConversation`。它在Root Primary Status Comment中稳定写入`Conversation: action required`、
`Activity: failed`、expected failed ID或`none`、closed failure code、evidence source、`observed_at`和
operator action，并把marker写成`retry_blocked: true`及对应expected pointer/failure/observation，
再append一条相同evidence的去重terminal Timeline Comment。只要该block仍与Linear current pointer
匹配，重启和后续poll都把Root评估为`needs_attention`；不得因内存状态丢失而重新进入自动retry。
它不是attempt counter，只能由带matching precondition的显式operator acknowledge清除。

## 12. Root变化与用户编辑

不创建Source Revision、Plan Revision或本地input checkpoint。变化处理使用Linear remote version、
受管Plan/Completion Comment marker和Git commit事实：

- Root title/description在非终态变化：当前command因precondition失效；Root Agent重新审计并更新Plan；
- Todo/In Progress Work变化：Agent使用最新内容继续或返工；
- In Review/Done Work的业务内容晚于Completion Comment：Root Agent重开该Work并重新完成；
- Human answer变化且影响已完成Work：Root Agent重开相关Work；
- 用户新增/重排Tree：下次read-back立即生效；
- Done/Canceled Root不自动重开。

这些判断从Linear/Git事实完成，不需要隐藏的input hash、Leaf cursor或attempt journal。

## 13. 错误可见性

`needs_attention`不是持久Conductor状态。Harness从当前事实发现无法安全继续时：

- 在Root Timeline写一条去重、脱敏、可执行的原因；
- 在Primary投影`failed`及其客观evidence/`observed_at`，再best-effort同步Label；
- 释放Agent lane；
- 后续周期重新读取事实，问题消失后Root自然恢复runnable。

Conversation loss本身走Root retry，不把Leaf标成failed。新Conversation无法创建、Profile未ready、
Root ownership冲突、多个In Progress Work或Git identity冲突才需要operator action。新Conversation
创建失败后以Primary marker中的closed Root Retry Block停止自动重试，不保存attempt counter，也不能
无限循环。

## 14. 不变量

1. Root是唯一调度、Conversation和retry单元。
2. Linear Tree是唯一Workflow结构，Linear sibling order是唯一Root内部顺序。
3. Leaf没有Conversation、dispatch、worktree、cursor、attempt或recovery checkpoint。
4. Work Group不执行；Canceled subtree不执行。
5. V3单writer下最多一个Agent-owned Work Leaf处于In Progress。
6. Plan、Human、Work、Gate、Rework和Delivery都必须在Linear/Git上留下人可理解的事实。
7. Root Gate审核整个Root，并以唯一的managed `[Root Gate]` Work child留下严格
   Markdown checklist事实；它不是独立Performer Turn或持久phase。
8. current `performer_id`只表达Root Conversation continuation，可以通过Root retry替换。
9. Root retry保留全部Linear/Git事实并拒绝旧Conversation副作用。
10. waiting/working/failed/delivered投影必须带客观evidence和freshness；Agent summary不是状态依据。
11. Conductor没有Root Run、Leaf、Queue、Gate、checkpoint、attempt或Result数据库。
12. Result/Event/process exit不能替代Linear/Git read-back。

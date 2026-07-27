# Root Issue工作流事实

状态：目标架构提案。本文是Root Tree、Issue kinds、Linear status subsets、DAG和native archive语义的唯一事实源。
durable authority与恢复规则只见[Workflow Authority与恢复](workflow-authority-recovery.md)。

## 1. Root Tree

```text
Root Issue
├── Cycle Issue 1
│   ├── Plan Issue*
│   ├── Work Issue*
│   ├── Verify Issue*
│   └── Finding Issue*
├── Cycle Issue 2
│   └── ...

Root comments
└── Human Action request/resolution threads
```

Root是workspace、delivery、convergence和恢复单位。Cycle是一次有明确Plan、执行DAG和验证结论的尝试。Plan、Work、
Verify和Finding必须是Cycle直接子Issue。Human Action只存在于Root comment threads，通过native Issue mention引用exact target；
完整规则由[Human Action](human-actions.md)定义。

Root current description是当前用户需求的唯一正文authority，包含objective、included/excluded scope、constraints、
acceptance criteria、verification requirements和明确delivery instruction。会改变重建输入的人类回答必须先合并到Root
description；不存在Spec Issue、contract record或repository task file。

## 2. Issue kind与身份

每个workflow Issue恰有一个primary kind label：

```text
Root | Cycle | Plan | Work | Verify | Finding
```

Issue identity只使用Linear native ID。kind必须同时满足primary label和parent topology；缺label、多个primary kind labels、
非法parent或跨Root relation使Root fail closed。title、description文本和创建顺序都不是identity。

附加labels只表达有限枚举，例如Finding severity、Verify conclusion或`Execution Invalidated`；它们不能
保存任意payload、digest、attempt ID或私有状态。Symphony不在description/comment写JSON、marker或machine envelope。

## 3. Linear status catalog

Team必须配置并验证以下display statuses：

| Linear category | display statuses |
|---|---|
| Backlog | `Draft` |
| Unstarted | `Todo` |
| Started | `Planning`, `Sealed`, `Executing`, `Verifying`, `In Progress`, `In Review` |
| Started | `Needs Approval`, `Needs Info`, `Inconclusive`, `Escalated` |
| Completed | `Succeeded`, `Changes Required`, `Done` |
| Canceled | `Interrupted`, `Canceled`, `Failed` |

每种kind只允许本文后续列出的status子集。native archive flag与status正交：archive决定active membership，不等于
`Done`或`Canceled`，也不删除comments、relations或Activity。

## 4. Root lifecycle

```text
Todo -> In Progress -> In Review -> Done
In Progress -> Needs Approval | Needs Info | Escalated -> In Progress
In Review -> In Progress
any nonterminal -> Canceled
```

| Status | 含义 |
|---|---|
| `Todo` | 已delegate但尚未开始 |
| `In Progress` | 可以推进Root或当前Cycle |
| `Needs Approval` | 至少一个blocking Approval/Permission Human Action open |
| `Needs Info` | 至少一个blocking Information Human Action open |
| `Escalated` | native事实冲突、mechanical failure或需要人工处置 |
| `In Review` | exact verified Git revision已交付，等待用户或SCM接受 |
| `Done` | 用户或SCM接受交付 |
| `Canceled` | Root terminal |

Human Action并发与Root summary precedence只由[Human Action](human-actions.md)定义。Root `In Review`的Git条件只由
[Git Worktree与交付](git-worktree-delivery.md)定义。

## 5. Cycle lifecycle

```text
Draft -> Planning -> Sealed -> Executing -> Verifying
Planning | Sealed | Executing | Verifying -> Inconclusive | Escalated
Verifying -> Succeeded | Changes Required
Inconclusive | Escalated -> Planning | Executing | Verifying | Changes Required
any nonterminal -> Canceled
```

| Status | 含义 |
|---|---|
| `Draft` | fresh Cycle存在，尚未开始Plan |
| `Planning` | fresh Plan正在生成或等待review |
| `Sealed` | exact Plan已批准，initial DAG已materialize并read-back |
| `Executing` | 正在推进Work DAG |
| `Verifying` | Verify针对immutable revision运行 |
| `Inconclusive` | 证据不足，需要fresh决策 |
| `Escalated` | blocking Human Action或mechanical inconsistency |
| `Succeeded` | verification和Cycle conclusion成功 |
| `Changes Required` | 当前Cycle terminal但Root需求未满足 |
| `Canceled` | 用户取消、supersession或execution generation失效 |

一个Root最多一个active nonterminal Cycle。successor Cycle用native predecessor relation连接，不能建立跨Cycle execution
dependency。

## 6. Plan、Work与Verify lifecycle

```text
Plan:   Todo -> In Progress -> In Review -> Done
Work:   Todo -> In Progress -> Done
Verify: Todo -> In Progress -> Done

any In Progress -> Interrupted | Failed | Canceled
any Todo         -> Canceled
```

`Todo`是唯一可dispatch状态。`Interrupted`、`Done`、`Failed`和`Canceled`都是terminal attempt；新的执行必须创建fresh
Issue，并以native predecessor/replacement relation连接，不能把旧Issue改回`Todo`。

Plan `In Review`表示description中human-readable Plan已经固定，等待exact Plan Approval。Approval有效后Plan进入`Done`，
Cycle进入`Sealed`。Plan description在`In Review`后发生编辑会使现有approval失效；必须创建fresh Plan，不能覆盖旧Plan。

Work `Done`要求matching Git变化和required checks可验证。Verify `Done`只表示该Verify attempt给出了closed conclusion；
结论由附加label限定为`Passed`、`Changes Required`、`Inconclusive`或`Contract Violation`，并由Finding Issues和Git evidence
支持。Cycle状态表达后续业务结论。

进程丢失留下的`In Progress`节点按
[Workflow Authority与恢复](workflow-authority-recovery.md)收敛；本文不复制恢复流程。

## 7. Plan与DAG

Cycle从一个Plan开始：

```text
Cycle(Planning)
└── Plan(Todo | In Progress | In Review)
```

Plan description是用户可读、immutable-after-approval的Plan contract，至少包含objective、scope、assumptions、constraints、
acceptance criteria、verification requirements、Work proposals、dependency proposal和required checks。它不包含机器JSON。

Plan Approval是Root上的Human Action comment thread，正文native-mention exact Plan。批准后Root Reconciler提出initial graph，
Conductor创建Work/Verify Issues与`blocks` relations并fresh read-back：

```text
Cycle(Sealed | Executing)
├── Plan(Done)
├── Work*(Todo or terminal attempt)
└── Verify*(Todo or terminal attempt)
```

规则：

- Work ready要求active、`Todo`、全部active dependencies为`Done`且matching Git evidence仍存在；
- 一个Work turn只执行一个Work Issue，同Cycle Work thread可以跨多个fresh Work Issues复用；
- approved Plan不原地修改；scope或acceptance变化创建fresh Plan并supersede旧Plan；
- approved scope内的DAG调整创建、archive或replace native Issues/relations，不保存parallel patch object；
- Verify只针对所有required active Work完成后的immutable Git revision；
- archived Issues不参与ready或dependency satisfaction。

## 8. Finding

Finding是Cycle直接子Issue，使用`Finding` primary label、severity/category labels和relation指向matching Verify/Work。

```text
Todo -> Done | Canceled
```

- `Todo`：unresolved，阻止不允许该severity的Cycle成功；
- `Done`：已由fresh evidence证明resolved；
- `Canceled`：duplicate、invalid或有matching approved Finding Waiver Human Action thread。

description和comments保存用户可读的观察、影响、复现与证据。waiver不能只靠comment、reaction或label推断；其scope和actor
由[Human Action](human-actions.md)定义。

## 9. Native execution evidence

Stage typed Result是transient cross-process output。Conductor在同一bounded materialization中把它转成以下native facts：

| Role | Durable native facts |
|---|---|
| Plan | Plan description、status、labels、Plan Approval relation、materialized child DAG |
| Work | Work status、meaningful result comment、Git diff/commit/check evidence、successor relations |
| Verify | Verify status/conclusion label、Finding Issues、meaningful evidence comment、verified Git revision |
| Root Review | Cycle terminal status、successor relation或Root delivery state |

comment只保存用户需要理解的结论、阻塞原因或证据，不保存model output envelope、usage、correlation或内部receipt。精确
model/token usage属于runtime observability。

attempt、budget和progress从native Issue数量、relation链、timestamps、statuses、Findings及Git current facts推导。不得
创建parallel assessment、outcome或budget objects。

## 10. 用户与外部修改

用户可以修改description、status、labels、relations、archive和comments。Conductor只验证结构和preconditions；业务语义
由fresh Root Reconciler解释。

- Root description的semantic change可能使当前Cycle terminal并创建successor；
- approved Plan被编辑后approval失效，旧Plan归档，fresh Plan重新review；
- 用户把terminal Work改回active是invalid lifecycle，Root进入`Escalated`等待显式处理；
- 人类comment通过native receipt/reply进入Root输入，不能当作隐藏command；
- 外部automation与unknown actor mutation不得静默视为Symphony成功事实。

## 11. 不变量

1. status拥有lifecycle，archive拥有active membership，labels/parent/relations拥有kind与topology。
2. Issue native ID是唯一identity；description/comment不含Symphony机器payload。
3. Root description是current requirement authority；Plan description是exact approved Plan authority。
4. Finding是native Issue；Human Action是Root native comment thread，二者都不使用private machine payload。
5. Dispatcher只派发`Todo`；terminal attempt只能由fresh successor替代。
6. Stage transport Result必须转成native Linear/Git facts并read-back后才能影响下一步。
7. 完整Root读取始终包含active和archived descendants。

# Root Human Action Comment交互与恢复

状态：目标架构提案。本文是Human Action Root comment thread、actor、scope、resolution和supersession的唯一事实源。
Human Action不是Issue、machine payload、generated workflow event或Desktop object。

## 1. 决定

Plan Result进入review时，Conductor按本文模板机械创建exact Plan approval request。需要补充信息、授予权限、waive Finding或
其他业务选择时，matching Root semantic gate提出top-level request comment。所有scope都host在Root；Cycle或Stage scope通过正文
中的Linear native Issue mention指向exact target。

```text
Root comments
├── Human Action request A
│   ├── human replies
│   └── Symphony resolution/clarification replies
└── Human Action request B
```

用户只回复ordinary Markdown，或使用Linear原生thread resolve/reopen。用户不输入command、action ID、digest或JSON。

## 2. Request identity与类型

Human Action request由以下原生事实识别：

- comment是Root上的top-level comment；
- author是当前Binding验证过的Symphony actor；
- body使用本文定义的一个用户可见heading；
- body包含可独立回答的request和必要的native Issue mentions；
- native comment ID是request唯一identity；
- replies、reactions、resolved state和Activity属于同一native thread。

允许的visible headings：

```text
需要你审批
需要你补充信息
需要你授权
需要你确认 Finding 豁免
```

heading是用户界面文案与semantic cue，不是隐藏wire format。Request identity由author、host Root、exact target mention、Activity和
target version共同证明，不能只靠heading或正文位置。Conductor机械验证closed Plan approval predicate；其他自然语言thread由matching
Root semantic gate解释。不存在comment parser把正文反序列化成private object。

## 3. Scope与target

- Root scope：request明确说明影响整个Root，可以mention Root本身；
- Root Decision：只由`terminal_review.request_root_decision`机械映射，必须mention Root本身；它表达产品取舍，不伪装成Permission；
- Cycle scope：必须mention exact Cycle；
- Plan Approval：必须mention exact Plan，用户直接阅读该Plan description；
- Permission：必须mention需要权限的exact Work或Plan；
- Finding Waiver：必须mentionexact Finding及其Verify/Cycle context。
- 同一Changes Required Verify存在多个开放Finding时，一个waiver request必须mention该冻结集合中的每个Finding exactly once；不能按单Finding
  拆成多次Root决策，也不能只引用Verify或Cycle替代Finding target。

approval、root decision、permission或waiver只对mentioned target及request创建时的target内容有效。target发生semantic edit、replacement、
archive或new verified revision时，旧thread只保留历史，不授权fresh target；Root Reconciler写superseded reply、resolve旧thread并
创建fresh request。

## 4. Request正文

正文先给出decision/question，再给出scope和影响。Information可以批量包含强相关问题，但每个问题必须：

- 能由用户直接回答；
- 说明为什么当前Linear/Git/repository facts不能推导答案；
- 说明答案影响哪个target；
- 避免询问Symphony可自行查证的信息；
- 不包含secret、raw reasoning、Provider transcript、usage或内部correlation。

正文可以使用heading、列表、表格、链接和native Issue mention，但不能包含JSON block、HTML marker、machine fields或“已记录
ownership”一类内部receipt。

## 5. Actor与有效回复

Root natural human来自Root current assignee/creator和Project policy。只有该human或policy明确授权的人类actor的reply可以
形成approval、rejection、answer、root decision、permission或waiver。

以下都不能形成human resolution：

- Symphony自己的reply；
- external automation或unknown actor reply；
- reaction-only变化；
- thread被resolve但没有可解释的人类回答；
- 沉默、emoji或与request无关的comment；
- 对另一个thread或另一个target的选择。

actor无法证明时保持pending并fail closed，不从显示名或文本签名猜测。

## 6. Active与resolved语义

一个request在其业务resolution尚未materialize时是active。native `resolved`只是thread current state，不单独证明批准或回答。

有效resolution必须形成以下可重建组合：

```text
authorized human reply
-> matching Root semantic disposition
-> native target consequence read-back
-> concise Symphony resolution reply
-> matching receipt reaction on the human reply
-> thread resolved
```

多Finding waiver是该顺序的显式两阶段特例，因为Linear不提供原子multi-Issue mutation。Root Reconciler将exact authorized human reply
解释为accepted后，Conductor先写canonical visible adoption reply，但不加receipt、不resolve thread，也不改变Finding；该adoption reply
只是与request、authorized human reply、originally mentioned targets及current Activity共同组成native authorization barrier，不能单独
自证。之后每个Finding作为独立effect收敛并read-back。全部target consequence成立后才补check receipt和thread resolved，最终仍满足
上述组合。进程内intent、Provider memory、hidden JSON、bare reaction或只匹配heading均不能成为waiver authority。

若human提前resolve thread但target consequence不存在，Conductor保持pending，并在存在歧义时进入matching semantic gate以reopen或
请求澄清。若human在resolution后reopen或编辑answer，Activity形成fresh input；旧target consequence不会被静默撤销。

check reaction表示matching human reply已采用；cross reaction表示未采用，必须有简短原因。reaction不表达approval本身。

## 7. Information与Root description

Information回答不充分时保持active，并在同thread回复缺口。充分时：

- 改变Root需求或worktree-loss rebuild input：先合并Root description并fresh read-back；
- 只影响exact Cycle target：先materialize matching native target consequence；
- 相互矛盾：保持active并请求clarification，不能猜一个值。

只有上述native consequence成立后才能写resolution reply和resolve。原human answer、actor和Activity永久保留在thread中；
worktree丢失后Root description仍保存已确认需求。

## 8. Approval、rejection与waiver

Conductor机械验证authorized actor、exact target mention和unchanged target version，但不通过字符串或heading解释reply含义。Plan
approval、rejection和ambiguous reply全部进入`plan_human_decision`；permission和waiver进入matching semantic gate：

- approved、permission和waiver：解释并materialize exact target允许的native next state；
- rejected：使matching attempt terminal并选择replacement、replan或结束Cycle；
- ambiguous：保持active并直接追问。

Plan approval的首个native consequence是exact Plan进入`Approved`；这是DAG partial-write recovery的authorization barrier，不是
完成状态。完整DAG read-back后Plan才进入`Done`且Cycle才可`Sealed`。target Plan edit会使approval superseded；`Approved`后编辑不得
按新内容继续执行。Finding waiver只允许matching Finding按policy进入waived terminal state，不改变其他Finding或Verify revision。
Finding waiver request正文的visible target section必须列出complete Finding set exactly once，并提供matching Verify/Cycle context；
fresh convergence以该originally mentioned set为授权范围，不能从mutation后缩小的open set反推原scope。

Symphony不能代表human写approval，也不能从✅、thread resolved或Root status反推一个不存在的human选择。

## 9. 并发与Root summary

一个Root可以有多个active request threads。Root summary status由所有active requests收敛：

```text
any active approval / root decision / permission / waiver -> Root Needs Approval
else any active information                               -> Root Needs Info
else no blocking request                                   -> Root In Progress
```

关闭一个thread不能解除另一个barrier。Conductor可以推进与open request无关且不会使其target过期的机械工作，但必须阻止跨越
matching target barrier的dispatch；存在是否会使target过期的业务歧义时进入semantic gate。

## 10. Recovery与worktree loss

恢复读取Root上的全部request threads、replies、reactions、resolved state、actor和Activity，并与Root/target current facts一起运行
deterministic transition；只有semantic gate消费matching facts。没有本地pending-action表、consumed-input list或private resolution payload。

worktree丢失时所有threads继续保留在Root：

- 已纳入Root description的信息仍是fresh rebuild input；
- 引用旧Plan/Work/Verify/Finding的approval、permission和waiver只保留为历史；
- fresh targets需要fresh request thread，不继承旧resolution。

整树重建步骤只见[Workflow Authority与恢复](workflow-authority-recovery.md)，本文不复制恢复算法。

## 11. 不变量

1. Human Action只存在于Root native comment threads，不创建Issue。
2. request与reply是普通用户可读Markdown，不包含JSON、marker或private schema。
3. native comment ID、thread topology、actor、reactions、resolved state和Activity保留恢复事实。
4. 只有authorized human reply可以形成resolution；reaction和resolved state本身不是approval。
5. Requirement-changing answer在thread resolve前进入Root description。
6. resolution不跨replacement target继承。
7. Plan、Work、Verify、Desktop和E2E driver都不能创建或解决Human Action。

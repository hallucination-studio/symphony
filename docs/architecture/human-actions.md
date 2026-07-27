# Root Human Action Comment交互与恢复

状态：目标架构提案。本文是Human Action Root comment thread、actor、scope、resolution和supersession的唯一事实源。
Human Action不是Issue、machine payload、generated workflow event或Desktop object。

## 1. 决定

需要人类批准、补充信息、授予权限或waive Finding时，Root Reconciler提出在Root Issue创建一个top-level request
comment。所有scope都host在Root；Cycle或Stage scope通过正文中的Linear native Issue mention指向exact target。

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

heading是用户界面文案与semantic cue，不是隐藏wire format。Root Reconciler解释完整自然语言thread；Conductor只机械验证
author、host Root、target mentions、actor和native postconditions。不存在comment parser把正文反序列化成private object。

## 3. Scope与target

- Root scope：request明确说明影响整个Root，可以mention Root本身；
- Cycle scope：必须mention exact Cycle；
- Plan Approval：必须mention exact Plan，用户直接阅读该Plan description；
- Permission：必须mention需要权限的exact Work或Plan；
- Finding Waiver：必须mentionexact Finding及其Verify/Cycle context。

approval、permission或waiver只对mentioned target及request创建时的target内容有效。target发生semantic edit、replacement、
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
形成approval、rejection、answer、permission或waiver。

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
-> Root Reconciler semantic disposition
-> native target consequence read-back
-> concise Symphony resolution reply
-> matching receipt reaction on the human reply
-> thread resolved
```

若human提前resolve thread但target consequence不存在，Root Reconciler将其视为pending input并reopen或请求澄清。若human在
resolution后reopen或编辑answer，Activity形成fresh input；旧target consequence不会被静默撤销，由fresh Root Reconciler决定。

check reaction表示matching human reply已采用；cross reaction表示未采用，必须有简短原因。reaction不表达approval本身。

## 7. Information与Root description

Information回答不充分时保持active，并在同thread回复缺口。充分时：

- 改变Root需求或worktree-loss rebuild input：先合并Root description并fresh read-back；
- 只影响exact Cycle target：先materialize matching native target consequence；
- 相互矛盾：保持active并请求clarification，不能猜一个值。

只有上述native consequence成立后才能写resolution reply和resolve。原human answer、actor和Activity永久保留在thread中；
worktree丢失后Root description仍保存已确认需求。

## 8. Approval、rejection与waiver

Root Reconciler从authorized human reply解释明确选择：

- approved/authorized/waived：materialize exact target允许的native next state；
- rejected：使matching attempt terminal并由fresh decision创建replacement或结束Cycle；
- ambiguous：保持active并直接追问。

Plan approval后Plan进入`Done`且Cycle才可`Sealed`；target Plan edit会使approval superseded。Finding waiver只允许matching Finding
按policy进入waived terminal state，不改变其他Finding或Verify revision。

Symphony不能代表human写approval，也不能从✅、thread resolved或Root status反推一个不存在的human选择。

## 9. 并发与Root summary

一个Root可以有多个active request threads。Root summary status由所有active requests收敛：

```text
any active approval / permission / waiver -> Root Needs Approval
else any active information               -> Root Needs Info
else no blocking request                   -> Root In Progress
```

关闭一个thread不能解除另一个barrier。Root Reconciler可以推进与open request无关且不会使其target过期的工作；Conductor必须
阻止跨越matching target barrier的dispatch。

## 10. Recovery与worktree loss

恢复读取Root上的全部request threads、replies、reactions、resolved state、actor和Activity，并与Root/target current facts
一起交给fresh Root Reconciler。没有本地pending-action表、consumed-input list或private resolution payload。

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

# Linear端到端流转、Root调度与SDK所有权

状态：目标架构提案。本文是Project解析、Root发现、调度、分页和Linear SDK ownership的唯一事实源。workflow recovery只见
[Workflow Authority与恢复](workflow-authority-recovery.md)。

## 1. Linear SDK所有权

Podium独占Linear SDK、OAuth、tokens、installation和GraphQL details。Conductor只依赖`LinearGatewayInterface`的closed
query/mutation contracts。SDK objects、lazy models、credentials和GraphQL payload不能跨process boundary。

Podium执行bounded native mutation并返回fresh semantic read-back；它不解释Root业务语义、不生成machine comment、不保存
workflow state。

## 2. Project与routing

每个Conductor Binding关联一个Linear Project、Repository Context、Performer Profile和一个Conductor Project Label。Root只有
同时满足以下条件才进入candidate set：

- 属于matching Project/Team；
- 带matching Conductor Project Label；
- native delegate指向当前Binding验证过的Symphony actor；
- Root primary kind label、status和archive状态允许admission。

undelegated Root零副作用：不改status、不写comment、不创建worktree、不调用Performer。delegation撤销是owned Root的fresh
native input；Conductor停止新dispatch并交给Root Reconciler决定业务后果。

Root的唯一Conductor Project Label把它route到一个Binding；同一Binding的single-live-process fencing由
[Runtime Hardening](runtime-hardening.md#3-multi-binding-process-ownership)定义的OS-backed `BindingProcessFence`和Podium
private-channel generation共同证明。Conductor内部可以用memory-only `RootIterationGuard`合并duplicate wake并防止同一进程
并发推进同一Root，但它不是跨进程distributed lease，也不是durable workflow fact。

调用Root或写入前必须同时重新验证matching routing、Binding process fence/generation、Root/target native preconditions和worktree writer
identity。任一条件变化都取消matching call并拒绝late output。无法取得exclusive Binding fence时Host和Conductor都fail
closed；不得用Linear comment、label、数据库row或普通lease payload仲裁winner。

## 3. Root header discovery

Root header query在分页内一次取得eligibility所需native facts：

```text
issue id
project/team
status + category
primary/route labels
delegate/assignee
priority + updated_at
archive flag
parent identity
```

禁止page返回后逐Root触发SDK lazy reads。header discovery不读取全部comments或descendants，也不推断workflow next step。
duplicate route labels、invalid kind、unknown status或coverage缺口fail closed。

## 4. 完整Root object graph

只有Root通过header admission并获得进程内iteration guard后，Conductor才读取完整graph：

- Root current fields；
- 全部active和archived descendants；
- statuses、labels、parent/child、relations和archive flags；
- comments、threads、reactions、attachments和required Activity；
- actor provenance、remote versions/timestamps与coverage；
- matching Git/SCM facts。

每种connection都分页至`hasNextPage = false`。Podium返回explicit coverage和omissions；Conductor不能用webhook cache、旧snapshot
或本地index补齐。权威对象范围只由Workflow Authority文档定义。

## 5. Scheduling

调度只决定“哪个eligible Root先获得一次reconciliation机会”，不决定Root内下一步。排序使用Project policy允许的native
Priority、updated time和fairness。capacity、rate limit和runtime health只影响何时运行，不写回workflow状态。

Root内部dispatch由Root Reconciler选择，Conductor机械验证target active且为`Todo`。terminal节点永不自动dispatch。

## 6. Root内部调用

```text
header admission + RootIterationGuard
-> complete Root object graph + Git read
-> worktree gate
-> fresh/open Root Reconciler
-> one RootNextAction
-> bounded native Linear/Git materialization
-> fresh read-back
-> release iteration guard or continue fairly
```

worktree gate、normal recovery和missing-worktree rebuild只链接
[Workflow Authority与恢复](workflow-authority-recovery.md)，本文不复制步骤。

## 7. Mutation语义

所有mutation使用explicit target和remote/current preconditions，并收敛到一个closed native desired state。create/update/read-back
ambiguous时重新读取完整relevant subtree；不能依赖local write ID、comment payload或command replay。

User status、description、label、archive、relation和comment changes都作为fresh native facts交给Root Reconciler。Conductor只拒绝
schema、coverage、actor、topology、capability或Git safety violation，不主动“修正”用户语义。

## 8. Comment边界

Conductor只创建：

- [Human Action](human-actions.md)定义的Root request/resolution thread内容；
- 对ordinary human comment的direct reply或native receipt；
- 用户需要理解的bounded failure、verification或delivery explanation。

status流转由Linear native Activity展示。业务mutation成功不生成额外Root/Cycle comment；heartbeat、tool progress、claim、
read-back和internal decision只进入runtime logs/metrics。

## 9. End-to-end flow

1. Human在Linear创建Root，填写description、Project、Root和routing labels。
2. Human native-delegates Root给Symphony actor。
3. Podium header query发现candidate；Conductor获得进程内`RootIterationGuard`并fresh验证routing/process generation。
4. Conductor读取完整native graph与Git，并执行worktree gate。
5. Root Reconciler DEFINE requirement或创建fresh Cycle/Plan。
6. Plan proposalmaterialize为Plan description；Human通过Root request threadreview。
7. approval后Conductor创建native Work/Verify DAG。
8. Root Reconciler逐个选择ready `Todo` Work；Conductor materialize native results与Git evidence。
9. Verify针对immutable revision，Findings作为native Issues。
10. Root Reconciler REVIEW并选择successor、Human Action或delivery。
11. Conductor完成Git/SCM delivery并把Root置`In Review`；human/SCM接受后`Done`。

## 10. 不变量

1. Podium独占Linear SDK和credentials；Conductor只见closed gateway contracts。
2. 未delegate Root零副作用。
3. Root routing使用唯一native label；single-live-process由Host fencing保证，进程内duplicate wake只由
   `RootIterationGuard`合并，三者都不增加workflow ownership事实。
4. header discovery与完整graph读取分离，二者都必须证明分页coverage。
5. Conductor不运行模型；Root内语义只来自Root Reconciler。
6. Linear current native objects + Git是durable authority。
7. Comment只服务human communication，不是event log或machine store。
8. Conductor无workflow DB、queue、checkpoint、DAG mirror或dispatch table。

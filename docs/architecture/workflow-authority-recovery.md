# Workflow Authority与恢复

状态：目标架构提案。本文是Symphony durable workflow authority、进程重启恢复、禁止重复执行和Root worktree
丢失重建规则的唯一事实源。其他文档只能引用本文，不能复制另一份恢复算法、持久化矩阵或dispatch规则。

## 1. 决定

Symphony只从以下两类事实恢复：

```text
complete native Linear Root object graph + Git
```

Linear中不存在Symphony私有payload、machine serialization、generated event comment、checkpoint或隐藏状态。所有写入Linear的
workflow事实都必须是Linear原生对象或字段；所有写入Git的代码事实都必须能由Git原生命令验证。

Conductor不重放旧next action，也不从comment日志回放command。每次启动都读取当前事实，由pure transition推导当前有效状态、
不一致项和唯一合法的机械后果；只有结果是semantic gate时才调用matching Root Reconciler。Conductor编译mechanical target或
semantic intent，并在每个independently durable effect后fresh read-back。

## 2. 权威对象模型

完整Root object graph至少包含：

| 原生事实 | 用途 |
|---|---|
| Issue native ID、title、description、creator、assignee/delegate、created/updated time | identity、需求、责任人与审计 |
| custom status及其Team category | lifecycle与dispatch eligibility |
| primary kind label及其他workflow labels | Root、Cycle、Plan、Work、Verify和Finding分类与结果限定 |
| parent/child topology | Root Tree、Cycle边界和节点scope |
| issue relations | current Cycle内的DAG dependency和真实native关联；Cycle lineage与recovery successor不伪造relation语义 |
| native archive flag | active membership与历史保留 |
| comments、threads、reactions和actor provenance | 普通人类输入、回答、解释和审计；不承载机器record |
| attachments、links和SCM integration facts | PR、外部证据和交付引用 |
| Linear native Activity及actor/timestamp | status、label、description、relation和comment变更历史 |

读取必须覆盖Root自身以及全部active和archived descendants，并完成分页。缺页、未知kind、非法parent、多个互斥primary
kind labels、无法验证actor，或无法读取required Git facts都会使该Root fail closed；Conductor不能用本地缓存补齐。

Git拥有repository base、branch、commit、tree、diff、checks、PR和delivery事实。Linear可以通过原生attachment、relation、
status和用户可读文本引用Git事实，但不复制一份机器payload。

## 3. 原生身份与唯一性

Issue identity只使用Linear native Issue ID。Issue kind由一个primary kind label与parent约束共同确定：

```text
Root
├── Cycle
│   ├── Plan
│   ├── Work*
│   ├── Verify*
│   └── Finding*
└── Root-hosted Human Action comment threads
```

Symphony不在description中嵌入stable key、digest、JSON或marker。所有Issue create action一次最多创建一个Issue；Plan不得
包含两个在kind、parent、scope、expected outcome、checks和dependencies上无法区分的合法节点。创建请求结果不确定时，
Conductor重新读取完整parent subtree并按native identity、kind、topology、relations和语义内容收敛：

- 恰有一个满足postcondition的对象时复用它；
- 没有满足对象且remote明确拒绝或确认未创建时，才可重新提交同一bounded mutation；
- 出现多个候选或无法证明唯一性时返回invalid facts并停止mutation；存在业务取舍时进入`recovery_strategy`，其high-level intent
  由Conductor compiler决定需要archive、replace还是请求人工处理，模型不返回低层Tree operation。

timeout、connection loss或缺少response不能单独证明未创建，也不能承诺exactly-once。不得通过title字符串、comment文本、
创建顺序猜测identity，也不得为幂等性引入workflow数据库或私有record。

## 4. 恢复入口与worktree gate

Root恢复必须先完成以下gate，之后才能决定是否沿用任何执行节点：

```text
1. fresh-read Root header and complete active/archived Root object graph
2. resolve repository context and deterministic Root worktree path
3. verify that the expected worktree exists
4. if it exists, validate repository identity, branch, HEAD and cleanliness facts
5. choose normal convergence, worktree rematerialization or invalid-generation convergence
```

这里的“存在”不是目录同名即可。worktree必须由Git识别，指向matching repository和Root delivery branch，且没有与另一个
Root共享identity。目录存在但无法验证时fail closed；不能reset、clean或猜测修复。

gate只对runnable Root执行，并先区分：

- fresh Root：没有Cycle/Stage descendants、没有prior branch/worktree/commit/Activity evidence；missing表示首次创建workspace；
- existing execution generation：存在任一Cycle/Stage或prior workspace/Git evidence；missing directory先检查Git authority，
  不能直接判定execution generation失效；
- terminal Root：`Done`或`Canceled`不进入dispatch recovery，按cleanup policy观察即可。

不得仅凭deterministic path当前不存在就把fresh Root标为`Execution Invalidated`。

## 5. worktree存在时的正常恢复

worktree通过gate后，Conductor以完整Root object graph和Git current facts打开fresh Root Reconciler：

```text
read current reality
-> validate topology, lifecycle, provenance and Git consistency
-> derive ready, terminal, interrupted and inconsistent nodes
-> deterministic transition to mechanical target, semantic gate, external wait or terminal
-> call Root Reconciler only for a semantic gate
-> materialize one independently durable Linear/Git effect and targeted read-back
```

恢复不是event replay，也不继续某个已持久化command。live session内必须遵守[Performer](performer.md#51-provider注入分层)
定义的incremental Provider memory contract；只有process/session丢失时，in-memory baseline、opaque continuation、handle和本轮
typed response才整体丢弃，并从当前Linear/Git facts创建fresh initial context。

Work role session还可能包含[Work Subagents](work-subagents.md)定义的Provider agent tree。Work root continuity和每个turn的path、
mailbox、descendant threads及Provider graph在session loss后全部丢弃；不能从Codex persistence恢复旧agent或重放其task。只有
matching workspace write capability永久撤销且`WorkSessionContainment` empty/isolated proof成立后，fresh runtime才可取得Root writer
domain。Partial edits作为Git/worktree current facts保留。

只有新generation已经持有[Runtime Hardening](runtime-hardening.md#3-multi-binding-process-ownership)定义的
`BindingProcessFence`，且Podium已经拒绝旧private channel mutation后，旧process loss才得到机械证明。若matching
`In Progress`节点的唯一合法后果是终止本次attempt，Conductor机械收敛为`Interrupted`，不调用Root Reconciler。旧节点不得自动
重新派发；是否继续、repair或replan存在业务取舍时才进入`recovery_strategy`，继续执行必须使用role-owned fresh successor topology。

对于`Interrupted` Plan的accepted successor intent，恢复授权必须先写成同一Planning Cycle下的fresh Todo Plan。生产projection中
Issue manifest actor为`unknown`时，授权链必须同时证明：Interrupted predecessor的matching current Issue version、其latest status Activity
由exact Symphony delegate actor写入且target仍是current Interrupted status，以及successor的matching current Issue version与immutable creator
等于该actor；successor存在later conflicting field Activity时fail closed。不能让successor creator自证，不能先archive旧Plan后再依赖丢失的
model intent创建replacement。fresh evaluator和fresh compiler必须独立重算同一授权链；两者观察到exact Interrupted predecessor与
authorized successor共存时，才机械archive predecessor，之后仅fresh successor可进入Plan dispatch。
lost create response或进程重启都从这组native facts恢复，不重开Root semantic gate。Archived Plan history不阻塞后续相同恢复。

对于非Finding terminal Stage，shared workflow的`Failed`或`Done`不足以区分blocked、failed与inconclusive。fresh transition仅在exact
role/Cycle phase、terminal status、canonical visible `## Outcome`以及field-specific native provenance一致时构造一个`stage_attempt`
recovery subject。Issue source manifest的composite actor不能作为唯一证明；exact current version、complete Activity coverage、Symphony
delegate创建者、current status/description/parent/archive latest target和label actor history共同组成该Stage conclusion proof。未被later
Symphony exact value覆盖的human edit、
unknown conclusion、多个candidate或status/outcome mismatch均fail closed。accepted information/permission
decision只形成target该terminal Stage的Root-hosted Human Action barrier，不改写或redispatchterminal identity。Finding-bearing Verify由
native Finding set单独进入recovery，不能伪装成generic Stage failure。
Finding set以active Cycle为subject namespace，并以current Changes Required Verify、全部Todo/In Progress Findings及涉及它们的relation topology
形成derived digest；digest同时包含Cycle current version，防止冻结后的人为Cycle edit被后续effect覆盖。fresh compiler必须重算完全相同的集合。accepted semantic `waiver`只映射为一个target全部集合成员的
`finding_waiver` Human Action；该步骤不关闭、archive、relabel或改写Finding。
accepted `end_current_cycle`只更新该exact owning Cycle为`Canceled`并写入一个recovery outcome。全部Finding保持unresolved且version、status、
labels、description与archive state不变；restart从Cycle outcome、Changes Required Verify与open Findings进入non-success `terminal_review`，
不重放recovery intent。

Finding waiver request和reply resolution是两个不同的semantic capabilities。accepted `resolve_finding_waiver`先在exact authorized human
reply下写入一条current Symphony adoption reply，保持human reply无receipt且request thread unresolved。该visible reply与current
waiver request、authorized human reply、originally mentioned Finding set、matching Verify/Cycle topology以及complete current Activity
共同形成native authorization barrier；任何单独一项都不能授权Finding mutation。Conductor随后每次只更新一个Finding为`Canceled`，
每次使用fresh version precondition并targeted read-back。lost response后通过current status和Activity区分已接受与未接受effect；partial
completion不得缩小原授权集合、重新调用Root模型或把remaining open set当作新waiver subject。全部originally mentioned Finding均为
matching waived terminal state后，Conductor才为human reply写check receipt、resolve request thread并恢复Root summary。若adoption reply、
request target、human actor、Finding content/provenance或Verify/Cycle context不再唯一，停止且不继续mutation。

跨Cycle Finding persistence只从Finding-to-Finding `triggered_by`有向单链重建；方向固定为successor指向predecessor，节点不能分叉或合并，
每条边必须连接Root严格时间序列中的相邻parent Cycles。只有archived且仍为Todo/In Progress的predecessor表示连续未解决；Done/Canceled
predecessor会重置count。undirected connectivity、distinct parent count、Issue ID tie-break或跳过Cycle都不是
hard-limit authority。lineage存在时Cycle `created_at`必须严格唯一；否则fail closed。达到`max_same_open_finding_cycles`的active tip先完成
Stage session fence，再由fresh compiler复核完整lineage、complete source coverage、exact version与snapshot，机械将owning Cycle收敛为
`Canceled + Recovery Exhausted`。Finding和relation原样保留；restart允许terminal tip继续作为evidence，但不再触发active-Cycle limit，
直接进入non-success `terminal_review`。

对于`Interrupted` Work或Verify，不允许在current Cycle内克隆approved DAG node或用`relates_to`伪装replacement。accepted successor
intent先创建一个Symphony-authored、带`Interrupted Stage Recovery` label与完整high-level recovery description的fresh Planning
Cycle。该durable fact是唯一的后续授权。生产Issue manifest actor为`unknown`时，`Interrupted Stage Recovery`必须从canonical
predecessor的matching Executing/Verifying phase选择唯一Interrupted Work或Verify；该Stage的exact current version、complete Activity
coverage、latest status Activity actor与current Interrupted status target共同证明delegate actor，successor的exact current version、
successor immutable creator和无冲突field Activity再绑定同一actor。不能由successor creator或label自证。safety、transition与fresh
compiler必须重算同一role-specific actor chain，成立时才允许短暂存在两个active Cycle。随后Conductor leaf-first archive旧subtree和Cycle，
再为successor创建Todo Plan。这样保留approved DAG与Verify evidence作为history，并在lost response或restart后不重复Root turn；普通双Cycle、
wrong role/phase、ambiguous Interrupted source和human-forged provenance仍是mechanical violation。

Delivery rejection的accepted successor intent先以一个带`Delivery Recovery` label和完整high-level attempt goal的fresh Planning Cycle
持久化。其前置delivery subject必须由[Git Worktree与Root交付](git-worktree-delivery.md#52-remote-scm-acceptance)定义的exact Attachment
provenance、immutable revision与fresh SCM observation共同证明，不能依赖生产中不存在的Attachment manifest actor。lost create response后，
transition与fresh compiler从Root current `In Review` status Activity actor重新建立source actor，并要求successor immutable creator等于该actor、
exact current Issue version匹配且不存在later conflicting field Activity。successor creator、`Delivery Recovery` label或description都不能自证。
授权成立后才机械恢复Root为`In Progress`、leaf-first archive成功历史并创建fresh Todo Plan；任一步restart从current facts继续且不重开
delivery recovery semantic gate。

Terminal review选择`start_successor_cycle`时，compiler先创建带`Terminal Review Successor` label与完整high-level objective的fresh
Planning Cycle。生产Issue manifest actor为`unknown`时，唯一授权来源是terminal review冻结的successful predecessor Cycle：其exact
current Issue version、complete Activity coverage和current `Succeeded` status Activity actor共同证明source actor；successor的exact current
Issue version、successor immutable creator和无冲突field Activity必须绑定同一actor。successor label、description或creator不能自证。
transition与fresh compiler独立重算该链后，才机械archive predecessor history并为successor创建Todo Plan；lost response或restart不重开
terminal review gate。Cycle cap、Root deadline、exact Git revision和canonical Cycle lineage仍在create前及每次fresh convergence时fail closed。

当accepted purpose是`replan_current_cycle`时，Conductor先在同一Cycle创建一个Symphony-authored、带`Cycle Replan` label的fresh Todo
Plan；canonical description完整保留planning objective、preserved constraints和interrupted role。这个native fact是唯一的replan
authorization。生产Issue actor为`unknown`时，canonical `## Recovery Source` role必须选择topology中唯一matching Interrupted Stage；
该Stage的exact current version、latest status Activity actor与current Interrupted status target共同证明delegate actor，fresh Plan的exact
current version、immutable creator和无冲突field Activity再绑定同一actor。只有这条role-specific链和canonical content都成立，fresh
transition与fresh compiler才允许该严格的partial topology，并逐effect、
leaf-first archive除fresh Plan外的旧Plan、Work、Verify和Finding。Interrupted Plan的Cycle保持Planning；Interrupted Work或Verify的
旧DAG全部archive后，Conductor再以独立effect把current Cycle从Executing或Verifying改回Planning。之后normal Plan admission只选择
fresh Plan。lost create response或任意archive/status effect后的restart都从current native facts推导remaining effect，不再次调用Root
Reconciler。普通额外Plan、ambiguous authorization、wrong role/phase和human-forged `Cycle Replan` label必须fail closed。

当accepted purpose是`repair_current_cycle`时，Interrupted Plan必须以purpose incompatible fail closed，因为尚无approved execution
scope可供repair。`Cycle Repair`授权由canonical Recovery Source选择唯一Interrupted Work或Verify，并用该Stage的exact current version、
latest status Activity与current Interrupted target证明source actor。fresh repair Work的exact version与immutable creator必须绑定该actor；
Verify repair随后创建的fresh Verify也必须绑定同一actor，不能改从执行中的repair Work status actor取权。Interrupted Work先产生fresh
Todo repair Work；Conductor只把旧Work所有incoming与
outgoing `blocks | blocked_by`关系按原方向逐一克隆到repair Work，完整read-back后才archive predecessor，已有Todo Verify保持不变。
`relates_to`不是readiness dependency，不能复制或伪装replacement。Interrupted Verify同样先产生repair Work，但还必须在archive旧Verify
前机械创建并读回带`Cycle Repair Verify` provenance的fresh Todo Verify；随后Cycle回到`Executing`，只dispatch repair Work。repair Work
完成后normal convergence进入`Verifying`，fresh Verify准备新的immutable target。旧Verify identity及其attachment永远不得复用。
每次只写一个effect并使用fresh actor/version precondition与targeted read-back；部分关系、额外关系、重复marker、human-forged provenance
或wrong phase一律fail closed，restart从native topology继续且不重开Root gate。

当exact Interrupted Plan、Work或Verify的accepted recovery purpose是`end_current_cycle`时，Conductor不创建successor topology，
而以一个independently durable update把current Cycle设为`Canceled`。同一update必须写入且仅写入一个closed outcome label：
`Recovery Exhausted`或`Recovery Abandoned`，并用canonical human-readable description保留bounded explanation和outcome。每次执行都以
fresh Cycle version为precondition并targeted read-back status、labels、description、version和Symphony actor；partial、stale、ambiguous或
human-forged lookalike一律fail closed。restart后pure transition从该terminal native fact构造non-success `terminal_review`，同时冻结Root
requirement、Git HEAD、Verify与Finding classification，不重开`recovery_strategy`。该恢复后果不结束Root，且non-success review不能
选择`deliver_verified_revision`。

正常dispatch中，只有写入`In Progress`并完成targeted read-back的当前同步dispatch调用栈可以继续调用Performer；matching
Root iteration guard在该调用栈结束前拒绝同Root重入。该能力不持久化，也不加入Root facts或transition contract。因此任一
fresh transition观察到`In Progress`时，都表示原dispatch调用栈已不再是当前evaluator，必须执行上述`Interrupted`机械后果，
不能从Provider session、旧execution ID或进程内缓存恢复并重新派发同一Issue。

## 6. worktree丢失时的rematerialization与invalid-generation rebuild

expected Root worktree目录不存在不等于Git code authority丢失。Conductor先fresh验证repository、delivery branch、HEAD、
commit tree和remote/SCM facts：

- matching branch与required commits完整、唯一且cleanly materializable时，pure transition返回
  mechanical workspace rematerialization target；Conductor从该existing branch重建deterministic worktree，然后按正常恢复收敛
  现有任务树，不调用Root Reconciler批准该机械后果；
- branch缺失、identity冲突、required commit不可达或Git facts不足以证明旧代码时，Conductor生成closed
  `ExecutionGenerationInvalid` mechanical fact；只有是否放弃旧execution authority存在业务取舍时才进入`recovery_strategy`。

invalid generation的目标形态如下，但它不是Conductor内部顺序状态机：

1. 当前nonterminal Cycle进入`Canceled`，并增加`Execution Invalidated` label；
2. 全部旧Cycle、Plan、Work、Verify和Finding descendants变为历史并native archive；
3. 旧节点无论原来是`Done`、`Failed`还是`In Progress`，都不能为新执行提供dependency satisfaction、completion或
   approval evidence；
4. 全部Root Human Action threads保留；引用旧执行target的approval只作为审计历史，不能批准fresh target；
5. invalid旧delivery branch和worktree path不复用；Conductor从native invalidated Cycle数推导fresh execution generation ordinal，
   从Root当前repository base创建generation-scoped fresh branch/worktree；ordinal不是持久化counter或模型字段；
6. matching recovery intent只引用Root Reconstruction Set；Conductor compiler创建fresh Cycle、fresh Plan和全新的Work/Verify DAG。

recovery intent一旦授权invalid-generation rebuild，Conductor从current native/Git facts持续机械收敛：terminal/archive旧tree、创建
fresh branch/worktree、编译fresh Cycle/Plan/DAG，并让每个independently durable effect targeted read-back。crash后同一transition从
current facts推导remaining effects，不恢复phase、command或sequence counter，也不再次请求模型选择下一条低层mutation。

Root Reconstruction Set固定为：Root当前description、status、labels、relations、attachments、普通Root human comments、
全部Root Human Action threads及native Activity，以及fresh repository base facts。Provider projection把旧执行子树放入明确的
`invalidated_execution_audit`分区；新intent的source/evidence refs不得引用该分区的Issue、approval或旧branch。Conductor
机械拒绝这种引用，因此不依赖prompt保证隔离。

这不是旧任务重跑：旧Issue永不再次dispatch；系统创建一组native identity不同的新任务。只有Git authority无法证明旧代码
仍然存在时才进入该路径；单纯worktree目录丢失且branch/commits完整时不得丢弃有效Git工作。

## 7. 禁止重复执行

dispatchable与terminal status集合只由[Root Issue工作流](root-issue.md#6-planwork与verify-lifecycle)定义。恢复层只增加一个
规则：任何terminal native Issue ID都不能再次成为execution target。用户要求修改已经完成的工作时，matching semantic gate返回
high-level repair intent；Conductor compiler创建fresh Issue或successor Cycle。Cycle lineage由Root下native Cycle identity、
`(created_at, issue_id)`全序和archive状态推导；不得用`blocks`或对称`relates_to`伪造predecessor语义。Plan retry与
Work/Verify successor Cycle分别由owning typed compiler和native provenance定义，不假设Linear存在未暴露的replacement relation。

## 8. 人类信息与批准

任意长度的人类回答不能可靠地压进status或label。Human Action继续使用Root上的原生comment thread：request、human
reply、Symphony resolution reply、reaction、resolved state和native Activity共同保留内容与actor；不创建Issue或JSON。

request正文使用用户可读类型heading，并通过Linear native Issue mention引用exact Plan/Work/Verify/Finding target。只有Root
natural human的matching reply可以形成批准、拒绝、回答或waiver。审批只对被引用target及当时内容有效，不传递给
replacement Issue。完整模型只由[Human Action](human-actions.md)定义。

会改变需求或重建输入的人类回答，必须先由Root Reconciler合并进Root description并fresh read-back，matching thread才可
resolve。这样worktree丢失后的Root Reconstruction Set不会丢失已经确认的信息。

## 9. Materialization与可见度

Conductor只写以下用户有意义的内容：

- native Issue、status、label、parent、relation、archive和attachment变化；
- Human Action请求及对用户问题的直接回复；
- Plan、Work、Verify和Finding description中的可执行目标或证据；
- 对失败、阻塞、验证结论和交付结果的简短人类可读comment。

不得为ownership、claim、delta、next action、execution start、usage、read-back或内部correlation写comment。Linear native
Activity已经提供状态流转历史，Symphony不再投影Root/Cycle event comments。

每次mutation必须fresh read-back满足postcondition后才进入下一步。部分materialization在重启后只是新的current facts；pure
transition根据当前对象图推导remaining mechanical target、semantic gate、external wait、terminal或invalid facts，不依赖一条
“已执行到第几步”的receipt，也不再次请求模型批准唯一合法的补齐步骤。

## 10. Budget、progress与observability

跨重启机械限制只使用可重建事实：Root/Cycle native timestamps、active/archived Cycle数、attempt relation链、Finding状态和
Project/Profile当前配置。progress从当前DAG、terminal statuses和Git evidence推导，不持久化assessment。

Convergence policy不保留`max_consecutive_no_progress`。合法Changes Required Cycle必须先经过Verify admission，因此至少一个`Done` Work且
全部required Work为`Done`；缺少该DAG evidence的terminal Cycle是invalid facts，不能累计成limit。不同Git revision也不能机械证明业务
progress。总attempt envelope由Cycle cap、Finding persistence、active-Cycle repair limit和Root deadline分别拥有，不能再增加一个语义重叠、
不可达或需要模型评分的no-progress counter。

对于`max_cycle_repair_attempts`，pure transition在任何fresh Stage dispatch前重算active Cycle repair attempts。严格超限的唯一后果是：
先确认Stage session fence全部closed，再对exact active Cycle执行一个`Recovery Exhausted` terminal update并read-back；任何session
close pending、snapshot/Tree计数不一致、active Cycle歧义或stale precondition都停止且不写。成功后fresh restart进入non-success
`terminal_review`，不调用或重放Root recovery turn。该规则不自动决定deadline、Cycle-count或Finding persistence limit。

Root lifetime deadline从native Root creation timestamp、Project/Profile current policy与fresh Tree `observed_at`重建。它不覆盖已经完成的
successful Verify/Cycle evidence，但禁止任何新的workspace、Cycle、Plan/DAG、Stage、repair、replan或successor execution。unfinished active
Cycle必须先完成Stage session fence，再以一个native update进入`Canceled + Recovery Abandoned`；fresh restart确认无active Cycle后，第二个
独立update才把Root写为`Canceled + Deadline Exceeded`。任一步stale、session close pending、deadline snapshot与fresh timestamp矛盾或
topology不一致都zero mutation。successful terminal review在deadline后只保留delivery，不能创建successor；delivery rejection也不能重新打开
recovery。该规则不使用Root model、不覆盖Root requirement description，也不把两个durable effects伪装成事务。

精确model/token usage、Provider turn ID、runtime timing和tool progress属于logs/metrics observability，不是workflow
authority，也不写入Linear。丢失这些观测不得改变Root恢复或dispatch结果。

Work Agent Tree token/tool/activity aggregate也只属于当前runtime；它不会形成cross-restart budget ledger。跨重启limits仍由本节
已有native Cycle/attempt/timestamp facts机械重建。

## 11. Hard cut

目标架构不读取、不写入、不迁移以下旧surface：

- Root/Cycle generated event、subscriber和step comments；
- Linear comment或description中的Symphony machine JSON；
- private marker、persisted next-action/Result/usage/delivery payload；
- local workflow database、queue、checkpoint、DAG mirror或Provider thread pointer；
- dual-read、fallback、backfill或compatibility adapter。

旧surface不属于Root object graph。实现切换后遇到它们时按普通历史文本处理；它们不能授权mutation、证明完成或参与恢复。

## 12. 不变量

1. Linear原生Root object graph是workflow authority，Git是code和delivery authority。
2. Linear comments和descriptions不包含Symphony机器JSON、marker或隐藏payload。
3. Root恢复从current state convergence开始，不重放command或comment time series。
4. Dispatcher只执行`Todo`；任何terminal Issue都不重新派发。
5. worktree存在或可从valid Git branch重建时保留当前任务树；Git execution facts也不可恢复时创建全新执行树，旧任务只保留为archive审计历史。
6. 已确认的人类需求先进入Root description；Human Action thread保留actor和scope，审批不跨replacement target继承。
7. 每个native mutation都必须fresh read-back；ambiguous state一律fail closed。
8. 其他架构文档只引用本文，不复制恢复算法或持久化矩阵。
9. Work session loss后不恢复Provider agent graph；旧write capability撤销与containment empty/isolated未证明前不得启动new writer、
   commit、Verify或cleanup。

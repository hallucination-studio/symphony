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

Root Reconciler不重放旧next action，也不从comment日志回放command。每次启动都读取当前事实，推导当前有效状态与
不一致项，然后返回一个基于当前事实的bounded next action。Conductor只materialize该action并fresh read-back。

## 2. 权威对象模型

完整Root object graph至少包含：

| 原生事实 | 用途 |
|---|---|
| Issue native ID、title、description、creator、assignee/delegate、created/updated time | identity、需求、责任人与审计 |
| custom status及其Team category | lifecycle与dispatch eligibility |
| primary kind label及其他workflow labels | Root、Cycle、Plan、Work、Verify和Finding分类与结果限定 |
| parent/child topology | Root Tree、Cycle边界和节点scope |
| issue relations | dependency、predecessor、replacement、approval target和delivery关联 |
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
- 出现多个候选或无法证明唯一性时停止Root，由fresh Root Reconciler显式archive、replace或请求人工处理。

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
-> ask fresh Root Reconciler for one next action
-> materialize one bounded native Linear/Git mutation
-> fresh read-back
```

恢复不是event replay，也不继续某个已持久化command。live session内必须遵守[Performer](performer.md#51-provider注入分层)
定义的incremental Provider memory contract；只有process/session丢失时，in-memory baseline、opaque continuation、handle和本轮
typed response才整体丢弃，并从当前Linear/Git facts创建fresh initial context。

Work role session还可能包含[Work Subagents](work-subagents.md)定义的Provider agent tree。Work root continuity和每个turn的path、
mailbox、descendant threads及Provider graph在session loss后全部丢弃；不能从Codex persistence恢复旧agent或重放其task。只有
matching workspace write capability永久撤销且`WorkSessionContainment` empty/isolated proof成立后，fresh runtime才可取得Root writer
domain。Partial edits作为Git/worktree current facts保留。

只有新generation已经持有[Runtime Hardening](runtime-hardening.md#3-multi-binding-process-ownership)定义的
`BindingProcessFence`，且Podium已经拒绝旧private channel mutation后，旧process loss才得到机械证明。fresh Root
Reconciler随后可以返回`RecordStageInterruptionAction`把matching `In Progress`节点置为`Interrupted`；Conductor不能在
调用Root Reconciler前自行选择该transition。旧节点不得自动重新派发，继续工作使用fresh successor Issue。

## 6. worktree丢失时的rematerialization与invalid-generation rebuild

expected Root worktree目录不存在不等于Git code authority丢失。Conductor先fresh验证repository、delivery branch、HEAD、
commit tree和remote/SCM facts：

- matching branch与required commits完整、唯一且cleanly materializable时，Root Reconciler可以返回
  `CreateRootWorkspaceAction`，Conductor从该existing branch重建deterministic worktree，然后按正常恢复收敛现有任务树；
- branch缺失、identity冲突、required commit不可达或Git facts不足以证明旧代码时，Conductor把closed
  `ExecutionGenerationInvalid` mechanical fact交给fresh Root Reconciler；不能自行修改Linear或创建replacement branch。

invalid generation的目标形态如下，但它不是Conductor内部顺序状态机：

1. 当前nonterminal Cycle进入`Canceled`，并增加`Execution Invalidated` label；
2. 全部旧Cycle、Plan、Work、Verify和Finding descendants变为历史并native archive；
3. 旧节点无论原来是`Done`、`Failed`还是`In Progress`，都不能为新执行提供dependency satisfaction、completion或
   approval evidence；
4. 全部Root Human Action threads保留；引用旧执行target的approval只作为审计历史，不能批准fresh target；
5. invalid旧delivery branch不复用；fresh workspace从Root当前repository base创建；
6. Root Reconciler只基于Root Reconstruction Set创建fresh Cycle、fresh Plan和全新的Work/Verify DAG。

Root Reconciler每轮只返回一个closed action：先用`InvalidateExecutionGenerationAction`把旧Cycle/descendants收敛到上述
native terminal/archive postcondition，再用`CreateRootWorkspaceAction`创建fresh branch/worktree，最后通过既有
`CreateCycleAction`和逐Issue tree patch创建新树。每个action独立fresh read-back；crash后fresh Root Reconciler只观察
current native/Git facts并决定下一action，不恢复phase、command或sequence counter。

Root Reconstruction Set固定为：Root当前description、status、labels、relations、attachments、普通Root human comments、
全部Root Human Action threads及native Activity，以及fresh repository base facts。Provider projection把旧执行子树放入明确的
`invalidated_execution_audit`分区；新action的source/evidence refs不得引用该分区的Issue、approval或旧branch。Conductor
机械拒绝这种引用，因此不依赖prompt保证隔离。

这不是旧任务重跑：旧Issue永不再次dispatch；系统创建一组native identity不同的新任务。只有Git authority无法证明旧代码
仍然存在时才进入该路径；单纯worktree目录丢失且branch/commits完整时不得丢弃有效Git工作。

## 7. 禁止重复执行

dispatchable与terminal status集合只由[Root Issue工作流](root-issue.md#6-planwork与verify-lifecycle)定义。恢复层只增加一个
规则：任何terminal native Issue ID都不能再次成为execution target。用户要求修改已经完成的工作时，Root Reconciler创建
fresh Issue或successor Cycle，并用native predecessor/replacement relation表达lineage；attempt数量从该relation链计算。

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

每次mutation必须fresh read-back满足postcondition后才进入下一步。部分materialization在重启后只是新的current facts；
fresh Root Reconciler根据当前对象图补齐、替换或停止，不依赖一条“已执行到第几步”的receipt。

## 10. Budget、progress与observability

跨重启机械限制只使用可重建事实：Root/Cycle native timestamps、active/archived Cycle数、attempt relation链、Finding状态和
Project/Profile当前配置。progress从当前DAG、terminal statuses和Git evidence推导，不持久化assessment。

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

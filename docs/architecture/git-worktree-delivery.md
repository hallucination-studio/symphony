# Git Worktree与Root交付

状态：目标架构提案。本文是Root worktree validation、immutable revision、PR和delivery mechanics的唯一事实源。
恢复分支选择、worktree rematerialization与invalid-generation rebuild只由
[Workflow Authority与恢复](workflow-authority-recovery.md)定义。

## 1. 固定模型

每个active Root恰有一个active execution generation；每个generation恰有：

```text
one repository context
one generation-scoped deterministic delivery branch
one generation-scoped deterministic Git worktree path
at most one active delivery PR
```

Performer Work只能修改授予的worktree capability。一个Work Agent Tree整体是一个writer domain；tree内全部nodes共享该
worktree且不能创建per-agent Git topology，完整协调规则见[Work Subagents](work-subagents.md)。Plan和Verify只读；Conductor
独占worktree创建、branch、commit、push、PR、cleanup和Git topology mutation。

## 2. Repository Context

Repository Context由Project Binding提供repository identity、local path、base branch、remote和delivery policy。Root可以在
description中覆盖明确允许的delivery instruction；不得从comment机器payload或Provider output改变repository identity。

Root branch/path由repository identity、Root native ID和native Cycle facts推导的execution generation ordinal确定性派生。初始
generation为`1`；每个带`Execution Invalidated` label的native Cycle只贡献一个后继ordinal。不得使用title、本地自增序号、DB
counter或模型输出。这样invalid generation保留原branch/path现场，fresh generation仍能取得不同且可重建的Git identity。

## 3. 创建与验证

Conductor在首次执行前：

1. 验证repository、remote和base revision；
2. 确认没有其他Root或generation占用matching generation branch/path；
3. 创建fresh delivery branch和worktree；
4. 通过`git worktree list`、branch、HEAD和repository identity fresh read-back；
5. 只有全部postconditions成立才dispatch Stage。

每次process恢复先执行同样的existence与identity gate。存在但identity、generation branch或repository不一致时fail closed，保留现场；
不能reset、clean、move或猜测修复。worktree不存在时先按Git authority验证existing branch/commits：可证明时从该branch
重建worktree；Git execution facts也不可证明时才进入
[invalid-generation convergence](workflow-authority-recovery.md#6-worktree丢失时的rematerialization与invalid-generation-rebuild)。

## 4. Work与immutable Verify target

Work不commit或push。全部required Work完成后，Conductor：

1. 只接受matching `WorkTurnResponse`的semantic Result variant；Performer必须已永久retire其turn mutation epoch，mechanical failure
   不能进入commit gate；
2. 确认matching workspace write capability已撤销、Root writer domain已归还；Conductor不读取agent tree status或private fence proof；
3. 对每个`work_completed`，fresh验证worktree HEAD仍等于该turn的baseline与Work报告的`observed_head_revision`，status完整、
   changed paths与Result一致，且没有越界路径或未预期Git topology变化；Work报告的revision不是commit或Verify target；
4. 运行mechanical required checks；
5. 创建一个可read-back的immutable target commit；
6. 在Todo Verify上创建标题明确包含commit SHA的native attachment，并fresh read-back exact Issue、title、URL、remote version及
   field-specific provenance；human或external automation创建的同形attachment不能成为admission proof；该attachment是
   restart-derivable admission proof，不是Verify Result返回后的装饰或parallel delivery record；
7. fresh Git gate必须证明worktree clean、HEAD等于attachment中的commit且commit reachable，随后Verify只读检查该exact revision。

commit、attachment和Verify dispatch是三个有序postcondition。进程可在任一边界丢失响应；下一次reconciliation从fresh Git与Linear
facts判断尚缺的后果。没有matching attachment、attachment与HEAD不一致、required checks失败或Git status不完整时不得dispatch Verify。

Verify后任何内容变化都会产生new revision，并要求fresh Verify Issue。旧Verify approval或Finding conclusion不适用于new
revision。

## 5. Delivery

交付分成三个不能互相替代的事实层：

### 5.1 Delivery Intent

Root只有在以下native事实同时成立时进入`In Review`：

- matching Cycle为`Succeeded`；
- matching Verify为`Done + Passed`；
- Verify检查的commit仍是delivery branch exact target；
- required checks通过；
- delivery policy要求的push/PR已完成并从Git/SCM fresh read-back；
- Root存在标题绑定current immutable revision的native PR attachment/relation，或direct-delivery policy有可验证remote revision；
- Root status `In Review` mutation已经fresh read-back。

这些事实证明delivery intent已经materialize，不证明remote reviewer/SCM已经接受。系统不再创建parallel delivery object、receipt comment或machine JSON。用户可见comment只在交付结果或
失败需要解释时写一次简短摘要；native SCM link提供详细证据。

### 5.2 Remote SCM Acceptance

如果Project delivery policy要求remote acceptance，Conductor必须从SCM fresh-read exact PR identity、expected head SHA、required
checks和current review/merge state。Linear attachment URL的语法或本地HEAD不能替代该read-back。direct-delivery policy同样必须
fresh-read exact remote revision。

Attachment manifest actor是不可用且过粗的composite provenance。生产manifest为`unknown`时，exact current Attachment version、complete
Tree coverage，以及owning Issue上target该Attachment ID的latest `attachment_changed` Activity必须共同证明Symphony actor；later human、
external automation或unknown matching Activity均fail closed。该证明只回答谁建立了current native reference；attachment title/URL、
immutable commit reachability、repository identity和PR current state仍分别由canonical content、Git/SCM fresh read-back证明，不能由Activity替代。

Root可以保留多个历史delivery attachment。current reference必须先由唯一current unarchived `Succeeded` Cycle、其`Done + Passed`
Verify和immutable revision确定，再选择标题精确绑定该revision且满足上述provenance的attachment（例如
`Delivery pull request: <revision>`）；generic delivery title、最新创建时间或“Root上恰好一个PR attachment”都不是current identity。
同一current revision存在多个matching attachment时fail closed。历史attachment不删除、不归档，也不参与current acceptance；选中后仍须
fresh验证attachment version、repository、PR URL、base、head branch和SCM head SHA。

SCM provider adapter必须把provider-specific payload收敛为下面的closed observation；raw SDK/CLI payload不得跨出adapter：

| Observation | 必需证明 | 唯一后果 |
| --- | --- | --- |
| `open_unchanged` | provider、repository、PR identity、base、head branch和exact head SHA全部匹配，PR仍open且没有明确rejection | external wait；不得调用Root模型或重复delivery mutation |
| `merged_exact` | 同一identity的PR已经merged，accepted head SHA等于immutable Verify target，policy要求的checks已成功 | 允许进入Root terminal completion |
| `changes_requested` | identity和exact head仍匹配，但SCM存在明确changes-requested/rejection事实 | recovery semantic gate |
| `closed_unmerged` | matching PR已closed且未merge | recovery semantic gate |
| `head_changed` | matching PR存在但head SHA不再等于immutable Verify target | recovery semantic gate；旧Verify不得复用 |
| `observation_invalid` | identity、coverage、checks或provider response不完整、矛盾或ambiguous | fail closed并提供owner-specific visibility |

该分类不能更粗：`In Review`或一个PR URL无法区分等待、接受、拒绝和revision失效。也不应更细：reviewer列表、原始check runs、merge queue
内部状态和provider枚举只有在改变上述分类时才属于adapter内部证据，不得迫使Root模型或native transition理解provider细节。

`open_unchanged`必须成为独立的`waiting-external` runtime disposition。它按外部wake或bounded idle observation重新检查，不得降级为
`needs-attention`、创建failure comment、启动Root模型或重复Linear mutation。Project Root Index只用于候选调度；进入单Root处理后，
是否为`In Review`以及后续transition必须以同一次完整fresh Root Tree为准，不能用可能滞后的index header替代。

三类recovery observation必须同时返回用于证明PR identity且满足上述provenance的Root attachment ID和version。Conductor以该native
identity及provider-neutral observation内容生成opaque digest，构造`delivery` recovery subject，并在接受intent后再次观察相同subject。
Root semantic command只携带closed trigger、attachment ID和digest；PR URL、revision、provider enum和raw SCM payload不得进入该command。
`observation_invalid`没有可信subject，必须停在owner-specific mechanical diagnostics，不能交给Root模型猜测恢复策略。

### 5.3 Root Terminal Completion

Root `Done`只能由authorized human acceptance或policy明确列出的Remote SCM Acceptance事实触发，并fresh read-back Root terminal
status。`In Review`不是terminal completion，也不自动cleanup worktree。review changes创建fresh Cycle或fresh Work Issue，不能重新
派发旧`Done`节点。

`merged_exact`到Root `Done`是机械收敛，不是新的Root语义决定。Root status写入响应丢失时，下一次fresh Linear read必须识别已经满足的
terminal postcondition；若Root仍为`In Review`则只重试缺失的status consequence。terminal read-back确认前不得cleanup或报告完成。

## 6. Cleanup

只在Root `Done`或`Canceled`且没有live Stage/Work Agent Tree writer domain、uncommitted changes、unreadable Git state或pending
delivery时cleanup。
cleanup必须先验证exact Root path、repository和branch，再使用Git-aware worktree removal。失败保留现场并记录sanitized log；
不得递归删除宽泛路径。

## 7. 不变量

1. 一个active Root一个branch和worktree；Git facts由Git fresh read-back。
2. Work只改文件，Conductor独占commit/push/PR/worktree mutation。
3. Verify和delivery绑定同一immutable revision。
4. Delivery Intent、Remote SCM Acceptance和Root Terminal Completion是三个独立gate，不保存私有record。
5. worktree missing的行为只由Workflow Authority文档定义，本文件不复制恢复算法。
6. ambiguous或mismatched workspace永不自动reset/clean。
7. Work subagents共享一个Root worktree；只有matching turn epoch永久retire、write capability撤销、writer domain归还并完成barrier后
   fresh read，Work evidence才可进入commit gate。

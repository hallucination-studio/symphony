# Symphony目标架构总览

状态：目标架构提案。本文是架构入口，不代表当前实现已经匹配，也不包含迁移或兼容计划。

## 1. 产品与角色

Symphony是一个产品，由四个职责组成：

```text
Podium Desktop
  -> Podium: Linear OAuth, token, project catalog, binding and Linear SDK

Conductor
  -> read native Linear + Git
  -> host Root Reconciliation
  -> materialize one bounded native mutation
  -> manage one Git worktree per Root

Performer
  -> one Root Reconciler thread per Root
  -> isolated Plan, Work and Verify threads per Cycle
  -> Work thread may own bounded recursive descendants scoped to one Work turn
  -> Provider SDK and tool runtime
```

Root Reconciler是唯一决定workflow下一步的model-driven角色。Conductor不运行模型；Plan、Work和Verify只返回当前执行的
closed typed Result，不修改DAG或决定下一步。Provider threads只提供runtime continuity，不是durable authority。

## 2. 核心不变量

- [Workflow Authority与恢复](workflow-authority-recovery.md)是native Linear + Git authority、重启、禁止重跑和
  worktree丢失重建的唯一事实源；
- Linear只保存原生Issue、status、label、parent、relation、archive、comment、Activity、attachment和SCM facts；
- Linear description/comment不保存Symphony JSON、hidden marker、next-action、Result或usage payload；
- 不生成Root/Cycle event comment stream；用户从native Activity、Issue Tree、statuses、labels、relations和有意义的comments
  看到当前状态与历史；
- Conductor不保存workflow DB、queue、checkpoint、DAG mirror或Provider thread pointer；
- `performer.md`定义的五层Provider memory注入完整保留：fresh session只注入一次base instructions和role initial context，
  live turn只追加current command与new/replacement/tombstone fragments；
- Root、Plan、Work、Verify各自维护独立Provider-visible baseline与opaque continuation，role之间不共享或fork conversation；
- 同一冻结观察批次可以包含多个独立context fragments；turn期间到达的新事实等待下一批；
- Root恢复使用完整active/archived Root object graph和Git current facts进行state convergence，不回放旧command；
- worktree存在时收敛现有树；目录丢失但Git branch/commits完整时重建worktree，只有Git execution authority也无法证明时才
  invalid旧generation并从Root current facts创建全新任务树；
- Dispatcher只执行`Todo`，`Done`、`Interrupted`、`Failed`和`Canceled`节点永不自动重跑；
- Human Action使用Root native comment threads；Finding使用native Issue；二者都不保存JSON；
- 用户确认的需求在Human Action结束前合并进Root description；approval只对exact related target有效；
- Conductor始终是Performer caller；Performer不调用Linear或Conductor；
- 只有Work role可以创建subagent；Work root可跨turn保留，recursive descendants只属于matching Work turn。整棵tree共享一个
  Root worktree并只形成一个`WorkTurnResponse`，完整规则见[Work Subagents](work-subagents.md)；
- cross-process communication使用closed versioned schemas和generated types，但这些transient payload不持久化到Linear；
- Podium独占Linear OAuth、token和SDK；Performer独占Provider SDK；
- Podium Desktop只提供连接、进程、Binding和Profile控制面，不提供第二个workflow UI。

## 3. 权威来源

| 事实 | Authority | Owner/Interpreter |
|---|---|---|
| OAuth、token、installation、Project catalog、Binding | `podium.db` | Podium |
| Root routing和initial delegation | Linear native labels/delegate | Human / Podium / Conductor |
| Root requirement | Root current description + accepted Root human facts | Human / Root Reconciler |
| Root/Cycle/Node lifecycle | Linear custom status + native archive flag | Root Reconciler proposes; Conductor writes |
| Issue kind、scope和DAG | labels + parent/child + relations | Root Reconciler proposes; Conductor writes |
| Human Action与approval | Root comment threads + native reactions/resolved state/Activity | Human / Root Reconciler / Conductor |
| Finding | native Issues + status/labels/comments/Activity | Root Reconciler / Conductor |
| branch、worktree、commit、diff、checks、PR和delivery | Git/SCM | Conductor / Performer Work |
| Provider auth和live session | Profile `CODEX_HOME` + Performer memory | Performer / Codex SDK |
| model、token、turn和tool progress | process logs/metrics | Conductor / Performer observability |

只有Linear/Git mutation fresh read-back后才成为accepted durable fact。live Provider memory是必须遵守的runtime continuity，
但不是durable authority；进程丢失时View、baseline、typed Result、handle和transcript都可丢弃并从fresh facts重建。

## 4. 调用与恢复

```text
Conductor -> open/advance Root Reconciler with current native facts -> Performer
Conductor <- one closed Root next-action result                    <- Performer

Conductor -> execute Plan | Work | Verify with closed request      -> Performer
Conductor <- one closed typed Stage response                       <- Performer
```

Stage response是semantic Result或mechanical `StageTurnFailure`。只有semantic Result进入当前materialization事务：Conductor将其
收敛成native Issue/status/relation/comment/Git facts并read-back，然后丢弃transport payload。恢复时重新解释current native
facts，不要求重建旧Result对象。

任何Root恢复都先执行worktree gate。完整规则只见
[Workflow Authority与恢复](workflow-authority-recovery.md)，其他文档不得建立第二套恢复流程。

## 5. 文档导航

- [Workflow Authority与恢复](workflow-authority-recovery.md)：唯一durable authority、restart、no-replay与worktree-loss规则。
- [Root Issue工作流](root-issue.md)：Root Tree、kind labels、status catalog、DAG和native evidence。
- [Root Reconciliation](root-reconciliation.md)：唯一语义决策角色和bounded materialization。
- [Human Action](human-actions.md)：Root comment threads、actor、scope与resolution。
- [Performer Stage Contracts](stage-orchestration.md)：Plan、Work、Verify transient request/result contracts。
- [Work Subagents](work-subagents.md)：Work-only agent tree、协作工具、并发、预算、turn retirement与runtime containment。
- [Git Worktree与交付](git-worktree-delivery.md)：workspace、revision、PR和delivery边界。
- [Linear端到端流转](linear-flow.md)：Project解析、Root发现、调度、分页和SDK ownership。
- [契约与接口](contracts.md)：cross-process schemas和public interface边界。
- [Conductor](conductor.md)：Conductor模块与副作用边界。
- [Performer](performer.md)：Python Agent runtime和Provider边界。
- [Performer Profile](performer-profiles.md)：Profile、Codex配置与runtime usage observability。
- [Podium](podium.md)
- [Podium Desktop](podium-desktop.md)
- [Runtime Hardening](runtime-hardening.md)
- [代码模块与命名规范](code-organization.md)
- [目标仓库目录](repository-directory.md)
- [并行黑盒端到端验收](black-box-e2e.md)
- [Roadmap](roadmap.md)
- [架构术语表](glossary.md)

## 6. Named concern ownership

| Sole owner | Fact or behavior |
|---|---|
| [Workflow Authority与恢复](workflow-authority-recovery.md) | native durable facts、recovery、no-replay、worktree-loss rebuild和hard cut |
| [Root Issue工作流](root-issue.md) | Issue kinds、status subsets、Root Tree、DAG与archive semantics |
| [Human Action](human-actions.md) | Root Human Action comment threads、actor、scope、resolution与supersession |
| [Root Reconciliation](root-reconciliation.md) | Root inputs、Root Reconciler decisions和one-action materialization |
| [Performer Stage Contracts](stage-orchestration.md) | Plan/Work/Verify transient request/result contract |
| [Work Subagents](work-subagents.md) | Work-only agent tree、tool/context语义、tree limits、write grants、turn retirement与containment |
| [Git Worktree与交付](git-worktree-delivery.md) | worktree validation、immutable revision、PR和delivery mechanics |
| [Performer Profile](performer-profiles.md) | Profile control、actual model和runtime usage observability |
| [契约与接口](contracts.md) | public/cross-process schema、validation与error semantics |
| [并行黑盒端到端验收](black-box-e2e.md) | foreground E2E topology、assertions、evidence和verdict |

同一事实只能在owner文档定义一次。其他文档需要该事实时只描述本模块的输入/输出并链接owner，不复制字段表、transition、
恢复步骤或hard-cut清单。

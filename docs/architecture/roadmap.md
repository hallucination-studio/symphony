# Symphony架构实施Roadmap

状态：目标架构实施顺序。本文定义可验收增量，不声明当前实现已经满足目标，也不提供旧设计的迁移或兼容路径。

## 1. 实施原则

1. [Workflow Authority与恢复](workflow-authority-recovery.md)是native Linear + Git recovery的唯一规格。
2. Root Reconciler只作业务语义选择；Conductor从fresh native facts持续机械收敛。
3. 一个external mutation outcome只代表一个independently durable effect，并必须targeted read-back。
4. 每个slice先写失败测试；真实边界按progressive acceptance逐层放开，不用full campaign代替定位。
5. 删除旧surface和replacement属于同一次hard cut；不增加dual-read、adapter、flag、backfill或fallback。
6. 每个功能点只有一个named concern owner；其他文档和代码只引用。

## 2. R0：架构authority与progressive acceptance

- 统一本文、Root Reconciliation、Conductor、Stage、contracts、Linear flow、delivery、glossary和AGENTS规则；
- 用`mechanical_target | semantic_gate | external_wait | terminal`替代universal Root next-action invariant；
- Root只保留`requirement_and_comment | plan_human_decision | recovery_strategy | terminal_review`四类gate；
- 定义Plan/Work/Verify discriminated Results、Provider turn outcome、one-effect mutation outcome和generation-fenced session；
- 定义L0-L4 observer-only acceptance：process readiness、one Root discovery、valid Root intent、first mutation read-back、Plan DAG seal；
- architecture tests拒绝模型选择ready Work、逐节点DAG物化和multi-effect mutation result。

R0只改架构authority与测试，不宣称production已经匹配。

## 3. R1：安全、诊断与最小真实验收

- child process环境先clear再按owner allowlist注入，Podium secret不得进入Conductor；
- 建立binding generation、Root、request、session/turn、Stage、mutation和external request的相邻correlation spine；
- 保留closed internal diagnostic code/category/phase，同时对public reason做sanitization；
- 修复targeted、deduplicated failure visibility，保留原始失败并验证comment write outcome/read-back；
- 实现L0-L4单Root runner，每层独立deadline与verdict，不写test-only Linear facts。

## 4. R2：closed contracts、session与mutation lifecycle

- Plan、Work和Verify改为真实discriminated unions，完整proof不能在wire validation后丢弃；
- Provider turn返回`not_accepted | accepted_valid | accepted_invalid | acceptance_unknown | session_lost | canceled`；
- 每个generation-bound role session只允许zero or one active turn，并按`open -> executing -> closing -> closed`推进；
- close撤销late output authority，restart从native facts推导未完成义务；
- multi-effect command hard cut为one-effect outcome与targeted read-back。

## 5. R3：deterministic convergence与semantic gates

- pure transition从complete native facts返回mechanical target、semantic gate、external wait、terminal或invalid facts；
- Conductor机械拥有workspace、initial Cycle、complete Plan DAG、ready Work、Stage dispatch、Verify target和successful Cycle closure；
- Root gate output只含high-level intent/rationale/evidence，不含native ID生成、status、relation、version或precondition；
- compiler先模拟完整candidate graph，再逐effect执行并read-back；
- Root-to-first-Plan最多一次Root semantic decision，W个ready Work产生零次Root scheduling call。

## 6. R4：Plan、Work、Verify evidence chain

- lossless Plan contract与完整native DAG使用同一seal digest，approval只绑定exact target；
- Work readiness是pure predicate；completion必须fresh验证scoped Git/check evidence；
- Conductor创建并fence immutable Verify target；Verify proof与Finding identity完整保留；
- Cycle success只从complete Plan/Work/Verify/Git evidence机械推导；
- restart在每个边界都能从Linear/Git推导相同remaining obligation，terminal nodes永不reopen或redispatch。

## 7. R5：delivery与terminal visibility

- commit/push使用fenced expected HEAD；
- Delivery Intent、Remote SCM Acceptance和Root Terminal Completion分别read-back和命名；
- `In Review`只证明delivery intent，不能用PR-shaped URL宣称remote acceptance；
- Project policy若要求SCM acceptance，必须读取exact PR/head/check/review/merge state；
- Root terminal status必须有authorized human或policy-defined SCM fact并fresh read-back。

## 8. R6：恢复、并发与最终campaign

- 先重复运行单Root L0-L7；remote acceptance在产品scope要求时运行L8；
- 再运行Conductor restart、missing worktree、parallel和same-Conductor preemption；
- 依据真实boundary latency校准独立deadline和request budget；
- 最后运行eight-case 14-Root campaign，并fresh-read完整Linear/Git/required SCM Final Evidence Snapshot；
- local harness、fake Linear和verdict fixture不能作为real boundary通过证据。

## 9. 每个slice的stop conditions

以下任一条件出现都不能推进下一slice：

- credential进入非owner process；
- accepted/unknown mutation无deterministic read-back recovery；
- restart无法从native facts推导remaining obligation；
- terminal node可被redispatch；
- claimed acceptance遗漏其名称所包含的真实boundary；
- compatibility或private workflow state成为新authority。

## 10. Final acceptance

1. 完整native Root object graph与Git足以从cold restart推导current state。
2. Root只在四类semantic gate调用；happy path机械transition不请求模型批准。
3. Plan/Work/Verify、Provider turn和mutation effect都使用closed discriminated outcomes。
4. `Todo`是唯一dispatchable Node；所有terminal attempts保持不可重跑。
5. Human confirmations保存在Root threads/Activity和materialized target facts，不跨replacement target继承。
6. Stage/Root transport results不落盘，native postconditions fresh read-back后才推进。
7. Linear可见内容只包含用户需求、计划、任务、Findings、直接交互和有意义结论。
8. L0-L8的claimed boundaries分别有真实证据，最后的mandatory 14-Root campaign通过。

## 11. 明确延期

- 第二Provider；
- 同一Root多个active Cycles或并行workspace writers；
- durable Provider transcript、vector memory或workflow database；
- Desktop Workflow、Root/Stage/Human Action View或approval control；
- Work subagent内部架构重设；
- 精确cross-restart token/cost accounting。

# Symphony架构实施Roadmap

状态：目标架构实施顺序。本文定义可验收增量，不声明当前实现已经满足目标，也不提供旧设计的迁移或兼容路径。

## 1. 实施原则

1. [Workflow Authority与恢复](workflow-authority-recovery.md)是native Linear + Git recovery的唯一规格。
2. Root Reconciler只作业务语义选择；Conductor从fresh native facts持续机械收敛。
3. 一个external mutation outcome只代表一个independently durable effect，并必须targeted read-back。
4. 每个slice先写失败测试；真实边界按progressive acceptance逐层放开，不用full campaign代替定位。
5. 删除旧surface和replacement属于同一次hard cut；不增加dual-read、adapter、flag、backfill或fallback。
6. 每个功能点只有一个named concern owner；其他文档和代码只引用。

## 2. N0：authority与cutover contract

- 统一full recovery、runtime-only canonical state、atomic current-value observation和hidden revision ownership；
- 分类已有实现为retain、migrate或hard-cut delete，不覆盖未提交用户工作；
- 建立完整defect closure matrix，把全部历史finding、已实现限制和剩余functional outcome映射到N1-N6。

N0只改architecture authority、task evidence与validation tooling，不开始production runtime实现。

## 3. N1：canonical observation foundation

- 定义closed canonical Linear/Git fact identity、current value与observed provenance；
- content digest覆盖canonical value本身；
- complete observation之间只产生atomic `current_value | replacement | tombstone` batch。

## 4. N2：full recovery

- 完整分页恢复bounded Project Root Header Index；
- admission后恢复一个Root的complete active/archived Tree与Git facts；
- same facts在restart后必须生成byte-equivalent current state。

## 5. N3：runtime observation loop

- 串行accept complete observations并在whole frozen batch后wake convergence一次；
- targeted mutation read-back是mutation后唯一state advancement入口；
- incomplete coverage、acceptance uncertainty或baseline uncertainty强制fresh recovery。

## 6. N4：hard-cut consumer migration

- discovery、scheduling、safety、transition、compiler和materializer只消费runtime-owned current state；
- Root与Stage sessions从同一canonical source派生，但各自维护isolated Provider-visible baseline；
- contract generation只保留new initial/change variants，不允许mixed protocol deploy。

## 7. N5：old runtime removal与closure

- composition root一次切换，并在同一hard cut删除旧state owner、contract、adapter和tests；
- 证明restart、reconnect、partial read、ambiguous write、late output与session loss恢复；
- 完成全部control plane、workflow、stage、delivery、observability和security defect closure。

## 8. N6：progressive real-boundary acceptance

- 获得明确外部effect授权后，从one Root L0-L8逐步推进；
- 验证restart、missing worktree、fair multi-Root scheduling和physical request budgets；
- 最后运行L9 campaign与全仓检查，并要求closure matrix zero open rows。

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
8. L0-L8的claimed boundaries分别有真实证据，最后的L9 campaign通过。

## 11. 明确延期

- 第二Provider；
- 同一Root多个active Cycles或并行workspace writers；
- durable Provider transcript、vector memory或workflow database；
- Desktop Workflow、Root/Stage/Human Action View或approval control；
- Work subagent内部架构重设；
- 精确cross-restart token/cost accounting。

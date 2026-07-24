# Symphony架构实施Roadmap

状态：目标架构实施顺序。本文定义可验收增量，不声明当前实现已满足目标，也不建立旧短Stage架构兼容路径。

## 1. 实施原则

1. Linear/Git始终是durable authority；Provider thread只提供runtime continuity。
2. 先固定closed bootstrap/delta contracts和完整Tree读取，再实现Agent session。
3. Conductor host保持确定性；Root与Cycle语义只由Root Reconciler模型决定。
4. 每个增量可以从fresh Linear/Git facts恢复。
5. 旧的一次性Stage client、per-Work新thread和Conductor semantic policy不属于目标架构，不保留切换、并行或回退路径。
6. 每个实现任务先写失败测试，并在真实cross-process/Linear边界提供证据。

## 2. R0：完整Tree与contracts

- Podium-Conductor支持`include_archived`完整Root/Cycle Tree读取；
- 定义Root Reconciler bootstrap/delta/directive、用户input/comment reply schemas；
- 定义Plan、Work、Verify request/result schemas；
- 定义Human Action专用statuses、labels、request/resolution records；
- 定义Root/Cycle timeline events和projection marker；
- 生成TypeScript/Python/Rust types及cross-language fixtures。

R0禁止arbitrary metadata、GraphQL passthrough、raw Provider thread ID和任意Linear mutation。

## 3. R1：Root Reconciliation host

- 实现Root discovery、routing、ownership和complete Tree validation；
- 实现ownership、coverage、schema、capability和convergence gates；lifecycle/Tree矛盾只作为Reconciler输入；
- 实现一个reconciliation最多一个bounded call/mutation；
- 实现crash后从Linear/Git重建；
- Conductor中不存在model或Agent SDK。

## 4. R2：Root Reconciler

- Performer创建每Root独立Reconciler thread并跨Cycles复用；
- Conductor只在session open时发送完整active+archived bootstrap，后续advance严格发送delta；
- Root Reconciler返回一个closed `RootDirective`；
- Conductor校验Tree digest、persist directive、materialize/read-back；
- 支持Stage选择、rerun、replan、active Cycle supersede、terminal predecessor successor和Tree patch；
- 过滤普通human comments，并在处理后写回matching reply；
- thread丢失或baseline mismatch后使用完整Root Tree打开fresh Reconciler session，不兼容或补猜缺失delta。

## 5. R3：Plan、Work、Verify role threads

- 每Cycle创建与Root Reconciler隔离的Plan、Work、Verify threads；
- Plan/Verify read-only，Work workspace-write；
- Work thread跨多个Work Issues和turn复用；
- Work turn内部可以诊断普通错误、修改和重试；
- Result先durable，再进入下一份Root delta；
- Verify绑定immutable revision且不继承Work conversation。

## 6. R4：Human Action与DAG演进

- Cycle Action是Cycle直接子Issue并link相关节点；Root Action是Root直接子Issue；
- Project初始化创建和验证Human Action labels/statuses；
- Root Reconciler生成完整Action proposal，Conductor materialize；
- 用户status/comment形成closed resolution并返回Root Reconciler；
- Rejected missing reason和Answered missing answer fail closed并进入Root Reconciler处理；
- native archive保留全部Issue/Action历史并支持restore。

## 7. R5：Timeline event projections

- 业务模块发布typed event，不直接渲染comment；
- Root subscriber只写Root Timeline；Cycle subscriber只写Cycle Timeline；
- comment结构覆盖Observed、Decision/Result、Evidence和Next；
- deterministic event ID支持duplicate、ambiguous write和crash backfill；
- heartbeat/tool progress不进入Linear timeline。

## 8. R6：Convergence与delivery

- Cycle `repair_required/exhausted`进入Root convergence gate；
- Root Reconciler选择successor或Root Human Action，gate只机械允许或拒绝matching directive；
- passed Cycle和matching revision完成PR/branch delivery；
- waiting Human释放runtime capacity；
- architecture guards拒绝旧的每Stage新thread不变量重新出现。

## 9. 真实边界验收

最终必须证明：

1. Podium真实Linear SDK能完整读取active/archived Tree并执行archive/restore和带precondition mutation。
2. Conductor通过真实session protocol驱动Root Reconciler和每Cycle三个隔离Stage threads。
3. Work thread跨至少两个Work Issues连续执行，普通错误在turn内恢复。
4. Root Reconciler依据Result和普通用户comment调整DAG、replan、创建successor或Human Action并回复用户。
5. Cycle budget耗尽后Root Reconciler选择successor或Human Action；Root gate只机械允许或拒绝该directive。
6. process/session重启只靠Linear/Git恢复并拒绝旧output。
7. Root/Cycle timeline comments从events幂等投影并可在crash后补齐。
8. delivery read-back与Root `In Review`一致。

## 10. 明确延期

- role thread内部sub-agents或fan-out/fan-in；
- 第二Provider；
- 同一Root多个active Cycles或并行workspace writers；
- durable Provider transcript、vector memory或Workflow数据库；
- 任何Desktop Workflow、Root/Stage/Human Action View或Agent transcript；
- authoritative monetary cost gate。

这些能力需要独立授权，不能通过预留任意variant或metadata进入当前contracts。

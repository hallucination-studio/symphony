# Symphony架构实施Roadmap

状态：目标架构实施顺序。本文定义可验收增量，不声明当前实现已满足目标，也不建立旧短Stage架构兼容路径。

## 1. 实施原则

1. Linear/Git始终是durable authority；Provider thread只提供runtime continuity。
2. 先固定closed bootstrap/delta contracts和Conductor侧完整Tree读取，再实现Agent session。
3. Conductor host保持确定性；Root与Cycle语义只由Root Reconciler模型决定。
4. 每个增量可以从fresh Linear/Git facts恢复。
5. 旧的一次性Stage client、per-Work新thread和Conductor semantic policy不属于目标架构，不保留切换、并行或回退路径。
6. 每个实现任务先写失败测试，并在真实cross-process/Linear边界提供证据。
7. 最终交付前必须以架构文档逐项审计contracts、generated bindings、production code、tests、fixtures和真实Linear
   evidence；发现的平行结果来源、平行lifecycle或旧路径必须删除后重新审计，不能以说明、adapter或兼容分支保留。

## 2. R0：完整Tree与contracts

- Podium-Conductor支持`include_archived`完整Root/Cycle Tree读取；
- Linear当前Issue、comment、relation和managed record是唯一Workflow事实；不建立Linear revision、mutation或change
  event生命周期；
- 定义Root Reconciler bootstrap/delta/directive、用户input/comment reply schemas；
- 定义Plan、Work、Verify request/result schemas；
- 定义Human Action专用statuses、labels、request/resolution records；
- 定义Root/Cycle timeline events以及一个event、一条Markdown + `symphony` block comment的materialization contract；
- 定义native comment thread resolve/unresolve、reaction回执、actual model和required Turn Usage contracts；
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
- Conductor每轮可以在内存中完整读取并按source version/hash计算fresh diff，但完整Tree只属于Conductor内存；已有session的advance
  request不得携带完整Tree、完整manifest、旧值/新值对或activity history；description/comment变化只发送新的完整当前值；
- 只有新建、丢失或无法证明baseline的session才重新发送一次`RootBootstrapSnapshot`；普通用户修改本身不触发Conductor
  重建session；
- delta只是跨进程turn输入，不创建Linear revision/event lifecycle；session丢失或baseline无法证明时丢弃旧session并重新bootstrap；
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

## 7. R5：Timeline event comments

- 业务模块发布typed event，不直接渲染comment；
- Root subscriber只写Root Timeline；Cycle subscriber只写Cycle Timeline；
- 一个event只写一条同时包含结构化用户Markdown和唯一`symphony` code block的comment；
- comment结构覆盖Observed、Decision/Result、Evidence、model/usage和Next；
- 用户comment使用native child reply、✅/❌回执和resolve/unresolve，reaction不表达审批status；
- deterministic event ID支持duplicate、ambiguous write和crash backfill；
- heartbeat/tool progress不进入Linear timeline。

## 8. R6：Convergence与delivery

- Cycle `repair_required/exhausted`进入Root convergence gate；
- Root Reconciler选择successor或Root Human Action，gate只机械允许或拒绝matching directive；
- passed Cycle和matching verified Git revision完成PR/branch delivery；
- waiting Human释放runtime capacity；
- architecture guards拒绝旧的每Stage新thread不变量重新出现。

## 9. R7：架构一致性与单一状态机审计

在真实边界验收前后各做一次fresh-context audit。审计以本目录的named concern文档为唯一规格，对照schema、generated
types、production code、tests、fixtures和E2E证据；task文件、日志、runtime memory或旧实现不具备解释权。

- 每个架构invariant必须有一个可定位的实现、验证和证据；没有对应实现的目标项必须保持明确未完成，不能由相邻功能
  推断已满足；
- 对每个持久化或跨进程对象确认唯一职责：Issue custom status + archive拥有lifecycle；Stage Result拥有execution
  事实；`ModelTurnRecord`拥有usage事实；directive/resolution拥有接受的意图或用户选择证据；timeline/reply/reaction/
  thread state只拥有叙事或回执；`RootDelta`只拥有单次传输；
- 明确拒绝三类双路径：从timeline/reply恢复或重计Stage Result/usage、由reaction/thread/record/delta驱动Issue
  lifecycle、以及任何HTML marker/managed-marker/revision-event/compatibility reader、writer或fallback；
- E2E通过条件只能是fresh Linear/Git read-back；不得以process exit、runtime state、session、log或synthetic `final`
  代替；
- 每个finding必须成为一个有architecture source、删除范围、验收条件和验证命令的独立修复项。修复后重跑完整audit，
  直到零finding；不得以waiver关闭。

## 10. 真实边界验收

最终必须证明：

1. Podium真实Linear SDK能完整读取active/archived Tree并执行archive/restore和带precondition mutation。
2. Conductor通过真实session protocol驱动Root Reconciler和每Cycle三个隔离Stage threads；每次Provider调用在Linear
   中留下actual model与required Turn Usage，Cycle/Root累计可从immutable turn records重新计算且完全一致。
3. Work thread跨至少两个Work Issues连续执行，普通错误在turn内恢复。
4. Root Reconciler依据Result和普通用户comment调整DAG、replan、创建successor或Human Action，并以native child reply、
   ✅/❌ receipt或no-terminal reaction以及resolve/keep-open结果回复用户；reaction不替代Human Action status。
5. Cycle budget耗尽后Root Reconciler选择successor或Human Action；Root gate只机械允许或拒绝该directive。
6. process/session重启只靠Linear/Git恢复并拒绝旧output。
7. Root/Cycle timeline comments从events幂等materialize并可在crash后补齐；每个event恰有一条同时包含用户Markdown和
   strict `symphony` code block的comment，tracked surface不存在HTML marker reader/writer或第二timeline record。
8. delivery read-back与Root `In Review`一致；E2E只以fresh Linear Issue status、strict managed code blocks、native
   thread/reaction和Git事实作为通过证据，process exit、runtime state、session、日志或synthetic `final` marker不能证明完成，
   也不存在另一套Workflow completion路径。

## 11. 明确延期

- role thread内部sub-agents或fan-out/fan-in；
- 第二Provider；
- 同一Root多个active Cycles或并行workspace writers；
- durable Provider transcript、vector memory或Workflow数据库；
- 任何Desktop Workflow、Root/Stage/Human Action View或Agent transcript；
- authoritative monetary cost gate。

这些能力需要独立授权，不能通过预留任意variant或metadata进入当前contracts。

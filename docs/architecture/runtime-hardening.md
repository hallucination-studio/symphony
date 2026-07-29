# V3 Runtime Hardening

状态：目标架构提案。本文定义Agent runtime的进程、session、资源、请求、升级、shutdown和cleanup边界；
不定义Linear Workflow、Root Reconciler或Stage contracts。

## 1. Scope record

```text
authorized
  - 多Conductor Binding的single-generation reconcile
  - 全局role-turn capacity与有界admission
  - Root worktree single-writer-domain和maintenance coordination
  - Work-only agent tree的内部capacity、dedicated session containment、epoch retirement与late-writer fencing
  - Linear request broker、rate-limit和bounded retry
  - structured logs、Problems、health和Desktop observations
  - immutable runtime bundle、atomic upgrade、bounded shutdown和safe cleanup
  - Performer readiness、session/turn limits、heartbeat、cancellation和child-process cleanup
  - Provider-native sandbox mode和有界command allowlist/denylist

required_consequences
  - runtime state全部可丢弃，不能成为Workflow authority
  - capacity只决定何时运行一个已选Root的Reconciler/Stage turn，不改变由Priority、`updatedAt`和blocker eligibility
    得出的Root admission顺序
  - Host/Conductor crash后从Binding、Linear和Git重新建立runtime
  - failure必须有界、脱敏、可观察并释放资源
  - execution policy只做closed DTO映射，不形成Symphony通用授权系统
  - Work descendants计入同一个Stage turn和writer domain，不改变Root admission顺序

out_of_scope
  - Root Reconciler、Plan或Verify内部subagents
  - Workflow DB、Root/Leaf Queue、本地dispatch table、内部attempt journal或turn checkpoint
  - 多writer、per-Agent worktree、自动merge或远程Agent runtime
  - 第二Provider Backend
  - 动态RBAC、逐命令人工审批、任意策略表达式或Provider config map

assumptions_requiring_approval
  - none

deferred_ideas
  - Provider-specific runtime adapters
```

## 2. Runtime与Workflow边界

V3 runtime可以维护以下memory-only对象：

```text
AgentTurnPermit
InstallationLinearRequestBroker
PerformerProcessHandle
PerformerSessionTransportHandle
OpaqueRoleSessionHandle
WorkSessionContainmentHandle
WorkMutationContainmentHandle
RootWorktreeWriterPermit
HeartbeatObservation
ShutdownDeadline
```

这些对象可以在crash后全部丢失。它们不能保存或推导current Work、Root/Cycle/Node status、pending Human request、
authoritative retry attempt或下一Root。跨重启事实只来自native Linear Root graph与Git：execution identity使用Issue native
ID，attempt lineage使用role-owned native provenance与canonical topology，Finding使用native Issue，progress/deadline从
statuses/timestamps推导。不得假设public Linear boundary未暴露的predecessor/replacement relation。
iteration guard、permit和token reservation不恢复，也不写Linear。重启后：

```text
read Conductor Bindings
-> establish only generations explicitly started in this Desktop lifetime
-> discover all Root headers and lazily fresh-read candidate Trees
-> inspect deterministic Git workspaces
-> assess and schedule Roots normally
```

Desktop runtime observation只能回答Linear connected/disconnected和Conductor online/offline。资源、限流和内部Workflow
细节只进入Conductor脱敏日志/metrics；只有用户需采取行动的业务事实才进入Linear，不能扩展Desktop公开状态。

## 3. Multi-Binding process ownership

Podium Desktop不保存Conductor desired/observed state。一次Desktop进程内，用户可以Start或Stop一个Binding：

```text
Start -> verify no matching live generation -> launch -> handshake -> online
Stop -> bounded shutdown -> prove process tree exited -> offline
heartbeat/channel loss -> offline + sanitized log
```

Host为每个Binding取得一个OS-backed advisory `BindingProcessFence`，并让matching Conductor process继承其live handle。
fence identity使用本机runtime目录中的Binding ID，但文件内容不保存workflow、Root或generation state；OS在全部持有进程
退出时释放lock。新generation只有成功取得exclusive fence、确认旧private channel失效并完成fresh handshake后才能online。
无法取得fence表示旧writer仍可能存活，replacement fail closed。

每个generation有runtime ID、PID/process identity、start time和health channel，这些只存在于runtime。Podium Backend把每个
Linear mutation绑定到当前authenticated private channel generation；channel关闭或被replacement撤销后拒绝旧generation的
mutation和late output。Generation ID只用于process/channel/turn fencing，不写Linear，也不是Root ownership或workflow
cursor。

Conductor先通过Project Conductor Pool和Root Conductor Label把Root唯一route到matching Binding；`BindingProcessFence`和
Podium channel fencing排除同一Binding的第二个writer，Conductor的memory-only `RootIterationGuard`只合并本进程的
duplicate wake。不存在跨独立Conductor进程共享的Root lease；generation ID不能接管、迁移或形成durable Root事实。

## 4. Agent session/turn runtime boundary

Root Reconciler/Plan/Work/Verify session、turn lifecycle、Human等待、deadline、cancellation和恢复分别由
[Root Reconciliation](root-reconciliation.md)与[Stage Contracts](stage-orchestration.md)定义。

Work role内部agent tree的active/resident capacity、tree budget、shared worktree coordination、epoch retirement和containment只由
[Work Subagents](work-subagents.md)定义。Runtime把整棵tree作为一个Conductor Stage permit和一个Root writer domain；
descendant slots不能形成第二套Root scheduler或workflow queue。

Runtime Hardening只允许permit、process/connection handle、opaque role session mapping和普通heartbeat存在于
memory。live Provider thread可以提供同一Cycle role的上下文连续性，但不能成为workflow authority；丢失后从
Linear/Git打开fresh session。crash fencing依赖process identity、channel、session/turn correlation和native target
preconditions，不写private lease payload到Linear。只有exclusive `BindingProcessFence`已取得且旧channel已失效，runtime才可
把旧process视为不能再materialize output；heartbeat超时或看不到PID本身不构成该证明。

每个Work role session还必须拥有独立`WorkSessionContainment`，每个turn在其中创建fresh
`WorkMutationContainment(stage_execution_id, epoch_generation)`。其他roles、Work sessions和turn epochs不得共享这些identity。
Containment必须在tool child执行第一条user code前完成membership，阻止detach/reparent逃逸，并在supervisor loss后仍可撤销
workspace mutation capability或terminate全部members。普通PID/process group只能用于best-effort signaling，不能证明writer已消失；
只有matching write capability永久撤销且containment empty/isolated proof成立后，runtime才可释放Root writer permit。

## 5. Linear request broker

Podium拥有Linear SDK和全installation rate-limit视图。Conductor requests通过共享broker分类：

```text
control: Project resolution, Root routing/process-fence/terminal checks
workflow-read: Root/Tree/comments/relations
mutation: Root-scoped writes and semantic read-back
observation: connection health and internal telemetry
```

Gateway protocol request与physical Linear HTTP request分别观测。Podium transport对每个SDK lazy read和
显式query记录sanitized operation、correlation ID、latency、status、request-window及complexity-window
计数；不记录credential、header、variables、query text、Issue内容或response body。

Project Pool preflight和Conductor Project resolution必须使用只选择判定所需字段、明确分页边界的紧凑
GraphQL query；不得通过SDK model relation或其默认fragment读取`ProjectLabel.projects`、`Project.issues`
或等价的全量对象。每个紧凑query都必须验证返回的Project、label ownership、Root routing和pageInfo；缺页或
缺cursor fail closed。SDK报告的rate-limit/network/internal failure必须保持为脱敏、可重试的Linear runtime
failure，不能降级为Project、Root或routing业务事实无效。

Root discovery同样必须使用[Linear端到端流转](linear-flow.md)定义的Project Root Index显式query和physical request
budget。protocol logical request与physical request分别计数；一个共享Index page被多个Conductor消费时仍只记一次physical
request。broker必须提供按operation、installation和Project关联的计数，使单页8 Roots/3 Conductors fixture可以证明
常态1次，而14 Roots/3 Conductors fixture必须证明1次首page加1次continuation；不得只证明logical request成功。

broker按installation在内存中分配physical request和GraphQL complexity permits。unchanged background
runtime在当前两个窗口中最多消耗25%，至少保留50%给control、mutation和ambiguous-write read-back；
窗口信息不足时background fail closed或延后。control和mutation read-back高于background observation，
但不能长期饿死完整Root reads。分页、并发、payload、排队deadline和retry次数都有上限。

只允许bounded、相同fresh-read identity的in-flight/read-through coalescing；Project Root Index由memory-only refresh
generation限定共享scope，其identity必须排除Binding和Conductor identity，其他query不得擅自扩大共享scope。matching
mutation、webhook/safety generation invalidation或process
restart后不得复用。coalesced result和memory cache不能成为workflow/mutation authority、单独授权dispatch或证明
completion，也不能替代last-responsible-point fresh precondition和semantic read-back。Project Root Index可以按
`linear-flow.md`提供candidate routing/eligibility/order，但不能单独授权dispatch；selected candidate仍须完整fresh Tree。

429和transient failure处理：

- 尊重SDK/response明确的retry time；
- 使用bounded jittered backoff；
- mutation timeout先semantic read-back；
- retry前重新验证Project、Root和当前mutation precondition；
- 达到runtime上限后释放permit，写一条去重的operator-visible Problem；
- 不保存durable retry counter或next-at timestamp作为Workflow state。

Project discovery transient network、429和5xx失败不得逃出主cycle并终止整个Conductor。matching Binding进入不调度新
Root的memory-only degraded/backoff状态，已有Root也不能基于不完整Index继续推进；下一次bounded wake重新读取。
authorization、schema、Binding和coverage失败保持fail closed并产生actionable correlated Problem，不进行busy retry。
单个Root的routing shape非法只隔离该Root或其page，不能被解释成普通空结果，也不能终止其他Project的runtime。

## 6. Error、Problem与日志

所有runtime error归一化：

```text
RuntimeProblem
  code
  scope: application | binding | profile
  severity
  sanitized_reason
  first_observed_at
  last_observed_at
```

`RuntimeProblem`是当前Podium/Desktop process observation，可过期、覆盖或在restart后重新发现，只描述连接、process
或Profile控制失败。Root/Stage错误不进入Desktop View；需要用户理解的Workflow事实写matching Linear Issue的bounded
comment或status。heartbeat loss和tool progress只进入logs/metrics。

Desktop可见日志只使用binding/profile correlation IDs，不记录Root、Issue、Stage、Token、cookie、Authorization header、API
Key、raw Profile credential、Provider transcript、SDK object或不受限Issue内容。绝对Profile path在UI和
public logs中脱敏。

[Performer](performer.md)定义的opt-in local Provider I/O diagnostic capture不属于Desktop可见日志或public runtime logs。
它只能写入operator显式指定的absolute directory，不能经过stdout/stderr forwarding、Problem、Podium storage或Linear；
Symphony不能读取它参与health、recovery、workflow或E2E verdict。默认关闭、restricted file mode、capture failure semantics与
operator retention责任只由Performer文档定义。

## 7. Immutable runtime bundle与atomic upgrade

安装的runtime bundle是immutable、content-addressed并带manifest：

```text
RuntimeBundleManifest
  product_version
  protocol_version
  platform
  architecture
  payload_digest
  files[]
```

upgrade先下载/构建到新目录，验证manifest、digest、file mode和可执行性，再原子切换current
pointer。不得原地覆盖正在运行binary。切换失败保留上一个完整bundle；成功后新generation使用新bundle，
旧generation按bounded shutdown退出。

bundle pointer和payload只属于runtime delivery，不保存Root、Provider thread或Workflow state。

## 8. Bounded shutdown

application、Binding或upgrade shutdown：

1. 停止新的Root/session/turn admission；
2. 先撤销active turn的result publication authority；对Work原子seal producer admission并永久撤销matching workspace write；
3. 请求Performer graceful cancel并interrupt active Provider/tool dispatch；
4. 在deadline内等待当前Request、pre-seal producer、read-back和containment drain结束；
5. terminate剩余exact containments并证明Work write revocation与containment empty/isolated；
6. 释放permits，关闭private channels和logs；
7. 只有全部required proof成立后报告stopped；否则保留fence并报告bounded failure。

shutdown不会把Root标成failed或Canceled。下次启动从Linear/Git重建Root并打开fresh matching role sessions；
不恢复raw Provider thread pointer。

## 9. Safe worktree cleanup

cleanup只删除可证明属于同一Conductor/Root的deterministic worktree，并同时满足：

- Root已经Done/Canceled或用户明确请求cleanup；
- 没有live process、permit或Work Agent Tree writer domain；
- worktree identity、repository common git dir和expected branch一致；
- 没有未提交修改、未push commit或未交付branch，除非用户明确批准丢弃；
- path位于配置的worktree root内且不是repository root、home或宽泛目录；
- Git worktree metadata和filesystem target都精确解析。

任一证明失败都停止并显示具体原因。cleanup不作为Root completion的必要步骤，也不改变Linear状态。

并行E2E的process topology、start barrier、restart动作和artifact retention只由
[并行黑盒端到端验收](black-box-e2e.md)定义。Runtime只提供本节已有的生产start/stop/kill语义；专用E2E Project的
启动前baseline reset是runner在Runtime创建前经Linear公开API执行的外部测试操作，不是Runtime lifecycle、turn closure或
test-only daemon mutation。

## 10. Failure matrix

| 故障 | Runtime动作 | Workflow恢复 |
|---|---|---|
| role session/turn启动失败 | 只有明确not-accepted且no-capability proof才rollback；Work accepted/unknown时revoke、fence并在proof后释放permit | 返回closed mechanical failure；唯一consequence机械收敛，有业务取舍时进入recovery gate |
| Linear mutation上限到达 | 拒绝mutation，结束turn后释放permit、read-back | 从fresh Linear/Git重建并继续 |
| heartbeat停止/硬wall-time耗尽 | invalidate result generation；Work先revoke write并fence exact containment，proof后才释放permit | closed mechanical failure机械收敛；有业务取舍时进入recovery gate |
| Work epoch无法retire或枚举状态不明 | revoke workspace capability并terminate exact containment；证明empty/isolated后才释放writer permit | proof成功为`work_epoch_closure_failed`；否则`workspace_fence_unproven`且Root保持runtime-blocked |
| Work descendant late write/output | generation fence拒绝，记录sanitized observation | Workflow facts不变；fresh worktree read决定后续 |
| transport在terminal response前中断 | invalidate generation；Work经过同一write-revocation/containment gate后释放permit并read-back | 使用native current facts或fresh role session |
| terminal response重复/迟到 | 以execution identity与precondition拒绝旧response | Workflow facts不变 |
| Linear 429 | bounded backoff，释放超时permit | 下次full-read继续 |
| mutation unconfirmed | semantic read-back | 以read-back事实继续 |
| Git HEAD变化 | 拒绝旧Result/mutation | fresh Root delta或bootstrap重新审计Git |
| Host/Conductor crash | replacement前证明旧write capability已撤销且containment不能再写 | full-read所有Roots/Git |
| upgrade失败 | 保留旧完整bundle | Workflow不变 |
| cleanup证明不足 | 不删除 | Root/branch保持可恢复 |

## 11. 验收边界

1. 每个running Binding恰好一个current Conductor generation。
2. capacity单位是active Root Reconciler/Stage turn；Root仍是全局admission与workspace单位。
3. turn绑定execution identity和fresh precondition；旧Context/Result不能修改新事实。
4. launch、heartbeat、turn limits、cancel和child-process cleanup有界；Provider usage只进入runtime observation。
5. 同一Root同时最多一个workspace writer domain；Work Agent Tree可以在该domain内按不相交write sets协作。
6. Linear request遵守rate-limit，ambiguous write先read-back。
7. runtime observations不参与Root scheduling或Workflow恢复。
8. upgrade不原地覆盖binary，失败可回到上一个完整bundle。
9. shutdown停止新admission并确认process tree/connection退出。
10. cleanup只删除经过完整identity和dirty-state证明的worktree。
11. crash后不恢复permit、process、raw thread、Result、iteration guard或token observation；status、attempt和Finding从native Linear
    重建，code/delivery从Git重建。
12. physical Linear request和protocol request分别观测，background最多使用request与complexity窗口的25%。
13. Work Agent Tree active/resident与budget有界；semantic Result前matching epoch永久retire并交还writer permit，close不确定时由
    write revocation和non-escapable containment精确fence。

## 12. 不变量

1. Runtime hardening不能创建第二套Workflow authority。
2. Root是顶层排序、admission、workspace和恢复单位；active model turn是capacity单位。
3. 所有runtime handles、iteration guards、permits、普通progress heartbeats和Problems都可丢弃，不写Linear recovery payload。
4. Linear/Git事实修复后Root自然恢复，不需要operation resume API。
5. Root Reconciler与Stage protocol只由[Root Reconciliation](root-reconciliation.md)和
   [Stage Contracts](stage-orchestration.md)定义。
6. 只有Work runtime可以承载[Work Subagents](work-subagents.md)定义的agent tree；其他roles不预建subagent capability。
7. Work tree仍是一个Stage turn和writer domain，tree runtime state不进入workflow memory store；live Provider memory仍按
   [Performer](performer.md#51-provider注入分层)维护。

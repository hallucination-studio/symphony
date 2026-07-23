# V3 Runtime Hardening

状态：目标架构提案。本文定义Stage runtime的进程、资源、请求、升级、shutdown和cleanup边界；
不定义Linear Workflow或Stage Context。

## 1. Scope record

```text
authorized
  - 多Conductor Binding的single-generation reconcile
  - 全局Stage capacity与有界admission
  - Root worktree single-writer和maintenance coordination
  - Linear request broker、rate-limit和bounded retry
  - structured logs、Problems、health和Desktop observations
  - immutable runtime bundle、atomic upgrade、bounded shutdown和safe cleanup
  - Performer readiness、Stage limits、heartbeat、cancellation和child-process cleanup
  - Provider-native sandbox mode和有界command allowlist/denylist

required_consequences
  - runtime state全部可丢弃，不能成为Workflow authority
  - capacity只决定何时运行一个已选Root的Stage，不改变Linear Priority/order/blocker
  - Host/Conductor crash后从Binding、Linear和Git重新建立runtime
  - failure必须有界、脱敏、可观察并释放资源
  - execution policy只做closed DTO映射，不形成Symphony通用授权系统

out_of_scope
  - sub-agents、child Turns或fan-out/fan-in capacity
  - Workflow DB、Root/Leaf Queue、本地dispatch table、内部attempt journal或Stage checkpoint
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
StagePermit
InstallationLinearRequestBroker
PerformerProcessHandle
StageTransportHandle
HeartbeatObservation
ShutdownDeadline
```

这些对象可以在crash后全部丢失。它们不能保存或推导current Work、Root/Cycle/Node status、accepted
Result、pending Human request、authoritative retry attempt或下一Root。恢复需要的Stage execution identity、
lease expiry、execution attempt、token reservation、Finding、progress、retry decision和deadline只写Linear managed
comments。重启后：

```text
read Conductor Bindings
-> re-establish one generation per running Binding
-> discover all Root headers and lazily fresh-read candidate Trees
-> inspect deterministic Git workspaces
-> assess and schedule Roots normally
```

runtime observation只能回答“进程/连接是否还活着、资源是否占用、请求是否被限流、用户该采取什么
动作”，不能回答“Workflow走到哪一步”。

## 3. Multi-Binding reconcile

Podium Desktop保存每个Conductor Binding的desired state。Host启动或Binding变化时reconcile：

```text
for each Binding:
  desired stopped -> terminate current generation with bounded shutdown
  desired running + no healthy generation -> start one generation
  desired running + one healthy generation -> attach observations
  desired running + multiple generations -> stop mutations, keep one only after proof
```

每个generation有runtime ID、PID/process identity、start time和health channel。Generation ID只允许作为
Stage lease fencing字段写入Node managed comment，不是Root ownership或Workflow cursor，也不进入Root Primary
Status Comment。Host必须证明旧process tree已经退出，才能启动replacement。

Conductor先通过Project Conductor Pool和Root Conductor Label判断routing eligibility，再通过Binding stable
identity和Root full `conductor_id`判断ownership；generation ID不能接管或
迁移Root。

## 4. Stage runtime boundary

Stage capacity、StageWire lifecycle、Human等待释放capacity、deadline、cancellation和fresh
recovery只由[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

Runtime Hardening只要求permit、process/connection handle和普通progress heartbeat全部memory-only；它们不能
承载Provider thread、pending Human future或workflow continuation。参与crash recovery的bounded Stage lease
heartbeat是例外，由Stage Orchestration定义并写Linear。

## 5. Linear request broker

Podium拥有Linear SDK和全installation rate-limit视图。Conductor requests通过共享broker分类：

```text
control: Project resolution, Root ownership/terminal checks
workflow-read: Root/Tree/comments/relations
mutation: Root-scoped writes and semantic read-back
observation: usage and Desktop refresh
```

Gateway protocol request与physical Linear HTTP request分别观测。Podium transport对每个SDK lazy read和
显式query记录sanitized operation、correlation ID、latency、status、request-window及complexity-window
计数；不记录credential、header、variables、query text、Issue内容或response body。

broker按installation在内存中分配physical request和GraphQL complexity permits。unchanged background
runtime在当前两个窗口中最多消耗25%，至少保留50%给control、mutation和ambiguous-write read-back；
窗口信息不足时background fail closed或延后。control和mutation read-back高于background observation，
但不能长期饿死完整Root reads。分页、并发、payload、排队deadline和retry次数都有上限。

只允许bounded、相同fresh-read identity的in-flight coalescing；mutation invalidation、操作结束或process
restart后不得复用。coalesced result和memory cache不能决定workflow、dispatch、mutation authority或
completion，也不能替代last-responsible-point fresh precondition和semantic read-back。

429和transient failure处理：

- 尊重SDK/response明确的retry time；
- 使用bounded jittered backoff；
- mutation timeout先semantic read-back；
- retry前重新验证Project、Root和当前mutation precondition；
- 达到runtime上限后释放permit，写一条去重的operator-visible Problem；
- 不保存durable retry counter或next-at timestamp作为Workflow state。

## 6. Error、Problem与日志

所有runtime error归一化：

```text
RuntimeProblem
  code
  scope: application | binding | root | stage | profile | workspace
  severity
  sanitized_reason
  action_required?
  first_observed_at
  last_observed_at
```

`RuntimeProblem`是Podium/Desktop observation，可过期、覆盖或在restart后重新发现。只有影响用户下一步
的Root error才写入Root Primary/Timeline Comment；heartbeat loss和tool progress不写Linear。

日志使用binding/root/stage/profile correlation IDs，不记录Token、cookie、Authorization header、API
Key、raw Profile credential、Provider transcript、SDK object或不受限Issue内容。绝对Profile path在UI和
public logs中脱敏。

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

1. 停止新的Root/Stage admission；
2. 停止所有Stage接受新的tool call；
3. 请求Performer graceful cancel；
4. 在deadline内等待当前Request处理或read-back结束；
5. terminate剩余process trees；
6. 关闭private channels和logs；
7. 只有确认退出后报告stopped。

shutdown不会把Root标成failed或Canceled。下次启动从Linear/Git重新选择并创建fresh Stage；不恢复
旧Wire或Provider thread。

## 9. Safe worktree cleanup

cleanup只删除可证明属于同一Conductor/Root的deterministic worktree，并同时满足：

- Root已经Done/Canceled或用户明确请求cleanup；
- 没有live process、permit或writer；
- worktree identity、repository common git dir和expected branch一致；
- 没有未提交修改、未push commit或未交付branch，除非用户明确批准丢弃；
- path位于配置的worktree root内且不是repository root、home或宽泛目录；
- Git worktree metadata和filesystem target都精确解析。

任一证明失败都停止并显示具体原因。cleanup不作为Root completion的必要步骤，也不改变Linear状态。

E2E遗留Root的显式quiescence是独立的operator mutation：只接受目标Project内唯一的合法
run-marker digest和确认词，将Root置为Canceled并做Project、marker、parent和state read-back。
它不改变Root ownership或Conductor routing；并行runner不会隐式调用它。

## 10. Failure matrix

| 故障 | Runtime动作 | Workflow恢复 |
|---|---|---|
| Stage process/connection启动失败 | 释放permit，记录Problem | 写attempt terminal record，保留reservation并过Root convergence gate |
| Linear mutation上限到达 | 拒绝mutation，结束Stage后释放permit、read-back | 从fresh Linear/Git重新选择Stage |
| heartbeat停止/硬wall-time耗尽 | cancel、terminate、read-back | lease过期后保留reservation并过Root convergence gate |
| Wire在terminal Result前中断 | 终止Stage、释放permit、read-back | 按Stage协议处理已持久化事实或fresh retry |
| terminal Result重复/迟到 | 以execution identity与precondition拒绝旧Result | Workflow facts不变 |
| Linear 429 | bounded backoff，释放超时permit | 下次full-read继续 |
| mutation unconfirmed | semantic read-back | 以read-back事实继续 |
| Git HEAD变化 | 拒绝旧Result/mutation | fresh Stage重新审计Git |
| Host/Conductor crash | replacement前证明旧tree退出 | full-read所有Roots/Git |
| upgrade失败 | 保留旧完整bundle | Workflow不变 |
| cleanup证明不足 | 不删除 | Root/branch保持可恢复 |

## 11. 验收边界

1. 每个running Binding恰好一个current Conductor generation。
2. capacity单位是active Stage invocation；Root仍是全局admission与workspace单位。
3. Stage绑定execution identity和fresh precondition；旧Context/Result不能修改新事实。
4. launch、heartbeat、Stage limits、cancel和child-process cleanup有界；Provider token只做Stage后观察。
5. 同一Root同时最多一个workspace writer。
6. Linear request遵守rate-limit，ambiguous write先read-back。
7. runtime observations不参与Root scheduling或Workflow恢复。
8. upgrade不原地覆盖binary，失败可回到上一个完整bundle。
9. shutdown停止新admission并确认process tree/connection退出。
10. cleanup只删除经过完整identity和dirty-state证明的worktree。
11. crash后不恢复permit、process、Wire或Result；status/attempt/lease/token reservation/Finding/retry从Linear managed comments重新派生。
12. physical Linear request和protocol request分别观测，background最多使用request与complexity窗口的25%。

## 12. 不变量

1. Runtime hardening不能创建第二套Workflow authority。
2. Root是顶层排序、admission、workspace和恢复单位；active Stage invocation是capacity单位。
3. 所有runtime handles、permits、普通progress heartbeats和Problems都可丢弃；recovery lease写Linear。
4. Linear/Git事实修复后Root自然恢复，不需要operation resume API。
5. Stage protocol与Human suspend/resume只由
   [Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。
6. 当前runtime不预建sub-agent、memory或Provider-specific capacity控制面。

# V3 Runtime Hardening

状态：目标架构提案。本文定义Agent Symphony Harness的进程、资源、请求、升级、shutdown和cleanup
边界；不定义Linear工作流、Root内部步骤或V4 Agent Cluster。

## 1. Scope record

```text
authorized
  - 多Conductor Binding的single-generation reconcile
  - 全局Root Turn capacity与有界admission
  - Root worktree single-writer和maintenance coordination
  - Linear request broker、rate-limit和bounded retry
  - structured logs、Problems、health和Desktop observations
  - immutable runtime bundle、atomic upgrade、bounded shutdown和safe cleanup
  - Performer readiness、Turn limits、heartbeat、cancellation和child-process cleanup
  - Provider-native sandbox mode和有界command allowlist/denylist

required_consequences
  - runtime state全部可丢弃，不能成为Workflow authority
  - capacity只决定何时运行Root，不改变Linear Priority/order/blocker
  - Host/Conductor crash后从Binding、Linear和Git重新建立runtime
  - failure必须有界、脱敏、可观察并释放资源
  - execution policy只做closed DTO映射，不形成Symphony通用授权系统

out_of_scope
  - V4 roles、child Turns、fan-out/fan-in或Agent Cluster capacity
  - Workflow DB、Root/Leaf Queue、dispatch table、attempt journal或Stage checkpoint
  - 多writer、per-Agent worktree、自动merge或远程Agent runtime
  - 第二Provider Backend
  - 动态RBAC、逐命令人工审批、任意策略表达式或Provider config map

assumptions_requiring_approval
  - none

deferred_ideas
  - V4 Agent Cluster capacity sharing
  - V5 Provider-specific runtime adapters
```

## 2. Runtime与Workflow边界

V3 runtime可以维护以下memory-only对象：

```text
RootTurnPermit
InstallationLinearRequestBroker
PerformerProcessHandle
HeartbeatObservation
ShutdownDeadline
```

这些对象可以在crash后全部丢失。它们不能保存或推导current Leaf、Plan/Work/Gate phase、accepted
Result、retry attempt或下一Root。重启后：

```text
read Conductor Bindings
-> re-establish one generation per running Binding
-> discover all Root headers and lazily fresh-read candidate Trees
-> inspect deterministic Git workspaces
-> assess and schedule Roots normally
```

runtime observation只能回答“进程是否还活着、资源是否占用、请求是否被限流、用户该采取什么
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

每个generation有runtime-only ID、PID/process identity、start time和health channel。它不写Linear，也不
进入Root Primary Status Comment。Host必须证明旧process tree已经退出，才能启动replacement。

Conductor通过Binding stable identity和Root full `conductor_id`判断ownership；generation ID不能接管或
迁移Root。

## 4. Root Turn admission

V3 capacity单位是Root Turn，不是Leaf、stage或Provider request：

```text
RootTurnPermit
  binding_id
  root_issue_id
  performer_profile_id
  performer_id
  admitted_at
  launch_deadline_at
```

permit只存在于内存并在以下事件释放：

- Performer process结束；
- launch deadline到期且process未成功启动；
- Turn deadline、cancellation或shutdown；
- Root Done/Canceled或ownership变化；
- Conversation retry替换current `performer_id`；
- process tree被确认终止。

获得permit后、launch前必须重新读取Root current Conversation和terminal/ownership facts。permit中的
`performer_id`与Linear不匹配时直接放弃；不能把permit转给另一个Root或新Conversation。

全局capacity可以在多个Bindings间做round-robin或weighted fairness，但只在已经按各自Linear
Priority/order选出的Root candidates之间分配runtime。它不能创建FIFO、aging或durable ready sequence。

## 5. Process readiness与cancellation

Conductor启动Performer后必须区分：

```text
spawned -> protocol ready -> Root Turn running -> result written -> exited
```

只有protocol ready后才发送Root context。启动失败、request validation失败或channel未ready不能被
当作Agent业务失败。

每个Root Turn在launch前验证context bytes，在运行中限制wall time、broker calls和mutation数量，
并提供bounded stdout/stderr、heartbeat和完整child-process cleanup。heartbeat只证明process最近活跃；
它不刷新Root/Leaf状态，也不能延长wall deadline。

Provider token usage只能在完整Provider Turn返回后观察，不能精确中断in-flight Provider调用。
broker calls或mutations达到上限后拒绝新的command；wall deadline耗尽则取消整个Turn。Conductor随后
释放permit、fresh read-back Linear/Git，并让同一Root重新参与Priority调度；不能直接续跑某个Leaf，
也不记录partial Turn或remaining token budget。

timeout/cancel顺序：

1. 停止接受新的tool call；
2. request graceful cancellation；
3. 等待bounded grace period；
4. terminate整个child process tree；
5. 确认process tree已退出后释放permit；
6. read-back Linear/Git并重新评估Root。

## 6. Workspace single-writer与maintenance

一个Root只有一个deterministic worktree，V3调度器任何时刻最多启动一个writer。每个write、commit
和delivery command都重新检查worktree identity、current `performer_id`和Git HEAD。

以下maintenance需要先取消writer并确认process tree退出：

- worktree create/recreate；
- safe cleanup；
- repository relink或base branch变更；
- runtime bundle replacement影响正在运行的binary；
- shutdown。

crash后Conductor检查真实Git worktree、lock、status和process liveness。无法证明安全时进入
`needs_attention`，不能reset/clean猜测恢复。

## 7. Linear request broker

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
- retry前重新验证Project、Root和current Conversation；
- 达到runtime上限后释放permit，写一条去重的operator-visible Problem；
- 不保存durable retry counter或next-at timestamp作为Workflow state。

## 8. Error、Problem与日志

所有runtime error归一化：

```text
RuntimeProblem
  code
  scope: application | binding | root | turn | profile | workspace
  severity
  sanitized_reason
  action_required?
  first_observed_at
  last_observed_at
```

`RuntimeProblem`是Podium/Desktop observation，可过期、覆盖或在restart后重新发现。只有影响用户下一步
的Root error才写入Root Primary/Timeline Comment；heartbeat loss和tool progress不写Linear。

日志使用binding/root/turn/profile correlation IDs，不记录Token、cookie、Authorization header、API
Key、raw Profile credential、Provider transcript、SDK object或不受限Issue内容。绝对Profile path在UI和
public logs中脱敏。

## 9. Immutable runtime bundle与atomic upgrade

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

bundle pointer和payload只属于runtime delivery，不保存Root、Conversation或Workflow state。

## 10. Bounded shutdown

application、Binding或upgrade shutdown：

1. 停止新的Root admission；
2. 停止所有Turn接受新的tool call；
3. 请求Performer graceful cancel；
4. 在deadline内等待当前command/read-back结束；
5. terminate剩余process trees；
6. 关闭private channels和logs；
7. 只有确认退出后报告stopped。

shutdown不会把Root标成failed或Canceled。下次启动从Linear/Git判断是否resume同一Conversation或继续
Root-level retry。

## 11. Safe worktree cleanup

cleanup只删除可证明属于同一Conductor/Root的deterministic worktree，并同时满足：

- Root已经Done/Canceled或用户明确请求cleanup；
- 没有live process、permit或writer；
- worktree identity、repository common git dir和expected branch一致；
- 没有未提交修改、未push commit或未交付branch，除非用户明确批准丢弃；
- path位于配置的worktree root内且不是repository root、home或宽泛目录；
- Git worktree metadata和filesystem target都精确解析。

任一证明失败都停止并显示具体原因。cleanup不作为Root completion的必要步骤，也不改变Linear状态。

## 12. Failure matrix

| 故障 | Runtime动作 | Workflow恢复 |
|---|---|---|
| Performer spawn失败 | 释放permit，记录Problem | Root保持原Linear/Git事实 |
| broker/mutation上限到达 | 拒绝新command，完成Turn后释放permit、read-back | 同一Conversation重新参与Root调度 |
| heartbeat停止/硬wall-time耗尽 | cancel、terminate、read-back | 同一Conversation重新参与Root调度 |
| Conversation unavailable | 取消旧Turn并终止process tree | V3 Root-level retry替换ID |
| Linear 429 | bounded backoff，释放超时permit | 下次full-read继续 |
| mutation unconfirmed | semantic read-back | 以read-back事实继续 |
| Git HEAD变化 | 拒绝旧command | 新Root Turn审计Git |
| Host/Conductor crash | replacement前证明旧tree退出 | full-read所有Roots/Git |
| upgrade失败 | 保留旧完整bundle | Workflow不变 |
| cleanup证明不足 | 不删除 | Root/branch保持可恢复 |

## 13. 验收边界

1. 每个running Binding恰好一个current Conductor generation。
2. capacity单位是Root Turn，不是Leaf或Stage。
3. Turn绑定current `performer_id`，Root retry后旧Turn request失效。
4. launch、heartbeat、Turn limits、cancel和child-process cleanup有界；Provider token只做Turn后观察。
5. 同一Root同时最多一个workspace writer。
6. Linear request遵守rate-limit，ambiguous write先read-back。
7. runtime observations不参与Root scheduling或Workflow恢复。
8. upgrade不原地覆盖binary，失败可回到上一个完整bundle。
9. shutdown停止新admission并确认process tree退出。
10. cleanup只删除经过完整identity和dirty-state证明的worktree。
11. crash后不恢复permit、attempt、Stage或Result。
12. physical Linear request和protocol request分别观测，background最多使用request与complexity窗口的25%。

## 14. 不变量

1. Runtime hardening不能创建第二套Workflow authority。
2. Root是V3唯一admission、Conversation和retry单元。
3. 所有runtime handles、permits、heartbeats和Problems都可丢弃。
4. Linear/Git事实修复后Root自然恢复，不需要operation resume API。
5. V4 Cluster和V5 Provider扩展复用这些runtime边界，不能复制capacity控制面。

# Performer Python Agent Runtime

状态：目标架构提案。Performer是Python Agent和Provider SDK边界；它承载Root Reconciler以及Plan、Work、
Verify执行角色，但不拥有Linear workflow、Root lifecycle或Git topology。

## 1. 职责

Performer负责：

- 通过官方Provider SDK创建、继续、interrupt和关闭role thread；
- 每个Root一个Root Reconciler thread，每个Cycle隔离Plan、Work、Verify三个Stage threads；
- open时接收一次完整Root bootstrap，后续ReAct turn只接收严格连续的delta；
- 返回closed `RootReconcilerTurnResult`；只有gate-specific intent variant携带matching用户comment dispositions和业务语义，
  failure variant只提供当前调用的closed failure；
- 执行Plan/Work/Verify turn并返回matching semantic Result或mechanical `StageTurnFailure`；
- Work turn内部运行有界coding-agent tool loop，并只允许Work root/descendants创建递归subagents；
- 映射model、effort、Fast、sandbox、deadline和structured output；
- 校验generated wire contracts并归一化Provider failure；
- 使用isolated Performer Profile `CODEX_HOME`。

Performer不负责：

- 调用Linear SDK/GraphQL、Podium或Conductor endpoint；
- 创建、更新、archive或restore Issue；
- materialize `RootSemanticIntent`、Human Action、comment reply或Stage Result；
- 判断Root convergence、创建successor Cycle或delivery；
- commit、push、创建worktree或修改Git topology；
- 把Provider transcript/thread当作durable workflow authority。

## 2. Session模型

```text
RootAgentRuntime
  root_reconciler_session -> one Provider thread across Root Cycles
  cycle_sessions[]
    plan_session          -> separate Provider thread
    work_session          -> dedicated containment + persistent Work root, multiple Work targets
      current_turn_epoch? -> fresh descendant tree for one stage_execution_id
    verify_session        -> separate Provider thread
```

同一Root最多一个active Reconciler session，同一Cycle每个Stage角色最多一个active Symphony session。每个session绑定一个runtime
generation并按`open -> executing -> closing -> closed`推进；一个generation同时最多有一个active turn。每个session可以有多个串行的
Conductor驱动turn；Work session跨多个Work Issues复用。Stage角色不能兼任Root Reconciler
或共享Provider conversation。

session handle是Performer内部或opaque Symphony runtime identity，不能暴露raw Provider thread ID。Cycle terminal关闭该Cycle三个
Stage sessions；每个Work turn永久retire matching mutation epoch和descendants，只有Work root thread可以进入下一turn。Work role
session只有在workspace write capability永久撤销且matching containment empty/isolated得到proof后才算关闭。
semantic cancel intent、routing/process generation变化或Profile失效时关闭Root Reconciler并拒绝late output。`closing`拒绝new turn；
旧generation的Provider output、continuation或write capability在任何后续state都没有authority。

## 3. 调用协议

Conductor始终是caller：

```text
PerformerAgentClientInterface
  openRootReconciler(bootstrap) -> RootReconcilerOpenedResult + initial RootReconcilerTurnResult
  advanceRootReconciler(delta) -> RootReconcilerTurnResult
  executePlanTurn(request) -> PlanTurnResponse
  executeWorkTurn(request) -> WorkTurnResponse
  executeVerifyTurn(request) -> VerifyTurnResponse
  closeCycleStageSessions(command) -> CloseCycleStageSessionsResult
  closeRootReconciler(command) -> CloseRootReconcilerResult
```

底层transport可以是Conductor创建的长连接process channel或等价的request/response协议，但不能变成Performer
主动callback。Performer返回的event和response只是当前Conductor call的输出。

Root Reconciler contract由[Root Reconciliation](root-reconciliation.md)定义；Plan/Work/Verify contract由
[Performer Stage Contracts](stage-orchestration.md)定义。Performer内部不能维护另一份字段或enum定义。

## 4. Provider边界

```text
ProviderBackendInterface
  openSession(role, profile, settings)
  executeTurn(session, request, workspaceCapability?) -> ProviderTurnOutcome
  interruptTurn(session)
  closeSession(session)
```

`ProviderTurnOutcome`是closed union：`not_accepted | accepted_valid | accepted_invalid | acceptance_unknown | session_lost | canceled`。
backend不得以arbitrary dictionary、mutable exception attributes或throw/null组合代替该结果。只有`accepted_valid`携带validated semantic
output；每个variant明确continuation、baseline和session generation consequence。

Work还要求backend提供role-session open/close以及turn-epoch begin/execute/seal/abort的closed internal capability。该能力、六个
model-facing协作工具、hard reservations、write grants和runtime containment只由[Work Subagents](work-subagents.md)定义，
不进入其他role或Conductor-facing Provider types。

当前实现目标为`CodexBackendImpl`。Backend差异只存在于`*BackendImpl`，公共Result不包含SDK object、Token、
raw error、reasoning、transcript或credential path。

`CodexBackendImpl`只使用官方SDK public API；不得调用Codex CLI、读取/改写`config.toml`或`auth.json`、依赖
private SDK成员或静默放宽sandbox。无法表达完整policy时fail closed。

### 4.1 Provider I/O诊断capture

Provider I/O capture默认关闭，只能由process-start环境中的`SYMPHONY_PROVIDER_IO_CAPTURE_DIR`显式启用。Conductor验证其为
operator指定的absolute directory，并为每个Conductor、Profile和process generation派生独立JSONL文件；Performer只接收
派生后的内部file path。该开关不是Profile设置、Podium API、Desktop control或workflow capability，不修改`.env`，也不能由
Root、comment或Provider输出开启。

开启时，`CodexBackendImpl`在调用SDK前同步append exact model-visible session/turn input，包括base instructions、current prompt与
SDK options；SDK返回后在任何JSON/schema/business validation前append原始`final_response`、status和error；SDK抛错时append
matching exception type与未改写的`str(error)`。每条record使用local session/turn capture ID，并带request、Root、Cycle、Stage
等已有correlation；capture失败必须以`provider_io_capture_failed` fail closed，且若Provider已经返回，continuity仍按`accepted`
处理，不能伪装成`not_accepted`。

capture文件不走Performer stdout/stderr、Conductor public runtime logs、Podium、Desktop或Linear，创建mode为`0600`，也不记录
request中的`secrets`字段、Provider credential、Authorization header、API Key或`CODEX_HOME`内容。model-visible input和原始
output可能包含完整Root、comment、repository facts及其他敏感业务内容；因此目录授权、retention与删除由启用它的operator负责。
Symphony不读取、上传、展示、索引或解析capture文件，不用它恢复Provider continuity、重放turn、生成workflow事实或裁决E2E。
它是临时diagnostic evidence，不是transcript store、context checkpoint或durable workflow authority。

## 5. Role prompt资源

Performer使用四个与role一一对应、随应用打包的英文Markdown资源：

```text
src/performer/prompts/
├── root-reconciler.md
├── plan.md
├── work.md
└── verify.md
```

这些文件是代码仓库内的只读应用资源，不是Profile、用户或部署配置。Performer不提供prompt locale、运行时覆盖、
文件监听、热加载、管理UI或外部prompt path。修改prompt等同于修改应用代码，必须经过代码评审、测试、构建和重新
部署；已经打开的Provider session继续使用其创建时的base instructions，新进程中的fresh session才使用新资源。

Performer内部prompt loader在process composition时一次性读取全部四个打包资源，校验后形成不可变的closed
role-to-prompt mapping；创建matching Provider session时只从该内存映射取得完整Markdown并作为base instructions交给
backend。resource缺失、不可读、空白、不是打包资源或role未知时必须fail closed；不得回退到backend中的内联字符串、
另一个role的prompt、Provider默认prompt或Profile配置。process运行期间不重新读取文件。prompt正文、文件路径和loader
对象不跨Conductor-Performer contract，不进入Linear、normal/public日志、Result或Provider Profile；唯一诊断例外是4.1中
operator显式启用且只能本地读取的Provider I/O capture。

Markdown只拥有稳定的role identity、职责、禁止事项和决策/执行方法。每轮bootstrap、delta、Stage context、
`instruction_bundle`和其他dynamic facts仍来自validated request；matching structured-output schema仍从
[`packages/contracts/schemas`](contracts.md)的closed contract生成并单独传给Provider。`instruction_bundle`是本轮
Stage目标与上下文的一部分，不是base prompt名称、resource selector或运行时prompt覆盖。prompt不能增加RootSemanticIntent、
Result variant、字段、workflow状态或capability；Provider输出即使符合自然语言要求，只要不符合matching schema、
correlation或Conductor gate仍必须拒绝。

四个prompt统一使用明确的`Role and Authority`、`Trigger Conditions`、编号`Workflow`、
`Anti-Rationalization`、`Red Flags`、可验证`Exit Criteria`和`Output Contract`。这些章节把何时执行、如何逐步处理、
哪些常见理由不能放宽边界、何时必须停止以及何种证据允许返回terminal output写清楚；它们不能创建第二套contract。

`root-reconciler.md`必须同时包含[Root Reconciliation](root-reconciliation.md)定义的Mermaid gate循环和等价的英文
规则，并明确四类gate及禁止机械调度/mutation字段。`plan.md`、`work.md`和`verify.md`
必须分别实现[Performer Stage Contracts](stage-orchestration.md)定义的role边界和Mermaid分支流程。Mermaid只表达
既有closed RootSemanticIntent或Result之间的判断顺序，不能成为第二套状态机；prompt不得复制或重新定义wire schema。

### 5.1 Provider注入分层

Performer必须把Provider session输入分为五层，不能把它们每turn重新拼成一份完整prompt：

| 层 | 注入时机 | Provider conversation语义 |
|---|---|---|
| stable base instructions | 仅fresh role session创建时 | matching role Markdown定义的workflow与authority |
| role-scoped initial context | 仅fresh session首个turn | Root完整bootstrap，或Stage的matching role/Cycle最小投影 |
| current turn command | 每个turn | 当前trigger、target、pending input identity和本轮要求 |
| model-visible context update | initial之后按需 | 仅该role baseline之后新增、replacement或tombstone fragments |
| Provider request metadata | 每个Provider调用 | model、tools、sandbox、limits、correlation和structured-output schema |

前四层中只有current command和本轮新增context update可以在已有session的后续conversation中出现。base instructions
和initial context已经进入matching Provider history后不得重新注入、摘要后替换或作为“安全上下文”再次展开。backend必须
使用Provider支持的opaque thread/response continuation提交strictly incremental items；不能从已有transcript重建一份
完整messages数组交给下一turn。Provider不支持可证明的增量continuation时，该backend不满足session contract，必须fail
closed，不能静默退化为每轮重放完整prompt。

structured-output schema始终是每次调用的机械Provider参数，因为它约束该次返回值；它不属于conversation history，
不得展开成field-by-field自然语言、示例JSON或重复的output instructions塞进current turn command。Provider可能如何计算
schema参数自身的用量由Provider负责，本架构只保证Symphony不把schema再复制成model-visible prompt内容。

Root delta和Stage role-context delta中的每个change都是有独立identity/version/correlation的逻辑context fragment，
但不要求一个fragment对应一个Provider SDK item，更不要求一个comment单独触发一个turn。backend可以把同一冻结观察批次
编码成一个bounded item或多个items，只要不丢失每个fragment的identity、消费与reply coverage，且不把整份baseline重新
序列化。turn执行期间到达的新事实只进入下一次context update。

每个role session独立维护Provider-visible baseline和opaque continuation；Root、Plan、Work、Verify之间不得共享或fork
conversation。Root Reconciler的完整bootstrap不能成为Stage startup context，Stage也不能继承另一个Stage role或前一Cycle
的history。fresh Stage session只能从Conductor提供的matching role-scoped initial projection开始。

Provider history只append current-value、replacement和tombstone fragments，不修改旧item。已经确认append但业务Result或
RootSemanticIntent尚未materialize的事实不在同一live thread重复发送；human input disposition、materialization和workflow推进
仍由native Linear/Git current facts独立决定。append是否成功或continuation baseline无法证明时关闭session，并由Conductor
从fresh Linear/Git facts重建fresh initial context；正常运行不持久化transcript、fragment log或context checkpoint。4.1的
opt-in diagnostic capture不能被Performer读取，因此不改变该恢复不变量。

本节优化的是每个turn新增的model-visible输入，不定义总conversation token上限、compaction、旧history裁剪或摘要替换
策略。资源limits仍用于拒绝单次过大的initial/delta/result，但不能作为重复注入完整上下文的理由。

### 5.2 Provider append确认与失败

Performer backend对每次Provider turn必须归一化为以下三种互斥事实；HTTP状态、SDK exception或本地进程退出本身不能被猜成
其中任一种：

| Provider事实 | baseline与session consequence | 当前业务turn consequence |
|---|---|---|
| `not_accepted`：Provider明确证明本次items未进入thread | baseline保持base；session只有在continuation仍被明确证明有效时才可保留 | 返回typed turn failure；不得自动重放command |
| `accepted`：Provider明确返回matching thread/response continuation，证明本次items已进入history | baseline原子推进到target，即使后续structured output缺失、schema-invalid或业务Result被Conductor拒绝 | 返回matching valid Result，或typed output/turn failure；失败不撤回baseline |
| `acceptance_unknown`：提交后timeout、断连、cancel race或任何无法证明是否进入history的结果 | 立即使continuation和baseline失效并关闭/丢弃session | 返回typed ambiguous-continuation failure；不得在旧thread重试或补发 |

`accepted`证据必须绑定matching local role session、Provider continuation、turn attempt和本次完整append batch；仅有request已发送、
stream收到部分token、usage、日志文本或可重试错误不足以推进baseline。baseline推进与validated model output是两个顺序独立的
判定：先根据Provider acceptance更新runtime continuity，再验证structured output。baseline更新不是Human input disposition、
RootSemanticIntent接受、Stage Result materialization或workflow进度。

没有validated业务output时，Root与Stage matching failure envelope都必须包含以下closed union；Conductor不得从通用
`retryable`、timeout或transport category反推continuity：

```text
ProviderTurnContinuity =
  | {
      kind: retained,
      append_outcome: not_accepted | accepted,
      provider_visible_context_digest
    }
  | {
      kind: closed,
      append_outcome: acceptance_unknown | session_lost
    }
```

`retained + not_accepted`中的digest是本次base；`retained + accepted`中的digest是本次target；二者之外的组合无效。
`closed`不携带digest，因为旧baseline不再可引用。matching failure同时使用closed error code区分
`provider_append_not_accepted`、`provider_output_schema_invalid`、`provider_append_acceptance_unknown`和`provider_session_lost`。
`retryable`的意义由matching outer failure union封闭定义，任何值都不授权重放本次request；对于`StageTurnFailure`，只有
`workspace_fence_unproven`为true且只允许retry generic close，不能直接发起后续业务turn。成功Result隐含`retained + accepted`且其
matching context digest必须是target，因此不重复携带该union。

`not_accepted`不授权Performer内部重试；Conductor下一次fresh observation可以针对仍连续的session发出一个新的turn。
`acceptance_unknown`后的唯一恢复是使用新Symphony session/turn identity，从fresh Linear/Git/repository facts生成matching role
完整initial和新current command。旧request body、旧command、旧delta、partial response或本地transcript都不重放；仍pending的
human input从native receipt/reply/target facts重新推导，并随新command引用。此fresh-open是丢失runtime continuity后的唯一
恢复语义，不是兼容fallback，也不允许持久化可供Symphony读取的fragment log、transcript、cursor或context checkpoint；4.1的
operator-only capture不能用于恢复或重放。

Work response中的该union只描述persistent Work root thread；descendant Provider continuity不会展开到public contract。Child failure只有在
Performer证明其thread/context/containment与root隔离后才可保留root continuation，否则整个Work role session返回`closed`并走fresh
session恢复。完整规则由[Work Subagents](work-subagents.md)拥有。

## 6. Agent行为

### 6.1 Root Reconciler

Root Reconciler在session open时消费一次完整bootstrap，此后只消费`base_root_digest`连续的delta，并返回一个closed
`RootReconcilerTurnResult`。其gate-specific intent variant可包含matching用户comment dispositions；failure variant不包含业务intent。
它
不能访问workspace write tool、Linear、Git mutation或其他role thread transcript。其rationale必须是bounded、
可审计解释，不包含raw chain-of-thought。

同一Root Reconciler role只执行`requirement_and_comment | plan_human_decision | recovery_strategy | terminal_review`四类gate。
这些gate不是新role、thread、Stage、Result或workflow state；实际Linear/Git materialization和delivery仍全部由Conductor完成。

### 6.2 Plan

Plan read-only，生成Plan Contract和initial Work DAG proposal。它不创建Issue或Action，不能直接调用Work。

### 6.3 Work

Work workspace-write。一个turn只接收一个selected Work target，但内部可以反复读取、编辑、运行命令、观察错误和修复，
直到完成、blocked或runtime终止。只有Work可以创建subagent；descendants仍属于同一个Work role并共享current turn budget与
Root worktree，但write access由subsetted lease机械限制，且不能跨`stage_execution_id`复用。Work root负责分工、final diff
review、checks和唯一semantic `WorkResult`；Performer只在机械失败时返回`StageTurnFailure`。完整语义见
[Work Subagents](work-subagents.md)。Work不能修改Cycle DAG；发现调整需要时返回structured facts。

### 6.4 Verify

Verify使用独立read-only thread，绑定immutable target revision。它不继承Work conversation，不修改代码或
Finding，不决定successor Cycle。

## 7. Runtime与恢复

Performer不保存workflow数据库。live session可以在进程内维持Provider continuity；恢复只依赖Linear/Git：

| 故障 | 处理 |
|---|---|
| turn transport失败 | 先invalidate matching generation，再按role关闭/fence；以mechanical StageTurnFailure contract fail closed且不产生业务结论 |
| Provider thread丢失 | close Symphony session；Conductor用fresh facts打开fresh role session |
| Performer process崩溃 | Reconciler和Stage sessions全部丢弃；Conductor从Root facts重建 |
| Work tree留下部分修改 | 永久撤销matching write epoch并fence containment；fresh Git/worktree facts进入下一份delta；session丢失则fresh bootstrap。Root Reconciler决定继续、rerun、replan或supersede |
| stale/late Result | correlation/digest/precondition检查拒绝 |
| Human等待 | turn结束并释放active execution；session可保留或丢弃，恢复结果相同 |

Provider session retention是性能优化，不是完成条件。系统必须在任意thread丢失后仍能从完整durable facts继续。

## 8. 资源与安全

- 每个Root Reconciler/Plan/Work/Verify turn有独立weighted-token、tool、context、result和wall-time limits；
- Work turn的weighted-token、tool和wall-time limits覆盖root与全部descendants，并在dispatch前hard reserve；
- Cycle和Root预算由Conductor机械gate，Performer只执行授予的turn limits；
- stdout/stderr、event frame和tool output必须bounded和sanitized；
- Plan、Verify、Root Reconciler是read-only；只有Work获得matching workspace-write capability；
- cancellation先撤销matching result/write authority，再interrupt active Provider turn并fence child execution；
- Work semantic Result前必须永久retire matching mutation epoch并fresh-read worktree；PID/process group不作为writer proof；
- secrets和auth material不进入request/result/log或Linear content。

## 9. Profile Control

Profile control仍是独立closed protocol，负责SDK login/status和受支持设置验证。Profile复用认证与设置，不复用
跨Cycle conversation。完整规则由[Performer Profile](performer-profiles.md)定义。

## 10. 不变量

1. Performer拥有全部Agent SDK和Provider thread实现。
2. 每个Root有一个Reconciler thread；每个Cycle有Plan、Work、Verify三个隔离角色thread。
3. Conductor是唯一caller；Performer不反向调用Conductor。
4. Root Reconciler只返回gate-specific RootSemanticIntent及comment dispositions；执行角色返回semantic Result，Performer返回mechanical failure。
5. Work thread可以跨Work Issues复用，但每turn只有一个target。
6. Performer不直接拥有Linear/Git workflow副作用。
7. Provider thread、transcript和operator diagnostic capture都不是durable authority。
8. 只有open request允许完整Root snapshot；advance request只允许delta，baseline mismatch必须fresh bootstrap。
9. 四个role各自只加载一个随Performer打包的英文Markdown resource；不存在运行时覆盖、locale或inline fallback。
10. Markdown定义稳定role行为，validated request提供本轮事实，generated schema和Conductor gate始终拥有机械执行边界。
11. 四个prompt都明确trigger、分步workflow、anti-rationalization、red flags、evidence exit criteria和output contract；
    Mermaid只解释既有closed flow，不新增schema或状态。
12. 已有session的Provider输入只追加current turn command和该role的new/replacement/tombstone fragments；base instructions、
    initial context、完整Root/Cycle snapshot和其他role transcript不得重复注入。
13. structured-output schema是每次调用的独立机械参数，不得复制成自然语言turn prompt。
14. 只有Work role暴露subagent tools；Root Reconciler、Plan和Verify没有该tool capability。
15. Work tree的全部nodes共享一个Work turn和Root worktree；只有root跨turn保留，descendants在epoch closure后失效。
16. 只有Work root生成semantic `WorkResult`；runtime cancel、budget、Provider或fence failure使用`StageTurnFailure`。
17. Work turn/session关闭、deadline或异常必须在write revocation与containment proof后释放writer capability；Provider archive、
    PID和process group不是closure proof。

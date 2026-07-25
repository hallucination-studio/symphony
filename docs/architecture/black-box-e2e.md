# 并行黑盒端到端验收

状态：目标架构提案。本文是Symphony生产边界并行黑盒E2E拓扑、actor隔离、证据读取和Case判定的唯一
事实源；不代表当前E2E runner已经匹配，也不定义产品Workflow。

## 1. Scope record

```text
authorized
  - 在同一个真实Linear Project中并行运行多个E2E Cases
  - 至少三个真实Conductor Binding、process、Profile和Repository Context
  - 使用独立Linear human actor完成真实用户交互
  - 只以最终fresh Linear/Git read-back和durable overlap判定
  - all-settled收集全部Case结果

required_consequences
  - E2E只能通过生产公开边界启动、配置、观察和交互
  - 测试不能代替Symphony创建managed records或推进Stage lifecycle
  - Case verdict只属于临时测试报告，不写Linear/Git且不参与恢复
  - mandatory Case非passed时Campaign必须非零退出
  - E2E Roots保留在Linear中作为可审计事实

out_of_scope
  - Desktop UI自动化和视觉验收
  - fake Linear、fake Provider或synthetic completion
  - load、soak、随机fuzz和无界chaos
  - 同一Root的多个active Cycles或多个workspace writers

assumptions_requiring_approval
  - none

deferred_ideas
  - 独立的load/soak Campaign
  - seeded revision fuzz和大规模Conductor churn
```

## 2. 权威边界

产品事实仍只由Linear和Git拥有。E2E读取并验证这些事实，但不创建E2E专用Workflow record、Issue status、managed
comment、checkpoint、completion marker或恢复账本。

`Parallel Black-Box E2E Campaign`、`E2E Case`和`E2E Case Verdict`是test-only transient概念：

- Campaign只组织并发进程、deadline和Case promise；
- Case只声明用户操作和最终证据predicate；
- verdict只在所有读取结束后分类为`passed | failed | incomplete`；
- 它们都不能写入Linear、Git或`podium.db`，也不能被Conductor、Performer或Root Reconciler读取。

Linear中的Root、Cycle、Stage、Human Action、managed records和comment thread仍遵守各自named concern文档。
本文件只定义如何从产品外部证明这些设计在真实边界成立。

## 3. 完整黑盒边界

Campaign只能使用以下外部边界：

- 通过正式Podium/Desktop control-plane入口创建Conductor Binding、Profile和process；
- 启动未修改的生产Conductor和Performer executable；
- E2E Human Actor通过Linear公开API执行真实用户可执行的操作；
- Git Observer通过标准Git命令或远端公开API读取repository、revision、checks和delivery；
- process controller只做启动、停止、kill和restart，用于验证真实恢复边界；
- 结束时从Linear公开API和Git重新读取全部验收事实。

完整黑盒E2E禁止：

- 导入Podium、Conductor或Performer的`internal/*`实现；
- 直接实例化`LinearSdkImpl`、`LinearGatewayProtocolHandlerImpl`或任一产品Impl；
- 直接读取或写入`podium.db`、Profile文件、Conductor data root或Provider session；
- 调用内部Conductor/Performer/harness方法推进Root、Stage或Human Action；
- 测试直接创建或修改strict `symphony` code block、Stage Result、Plan Contract、Finding、usage、timeline或reply record；
- 测试修改Plan/Work/Verify Issue status、archive、relation或description以帮助Workflow完成；
- fake gateway、fake Provider、synthetic Result、synthetic `final`或测试专用production branch。

测试工具可以在自身进程中使用Linear公开client，但不能从产品包深路径复用Podium内部SDK实现。这个外部测试client
代表真实human actor，不改变“Podium是产品内唯一Linear SDK和credential owner”的产品边界。

### 3.1 Required Linear write outage transport gate

`required Linear write fail-closed` Case可以在E2E test runtime向Podium的**物理**Linear request wrapper注入一个
bounded、in-memory request gate。它只用于临时制造真实channel的不可用窗口，不是Conductor、Performer、Root Reconciler
或Workflow业务模块的接口，也不写入`podium.db`、Linear、Git、日志证据、Profile或任何恢复状态。

gate的匹配范围必须同时满足以下条件：

- matching Case Root的`append_workflow_comment` physical mutation；
- 已观察到该Root的`plan_completed` Stage Result；
- 待写入的唯一terminal `symphony` block是Cycle timeline，且其`source_record_ids`包含该Plan Result ID。

gate暂停原始physical request，不伪造Result、timeline、read-back或后续Stage事实；恢复后只能让同一原始request继续。
Human script必须按`wait until blocked -> restore -> approve real Plan Action`顺序执行。gate的armed/blocked/recovered内存值
只证明测试是否已经触达故障注入点，不能进入Case snapshot、evidence predicate、verdict、报告或Campaign exit code。若没有
命中暂停点，Case只能因没有形成足够的Linear/Git事实而`incomplete`，不能以timeout、controller内存或日志判为通过。

被故障窗口阻塞的write本身不会留下durable“outage occurred”记录，所以final fresh evidence不能声称从Linear单独重建该窗口。
它只验证可持久化的fail-closed结果：唯一Plan Result、其确定性timeline identity及read-back、以及所有后续Stage execution/result
严格晚于该timeline comment创建时间。任何更早后续Stage事实是`failed`；缺少所需事实是`incomplete`。

## 4. Actor与credential隔离

一个Campaign至少使用两个可在Linear read-back中区分的actor：

| Actor | Credential owner | 允许行为 |
|---|---|---|
| Symphony Actor | production Podium installation | 生产Conductor经Podium执行的全部Workflow read/write |
| E2E Human Actor | external test secret store | 创建Root、写普通comment、修改Root description/status、处理Human Action、resolve/reopen thread |

两个actor必须具有不同的Linear actor identity。E2E启动前通过公开read验证身份，不能只依赖环境变量名称或测试配置中的
声明。credential不能写入Root、comment、日志、verdict或artifact；错误只报告脱敏actor identity和operation。

E2E Human Actor只能模拟产品用户：

- 创建带唯一Campaign/Case标识和明确需求的Root Issue；
- 设置用户可设置的Priority、routing label、description和Root status；
- 写入、编辑普通Markdown comment和code block；
- 将Human Action从`Todo`/`In Progress`流转到批准的terminal status并提供必要reason/answer；
- 对comment thread执行Linear原生resolve/reopen。

reaction、managed reply、timeline、Plan/Work/Verify结果、Cycle创建和所有Symphony-owned mutation必须由生产进程生成。

## 5. 最低真实拓扑

所有Conductor和Cases共享一个真实Linear Project。Project Conductor Pool至少包含三个member：

```text
Parallel Black-Box E2E Campaign
├── External Linear Human Driver
├── Git Observer
├── Conductor A
│   ├── parallel happy path
│   └── same-Conductor scheduling Cases
├── Conductor B
│   ├── parallel happy path
│   └── Human Action / revision Cases
└── Conductor C
    ├── restart / recovery Case
    └── convergence / successor Case
```

每个Conductor必须拥有不同的：

- `ConductorBinding`、full `conductor_id`和Conductor Short Hash；
- OS process tree和private protocol connection；
- active Performer Profile及隔离的`CODEX_HOME`；
- `RepositoryContext`和实际Git repository/worktree root；
- Root routing label集合。

共享Project只用于验证真实pool、routing、rate-limit和多Conductor并发。Case按创建时记录的Root Issue ID和唯一routing
label读取证据，不能以Project中“最新Issue”或无界title搜索猜测归属。一个Conductor故障不能停止、重启或重新配置其他
Conductor。

## 6. Campaign执行协议

Campaign按以下单向阶段执行；这些阶段是测试编排步骤，不是可恢复状态机：

```text
validate external credentials and production binaries
-> provision three or more public Bindings and repositories
-> reach one process-start barrier
-> release all production Conductor process starts concurrently
-> provision and activate isolated Profiles through each live control-plane
-> reach one Case-readiness barrier
-> create every Case Root concurrently with explicit routing
-> run independent human drivers and observers concurrently
-> await every Case with all-settled semantics
-> discard polling caches
-> fresh-read final Linear Trees and Git facts
-> derive Case verdicts and one Campaign exit code
```

process-start barrier必须在全部Bindings和repositories可从公开边界read-back后才释放。Profile属于Conductor，所以只能在
matching process online后经正式control-plane创建和激活；不能由runner直接写Profile文件。Case-readiness barrier必须等待
三个或更多Profile全部fresh read-back为ready，随后并发创建Cases，不能用串行`for await`逐个执行。每个Case拥有独立
deadline和promise，单Case的failure、timeout或process exit不cancel其他Case。

轮询只用于发现何时可以执行下一次真实human action。轮询缓存、webhook、process stdout和本地Case observation在最终
判定前全部丢弃。全局deadline到达时停止新增human action，但仍对每个Case执行一次bounded final fresh read。

Root revision and comment Case必须避免把用户连续的native thread操作压缩为一个不可观察的当前值：Human Actor在`resolve`
后，必须通过新建外部client的fresh Linear read等待matching `resolved` thread-state input的accepted directive、reply和
read-back；只有该边界成立后才能`reopen`。`reopen`后也必须同样等待matching `unresolved` input的durable reply，才可结束
该Case的human script。两次等待只决定何时执行下一次真实用户操作，不构成事件历史、checkpoint或verdict输入；最终判定仍只
使用Case settle后的独立final fresh Linear/Git snapshot。这样Case不要求Conductor重放close/reopen history，而是在两次
用户操作之间保留可从Linear重建的durable事实。

required Linear write Case同样只把gate作为下一步外部操作的短暂同步边界：Human Actor等待matching physical write已被暂停，
恢复该**同一**请求后才处理真实Plan Review Action。gate不会生成evidence、不会保留到Case完成后，也不会替代Case结束时的
fresh Linear/Git read。

Campaign不自动删除、archive、cancel或quiesce测试Roots。Root保留其生产Workflow最终状态和完整active/archived历史。
重复运行使用新的Campaign/Case identity和新的三个或更多Conductor identities/routing labels，不复用旧Root作为本次通过
证据，也不让新Conductor admit旧Campaign未完成的Root。

## 7. Command surface

E2E只保留以下两条Campaign相关命令。它们不互为alias、fallback或替代证据：

| Command | Purpose | Credentials | CI role |
|---|---|---|---|
| `npm run test:e2e:runner` | 确定性、无密钥的Campaign contract和negative-control验证 | 不读取`.env`或Workflow credential | required |
| `npm run e2e` | 启动唯一的真实Parallel Black-Box E2E Campaign | 从已存在时的`.env`读取授权输入，或使用外部环境 | explicit authorized run only |

`make e2e`只能调用`npm run e2e`。Desktop shell smoke是Podium Desktop production-entrypoint的独立观测，不是Campaign
command、Campaign证据或Workflow E2E的替代；它不属于上表的任一命令。

真实Campaign CLI在缺失或无效输入、required runtime不可用，或其他启动失败时必须fail closed：只向stderr写一行结构化JSON，格式为
`{ "status": "failed", "reason_code", "issues" }`，并以exit code `1`结束。`reason_code`和`issues`只能是稳定的公开码；不输出
credential、token、provider transcript、原始exception、Root/Issue正文或任意环境变量值。不存在`doctor`、环境测试alias、成功占位
或配置不足时的synthetic Campaign result。

## 8. Test-only closed contract

runner内部使用versioned、closed的test-only Command/Result，禁止任意metadata：

```text
RunParallelBlackBoxE2ECampaignCommand
  version: 1
  campaign_id
  project_id
  started_at
  deadline_at
  conductors[]:
    binding_id
    conductor_id
    conductor_short_hash
    repository_identity
  cases[]:
    case_id
    mandatory
    routed_conductor_ids[]
    deadline_at
    human_script_id
    evidence_predicate_id

ParallelBlackBoxE2ECampaignResult
  version: 1
  campaign_id
  cases[]: E2ECaseResult
  durable_overlap_evidence_refs[]

E2ECaseResult
  case_id
  status: passed | failed | incomplete
  reason_code
  evidence_refs[]
  observed_at
```

`human_script_id`和`evidence_predicate_id`必须从runner代码中的closed registry选择，不能执行来自Linear的脚本或任意
表达式。`E2ECaseResult`只输出到CI报告；它不是Linear comment、managed record、product Event或下一轮Campaign输入。不存在
`pending/running/final` Case lifecycle，也不存在从旧verdict恢复Campaign。

每个Case创建Root后，runner只在内存中保留一个closed `CaseRootSet`：

```text
CaseRootSet
  root_issue_ids[]  # 1..8, unique Linear Issue IDs
```

它是Human Actor创建后返回的精确final-read目标，不是Command字段、Linear事实、Product contract、checkpoint或恢复输入。
任何额外字段、重复ID或缺失ID都使该Case不能产生通过verdict。普通Case的集合恰有一个Root；cross-Conductor happy-path
Case恰有两个，顺序固定为`A_root`、`B_root`，并且必须与`routed_conductor_ids[]`中的`A`、`B`顺序严格对应；
same-Conductor preemption Case恰有两个，顺序固定为`in_flight_root`、`updated_root`；Conductor restart isolation Case恰有
三个，顺序固定为`C_root`、`A_root`、`B_root`，并且必须与`routed_conductor_ids[]`中的`C`、`A`、`B`顺序严格对应。
它们只供closed Human/operator script和predicate定位外部对象，不是durable checkpoint。

## 9. Final Evidence Snapshot

每个Case在settle后重新创建外部clients，并以其spec中的精确Root IDs读取：

1. 每个Root的完整active和archived Issue Tree、status catalog、relations、comments、native thread state和reactions；
2. 全部strict `symphony` managed code blocks及其stable identity、remote version和actor；
3. matching Stage Execution、Stage Result、Plan Contract、Human resolution、Finding、timeline、reply和Model Turn records；
4. matching repository的fresh branch、commit、diff、checks和delivery read-back。

需要证明same-priority `updatedAt`抢占时，还要fresh-read matching Roots的Linear原生Issue activity/audit entries，以重建
human mutation后的admission输入和actor/time顺序。该history只属于外部验收证据，不发送给Conductor/Performer、不进入
Root Tree或Root Reconciler，也不成为产品Workflow authority。

该Case只有同时满足以下事实才成立：两个Root具有同一Priority和同一full `conductor_id` ownership；预验证的Human Actor
对`updated_root`写入普通description；一个in-flight Stage满足`started_at < human update < matching Result.completed_at`；
且`updated_root`在该update后的最早且时间戳唯一的Stage Execution在该Result之后开始，期间没有`in_flight_root`的新Stage
Execution。最早候选的时间戳并列时证据不足，必须`incomplete`，不能按读取顺序猜测。此前已完成的
同Root Stage不影响in-flight识别。任一顺序、ownership、actor或record linkage不成立时必须failed或incomplete，不能用
polling、process或本地timer补足。

任一required page、archived child、comment、reaction、thread state、managed block或Git fact读取不完整时，snapshot标记coverage
incomplete，不能使用较早轮询结果补齐。最终predicate必须同时验证预期事实和禁止事实；例如不能只验证Root进入
`In Review`，还必须验证matching Verify、delivery、usage和required timeline/reply都存在且无第二条completion路径。

process exit code、Conductor/Performer内存、Provider session、runtime log、timeline event publish返回值、polling cache和
runner本地`final`字段只能帮助诊断，不能进入通过predicate或`evidence_refs`。

### 9.1 Conductor restart isolation

restart isolation Case的operator script必须先从公开观察边界等待`C_root`出现in-flight Stage，再只通过process controller
对`C`执行`SIGKILL`和使用相同公开Binding输入的fresh process start。该等待和kill/restart调用只决定何时触发真实故障；
它们不写Linear/Git，不保留restart checkpoint，也不进入final predicate。

settle后final fresh snapshot必须同时证明以下durable事实：

1. `C_root`只有一个matching `root_ownership`，其full `conductor_id`严格等于路由中的`C`；旧in-flight
   `StageExecutionRecord`有唯一matching terminal Result，且其`outcome_kind`为`execution_failed`或`canceled`。
2. 旧execution不得有任何`plan_completed`、`work_completed`或`verify_passed`的matching Result。旧execution的第二个
   或success Result都是stale output已materialize，Case必须失败，不能依据process日志推断其是否曾经返回。
3. C的replacement execution与旧execution拥有相同Root、Cycle、Node和Stage，使用不同`stage_execution_id`，在旧failure
   Result完成后开始；它的唯一非`canceled`/`execution_failed` terminal Result使用不同`role_session_id`，并在旧failure后
   完成。该Result证明fresh session已由Linear/Git durable facts重新打开；Provider thread、PID或内存session不能代替它。
4. `A_root`和`B_root`各自只有一个matching ownership，分别严格等于路由中的`A`和`B`。各自存在一条唯一成功的
   execution/result interval：开始早于C旧failure完成，完成晚于C replacement Result完成。interval内不得出现
   `execution_failed`、`canceled`或第二个execution/result；这条连续durable链是A/B未被停止、重启、重配置或接管的唯一
   可验收证据。

任何ownership、lineage、session、timestamp或terminal Result歧义都是`incomplete`；已读取到的stale成功output、错误
ownership、A/B failure/cancel/replacement或不连续interval都是`failed`。没有durable的“process restarted”记录，且不得创建
该记录。

### 9.2 Durable overlap

Campaign必须证明至少两个不同Conductor执行过真正重叠的Stage interval。唯一允许的证据是final fresh read中的：

- matching `StageExecutionRecord.started_at`；
- 同一`stage_execution_id`的Plan/Work/Verify Result `completed_at`；
- Root routing和Root Control Record证明两个interval属于不同full `conductor_id`。

存在interval A和B满足以下条件才算overlap：

```text
conductor(A) != conductor(B)
max(A.started_at, B.started_at) < min(A.completed_at, B.completed_at)
```

process存活时间、日志交错、Promise并发、Root `In Progress`时间重叠或本地timer都不能证明并行执行。

## 10. Verdict与failure语义

final snapshot读取完成后才产生verdict：

- `passed`：全部required positive/negative predicates成立，snapshot coverage完整；
- `failed`：fresh durable事实证明出现禁止行为、错误terminal Result、错误routing/ownership、错误顺序或越过required write；
- `incomplete`：deadline或外部读取失败后仍缺少足够durable事实，无法证明passed或failed。

发现错误terminal Stage Result或已经越过必需Linear write的后续事实时立即settle该Case为`failed`，不能继续等待它“最终
变好”。只有事实尚未收敛且不存在相反证据时才等待到Case deadline；deadline不是成功，也不能合成completion。

Campaign使用all-settled：等待全部Case各自完成final fresh read，再汇总所有verdict。任一mandatory Case不是`passed`，
Campaign非零退出；optional Case只能补充诊断，不能抵消mandatory failure。报告按Case列出脱敏reason和durable
Linear/Git references，不输出Issue正文、credential、Provider transcript或内部runtime state。

## 11. Mandatory Case matrix

| Case ID | Human script | Evidence predicate | Case | 外部用户/故障动作 | final fresh evidence |
|---|---|---|---|---|---|
| `cross_conductor_happy_paths` | `approve_plan` | `happy_path` | cross-Conductor happy paths | 为A和B各创建并批准一个Root | 两条完整Plan -> approval -> Work -> Verify -> delivery链，且满足durable overlap |
| `same_conductor_preemption` | `preempt_same_priority` | `same_conductor_preemption` | same-Conductor preemption | Conductor已有in-flight turn时创建同Priority Roots，并由Human Actor更新其中一个Root | native activity证明admission前的Priority/`updatedAt`顺序，Stage records证明下一boundary先选择最新Root且未取消in-flight turn |
| `plan_rejection_and_supersession` | `reject_plan` | `plan_rejection_supersession` | Plan rejection and supersession | Human Actor拒绝Plan Action并给出reason | rejected resolution、旧Contract/Action/Result保留、Contract supersession、fresh Plan execution/Contract/Action；archive严格匹配accepted directive |
| `root_revision_and_comment` | `revise_root` | `root_revision_comment` | Root revision and comment | 修改Root description，写/编辑comment并resolve/reopen | Root Reconciler消费增量，产生matching reply、closed reaction disposition和thread action后再推进 |
| `conductor_restart_isolation` | `restart_conductor` | `restart_isolation` | Conductor restart isolation | `CaseRootSet`按`C,A,B`创建；C Stage in-flight时仅经process controller `SIGKILL`并fresh start C，A/B继续 | C旧failure/cancel、无stale成功Result、同Cycle/Node的新session replacement Result；A/B各一条跨越C恢复的连续成功interval和不变ownership |
| `cycle_exhaustion_and_successor` | `exhaust_cycle_budget` | `cycle_successor` | Cycle exhaustion and successor | 在Root claim前通过公开Conductor配置设置Cycle repair limit，并触发本Cycle预算耗尽 | terminal predecessor、durable Findings/attempts、matching successor Cycle和fresh Plan |
| `delivery_and_review` | `deliver_and_review` | `delivery_review` | delivery and review | 完成可交付Root | matching verified Git revision、delivery read-back和Root `In Review`一致 |
| `required_linear_write_fail_closed` | `required_write_outage` | `required_write_fail_closed` | required Linear write fail-closed | 通过bounded physical request gate暂停matching Plan Result的Cycle timeline write，恢复同一request后批准真实Plan Action | 唯一Plan Result的deterministic timeline identity已read-back，所有后续Stage `started_at`/Result `completed_at`严格晚于timeline comment；gate状态、日志、timeout不参与verdict |

每个Case可以使用多个Root，但每个Root只能属于一个Case。Case不得通过修改managed事实、手工完成Stage或调用内部
materializer制造证据。Plan approval由happy paths覆盖；rejection、普通comment、resolve/reopen、restart和successor分别由
独立Case覆盖，避免一个长Case失败后掩盖其他边界。

Campaign Command必须按上表顺序包含且仅包含这八个Case；每个都是`mandatory: true`。`cross_conductor_happy_paths`
固定路由到A、B，`conductor_restart_isolation`固定路由到C、A、B，其余Case路由到A。Case ID、Human script、
Evidence predicate、路由数量或mandatory标志的任一偏差都是无效Campaign，不能作为optional替代或别名接受。

## 12. 实现硬切换

实现本设计时直接删除串行、白盒或synthetic runner路径，不保留feature flag、adapter、dual runner或fallback。尤其必须
删除以下行为及其tests/fixtures：

- 从architecture acceptance条目串行选择少量scenario并复用同一production root；
- 通过产品`internal` import构造Linear/Podium边界；
- 直接写Store配置Binding、installation或Project；
- runner使用Symphony actor代替human actor批准Human Action；
- 用process/log/session/local evidence或synthetic `final`宣告完成；
- E2E cleanup/quiescence mutation改变被验收Root的最终事实。

新runner只有一条Campaign入口和一套mandatory Case registry。旧代码、旧配置项、旧fixture和旧测试必须在同一原子切换中
删除，不能声明deprecated后继续存在。

## 13. 不变量

1. 所有Cases共享一个真实Linear Project，最低拓扑是三个独立真实Conductor。
2. Symphony Actor和E2E Human Actor身份可从Linear durable facts区分。
3. 测试只做真实用户和外部operator可做的动作，不生成Symphony-owned Workflow事实。
4. 至少两个不同Conductor的Stage interval由durable Linear timestamps证明重叠。
5. 每个Case最终丢弃缓存并fresh-read完整Linear/Git事实。
6. verdict是transient CI classification，不是产品状态、record或恢复输入。
7. all-settled不因单Case失败而取消其他Case；mandatory非passed使Campaign失败。
8. 日志、process exit、session、runtime state和synthetic `final`永远不是完成证据。
9. E2E Roots不被runner清理或改写为测试专用terminal状态。
10. 旧串行/白盒runner与新Campaign不能并存。
11. required-write gate只制造临时外部channel故障；final verdict只使用恢复后的fresh Linear/Git事实，不能读取gate内存或把outage本身伪造成durable事实。

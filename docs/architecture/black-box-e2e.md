# 并行前台黑盒端到端验收

状态：目标架构提案。本文是 Symphony 真实生产边界 E2E 的唯一事实源，拥有 Campaign 生命周期、
环境隔离、用户模拟、并行 Case、最终证据和断言规则。它不定义产品 Workflow，也不表示当前 E2E
实现已经符合本文。

## 1. Scope record

```text
authorized
  - 每轮从专用 Linear 测试 Project 创建全新、可验证的运行环境
  - 在一个前台 Campaign 中并行执行多个 mandatory Cases
  - 使用多个真实 Conductor、真实 Performer、真实 Provider、真实 Linear 和真实 Git
  - 通过独立 Linear Human Actor 模拟用户创建 Root 和处理 Human Action
  - 为满足真实用户或 operator 能力而修正生产代码和正式公开边界
  - 直接删除旧 E2E runner、fixture、parser、control path 和 tests

required_consequences
  - E2E 只能创建环境、模拟用户、施加外部进程故障和读取最终事实
  - E2E 不能成为第二套产品控制面、Workflow 或状态机
  - Root 原始需求不可被测试为了通过而修改
  - 每个 Case 同时定义正向断言、禁止事实和证据不足条件
  - pass 只由 Case 结束后的 fresh Linear/Git read-back 得出
  - 一个 Case 失败不能取消其他 Case；所有 Case settle 后 Campaign 才退出
  - npm run e2e 在前台持续输出进度并负责全部子进程的有界清理
  - 现有 .env 变量名、含义和加载方式保持不变

out_of_scope
  - Desktop Workflow 操作或 Desktop 业务状态
  - fake Linear、fake Provider、synthetic Result 或 synthetic completion
  - load、soak、随机 fuzz 和无界 chaos
  - E2E 专用 production endpoint、test mode、兼容层或迁移逻辑
  - 使用 request gate 注入 Linear write failure 的真实 Campaign Case

assumptions_requiring_approval
  - none

deferred_ideas
  - 独立 load/soak Campaign
  - 在可由真实外部基础设施制造故障后增加 Linear outage Campaign
```

## 2. 定位与权威边界

E2E 是并行的用户行为模拟器和外部事实验证器，不是 Symphony 的测试版控制面。

```text
E2E 创建环境
-> 启动未修改的生产进程
-> 用户通过 Linear 创建不可变需求
-> Symphony 自主 admission、reconcile、plan、work、verify 和 delivery
-> 用户通过 Linear 响应真实 Human Action
-> E2E 从 Linear 和 Git fresh read 最终事实
-> E2E 计算 transient verdict
```

Linear 和 Git 仍是产品 Workflow 的唯一 durable authority。Campaign、Case、进度和 verdict 都是
test-only transient 值，不能写入 Linear、Git、`podium.db`、Profile、Provider session 或任一产品
managed record，也不能成为重启恢复输入。

E2E 可以启动、停止或杀死 OS 进程，因为这些行为属于环境和故障生命周期；它不能因此调用任何业务
推进接口。进程存活、日志、事件、Promise 状态和本地缓存只能帮助同步或诊断，不能证明业务成功。

## 3. 禁止第二套产品控制面

E2E 禁止：

- 直接调用 Root Reconciler 或 Plan、Work、Verify Performer；
- 指定下一 Root、Cycle、Stage、Work Issue 或 directive；
- 创建或修改 Stage Result、Plan Contract、Finding、Attempt、timeline、reply、usage 或其他 managed record；
- 直接修改 Plan、Work、Verify Issue 的 status、archive、relation、description 或 dependency；
- 从数据库、产品 `internal/*`、进程内存、Provider session 或事件总线读写 Workflow 状态；
- 用测试代码重试、修复、补偿或推进被阻塞的 Root；
- 根据运行结果追加提示、降低验收标准、改写需求或修改预期；
- 使用 test-only endpoint、environment flag、request gate、fake clock 或 synthetic `final` 改变业务结果；
- 在 runner 中重新实现调度、Root Reconciliation、Human Action lifecycle 或 managed-record parser；
- 把日志、process exit、runtime event 或 timeout 当作 pass evidence。

生产代码允许因本次 E2E 暴露的缺口而修改，但新增能力必须是实际用户或 operator 需要的正式能力，
例如正确的 Linear 交互、生产健康状态、结构化日志或共享 contract codec。只服务于测试推进业务的能力
不得进入产品。

## 4. 命令与配置契约

真实 Campaign 只有一个入口：

```bash
npm run e2e
```

它继续使用：

```bash
node --env-file-if-exists=.env <campaign-entrypoint>
```

现有 `.env` 配置名称和语义保持不变：

- `LINEAR_CLIENT_ID`
- `LINEAR_CLIENT_SECRET`
- `SYMPHONY_E2E_PROJECT_SLUG_ID`
- `SYMPHONY_E2E_LINEAR_DEV_TOKEN`
- `SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED`
- `SYMPHONY_E2E_CODEX_API_KEY`
- `SYMPHONY_E2E_CODEX_BASE_URL`
- `SYMPHONY_E2E_CODEX_MODEL`
- `SYMPHONY_E2E_LINEAR_HUMAN_TOKEN`

`SYMPHONY_E2E_LINEAR_DEV_TOKEN` 驱动生产 Podium installation；
`SYMPHONY_E2E_LINEAR_HUMAN_TOKEN` 驱动外部 Human Actor。启动前必须从 Linear fresh read 证明
它们属于不同 actor。credential 值不得进入日志、Issue、comment、报告或 artifact。

无密钥 runner 测试可以验证 Campaign、Case、signal、deadline、cleanup、verdict 和 negative controls，
但不能生成一个可替代真实 Campaign 的 synthetic success 路径。

## 5. 前台 Campaign 生命周期

`npm run e2e` 是唯一 foreground owner。正常运行不需要 `nohup`、PID 文件、后台日志或额外清理命令。

Campaign 只执行以下一次性阶段：

```text
validate configuration and actor separation
-> reset dedicated test Project
-> fresh-read initialized baseline
-> create isolated local runtime and repositories
-> start production Podium, Conductors and Performers
-> wait for one bounded readiness barrier
-> create all Case Roots concurrently through the Human Actor
-> run independent Human drivers concurrently
-> settle every Case with all-settled semantics
-> discard runtime observations and polling caches
-> fresh-read final Linear Trees and Git facts
-> derive all verdicts
-> bounded process cleanup
-> emit one summary and exit
```

这是一条不可恢复的测试进程生命周期，不是产品状态机。Campaign 不持久化 checkpoint，不从上一次
Campaign 恢复，也没有第二条 `final` 或 fallback 完成路径。

收到 `SIGINT` 或 `SIGTERM` 后，Campaign 停止创建新的用户操作，取消未完成的本地等待，对已创建 Root
执行一次有界 final read，终止自己拥有的子进程并退出。不得遗留 Conductor、Performer 或临时 process tree。

等待期间必须输出脱敏、结构化的前台事件：Campaign phase、Case ID、当前用户等待、elapsed time、deadline
和 heartbeat。进度事件不进入 Case evidence。

## 6. 环境初始化与清理

每轮 Campaign 在创建任一 Binding、Profile、repository、process 或 Case Root 前完成初始化：

1. 验证配置 Project 是明确授权的专用 E2E Project；
2. 平铺读取该 Project 的全部 active Issues，包括 `Done`、`Canceled` 和 `Duplicate`；
3. 对每个 active Issue 调用一次 Linear 原生 archive，不做 children 递归和级联假设；
4. fresh read-back 证明 active Issue 集合为空；
5. 清理只属于该测试 Project 的旧 active Conductor routing labels，并 fresh read-back；
6. 创建新的临时 `podium.db`、Conductor data roots、Profiles、Provider sessions 和 Git repositories；
7. 通过正式产品配置边界建立本轮多个 Conductor，并等待全部 ready。

已归档 Issue 不恢复、不遍历、不参与调度、Case 定位或 verdict。Case final evidence 在本轮结束后保留，
直到下一轮 Campaign 启动时成为 active baseline reset 的输入。

Campaign 结束时只清理自己拥有的本地临时目录和 process tree，不修改本轮 Linear/Git 最终事实。

## 7. 用户模拟与需求不可变性

E2E Human Actor 只能执行真实 Linear 用户可执行的操作：

- 创建 Root Issue，并设置 title、description、Priority、Root status 和 routing label；
- 仅对本 Case 已创建的 Root 写入 catalog 预声明的 description delta；它只能用于 business revision 或不改变
  目标和验收标准的 scheduling touch，不能修改 title、status、routing、relation、dependency 或任何 descendant；
- 写入或编辑普通 Markdown comment，包括 fenced code block；
- 处理产品创建的 Human Action Issue；
- 设置 Human Action 的正式 terminal status；
- 对原生 comment thread 执行 resolve 或 reopen；
- 在产品协议允许时添加 reaction。

测试不能创建 Human Action，也不能代替产品写 managed reply、timeline 或 reaction disposition。

每个 Case 在启动前固定：

```text
case_id
initial_requirement
initial_requirement_hash
root_creation_input
root_topology
declared_user_interactions
allowed_process_faults
verification_boundary
positive_assertions
negative_assertions
incomplete_conditions
```

Root 创建后，除 `root_revision_and_comment` 的预声明 revision，以及
`same_conductor_preemption` 的预声明非语义 touch 外，description 和验收需求必须与初始 hash 一致。
非语义 touch 只能增加不改变目标或验收标准的调度标记；最终 evidence 必须同时保留原始需求。

测试不得根据 Plan、Work、Verify、timeout 或错误动态生成新的用户需求。Revision Case 的 revision 内容、
触发条件和期望结果必须在 Campaign 启动前确定。

## 8. 并行执行模型

所有 mandatory Cases 在同一 readiness barrier 后并发创建 Root 并开始各自 driver。每个 Case 拥有隔离的：

- Root ID 集合和 routing；
- repository 或 worktree；
- deadline 和 AbortSignal；
- Human driver；
- polling cache；
- final evidence scope；
- sanitized correlation ID。

一个 Case 的失败、超时或 Human Action 等待不能取消其他 Case。需要多个 Root 或共享 Conductor 的 Case
必须显式声明 coordination group；该协调只约束用户操作时序，不能指定产品调度结果。

至少三个真实 Conductor 同时在线并拥有不同 Binding、full `conductor_id`、Profile、`CODEX_HOME`、
repository context 和 routing label。至少两个不同 Conductor 的 Stage interval 必须在 durable Linear facts
上重叠。

## 9. Mandatory Case 与断言

以下七个 Case 必须全部存在且均为 mandatory。Case 可以复用共享 fixture 和 evidence reader，但不能复用
可变 Root 状态或把另一个 Case 的成功当作自己的证据。

### 9.1 固定断言契约

Case definition 不是运行时脚本，而是 Campaign 启动前冻结的验收契约。它必须为每个 Case 固定：

- `root_topology`：精确的 Root 数量、每个 Root 的 routing、repository/worktree 归属，以及 Case 内需要
  相同或不同 Conductor 的关系；
- `verification_boundary`：这个 Case 在哪个可从 Linear/Git read-back 的稳定业务边界停止等待。它可以是
  Root `In Review` 与 delivery，也可以是一个明确的 fresh Human Action 等待；不能用 process ready、日志、
  local cache、timeout 或 test-owned `final` 表示；
- 命名的 `positive_assertions`、`negative_assertions` 和 `incomplete_conditions`。每条 assertion 必须声明
  需要的 Linear/Git fact scope、identity correlation 和顺序/唯一性规则，不能在运行中临时追加；
- predeclared Human operation 只作为等待到产品事实后的用户响应，不能选择 workflow 的下一步或生成替代事实。

断言评估只消费 Case final evidence snapshot。正向 assertion 只有在全部 required durable facts、correlation 和
顺序都成立时才满足；已读到与之矛盾的 durable fact 时为 `failed`，其他缺失或无法完整读取的情况为
`incomplete`。禁止 assertion 一旦在 fresh final evidence 中成立即为 `failed`。所有 assertion 都必须由
同一个 closed Case assertion vocabulary 实现其 `equals`、`unique`、`ordered`、`linked`、`aggregate`、
`archived`、`thread-state` 或 `interval-overlap` predicate；Case 不得注册任意代码、查询产品运行时或把
polling observation 变成 predicate。

除 Case 专有断言外，每个 Case 都必须通过下列共同断言：

1. 只读取自己 `root_topology` 中 Root 的 active/archived Tree 与匹配 Git repository；没有跨 Case 事实泄漏；
2. 最终 description、acceptance criteria 和普通用户输入与冻结的 hash/预声明 delta 一致；
3. 所有被 assertion 引用的 Issue、comment、thread state、reaction、managed record、execution/result、usage、
   ownership、delivery 与 Git fact 均具有可 read-back 的 source identity、version/digest 和 Root/Cycle correlation；
4. 完整分页、active/archived coverage、status catalog 和 Git coverage 均可证明；任何 coverage 缺口均不能 pass；
5. 没有 E2E 写入的 Human Action、Stage/managed record、DAG mutation、timeline/reply、usage 或 synthetic
   completion 参与 Case 成功链。

每个 Case 的 `verification_boundary` 与最小 Root 拓扑如下。这里的“完成”仅表示 Case 的验收边界已经成立；它不
创建第二套产品 terminal state，也不要求所有 Case 都将 Root 推到同一种状态。

| Case | 最小 Root 拓扑 | 固定验证边界 |
|---|---|---|
| `approved_happy_path` | 1 个 Root，1 个独占 repository | Root `In Review`、matching delivery 与唯一 passed Verify Result |
| `plan_rejected_and_replanned` | 1 个 Root，1 个独占 repository | 同一 Root 上 fresh Plan execution/Contract 与 fresh active Plan Review Human Action；它仍等待用户审批 |
| `information_requested_and_answered` | 1 个 Root，1 个独占 repository | Answered Action 之后的 fresh Plan execution/Contract 与 fresh active Plan Review Human Action |
| `root_revision_and_comment` | 1 个 Root，1 个独占 repository | 旧 Cycle 已 terminal，successor Cycle 有 fresh Plan execution/Contract 与 fresh active Plan Review Human Action |
| `parallel_multi_conductor` | 至少 2 个 Root，分别路由到不同 Conductor 与独占 repository | 每个 Root 都 `In Review` 且交付；至少一对跨 Conductor durable Stage interval overlap |
| `same_conductor_preemption` | 3 个同 Priority Root，路由到同一 Conductor、各自独占 repository | 三个 Root 都 `In Review` 且交付；被 touch 的 ready Root 在下一调度边界首先进入 Stage |
| `conductor_restart_recovery` | 至少 2 个 Root：1 个受影响 Root 与至少 1 个运行在另一 Conductor 的连续 Root | 受影响 Root 从 fresh execution 恢复至 `In Review`/delivery；连续 Root 也完成交付 |

### 9.2 Assertion identity and outcome rules

每个 Case definition 必须列出全部共同 assertion ID 与其所在 Case 行的全部 assertion ID，不能通过 callback、
predicate closure 或运行时条件添加、删除或替换 assertion。一个 assertion record 固定包含：`assertion_id`、`kind`、
Case-local fact scope、required correlation、closed predicate 和 stable reason code。`kind` 只能为：

- `required`：完整 final evidence 满足 predicate 时为 `satisfied`；任何已读取的冲突事实、错误 identity、错误
  status、重复事实或顺序违反时为 `contradicted`；缺少必须的 page、source、version/digest、archive coverage 或 Git
  coverage 时为 `coverage_missing`。
- `prohibited`：完整 final evidence 证明禁止事实不存在时为 `satisfied`；一旦读取到禁止事实即为
  `contradicted`；无法完整读取其 fact scope 时为 `coverage_missing`。禁止事实不能因后续 archive、success 或
  replacement 而被抹除。
- `boundary`：是一个 `required` assertion，表达 Case 可以停止等待用户交互的稳定 Linear/Git 事实；它不能缩减
  共同断言或同 Case 的其他 assertion。

每条冻结 record 使用下列闭合 shape；Case definition 只能填入本文已经列出的值，不能携带 callback、query、
function name、runtime object 或未列出的操作符：

```text
assertion_id: one catalog ID in this section
kind: required | prohibited | boundary
fact_scope: exact Case root_topology plus its matching repositories
correlation: immutable Case/root identity plus the documented Root/Cycle/Stage,
             Issue/comment/reaction, execution/result, delivery, or Git identities
predicate: closed vocabulary selector and the documented Case condition
reason_code: e2e.<case_id>.<assertion_id>
```

`reason_code` is a frozen diagnostic prefix, not an implementation-defined message. An assertion evaluator reports only
`<reason_code>.contradicted` or `<reason_code>.coverage_missing`; `satisfied` has no failure reason. The predicate's fact
scope and correlation are limited to the Case definition: a reader may not widen them by searching another Case's Root,
repository, polling cache, runtime state, or a new selector discovered while running. The common table below supplies the
closed condition for common IDs. For each Case-specific ID, the matching Case subsection's user behavior, positive facts,
verification boundary, prohibited facts, and incomplete rule together are that ID's closed condition; implementation does
not get to infer an additional one.

运行中的 Human driver 可以轮询 Linear current facts，以等待产品创建的 Human Action 或已预声明的 process-fault
时机；这种观察只决定是否执行已声明的真实用户操作，永远不改变 catalog，也不构成 assertion evidence。Campaign
settle 后必须丢弃该观察并重新读取 final evidence。

所有 Case 都有以下共同 assertion ID；它们的完整 fact scope 是自己的 `root_topology` 和 matching Git repositories：

| Assertion ID | Kind | Final-evidence condition |
|---|---|---|
| `case_scope_isolated` | required | 仅有 Case-local Root/archived Tree、repository、routing、ownership 和 correlation 被读取或引用；没有跨 Case fact。 |
| `requirement_input_preserved` | required | Root description、acceptance criteria 与普通用户输入匹配冻结 hash 及预声明 delta；允许的 non-semantic touch 不改变目标或验收标准。 |
| `durable_facts_correlated` | required | 每个被引用的 Issue、comment/thread/reaction、managed record、execution/result、usage、delivery 和 Git fact 都有 source identity、version/digest、Root/Cycle/Stage correlation 及 native status/archive read-back。 |
| `final_evidence_complete` | required | active/archived pagination、status catalog、relations、comments、activity、managed records 和 Git coverage 均完整；无 coverage omission。 |
| `no_e2e_control_facts` | prohibited | 成功链中没有 E2E 创建的 Human Action、Stage/managed record、DAG mutation、timeline/reply、usage 或 synthetic completion。 |

下表是每个 Case 除共同 assertion 外不可省略的最小 catalog。表中 ID 的精确定义由各 Case 小节的用户行为、正向
断言、验证边界、禁止事实和 `incomplete` 规则共同限定；实现只能用 closed assertion vocabulary 表达这些条件。

| Case | `required` / `boundary` assertions | `prohibited` assertions | `coverage_missing` condition |
|---|---|---|---|
| `approved_happy_path` | `plan_approval_precedes_work`; `stage_chain_delivered`; `turn_usage_aggregated`; `boundary_in_review_delivery` | `work_before_approval`; `duplicate_or_synthetic_completion`; `usage_missing_or_double_counted` | 任何 approval、stage/result、delivery、usage、timeline/reply 或 Git read-back 缺失。 |
| `plan_rejected_and_replanned` | `rejection_consumed_and_replied`; `rejected_lineage_retained`; `rejected_contract_superseded`; `boundary_fresh_plan_review` | `work_against_rejected_contract`; `contract_overwritten_or_history_deleted`; `test_created_replacement` | 已有 rejection 但无法完整关联旧 Contract、archive/supersession、fresh execution/Contract/Action。 |
| `information_requested_and_answered` | `information_action_actionable`; `answer_consumed_and_receipted`; `answer_drives_fresh_plan`; `boundary_fresh_plan_review` | `missing_answer_assumed`; `test_unblocks_or_mutates_stage` | 已提交 Answer 但无法关联 accepted input、reply/reaction 或 fresh Plan/Contract/Action。 |
| `root_revision_and_comment` | `ordinary_inputs_consumed_once`; `thread_transitions_receipted`; `revision_supersedes_cycle`; `boundary_successor_plan_review` | `system_comment_treated_as_input`; `thread_history_lost`; `undeclared_revision_or_conductor_interpretation` | 任一预声明 description/comment/edit/resolve/reopen delta 没有独立 accepted input、reply/reaction/thread action 或 successor/continue evidence。 |
| `parallel_multi_conductor` | `root_ownership_and_workspace_isolated`; `independent_delivery_chains`; `cross_conductor_stage_overlap`; `boundary_all_roots_delivered` | `cross_conductor_takeover`; `shared_workspace_writer`; `telemetry_substitutes_overlap` | 缺少任何 Root ownership、execution/result interval、timestamp 或 delivery coverage。 |
| `same_conductor_preemption` | `inflight_stage_completes`; `latest_ready_root_runs_next`; `remaining_ready_root_progresses`; `boundary_all_roots_delivered` | `inflight_turn_interrupted`; `test_selects_next_root`; `semantic_requirement_touch` | 任何 native activity/updatedAt/Stage interval 不能形成严格且无并列的下一调度顺序。 |
| `conductor_restart_recovery` | `old_execution_terminal_once`; `recovery_uses_fresh_execution`; `ownership_persists`; `unaffected_root_continues`; `boundary_recovered_and_continuous_delivered` | `late_old_session_success`; `checkpoint_or_linear_rewrite`; `unaffected_conductor_reconfigured` | 无法唯一关联被杀旧 execution、其 terminal result、fresh replacement、unchanged ownership 和连续 Root。 |

### 9.3 `approved_happy_path`

用户行为：创建一个明确、可在测试 repository 中完成的 Root，等待真实 Plan Review Human Action，按其说明
将状态流转为 `Approved`。

正向断言：

- 存在唯一 active Plan Contract、matching Plan Result 和 `Approved` Human resolution；
- Work 只在 approval durable read-back 后开始，全部 matching Work Issues 和 Results 完成；
- Verify 有唯一通过 Result，Git revision、checks、delivery 与 Root `In Review` 一致；
- Plan、Work、Verify Issue 记录各自模型名和 usage；Cycle usage 是该 Cycle 全部 model turns 的聚合；
- Root usage 聚合全部 Cycles 和 Root Reconciler model turns；
- required timeline、reply 和 managed records 均存在且可 read-back。

验证边界：唯一目标 Root 为 `In Review`，其 delivery、passed Verify Result 和 Git revision 彼此 matching。该
boundary 不能由 Root `Done`、local `final` 或单独的 Plan approval 代替。

禁止事实：approval 前开始 Work、多个 completion path、缺少 delivery、用本地 `final` 补完成、usage 重复或漏算。

`incomplete`：任一 required page、record、Git fact 或 read-back 缺失，且没有 durable 相反事实。

### 9.4 `plan_rejected_and_replanned`

用户行为：创建 Root，等待真实 Plan Review Human Action，以预声明普通用户 reason 将其流转为 `Rejected`。

正向断言：

- rejected Human Action、reason、Root Reconciler input 和 durable reply 均可读取；
- 旧 Plan Contract、Action、Execution 和 Result 保留审计历史；
- 旧 Contract 被 supersede，需移除的节点使用 Linear 原生 archive；
- 产生 fresh Plan execution、fresh Contract 和 fresh Human Action；
- replacement 使用新的 execution/session identity，并保留同一 Root 目标。

验证边界：replacement Plan 已形成 immutable fresh Contract，并由产品创建 fresh active Plan Review Human Action。
Case 不批准 replacement Action；该等待状态本身连同旧 Contract 的 supersession 是本 Case 的完整验收边界。

禁止事实：对 rejected Contract 执行 Work、原地覆盖旧 Contract、物理删除历史、E2E 创建 replacement Plan。

`incomplete`：rejection 已存在但尚无足够 durable facts 证明 supersession 或明确错误推进。

### 9.5 `information_requested_and_answered`

用户行为：等待产品创建需要补充信息的 Human Action，按 Action 描述提交预声明答案，并将 Action 流转到
正式 answered terminal status。

正向断言：

- Human Action 明确说明问题、需要的内容、提交位置和下一步；
- 用户答案以普通 comment 或 Human Action 约定字段存在，Action lifecycle 完整；
- Root Reconciler 消费该输入并产生 matching durable reply；
- 用户输入得到协议规定的 reaction disposition，Workflow 随后由产品自主继续。

验证边界：Answer 已被 consumption/reply 关联到初始缺失信息，随后出现只引用该 Answer 的 fresh Plan execution、
fresh Contract 和 fresh active Plan Review Human Action。Case 不替产品批准该 replacement Action，也不接受没有后续
Plan/Contract 的“已收到”文本作为 continuation。

禁止事实：缺失答案时自动假设、E2E 修改 Plan/Work/Verify、测试直接解除 Workflow 阻塞。

`incomplete`：答案已提交但尚无 matching accepted input、reply 或后续 durable decision。

### 9.6 `root_revision_and_comment`

用户行为：按预声明顺序修改 Root description，写入和编辑普通 comment，并对 comment thread 执行
resolve、等待 durable response、reopen、再次等待 durable response。

正向断言：

- 每个 description/comment/thread 增量都由 Root Reconciler 以独立 input identity 消费；
- first system comment、timeline 和 managed comment 不被当作用户输入；
- 每个用户 comment 都有 matching durable reply 和 reaction disposition；
- destructive business revision 使当前 Cycle terminal，并创建 successor Cycle 和 fresh Plan；
- 若 Case 中包含预声明 non-destructive comment，产品可继续时必须有明确 directive 和审计链。

验证边界：被 revision 取代的 Cycle 为 `Changes Required` 或 `Canceled`，successor Cycle 与旧 Cycle identity 不同，
并有 fresh Plan execution、fresh Contract 和 fresh active Plan Review Human Action。每次 comment body、edit、resolve
和 reopen 都必须在此之前已有自身 matching reply/reaction durable facts，不能被 successor 的存在掩盖。

禁止事实：丢失 resolve/reopen、把当前 comment 值伪造成历史、E2E 临时改写 revision、Conductor 自行解释 revision。

`incomplete`：任一预声明增量缺少 accepted input、reply、thread action 或 successor/continue decision。

### 9.7 `parallel_multi_conductor`

用户行为：并发创建至少两个分别路由到不同 Conductor 的独立 Root，并处理各自真实 Plan approval。

正向断言：

- 每个 Root 的 ownership、routing 和 repository identity 唯一且正确；
- 每个 Root 独立形成完整 Plan、approval、Work、Verify 和 delivery 链；
- 至少两个不同 Conductor 的 Stage intervals 满足：

```text
max(A.started_at, B.started_at) < min(A.completed_at, B.completed_at)
```

- overlap 只由 matching Stage Execution 和 Result timestamps 证明。

验证边界：每个 Case Root 都达到 `In Review`，且各自 delivery 与 passed Verify Result matching；至少一对不同
Conductor 的 matching Stage Execution/Result interval 满足上述 overlap 公式。

禁止事实：跨 Conductor 接管、共享 workspace writer、以 Promise 并发、日志交错或进程在线代替 durable overlap。

`incomplete`：Root 均可成功但缺少完整 interval、ownership 或 timestamp coverage。

### 9.8 `same_conductor_preemption`

用户行为：以相同 Priority 创建多个路由到同一 Conductor 的 Root；一个 Stage in-flight 时，对另一个 Root
执行预声明非语义 description touch，使其 `updatedAt` 最新。

正向断言：

- in-flight Stage 正常完成，不被抢占取消；
- 下一调度边界选择同 Priority 中 `updatedAt` 最新的 ready Root；
- native activity 证明 touch 的 actor、时间和顺序；
- 其他 ready Root 后续仍被调度，没有 starvation 或 ownership 变化。

验证边界：in-flight Root、被 touch Root 与另一 ready Root 均达到 `In Review` 并有 matching delivery。由 native
activity、Stage Execution 和 Result 建立严格顺序：in-flight Stage 先完成；随后被 touch Root 先开始 Stage；最后一个
ready Root 随后完成。三者必须保持同一 Conductor ownership。

禁止事实：中断当前 turn、并发写同一 workspace、测试指定 next Root、改变目标或验收要求来制造更新时间。

`incomplete`：时间戳并列、activity coverage 不完整，或未形成可比较的下一调度边界。

### 9.9 `conductor_restart_recovery`

用户行为：创建专属 coordination group；观察到一个真实 Stage in-flight 后，只对 owning Conductor 发送
`SIGKILL`，再从同一正式 Binding 启动 fresh production process。其他 Conductor 继续运行。

正向断言：

- 旧 execution 得到唯一 `execution_failed` 或 `canceled` Result，且不存在 matching success Result；
- replacement execution 使用新的 execution 和 role-session identity；
- Root ownership 保持不变，replacement 从 Linear/Git durable facts 恢复；
- coordination group 中其他 Conductor 的 Roots 保持连续执行并完成。

验证边界：受影响 Root 的 replacement execution 与 delivery matching 且 Root 为 `In Review`；每个连续 Root 也有
matching passed Verify Result、delivery 和 `In Review`。被杀进程的旧 execution 只能有唯一 terminal failure/cancel
Result，不能以迟到 success 或现存 session identity 贡献新的 delivery。

禁止事实：接受旧 session 的迟到成功结果、测试恢复 checkpoint、重写 Linear 状态、停止或重配其他 Conductor。

`incomplete`：无法从 final facts 唯一关联旧 execution、terminal Result、replacement 和 unaffected Roots。

## 10. 公共断言与 verdict

每个 Case 的 final reader 都必须 fresh-read：

1. 精确 Root IDs 对应的完整 active 和 archived Issue Tree；
2. Team status catalog、relations、comments、native thread state、reactions 和 relevant activity；
3. strict managed code blocks及其 identity、version 和 actor；
4. Root Reconciler inputs/directives/replies、Stage Executions/Results、Plan Contracts、Human resolutions、Findings、
   attempts、timeline、usage 和 model turns；
5. matching Git branch、commit、diff、checks 和 delivery facts。

final reader 必须为每个 assertion 返回独立的 evidence coverage，而不是只返回一个 Case 级布尔值。一个 fact 只能在
它的 source identity、Root/Cycle/Stage correlation、native archive/status 和 remote version/digest 都可读取时被 assertion
引用。Case assertion 之间可以引用同一 snapshot fact，但不得共享另一个 Case 的 assertion result、polling cache 或
runtime observation。`verification_boundary` 只是 assertion group 的目标事实，不能绕过共同断言或 Case 专有禁止事实。

最终分类只有：

- `passed`：该 Case 全部正向断言成立、全部禁止事实不存在、coverage 完整；
- `failed`：fresh durable facts 已证明任一禁止事实、错误 terminal outcome、错误 ownership、错误顺序或需求被篡改；
- `incomplete`：deadline 或外部读取结束后证据仍不足以证明 passed 或 failed。

发现 durable 失败事实后可以提前停止该 Case 的用户操作，但仍必须做 final fresh read。timeout 永远是
`incomplete` 或 `failed`，不能合成成功。所有 mandatory Cases 使用 all-settled 汇总；任一 Case 不是
`passed`，Campaign exit code 非零。

报告只包含 Case ID、verdict、稳定 reason code、elapsed time 和脱敏 evidence references。Issue 正文、
credential、Provider transcript、原始 exception 和环境变量值不得输出。

## 11. 时间与进度模型

Campaign 使用一个 monotonic deadline 和一个顶层 AbortSignal。每个 Case 使用不超过 Campaign deadline 的
独立 bounded scope。reset、process start 和 Profile readiness 不消耗尚未 admission 的 Root durable budget；
Root deadline 仍按 [Root Reconciliation](root-reconciliation.md) 在首次 admission 时 materialize。

前台 reporter 至少输出：

- Campaign `resetting | starting | ready | running | final-reading | cleaning` phase；
- 每个 Case `creating-root | running | waiting-human | final-reading | passed | failed | incomplete` observation；
- 周期 heartbeat、elapsed time 和剩余 deadline；
- signal handling、子进程退出和 cleanup outcome。

这些值仅是当前进程的观察文本，不可恢复、不写产品存储，也不能参与 pass predicate。

## 12. 实现硬切换与复杂度约束

实现本文时原子删除旧 E2E，不保留 alias、adapter、feature flag、dual runner、fallback 或 retired tests。
目标目录只保留下列职责：

```text
campaign     前台生命周期、readiness、并发、signal、summary
environment  reset、临时资源、生产进程、bounded cleanup
cases        不可变用户输入和预声明交互
human        Linear 外部用户操作
evidence     共享 contract codec + fresh Linear/Git read
verdict      纯正向/负向/coverage predicate
reporter     脱敏前台进度
```

通用 process management、polling、deadline、Linear pagination、managed-record decoding 和 cleanup 各只能有
一份实现。Case 文件不得创建 process、reset Project、解析私有 code block 或实现 Workflow 决策。

真实 Campaign 不包含 request gate 或 required-write outage 注入。required Linear write fail-closed 由拥有该
物理 transport 的生产模块集成测试验证；未来只有能从产品外制造真实 outage 时，才可新增独立黑盒 Case。

## 13. 不变量

1. E2E 创建环境、模拟用户和验证事实，但不控制 Workflow。
2. `npm run e2e` 是前台、可中断、会清理、最终自行退出的唯一真实入口。
3. `.env` 配置名称、语义和加载方式保持不变。
4. 七个 mandatory Cases 在 readiness barrier 后并行执行，并拥有明确正向、负向和 incomplete 断言。
5. 需求在启动前固定；测试不得为通过而改变目标或验收标准。
6. Human Action 由产品创建，E2E 只能通过 Linear 模拟真实用户响应。
7. Linear/Git final fresh read 是唯一 pass authority。
8. runtime event、log、process、session、timeout 和 synthetic `final` 永远不是成功证据。
9. all-settled 保留每个 Case 结果；单 Case 失败不取消其他 Case。
10. 旧 runner、旧 fixture、旧 evidence parser 和第二套控制面在硬切换后不得残留。

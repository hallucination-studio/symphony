# Performer Profile与Codex配置

状态：目标架构提案。本文定义Podium Desktop如何配置和选择多个Codex Performer
Profiles，以及Conductor、Performer和Codex SDK之间的所有权边界。

## 1. 核心结论

- Desktop允许每个Conductor创建多个Performer Profiles；
- 当前只支持`backendKind: codex`；
- 每个Profile拥有独立、deterministic的`CODEX_HOME`；
- Conductor保存Profile索引、非秘密设置和active Profile；
- Performer通过官方Codex Python SDK执行ChatGPT登录、API Key登录、状态读取和Turn；
- Symphony不读取、复制、解析或改写`auth.json`、`config.toml`或其他Codex-owned文件；
- Desktop通过Podium发出Profile Command；Podium只做瞬时转发和View组合，active Profile由
  Conductor验证并持久化；
- Profile切换不重启Conductor，下一次Root claim立即使用新active Profile；
- Root固定使用claim时的Profile；每个Root创建Reconciler thread，每个Cycle创建隔离Plan、Work、Verify threads；
- model、reasoning effort和Fast由Conductor保存为产品设置，并由Performer映射为SDK参数；
- sandbox mode和command allowlist/denylist由Conductor保存，并由Performer映射为Provider-native策略；
- Token使用量来自validated Root Reconciler/Stage Result中的Codex SDK usage；完成数量来自Linear Root事实。

## 2. Canonical模型

```text
PerformerProfile
  profileId
  displayName
  backendKind: codex
  authenticationMethod: chatgpt | api_key
  codexTurnSettings
    model
    reasoningEffort: none | minimal | low | medium | high | xhigh
    isFastModeEnabled
  executionPolicy
    sandboxMode: read_only | workspace_write | unrestricted
    commandAllowlist[]
    commandDenylist[]
  createdAt
  updatedAt
```

Profile不保存：

- API Key；
- access token或refresh token；
- Codex account object；
- `auth.json`或`config.toml`内容；
- absolute `CODEX_HOME`；
- Provider SDK handle。

`isActive`、readiness、account display和usage是派生View，不写入
`PerformerProfile`。

`backendKind`和`authenticationMethod`在Profile创建后不可修改。用户需要切换登录方式
时创建另一个Profile；这样不会让同一`CODEX_HOME`中残留的认证上下文与Profile定义
互相矛盾。`UpdatePerformerProfileCommand`只修改`displayName`和
`codexTurnSettings`、`executionPolicy`。

## 3. CODEX_HOME所有权

每个Profile路径由Conductor确定性生成：

```text
<conductor-data-root>/
  performer-profiles/
    profiles.json
    <profile-id>/
      codex-home/
```

所有权：

| 事实 | 所有者 |
|---|---|
| `profiles.json` | Conductor |
| Profile ID、display name、auth method、Turn settings、execution policy | Conductor |
| active Profile ID | Conductor |
| Profile目录和`CODEX_HOME`路径分配 | Conductor |
| `CODEX_HOME`内部文件格式和内容 | Codex SDK |
| 登录、Token refresh、account status | Codex SDK / `CodexBackendImpl` |
| Profile选择UI | Podium Desktop |

Conductor只创建`codex-home/`目录并把它作为`CODEX_HOME`传给Performer。Conductor和
Podium不能枚举、读取或改写目录内部文件。

MVP不加密Profile目录。Performer把该Profile的`CODEX_HOME`交给Codex SDK，凭据由Codex
以明文保存在该目录中。Symphony不实现自己的credential schema、加密层或迁移格式。

Profile目录使用owner-only文件权限，但这不是加密。

## 4. Conductor模块

```text
performer-profiles/
  api/
    PerformerProfileStoreInterface.ts
    PerformerProfileControlInterface.ts
  internal/
    FilePerformerProfileStoreImpl.ts
    SubprocessPerformerProfileControlImpl.ts
```

```text
PerformerProfileStoreInterface
  <- FilePerformerProfileStoreImpl

PerformerProfileControlInterface
  <- SubprocessPerformerProfileControlImpl
```

`PerformerProfileStoreInterface`只保存Conductor-owned Profile字段和active Profile ID。
`PerformerProfileControlInterface`只启动installed Performer control subprocess，并
消费closed login/status Result/Event。

Conductor不导入Codex SDK，不解释Codex account、model catalog、reasoning或Fast的
Provider类型。

## 5. Profile Command

Desktop通过Podium发起：

```text
GetPerformerProfilesQuery
GetPerformerProfileStatusQuery
CreatePerformerProfileCommand
UpdatePerformerProfileCommand
StartCodexChatGPTLoginCommand
SetCodexApiKeyCommand
ActivatePerformerProfileCommand
```

返回closed Result：

```text
PerformerProfileCommandResult
  = PerformerProfileSavedResult
  | PerformerProfileActivatedResult
  | CodexLoginStartedResult
```

Podium不保存这些Command。除API Key外，Podium只做closed shape validation并转发给目标
Conductor。

Conductor是Command的业务所有者：

- Create/Update原子写入`profiles.json`；
- Activate验证readiness后原子替换`activeProfileId`；
- Login Command只允许用于匹配其`authenticationMethod`的Profile；
- Podium不能在Conductor失败时本地伪造active或ready状态。

两个Login Command都先返回`CodexLoginStartedResult`，最终状态统一来自
`CodexLoginSucceededEvent`或`CodexLoginFailedEvent`。ChatGPT流程在中间额外产生
`CodexLoginPendingEvent`；API Key流程通常直接产生Succeeded或Failed。Desktop只有在
Succeeded Event或后续Status Query确认认证后才显示`Configured`/`Ready`。

`SetCodexApiKeyCommand`是唯一允许携带Codex secret input的Desktop Command。API Key：

- 只存在于表单内存、Podium relay内存、Conductor relay内存和Performer stdin；
- 不进入`podium.db`、`profiles.json`、request/result文件、日志、View、Linear或Git；
- 不出现在任何response body；
- 由`CodexBackendImpl`直接传给官方SDK login方法。

Profile Query返回两种named View：

```text
PerformerProfileSummaryView
  profileId
  displayName
  authenticationMethod
  codexTurnSettings
  executionPolicy
  readiness
  isActive
  sanitizedAccountLabel?
  observedAt

PerformerProfileDetailView
  summary
  sanitizedLastError?
  recommendedProfileOperation?
```

View不包含`CODEX_HOME`、API Key、auth文件内容、SDK object或原始error。

## 6. ChatGPT官方登录

```text
Desktop StartCodexChatGPTLoginCommand
-> Podium transient relay
-> Conductor PerformerProfileControlInterface
-> Performer profile control process
-> set CODEX_HOME to selected Profile
-> CodexBackendImpl
-> official Codex SDK ChatGPT login
-> CodexLoginPendingEvent
-> user completes official verification
-> CodexLoginSucceededEvent | CodexLoginFailedEvent
```

Performer拥有SDK login handle。Conductor只持有通用subprocess handle和closed Event。

`CodexLoginPendingEvent`可以包含SDK批准返回的verification URL、user code和expiry；
不能包含Token、cookie、SDK object或本地路径。

Conductor重启会终止正在进行的login process，且不持久化或恢复SDK login handle。
重启后Conductor先通过SDK重新读取account：若认证已经成功落入该Profile的
`CODEX_HOME`，Profile直接恢复为`ready`；否则回到`login-required`，用户重新发起登录。

## 7. API Key登录

```text
Desktop SetCodexApiKeyCommand
-> private in-memory relay
-> Performer control metadata frame
-> bounded secret stdin frame
-> CodexBackendImpl.login_api_key(secret)
-> Codex SDK persists its own auth state under Profile CODEX_HOME
```

API Key不写入Codex配置文件，也不由Symphony保存为字段。替换API Key就是对同一Profile
再次执行SDK login。SDK把认证信息以明文写入该Profile的`CODEX_HOME`；这属于
Codex-owned存储，不是Podium或Conductor自定义的API Key字段。

## 8. SDK设置与执行策略映射

Conductor保存不含SDK类型的Codex产品字段：

```text
CodexTurnSettings
  model
  reasoningEffort
  isFastModeEnabled
```

当前只支持Codex，因此不引入`settings: map`、通用Provider配置树或插件Schema。

Conductor还保存Provider-neutral产品字段：

```text
AgentExecutionPolicy
  sandboxMode
  commandAllowlist[]
  commandDenylist[]
```

`workspace_write`是默认sandbox mode。空allowlist表示除denylist外不额外限制，非空allowlist只允许
exact executable/argv-prefix匹配，denylist始终优先。规则数量、executable和argv长度全部有界；
不支持regex、shell policy language、逐命令审批或arbitrary Provider config。

Performer中的`CodexBackendImpl`负责映射：

| 产品字段 | SDK行为 |
|---|---|
| `model` | Codex SDK thread/turn model参数 |
| `reasoningEffort` | Codex SDK Turn reasoning effort参数 |
| `isFastModeEnabled` | Codex SDK公开的Fast/service-tier参数 |
| `executionPolicy` | Codex SDK公开的sandbox和command policy参数 |

Symphony不通过文本操作修改`config.toml`。若某个设置不能通过当前pinned SDK的public
API表达，`UpdatePerformerProfileCommand`返回
`performer_profile_setting_unsupported`；不得回退到直接写文件、private SDK成员或
CLI命令，且原Profile设置保持不变。

Fast必须按当前认证方式和SDK公开能力解释：

- ChatGPT Profile只有在当前账号和所选model支持Codex Fast时才允许开启；
- API Key Profile在V1显示为`Unavailable`，`isFastModeEnabled`必须为`false`；
- Symphony不把API Key的其他priority/service-tier计费能力冒充为Codex Fast；
- SDK在role turn启动时仍可拒绝已失效的model/Fast组合，错误必须作为Profile/turn设置错误
  可见，不能自动换model或关闭Fast。

Profile设置在每个role session/turn启动时重新读取。编辑当前Root所固定Profile的model、reasoning、Fast或
execution policy后，无需重启Conductor；新session/turn使用新设置，当前turn不被抢占。

## 9. Readiness

`PerformerProfileReadiness`：

```text
login-required
ready
invalid
```

创建Profile后：

- ChatGPT Profile进入`login-required`；
- API Key Profile在输入Key前进入`login-required`；
- SDK login成功且account状态为authenticated后进入`ready`；
- SDK登录失败、取消或中断后保持`login-required`并记录脱敏原因；
- 已保存Profile结构损坏、Profile目录不可用，或升级后的已保存设置无法再由pinned SDK
  表达时进入`invalid`。

Update在持久化前验证closed字段、认证方式约束和当前Backend adapter支持的参数；
失败时返回Error而不破坏原来的ready Profile。model是否对当前账号可用不通过额外
额外Provider预检，最终由真实Stage中的SDK调用确认。

只有`ready` Profile可以被activate或启动新的Root。

Readiness由Conductor通过Performer SDK account/status重新读取，不是Podium事实。
Conductor启动后刷新所有已保存Profile的状态；`GetPerformerProfilesQuery`也会刷新
status后再返回View。readiness和account label只存在于当前进程内，重启时重新读取。
active Profile未确认ready前不claim新的Root。

## 10. Active Profile与Agent调用

Conductor在`profiles.json`保存一个`activeProfileId`。新Root claim时把ready active Profile固定到
Root Control Record Comment；切换active Profile只影响之后claim的Root，不抢占active turn。

Root Reconciler以及每个Cycle的Plan、Work和Verify role都使用该Profile的`CODEX_HOME`创建互相隔离的
Provider thread。Profile复用认证、Provider设置和SDK cache；Root Reconciler thread只在matching Root内复用，
Stage thread只在matching Cycle内复用，且都不能成为durable authority。契约由
[Root Reconciliation](root-reconciliation.md)和[Stage Contracts](stage-orchestration.md)定义。

## 11. Token usage

本节是model identity、单turn token usage以及Stage/Cycle/Root聚合的唯一事实源。Performer为每次实际Provider调用记录
准确发送给Provider的`model`；不能从当前Profile配置倒推历史turn，也不能用model alias、Profile ID或Root结束时的
当前设置覆盖已经发生的调用。

Performer把Codex SDK的Turn usage归一化为closed union：

```text
TurnUsage =
  MeasuredTurnUsage
    status: measured
    input_tokens
    cached_input_tokens
    output_tokens
    reasoning_output_tokens
    total_tokens
  | UnavailableTurnUsage
    status: unavailable
    reason: provider_omitted | transport_lost | process_lost | invalid_provider_usage
```

`cached_input_tokens`是`input_tokens`的子集，`reasoning_output_tokens`可以是`output_tokens`的子集；聚合时五个字段
分别求和，不能把cached或reasoning重复加进`total_tokens`。`total_tokens`使用Provider归一化后的本次总量，不能在
Conductor中从其他维度重新推算。Provider明确报告零才可写零；无法取得实际usage时必须使用`unavailable`，不能省略
字段、伪造零或用reservation代替实际消耗。

每次已经进入Provider invocation边界的Root Reconciler、Plan、Work或Verify调用必须产生一个immutable
`ModelTurnRecord`，无论结果是succeeded、blocked、
failed、canceled、timed out、budget exhausted、schema invalid、retry、rerun或replan。record至少包含role、turn/execution
identity、Root/Cycle/target、`invocation_state: confirmed | ambiguous`、model、outcome、`TurnUsage`和completed/failed
time。`confirmed`表示Performer确认Provider invocation已开始；跨进程丢失导致是否开始无法证明时使用`ambiguous +
UnavailableTurnUsage`并使累计不完整。明确在Provider边界前被schema、coverage或precondition拒绝的request只写普通
execution failure，不伪造ModelTurnRecord或token使用。Stage Result record把matching
`ModelTurnRecord`作为closed nested object写在Plan/Work/Verify Issue同一managed comment的唯一`symphony` block中，
不是第二个block或第二条usage comment；Root Reconciler accepted `RootDirectiveRecord`或
`RootReconcilerFailureRecord`也各自nested一个matching `ModelTurnRecord`。模型不能自行报告这些字段；Performer从
实际SDK调用设置和SDK usage填充。

Conductor只从Linear中immutable `ModelTurnRecord`重建累计值。execution identity防止同一个turn重复计算；Timeline和
aggregate snapshot只是派生显示，不是第二份usage ledger，也不得再次计数。没有本地counter、usage数据库、Control Record
副本或Desktop计数器。

聚合范围固定为：

| Linear位置 | 用户可见累计值 | 唯一输入集合 |
|---|---|---|
| Plan/Work/Verify Issue | 该Issue全部初次、retry和rerun turn，按model分组 | target为该Issue的Stage `ModelTurnRecord` |
| Cycle Issue | 该Cycle全部Plan、Work和Verify usage，按stage和model分组 | matching Cycle的Stage `ModelTurnRecord` |
| Root Issue | 全部Cycle Stage usage加全部Root Reconciler usage，按Cycle/role/model分组 | Root下全部`ModelTurnRecord` |

Cycle累计不包含Root Reconciler turn。Root累计的公式唯一为`sum(all Cycle Stage turns) + sum(all Root Reconciler turns)`；
任何把Reconciler turn同时计入Cycle再汇总Root的实现都会双计，必须拒绝。每个累计snapshot携带source record count、
canonical source digest、`is_complete`和`unknown_turn_count`。只要任一input record为`unavailable`，累计仍展示所有已知
维度，但必须`is_complete: false`并明确未知turn数量，不能显示为精确总量。

Stage managed comment展示本turn和该Issue累计值；Cycle timeline展示该事件后的Cycle累计值；Root Reconciliation
timeline展示该事件后的Root累计值。累计值从fresh Linear事实计算并随matching event comment一起read-back，不通过修改
Issue description或单独维护可变summary record实现。

Result应用时先完成最新Linear/Git read-back和全部correlation校验，再结算usage并重新评估Root。
model/usage record或累计comment写入、strict decode、聚合校验或read-back失败时当前Root停止，turn启动前的Linear token
reservation继续全额计入，不能因少计而绕过Root
convergence gate。Workflow gate只读取execution settlements和open reservations。

SDK actual usage是operator-facing observation，不是账单；Root token budget correctness由保守reservation保证：

- Performer在SDK usage返回前崩溃时写`UnavailableTurnUsage`，reservation不释放；
- 货币成本、ChatGPT credits或Fast multiplier只可作为telemetry，不参与Workflow gate；
- actual usage可以降低reservation后的charged amount，但不能增加Root token budget或覆盖deadline/cycle breaker。

## 12. Desktop

顶层只有Overview、Conductors和Settings。

Conductor Detail增加`Performer Profiles`区域：

- Profile display name；
- ChatGPT或API Key登录方式；
- account/auth安全摘要；
- model；
- reasoning effort；
- Fast on/off/unavailable；
- readiness；
- active标记；
- Create、Edit、Login、Replace API Key、Activate。

API Key保存后只显示`Configured`，不能重新显示或复制原值。

Desktop只显示Profile配置和认证操作的真实Result，不显示当前Root/Stage使用的Profile、usage或完成数量。

## 13. 错误与恢复

| 错误 | 行为 |
|---|---|
| Profile不存在 | 新Root不启动；Profile操作返回失败并写脱敏日志 |
| active Profile未登录 | Conductor不claim新Root |
| SDK login失败 | Profile保持`login-required`，保留安全原因并允许重试 |
| login process随重启丢失 | SDK account未认证时回到`login-required` |
| SDK不支持新设置 | 拒绝Update，保留原设置 |
| 已保存设置升级后不再支持 | Profile `invalid`，等待用户Edit |
| Profile目录不可读 | `performer_profile_home_unavailable` |
| Root固定Profile被移除 | Root blocked，不静默改用active Profile |
| usage无法取得 | 写`unavailable`并使Cycle/Root累计不完整；reservation不释放，禁止静默少计 |

本轮不提供删除Profile Command，因此不会正常产生“固定Profile被移除”；该错误只防御
磁盘损坏或人工删除。

## 14. 不变量

1. 每个Performer Profile有独立`CODEX_HOME`。
2. Codex SDK是登录、account、auth持久化和Provider设置解释的唯一所有者。
3. Symphony不读取或写入Codex-owned配置与credential文件。
4. Podium不持久化Profile、API Key、Codex auth或usage。
5. Conductor只保存Profile业务字段和active Profile ID。
6. API Key只通过secret pipe进入Performer SDK。
7. 只有ready Profile可以处理新Root。
8. active Profile切换不抢占active turn，也不迁移已有Root Profile。
9. 同一Root固定一个`performer_profile_id`；Reconciler thread只在该Root复用，三个Stage threads只在各自Cycle复用。
10. model、reasoning和Fast只通过SDK public API生效。
11. sandbox和command policy只通过SDK public API生效，Symphony不实现动态授权引擎。
12. SDK usage不宣称账单精度；Root token budget只由Linear reservation与validated settlement机械执行。
13. 当前只允许`backendKind: codex`。
14. `backendKind`和`authenticationMethod`创建后不可修改。
15. Podium发起或转发active选择，但只有Conductor可以提交active Profile事实。
16. 每个模型调用都有Linear `ModelTurnRecord`；model和usage不能是optional，也不能只存在于日志或runtime。
17. Stage、Cycle和Root累计只从immutable turn records派生；不存在usage ledger、可变counter或双重计数路径。

## 15. 官方技术依据

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex Authentication](https://learn.chatgpt.com/docs/auth)
- [Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex Speed与Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed)

官方资料确认：

- Codex支持ChatGPT登录和API Key登录；
- Python SDK控制本地Codex app-server；
- `CODEX_HOME`隔离config、auth、session和其他Codex state；
- V1使用当前pinned SDK可表达的`none`、`minimal`、`low`、`medium`、`high`、`xhigh`
  reasoning effort闭合集；
- Fast是受账号、认证方式和model支持约束的service tier，不能对API Key Profile假定
  可用；
- SDK Turn completion可以提供input、cached input、output和reasoning token usage。

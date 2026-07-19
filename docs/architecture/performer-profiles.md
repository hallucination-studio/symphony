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
- 已经创建Provider Conversation的Root固定使用原Profile，避免跨`CODEX_HOME`丢失Conversation；
- model、reasoning effort和Fast由Conductor保存为产品设置，并由Performer映射为SDK参数；
- Token使用量来自Codex SDK usage Event/Result；完成数量来自Linear Root事实。

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
`codexTurnSettings`。

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
| Profile ID、display name、auth method、Turn settings | Conductor |
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
  readiness
  isActive
  sanitizedAccountLabel?
  observedAt

PerformerProfileDetailView
  summary
  sanitizedLastError?
  nextAction?
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

## 8. SDK设置映射

Conductor保存不含SDK类型的Codex产品字段：

```text
CodexTurnSettings
  model
  reasoningEffort
  isFastModeEnabled
```

当前只支持Codex，因此不引入`settings: map`、通用Provider配置树或插件Schema。

Performer中的`CodexBackendImpl`负责映射：

| 产品字段 | SDK行为 |
|---|---|
| `model` | Codex SDK thread/turn model参数 |
| `reasoningEffort` | Codex SDK Turn reasoning effort参数 |
| `isFastModeEnabled` | Codex SDK公开的Fast/service-tier参数 |

Symphony不通过文本操作修改`config.toml`。若某个设置不能通过当前pinned SDK的public
API表达，`UpdatePerformerProfileCommand`返回
`performer_profile_setting_unsupported`；不得回退到直接写文件、private SDK成员或
CLI命令，且原Profile设置保持不变。

Fast必须按当前认证方式和SDK公开能力解释：

- ChatGPT Profile只有在当前账号和所选model支持Codex Fast时才允许开启；
- API Key Profile在V1显示为`Unavailable`，`isFastModeEnabled`必须为`false`；
- Symphony不把API Key的其他priority/service-tier计费能力冒充为Codex Fast；
- SDK在Turn启动时仍可拒绝已失效的model/Fast组合，错误必须作为Profile/Turn设置错误
  可见，不能自动换model或关闭Fast。

Profile设置在每个Turn启动时重新读取。编辑当前Root所固定Profile的model、reasoning或
Fast后，无需重启Conductor，下一Performer Turn使用新设置；当前Turn不被抢占。

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
Check Turn预检，最终由真实Turn中的SDK调用确认。

只有`ready` Profile可以被activate或启动新的Root。

Readiness由Conductor通过Performer SDK account/status重新读取，不是Podium事实。
Conductor启动后刷新所有已保存Profile的状态；`GetPerformerProfilesQuery`也会刷新
status后再返回View。readiness和account label只存在于当前进程内，重启时重新读取。
active Profile未确认ready前不claim新的Root。

## 10. Active Profile与实时切换

Conductor在`profiles.json`中只保存一个：

```text
activeProfileId
```

`ActivatePerformerProfileCommand`：

1. 确认Profile存在且`ready`；
2. 原子替换`activeProfileId`；
3. Conductor立即向Desktop报告新的active Profile；
4. 不重启Conductor或Performer常驻进程；
5. 不抢占当前Turn。

Profile Create/Update/Activate不启动SDK，可以在业务Turn运行时提交。Login和Status需要
启动Performer control process，必须等待Conductor的当前业务Turn结束。

新Root首次claim时，把active Profile写入Root Primary Status Comment：

```text
performer_profile_id: <profile-id>
```

Root得到`performer_id`后，始终使用该`performer_profile_id`对应的`CODEX_HOME`。
切换active Profile只影响之后claim的Root。

原因是Codex Conversation和session state属于创建它的`CODEX_HOME`。目标架构不跨
Profile复制session、不静默创建新Conversation，也不把同一个Root迁移到另一个Profile。

因此“实时切换”定义为：

- Desktop选择后立即生效；
- 不需要重启任何Runtime；
- 下一个新Root使用新Profile；
- 当前Turn继续；
- 已有Root保持Conversation/Profile稳定。

## 11. Turn契约

每个Turn增加：

```text
performer_profile_id
```

Conductor通过该ID解析Profile目录和`CodexTurnSettings`，然后启动Performer：

```text
CODEX_HOME=<profile codex-home>
PerformerTurnCommand.performer_profile_id=<profile-id>
PerformerTurnCommand.codex_turn_settings=<current settings>
```

Result必须回显`performer_profile_id`。Result、Root Primary Status Comment、原始Command和
该Command解析出的Profile目录任一不匹配时，Conductor拒绝Result；校验不读取当前
`activeProfileId`。

`CodexTurnSettings`是显式批准的closed产品DTO，不是SDK config或任意Provider map。
`CODEX_HOME`绝对路径通过受控process environment传入，不进入Linear、Desktop View或
日志。

## 12. Token与完成数量

Performer把Codex SDK的Turn usage归一化为：

```text
PerformerTurnUsageSnapshot
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens
```

`cached_input_tokens`是`input_tokens`的子集，`total_tokens`按SDK语义或
`input_tokens + output_tokens`计算，不能把cached token重复相加。

每个有效Turn Result可以携带`usage`。Conductor把Root累计值写入Root Primary Status Comment：

```text
usage_input_tokens
usage_cached_input_tokens
usage_output_tokens
usage_reasoning_output_tokens
usage_total_tokens
last_usage_turn_id
```

`last_usage_turn_id`防止同一个Result重复累计。Root已经Done/Canceled或Result correlation
失效时，不为记录指标而绕过Root终止规则。

Result应用时先完成最新Linear/Git read-back和全部correlation校验，再尝试累计usage，
最后应用业务Result。usage写入失败只产生可见warning，不阻止Work、Root Gate或交付；
因此该指标明确允许少计。

Conductor通过`ListRootUsageQuery`分页读取自己拥有的managed Roots并产生：

```text
PerformerUsageView
  inputTokens
  cachedInputTokens
  outputTokens
  reasoningOutputTokens
  totalTokens
  completedRootCount
  observedAt
  isStale
```

`completedRootCount`表示已由Symphony交付、当前为In Review或Done的Roots数量。
Podium只汇总各Conductor的`PerformerUsageView`，不保存计数。

Turn进行中，Desktop可以用`PerformerUsageUpdatedEvent`刷新当前Turn的临时数值；Turn
完成后以Result累计值替换。Event不累计、不持久化，Desktop或Conductor重启后只从
Linear中的Root累计值恢复。

Usage是operator-facing、best-effort指标，不是账单：

- Performer在SDK usage返回前崩溃时可能缺失；
- 不计算货币成本、ChatGPT credits或Fast multiplier；
- 不作为Root、Work、Gate或调度决策输入。

## 13. Desktop

顶层仍只有Overview、Work、Conductors和Settings。

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

如果当前Turn使用的Profile和active Profile不同，Desktop同时显示：

```text
Current Turn Profile
Active Profile for new Roots
```

Overview增加两个低密度指标：

- Total tokens；
- Completed roots。

Conductor Detail显示该Conductor的usage breakdown；Root Detail显示该Root的Profile和
token usage。指标必须带`observedAt`和stale状态。

## 14. 错误与恢复

| 错误 | 行为 |
|---|---|
| Profile不存在 | 新Root不启动；Desktop提示选择有效Profile |
| active Profile未登录 | Conductor不claim新Root |
| SDK login失败 | Profile保持`login-required`，保留安全原因并允许重试 |
| login process随重启丢失 | SDK account未认证时回到`login-required` |
| SDK不支持新设置 | 拒绝Update，保留原设置 |
| 已保存设置升级后不再支持 | Profile `invalid`，等待用户Edit |
| Profile目录不可读 | `performer_profile_home_unavailable` |
| Root固定Profile被移除 | Root blocked，不静默改用active Profile |
| usage缺失 | Workflow继续，统计可能少计 |

本轮不提供删除Profile Command，因此不会正常产生“固定Profile被移除”；该错误只防御
磁盘损坏或人工删除。

## 15. 不变量

1. 每个Performer Profile有独立`CODEX_HOME`。
2. Codex SDK是登录、account、auth持久化和Provider设置解释的唯一所有者。
3. Symphony不读取或写入Codex-owned配置与credential文件。
4. Podium不持久化Profile、API Key、Codex auth或usage。
5. Conductor只保存Profile业务字段和active Profile ID。
6. API Key只通过secret pipe进入Performer SDK。
7. 只有ready Profile可以处理新Root。
8. active Profile切换不抢占Turn，也不迁移已有Root Conversation。
9. 同一Root固定一个`performer_profile_id`和一个`performer_id`。
10. model、reasoning和Fast只通过SDK public API生效。
11. Token usage不参与Workflow决策，也不宣称账单精度。
12. 当前只允许`backendKind: codex`。
13. `backendKind`和`authenticationMethod`创建后不可修改。
14. Podium发起或转发active选择，但只有Conductor可以提交active Profile事实。

## 16. 官方技术依据

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

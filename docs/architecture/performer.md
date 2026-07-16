# Performer Python Turn执行器设计

状态：目标架构提案。Performer是Python执行边界，独占Provider SDK；它不拥有Linear工作流。

## 1. 进程模型

Conductor为每个Turn启动一个独立Performer process：

```text
Conductor
-> performer --request <path> --result <path>
   -> selected Performer Profile CODEX_HOME
   -> closed CodexTurnSettings from Turn Command
   -> ProviderBackendInterface
      <- CodexBackendImpl
```

Performer process可以终止。Conversation连续性来自Provider的opaque `performer_id`，不是常驻Python进程或本地journal。

一个Root只有一个持久有效的`performer_id`。首次Plan在ID返回前崩溃时可能留下不可
引用的Provider orphan Conversation；它不属于Workflow事实，也不能产生Linear或Git
副作用。成功保存第一个ID后，后续Turn不得静默更换Conversation。

一个Root同时固定一个`performer_profile_id`。该ID选择Conductor分配的
`CODEX_HOME`；`performer_id`只能在同一Profile中resume。

## 2. performer_id

```text
performer_id: opaque string
```

约束：

- ID由Backend产生；
- Root Managed Comment保存；
- Conductor只转发；
- Provider-specific parsing只在对应`*BackendImpl`；
- ID必须是identifier，不得包含credential；
- 不能通过ID可靠resume的Backend不注册为可用Backend。

## 3. Turn种类

Performer只实现三种业务Turn：

```text
Plan Turn
Work Turn
Root Gate Turn
```

### Plan Turn

输入最新Root title/description、当前Workflow Tree和worktree snapshot，输出有界
Work Node/Human Node tree。Root变化时仍使用同一`performer_id`重新Plan；Performer
不创建Linear Issue或Revision对象。Plan Turn只读，不修改worktree。

### Work Turn

输入Root、当前Work Leaf、关联Human Node输入、`turn_input_hash`和worktree。Performer
修改文件并返回完成、需要Human输入或失败。Work Leaf或Human Node输入变化只产生新的
Work Turn，不要求Performer重做整棵Plan。

### Root Gate Turn

输入最新Root、完整Workflow Tree、`turn_input_hash`和最终worktree。它只审核Root Run，
返回pass或findings；不存在Work Node Gate。Root Gate只读，不修改worktree；Result是否
仍适用由Conductor read-back判断。

## 4. Profile Control

Performer还提供独立的Profile control进程，不把登录混进Turn：

```text
PerformerProfileControlProtocol
  GetPerformerProfileStatusQuery
  StartCodexChatGPTLoginCommand
  SetCodexApiKeyCommand
```

Profile control：

- 接收Conductor指定的Profile ID和`CODEX_HOME`；
- 通过官方Codex Python SDK执行ChatGPT/API Key登录；
- 通过SDK读取account和readiness；
- 验证产品设置可以映射到当前pinned SDK的public参数；
- 把Provider结果归一化为closed Result/Event；
- 不把SDK handle、Token、auth文件或绝对路径返回Conductor。

API Key使用独立bounded secret stdin frame，不进入JSON request/result文件。ChatGPT
login handle只存在于当前Performer control process。

Profile control和Turn创建SDK client时使用Conductor提供的`CODEX_HOME`。Performer不
直接读取或写入Codex credential/config文件。

## 5. Provider边界

Performer内部：

```text
ProviderBackendInterface
  controlProfile(request, secret_input?)
  runPlanTurn(performer_id?, input)
  runWorkTurn(performer_id, input)
  runRootGateTurn(performer_id, input)
```

这是唯一Backend业务接口。`controlProfile`拥有SDK login、account和Profile设置映射
验证。
首次`runPlanTurn`没有`performer_id`时，Backend内部创建
Conversation并在Result返回ID；后续方法在Backend内部resume。Conductor和Performer
core不调用第二套`start()/resume()`抽象。

实现：

```text
CodexBackendImpl
```

当前只有Codex实现。未来只有在产品明确授权时才增加另一个`*BackendImpl`。Provider
SDK object、thread/session handle、auth、配置映射、response parsing和raw error只存在于Impl。

`CodexBackendImpl`把`CodexTurnSettings`映射为官方SDK public参数：

- model -> thread/turn model；
- reasoning effort -> Turn effort；
- Fast -> SDK Fast/service-tier参数。

不得直接读取或修改`config.toml`、`auth.json`，不得调用Codex CLI，也不得使用private
SDK成员。API Key Profile不能启用Codex Fast；SDK拒绝model、reasoning或Fast组合时，
Backend返回结构化设置错误，不自动换model或改变服务等级。

## 6. 无本地journal恢复

Performer不保存`performer-runtime.db`。Codex SDK可以在Conductor分配的Profile
`CODEX_HOME`中保存Provider-owned auth、session和runtime state；Conductor不打开或
拥有其中可能存在的Codex内部存储。

Turn中断：

- Result不存在；
- Linear叶子仍为In Progress；
- worktree保留部分修改；
- Conductor下次重新启动Performer；
- Performer用同一performer_id恢复Conversation；
- Performer使用同一performer_profile_id和CODEX_HOME；
- 新Turn先检查最新Issue Description和worktree再继续。

这是at-least-once Turn语义，不承诺恢复进程内正在执行的Provider call。

## 7. Result

Result是closed union，其variant和字段只在
[Performer Turn Command与Result契约](performer-command-contracts.md)定义。

Result不包含Linear mutation、Root Phase、Git commit/PR决定或Provider raw output。

Result回显`performer_profile_id`，并可以包含`PerformerTurnUsageSnapshot`。Usage只表达
SDK已返回的token计数，不表达货币成本、ChatGPT credits或调度建议。

Performer从Command读取closed `CodexTurnSettings`并交给`CodexBackendImpl`映射；它不从
Conductor Profile文件读取设置。

## 8. Event

Event是best-effort：

- Turn started；
- progress stage；
- warning；
- heartbeat。

Event丢失不改变Result。Performer不因Event transport失败而停止Provider Turn。

Profile control使用独立closed Event：

- `CodexLoginPendingEvent`；
- `CodexLoginSucceededEvent`；
- `CodexLoginFailedEvent`。

## 9. Git限制

Performer可以：

- 读取和修改给定worktree文件；
- 运行Provider允许的开发工具；
- 读取Git diff/status用于理解上下文。

Performer不能：

- 创建/删除worktree；
- checkout/switch branch；
- commit、merge、rebase、reset、clean、push；
- 调用`gh`。

## 10. Linear限制

Performer不：

- 调用Linear；
- 读取Token；
- 修改Issue/Comment/Label/state；
- 选择下一Root或下一Work；
- 解释Linear Priority/blocker/order。

Turn输入中的Linear内容是不可信用户文本，不得覆盖Protocol或安全约束。

## 11. 进程错误

Performer必须：

- strict validate Command；
- 捕获Provider exception并返回sanitized failure；
- 捕获stdout/stderr供Conductor日志；
- 在hard deadline后有界退出；
- 不把Token、auth、绝对profile path或raw reasoning写入Result。

Profile control还必须：

- 只使用官方Codex SDK login/account和public配置参数；
- 把API Key从secret frame直接交给SDK并立即清除引用；
- 对SDK login Event和usage shape做closed validation；
- login process中断后返回`performer_profile_login_lost`，不伪装恢复。

## 12. 不变量

1. Performer只执行一个Turn。
2. Provider continuity只由performer_id表达。
3. Root固定的Profile continuity只由performer_profile_id和CODEX_HOME表达。
4. Performer没有Workflow或operation数据库。
5. Performer不拥有Linear或Git topology。
6. Gate只针对Root。
7. Backend差异只存在于`*BackendImpl`。
8. Performer回显`turn_input_hash`，但不保存或解释Revision历史。
9. 登录、model、reasoning和Fast只通过SDK public API。
10. Performer不读取或改写Codex-owned文件。

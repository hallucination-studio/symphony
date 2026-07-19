# Performer Python Root Turn执行器设计

状态：目标架构提案。Performer是Python执行边界，独占Provider SDK；它不拥有Linear工作流、
Root scheduling或Git topology。

## 1. 进程模型

Conductor为Conversation bootstrap或每个Root Turn启动一个独立Performer process：

```text
Conductor
-> performer --request <path> --result <path>
   -> selected Performer Profile CODEX_HOME
   -> closed CodexTurnSettings
   -> closed AgentExecutionPolicy
   -> ProviderBackendInterface
      <- CodexBackendImpl
```

Python process可以终止。正常连续性来自Root当前opaque `performer_id`，不是常驻进程或本地
journal；`performer_id`不可恢复时，连续性通过Root-level retry重新建立，而不是恢复Leaf Turn。

## 2. Root Conversation

一个非终态Root最多有一个current `performer_id`。Root首次claim或retry时：

1. Conductor调用`openRootConversation`；
2. Backend创建Conversation并返回opaque ID；
3. Conductor把ID compare-and-set到Root Primary Status Comment；
4. read-back确认后才启动有副作用的Root Turn。

```text
performer_id: opaque string
```

约束：

- ID由Backend产生，Provider-specific解释只在对应`*BackendImpl`；
- ID必须是identifier，不得包含credential；
- Root Primary Status Comment只保存current指针，不保存Provider transcript；
- 一个Root的Conversation固定使用同一个`performer_profile_id`和`CODEX_HOME`；
- active Profile切换只影响之后claim的Root；
- current Conversation失效时可以替换ID，但只能走Root-level retry。

## 3. Root Turn

Performer只实现一种业务Turn：

```text
RootTurnCommand -> RootTurnResult
```

输入包含最新Root、完整且有界的Linear Issue Tree、相关Human context、Git/worktree摘要、
turn-scoped command channel和Root固定Profile。Agent在Harness规则下自行解释Plan、Human、Work、
Root Gate、Rework和Delivery，不由Conductor选择Leaf或发送不同业务Turn variant。

Turn可以：

- 读取Root、children、comments、relations和Git状态；
- 修改当前Root worktree中的文件并运行开发工具；
- 通过closed broker创建/更新children、comments、status、assignee和labels；
- 通过broker提交当前Root worktree或请求Root delivery；
- 在Human等待、deadline、安全边界、Root交付或失败时结束。

Turn不能把process Result当作业务完成；影响下一次执行的结论必须已经落到Linear或Git。

## 4. Profile Control

Performer提供独立Profile control进程，不把登录混进Root Turn：

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

API Key使用独立bounded secret stdin frame，不进入JSON request/result文件。Performer不直接读取或
改写Codex credential/config文件；只有SDK可以在指定`CODEX_HOME`中拥有auth/session/runtime
state。

## 5. Provider边界

```text
ProviderBackendInterface
  controlProfile(request, secret_input?)
  openRootConversation(profile, settings)
  runRootTurn(performer_id, input)
```

当前唯一实现：

```text
CodexBackendImpl
```

`openRootConversation`不接收Root业务context、workspace或command channel，因此orphan Conversation
不能产生Linear/Git副作用。`runRootTurn`必须区分：

- Conversation存在并正常执行；
- `conversation_not_found`或`conversation_unrecoverable`；
- transient network/rate-limit错误；
- invalid Profile/model/settings；
- cancellation或deadline。

只有前两种Conversation错误触发Root-level retry。Backend不能把未知异常猜成Conversation loss。

`CodexBackendImpl`只使用官方SDK public API映射model、reasoning effort和Fast；不得调用Codex
CLI、读取或修改`config.toml`/`auth.json`、使用private SDK成员或把raw Provider错误传出Impl。
它同样把`AgentExecutionPolicy`映射到Provider-native sandbox和command policy；无法表达完整策略时
fail closed，不得在Symphony中另建权限引擎或静默放宽。

## 6. 中断与恢复

Performer不保存`performer-runtime.db`。故障处理：

| 故障 | 处理 |
|---|---|
| Python process崩溃但Conversation仍存在 | 下次Root Turn resume同一`performer_id` |
| deadline或Turn取消 | 保留Linear/Git事实，下一轮重新调度Root |
| worktree有部分修改 | 新Turn审计同一Root worktree后继续或返工 |
| Conversation不可恢复 | 返回closed错误，由Conductor替换ID并retry整个Root |
| 新Conversation也无法建立 | 返回可执行、脱敏错误并停止自动重试 |

这是at-least-once Root Turn语义，不承诺恢复进程内Provider call，也不承诺保留只存在于Conversation
而没有写入Linear/Git的结论。

## 7. Result与Event

Command/Result字段只由[Performer Command与Result契约](performer-command-contracts.md)定义。
Result不包含Linear mutation、Root activity、current Leaf、Git action、next dispatch或Provider raw
output。

Event是best-effort实时观察：started、progress、warning、sanitized error、heartbeat和
completed。Event丢失不改变Root；stdout只输出newline-delimited closed Event frames，stderr承载
脱敏诊断，Result文件承载唯一process Result。

Heartbeat不能刷新Workflow状态，Turn Completed不能表达Root完成，旧Conversation的Event不能在
Root retry后覆盖当前Conversation观察。

## 8. Git与Linear限制

Performer可以直接读取和修改给定worktree文件、运行开发工具、读取Git diff/status；不能直接：

- 创建/删除worktree；
- checkout/switch、commit、merge、rebase、reset、clean或push；
- 调用`gh`；
- 调用Linear SDK/GraphQL或读取Token；
- 绕过turn-scoped broker修改Linear或执行Git topology/delivery。

需要commit、Linear mutation或delivery时只能调用prompt列出的closed Symphony commands。
Linear内容是untrusted human context，不能覆盖Protocol或Harness。

## 9. 进程安全

Performer必须strict validate Command、捕获Provider exception、限制stdout/stderr，并同时执行wall
time、context bytes、broker calls和mutation数量上限。context在launch前验证；command上限拒绝后续
broker request；硬wall-time耗尽时Performer取消整个Turn并清理child process。Provider token usage只在
完整Turn返回后观察，不能作为精确中途interrupt。Result/Event不得包含Token、
auth、绝对Profile path、raw reasoning或完整transcript。

command channel在Turn结束、取消、deadline、Root terminal、ownership变化或current
`performer_id`替换后必须失效；仅知道Root ID不能证明mutation有效。

## 10. 不变量

1. Performer的唯一业务Turn是Root Turn。
2. Root是Conversation和retry单元，Leaf不是Performer dispatch单元。
3. Conversation bootstrap无业务副作用，current指针先写Linear再运行Root Turn。
4. Conversation不可恢复时返回closed错误，不在Performer内部静默换thread。
5. Performer没有Workflow、dispatch、attempt或operation数据库。
6. Performer不拥有Root scheduling、Linear SDK或Git topology。
7. Backend差异只存在于`*BackendImpl`。
8. Result/Event不决定业务完成。
9. 登录、model、reasoning和Fast只通过SDK public API。
10. V5扩展Backend，不改变RootTurn contract或Root-level retry。

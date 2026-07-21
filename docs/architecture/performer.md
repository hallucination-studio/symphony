# Performer Python Stage执行器设计

状态：目标架构提案。Performer是Python执行边界，独占Provider SDK；它不拥有Linear工作流、
Root scheduling或Git topology。

## 1. 进程模型

Conductor为每个Stage启动独立Performer process：

```text
Conductor
-> performer --request <path> --result <path>
   -> selected Performer Profile CODEX_HOME
   -> closed CodexTurnSettings
   -> closed AgentExecutionPolicy
   -> ProviderBackendInterface
      <- CodexBackendImpl
```

Process可以终止。下一次执行由Conductor从Linear/Git创建fresh Stage context，不恢复旧thread。

## 2. Stage execution 边界

Performer只执行Conductor明确调用的一个Plan、Work或Verify Node Stage。Cycle Issue只作为container，
不能成为Stage target。公共`StageContextEnvelope`、三个stage-specific context variants、workspace
capability和Result只由
[Linear Workflow Loop与Performer Stage Context](stage-orchestration.md)定义。

Performer不保存Root conversation pointer，不resume跨Stage thread，也不调用Conductor。

## 3. Profile Control

Performer提供独立Profile control进程，不把登录混进Stage：

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

## 4. Provider边界

```text
ProviderBackendInterface
  controlProfile(request, secret_input?)
  executeStage(profile, stage_context, workspace_capability?)
```

当前唯一实现：

```text
CodexBackendImpl
```

Backend必须区分success、transient provider failure、invalid Profile/settings、cancellation和deadline。

`CodexBackendImpl`只使用官方SDK public API映射model、reasoning effort和Fast；不得调用Codex
CLI、读取或修改`config.toml`/`auth.json`、使用private SDK成员或把raw Provider错误传出Impl。
它同样把`AgentExecutionPolicy`映射到Provider-native sandbox和command policy；无法表达完整策略时
fail closed，不得在Symphony中另建权限引擎或静默放宽。

## 5. 中断与恢复

Performer不保存`performer-runtime.db`。故障处理：

| 故障 | 处理 |
|---|---|
| process或connection崩溃 | 丢弃Stage context，下一次使用fresh context |
| deadline或Stage取消 | 保留Linear/Git事实，下一轮重新选择Stage |
| worktree有部分修改 | 同一Work Node的新Stage execution从fresh Git baseline审计 |
| Provider不可用 | 返回closed错误并释放Stage capacity |

不承诺恢复进程内Provider call；只存在于Provider context而没有写入Linear/Git的结论可以丢弃。

## 6. Linear 与 Git 限制

Performer不能直接调用Linear SDK/GraphQL、Conductor、Git topology、commit或delivery。Work Stage只能在
给定workspace capability内修改文件和运行execution policy允许的开发命令；Plan和Verify必须read-only。

## 7. 进程安全

Performer必须strict validate StageContextEnvelope/Wire frame、捕获Provider exception、限制stdout/stderr，并
执行wall time、context bytes、frame和tool execution上限。硬wall-time耗尽时取消Stage并清理child
process。Provider token usage只在完整Stage返回后观察，不能作为精确中途interrupt。Result/Event不得包含Token、
auth、绝对Profile path、raw reasoning或完整transcript。

StageWire在Stage结束、取消、deadline、Root terminal或ownership变化后必须失效。

## 8. 不变量

1. Performer只执行Conductor选择的一个Plan、Work或Verify Node。
2. Conductor是唯一caller和StageWire owner。
3. 每个Stage使用fresh Provider context，不共享或持久化thread。
4. Human等待结束当前Stage，不保留process或context。
5. Performer没有Workflow、dispatch、attempt或operation数据库。
6. Performer不拥有Root scheduling、Linear SDK或Git topology。
7. Backend差异只存在于`*BackendImpl`。
8. Event不决定业务完成；Result必须由Conductor materialize并read-back。
9. 登录、model、reasoning和Fast只通过SDK public API。
10. Performer不创建sub-agent，也不把Provider runtime state当成Workflow memory。

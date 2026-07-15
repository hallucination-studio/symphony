# 规格：Podium Desktop 客户端重构

> 状态：Approved，用户于 2026-07-15 批准 A1–A13 和任务边界
>
> 产品：Symphony
>
> 执行门槛：本规格、tasks/plan.md、tasks/todo.md 和 tasks/code-view.md 明确获批前，不修改生产代码、数据库、构建配置或运行时行为。
>
> Linear 校准来源：`docs/product/linear-integration.md`。Tasks 只能拆分该 accepted design，不得增加 inbound、native agent、provider 或 workflow 行为。

## 1. 目标

将旧 Podium SaaS 重构为本地跨平台客户端，同时保持现有 Python package 和逻辑边界：

    Podium Desktop
    ├─ Tauri 2 / Rust 原生壳
    ├─ React UI
    ├─ Podium 本地进程
    │  ├─ 固定 Linear Application OAuth
    │  ├─ project catalog / Create Conductor binding
    │  ├─ polling / delegation epoch / dispatch
    │  ├─ Podium SQLite：podium.db
    │  └─ UI-safe snapshots
    └─ 一个或多个本地 Conductor 进程
       ├─ 每个进程绑定一个 Linear project + repository
       ├─ Conductor SQLite：workflow.db
       ├─ Managed Run / Gate / recovery / runtime wait
       └─ Performer process supervision
          └─ Performer fenced turn
             ├─ closed final result：workflow truth
             └─ closed performer_event：Podium advisory status only

核心结果：

- Podium 变成客户端，不再是 SaaS、公开 BFF 或浏览器 static host。
- packages/podium、packages/conductor、packages/performer、packages/performer-api 均保留。
- Podium 与 Conductor 继续是独立 package、独立进程和独立 durable state owner。
- PostgreSQL 完全删除；Podium 使用本地 SQLite。
- Linear access/refresh token 明文持久化在 Podium-owned `podium.db`，restart/update 不重复授权。
- Conductor 继续使用自己的 workflow.db，不与 podium.db 合并。
- Podium 与 Conductor 不互相 import；共享 wire contract 只能进入 performer-api。
- 新 Podium 不生成、分发、持久化或兼容任何 Podium secret。
- Symphony 不实现 Podium/Linear 凭据的应用层加密、解密、密钥或密文字段。
- 固定使用测试 Linear Application；不允许用户自定义 Application。
- MVP 不保存 Linear Application manifest/config revision，不支持配置修改、candidate、cutover 或 migration。
- OAuth callback 使用本机 loopback。
- Linear runtime intake 只使用 outbound polling；不开放 inbound business-event endpoint。
- Linear 只投影 parent、ordered Sub Issues、`[Human Action]`、Gate 和 final state；不接收 live-event write。
- Codex 进度只允许以 closed `performer_event` 在 Podium 展示；不做 raw event、event history、provider selector 或 cross-model。
- macOS 提供菜单栏 popover；完整窗口保持现有 Podium 视觉样式。

这是硬切重构，不保留旧 Podium public API、PostgreSQL schema、runtime enrollment token、runtime/proxy bearer、旧 Web 登录或兼容 adapter。

## 2. 不可破坏的 package 边界

保留当前四个 Python package：

    packages/podium/
    packages/conductor/
    packages/performer/
    packages/performer-api/

Import 规则：

- performer_api 不 import podium、conductor 或 performer。
- podium、conductor、performer 可以 import performer_api。
- podium、conductor、performer 不互相 import。
- Podium 不直接调用 Conductor Python 类。
- Conductor 不直接调用 Podium Python 类。
- Conductor 继续通过 installed performer command 启动 Performer，不 import Performer internals。
- Provider SDK、provider session、provider login/config 和 provider-specific parsing 仍只存在于 Performer。

新桌面文件建议放在现有 Podium 所有权下：

    packages/podium/desktop/       Tauri/Rust shell
    packages/podium/web/           React UI，保留 DESIGN.md
    packages/podium/src/podium/    Podium local process

不新增 client-core、podium-runtime 或合并后的 conductor 模块。内部文件可以重组，但 package 和职责边界不得改变，除非用户另行批准 scope change。

## 3. 组件职责

| 组件 | 必须拥有 | 明确不拥有 |
| --- | --- | --- |
| React UI | 展示、表单、view state、accessibility、safe live status | token、SQLite、Linear 请求、subprocess、raw provider event |
| Tauri/Rust | 窗口、tray、single instance、Podium/Conductor process supervision、受限 commands | Linear/Managed Run 领域逻辑、provider SDK |
| Podium | Linear OAuth/token use、projects、bindings、polling、dispatch、podium.db、UI snapshots、latest ephemeral safe `performer_event` view | workflow.db、Gate、Performer SDK、Conductor internals、live-event history |
| Conductor | 单 project/repository durable Managed Run、workflow.db、Gate/recovery/runtime wait、Performer process、event validation/fencing | Podium SQLite、OAuth token persistence、Application selection、UI、event journal |
| Performer | provider auth/config/SDK、Check、fenced turn、raw-to-semantic event normalization | polling、Linear scheduler、durable Managed Run、desktop UI、raw event export |
| performer-api | provider-neutral closed wire contracts，包括 `PerformerTurnEvent` 和本地 envelope | runtime implementation、database、HTTP/IPC server、provider SDK、arbitrary provider payload |

Podium 是 project/polling/dispatch 的唯一 truth；Conductor 是 Managed Run/work item/turn/evidence 的唯一 truth。UI snapshot 可以缓存有界只读摘要，但不得成为第二份可变 workflow truth。

## 4. Podium 客户端与 SQLite

### 4.1 Podium 数据库

Podium 使用 OS app-data 目录下的 podium.db。

推荐表：

- schema_migrations
- app_profile
- linear_installations（含唯一批准的明文 `access_token`、`refresh_token` 字段）
- linear_projects
- project_bindings
- polling_checkpoints
- delegation_epochs
- dispatches
- runtime_commands
- runtime_reports
- background_failures
- app_events（仅通用 Desktop 生命周期事件；不得保存 `performer_event` 历史）

明确禁止：

- users、password_hash、sessions、workspaces、turnstile。
- custom_linear_applications。
- PostgreSQL-specific sequence、advisory lock 或 asyncpg schema。
- Podium runtime/proxy/enrollment token。
- token ciphertext、*_enc、encryption_key、secret_hash，以及批准的 `linear_installations` 行之外的 access/refresh token 字段。

SQLite 规则：

- WAL、foreign_keys、busy_timeout 和显式 migration。
- 所有 SQLite 读写使用参数化 SQL，不拼接 token 或外部值。
- Podium 是 podium.db 唯一写进程；React、Tauri、Conductor 不直接打开它。
- installation metadata 与 access/refresh pair 首次写入、refresh pair 替换、disconnect 清空分别在单一事务内完成。
- 普通 repository record/snapshot 不包含 token 字段；只有 Podium credential repository 可读取它们。
- polling observation、delegation epoch、dispatch insert、checkpoint advance 在同一事务提交。
- 同一 issue/delegation epoch 最多一个 active dispatch。
- 同一 project 最多一个 active binding。
- list/snapshot 有明确上限或 cursor，不做无界全表加载。
- migration、corruption、disk full、lock timeout 均 fail closed；podium.db 仍可写时进入 durable failure、snapshot、UI 和日志，数据库无法打开或写入时必须进入 Tauri observed failure、UI 和 operator log，且不得伪装成 ready 或另建 fallback durable store。

### 4.2 Conductor 数据库

- 每个 Conductor data root 继续拥有 workflow.db。
- workflow.db 继续是 Managed Run、plan、work item、turn、Gate、runtime wait、evidence 和 manifest 的唯一 durable truth。
- 不把 workflow.db 合并到 podium.db。
- 不双写 Managed Run state。
- Podium 只保存 Conductor 上报的有界安全摘要和 last-seen health。

## 5. 无 Podium secret、无自研加密

### 5.1 必须删除

- PODIUM_PROXY_TOKEN。
- podium_runtime_token、podium_proxy_token。
- enrollment token。
- runtime/proxy bearer 和 Authorization 验证。
- hash_secret、secret verification、secret rotation。
- SecretDecryptionError、encrypt/decrypt helper。
- encryption key 配置和 key rotation。
- *_enc、ciphertext、secret_hash、runtime token schema。
- 对应 model、DTO、env、CLI flag、日志事件、错误码、测试和 active docs。

不得改名补回：

- desktop_secret、client_secret、runtime_secret。
- capability token、local bearer、API key、session cookie。
- 明文 token side file、第二 credential table/store 或 credential reference。

这里的 client_secret 专指 OAuth Application secret；固定桌面 Application 也不包含它。Tauri permission capability 是框架权限配置，不是共享认证 secret，文档和代码中必须明确区分。

### 5.2 Linear OAuth 凭据

Linear access/refresh token 是第三方协议凭据，不是 Podium secret。批准的最小持久化边界是：

- access_token、refresh_token 只作为 `linear_installations` 行的明文字段保存在 Podium-owned `podium.db`。
- Podium 是唯一数据库 writer 和唯一 token reader；普通 metadata record、UI/Tauri response、Conductor/Performer contract、日志、报告、artifact 和 Linear 均不得包含 token。
- 首次连接必须把 installation metadata 与 pair 原子提交后才标记 Connected；refresh 必须原子替换 pair；disconnect 必须原子清空 pair 和状态。
- 正常 service restart/application update 复用 app-data 下同一 `podium.db`，不重新打开 OAuth。
- database missing、unreadable 或 corrupt 时 fail closed 并要求重新授权；不创建 fallback store。
- Symphony 不实现 OS credential/Keychain adapter、token encryption/decryption、key、ciphertext、memory-only mode、自动迁移或 dual read/write。
- 不使用明文 side file 或另一张 token table。
- callback state、PKCE verifier、authorization code 仅在内存短暂存在，完成、失败或超时后清除。

### 5.3 Podium 与 Conductor 本地通信

旧 HTTP runtime/enrollment/proxy secret transport 全部删除，改为 Desktop 在启动子进程前建立并只继承给预期 Podium/Conductor 的私有本地 IPC：

- 首选 inherited socketpair/pipe handle，使 channel 与 Desktop 启动的目标 child process 一一绑定；只有平台 proof 证明 inherited channel 不可行时，才能提交 scope_change_proposal 采用命名 endpoint。
- 若获批使用命名 endpoint，macOS/Linux 必须使用 app runtime directory 下的 Unix domain socket、0700 目录/0600 socket、peer credential 和 expected PID；Windows 必须使用当前用户 ACL 的 named pipe 并验证 expected process identity。
- 每个 Conductor 使用独立 channel，并绑定 conductor_id、project_id、binding_generation。
- 不开放 public 或 LAN listener。
- 不使用 bearer、capability token、cookie、API key 或共享 secret。
- handshake 只验证 component version、contract version、instance id、expected child process identity 和 nonce freshness。
- nonce 只用于会话新鲜度和 fencing，不作为持久或共享 credential。
- 意外 handle inheritance、重复连接、非预期 peer、stale generation 和 version mismatch 均 fail closed。

共享 IPC payload 必须由 performer-api 中的 closed model 定义。共享 model 不得包含数据库实现、token、任意 URL、任意 header 或 provider-specific 字段。

Performer turn 的 live status 使用单 turn、继承式、有界的本地 pipe。它只传 closed `PerformerTurnEvent`；Conductor 只保留 latest accepted value 和 counters，Podium 只展示 latest safe value。不得为此新增 listener、shared secret、event table、journal、broker、outbox 或 replay API。event loss 只影响 freshness，不影响 final result、task、wait、Gate 或 run state。

## 6. Linear 与固定 Application

唯一 Application manifest 包含：

- public client_id。
- 固定 loopback callback。
- 固定 scopes：`read`、`write`、`app:assignable`。
- actor=app。

Manifest 不启用 webhook 或 mention intake；loopback callback 只完成 human-initiated OAuth attempt，不是 runtime event ingress。

public client id 只从必需的 `LINEAR_CLIENT_ID` 进程环境读取，缺失/空值 fail closed；UI 和 SQLite 不可覆盖，callback/actor/scopes 仍由代码固定。schema 拒绝 client_secret、custom application、manifest/config revision 和 mutation 字段。MVP 不设计 Application 配置变更、candidate、cutover、兼容或 migration 分支。

OAuth 流程：

1. Podium 生成 state、PKCE verifier/challenge、attempt id 和 TTL。
2. Tauri 用系统浏览器打开 authorize URL。
3. 短生命周期 callback listener 只绑定固定 loopback host/port/path。
4. 校验 state、attempt、single use、TTL、Host/path。
5. code 只在内存完成 exchange。
6. callback 页面使用 no-store、严格 CSP、nosniff、no-referrer，不加载外部资源。
7. installation metadata 与 access/rotating-refresh pair 在 podium.db 的同一事务提交。
8. success、denied、invalid/replay/expired、port conflict、exchange failure 均形成 sanitized durable outcome。
9. listener 完成、失败、取消或超时后关闭。

正常启动先读取 podium.db：可用 access token 通过 `viewer` 验证；过期 token 用 public client id 和 rotating refresh token 刷新，并在新 access/refresh pair 原子提交 SQLite 后切换。正常 restart/update 不打开浏览器。`viewer` 必须验证 `app=true`、organization、app user 和 exact scopes。

Workspace installation 与本地 credential 是两个状态。已安装但本地无 credential，或 Connect 打开后只显示 **Manage** 且 bounded callback 超时，进入 `credentials_missing_for_existing_installation`。Manage 只打开管理页，不得标记 Connected；只有 admin 明确确认 **Reset and reconnect**、完成 workspace app removal 后，才能开始新的 install。不得自动移除、无限等待或使用 client secret/personal token/client-credentials fallback。

固定测试 Application 若不能使用无 client secret 的 S256 PKCE，Phase 1 直接 No-Go；不得把 client secret 打进客户端。

## 7. 运行流程

### 7.0 Create Conductor

Create Conductor 是 project choice、repository binding 和 desired process
creation 的唯一客户流程：

1. React 从 Podium 的 accessible project catalog 选择一个未绑定 project id。
2. React 调用 Tauri native Create Conductor command；Tauri 打开受限 directory
   picker，React 不提交 free-text repository path。
3. Tauri canonicalize picker 结果并通过 bounded bridge 把 project id +
   repository path 交给 Podium。
4. Podium 在一个 SQLite transaction 中验证 project accessible/unbound、
   repository/conductor uniqueness，并写入 stable conductor id、project、
   canonical repository、generation=1、isolated data-root key、
   `desired=running`。
5. Commit 后 Desktop 立即 reconcile，observed state 按
   `pending -> starting -> ready | failed` 推进。启动失败保留 desired binding
   和稳定错误，不回滚配置或伪装 ready。
6. 每次 Podium Desktop 启动都重新读取 active desired bindings 并自动启动或
   reconnect；生产不运行安装脚本、enrollment token、ambient CLI、checkout
   `PYTHONPATH` 或 ambient `conductor`。

MVP 不提供 binding edit/revision UI、自动 repository discovery、launch at
login 或 background service installation。Binding generation 只保留 runtime
configuration/fencing 语义，不形成客户可编辑 revision 流程。

### 7.1 启动

1. Tauri 获得 single-instance lock。
2. 创建 app-data、runtime、logs 和每个 Conductor data root。
3. 启动 Podium local process。
4. 完成 Tauri/Podium private protocol handshake。
5. Podium 打开 podium.db，并从批准的 installation 行恢复 Linear credential。
6. Tauri 根据 Podium active desired bindings 自动启动或重新连接隔离 Conductor；客户不运行安装脚本。
7. 每个 Conductor 完成 private IPC handshake 并打开自己的 workflow.db。
8. Conductor 启动 installed Performer control。
9. UI/popover 读取安全 snapshot。

### 7.2 Dispatch

1. Podium 完整分页 polling Linear。
2. 只接受 active desired binding project 中 delegate id 匹配当前 installation `app_user_id` 的 eligible root issue；排除 Symphony projection children，且不以 label 或 human assignee 路由。
3. observation、epoch、dispatch、checkpoint 原子提交到 podium.db。
4. 绑定项目的 Conductor 通过私有 IPC lease dispatch。
5. lease/ACK 携带 binding generation、lease id 和 fencing token。
6. Conductor 创建或恢复 workflow.db 中的 Managed Run。
7. Conductor 通过 installed Performer command 执行 plan、execute、gate turn。
8. Conductor 通过 Podium 的 scoped Linear gateway 投影状态；Linear token 永不发送给 Conductor。
9. Conductor 上报有界 run/Performer/runtime-wait snapshot，并可附带 latest closed `performer_event`；该 event 不持久化为 workflow truth。

### 7.3 退出

1. 停止新 polling、dispatch 和 turn。
2. 请求 active Conductor drain 到安全点。
3. 停止 Performer control/turn。
4. 关闭每个 workflow.db 和 IPC。
5. Podium checkpoint 并关闭 podium.db。
6. 停止 Podium 和 Conductor 进程。
7. Tauri 退出。

关闭主窗口只隐藏；显式 Quit 才执行退出流程。

## 8. 必须保留的运行语义

- baseline/incremental polling 完整 cursor pagination。
- checkpoint/delegation epoch 原子提交。
- 同一 epoch exactly-once dispatch。
- blocker 重新评估、lease reclaim、stale fencing/result rejection。
- 一个 project 最多一个 active desired Conductor binding。
- 一个 Conductor 绑定一个 project + repository。
- ordered work items。
- verification command 后执行 read-only Performer Gate。
- 第一次 Gate fail 自动 rework 一次，第二次 fail block。
- immutable plan/policy revision、attempt、lease、fencing provenance。
- runtime approval/permission/tool-input wait 的 durable state 和 Linear projection。
- sanitized correlated logs、durable errors、UI/Linear parity。
- Performer provider isolation 和 installed subprocess boundary。
- `performer_kind` 固定为 `codex` provenance，不提供 selector、fallback、review route 或第二 backend。
- `performer_event` 仅为 allowlisted semantic `progress|warning|heartbeat`；不得改变 task、plan approval、runtime wait、Gate、retry 或 terminal state。
- Linear 不接收 `performer_event`；operator truth 继续由 parent/Sub Issue/`[Human Action]`/Gate/final projection 提供。

模块边界保留不代表保留旧远端 transport。Podium/Conductor 仍分工，但只在本机通过无共享 secret 的私有 IPC 协作。

## 9. UI

### 9.1 完整窗口

1. Overview：Linear、Podium、Conductors、Performers、active runs 的组合健康。
2. Linear：Connect、Reset and reconnect、Disconnect、organization、app user、exact scopes、credential/polling health、accessible project catalog。
3. Runtimes：Create Conductor（选择 project + repository）以及每个 Conductor 的 process、heartbeat、dispatch 和错误。
4. Performer：Codex provenance、readiness、provider login、profile revision、active turn、runtime wait；无 provider selector。
5. Managed Runs：run、work items、verification、Gate、rework、blocked、evidence、latest safe `performer_event` 或 unavailable/stale state。

首次设置：

    Connect Linear
      -> Create Conductor(s): select one project + one repository
      -> Desktop automatically starts/reconnects desired Conductor(s)
      -> Validate Performer
      -> Ready

不再存在 Login、Register、Account、workspace session、custom Application 或 enrollment token UI。

### 9.2 macOS popover

popover 只读展示：

- 全局状态与最后更新时间。
- Needs attention。
- Linear authorization/polling health。
- Podium local process health。
- Conductor online/total、project 和 active dispatch/run。
- Performer Ready/Busy/Waiting/Failed。
- Open Podium、Quit。

第一版不在 popover 直接执行 reauthorize、retry、start/stop/restart、disconnect 或删除。

### 9.3 视觉

继续以 packages/podium/web/DESIGN.md 和 tokens.css 为规范，保持现有 palette、typography、spacing、radius、border、shadow 和 status colors。只允许补充桌面窗口、popover、安全区和平台控件布局 token，不借重构换肤。

## 10. 架构演进

### 当前

    Browser
      -> Podium SaaS + PostgreSQL
      -> HTTP runtime/proxy bearer
      -> Conductor + workflow.db
      -> Performer

### 过渡

    Tauri/React
      -> Podium local process + podium.db
      -> private local IPC
      -> Conductor + workflow.db
      -> Performer

过渡规则：

- 新旧路径不双写。
- 旧 Podium/Conductor 代码只作为行为对照，不新增功能。
- 先证明 Desktop、SQLite、OAuth、IPC、Conductor/Performer chain 可行。
- 新路径 real E2E 通过后再删除 PostgreSQL、public API、secret/crypto 和 enrollment。
- packages/podium 与 packages/conductor 始终保留；只删除各自的旧 SaaS/远端 transport 实现。

### 目标

    Podium Desktop UI
      -> Podium local control plane + SQLite
      -> Conductor local orchestration + workflow.db
      -> Performer fenced turns

目标减少：

- SaaS/public browser boundary：删除。
- PostgreSQL：删除。
- Podium secret、自研 crypto：删除。
- public runtime HTTP：删除。
- browser account/custom Application：删除。

目标保留：

- Podium 与 Conductor 逻辑/进程/package 边界。
- 两个明确 durable ownership domain。
- Performer provider boundary。
- Managed Run 行为。

已拒绝方案：

- 合并 Podium/Conductor package。
- 删除 packages/conductor。
- 合并 podium.db 与 workflow.db。
- 将所有职责堆入单一 Podium Runtime。

## 11. 范围台账

### 11.1 authorized

- 保持四个现有 Python package。
- 保持 Podium/Conductor/Performer import boundary。
- Podium 客户端化并改用 SQLite。
- Conductor 继续独立、继续拥有 workflow.db。
- 删除 PostgreSQL。
- 删除全部 Podium secret 和 Symphony 自研 encryption/decryption。
- Linear access/refresh token 只明文持久化在 Podium-owned podium.db；无 Keychain/OS credential adapter、memory-only mode 或第二 store。
- 固定测试 Linear Application、本地 callback、无自定义 Application。
- Linear polling-only、无 inbound business-event endpoint、无 native agent interaction。
- Podium-only、Codex-only closed `performer_event`；无 raw event、event history 或 Linear live write。
- macOS 菜单栏 popover、完整窗口保持现有视觉。
- 每个 Task 必须调用 simple-code、经过 code-view finding 范围审查并形成独立 commit。
- code-view 不得成为新功能来源；越界建议必须拒绝。

### 11.2 assumptions_requiring_approval

| ID | 推荐决定 | 影响 |
| --- | --- | --- |
| A1 | 原生壳使用 Tauri 2，UI 继续 React + TypeScript | 桌面技术栈 |
| A2 | Podium Python package 作为本地 sidecar 复用，不重写成 Rust | 降低迁移风险 |
| A3 | Desktop 同时监督一个 Podium 和多个隔离 Conductor | 本地进程拓扑 |
| A4 | 一个 profile 同时只连接一个 Linear organization，可选择多个 project | 本地数据模型 |
| A5 | 每个 created Conductor 对应一个 project、repository、data root 和 active desired binding | 保持现有隔离模型；project choice 属于 Create Conductor |
| A6 | 所有平台首选 Desktop 创建并仅继承给目标 child 的私有 channel；只有 Phase 1 证明不可行且另获 scope-change 批准时，才使用 Unix domain socket 或 Windows named pipe | 无 shared secret 的 transport |
| A7 | 关闭主窗口只隐藏，显式 Quit 才停止 | macOS 生命周期 |
| A8 | 第一版不做 launch at login | 首版平台范围 |
| A9 | 旧 Podium/PostgreSQL/account 数据不迁移；旧 workflow.db 不自动导入 | 硬切数据策略 |
| A10 | macOS 完整 popover；Windows 等价 tray；Linux 可回退 native menu + full window | 跨平台范围 |
| A11 | 固定测试 Application manifest 不可由 UI/env/database 覆盖，使用 S256 PKCE、`actor=app` 和 exact `read,write,app:assignable` scopes，无 revision、修改流程或 webhook runtime dependency | OAuth 模型 |
| A12 | Runtime/Linear 短暂不可用时停止新工作；已启动 turn 可完成并先写 workflow.db，恢复后投影 | 故障语义 |
| A13 | Linear access/refresh token 明文写入 Podium-owned `podium.db`，restart/update 复用；不使用 Keychain/OS credential、自研 crypto、memory-only、自动迁移或 dual store | 最小凭据持久化 |

批准本规格即批准 A1–A13。任何调整必须先更新 tracked product spec，再实现。

### 11.3 out_of_scope

- 合并或删除现有 Python package。
- SaaS、多租户、远端 Conductor、云同步。
- 自定义 Linear Application。
- Linear Application manifest/config revision、运行时修改、candidate、cutover、兼容或 migration。
- Public webhook/relay/tunnel、mention intake、Linear native agent interaction。
- Raw Codex streaming、event table/journal/broker/outbox/replay、Linear live-event write。
- Provider selector、第二 production backend、cross-model routing/review/fallback。
- PostgreSQL 或其他网络数据库。
- Podium secret、local bearer、capability secret、自研 crypto/key management。
- OS credential store/Keychain、memory-only Linear credential、credential migration、dual store 或 plaintext token side file。
- 旧数据迁移、compatibility shim、双写。
- 新 DAG、并行 task scheduler、第二 production backend。
- 自动更新、launch at login、遥测、诊断包导出、视觉重设计。

## 12. 每任务交付协议

每个 tasks/plan.md 中的 Task 都必须按以下顺序执行，任何一步不可跳过：

1. Scope ledger
   - 写 authorized、required_consequences、out_of_scope、assumptions_requiring_approval、deferred_ideas。
   - assumptions_requiring_approval 必须为空。
2. Baseline
   - 确认 working tree，记录任务开始 commit。
   - 读取当前 task 的 spec、邻近实现和测试。
3. Implement
   - 先写或更新行为测试，再实现最小范围。
   - 只修改本任务声明的文件/行为。
4. Focused verification
   - 运行本任务 focused tests、lint/type/build。
5. simple-code
   - 必须调用项目 code-simplification skill；本项目将此步骤称为 simple-code。
   - 只审查和简化本任务 diff。
   - 保持行为、错误、side effects、ordering 和 public/durable contract 完全不变。
   - 不得跨任务重构、删除错误处理或添加功能。
   - 若无需修改，也必须记录 simple-code_no_change 及理由。
6. Re-verify
   - simple-code 后重新运行 focused tests、lint/type/build。
7. code-view
   - 对最终 task diff 做 correctness、architecture、security、performance、test review。
8. Finding adjudication
   - 每条 finding 必须分类并写入 task evidence：
     - IN_SCOPE_BLOCKER：直接违反已批准 spec、当前 task acceptance 或既有明确 invariant；必须修复。
     - IN_SCOPE_OPTIONAL：在范围内但非完成所必需；默认不实现，除非用户批准。
     - OUT_OF_SCOPE_REVIEW_SUGGESTION：无法追溯到已批准需求；必须拒绝，不改代码，不加测试。
     - INVALID_FINDING：与事实/contract 不符；记录证据后拒绝。
   - Code-view 的建议本身不构成需求。
   - 不得通过“安全加固”“顺手优化”“未来扩展”绕过用户批准。
9. Review loop
   - 修复 IN_SCOPE_BLOCKER 后，重新执行 focused verification、simple-code、re-verify 和 code-view。
   - 直到没有未处理的 IN_SCOPE_BLOCKER。
10. Final verification
    - 运行任务要求的 focused/full tests、secret/forbidden search 和 diff check。
11. Atomic commit
    - 每个 Task 必须产生一个独立 commit。
    - 一个 commit 只包含该 Task；不得合并多个 Task，不得混入无关格式化或重构。
    - commit message 使用 type: imperative summary，并解释 why。
    - 记录 commit hash、verification、simple-code 结果、code-view finding 分类和 residual risk。

除纯用户批准 Gate 外，任何产生 tracked diff 的 Task 没有 commit 就不算完成。不得制造空提交来满足流程。Commit 不是产品 acceptance；用户仍可拒绝结果。

仓库目前没有名为 simple-code 或 code-view 的独立命令。除非用户之后提供其他入口：

- simple-code 明确定义为调用 .agents/skills/code-simplification/SKILL.md。
- code-view 明确定义为调用 .agents/skills/code-review-and-quality/SKILL.md。

实施前必须把两个入口写入 tracked workflow 文档；不得假装执行了不存在的命令，也不得只写“已 review”而没有 findings/evidence。

## 13. Review 与产品批准

- Review finding 不等于产品授权。
- Critical/Required 只有在可追溯到已批准 contract 时才是 IN_SCOPE_BLOCKER。
- Optional、Consider、Nit、FYI 默认不实施。
- 新页面、按钮、状态、配置、schema、权限、fallback、平台能力或 workflow branch 必须先提交 scope_change_proposal。
- scope_change_proposal 必须包含用户价值、行为差异、数据/安全影响、替代方案、删除成本和新增测试。
- 用户明确批准前，不得把 proposal 写入生产代码或用测试固化成需求。
- 用户可以拒绝 code-view 结论。
- 工程 review approval、commit 完成和用户 product acceptance 是三个独立状态。

## 14. 删除旧实现的硬门槛

只有以下全部通过才能删除旧路径：

- Desktop/Tauri、Podium sidecar、private IPC、SQLite、OAuth、Conductor/Performer chain feasibility 为 Go。
- 从零完成固定 Application OAuth、project discovery、Create Conductor（project + repository）、Desktop auto-start 和 Performer Ready。
- 已安装但本地 credential 缺失时 Manage bounded timeout、显式 Reset and reconnect 和 clean reinstall 有证据。
- 一次真实成功 Managed Run。
- first Gate fail rework、second fail block、runtime wait。
- Podium/Conductor restart、OAuth refresh、dedup、lease reclaim、stale fencing。
- SQLite token pair 在 restart/update 后可恢复，refresh/disconnect transaction 有失败与泄漏证据。
- UI、podium.db、workflow.db、Linear、logs 对 failure/wait 状态一致。
- Podium secret、自研 crypto、PostgreSQL forbidden search 为零。
- E2E 在 PostgreSQL、旧 public Podium API 和旧 bearer transport 不可用时通过。
- macOS 完整验收；Windows/Linux 达到批准标准。

## 15. 成功标准

1. 用户只启动 Podium Desktop，不需要 PostgreSQL 或公开 Podium server。
2. packages/podium、packages/conductor、packages/performer、packages/performer-api 均保留且 import boundary 通过。
3. podium.db 是 Podium 唯一 durable store；每个 Conductor 的 workflow.db 仍是 Managed Run truth。
4. 只有固定测试 Linear Application；本地 callback + S256 PKCE + exact `read,write,app:assignable` scopes，无 client secret/webhook runtime dependency，也无 manifest/config revision 或修改流程。
5. 无 Podium runtime/proxy/enrollment secret、bearer、secret hash 或替代 capability secret。
6. 无 Symphony encrypt/decrypt/key/ciphertext/OS credential adapter；Linear token 只在 Podium memory 和 podium.db 的批准字段中出现，restart/update 不重复授权。
7. Podium 与 Conductor 通过 private IPC 协作，不互相 import，不公开 runtime HTTP。
8. macOS popover和完整窗口保持现有视觉，展示 Linear、Conductors、Codex Performer、runs、waits、errors 和 latest safe live status；无 provider selector。
9. 原 Managed Run/Gate/recovery/error visibility 有自动化和 real-run 证据。
10. 每个 Task 都有 simple-code evidence、code-view finding adjudication、最终验证和独立 commit hash。
11. 任何越界 code-view 建议均被拒绝，未引入未批准新功能。

## 16. 官方设计依据

- 已批准 Linear 架构：`docs/product/linear-integration.md`。
- Linear 凭据持久化决策：`docs/decisions/0008-store-linear-tokens-in-podium-sqlite.md`。
- Linear 固定配置无 revision 决策：`docs/decisions/0009-freeze-linear-app-configuration-for-mvp.md`。
- Tauri 2 Sidecar：https://v2.tauri.app/develop/sidecar/
- Tauri 2 System Tray：https://v2.tauri.app/learn/system-tray/
- Linear OAuth 2.0 / PKCE：https://linear.app/developers/oauth-2-0-authentication
- Linear OAuth application actor：https://linear.app/developers/oauth-actor-authorization
- Linear OAuth application manifests：https://linear.app/developers/oauth-app-manifests

官方能力说明不能替代仓库内 feasibility、测试和真实 E2E 证据。

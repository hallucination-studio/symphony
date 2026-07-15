# 实施计划：Podium Desktop、SQLite 与保留 Conductor 边界

> 状态：Approved，按依赖顺序实施
>
> 规格：tasks/spec.md
>
> 原则：只拆分已授权方案，不新增产品功能。
>
> Linear 校准来源：`docs/product/linear-integration.md`。本计划不得增加该文档未批准的 inbound、native agent、provider、event persistence 或 workflow 行为。

## 1. 已冻结架构

    Podium Desktop（Tauri + React）
      ├─ Podium local process + podium.db
      │  └─ OAuth / projects / polling / dispatch / snapshots
      └─ Conductor process(es) + workflow.db
         └─ Managed Run / Gate / recovery / Performer subprocesses

必须保持：

- packages/podium、packages/conductor、packages/performer、packages/performer-api 四个 package。
- Podium 与 Conductor 的独立进程、import boundary 和 durable state ownership。
- Podium 使用 podium.db；每个 Conductor 继续使用 workflow.db。
- Linear access/refresh token 只明文持久化在 Podium-owned podium.db；restart/update 复用同一数据库。
- Podium/Conductor 只通过 private inherited IPC 和 performer-api closed contracts 协作。
- 不使用 PostgreSQL、Podium secret、自研 encryption/decryption、public runtime HTTP 或 custom Linear Application。
- Linear runtime intake 只使用 outbound polling；固定 App 使用 S256 PKCE、`actor=app` 和 exact `read,write,app:assignable` scopes。
- MVP 固定 App 无 manifest/config revision、mutation、candidate、cutover 或 migration。
- `performer_event` 只作为 Podium 的 Codex-only advisory live status；无 raw event、Linear live write、event history 或 workflow authority。

## 2. 统一验证命令

后续任务引用以下命令名；执行时使用这里的完整命令。

缩写展开规则：

- Python focused X：将 X 中列出的测试文件或 node id 原样替换到下面 Python focused 命令的占位符；必须记录最终展开后的完整命令。
- Python full：执行 make test。
- Podium Web：按顺序执行 test、lint、design:lint、build 四条命令，不得只选其中一条。
- Desktop Rust：按顺序执行 cargo test、cargo check、npm run build；某 Task 明确限定单个 Rust test 时，final verification 仍需执行全部三条。
- Diff：同时执行 git diff --check 和 git status --short。
- Search/scan：Task evidence 必须记录实际 rg 或审计脚本命令、退出码和匹配结果，不能只写“已搜索”。

Python focused：

    PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
      .venv/bin/python -m pytest <test-files-or-node-ids> -q

Python full：

    make test

Podium Web：

    cd packages/podium/web && npm run test
    cd packages/podium/web && npm run lint
    cd packages/podium/web && npm run design:lint
    cd packages/podium/web && npm run build

Desktop Rust，创建 desktop workspace 后：

    cd packages/podium/desktop/src-tauri && cargo test
    cd packages/podium/desktop/src-tauri && cargo check
    cd packages/podium/desktop && npm ci
    cd packages/podium/desktop && npm run build

Diff：

    git diff --check
    git status --short

Files 路径规则：

- 以 packages/podium/src/podium/ 开头的同组文件可在同一 Task 的 Files 中省略该共同前缀。
- web/ 等价于 packages/podium/web/。
- desktop/ 等价于 packages/podium/desktop/。
- store/ 等价于 packages/podium/src/podium/store/。
- tests/ 等价于仓库根 tests/。
- 每个 Files 条目中的省略前缀、裸文件名、related tests、focused tests 或 tests 占位写法，实施前都必须在 Task scope ledger 中解析为唯一的 repo-relative path；不得依赖执行者猜测“同目录”。
- 解析后的具体路径必须保持在该 Task file budget 内；任一路径无法唯一解析时 Task 阻塞，只能做 scope-neutral task split 或修正文档，不得扩大范围。

## 3. 每任务 Definition of Done

除纯用户批准 Gate 外，每个产生 tracked diff 的 Task 必须依次完成：

1. 写 scope ledger，assumptions_requiring_approval 为空。
2. 记录开始 commit 和 focused baseline。
3. 先写行为测试，再实现当前 Task 最小改动。
4. 运行当前 Task 的 focused verification。
5. 调用 simple-code：.agents/skills/code-simplification/SKILL.md，只简化当前 diff。
6. simple-code 后重新运行 focused verification。
7. 调用 code-view：.agents/skills/code-review-and-quality/SKILL.md。
8. 对每条 finding 做 requirement trace 和分类：
   - IN_SCOPE_BLOCKER：违反批准规格、Task acceptance 或明确 invariant；必须修复。
   - IN_SCOPE_OPTIONAL：范围内但非必要；默认拒绝，用户批准后才能实现。
   - OUT_OF_SCOPE_REVIEW_SUGGESTION：不属于批准方案；必须拒绝，不改代码、不加测试。
   - INVALID_FINDING：事实或 contract 不成立；记录证据后拒绝。
9. 修复 blocker 后重新执行 verification、simple-code、re-verification 和 code-view。
10. 运行 final verification、forbidden search 和 diff check。
11. 创建一个只包含当前 Task 的原子 commit，记录 hash、验证、simple-code、finding adjudication 和 residual risk。

不得制造空提交。Engineering review、commit 完成和用户 product acceptance 是三个独立状态。

## 4. 依赖图

    Approval / tracked spec
      -> Desktop + sidecar feasibility
      -> SQLite / IPC / OAuth feasibility
      -> Local contracts + Podium foundation
      -> Fixed Linear Application
      -> Private Podium/Conductor boundary
      -> Polling + dispatch
      -> Managed Run core
      -> Closed Codex performer_event
      -> Desktop UI + popover
      -> Real E2E
      -> Old path deletion
      -> Platform release acceptance

## 5. Phase 0：批准与工作流冻结

### Task 0.1：批准规格和任务边界

Description：确认 A1–A13、package boundary、双 SQLite ownership、无 secret/crypto 和交付 Gate。

Dependencies：None。

Files：tasks/spec.md、tasks/plan.md、tasks/todo.md、tasks/code-view.md。

Estimated scope：XS，纯批准 Gate，不产生 tracked diff。

Acceptance：

- 用户明确批准或要求修订。
- 旧“合并/删除 Conductor”方案保持 rejected。
- tasks/code-view.md verdict 为 Approve，且没有未处理的 IN_SCOPE_BLOCKER 或越界需求。

Verification：检查 git status、tasks ignored 状态、A1–A13、无已勾选任务，以及 code-view 文档必需章节、finding 分类和 verdict。

Commit：None，纯用户批准 Gate，禁止制造空提交。

### Task 0.2：提交 tracked product spec 和 ADR

Description：把获批方案从 gitignored tasks 固化为仓库 source of truth。

Dependencies：0.1。

Files：docs/product/podium-desktop.md、docs/decisions/0007-podium-desktop-local-boundaries.md、docs/product/README.md、AGENT.md、AGENTS.md。

Estimated scope：M，5 files。

Acceptance：

- 文档明确保留四 package、Podium/Conductor boundary、podium.db/workflow.db ownership。
- ADR 明确拒绝 package/database 合并并记录硬切后果。
- AGENT.md/AGENTS.md 在 Task 1.4 前明确 performer-api 可承载跨 role/process 的 dependency-free closed contract，同时继续禁止 runtime implementation、Linear 调用、持久化和 provider-specific 数据。
- 未验证技术仍标为 assumptions。

Verification：documentation link check；Diff；code-view requirement trace。

Commit：docs: define Podium Desktop local boundaries。

### Task 0.3：确认 skill 驱动的 Task evidence 流程

Description：确认现有 skills 已约束 plan、todo、simple-code 和 code-view；evidence 留在 tasks 工作区，不另建 docs workflow 或 helper。

Dependencies：0.2。

Files：tasks/plan.md、tasks/todo.md、tasks/code-view.md、tasks/scope-ledgers/、tasks/evidence/。

Estimated scope：XS，本地流程确认 gate，不产生 tracked diff。

Acceptance：

- planning/spec skills 的规范路径保持 tasks/plan.md 和 tasks/todo.md。
- 每个 Task 的 scope ledger 写入 tasks/scope-ledgers/task-<id>.md。
- 每个 Task 的 verification、simple-code、code-view finding adjudication、commit hash 和 residual risk 写入 tasks/evidence/task-<id>.md。
- 无 requirement trace 的 finding 默认标记 OUT_OF_SCOPE_REVIEW_SUGGESTION 并拒绝。
- 不新增 docs evidence、Make helper、自动 finding acceptance 或自动 commit。

Verification：路径检查；skill contract review；tasks ignored-state check；无 docs/development evidence/helper diff。

Commit：None，本地流程确认 gate，禁止制造空提交。

### Checkpoint 0：工作流可执行

- tracked product spec 和 ADR 已提交；skill 驱动的 task/evidence 路径已确认。
- 用户批准后才进入生产实现。

## 6. Phase 1：高风险可行性

### Task 1.1：建立最小 Tauri Desktop 壳

Description：在现有 Podium 所有权下建立可启动、可打包的 Tauri 2 壳，直接消费 packages/podium/web 的现有 build，不迁移业务逻辑或创建第二个 React root。

Dependencies：Checkpoint 0。

Files：packages/podium/desktop/package.json、package-lock.json、src-tauri/Cargo.toml、Cargo.lock、build.rs、src/main.rs、tauri.conf.json、capabilities/default.json。

Estimated scope：M，8 scaffold/lock files；lockfile 机械 diff 不扩大产品行为。

Acceptance：

- macOS dev/build 能显示 packages/podium/web 的现有 token 驱动 React view；desktop/ 下没有第二个 React entrypoint。
- Desktop package scripts 只负责 Tauri dev/build，并调用现有 web build；Tauri CLI 被 lockfile 固定，不依赖 ambient global install。
- CSP、Tauri permissions 和网络访问无通配。
- Rust、Node、Tauri 版本锁定。

Verification：Desktop Rust；单一 React entrypoint/source search；native launch smoke；Diff。

Commit：feat: add minimal Podium Desktop shell。

### Task 1.2：证明 Podium sidecar framing 和生命周期

Description：让 Tauri 启停现有 podium package 的本地进程，并建立最小 framed protocol。

Dependencies：1.1。

Files：packages/podium/src/podium/desktop_cli.py、desktop_protocol.py、desktop_health.py、desktop/src-tauri/src/podium_process.rs、desktop/src-tauri/tauri.conf.json、tools/build_desktop_sidecars.py、sidecar build dependency manifest/lock、tests/test_podium_desktop_protocol.py。

Estimated scope：M，8 protocol/packaging files；manifest/lock 的唯一 repo-relative path 在 Task scope ledger 中解析。

Acceptance：

- 支持 handshake、frame size、timeout、backpressure、malformed input 和 graceful shutdown。
- stdout 仅承载 protocol，日志走 stderr/file。
- Build 从当前 source/package 生成 target-specific Podium sidecar artifact 并登记到 Tauri bundle；installed runtime 只解析 bundle 内 artifact，不调用 checkout、PYTHONPATH、ambient `python` 或 `podium`。
- 打包器选择属于 Phase 1 可替换 build detail，不改变四 package ownership；新增依赖必须按 dependency review gate 记录维护性、license、锁文件和 bundle 影响。
- crash 在 Tauri state 中可见且退出无 orphan。

Verification：Python focused test_podium_desktop_protocol；cargo test/check；bundle manifest/artifact inspection；从不含 checkout/PYTHONPATH/ambient podium 的临时目录执行 packaged lifecycle smoke；Diff。

Commit：feat: supervise the local Podium sidecar。

### Task 1.3：证明 Podium SQLite 事务模型

Description：用独立 feasibility schema 验证 PostgreSQL polling transaction 可落到 SQLite。

Dependencies：1.2。

Files：packages/podium/src/podium/store/sqlite.py、schema.py、tests/test_podium_sqlite_feasibility.py。

Estimated scope：M，3 files。

Acceptance：

- WAL、foreign_keys、busy_timeout 和 single writer 生效。
- observation、epoch、dispatch、checkpoint 可原子提交并在 crash/reopen 后一致。
- lock、disk-full、corruption 明确失败，不静默重建。
- Proof 使用后续 Task 2.1 原地收敛的 store/sqlite.py 和 schema.py，不创建 proof-only production module 或第二套 SQLite abstraction。

Verification：Python focused test_podium_sqlite_feasibility；timing evidence；PostgreSQL dependency absence check；Diff。

Commit：test: prove Podium SQLite transaction semantics。

### Checkpoint 1A：Desktop 与 SQLite proof

- Tauri shell、Podium sidecar 和 SQLite transaction proof 通过。
- 未开始迁移业务状态。

### Task 1.4：定义最小 private IPC proof contract

Description：先在 performer-api 定义只够 feasibility 使用的 handshake 和 envelope，避免跨包复制 DTO。

Dependencies：1.2。

Files：packages/performer-api/src/performer_api/local_runtime.py、validation.py、__init__.py、tests/test_local_runtime_contract.py、docs/modules/performer-api.md、docs/modules/README.md。

Estimated scope：M，6 contract/test/documentation files。

Acceptance：

- Contract 封闭 version、instance、project、binding generation、correlation 和 payload kind。
- 拒绝 token、header、arbitrary URL、provider fields 和 unknown fields。
- performer-api 不获得 runtime implementation dependency。
- docs/modules/performer-api.md 同步记录 local runtime DTO 属于 dependency-free closed wire contract，而非 Performer 或 Linear runtime implementation。
- docs/modules/README.md 的 performer-api ownership 表与新增 closed contract 同步，不保留过时 target surface。

Verification：Python focused test_local_runtime_contract；package boundary test；Diff。

Commit：feat: define private local runtime contracts。

### Task 1.5：证明 inherited Podium/Conductor channel

Description：Desktop 为测试 Conductor 创建专属 inherited channel，并证明长驻 Podium 不重启时仍可增加后续隔离 Conductor session，验证身份和 fail-closed 行为。

Dependencies：1.4。

Files：desktop/src-tauri/src/private_ipc.rs、packages/podium/src/podium/local_sessions.py、packages/conductor/src/conductor/podium_ipc.py、tests/test_private_runtime_ipc.py、desktop/src-tauri/tests/private_ipc.rs。

Estimated scope：M，5 files。

Acceptance：

- Channel 只继承给 expected child，并绑定 PID、instance、project 和 generation。
- Podium 已 ready 后可依次接入至少两个独立 Conductor session；不得通过重启 Podium、public/named listener 或共享 bearer 绕过动态 handle/session 建立问题。
- Desktop 可做 opaque frame relay 或平台 handle transfer，但不得解析、重写或持久化 configure/dispatch/report/Linear 领域 payload；所选机制及平台限制写入 feasibility evidence。
- wrong peer、duplicate connect、stale nonce/version/generation 均拒绝。
- 无 localhost listener、bearer、capability secret、API key 或 cookie。
- Proof 只建立后续 Task 4.2/4.4 原地扩展的最小 canonical seams，不创建 probe-only transport module。

Verification：Python focused test_private_runtime_ipc；cargo test private_ipc；long-lived Podium + sequential two-Conductor session smoke；socket/listener/handle isolation inspection；package boundary；Diff。

Commit：test: prove secretless Podium Conductor IPC。

### Checkpoint 1B：边界 proof

- performer-api contract 和 inherited IPC identity proof 通过。
- 无 shared secret、public listener 或跨包 import。

### Task 1.6：证明固定 Application PKCE callback mechanics

Description：验证固定测试 Application 的本地 callback、S256 PKCE 和 public exchange mechanics；正式 credential lifecycle 由 Task 1.7 与 Checkpoint 1C 共同证明。

Dependencies：1.2。

Files：packages/podium/src/podium/linear_manifest.py、linear_oauth.py、oauth_callback.py、tests/test_podium_oauth_feasibility.py、desktop/src-tauri/src/oauth.rs。

Estimated scope：M，5 files。

Acceptance：

- S256 PKCE、固定 host/port/path、state TTL 和 single use 可用。
- public client id 只从必需的 `LINEAR_CLIENT_ID` 读取，缺失/空值 fail closed；authorize/exchange 不接受 client-id 参数或 fallback。
- success、denied、replay、expired、timeout、port conflict 均确定性关闭 listener。
- callback response 使用 no-store、CSP、nosniff、no-referrer，无外部资源。
- Public exchange request 不携带 client secret；本 Task 只用 deterministic fake/sentinel token 验证 exchange/revoke cleanup，不自行建立正式 credential persistence。
- Proof 使用后续 Task 3.2/3.3 原地收敛的 OAuth seams，不留下 probe-only callback/exchange module。

Verification：Python focused test_podium_oauth_feasibility；Rust fixed-manifest tests；public exchange request/body、revoke cleanup、callback header/content 和 sentinel scan；Diff。

Commit：test: prove local Linear PKCE callback。

### Task 1.7：证明 Linear credential SQLite persistence

Description：在 canonical SQLite seam 验证 Linear token pair 可跨 reopen、service restart 和 application update 持久化。

Dependencies：1.3、1.6。

Files：packages/podium/src/podium/store/sqlite.py、schema.py、tests/test_linear_credentials_sqlite.py。

Estimated scope：M，3 files。

Acceptance：

- installation metadata + access/refresh pair 首次写入、pair replace、pair clear 均为单一 SQLite transaction；失败不留下 half pair 或虚假 Connected。
- close/reopen、service restart 和保留 app-data 的 application update 可读回同一 pair，不打开 OAuth。
- token 只存在于批准的 installation columns；普通 record/snapshot、Tauri protocol、stdout、stderr、logs、report、artifact 和 UI payload 均无 sentinel。
- database unavailable/corrupt 时 fail closed；不存在 OS credential/Keychain adapter、encrypt/decrypt/key/ciphertext、memory-only 或第二 store fallback。
- Proof 原地扩展 Task 1.3 的 sqlite/schema seam，并由 Tasks 2.1/3.4 收敛；不创建 proof-only credential module。

Verification：Python focused test_linear_credentials_sqlite；transaction/reopen/restart/update/failure tests；schema allowlist；outward token sentinel/Keychain/crypto forbidden scan；Diff。

Commit：test: prove Linear credential persistence in SQLite。

### Checkpoint 1C：OAuth proof

- 使用 Task 1.6/1.7 canonical seams 完成一次 production-shaped real flow：exact callback、S256 PKCE、`actor=app`、exact scopes、public exchange、`viewer.app=true`、organization/app user/project pagination、SQLite transaction write、reopen/restart、refresh rotation 和 refresh 后 viewer revalidation。
- 已安装但本地 credential 缺失时，**Manage** 不得标记 success；bounded callback timeout、`credentials_missing_for_existing_installation`、explicit app removal 和 clean reinstall evidence 完整。
- 真实 credential 可在明确记录的 test installation row 中保留供后续 E2E；raw podium.db 不归档，token 不得出现在 stdout/stderr/log/report/artifact/argv，cleanup 或 intentional retention 必须可审计。
- 无 client secret、OS credential/Keychain、自研 crypto、memory-only 或 dual-store path。

### Task 1.8：证明 Desktop 到 Performer 的完整进程链

Description：用一个隔离 Conductor 证明 Desktop 监督与既有 Performer boundary 可以共同打包运行。

Dependencies：1.5。

Files：desktop/src-tauri/src/conductor_process.rs、desktop/src-tauri/tauri.conf.json、packages/conductor/src/conductor/conductor_cli.py、performer_control.py、tools/build_desktop_sidecars.py、tools/desktop_process_smoke.py、tests/test_desktop_process_bundle.py。

Estimated scope：M，7 process/packaging files。

Acceptance：

- Desktop 启动 Conductor，Conductor 启动 installed Performer control 和受控 turn。
- Conductor 和 Performer target-specific artifacts 进入 Tauri bundle；installed runtime 只从 bundle manifest/approved app paths 解析，不依赖 checkout、PYTHONPATH、ambient PATH 或 ~/.codex。
- Bundle 内仍保留独立 podium/conductor/performer package/command 边界，不合并为一个运行模块。
- PID、instance、turn、exit、log 可关联且无 orphan。

Verification：Python focused test_desktop_process_bundle；bundle manifest/artifact inspection；从 clean temporary install root 执行 process smoke；provider/import boundary；ambient path/profile forbidden audit；Diff。

Commit：test: prove packaged Conductor Performer chain。

### Task 1.9：证明 macOS popover 生命周期

Description：只验证 tray、window 和 popover 行为，不接业务 mutation。

Dependencies：1.1、1.2。

Files：desktop/src-tauri/build.rs、src/oauth.rs、src/tray.rs、src/windows.rs、web/src/App.tsx、auth/useSession.ts、i18n.tsx、popover/Popover.tsx、popover.css、Popover.test.tsx。

Estimated scope：M，10 files；既有 static build artifacts 随 Web build 机械更新。

Acceptance：

- 点击 toggle、失焦/Esc 收起、多显示器定位、关闭主窗口不退出。
- Podium sidecar down 时仍能显示错误、Open 和 Quit。
- 正式 `.app` 的 public client id 来自构建环境，正常 GUI 启动不依赖 shell `.env`；主窗口的本地服务失败结束 Loading 并显示脱敏错误。
- 键盘和 VoiceOver 基本路径可用。

Verification：component test；cargo test/check；native screenshots/video；orphan check；Diff。

Commit：feat: add the macOS status popover shell。

### Checkpoint 1D：进程与 popover proof

- Desktop -> Conductor -> Performer chain 和 macOS popover lifecycle 通过。

### Task 1.10：记录跨平台 Go/No-Go

Description：汇总 macOS、Windows、Linux 的 sidecars、IPC、SQLite credential persistence、callback 和 tray 证据。

Dependencies：1.3、1.5、1.7–1.9。

Files：docs/evidence/desktop-feasibility.md、tools/desktop_feasibility_report.py、tests/test_desktop_feasibility_report.py、.github/workflows/desktop-feasibility.yml。

Estimated scope：M，4 files。

Acceptance：

- macOS 全部 Go；Windows 至少 build/sidecars/IPC/callback/SQLite credential reopen/tray smoke。
- Linux 记录 rich popover 或 A10 fallback。
- 任一 No-Go 包含证据和需重新批准的替代方案。

Verification：report test；CI matrix artifacts；evidence review；Diff。

Commit：docs: record Podium Desktop feasibility results。

### Checkpoint 1：可行性 Go

- SQLite transaction/credential persistence、private IPC、fixed OAuth、process chain 和 popover 均有执行证据。
- 任一 No-Go 阻塞 Phase 2。

## 7. Phase 2：Podium 本地持久化与生命周期

### Task 2.1：建立 podium.db migration runner

Description：建立正式连接配置、schema_migrations 和逐版本事务 migration。

Dependencies：Checkpoint 1。

Files：packages/podium/src/podium/store/sqlite.py、migrations.py、schema.py、tests/test_podium_sqlite_migrations.py。

Estimated scope：M，4 files。

Acceptance：

- fresh、upgrade、reopen 幂等，migration failure 不部分提交。
- WAL、foreign_keys、busy_timeout 每次连接生效。
- schema 不含 SaaS、PostgreSQL、runtime secret 或 crypto 字段；仅 `linear_installations` 可包含批准的 plaintext access/refresh token fields。
- 数据库无法打开或写入时不创建第二 durable store；Tauri observed state、UI 和 operator log 显示稳定错误且 readiness fail closed。

Verification：Python focused test_podium_sqlite_migrations；schema forbidden scan；Diff。

Commit：feat: add Podium SQLite migrations。

### Task 2.2：建立 Linear installation metadata repositories

Description：持久化 installation metadata 和 discovered project catalog；普通 record 明确排除 schema 中的 token fields。早期 selection 字段由 Task 3.9 按 ADR-0010 移除。

Dependencies：2.1。

Files：store/linear.py、store/records.py、linear_models.py、tests/test_podium_sqlite_linear.py。

Estimated scope：M，4 files。

Acceptance：

- organization/app user/exact scopes/expiry、connection status、last verified time 和 sanitized error code 可原子保存和读取。
- `credentials_missing_for_existing_installation` 与 `reauthorization_required` 是独立状态；boolean `installed=true` 不得代表 Connected。
- project catalog 有 stable project identity 和 Create Conductor bound protection 所需字段；standalone selected state 不是最终产品 contract。
- 普通 installation/project record、snapshot 和序列化 model 不返回 token；schema 只有批准的 installation token fields，且无 credential reference、ciphertext、secret hash 或 key。

Verification：Python focused test_podium_sqlite_linear；schema/model forbidden scan；Diff。

Commit：feat: persist Linear installation metadata safely。

### Task 2.3：建立 binding 和 runtime report repositories

Description：持久化 project-to-Conductor desired binding、generation 和有界 reports。

Dependencies：2.1。

Files：store/bindings.py、store/runtime_reports.py、conductor_bindings.py、tests/test_podium_sqlite_bindings.py。

Estimated scope：M，4 files。

Acceptance：

- project 与 active Conductor binding 双向唯一。
- generation 单调递增，stale report 不覆盖当前状态。
- report 只有 bounded safe fields，不复制 workflow truth。

Verification：Python focused test_podium_sqlite_bindings；conflict/stale/size tests；Diff。

Commit：feat: persist local Conductor bindings。

### Checkpoint 2A：Podium metadata persistence

- Migration、Linear metadata、bindings/reports repositories 通过。

### Task 2.4：建立 polling 和 dispatch repositories

Description：建立 checkpoint、delegation epoch、dispatch、lease 和 background failure 存储原语。

Dependencies：2.1。

Files：store/polling.py、store/dispatch.py、store/failures.py、tests/test_podium_sqlite_dispatch.py。

Estimated scope：M，4 files。

Acceptance：

- issue/epoch 唯一，checkpoint/dispatch 支持同事务提交。
- lease/ACK/reclaim 使用 generation/fencing 并幂等。
- failure 保存 retry count、last reason、next action/time。

Verification：Python focused test_podium_sqlite_dispatch；concurrency/reopen tests；Diff。

Commit：feat: persist polling and dispatch state in SQLite。

### Task 2.5：建立 Podium local lifecycle

Description：将 feasibility sidecar 收敛为正式 startup/readiness/degraded/shutdown lifecycle。

Dependencies：2.2–2.4。

Files：packages/podium/src/podium/desktop_app.py、desktop_cli.py、desktop_health.py、tests/test_podium_desktop_lifecycle.py。

Estimated scope：M，4 files。

Acceptance：

- startup 顺序为 paths、SQLite、installation state、background jobs、ready。
- background exception 在 SQLite 可写时进入 durable failure 和 structured log；SQLite 不可用时进入 Tauri observed failure、UI 和 operator log。
- shutdown 停止新工作并关闭 jobs/SQLite，不吞异常。

Verification：Python focused test_podium_desktop_lifecycle；startup/crash/shutdown tests；Diff。

Commit：feat: add the local Podium lifecycle。

### Checkpoint 2B：Podium state lifecycle

- Polling/dispatch repositories 和 local lifecycle 通过。

### Task 2.6：建立 Desktop command dispatcher

Description：定义 React 经 Tauri 调用 Podium 的有限 command surface。

Dependencies：2.5。

Files：packages/podium/src/podium/desktop_commands.py、desktop_protocol.py、desktop/src-tauri/src/commands.rs、web/src/api/desktopClient.ts、focused tests。

Estimated scope：M，5 files。

Acceptance：

- command input/output 严格 schema，统一 sanitized error。
- 不支持 shell passthrough、arbitrary URL/file/SQL 或 token response。
- React 不直接 fetch localhost 或打开 SQLite。

Verification：Python command tests；cargo command tests；exact client payload tests；Diff。

Commit：feat: expose bounded Podium Desktop commands。

### Task 2.7：建立 process desired/observed reconcile

Description：分离 Podium 的 durable desired binding 与 Rust 的 observed process state。

Dependencies：2.3、2.6。

Files：desktop/src-tauri/src/supervisor.rs、process_state.rs、shutdown.rs、packages/podium/src/podium/conductor_bindings.py、focused tests。

Estimated scope：M，5 files。

Acceptance：

- desired binding 携带 generation/fencing，Rust 回报 observed process state 与 applied generation。
- crash loop 有界并进入 needs_attention，不无限重启。
- 在正式 Conductor drain command 接入前，Quit 的进程等待/终止策略有界且失败可见，不伪装成 clean shutdown。
- single instance 和无 active turn 的 Quit 不留下 Podium/Conductor/Performer orphan。

Verification：cargo supervisor tests；Python binding tests；two-launch/crash/idle-quit smoke；failure visibility/orphan audit；Diff。

Commit：feat: reconcile local runtime processes。

### Task 2.8：建立聚合 snapshot

Description：从 podium.db 与有界 Conductor reports 生成完整窗口/popover 共用 read model。

Dependencies：2.3、2.5、2.7。

Files：packages/podium/src/podium/desktop_snapshot.py、desktop_failures.py、desktop_events.py、tests/test_podium_desktop_snapshot.py。

Estimated scope：M，4 files。

Acceptance：

- Linear、Podium、Conductor、Performer、run、wait、failure 使用 discriminated state。
- stale/unknown 不显示 healthy，列表有上限/cursor。
- SQLite、snapshot、log 使用相同 error code/correlation。

Verification：Python focused test_podium_desktop_snapshot；golden/stale/redaction/size tests；Diff。

Commit：feat: aggregate secret-free Desktop snapshots。

### Checkpoint 2：本地 Podium 基础稳定

- podium.db、lifecycle、commands、supervisor 和 snapshot 通过完整 focused suite。
- Conductor/workflow.db ownership 尚未改变。

## 8. Phase 3：固定 Linear Application 与授权

### Task 3.1：固化固定 Application manifest

Description：将唯一测试 Application 的公开配置做成不可覆盖的 package resource。

Dependencies：Checkpoint 2。

Files：packages/podium/src/podium/linear_manifest.py、resources/linear-application.json、packages/podium/pyproject.toml、tests/test_linear_manifest.py、docs/product/podium-desktop.md。

Estimated scope：M，5 files。

Acceptance：

- public client id 只从必需的 `LINEAR_CLIENT_ID` 进程环境读取，缺失/空值 fail closed；fixed loopback callback、exact `read,write,app:assignable` scopes 和 `actor=app` 由 manifest 代码固定；不包含 revision、webhook 或 mention runtime configuration。
- UI、SQLite 不能覆盖 client id；env 不能覆盖 callback/scopes/actor；unknown、client_secret、custom application、revision 和 mutation fields 被拒绝。
- Installed package 和 Desktop bundle 都包含同一 exact non-client-id manifest resource，且只有批准的公开字段；client-id env 缺失、资源缺失或字段/值不符时 fail closed，不建立 revision mismatch/migration branch。

Verification：Python focused test_linear_manifest；wheel/installed package/Desktop bundle resource inspection；client-secret/custom-app/manifest-revision/mutation forbidden search；Diff。

Commit：feat: fix the Linear application manifest。

### Task 3.2：实现 PKCE attempt state machine

Description：在 Podium 内管理短生命周期 OAuth attempt，不启动 callback listener。

Dependencies：3.1。

Files：packages/podium/src/podium/oauth_state.py、linear_oauth.py、tests/test_linear_oauth_state.py。

Estimated scope：M，3 files。

Acceptance：

- 生成高熵 state、verifier、S256 challenge、attempt id 和 TTL。
- Attempt single-use，expired/cancelled/consumed 不能交换 code。
- state/verifier/code 不持久化、不进入日志或 snapshot。

Verification：Python focused test_linear_oauth_state；replay/expiry/concurrency/sentinel tests；Diff。

Commit：feat: manage transient Linear PKCE attempts。

### Checkpoint 3A：固定 App 与 PKCE state

- Manifest 不可覆盖，PKCE attempt transient/single-use。

### Task 3.3：实现 loopback callback listener

Description：实现只处理固定 OAuth response 的短生命周期 listener 和安全完成页。

Dependencies：3.2。

Files：packages/podium/src/podium/oauth_callback.py、oauth_callback_page.py、tests/test_oauth_callback.py、desktop/src-tauri/src/oauth.rs。

Estimated scope：M，4 files。

Acceptance：

- 仅固定 loopback host/port/path，success/denied/invalid/timeout 后关闭。
- 校验 Host/path/state/attempt/TTL/single-use。
- Response 含 no-store、严格 CSP、nosniff、no-referrer且无外部资源。
- **Manage** 页面或 browser-open 不是成功信号；没有 exact callback 时 bounded timeout 并保持非 Connected。

Verification：Python focused test_oauth_callback；cargo check；callback header/content/port-conflict tests；Diff。

Commit：feat: handle the local Linear OAuth callback。

### Task 3.4：实现 SQLite Linear credential repository

Description：在现有 `store/linear.py` 中增加最小的 load/replace/clear credential operations，不建立单独平台 adapter。

Dependencies：2.2、3.3。

Files：packages/podium/src/podium/store/linear.py、tests/test_linear_credentials_sqlite.py。

Estimated scope：M，2 files。

Acceptance：

- load、atomic replace 和 atomic clear 使用参数化 SQL 且只操作当前 installation row；replace/clear failure 不部分提交。
- Podium 是唯一调用方；普通 metadata reads、API、Tauri/Rust、React、Conductor 和 Performer 不接收 token。
- SQLite unavailable/locked/corrupt 时使用现有 store error surface fail closed，不新增 credential-specific error hierarchy 或 fallback store。
- 无新 dependency、OS credential/Keychain API、encrypt/decrypt/key/ciphertext、memory-only mode、side file、credential reference 或 dual read/write。

Verification：Python focused test_linear_credentials_sqlite；transaction/failure/reopen tests；metadata/API/Tauri/Conductor token sentinel；Keychain/crypto/second-store forbidden scan；Diff。

Commit：feat: persist Linear credentials in Podium SQLite。

### Task 3.5：实现 OAuth exchange 与 refresh rotation

Description：完成 code exchange、single-flight refresh 和 refresh-token rotation。

Dependencies：3.3、3.4。

Files：packages/podium/src/podium/linear_tokens.py、linear_oauth.py、store/linear.py、tests/test_linear_token_lifecycle.py。

Estimated scope：M，4 files。

Acceptance：

- Startup 先读取 podium.db installation credential；可用 access token 经 `viewer` 验证，正常 restart/update 不打开 browser。
- Exchange/refresh 不使用 client secret，并验证 `viewer.app=true`、organization、app user 和 exact scopes。
- Refresh single-flight；new access/refresh pair 原子提交 SQLite 后才淘汰旧 pair，refresh 后再次验证 viewer identity。
- invalid grant/scope/identity drift 停止 polling 并形成 durable actionable failure。

Verification：Python focused test_linear_token_lifecycle；concurrency/rotation/failure tests；token sentinel；Diff。

Commit：feat: refresh Linear credentials safely。

### Task 3.6：实现授权恢复、Reset and reconnect 与 Disconnect

Description：提供完整窗口使用的 credential-aware recovery、explicit Reset and reconnect、revoke/disconnect command；不把 **Manage** 或 browser-open 当成 reauthorization success。

Dependencies：3.5、2.6。

Files：packages/podium/src/podium/linear_disconnect.py、desktop_commands_linear.py、store/linear.py、tests/test_linear_disconnect.py。

Estimated scope：M，4 files。

Acceptance：

- Healthy stored credential 走 refresh-first，不打开 authorization；invalid refresh 进入 `reauthorization_required`。
- Workspace app exists 但 local credential 缺失，或 Connect 只到 **Manage** 并 timeout，进入 `credentials_missing_for_existing_installation`，只提供 Open Linear app settings 与 explicit **Reset and reconnect**。
- Reset 必须经 admin 明确确认并等待 workspace app removal 后才开始 clean install；不得自动移除、无限 retry 或使用 secret/personal-token/client-credentials fallback。
- Disconnect/revoke 失败可见且仅提供 safe retry；当前可用 installation 在未经 explicit reset/disconnect 前不被浏览器尝试清除。
- Disconnect 成功在一个 transaction 中清空 token pair 并更新 installation state；失败保留原状态，不留下 half pair。
- Active binding 阻止不安全 disconnect，错误包含稳定 code/next action。

Verification：Python focused test_linear_disconnect；refresh-first/Manage-timeout/missing-credential/reset-confirmation/removal/reinstall/command contract tests；token/log sentinel；Diff。

Commit：feat: manage local Linear authorization lifecycle。

### Checkpoint 3B：授权闭环

- 固定 Application、PKCE、callback、SQLite credential persistence、refresh、Manage/missing-credential recovery、Reset and reconnect、disconnect focused suite 通过。
- 无 client secret、OS credential/Keychain、自研 crypto、memory-only、side file 或 dual store。

### Task 3.7：实现 allowlisted Linear gateway

Description：将 Podium 设为唯一 Linear Authorization header 注入边界。

Dependencies：3.5。

Files：packages/podium/src/podium/linear_gateway.py、linear_queries.py、linear_validation.py、tests/test_linear_gateway.py。

Estimated scope：M，4 files。

Acceptance：

- 只允许批准 operation 和 variables schema，不接受 arbitrary URL/header/query。
- 第三方 response 始终验证 shape、page bounds 和 errors。
- Timeout/auth failure 有稳定 sanitized error 和 correlation。

Verification：Python focused test_linear_gateway；malformed/timeout/GraphQL/scope tests；Authorization log scan；Diff。

Commit：feat: constrain the local Linear gateway。

### Task 3.8：实现 project discovery 全分页

Description：通过 gateway 发现全部可访问项目并写入 secret-free metadata store。

Dependencies：3.7、2.2。

Files：packages/podium/src/podium/linear_projects.py、linear_queries.py、store/linear.py、tests/test_linear_project_discovery.py。

Estimated scope：M，4 files。

Acceptance：

- 完整 cursor pagination，重复项目按 stable id 去重。
- Organization/app user/exact scope drift 拒绝写入并停止 readiness。
- Empty、partial-page failure 和 restart 均有确定状态。

Verification：Python focused test_linear_project_discovery；pagination/restart/drift tests；Diff。

Commit：feat: discover all accessible Linear projects。

### Task 3.9：实现 accessible project catalog command

Description：提供 Create Conductor 使用的只读 project catalog，并移除早期 standalone selected-project mutation/column。

Dependencies：3.8、2.6。

Files：packages/podium/src/podium/linear_projects.py、desktop_commands_linear.py、store/linear.py、tests/test_linear_project_catalog.py。

Estimated scope：M，4 files。

Acceptance：

- Catalog 完整返回 discovered accessible projects，并标记当前 active binding；bound project 不可再次用于 Create Conductor。
- Request/response 只包含 id/name/slug/bound 等安全字段，无 selected mutation、repository path 或 token。
- SQLite migration 移除早期 `selected` flag 和 selection APIs，保留 project metadata/bindings；refresh/restart 从 catalog + binding 恢复，不维护第二份 setup state。

Verification：Python focused test_linear_project_catalog；command exact payload/bound/reopen tests；standalone selection mutation forbidden scan；Diff。

Commit：feat: expose the Linear project catalog locally。

### Task 3.10：实现 atomic Create Conductor desired binding

Description：接收 Tauri native picker 内部提供的 project id + canonical repository，原子创建 Desktop auto-start 所需 desired binding；不启动进程、不创建 session。

Dependencies：3.9、2.3、2.6。

Files：packages/podium/src/podium/desktop_commands_conductors.py、desktop_commands.py、desktop_health.py、conductor_bindings.py、store/bindings.py、store/migrations.py、store/schema.py、tests/test_create_conductor.py。

Estimated scope：M，8 files。新增的 dispatcher/protocol allowlist/schema 路径仅是让已批准 private command 与 migration 可达的必要 wiring，不增加第二入口或产品行为。

Acceptance：

- Private Podium create command 只接受 Tauri bridge 内部提供的 project id + canonical existing repository；它不是 browser/HTTP API。Task 6.6 的 native wrapper 保证 React 只提交 project id，React/browser contract 无 repository path 字段。
- Podium transaction 验证 accessible/unbound project、repository/project/conductor uniqueness，并原子创建 stable conductor id、project id、canonical repository、generation=1、isolated data-root key、`desired=running`。
- Commit 后 observed state 为 pending；不存在 selected-only、repository-only、unbound enrollment 或 half binding。
- Invalid/cancelled picker 不调用 Podium；transaction failure 不写任何 binding；response/snapshot/log 无 arbitrary path echo、shell、token 或 secret。
- MVP 不实现 binding edit/revision/delete、安装脚本、enrollment token、ambient CLI 或 process start；auto-start 属于 Task 4.6。

Verification：Python create command/transaction/rollback/uniqueness/reopen tests；public browser/HTTP/path echo/install-script forbidden scan；Diff。

Commit：feat: create desired Conductor bindings atomically。

### Checkpoint 3C：Linear 项目闭环

- 真实 OAuth 后能发现并恢复 accessible project catalog；Create Conductor 可原子创建 project + repository desired binding，无 standalone selection 或安装脚本。
- Podium 仍是唯一 token owner，UI/Conductor 无 token。

## 9. Phase 4：Podium 与 Conductor 私有运行边界

### Task 4.1：扩展正式 local runtime contracts

Description：将 feasibility envelope 扩展为 configure、drain、dispatch、ACK、report 和 gateway closed DTO。

Dependencies：Checkpoint 3C、Task 1.4。

Files：packages/performer-api/src/performer_api/local_runtime.py、validation.py、__init__.py、tests/test_local_runtime_contract.py。

Estimated scope：M，4 files。

Acceptance：

- DTO 带 conductor/project/binding generation、lease/fencing、correlation 和 payload limits；drain request/ACK 有稳定状态、deadline 和 failure fields；可选 `performer_event` envelope 只有 exact context、source、event fields。
- Unknown kind/field/version、oversize 和 invalid transition fail closed。
- 无 token/header/arbitrary URL/database/arbitrary provider field；`performer_event.source.performer_kind` 仅接受 closed singleton `codex` provenance，不形成 selector。

Verification：Python focused test_local_runtime_contract；wire-safety/package-boundary tests；Diff。

Commit：feat: complete local Podium Conductor contracts。

### Task 4.2：实现 Podium IPC session registry

Description：在 Podium 中登记 Desktop 已建立的 inherited channels 和 expected process identity。

Dependencies：4.1、2.3。

Files：packages/podium/src/podium/local_sessions.py、local_runtime_server.py、desktop_app.py、tests/test_podium_local_sessions.py。

Estimated scope：M，4 files。

Acceptance：

- Session 绑定 conductor/project/generation/expected PID/instance。
- Duplicate、wrong peer、stale generation、closed session 不可恢复使用。
- Session state 不持久化 secret，process exit 立即标记 offline。

Verification：Python focused test_podium_local_sessions；peer/replay/exit tests；listener absence；Diff。

Commit：feat: register private Conductor sessions。

### Task 4.3：实现 Podium configure/command dispatcher

Description：通过已创建 desired binding 的匹配 session 下发 project/repository/profile generation command。

Dependencies：4.2、2.3。

Files：packages/podium/src/podium/local_runtime_commands.py、conductor_bindings.py、store/bindings.py、tests/test_local_runtime_commands.py。

Estimated scope：M，4 files。

Acceptance：

- Command 只能发给 matching active binding/session。
- Generation 单调且 duplicate ACK 幂等；stale ACK 不改变当前 binding。
- Repository path 输入在 Podium command boundary 规范化并限制为批准 binding。
- Quit drain command 先停止该 binding 的新 dispatch/turn，再请求 active Conductor 到 workflow.db 安全点；command 有界且带稳定 failure/next action。

Verification：Python focused test_local_runtime_commands；matching/conflict/stale/config-path tests；Diff。

Commit：feat: configure Conductors over private IPC。

### Checkpoint 4A：Podium IPC server

- Contract、session registry 和 configure/command dispatcher 通过。

### Task 4.4：实现 Conductor IPC transport client

Description：替换 active HTTP bearer transport，但暂不删除旧实现文件。

Dependencies：4.1–4.3。

Files：packages/conductor/src/conductor/podium_ipc.py、models.py、conductor_service.py、tests/test_conductor_podium_ipc.py。

Estimated scope：M，4 files。

Acceptance：

- Conductor 从 inherited handle 连接，验证 version/instance/project/generation。
- Configure/report/lease/ACK 使用 performer-api DTO，不 import Podium。
- Conductor 接受 matching session/generation 的 drain command，停止新 turn 并在 active result 写入 workflow.db 后 ACK；stale/duplicate drain fail closed 或幂等。
- Runtime/proxy token 不再是新 active path 的配置输入。

Verification：Python focused test_conductor_podium_ipc；package boundary；token/env forbidden active-path test；Diff。

Commit：feat: connect Conductor through private IPC。

### Task 4.5：切换 active sync 到 private IPC

Description：让 Conductor tick 使用 IPC command/report/dispatch 顺序，保留旧代码仅作迁移对照。

Dependencies：4.4。

Files：packages/conductor/src/conductor/conductor_podium_sync.py、conductor_service.py、podium_ipc.py、tests/test_conductor_private_sync.py。

Estimated scope：M，4 files。

Acceptance：

- Tick 顺序为 configure/command -> report -> lease -> ACK，可在任一步重启恢复。
- HTTP URL/bearer 不在 active branch。
- Failure 写 Conductor log/state，并通过下一 report 进入 Podium snapshot。
- Desktop Quit 按规格 7.3 停止新 polling/dispatch/turn、等待每个 active Conductor drain 后再关闭 IPC/SQLite；timeout/result-persistence failure 有界可见且不冒充 clean shutdown。

Verification：Python focused test_conductor_private_sync；restart/failure/order/active-turn drain tests；active-path source search；orphan/failure visibility audit；Diff。

Commit：refactor: switch Conductor sync to private IPC。

### Checkpoint 4B：基本 IPC 闭环

- 一个 Podium 与一个 Conductor 完成 configure/report/lease/ACK。
- 无 shared secret、public runtime listener 或跨包 import。

### Task 4.6：实现 Desktop 多 Conductor auto-start reconciliation

Description：Create Conductor 提交后立即、并在每次 Desktop 启动时，根据 active desired bindings 自动启动或重新连接多个独立 data root/IPC/log 的 bundled Conductor。

Dependencies：2.7、3.10、4.5。

Files：desktop/src-tauri/src/conductors.rs、supervisor.rs、process_state.rs、desktop/src-tauri/tests/multi_conductor.rs。

Estimated scope：M，4 files。

Acceptance：

- Create Conductor commit 后无需安装脚本或额外 Start 操作即可启动；Desktop restart 自动恢复全部 active desired bindings。
- 每个 project 独立 identity、data root、channel、PID 和 log，二进制只从 bundle manifest/approved app paths 解析。
- Duplicate project/conductor binding fail closed。
- Start failure 保留 desired binding 并形成可见 failed observed state；下次 Desktop start 自动 reconcile。
- 一个实例进程退出后的 reconcile 不影响其他实例，Desktop 退出无 orphan；不新增 customer start/stop/restart command，不调用 checkout、安装脚本、ambient PATH/PYTHONPATH 或 ambient `conductor`。

Verification：cargo multi_conductor tests；create-immediate-start/reopen-auto-start/two-Conductor packaged smoke；bundle/path/channel/process/install-script forbidden audit；Diff。

Commit：feat: supervise isolated local Conductors。

### Task 4.7：实现 scoped Linear gateway contract

Description：允许 Conductor 请求批准的 Linear projection/read operation，但不接收 Linear token。

Dependencies：3.7、4.5。

Files：packages/performer-api/src/performer_api/local_runtime.py、packages/podium/src/podium/local_linear_gateway.py、packages/conductor/src/conductor/linear.py、tests/test_conductor_linear_gateway.py。

Estimated scope：M，4 files。

Acceptance：

- Request 必须匹配 active binding/project/operation allowlist。
- Podium 内部注入 Authorization；Conductor response 不含 token/header。
- Auth expiry/timeout/scope violation 进入 actionable Managed Run/operator state。

Verification：Python focused test_conductor_linear_gateway；scope/auth/redaction tests；Diff。

Commit：feat: proxy scoped Linear operations locally。

### Task 4.8：实现 bounded runtime reports

Description：将 Conductor、Performer、Managed Run 和 runtime-wait 状态投影到 Podium read model。

Dependencies：4.5、2.8。

Files：packages/conductor/src/conductor/podium_report.py、performer_control.py、packages/podium/src/podium/runtime_reports.py、tests/test_local_runtime_reports.py。

Estimated scope：M，4 files。

Acceptance：

- Report 有 bounds、binding provenance、last heartbeat 和 stable failure codes。
- Performer readiness/login/turn/wait、Managed Run summary 与可选 latest closed `performer_event` 可见；event 带 exact turn context/fencing 和 `performer_kind=codex`。
- Raw profile、token、local auth path、unbounded logs/raw provider fields 不进入 report；latest event 只进入 ephemeral read model，不写 runtime_reports/app_events history。

Verification：Python focused test_local_runtime_reports；stale/redaction/size/provenance tests；Diff。

Commit：feat: report local runtime health safely。

### Checkpoint 4C：多 Runtime 边界稳定

- 多 Conductor、scoped Linear gateway 和 reports 通过 integration。
- Podium/Conductor 边界和双 durable ownership 未漂移。

## 10. Phase 5：Polling、Dispatch 与 Managed Run 回归

### Task 5.1：迁移 baseline polling 到 SQLite

Description：在 active desired binding projects 上完成全分页 baseline scan，并原子提交 observations/checkpoint。

Dependencies：Checkpoint 3C、Checkpoint 4B。

Files：packages/podium/src/podium/linear_polling.py、linear_queries.py、store/polling.py、tests/test_podium_baseline_polling.py。

Estimated scope：M，4 files。

Acceptance：

- 每个 active bound project 完整 cursor pagination，checkpoint 仅在完整 scan 成功后推进。
- Delegated/non-delegated observation 保留 organization、project、installation app user 和 observed revision；eligible intake 只接受 delegate id 匹配当前 `app_user_id` 的 root issue，并排除 Symphony projection children。
- 中途 page failure 不推进 checkpoint，并形成 durable failure。

Verification：Python focused test_podium_baseline_polling；pagination/page-failure/reopen tests；Diff。

Commit：feat: poll Linear projects from SQLite state。

### Task 5.2：实现 incremental checkpoint polling

Description：基于 baseline checkpoint 处理增量变化、restart 和 checkpoint continuity。

Dependencies：5.1。

Files：packages/podium/src/podium/linear_polling.py、linear_reconciliation.py、store/polling.py、tests/test_podium_incremental_polling.py。

Estimated scope：M，4 files。

Acceptance：

- 增量页完整遍历，重复 observation 幂等。
- Podium restart 从 committed checkpoint 继续，不跳过窗口。
- Authorization unhealthy 时停止 scan，并保留 last checkpoint 和 actionable state。

Verification：Python focused test_podium_incremental_polling；restart/dedup/auth-failure tests；Diff。

Commit：feat: resume incremental Linear polling safely。

### Checkpoint 5A：Polling continuity

- Baseline/incremental pagination、checkpoint 和 restart continuity 通过。

### Task 5.3：实现 delegation epoch 状态机

Description：将委派、取消委派、重新委派映射为持久 delegation epoch。

Dependencies：5.1、2.4。

Files：packages/podium/src/podium/delegation.py、store/polling.py、store/dispatch.py、tests/test_delegation_epochs.py。

Estimated scope：M，4 files。

Acceptance：

- 同一 issue active epoch 唯一，重复观察不创建新 epoch。
- 取消委派关闭 epoch；重新委派创建新 epoch。
- Organization/project/app user mismatch、projection child、label-only 或 human-assignee-only match 不打开 epoch。

Verification：Python focused test_delegation_epochs；duplicate/cancel/redelegate/mismatch tests；Diff。

Commit：feat: persist Linear delegation epochs。

### Task 5.4：实现 blocker reconciliation

Description：完整分页读取 blockers，并在 blocker 完成后重新评估 blocked dispatch。

Dependencies：5.2、5.3。

Files：packages/podium/src/podium/linear_reconciliation.py、linear_queries.py、store/dispatch.py、tests/test_dispatch_blockers.py。

Estimated scope：M，4 files。

Acceptance：

- 只有 active related blockers 阻止 dispatch。
- Later-page blocker 在 lease 前可撤回 eligibility。
- Blocker clearing 后 dispatch 重新 eligible，不需新 epoch。

Verification：Python focused test_dispatch_blockers；pagination/clear/race tests；Diff。

Commit：feat: reconcile Linear dispatch blockers。

### Checkpoint 5B：Observation 到 eligible dispatch

- Baseline/incremental、epochs 和 blockers 在 SQLite 下通过。
- Restart/dedup 证据完整。

### Task 5.5：实现 exactly-once dispatch enqueue

Description：在 observation/epoch/checkpoint transaction 中为 eligible epoch 插入唯一 dispatch。

Dependencies：Checkpoint 5B。

Files：packages/podium/src/podium/dispatch.py、store/dispatch.py、linear_polling.py、tests/test_dispatch_enqueue.py。

Estimated scope：M，4 files。

Acceptance：

- 同一 issue/epoch 最多一条 dispatch，concurrent/repeated observation 不重复。
- 只有 accessible project + active ready desired binding 可入队。
- Transaction failure 不留下 dispatch/checkpoint 半状态。

Verification：Python focused test_dispatch_enqueue；concurrency/rollback/binding tests；Diff。

Commit：feat: enqueue one dispatch per delegation epoch。

### Task 5.6：实现 private IPC lease 和 ACK

Description：将 eligible dispatch lease 给唯一 matching Conductor session，并应用 ACK。

Dependencies：5.5、4.5。

Files：packages/podium/src/podium/local_runtime_dispatch.py、store/dispatch.py、packages/conductor/src/conductor/podium_ipc.py、tests/test_private_dispatch_lease.py。

Estimated scope：M，4 files。

Acceptance：

- Lease 匹配 project/binding generation/conductor identity，带 lease id/fencing token。
- Duplicate ACK 幂等；stale/mismatched ACK 拒绝且不改变当前状态。
- Lease 前最新 blocker 或 binding drift 可撤回 lease。

Verification：Python focused test_private_dispatch_lease；identity/stale/duplicate/race tests；Diff。

Commit：feat: lease dispatches over private IPC。

### Task 5.7：实现 lease expiry 和 reclaim

Description：让 Podium restart 或 Conductor crash 后可以有界回收 expired lease。

Dependencies：5.6。

Files：packages/podium/src/podium/dispatch_recovery.py、store/dispatch.py、desktop_health.py、tests/test_dispatch_recovery.py。

Estimated scope：M，4 files。

Acceptance：

- Fresh heartbeat 不回收；expired lease 仅回到 eligible matching state。
- Old fencing result/ACK 在 reclaim 后拒绝。
- Repeated reaper 幂等，并记录 reclaim reason/attempt。

Verification：Python focused test_dispatch_recovery；heartbeat/restart/stale/repeat tests；Diff。

Commit：feat: reclaim expired local dispatch leases。

### Task 5.8：接入 Conductor Managed Run commit/resume

Description：把 private dispatch 交给现有 workflow.db commit/resume 路径，不重写 workflow engine。

Dependencies：5.6。

Files：packages/conductor/src/conductor/conductor_service.py、workflow_driver.py、podium_ipc.py、tests/test_private_dispatch_workflow.py。

Estimated scope：M，4 files。

Acceptance：

- 一个 delegated parent/epoch 对应一个 Managed Run。
- Duplicate/reclaimed delivery 恢复已有 run，不创建第二个 run。
- Podium payload 不直接修改 work-item/turn/gate state。

Verification：Python focused test_private_dispatch_workflow；duplicate/resume/fencing tests；Diff。

Commit：feat: resume Managed Runs from local dispatches。

### Checkpoint 5C：Dispatch 到 Managed Run

- Enqueue、lease、ACK、reclaim 和 workflow commit/resume integration 通过。
- podium.db 与 workflow.db ownership 清晰。

### Task 5.9：回归 ordered work items 和 verification

Description：证明 transport/store 变化未改变 plan、ordered tasks 和 verification command 行为。

Dependencies：Checkpoint 5C。

Files：tests/test_conductor_workflow.py、tests/test_workflow_driver.py、tests/test_conductor_gate.py。

Estimated scope：M，3 test files。

Acceptance：

- Plan creates bounded ordered tasks，同一时刻仅一个 task active。
- 每个 task 执行全部 verification commands 后才进入 Gate。
- Verification failure durable/visible，不误标 Done。

Verification：Python focused 上述 3 files；make test；Diff。

Commit：test: preserve ordered Managed Run verification。

### Task 5.10：回归 Gate rework 和 block

Description：证明 first Gate failure rework once、second failure block 语义不变。

Dependencies：5.9。

Files：tests/test_conductor_gate.py、tests/test_workflow_driver.py、tests/test_conductor_workflow.py。

Estimated scope：M，3 test files。

Acceptance：

- First fail 返回 executable rework，保留 attempt/evidence provenance。
- Second fail block task/parent，reason 同步 workflow/Linear/report/log。
- Gate 仍为 read-only Performer turn。

Verification：Python focused Gate/rework cases；make test；Diff。

Commit：test: preserve Gate rework and blocking semantics。

### Task 5.11：回归 recovery、stale fencing 和 runtime waits

Description：覆盖 Conductor/Performer crash、stale result、approval/tool wait 和 resume channel。

Dependencies：5.9。

Files：tests/test_conductor_recovery.py、tests/test_conductor_performer_control.py、tests/test_conductor_workflow.py、tests/test_conductor_policy_projection.py。

Estimated scope：M，4 test files。

Acceptance：

- Stale fencing/plan/policy result 不改变 current state。
- Runtime wait durable 并投影 Linear Human Action flow；stdout/comment 不自行 resume。
- Recovery 保留 latest sanitized reason、attempt 和 next action。

Verification：Python focused 上述 files；make test；Diff。

Commit：test: preserve recovery and runtime waits。

### Checkpoint 5D：Managed Run regression

- Managed Run、Gate、recovery、wait 和 provider boundary full suite 通过。
- 新 transport 未改变 workflow behavior。

### Task 5.12：实现 Codex semantic performer_event

Description：把 Codex SDK turn 的内部事件在 Performer 内映射为 closed semantic `PerformerTurnEvent`，并证明事件可在 final result 前交给调用方。

Dependencies：Checkpoint 5D、Task 1.8。

Files：packages/performer/src/performer/codex_client.py、backends/codex.py、tests/test_performer_sdk_client.py、tests/test_performer_backend_contract.py。

Estimated scope：M，4 files。

Acceptance：

- 真实 Codex integration 记录至少一个 pre-final callback；若 provider-derived callback 不可用，必须记录 live progress unavailable，并只保留已批准 lifecycle heartbeat，不伪造 provider progress。
- Raw names/instructions/reasoning/commands/tool data/paths/diffs/stdout/stderr/usage/provider ids/arbitrary metadata 只在 Performer 内处理；跨边界仅允许 `progress|warning|heartbeat` 和 allowlisted semantic text。
- Sequence 单调且 final `PerformerTurnResult` 保持唯一 business result；callback failure/drop 不改变 result eligibility。

Verification：Python focused test_performer_sdk_client 和 test_performer_backend_contract；一次 real Codex callback-timing evidence；raw-marker/allowlist/result-parity scan；Diff。

Commit：feat: emit closed Codex turn progress。

### Task 5.13：实现 bounded performer_event transport

Description：通过单 turn inherited local pipe 把 closed event 从 Performer 送到 Conductor，并通过既有 bounded report path 暴露 Podium latest safe status。

Dependencies：5.12、4.8、Task 1.8。

Files：packages/performer/src/performer/cli.py、packages/conductor/src/conductor/runtime.py、podium_report.py、packages/podium/src/podium/runtime_reports.py、tests/test_performer_event_transport.py。

Estimated scope：M，5 files。

Acceptance：

- Pipe 只随 one-shot turn 继承和关闭，frame 有 version/size/count bounds；无 listener、secret、event table、journal、broker、outbox 或 replay API。
- Conductor 校验 turn context、fencing、`performer_kind=codex`、binding generation、sequence 和 schema，只保留 latest value/counters；Podium 只保留 ephemeral latest view，不写 durable event history。
- Backpressure 可 coalesce/drop event 但不得阻塞 final result；event 不创建/重排 task，不批准 plan，不 resolve wait，不通过 Gate，不 retry/complete run，也不写 Linear。

Verification：Python focused test_performer_event_transport、test_conductor_runtime 和 test_local_runtime_reports；real subprocess pre-final timing；stale/oversize/drop/fence/SQLite/Linear-write/raw-marker scans；Diff。

Commit：feat: stream bounded Performer status locally。

### Checkpoint 5E：Podium live status

- `performer_event` 从 Codex semantic callback 到 Podium latest view 的闭环通过，只有 closed `codex` provenance 和 allowlisted text。
- Event loss/restart/backpressure 不改变 final result 或 Managed Run truth；无 durable event history、Linear live write 或新 control path。

## 11. Phase 6：Desktop UI 纵向切片

### Task 6.1：建立 Desktop shell 与现有 design tokens

Description：把 SPA shell 适配 Desktop window，先保留空页面和现有视觉系统。

Dependencies：Checkpoint 2。

Files：packages/podium/web/src/App.tsx、layout/DesktopShell.tsx、lib/navigation.ts、styles/layout.css、App.test.tsx。

Estimated scope：M，5 files。

Acceptance：

- Navigation 只有 Overview、Linear、Runtimes、Performer、Managed Runs。
- Login/Register/Account 不在 Desktop route tree；Phase 8 前 legacy browser route tree 仍作为独立迁移对照保留，不得在本 Task 提前删除。
- Desktop/browser selection 是显式、可测试的 build/runtime boundary；两者复用同一 React entrypoint，但 Desktop 不发旧 HTTP auth/session 请求，legacy browser path 不调用 Desktop commands。
- DESIGN.md/tokens 值不变，无 hardcoded hex/font/radius。

Verification：Podium Web；Desktop/legacy exact route and transport isolation tests；routing/keyboard tests；visual baseline；Diff。

Commit：feat: adapt the Podium shell for Desktop。

### Task 6.2：实现 Overview snapshot slice

Description：用 snapshot command 展示 Linear、Podium、Conductor、Performer 和 active run 组合健康。

Dependencies：6.1、2.8。

Files：web/src/pages/OverviewPage.tsx、api/desktopClient.ts、api/hooks.ts、pages/OverviewPage.test.tsx。

Estimated scope：M，4 files。

Acceptance：

- Loading、ready、empty、stale、needs_attention、failed 状态完整。
- Unknown 不显示 healthy；只有一个 contextually valid primary action。
- UI 无 direct localhost fetch 和 secret fields。

Verification：Podium Web；exact command/state tests；Diff。

Commit：feat: show local Symphony health overview。

### Task 6.3：实现本地 Setup route selection

Description：根据 snapshot readiness 进入 Connect、Create Conductor、Performer 或 Ready step。

Dependencies：6.2。

Files：web/src/pages/SetupPage.tsx、pages/setup/types.ts、lib/onboarding.ts、pages/SetupPage.test.tsx。

Estimated scope：M，4 files。

Acceptance：

- 首次启动不显示 Login/Register，直接进入第一个真实未完成步骤。
- Refresh/restart 从 snapshot 恢复，不维护第二份 durable setup state。
- 无 custom App 或 enrollment-token step。

Verification：Podium Web；step-routing/reload/error tests；Diff。

Commit：feat: route local Podium setup from readiness。

### Checkpoint 6A：Desktop shell 与 Setup routing

- Shell、Overview snapshot 和 Setup route selection 通过。

### Task 6.4：实现 Linear authorization UI slice

Description：连接固定 Application，并展示 organization/app user/exact scopes/credential health 和 polling health。

Dependencies：3.6、6.3。

Files：web/src/pages/LinearPage.tsx、components/LinearAuthorizationStatus.tsx、pages/setup/LinearConnectStep.tsx、tests。

Estimated scope：M，4 files。

Acceptance：

- Connect/Open Linear app settings/Reset and reconnect/Disconnect 只调用 Desktop commands；不提供假定 Manage 会授权的 Reauthorize shortcut。
- Success/denied/expired/degraded/revoke-failed/`credentials_missing_for_existing_installation` 有明确且与 Task 3.6 一致的 action。
- UI 不显示 client id/secret/callback/custom Application/token。

Verification：Podium Web；exact command/auth state/a11y/secret search；Diff。

Commit：feat: manage fixed Linear authorization in Desktop。

### Task 6.5：实现 Create Conductor project picker slice

Description：在 Create Conductor 表单中展示全部 accessible projects，并排除已绑定项目；不提供独立 project selection 页面或 Save selection。

Dependencies：3.9、6.4。

Files：web/src/components/ConductorProjectPicker.tsx、pages/RuntimesPage.tsx、pages/setup/CreateConductorStep.tsx、tests。

Estimated scope：M，4 files。

Acceptance：

- Single project choice、bound exclusion、empty/loading/error 状态完整。
- 选择本身不写 durable state；只有完整 Create Conductor command 才创建 binding。
- 不修改 Linear memberIds、standalone selected flag 或重复 OAuth。

Verification：Podium Web；catalog/bound/single-choice/no-selection-mutation tests；Diff。

Commit：feat: choose a project while creating a Conductor。

### Task 6.6：实现 Create Conductor 与 auto-start UI slice

Description：把 project choice 与 native repository picker 合成一个 Create Conductor action；提交 desired binding 后由 Desktop 自动启动，不显示安装脚本或额外 Start step。

Dependencies：3.10、4.6、6.5。

Files：web/src/pages/CreateConductorForm.tsx、pages/setup/CreateConductorStep.tsx、api/hooks.ts、tests、desktop/src-tauri/src/repository_picker.rs、desktop/src-tauri/capabilities/default.json、desktop/src-tauri/Cargo.toml。

Estimated scope：M，7 UI/native-picker files。

Acceptance：

- Project/repository/Conductor uniqueness conflict 可见。
- React 只提交 project id；受限 native Create Conductor command 打开 directory picker 并把 canonical path 内部交给 Podium，UI 不接收或回传自由文本 path，capability 只开放所需 picker/create command。
- 一个 native action 同时提交 project id 和 picker repository；不产生 selected-only、repository-only 或 unbound enrollment 半状态。
- Binding committed/starting/ready/failed generation ACK 状态清晰；创建后自动进入 starting，应用重启自动恢复，不要求客户执行安装脚本、CLI 或额外 Start。

Verification：Podium Web；cargo picker/capability tests；exact atomic payload/conflict/immediate-start/reload-auto-start tests；arbitrary path/shell/install-script forbidden scan；Diff。

Commit：feat: create and auto-start local Conductors。

### Checkpoint 6B：Setup 配置闭环

- Linear authorization 与 Create Conductor（project + repository + auto-start）可从零完成，无 standalone selection 或安装脚本步骤。

### Task 6.7：实现 Runtimes/Conductor UI slice

Description：展示多个 Conductor 的 project、repository、process、heartbeat、dispatch 和 error。

Dependencies：4.8、6.6。

Files：web/src/pages/RuntimesPage.tsx、components/ConductorList.tsx、components/ConductorDetails.tsx、tests。

Estimated scope：M，4 files。

Acceptance：

- 多 Conductor 可区分，online/offline/stale/crash-loop/needs_attention 状态完整。
- Runtimes 页面不新增手动 start/stop/restart mutation；首次 Start/Bind 仍只属于已批准的 Setup binding flow。
- 不显示 channel handle、token、raw log 或 secret path。

Verification：Podium Web；state matrix/two-runtime/keyboard tests；Diff。

Commit：feat: show local Conductor runtimes。

### Task 6.8：实现 Performer UI slice

Description：在 selected Conductor 下展示 backend readiness、provider login、profile、active turn 和 runtime wait。

Dependencies：4.8、6.7。

Files：web/src/components/PerformerDrawer.tsx、PerformerStatus.tsx、lib/performer.ts、tests。

Estimated scope：M，4 files。

Acceptance：

- 区分 Linear authorization 与 provider login/approval/tool wait。
- `performer_kind=codex` 只读 provenance；无 provider selector/fallback/reviewer。unavailable/unsupported/check-required/setup-failed/busy/ready 有稳定文案和 action。
- 不显示 provider token、raw profile、auth file path。

Verification：Podium Web；fixture/redaction/focus/keyboard tests；Diff。

Commit：feat: show Performer readiness and waits。

### Task 6.9：实现 Managed Runs UI slice

Description：展示 bounded run list、work items、Gate/rework/blocked、evidence summary 和 latest safe `performer_event`。

Dependencies：4.8、6.2、Checkpoint 5E。

Files：web/src/pages/ManagedRunsPage.tsx、components/ManagedRunDetails.tsx、lib/managedRuns.ts、tests。

Estimated scope：M，4 files。

Acceptance：

- Active/completed/blocked/stale/loading/empty/error 状态完整；active turn 可显示 latest allowlisted status、`codex` provenance、fresh/stale/unavailable。
- Provenance 与 Conductor report 一致，列表有 cursor/bound。
- Logs 不是唯一 truth，sanitized failure/next action 直接可见；UI 不显示 raw event/history，也不提供 event-derived workflow action。

Verification：Podium Web；fixture parity/pagination/error tests；Diff。

Commit：feat: inspect local Managed Runs。

### Checkpoint 6C：运行信息闭环

- Runtimes、Performer 和 Managed Runs 页面使用同一 snapshot/report contract。
- Setup、Linear、Projects、Runtimes、Performer、Managed Runs 可从零走到 Ready。
- UI test/lint/design-lint/build clean。

### Task 6.10：实现生产 macOS popover

Description：复用 snapshot 语义构建只读、bounded、needs-attention-first popover。

Dependencies：Checkpoint 6C、Task 1.9。

Files：web/src/popover/Popover.tsx、NeedsAttention.tsx、RuntimeSummary.tsx、popover.css、Popover.test.tsx。

Estimated scope：M，5 files。

Acceptance：

- 展示 global、Linear、Podium、Conductors、Performer、active run；详情进入 Open Podium。
- 只允许 Open/Quit，不直接 mutation。
- Esc/Tab/VoiceOver、sidecar-down 和 stale snapshot 可用。

Verification：Podium Web；native multi-display/keyboard/VoiceOver/screenshots；Diff。

Commit：feat: show local status in the macOS popover。

### Task 6.11：完成 Desktop UI quality gate

Description：集中验证 accessibility、尺寸、console/network 和 visual identity，不添加新界面行为。

Dependencies：6.10。

Files：web/src/test/accessibility.test.tsx、styles/app.css、styles/features.css、docs/evidence/desktop-ui-acceptance.md。

Estimated scope：M，4 files。

Acceptance：

- Critical paths 满足 WCAG 2.1 AA keyboard/name/role/value/focus。
- 360–400 popover、min window、1024、1440 无关键截断。
- 无 console error、unknown network、secret render 或 DESIGN token drift。

Verification：Podium Web；axe；native console/network；visual evidence；Diff。

Commit：test: verify Podium Desktop UI quality。

### Checkpoint 6E：UI 完成

- Full window 和 macOS popover 达到批准设计与 accessibility 标准。
- 未新增 review 建议型功能。

## 12. Phase 7：Real E2E 与恢复证据

Execution note：当前用户指令要求完成所有非真实测试任务；本 Phase 的真实 Linear/Codex/browser runs 保持 pending，不得以 mock、unit test 或静态 evidence 冒充完成。

### Task 7.1：建立 Desktop real-flow harness

Description：改写 runner 的启动/观察/归档层，暂不跑完整业务场景。

Dependencies：Checkpoints 5D、5E、6E。

Files：tools/real_flow.py、tools/desktop_fixture.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，4 files。

Acceptance：

- 一个 run_id 启动 Desktop、Podium、多个 Conductor 和 Performer。
- Runner 不启动 PostgreSQL/public Podium，且断言无旧 endpoint/env dependency。
- 归档排除 token fields 的 podium.db schema/state export、workflow reports、component logs、turn artifacts 和 UI evidence；不得归档含真实 credential 的 raw podium.db。

Verification：Python focused test_real_flow；harness diagnostic batch；artifact manifest audit；Diff。

Commit：test: run real flows through Podium Desktop。

### Task 7.2：完成真实 OAuth 和 project binding prerequisite

Description：在一个 real-flow run 中完成固定 Application OAuth、project discovery、Create Conductor（project + repository）、Desktop auto-start 和 Performer readiness。

Dependencies：7.1。

Files：tools/real_flow.py、tools/desktop_fixture.py、tools/linear_fixture.py、tests/test_real_flow.py。

Estimated scope：M，4 files。

Acceptance：

- OAuth 真实完成并记录 organization/app user/exact scopes/expiry/credential health，不记录 manifest/config revision，也不把 token/code/state 写入 evidence；restart/update 使用 podium.db stored credential/refresh-first，不重复打开 browser。
- Create Conductor 后无需安装脚本或额外 Start；binding/Conductor/Performer 均 ready 后才创建 business issue，并验证 Desktop restart 自动恢复该 Conductor。
- UI、podium.db metadata、process logs 和 Linear evidence 一致。

Verification：real-flow prerequisite run；credential/token artifact scan；binding evidence audit；Diff。

Commit：test: verify Desktop Linear and runtime prerequisites。

### Task 7.3：完成真实成功 Managed Run

Description：从真实 delegation 经 polling/dispatch 到 Performer Gate 和 Linear Done。

Dependencies：7.2。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- 同一 delegation epoch 恰好一个 dispatch/run。
- Parent/sub-issue、plan、turn、verification、Gate、manifest、Done 一致；Linear 无 `performer_event` write。
- 至少一个 allowlisted `codex` event 在 final result 前出现在 Podium；UI、podium.db、workflow.db report、Linear 和 logs 的 workflow truth 一致。

Verification：desktop real-flow all success scenario；explicit parent field audit；artifact manifest；Diff。

Commit：test: prove a successful Desktop Managed Run。

### Checkpoint 7A：Prerequisite 与成功流

- Desktop prerequisite 和真实成功 Managed Run evidence 完整。

### Task 7.4：完成 Gate rework/block 场景

Description：用 controlled real turns 证明 first failure rework 和 second failure block。

Dependencies：Checkpoint 7A。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- First Gate failure 回到 executable rework 并保留 provenance。
- Second failure block task/parent；reason 在 workflow/Linear/UI/log 一致。
- Scenario 不靠手工修改 durable state 伪造。

Verification：desktop real-flow gate scenario；state/evidence audit；Diff。

Commit：test: prove Desktop Gate rework and blocking。

### Task 7.5：完成 runtime wait 场景

Description：证明 provider approval/permission/tool-input wait 的 durable visibility 和正确 resume channel。

Dependencies：Checkpoint 7A。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- Wait 有 wait_kind/attempt/lease/sanitized message 和 Linear projection。
- UI/popover 显示 needs attention，不暴露 provider secret/path。
- Resume 只走 recorded runtime wait channel，diagnostic comment 不生效。

Verification：desktop real-flow wait scenario；Linear/UI/workflow/log audit；Diff。

Commit：test: prove Desktop runtime wait handling。

### Checkpoint 7B：核心业务 Real E2E

- Prerequisite、success、Gate 和 wait 四类场景有独立 evidence。

### Task 7.6：完成 Podium restart/dedup 场景

Description：在 active polling/dispatch 中重启 Podium，证明 SQLite checkpoint/epoch/lease 正确。

Dependencies：7.3。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- Checkpoint 不回退、不跳过；epoch/dispatch 不重复。
- Expired lease 可 reclaim；old ACK/fencing 拒绝。
- Restart failure 立即归档具体 reason，不等 global timeout。

Verification：desktop real-flow Podium restart scenario；podium.db diff/audit；Diff。

Commit：test: prove Podium restart and dispatch deduplication。

### Task 7.7：完成 Conductor restart/isolation 场景

Description：重启一个 active Conductor，证明 workflow recovery 且其他 Conductor 不受影响。

Dependencies：7.3。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- Target Conductor 恢复已有 run/turn，不创建 duplicate。
- 另一 Conductor 的 process/channel/project/run 不改变。
- Stale result/generation/fencing 拒绝并 operator-visible；ephemeral event 丢失或 stale 不改变 final result/run，恢复后只接受新 matching event。

Verification：desktop real-flow Conductor restart scenario；dual workflow/report audit；Diff。

Commit：test: prove isolated Conductor recovery。

### Checkpoint 7C：Restart 与隔离

- Podium/Conductor restart、dedup、reclaim 和多实例隔离 evidence 完整。

### Task 7.8：完成 OAuth refresh/failure 场景

Description：验证 refresh rotation、auth expiry 和 scope/identity drift 对 polling/dispatch 的影响。

Dependencies：7.2。

Files：tools/real_flow.py、tests/test_real_flow.py、docs/real-flow.md。

Estimated scope：M，3 files。

Acceptance：

- Refresh 在 podium.db 原子轮换 access/refresh pair、revalidate viewer 后继续 polling，且不泄漏 token；restart/update 后同一 credential 仍可用。
- invalid grant/scope/identity drift 停止新 polling/dispatch并显示 `reauthorization_required`；installed app + missing credential/Manage timeout 显示 `credentials_missing_for_existing_installation`，只有 explicit Reset/remove/reinstall 可恢复。
- Active turn 按 A12 完成到 workflow.db，恢复前不开下一 turn。

Verification：desktop real-flow auth scenarios；token sentinel；state/log/UI audit；Diff。

Commit：test: prove Linear refresh and failure handling。

### Task 7.9：完成 security/forbidden gate

Description：在旧源码尚未物理删除的 Replacement Ready 前，集中验证 **Desktop replacement active path** 无 Podium secret/crypto/PostgreSQL/public runtime transport，并完成依赖安全检查；repo/source/bundle 的零残留属于 Phase 8 hard-cut gate。

Dependencies：Checkpoint 7B、7.6–7.8。

Files：tests/test_desktop_security.py、tools/desktop_security_audit.py、tests/test_desktop_security_audit.py、docs/evidence/desktop-security.md。

Estimated scope：M，4 files。

Acceptance：

- Desktop 启动入口、实际加载模块、进程参数/env、运行时 schema 和可达 transport 中无 runtime/proxy/enrollment bearer、hash、encrypt/decrypt、key/ciphertext、OS credential adapter 或替代 local secret；replacement schema allowlist 仅允许 Podium installation 的 plaintext access/refresh fields。
- 尚待 Phase 8 删除且已证明不可达、未加载的 legacy source 必须进入明确 deletion inventory；本 Task 不以 source-wide 零命中冒充 Replacement Ready，也不提前删除旧路径。
- Wrong peer/handle 无法连接 IPC；callback negative fail closed；token 只存在于批准的 podium.db fields，code/state 零持久化，API/Tauri/Conductor/log/report/artifact/Linear 零泄漏；raw Codex data 不跨 Performer，SQLite 无 event history，Linear 无 live-event write。
- Dependency audit 无未处置 reachable critical/high。

Verification：security focused suite；Desktop entry/import/runtime/schema/env/listener scans；legacy deletion-inventory completeness；dependency audits；evidence review；Diff。

Commit：test: enforce Desktop security boundaries。

### Checkpoint 7D：Replacement Ready

- Core、restart、auth 和 security E2E 全部通过。
- Desktop replacement 是唯一 active path；legacy public/HTTP/PostgreSQL source 允许暂时保留的前提是不可达且每个文件已有 Phase 8 删除 owner。
- 此时才允许删除旧路径。

## 13. Phase 8：旧路径退役

### Task 8.1：删除 Login/Register route slice

Description：删除 Login/Register 页面和 route，不触碰 Account/session hook。

Dependencies：Checkpoint 7D。

Files：web/src/pages/LoginPage.tsx、RegisterPage.tsx、App.tsx、相关 route tests。

Estimated scope：M，4 files。

Acceptance：Desktop route tree 无 login/register；Linear/provider auth UI 保留；无 stale redirect。

Verification：Podium Web；route/source search；Diff。

Commit：refactor: remove login and registration routes。

### Task 8.2：删除 Account/session frontend slice

Description：删除 Account 页面、session hook、account chip 和相关 navigation。

Dependencies：8.1。

Files：web/src/pages/AccountPage.tsx、auth/useSession.ts、layout/DesktopShell.tsx、相关 tests。

Estimated scope：M，4 files。

Acceptance：UI 无 browser account/session dependency；Desktop shell 从 local snapshot 启动；无 stale i18n/nav。

Verification：Podium Web；session/account source search；Diff。

Commit：refactor: remove browser account state from the UI。

### Task 8.3：删除 custom Application UI

Description：删除 LinearApplicationSetup 和 default/custom selection presentation。

Dependencies：8.2、Task 3.1、Task 6.4。

Files：web/src/components/LinearApplicationSetup.tsx、IntegrationsPage.tsx、SetupPage.tsx、相关 tests。

Estimated scope：M，4 files。

Acceptance：UI 只有固定 Application Connect/Reauthorize；无 client id/secret/callback form；setup flow 不分支。

Verification：Podium Web；custom-app/client-secret UI search；Diff。

Commit：refactor: remove custom Linear application UI。

### Task 8.4：删除 legacy browser HTTP client

Description：在 Desktop command client 已通过 Replacement Ready 后，删除 legacy browser transport selection、cookie session request 和 `/api/v1` fetch client；不改 Desktop command contract。

Dependencies：8.3、Task 6.1、Checkpoint 6C。

Files：packages/podium/web/src/api/client.ts、api/hooks.ts browser-only exports、api/types.ts browser-only DTO、App.tsx legacy browser branch、相关 tests。

Estimated scope：M，5 files。

Acceptance：React active tree 只调用批准的 Desktop command client；无 `fetch('/api/v1')`、session cookie、public endpoint fallback 或 dual transport selector；Desktop UI 行为不变。

Verification：Podium Web；fetch/cookie/endpoint/transport-selector source search；desktop UI focused suite；Diff。

Commit：refactor: remove the legacy browser HTTP client。

### Checkpoint 8A：Desktop frontend hard cut

- Login/Register/Account/custom Application UI 和 legacy browser HTTP client 删除；Desktop command client 是唯一 frontend transport。

### Task 8.5：删除 Podium auth routes

Description：删除 register/login/logout/me/password route registration 和 handlers，同时从仍存活的 public app registration 中移除该 slice；暂不删除仍被其他 legacy routes 使用的 user/session store。

Dependencies：Checkpoint 8A。

Files：podium_routes_core_auth.py、app.py route registration、auth route tests、config auth flags。

Estimated scope：M，4 files。

Acceptance：Backend 无 browser auth endpoints；Desktop commands 不依赖 require_user；remaining legacy route tests 与 app import 仍通过。

Verification：Python focused auth/desktop tests；route/import search；make test；Diff。

Commit：refactor: remove Podium browser auth routes。

### Task 8.6：删除 custom Application backend

Description：删除 application config routes、state methods 和 store accessors。

Dependencies：8.5、Task 3.1。

Files：podium_routes_linear_application.py、podium_state.py application parts、store/_postgres_linear.py application accessors、相关 tests。

Estimated scope：M，4 files。

Acceptance：Backend 无 application CRUD/config selection；app registration 不再 import 该 route；固定 manifest 是唯一 source；OAuth suite 通过。

Verification：fixed OAuth focused suite；route/model search；make test；Diff。

Commit：refactor: remove custom Linear application backend。

### Checkpoint 8B：Account 与 Application HTTP 分支退役

- Browser auth route 和 custom/default Application backend 删除；固定 manifest 与 Desktop authorization 闭环保持。

### Task 8.7：删除 public Linear lifecycle routes

Description：删除旧 public OAuth callback/installations、project selection、disconnect/revoke 和 installation cutover HTTP routes；保留 Task 3.x 的 fixed-manifest loopback listener、commands 和 local domain services。

Dependencies：Checkpoint 8B、Checkpoint 3C、Task 3.6。

Files：podium_routes_linear_oauth.py、podium_routes_linear_projects.py、podium_routes_linear_disconnect.py、podium_routes_linear_cutover.py、app.py registrations、相关 route tests。

Estimated scope：M，6 logical files plus focused tests。

Acceptance：Podium 无 public Linear lifecycle endpoint 或 public callback；fixed loopback callback 和 Desktop commands 是唯一入口；app import、OAuth/project/disconnect focused suites 通过。

Verification：public Linear endpoint/registration search；fixed OAuth/project command suites；make test；Diff。

Commit：refactor: remove public Linear lifecycle routes。

### Task 8.8：删除 public onboarding/binding routes

Description：删除旧 browser onboarding/smoke、Conductor binding/replacement HTTP routes和 HTTP-only health response adapter；保留 local snapshot、Desktop binding command 与 domain health logic。

Dependencies：8.7、Checkpoint 6B、Checkpoint 4C。

Files：podium_routes_core_onboarding.py、podium_routes_conductor_bindings.py、app.py registrations、podium_health.py HTTP adapter、相关 route tests。

Estimated scope：M，5 logical files plus focused tests。

Acceptance：无 public onboarding/binding/smoke endpoint；Podium health domain logic 不依赖 FastAPI response；Desktop snapshot/binding/smoke 行为保持。

Verification：endpoint/FastAPI-adapter search；Desktop snapshot/binding/smoke focused suites；make test；Diff。

Commit：refactor: remove public onboarding and binding routes。

### Task 8.9：删除 enrollment/install transport

Description：删除 enrollment-token route、runtime enroll、runtime listing/status HTTP slice 和 install.sh generator；Desktop supervisor 与 snapshot 已是唯一创建/观察路径。

Dependencies：8.8、Task 4.6、Checkpoint 6C。

Files：podium_routes_runtime_enrollment.py、podium_install.py、app.py install/route registrations、web enrollment remnants、相关 enrollment tests。

Estimated scope：M，5 logical files plus focused tests。

Acceptance：无 enrollment token、runtime enroll/listing/status 或 install.sh path；Desktop supervisor 创建 Conductor；Runtimes UI 只读 Desktop snapshot，不请求 enrollment token。

Verification：endpoint/UI/install/source search；Desktop multi-Conductor/Runtimes tests；Podium Web；make test；Diff。

Commit：refactor: remove runtime enrollment transport。

### Checkpoint 8C：Public setup routes 退役

- Public Linear lifecycle、onboarding/binding、enrollment/install routes 删除；Desktop commands/snapshot/supervisor 闭环保持。

### Task 8.10：删除 public runtime operations routes

Description：删除 HTTP dispatch/command/report/log 和 Performer live-control routes；保留 private IPC dispatcher、bounded report 与 Desktop performer commands。

Dependencies：Checkpoint 8C、Checkpoint 5C、Task 4.8。

Files：podium_routes_runtime_ops.py、podium_routes_performer_control.py、app.py registrations、相关 route tests。

Estimated scope：M，4 logical files plus focused tests。

Acceptance：无 public lease/ACK/command/report/log/live-control endpoint；private IPC dispatch/report/Performer control suite 通过；app import 不保留 route reference。

Verification：endpoint/registration search；private IPC/dispatch/report/Performer focused suites；make test；Diff。

Commit：refactor: remove public runtime operation routes。

### Task 8.11：删除 public Linear proxy route

Description：删除 browser/runtime HTTP Linear GraphQL proxy；保留 allowlisted internal gateway 和 scoped private IPC contract。

Dependencies：8.10、Task 4.7。

Files：podium_routes_runtime_proxy.py、app.py registration、related proxy tests、remaining HTTP proxy client references。

Estimated scope：M，4 files。

Acceptance：无 public/arbitrary GraphQL proxy endpoint；Conductor scoped IPC gateway 和 Podium internal gateway 保留；UI/Conductor 不持有 URL/header/token fallback。

Verification：endpoint/client/header search；gateway focused suites；make test；Diff。

Commit：refactor: remove the public Linear proxy route。

### Checkpoint 8D：Public runtime routes 退役

- HTTP runtime operations、Performer live control 和 Linear proxy routes 删除；private IPC 是唯一 Podium/Conductor runtime transport。

### Task 8.12：删除 public Podium server mode

Description：在全部 public route registration 已删除后，删除 FastAPI public app/API CLI/Docker entry，保留 desktop sidecar CLI 和短生命周期 OAuth callback listener。

Dependencies：Checkpoint 8D、Task 3.3。

Files：packages/podium/src/podium/app.py、cli.py、packages/podium/Dockerfile、packages/podium/pyproject.toml、public-host tests。

Estimated scope：M，5 files。

Acceptance：无 public API/static server/container entry；project script 指向 desktop sidecar 唯一 Podium process entry；callback listener 仍短生命周期可测；uvicorn 等已无 owner 的 server dependency/import 同步删除，FastAPI 仅可暂留给尚待下一 Task 清理的 state type reference。

Verification：route/CLI/Docker/entrypoint search；desktop package；OAuth callback tests；make test；Diff。

Commit：refactor: remove the public Podium server mode。

### Task 8.13：删除 session/user store model

Description：在最后一个 require_user HTTP consumer 消失后，删除 user/session/password/Turnstile state model、cookie response helpers 和 PostgreSQL auth mixin。

Dependencies：8.12。

Files：store/_postgres_auth.py、store/_postgres_records.py auth rows、podium_state.py auth parts、packages/podium/pyproject.toml、相关 storage tests。

Estimated scope：M，5 files。

Acceptance：无 user/password/session/Turnstile/cookie runtime model；Linear installation metadata 保留；仅供 password hashing 的 argon2 及 FastAPI response type dependency/import 在无 owner 时删除。

Verification：Python focused storage tests；model/import/dependency search；make test；Diff。

Commit：refactor: remove Podium user and session models。

### Checkpoint 8E：Public Podium host 退役

- Public Podium app/API/CLI/container、browser session 和 route graph 删除；Desktop sidecar 与 fixed loopback callback 保留。

### Task 8.14：删除 Conductor HTTP sync 与 listener

Description：删除 `conductor_podium_sync` 的 URL/bearer/httpx branch、`ConductorApiServer` loopback listener、host/port CLI 和 instance `http_port` schema；保留 private IPC scheduler、workflow.db 与 installed Performer process boundary。

Dependencies：Checkpoint 8E、Task 4.5、Task 4.7。

Files：packages/conductor/src/conductor/conductor_podium_sync.py、conductor_api.py、conductor_cli.py、conductor_service.py、models.py、store.py、packages/conductor/pyproject.toml、相关 HTTP/sync tests。

Estimated scope：M，7 logical files plus focused tests；若 diff 超过本 Task file budget，只允许按 listener、sync consumer 做 scope-neutral split，不保留兼容 branch。

Acceptance：Conductor 不 bind localhost/LAN port，不含 PODIUM_URL/runtime token/proxy token HTTP branch、arbitrary GraphQL client 或 `http_port` durable field；private IPC 是唯一 Podium transport；workflow.db/Managed Run/Performer subprocess 保留；httpx 在无 owner 时删除。

Verification：listener/socket/env/URL/header/http_port/import/dependency search；private sync/full Conductor suite；package boundary；make test；Diff。

Commit：refactor: remove Conductor HTTP transport and listener。

### Task 8.15：删除 legacy Linear service mixins

Description：在 Task 3.x local services 已覆盖后，删除只服务旧 ManagedPodiumState/public lifecycle 的 installation version/cutover/project mixin 图；不删除 fixed manifest、SQLite credential repository、polling 或 allowlisted gateway。

Dependencies：8.14、Checkpoint 3C。

Files：podium_linear_installations.py、podium_linear_cutover.py、podium_linear_projects.py、对应 old lifecycle/project tests、obsolete app aggregate references。

Estimated scope：M，5 logical files plus focused tests。

Acceptance：无 legacy application-version/candidate/cutover/project-selection mixin 或 fallback；fixed MVP authorization/project services 是唯一实现；无 orphan import。

Verification：legacy class/import/cutover search；fixed OAuth/project/polling suites；make test；Diff。

Commit：refactor: remove legacy Linear service mixins。

### Task 8.16：删除 legacy runtime service mixins

Description：删除只服务 public runtime/enrollment/report relay 的 Conductor/runtime/dispatch/smoke mixin 图；保留 SQLite dispatch、local sessions、bounded reports 与 Desktop snapshot。

Dependencies：8.15、Checkpoint 5E。

Files：podium_conductors.py、podium_dispatch.py、podium_runtime.py、podium_smoke_checks.py、live_conductor_relay.py、podium_health.py legacy runtime portions、对应 old runtime tests。

Estimated scope：M，6 logical files plus focused tests；允许按 runtime 与 report relay 做 scope-neutral split。

Acceptance：无 runtime bearer lookup、presence/enrollment/public relay mixin 或 old smoke transport；replacement dispatch/session/report/snapshot 是唯一 owner；Linear reconciliation health 保持 domain-only。

Verification：legacy class/import/bearer/presence search；private dispatch/report/snapshot suites；make test；Diff。

Commit：refactor: remove legacy runtime service mixins。

### Task 8.17：删除 legacy binding/profile service mixins

Description：删除只服务 public ManagedPodiumState 的 binding creation/replacement/label/profile mixin 图；保留 local `conductor_bindings.py`、SQLite binding/policy repositories 和 fixed backend profile contract。

Dependencies：8.16、Checkpoint 4C。

Files：podium_project_bindings.py、podium_project_binding_creation.py、podium_project_replacements.py、podium_project_labels.py、podium_performer_profiles.py、对应 old binding/profile tests。

Estimated scope：M，5 logical files plus focused tests。

Acceptance：无 legacy ManagedPodiumState binding/profile mixin、project-label routing 或 orphan import；local binding/policy/private command suites 通过。

Verification：legacy class/import/label-routing search；SQLite binding/policy/private command suites；make test；Diff。

Commit：refactor: remove legacy binding and profile mixins。

### Checkpoint 8F：Legacy service graph 退役

- Conductor HTTP listener/sync 与旧 ManagedPodiumState Linear/runtime/binding/profile mixin 图删除；四 package 与 domain ownership 保留。

### Task 8.18：删除 SaaS PostgreSQL schema tables

Description：在全部 legacy service consumer 已删除后，从 schema statements 删除 user/session/workspace/custom-app/profile tables 和 sequences。

Dependencies：Checkpoint 8F、Checkpoint 2。

Files：store/_postgres_schema_statements.py、tests/test_podium_storage.py、tests/test_podium_linear_lifecycle.py。

Estimated scope：M，3 files。

Acceptance：SaaS-only tables/sequences 不存在；remaining schema tests 与 SQLite replacement 对齐；无 destructive active migration path。

Verification：schema focused tests/search；make test；Diff。

Commit：refactor: remove SaaS tables from the legacy schema。

### Task 8.19：删除 PostgreSQL profile/health/ops mixins

Description：删除已由 SQLite replacement 覆盖的 profile、health 和 ops PostgreSQL modules。

Dependencies：8.18、Checkpoint 2。

Files：store/_postgres_profiles.py、_postgres_health.py、_postgres_ops.py、相关 tests。

Estimated scope：M，4 files。

Acceptance：Profile/health/ops active reads 全部来自 SQLite/local lifecycle；无 orphan imports。

Verification：SQLite health/profile focused tests；import search；make test；Diff。

Commit：refactor: remove legacy PostgreSQL profile and health stores。

### Task 8.20：删除 PostgreSQL Linear store

Description：删除 installation/project/reconciliation PostgreSQL mixins。

Dependencies：8.19、Checkpoint 3C。

Files：store/_postgres_linear.py、_postgres_linear_reconciliation.py、_postgres_project_replacements.py、相关 tests。

Estimated scope：M，4 files。

Acceptance：Linear metadata/projects/reconciliation 只走 SQLite；无 old cutover/store fallback。

Verification：Linear SQLite/project/polling focused suites；import/search；make test；Diff。

Commit：refactor: remove the PostgreSQL Linear store。

### Task 8.21：删除 PostgreSQL dispatch store

Description：删除 dispatch/lease/binding/runtime PostgreSQL mixin，保留 SQLite implementation。

Dependencies：8.20、Checkpoint 5C。

Files：store/_postgres_dispatch.py、_postgres_runtime.py、_postgres_project_unbind.py、相关 tests。

Estimated scope：M，4 files。

Acceptance：Dispatch/binding/lease 只走 SQLite；enrollment/runtime secret tables/accessors 同步消失；无 advisory lock/SQL fallback；private dispatch suite 通过。

Verification：SQLite dispatch/private lease tests；SQL/import/enrollment-secret search；make test；Diff。

Commit：refactor: remove the PostgreSQL dispatch store。

### Task 8.22：删除 PostgreSQL aggregate 和 asyncpg

Description：删除 PgStore aggregate、剩余 records/schema imports 和 asyncpg dependency/config。

Dependencies：8.21。

Files：store/postgres.py、store/__init__.py、store/_postgres_records.py、store/_postgres_schema_statements.py、packages/podium/pyproject.toml、packages/podium/src/podium/config.py、相关 tests。

Estimated scope：M，6 logical files plus focused tests。

Acceptance：packages/podium 无 asyncpg/PostgreSQL import；PODIUM_DATABASE_URL 不在 active config；make install 使用 SQLite stack；不存在已删模块的 import。

Verification：dependency/import/env/SQL search；make install；make test；Diff。

Commit：refactor: remove the PostgreSQL Podium dependency。

### Task 8.23：删除 runtime secret models/config

Description：在所有 bearer/enrollment consumer 和 PostgreSQL backing 已删除后，删除 podium_runtime_token、podium_proxy_token、enrollment token/hash 及其 serialization/config/helper 残留。

Dependencies：8.22。

Files：packages/conductor/src/conductor/models.py、store.py、packages/podium/src/podium/podium_shared.py、config.py、相关 model/config tests。

Estimated scope：M，5 files。

Acceptance：Source、fresh schema、env、bundle 和 active models/config 无 runtime/proxy/enrollment bearer/hash；不改名补回；private IPC config 完整；旧 workflow.db 不迁移。

Verification：repo/bundle/model/schema/env/error forbidden search；private IPC focused suite；make test；Diff。

Commit：refactor: remove Podium runtime secret models。

### Task 8.24：删除 Podium 自研 crypto implementation

Description：删除 SecretDecryptionError、encrypt/decrypt helper、key config/rotation 和仅服务旧 ManagedPodiumState 的 encrypted-token layer。

Dependencies：8.23、Task 3.4。

Files：packages/podium/src/podium/podium_state.py、config.py、linear_token_service.py、packages/podium/pyproject.toml、相关 crypto tests。

Estimated scope：M，5 files。

Acceptance：无 encrypt/decrypt/key/ciphertext/*_enc/secret_hash code/error；批准的 plaintext installation token fields 保留；不迁移旧密文；generic redaction 保留；仅供自研 crypto 使用的 dependency/import 一并删除。

Verification：repo/bundle crypto forbidden search；credential/redaction tests；make test；Diff。

Commit：refactor: remove Podium credential encryption。

### Checkpoint 8G：PostgreSQL、secret 与 crypto 退役

- PostgreSQL/asyncpg/PODIUM_DATABASE_URL、runtime secret/hash 和自研 crypto 从 source、schema、bundle、env 与 dependencies 全部删除。

### Task 8.25：删除 committed Python static assets

Description：删除 Python package 内 committed SPA assets，并将 Web output 指向 Tauri bundle。

Dependencies：Checkpoint 8G、Checkpoint 6E。

Files：packages/podium/src/podium/static、web/vite.config.ts、packages/podium/pyproject.toml、相关 build tests。

Estimated scope：M，删除资产 + 3 config files。

Acceptance：Python package 不含 static assets；npm build 产物由 Desktop bundle 消费；build 后 git 无 generated drift。

Verification：Podium Web build；desktop build/package；static/file search；git status；Diff。

Commit：refactor: move Podium Web assets into the Desktop bundle。

### Task 8.26：清理 active transport vocabulary

Description：重命名 active module/event/error/test 词汇以反映 local private IPC，不重命名 package/roles。

Dependencies：8.25。

Files：active conductor sync module、Podium local runtime modules、event/error constants、focused tests。

Estimated scope：M，最多 5 个逻辑文件；机械引用可由 rename tool 更新。

Acceptance：Active code 无 misleading bearer/enrollment/public proxy 名称；Podium/Conductor role 名称保持；historical ADR 明确 historical。

Verification：active vocabulary search；package boundary；make test；Diff。

Commit：refactor: align private runtime vocabulary。

### Task 8.27：更新 build 和 CI entrypoints

Description：让 desktop install/dev/test/build/package 成为 active tooling，不改产品行为。

Dependencies：8.26。

Files：Makefile、package manifests、primary test workflow、desktop build workflow。

Estimated scope：M，4 files。

Acceptance：clean checkout 可执行 desktop commands；CI 不启动 PostgreSQL/public Podium/Conductor HTTP listener；build 后 git clean。

Verification：clean install/build/test；CI config validation；listener/process audit；git status；Diff。

Commit：chore: make Desktop the active build target。

### Task 8.28：更新 root operating docs

Description：更新 README、AGENT、AGENTS 的 active topology、安全边界和交付 Gate。

Dependencies：8.27。

Files：README.md、AGENT.md、AGENTS.md、docs/product/README.md。

Estimated scope：M，4 files。

Acceptance：不指导 PostgreSQL/public Podium/secret/custom App；明确双 DB ownership、四 package 和 per-task Gate。

Verification：docs link/search；command examples dry run；Diff。

Commit：docs: document the active Desktop topology。

### Task 8.29：更新 product architecture docs

Description：重写 active product topology、Linear、security 和 installation 文档。

Dependencies：8.28。

Files：docs/product/README.md、podium-desktop.md、linear-integration.md、security-model.md、runtime-installation.md。

Estimated scope：M，5 files。

Acceptance：Product docs 只有一个 active topology；固定 App、SQLite、private IPC、无 secret/crypto 与代码一致。

Verification：product docs links/search；documented command dry run；Diff。

Commit：docs: reconcile Desktop product architecture。

### Task 8.30：更新 module boundary docs

Description：更新 Podium、Podium Web、Conductor、Performer 和 performer-api 模块职责。

Dependencies：8.29。

Files：docs/modules/README.md、podium.md、podium-web.md、conductor.md、performer-api.md。

Estimated scope：M，5 files。

Acceptance：四 package boundary、双 DB ownership、private IPC DTO 和 provider isolation 与代码一致。

Verification：module docs links/search；package boundary cross-check；Diff。

Commit：docs: reconcile Desktop module boundaries。

### Task 8.31：更新 real-flow design docs

Description：更新 real-flow 和 acceptance design，不再依赖 PostgreSQL/public Podium/bearer。

Dependencies：8.30。

Files：docs/real-flow.md、docs/real-e2e-design.md、tools/real_flow.py docs/help tests。

Estimated scope：M，4 files。

Acceptance：Documented runner 只走 Desktop/SQLite/private IPC；evidence 和 cleanup 规则与 Task 7.x 一致。

Verification：real-flow help/dry run；docs links/search；runner tests；Diff。

Commit：docs: reconcile Desktop real-flow guidance。

### Checkpoint 8H：硬切完成

- Source、imports、entrypoints、bundle、schema、env、frontend client 和 tests 中的 SaaS、PostgreSQL、runtime secret/crypto、public Podium/Conductor HTTP、enrollment、arbitrary Linear proxy 与 legacy ManagedPodiumState graph 全部删除；historical ADR 仅可作为明确历史记录命中。
- `podium_routes_*`、`ConductorApiServer`、`PODIUM_URL`/runtime/proxy token、`http_port`、PgStore/asyncpg、browser `/api/v1` fetch 均为零 active/dead-code residual；固定 loopback OAuth callback 不计入 public runtime listener。
- 四 package、Podium/Conductor 边界和双 durable ownership 保留。

## 14. Phase 9：跨平台发行验收

### Task 9.1：完成 clean macOS acceptance

Description：在 clean user 环境执行完整客户端与真实业务路径。

Dependencies：Checkpoint 8H。

Files：tools/real_flow.py、docs/evidence/macos-acceptance.md、tests/test_release_evidence.py。

Estimated scope：M，3 files。

Acceptance：

- Install、OAuth、SQLite credential restart/update persistence、popover、多 Conductor、Performer、run、hide/Quit 全部通过。
- 无 orphan、secret leak 或 ambient checkout/profile dependency。
- Evidence 链接 component logs、排除 credential fields 的双 DB state exports、turn 和 Linear/UI artifacts。

Verification：macOS package/install/real-flow；evidence schema test；cleanup audit；Diff。

Commit：test: record macOS Desktop acceptance。

### Task 9.2：完成 Windows acceptance

Description：验证 Windows tray、双 sidecar 拓扑、已批准的 inherited IPC 和业务 smoke；只有 Phase 1 No-Go 后另获批准时才验证 named pipe/ACL fallback。

Dependencies：Checkpoint 8H。

Files：CI Windows workflow、docs/evidence/windows-acceptance.md、tests/test_release_evidence.py。

Estimated scope：M，3 files。

Acceptance：

- Tray、Podium/Conductor processes、inherited IPC identity、SQLite credential reopen、callback、Performer、exit 达标；若另行批准 named endpoint，则追加 named pipe/ACL evidence。
- 路径/进程/权限无 macOS 假设。
- Evidence artifact 可审计且无 secrets。

Verification：Windows clean-machine artifact；focused integration；evidence test；Diff。

Commit：test: record Windows Desktop acceptance。

### Task 9.3：完成 Linux acceptance

Description：验证批准 desktop environment 的 tray fallback、已批准的 inherited Unix IPC 和业务 smoke；只有 Phase 1 No-Go 后另获批准时才验证 filesystem Unix socket fallback。

Dependencies：Checkpoint 8H。

Files：CI Linux workflow、docs/evidence/linux-acceptance.md、tests/test_release_evidence.py。

Estimated scope：M，3 files。

Acceptance：

- Rich popover 或 A10 native-menu fallback 明确且可用。
- Inherited Unix IPC identity/handle isolation、SQLite credential reopen、callback、Performer、exit 达标；若另行批准 named endpoint，则追加 runtime-directory/socket permissions 和 peer-identity evidence。
- Evidence artifact 可审计且无 secrets。

Verification：Linux build/install/smoke；fallback evidence；evidence test；Diff。

Commit：test: record Linux Desktop acceptance。

### Task 9.4：发布前全量报告

Description：汇总所有平台、real-flow、security、forbidden scans 和 per-task delivery evidence。

Dependencies：9.1–9.3。

Files：docs/evidence/release-acceptance.md、tools/release_acceptance.py、tests/test_release_acceptance.py、CHANGELOG.md。

Estimated scope：M，4 files。

Acceptance：

- 每个主要要求给出 0/4–4/4 分数和 concrete evidence；未验证项不冒充通过。
- 每个 tracked Task 有 commit hash、simple-code、re-verification、code-view adjudication 和 residual risk。
- 所有 OUT_OF_SCOPE_REVIEW_SUGGESTION 有 rejected evidence，未形成生产行为。

Verification：release report test；Python full；Podium Web；Desktop Rust；package matrix；real-flow；forbidden scans；Diff。

Commit：docs: publish Podium Desktop acceptance evidence。

### Checkpoint 9：完成

- 无 unresolved critical gap。
- 测试进程、Linear fixture、临时数据和生成物清理完成。
- Git status 符合预期。

## 15. 并行与顺序约束

必须顺序：

- 0.x -> 1.x -> Checkpoint 1。
- SQLite migration runner -> repositories -> lifecycle/commands。
- OAuth state -> callback -> SQLite credential repository -> token lifecycle -> gateway/projects。
- Contract -> Podium session -> Conductor client -> active sync。
- Polling -> epoch/blocker -> enqueue -> lease/reclaim -> workflow integration。
- Checkpoint 5D -> Codex semantic event -> bounded event transport -> Checkpoint 5E。
- Checkpoint 7B -> 所有 destructive deletion tasks。

合同冻结后可并行，但本轮未授权多 agent 执行：

- 2.x Podium persistence 与 6.1 Desktop shell。
- 3.7 gateway 与 4.2 session registry，在 shared contract 稳定后。
- 6.7 Runtimes、6.8 Performer、6.9 Managed Runs，在 snapshot/report contract 稳定后。
- 9.1–9.3 平台 acceptance。

## 16. 风险与对策

| 风险 | 对策 |
| --- | --- |
| SQLite 事务语义漂移 | 高风险 proof 提前；unique constraints；原子 polling transaction；逐项 port regression |
| 无 bearer 后 IPC 被冒用 | inherited channel 优先；expected PID/peer identity/generation；每 Conductor 独立 channel |
| Desktop 侵蚀 package boundary | package-boundary tests；shared DTO only in performer-api；禁止互相 import |
| desired/observed process drift | Podium durable desired binding + generation/fencing；Rust observed state；启动时 reconcile |
| Manage 被误判为授权成功 | installation/credential 分离状态；bounded callback timeout；explicit Reset/remove/reinstall evidence |
| SQLite credential 泄漏到普通输出 | token fields 只由 Podium credential repository 读取；metadata DTO/snapshot/API/Tauri/Conductor/artifact sentinel gate |
| Raw Codex event 泄漏或获得 workflow authority | Performer semantic allowlist；closed schema/fencing；ephemeral latest-only；result parity 和 Linear-write forbidden tests |
| 删除 crypto 误删 generic redaction | crypto deletion 独立 Task；credential/redaction regression 必须通过 |
| simple-code 改变行为 | 仅当前 diff；前后 focused verification；行为变化即拒绝简化 |
| code-view 顺手加功能 | requirement trace；无 trace 强制 OUT_OF_SCOPE_REVIEW_SUGGESTION |
| 删除任务在实施时膨胀 | 所有删除 Task 仍受 S/M file budget；超出时先做 scope-neutral task split，不得以机械删除为由扩大 commit |

## 17. 最终 Definition of Done

- Podium Desktop 是唯一入口，不需要 PostgreSQL/public Podium server。
- 四个 Python package 保留并通过 import-boundary tests。
- Podium 使用 podium.db；每个 Conductor 使用 workflow.db。
- 固定测试 Application、本地 PKCE、exact scopes、Manage/missing-credential recovery，无 client secret/custom App/webhook runtime dependency，也无 manifest/config revision 或修改流程。
- 无 Podium secret、替代 local bearer/capability secret、自研 encryption/decryption。
- Private IPC 无 public runtime HTTP；Linear token 只在 Podium memory 和 podium.db 的批准 installation fields，restart/update 不重复授权，无 OS credential adapter、自研 crypto、memory-only 或 dual store。
- 完整窗口和 macOS popover 保持现有视觉。
- Podium Managed Runs 只显示 latest closed Codex `performer_event`；无 raw event/history/Linear live write，event loss 不改变 Managed Run。
- Managed Run/Gate/recovery/error visibility 有自动化和 real E2E evidence。
- 每个 tracked Task 有 simple-code、code-view adjudication、verification 和独立 commit hash。
- 所有越界 review 建议均被拒绝，未增加未批准功能。

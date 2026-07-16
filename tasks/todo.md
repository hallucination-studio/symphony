# Podium Desktop 实施任务清单

> 状态：已批准，实施中
>
> Source of truth：tasks/spec.md、tasks/plan.md、tasks/code-view.md。此文件由 plan 的 Task/Checkpoint 标题机械对齐。

## 每个 tracked Task 的硬门槛

- [ ] Scope ledger 完整，assumptions_requiring_approval 为空。
- [ ] Baseline 与任务开始 commit 已记录。
- [ ] 测试先行，实施只覆盖当前 Task。
- [ ] Focused verification 通过。
- [ ] 已调用 simple-code（code-simplification skill），仅处理当前 diff；无变化时记录 simple_code_no_change。
- [ ] simple-code 后 focused verification 重新通过。
- [ ] 已调用 code-view（code-review-and-quality skill）并保存 findings。
- [ ] 每条 finding 有 requirement trace，并完成四类 adjudication。
- [ ] OUT_OF_SCOPE_REVIEW_SUGGESTION 和 INVALID_FINDING 已拒绝，未改代码、未加测试。
- [ ] IN_SCOPE_OPTIONAL 默认未实现；如需实现已有用户明确批准。
- [ ] 所有 IN_SCOPE_BLOCKER 修复后重新执行 verification、simple-code 和 code-view。
- [ ] Final verification、forbidden scan 与 git diff --check 通过。
- [ ] 当前 tracked Task 已形成一个独立原子 commit，并记录 hash、evidence、finding adjudication 和 residual risk。

## Phase 0：批准与工作流冻结

- [x] 0.1 批准规格和任务边界
- [x] 0.2 提交 tracked product spec 和 ADR
- [x] 0.3 确认 skill 驱动的 Task evidence 流程
- [x] Checkpoint 0：工作流可执行

## Phase 1：高风险可行性

- [x] 1.1 建立最小 Tauri Desktop 壳
- [x] 1.2 证明 Podium sidecar framing 和生命周期
- [x] 1.3 证明 Podium SQLite 事务模型
- [x] Checkpoint 1A：Desktop 与 SQLite proof

- [x] 1.4 定义最小 private IPC proof contract
- [x] 1.5 证明 inherited Podium/Conductor channel
- [x] Checkpoint 1B：边界 proof

- [x] 1.6 证明固定 Application PKCE callback mechanics
- [x] 1.7 证明 Linear credential SQLite persistence
- [ ] Checkpoint 1C：OAuth proof

- [x] 1.8 证明 Desktop 到 Performer 的完整进程链
- [ ] 1.9 证明 macOS popover 生命周期
- [ ] Checkpoint 1D：进程与 popover proof

- [ ] 1.10 记录跨平台 Go/No-Go
- [ ] Checkpoint 1：可行性 Go

## Phase 2：Podium 本地持久化与生命周期

- [x] 2.1 建立 podium.db migration runner
- [x] 2.2 建立 Linear installation metadata repositories
- [x] 2.3 建立 binding 和 runtime report repositories
- [x] Checkpoint 2A：Podium metadata persistence

- [x] 2.4 建立 polling 和 dispatch repositories
- [x] 2.5 建立 Podium local lifecycle
- [x] Checkpoint 2B：Podium state lifecycle

- [x] 2.6 建立 Desktop command dispatcher
- [x] 2.7 建立 process desired/observed reconcile
- [x] 2.8 建立聚合 snapshot
- [x] Checkpoint 2：本地 Podium 基础稳定

## Phase 3：固定 Linear Application 与授权

- [x] 3.1 固化固定 Application manifest
- [x] 3.2 实现 PKCE attempt state machine
- [x] Checkpoint 3A：固定 App 与 PKCE state

- [x] 3.3 实现 loopback callback listener
- [x] 3.4 实现 SQLite Linear credential repository
- [x] 3.5 实现 OAuth exchange 与 refresh rotation
- [x] 3.6 实现授权恢复、Reset and reconnect 与 Disconnect
- [x] Checkpoint 3B：授权闭环

- [x] 3.7 实现 allowlisted Linear gateway
- [x] 3.8 实现 project discovery 全分页
- [x] 3.9 实现 accessible project catalog command
- [x] 3.10 实现 atomic Create Conductor desired binding
- [x] Checkpoint 3C：Linear 项目闭环（local evidence；real OAuth 保留 Phase 7）

## Phase 4：Podium 与 Conductor 私有边界

- [x] 4.1 扩展正式 local runtime contracts
- [x] 4.2 实现 Podium IPC session registry
- [x] 4.3 实现 Podium configure/command dispatcher
- [x] Checkpoint 4A：Podium IPC server

- [x] 4.4 实现 Conductor IPC transport client
- [x] 4.5a 修正完整 Configure private contract
- [x] 4.5b 打通 private Configure 构造与应用
- [x] 4.5c 建立 Conductor inherited IPC bootstrap
- [x] 4.5d 切换 active sync tick 到 private IPC
- [x] Checkpoint 4B：基本 IPC 闭环

- [ ] 4.6a 建立 Desktop 到长驻 Podium 的动态 inherited session handoff
- [ ] 4.6b 实现 Desktop 多 Conductor auto-start reconciliation
- [ ] 4.7 实现 scoped Linear gateway contract
- [ ] 4.8 实现 bounded runtime reports
- [ ] Checkpoint 4C：多 Runtime 边界稳定

## Phase 5：Polling、Dispatch 与 Managed Run 回归

- [ ] 5.1 迁移 baseline polling 到 SQLite
- [ ] 5.2 实现 incremental checkpoint polling
- [ ] Checkpoint 5A：Polling continuity

- [ ] 5.3 实现 delegation epoch 状态机
- [ ] 5.4 实现 blocker reconciliation
- [ ] Checkpoint 5B：Observation 到 eligible dispatch

- [ ] 5.5 实现 exactly-once dispatch enqueue
- [ ] 5.6 实现 private IPC lease 和 ACK
- [ ] 5.7 实现 lease expiry 和 reclaim
- [ ] 5.8 接入 Conductor Managed Run commit/resume
- [ ] Checkpoint 5C：Dispatch 到 Managed Run

- [ ] 5.9 回归 ordered work items 和 verification
- [ ] 5.10 回归 Gate rework 和 block
- [ ] 5.11 回归 recovery、stale fencing 和 runtime waits
- [ ] Checkpoint 5D：Managed Run regression

- [ ] 5.12 实现 Codex semantic performer_event
- [ ] 5.13 实现 bounded performer_event transport
- [ ] Checkpoint 5E：Podium live status

## Phase 6：Desktop UI 纵向切片

- [ ] 6.1 建立 Desktop shell 与现有 design tokens
- [ ] 6.2 实现 Overview snapshot slice
- [ ] 6.3 实现本地 Setup route selection
- [ ] Checkpoint 6A：Desktop shell 与 Setup routing

- [ ] 6.4 实现 Linear authorization UI slice
- [ ] 6.5 实现 Create Conductor project picker slice
- [ ] 6.6 实现 Create Conductor 与 auto-start UI slice
- [ ] Checkpoint 6B：Setup 配置闭环

- [ ] 6.7 实现 Runtimes/Conductor UI slice
- [ ] 6.8 实现 Performer UI slice
- [ ] 6.9 实现 Managed Runs UI slice
- [ ] Checkpoint 6C：运行信息闭环

- [ ] 6.10 实现生产 macOS popover
- [ ] 6.11 完成 Desktop UI quality gate
- [ ] Checkpoint 6E：UI 完成

## Phase 7：Real E2E 与恢复证据

- [ ] 7.1 建立 Desktop real-flow harness
- [ ] 7.2 完成真实 OAuth 和 project binding prerequisite
- [ ] 7.3 完成真实成功 Managed Run
- [ ] Checkpoint 7A：Prerequisite 与成功流

- [ ] 7.4 完成 Gate rework/block 场景
- [ ] 7.5 完成 runtime wait 场景
- [ ] Checkpoint 7B：核心业务 Real E2E

- [ ] 7.6 完成 Podium restart/dedup 场景
- [ ] 7.7 完成 Conductor restart/isolation 场景
- [ ] Checkpoint 7C：Restart 与隔离

- [ ] 7.8 完成 OAuth refresh/failure 场景
- [ ] 7.9 完成 security/forbidden gate
- [ ] Checkpoint 7D：Replacement Ready

## Phase 8：旧路径退役

- [ ] 8.1 删除 Login/Register route slice
- [ ] 8.2 删除 Account/session frontend slice
- [ ] 8.3 删除 custom Application UI
- [ ] 8.4 删除 legacy browser HTTP client
- [ ] Checkpoint 8A：Desktop frontend hard cut

- [ ] 8.5 删除 Podium auth routes
- [ ] 8.6 删除 custom Application backend
- [ ] Checkpoint 8B：Account 与 Application HTTP 分支退役

- [ ] 8.7 删除 public Linear lifecycle routes
- [ ] 8.8 删除 public onboarding/binding routes
- [ ] 8.9 删除 enrollment/install transport
- [ ] Checkpoint 8C：Public setup routes 退役

- [ ] 8.10 删除 public runtime operations routes
- [ ] 8.11 删除 public Linear proxy route
- [ ] Checkpoint 8D：Public runtime routes 退役

- [ ] 8.12 删除 public Podium server mode
- [ ] 8.13 删除 session/user store model
- [ ] Checkpoint 8E：Public Podium host 退役

- [ ] 8.14 删除 Conductor HTTP sync 与 listener
- [ ] 8.15 删除 legacy Linear service mixins
- [ ] 8.16 删除 legacy runtime service mixins
- [ ] 8.17 删除 legacy binding/profile service mixins
- [ ] Checkpoint 8F：Legacy service graph 退役

- [ ] 8.18 删除 SaaS PostgreSQL schema tables
- [ ] 8.19 删除 PostgreSQL profile/health/ops mixins
- [ ] 8.20 删除 PostgreSQL Linear store
- [ ] 8.21 删除 PostgreSQL dispatch store
- [ ] 8.22 删除 PostgreSQL aggregate 和 asyncpg
- [ ] 8.23 删除 runtime secret models/config
- [ ] 8.24 删除 Podium 自研 crypto implementation
- [ ] Checkpoint 8G：PostgreSQL、secret 与 crypto 退役

- [ ] 8.25 删除 committed Python static assets
- [ ] 8.26 清理 active transport vocabulary
- [ ] 8.27 更新 build 和 CI entrypoints
- [ ] 8.28 更新 root operating docs
- [ ] 8.29 更新 product architecture docs
- [ ] 8.30 更新 module boundary docs
- [ ] 8.31 更新 real-flow design docs
- [ ] Checkpoint 8H：硬切完成

## Phase 9：跨平台发行验收

- [ ] 9.1 完成 clean macOS acceptance
- [ ] 9.2 完成 Windows acceptance
- [ ] 9.3 完成 Linux acceptance
- [ ] 9.4 发布前全量报告
- [ ] Checkpoint 9：完成

## 最终完成条件

- [ ] Podium Desktop 是唯一入口，不需要 PostgreSQL 或 public Podium server。
- [ ] 四个 Python package 保留并通过 import-boundary tests。
- [ ] Podium 使用 podium.db；每个 Conductor 使用 workflow.db。
- [ ] 固定测试 Application、本地 PKCE、无 client secret/custom App，无 manifest/config revision 或修改流程。
- [ ] 无 Podium secret、替代 local bearer/capability secret、自研 encryption/decryption。
- [ ] Private IPC 无 public runtime HTTP；Linear token 只在 Podium memory 和 podium.db 的批准 installation fields，restart/update 不重复授权，无 Keychain/OS credential、自研 crypto、memory-only 或 dual store。
- [ ] 完整窗口和 macOS popover 保持现有视觉。
- [ ] Managed Run/Gate/recovery/error visibility 有自动化和 real E2E evidence。
- [ ] 每个 tracked Task 有 simple-code、code-view adjudication、verification 和独立 commit hash。
- [ ] 所有越界 review 建议均被拒绝，未增加未批准功能。

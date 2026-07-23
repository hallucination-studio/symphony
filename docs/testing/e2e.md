# Target Workflow E2E

本文规定 target-workflow 的真实边界验收方式。架构和产品行为以
[`docs/architecture/`](../architecture/README.md) 为准；本文只描述运行入口、证据和
清理边界。

## 场景

credentialed all-run 先完成一次 Team/Project setup 和历史 E2E Root 清理，再并行启动五个
相互独立的场景子进程：

1. `success`：外部 Root、Bootstrap Plan、审批、sealed Work/Verify DAG、Work 和 Verify。
2. `repair_escalation`：真实 Finding disposition 和 Root convergence breaker。
3. `restart_recovery`：Conductor 重启后从 Linear/Git 重建同一 Human action；stale-result
   rejection 必须由真实 Performer late-result probe 提供。
4. `delivery`：Verify immutable revision 与 Linear delivery read-back 一致。
5. `scheduling`：从 Linear Root priority、state 和 blocker relation 读取单 writer 选择。

每个场景使用独立本地 Git/Conductor scope。场景之间不合并 Root、Cycle、Node 或
stage evidence。setup、历史 Root archive 和最终 schedulable Root read-back 完成前不会
创建任何场景 Root。

## Commands

无凭据的 runner contract 检查：

```bash
npm run test:e2e:runner
```

本地 credentialed all-run：

```bash
npm run e2e:target-live
```

单场景入口（每个入口同样受 `300000ms` watchdog 约束）：

```bash
node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node tools/e2e/target-workflow-entry.mjs --live-success
node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node tools/e2e/target-workflow-entry.mjs --live-repair
node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node tools/e2e/target-workflow-entry.mjs --live-restart
node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node tools/e2e/target-workflow-entry.mjs --live-delivery
node tools/e2e/run-with-timeout.mjs --timeout-ms 300000 -- node tools/e2e/target-workflow-entry.mjs --live-scheduling
```

完整 target E2E 会由 `make e2e` 在构建和 contract 检查后调用同一入口。CI 只在受保护
Environment 中注入凭据，并上传 `.test/e2e-target-workflow/<run-id>/verdict.json`。

仅检查 target source topology：

```bash
node tools/e2e/target-workflow-entry.mjs --dry-run
```

## Inputs

入口读取以下环境变量：

- `SYMPHONY_E2E_LINEAR_DEV_TOKEN`
- `LINEAR_CLIENT_ID`
- `SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED` (`true` is required for credentialed
  Team workflow initialization and Project Label rebind)
- `SYMPHONY_E2E_PROJECT_SLUG_ID`
- `SYMPHONY_E2E_CODEX_API_KEY`
- `SYMPHONY_E2E_CODEX_BASE_URL`
- `SYMPHONY_E2E_CODEX_MODEL`
- `SYMPHONY_E2E_RUN_ID`

缺少必要配置时，入口在任何 scope 或外部 mutation 之前输出 `unverified`。凭据只进入
Podium/approved Profile boundary；Conductor child environment、Linear snapshot、Git
observation、日志和 evidence 均不得包含 secret。

Credentialed setup 在任何 retained Root 或 Project Label mutation 之前读取目标 Project
绑定的唯一 Team，并校验完整的 17 个 canonical workflow statuses 及其 Linear category。
缺少 status、重复/错误 category 或 Team 绑定不唯一时，入口 fail closed；完整目录缺失时
使用稳定原因 `target_live_workflow_catalog_incomplete`，不会创建 Root。

When `SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED=false`, setup remains read-only and
returns `authorization-required` before Root cleanup, pool reconciliation, or
any other Linear mutation.

## Evidence

runner 只通过外部 Root/Human input adapter 创建 caller-owned 输入；它不创建 Cycle、Node、
Finding、relation、commit 或 delivery。Linear snapshot 和 Git observation 通过 bounded
read-only adapters 投影为闭合 facts DTO。

最终 verdict 由 `evaluateTargetWorkflowResults` 从五个 scenario evidence 重新计算。它会
拒绝缺失 correlation、stale result、错误 revision、未检查 convergence breaker、错误
blocker 选择、cleanup 未完成和 secret leak。最终 evidence 还包含已完成授权 setup 的
sanitized verdict、workflow/project-label mutation verdict 和 identity digest；不包含
Linear IDs、SDK 对象或 mutation payload。单场景失败不会变成其他场景的成功；all-run 会
收集已启动子进程的脱敏结果并返回 `failed`。真实 `429` 会取消并回收兄弟场景进程。

## Deadline

协调器从命令开始拥有一个 `300000ms` 总 deadline；每个场景再通过独立
`run-with-timeout.mjs` 获得不超过剩余时间的 watchdog。watchdog 到期时直接终止该场景
process group，必要时强制 kill，并以退出码 `124` 结束，不等待业务 `close()`、IPC 关闭或
证据写入。因此挂起的 cleanup 不能把场景拖到五分钟之后。

当前仓库没有 credentialed retained run。Restart boundary 已覆盖真实 Conductor 的重启、
Linear/Git 重建和 Human correlation，但不会把 provider simulation 冒充 stale-result
evidence；因此在 T12 late-result probe 尚未接入 target all-run 前，`restart_recovery`
和整体 verdict 必须保持未接受/失败。

## Cleanup

每个场景在成功和失败路径关闭 Conductor/Podium，并删除带 run marker 的本地 scope。并行
启动前，setup 只 archive 带合法 `symphony e2e-run` marker 且已处于 terminal state 的历史
顶层 Root，并通过最终 active-Root read-back 确认没有旧测试 Root 仍可调度；发现带 marker
的非 terminal Root 时直接 fail closed，不猜测它是否已失联或可接管。未标记 Issue 不会修改。Linear
Project、Root 和 Project Label 属于 retained external evidence，不由 runner 自动删除；
credentialed run 后必须人工检查 `.test/e2e-target-workflow/<run-id>/verdict.json` 和对应
Linear/Git facts。未获得真实 Linear、Git、Conductor、Performer 证据时，不能报告
credentialed acceptance 通过。

当遗留的 marked Root 已确认不再由任何运行实例使用时，operator 可以显式 quiesce 它：

```bash
node --env-file-if-exists=.env tools/e2e/cleanup.mjs \
  --quiesce-run-digest <12-hex-run-digest> QUIESCE
```

该命令只匹配目标 Project 中一个顶层 E2E marker，将 Root 置为 `Canceled`，并验证
Project、marker、父级和最终状态；它不接受 raw Issue ID，不改变 ownership 或 routing，
也不会自动运行在 `--live-all` 中。之后仍须由正常 preparation archive 该 terminal Root。

## Parallel preparation and Root routing

Credentialed E2E execution has one mandatory preparation barrier:

```text
Project identity read
  -> archive only prior valid marked terminal E2E Roots
  -> final active/schedulable Root read-back
  -> reconcile the complete Project Conductor Pool
  -> start isolated scenario children concurrently
```

The pool is reconciled only after retained marked Roots have been archived. An
unmarked or non-terminal Root is never deleted or silently taken over; if it
prevents routing or member removal, preparation fails closed and starts zero
scenario children.

Each child derives one unique pool member from its scenario run ID. Root input
must select that member, validate it against the Project pool, and write exactly
one `symphony:conductor/<short-hash>` Issue Label at creation. A child cannot
reuse another scenario's Root, Binding, database, Git scope, observer, or
process group.

Every scenario is guarded by an authoritative `300000ms` process deadline.
Timeout termination targets only that scenario's process group, returns exit
code `124`, and does not await graceful close, IPC shutdown, or evidence flush.

# Target Workflow E2E

本文是 target-workflow E2E 的测试设计来源。产品行为仍由
[`docs/architecture/`](../architecture/README.md) 定义；E2E 不拥有或复制
Plan/Work/Verify、Performer 或 Conductor 的业务流程。

## Test boundary

E2E 是一个黑盒外部参与者，只允许承担四类职责：

1. 从仓库根目录的 `.env` 读取真实凭据并通过生产 Podium boundary 解析 Team、Project 和
   Performer Profiles；历史 Root 清理后再 reconcile 本次五个 Conductor members。
2. 清理目标测试 Project 中由闭合 `symphony e2e-run` marker 证明属于 E2E 的历史数据。
3. 通过 Linear API 创建五个新的 Root Issues，并在真实 Pending Human Action 出现后扮演
   Linear 用户提交批准或拒绝决定。
4. 启动真实 Conductor 进程并只从 Linear、Git 和进程退出状态观察、断言结果。

E2E 不直接启动或调用 Performer。每次 Plan、Work 和 Verify Performer invocation 都必须由
生产 Conductor 通过生产 Stage Wire 创建。E2E 不创建 Cycle、Plan、Work、Verify、Finding、
managed workflow record、relation、commit 或 delivery，也不计算下一步 Stage、不伪造 Stage
Result、不修复 workflow、不实现 retry/recovery/convergence。

## Mandatory lifecycle

每次 credentialed all-run 必须严格执行：

```text
load and validate .env
-> resolve Team / Project and bind Performer Profiles
-> stop and reap prior local E2E process groups
-> cancel and archive every historical E2E-marked Root in the test Project
-> read back that no historical E2E-marked Root is schedulable
-> reconcile the five Conductor members for this run
-> create all five new routed Root Issues
-> read back all five Root identities, markers and routes
-> start five real Conductor process groups concurrently
-> observe Pending Human Actions and submit real Linear user decisions
-> observe terminal Linear/Git outcomes
-> terminate and reap all process groups
```

任何 preparation 步骤失败时启动零个 Conductor。五个 Root 必须全部创建并 read back 后才可
启动第一个 Conductor；不得边创建边执行。历史清理是每次运行的固定步骤，不保留人工
`quiesce` 前置流程。清理可以取消并 archive 有合法 E2E marker 的非终态历史 Root，但不得
修改未标记 Issue、其他 Project 或非 Root Issue。

## Scenarios

五个场景使用五个隔离 Git fixtures、Bindings、Conductor routes、data roots 和 process groups。
任务都应是可在五分钟内完成的确定性小改动；场景差异用于证明并行隔离和审批结果，不用于
在测试代码中复刻内部 workflow：

- `approve-1`、`approve-2`、`approve-3`、`approve-4`：观察到 matching Plan approval 后
  提交批准，随后断言各自的小任务完成。
- `reject-then-approve`：拒绝第一次 Plan approval 并提供原因；断言生产 Conductor 创建了
  fresh Plan execution 和新的 action ID，再批准新 Plan，最后断言小任务完成。

场景只响应与自身 Root、target Node、context digest 和 action ID 精确匹配的 Pending Human
Action。额外的 `needs_info` 或未知 approval 不得被自动猜测；场景立即失败并输出脱敏原因。
同一个 action 最多提交一次决定，重试只能在 Linear read-back 证明原 mutation 未应用时发生。

## Human decision boundary

审批是合法的 E2E 外部输入，不是 Performer 模拟。E2E 使用
`SYMPHONY_E2E_LINEAR_DEV_TOKEN` 调用真实 Linear `commentCreate`，向 Pending Human Action
指定的 target Node 写入架构规定的闭合 decision command：

```text
/symphony approve <action_id>
```

或：

```text
/symphony reject <action_id>
<non-empty reason>
```

E2E 不直接更新 Root、Cycle 或 Node status。生产 Conductor 验证 comment 的 Project、Root、
target Node、author kind、时间顺序、action ID 和 context digest，持久化 matching resolution，
然后执行批准或拒绝语义。普通评论、错误 action ID、重复决定和 stale comment 都不能推进流程。

## Assertions

每个场景只断言用户可观察的真实边界：

- Root、route marker 和 run marker 属于本次运行且相互隔离；
- Pending Human Action 和提交的 decision 精确关联；拒绝场景出现新的 Plan execution 和 action；
- Root 达到预期 `In Review` delivery state，且没有 unresolved Human Action；
- Git HEAD 相对 fixture baseline 有真实 Conductor-owned commit，改动与 Root acceptance criteria 一致；
- Linear delivery revision、Verify revision 和 Git HEAD 一致；
- 没有残留 E2E process group，日志和 evidence 不包含 secret。

E2E 可以读取生产持久化的事实以证明这些断言，但不得维护一套独立的 DAG/attempt/Finding/
convergence 状态机。一个场景失败不能成为另一个场景的成功证据。

## Deadline and exit

整个命令从读取 `.env` 开始只有一个权威 `300000ms` wall-clock deadline。每个场景子进程继承
该绝对 deadline，而不是重新获得五分钟；因此 preparation、五场景并行执行和最终回收的总时长
都不能超过五分钟。

coordinator 必须在绝对 deadline 前预留并完成短暂 SIGTERM grace 与 SIGKILL escalation。外层
watchdog 在 `300000ms` 到点时不再等待 grace，直接强制终止剩余 process groups 并以退出码
`124` 结束。此路径不等待 Conductor/Podium `close()`、IPC shutdown、evidence flush、Linear
cleanup 或任何未 settle 的 Promise。业务 cleanup 仅为 best effort；“未 close”不能阻止进程
退出。真实 Linear `429` 同样立即终止全部场景，不等待 reset window。

## Commands and inputs

无凭据 contract checks：

```bash
npm run test:e2e:runner
```

真实 all-run：

```bash
npm run e2e:target-live
```

入口至少读取：

- `SYMPHONY_E2E_LINEAR_DEV_TOKEN`
- `LINEAR_CLIENT_ID`
- `SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED=true`
- `SYMPHONY_E2E_PROJECT_SLUG_ID`
- `SYMPHONY_E2E_CODEX_API_KEY`
- `SYMPHONY_E2E_CODEX_BASE_URL`
- `SYMPHONY_E2E_CODEX_MODEL`
- `SYMPHONY_E2E_RUN_ID`（本地缺省时生成安全 ID）

缺少配置时必须在任何 mutation 或 process launch 前返回 `unverified`。token 只进入 Podium/
Profile boundary 和 E2E 的受限 Linear user actor；不得进入 Conductor child environment、日志、
fixture、snapshot、verdict 或最终报告。

## Migration rule

当前 `success/repair/restart/delivery/scheduling` scenario controllers、独立 facts projector 和
workflow-specific verdict 属于待删除实现，不代表本设计。迁移期间不得运行 credentialed
`--live-all`；只有 preparation-first、five-Root、real-Conductor、Linear-user-decision 和硬 deadline
的新入口完成后才能恢复真实执行。

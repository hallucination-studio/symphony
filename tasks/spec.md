# Spec: Roadmap V1 固定场景 E2E

**状态：** E0-E3 E2E实现已完成；固定 live fixture、GitHub Environment配置和真实 Linear/GitHub/Codex验收按用户授权统一延后，且仍须通过preflight后显式运行。

## 1. 目标

E2E 只解决一件事：按固定业务剧本启动真实 Symphony 客户端，依次调用真实 UI、Podium、
Conductor、Performer、Linear、Codex SDK 和 Git/GitHub，并在每一步验证明确预期。

```text
启动客户端
-> 注入 E2E Linear app credential
-> UI 选择 HELL + test repository/base branch
-> 创建并启动 Conductor
-> UI 创建 API Key Profile 并 ready/activate
-> operator 创建并 delegate Root
-> claim -> Plan -> Plan Approval
-> ordered Work/Human
-> Root Gate
-> PR 或 branch
-> Root In Review
```

Fake Gateway、静态 registry、只调用后端 API 或只测试 React 不能算真实 E2E。

## 2. 简化边界

### 保留

- 一套共享 V1 scenario，Linux CI、本地 Linux、本地 macOS使用相同业务步骤和断言；
- UI 操作只实现 Linux/macOS 两个 adapter；
- 本地 `.env` 与 GitHub Actions 映射为相同进程环境变量；
- 只操作 `SYMPHONY_E2E_PROJECT_SLUG=8ab43179fb54` 对应的 HELL Project 和专用仓库；
- 一个 `OPENAI_E2E_API_KEY` 可创建两个独立 API Key Profiles，用于 A21 Profile 切换；
- Linear 是权威；mutation 失败后有界重试、具体 comment、blocked 并停止。

### 不做

- Windows UI adapter；
- 通用跨平台 process/display/framework 抽象；
- 为每个平台复制 scenario；
- ChatGPT login E2E；
- V2 多 Root调度、第二 Provider、nightly、自动 merge；
- 坐标点击、图像识别或直接改 `podium.db`/`profiles.json`；
- 为测试增加客户可见登录模式。

## 3. 环境输入

本地 runner 读取已忽略的 `.env`；CI 将 GitHub Environment Secrets/Variables 映射为同名
环境变量。scenario 不感知输入来自 `.env` 还是 GitHub。

### Secrets

| 进程环境变量 | 含义 |
|---|---|
| `LINEAR_CLIENT_ID` | 专用 E2E Linear app client ID |
| `LINEAR_CLIENT_SECRET` | 专用 E2E Linear app secret，用于 `client_credentials` |
| `LINEAR_E2E_USER_API_KEY` | 专用测试用户 secret，执行创建/delegate/approve/Human/probe |
| `OPENAI_E2E_API_KEY` | 同一个 Key 分别通过两个 Profile 的 bounded secret frame 登录 |
| `SYMPHONY_E2E_GITHUB_TOKEN` | 专用测试仓库的 Contents/PR 最小权限 token |

### Non-secret config

| 变量 | 约束 |
|---|---|
| `SYMPHONY_E2E_PROJECT_SLUG` | 必须等于 `8ab43179fb54` |
| `SYMPHONY_E2E_EXPECTED_PROJECT_NAME` | 必须等于 `HELL` |
| `SYMPHONY_E2E_REPOSITORY_PATH` | 本地临时 clone 的 allowlisted test repository |
| `SYMPHONY_E2E_GITHUB_REPOSITORY` | 专用 `owner/repo` |
| `SYMPHONY_E2E_GITHUB_BASE_BRANCH` | 专用 base branch |
| `SYMPHONY_E2E_LINEAR_MAX_ATTEMPTS` | 默认 `5` |
| `SYMPHONY_E2E_LINEAR_BACKOFF_BASE_MS` | 默认 `1000` |
| `SYMPHONY_E2E_LINEAR_BACKOFF_MAX_MS` | 默认 `16000` |
| `SYMPHONY_E2E_SCENARIO_TIMEOUT_MINUTES` | 默认 `45` |

preflight 必须先验证所有 secret 存在但绝不打印值，再解析 app actor、HELL、repository remote、
base branch、Codex SDK/runtime 和 `gh` 权限。任何一项不匹配，在第一次外部 mutation 前失败。

## 4. Runner 结构

保持三层，不继续泛化：

```text
V1 scenarios
  -> Shared business actions
     startClient / createBinding / createProfile / createRoot / approve / answerHuman / waitState
  -> Desktop UI actions
     LinuxDesktopUi | MacDesktopUi
```

共享 business actions 负责调用顺序、barrier、timeout、断言和 evidence。Linux/macOS adapter
只负责启动当前平台客户端、通过 WebdriverIO Tauri service 点击/输入/读取 UI、关闭客户端。
它们不解释 Root workflow、不调用 Linear、不决定下一步。

原生 repository picker 无法稳定由 WebView控制时，只允许一个 E2E build seam：UI 仍点击
“Choose Git repository”，真实 Tauri command 将 `SYMPHONY_E2E_REPOSITORY_PATH` 交给生产
`inspect_repository`。production build 不编译可启用入口，并用 architecture negative test 证明。

Linear app credential 也使用同样严格隔离的 E2E composition seam：把 client-credentials token
交给临时 Podium credential owner，Podium 仍是唯一 token owner，真实 `LinearSdkImpl` 调用
Linear；不伪造 refresh token、不写普通 OAuth installation row，production build 不可启用。

## 5. 固定场景

### S1 — 主业务闭环与 Profile

| 顺序 | 调用 | 必须观察到 | 立即失败条件 |
|---:|---|---|---|
| 1 | `preflight()`、获取 HELL 全局 E2E lock | credential、Project、repo、SDK/runtime 都匹配；尚无 mutation | 缺失、越界、已有活跃 E2E owner |
| 2 | `startClient()` | packaged Desktop、Podium sidecar启动；UI 显示 Linear connected | 任一进程退出、UI error、token 出现在 View/log |
| 3 | UI 选择 HELL、repo、base branch，`createBinding()` | 一个 Binding running，Conductor PID可见且 project label 唯一 | Project/repo read-back 不匹配、多个 project labels |
| 4 | UI 创建 primary API Key Profile，`setApiKey()`、`activate()` | SDK login succeeded/status ready；active=primary；Fast unavailable；Podium DB、profiles.json、View、request/result和日志均无 API Key | secret 出现在自定义持久化、JSON、log或View；ready/active不一致 |
| 5 | user 创建 Root A 并 delegate app actor | Root A 是 HELL 顶层 Todo、唯一 run prefix、delegation read-back成功 | 创建/委派任一步 read-back失败 |
| 6 | 等待 Conductor claim | Root A In Progress + planning；一个 managed comment/phase/branch/worktree | 无 ready Profile仍 claim；singleton重复；超时 |
| 7 | 等待 Plan 完成 | nested Tree parent/order与结果一致；一个 `[Human Action]` Plan Approval；phase awaiting-human | Plan 后已有 Work执行、Tree/order错误 |
| 8 | 在批准前观察一个稳定窗口 | Work全部保持 Todo；无 Work Turn/commit | 任一 Work提前运行 |
| 9 | user approve Plan | approval Done；phase working；下一 deepest ordered leaf被选择 | 旧 snapshot 推进、跳过更深/更早 leaf |
| 10 | 依次处理 Work/Human | 同时最多一个 Performer Turn；Human 出现时等待 user answer；之后严格继续顺序 | 并行 Turn、未回答 Human仍推进、错误顺序 |
| 11 | Root Gate | 成功前不 delivery；若 fixture产生 finding，则恰好一个 Rework，完成后重新 Gate | Gate失败仍交付、重复 Rework、Gate Issue被创建 |
| 12 | delivery | `gh` 可用时创建/复用 PR，否则明确 branch；Root In Review + in-review | 自动 Done、重复 PR/branch、Linear read-back失败 |
| 13 | UI 检查 usage/completed roots | Total Tokens best-effort，Completed Roots来自 Linear | secret/path泄漏、计数来源错误 |
| 14 | 创建 secondary API Key Profile并 activate | 同一 API Key再次走 secret frame；两个 Profile拥有不同 CODEX_HOME；Conductor PID不变 | 复制 primary CODEX_HOME、重启 Conductor、API Key进入持久化/View/log |
| 15 | 更新 secondary 的model/reasoning，创建 Root B（Root A 已 terminal） | Root A仍固定primary；Root B固定secondary；Root B下一 Turn的SDK invocation使用更新后的model/reasoning，Fast仍false | 两个Root同时runnable、Root A profile被改写、SDK参数仍为旧值或自动改写设置 |
| 16 | 执行最终secret与Codex-owned文件边界检查 | API Key扫描零命中；Symphony自定义存储/View/log无secret；产品代码路径没有读取/改写auth.json/config.toml的证据 | 任一secret命中，或发现Podium/Conductor直接访问Codex-owned文件 |

覆盖 A01、A03、A04、A05、A10、A11、A12、A19 的 API Key部分、A20、A21、A22、A23、A24。
ChatGPT live login 不执行，也不由 API Key evidence 冒充。

### S2 — Linear 权威与用户变化

每个 probe 使用独立 run-owned Root，按以下固定顺序执行：

1. 在 Turn boundary 移动/恢复 Conductor Project Label，验证下轮 resolution变化且旧 Result不推进（A02）；
2. Plan 后新增/重排 Sub Issue，验证下个 Turn full-read最新 Tree（A06）；
3. 修改 Root title/description，验证重新 Plan、reconcile未完成 Work、重新批准（A07）；
4. 修改一个 Work leaf，只重跑该 Work，不重做整棵 Plan（A08）；
5. cancel subtree，验证不进入 Root Gate 输入（A13）；
6. 损坏 In Review/Done Work metadata，验证 blocked且不会静默完成（A14）；
7. active Turn期间 Done/Canceled Root，验证旧 Result不能推进（A15）；
8. 制造 mutation precondition conflict，验证重新读且不覆盖 user state（A16）。

每步都必须保存 before/after remote version、Turn ID、预期状态；probe comment 使用明确
`[E2E Probe]`，不能伪装业务指令。一个 probe失败立即停止 S2。

### S3 — 恢复与收敛

1. 中断 Performer，验证同一 hashed `performer_id` 继续 In Progress Work（A09）；
2. 分别在 Work commit、input hash、Linear state 更新后中断一次，重启后收敛且不重复 commit/marker（A17）；
3. 替换 Conductor process tree，验证无 Conductor DB、从 Linear/Git/Profile恢复（A18）；
4. 禁用 `gh` 但保留 Git remote，验证明确 branch fallback 和复用（A11 branch）。

已知 failure必须立即写日志/evidence；不能等全局 timeout才暴露。

## 6. 验证失败与 Linear 停止规则

所有产品 Linear mutation：

```text
reread/compare -> mutate -> read-back
```

- retry只用于 429、明确 5xx、network、timeout；默认 `1s,2s,4s,8s,16s` + jitter；
- 401只重新获取一次 app token，仍计入总尝试；
- precondition conflict丢弃 snapshot并重新 full-read；
- project/repository mismatch、权限错误、非重试4xx立即失败；
- 耗尽后 Root进入 blocked，singleton managed comment写 sanitized error、attempt count、next action；
- 若 comment也写失败，user operator写 `[E2E Diagnostic]` comment并退出非零；
- 失败后禁止启动下一个 Turn、Git操作或 Linear业务状态推进。

## 7. 并行策略

允许并行：

- install/build、环境只读 preflight、Codex/Git/Linear只读健康检查；
- S1 与 S2/S3 的代码实现和 dry-run/contract tests；
- 到达稳定 barrier 后，对 UI、Linear snapshot、Git状态、日志/secret scan并行采证。

禁止并行：

- 对 HELL Project Label 的修改；
- 多个真实 Conductor Bindings；
- S1/S2/S3 的真实 mutation run；
- 同一 Root 的业务步骤；
- 多个 Performer Turns。

原因是 V1只有一个 Binding、一个全局 Performer lane，HELL Project Label也是共享资源。
本地和 CI 都必须获取同一个外部 lock；GitHub `concurrency` 只是第二层保护。

## 8. 命令与 verdict

```bash
npm run e2e:doctor
npm run e2e:build
npm run e2e:ui-smoke
npm run acceptance:v1 -- --scenario S1
npm run acceptance:v1 -- --scenario S2
npm run acceptance:v1 -- --scenario S3
npm run acceptance:evaluate
```

- Linux CI：`ubuntu-24.04` + Xvfb + Linux UI adapter；
- 本地 Linux：Linux UI adapter，使用现有 DISPLAY 或 Xvfb；
- 本地 macOS：macOS UI adapter；
- scenario、business actions、assertions、evidence完全共享。

`automated_api_key_v1_e2e` 可在 S1–S3全部通过后 passed。完整 Roadmap V1 verdict 在
ChatGPT live login 未验证前保持 incomplete。

## 9. Scope ledger

### authorized

- 上述固定 V1场景、Linux/macOS UI adapter、本地/CI相同环境输入和真实外部验收。

### required_consequences

- Linear权威、Podium token ownership、Performer SDK ownership、一个 API Key两个 Profile、
  bounded retry/comment/blocked/stop、一个 Task一个 commit。

### out_of_scope

- Windows UI、ChatGPT E2E、V2+、通用平台框架、production测试入口。

### assumptions_requiring_approval

- None。计划整体仍须用户批准。

### deferred_ideas

- ChatGPT人工 E2E、Windows UI、GitHub macOS matrix、nightly和长时稳定性。

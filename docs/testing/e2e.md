# Symphony Core Live E2E

状态：当前 E2E 验收规范。产品行为与验收事实由
[`docs/architecture/`](../architecture/README.md) 及
[`roadmap.md`](../architecture/roadmap.md) 定义；本文只规定如何取得这些事实的
运行证据。

## 1. 验收目标

仓库只维护一条权威的 workflow E2E：core live E2E。它在本机和受保护的
GitHub Actions 环境中运行同一命令，启动真实 Podium 服务、Conductor 进程和
逐 Turn Performer 进程，通过真实 Linear 与 Codex 边界，在全新的本地 Git
仓库中完成一个小 Root。

core live E2E 绕过 Podium Desktop、Tauri/WebView 和 Linear OAuth。另保留一条
无 secret 的 Desktop smoke，用于证明应用 shell 能启动；该 smoke 不证明
workflow、Linear 或 Provider 行为。

Desktop smoke 的唯一命令是 `npm run desktop-shell-smoke`。它构建 production
`main.rs`、production frontend、production backend `main.ts` 和 production
sidecars，不增加 E2E feature、capability、WebDriver 或 alternate composition。
运行时使用隔离的 HOME 和每次生成的惰性 OAuth 配置值，不读取任何 workflow
credential。runner 只接受 production host 输出的一次性 WebView loaded 和首次
Podium backend response 事件；证据写入 `.test/e2e-desktop-shell/`，其 verdict
不能满足 core live verdict。

## 2. 范围记录

### `authorized`

- 从本机 shell 或 GitHub Environment 传入 Linear Application development
  token、Codex API key、Codex base URL 和 model；
- 由 Podium 建立真实 `DevelopmentTokenInstallation`，使用真实 Linear SDK；
- 由 runner 通过生成的闭合 IPC contract 连接真实 Podium 与 Conductor；
- 通过 Conductor 现有 Profile command 和 bounded secret frame 创建、登录并
  activate 一个 API Key Performer Profile；
- 每次创建独立 Linear Project、Root、app data、`CODEX_HOME`、Git repository
  和 evidence directory；
- 执行真实 Plan、Work、Root Gate 和本地 branch delivery，并验证 Linear 最终
  为 In Review / `in-review`；
- 在受保护、串行化、仅可信 ref 可执行的 GitHub Actions job 中运行同一场景；
- 不维护旧 E2E entrypoint、E2E Podium composition、fake Linear client、
  temporary Store 或 hermetic workflow automation。

### `required_consequences`

- Linear credential bytes 只进入 Podium，不得出现在 Conductor 参数、环境、
  frame、日志或 evidence 中；
- Codex API key 只经 runner 持有的 secret buffer 和既有 bounded secret frame
  进入 Profile control；不得进入 Profile metadata、进程参数或普通环境；
- Codex base URL 是经验证的进程配置，经 public `CodexConfig` 映射，不是
  Profile 字段，也不通过改写 Codex 文件实现；
- 空状态由 run-scoped Linear/Git 资源产生，不通过 revoke 共享 credential；
- runner 只负责 transport、deadline、evidence 和 cleanup，不实现 Podium、
  Conductor 或 Performer 的业务逻辑；
- 未经过真实边界观察到的行为不得标为 live evidence。

### `out_of_scope`

- Linear OAuth、PKCE、callback、refresh 和 revoke 验收；
- ChatGPT login 验收；
- secret-bearing Desktop UI E2E；
- remote GitHub PR delivery；首个场景只验收本地 branch delivery；
- S2/S3 recovery、并发 Root、故障注入和 Conductor replacement；
- 自动对 fork pull request 或其他不可信代码提供 live secrets。

### `assumptions_requiring_approval`

无。core live 边界、pipeline credential、直接 Profile 配置以及 OAuth/Desktop UI
排除项已经获得批准。

### `deferred_ideas`

- Conductor replacement 与 mutation-conflict live 场景；
- remote branch push 和专用 repository 的 pull request delivery；
- 在成本、配额和 cleanup 责任明确后的 scheduled live run；
- 第二 Performer endpoint 或通用 Provider 配置产品能力。

## 3. 唯一运行拓扑

```text
core-live runner
  |-- Linear dev token --> Podium DevelopmentTokenInstallation
  |                         `-> real LinearSdkImpl
  |-- generated IPC ------> real Conductor process
  |                           |-- create API Key Profile
  |-- Codex API key ----------|-- set_api_key secret frame
  |                           `-> real Performer process per Turn
  |                               `-> Codex SDK -> configured base URL
  |-- run-scoped Linear Project and Root
  `-- run-scoped Git repository <- Work Turn mutation and branch delivery
```

以下实现禁止作为 workflow E2E 的替代路径：E2E-only Podium composition、fake
Linear client、`TemporaryPodiumStore`、`e2e-main.ts`、静态 `performer.json`、伪造
OAuth refresh token，以及把 Linear credential 传给 Conductor。单元或 contract
测试可以使用 test double，但它们不能生成 live verdict。

## 4. Core Live 场景

每次运行必须按以下有界顺序完成：

1. 读取并验证 pipeline inputs；日志只报告 secret 是否存在；
2. 获取全局/本地锁，再创建唯一 run marker 和隔离目录；
3. 用 development token 在 Podium 中 bootstrap installation，并通过真实 Linear
   SDK 验证 organization；
4. 启动真实 Podium services 和真实 Conductor executable，观察生成协议上的
   `ready` / `unbound` handshake；
5. 通过 Conductor 创建 API Key Profile，以 `set_api_key` secret frame 登录，
   等待 ready 后 activate；
6. 创建带唯一 marker 和 Conductor Project Label 的 Linear Project/Root，并
   初始化干净的本地 Git repository；
7. Root 要求创建一个内容精确包含 run marker 的文件；
8. 观察 Plan Turn 和 Plan Approval Node，批准后执行 Work Turn；
9. 观察不同 Performer 进程使用同一 opaque `performer_id` resume conversation；
10. 观察 Root Gate 成功、本地 branch delivery、Root In Review 和
    `in-review` phase；
11. 从交付 branch 读取目标文件并核对精确 marker；
12. 终止全部子进程，只清理由本 run marker 管理的 Project、Project Label 和本地
    资源；所有 cleanup 完成后才写入最终脱敏 evidence。

任何 startup、protocol、process exit、timeout、cleanup 或 secret audit 失败都使
场景失败。不得以 dry-run、合成 observation、mock SDK 输出或“blocked artifact”
代替步骤成功。

## 5. Roadmap V1 覆盖矩阵

状态含义：`covered` 表示 core live 场景应提供真实边界证据；`partially covered`
表示只覆盖该事实的一部分；`deferred` 表示本方案明确不宣称验收。

| # | 状态 | Core live 证据边界 |
|---:|---|---|
| 1 | covered | token 仅由 Podium bootstrap 和真实 Linear SDK 使用；Conductor 只走 Gateway |
| 2 | partially covered | 验证唯一 Project Label 解析；Turn 间 Label 切换 deferred |
| 3 | covered | 一个 Root 的 managed comment、phase、branch、worktree 均唯一 |
| 4 | covered | Plan 产生的嵌套 Tree 与 Linear parent/order 一致 |
| 5 | covered | Approval 前无 Work mutation，批准后才开始 Work |
| 6 | deferred | 用户新增或重排 Sub Issue 后重读 |
| 7 | deferred | Root 内容变化后的 replan/reconcile |
| 8 | deferred | Work Leaf 内容变化后的局部重跑 |
| 9 | covered | 分离的 Performer 进程以同一 `performer_id` resume Work |
| 10 | partially covered | 验证成功 Root Gate；失败后 Rework deferred |
| 11 | partially covered | 验证清晰的本地 branch delivery；PR 创建/复用 deferred |
| 12 | covered | Symphony 只推进 Root 到 In Review / `in-review` |
| 13 | deferred | Canceled Work/subtree 的 Gate 排除 |
| 14 | deferred | 非法或缺失 Work metadata 的 blocked 行为 |
| 15 | deferred | Turn 期间用户 Done/Canceled 后拒绝旧 Result |
| 16 | deferred | Linear mutation precondition conflict 后重读 |
| 17 | deferred | commit/hash/state 中断后的收敛 |
| 18 | partially covered | 场景使用无数据库 Conductor；重启恢复 deferred |
| 19 | partially covered | API Key Profile 通过 Codex SDK 登录；Desktop、多 Profile、ChatGPT deferred |
| 20 | covered | source/evidence audit 证明 Symphony 不读写 `auth.json` 或 `config.toml` |
| 21 | partially covered | activate 无需重启且新 Root 使用 active Profile；既有 Root 固定 Profile deferred |
| 22 | partially covered | model/reasoning 经 SDK 参数用于 Turn；Fast 变化 deferred |
| 23 | covered | API key canary 不进入自定义持久化、View、日志或 evidence |
| 24 | deferred | Desktop best-effort usage 与 Completed Roots 显示 |

本矩阵只定义 core live 场景的完成目标。场景尚未真实通过时，对应行不能被报告为
“已验收”。

## 6. 输入与 Secret 边界

唯一允许的运行输入为：

- `SYMPHONY_E2E_LINEAR_DEV_TOKEN`；
- `SYMPHONY_E2E_CODEX_API_KEY`；
- `SYMPHONY_E2E_CODEX_BASE_URL`；
- `SYMPHONY_E2E_CODEX_MODEL`。

不得加载 `.env` 或静态 Performer 文件。base URL 允许 HTTP 或 HTTPS，不得包含
userinfo、query 或 fragment；CI 中 host 必须在 workflow 配置的 allowlist 中。
runner 必须为每类子进程构造显式环境 allowlist，默认不继承两个 token。

本机唯一 credentialed 入口是 `npm run e2e:core-live`；`make e2e` 只负责安装、
按 Podium → Conductor 顺序构建、运行 secret-free runner contracts，再调用同一
入口。Make 前置步骤显式移除两项 secret，只有最终 live 命令可读取它们。两种
入口都从当前 shell 读取上述四项输入，不读取 `.env`。

GitHub Actions 只能从受保护 Environment 向可信 ref 注入 secrets，使用全局
concurrency 防止共享 Linear authority 并发执行。pull request merge gate 运行
secret-free contract/unit tests 和 Desktop smoke，不运行 core live。受保护的 live
入口是 `.github/workflows/roadmap-v1-e2e.yml`，只允许在 `main` 上手动执行，并调用
与本机相同的 `npm run e2e:core-live`。

## 7. Evidence 与清理

- runner 默认向 stderr 输出逐行 JSON 日志，每行包含 timestamp、run_id 和稳定 event；
- step 开始/完成/失败、Conductor stdout/stderr/exit、Profile control 命令、Linear
  GraphQL 错误和每项 cleanup 均实时输出；最终机器可读 verdict 单独写入 stdout；
- 日志只包含 allowlisted 诊断字段，不包含 request variables、authorization header、
  secret frame 或 Profile credential；已知 secret 在序列化前递归脱敏；
- evidence 只包含 run ID、步骤状态、计数、公开 Linear identifier、Git ref、
  稳定 reason code 和相对路径；
- stdout/stderr、request/result、Profile files 和 evidence 必须用已知 secret
  canary 扫描；不得上传 `CODEX_HOME`、app data、repository 或原始 backend log；
- 每步有 deadline，首个失败停止后续 mutation；异常文本归一化为稳定 code；
- cleanup 必须幂等，只 archive/delete 精确匹配当前 managed marker 的资源；
  `cleanup_completed` 是 live verdict 的必需证据，任一 cleanup 失败都会使其失败；
- 下次运行在 mutation 前 reconcile 同一测试 authority 留下的 stale managed run；
- runner 必须在成功和失败路径有界关闭 Podium、Conductor、Performer 和 IPC。

## 8. 完成标准

- 同一个 core live 命令在本机和一次受保护 GitHub Actions run 中完成小 Root；
- 真实 `SqlitePodiumStoreImpl`、Podium production services、Conductor `main.ts`、
  Performer processes、`LinearSdkImpl` 和固定版本 Codex SDK 全部位于证据链；
- 同一 `performer_id` 跨 Plan/Work 等独立 Performer 进程延续；
- 交付 branch 中的目标文件精确包含 run marker，Linear 最终为 In Review /
  `in-review`；
- secret scan、focused checks、`make lint`、`make typecheck`、`make test-all` 和
  `make build` 全部通过；
- 旧 alternate E2E runtime、fake composition、temporary Store 和 hermetic
  workflow automation 已删除，仅保留不宣称 workflow coverage 的 Desktop smoke。

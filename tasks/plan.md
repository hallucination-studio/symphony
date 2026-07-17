# Roadmap V1 固定场景 E2E 计划

**状态：** E0 已实现；E1-E3 待后续 task 逐项实现。

## 1. 设计

```text
E0 shared runner + env + Linux/macOS UI actions
 ├── E1 S1 主业务闭环/Profile
 └── E2 S2 Linear权威 + S3恢复收敛
          ↓
E3 Linux CI + 本地入口 + evidence/verdict
```

E1、E2 在 E0 后可并行实现；真实运行通过 HELL全局 lock串行。平台差异只保留在 UI
action层，其余业务调用顺序、barrier、断言、operator、fault和evidence全部共享。

## 2. 每个 Task 的提交规则

每个 Task 恰好一个 commit。commit前：

1. 写 scope ledger；
2. 先写失败测试/negative control；
3. 运行 code-simple；
4. 运行五轴 code-review；
5. finding分类 accepted/rejected/deferred，不接受无架构依据的需求扩大；
6. 运行精确验证、secret scan、`git diff --check`。

只反向放行 Git跟踪 `tasks/*.md`、`tasks/scope-ledgers/*.md`、`tasks/reviews/*.md`；
runtime evidence、screenshots、credentials、Profile/CODEX_HOME继续忽略。

## 3. Tasks

### E0 — 建立共享 runner、环境注入和 Linux/macOS UI actions

**状态：** 已实现。真实 packaged smoke 因本地 preflight 缺少必需配置而未运行，未声称 Roadmap 验收通过。

**架构依据：** `roadmap.md` §§3–8；`podium-desktop.md`；`linear-flow.md`；
`performer-profiles.md`。

**包含：**

- `.env`/CI同名配置 loader、preflight、HELL/repo allowlist、全局 lock；
- 固定 step runner：调用、deadline、expected observation、fail-fast、evidence；
- 共享 business actions，不包含平台判断；
- WebdriverIO Tauri UI actions，只有 Linux和macOS启动/点击/输入/读取差异；
- E2E-only repository picker和Linear app credential composition seam；production negative controls；
- 一个 API Key创建两个 Profile的secret-frame/readiness contract；
- Linear bounded retry/read-back/comment/blocked/stop；
- automated API Key verdict与完整 Roadmap verdict分离。

**验收：** Linux/macOS UI adapter通过同一 UI action contract；Linux packaged smoke和本地当前平台
smoke都能完成启动、connected、HELL/repo、Binding、primary Profile ready/active；production binary
无法启用 E2E seams；任何 secret/allowlist/preflight失败发生在首次 mutation前。

**验证：**

```bash
make install
npm run e2e:doctor
npm run e2e:build
npm run test:e2e:runner
npm run e2e:ui-smoke
npm run test:architecture
npm run package
git diff --check
```

**Commit：** `test(e2e): establish the fixed V1 runner`

### E1 — 实现 S1 主业务闭环和 Profile验收

**依赖：** E0。可与 E2并行实现。

严格实现 `tasks/spec.md#5-固定场景` 的 S1步骤1–16，不在实现中重新解释流程。

**覆盖：** A01、A03、A04、A05、A10、A11(PR)、A12、A19(API Key)、A20、A21、A22、A23、A24。

**关键 barrier：** Plan批准前零 Work；Human回答前零推进；Gate成功前零delivery；Root A terminal
后才创建 Root B，避免扩到V2；Profile切换不重启Conductor且不改变Root A固定Profile。

**验证：**

```bash
npm run test:e2e:scenarios -- --scenario S1
npm run acceptance:v1 -- --scenario S1 --dry-run
npm run test
git diff --check
```

**Commit：** `test(e2e): prove the fixed V1 root journey`

### E2 — 实现 S2 Linear权威和 S3恢复收敛验收

**依赖：** E0。可与 E1并行实现。

严格实现 `tasks/spec.md#5-固定场景` 的 S2八个 probes和 S3四个恢复步骤。每个 probe
独立 Root、固定输入、固定 barrier、固定预期；任一步失败立即停止当前 scenario。

**覆盖：** A02、A06–A09、A11(branch)、A13–A18。

**关键限制：** fault只发生在test-owned process boundary；不增加checkpoint/journal；Project Label
probe独占HELL全局lock；known failure立即产出日志/evidence。

**验证：**

```bash
npm run test:e2e:scenarios -- --scenario S2
npm run test:e2e:scenarios -- --scenario S3
npm run acceptance:v1 -- --scenario S2 --dry-run
npm run acceptance:v1 -- --scenario S3 --dry-run
npm run test
git diff --check
```

**Commit：** `test(e2e): prove V1 authority and recovery`

### E3 — 接入 Linux CI、本地入口和验收 verdict

**依赖：** E1、E2。

**包含：**

- GitHub `workflow_dispatch`、protected Environment、`ubuntu-24.04`、Xvfb、`concurrency: 1`；
- GitHub Secrets映射为与本地 `.env` 相同的环境变量；
- install/build/read-only preflight适当并行；真实 S1→S2→S3串行；
- 稳定 barrier后的 UI/Linear/Git/log evidence可并行收集；
- 失败仍执行sanitized artifact collection和run-owned cleanup；
- local Linux/macOS和CI使用同一 `e2e:doctor/e2e:build/acceptance:v1`入口；
- automated API Key verdict可passed；完整 Roadmap verdict因ChatGPT未测保持incomplete。

**验证：**

```bash
npm run e2e:doctor
npm run test:acceptance
npm run acceptance:v1 -- --preflight
npm run acceptance:evaluate
npm run lint
npm run typecheck
npm run test
npm run build
npm run package
git diff --check
```

然后由 Environment reviewer批准一次真实 Linux workflow run。

**Commit：** `ci(e2e): run the fixed V1 journey on Linux`

## 4. Definition of Done

- S1–S3每一步都有调用、预期、deadline和立即失败条件；
- Linux/macOS只在UI action层分叉；
- 本地 `.env` 和CI使用相同环境变量；
- 真实HELL mutation串行，安全准备/采证适当并行；
- Linear失败comment/blocked/stop；
- 一个API Key、两个产品Profile、两次secret-frame login；
- production binary无法启用E2E seams；
- 不把ChatGPT未测冒充完整V1 passed；
- 一个Task一个commit，commit前code-review+code-simple；
- 用户批准后才开始E0。

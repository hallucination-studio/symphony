# Roadmap V1 固定场景 E2E Tasks

**状态：E0 已实现；后续 task 仍按依赖和单 commit 规则迭代。**

- [x] E0 — 共享 runner、`.env`/CI环境、固定 step runner、Linux/macOS UI actions、E2E seams
  - Dependencies: none
  - Acceptance: Linux/macOS同一UI contract；packaged smoke完成connected→HELL/repo→Binding→primary Profile ready/active；production negative controls通过
  - Verify: `make install && npm run e2e:doctor && npm run e2e:build && npm run test:e2e:runner && npm run e2e:ui-smoke && npm run test:architecture && npm run package`
  - Before commit: scope ledger；code-simple；五轴code-review；finding decisions；secret scan；`git diff --check`
  - One commit: `test(e2e): establish the fixed V1 runner`
  - Residual verification: 本地 preflight 缺少必需配置，真实 packaged smoke 未运行；fail-closed guard 已验证

- [ ] E1 — S1主业务闭环和两个API Key Profiles
  - Dependencies: E0
  - Parallel: 可与E2并行实现；真实HELL运行必须串行
  - Covers: A01, A03, A04, A05, A10, A11(PR), A12, A19(API Key), A20, A21, A22, A23, A24
  - Source: `tasks/spec.md#s1--主业务闭环与-profile`步骤1–16
  - Verify: `npm run test:e2e:scenarios -- --scenario S1 && npm run acceptance:v1 -- --scenario S1 --dry-run && npm run test`
  - Before commit: scope ledger；code-simple；五轴code-review；拒绝V2/ChatGPT扩散；secret scan；`git diff --check`
  - One commit: `test(e2e): prove the fixed V1 root journey`

- [ ] E2 — S2 Linear权威和S3恢复收敛
  - Dependencies: E0
  - Parallel: 可与E1并行实现；真实HELL运行必须串行
  - Covers: A02, A06–A09, A11(branch), A13–A18
  - Source: `tasks/spec.md#s2--linear-权威与用户变化`、`#s3--恢复与收敛`
  - Verify: `npm run test:e2e:scenarios -- --scenario S2 && npm run test:e2e:scenarios -- --scenario S3 && npm run acceptance:v1 -- --scenario S2 --dry-run && npm run acceptance:v1 -- --scenario S3 --dry-run && npm run test`
  - Before commit: scope ledger；code-simple；五轴code-review；probe/fault/log review；拒绝checkpoint/journal；`git diff --check`
  - One commit: `test(e2e): prove V1 authority and recovery`

- [ ] E3 — Linux CI、本地Linux/macOS入口、并行准备/采证和双层verdict
  - Dependencies: E1, E2
  - Execution: prepare/read-only checks并行；S1→S2→S3真实mutation串行；stable-barrier evidence并行
  - Verdict: automated API Key E2E可passed；full Roadmap V1因ChatGPT live login未测保持incomplete
  - Verify: `npm run e2e:doctor && npm run test:acceptance && npm run acceptance:v1 -- --preflight && npm run acceptance:evaluate && npm run lint && npm run typecheck && npm run test && npm run build && npm run package`，再批准一次真实Linux workflow
  - Before commit: scope ledger；code-simple；五轴code-review；least privilege；secret scan；`git diff --check`
  - One commit: `ci(e2e): run the fixed V1 journey on Linux`

## 全局停止条件

- 用户尚未批准；
- `.env`/CI secret缺失，或HELL/repository不匹配；
- 无法获取HELL全局E2E lock；
- production binary可启用E2E seam；
- Codex SDK/runtime、Profile ready/active或packaged client失败；
- 任一Linear mutation在bounded retry/read-back后失败；
- 无法写具体sanitized error comment；
- secret/path/provenance scan失败；
- review意见超出架构且未获批准。

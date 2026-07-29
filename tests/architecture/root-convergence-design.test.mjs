import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = process.cwd();

async function architectureSource(name) {
  return readFile(`${root}/docs/architecture/${name}`, "utf8");
}

test("Root architecture separates deterministic convergence from four semantic gates", async () => {
  const source = await architectureSource("root-reconciliation.md");

  for (const required of [
    "mechanical_target",
    "semantic_gate",
    "external_wait",
    "terminal",
    "invalid_facts",
    "requirement_and_comment",
    "plan_human_decision",
    "recovery_strategy",
    "terminal_review",
  ]) {
    assert.match(source, new RegExp(`\\b${required}\\b`, "u"), `missing ${required}`);
  }

  assert.doesNotMatch(source, /Root Reconciler逐个选择ready/u);
  assert.doesNotMatch(source, /每turn返回one bounded RootNextAction/u);
  assert.doesNotMatch(source, /MaterializePlanNodeAction/u);
});

test("Conductor owns every uniquely derivable happy-path transition", async () => {
  const source = await architectureSource("conductor.md");

  for (const required of [
    "initial Cycle creation",
    "complete Plan DAG materialization",
    "ready Work selection",
    "Stage dispatch",
    "immutable Verify target preparation",
    "successful Cycle closure",
  ]) {
    assert.match(source, new RegExp(required, "u"), `missing ${required}`);
  }

  assert.doesNotMatch(source, /workflow next step只来自Root Reconciler/u);
});

test("recovery authority assigns uniquely derivable interruption and worktree repair to mechanical transition", async () => {
  const source = await architectureSource("workflow-authority-recovery.md");

  assert.match(source, /Conductor机械收敛为`Interrupted`/u);
  assert.match(source, /mechanical workspace rematerialization target/u);
  assert.doesNotMatch(source, /RecordStageInterruptionAction/u);
  assert.doesNotMatch(source, /Root Reconciler可以返回\s*\n?\s*mechanical workspace target/u);
  assert.match(source, /当前同步dispatch调用栈/u);
  assert.match(source, /fresh transition观察到`In Progress`/u);
});

test("interrupted Work and Verify continue through a successor Cycle without a fictional replacement relation", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const rootIssue = await architectureSource("root-issue.md");

  assert.match(rootReconciliation, /Interrupted` Work或Verify[\s\S]{0,500}fresh `Planning` successor Cycle/u);
  assert.match(recovery, /Interrupted` Work或Verify[\s\S]{0,500}approved DAG/u);
  assert.match(rootIssue, /Work与Verify[\s\S]{0,500}successor Cycle/u);
  assert.doesNotMatch(rootIssue, /新的执行必须创建fresh\s*\n?Issue，并以native predecessor\/replacement relation连接/u);
});

test("end-Cycle recovery remains durable and reaches non-success terminal review", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");

  assert.match(rootReconciliation, /end_current_cycle[\s\S]{0,1200}Recovery Exhausted[\s\S]{0,500}terminal_review/u);
  assert.match(recovery, /Recovery Exhausted[\s\S]{0,800}terminal_review/u);
  assert.match(rootReconciliation, /non-success[\s\S]{0,500}deliver_verified_revision/u);
});

test("current-Cycle replan persists authorization before mechanically replacing the old DAG", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const rootIssue = await architectureSource("root-issue.md");

  assert.match(rootReconciliation, /replan_current_cycle[\s\S]{0,1200}Cycle Replan[\s\S]{0,800}fresh Plan/u);
  assert.match(recovery, /Cycle Replan[\s\S]{0,1200}leaf-first[\s\S]{0,800}Planning/u);
  assert.match(rootIssue, /Cycle Replan[\s\S]{0,900}terminal identity/u);
});

test("current-Cycle repair has role-specific topology and never reuses terminal identities", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const rootIssue = await architectureSource("root-issue.md");
  const stages = await architectureSource("stage-orchestration.md");

  assert.match(rootReconciliation, /repair_current_cycle[\s\S]{0,1800}Cycle Repair[\s\S]{0,1200}fresh Verify/u);
  assert.match(recovery, /Interrupted Work[\s\S]{0,1400}blocks[\s\S]{0,500}blocked_by/u);
  assert.match(recovery, /Interrupted Verify[\s\S]{0,1400}Cycle回到`Executing`/u);
  assert.match(rootIssue, /Cycle Repair[\s\S]{0,1000}terminal identity/u);
  assert.match(stages, /repair Work[\s\S]{0,1200}fresh Verify[\s\S]{0,900}immutable target/u);
});

test("terminal Stage recovery requires exact native conclusion provenance", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const stages = await architectureSource("stage-orchestration.md");

  assert.match(rootReconciliation, /stage_blocked \| stage_failed \| stage_inconclusive/u);
  assert.match(rootReconciliation, /canonical human-readable `## Outcome`[\s\S]{0,300}field-specific provenance/u);
  assert.match(rootReconciliation, /latest Activity actor[\s\S]{0,500}label history/u);
  assert.match(recovery, /`Failed`或`Done`不足以区分blocked、failed与inconclusive/u);
  assert.match(stages, /verify_changes_required[\s\S]{0,300}native recovery authority/u);
});

test("Finding recovery freezes one complete native set and materializes only a set-wide waiver barrier", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const humanActions = await architectureSource("human-actions.md");

  assert.match(rootReconciliation, /完整开放Finding集合[\s\S]{0,900}全部native relation topology/u);
  assert.match(rootReconciliation, /Changes Required Verify[\s\S]{0,300}delegate actor[\s\S]{0,300}immutable creator/u);
  assert.match(rootReconciliation, /Relation actor[\s\S]{0,400}不能单独授权/u);
  assert.match(recovery, /Interrupted predecessor[\s\S]{0,500}latest status Activity[\s\S]{0,500}successor[\s\S]{0,300}immutable creator/u);
  assert.match(recovery, /Cycle Replan[\s\S]{0,900}Recovery Source[\s\S]{0,500}Interrupted Stage[\s\S]{0,500}immutable creator/u);
  assert.match(recovery, /Cycle Repair[\s\S]{0,1200}Interrupted (?:Work|Verify)[\s\S]{0,500}repair Work[\s\S]{0,500}fresh Verify[\s\S]{0,400}同一actor/u);
  assert.match(recovery, /Interrupted Stage Recovery[\s\S]{0,700}latest status Activity actor[\s\S]{0,500}successor immutable creator[\s\S]{0,300}同一actor/u);
  assert.match(recovery, /Terminal Review Successor[\s\S]{0,700}successful predecessor Cycle[\s\S]{0,500}current `Succeeded` status Activity actor[\s\S]{0,500}successor immutable creator/u);
  assert.match(rootReconciliation, /waiver intent[\s\S]{0,300}`finding_waiver`[\s\S]{0,300}target全部开放Finding/u);
  assert.match(recovery, /fresh compiler必须重算完全相同的集合/u);
  assert.match(humanActions, /每个Finding exactly once/u);
  assert.doesNotMatch(rootReconciliation, /has_open_findings.*足以/u);
});

test("Finding waiver resolution persists visible adoption before one-effect convergence", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const humanActions = await architectureSource("human-actions.md");
  const contracts = await architectureSource("contracts.md");

  assert.match(contracts, /request_human_decision[\s\S]{0,500}resolve_finding_waiver/u);
  assert.match(contracts, /accepted \| rejected \| needs_clarification/u);
  assert.match(rootReconciliation, /resolve_finding_waiver[\s\S]{0,1000}adoption reply/u);
  assert.match(rootReconciliation, /adoption reply[\s\S]{0,700}不得[^。]{0,120}(?:receipt|resolve)/u);
  assert.match(recovery, /originally mentioned Finding set[\s\S]{0,900}每次只[^。]{0,100}一个Finding/u);
  assert.match(recovery, /全部[^。]{0,100}Finding[\s\S]{0,500}receipt[\s\S]{0,300}resolve/u);
  assert.match(humanActions, /adoption reply[\s\S]{0,700}native authorization barrier/u);
  assert.match(humanActions, /request、authorized human reply[\s\S]{0,700}current Activity/u);
  assert.doesNotMatch(humanActions, /waiver[^\n]{0,120}(?:hidden JSON|进程内intent).*authority/u);
});

test("Finding recovery can end only the exact frozen Cycle and preserves unresolved evidence", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const stages = await architectureSource("stage-orchestration.md");

  assert.match(rootReconciliation, /Cycle ID\/current version[\s\S]{0,900}Finding ID\/current version\/status/u);
  assert.match(rootReconciliation, /Finding-set `end_current_cycle`[\s\S]{0,500}不得修改、关闭、archive或relabel任何Finding/u);
  assert.match(recovery, /Finding保持unresolved[\s\S]{0,500}non-success `terminal_review`/u);
  assert.match(stages, /Cycle terminal update[\s\S]{0,500}Finding evidence保持不变/u);
});

test("a hard Cycle repair limit has one mechanical terminal consequence", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const conductor = await architectureSource("conductor.md");

  assert.match(rootReconciliation, /`max_cycle_repair_attempts`[\s\S]{0,700}不调用Root Reconciler/u);
  assert.match(rootReconciliation, /fresh Tree重算[\s\S]{0,500}Recovery Exhausted/u);
  assert.match(recovery, /Stage session fence[\s\S]{0,600}non-success\s+`terminal_review`/u);
  assert.match(conductor, /repair-attempt hard limit[\s\S]{0,400}mechanical Cycle closure/u);
});

test("the repeated Finding limit requires a directed adjacent-Cycle lineage and one mechanical consequence", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const conductor = await architectureSource("conductor.md");

  assert.match(rootReconciliation, /`max_same_open_finding_cycles`[\s\S]{0,700}有向单链/u);
  assert.match(rootReconciliation, /反向、分叉、合并[\s\S]{0,500}invalid facts/u);
  assert.match(rootReconciliation, /predecessor已经Done\/Canceled[\s\S]{0,200}从1重新计数/u);
  assert.match(rootReconciliation, /Stage[\s\S]{0,100}session fence[\s\S]{0,800}Recovery Exhausted/u);
  assert.match(rootReconciliation, /Finding、Verify、Work和relation[\s\S]{0,300}保持不变/u);
  assert.match(rootReconciliation, /actor分类为`unknown`[\s\S]{0,400}不能把`actor_kind: symphony`设为正确性前提/u);
  assert.match(recovery, /undirected connectivity[\s\S]{0,500}hard-limit authority/u);
  assert.match(recovery, /terminal tip[\s\S]{0,300}non-success `terminal_review`/u);
  assert.match(conductor, /repeated-Finding hard limit[\s\S]{0,300}directed single-chain lineage/u);
  assert.doesNotMatch(rootReconciliation, /max_same_open_finding_cycles[^\n]{0,200}generic `convergence_limit_reached` Root turn/u);
});

test("convergence policy does not expose an unreachable subjective no-progress limit", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const contractSchema = await readFile(
    `${root}/packages/contracts/schemas/conductor-performer/conductor-performer.schema.json`,
    "utf8",
  );
  const policySource = await readFile(
    `${root}/apps/conductor/src/root-reconciliation/api/RootConvergence.ts`,
    "utf8",
  );

  assert.match(rootReconciliation, /不定义`max_consecutive_no_progress`/u);
  assert.match(recovery, /Changes Required[\s\S]{0,500}至少一个`Done` Work/u);
  assert.doesNotMatch(contractSchema, /max_consecutive_no_progress|consecutive_no_progress/u);
  assert.doesNotMatch(policySource, /maxConsecutiveNoProgress|consecutiveNoProgress|max_consecutive_no_progress/u);
});

test("the Root Cycle cap closes only terminal successor capability", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const contracts = await architectureSource("contracts.md");
  const conductor = await architectureSource("conductor.md");

  assert.match(rootReconciliation, /`max_cycles_per_root`[\s\S]{0,500}关闭的是successor capability/u);
  assert.match(rootReconciliation, /successor_cycle_policy: allowed \| cycle_limit_reached/u);
  assert.match(rootReconciliation, /达到上限[\s\S]{0,400}delivery[\s\S]{0,300}Human decision[\s\S]{0,300}halt/u);
  assert.match(rootReconciliation, /严格超过policy[\s\S]{0,500}fail closed/u);
  assert.match(contracts, /successor_cycle_policy: allowed \| cycle_limit_reached[\s\S]{0,500}fresh native Cycle count/u);
  assert.match(conductor, /max-Cycles[\s\S]{0,400}zero mutation/u);
  assert.doesNotMatch(rootReconciliation, /max_cycles_per_root[^\n]{0,200}convergence_limit_reached semantic turn/u);
});

test("the Root deadline closes execution admission without erasing completed success evidence", async () => {
  const rootReconciliation = await architectureSource("root-reconciliation.md");
  const contracts = await architectureSource("contracts.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");
  const conductor = await architectureSource("conductor.md");

  assert.match(rootReconciliation, /Root lifetime `deadline_at`[\s\S]{0,700}passed Verify[\s\S]{0,500}root_deadline_reached/u);
  assert.match(rootReconciliation, /Recovery Abandoned[\s\S]{0,500}Deadline Exceeded/u);
  assert.match(rootReconciliation, /changes-requested[\s\S]{0,300}不得在deadline后重新打开recovery/u);
  assert.match(contracts, /allowed \| cycle_limit_reached \| root_deadline_reached/u);
  assert.match(recovery, /session fence[\s\S]{0,500}第二个[\s\S]{0,300}Root/u);
  assert.match(conductor, /Root deadline关闭execution admission[\s\S]{0,500}successor/u);
  assert.doesNotMatch(rootReconciliation, /deadline_exceeded[^\n]{0,200}generic limit gate/u);
});

test("initial requirement read-back leads to one restart-derivable Cycle and Plan desired state", async () => {
  const source = await architectureSource("root-reconciliation.md");

  assert.match(source, /Root `Todo`.*`requirement_and_comment`/u);
  assert.match(source, /Root description[\s\S]{0,200}Root `In Progress`[\s\S]{0,200}targeted read-back/u);
  assert.match(source, /`converge_initial_cycle_plan`/u);
  assert.match(source, /Cycle与Plan之间不调用Root Reconciler/u);
  assert.match(source, /每个effect后使用fresh facts重新编译remaining effect/u);
  assert.match(source, /initial Plan只是`Todo` shell/u);
  assert.match(source, /不得伪装成approved Plan Contract/u);
});

test("architecture closes external effects and distinguishes delivery intent from acceptance", async () => {
  const contracts = await architectureSource("contracts.md");
  const delivery = await architectureSource("git-worktree-delivery.md");
  const recovery = await architectureSource("workflow-authority-recovery.md");

  for (const required of [
    "not_applied",
    "applied",
    "acceptance_unknown",
    "precondition_failed",
    "readback_mismatch",
  ]) {
    assert.match(contracts, new RegExp(`\\b${required}\\b`, "u"), `missing ${required}`);
  }

  assert.match(delivery, /Delivery Intent/u);
  assert.match(delivery, /Remote SCM Acceptance/u);
  assert.match(delivery, /Root Terminal Completion/u);
  assert.match(delivery, /Attachment manifest actor[\s\S]{0,500}`attachment_changed` Activity[\s\S]{0,500}Git\/SCM/u);
  assert.match(recovery, /Delivery Recovery[\s\S]{0,700}Root current `In Review` status Activity actor[\s\S]{0,500}successor immutable creator/u);
});

test("the implementation roadmap starts with architecture authority and progressive acceptance", async () => {
  const source = await architectureSource("roadmap.md");

  assert.match(source, /R0：架构authority与progressive acceptance/u);
  assert.match(source, /L0-L4/u);
  assert.match(source, /14-Root campaign/u);
  assert.match(source, /最后/u);
});

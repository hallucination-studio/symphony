import { readFile, writeFile } from "node:fs/promises";

import { EvidenceReader } from "./evidence-reader.mjs";

export async function runDeterministicScenario({ world, linear, agent, createPullRequest }) {
  const root = await linear.readRoot();
  const comments = await linear.listRootCommentsAfter();
  const cycle = await linear.createCycle({
    objective: "Write one verified result file.",
    acceptance: "A fresh read-only Audit confirms the exact result file.",
    boundaries: "Only one result file may change.",
    consumedCommentIds: comments.map((comment) => comment.id),
  });
  const executeRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    objective: cycle.objective,
    working_directory: world.workspace,
    sandbox: "workspace_write",
    final_response_path: `${world.runDirectory}/cycle-001-executor-result.md`,
  });
  const execute = await agent.execute(executeRequest, world);
  const executorResultPath = `${world.runDirectory}/cycle-001-executor-result.md`;
  const executorMarkdown = await readFile(executorResultPath, "utf8").catch(() => "");
  await linear.recordExecute(cycle.id, {
    launch_status: execute.launch_status,
    ...(execute.exit_code === undefined ? {} : { exit_code: execute.exit_code }),
  });
  await linear.createComment(cycle.execute_issue?.id ?? `execute-${cycle.id}`, executorMarkdown || "Executor result missing.");
  const auditRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    acceptance: cycle.acceptance,
    working_directory: world.workspace,
    sandbox: "read_only",
    final_response_path: `${world.runDirectory}/cycle-001-audit-result.md`,
  });
  const audit = await agent.audit(auditRequest, world);
  const auditResult = audit.result ?? audit;
  const auditResponsePath = `${world.runDirectory}/cycle-001-audit-result.md`;
  const auditMarkdown = await readFile(auditResponsePath, "utf8").catch(() => "");
  const auditJsonPath = `${world.runDirectory}/cycle-001-audit-result.json`;
  await writeFile(auditJsonPath, `${JSON.stringify(auditResult)}\n`, { encoding: "utf8", mode: 0o600 });
  const persistedAudit = JSON.parse(await readFile(auditJsonPath, "utf8"));
  await linear.recordAudit(cycle.id, persistedAudit);
  await linear.createComment(cycle.audit_issue?.id ?? `audit-${cycle.id}`, auditMarkdown || "Audit result missing.");
  await writeFile(
    `${world.runDirectory}/deterministic-evidence.jsonl`,
    `${JSON.stringify({ event: "execute", launch_status: execute.launch_status })}\n${JSON.stringify({ event: "audit", verdict: auditResult.verdict })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const cycleResult = auditResult.verdict === "accepted"
    ? "succeeded"
    : auditResult.verdict === "incomplete" ? "rejected" : "failed";
  const uploadOutcome = await uploadAuditResult(linear, auditJsonPath);
  await linear.createComment(cycle.id, cycleResultComment({
    cycleResult, audit: persistedAudit, uploadOutcome, auditIssueId: cycle.audit_issue?.id ?? `audit-${cycle.id}`,
  }));
  await linear.finishCycle(cycle.id, cycleResult, uploadOutcome);

  if (cycleResult !== "succeeded") {
    await linear.writeRootState({
      workspace_path: world.workspace,
      run_directory: world.runDirectory,
      root_branch: world.rootBranch,
      current_phase: "NeedsHuman",
      task_state_markdown: "No independently audited task progress yet.",
      pending_finding: auditResult.pending_finding
        ?? auditResult.findings?.[0]
        ?? auditResult.scope_audited
        ?? auditResult.implementation_review
        ?? auditResult.reason,
      latest_audit: persistedAudit,
    });
    return Object.freeze({ status: "rejected", cycle_result: cycleResult, audit: persistedAudit });
  }

  await linear.writeRootState({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "publishing",
    task_state_markdown: auditResult.task_state_markdown,
    latest_audit: persistedAudit,
  });
  await world.commit("deterministic verified result");
  await world.push();
  const pullRequestUrl = await createPullRequest({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
  });
  await linear.writeRootState({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "completed",
    task_state_markdown: auditResult.task_state_markdown,
    latest_audit: persistedAudit,
    pull_request_url: pullRequestUrl,
  });
  await linear.setRootStatus("completed");
  return Object.freeze({
    status: "done",
    cycle_result: cycleResult,
    audit: persistedAudit,
    pull_request_url: pullRequestUrl,
    evidence: await new EvidenceReader(world, linear).read(),
  });
}

async function uploadAuditResult(linear, filePath) {
  const filename = filePath.split("/").at(-1);
  try {
    const result = await linear.uploadFile(filename, "application/json", await readFile(filePath));
    return Object.freeze({ filename, status: "uploaded", content_type: "application/json", url: result.url });
  } catch (error) {
    const reason = error instanceof Error && error.message.length > 0
      ? error.message.slice(0, 50)
      : "file_upload_failed";
    return Object.freeze({ filename, status: "failed", reason });
  }
}

function cycleResultComment({ cycleResult, audit, uploadOutcome, auditIssueId }) {
  const reason = audit.verdict === "process_error"
    ? audit.reason
    : audit.implementation_review ?? audit.findings?.[0] ?? audit.scope_audited;
  return [
    "## Cycle Result",
    `- Result: ${cycleResult}`,
    `- Audit Issue: ${auditIssueId}`,
    `- Audit verdict: ${audit.verdict}`,
    `- Reason: ${reason}`,
    uploadOutcome.status === "uploaded"
      ? `- Audit result: [${uploadOutcome.filename}](${uploadOutcome.url})`
      : `- Audit result: upload failed (${uploadOutcome.reason})`,
  ].join("\n");
}

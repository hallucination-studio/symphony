import { readFile, writeFile } from "node:fs/promises";

import { EvidenceReader } from "./evidence-reader.mjs";
import { formatLocalTimestamp } from "./linear-driver.mjs";

export async function runDeterministicScenario({ world, linear, agent, createPullRequest }) {
  const root = await linear.readRoot();
  const comments = await linear.listRootCommentsAfter();
  const cycle = await linear.createCycle({
    objective: "Write one verified result file.",
    acceptance: "A fresh read-only Critic confirms the exact result file.",
    boundaries: "Only one result file may change.",
    consumedCommentIds: comments.map((comment) => comment.id),
  });
  await linear.createComment(cycle.id, [
    "# Symphony Harness: Reconcile",
    "",
    "### Why Continue",
    "The requested result file is not yet independently verified.",
    "",
    "### Evidence",
    "No accepted Critic has verified the current workspace.",
    "",
    "### Next Cycle",
    "Create and audit the requested result file.",
  ].join("\n"));
  const artistRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    objective: cycle.objective,
    working_directory: world.workspace,
    sandbox: "workspace_write",
    final_response_path: `${world.runDirectory}/cycle-001-artist-result.md`,
  });
  const artist = await agent.artist(artistRequest, world);
  const artistResultPath = `${world.runDirectory}/cycle-001-artist-result.md`;
  const artistMarkdown = await readFile(artistResultPath, "utf8").catch(() => "");
  await linear.recordArtist(cycle.id, {
    launch_status: artist.launch_status,
    ...(artist.exit_code === undefined ? {} : { exit_code: artist.exit_code }),
  });
  await linear.updateIssueDescription(
    cycle.artist_issue?.id ?? `artist-${cycle.id}`,
    `${cycle.artist_issue?.description ?? "# Task\n\nArtist\n\n# Symphony Metadata\n\n## Role\n\nArtist"}\n\n# Result\n\nUpdated at: ${formatLocalTimestamp()}\n\n${artistMarkdown || "Artist result missing."}`,
  );
  const criticRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    acceptance: cycle.acceptance,
    working_directory: world.workspace,
    sandbox: "read_only",
    final_response_path: `${world.runDirectory}/cycle-001-critic-result.md`,
  });
  const critic = await agent.critic(criticRequest, world);
  const critique = critic.result ?? critic;
  const criticResponsePath = `${world.runDirectory}/cycle-001-critic-result.md`;
  const criticMarkdown = await readFile(criticResponsePath, "utf8").catch(() => "");
  const critiqueJsonPath = `${world.runDirectory}/cycle-001-critique-result.json`;
  await writeFile(critiqueJsonPath, `${JSON.stringify(critique)}\n`, { encoding: "utf8", mode: 0o600 });
  const persistedCritic = JSON.parse(await readFile(critiqueJsonPath, "utf8"));
  await linear.recordCritic(cycle.id, persistedCritic);
  await linear.updateIssueDescription(
    cycle.critic_issue?.id ?? `critic-${cycle.id}`,
    `${cycle.critic_issue?.description ?? "# Task\n\nCritic\n\n# Symphony Metadata\n\n## Role\n\nCritic"}\n\n# Result\n\nUpdated at: ${formatLocalTimestamp()}\n\n${criticMarkdown || "Critique missing."}`,
  );
  await writeFile(
    `${world.runDirectory}/deterministic-evidence.jsonl`,
    `${JSON.stringify({ event: "artist", launch_status: artist.launch_status })}\n${JSON.stringify({ event: "critique", verdict: critique.verdict })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const cycleResult = critique.verdict === "accepted"
    ? "succeeded"
    : critique.verdict === "incomplete" ? "rejected" : "failed";
  const uploadOutcome = await uploadCriticResult(linear, critiqueJsonPath);
  await linear.createComment(cycle.id, cycleResultComment({
    cycleResult, critique: persistedCritic, uploadOutcome, criticIssueId: cycle.critic_issue?.id ?? `critic-${cycle.id}`,
  }));
  await linear.finishCycle(cycle.id, cycleResult, uploadOutcome);

  if (cycleResult !== "succeeded") {
    await linear.writeRootState({
      workspace_path: world.workspace,
      run_directory: world.runDirectory,
      root_branch: world.rootBranch,
      current_phase: "NeedsHuman",
      task_state_markdown: "No independently audited task progress yet.",
      pending_finding: critique.pending_finding
        ?? critique.findings?.[0]
        ?? critique.scope_reviewed
        ?? critique.implementation_review
        ?? critique.reason,
      latest_critique: persistedCritic,
    });
    return Object.freeze({ status: "rejected", cycle_result: cycleResult, critic: persistedCritic });
  }

  await linear.writeRootState({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "publishing",
    task_state_markdown: critique.task_state_markdown,
    latest_critique: persistedCritic,
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
    task_state_markdown: critique.task_state_markdown,
    latest_critique: persistedCritic,
    pull_request_url: pullRequestUrl,
  });
  await linear.setRootStatus("completed");
  return Object.freeze({
    status: "done",
    cycle_result: cycleResult,
    critic: persistedCritic,
    pull_request_url: pullRequestUrl,
    evidence: await new EvidenceReader(world, linear).read(),
  });
}

async function uploadCriticResult(linear, filePath) {
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

function cycleResultComment({ cycleResult, critique, uploadOutcome, criticIssueId }) {
  const reason = critique.verdict === "process_error"
    ? critique.reason
    : critique.implementation_review ?? critique.findings?.[0] ?? critique.scope_reviewed;
  return [
    "## Cycle Result",
    `- Result: ${cycleResult}`,
    `- Critic Issue: ${criticIssueId}`,
    `- Critic verdict: ${critique.verdict}`,
    `- Reason: ${reason}`,
    uploadOutcome.status === "uploaded"
      ? `- Critique: [${uploadOutcome.filename}](${uploadOutcome.url})`
      : `- Critique: upload failed (${uploadOutcome.reason})`,
  ].join("\n");
}

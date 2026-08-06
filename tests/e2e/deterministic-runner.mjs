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
  await linear.updateIssueStatus(cycle.id, "in_progress");
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
  await linear.setRootStatus("in_progress");
  const artistRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    objective: cycle.objective,
    working_directory: world.workspace,
    sandbox: "workspace_write",
    final_response_path: `${world.runDirectory}/cycle-001-artist-result.md`,
  });
  await linear.updateIssueStatus(cycle.artist_issue.id, "in_progress");
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
  await linear.updateIssueStatus(cycle.artist_issue.id, "done");
  await linear.updateIssueStatus(cycle.id, "in_review");
  await linear.updateIssueStatus(cycle.critic_issue.id, "in_review");
  const criticRequest = Object.freeze({
    root_id: root.id,
    cycle_id: cycle.id,
    acceptance: cycle.acceptance,
    working_directory: world.workspace,
    sandbox: "read_only",
    final_response_path: `${world.runDirectory}/cycle-001-critic-result.md`,
  });
  const critic = await agent.critic(criticRequest, world);
  const envelope = critic.result ?? critic;
  const criticResponsePath = `${world.runDirectory}/cycle-001-critic-result.md`;
  const criticMarkdown = await readFile(criticResponsePath, "utf8").catch(() => "");
  const critiqueJsonPath = `${world.runDirectory}/cycle-001-critique-result.json`;
  const artifact = Object.freeze({
    envelope,
    report_markdown: criticMarkdown || "Critique missing.",
  });
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  await writeFile(critiqueJsonPath, artifactBytes, { mode: 0o600 });
  await linear.recordCritic(cycle.id, envelope);
  await linear.updateIssueDescription(
    cycle.critic_issue?.id ?? `critic-${cycle.id}`,
    `${cycle.critic_issue?.description ?? "# Task\n\nCritic\n\n# Symphony Metadata\n\n## Role\n\nCritic"}\n\n# Result\n\nUpdated at: ${formatLocalTimestamp()}\n\n${criticMarkdown || "Critique missing."}`,
  );
  await linear.updateIssueStatus(cycle.critic_issue.id, "done");
  await writeFile(
    `${world.runDirectory}/deterministic-evidence.jsonl`,
    `${JSON.stringify({ event: "artist", launch_status: artist.launch_status })}\n${JSON.stringify({ event: "critique", verdict: envelope.verdict })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const cycleResult = envelope.verdict === "accepted"
    ? "succeeded"
    : envelope.verdict === "incomplete" ? "rejected" : "failed";
  const uploadOutcome = await uploadCriticResult(linear, critiqueJsonPath, artifactBytes);
  const checkpoint = Object.freeze({
    ...envelope,
    ...(uploadOutcome.status === "uploaded" ? { artifact_url: uploadOutcome.url } : {}),
  });
  await linear.createComment(cycle.id, cycleResultComment({
    cycleResult,
    uploadOutcome,
    criticIssue: cycle.critic_issue ?? {
      identifier: `critic-${cycle.id}`,
      url: `https://linear.example/issue/critic-${cycle.id}`,
    },
  }));
  await linear.finishCycle(cycle.id, cycleResult, uploadOutcome);
  await linear.setRootStatus("in_review");

  if (cycleResult !== "succeeded") {
    await linear.writeRootState({
      workspace_path: world.workspace,
      run_directory: world.runDirectory,
      root_branch: world.rootBranch,
      current_phase: "NeedsHuman",
      task_state_markdown: "No independently audited task progress yet.",
      latest_critique: checkpoint,
    });
    return Object.freeze({
      status: "rejected",
      cycle_result: cycleResult,
      critic: checkpoint,
      artifact,
      evidence: await new EvidenceReader(world, linear).read(),
    });
  }

  await linear.writeRootState({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "publishing",
    task_state_markdown: envelope.task_state_markdown,
    latest_critique: checkpoint,
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
    task_state_markdown: envelope.task_state_markdown,
    latest_critique: checkpoint,
    delivery: { kind: "pull_request", url: pullRequestUrl, branch: world.rootBranch },
  });
  await linear.setRootStatus("done");
  return Object.freeze({
    status: "done",
    cycle_result: cycleResult,
    critic: checkpoint,
    artifact,
    pull_request_url: pullRequestUrl,
    evidence: await new EvidenceReader(world, linear).read(),
  });
}

async function uploadCriticResult(linear, filePath, bytes) {
  const filename = filePath.split("/").at(-1);
  try {
    const result = await linear.uploadFile(filename, "application/json", bytes);
    return Object.freeze({ filename, status: "uploaded", content_type: "application/json", url: result.url });
  } catch (error) {
    const reason = error instanceof Error && error.message.length > 0
      ? error.message.slice(0, 50)
      : "file_upload_failed";
    return Object.freeze({ filename, status: "failed", reason });
  }
}

function cycleResultComment({ cycleResult, uploadOutcome, criticIssue }) {
  return [
    "## Cycle Result",
    `- Result: ${cycleResult}`,
    `- Critic: [${criticIssue.identifier}](${criticIssue.url})`,
    uploadOutcome.status === "uploaded"
      ? `- Critique: [${uploadOutcome.filename}](${uploadOutcome.url})`
      : `- Critique: upload failed (${uploadOutcome.reason})`,
  ].join("\n");
}

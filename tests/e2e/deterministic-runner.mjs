import { readFile, writeFile } from "node:fs/promises";

import { EvidenceReader } from "./evidence-reader.mjs";
import { formatLocalTimestamp, runHumanActionScenario } from "./linear-driver.mjs";
import { assertScenario } from "./scenario-catalog.mjs";

const DEFAULT_CYCLE = Object.freeze({
  objective: "Write one verified result file.",
  acceptance: "A fresh read-only Critic confirms the exact result file.",
  boundaries: "Only one result file may change.",
});

function cycleLabel(number) {
  return String(number).padStart(3, "0");
}

async function appendRunEvidence(world, record) {
  const file = `${world.runDirectory}/deterministic-evidence.jsonl`;
  const previous = await readFile(file, "utf8").catch(() => "");
  await world.writeRunFile("deterministic-evidence.jsonl", `${previous}${JSON.stringify(record)}\n`);
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

async function runCycle({ world, linear, agent, cycleNumber, architectureDecisions, cycle = DEFAULT_CYCLE }) {
  const root = await linear.readRoot();
  const comments = await linear.listRootCommentsAfter();
  const cycleTag = cycleLabel(cycleNumber);
  const createdCycle = await linear.createCycle({
    ...cycle,
    architectureDecisions,
    consumedCommentIds: comments.map((comment) => comment.id),
  });
  await linear.updateIssueStatus(createdCycle.id, "in_progress");
  await linear.createComment(createdCycle.id, [
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
    cycle_id: createdCycle.id,
    objective: createdCycle.objective,
    working_directory: world.workspace,
    sandbox: "workspace_write",
    final_response_path: `${world.runDirectory}/cycle-${cycleTag}-artist-result.md`,
  });
  await linear.updateIssueStatus(createdCycle.artist_issue.id, "in_progress");
  const artist = await agent.artist(artistRequest, world);
  const artistPath = `${world.runDirectory}/cycle-${cycleTag}-artist-result.md`;
  const artistMarkdown = await readFile(artistPath, "utf8").catch(() => "");
  await linear.recordArtist(createdCycle.id, {
    launch_status: artist.launch_status,
    ...(artist.exit_code === undefined ? {} : { exit_code: artist.exit_code }),
  });
  await linear.updateIssueDescription(
    createdCycle.artist_issue.id,
    `${createdCycle.artist_issue.description}\n\n# Result\n\nUpdated at: ${formatLocalTimestamp()}\n\n${artistMarkdown || "Artist result missing."}`,
  );
  await linear.updateIssueStatus(createdCycle.artist_issue.id, "done");
  await linear.updateIssueStatus(createdCycle.id, "in_review");
  await linear.updateIssueStatus(createdCycle.critic_issue.id, "in_review");

  const criticRequest = Object.freeze({
    root_id: root.id,
    cycle_id: createdCycle.id,
    acceptance: createdCycle.acceptance,
    architecture_decisions: architectureDecisions,
    working_directory: world.workspace,
    sandbox: "read_only",
    final_response_path: `${world.runDirectory}/cycle-${cycleTag}-critic-result.md`,
  });
  const critic = await agent.critic(criticRequest, world);
  const envelope = critic.result ?? critic;
  const criticPath = `${world.runDirectory}/cycle-${cycleTag}-critic-result.md`;
  const criticMarkdown = await readFile(criticPath, "utf8").catch(() => "");
  const critiqueJsonPath = `${world.runDirectory}/cycle-${cycleTag}-critique-result.json`;
  const artifact = Object.freeze({
    envelope,
    report_markdown: criticMarkdown || "Critique missing.",
  });
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  await writeFile(critiqueJsonPath, artifactBytes, { mode: 0o600 });
  await linear.recordCritic(createdCycle.id, envelope);
  await linear.updateIssueDescription(
    createdCycle.critic_issue.id,
    `${createdCycle.critic_issue.description}\n\n# Result\n\nUpdated at: ${formatLocalTimestamp()}\n\n${criticMarkdown || "Critique missing."}`,
  );
  await linear.updateIssueStatus(createdCycle.critic_issue.id, "done");
  await appendRunEvidence(world, { event: "artist", cycle: cycleNumber, launch_status: artist.launch_status });
  await appendRunEvidence(world, { event: "critique", cycle: cycleNumber, verdict: envelope.verdict });

  const cycleResult = envelope.verdict === "accepted"
    ? "succeeded"
    : envelope.verdict === "incomplete" ? "rejected" : "failed";
  const uploadOutcome = await uploadCriticResult(linear, critiqueJsonPath, artifactBytes);
  const checkpoint = Object.freeze({
    ...envelope,
    ...(uploadOutcome.status === "uploaded" ? { artifact_url: uploadOutcome.url } : {}),
  });
  await linear.createComment(createdCycle.id, cycleResultComment({
    cycleResult,
    uploadOutcome,
    criticIssue: createdCycle.critic_issue,
  }));
  await linear.finishCycle(createdCycle.id, cycleResult, uploadOutcome);
  await linear.setRootStatus("in_review");
  const currentState = await linear.readRootState();
  await linear.writeRootState({
    ...(currentState ?? {}),
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "idle",
    task_state_markdown: cycleResult === "succeeded"
      ? envelope.task_state_markdown
      : (currentState?.task_state_markdown ?? "No independently audited task progress yet."),
    latest_critique: checkpoint,
    architecture_decisions: currentState?.architecture_decisions ?? architectureDecisions,
  });
  return Object.freeze({
    cycle: (await linear.snapshot()).cycles.at(-1),
    cycle_result: cycleResult,
    critic: checkpoint,
    artifact,
  });
}

async function finishDeterministicRoot({ world, linear, createPullRequest, taskState, latestCritique }) {
  const state = await linear.readRootState();
  await linear.writeRootState({
    ...(state ?? {}),
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "publishing",
    task_state_markdown: taskState,
    latest_critique: latestCritique,
    architecture_decisions: state?.architecture_decisions ?? [],
  });
  await world.commit("deterministic verified result");
  await world.push();
  const pullRequestUrl = await createPullRequest({
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
  });
  await linear.writeRootState({
    ...(state ?? {}),
    workspace_path: world.workspace,
    run_directory: world.runDirectory,
    root_branch: world.rootBranch,
    current_phase: "completed",
    task_state_markdown: taskState,
    latest_critique: latestCritique,
    architecture_decisions: state?.architecture_decisions ?? [],
    delivery: { kind: "pull_request", url: pullRequestUrl, branch: world.rootBranch },
  });
  await linear.setRootStatus("done");
  return pullRequestUrl;
}

export async function runDeterministicScenario({
  scenario = "single-cycle",
  world,
  linear,
  agent,
  createPullRequest,
} = {}) {
  assertScenario(scenario);
  if (world === undefined || linear === undefined || agent === undefined
    || typeof createPullRequest !== "function") {
    throw new Error("deterministic_scenario_fixture_invalid");
  }
  const root = await linear.readRoot();
  await linear.addRootComment(`Run ${scenario}.`);

  if (scenario === "human-action-unanswered") {
    const action = await runHumanActionScenario({ linear, mode: "unanswered" });
    return Object.freeze({
      scenario,
      status: "needs_human",
      root: root.id,
      action,
      evidence: await new EvidenceReader(world, linear).read(),
    });
  }

  if (scenario === "single-cycle-human-action") {
    await runHumanActionScenario({ linear, mode: "accepted" });
  } else if (scenario === "human-action-rejected-supplement") {
    await runHumanActionScenario({ linear, mode: "rejected_then_supplement" });
  }

  let first;
  if (scenario === "multi-cycle") {
    first = await runCycle({ world, linear, agent, cycleNumber: 1, architectureDecisions: [] });
    if (first.cycle_result !== "rejected") throw new Error("multi_cycle_first_cycle_not_rejected");
  } else if (scenario === "cycle-human-action-cycle") {
    first = await runCycle({ world, linear, agent, cycleNumber: 1, architectureDecisions: [] });
    if (first.cycle_result !== "succeeded") throw new Error("human_action_cycle_first_cycle_invalid");
    await runHumanActionScenario({ linear, mode: "accepted" });
  }

  const state = await linear.readRootState();
  const final = await runCycle({
    world,
    linear,
    agent,
    cycleNumber: first === undefined ? 1 : 2,
    architectureDecisions: state?.architecture_decisions ?? [],
  });
  if (final.cycle_result !== "succeeded") {
    return Object.freeze({
      scenario,
      status: "rejected",
      root: root.id,
      cycle_result: final.cycle_result,
      evidence: await new EvidenceReader(world, linear).read(),
    });
  }
  const pullRequestUrl = await finishDeterministicRoot({
    world,
    linear,
    createPullRequest,
    taskState: final.critic.task_state_markdown,
    latestCritique: final.critic,
  });
  return Object.freeze({
    scenario,
    status: "done",
    root: root.id,
    cycle_result: final.cycle_result,
    critic: final.critic,
    artifact: final.artifact,
    pull_request_url: pullRequestUrl,
    evidence: await new EvidenceReader(world, linear).read(),
  });
}

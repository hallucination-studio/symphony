import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AgentDriver } from "./agent-driver.mjs";
import { runDeterministicScenario } from "./deterministic-runner.mjs";
import { LinearDriver } from "./linear-driver.mjs";
import { createScenarioWorld } from "./scenario-world.mjs";

test("serial fake Linear and Agent flow uses real filesystem/Git and publishes one PR", async (context) => {
  const world = await createScenarioWorld();
  context.after(() => world.cleanup());
  await symlink(`${world.workspace}/README.md`, `${world.runDirectory}/diagnostic-link`);
  const linear = new LinearDriver({ root: { id: world.rootId, identifier: "ENG-1" } });
  await linear.addRootComment("Write the verified result.");
  const agent = new AgentDriver({
    artist: [async (request, currentWorld) => {
      assert.equal(request.sandbox, "workspace_write");
      await currentWorld.write("result.txt", "verified\n");
      await currentWorld.writeRunFile("cycle-001-artist-result.md", [
        "## Summary",
        "Created the requested result file and ran the focused verification.",
        "",
        "## File Changes",
        "### Created",
        "- result.txt (+1/-0 lines)",
        "### Updated",
        "- None",
        "### Deleted",
        "- None",
        "",
        "## Verification",
        "- Read back result.txt and confirmed the expected content.",
        "",
      ].join("\n"));
      return { launch_status: "exited", exit_code: 0, final_output: "untrusted execute prose" };
    }],
    critic: [async (request, currentWorld) => {
      assert.equal(request.sandbox, "read_only");
      assert.equal(await currentWorld.read("result.txt"), "verified\n");
      await currentWorld.writeRunFile("cycle-001-critic-result.md", [
        "verdict: accepted",
        "",
        "## Scope Reviewed",
        "Inspected the complete workspace diff and result.txt.",
        "",
        "## Implementation Review",
        "The requested file is present with the expected content.",
        "",
        "## Checks",
        "- result.txt matches the frozen acceptance",
        "",
        "## Evidence",
        "- Read-only inspection passed",
        "",
        "## Findings",
        "- None",
        "",
        "## Task State",
        "The verified result is present.",
        "",
      ].join("\n"));
      return {
        verdict: "accepted",
        scope_reviewed: "Inspected the complete workspace diff and result.txt.",
        implementation_review: "The requested file is present with the expected content.",
        checks: ["result.txt matches the frozen acceptance"],
        evidence: ["read-only inspection passed"],
        findings: [],
        task_state_markdown: "The verified result is present.",
      };
    }],
  });
  const result = await runDeterministicScenario({
    world,
    linear,
    agent,
    createPullRequest: async (request) => {
      assert.equal(request.root_branch, world.rootBranch);
      assert.equal(await world.remoteHas("result.txt"), "verified\n");
      return "https://github.example/pull/1";
    },
  });

  assert.equal(result.status, "done");
  assert.equal(result.pull_request_url, "https://github.example/pull/1");
  assert.equal(result.evidence.workspace.status, "");
  assert.equal(result.evidence.publicState.root.status, "completed");
  assert.equal(result.evidence.publicState.cycles[0].result, "succeeded");
  assert.equal(result.evidence.runEvidence.length, 4);
  assert.deepEqual(result.evidence.runEvidence.map(({ name }) => name).sort(), [
    "cycle-001-artist-result.md", "cycle-001-critic-result.md", "cycle-001-critique-result.json", "deterministic-evidence.jsonl",
  ]);
  assert.equal(result.evidence.publicState.cycles[0].artist.final_output, undefined);
  const artistIssueId = result.evidence.publicState.cycles[0].artist_issue.id;
  const criticIssueId = result.evidence.publicState.cycles[0].critic_issue.id;
  const cycleId = result.evidence.publicState.cycles[0].id;
  const comments = result.evidence.publicState.comments;
  const artistDescription = result.evidence.publicState.cycles[0].artist_issue.description;
  assert.match(artistDescription, /^# Task\n/u);
  assert.match(artistDescription, /# Symphony Metadata\n/u);
  assert.match(artistDescription, /# Result\n/u);
  assert.match(artistDescription, /## Summary\n/u);
  assert.match(artistDescription, /## File Changes/u);
  assert.match(artistDescription, /result\.txt \(\+1\/-0 lines\)/u);
  const criticDescription = result.evidence.publicState.cycles[0].critic_issue.description;
  assert.match(criticDescription, /^# Task\n/u);
  assert.match(criticDescription, /# Symphony Metadata\n/u);
  assert.match(criticDescription, /# Result\n/u);
  assert.match(criticDescription, /verdict: accepted\n/u);
  assert.match(criticDescription, /## Scope Reviewed[\s\S]*## Implementation Review[\s\S]*## Findings/u);
  assert.equal(comments.some((comment) => comment.issue_id === artistIssueId), false);
  assert.equal(comments.some((comment) => comment.issue_id === criticIssueId), false);
  const cycleComments = comments.filter((comment) => comment.issue_id === cycleId).map((comment) => comment.body);
  assert.equal(cycleComments.some((body) => body.includes("## Scope Reviewed")), false);
  assert.match(cycleComments.at(-1) ?? "", /- Critique: \[cycle-001-critique-result\.json\]\(https:\/\/linear\.example\/upload\/1\)/u);
  assert.deepEqual(result.evidence.publicState.uploads.map(({ filename, content_type }) => ({ filename, content_type })), [
    { filename: "cycle-001-critique-result.json", content_type: "application/json" },
  ]);
  const critiqueJsonText = await readFile(path.join(world.runDirectory, "cycle-001-critique-result.json"), "utf8");
  assert.deepEqual(JSON.parse(critiqueJsonText), result.critic);
  assert.equal(result.evidence.publicState.uploads[0].contents, critiqueJsonText);
  assert.deepEqual(result.evidence.publicState.root_state.latest_critique, result.critic);
  assert.deepEqual(agent.calls.map((call) => call.role), ["artist", "critic"]);
});

test("failed Artist still gets a fresh Critic and leaves partial workspace changes for inspection", async (context) => {
  const world = await createScenarioWorld();
  context.after(() => world.cleanup());
  const linear = new LinearDriver({ root: { id: world.rootId, identifier: "ENG-1" } });
  const agent = new AgentDriver({
    artist: [async (_request, currentWorld) => {
      await currentWorld.write("partial.txt", "partial change\n");
      await currentWorld.writeRunFile("cycle-001-artist-result.md", [
        "## Summary",
        "The workspace change was left partial after the process timed out.",
        "",
        "## File Changes",
        "### Created",
        "- partial.txt (+1/-0 lines)",
        "### Updated",
        "- None",
        "### Deleted",
        "- None",
        "",
        "## Verification",
        "- Process timed out before full verification.",
        "",
      ].join("\n"));
      return { launch_status: "timed_out", sanitized_reason: "agent_timeout" };
    }],
    critic: [async (request, currentWorld) => {
      assert.equal(request.sandbox, "read_only");
      assert.equal(await currentWorld.read("partial.txt"), "partial change\n");
      await currentWorld.writeRunFile("cycle-001-critic-result.md", [
        "verdict: blocked",
        "",
        "## Scope Reviewed",
        "Inspected the complete workspace diff after the timed-out Artist.",
        "",
        "## Implementation Review",
        "The partial file does not establish the requested completed behavior.",
        "",
        "## Checks",
        "- partial workspace inspected",
        "",
        "## Evidence",
        "- None",
        "",
        "## Findings",
        "- The requested behavior is incomplete.",
        "",
        "## Task State",
        "Repair the partial change.",
        "",
      ].join("\n"));
      return {
        verdict: "blocked",
        scope_reviewed: "Inspected the complete workspace diff after the timed-out Artist.",
        implementation_review: "The partial file does not establish the requested completed behavior.",
        checks: ["partial workspace inspected"],
        evidence: [],
        findings: ["The requested behavior is incomplete."],
        pending_finding: "Repair the partial change.",
      };
    }],
  });
  let createPullRequestCalls = 0;
  const result = await runDeterministicScenario({
    world,
    linear,
    agent,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return "https://github.example/pull/never";
    },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.cycle_result, "failed");
  assert.equal(createPullRequestCalls, 0);
  assert.match(await world.status(), /\?\? partial\.txt/u);
  assert.equal((await linear.readRoot()).status, "todo");
  assert.deepEqual(agent.calls.map((call) => call.role), ["artist", "critic"]);
});

test("Critic JSON upload failure is visible without changing the Critic verdict", async (context) => {
  const world = await createScenarioWorld();
  context.after(() => world.cleanup());
  const linear = new LinearDriver({
    root: { id: world.rootId, identifier: "ENG-1" },
    uploadFailures: ["provider file upload failed after the current boundary message grows"],
  });
  const agent = new AgentDriver({
    artist: [async (_request, currentWorld) => {
      await currentWorld.write("result.txt", "verified\n");
      await currentWorld.writeRunFile("cycle-001-artist-result.md", [
        "## Summary", "Created the verified result file.", "", "## File Changes",
        "### Created", "- result.txt (+1/-0 lines)", "### Updated", "- None",
        "### Deleted", "- None", "", "## Verification", "- Read back result.txt.", "",
      ].join("\n"));
      return { launch_status: "exited", exit_code: 0 };
    }],
    critic: [async (_request, currentWorld) => {
      await currentWorld.writeRunFile("cycle-001-critic-result.md", [
        "verdict: accepted", "", "## Scope Reviewed", "Inspected the complete workspace diff.", "",
        "## Implementation Review", "The requested file is present.", "", "## Checks", "- None", "",
        "## Evidence", "- Read-only inspection passed", "", "## Findings", "- None", "",
        "## Task State", "Verified.", "",
      ].join("\n"));
      return {
        verdict: "accepted", scope_reviewed: "Inspected the complete workspace diff.",
        implementation_review: "The requested file is present.", checks: [], evidence: [], findings: [],
        task_state_markdown: "Verified.",
      };
    }],
  });
  const result = await runDeterministicScenario({
    world,
    linear,
    agent,
    createPullRequest: async () => "https://github.example/pull/attachment-failure",
  });

  assert.equal(result.status, "done");
  assert.equal(result.critic.verdict, "accepted");
  assert.equal(result.evidence.publicState.root_state.latest_critique.verdict, "accepted");
  assert.equal(result.evidence.publicState.cycles[0].upload_outcome.status, "failed");
  assert.equal(result.evidence.publicState.cycles[0].upload_outcome.reason,
    "provider file upload failed after the current boundary message grows".slice(0, 50));
  const cycleComment = result.evidence.publicState.comments
    .filter((comment) => comment.issue_id === result.evidence.publicState.cycles[0].id)
    .at(-1)?.body ?? "";
  assert.match(cycleComment, /- Critique: upload failed \(provider file upload failed/u);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";
import { runConductorRestartRecoveryCase } from "../../tools/e2e/conductor-restart-recovery.mjs";
import { forceKillOwnedProcess } from "../../tools/e2e/runtime-owner.mjs";

test("restart recovery Case creates both Roots, kills only the affected Conductor, and approves product-created Plan Reviews", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "conductor_restart_recovery");
  const calls = [];
  const human = {
    actorId: "human-1",
    async createRootIssue(input) {
      calls.push({ kind: "create_root", input });
      return input.rootKey === "affected-root"
        ? { rootIssueId: "affected-root-id", identifier: "ENG-1" }
        : { rootIssueId: "continuous-root-id", identifier: "ENG-2" };
    },
    async assertRootUndelegatedAndInactive(input) {
      calls.push({ kind: "assert_undelegated", input });
    },
    async delegateRootIssue(input) {
      calls.push({ kind: "delegate_root", input });
    },
    async waitForRestartRecoveryAdmission(input) {
      calls.push({ kind: "wait_for_admission", input });
      return { affectedRootIssueId: "affected-root-id", interruptedStageIssueId: "old-execution" };
    },
    async waitForPlanApprovalRequest(input) {
      calls.push({ kind: "wait_for_plan_review", input });
      return { requestCommentId: `${input.rootIssueId}-request`, planIssueId: `${input.rootIssueId}-plan` };
    },
    async replyToHumanAction(input) {
      calls.push({ kind: "approve_plan_review", input });
    },
  };
  const runtime = {
    async killAndRestartConductor(input) {
      calls.push({ kind: "kill_and_restart", input });
      return { conductorId: input.conductorId };
    },
  };
  const rootCreationsByRootKey = {
    "affected-root": rootCreation("route-a", "conductor-a", "profile-a", "/repositories/a"),
    "continuous-root": rootCreation("route-b", "conductor-b", "profile-b", "/repositories/b"),
  };

  const result = await runConductorRestartRecoveryCase({ definition, human, runtime, rootCreationsByRootKey });

  assert.deepEqual(calls, [
    { kind: "create_root", input: rootCreateInput("affected-root", rootCreationsByRootKey["affected-root"]) },
    { kind: "create_root", input: rootCreateInput("continuous-root", rootCreationsByRootKey["continuous-root"]) },
    { kind: "assert_undelegated", input: { rootIssueId: "affected-root-id" } },
    { kind: "assert_undelegated", input: { rootIssueId: "continuous-root-id" } },
    { kind: "delegate_root", input: { rootIssueId: "affected-root-id" } },
    { kind: "delegate_root", input: { rootIssueId: "continuous-root-id" } },
    {
      kind: "wait_for_admission",
      input: { affectedRootIssueId: "affected-root-id", continuousRootIssueId: "continuous-root-id" },
    },
    { kind: "kill_and_restart", input: { conductorId: "conductor-a" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "affected-root-id" } },
    { kind: "wait_for_plan_review", input: { rootIssueId: "continuous-root-id" } },
    { kind: "approve_plan_review", input: { rootIssueId: "affected-root-id", requestCommentId: "affected-root-id-request", body: "Approved." } },
    { kind: "approve_plan_review", input: { rootIssueId: "continuous-root-id", requestCommentId: "continuous-root-id-request", body: "Approved." } },
  ]);
  assert.deepEqual(result, {
    context: {
      humanActorId: "human-1",
      rootIssueIdsByKey: {
        "affected-root": "affected-root-id",
        "continuous-root": "continuous-root-id",
      },
      recovery: {
        affectedRootId: "affected-root-id",
        continuousRootId: "continuous-root-id",
        interruptedStageIssueId: "old-execution",
        affectedConductorId: "conductor-a",
        continuousConductorId: "conductor-b",
        affectedRoutingLabelId: "route-a",
        continuousRoutingLabelId: "route-b",
        affectedPerformerProfileId: "profile-a",
        continuousPerformerProfileId: "profile-b",
        affectedRepositoryRoot: "/repositories/a/affected-root-id",
        continuousRepositoryRoot: "/repositories/b/continuous-root-id",
      },
    },
  });
});

test("restart recovery Case rejects noncanonical topology, non-owning runtime faults, and invalid admission", async () => {
  const definition = FOREGROUND_E2E_CASES.find(({ caseId }) => caseId === "conductor_restart_recovery");
  const human = {
    actorId: "human-1",
    async createRootIssue({ rootKey }) { return { rootIssueId: `${rootKey}-id`, identifier: "ENG-1" }; },
    async assertRootUndelegatedAndInactive() {},
    async delegateRootIssue() {},
    async waitForRestartRecoveryAdmission() {
      return { affectedRootIssueId: "continuous-root-id", interruptedStageIssueId: "old-execution" };
    },
    async waitForPlanApprovalRequest() { return { requestCommentId: "request", planIssueId: "plan" }; },
    async replyToHumanAction() {},
  };
  const runtime = { async killAndRestartConductor() { return { conductorId: "conductor-a" }; } };
  const rootCreationsByRootKey = {
    "affected-root": rootCreation("route-a", "conductor-a", "profile-a", "/repositories/a"),
    "continuous-root": rootCreation("route-b", "conductor-b", "profile-b", "/repositories/b"),
  };

  await assert.rejects(
    runConductorRestartRecoveryCase({ definition: { ...definition, caseId: "approved_happy_path" }, human, runtime, rootCreationsByRootKey }),
    hasCode("foreground_e2e_recovery_case_definition_invalid"),
  );
  await assert.rejects(
    runConductorRestartRecoveryCase({ definition, human, runtime, rootCreationsByRootKey }),
    hasCode("foreground_e2e_recovery_admission_invalid"),
  );
  const admittedHuman = {
    ...human,
    async waitForRestartRecoveryAdmission() {
      return { affectedRootIssueId: "affected-root-id", interruptedStageIssueId: "old-execution" };
    },
  };
  await assert.rejects(
    runConductorRestartRecoveryCase({ definition, human: admittedHuman, runtime: { async killAndRestartConductor() { return { conductorId: "conductor-b" }; } }, rootCreationsByRootKey }),
    hasCode("foreground_e2e_recovery_restart_invalid"),
  );
});

test("owned recovery fault sends SIGKILL without graceful termination", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await forceKillOwnedProcess(child, { timeoutMs: 1_000 });
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function rootCreation(routingLabelId, conductorId, performerProfileId, worktreeDirectory) {
  return { teamId: "team-1", projectId: "project-1", rootLabelId: "root-label", routingLabelId, rootStatusId: "todo-state", conductorId, performerProfileId, worktreeDirectory };
}

function rootCreateInput(rootKey, { teamId, projectId, rootLabelId, routingLabelId, rootStatusId }) {
  return { caseId: "conductor_restart_recovery", rootKey, teamId, projectId, rootLabelId, routingLabelId, rootStatusId };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

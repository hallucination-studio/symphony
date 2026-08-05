import { Conductor } from "./Conductor.js";
import type { ConductorStartup } from "./startup.js";
import { CycleRunner } from "../cycle-runner/CycleRunner.js";
import { ensureLinearWorkflow } from "../linear/LinearWorkflow.js";
import { RootReconciler } from "../root-reconciliation/RootReconciler.js";
import type { CreatePullRequest } from "../workspace/TerminalPullRequest.js";
import { TerminalPullRequest } from "../workspace/TerminalPullRequest.js";

export async function createProductionRootRun(
  startup: ConductorStartup,
  createPullRequest: CreatePullRequest,
  log?: (event: Readonly<Record<string, unknown>>) => void,
): Promise<Conductor> {
  const root = await startup.gateway.get_issue(startup.request.linear_root);
  const workflow = await ensureLinearWorkflow(root.team_id, startup.gateway);
  const reconciler = new RootReconciler({
    performer: startup.executePerformer,
    runDirectory: startup.request.run_directory,
    agent: startup.request.agent,
    ...(startup.request.execute_model === undefined ? {} : { model: startup.request.execute_model }),
    ...(startup.request.execute_reasoning_effort === undefined
      ? {} : { reasoningEffort: startup.request.execute_reasoning_effort }),
    timeoutMs: 120_000,
  });
  const cycleRunner = new CycleRunner({
    gateway: startup.gateway,
    executePerformer: startup.executePerformer,
    auditPerformer: startup.auditPerformer,
    workflow,
    agent: startup.request.agent,
    ...(startup.request.execute_model === undefined ? {} : { executeModel: startup.request.execute_model }),
    ...(startup.request.execute_reasoning_effort === undefined
      ? {} : { executeReasoningEffort: startup.request.execute_reasoning_effort }),
    ...(startup.request.audit_model === undefined ? {} : { auditModel: startup.request.audit_model }),
    ...(startup.request.audit_reasoning_effort === undefined
      ? {} : { auditReasoningEffort: startup.request.audit_reasoning_effort }),
    timeoutMs: 120_000,
  });
  return new Conductor({
    gateway: startup.gateway,
    workflow,
    reconciler,
    cycleRunner,
    publisher: {
      publish: (workspace, onPublishing) => new TerminalPullRequest({
        createPullRequest,
        onPublishing,
      }).publish(workspace),
    },
    workspace: startup.resolveWorkspace,
    maxCycles: startup.request.max_cycles,
    ...(log === undefined ? {} : { log }),
  });
}

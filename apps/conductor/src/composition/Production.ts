import { Conductor } from "./Conductor.js";
import type { ConductorStartup } from "./startup.js";
import { CycleRunner } from "../cycle-runner/CycleRunner.js";
import { ensureLinearWorkflow } from "../linear/LinearWorkflow.js";
import { RootReconciler } from "../root-reconciliation/RootReconciler.js";

export async function createProductionRootRun(
  startup: ConductorStartup,
  log?: (event: Readonly<Record<string, unknown>>) => void,
): Promise<Conductor> {
  const root = await startup.gateway.get_issue(startup.request.linear_root);
  const workflow = await ensureLinearWorkflow(root.team_id, startup.gateway);
  const reconciler = new RootReconciler({
    performer: startup.reconcilePerformer,
    runDirectory: startup.request.run_directory,
    reconcileAgent: startup.request.reconcile_agent,
    ...(startup.request.reconcile_model === undefined ? {} : { reconcileModel: startup.request.reconcile_model }),
    ...(startup.request.reconcile_reasoning_effort === undefined
      ? {} : { reconcileReasoningEffort: startup.request.reconcile_reasoning_effort }),
    timeoutMs: 120_000,
  });
  const cycleRunner = new CycleRunner({
    gateway: startup.gateway,
    artistPerformer: startup.artistPerformer,
    criticPerformer: startup.criticPerformer,
    workflow,
    artistAgent: startup.request.artist_agent,
    ...(startup.request.artist_model === undefined ? {} : { artistModel: startup.request.artist_model }),
    ...(startup.request.artist_reasoning_effort === undefined
      ? {} : { artistReasoningEffort: startup.request.artist_reasoning_effort }),
    criticAgent: startup.request.critic_agent,
    ...(startup.request.critic_model === undefined ? {} : { criticModel: startup.request.critic_model }),
    ...(startup.request.critic_reasoning_effort === undefined
      ? {} : { criticReasoningEffort: startup.request.critic_reasoning_effort }),
    timeoutMs: 120_000,
  });
  return new Conductor({
    gateway: startup.gateway,
    workflow,
    reconciler,
    cycleRunner,
    workspace: () => reconciler.prepare(root, startup.request.workspace_path),
    maxCycles: startup.request.max_cycles,
    ...(log === undefined ? {} : { log }),
  });
}

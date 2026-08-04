import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

import type { TaskObservationEvent } from "../contracts/observation.js";
import type { CycleIssueId, RepositoryId, RootIssueId } from "../contracts/identity.js";
import { GhCommand, GitHubScm, discoverGitHubRepository } from "../delivery/internal/GitHubScm.js";
import { GitScmDelivery } from "../delivery/internal/GitScmDelivery.js";
import { GitWorktree } from "../git/internal/GitWorktree.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { RootRuntimeRegistry } from "../runtime/RootRuntimeRegistry.js";
import type { RootRuntimeCleanup } from "../runtime/RootRuntimeRegistry.js";
import { RootFamilyGuard } from "../runtime/RootFamilyGuard.js";
import { SerialConductor } from "../runtime/SerialConductor.js";
import type { SerialConductorLog, SerialRunResult } from "../runtime/SerialConductor.js";
import { createTaskManageCallerAuthority } from "../task-management/api/TaskManageCapability.js";
import type { TaskManageObserverInterface } from "../task-management/api/TaskManageObserverInterface.js";
import { LinearSdkQueryClient } from "../task-management/linear/LinearClient.js";
import { LinearCommands } from "../task-management/linear/LinearCommands.js";
import { LinearObserver } from "../task-management/linear/LinearObserver.js";
import type { TaskObservationLog } from "../task-management/linear/LinearObserver.js";
import { LinearQueries } from "../task-management/linear/LinearQueries.js";
import type { ConductorStartup } from "./startup.js";
import {
  LinearTaskManageCommand,
  assertTaskWorkflowConfiguration,
  readTaskWorkflowCatalog,
} from "./TaskManagerComposition.js";
import {
  ProductionRootRuntimeFactory,
  type ProductionRootBinding,
  type ProductionRuntimeLog,
  worktreeRoot,
} from "./ProductionRuntime.js";
export {
  assertTaskWorkflowConfiguration,
  type TaskWorkflowCatalog,
} from "./TaskManagerComposition.js";

const MAX_ACTIONS_PER_POLL = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

interface ProductionScheduler {
  admit(inputs: readonly unknown[]): void;
  runNext(): Promise<SerialRunResult>;
}

export interface ProductionPollTarget {
  readonly observer: TaskManageObserverInterface;
  readonly scheduler: ProductionScheduler;
}

export interface ProductionConductor extends ProductionPollTarget {
  readonly polling_interval_ms: number;
}

export type ProductionLog = ProductionRuntimeLog | SerialConductorLog | TaskObservationLog;

export interface ProductionPollResult {
  readonly observations: number;
  readonly actions: number;
  readonly failures: number;
  readonly stopped: boolean;
}

export async function runProductionPoll(
  target: ProductionPollTarget,
): Promise<ProductionPollResult> {
  const observations: readonly TaskObservationEvent[] = await target.observer.poll_once();
  target.scheduler.admit(observations);
  let actions = 0;
  let failures = 0;
  while (actions < MAX_ACTIONS_PER_POLL) {
    const result = await target.scheduler.runNext();
    if (result.kind === "idle") {
      return Object.freeze({ observations: observations.length, actions, failures, stopped: false });
    }
    actions += 1;
    if (result.kind === "failed") {
      failures += 1;
      throw new Error(result.reason_code);
    }
    if (result.kind === "root_cleanup_completed") {
      return Object.freeze({ observations: observations.length, actions, failures, stopped: true });
    }
  }
  throw new Error("production_scheduler_action_limit");
}

interface RepositoryResources {
  readonly repository_path: string;
  readonly base_branch: string;
  readonly git: GitWorktree;
  readonly delivery: GitScmDelivery;
}

async function repositoryResources(
  startup: ConductorStartup,
  repositoryId: RepositoryId,
  repositoryPath: string,
  baseBranch: string,
): Promise<RepositoryResources> {
  const root = worktreeRoot(startup.config.program_data_path, repositoryId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const git = await GitWorktree.create({
    executable: "git",
    repository_id: repositoryId,
    repository_path: repositoryPath,
    worktree_root: root,
    command_timeout_ms: COMMAND_TIMEOUT_MS,
    max_output_bytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  const gh = new GhCommand(repositoryPath);
  const repository = await discoverGitHubRepository(gh);
  const delivery = await GitScmDelivery.create({
    executable: "git",
    repository_id: repositoryId,
    repository_path: repositoryPath,
    command_timeout_ms: COMMAND_TIMEOUT_MS,
    max_output_bytes: MAX_COMMAND_OUTPUT_BYTES,
    scm: new GitHubScm(repository, gh),
  });
  return Object.freeze({ repository_path: repositoryPath, base_branch: baseBranch, git, delivery });
}

export async function createProductionConductor(
  startup: ConductorStartup,
  log: (entry: ProductionLog) => void = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
): Promise<ProductionConductor> {
  if (startup.config.delivery_provider_endpoint !== "https://api.github.com") {
    throw new Error("unsupported_delivery_provider_endpoint");
  }
  await access(startup.config.codex_executable, constants.X_OK).catch(() => {
    throw new Error("invalid_codex_executable");
  });
  await mkdir(startup.config.program_data_path, { recursive: true, mode: 0o700 });

  const sdk = LinearSdkQueryClient.fromAccessToken(startup.linear_token);
  const queries = new LinearQueries(sdk, {
    team_id: startup.config.linear_team_id,
    service_actor_id: startup.config.agent_actor_id,
  });
  await queries.readServiceActor();
  const root = startup.config.root;
  let catalog;
  try {
    catalog = await readTaskWorkflowCatalog(queries, root.root_id);
    assertTaskWorkflowConfiguration(startup.config, catalog);
  } catch {
    throw new Error("invalid_task_workflow_configuration");
  }

  const resource = await repositoryResources(
    startup,
    root.repository_id,
    root.repository_path,
    root.base_branch,
  );
  const route: ProductionRootBinding = Object.freeze({
    ...root,
    git: resource.git,
    delivery: resource.delivery,
  });

  const callerAuthority = createTaskManageCallerAuthority();
  const commands = new LinearCommands(sdk, queries, {
    team_id: startup.config.linear_team_id,
    service_actor_id: startup.config.agent_actor_id,
  });
  const taskManager = new LinearTaskManageCommand(queries, commands, callerAuthority.verifier);
  const homes = await RootHomeManager.create(
    startup.config.program_data_path,
    startup.config.performer_home,
  );
  const cleanup: RootRuntimeCleanup = Object.freeze({
    delete: async (
      rootId: RootIssueId,
      cycleIds: readonly CycleIssueId[],
      isLive: (candidate: RootIssueId) => boolean,
    ) => {
      await resource.git.deleteCycles(rootId, cycleIds, isLive);
      await homes.delete(rootId, isLive);
    },
  });
  const registry = new RootRuntimeRegistry(root.root_id, new ProductionRootRuntimeFactory({
    startup,
    queries,
    task_manager: taskManager,
    caller_issuer: callerAuthority.issuer,
    homes,
    route,
    log,
  }), cleanup);
  const familyGuard = new RootFamilyGuard({
    service_actor_id: startup.config.agent_actor_id,
    caller_issuer: callerAuthority.issuer,
    task_manager: taskManager,
    records: queries,
    workflow: startup.config.workflow,
    root_states: startup.config.root_states,
  });
  const scheduler = new SerialConductor(registry, {
    root_id: root.root_id,
    agent_actor_id: startup.config.agent_actor_id,
    root_kind_label_id: startup.config.workflow.labels.root,
    root_states: startup.config.root_states,
    workflow: startup.config.workflow,
    family_guard: familyGuard,
    log: (entry) => log(entry),
  });
  const observer = new LinearObserver(queries, {
    root_id: root.root_id,
    log: (entry) => log(entry),
  });
  return Object.freeze({
    observer,
    scheduler,
    polling_interval_ms: startup.config.polling_interval_ms,
  });
}

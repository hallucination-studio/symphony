import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { LinearClient } from "@linear/sdk";

import {
  parseCorrelationId,
  parseRevision,
  parseRuntimeGeneration,
  type RepositoryId,
  type RootIssueId,
} from "../contracts/identity.js";
import type { DeliveryIdentity, DeliveryInterface, DeliveryObservation, DeliverRevisionRequest } from "../delivery/api/DeliveryInterface.js";
import { GhCommand, GitHubScm, discoverGitHubRepository } from "../delivery/internal/GitHubScm.js";
import { GitScmDelivery } from "../delivery/internal/GitScmDelivery.js";
import type { CommitWorkspaceRequest, GitWorkspaceInterface, PrepareWorkspaceRequest, RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import { GitCommand } from "../git/internal/GitCommand.js";
import { GitWorktree } from "../git/internal/GitWorktree.js";
import { LinearGateway } from "../linear/internal/LinearMutations.js";
import { LinearPerformerTools } from "../linear/internal/LinearPerformerTools.js";
import { LinearSdkReadClient } from "../linear/internal/LinearSdkReadClient.js";
import { CommitMechanics } from "../orchestration/CommitMechanics.js";
import { CycleMechanics } from "../orchestration/CycleMechanics.js";
import { DeliveryMechanics } from "../orchestration/DeliveryMechanics.js";
import { RootAdvancer, type RootSessionProvider } from "../orchestration/RootAdvancer.js";
import { MechanicalRootActions } from "../orchestration/RootActions.js";
import type { RootAdmission } from "../orchestration/RootDiscovery.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import { CodexPlanSessionFactory, PlanPerformer } from "../performer/internal/PlanPerformer.js";
import { CodexVerifySessionFactory, VerifyPerformer } from "../performer/internal/VerifyPerformer.js";
import { CodexWorkSessionFactory, WorkPerformer } from "../performer/internal/WorkPerformer.js";
import { LinearStageIssueContextReader } from "../performer/internal/StageIssueContext.js";
import { CodexRootTurnTransportFactory, RootReconcillFactory } from "../root-reconcill/internal/RootReconcill.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { JsonLineLogger, type StructuredLoggerInterface } from "../runtime-logs/StructuredLogger.js";
import { BoundRootToolsFactory } from "../runtime/RootTools.js";
import { RootRetirement } from "../runtime/RootRetirement.js";
import { RootRuntimeRegistry } from "../runtime/RootRuntimeRegistry.js";
import { SerialConductor } from "../runtime/SerialConductor.js";
import type { ConductorStartup } from "./startup.js";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const CODEX_STARTUP_TIMEOUT_MS = 30_000;
const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_SHUTDOWN_TIMEOUT_MS = 10_000;

function prepareCorrelationId(rootId: RootIssueId) {
  const digest = createHash("sha256").update(rootId, "utf8").digest("hex");
  return parseCorrelationId(`prepare:${digest}`);
}

interface RouteResources {
  readonly repository_id: RepositoryId;
  readonly repository_path: string;
  readonly base_branch: string;
  readonly git: GitWorktree;
  readonly delivery: GitScmDelivery;
}

class RoutedGit implements GitWorkspaceInterface {
  constructor(private readonly routes: ReadonlyMap<RepositoryId, RouteResources>) {}

  prepare(request: PrepareWorkspaceRequest) { return this.#route(request.repository_id).git.prepare(request); }
  read(identity: RootWorkspaceIdentity) { return this.#route(identity.repository_id).git.read(identity); }
  commit(request: CommitWorkspaceRequest) { return this.#route(request.repository_id).git.commit(request); }

  pathFor(rootId: RootIssueId, repositoryId: RepositoryId): string {
    return this.#route(repositoryId).git.pathFor(rootId);
  }

  #route(repositoryId: RepositoryId): RouteResources {
    const route = this.routes.get(repositoryId);
    if (!route) throw new Error("repository_route_missing");
    return route;
  }
}

class RoutedDelivery implements DeliveryInterface {
  constructor(private readonly routes: ReadonlyMap<RepositoryId, RouteResources>) {}

  read(identity: DeliveryIdentity): Promise<DeliveryObservation> {
    return this.#route(identity.repository_id).delivery.read(identity);
  }
  push(request: DeliverRevisionRequest) { return this.#route(request.identity.repository_id).delivery.push(request); }
  createPullRequest(request: DeliverRevisionRequest) {
    return this.#route(request.identity.repository_id).delivery.createPullRequest(request);
  }

  #route(repositoryId: RepositoryId): RouteResources {
    const route = this.routes.get(repositoryId);
    if (!route) throw new Error("repository_route_missing");
    return route;
  }
}

class ProductionRootSessions implements RootSessionProvider {
  readonly #baseReader = new GitCommand({
    executable: "git",
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });

  constructor(
    private readonly routeByRoot: ReadonlyMap<RootIssueId, RouteResources>,
    private readonly git: RoutedGit,
    private readonly homes: RootHomeManager,
    private readonly runtimes: RootRuntimeRegistry,
  ) {}

  async ensure(admission: RootAdmission) {
    const candidate = admission.candidate;
    const route = this.routeByRoot.get(candidate.root_id);
    if (
      !route
      || route.repository_id !== candidate.repository_id
      || route.base_branch !== candidate.base_branch
    ) throw new Error("root_route_identity_mismatch");
    const workspace: RootWorkspaceIdentity = {
      root_id: candidate.root_id,
      repository_id: candidate.repository_id,
      base_branch: candidate.base_branch,
      head_branch: `symphony/root-${Buffer.from(candidate.root_id, "utf8").toString("hex")}`,
    };
    if (!this.runtimes.has(candidate.root_id)) {
      const baseRevision = parseRevision((await this.#baseReader.run(route.repository_path, [
        "rev-parse", "--verify", `refs/heads/${candidate.base_branch}^{commit}`,
      ])).toString("utf8").trim());
      const prepared = await this.git.prepare({
        ...workspace,
        correlation_id: prepareCorrelationId(candidate.root_id),
        expected_base_revision: baseRevision,
      });
      if (prepared.outcome !== "applied") throw new Error("root_workspace_prepare_failed");
      const home = await this.homes.open(candidate.root_id);
      let generation = 1;
      try {
        generation = (await home.continuity.load()).runtime_generation + 1;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "root_continuity_unavailable") throw error;
      }
      await this.runtimes.create({
        root_id: candidate.root_id,
        runtime_generation: parseRuntimeGeneration(generation),
        workspace,
      });
    }
    return Object.freeze({ workspace, runtime: this.runtimes.get(candidate.root_id) });
  }
}

function performer(
  startup: ConductorStartup,
  git: RoutedGit,
  routeByRoot: ReadonlyMap<RootIssueId, RouteResources>,
  tools: LinearPerformerTools,
  contexts: LinearStageIssueContextReader,
): StagePerformerInterface {
  const common = {
    executable: startup.config.codex_executable,
    performerHome: startup.config.performer_home,
    startupTimeoutMs: CODEX_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: CODEX_REQUEST_TIMEOUT_MS,
    turnTimeoutMs: CODEX_TURN_TIMEOUT_MS,
    shutdownTimeoutMs: CODEX_SHUTDOWN_TIMEOUT_MS,
    apiKey: startup.codex_api_key,
    baseUrl: startup.codex_base_url,
    model: startup.codex_model,
  };
  const worktreePath = async (rootId: RootIssueId) => {
    const route = routeByRoot.get(rootId);
    if (!route) throw new Error("root_route_missing");
    return git.pathFor(rootId, route.repository_id);
  };
  const plan = new PlanPerformer(new CodexPlanSessionFactory({
    ...common, cwd: startup.config.performer_home, bindings: (request) => [tools.plan(request)],
    issueContext: (request) => contexts.read(request.root_id),
  }));
  const work = new WorkPerformer(new CodexWorkSessionFactory({
    ...common, worktreePath, networkAccess: false, bindings: (request) => [tools.work(request)],
    issueContext: (request) => contexts.read(request.work_issue_id),
  }));
  const verify = new VerifyPerformer(new CodexVerifySessionFactory({
    ...common, worktreePath, bindings: (request) => [tools.verify(request)],
  }));
  const stages: StagePerformerInterface = {
    executePlan: (request) => plan.executePlan(request),
    executeWork: (request) => work.executeWork(request),
    executeVerify: (request) => verify.executeVerify(request),
    closeCycle: (rootId, cycleId) => work.closeCycle(rootId, cycleId),
  };
  return Object.freeze(stages);
}

export interface ProductionConductor {
  readonly serial: SerialConductor;
  readonly retirement: RootRetirement;
  readonly linear: LinearGateway;
  readonly runtimes: RootRuntimeRegistry;
}

export async function createProductionConductor(
  startup: ConductorStartup,
  logger: StructuredLoggerInterface = new JsonLineLogger((line) => process.stdout.write(line)),
): Promise<ProductionConductor> {
  if (startup.config.delivery_provider_endpoint !== "https://api.github.com") {
    throw new Error("unsupported_delivery_provider_endpoint");
  }
  await mkdir(startup.config.program_data_path, { recursive: true, mode: 0o700 });
  const routeResources = new Map<RepositoryId, RouteResources>();
  const routeByRoot = new Map<RootIssueId, RouteResources>();
  for (const route of startup.config.root_routing) {
    if (routeResources.has(route.repository_id)) {
      const existing = routeResources.get(route.repository_id)!;
      if (existing.repository_path !== route.repository_path || existing.base_branch !== route.base_branch) {
        throw new Error("repository_route_identity_ambiguous");
      }
      routeByRoot.set(route.root_id, existing);
      continue;
    }
    const worktreeRoot = path.join(
      startup.config.program_data_path,
      "worktrees",
      Buffer.from(route.repository_id, "utf8").toString("hex"),
    );
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    const git = await GitWorktree.create({
      executable: "git",
      repository_id: route.repository_id,
      repository_path: route.repository_path,
      worktree_root: worktreeRoot,
      command_timeout_ms: COMMAND_TIMEOUT_MS,
      max_output_bytes: MAX_COMMAND_OUTPUT_BYTES,
    });
    const gh = new GhCommand(route.repository_path);
    const repository = await discoverGitHubRepository(gh);
    const delivery = await GitScmDelivery.create({
      executable: "git",
      repository_path: route.repository_path,
      repository_id: route.repository_id,
      command_timeout_ms: COMMAND_TIMEOUT_MS,
      max_output_bytes: MAX_COMMAND_OUTPUT_BYTES,
      scm: new GitHubScm(repository, gh),
    });
    const resources = Object.freeze({ ...route, git, delivery });
    routeResources.set(route.repository_id, resources);
    routeByRoot.set(route.root_id, resources);
  }

  const linearClient = new LinearClient({ accessToken: startup.linear_token });
  const delegateActorId = (await linearClient.viewer).id;
  const sdk = new LinearSdkReadClient(linearClient);
  const linear = new LinearGateway(sdk, {
    team_id: startup.config.linear_team_id,
    delegate_actor_id: delegateActorId,
    routes: startup.config.root_routing.map(({ root_id, repository_id, base_branch }) => ({
      root_id, repository_id, base_branch,
    })),
  });
  const homes = await RootHomeManager.create(startup.config.program_data_path, startup.config.performer_home);
  const routedGit = new RoutedGit(routeResources);
  const routedDelivery = new RoutedDelivery(routeResources);
  const performerClient = linearClient;
  const stages = performer(
    startup,
    routedGit,
    routeByRoot,
    new LinearPerformerTools(performerClient, startup.config.linear_team_id, linear),
    new LinearStageIssueContextReader(performerClient, startup.config.linear_team_id),
  );
  const reconcills = new RootReconcillFactory(new CodexRootTurnTransportFactory({
    executable: startup.config.codex_executable,
    startupTimeoutMs: CODEX_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: CODEX_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: CODEX_SHUTDOWN_TIMEOUT_MS,
    apiKey: startup.codex_api_key,
    baseUrl: startup.codex_base_url,
    model: startup.codex_model,
  }));
  const runtimes = new RootRuntimeRegistry(homes, reconcills, new BoundRootToolsFactory(linear, routedGit, stages));
  const sessions = new ProductionRootSessions(routeByRoot, routedGit, homes, runtimes);
  const actions = new MechanicalRootActions(
    linear,
    routedGit,
    runtimes,
    stages,
    new CycleMechanics(linear),
    new CommitMechanics(linear, routedGit),
    new DeliveryMechanics(linear, routedGit, routedDelivery),
  );
  const serial = new SerialConductor(linear, new RootAdvancer(linear, routedGit, sessions, actions), logger);
  return Object.freeze({
    serial,
    retirement: new RootRetirement(linear, runtimes, homes, logger),
    linear,
    runtimes,
  });
}

import { createHash } from "node:crypto";

import { podiumError } from "../errors.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import type {
  ConductorBinding,
  RepositoryContext,
} from "../models.js";
import type { ConductorBindingStoreInterface } from "./api/ConductorBindingStoreInterface.js";

interface BindingDependencies {
  createBindingId(): string;
  createConductorId(): string;
}

export class ConductorBindingUseCase {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConductorBindingStoreInterface,
    private readonly client: Pick<
      LinearClientInterface,
      "readConductorProjectPool" | "preflightConductorProjectPool" | "reconcileConductorProjectPool"
    >,
    private readonly dependencies: BindingDependencies,
  ) {
    if (typeof client.readConductorProjectPool !== "function" ||
        typeof client.preflightConductorProjectPool !== "function" ||
        typeof client.reconcileConductorProjectPool !== "function") {
      throw new Error("linear_project_pool_client_invalid");
    }
  }

  async create(input: {
    installationId: string;
    projectId: string;
    repositoryContext: RepositoryContext;
  }): Promise<ConductorBinding> {
    const operation = this.#tail.then(() => this.#create(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #create(input: {
    installationId: string;
    projectId: string;
    repositoryContext: RepositoryContext;
  }): Promise<ConductorBinding> {
    const existingBindings = this.store.listConductorBindings();
    const existing = existingBindings.find((binding) =>
      binding.desiredState === "stopped" &&
      binding.linearInstallationId === input.installationId &&
      sameRepository(binding.repositoryContext, input.repositoryContext),
    );
    if (existing) {
      await this.#ensureProjectPool(input.projectId, existing.conductorShortHash);
      this.store.setConductorDesiredState(existing.bindingId, "running");
      return { ...existing, desiredState: "running" };
    }
    const installation = this.store.getLinearCredential(input.installationId);
    const project = this.store.getProject(input.projectId);
    if (
      !installation ||
      !project ||
      project.installationId !== installation.installationId ||
      project.organizationId !== installation.organizationId
    ) {
      throw podiumError(
        "conductor_project_invalid",
        "The selected Linear Project does not belong to the active installation.",
      );
    }

    const conductorId = this.dependencies.createConductorId();
    const conductorShortHash = createHash("sha256")
      .update(conductorId)
      .digest("hex")
      .slice(0, 12);
    const binding: ConductorBinding = {
      bindingId: this.dependencies.createBindingId(),
      conductorId,
      conductorShortHash,
      linearInstallationId: installation.installationId,
      organizationId: installation.organizationId,
      repositoryContext: input.repositoryContext,
      desiredState: "stopped",
    };
    this.store.saveConductorBinding(binding);
    // Keep the stopped binding as a durable retry intent if pool reconciliation fails.
    await this.#ensureProjectPool(project.projectId, conductorShortHash);
    this.store.setConductorDesiredState(binding.bindingId, "running");
    return { ...binding, desiredState: "running" };
  }

  async #ensureProjectPool(projectId: string, conductorShortHash: string): Promise<void> {
    const current = await this.client.readConductorProjectPool({ projectId });
    const desiredMembers = [...new Set([...current.members, conductorShortHash])];
    const plan = await this.client.preflightConductorProjectPool({ projectId, desiredMembers });
    if (plan.kind !== "ready") throw new Error(`linear_project_pool_${plan.reason}`);
    const result = await this.client.reconcileConductorProjectPool({ plan, authorized: true });
    if (result.kind === "dry_run" || !result.members.includes(conductorShortHash)) {
      throw new Error("linear_project_pool_read_back_failed");
    }
  }
}

function sameRepository(left: RepositoryContext, right: RepositoryContext): boolean {
  return (
    left.repositoryIdentity === right.repositoryIdentity &&
    left.repositoryRoot === right.repositoryRoot &&
    left.baseBranch === right.baseBranch
  );
}

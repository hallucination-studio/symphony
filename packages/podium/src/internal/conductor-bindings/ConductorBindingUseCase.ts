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
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export class ConductorBindingUseCase {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConductorBindingStoreInterface,
    private readonly client: Pick<
      LinearClientInterface,
      "assignConductorProjectLabel"
    > & Partial<Pick<
      LinearClientInterface,
      "readConductorProjectPool" | "preflightConductorProjectPool" | "reconcileConductorProjectPool"
    >>,
    private readonly dependencies: BindingDependencies,
  ) {
    const maximum = dependencies.maxAttempts ?? 4;
    const baseDelayMs = dependencies.baseDelayMs ?? 250;
    if (
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 10 ||
      !Number.isFinite(baseDelayMs) ||
      baseDelayMs < 1 ||
      baseDelayMs > 60_000
    ) {
      throw new Error("linear_retry_policy_invalid");
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
    const existingBindings = this.store.listConductorBindings
      ? this.store.listConductorBindings()
      : (this.store.getConductorBinding() ? [this.store.getConductorBinding()!] : []);
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
    if (
      typeof this.client.readConductorProjectPool !== "function" ||
      typeof this.client.preflightConductorProjectPool !== "function" ||
      typeof this.client.reconcileConductorProjectPool !== "function"
    ) {
      await this.#assignLabel({
        projectId,
        labelName: `symphony:conductor/${conductorShortHash}`,
      });
      return;
    }
    const current = await this.client.readConductorProjectPool({ projectId });
    const desiredMembers = [...new Set([...current.members, conductorShortHash])];
    const plan = await this.client.preflightConductorProjectPool({ projectId, desiredMembers });
    if (plan.kind !== "ready") throw new Error(`linear_project_pool_${plan.reason}`);
    const result = await this.client.reconcileConductorProjectPool({ plan, authorized: true });
    if (result.kind === "dry_run" || !result.members.includes(conductorShortHash)) {
      throw new Error("linear_project_pool_read_back_failed");
    }
  }

  async #assignLabel(input: { projectId: string; labelName: string }) {
    const maximum = this.dependencies.maxAttempts ?? 4;
    const baseDelayMs = this.dependencies.baseDelayMs ?? 250;
    for (let attempt = 1; attempt <= maximum; attempt += 1) {
      try {
        await this.client.assignConductorProjectLabel(input);
        return;
      } catch (error) {
        if (!retryableLinearError(error) || attempt === maximum) throw error;
        await (this.dependencies.sleep ?? defaultSleep)(
          baseDelayMs * 2 ** (attempt - 1),
        );
      }
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

function retryableLinearError(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "RatelimitedLinearError",
      "NetworkLinearError",
      "InternalLinearError",
    ].includes(error.constructor.name)
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

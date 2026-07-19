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
    >,
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
    const existing = this.store.getConductorBinding();
    if (existing) {
      if (
        existing.desiredState === "stopped" &&
        existing.linearInstallationId === input.installationId &&
        sameRepository(existing.repositoryContext, input.repositoryContext)
      ) {
        await this.#assignLabel({
          projectId: input.projectId,
          labelName: `symphony:conductor/${existing.conductorShortHash}`,
        });
        this.store.setConductorDesiredState(existing.bindingId, "running");
        return { ...existing, desiredState: "running" };
      }
      throw podiumError(
        "conductor_binding_already_exists",
        "Roadmap V1 supports exactly one Conductor Binding.",
        { actionRequired: "use_existing_binding" },
      );
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
    await this.#assignLabel({
      projectId: project.projectId,
      labelName: `symphony:conductor/${conductorShortHash}`,
    });
    this.store.setConductorDesiredState(binding.bindingId, "running");
    return { ...binding, desiredState: "running" };
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

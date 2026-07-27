import { createHash } from "node:crypto";

import { PodiumError, podiumError } from "../errors.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import { classifyLinearFailure } from "../linear-gateway/LinearFailure.js";
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
    const current = await projectPoolStep(
      () => this.client.readConductorProjectPool({ projectId }),
      "conductor_project_pool_read_failed",
    );
    const desiredMembers = [...new Set([...current.members, conductorShortHash])];
    const plan = await projectPoolStep(
      () => this.client.preflightConductorProjectPool({ projectId, desiredMembers }),
      "conductor_project_pool_preflight_failed",
    );
    if (plan.kind !== "ready") {
      const code = `linear_project_pool_${plan.reason}`;
      throw podiumError(code, code, {
        actionRequired: "retry_request",
        nextAction: "Resolve the reported Linear Project pool problem and retry the request.",
      });
    }
    const result = await projectPoolStep(
      () => this.client.reconcileConductorProjectPool({ plan, authorized: true }),
      "conductor_project_pool_reconciliation_failed",
    );
    if (result.kind === "dry_run" || !result.members.includes(conductorShortHash)) {
      throw new Error("linear_project_pool_read_back_failed");
    }
  }
}

async function projectPoolStep<T>(
  operation: () => Promise<T>,
  failureCode: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PodiumError) throw error;
    const linearFailure = classifyLinearFailure(error);
    if (linearFailure) {
      throw podiumError(linearFailure.code, linearFailure.sanitizedReason, {
        retryable: linearFailure.retryable,
        actionRequired: "retry_request",
        nextAction: "Retry the request after Linear is available.",
      });
    }
    throw podiumError(failureCode, failureCode, {
      actionRequired: "retry_request",
      nextAction: "Resolve the reported Linear Project pool problem and retry the request.",
    });
  }
}

function sameRepository(left: RepositoryContext, right: RepositoryContext): boolean {
  return (
    left.repositoryIdentity === right.repositoryIdentity &&
    left.repositoryRoot === right.repositoryRoot &&
    left.baseBranch === right.baseBranch
  );
}

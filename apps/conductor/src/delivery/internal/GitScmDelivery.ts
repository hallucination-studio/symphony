import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseRepositoryId,
  parseRevision,
  type Revision,
} from "../../contracts/identity.js";
import type { MutationResult } from "../../contracts/mutation.js";
import type { PullRequestSnapshot } from "../../contracts/observation.js";
import type {
  DeliverRevisionRequest,
  DeliveryIdentity,
  DeliveryInterface,
  DeliveryObservation,
} from "../api/DeliveryInterface.js";
import { verifiedDelivery } from "../api/DeliveryInterface.js";
import { GitCommand } from "../../git/internal/GitCommand.js";

export interface ScmBoundary {
  read(identity: DeliveryIdentity): Promise<readonly PullRequestSnapshot[]>;
  create(identity: DeliveryIdentity, revision: Revision): Promise<"accepted" | "rejected" | "unknown">;
}

export interface GitScmDeliveryOptions {
  readonly executable: string;
  readonly repository_path: string;
  readonly repository_id: DeliveryIdentity["repository_id"];
  readonly command_timeout_ms: number;
  readonly max_output_bytes: number;
  readonly scm: ScmBoundary;
}

function result(
  request: DeliverRevisionRequest,
  outcome: MutationResult["outcome"],
  reason?: string,
): MutationResult {
  return outcome === "applied"
    ? {
        schema_version: 1,
        outcome,
        target_id: request.identity.root_id,
        correlation_id: request.correlation_id,
      }
    : {
        schema_version: 1,
        outcome,
        target_id: request.identity.root_id,
        correlation_id: request.correlation_id,
        reason: reason ?? outcome,
      };
}

export class GitScmDelivery implements DeliveryInterface {
  readonly #commands: GitCommand;

  private constructor(
    private readonly repositoryPath: string,
    private readonly repositoryId: DeliveryIdentity["repository_id"],
    private readonly scm: ScmBoundary,
    options: GitScmDeliveryOptions,
  ) {
    this.#commands = new GitCommand({
      executable: options.executable,
      timeoutMs: options.command_timeout_ms,
      maxOutputBytes: options.max_output_bytes,
    });
  }

  static async create(options: GitScmDeliveryOptions): Promise<GitScmDelivery> {
    if (!path.isAbsolute(options.repository_path)) throw new Error("invalid_delivery_repository_path");
    if (!Number.isSafeInteger(options.command_timeout_ms) || options.command_timeout_ms < 1) {
      throw new Error("invalid_delivery_command_timeout");
    }
    if (!Number.isSafeInteger(options.max_output_bytes) || options.max_output_bytes < 1024) {
      throw new Error("invalid_delivery_output_limit");
    }
    const repositoryPath = path.normalize(await realpath(options.repository_path));
    const instance = new GitScmDelivery(
      repositoryPath,
      parseRepositoryId(options.repository_id),
      options.scm,
      options,
    );
    const topLevel = path.normalize((await instance.#commands.run(repositoryPath, [
      "rev-parse", "--show-toplevel",
    ])).toString("utf8").trim());
    if (path.normalize(await realpath(topLevel)) !== repositoryPath) {
      throw new Error("delivery_repository_identity_mismatch");
    }
    return instance;
  }

  async read(identity: DeliveryIdentity): Promise<DeliveryObservation> {
    this.#assertIdentity(identity);
    const [remoteRevision, pullRequests] = await Promise.all([
      this.#readRemote(identity),
      this.scm.read(identity),
    ]);
    return Object.freeze({
      identity,
      remote_revision: remoteRevision,
      matching_pull_requests: Object.freeze([...pullRequests]),
    });
  }

  async push(request: DeliverRevisionRequest): Promise<MutationResult> {
    const before = await this.read(request.identity);
    if (before.remote_revision !== request.expected_remote_revision) {
      return result(request, "precondition_failed", "remote_revision_mismatch");
    }
    if (before.remote_revision === request.verified_revision) return result(request, "applied");
    await this.#assertLocalRevision(request.verified_revision);
    try {
      await this.#commands.run(this.repositoryPath, [
        "push",
        `--force-with-lease=refs/heads/${request.identity.head_branch}:${request.expected_remote_revision ?? "0".repeat(request.verified_revision.length)}`,
        "origin",
        `${request.verified_revision}:refs/heads/${request.identity.head_branch}`,
      ]);
    } catch {
      return this.#classifyPushFailure(request);
    }
    const after = await this.read(request.identity);
    return after.remote_revision === request.verified_revision
      ? result(request, "applied")
      : result(request, "readback_mismatch", "remote_revision_readback_mismatch");
  }

  async createPullRequest(request: DeliverRevisionRequest): Promise<MutationResult> {
    const before = await this.read(request.identity);
    if (
      before.remote_revision !== request.expected_remote_revision
      || before.remote_revision !== request.verified_revision
    ) return result(request, "precondition_failed", "pull_request_remote_precondition_mismatch");
    if (before.matching_pull_requests.length > 0) {
      try {
        verifiedDelivery(before, request.verified_revision);
        return result(request, "applied");
      } catch {
        return result(request, "not_applied", "pull_request_identity_conflict");
      }
    }

    const providerOutcome = await this.scm.create(request.identity, request.verified_revision);
    let after: DeliveryObservation;
    try {
      after = await this.read(request.identity);
    } catch {
      return result(request, "acceptance_unknown", "pull_request_readback_unavailable");
    }
    let exact = false;
    try {
      verifiedDelivery(after, request.verified_revision);
      exact = true;
    } catch {
      exact = false;
    }
    if (exact && providerOutcome === "accepted") return result(request, "applied");
    if (exact && providerOutcome === "unknown") return result(request, "acceptance_unknown", "pull_request_acceptance_unknown");
    if (!exact && providerOutcome === "rejected") return result(request, "not_applied", "pull_request_rejected");
    if (!exact && providerOutcome === "unknown") return result(request, "acceptance_unknown", "pull_request_acceptance_unknown");
    return result(request, "readback_mismatch", "pull_request_readback_mismatch");
  }

  async #classifyPushFailure(request: DeliverRevisionRequest): Promise<MutationResult> {
    try {
      const after = await this.read(request.identity);
      if (after.remote_revision === request.verified_revision) {
        return result(request, "acceptance_unknown", "push_acceptance_unknown");
      }
      if (after.remote_revision === request.expected_remote_revision) {
        return result(request, "not_applied", "push_not_applied");
      }
      return result(request, "readback_mismatch", "push_remote_conflict");
    } catch {
      return result(request, "acceptance_unknown", "push_readback_unavailable");
    }
  }

  async #readRemote(identity: DeliveryIdentity): Promise<Revision | null> {
    const output = (await this.#commands.run(this.repositoryPath, [
      "ls-remote", "--refs", "origin", `refs/heads/${identity.head_branch}`,
    ])).toString("utf8").trim();
    if (output === "") return null;
    const lines = output.split("\n");
    if (lines.length !== 1) throw new Error("delivery_remote_identity_ambiguous");
    const [revision, ref, ...extra] = lines[0]?.split(/\s+/u) ?? [];
    if (extra.length > 0 || ref !== `refs/heads/${identity.head_branch}`) {
      throw new Error("delivery_remote_identity_mismatch");
    }
    return parseRevision(revision);
  }

  async #assertLocalRevision(revision: Revision): Promise<void> {
    const actual = parseRevision((await this.#commands.run(this.repositoryPath, [
      "rev-parse", "--verify", `${revision}^{commit}`,
    ])).toString("utf8").trim());
    if (actual !== revision) throw new Error("delivery_local_revision_mismatch");
  }

  #assertIdentity(identity: DeliveryIdentity): void {
    if (identity.repository_id !== this.repositoryId) throw new Error("delivery_repository_identity_mismatch");
  }
}

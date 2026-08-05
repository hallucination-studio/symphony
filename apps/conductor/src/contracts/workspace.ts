import {
  asRecord,
  freezeObject,
  parseAbsolutePath,
  parseBoundedString,
  parseEnum,
} from "./validation.js";

export interface RootWorkspace {
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
}

export type PullRequestResult =
  | {
    readonly status: "created";
    readonly pull_request_url: string;
    readonly root_branch: string;
  }
  | {
    readonly status: "branch_delivered";
    readonly root_branch: string;
    readonly reason: string;
  }
  | {
    readonly status: "failed";
    readonly step: "validate" | "commit" | "push" | "create_pr";
    readonly reason: string;
  };

const PR_STEPS = ["validate", "commit", "push"] as const;

export function parseRootWorkspace(value: unknown): RootWorkspace {
  const record = asRecord(value, "invalid_root_workspace");
  if (Object.keys(record).sort().join("\0") !== ["root_branch", "run_directory", "workspace_path"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  return freezeObject({
    workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path"),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
  });
}

export function parsePullRequestResult(value: unknown): PullRequestResult {
  const record = asRecord(value, "invalid_pull_request_result");
  const status = record.status;
  if (status === "created") {
    if (Object.keys(record).sort().join("\0") !== ["pull_request_url", "root_branch", "status"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    const url = parseBoundedString(record.pull_request_url, "invalid_pull_request_url", 2_048);
    if (!URL.canParse(url)) throw new Error("invalid_pull_request_url");
    return freezeObject({
      status,
      pull_request_url: url,
      root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
    });
  }
  if (status === "branch_delivered") {
    if (Object.keys(record).sort().join("\0") !== ["reason", "root_branch", "status"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    return freezeObject({
      status,
      root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
      reason: parseBoundedString(record.reason, "invalid_pull_request_reason", 50),
    });
  }
  if (status === "failed") {
    if (Object.keys(record).sort().join("\0") !== ["reason", "status", "step"].sort().join("\0")) {
      throw new Error("invalid_contract_keys");
    }
    return freezeObject({
      status,
      step: parseEnum(record.step, PR_STEPS),
      reason: parseBoundedString(record.reason, "invalid_pull_request_reason", 256),
    });
  }
  throw new Error("invalid_contract_variant");
}

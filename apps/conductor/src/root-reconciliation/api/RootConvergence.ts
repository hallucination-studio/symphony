import { createHash } from "node:crypto";

import type { RootConvergenceView } from "./ManagedRecords.js";

export type ConvergenceTriggerInput =
  | "none"
  | "root_canceled"
  | "deadline_exceeded"
  | "max_cycles_per_root"
  | "max_same_open_finding_cycles"
  | "max_consecutive_no_progress"
  | "token_budget"
  | "max_cycle_repair_attempts";

export function rootConvergencePolicyId(rootIssueId: string): string {
  return `root-convergence-policy:${digest({ rootIssueId })}`;
}

export function convergenceRecordId(input: {
  rootIssueId: string;
  policyId: string;
  view: RootConvergenceView;
  trigger: Exclude<ConvergenceTriggerInput, "none">;
}): string {
  return `convergence:${digest(input)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("root_convergence_identity_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  throw new Error("root_convergence_identity_invalid");
}

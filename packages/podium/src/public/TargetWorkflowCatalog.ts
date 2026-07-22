export const TARGET_WORKFLOW_STATUS_CATEGORIES = Object.freeze({
  Draft: "backlog",
  Todo: "unstarted",
  Planning: "started",
  Sealed: "started",
  Executing: "started",
  Verifying: "started",
  "In Progress": "started",
  "In Review": "started",
  "Needs Approval": "started",
  "Needs Info": "started",
  Inconclusive: "started",
  Escalated: "started",
  Succeeded: "completed",
  "Changes Required": "completed",
  Done: "completed",
  Canceled: "canceled",
  Failed: "canceled",
});

export type TargetWorkflowStatusCategory =
  (typeof TARGET_WORKFLOW_STATUS_CATEGORIES)[keyof typeof TARGET_WORKFLOW_STATUS_CATEGORIES];

export interface TargetWorkflowStatusSnapshot {
  statusId: string;
  name: string;
  category: TargetWorkflowStatusCategory;
  position?: number;
}

export type TargetWorkflowCatalogInspection =
  | {
      kind: "complete";
      canonicalStatuses: readonly TargetWorkflowStatusSnapshot[];
      nativeDuplicate: TargetWorkflowStatusSnapshot;
    }
  | {
      kind: "incomplete";
      reason:
        | "invalid_status"
        | "canonical_status_missing"
        | "canonical_status_category_invalid"
        | "native_duplicate_invalid"
        | "native_duplicate_missing"
        | "unexpected_status";
    };

const NATIVE_DUPLICATE_NAME = "Duplicate";
const VALID_CATEGORIES = new Set<TargetWorkflowStatusCategory>([
  "backlog", "unstarted", "started", "completed", "canceled",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function inspectTargetWorkflowCatalog(
  states: readonly unknown[],
): TargetWorkflowCatalogInspection {
  if (!Array.isArray(states) || states.length === 0 || states.length > 64) {
    return { kind: "incomplete", reason: "invalid_status" };
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const canonical = new Map<string, TargetWorkflowStatusSnapshot>();
  let nativeDuplicate: TargetWorkflowStatusSnapshot | undefined;

  for (const state of states) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { kind: "incomplete", reason: "invalid_status" };
    }
    const value = state as Record<string, unknown>;
    const statusId = value.id;
    const name = value.name;
    const type = value.type;
    if (
      typeof statusId !== "string" ||
      !SAFE_ID.test(statusId) ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof type !== "string" ||
      ids.has(statusId) ||
      names.has(name)
    ) {
      return { kind: "incomplete", reason: "unexpected_status" };
    }
    ids.add(statusId);
    names.add(name);

    const position = value.position;
    const snapshotPosition = typeof position === "number" && Number.isFinite(position)
      ? position
      : undefined;
    if (type === "duplicate") {
      if (name !== NATIVE_DUPLICATE_NAME || nativeDuplicate) {
        return { kind: "incomplete", reason: "native_duplicate_invalid" };
      }
      nativeDuplicate = {
        statusId,
        name,
        category: "canceled",
        ...(snapshotPosition === undefined ? {} : { position: snapshotPosition }),
      };
      continue;
    }

    if (!VALID_CATEGORIES.has(type as TargetWorkflowStatusCategory)) {
      return { kind: "incomplete", reason: "unexpected_status" };
    }
    const expectedCategory = TARGET_WORKFLOW_STATUS_CATEGORIES[
      name as keyof typeof TARGET_WORKFLOW_STATUS_CATEGORIES
    ];
    if (expectedCategory === undefined) {
      return { kind: "incomplete", reason: "unexpected_status" };
    }
    if (expectedCategory !== type) {
      return { kind: "incomplete", reason: "canonical_status_category_invalid" };
    }
    canonical.set(name, {
      statusId,
      name,
      category: expectedCategory,
      ...(snapshotPosition === undefined ? {} : { position: snapshotPosition }),
    });
  }

  if (!nativeDuplicate) {
    return { kind: "incomplete", reason: "native_duplicate_missing" };
  }
  if (canonical.size !== Object.keys(TARGET_WORKFLOW_STATUS_CATEGORIES).length) {
    return { kind: "incomplete", reason: "canonical_status_missing" };
  }

  return {
    kind: "complete",
    canonicalStatuses: Object.freeze(
      Object.keys(TARGET_WORKFLOW_STATUS_CATEGORIES).map((name) => canonical.get(name)!),
    ),
    nativeDuplicate: Object.freeze(nativeDuplicate),
  };
}

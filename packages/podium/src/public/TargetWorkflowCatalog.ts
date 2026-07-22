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

export type TargetWorkflowInitializationOperation =
  | {
      kind: "rename";
      statusId: string;
      expectedName: "Backlog";
      name: "Draft";
      category: "backlog";
    }
  | {
      kind: "create";
      name: string;
      category: TargetWorkflowStatusCategory;
    };

export type TargetWorkflowInitializationPlan =
  | {
      kind: "ready";
      teamId: string;
      operations: readonly TargetWorkflowInitializationOperation[];
      nativeDuplicate: TargetWorkflowStatusSnapshot;
    }
  | {
      kind: "blocked";
      reason:
        | "invalid_team"
        | "invalid_status"
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

interface ParsedTargetWorkflowStatuses {
  canonical: Map<string, TargetWorkflowStatusSnapshot>;
  legacyBacklog?: TargetWorkflowStatusSnapshot | undefined;
  nativeDuplicate?: TargetWorkflowStatusSnapshot | undefined;
}

type TargetWorkflowParseFailure = {
  kind: "blocked";
  reason:
    | "invalid_status"
    | "canonical_status_category_invalid"
    | "native_duplicate_invalid"
    | "unexpected_status";
};

function parseTargetWorkflowStatuses(
  states: readonly unknown[],
): ParsedTargetWorkflowStatuses | TargetWorkflowParseFailure {
  if (!Array.isArray(states) || states.length === 0 || states.length > 64) {
    return { kind: "blocked", reason: "invalid_status" };
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const canonical = new Map<string, TargetWorkflowStatusSnapshot>();
  let legacyBacklog: TargetWorkflowStatusSnapshot | undefined;
  let nativeDuplicate: TargetWorkflowStatusSnapshot | undefined;

  for (const state of states) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { kind: "blocked", reason: "invalid_status" };
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
      return { kind: "blocked", reason: "unexpected_status" };
    }
    ids.add(statusId);
    names.add(name);

    const position = value.position;
    const snapshotPosition = typeof position === "number" && Number.isFinite(position)
      ? position
      : undefined;
    if (type === "duplicate") {
      if (name !== NATIVE_DUPLICATE_NAME || nativeDuplicate) {
        return { kind: "blocked", reason: "native_duplicate_invalid" };
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
      return { kind: "blocked", reason: "unexpected_status" };
    }
    const expectedCategory = TARGET_WORKFLOW_STATUS_CATEGORIES[
      name as keyof typeof TARGET_WORKFLOW_STATUS_CATEGORIES
    ];
    if (expectedCategory === undefined) {
      if (name === "Backlog" && type === "backlog" && !legacyBacklog) {
        legacyBacklog = {
          statusId,
          name,
          category: "backlog",
          ...(snapshotPosition === undefined ? {} : { position: snapshotPosition }),
        };
        continue;
      }
      return { kind: "blocked", reason: "unexpected_status" };
    }
    if (expectedCategory !== type) {
      return { kind: "blocked", reason: "canonical_status_category_invalid" };
    }
    canonical.set(name, {
      statusId,
      name,
      category: expectedCategory,
      ...(snapshotPosition === undefined ? {} : { position: snapshotPosition }),
    });
  }

  return { canonical, legacyBacklog, nativeDuplicate };
}

export function planTargetWorkflowInitialization(input: {
  teamId: string;
  states: readonly unknown[];
}): TargetWorkflowInitializationPlan {
  if (!SAFE_ID.test(input?.teamId ?? "")) {
    return { kind: "blocked", reason: "invalid_team" };
  }
  const parsed = parseTargetWorkflowStatuses(input.states);
  if ("kind" in parsed) return { kind: "blocked", reason: parsed.reason };
  if (!parsed.nativeDuplicate) {
    return { kind: "blocked", reason: "native_duplicate_missing" };
  }
  if (parsed.legacyBacklog && parsed.canonical.has("Draft")) {
    return { kind: "blocked", reason: "unexpected_status" };
  }

  const operations: TargetWorkflowInitializationOperation[] = [];
  if (parsed.legacyBacklog) {
    operations.push({
      kind: "rename",
      statusId: parsed.legacyBacklog.statusId,
      expectedName: "Backlog",
      name: "Draft",
      category: "backlog",
    });
  }
  for (const [name, category] of Object.entries(TARGET_WORKFLOW_STATUS_CATEGORIES)) {
    if (!parsed.canonical.has(name) && !(name === "Draft" && parsed.legacyBacklog)) {
      operations.push({ kind: "create", name, category });
    }
  }
  return {
    kind: "ready",
    teamId: input.teamId,
    operations: Object.freeze(operations),
    nativeDuplicate: Object.freeze(parsed.nativeDuplicate),
  };
}

export function inspectTargetWorkflowCatalog(
  states: readonly unknown[],
): TargetWorkflowCatalogInspection {
  const parsed = parseTargetWorkflowStatuses(states);
  if ("kind" in parsed) {
    return { kind: "incomplete", reason: parsed.reason };
  }
  if (!parsed.nativeDuplicate) {
    return { kind: "incomplete", reason: "native_duplicate_missing" };
  }
  if (parsed.legacyBacklog) {
    return { kind: "incomplete", reason: "unexpected_status" };
  }
  if (parsed.canonical.size !== Object.keys(TARGET_WORKFLOW_STATUS_CATEGORIES).length) {
    return { kind: "incomplete", reason: "canonical_status_missing" };
  }

  return {
    kind: "complete",
    canonicalStatuses: Object.freeze(
      Object.keys(TARGET_WORKFLOW_STATUS_CATEGORIES).map((name) => parsed.canonical.get(name)!),
    ),
    nativeDuplicate: Object.freeze(parsed.nativeDuplicate),
  };
}

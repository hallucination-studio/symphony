import type {
  ConductorDetailView,
  DesktopOverviewView,
  RootDetailView,
} from "../ui/types";
import * as generatedContracts from "./contracts-runtime.mjs";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type GeneratedContracts = {
  decodePodiumClientDesktopOverviewView(value: JsonValue): JsonValue;
  decodePodiumClientConductorDetailView(value: JsonValue): JsonValue;
  decodePodiumClientRootSummaryView(value: JsonValue): JsonValue;
  decodePodiumClientWorkflowNodeView(value: JsonValue): JsonValue;
  decodePodiumClientPerformerUsageView(value: JsonValue): JsonValue;
  decodePodiumClientRuntimeEventView(value: JsonValue): JsonValue;
  decodePodiumClientNextActionView(value: JsonValue): JsonValue;
};

export async function decodeDesktopOverviewView(value: JsonValue): Promise<DesktopOverviewView> {
  const contracts = generatedContracts as GeneratedContracts;
  return toDesktopView<DesktopOverviewView>(
    contracts.decodePodiumClientDesktopOverviewView(value),
  );
}

export async function decodeConductorDetailView(value: JsonValue): Promise<ConductorDetailView> {
  const contracts = generatedContracts as GeneratedContracts;
  return toDesktopView<ConductorDetailView>(
    contracts.decodePodiumClientConductorDetailView(value),
  );
}

export async function decodeRootDetailView(value: JsonValue): Promise<RootDetailView> {
  const contracts = generatedContracts as GeneratedContracts;
  const rootDetail = requireClosedObject(value, [
    "summary",
    "workflow_nodes",
    "usage",
    "events",
    "next_action",
    "retry_observed_at",
  ]);
  const workflowNodes = requireArray(rootDetail.workflow_nodes).map(
    contracts.decodePodiumClientWorkflowNodeView,
  );
  const events = requireArray(rootDetail.events).map(
    contracts.decodePodiumClientRuntimeEventView,
  );
  return toDesktopView<RootDetailView>({
    summary: contracts.decodePodiumClientRootSummaryView(rootDetail.summary!),
    workflow_nodes: workflowNodes,
    usage: contracts.decodePodiumClientPerformerUsageView(rootDetail.usage!),
    events,
    ...(rootDetail.retry_observed_at === undefined
      ? {}
      : { retry_observed_at: rootDetail.retry_observed_at }),
    ...(rootDetail.next_action === undefined
      ? {}
      : {
          next_action: contracts.decodePodiumClientNextActionView(
            rootDetail.next_action,
          ),
        }),
  });
}

function toDesktopView<View>(value: JsonValue): View {
  return mapWireValue(value) as View;
}

function mapWireValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(mapWireValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      mapWireValue(child),
    ]),
  );
}

function requireClosedObject(
  value: JsonValue,
  allowedKeys: string[],
): Record<string, JsonValue | undefined> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("RootDetailView must be an object");
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`RootDetailView has unknown fields: ${unknownKeys.join(", ")}`);
  }
  for (const requiredKey of ["summary", "workflow_nodes", "usage", "events"]) {
    if (!(requiredKey in value)) {
      throw new Error(`RootDetailView is missing ${requiredKey}`);
    }
  }
  return value;
}

function requireArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error("RootDetailView collection must be an array");
  }
  return value;
}

import * as generatedContracts from "./contracts-runtime.mjs";
import type { ConductorDetailView, DesktopOverviewView } from "../ui/types";

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
};

export async function decodeDesktopOverviewView(value: JsonValue): Promise<DesktopOverviewView> {
  const contracts = generatedContracts as unknown as GeneratedContracts;
  return mapWireValue(
    contracts.decodePodiumClientDesktopOverviewView(value),
  ) as unknown as DesktopOverviewView;
}

export async function decodeConductorDetailView(value: JsonValue): Promise<ConductorDetailView> {
  const contracts = generatedContracts as unknown as GeneratedContracts;
  return mapWireValue(
    contracts.decodePodiumClientConductorDetailView(value),
  ) as unknown as ConductorDetailView;
}

function mapWireValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(mapWireValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      mapWireValue(child),
    ]),
  );
}

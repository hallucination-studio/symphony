import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootDeliveryCommand {
  operationId: string;
  view: RootReconciliationView;
  baseBranch: string;
  title: string;
  body: string;
}

export type RootDeliveryResult = { kind: "pull_request"; url: string };

export interface RootDeliveryInterface {
  deliver(command: RootDeliveryCommand): Promise<RootDeliveryResult>;
}

export interface RootRemoteAcceptanceCommand {
  view: RootReconciliationView;
  baseBranch: string;
}

export type RootRemoteAcceptanceObservation =
  | { kind: "open_unchanged"; deliveryReferenceId: string; deliveryReferenceVersion: string; pullRequestUrl: string; exactRevision: string }
  | { kind: "merged_exact"; deliveryReferenceId: string; deliveryReferenceVersion: string; pullRequestUrl: string; exactRevision: string }
  | { kind: "changes_requested"; deliveryReferenceId: string; deliveryReferenceVersion: string; pullRequestUrl: string; exactRevision: string }
  | { kind: "closed_unmerged"; deliveryReferenceId: string; deliveryReferenceVersion: string; pullRequestUrl: string; exactRevision: string }
  | { kind: "head_changed"; deliveryReferenceId: string; deliveryReferenceVersion: string; pullRequestUrl: string; expectedRevision: string; observedRevision: string }
  | { kind: "observation_invalid"; reason: "native_facts" | "git_facts" | "pull_request_identity" | "provider_response" | "checks_incomplete" };

export interface RootRemoteAcceptanceInterface {
  observeAcceptance(command: RootRemoteAcceptanceCommand): Promise<RootRemoteAcceptanceObservation>;
}

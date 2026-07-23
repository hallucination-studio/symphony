import type { RootReconcilerClientInterface } from "../api/RootReconcilerClientInterface.js";
import type {
  RootReconcilerAdvanceResult,
  RootReconcilerObservation,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

interface RootReconcilerTransport {
  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconcilerObservation;
  }): Promise<RootReconcilerAdvanceResult>;
  closeRootReconciler(input: { requestId: string; rootIssueId: string; sessionId: string }): Promise<void>;
}

export class PerformerRootReconcilerClientImpl implements RootReconcilerClientInterface {
  private readonly rootsBySession = new Map<string, string>();

  constructor(private readonly transport: RootReconcilerTransport) {}

  async open(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult> {
    const result = await this.transport.openRootReconciler(input);
    this.rootsBySession.set(result.sessionId, input.rootIssueId);
    return result;
  }

  advance(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconcilerObservation;
  }): Promise<RootReconcilerAdvanceResult> {
    return this.transport.advanceRootReconciler(input);
  }

  async close(input: { requestId: string; sessionId: string }): Promise<void> {
    const rootIssueId = this.rootsBySession.get(input.sessionId);
    if (!rootIssueId) throw new Error("root_reconciler_session_unknown");
    await this.transport.closeRootReconciler({ ...input, rootIssueId });
    this.rootsBySession.delete(input.sessionId);
  }
}

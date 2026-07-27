import type { RootReconcilerClientInterface } from "../api/RootReconcilerClientInterface.js";
import type {
  RootDelta,
  RootReconcilerAdvanceResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

interface RootReconcilerTransport {
  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult>;
  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult>;
  closeRootReconciler(input: {
    requestId: string;
    rootIssueId: string;
    sessionId: string;
    reason: "root_terminal" | "turn_failed";
  }): Promise<void>;
}

export class PerformerRootReconcilerClientImpl implements RootReconcilerClientInterface {
  private readonly rootsBySession = new Map<string, string>();

  constructor(private readonly transport: RootReconcilerTransport) {}

  async open(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult> {
    const result = await this.transport.openRootReconciler(input);
    if (
      result.initialResult.kind === "directive" ||
      result.initialResult.failure.continuity.kind === "retained"
    ) {
      this.rootsBySession.set(result.sessionId, input.rootIssueId);
    }
    return result;
  }

  async advance(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult> {
    const result = await this.transport.advanceRootReconciler(input);
    if (result.kind === "failed" && result.failure.continuity.kind === "closed") {
      this.rootsBySession.delete(input.sessionId);
    }
    return result;
  }

  async close(input: {
    requestId: string;
    sessionId: string;
    reason: "root_terminal" | "turn_failed";
  }): Promise<void> {
    const rootIssueId = this.rootsBySession.get(input.sessionId);
    if (!rootIssueId) throw new Error("root_reconciler_session_unknown");
    await this.transport.closeRootReconciler({ ...input, rootIssueId });
    this.rootsBySession.delete(input.sessionId);
  }
}

import type { JsonValue } from "./DesktopViewInterface.js";

export interface PodiumDesktopHostPorts {
  openLinearAuthorization(input: {
    attemptId: string;
    authorizationUrl: string;
  }): Promise<void>;
  resolveRepository(repositoryHandle: string, baseBranch: string): Promise<{
    repositoryHandle: string;
    repositoryIdentity: string;
    repositoryDisplayName: string;
    repositoryRoot: string;
    baseBranch: string;
  }>;
  startConductor(input: {
    bindingId: string;
    conductorId: string;
    conductorShortHash: string;
    linearInstallationId: string;
    organizationId: string;
    repositoryHandle: string;
    repositoryRoot: string;
    baseBranch: string;
  }): Promise<void>;
  stopConductor(conductorId: string): Promise<void>;
  restartConductor(conductorId: string): Promise<void>;
  relayProfile(
    body: Record<string, JsonValue>,
    secretFrame?: Uint8Array,
  ): Promise<JsonValue>;
}

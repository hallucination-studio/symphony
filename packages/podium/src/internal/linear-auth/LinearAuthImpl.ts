import { podiumError } from "../errors.js";
import type { LinearInstallationStoreInterface } from "./api/LinearInstallationStoreInterface.js";
import type { LinearOAuthClientInterface } from "./api/LinearOAuthClientInterface.js";

interface AuthDependencies {
  createId(): string;
  createSecret(): string;
  createState(): string;
  now(): string;
}

export class LinearAuthImpl {
  constructor(
    private readonly store: LinearInstallationStoreInterface,
    private readonly client: LinearOAuthClientInterface,
    private readonly dependencies: AuthDependencies,
  ) {}

  start(): { attemptId: string; state: string } {
    const attemptId = this.dependencies.createId();
    const state = this.dependencies.createState();
    this.store.saveOAuthAttempt({
      attemptId,
      state,
      codeVerifier: this.dependencies.createSecret(),
      createdAt: this.dependencies.now(),
    });
    return { attemptId, state };
  }

  async complete(input: {
    state: string;
    authorizationCode: string;
  }): Promise<{
    status: "connected";
    workspaceName: string;
    observedAt: string;
  }> {
    const attempt = this.store.consumeOAuthAttempt(input.state);
    if (!attempt) {
      throw podiumError(
        "oauth_state_invalid",
        "The Linear authorization attempt is missing or already used.",
        { nextAction: "Reconnect Linear and try again." },
      );
    }
    const installation = await this.client.exchangeAuthorizationCode({
      authorizationCode: input.authorizationCode,
      codeVerifier: attempt.codeVerifier,
    });
    this.store.saveLinearInstallation(installation);
    return {
      status: "connected",
      workspaceName: installation.organizationId,
      observedAt: this.dependencies.now(),
    };
  }

  async refresh(installationId: string): Promise<void> {
    const installation = this.store.getLinearInstallation(installationId);
    if (!installation) {
      throw podiumError(
        "linear_installation_missing",
        "The Linear installation is not available.",
        { nextAction: "Reconnect Linear." },
      );
    }
    const refreshed = await this.client.refresh({
      refreshToken: installation.refreshToken,
    });
    this.store.saveLinearInstallation({ ...installation, ...refreshed });
  }
}

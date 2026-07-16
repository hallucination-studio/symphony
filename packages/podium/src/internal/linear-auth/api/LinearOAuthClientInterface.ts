import type { LinearInstallation } from "../../models.js";

export interface LinearOAuthClientInterface {
  exchangeAuthorizationCode(input: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<LinearInstallation>;

  refresh(input: {
    refreshToken: string;
  }): Promise<Omit<LinearInstallation, "installationId" | "organizationId">>;
}

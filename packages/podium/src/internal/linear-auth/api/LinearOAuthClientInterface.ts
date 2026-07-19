import type { OAuthLinearInstallation } from "../../models.js";

export interface LinearOAuthClientInterface {
  exchangeAuthorizationCode(input: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<OAuthLinearInstallation>;

  refresh(input: {
    refreshToken: string;
  }): Promise<Omit<OAuthLinearInstallation, "installationId" | "organizationId">>;
}

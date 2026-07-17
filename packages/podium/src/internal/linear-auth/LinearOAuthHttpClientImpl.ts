import { randomUUID } from "node:crypto";

import type { LinearOAuthClientInterface } from "./api/LinearOAuthClientInterface.js";
import { LinearSdkImpl } from "../linear-gateway/internal/LinearSdkImpl.js";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export class LinearOAuthHttpClientImpl implements LinearOAuthClientInterface {
  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      fetch: typeof globalThis.fetch;
      now(): number;
    },
  ) {}

  authorizationUrl(input: { state: string; codeChallenge: string }): string {
    const url = new URL("https://linear.app/oauth/authorize");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("actor", "app");
    url.searchParams.set(
      "scope",
      "read,write,issues:create,comments:create,app:assignable",
    );
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    authorizationCode: string;
    codeVerifier: string;
  }) {
    const token = await this.#token({
      grant_type: "authorization_code",
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      redirect_uri: this.config.redirectUri,
    });
    const organizationId = await LinearSdkImpl.discoverOrganizationId(
      token.access_token,
    );
    return {
      installationId: randomUUID(),
      organizationId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiresAt(this.config.now(), token.expires_in),
    };
  }

  async refresh(input: { refreshToken: string }) {
    const token = await this.#token({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiresAt(this.config.now(), token.expires_in),
    };
  }

  async #token(values: Record<string, string>): Promise<TokenResponse> {
    const response = await this.config.fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...values,
      }),
    });
    if (!response.ok) throw new Error("linear_oauth_exchange_failed");
    const value = (await response.json()) as Partial<TokenResponse>;
    if (
      typeof value.access_token !== "string" ||
      typeof value.refresh_token !== "string" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in! < 1
    ) {
      throw new Error("linear_oauth_response_invalid");
    }
    return value as TokenResponse;
  }
}

function expiresAt(now: number, expiresIn: number): string {
  return new Date(now + expiresIn * 1_000).toISOString();
}

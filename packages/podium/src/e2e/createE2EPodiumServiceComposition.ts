import type { PodiumDesktopHostPorts } from "../public/PodiumDesktopHostPorts.js";
import type { PodiumClientServices } from "../public/PodiumClientProtocolHandler.js";
import type { PodiumConductorServices } from "../public/PodiumConductorProtocolHandler.js";
import { PodiumClientServicesImpl, createLinearAuth } from "../internal/composition/PodiumClientServicesImpl.js";
import { PodiumConductorServicesImpl } from "../internal/composition/PodiumConductorServicesImpl.js";
import { LinearOAuthHttpClientImpl } from "../internal/linear-auth/LinearOAuthHttpClientImpl.js";
import type { LinearClientInterface } from "../internal/linear-gateway/api/LinearClientInterface.js";
import { LinearSdkImpl } from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { ProjectCatalogUseCase } from "../internal/project-catalog/ProjectCatalogUseCase.js";
import { TemporaryPodiumStore } from "./TemporaryPodiumStore.js";

const INSTALLATION_ID = "e2e-linear-app";

export interface E2EPodiumServiceComposition {
  conductorServices: PodiumConductorServices;
  createClientServices(host: PodiumDesktopHostPorts): PodiumClientServices;
  close(): void;
}

export async function createE2EPodiumServiceComposition(input: {
  linearClientId: string;
  linearClientSecret: string;
  projectSlug: string;
  projectName: string;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  createLinearSdk?: (
    accessToken: string,
    organizationId: string,
  ) => LinearClientInterface;
  discoverOrganizationId?: (accessToken: string) => Promise<string>;
}): Promise<E2EPodiumServiceComposition> {
  const linearClientId = required(input.linearClientId, "e2e_linear_client_id_invalid");
  const linearClientSecret = required(
    input.linearClientSecret,
    "e2e_linear_client_secret_invalid",
  );
  const projectSlug = required(input.projectSlug, "e2e_linear_project_slug_invalid");
  const projectName = required(input.projectName, "e2e_linear_project_name_invalid");
  const fetch = input.fetch ?? globalThis.fetch;
  const accessToken = await requestAppToken(fetch, linearClientId, linearClientSecret);
  const organizationId = await (
    input.discoverOrganizationId ?? LinearSdkImpl.discoverOrganizationId
  )(accessToken);
  const createLinearSdk =
    input.createLinearSdk ??
    ((token: string, organization: string) =>
      new LinearSdkImpl(token, organization));
  const store = new TemporaryPodiumStore({
    installationId: INSTALLATION_ID,
    organizationId,
    accessToken,
  });
  const sdk = createLinearSdk(accessToken, organizationId);
  const projects = await new ProjectCatalogUseCase(store, sdk).refresh(
    INSTALLATION_ID,
  );
  if (
    !projects.some(
      (project) =>
        project.slugId === projectSlug && project.name === projectName,
    )
  ) {
    store.close();
    throw new Error("e2e_linear_project_not_allowlisted");
  }

  const now = input.now ?? (() => new Date().toISOString());
  const oauthHttp = new LinearOAuthHttpClientImpl({
    clientId: linearClientId,
    clientSecret: linearClientSecret,
    redirectUri: "symphony://oauth/linear/callback",
    fetch,
    now: () => Date.parse(now()),
  });
  return {
    conductorServices: new PodiumConductorServicesImpl(store, {
      now,
      sleep: (delayMs) =>
        new Promise((resolve) => setTimeout(resolve, delayMs)),
      createLinearSdk,
    }),
    createClientServices: (host) =>
      new PodiumClientServicesImpl(
        store,
        createLinearAuth(store, oauthHttp, now),
        oauthHttp,
        host,
        now,
        createLinearSdk,
      ),
    close: () => store.close(),
  };
}

async function requestAppToken(
  fetch: typeof globalThis.fetch,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) throw new Error("e2e_linear_app_token_failed");
  const body = (await response.json()) as { access_token?: unknown };
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length < 1 ||
    body.access_token.length > 16_384
  ) {
    throw new Error("e2e_linear_app_token_invalid");
  }
  return body.access_token;
}

function required(value: string, code: string): string {
  if (!value || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

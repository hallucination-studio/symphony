import {
  LinearSdkImpl,
  type LinearPhysicalRequestObservation,
} from "../internal/linear-gateway/internal/LinearSdkImpl.js";
import { SqlitePodiumStoreImpl } from "../internal/storage/SqlitePodiumStoreImpl.js";

export interface DevelopmentTokenInstallationView {
  installationId: string;
  organizationId: string;
}

export interface DevelopmentTokenTargetProject {
  projectId: string;
  name: string;
  updatedAt: string;
}

export async function bootstrapDevelopmentTokenInstallation(input: {
  databasePath: string;
  developmentToken: string;
  delegateActorId: string;
  targetProject?: DevelopmentTokenTargetProject;
  observeLinearRequest?: (observation: LinearPhysicalRequestObservation) => void;
  discoverOrganizationId?: (
    accessToken: string,
    observe?: (observation: LinearPhysicalRequestObservation) => void,
  ) => Promise<string>;
}): Promise<DevelopmentTokenInstallationView> {
  if (!input.developmentToken) throw new Error("linear_development_token_missing");
  if (!input.delegateActorId) throw new Error("linear_development_token_actor_missing");
  validateTargetProject(input.targetProject);
  const discoverOrganizationId =
    input.discoverOrganizationId ??
    LinearSdkImpl.discoverDevelopmentTokenOrganizationId;
  let organizationId: string;
  try {
    const observe = input.observeLinearRequest;
    organizationId = await discoverOrganizationId(
      input.developmentToken,
      observe,
    );
  } catch {
    throw new Error("linear_development_token_invalid");
  }
  if (!organizationId) throw new Error("linear_development_token_organization_missing");

  const installationId = `development-token:${organizationId}`;
  const store = new SqlitePodiumStoreImpl(input.databasePath);
  try {
    store.saveLinearInstallation({
      kind: "development_token",
      installationId,
      organizationId,
      delegateActorId: input.delegateActorId,
      accessToken: input.developmentToken,
    });
    if (input.targetProject) {
      store.saveProject({
        projectId: input.targetProject.projectId,
        installationId,
        organizationId,
        name: input.targetProject.name,
        updatedAt: input.targetProject.updatedAt,
      });
    }
  } finally {
    store.close();
  }
  return Object.freeze({ installationId, organizationId });
}

function validateTargetProject(value: DevelopmentTokenTargetProject | undefined): void {
  if (value === undefined) return;
  if (!IDENTIFIER.test(value.projectId) || value.name.length === 0 || value.name.length > 512 ||
      !TIMESTAMP.test(value.updatedAt) || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("linear_development_token_project_invalid");
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

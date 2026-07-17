import type {
  ConductorBinding,
  LinearCredential,
  LinearInstallation,
  OAuthAttempt,
  ProjectCatalogEntry,
  RuntimeObservation,
} from "../internal/models.js";
import type { LinearInstallationStoreInterface } from "../internal/linear-auth/api/LinearInstallationStoreInterface.js";
import type {
  PodiumClientStoreInterface,
  PodiumConductorStoreInterface,
} from "../internal/composition/PodiumStoreInterfaces.js";

export class TemporaryPodiumStore
  implements
    LinearInstallationStoreInterface,
    PodiumClientStoreInterface,
    PodiumConductorStoreInterface
{
  #credential: LinearCredential | undefined;
  readonly #projects = new Map<string, ProjectCatalogEntry>();
  #binding: ConductorBinding | undefined;
  readonly #observations = new Map<string, RuntimeObservation>();

  constructor(credential: LinearCredential) {
    this.#credential = credential;
  }

  saveLinearInstallation(): void {
    throw new Error("e2e_linear_oauth_disabled");
  }

  getLinearInstallation(): LinearInstallation | undefined {
    return undefined;
  }

  getLinearCredential(installationId: string): LinearCredential | undefined {
    return this.#credential?.installationId === installationId
      ? this.#credential
      : undefined;
  }

  getOnlyLinearCredential(): LinearCredential | undefined {
    return this.#credential;
  }

  saveOAuthAttempt(): void {
    throw new Error("e2e_linear_oauth_disabled");
  }

  consumeOAuthAttempt(): OAuthAttempt | undefined {
    return undefined;
  }

  replaceProjects(
    installationId: string,
    projects: ReadonlyArray<ProjectCatalogEntry>,
  ): void {
    if (installationId !== this.#credential?.installationId) {
      throw new Error("linear_installation_missing");
    }
    this.#projects.clear();
    for (const project of projects) this.#projects.set(project.projectId, project);
  }

  listProjects(installationId: string): ProjectCatalogEntry[] {
    if (installationId !== this.#credential?.installationId) return [];
    return [...this.#projects.values()].sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.projectId.localeCompare(right.projectId),
    );
  }

  getProject(projectId: string): ProjectCatalogEntry | undefined {
    return this.#projects.get(projectId);
  }

  saveConductorBinding(binding: ConductorBinding): void {
    if (this.#binding && this.#binding.bindingId !== binding.bindingId) {
      throw new Error("conductor_binding_already_exists");
    }
    this.#binding = binding;
  }

  getConductorBinding(): ConductorBinding | undefined {
    return this.#binding;
  }

  setConductorDesiredState(
    bindingId: string,
    desiredState: ConductorBinding["desiredState"],
  ): void {
    if (!this.#binding || this.#binding.bindingId !== bindingId) {
      throw new Error("conductor_binding_missing");
    }
    this.#binding = { ...this.#binding, desiredState };
  }

  saveRuntimeObservation(observation: RuntimeObservation): void {
    this.#observations.set(observation.bindingId, observation);
  }

  getRuntimeObservation(bindingId: string): RuntimeObservation | undefined {
    return this.#observations.get(bindingId);
  }

  close(): void {
    this.#credential = undefined;
    this.#projects.clear();
    this.#binding = undefined;
    this.#observations.clear();
  }
}

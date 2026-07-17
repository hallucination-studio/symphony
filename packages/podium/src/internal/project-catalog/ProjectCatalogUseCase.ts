import type { LinearCredentialStoreInterface } from "../linear-auth/api/LinearCredentialStoreInterface.js";
import type { LinearClientInterface } from "../linear-gateway/api/LinearClientInterface.js";
import type { ProjectCatalogEntry } from "../models.js";

const PAGE_LIMIT = 250;

export class ProjectCatalogUseCase {
  constructor(
    private readonly store: LinearCredentialStoreInterface,
    private readonly client: Pick<LinearClientInterface, "listProjects">,
  ) {}

  async refresh(installationId: string): Promise<ProjectCatalogEntry[]> {
    const installation = this.store.getLinearCredential(installationId);
    if (!installation) throw new Error("linear_installation_missing");

    const projects: ProjectCatalogEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listProjects({
        ...(cursor ? { cursor } : {}),
        limit: PAGE_LIMIT,
      });
      for (const project of page.items) {
        if (project.organizationId !== installation.organizationId) {
          throw new Error("linear_project_organization_mismatch");
        }
        projects.push({
          ...project,
          installationId,
        });
      }
      cursor = page.pageInfo.hasNextPage
        ? page.pageInfo.endCursor
        : undefined;
      if (page.pageInfo.hasNextPage && !cursor) {
        throw new Error("linear_pagination_cursor_missing");
      }
    } while (cursor);

    this.store.replaceProjects(installationId, projects);
    return this.store.listProjects(installationId);
  }
}

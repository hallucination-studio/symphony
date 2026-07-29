import type {
  AcceptedProjectRootIndex,
  ConductorProjectResolution,
  ProjectRootHeader,
  ProjectRootIndexFailure,
  ProjectRootIndexRecoveryInterface,
  ProjectRootIndexRecoveryResult,
  ProjectRootIndexSourceInterface,
} from "../api/ProjectRootIndexRecoveryInterface.js";

const PAGE_SIZE = 8;
const MAX_ROOTS = 512;

export class ProjectRootIndexRecoveryImpl implements ProjectRootIndexRecoveryInterface {
  private accepted: AcceptedProjectRootIndex | undefined;
  private generation = 0;

  constructor(private readonly options: {
    source: ProjectRootIndexSourceInterface;
    conductorShortHash: string;
  }) {}

  current(): AcceptedProjectRootIndex | undefined {
    return this.accepted;
  }

  async recover(): Promise<ProjectRootIndexRecoveryResult> {
    const generation = ++this.generation;
    let resolution: ConductorProjectResolution;
    try {
      resolution = await this.options.source.resolveProject();
    } catch {
      return this.failed(generation, failure("project_resolution_transport_failed", "transport", true));
    }
    if (generation !== this.generation) return this.stale();
    if (resolution.kind === "failed") return this.failed(generation, resolution.failure);
    if (resolution.kind !== "resolved") {
      return this.failed(generation, failure(`project_resolution_${resolution.kind}`, "linear", false));
    }
    if (!validResolution(resolution, this.options.conductorShortHash)) {
      return this.failed(generation, failure("project_resolution_incomplete", "schema", false));
    }

    const roots: ProjectRootHeader[] = [];
    const rootIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      let pageResult;
      try {
        pageResult = await this.options.source.readProjectRootIndexPage({
          projectId: resolution.projectId,
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch {
        return this.failed(generation, failure("project_root_index_transport_failed", "transport", true));
      }
      if (generation !== this.generation) return this.stale();
      if (pageResult.kind === "failed") return this.failed(generation, pageResult.failure);
      const page = pageResult.page;
      if (page.roots.length > PAGE_SIZE) {
        return this.failed(generation, failure("project_root_index_page_oversized", "schema", false));
      }
      for (const root of page.roots) {
        if (rootIds.has(root.issueId)) {
          return this.failed(generation, failure("project_root_index_root_duplicate", "schema", false));
        }
        if (!validHeader(root, resolution, this.options.conductorShortHash)) {
          return this.failed(generation, failure("project_root_index_routing_incomplete", "schema", false));
        }
        if (roots.length >= MAX_ROOTS) {
          return this.failed(generation, failure("project_root_index_limit_exceeded", "schema", false));
        }
        rootIds.add(root.issueId);
        roots.push(copyHeader(root));
      }
      if (!page.hasNextPage) {
        hasNextPage = false;
        continue;
      }
      if (roots.length >= MAX_ROOTS) {
        return this.failed(generation, failure("project_root_index_limit_exceeded", "schema", false));
      }
      if (page.endCursor === undefined || page.endCursor.length === 0) {
        return this.failed(generation, failure("project_root_index_cursor_missing", "schema", false));
      }
      if (cursors.has(page.endCursor)) {
        return this.failed(generation, failure("project_root_index_cursor_repeated", "schema", false));
      }
      cursors.add(page.endCursor);
      cursor = page.endCursor;
    }

    if (generation !== this.generation) return this.stale();
    const index = deepFreeze({
      projectId: resolution.projectId,
      teamId: resolution.teamId,
      conductorPool: resolution.conductorPool.map(({ conductorShortHash }) => ({ conductorShortHash })),
      roots,
    });
    this.accepted = index;
    return { kind: "accepted", index };
  }

  private stale(): ProjectRootIndexRecoveryResult {
    return { kind: "stale", ...(this.accepted === undefined ? {} : { accepted: this.accepted }) };
  }

  private failed(generation: number, error: ProjectRootIndexFailure): ProjectRootIndexRecoveryResult {
    if (generation !== this.generation) return this.stale();
    return { kind: "failed", failure: error, ...(this.accepted === undefined ? {} : { accepted: this.accepted }) };
  }
}

function validResolution(
  resolution: Extract<ConductorProjectResolution, { kind: "resolved" }>,
  conductorShortHash: string,
): boolean {
  return resolution.projectId.length > 0
    && resolution.teamId.length > 0
    && conductorShortHash.length > 0
    && resolution.conductorPool.length > 0
    && resolution.conductorPool.every(({ conductorShortHash: hash }) => hash.length > 0)
    && new Set(resolution.conductorPool.map(({ conductorShortHash: hash }) => hash)).size === resolution.conductorPool.length
    && resolution.conductorPool.some(({ conductorShortHash: hash }) => hash === conductorShortHash);
}

function validHeader(
  root: ProjectRootHeader,
  resolution: Extract<ConductorProjectResolution, { kind: "resolved" }>,
  conductorShortHash: string,
): boolean {
  return root.issueId.length > 0
    && root.identifier.length > 0
    && root.projectId === resolution.projectId
    && root.teamId === resolution.teamId
    && root.parentIssueId === null
    && root.issueKind === "root"
    && root.routeConductorShortHashes.length === 1
    && resolution.conductorPool.some(({ conductorShortHash: hash }) => hash === root.routeConductorShortHashes[0])
    && resolution.conductorPool.some(({ conductorShortHash: hash }) => hash === conductorShortHash);
}

function copyHeader(root: ProjectRootHeader): ProjectRootHeader {
  return {
    ...root,
    routeConductorShortHashes: [...root.routeConductorShortHashes],
    blockers: root.blockers.map((blocker) => ({ ...blocker })),
  };
}

function failure(
  code: string,
  category: ProjectRootIndexFailure["category"],
  retryable: boolean,
): ProjectRootIndexFailure {
  return { code, category, retryable };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

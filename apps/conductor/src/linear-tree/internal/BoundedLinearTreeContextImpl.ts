import type {
  LinearContextSection,
  LinearTreeContextInterface,
  LinearTreeContextSnapshot,
} from "../api/LinearTreeContextInterface.js";

export interface BoundedContextSection<T> {
  items: T[];
  returned: number;
  cap: number;
  has_more: boolean;
  partial: boolean;
  include_errors: Array<{ code: string; sanitized_reason: string }>;
}

export interface BoundedLinearTreeContext {
  root: BoundedContextSection<unknown>;
  tree: BoundedContextSection<unknown>;
  ancestors: BoundedContextSection<unknown>;
  comments: BoundedContextSection<unknown>;
  relations: BoundedContextSection<unknown>;
}

export class BoundedLinearTreeContextImpl {
  constructor(private readonly source: LinearTreeContextInterface) {}

  async read(rootIssueId: string): Promise<BoundedLinearTreeContext> {
    const snapshot = await this.source.readRootContext(rootIssueId);
    return {
      root: bound("root", snapshot.root),
      tree: bound("tree", snapshot.tree),
      ancestors: bound("ancestors", snapshot.ancestors),
      comments: bound("comments", snapshot.comments),
      relations: bound("relations", snapshot.relations),
    };
  }
}

function bound(name: keyof LinearTreeContextSnapshot, section: LinearContextSection): BoundedContextSection<unknown> {
  if (!Number.isSafeInteger(section.cap) || section.cap < 0) {
    throw new Error(`linear_context_${name}_cap_invalid`);
  }
  if (section.items.length > section.cap) {
    throw new Error(`linear_context_${name}_cap_exceeded`);
  }
  if (section.includeErrors.length > 8) {
    throw new Error(`linear_context_${name}_include_errors_exceeded`);
  }
  return {
    items: [...section.items],
    returned: section.items.length,
    cap: section.cap,
    has_more: section.hasMore,
    partial: section.hasMore || section.includeErrors.length > 0,
    include_errors: section.includeErrors.map(({ code, sanitized_reason }) => ({
      code,
      sanitized_reason,
    })),
  };
}

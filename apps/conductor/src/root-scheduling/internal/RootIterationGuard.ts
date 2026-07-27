export class RootIterationGuard {
  readonly #activeRootIds = new Set<string>();

  tryAcquire(rootIssueId: string): (() => void) | undefined {
    if (this.#activeRootIds.has(rootIssueId)) return undefined;
    this.#activeRootIds.add(rootIssueId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeRootIds.delete(rootIssueId);
    };
  }
}

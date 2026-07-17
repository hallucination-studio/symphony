import { useRef, useState } from "react";

import { ConductorsPage } from "./ConductorsPage";
import type {
  CommandHandler,
  DesktopState,
  RepositorySelection,
  SecretHandler,
} from "./types";

export function SetupView({
  state,
  onCommand,
  onSecret,
  onChooseRepository,
  onBeginCreateConductor,
}: {
  state: DesktopState;
  onCommand: CommandHandler;
  onSecret: SecretHandler;
  onChooseRepository: () => Promise<RepositorySelection | undefined>;
  onBeginCreateConductor: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [projectId, setProjectId] = useState(state.kind === "conductor-setup" ? state.projects[0]?.id ?? "" : "");
  const [repository, setRepository] = useState<RepositorySelection>();
  const [error, setError] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const chooseRepository = async () => {
    setError(undefined);
    try {
      const selection = await onChooseRepository();
      if (selection) setRepository(selection);
    } catch {
      setRepository(undefined);
      setError("Repository selection or validation failed. Choose a Git repository and try again.");
    }
  };
  const createConductor = async () => {
    if (!projectId || !repository || isCreating) return;
    setError(undefined);
    setIsCreating(true);
    try {
      const result = await onCommand({ kind: "create_conductor", projectId, repository });
      if (result.kind === "rejected") {
        setError("Conductor creation was not accepted. Review the selection and try again.");
        setIsCreating(false);
      }
    } catch {
      setError("Conductor creation was not accepted. Review the selection and try again.");
      setIsCreating(false);
    }
  };
  if (state.kind === "loading") {
    return (
      <main className="setup-layout" aria-busy="true">
        <section className="setup-card skeleton">
          <p className="eyebrow">Symphony</p>
          <h1>Reading {state.objectLabel ?? "Desktop state"}…</h1>
          <div /><div /><div />
        </section>
      </main>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <main className="setup-layout">
        <section className="setup-card error-panel" role="alert">
          <p className="eyebrow">Unavailable</p><h1>{state.summary}</h1><p>{state.nextAction}</p>
        </section>
      </main>
    );
  }
  if (state.kind === "linear-setup") {
    return (
      <main className="setup-layout">
        <section className="setup-card">
          <p className="eyebrow">Setup · 1 of 3</p>
          <h1 ref={headingRef}>Connect Symphony to Linear</h1>
          <p>Linear is the workflow authority. Authorization opens in your browser; credentials never enter this view.</p>
          <button className="button primary full-width" onClick={() => onCommand({ kind: "connect_linear" })}>Connect Linear</button>
        </section>
      </main>
    );
  }
  if (state.kind === "conductor-setup") {
    return (
      <main className="setup-layout"><section className="setup-card"><p className="eyebrow">Setup · 2 of 3</p><h1>Create Conductor</h1><p>Select one Project, a Git repository, and its base branch. Repository selection uses the native picker.</p>
        <label>Linear Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <button className="button full-width" onClick={() => void chooseRepository()}>Choose Git repository</button>
        {repository && <label>Base branch<select value={repository.baseBranch} onChange={(event) => setRepository({ ...repository, baseBranch: event.target.value })}>{repository.baseBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label>}
        {repository && <p className="selection-summary">{repository.displayName} · {repository.baseBranch}</p>}
        {error && <p role="alert">{error}</p>}
        <button className="button primary full-width" disabled={!projectId || !repository || isCreating} onClick={() => void createConductor()}>{isCreating ? "Creating…" : "Create Conductor"}</button>
      </section></main>
    );
  }
  if (state.kind !== "profile-setup") {
    return null;
  }
  return (
    <main className="setup-detail">
      <p className="eyebrow">Setup · 3 of 3</p>
      <ConductorsPage
        conductors={[state.conductorDetail.summary]}
        detail={state.conductorDetail}
        headingRef={headingRef}
        onSelect={() => undefined}
        onCommand={onCommand}
        onSecret={onSecret}
        onBeginCreateConductor={onBeginCreateConductor}
      />
    </main>
  );
}

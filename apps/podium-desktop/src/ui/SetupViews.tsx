import { useRef, useState } from "react";

import { ConductorsPage } from "./ConductorsPage";
import { BrandMark } from "./components";
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
  const setupStep =
    state.kind === "linear-setup" ? 1
    : state.kind === "conductor-setup" ? 2
    : state.kind === "profile-setup" ? 3
    : 0;
  // The bar lives outside the keyed body so it persists across steps and
  // its fill width transitions instead of remounting.
  const progress = setupStep > 0 && (
    <div
      className="setup-progress"
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={3}
      aria-valuenow={setupStep}
    >
      <div className="setup-progress-fill" data-step={setupStep} />
    </div>
  );
  if (
    state.kind === "loading" ||
    state.kind === "unavailable" ||
    state.kind === "linear-setup" ||
    state.kind === "conductor-setup"
  ) {
    return (
      <main className="setup-layout" aria-busy={state.kind === "loading" || undefined}>
        <section
          className={`setup-card${state.kind === "loading" ? " skeleton" : ""}${state.kind === "unavailable" ? " error-panel" : ""}`}
          role={state.kind === "unavailable" ? "alert" : undefined}
        >
          {progress}
          <div className="setup-card-body" key={state.kind}>
            {state.kind === "loading" && (
              <>
                <BrandMark />
                <p className="eyebrow">Symphony</p>
                <h1>Reading {state.objectLabel ?? "Desktop state"}…</h1>
                <div /><div /><div />
              </>
            )}
            {state.kind === "unavailable" && (
              <>
                <p className="eyebrow">Unavailable</p>
                <h1>{state.summary}</h1>
                <p>{state.nextAction}</p>
              </>
            )}
            {state.kind === "linear-setup" && (
              <>
                <BrandMark />
                <p className="eyebrow">Setup · 1 of 3</p>
                <h1 ref={headingRef}>Connect Symphony to Linear</h1>
                <p>Linear is the workflow authority. Authorization opens in your browser; credentials never enter this view.</p>
                <button className="button primary full-width" onClick={() => onCommand({ kind: "connect_linear" })}>Connect Linear</button>
              </>
            )}
            {state.kind === "conductor-setup" && (
              <>
                <BrandMark />
                <p className="eyebrow">Setup · 2 of 3</p>
                <h1>Create Conductor</h1>
                <p>Select one Project, a Git repository, and its base branch. Repository selection uses the native picker.</p>
                <label>Linear Project<select data-testid="project-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                <button data-testid="choose-repository" className="button full-width" onClick={() => void chooseRepository()}>Choose Git repository</button>
                {repository && <label>Base branch<select data-testid="base-branch-select" value={repository.baseBranch} onChange={(event) => setRepository({ ...repository, baseBranch: event.target.value })}>{repository.baseBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label>}
                {repository && <p className="selection-summary">{repository.displayName} · {repository.baseBranch}</p>}
                {error && <p role="alert">{error}</p>}
                <button data-testid="create-conductor" className="button primary full-width" disabled={!projectId || !repository || isCreating} aria-busy={isCreating} onClick={() => void createConductor()}>{isCreating && <span className="button-spinner" aria-hidden="true" />}{isCreating ? "Creating…" : "Create Conductor"}</button>
              </>
            )}
          </div>
        </section>
      </main>
    );
  }
  if (state.kind !== "profile-setup") {
    return null;
  }
  return (
    <main className="setup-detail">
      <p className="eyebrow">Setup · 3 of 3</p>
      {progress}
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

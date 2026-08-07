import { useState, type FormEvent, type RefObject } from "react";

import { BindingRow, ConfirmDialog, Dialog, EmptyState, Notice, PageHeading, StatusBadge } from "./components";
import type {
  CommandHandler,
  LinearConnectionView,
  LinearProjectView,
  ProjectBindingDraftView,
  ProjectBindingView,
} from "./types";

type BindingFormState = Omit<ProjectBindingView, "id"> & { id?: string };
type RequiredField = "projectId" | "routingLabel" | "repositoryPath" | "baseBranch" | "concurrency";
type FieldErrors = Partial<Record<RequiredField, string>>;

const blankBinding = (): BindingFormState => ({
  projectId: "",
  routingLabel: "",
  repositoryPath: "",
  baseBranch: "main",
  concurrency: 1,
  reconcile_agent: "codex",
  reconcile_model: null,
  reconcile_reasoning_effort: null,
  artist_agent: "codex",
  artist_model: null,
  artist_reasoning_effort: null,
  critic_agent: "codex",
  critic_model: null,
  critic_reasoning_effort: null,
});

export function SettingsPage({
  bindings,
  linear,
  headingRef,
  onCommand,
  onPickDirectory,
}: {
  bindings: ProjectBindingView[];
  linear: LinearConnectionView;
  headingRef: RefObject<HTMLHeadingElement>;
  onCommand: CommandHandler;
  onPickDirectory?: (() => Promise<string | null>) | undefined;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<BindingFormState>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [pending, setPending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [projects, setProjects] = useState<LinearProjectView[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  const beginCreate = () => {
    setEditingId(undefined);
    setForm(blankBinding());
    setConfirmingDelete(false);
    setFieldErrors({});
    setError(undefined);
    setMessage(undefined);
    void loadProjects();
  };

  // The editor works on a snapshot: the Tauri host polls every 2s, and
  // re-syncing mid-edit would clobber in-progress input.
  const beginEdit = (binding: ProjectBindingView) => {
    setEditingId(binding.id);
    setForm(toForm(binding));
    setConfirmingDelete(false);
    setFieldErrors({});
    setError(undefined);
    setMessage(undefined);
    void loadProjects();
  };

  const closeEditor = () => {
    if (pending) return;
    setForm(undefined);
    setEditingId(undefined);
    setConfirmingDelete(false);
    setFieldErrors({});
    setError(undefined);
  };

  const updateField = <K extends keyof BindingFormState>(field: K, value: BindingFormState[K]) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
    setFieldErrors((current) => (field in current ? { ...current, [field]: undefined } : current));
  };

  async function browseRepositoryPath() {
    if (!onPickDirectory || pending) return;
    const selected = await onPickDirectory();
    if (selected) updateField("repositoryPath", selected);
  }

  async function loadProjects() {
    if (loadingProjects || linear.status !== "connected") return;
    setLoadingProjects(true);
    setError(undefined);
    try {
      const result = await onCommand({ kind: "list_linear_projects" });
      if (result.kind === "projects") {
        setProjects(result.projects);
      } else if (result.kind === "rejected") {
        setError(result.sanitizedReason);
      }
    } catch {
      setError("Linear projects could not be loaded.");
    } finally {
      setLoadingProjects(false);
    }
  }

  async function connectLinear() {
    if (connecting) return;
    setConnecting(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await onCommand({ kind: "connect_linear" });
      if (result.kind === "rejected") {
        // A cancelled authorization is operator intent, not a failure.
        if (result.sanitizedReason === "linear_authorization_cancelled") {
          setMessage("Connection cancelled.");
        } else {
          setError(result.sanitizedReason);
        }
        return;
      }
      setMessage("Linear connected. Select a project to continue.");
      const projectsResult = await onCommand({ kind: "list_linear_projects" });
      if (projectsResult.kind === "projects") {
        setProjects(projectsResult.projects);
      } else if (projectsResult.kind === "rejected") {
        setError(projectsResult.sanitizedReason);
      }
    } catch {
      setError("Linear could not be connected.");
    } finally {
      setConnecting(false);
    }
  }

  function cancelConnect() {
    if (!connecting) return;
    void onCommand({ kind: "cancel_linear_connect" });
  }

  async function disconnectLinear() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await onCommand({ kind: "disconnect_linear" });
      if (result.kind === "rejected") {
        setError(result.sanitizedReason);
      } else {
        setMessage("Linear disconnected. Bindings stay saved until you reconnect.");
      }
    } catch {
      setError("Linear could not be disconnected.");
    } finally {
      setPending(false);
      setConfirmingDisconnect(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || pending) return;
    const errors = validateForm(form);
    if (form.projectId && !projects.some((project) => project.id === form.projectId)) {
      errors.projectId = "Choose a project returned by Linear.";
    }
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) return;
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    const binding = toCommandBinding(form);
    try {
      const command = editingId
        ? { kind: "update_binding" as const, binding: { ...binding, id: editingId } }
        : { kind: "create_binding" as const, binding };
      const result = await onCommand(command);
      if (result.kind === "rejected") {
        setError(result.sanitizedReason);
      } else {
        setMessage(editingId ? "Binding saved." : "Binding created.");
        setForm(undefined);
        setEditingId(undefined);
      }
    } catch {
      setError("The binding could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function removeBinding() {
    if (!editingId || pending) return;
    setPending(true);
    setError(undefined);
    const result = await onCommand({ kind: "delete_binding", bindingId: editingId });
    if (result.kind === "rejected") {
      setConfirmingDelete(false);
      setError(result.sanitizedReason);
    } else {
      setForm(undefined);
      setEditingId(undefined);
      setConfirmingDelete(false);
      setMessage("Binding deleted.");
    }
    setPending(false);
  }

  return (
    <>
      <PageHeading
        title="Settings"
        description="Create and edit Project Bindings and their three role launch values."
        headingRef={headingRef}
      />
      <div className="page-stack">
        {message && <Notice tone="positive">{message}</Notice>}
        {error && !form && <Notice tone="negative">{error}</Notice>}
        <section className="panel" aria-labelledby="settings-linear-heading">
          <div className="section-heading">
            <h2 id="settings-linear-heading">Linear connection</h2>
            <StatusBadge
              label={linearStatusLabel(linear)}
              tone={linear.status === "connected" ? "positive" : linear.status === "reconnect_required" ? "negative" : "neutral"}
            />
          </div>
          {linear.status === "connected" ? (
            <>
              <p className="quiet">Connected to {linear.organization}. Projects are read from this Linear account.</p>
              <div className="button-row">
                <button className="button" type="button" disabled={pending || loadingProjects} onClick={() => void loadProjects()}>
                  {loadingProjects ? "Loading projects…" : "Refresh projects"}
                </button>
                <button className="button destructive" type="button" disabled={pending} onClick={() => setConfirmingDisconnect(true)}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="quiet">Connect Linear before choosing a Project Binding.</p>
              <div className="button-row">
                <button className="button primary" type="button" disabled={connecting} onClick={() => void connectLinear()}>
                  {connecting && <span className="button-spinner" aria-hidden="true" />}
                  {connecting
                    ? "Waiting for the browser…"
                    : linear.status === "reconnect_required"
                      ? "Reconnect Linear"
                      : "Connect Linear"}
                </button>
                {connecting && (
                  <button className="button" type="button" onClick={cancelConnect}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </section>
        <section className="panel" aria-labelledby="settings-bindings-heading">
          <div className="section-heading">
            <h2 id="settings-bindings-heading">Project Bindings</h2>
            <button className="button primary" type="button" disabled={linear.status !== "connected" || pending} onClick={beginCreate}>
              New binding
            </button>
          </div>
          {bindings.length === 0 ? (
            <EmptyState title="No bindings" body="Create a binding to route Linear Roots to a repository." />
          ) : (
            <ul className="plain-list" aria-label="Configured Project Bindings">
              {bindings.map((binding) => (
                <BindingRow
                  key={binding.id}
                  binding={binding}
                  trailing={
                    <button className="button compact" type="button" onClick={() => beginEdit(binding)}>
                      Edit binding
                    </button>
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="settings-runtime-heading">
          <div className="section-heading">
            <h2 id="settings-runtime-heading">Role defaults</h2>
            <span>Closed launch contract</span>
          </div>
          <p className="quiet">Each Reconcile, Artist, and Critic role uses Codex. Model and reasoning effort overrides are optional.</p>
        </section>
      </div>

      {form && !confirmingDelete && (
        <Dialog labelId="binding-editor-heading" onClose={closeEditor}>
          <div className="section-heading">
            <h2 id="binding-editor-heading">{editingId ? "Edit binding" : "Create binding"}</h2>
            {editingId && <span className="mono">{editingId}</span>}
          </div>
          <form noValidate onSubmit={(event) => void save(event)}>
            <ProjectField
              value={form.projectId}
              projects={projects}
              loading={loadingProjects}
              error={fieldErrors.projectId}
              autoFocus
              onChange={(value) => updateField("projectId", value)}
            />
            <TextField
              label="Routing label"
              name="routingLabel"
              value={form.routingLabel}
              placeholder="core"
              error={fieldErrors.routingLabel}
              onChange={(value) => updateField("routingLabel", value)}
            />
            <div className="field">
              <label htmlFor="binding-repository-path">Repository path</label>
              <div className="input-row">
                <input
                  id="binding-repository-path"
                  name="repositoryPath"
                  value={form.repositoryPath}
                  placeholder="~/Code/repository"
                  aria-invalid={fieldErrors.repositoryPath ? true : undefined}
                  onChange={(event) => updateField("repositoryPath", event.target.value)}
                />
                {onPickDirectory && (
                  <button className="button" type="button" disabled={pending} onClick={() => void browseRepositoryPath()}>
                    Browse…
                  </button>
                )}
              </div>
              {fieldErrors.repositoryPath && <span className="field-error">{fieldErrors.repositoryPath}</span>}
            </div>
            <TextField
              label="Base branch"
              name="baseBranch"
              value={form.baseBranch}
              placeholder="main"
              error={fieldErrors.baseBranch}
              onChange={(value) => updateField("baseBranch", value)}
            />
            <div className="field">
              <label>
                Concurrency
                <input
                  name="concurrency"
                  min={1}
                  step={1}
                  type="number"
                  value={form.concurrency}
                  aria-invalid={fieldErrors.concurrency ? true : undefined}
                  onChange={(event) => updateField("concurrency", Number(event.target.value))}
                />
              </label>
              {fieldErrors.concurrency && <span className="field-error">{fieldErrors.concurrency}</span>}
            </div>

            <details open>
              <summary>Advanced role launch overrides</summary>
              <RoleConfigFields role="reconcile" form={form} updateField={updateField} />
              <RoleConfigFields role="artist" form={form} updateField={updateField} />
              <RoleConfigFields role="critic" form={form} updateField={updateField} />
            </details>

            {error && <Notice tone="negative">{error}</Notice>}
            <div className="button-row">
              {editingId && (
                <button
                  className="button destructive destructive-push"
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete binding
                </button>
              )}
              <button className="button" type="button" disabled={pending} onClick={closeEditor}>
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={pending} aria-busy={pending}>
                {pending && <span className="button-spinner" aria-hidden="true" />}
                {pending ? "Saving…" : "Save binding"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {form && confirmingDelete && editingId && (
        <ConfirmDialog
          title="Delete this Project Binding?"
          body={`${form.projectId || editingId} will be removed. Running Conductors will be stopped.`}
          confirmLabel="Delete"
          pending={pending}
          onConfirm={() => void removeBinding()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {confirmingDisconnect && (
        <ConfirmDialog
          title="Disconnect Linear?"
          body="Polling and Conductor launches will stop. Your bindings stay saved, and reconnecting restores them."
          confirmLabel="Disconnect"
          pending={pending}
          onConfirm={() => void disconnectLinear()}
          onCancel={() => setConfirmingDisconnect(false)}
        />
      )}
    </>
  );
}

function TextField({
  label,
  name,
  value,
  placeholder,
  error,
  autoFocus,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  placeholder?: string | undefined;
  error?: string | undefined;
  autoFocus?: boolean | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>
        {label}
        <input
          name={name}
          value={value}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function ProjectField({
  value,
  projects,
  loading,
  error,
  autoFocus,
  onChange,
}: {
  value: string;
  projects: LinearProjectView[];
  loading: boolean;
  error?: string | undefined;
  autoFocus?: boolean | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="binding-project">Linear Project</label>
      <select
        id="binding-project"
        name="projectId"
        value={value}
        autoFocus={autoFocus}
        disabled={loading || projects.length === 0}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{loading ? "Loading projects…" : projects.length === 0 ? "No Linear projects available" : "Choose a project…"}</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function RoleConfigFields({
  role,
  form,
  updateField,
}: {
  role: "reconcile" | "artist" | "critic";
  form: BindingFormState;
  updateField: <K extends keyof BindingFormState>(field: K, value: BindingFormState[K]) => void;
}) {
  const modelField = `${role}_model` as keyof BindingFormState;
  const effortField = `${role}_reasoning_effort` as keyof BindingFormState;
  const model = form[modelField];
  const effort = form[effortField];
  return (
    <fieldset>
      <legend>{role[0]?.toUpperCase()}{role.slice(1)} launch</legend>
      <p className="quiet">Agent: <strong>codex</strong></p>
      <label>
        Model override
        <input
          name={String(modelField)}
          value={typeof model === "string" ? model : ""}
          placeholder="Optional"
          onChange={(event) => updateField(modelField, nullable(event.target.value) as BindingFormState[typeof modelField])}
        />
      </label>
      <label>
        Reasoning effort override
        <input
          name={String(effortField)}
          value={typeof effort === "string" ? effort : ""}
          placeholder="Optional"
          onChange={(event) => updateField(effortField, nullable(event.target.value) as BindingFormState[typeof effortField])}
        />
      </label>
    </fieldset>
  );
}

function validateForm(form: BindingFormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.projectId.trim()) errors.projectId = "Select a Linear project.";
  if (!form.routingLabel.trim()) errors.routingLabel = "Routing label is required.";
  if (!form.repositoryPath.trim()) errors.repositoryPath = "Repository path is required.";
  if (!form.baseBranch.trim()) errors.baseBranch = "Base branch is required.";
  if (!Number.isInteger(form.concurrency) || form.concurrency < 1) {
    errors.concurrency = "Concurrency must be a positive whole number.";
  }
  return errors;
}

function linearStatusLabel(connection: LinearConnectionView): string {
  switch (connection.status) {
    case "connected": return "Connected";
    case "reconnect_required": return "Reconnect required";
    case "disconnected": return "Not connected";
  }
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toForm(binding: ProjectBindingView): BindingFormState {
  return { ...binding };
}

function toCommandBinding(form: BindingFormState): ProjectBindingDraftView {
  return {
    projectId: form.projectId.trim(),
    routingLabel: form.routingLabel.trim(),
    repositoryPath: form.repositoryPath.trim(),
    baseBranch: form.baseBranch.trim(),
    concurrency: Number(form.concurrency),
    reconcile_agent: "codex",
    reconcile_model: form.reconcile_model ?? null,
    reconcile_reasoning_effort: form.reconcile_reasoning_effort ?? null,
    artist_agent: "codex",
    artist_model: form.artist_model ?? null,
    artist_reasoning_effort: form.artist_reasoning_effort ?? null,
    critic_agent: "codex",
    critic_model: form.critic_model ?? null,
    critic_reasoning_effort: form.critic_reasoning_effort ?? null,
  };
}

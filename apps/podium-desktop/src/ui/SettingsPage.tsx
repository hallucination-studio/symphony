import { useEffect, useState, type FormEvent, type RefObject } from "react";

import { EmptyState, PageHeading } from "./components";
import type {
  CommandHandler,
  ProjectBindingDraftView,
  ProjectBindingView,
} from "./types";

type BindingFormState = Omit<ProjectBindingView, "id"> & { id?: string };

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
  headingRef,
  onCommand,
}: {
  bindings: ProjectBindingView[];
  headingRef: RefObject<HTMLHeadingElement>;
  onCommand: CommandHandler;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<BindingFormState>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (editingId) {
      const selected = bindings.find((binding) => binding.id === editingId);
      if (selected) setForm(toForm(selected));
    }
  }, [bindings, editingId]);

  const beginCreate = () => {
    setEditingId(undefined);
    setForm(blankBinding());
    setError(undefined);
    setMessage(undefined);
  };

  const beginEdit = (binding: ProjectBindingView) => {
    setEditingId(binding.id);
    setForm(toForm(binding));
    setError(undefined);
    setMessage(undefined);
  };

  const updateField = <K extends keyof BindingFormState>(field: K, value: BindingFormState[K]) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || pending) return;
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
      }
    } catch {
      setError("The binding could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function removeBinding() {
    if (!editingId || pending || !window.confirm("Delete this Project Binding? Running Conductors will be stopped.")) return;
    setPending(true);
    setError(undefined);
    const result = await onCommand({ kind: "delete_binding", bindingId: editingId });
    if (result.kind === "rejected") {
      setError(result.sanitizedReason);
    } else {
      setForm(undefined);
      setEditingId(undefined);
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
        <section className="panel" aria-labelledby="settings-bindings-heading">
          <div className="section-heading">
            <h2 id="settings-bindings-heading">Project Bindings</h2>
            <button className="button primary" type="button" onClick={beginCreate}>
              New binding
            </button>
          </div>
          {bindings.length === 0 ? (
            <EmptyState title="No bindings" body="Create a binding to route Linear Roots to a repository." />
          ) : (
            <ul className="plain-list" aria-label="Configured Project Bindings">
              {bindings.map((binding) => (
                <li key={binding.id}>
                  <div>
                    <strong>{binding.projectId}</strong>
                    <span>
                      <span className="mono">{binding.id}</span> · {binding.routingLabel} · {binding.repositoryPath}
                    </span>
                  </div>
                  <button className="button compact" type="button" onClick={() => beginEdit(binding)}>
                    Edit binding
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {form && (
          <section className="panel" aria-labelledby="binding-editor-heading">
            <div className="section-heading">
              <h2 id="binding-editor-heading">{editingId ? "Edit binding" : "Create binding"}</h2>
              {editingId && <span className="mono">{editingId}</span>}
            </div>
            <form onSubmit={(event) => void save(event)}>
              <div className="readiness-list">
                <label>
                  Project ID
                  <input
                    name="projectId"
                    required
                    value={form.projectId}
                    onChange={(event) => updateField("projectId", event.target.value)}
                  />
                </label>
                <label>
                  Routing label
                  <input
                    name="routingLabel"
                    required
                    value={form.routingLabel}
                    onChange={(event) => updateField("routingLabel", event.target.value)}
                  />
                </label>
                <label>
                  Repository path
                  <input
                    name="repositoryPath"
                    required
                    value={form.repositoryPath}
                    onChange={(event) => updateField("repositoryPath", event.target.value)}
                  />
                </label>
                <label>
                  Base branch
                  <input
                    name="baseBranch"
                    required
                    value={form.baseBranch}
                    onChange={(event) => updateField("baseBranch", event.target.value)}
                  />
                </label>
                <label>
                  Concurrency
                  <input
                    name="concurrency"
                    required
                    min={1}
                    step={1}
                    type="number"
                    value={form.concurrency}
                    onChange={(event) => updateField("concurrency", Number(event.target.value))}
                  />
                </label>
              </div>

              <RoleConfigFields role="reconcile" form={form} updateField={updateField} />
              <RoleConfigFields role="execute" form={form} updateField={updateField} />
              <RoleConfigFields role="audit" form={form} updateField={updateField} />

              {error && <p role="alert">{error}</p>}
              {message && <p role="status">{message}</p>}
              <div className="button-row">
                <button className="button" type="button" onClick={() => setForm(undefined)}>
                  Cancel
                </button>
                <button className="button primary" type="submit" disabled={pending} aria-busy={pending}>
                  {pending && <span className="button-spinner" aria-hidden="true" />}
                  {pending ? "Saving…" : "Save binding"}
                </button>
                {editingId && (
                  <button className="button" type="button" disabled={pending} onClick={() => void removeBinding()}>
                    Delete binding
                  </button>
                )}
              </div>
            </form>
          </section>
        )}

        <section className="panel" aria-labelledby="settings-runtime-heading">
          <div className="section-heading">
            <h2 id="settings-runtime-heading">Role defaults</h2>
            <span>Closed launch contract</span>
          </div>
          <p className="quiet">Each Reconcile, Artist, and Critic role uses Codex. Model and reasoning effort overrides are optional.</p>
        </section>
      </div>
    </>
  );
}

function RoleConfigFields({
  role,
  form,
  updateField,
}: {
  role: "reconcile" | "execute" | "audit";
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

# ADR-0004: Layered Performer profiles and runtime profiles

## Status

Proposed, awaiting user approval

## Date

2026-07-12

## Context

The first configuration sketch put TOML, versioning, policy, and credential
metadata directly on `project_bindings`. That would make an already broad
binding row grow past thirty columns, couple project routing to runtime policy,
and make multiple Codex accounts or API keys awkward to represent.

Codex also has more than one authentication shape. `codex login` can create a
ChatGPT OAuth session without an API token, while some operators may keep one
or more API keys for other accounts or providers. These credentials must remain
outside browser responses, Linear, logs, and ordinary Podium data. The system
still needs a durable way to select one configuration and one local credential
for each project binding and to audit exactly which immutable revision ran.

## Proposed decision

Keep two explicit profile layers and normalize credential selection separately.
`runtime_profile` is the low-level adapter/runtime configuration. A
`performer_profile` is Symphony's stable agent-facing wrapper: it chooses the
Performer/SDK kind, turn policy, and one runtime profile. A project binding
stores only a reference to an immutable Performer profile revision. Runtime and
Performer revisions are immutable; credential records are
metadata/references, not a bag of secrets.

### Podium tables

```text
runtime_profiles
  id                  primary key
  workspace_id        users.id
  name                operator label, unique per workspace
  runtime_kind        codex | future runtime adapter kind
  active_revision_id  nullable runtime_profile_revisions.id
  state               active | disabled
  created_by          users.id
  created_at          timestamptz
  updated_at          timestamptz

runtime_profile_revisions
  id                  primary key
  runtime_profile_id  runtime_profiles.id
  revision            monotonically increasing per profile
  policy_revision     integer
  config_format       toml for the Codex adapter
  config_document     validated non-secret adapter document
  config_sha256       sha256(canonical config document)
  created_by          users.id
  created_at          timestamptz
  unique(runtime_profile_id, revision)

performer_profiles
  id                  primary key
  workspace_id        users.id
  name                operator label, unique per workspace
  performer_kind      codex | future SDK agent kind
  runtime_profile_id  runtime_profiles.id
  active_revision_id  nullable performer_profile_revisions.id
  state               active | disabled
  created_by          users.id
  created_at          timestamptz
  updated_at          timestamptz

performer_profile_revisions
  id                    primary key
  performer_profile_id  performer_profiles.id
  revision              monotonically increasing per Performer profile
  runtime_profile_revision_id  runtime_profile_revisions.id
  turn_policy           bounded Performer policy document
  revision_sha256       sha256(canonical Performer revision)
  created_by            users.id
  created_at             timestamptz
  unique(performer_profile_id, revision)

performer_credentials
  id                  primary key
  workspace_id        users.id
  name                operator label, unique per workspace
  performer_kind      codex | future SDK agent kind
  auth_method         chatgpt_oauth | api_key | provider_token
  account_hint        sanitized display label or stable hash, never a token
  local_ref           opaque Conductor credential-slot reference
  state               active | disabled | revoked
  created_by          users.id
  created_at          timestamptz
  updated_at          timestamptz

performer_bindings
  id                  primary key
  workspace_id        users.id
  project_binding_id  project_bindings.id, unique
  performer_profile_id performer_profiles.id
  performer_profile_revision_id performer_profile_revisions.id
  credential_id       performer_credentials.id
  generation          optimistic-concurrency integer
  state               pending | ready | failed | disabled
  error_code          sanitized code
  sanitized_reason    bounded reason
  updated_at          timestamptz
```

The important references are:

```text
performer_bindings.performer_profile_revision_id
  -> performer_profile_revisions.id
performer_profile_revisions.runtime_profile_revision_id
  -> runtime_profile_revisions.id
performer_profile_revisions.performer_profile_id
  -> performer_profiles.id
performer_profiles.runtime_profile_id
  -> runtime_profiles.id
performer_bindings.credential_id
  -> performer_credentials.id
```

The existing `project_bindings` table receives only
`performer_binding_id TEXT NULL` (or an equivalent foreign-key column in the
fresh schema). It does not receive TOML, credential fields, SDK policy fields,
or per-profile status columns. Dispatches continue to reference the project
binding, never a credential or a profile name.

The existing `runtime_commands` table remains the delivery queue. A configure
command contains:

```json
{
  "type": "project.configure",
  "binding_id": "...",
  "binding_config_version": 7,
  "performer_binding_id": "...",
  "performer_profile_id": "...",
  "performer_profile_revision_id": "...",
  "performer_profile_revision": 3,
  "runtime_profile_id": "...",
  "runtime_profile_revision_id": "...",
  "runtime_profile_revision": 3,
  "performer_kind": "codex",
  "runtime_kind": "codex",
  "policy_revision": 2,
  "config_format": "toml",
  "config_document": "...",
  "credential_id": "...",
  "credential_ref": "..."
}
```

`config_document` is non-secret and is carried because the existing runtime
transport is polling-only. `credential_ref` is an opaque local slot reference;
the command never carries an API key, OAuth token, `auth.json`, cookie, or
keyring export. Command deduplication uses the binding, profile revision, and
credential id. A repeated command is a no-op; a lower generation or revision is
stale and cannot replace current local state.

### Multiple accounts and API keys

One workspace can create many `performer_credentials` records. A Performer
binding selects exactly one active credential record, and changing accounts is
a new `performer_bindings` generation rather than an in-place secret overwrite.
Credential rotation creates a new local slot/reference and keeps the previous
record revocable for audit and rollback.

Conductor owns the actual local slots under its data root (or an explicitly
configured OS secret store):

```text
<conductor-data>/performer-credentials/<credential_id>/
  CODEX_HOME/          # official `codex login` state when auth_method=chatgpt_oauth
  secret-ref           # local reference only for API/provider credentials
```

For ChatGPT OAuth, the operator runs `codex login` in the selected slot's
dedicated `CODEX_HOME`; this works without an API token. For an API key, the
operator provisions the local slot through an environment variable or OS
keychain reference. Podium stores only `auth_method`, `account_hint`, and
`local_ref`, and receives only readiness/error metadata. The ambient
`~/.codex` home is never accepted as a slot.

The MVP deliberately does **not** make Podium a credential vault. Supporting
Podium-managed encrypted API-key values would require a separate KMS/rotation
design and explicit approval. Until then, a credential record without a
healthy local slot is visible but not runnable.

### Local execution

When Conductor applies a command it:

1. validates the referenced immutable Performer revision and its referenced
   runtime revision/hash;
2. records `performer_binding_id`, Performer/runtime revisions, credential id,
   and sanitized status in local durable state;
3. asks the selected runtime adapter to write its non-secret config document to
   a local controlled config file;
4. creates a fresh per-attempt `CODEX_HOME`, copies that config, and overlays
   only the selected credential slot's approved local state;
5. launches Performer with the isolated home and no Podium/Linear credential;
6. reports Performer/runtime profile ids, revisions/hashes, and credential
   readiness, never contents.

OAuth refresh is handled by Codex inside the selected local slot. It is not
copied to Podium or another credential slot. A missing slot, expired login, or
invalid key reference fails closed with a concrete sanitized reason and is
visible in local durable state, logs, the runtime report, and the relevant
Linear wait/failure projection.

### API and file ingestion

To keep the MVP generic and small, the first provisioning path may load
validated runtime adapter documents and Performer policy from a
Podium-controlled local directory or deployment file and create immutable
revisions. A future authenticated API can create Performer/runtime
profiles/revisions and credential metadata using the same tables and contract;
it must not accept raw credentials. No browser UI is required for this slice.

## Security invariants

- Codex `config_document` is bounded, parsed with a TOML parser, allowlisted, and rejected
  if it contains literal secret patterns or forbidden credential-bearing keys.
- `auth.json`, API keys, access/refresh tokens, cookies, and Authorization
  headers never enter Podium PostgreSQL, runtime commands, browser responses,
  Linear, or logs.
- Public/runtime reports expose only ids, revisions, hashes, auth method, a
  sanitized account hint, readiness, and error category.
- Performer/runtime revisions and credential records are immutable/auditable; disable or
  revoke creates a state transition, not destructive replacement.
- Binding generation and runtime-command fencing prevent stale Performer,
  runtime, or
  credential selections from changing the current task.

## Alternatives considered

### Put all runtime fields on `project_bindings`

Rejected. It creates a wide, mixed-ownership table and cannot model reusable
profiles, immutable history, or multiple credential selections cleanly.

### Store raw OAuth/API credentials in Podium

Rejected for the MVP. It expands the secret blast radius and conflicts with the
local `codex login` flow. A KMS-backed vault is a separate approved project.

### Use only one global Codex account per Conductor

Rejected. It prevents project-level account selection and makes account/API-key
rotation unsafe.

## Approval questions

1. Approve the layered shape and references:
   `project_bindings -> performer_bindings -> performer_profile_revisions ->
   runtime_profile_revisions -> runtime_profiles`.
2. Approve local-only credentials for MVP: Podium stores credential metadata and
   references, never raw OAuth/API-key values.
3. Approve file/directory provisioning as the first profile ingestion path; an
   authenticated metadata/config API and Web editor remain later slices.

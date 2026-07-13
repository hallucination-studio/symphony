# ADR-0004: Layered Performer profiles and runtime profiles

## Status

Accepted by the user on 2026-07-12

## Date

2026-07-12

## Revision note

This is the simplified version of the original proposal. The original draft
introduced `runtime_profile_revisions` and `performer_profile_revisions`.
Neither table is part of this proposal. Profile rows are mutable; a binding
generation and content hashes provide the small amount of fencing and
integrity checking needed by the MVP.

## Context

The first configuration sketch put TOML, policy, and credential metadata
directly on `project_bindings`. That would make an already broad binding row
grow past thirty columns, couple project routing to runtime policy, and make
multiple Codex accounts or API keys awkward to represent.

Codex also has more than one authentication shape. `codex login` can create a
ChatGPT OAuth session without an API token, while some operators may keep one
or more API keys for other accounts or providers. These credentials must remain
outside browser responses, Linear, logs, and ordinary Podium data. The system
still needs a durable way to select one Performer, one runtime configuration,
and one local credential for each project binding.

The MVP does not require historical profile snapshots. Keeping two revision
tables would add lifecycle, migration, and UI/API concepts before that history
is needed. A run records the selected profile ids, generation, and hashes; a
future audit-history requirement can be designed separately.

## Proposed decision

Keep two explicit profile layers and normalize credential selection separately:

* `runtime_profile` is the low-level runtime/adapter configuration.
* `performer_profile` is Symphony's stable agent-facing wrapper. It chooses the
  Performer/SDK kind, turn policy, and one runtime profile.
* `performer_binding` selects one Performer profile and one credential for a
  project.

The profile rows are mutable current state. A binding `generation` is bumped
whenever its selected profile, credential, or referenced profile content
changes. The generated `project.configure` command carries that generation,
the current non-secret documents, and their hashes. This keeps stale commands
from replacing current local state without adding profile revision tables.

### Podium tables

```text
runtime_profiles
  id                  primary key
  workspace_id        users.id
  name                operator label, unique per workspace
  runtime_kind        codex | future runtime adapter kind
  config_format       toml for the Codex adapter
  config_document     validated non-secret adapter document
  config_sha256       sha256(canonical config document)
  state               active | disabled
  created_by          users.id
  created_at          timestamptz
  updated_at          timestamptz

performer_profiles
  id                  primary key
  workspace_id        users.id
  name                operator label, unique per workspace
  performer_kind      codex | future SDK agent kind
  runtime_profile_id  runtime_profiles.id
  turn_policy         bounded non-secret Performer policy document
  policy_sha256       sha256(canonical policy document)
  state               active | disabled
  created_by          users.id
  created_at          timestamptz
  updated_at          timestamptz

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
  credential_id       performer_credentials.id
  generation          optimistic-concurrency/configuration integer
  state               pending | ready | failed | disabled
  error_code          sanitized code
  sanitized_reason    bounded reason
  updated_at          timestamptz
```

The only profile references are:

```text
project_bindings.performer_binding_id
  -> performer_bindings.id
performer_bindings.performer_profile_id
  -> performer_profiles.id
performer_profiles.runtime_profile_id
  -> runtime_profiles.id
performer_bindings.credential_id
  -> performer_credentials.id
```

There are no `*_profile_revision` tables or `active_revision_id` columns.
`project_bindings` receives only `performer_binding_id TEXT NULL` (or an
equivalent foreign-key column in the fresh schema). It does not receive TOML,
credential fields, SDK policy fields, or profile status columns. Dispatches
continue to reference the project binding, never a credential or a profile
name.

### Profile updates and generation

Profile edits replace the current validated document in the profile row. The
write transaction increments `generation` for every affected
`performer_binding` and queues a fresh `project.configure` command. A binding
selection change or credential rotation increments the same generation. The
old profile content is not retained in Podium; the selected hash and generation
are retained in the local run/attempt record and sanitized runtime report.

If a rollback is needed, provisioning writes the previous known-good document
back into the profile row, producing another generation. No profile-history
table is implied by that operation.

The workflow's existing `plan_revisions` and `policy_revision` fields remain
unchanged. They describe a managed-run plan and its approval/evidence
provenance, not the current Performer or runtime profile configuration.

### Existing runtime command

The existing `runtime_commands` table remains the delivery queue. A configure
command contains the current profile documents and the binding generation:

```json
{
  "type": "project.configure",
  "binding_id": "...",
  "binding_config_version": 7,
  "performer_binding_id": "...",
  "performer_profile_id": "...",
  "runtime_profile_id": "...",
  "performer_kind": "codex",
  "runtime_kind": "codex",
  "turn_policy": "...",
  "policy_sha256": "...",
  "config_format": "toml",
  "config_document": "...",
  "config_sha256": "...",
  "credential_id": "...",
  "credential_ref": "..."
}
```

`binding_config_version` is the existing wire name for the binding
generation; it is a command fence, not a profile revision. The command never
carries an API key, OAuth token, `auth.json`, cookie, or Authorization header.
Conductor treats an identical binding/generation/hash tuple as a no-op. A
lower generation, a mismatched binding, or a hash that does not match the
document is rejected as stale/invalid and cannot replace current local state.

### Multiple accounts and API keys

One workspace can create many `performer_credentials` records. A Performer
binding selects exactly one active credential record. Changing accounts or
rotating an API key creates a new local slot/reference and increments the
binding generation; it never overwrites the selected secret in Podium.

Conductor owns the actual local slots under its data root (or an explicitly
configured OS secret store):

```text
<conductor-data>/performer-credentials/<credential_id>/
  CODEX_HOME/       # official `codex login` state when auth_method=chatgpt_oauth
  secret-ref        # local reference only for API/provider credentials
```

For ChatGPT OAuth, the operator runs `codex login` in the selected slot's
dedicated `CODEX_HOME`; this works without an API token. For an API key, the
operator provisions the local slot through an environment variable or OS
keychain reference. Podium stores only `auth_method`, `account_hint`, and
`local_ref`, and receives only readiness/error metadata. The ambient
`~/.codex` home is never accepted.

The MVP deliberately does **not** make Podium a credential vault. Supporting
Podium-managed encrypted API-key values would require a separate KMS/rotation
design and explicit approval. Until then, a credential record without a
healthy local slot is visible but not runnable.

### Local execution

When Conductor applies a command it:

1. validates the referenced current Performer/runtime documents and hashes;
2. records the Performer/runtime ids, binding generation, hashes, and
   credential id in local durable state;
3. asks the selected runtime adapter to write its non-secret config document to
   a local controlled config file;
4. creates a fresh per-attempt `CODEX_HOME`, copies that config, and overlays
   only the selected credential slot's approved local state;
5. launches Performer with the isolated home and no Podium/Linear credential;
6. reports profile ids, generation/hashes, and credential readiness, never
   document contents or secret values.

OAuth refresh is handled by Codex inside the selected local slot. It is not
copied to Podium or another credential slot. A missing slot, expired login, or
invalid key reference fails closed with a concrete sanitized reason and is
visible in local durable state, logs, the runtime report, and the relevant
Linear wait/failure projection.

### API and file ingestion

To keep the MVP generic and small, the first provisioning path may load
validated runtime adapter documents and Performer policy from a Podium-
controlled local directory or deployment file and upsert the two profile rows.
When an upsert changes a referenced profile, the affected binding generations
are incremented transactionally. A future authenticated API can create or
update profiles and credential metadata using the same tables and contract; it
must not accept raw credentials. No browser UI is required for this slice.

## Security invariants

- Codex `config_document` is bounded, parsed with a TOML parser, allowlisted,
  and rejected if it contains literal secret patterns or forbidden
  credential-bearing keys.
- `auth.json`, API keys, access/refresh tokens, cookies, and Authorization
  headers never enter Podium PostgreSQL, runtime commands, browser responses,
  Linear, or logs.
- Public/runtime reports expose only ids, the binding generation, hashes, auth
  method, a sanitized account hint, readiness, and an error category.
- Profile rows are mutable current state. The generation/hash tuple is the
  audit and stale-command boundary for the MVP; historical profile documents
  are explicitly out of scope.
- Binding generation and runtime-command fencing prevent stale Performer,
  runtime, or credential selections from changing the current task.

## Alternatives considered

### Put all runtime fields on `project_bindings`

Rejected. It creates a wide, mixed-ownership table and cannot model reusable
profiles or multiple credential selections cleanly.

### Add immutable runtime and Performer profile revision tables

Rejected for the MVP. Two history tables add lifecycle and API complexity that
the acceptance requirements do not need. Binding generation plus hashes gives
the required idempotency, stale-command rejection, and integrity checks. A
separate audit-history design can be added if historical profile inspection
becomes a product requirement.

### Store raw OAuth/API credentials in Podium

Rejected for the MVP. It expands the secret blast radius and conflicts with
the local `codex login` flow. A KMS-backed vault is a separate approved
project.

### Use only one global Codex account per Conductor

Rejected. It prevents project-level account selection and makes account/API-key
rotation unsafe.

## Approval questions

1. Approve the simplified references:
   `project_bindings -> performer_bindings -> performer_profiles ->
   runtime_profiles`, plus `performer_bindings -> performer_credentials`.
2. Approve mutable current profile rows with binding generation and content
   hashes as the only profile fencing/integrity mechanism; no profile revision
   tables or historical profile snapshots in the MVP.
3. Approve local-only credentials for MVP: Podium stores credential metadata and
   references, never raw OAuth/API-key values.
4. Approve file/directory provisioning as the first profile ingestion path; an
   authenticated metadata/config API and Web editor remain later slices.

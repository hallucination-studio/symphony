# Symphony Linear Tree Skill

## Goal

Define a Symphony-specific Claude skill suite that turns a complex execution plan
into a Linear issue tree that Symphony can schedule and execute.

The skill suite should:

- authenticate directly with Linear using official OAuth 2.0 Authorization Code
  + PKCE;
- remain independent from Symphony runtime packages;
- produce a markdown-first planning document that a human can review and edit;
- create or incrementally synchronize a Linear structure made of phase-parent
  issues, child task issues, and `blocks` dependencies;
- write issue descriptions that are complete enough for Symphony to execute from
  the Linear issue alone, including acceptance criteria and AGENT.md-aligned
  0–4 verification guidance.

This is a Symphony product feature for planning and scheduling work in Linear.
It is not a generic Linear planning tool.

## Core Decision

Symphony should ship a small skill suite with three entry points:

- `symphony-linear-tree-auth`
- `symphony-linear-tree-design`
- `symphony-linear-tree-apply`

The main user workflow remains two-stage:

1. design a markdown execution plan;
2. apply that plan to Linear.

Authentication is separate because OAuth token lifecycle is independent from plan
creation and plan apply.

## Why This Exists

Symphony can already schedule Linear issues once they exist and once `blocks`
relations reflect the true dependency graph. What is missing is a reliable way to
turn a large plan into that scheduler-ready issue tree.

The product need is not only "create some Linear issues." The product need is:

- preserve a long plan as a reviewable document;
- convert that document into a stable hierarchy of phase and task issues;
- preserve execution-critical dependencies as `blocks` edges;
- make reruns safe when the plan evolves;
- ensure the issue descriptions include enough operational detail for Symphony to
  work without depending on hidden context.

## Scope

### In scope

- Linear OAuth Authorization Code + PKCE login for the skill user.
- Markdown-first Symphony execution plan design.
- Parsing a semi-structured markdown plan into phases, tasks, and dependencies.
- Creating phase-parent issues in Linear.
- Creating child task issues in Linear.
- Creating `blocks` dependencies in Linear.
- Incrementally updating existing issues and dependencies from the markdown spec.
- Two-layer confirmation before any Linear write.

### Out of scope

- Importing `performer`, `conductor`, `podium`, or `performer_api` directly.
- Automatically running Symphony after issue creation.
- Automatically deleting or archiving existing Linear issues.
- Acting as a generic project planner for non-Symphony workflows.
- Replacing AGENT.md with a new verification model.

## Independence from Runtime Code

The skill suite should be implemented independently from Symphony runtime code.
It may copy concepts from existing Linear integrations, but it must not depend on
Symphony packages as a library boundary.

That means:

- no imports from `packages/performer`, `packages/conductor`,
  `packages/podium`, or `packages/performer-api`;
- its own OAuth implementation;
- its own small Linear GraphQL client;
- its own markdown parser and sync engine.

This keeps the skill usable without coupling it to product runtime internals,
release cadence, or import-boundary rules.

## Authentication Model

### Decision

The skill suite should authenticate with Linear using official OAuth 2.0
Authorization Code + PKCE.

### Why

This matches the requirement that the skill use Linear's official login flow,
rather than personal API keys or Podium-mediated auth.

PKCE is the right fit because the skill behaves like a local-user client and
should not depend on embedding a durable client secret in the repository.

### Flow

1. `symphony-linear-tree-auth` checks for a valid cached token.
2. If no valid token exists, it generates:
   - `state`
   - PKCE `code_verifier`
   - PKCE `code_challenge`
3. It starts a local loopback listener on `127.0.0.1` using an available port.
4. It opens the browser to Linear's OAuth authorize URL.
5. The user approves the Linear application.
6. Linear redirects to the local callback with `code` and `state`.
7. The skill validates `state`.
8. The skill exchanges the authorization code for token material.
9. The token is stored locally outside the repository.

### Local storage

Recommended token path:

```text
~/.claude/symphony-linear-tree/linear-auth.json
```

Token material must never be written into the repository or echoed to the user.

### Local configuration

The implementation should read the OAuth client id from environment or local
config. The user indicated that `.env` already contains the client id.

Preferred environment names:

- `LINEAR_CLIENT_ID`
- `LINEAR_REDIRECT_HOST` (optional, default `127.0.0.1`)
- `LINEAR_REDIRECT_PORT` (optional, default random available port)

The first version should avoid requiring a client secret.

## Skill Responsibilities

### `symphony-linear-tree-auth`

This skill owns Linear authentication only.

Responsibilities:

- acquire a new token using OAuth + PKCE;
- refresh or re-authenticate when needed;
- verify that a usable token is available;
- report which workspace/account is connected, without exposing secrets.

It should not create plans or mutate Linear issues beyond what is required to
complete authentication.

### `symphony-linear-tree-design`

This skill owns plan design and markdown generation.

Responsibilities:

- accept a rough natural-language request or a partially structured plan;
- generate a first-pass execution skeleton;
- ask the user to confirm the skeleton;
- expand the skeleton into a full markdown plan;
- save the plan in the repository under `docs/`.

The design skill should optimize the resulting document for both:

- human review;
- machine parsing by the apply skill.

### `symphony-linear-tree-apply`

This skill owns parsing, preview, and synchronization to Linear.

Responsibilities:

- read a markdown plan file;
- validate its structure and dependencies;
- preview the parsed interpretation;
- preview the exact write plan;
- create or incrementally update Linear issues and `blocks` relations.

It should never write to Linear without two explicit user confirmations.

## Planning Document Model

### Decision

The planning artifact should be markdown-first, not JSON-first.

The user should be able to read, review, edit, and discuss the plan as a normal
product or execution document.

### Constraint

Markdown alone is too ambiguous for reliable incremental synchronization.
The document therefore needs small machine-readable anchors inside an otherwise
human-readable format.

### Shape

The recommended plan file should contain:

1. frontmatter with Linear defaults;
2. prose sections such as Summary, Scope, and Execution Policy;
3. phase sections for batches such as `E0`, `E1`, `E2`;
4. task sections nested under phases;
5. machine-readable blocks that encode stable keys and dependency references.

### Frontmatter

Recommended fields:

```yaml
---
title: Symphony execution plan for <topic>
linear:
  team: <team key or team name>
  project: <project name or project id>
  phase_parent_state: Backlog
  task_state: Backlog
  delegate_to_symphony: true
sync:
  mode: incremental
  external_id_prefix: symphony-plan
---
```

The first implementation should support at least:

- target team;
- target project;
- default state for phase issues;
- default state for task issues;
- whether created tasks should default to Symphony delegation.

### Phase sections

Each phase should have a human-readable heading and a small machine-readable
block.

Example:

```md
## Phase E0 — State convergence foundation

```yaml
phase:
  key: E0
  blocked_by: []
```

Goal...
Acceptance...
```
```

### Task sections

Each task should also have a heading and a machine-readable block.

Example:

```md
### E0.1 Split orchestrator_state.py

```yaml
issue:
  key: E0.1
  parent: E0
  blocked_by: []
  kind: task
```

**Goal**
...

**Implementation**
...

**Acceptance**
...

**Rubric**
- 4/4: ...
- 3/4: ...
- ≤2/4: ...
```
```

### Why this compromise

This format keeps the document readable and editable while letting the apply
skill deterministically recover:

- issue identity;
- parent-child grouping;
- dependency edges;
- sync intent.

## Linear Tree Model

### Decision

The created Linear structure should use:

- one phase-parent issue per batch;
- one child issue per task under its phase parent;
- explicit `blocks` relations for execution dependencies.

### Why

Parent-child structure improves readability and review. `blocks` relations are the
execution truth that Symphony's scheduler can act on.

Grouping and scheduling are therefore separate concerns:

- parent-child expresses grouping;
- `blocks` expresses dependency.

### Relation direction

If task A must complete before task B can start, then A blocks B.

The apply engine should centralize relation creation so the direction cannot drift
between different code paths or templates.

## Incremental Sync Model

### Decision

The default sync mode should be incremental and non-destructive.

### Default behavior

On rerun, the apply skill should:

- create missing phase issues;
- create missing task issues;
- update titles;
- update descriptions;
- update parent assignments;
- add missing `blocks` relations;
- preview extra relations when found.

It should not, by default:

- delete issues;
- archive issues;
- remove extra issues;
- remove extra relations automatically.

### Stable identity

Incremental sync requires a stable key that survives title edits.

Each phase and task should therefore have a stable plan key such as:

- `E0`
- `E0.1`
- `E4.11`

The apply engine should persist that key inside the Linear issue description,
for example as a hidden marker:

```text
<!-- symphony-linear-tree:key=E0.1 -->
```

This marker becomes the primary identity used for sync. Title matching should be
best-effort fallback only.

## Design Workflow

### Input types

The design skill should accept:

- a natural-language execution plan;
- an existing rough markdown outline;
- a previously written execution plan that needs normalization.

### Two-pass design flow

The user selected a design flow that starts with a skeleton before writing the
full plan.

#### Pass A: skeleton

Generate:

- summary;
- phase list;
- task list;
- initial `blocked_by` graph;
- obvious ambiguity or conflict notes.

The user reviews the skeleton before expansion.

#### Pass B: full plan

Expand the skeleton into a complete document with:

- phase descriptions;
- task goals;
- proposed implementation direction;
- acceptance checks;
- AGENT.md 0–4 rubric language;
- explicit dependency references.

### Output location

The generated plan should live in the real repository under `docs/`.

Recommended path pattern:

```text
docs/product/<topic>-execution-plan.md
```

A more specific subdirectory may be introduced later if multiple plans accumulate,
but the first version should keep the plan visible as a product document.

## Apply Workflow

### Inputs

The apply skill should accept:

- path to a markdown plan file;
- optional overrides for team/project/state values;
- `--dry-run`;
- future-compatible flags for stricter sync modes.

### Validation

Before any preview or write, apply should validate:

- frontmatter parses cleanly;
- every phase key is unique;
- every task key is unique;
- every parent reference resolves to a phase;
- every `blocked_by` key exists;
- the dependency graph is acyclic;
- team/project/state values resolve unambiguously in Linear.

Any validation failure must stop the workflow before write preview.

### Two confirmations

The user asked for a double-confirmation model.

#### Confirmation 1: parse preview

Show:

- phases found;
- tasks found;
- parent-child mapping;
- dependency edges;
- warnings.

Prompt: does this interpretation of the document look correct?

#### Confirmation 2: write preview

Show:

- issues to create;
- issues to update;
- parent changes;
- `blocks` relations to add;
- relations already satisfied.

Prompt: do you want to apply these changes to Linear?

Only after the second confirmation may the skill write to Linear.

### Write order

The write order should be deterministic:

1. resolve team/project/state/delegate identifiers;
2. create or update phase issues;
3. create or update task issues;
4. repair parent assignments;
5. create missing `blocks` relations.

This guarantees that all issue ids exist before dependency creation begins.

## Issue Description Requirements

The generated issue descriptions should be written for Symphony execution, not as
thin ticket summaries.

Every task issue should include:

- the goal of the task;
- the specific implementation direction or fix;
- relevant locations if the source material names files or modules;
- acceptance criteria;
- verification expectations aligned with AGENT.md;
- 0–4 rubric thresholds when the task requires explicit scoring language.

The goal is that a task issue can stand on its own during execution.

## Error Handling

### Authentication errors

Examples:

- missing client id;
- browser open failure;
- callback timeout;
- state mismatch;
- token exchange failure;
- expired token without successful refresh.

Behavior:

- fail with concrete instructions;
- never print secrets;
- suggest rerunning auth when appropriate.

### Parse errors

Examples:

- invalid frontmatter;
- malformed machine block;
- duplicate keys;
- unknown blocker references;
- dependency cycles.

Behavior:

- stop before any Linear write;
- report the exact section or key at fault;
- treat the markdown plan as the single source to fix.

### Linear API errors

Examples:

- project or team not found;
- ambiguous lookup;
- issue create or update failure;
- relation create failure;
- permission errors.

Behavior:

- stop with a partial-write summary;
- report what already changed;
- make reruns safe under incremental sync.

## Security Model

1. Use official OAuth only.
2. Keep auth artifacts outside the repository.
3. Never echo tokens.
4. Restrict local token-file permissions.
5. Keep the planning document in the repository, but do not treat it as a secret
   store.
6. Only write to Linear after explicit user confirmation.

## Testing Strategy

### Unit tests

Test deterministic logic:

- PKCE helper generation;
- auth URL construction;
- frontmatter parsing;
- machine-block extraction;
- duplicate-key detection;
- dependency cycle detection;
- write-plan diff generation.

### Integration tests with mocked Linear HTTP

Test:

- code exchange flow;
- issue creation sequence;
- issue update sequence;
- relation creation;
- rerun idempotence;
- ambiguous-lookup handling.

### Manual end-to-end validation

Validate against a real Linear workspace:

1. authenticate with OAuth + PKCE;
2. generate a markdown plan into `docs/product`;
3. apply the plan to a test Linear project;
4. edit one task and rerun apply;
5. verify that the existing issue is updated rather than duplicated;
6. verify that parent-child structure and `blocks` edges match the plan.

## Suggested Implementation Order

1. Implement shared config and path helpers.
2. Implement OAuth + PKCE auth flow and local token cache.
3. Implement a minimal Linear GraphQL client.
4. Implement markdown parsing and structural validation.
5. Implement dependency graph validation and cycle detection.
6. Implement dry-run parse preview.
7. Implement dry-run write preview.
8. Implement full create/update/relationship sync.
9. Implement the design skill's skeleton-to-full-plan flow.
10. Run a real end-to-end validation in a test Linear workspace.

## Success Criteria

This feature is successful when all of the following are true:

1. A user can authenticate to Linear through official OAuth + PKCE.
2. A user can generate a markdown execution plan under `docs/product`.
3. The plan is readable as a normal product or execution document.
4. The apply skill can deterministically parse the plan.
5. The apply skill can create phase-parent issues and child task issues.
6. The apply skill can create correct `blocks` dependencies.
7. Rerunning apply after editing the document incrementally updates existing
   issues rather than duplicating them.
8. The resulting issue descriptions are complete enough for Symphony to execute
   from Linear directly.

## Summary

Symphony should add an independent skill suite that authenticates directly with
Linear, turns a complex execution plan into a markdown-first product document,
and then synchronizes that document into a scheduler-ready Linear issue tree.

The key product choice is deliberate: keep the human-facing artifact as markdown,
but embed enough structure for deterministic parsing and safe incremental apply.
That gives Symphony a practical bridge between product planning and execution
scheduling without coupling the skill to runtime internals.
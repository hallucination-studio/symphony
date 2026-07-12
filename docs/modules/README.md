# Module Design Baselines

Status: code baseline as of 2026-07-12. The local suite proves the covered
contracts; a real Linear/OAuth/Codex flow is still an external verification
step, not an implied pass.

These documents describe the code that exists now and the hard-cut boundaries
that future work must preserve. They do not authorize a new feature or hide an
unimplemented requirement. `tasks/spec.md` is the product contract and
`tasks/plan.md` is the approved implementation plan.

## Product path

```text
Linear parent issue
  -> Podium polling, dispatch, and lease
  -> Conductor durable workflow
  -> Performer plan turn
  -> ordered Linear Sub Issues
  -> Performer execute turn
  -> verification commands + one read-only Codex Gate
  -> child Done, one rework, or visible block
  -> parent Done after every child is Done
```

Podium-to-Conductor coordination is authenticated HTTP polling. Performer is a
local process launched by Conductor through request/result files. Podium Web is
the only customer-facing UI and never receives Linear or Codex credentials.

## Module ownership

| Module | Owns | Does not own |
|---|---|---|
| [`performer-api`](performer-api.md) | Shared JSON contracts and boundary validation | SDK calls, persistence, Linear, HTTP, UI |
| [`performer`](performer.md) | One fenced Codex turn and its isolated runtime | Scheduling, Linear, Podium, durable workflow state |
| [`conductor`](conductor.md) | One bound repository, sequential durable workflow, Linear projection, gates | Customer OAuth, browser UI, direct Linear tokens |
| [`podium`](podium.md) | Auth, Linear control plane, bindings, polling, dispatch, proxy, runtime APIs | Local task execution or Codex process management |
| [`podium-web`](podium-web.md) | Existing browser routes, actions, presentation, secret-safe API use | Workflow decisions, credentials, runtime sockets |
| [`verification`](verification.md) | Module tests and a strict real-flow preflight | A second acceptance product or cross-model scheduler |

## Cross-module invariants

- The four Python package import boundaries remain: `performer_api` imports no
  other product package; Performer, Conductor, and Podium do not import each
  other.
- Linear behavior remains: OAuth, token refresh, selected projects, cursor
  pagination, polling checkpoints, delegation epochs, dispatch deduplication,
  bindings, labels, proxying, parent/child projection, and visible failures.
- Podium Web behavior remains: auth, onboarding, project and repository setup,
  enrollment/binding, smoke actions, logs, managed-run views, translations,
  redirects, cookies, and design tokens.
- The workflow is strictly sequential. There is no dependency graph, parallel
  scheduler, branch/join model, checkpoint-group system, cross-model reviewer,
  or second acceptance scheduler.
- There is no WebSocket runtime transport. HTTP reports refresh the retained
  runtime-presence TTL, and the local Conductor HTTP API remains separate.
- `runtime_group_id` is a deterministic presentation alias
  (`group_{conductor_id}`), not persisted routing or ownership state.
- Failures must stay sanitized and observable. Current views expose the fields
  owned by their corresponding state records; do not claim uniform failure
  metadata where a route or store has not implemented it.

## Baseline change protocol

For each slice, record `authorized`, `required_consequences`, `out_of_scope`,
`assumptions_requiring_approval`, and `deferred_ideas`. Keep the assumptions
empty before production edits. A simplification is complete only when its
former owner has no callers, its remaining owner is explicit, and module tests
cover the preserved behavior. Source size is a review signal, never a gate.

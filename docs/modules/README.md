# Module Design Baselines

Status: implemented baseline, 2026-07-12. Real Linear flow remains an
external-environment verification step.

These documents define the ownership model for the hard-cut minimal polling
workflow. `tasks/spec.md` is the product contract and `tasks/plan.md` records
the implementation cutover. A module owns one behavior; compatibility facades
and duplicate test/tool owners are not part of the baseline.

## Product path

```text
Linear parent issue
  -> Podium Linear polling and dispatch
  -> Conductor HTTP lease
  -> Performer plan turn
  -> plan revision and approval
  -> Linear child sub-issues in plan order
  -> Performer execute turn
  -> command checks + one read-only Codex rubric gate
  -> child Done, or one rework then visible block
  -> parent Done only after every child is Done
```

The only runtime transport is authenticated HTTP polling. Performer is still a
local process launched by Conductor through request/result files. Podium Web is
the customer-facing surface; it does not receive Linear credentials or Codex
credentials.

## Module ownership

| Module | Owns | Does not own |
|---|---|---|
| `performer-api` | Small JSON contracts and boundary validation | SDK calls, persistence, Linear, HTTP, UI |
| `performer` | One fenced Codex turn and isolated runtime home | Scheduling, Linear, Podium, workflow state |
| `conductor` | One bound repository, sequential run state, child issues, gates | Customer OAuth, browser UI, direct Linear tokens |
| `podium` | Auth, Linear control plane, bindings, dispatch, runtime HTTP API, BFF | Local task execution or Codex process management |
| `podium-web` | Existing browser routes, actions, presentation, secret-safe API use | Workflow decisions, tokens, runtime sockets |
| `verification` | Small behavior suite, one real flow, evidence and docs checks | A second acceptance product or cross-model scheduler |

## Cross-module invariants

- The four Python package import boundaries remain: `performer_api` imports
  nothing from the other three; the three roles do not import each other.
- Linear business behavior remains: OAuth, token refresh, selected projects,
  cursor pagination, polling checkpoints, delegation epochs, dispatch
  deduplication, project bindings, labels, proxying, parent/child projection,
  comments, and visible errors.
- Podium Web business behavior remains: authentication, onboarding, project and
  repository setup, runtime enrollment/binding, smoke action, operator pages,
  managed-runs views, translations, redirects, cookies, and design tokens.
- Managed Run plan revisions, approval state, risks, architecture decisions,
  open questions, acceptance catalogs, score/rubric evidence, manifests,
  artifacts, and provenance remain owned by the workflow/evidence modules.
- Every blocking or terminal error has `error_code`, `sanitized_reason`,
  `action_required`, `retryable`, and `next_action`, and is visible in durable
  state, structured logs, Linear when relevant, and the Podium report.
- There is no WebSocket runtime endpoint, client, setting, install response
  field, presence channel, wake command, or compatibility shim. Conductor's
  retained local HTTP API is separate.
- There is no generic workflow engine, dependency graph, parallel scheduler,
  branch/join model, checkpoint-group system, cross-model reviewer, or second
  acceptance scheduler/backend abstraction.

## Baseline change protocol

For each further slice, record its scope ledger in the task checklist and keep
approval-requiring assumptions empty. A module is complete when its owner is
singular, its public contract is explicit, old ownership paths are deleted, and
the behavior is covered by the rebuilt module suite. Size budgets are review
signals, not source-line gates.

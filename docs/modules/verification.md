# Module baseline: verification, tools, and supporting docs

Status: proposed baseline, 2026-07-11.

## Responsibility

Verification is rebuilt around the one product flow instead of preserving the
old acceptance framework. It proves the retained Linear/Podium business paths,
the sequential Conductor workflow, Performer fencing, error visibility, and
the browser secret boundary. It is evidence for the product, not a second
workflow engine or a scoring product.

The user-authorized hard break permits deleting the current Python tests, Web
tests, tools, generated acceptance catalog, expanded runtime docs, legacy
workflow guides, and retired ADR content. Rebuild only after the target
contracts in `tasks/spec.md` and the module baselines are approved.

## Target Python suite

Recreate seven focused files, about thirty behavior tests and no more than
2,500 lines:

```text
tests/
  conftest.py
  test_performer_turn.py
  test_conductor_workflow.py
  test_conductor_recovery.py
  test_podium_linear.py
  test_podium_api.py
  test_product_flow.py
```

Coverage must include:

- plan/task/result contract validation and exact fencing;
- parent dispatch -> ordered real child sub-issues;
- sequential execute -> command checks -> read-only Codex gate;
- one rework and second gate failure blocking child and parent;
- all-children-Done parent completion;
- restart/idempotency and stale result rejection;
- Linear OAuth/polling/checkpoint/epoch/dispatch/binding/label/proxy behavior;
- HTTP command lease/expiry/reclaim/ack/fence behavior;
- durable/log/Linear/Podium parity for concrete failures.

Do not recreate score rubrics, acceptance catalogs, graph schedulers, branch
joins, RED/GREEN evidence frameworks, checkpoint groups, or tests that assert
source-line counts, phrase inventories, or retired identifier tombstones.

## Target Web suite

Recreate only the behavior needed for the existing browser product:

```text
packages/podium/web/
  test/setup.ts
  test/render.tsx
  src/App.test.tsx
  src/api/client.test.ts
  src/pages/SetupPage.test.tsx
  src/pages/ProductPages.test.tsx
```

The suite checks routes/auth, cookies and secret-safe BFF responses, setup and
binding, runtime/smoke/operator pages, managed-runs rendering, errors, and
responsive DOM behavior. It does not enforce retired module names or visual
line-count limits.

## Target tools and evidence

Keep only:

```text
tools/real_flow.py       # one end-to-end polling/Linear/Codex flow
tools/linear_fixture.py  # create, inspect, delegate, and clean up fixtures
```

The real flow runs from a clean Linear project and a staged Codex home. It
exits immediately on known failures, prints the concrete error, and archives a
report plus Podium/Conductor/Performer logs, managed-runs state, turn files,
and Linear parent/child evidence. It must prove the happy path and the failed
gate/error-visibility path. It never reads `~/.codex` directly and never
stores tokens in artifacts.

No cross-model review or separate acceptance scheduler is part of this
baseline. The product gate is the Conductor boolean gate defined in the
Conductor document.

## Documentation baseline

Keep `README.md`, one concise architecture/workflow guide, the Web
`DESIGN.md`, `tasks/spec.md`, `tasks/plan.md`, `tasks/todo.md`, and these module
baselines. Retire duplicated product/runtime guides, acceptance matrices,
generated catalogs, legacy `WORKFLOW*` files, and stale ADR proposals after
their information is either captured here or explicitly rejected.

## Exit gate

Verification is complete when the rebuilt suite is green, the one real flow
produces linked evidence, zero WebSocket references remain in active code/docs,
and no test/tool/doc still asks the implementation to support a removed
concept.

# Module baseline: verification, tools, and supporting docs

Status: implemented baseline, 2026-07-12. Real Linear evidence is still
environment-dependent.

## Responsibility

Verification is rebuilt around the one product flow while preserving the
Managed Run acceptance catalog, rubric, score, threshold, weight, provenance,
manifest, and artifact evidence semantics. It proves the retained
Linear/Podium business paths, the sequential Conductor workflow, Performer
fencing, error visibility, and the browser secret boundary. It is evidence for
the product, not a second workflow engine, cross-model reviewer, or second
acceptance scheduler.

The user-authorized hard break permits deleting the current Python tests, Web
tests, tools, obsolete generated acceptance harness, expanded runtime docs,
legacy workflow guides, and retired ADR content. Rebuild the acceptance catalog
and evidence writer only after the target
contracts in `tasks/spec.md` and the module baselines are approved.

## Target Python suite

The rebuilt Python suite is split by module, with shared setup in one
`conftest.py` and about thirty behavior tests:

```text
tests/
  conftest.py
  test_minimal_performer_api.py
  test_minimal_performer_turn.py
  test_runtime_contract.py
  test_conductor_gate.py
  test_conductor_workflow.py
  test_conductor_recovery.py
  test_conductor_runtime.py
  test_workflow_driver.py
  test_podium_runtime_polling.py
  test_package_boundaries.py
```

Coverage must include:

- plan/task/result contract validation, revision/approval, and exact fencing;
- parent dispatch -> ordered real child sub-issues;
- sequential execute -> command checks -> one read-only Codex rubric/verifier gate;
- acceptance-catalog lookup, score/threshold decisions, provenance, manifests,
  artifacts, and Linear gate/evidence issue projections;
- one rework and second gate failure blocking child and parent;
- all-children-Done parent completion;
- restart/idempotency and stale result rejection;
- Linear OAuth/polling/checkpoint/epoch/dispatch/binding/label/proxy behavior;
- HTTP command lease/expiry/reclaim/ack/fence behavior;
- durable/log/Linear/Podium parity for concrete failures.

Do not recreate graph schedulers, branch joins, checkpoint groups, cross-model
reviewers, second acceptance schedulers, RED/GREEN evidence frameworks, or
tests that assert source-line counts, phrase inventories, or retired identifier
tombstones.

## Target Web suite

Recreate only the behavior needed for the existing browser product:

```text
packages/podium/web/
  src/test/setup.ts
  src/test/utils.tsx
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
baseline. The product gate is the single Conductor boolean gate with the
retained score/rubric/evidence model defined in the Conductor document.

## Documentation baseline

Keep `README.md`, one concise architecture/workflow guide, the Web
`DESIGN.md`, `tasks/spec.md`, `tasks/plan.md`, `tasks/todo.md`, and these module
baselines. Retire duplicated product/runtime guides, acceptance matrices,
generated catalogs, legacy `WORKFLOW*` files, and stale ADR proposals after
their information is either captured here or explicitly rejected.

## Exit gate

Verification is complete when the rebuilt suite is green, the one real flow
produces linked evidence, zero removed socket references remain in active code/docs,
and no test/tool/doc still asks the implementation to support a removed
concept.

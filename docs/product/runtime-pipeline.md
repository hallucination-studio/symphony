# Runtime Pipeline

## Purpose

The Symphony runtime path is a Conductor-owned durable
`plan -> execute -> verify` pipeline. Podium routes work and pushes runtime
configuration. Performer only runs fenced one-shot attempts. Linear is the
operator projection and collaboration surface.

This is the only runtime execution path. Legacy workflow runners and Performer
tracker polling are not product paths.

## Intake

1. A Linear issue is delegated to the Symphony custom agent.
2. Podium accepts the delegated work through its Linear integration.
3. Podium matches workspace, project scope, custom-agent delegate, routing rule,
   runtime group, active state, blockers, and runtime capacity.
4. Podium queues a dispatch.
5. Conductor leases the dispatch over outbound runtime authentication.
6. Conductor commits or resumes the durable graph for the delegated issue.

Dispatch routing never uses labels or human assignee as scheduler truth.

## Attempt Modes

Each mode is a separate dispatchable unit with its own runtime profile,
workspace boundary, backend home, request file, result file, logs, lease, and
attempt record.

```text
plan    -> produce graph and gate proposal
execute -> implement one graph node and publish immutable output bundle
verify  -> verify one execute attempt against one frozen gate snapshot
```

Performer accepts only managed one-shot attempts:

```bash
.venv/bin/performer --mode plan|execute|verify --attempt-request-path /path/request.json --attempt-result-path /path/result.json
```

The removed positional workflow entrypoint and old result-file flags are not
supported.

## Planning

The planner receives the delegated issue, structured project context, current
graph state, policy limits, and acceptance harness inputs. Its output is a
proposal, not product fact.

Before commit, Conductor derives authoritative intent from structured inputs,
runs deterministic repair, and validates the plan. A valid plan commits as a new
graph revision containing nodes, parentage, `blocks` edges, and frozen gate
bindings.

The planner may emit one node or a decomposed DAG. Decomposition depth is a model
decision bounded by scheduler policy and deterministic validation, not a
hardcoded issue-size threshold.

## Execution

An executable node becomes dispatchable only when all upstream dependencies are
satisfied by verified results and capacity is available. The executor receives
the node, its frozen gate hash, a prepared workspace, and any verified upstream
manifests explicitly listed as inputs.

Before dispatch, Conductor prepares the executor workspace with git. Entry nodes
start from the graph base revision. Dependent nodes get a per-node worktree
branch and Conductor merges every verified blocker branch into it. This merge is
the join point for fan-out/fan-in DAGs.

The executor may modify code, commit to its node branch, and upload evidence. It
cannot change gates, graph topology, verify verdicts, scheduler policy, or
durable attempt state directly.

Every terminal execute attempt publishes an immutable verification input bundle:
base revision, branch name, commit sha, artifact URIs and hashes, evidence URI,
and the gate hash.

## Verification

Verification runs in a separate mode. The verifier checks one execute attempt
against one frozen gate snapshot. It reconstructs the executor output in a fresh
disposable worktree at the execute commit, verifies artifact hashes, loads the
frozen gate by hash, runs the gate procedure, and emits a score.

A node verify-passes only at rubric score `>= 3`. Downstream dependencies are
satisfied by verify-pass plus a verified branch output manifest, not by execute
completion or a self-reported success.

The first default verifier is `local-verifier`: it uses a disposable worktree
and mutation detection after gate execution. This is intentionally not described
as OS-level read-only enforcement.

## Join Conflicts And Delivery

If a downstream join cannot merge verified blocker branches cleanly, Conductor
inserts an ordinary merge-conflict resolver execute node between the blockers
and the downstream node. If that resolver cannot produce a clean branch, the
pipeline escalates to `need_human`.

When every active graph node is `VERIFY_PASSED` or `SUPERSEDED`, Conductor may
produce an operator-facing delivery branch: create or reset
`symphony/<issue-identifier>`, merge every exit node's verified branch/commit,
push the final branch, and open a PR through the configured git host integration.
Delivery outcomes are durable pipeline state and appear in `graph_deliveries`.

## Replan And Supersession

When verification shows the approach must return to planning, Conductor performs
an atomic graph rewrite. The old node becomes `SUPERSEDED`, the replacement
subgraph inherits upstream and downstream `blocks` edges, and the rewrite commits
as a new graph revision.

In Linear, the supersession is projected as a canceled old issue and a new issue
at the same level with `replaces` / `replaced-by` links. The original business
root issue remains immutable and aggregates child results.

## Human And Runtime Waits

Pipeline work that needs operator input enters `need_human` on the affected
node. The operator resumes it by flipping the node out of the blocked-style
state. Comments provide context only.

Runtime approval, permission, and tool-input waits are separate runtime waits.
They are surfaced through node metadata and the product's runtime wait
projection, including `[Human Action]` child issues where the runtime wait flow
uses them.

## Observability

The runtime must expose current graph revision, policy revision, nodes, attempts,
leases, capacity, gates, manifests, integration state, waits, errors, and Linear
projection identifiers through durable state, logs, and API views.

A failed attempt is not handled until its sanitized reason is visible in durable
state, the relevant operator view, correlated logs, and Linear projection when
Linear is part of the managed run.

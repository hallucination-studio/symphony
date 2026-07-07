# Symphony Offline Pipeline Plan Importer

## Status

Optional offline pipeline plan importer. The product runtime source of truth is
`docs/product/three-mode-runtime-pipeline.md`.

This document does not own runtime decomposition. Runtime planning,
execution, verification, rework, and replanning happen inside Conductor's
durable `plan -> execute -> verify` graph. Linear is a projection and
collaboration surface, not the scheduler.

## Purpose

The importer exists only to help a human seed a reviewed static plan into the
pipeline graph when that is useful before a managed run starts. The imported
artifact must become a normal `PlanProposal` and must pass the same deterministic
`PlanValidator` rules as a planner-produced proposal:

- every node has a frozen `GateSpecSnapshot`;
- every gate has executable verification procedure steps;
- every rubric contains exactly `0`, `1`, `2`, `3`, and `4`;
- `pass_threshold` is exactly `3`;
- dependency edges are acyclic and reference existing nodes;
- entry and exit node sets match the graph shape;
- verifier credentials are available before a gate can be accepted.

## Non-Goals

- It does not create a separate runtime architecture.
- It does not introduce scheduler truth in Linear.
- It does not create compatibility for legacy phase runners, direct polling, or
  orchestration-run views.
- It does not bypass Conductor graph revisioning, gate hashing, leases, fencing,
  integration, human waits, or Linear projection metadata.

## Import Shape

The importer reads a pipeline-oriented plan document and converts it to a
`PlanProposal` with:

- graph metadata: `graph_id`, `root_node_id`, `created_by_attempt_id`;
- node records: stable `node_id`, title, optional Linear issue anchor, parent
  node, and initial graph state;
- `blocks` edges that encode verified dependency order;
- one frozen gate snapshot per executable node.

The result is committed through `ConductorPipelineStore.commit_plan()`. After
commit, the scheduler treats imported nodes exactly like planner-created nodes.

## Operating Rule

If an imported plan fails during execute or verify, Conductor must use the same
failure-driven replanning path as any other graph: rework within policy, then
atomic graph rewrite when the rework limit is exceeded. The importer is only a
seed mechanism; it is not a second control loop.

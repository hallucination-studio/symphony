# Product Architecture Docs

These documents describe the current Symphony product architecture. They are
not historical plans, RFC trackers, or implementation scorecards.

## Sources Of Truth

- [Product Shape](./product-shape.md) describes the managed product journey and
  the Podium, Conductor, Performer, and `performer-api` roles.
- [Runtime Pipeline](./runtime-pipeline.md) describes the end-to-end
  `plan -> execute -> verify` flow.
- [Pipeline State](./pipeline-state.md) owns graph revisions, nodes, attempts,
  leases, scheduling, capacity, and convergence.
- [Gates, Verification, And Integration](./gates-verification-integration.md)
  owns frozen gates, rubrics, verifier handoff, manifests, and integration.
- [Linear Projection](./linear-projection.md) owns the Linear issue topology,
  attempt comments, `need_human`, resume semantics, and supersede chains.
- [Runtime Profiles And Backends](./runtime-profiles-backends.md) owns per-mode
  profiles, backend selection, thread identity, and Codex home isolation.
- [Linear Integration](./linear-integration.md) owns OAuth/app setup, delegated
  issue intake, routing, and the GraphQL proxy.
- [Podium Web](./podium-web.md) owns onboarding and operator UI surfaces.
- [Runtime Installation](./runtime-installation.md) owns installer, enrollment,
  updates, connectivity, and uninstall behavior.
- [Security Model](./security-model.md) owns token boundaries, proxy rules, and
  enrollment/update safety.
- [Real Run Testing Guide](../real-run-testing-guide.md) owns the managed
  acceptance procedure and required evidence.

## Doc Rules

- One document owns one concept. Link to the owner instead of duplicating it.
- Use present-tense architecture statements: what Symphony does, what is
  prohibited, and how operators verify the behavior.
- Do not preserve implemented plans as compatibility pointers.
- Do not publish legacy workflow-runner or runtime tracker-polling
  instructions.

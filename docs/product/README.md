# Product architecture

These documents describe the target product architecture, not historical
plans. A document's own status is authoritative: targets explicitly marked
`proposed` are not accepted implementation claims. The compact module baselines
in [`docs/modules`](../modules/README.md) define the currently implemented
ownership. The accepted Desktop target and its migration gates are tracked in
[`podium-desktop.md`](podium-desktop.md), ADR-0007, ADR-0008, and ADR-0009.

## Sources of truth

- [`podium-desktop.md`](podium-desktop.md): accepted local
  Desktop/SQLite/private-IPC target and migration gates. Until its replacement
  gates pass, documents explicitly marked as legacy continue to describe the active path.
- [`ADR-0008`](../decisions/0008-store-linear-tokens-in-podium-sqlite.md):
  accepted plaintext SQLite persistence for Linear access/refresh tokens; it
  supersedes only ADR-0007's OS credential-store decision.
- [`ADR-0009`](../decisions/0009-freeze-linear-app-configuration-for-mvp.md):
  accepted fixed Linear app configuration with no manifest/config revision,
  mutation, or migration path in the MVP.
- [`ADR-0010`](../decisions/0010-create-and-autostart-conductors-from-desktop.md):
  accepted Create Conductor flow with project + repository choice and Desktop
  immediate/restart auto-start, replacing standalone selection and installer UX.
- [`runtime-pipeline.md`](runtime-pipeline.md): Podium -> Conductor -> Performer.
- [`pipeline-state.md`](pipeline-state.md): durable run/task/attempt state.
- [`gates-verification-integration.md`](gates-verification-integration.md):
  command checks and the single selected-backend Performer Gate.
- [`linear-projection.md`](linear-projection.md): parent/Sub Issue projection.
- [`runtime-profiles-backends.md`](runtime-profiles-backends.md): shared
  policy/control contracts, Performer backend ownership, and readiness.
- [`linear-integration.md`](linear-integration.md): accepted fixed-app,
  polling-only Linear core, Managed Run closure, and Podium-only closed Codex
  `performer_event` live status.
- [`podium-web.md`](podium-web.md): unchanged browser business behavior.
- [`runtime-installation.md`](runtime-installation.md): Desktop-owned Create
  Conductor, packaged process auto-start, and restart reconciliation.
- [`security-model.md`](security-model.md): secret and error boundaries.

The implementation has no graph scheduler, parallel work model, branch/join
layer, workflow checkpoint groups, cross-model reviewer, or second acceptance
scheduler. Linear polling checkpoints remain control-plane cursor state.

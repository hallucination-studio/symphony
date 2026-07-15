# Product architecture

These documents describe the accepted target product architecture, not
historical plans. The compact module baselines in
[`docs/modules`](../modules/README.md) define the currently implemented
ownership. The accepted Desktop target and its migration gates are tracked in
[`podium-desktop.md`](podium-desktop.md) and ADR-0007.

## Sources of truth

- [`podium-desktop.md`](podium-desktop.md): accepted local
  Desktop/SQLite/private-IPC target and migration gates. Until its replacement
  gates pass, the remaining documents continue to describe the active path.
- [`runtime-pipeline.md`](runtime-pipeline.md): Podium -> Conductor -> Performer.
- [`pipeline-state.md`](pipeline-state.md): durable run/task/attempt state.
- [`gates-verification-integration.md`](gates-verification-integration.md):
  command checks and the single selected-backend Performer Gate.
- [`linear-projection.md`](linear-projection.md): parent/Sub Issue projection.
- [`runtime-profiles-backends.md`](runtime-profiles-backends.md): shared
  policy/control contracts, Performer backend ownership, and readiness.
- [`linear-integration.md`](linear-integration.md): OAuth, polling, routing, and
  the Linear proxy.
- [`podium-web.md`](podium-web.md): unchanged browser business behavior.
- [`runtime-installation.md`](runtime-installation.md): enrollment and binding.
- [`security-model.md`](security-model.md): secret and error boundaries.

The implementation has no graph scheduler, parallel work model, branch/join
layer, workflow checkpoint groups, cross-model reviewer, or second acceptance
scheduler. Linear polling checkpoints remain control-plane cursor state.

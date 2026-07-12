# Product architecture

These documents describe the current product, not historical plans. The
compact module baselines in [`docs/modules`](../modules/README.md) define
ownership; [`tasks/spec.md`](../../tasks/spec.md) defines the workflow contract.

## Sources of truth

- [`runtime-pipeline.md`](runtime-pipeline.md): Podium -> Conductor -> Performer.
- [`pipeline-state.md`](pipeline-state.md): durable run/task/attempt state.
- [`gates-verification-integration.md`](gates-verification-integration.md):
  command checks and the single Codex Gate.
- [`linear-projection.md`](linear-projection.md): parent/Sub Issue projection.
- [`linear-integration.md`](linear-integration.md): OAuth, polling, routing, and
  the Linear proxy.
- [`podium-web.md`](podium-web.md): unchanged browser business behavior.
- [`runtime-installation.md`](runtime-installation.md): enrollment and binding.
- [`security-model.md`](security-model.md): secret and error boundaries.

The implementation has no graph scheduler, parallel work model, branch/join
layer, workflow checkpoint groups, cross-model reviewer, or second acceptance
scheduler. Linear polling checkpoints remain control-plane cursor state.

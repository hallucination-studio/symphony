# Symphony architecture

Symphony is one product with four runtime packages. The packages are process
boundaries, not separate products.

```text
Podium (Linear control plane + Web)
  -- HTTP polling --> Conductor (one project/repository)
                         -- request/result files --> Performer (one Codex turn)
                                   ^
                                   | performer-api contracts
```

Podium keeps OAuth, project selection, cursor polling, delegation epochs,
dispatch routing, bindings, labels, proxying, onboarding, and the Web API.
Conductor owns one durable `workflow.db`, creates ordered Linear Sub Issues,
executes exactly one task at a time, and projects sanitized state. Performer
runs one fenced `plan`, `execute`, or read-only `gate` turn and then exits.

The runtime channel is HTTP polling only. A report carries liveness, a cached
log tail, and the current sanitized workflow view. A command or dispatch is
leased and acknowledged with a monotonically checked fence. Browser responses
never contain Linear or Codex credentials.

The design deliberately has no DAG, parallel scheduler, branch/join model,
checkpoint-group layer, cross-model reviewer, or second acceptance scheduler.
Linear polling checkpoints remain because they are control-plane cursor state,
not workflow checkpoints.

Module ownership and behavior baselines live in [`docs/modules`](modules/README.md).
The retained product contracts are listed in [`tasks/spec.md`](../tasks/spec.md).

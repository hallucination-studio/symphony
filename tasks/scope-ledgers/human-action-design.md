# Human Action Design Scope Ledger

- `authorized`
  - Establish one architecture source of truth for Human Action interaction,
    states, durable records, recovery, and implementation order.
  - Replace machine command approval with Linear Human Action Issue status and
    ordinary Human comments.
  - Define approve, reject/replan, clarification, permission, waiver, and
    convergence override behavior.
- `required_consequences`
  - Plan rejection supersedes the reviewed Contract and creates a fresh Plan
    execution, Provider context, Contract, and review Action.
  - Action requests live in Conductor-owned descriptions; Human content lives
    in comments; terminal Action status expresses the decision.
  - Every accepted interaction is projected into a closed durable resolution.
  - Existing architecture and E2E documents must stop owning conflicting Human
    Action semantics and link to the dedicated source of truth.
- `out_of_scope`
  - Runtime implementation, contract generation, Desktop controls, and E2E
    execution.
  - Generic natural-language classification or per-command tool approval.
- `assumptions_requiring_approval`
  - none
- `deferred_ideas`
  - Desktop shortcuts, notification policy, batch approval, and transports
    beyond Linear.

# Task 4.1 scope ledger

## authorized

- Extend the feasibility envelope into closed configure, drain, dispatch,
  acknowledgement, runtime-report, gateway, and optional performer-event DTOs.
- Preserve the existing Task 1.4 handshake/envelope contract.

## required_consequences

- Carry exact runtime identity, binding generation, correlation, lease, and
  fencing fields where the approved message requires them.
- Bound serialized payloads and reject unknown fields, versions, message kinds,
  provider selectors, secret transport fields, and invalid state combinations.
- Use the canonical Codex-only `performer_event` envelope from the approved
  Linear integration design, including binding provenance.
- Export and validate the closed DTOs through `performer_api` only.

## out_of_scope

- IPC sessions, socket or pipe transport, process start, dispatch persistence,
  Linear calls, live streaming, event semantic mapping, or UI behavior.
- Additional providers, configurable provider routing, arbitrary gateway
  payloads, compatibility branches beyond the existing Task 1.4 envelope.
- Real Linear or Codex execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Tasks 4.2 through 4.8 consume these contracts in the private runtime path.
- Tasks 5.12 and 5.13 implement and transport semantic Codex events.

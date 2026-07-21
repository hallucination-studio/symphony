# T16 Target Production Boundary

## authorized

- Compose the target external-input adapter, Linear snapshot transport, and
  closed runner with the production Podium/Conductor harness and Performer
  Profile control boundary.
- Bootstrap only the local Podium installation, Project catalog entry, and
  Conductor binding required for the caller-selected target Project.

## required_consequences

- The composition launches the real Conductor process and configures a
  Conductor-owned Profile without exposing process handles, profile records,
  credentials, or Podium SDK objects through the returned runner.
- Linear development token is used only by the external input/transport and
  Podium bootstrap dependencies; the Codex key is sent only through the
  approved Profile control boundary and is zeroed after use.
- No Linear workflow mutation beyond the caller-owned Root/Human adapters is
  introduced; setup does not create Cycles, Nodes, Findings, relations,
  managed records, commits, or delivery.
- Startup failures close any already-created Podium owner or Conductor
  process and return a stable sanitized reason.

## out_of_scope

- Project catalog discovery, state selection, Root input construction, live
  CLI wiring, cleanup policy, and final target verdict assembly.
- Restart, repair/escalation, delivery, and scheduler scenario orchestration.
- Credentialed retained acceptance; this slice is composition evidence only.

## assumptions_requiring_approval

None.

## deferred_ideas

- Connect the composition to the target success entry point and retained Git
  fixture.
- Add real restart, repair/escalation, delivery, and scheduling evidence.

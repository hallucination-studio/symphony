# Task 4.5 plan revision scope ledger

## authorized

- Revise the approved plan to resolve the discovered Task 4.5 file-budget and
  Configure contract gaps before production implementation continues.
- Include the actual Conductor tick entrypoint and the inherited-channel CLI
  bootstrap required by the approved private IPC architecture.

## required_consequences

- Split the oversized correction into contract-first Tasks 4.5a-4.5d.
- Define one exact Configure wire shape using the existing closed
  `PerformerProfileConfig`; do not create a second compatibility DTO.
- Update downstream dependencies and the mechanical todo list to point at the
  final active-path task.

## out_of_scope

- Production code, tests, runtime behavior, schema, UI, or compatibility
  implementation.
- Any new provider, public transport, token, fallback, or customer workflow.

## assumptions_requiring_approval

- None. The user explicitly approved revising the plan on 2026-07-16.

## deferred_ideas

- Implementation resumes at Task 4.5a after this plan-only revision.

# T16 Target Delivery Scenario

## authorized

- Add a target scenario that waits for durable delivery evidence after a
  successful Verify and correlates it to the same Root and immutable Verify
  revision.
- Reuse the existing target runner and production boundary lifecycle.

## required_consequences

- Delivery is accepted only after Linear read-back, with a closed delivery
  kind, branch, verified revision, Verify correlation, and read-back marker.
- A revision mismatch, missing delivery, or wrong Root fails closed.
- The scenario does not perform Git push, pull-request creation, or direct
  workflow mutation.

## out_of_scope

- Changing Conductor delivery policy or adding a second delivery authority.
- Remote credentials, provider metadata, or arbitrary Linear SDK objects.
- Final all-scenario verdict aggregation.

## assumptions_requiring_approval

None.

## deferred_ideas

- Credentialed retained delivery acceptance after live composition is wired.

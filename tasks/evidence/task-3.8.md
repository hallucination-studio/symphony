# Task 3.8 evidence

- Fixed GraphQL operation returns app-user identity, organization identity, and bounded project metadata.
- Discovery exhausts cursors, rejects repeated cursors, and deduplicates stable project ids before one SQLite replacement transaction.
- App-user, organization, exact-scope, gateway, and partial-page failures preserve the last complete catalog and record a sanitized durable error.
- Focused verification: `37 passed` across gateway, discovery, and SQLite Linear tests.
- Real Linear execution is intentionally deferred to Phase 7.

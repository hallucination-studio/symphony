# ADR-0008: Store Linear tokens in Podium SQLite

## Status

Accepted by the user on 2026-07-15.

This ADR supersedes only the OS credential-store portion of ADR-0007. The rest
of ADR-0007 remains accepted.

## Context

Podium Desktop must retain a Linear installation across service restart and
application update. A memory-only token would force the customer through OAuth
again. An OS credential-store adapter and application-defined encryption add
platform code, failure modes, dependencies, and key lifecycle that are not
required for the approved local product.

The current production code still contains the old PostgreSQL and
Symphony-encrypted token path. That is implementation state, not the target
defined here.

## Decision

Store the Linear `access_token` and `refresh_token` as plaintext fields in the
installation row of the local Podium `podium.db`.

- Podium is the only process that writes the database and the only role that
  reads or uses those fields.
- OAuth records **Connected** only after the installation metadata and token
  pair commit together.
- Token refresh replaces the access/refresh pair in one SQLite transaction
  before the new pair becomes active.
- Disconnect clears the pair and updates installation state in one
  transaction.
- Normal restart and application update reopen the same app-data database and
  do not repeat OAuth.
- Token fields are excluded from ordinary records, snapshots, APIs, Tauri and
  Conductor contracts, logs, reports, artifacts, and Linear projections.
- A missing, unreadable, or corrupt database fails closed and requires
  authorization again after the database is restored or reset if the
  credential was lost.

There is no OS credential store, application encryption/decryption, encryption
key, ciphertext field, plaintext side file, memory-only credential mode,
dual-read/write path, or automatic credential migration.

## Security boundary

The accepted boundary is the current user's local application-data directory
and Podium's exclusive database ownership. This design does not claim to
protect a token from another process or user that can already read that
database. It continues to protect the token from browser/API output, local
role protocols, logs, reports, artifacts, and Linear.

Disconnect is a logical transactional clear. The target makes no forensic
secure-erasure guarantee for prior SQLite pages or WAL contents and adds no
vacuum or overwrite protocol.

## Consequences

- Credential persistence uses the existing SQLite lifecycle and migration
  machinery; no credential adapter or cryptography dependency is added.
- Schema and model audits must allow the two approved token fields only in the
  Podium installation persistence boundary while continuing to reject them in
  every outward contract and output.
- Existing Keychain feasibility evidence proves OAuth exchange and refresh
  behavior only; it is not evidence that the target persistence path works.
- The old PostgreSQL ciphertext path is removed only after the SQLite
  replacement gates pass. It is not migrated, dual-written, or used as a
  fallback.

## Rejected alternatives

### Memory-only tokens

Rejected because restart or application update would require authorization
again.

### OS credential store

Rejected because it adds platform adapters and a separate failure domain for a
local single-user product.

### Symphony encryption or ciphertext in SQLite

Rejected because it adds key storage, rotation, and recovery complexity while
still requiring a place to protect the key.

### Compatibility migration or dual storage

Rejected because the Desktop migration is an approved hard cut. Automatic
import, dual-read, and dual-write would retain the complexity being removed.

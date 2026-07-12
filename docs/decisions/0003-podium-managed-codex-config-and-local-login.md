# ADR-0003: Podium-managed Codex configuration with local login credentials

## Status

Accepted

## Date

2026-07-12

## Context

The managed runtime needs one versioned Codex configuration for a project, but
Codex authentication is not necessarily an API key. The supported local Codex
login flow is `codex login`, which keeps the login state in the local Codex home.
Linear and Podium credentials already have a strict server-side boundary, and
Codex credentials must not become another browser, API, Linear, or logging
payload.

The previous implementation copied a locally staged Codex seed, while Podium
reported an empty compatibility profile. That made the effective configuration
implicit, could not identify which version a run used, and did not define how a
ChatGPT login without an API token reaches an isolated Performer attempt.

## Decision

Podium owns a binding-scoped, versioned Codex configuration file. It stores the
validated non-secret TOML, a SHA-256 digest, and a policy revision alongside
the project binding. The existing `project.configure` command carries that
small file content and metadata through the authenticated runtime command
lease/ack transport. The command is idempotent and stale versions are rejected;
there is no second config service or transport.

Podium never stores or receives Codex credentials. In particular, it never
accepts `auth.json`, API keys, ChatGPT access tokens, or a credential-bearing
environment value. Browser, Linear, managed-run, and log surfaces expose only
config version, digest, policy revision, and the existing sanitized runtime
readiness.

Conductor persists the accepted config and its version/hash in local binding
state. Before every plan, execute, or gate attempt it writes the Podium config
to a local controlled file and copies it, plus the approved local Codex seed
files, into a fresh isolated `CODEX_HOME`. An operator may prepare that seed by
running `codex login` in a fixed staged home; the resulting OAuth/session state
stays local. A seed named or resolved as `~/.codex` is rejected. Codex owns any
login refresh. Missing local setup continues to fail closed with the existing
sanitized runtime reason and remains visible in the normal product surfaces.

## Alternatives considered

### Send an API token from Podium

Rejected. It does not support ChatGPT OAuth-only accounts and would violate the
existing secret boundary by making Codex credentials part of the SaaS control
plane.

### Send `auth.json` through the project command

Rejected. Runtime commands are durable, retryable control-plane records and
would make a bearer credential observable in PostgreSQL, HTTP traces, reports,
and operator tooling.

### Use the operator's `~/.codex` directly

Rejected. It couples runs to ambient personal state, makes the credential
boundary un-auditable, and violates the real-flow requirement for a fixed
staged seed.

### Require an API key for all managed runs

Rejected. Official ChatGPT login is a supported Codex authentication mode and
must work without an API token.

## Consequences

- Podium gains a small durable config field on the existing project binding,
  while keeping the existing polling transport and fencing model.
- Conductor has one local config file plus the existing staged seed path; no
  credential broker or auth-mode registry is introduced.
- Real-flow preflight must stage approved files from an explicitly chosen
  logged-in Codex home and must test the OAuth-login path.
- Existing `auth.json` redaction and `CODEX_HOME` isolation tests remain
  mandatory; no Podium/Web UI is required to render credential details.

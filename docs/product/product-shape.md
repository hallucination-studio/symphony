# Product Shape

## Overview

Symphony should be delivered as a hosted control plane plus a customer-installed
runtime. Podium is the hosted product surface. It owns the Linear OAuth
application, stores Linear workspace tokens, receives Linear webhooks, routes
work, and exposes the web UI. Customers install a local runtime that contains
Conductor and Performer. That runtime runs on the customer's machine or server
and performs code work close to the customer's repositories and credentials.

The customer should not need to create their own Linear application. Symphony
creates and operates one official Linear application. Customers authorize that
application into their Linear workspace from Podium.

## Product Components

### Podium

Podium is the SaaS boundary. It is public internet-facing and must have stable
HTTPS endpoints for:

- Linear OAuth callback
- Linear webhooks
- Runtime registration
- Runtime heartbeat and command channels
- Linear GraphQL proxy
- Web UI and API

Podium owns the sensitive integration state:

- Linear OAuth access tokens
- Linear refresh tokens
- Linear webhook signing secrets
- Runtime enrollment tokens
- Runtime dispatch/proxy tokens

### Conductor

Conductor is installed in the customer's environment. It manages local state and
runtime processes, but it does not hold Linear OAuth tokens. It registers itself
with Podium, receives dispatches, starts and stops Performers, exposes local
health, and uploads operational state back to Podium.

Conductor should only need outbound connectivity to Podium for the primary
product path. Direct inbound calls from Podium to a customer's machine should be
treated as an optional development mode, not the default SaaS posture.

### Performer

Performer runs exactly one fenced pipeline attempt in `plan`, `execute`, or
`verify` mode. It receives attempt JSON from Conductor, uses the isolated
runtime environment prepared for that mode, and writes one fenced result JSON
back to Conductor. It may access local repositories, workspaces, Codex, shell
tools, and customer-approved secrets needed for the attempt.

Performer must not require `LINEAR_API_KEY` in the managed product path and must
not poll Linear directly. Linear collaboration flows through Podium and
Conductor's pipeline projection.

## Core User Journey

1. A user signs in to Podium.
2. The user connects a Linear workspace by authorizing the Symphony Linear app.
3. Podium stores the Linear workspace installation.
4. The user selects Linear projects and routing rules.
5. Podium generates a runtime install command.
6. The user runs the install command on a local machine or server.
7. The installed Conductor enrolls with Podium.
8. Linear sends `AgentSessionEvent` webhooks to Podium.
9. Podium routes each event to an eligible Conductor.
10. Conductor schedules fenced `plan -> execute -> verify` attempts and starts
    short-lived Performers for each mode.
11. Podium shows pipeline graph state, capacity, leases, attempts, manifests,
    integration, human waits, and runtime health.

## Default Architecture Decision

The default should be:

> Linear and public webhooks terminate at Podium. Customer runtimes connect
> outbound to Podium. Linear tokens never leave Podium.

This keeps the customer installation simpler and avoids asking users to expose a
local machine to the public internet.

## Non-Goals for the First Managed Version

- No customer-created Linear OAuth applications.
- No requirement for customer machines to expose public webhook endpoints.
- No Linear OAuth tokens on Conductor or Performer.
- No Kubernetes requirement for customer runtime.
- No local UI required on the customer machine.

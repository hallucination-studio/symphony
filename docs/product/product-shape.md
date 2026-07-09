# Product Shape

## Overview

Symphony is one managed product with a hosted control plane and a
customer-installed runtime. Podium is the hosted product surface. Conductor and
Performer run near the customer's repositories and execution credentials.
`performer-api` carries shared contracts so those roles do not import each
other's runtime code.

Linear integration terminates at Podium. Customer runtimes connect outbound to
Podium. Linear OAuth tokens never leave Podium.

## Product Roles

### Podium

Podium is the SaaS boundary and public HTTPS surface. It owns:

- user authentication and Podium Web APIs;
- Linear OAuth/app installation state;
- delegated Linear issue intake;
- routing rules and runtime groups;
- runtime enrollment and update policy;
- dispatch queues and runtime configuration;
- the scoped Linear GraphQL proxy;
- sanitized pipeline views for operators.

### Conductor

Conductor is the customer-side daemon. It owns local instance metadata,
durable pipeline graph state, runtime credentials, dispatch leases, per-mode
runtime profile materialization, Performer process lifecycle, result
collection, local logs, and reports back to Podium.

Conductor is the only local process manager for Performer. It launches
Performer through the installed `performer` command or the repo-local fallback;
it does not import Performer internals.

### Performer

Performer is a short-lived worker. It runs exactly one fenced attempt in
`plan`, `execute`, or `verify` mode from Conductor-owned request/result JSON
paths. It may use local repositories, shell tools, model backends, and
customer-approved execution secrets prepared for that mode.

Performer does not lease dispatches, poll Linear, own graph state, or receive
Linear OAuth tokens.

### performer-api

`performer-api` is the shared contract package. It owns runtime modes,
scheduler policy DTOs, runtime profile DTOs, pipeline graph and attempt state,
frozen gate snapshots, verification input snapshots, task output manifests,
projection models, and registration DTOs.

## Managed Journey

1. A user signs in to Podium.
2. The user connects Linear by authorizing the Symphony Linear app.
3. The user selects project scope and repository mapping.
4. Podium generates a runtime install command.
5. The installed Conductor enrolls with Podium and receives scoped credentials.
6. A Linear issue is delegated to the Symphony custom agent.
7. Podium accepts the delegated issue and queues a dispatch for an eligible
   runtime group.
8. Conductor leases the dispatch and commits or resumes a durable pipeline
   graph.
9. Performer runs fenced `plan`, `execute`, and `verify` attempts under
   per-mode profiles.
10. Podium and Linear show sanitized operator state: nodes, attempts, capacity,
    leases, gates, manifests, waits, conflicts, and runtime health.

## Product Boundaries

- The product is Symphony, not four independent tools.
- Package boundaries are runtime boundaries.
- The managed path is Podium -> Conductor -> Performer, with Conductor-owned
  durable state.
- Linear is a collaboration and projection surface, not scheduler truth.
- Runtime install and update flows do not ask customers to clone this repo or
  copy Linear tokens.

## Non-Goals

- No customer-created Linear OAuth application for the managed path.
- No inbound public callback requirement for customer machines.
- No Linear OAuth token on Conductor or Performer.
- No local web console requirement on customer machines.
- No compatibility shim for the removed `symphony` Python package, CLI,
  labels, state files, or workflow runner paths.

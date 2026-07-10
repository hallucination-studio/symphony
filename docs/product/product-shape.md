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
- default and customer-owned Linear application configuration;
- versioned Linear OAuth installation state and callback acceptance;
- refreshable installation credentials and reliable delegated-issue polling;
- selected projects, single-project Conductor bindings, and routing rules;
- runtime enrollment, dispatch queues, and runtime configuration;
- the scoped Linear GraphQL proxy;
- sanitized Managed Runs views for operators.

### Conductor

Conductor is the customer-side daemon. One Conductor binds exactly one Linear
project and one repository. It owns that project's local instance metadata,
durable Managed Runs state, runtime credentials, dispatch leases, per-role
runtime profile materialization, Performer lifecycle, turn collection, local
logs, and reports back to Podium.

Conductor is the only local process manager for Performer. It launches Performer
through the installed `performer` command or the repo-local fallback; it does
not import Performer internals. Multiple isolated Conductors may run on the same
host for different projects.

### Performer

Performer is a short-lived worker. It runs exactly one fenced attempt in the
Linear-native Managed Runs flow from Conductor-owned request/result JSON paths.
It may use local repositories, shell tools, model backends, and
customer-approved execution secrets prepared for that role.

Performer does not lease dispatches, poll Linear, own Managed Runs state, or
receive Linear OAuth tokens.

### performer-api

`performer-api` is the shared contract package. It owns Managed Runs DTOs,
runtime policy and profile DTOs, plan/work-item state, verification evidence,
projection models, and registration DTOs.

## Managed Journey

1. A user signs in to Podium.
2. The user chooses Podium's default Linear application or stages a custom one.
3. A Linear workspace admin authorizes the app actor; Podium validates the
   callback and installation identity.
4. The user selects the Linear projects Symphony may manage.
5. Podium generates an enrollment command for a named, initially unbound
   Conductor.
6. After the Conductor is online, the user binds one selected project and its
   repository; Podium verifies configuration and adds the managed project label.
7. A Linear issue is delegated to the installed app actor.
8. Full baseline and incremental polling discovers delegated issues with
   transactional checkpoints and queues one dispatch per delegation epoch.
9. The project Conductor leases the dispatch and commits or resumes one durable
   managed run.
10. Performer runs fenced plan and work-item turns under per-role profiles.
11. Podium and Linear show sanitized state: runs, work items, capacity, leases,
    verification evidence, waits, conflicts, installation health, and runtime
    health.

## Product Boundaries

- The product is Symphony, not four independent tools.
- Package boundaries are runtime boundaries.
- The managed path is Podium -> Conductor -> Performer, with Conductor-owned
  durable Managed Runs state.
- Linear is a collaboration and projection surface, not scheduler truth.
- Project bindings are routing truth; project labels and human assignee are not.
- Runtime install and update flows do not ask customers to clone this repo or
  copy Linear tokens.

## Non-Goals

- No project-level OAuth installation or automatic project-member mutation.
- No Conductor that serves more than one Linear project.
- No inbound public callback requirement for customer machines.
- No Linear OAuth token on Conductor or Performer.
- No local web console requirement on customer machines.
- No compatibility shim for removed packages, commands, labels, state files,
  global Linear app tokens, or workflow runner paths.

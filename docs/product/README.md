# Symphony Product Architecture

This directory describes the intended product shape for Symphony as a managed
SaaS plus customer-installed runtime.

The core product split is:

- **Podium**: hosted control plane, Linear application owner, OAuth token holder,
  dispatch router, and operator UI.
- **Conductor**: customer-side daemon that registers with Podium, manages local
  Performer instances, and reports runtime state.
- **Performer**: customer-side worker that executes agent runs and accesses
  Linear only through Podium's controlled proxy.

Start here:

- [Product Shape](./product-shape.md)
- [Three-Mode Runtime Pipeline](./three-mode-runtime-pipeline.md)
- [Linear Topology Mirror](./linear-topology-mirror.md)
- [Linear Application and Podium Integration](./linear-podium-integration.md)
- [Runtime Installer and Updates](./runtime-installer-and-updates.md)
- [Podium Web Onboarding](./podium-web-onboarding.md)
- [Security Model](./security-model.md)

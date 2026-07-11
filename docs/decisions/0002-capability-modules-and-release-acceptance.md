# ADR-0002: Capability modules and release acceptance

Status: Rejected

The proposed capability-module catalog, parallel scheduler, checkpoint graph,
cross-model acceptance runner, and independent release scheduler are not part
of Symphony's approved design. The implementation uses the compact module
baselines in `docs/modules/` and the single Conductor workflow:

`Linear poll -> plan -> Linear Sub Issues -> sequential execute -> verification commands + one read-only Codex Gate`.

Plan revisions, approval, risks, architecture decisions, open questions,
rubric metadata, manifests, artifacts, and provenance remain durable workflow
data. They are not a second orchestration framework.

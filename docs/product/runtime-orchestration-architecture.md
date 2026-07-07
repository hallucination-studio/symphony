# Runtime Orchestration Architecture

Superseded by `docs/product/three-mode-runtime-pipeline.md`.

The runtime architecture is now the Conductor-owned durable pipeline graph:
`plan -> execute -> verify`, with fenced attempts, immutable gate snapshots,
lease-based capacity, verified manifests, deterministic integration, and
PipelineView/Podium observability.

This page remains only as a compatibility pointer for old documentation links.
Do not add runtime behavior here.

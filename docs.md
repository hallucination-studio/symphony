# Historical legacy spec

Do not use this file as runtime architecture guidance.

The active Symphony runtime architecture is
`docs/product/three-mode-runtime-pipeline.md`: Conductor owns durable pipeline
graph state, Performer runs fenced `plan`, `execute`, or `verify` attempts from
request/result JSON files, and Podium projects sanitized pipeline state.

Legacy direct runner behavior has been removed from product runtime paths.

"""Closed registry of approved Performer backend factories."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import os

from .backend_interface import PerformerBackend


BackendFactory = Callable[[], PerformerBackend]


class PerformerBackendRegistryError(RuntimeError):
    def __init__(self, code: str, sanitized_reason: str) -> None:
        super().__init__(sanitized_reason)
        self.code = code


class BackendRegistry:
    def __init__(self, factories: Mapping[str, BackendFactory]) -> None:
        self._factories = dict(factories)

    def create(self, kind: str) -> PerformerBackend:
        factory = self._factories.get(kind)
        if factory is None:
            raise PerformerBackendRegistryError(
                "performer_backend_unsupported",
                "The requested Performer backend is not supported.",
            )
        backend = factory()
        if backend.kind != kind:
            raise PerformerBackendRegistryError(
                "performer_backend_kind_mismatch",
                "The selected Performer backend did not match the requested kind.",
            )
        return backend


def _codex_backend() -> PerformerBackend:
    from .backends.codex import CodexBackend

    configured_binary = os.environ.get("CODEX_SDK_CODEX_BIN", "").strip() or None
    return CodexBackend(sdk_codex_bin=configured_binary)


DEFAULT_BACKEND_REGISTRY = BackendRegistry({"codex": _codex_backend})


__all__ = [
    "BackendFactory",
    "BackendRegistry",
    "DEFAULT_BACKEND_REGISTRY",
    "PerformerBackendRegistryError",
]

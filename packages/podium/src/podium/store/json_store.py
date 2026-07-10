from __future__ import annotations

from .json_store_auth import JsonStoreAuthMixin
from .json_store_base import JsonStoreBase
from .json_store_dispatch import JsonStoreDispatchMixin
from .json_store_legacy import JsonStoreLegacyMixin
from .json_store_linear import JsonStoreLinearMixin
from .json_store_ops import JsonStoreOpsMixin
from .json_store_runtime import JsonStoreRuntimeMixin


class PodiumStore(
    JsonStoreLegacyMixin,
    JsonStoreAuthMixin,
    JsonStoreLinearMixin,
    JsonStoreRuntimeMixin,
    JsonStoreDispatchMixin,
    JsonStoreOpsMixin,
    JsonStoreBase,
):
    """JSON-backed Podium state store used by tests.

    The object stores only its root path. Every operation reads and writes JSON
    files so tests exercise the same restart-safe shape as the PostgreSQL store.
    """

from __future__ import annotations

import os
import json
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

LINEAR_OAUTH_HOST = "127.0.0.1"
LINEAR_OAUTH_PORT = 43821
LINEAR_OAUTH_PATH = "/oauth/linear/callback"
LINEAR_OAUTH_REDIRECT_URI = f"http://{LINEAR_OAUTH_HOST}:{LINEAR_OAUTH_PORT}{LINEAR_OAUTH_PATH}"
LINEAR_OAUTH_SCOPES = ("read", "write", "app:assignable")
LINEAR_OAUTH_ACTOR = "app"
_RESOURCE_PATH = "resources/linear-application.json"
_FIXED_RESOURCE: dict[str, Any] = {
    "redirect_uri": LINEAR_OAUTH_REDIRECT_URI,
    "scopes": list(LINEAR_OAUTH_SCOPES),
    "actor": LINEAR_OAUTH_ACTOR,
}


@dataclass(frozen=True)
class LinearApplicationManifest:
    client_id: str
    redirect_uri: str
    scopes: tuple[str, ...]
    actor: str


def load_linear_manifest() -> LinearApplicationManifest:
    client_id = os.environ.get("LINEAR_CLIENT_ID", "").strip()
    if not client_id:
        raise ValueError("linear_client_id_missing")
    try:
        encoded = files("podium").joinpath(_RESOURCE_PATH).read_text(encoding="utf-8")
    except (OSError, ModuleNotFoundError) as error:
        raise ValueError("linear_manifest_resource_missing") from error
    except UnicodeDecodeError as error:
        raise ValueError("linear_manifest_invalid") from error
    resource = _decode_fixed_resource(encoded)
    return LinearApplicationManifest(
        client_id=client_id,
        redirect_uri=resource["redirect_uri"],
        scopes=tuple(resource["scopes"]),
        actor=resource["actor"],
    )


def _decode_fixed_resource(encoded: str) -> dict[str, Any]:
    try:
        resource = json.loads(encoded, object_pairs_hook=_unique_object)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("linear_manifest_invalid") from error
    if resource != _FIXED_RESOURCE:
        raise ValueError("linear_manifest_invalid")
    return resource


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("linear_manifest_invalid")
        result[key] = value
    return result


def linear_oauth_client_id() -> str:
    return load_linear_manifest().client_id

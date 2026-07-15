from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from podium.linear_manifest import (
    LINEAR_OAUTH_REDIRECT_URI,
    LinearApplicationManifest,
    _decode_fixed_resource,
    load_linear_manifest,
)
from podium.linear_oauth import authorization_url


EXPECTED_RESOURCE = {
    "redirect_uri": "http://127.0.0.1:43821/oauth/linear/callback",
    "scopes": ["read", "write", "app:assignable"],
    "actor": "app",
}


def test_loads_exact_fixed_manifest_with_environment_client_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client-1")

    assert load_linear_manifest() == LinearApplicationManifest(
        client_id="public-client-1",
        redirect_uri=LINEAR_OAUTH_REDIRECT_URI,
        scopes=("read", "write", "app:assignable"),
        actor="app",
    )

    query = parse_qs(urlparse(authorization_url("state", "challenge")).query)
    assert query["scope"] == ["read,write,app:assignable"]
    assert query["actor"] == ["app"]
    assert query["redirect_uri"] == [LINEAR_OAUTH_REDIRECT_URI]


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_or_empty_client_id_fails_closed(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv("LINEAR_CLIENT_ID", raising=False)
    else:
        monkeypatch.setenv("LINEAR_CLIENT_ID", value)

    with pytest.raises(ValueError, match="^linear_client_id_missing$"):
        load_linear_manifest()


@pytest.mark.parametrize(
    "mutation",
    [
        {"client_secret": "forbidden"},
        {"client_id": "browser-override"},
        {"manifest_revision": 2},
        {"webhook_url": "https://example.invalid"},
        {"scopes": ["read"]},
        {"actor": "user"},
        {"redirect_uri": "http://127.0.0.1:9999/callback"},
    ],
)
def test_resource_rejects_unknown_or_mutated_configuration(
    mutation: dict[str, object],
) -> None:
    payload = dict(EXPECTED_RESOURCE)
    payload.update(mutation)

    with pytest.raises(ValueError, match="^linear_manifest_invalid$"):
        _decode_fixed_resource(json.dumps(payload))


def test_resource_rejects_duplicate_keys() -> None:
    duplicate = (
        '{"redirect_uri":"http://127.0.0.1:43821/oauth/linear/callback",'
        '"scopes":["read","write","app:assignable"],'
        '"actor":"app","actor":"app"}'
    )

    with pytest.raises(ValueError, match="^linear_manifest_invalid$"):
        _decode_fixed_resource(duplicate)


def test_source_package_and_desktop_bundle_config_reference_the_same_resource() -> None:
    resource = files("podium").joinpath("resources/linear-application.json")
    assert json.loads(resource.read_text(encoding="utf-8")) == EXPECTED_RESOURCE

    repository = Path(__file__).resolve().parents[1]
    tauri_config = json.loads(
        (repository / "packages/podium/desktop/src-tauri/tauri.conf.json").read_text()
    )
    bundled = tauri_config["bundle"]["resources"]
    assert bundled == {
        "../../src/podium/resources/linear-application.json": (
            "resources/linear-application.json"
        )
    }


def test_resource_has_only_approved_public_fields() -> None:
    encoded = files("podium").joinpath("resources/linear-application.json").read_text()

    assert set(json.loads(encoded)) == {"redirect_uri", "scopes", "actor"}
    assert "secret" not in encoded.lower()
    assert "revision" not in encoded.lower()
    assert "webhook" not in encoded.lower()


def test_missing_package_resource_fails_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client-1")
    monkeypatch.setattr("podium.linear_manifest.files", lambda _package: tmp_path)

    with pytest.raises(ValueError, match="^linear_manifest_resource_missing$"):
        load_linear_manifest()


def test_package_resource_os_error_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class UnreadableResource:
        def joinpath(self, _path: str):
            return self

        def read_text(self, *, encoding: str) -> str:
            raise PermissionError("raw-path-must-not-escape")

    monkeypatch.setenv("LINEAR_CLIENT_ID", "public-client-1")
    monkeypatch.setattr(
        "podium.linear_manifest.files", lambda _package: UnreadableResource()
    )

    with pytest.raises(ValueError, match="^linear_manifest_resource_missing$") as error:
        load_linear_manifest()
    assert "raw-path-must-not-escape" not in str(error.value)

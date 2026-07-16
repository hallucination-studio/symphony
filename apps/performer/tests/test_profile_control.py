from __future__ import annotations

import io
from types import SimpleNamespace

from performer.profile_control.host import ProfileControlHost


class FakeCodex:
    def __init__(self):
        self.keys = []

    def login_api_key(self, secret):
        self.keys.append(secret)

    def account(self, refresh_token=False):
        return SimpleNamespace(account=SimpleNamespace(email="person@example.com"))

    def login_chatgpt(self):
        return SimpleNamespace(
            auth_url="https://auth.example.test",
            wait=lambda: SimpleNamespace(success=True, error=None),
        )


def metadata(kind, **extra):
    return {
        "protocol_version": "1",
        "request_id": "request-1",
        "kind": kind,
        "profile_id": "profile-1",
        **extra,
    }


def test_api_key_is_read_from_exact_separate_frame():
    sdk = FakeCodex()
    secret = b"top-secret"
    stream = io.BytesIO(secret)

    results = ProfileControlHost(sdk).handle(
        metadata("set_api_key", secret_frame_length=len(secret)), stream
    )

    assert sdk.keys == ["top-secret"]
    assert results[-1]["kind"] == "login_succeeded"
    assert "top-secret" not in str(results)


def test_short_or_extra_secret_frame_fails_without_echo():
    for stream, length in ((io.BytesIO(b"short"), 10), (io.BytesIO(b"secret!extra"), 7)):
        sdk = FakeCodex()
        results = ProfileControlHost(sdk).handle(
            metadata("set_api_key", secret_frame_length=length), stream
        )
        assert sdk.keys == []
        assert results[-1]["kind"] == "login_failed"
        assert "secret" not in str(results)


def test_status_is_normalized():
    result = ProfileControlHost(FakeCodex()).handle(
        metadata("get_profile_status"), io.BytesIO()
    )[0]
    assert result["readiness"] == "ready"
    assert result["sanitized_account_label"] == "person@example.com"


def test_missing_account_is_login_required():
    sdk = FakeCodex()
    sdk.account = lambda refresh_token=False: SimpleNamespace(account=None)

    result = ProfileControlHost(sdk).handle(
        metadata("get_profile_status"), io.BytesIO()
    )[0]

    assert result["kind"] == "profile_status"
    assert result["readiness"] == "login-required"


def test_chatgpt_login_emits_started_then_success():
    results = ProfileControlHost(FakeCodex()).handle(
        metadata("start_chatgpt_login"), io.BytesIO()
    )
    assert [result["kind"] for result in results] == ["login_started", "login_succeeded"]


def test_chatgpt_started_is_available_before_wait():
    waited = False

    class StreamingCodex(FakeCodex):
        def login_chatgpt(self):
            def wait():
                nonlocal waited
                waited = True
                return SimpleNamespace(success=True, error=None)

            return SimpleNamespace(auth_url="https://auth.example.test", wait=wait)

    results = ProfileControlHost(StreamingCodex()).iter_results(
        metadata("start_chatgpt_login"), io.BytesIO()
    )

    assert next(results)["kind"] == "login_started"
    assert waited is False
    assert next(results)["kind"] == "login_succeeded"
    assert waited is True

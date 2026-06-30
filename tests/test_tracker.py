from __future__ import annotations

import pytest

from symphony.config import ConfigError, TrackerConfig
from symphony.linear import LinearTracker
from symphony.tracker import create_tracker, register_tracker_adapter


def make_config(kind: str = "linear") -> TrackerConfig:
    return TrackerConfig(
        kind=kind,
        endpoint="https://api.linear.app/graphql",
        project_slug="MT",
        api_key="linear-token",
    )


def test_create_tracker_returns_linear_adapter_for_linear_kind() -> None:
    tracker = create_tracker(make_config())

    assert isinstance(tracker, LinearTracker)


def test_custom_tracker_adapter_can_be_registered() -> None:
    class CustomTracker:
        def __init__(self, config: TrackerConfig):
            self.config = config

    register_tracker_adapter("custom", CustomTracker)

    tracker = create_tracker(make_config("custom"))

    assert isinstance(tracker, CustomTracker)
    assert tracker.config.kind == "custom"


def test_custom_tracker_adapter_can_use_non_linear_config_without_token_or_project() -> None:
    class CustomTracker:
        def __init__(self, config: TrackerConfig):
            self.config = config

    register_tracker_adapter("custom-no-auth", CustomTracker)

    tracker = create_tracker(
        TrackerConfig(
            kind="custom-no-auth",
            endpoint="https://tracker.example/api",
            project_slug="",
            api_key="",
        )
    )

    assert isinstance(tracker, CustomTracker)
    assert tracker.config.project_slug == ""
    assert tracker.config.api_key == ""


def test_unknown_tracker_kind_fails_at_factory_time() -> None:
    with pytest.raises(ConfigError) as exc:
        create_tracker(make_config("missing"))

    assert exc.value.code == "unsupported_tracker_kind"

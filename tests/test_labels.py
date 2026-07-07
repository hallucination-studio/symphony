from performer_api.labels import LABEL_SCHEME, PIPELINE_LABELS


LEGACY_LABEL_FIXTURES = {
    "performer:queued",
    "performer:running",
    "performer:retrying",
    "performer:error",
    "performer:done",
    "performer:type/task",
    "performer:type/acceptance",
    "performer:type/gate",
    "performer:type/evidence",
    "performer:gate/passed",
    "performer:score/3/4",
    "performer:phase/planned",
}


def test_label_scheme_has_unique_static_labels_across_axes() -> None:
    labels = LABEL_SCHEME.all_static_labels()

    assert len(labels) == len(set(labels))
    assert all(label.startswith("performer:") for label in labels)
    assert set(LABEL_SCHEME.pipeline) == {
        "planning",
        "ready",
        "executing",
        "verifying",
        "verify_passed",
        "awaiting_human",
        "failed",
    }
    assert set(LABEL_SCHEME.types) == {"human_action", "repository_integration", "pipeline_node"}


def test_label_scheme_does_not_include_legacy_runtime_labels() -> None:
    labels = set(LABEL_SCHEME.all_static_labels())

    assert labels.isdisjoint(LEGACY_LABEL_FIXTURES)
    assert not any(label.startswith("performer:phase/") for label in labels)
    assert not any(label.startswith("performer:lifecycle/") for label in labels)
    assert not any(label.startswith("performer:dispatch/") for label in labels)
    assert not any(label.startswith("performer:retry/") for label in labels)
    assert not any(label.startswith("performer:error/") for label in labels)
    assert not any(label.startswith("performer:human/") for label in labels)
    assert not any(label.startswith("performer:gate/") for label in labels)
    assert not any(label.startswith("performer:score/") for label in labels)


def test_pipeline_labels_replace_phase_contract() -> None:
    assert PIPELINE_LABELS["executing"] == "performer:pipeline/executing"
    assert PIPELINE_LABELS["awaiting_human"] == "performer:pipeline/awaiting-human"

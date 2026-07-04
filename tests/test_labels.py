from performer_api.labels import LABEL_SCHEME


LEGACY_LABEL_FIXTURES = {
    "performer:queued",
    "performer:running",
    "performer:retrying",
    "performer:error",
    "performer:done",
    "performer:type/task",
    "performer:type/acceptance",
    "performer:phase/planned",
}


def test_label_scheme_has_unique_static_labels_across_axes() -> None:
    labels = LABEL_SCHEME.all_static_labels()

    assert len(labels) == len(set(labels))
    assert all(label.startswith("performer:") for label in labels)
    assert set(LABEL_SCHEME.phases) == {
        "queued",
        "implementation",
        "review",
        "rework",
        "done",
        "failed",
        "blocked",
    }
    assert set(LABEL_SCHEME.types) == {
        "gate",
        "evidence",
        "human_action",
        "repository_integration",
    }
    assert set(LABEL_SCHEME.gates) == {
        "pending",
        "passed",
        "pass_with_findings",
        "failed",
    }


def test_label_scheme_does_not_include_legacy_runtime_labels() -> None:
    labels = set(LABEL_SCHEME.all_static_labels())

    assert labels.isdisjoint(LEGACY_LABEL_FIXTURES)
    assert not any(label.startswith("performer:lifecycle/") for label in labels)
    assert not any(label.startswith("performer:dispatch/") for label in labels)
    assert not any(label.startswith("performer:retry/") for label in labels)
    assert not any(label.startswith("performer:error/") for label in labels)
    assert not any(label.startswith("performer:human/") for label in labels)


def test_score_labels_are_dynamic_gate_scores() -> None:
    assert [LABEL_SCHEME.score(i) for i in range(5)] == [
        "performer:score/0/4",
        "performer:score/1/4",
        "performer:score/2/4",
        "performer:score/3/4",
        "performer:score/4/4",
    ]

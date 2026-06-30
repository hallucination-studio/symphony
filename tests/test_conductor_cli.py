from __future__ import annotations

from pathlib import Path

from symphony import conductor_cli


def test_conductor_main_does_not_load_dotenv_from_launch_directory(tmp_path: Path, monkeypatch) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("LINEAR_API_KEY=linear-token\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)

    async def fake_run_server(**_kwargs) -> None:
        import os

        assert "LINEAR_API_KEY" not in os.environ

    monkeypatch.setattr(conductor_cli, "run_server", fake_run_server)

    assert conductor_cli.main([]) == 0

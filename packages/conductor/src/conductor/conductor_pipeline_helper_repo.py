from __future__ import annotations

from .conductor_pipeline_helper_common import *


def _repository_integration_path(repository_path: Path | str) -> str:
    return str(Path(repository_path).resolve(strict=False))

def _safe_path_part(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return safe or "integration"

def _git(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.STDOUT)

def _rollback_repository(repository_path: Path, revision: str) -> None:
    try:
        _git(["reset", "--hard", revision], cwd=repository_path)
        _git(["clean", "-fd"], cwd=repository_path)
    except Exception:
        return

def _repository_head_revision(repository_path: str) -> str:
    path = Path(repository_path) if repository_path else None
    if path is None or not path.exists():
        return ""
    try:
        return _git(["rev-parse", "HEAD"], cwd=path).strip()
    except Exception:
        return ""

def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]

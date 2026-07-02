from __future__ import annotations

from pathlib import Path

from podium.routes import RawResponse

# Map file extensions to Content-Type headers. Anything not listed is served as
# application/octet-stream.
_CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
}


def content_type_for(path: Path) -> str:
    return _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


class StaticFiles:
    """
    Serves built SPA assets from a static root with SPA fallback.

    - Non-API GET requests resolve to a file under ``root``.
    - Requests that don't map to a real file fall back to ``index.html`` so a
      client-side router can handle deep links.
    - Path traversal outside ``root`` is rejected.

    When no ``index.html`` exists under ``root`` the server is considered to
    have no built SPA; callers should preserve legacy behavior in that case.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()

    @property
    def index_path(self) -> Path:
        return self.root / "index.html"

    def has_index(self) -> bool:
        return self.index_path.is_file()

    def _resolve(self, url_path: str) -> Path | None:
        """Resolve a URL path to a real file inside root, or None if unsafe/missing."""
        # Strip leading slashes and normalize. reject empty segments handled by resolve().
        relative = url_path.lstrip("/")
        candidate = (self.root / relative).resolve()
        # Guard against path traversal: resolved path must stay within root.
        if candidate != self.root and self.root not in candidate.parents:
            return None
        if candidate.is_file():
            return candidate
        return None

    def serve(self, url_path: str) -> tuple[int, RawResponse] | None:
        """
        Serve a static file or SPA fallback for a GET request.

        Returns None when there is no built SPA (no index.html) so the caller
        can preserve legacy routing.
        """
        if not self.has_index():
            return None

        if url_path in ("", "/"):
            return self._file_response(self.index_path)

        resolved = self._resolve(url_path)
        if resolved is not None:
            return self._file_response(resolved)

        # SPA fallback: unknown non-API path -> index.html.
        return self._file_response(self.index_path)

    def _file_response(self, path: Path) -> tuple[int, RawResponse]:
        body = path.read_bytes()
        return 200, RawResponse(body=body, content_type=content_type_for(path))

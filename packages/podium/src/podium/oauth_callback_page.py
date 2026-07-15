from __future__ import annotations

CALLBACK_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}

SUCCESS_PAGE = (
    b"<!doctype html><html><head><meta charset=utf-8><title>Podium</title></head>"
    b"<body><p>Authorization complete. Return to Podium.</p></body></html>"
)
DENIED_PAGE = (
    b"<!doctype html><html><head><meta charset=utf-8><title>Podium</title></head>"
    b"<body><p>Authorization was not completed. Return to Podium.</p></body></html>"
)
INVALID_PAGE = (
    b"<!doctype html><html><head><meta charset=utf-8><title>Podium</title></head>"
    b"<body><p>Authorization failed. Return to Podium.</p></body></html>"
)


def callback_response(body: bytes) -> bytes:
    headers = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/html; charset=utf-8",
        *(f"{key}: {value}" for key, value in CALLBACK_HEADERS.items()),
        f"Content-Length: {len(body)}",
        "Connection: close",
        "",
        "",
    ]
    return "\r\n".join(headers).encode("ascii") + body

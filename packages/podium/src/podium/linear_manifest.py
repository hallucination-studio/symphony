from __future__ import annotations

import os

LINEAR_OAUTH_HOST = "127.0.0.1"
LINEAR_OAUTH_PORT = 43821
LINEAR_OAUTH_PATH = "/oauth/linear/callback"
LINEAR_OAUTH_REDIRECT_URI = f"http://{LINEAR_OAUTH_HOST}:{LINEAR_OAUTH_PORT}{LINEAR_OAUTH_PATH}"


def linear_oauth_client_id() -> str:
    client_id = os.environ.get("LINEAR_CLIENT_ID", "").strip()
    if not client_id:
        raise ValueError("linear_client_id_missing")
    return client_id

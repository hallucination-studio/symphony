from __future__ import annotations

import shlex
from typing import Any


def shlex_quote(value: str) -> str:
    return shlex.quote(value)

INSTALL_SCRIPT = r'''#!/usr/bin/env bash
set -euo pipefail

ENROLLMENT_TOKEN="${PODIUM_ENROLLMENT_TOKEN:-}"
ENROLLMENT_RESULT_PATH="${PODIUM_ENROLLMENT_RESULT_PATH:-}"
PODIUM_URL="${PODIUM_URL:-}"
DATA_ROOT="${PODIUM_CONDUCTOR_DATA_ROOT:-${HOME}/.podium-conductor}"
CONDUCTOR_COMMAND="${PODIUM_CONDUCTOR_COMMAND:-conductor}"
CONDUCTOR_PORT="${PODIUM_CONDUCTOR_PORT:-8091}"
START_CONDUCTOR="${PODIUM_START_CONDUCTOR:-1}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enrollment-token)
      ENROLLMENT_TOKEN="${2:-}"
      shift 2
      ;;
    --podium-url)
      PODIUM_URL="${2:-}"
      shift 2
      ;;
    --data-root)
      DATA_ROOT="${2:-}"
      shift 2
      ;;
    --conductor-command)
      CONDUCTOR_COMMAND="${2:-}"
      shift 2
      ;;
    --port)
      CONDUCTOR_PORT="${2:-}"
      shift 2
      ;;
    --no-start)
      START_CONDUCTOR="0"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$ENROLLMENT_TOKEN" ]; then
  echo "--enrollment-token is required" >&2
  exit 2
fi

if [ -z "$PODIUM_URL" ]; then
  if [ -n "${PODIUM_INSTALL_URL:-}" ]; then
    PODIUM_URL="${PODIUM_INSTALL_URL%/}"
  else
    PODIUM_URL="$(python3 - <<'PY'
import os
from urllib.parse import urlsplit, urlunsplit
url = os.environ.get("PODIUM_INSTALL_SOURCE_URL", "")
parts = urlsplit(url)
print(urlunsplit((parts.scheme, parts.netloc, "", "", "")).rstrip("/"))
PY
)"
  fi
fi

if [ -z "$PODIUM_URL" ]; then
  echo "PODIUM_URL is required when the script is not fetched from Podium" >&2
  exit 2
fi

mkdir -p "$DATA_ROOT"

ENROLLED_JSON="$(PODIUM_ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" python3 - "$PODIUM_URL" <<'PY'
import json
import os
import sys
import urllib.request

podium_url = sys.argv[1].rstrip("/")
token = os.environ.get("PODIUM_ENROLLMENT_TOKEN", "")
body = json.dumps({"enrollment_token": token}).encode()
request = urllib.request.Request(
    f"{podium_url}/api/v1/runtime/enroll",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
PY
)"

if [ -n "$ENROLLMENT_RESULT_PATH" ]; then
  umask 077
  printf '%s' "$ENROLLED_JSON" > "$ENROLLMENT_RESULT_PATH"
  chmod 600 "$ENROLLMENT_RESULT_PATH"
fi

RUNTIME_ID="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["runtime_id"])' <<<"$ENROLLED_JSON")"
RUNTIME_TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["runtime_token"])' <<<"$ENROLLED_JSON")"
PROXY_TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["proxy_token"])' <<<"$ENROLLED_JSON")"
if [ "$START_CONDUCTOR" = "1" ]; then
  CONDUCTOR_LOG="/tmp/podium-conductor-${RUNTIME_ID}.log"
  CONDUCTOR_PID="$(python3 - "$CONDUCTOR_COMMAND" "$CONDUCTOR_PORT" "$DATA_ROOT" "$CONDUCTOR_LOG" <<'PY'
import subprocess
import sys

command, port, data_root, log_path = sys.argv[1:]
log = open(log_path, "ab", buffering=0)
process = subprocess.Popen(
    [command, "--port", port, "--data-root", data_root],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
    close_fds=True,
)
print(process.pid)
PY
)"
  for _ in $(seq 1 50); do
    if python3 - "$CONDUCTOR_PORT" <<'PY'
import sys
import urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/", timeout=1)
except Exception:
    raise SystemExit(1)
PY
    then
      break
    fi
    if ! kill -0 "$CONDUCTOR_PID" >/dev/null 2>&1; then
      echo "conductor exited during startup; see /tmp/podium-conductor-${RUNTIME_ID}.log" >&2
      exit 1
    fi
    sleep 0.2
  done
fi

python3 - "$CONDUCTOR_PORT" "$PODIUM_URL" "$RUNTIME_ID" "$RUNTIME_TOKEN" "$PROXY_TOKEN" <<'PY'
import json
import sys
import urllib.request

port, podium_url, runtime_id, runtime_token, proxy_token = sys.argv[1:]
body = json.dumps({
    "podium_url": podium_url.rstrip("/"),
    "podium_runtime_id": runtime_id,
    "podium_runtime_token": runtime_token,
    "podium_proxy_token": proxy_token,
    "managed_mode": True,
}).encode()
request = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/settings",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="PATCH",
)
with urllib.request.urlopen(request, timeout=30) as response:
    response.read()
PY

echo "Podium conductor enrolled as ${RUNTIME_ID}."
echo "Conductor API: http://127.0.0.1:${CONDUCTOR_PORT}"
'''


def render_install_script() -> str:
    return INSTALL_SCRIPT + "    "

from __future__ import annotations

import shlex


def shlex_quote(value: str) -> str:
    return shlex.quote(value)


INSTALL_SCRIPT = r'''#!/usr/bin/env bash
set +x
set -euo pipefail

unset ENROLLMENT_TOKEN ENROLLED_JSON RUNTIME_TOKEN PROXY_TOKEN
ENROLLMENT_TOKEN="${PODIUM_ENROLLMENT_TOKEN:-}"
unset PODIUM_ENROLLMENT_TOKEN PODIUM_RUNTIME_TOKEN PODIUM_PROXY_TOKEN
ENROLLMENT_RESULT_PATH="${PODIUM_ENROLLMENT_RESULT_PATH:-}"
PODIUM_URL="${PODIUM_URL:-}"
DATA_ROOT="${PODIUM_CONDUCTOR_DATA_ROOT:-}"
CONDUCTOR_COMMAND="${PODIUM_CONDUCTOR_COMMAND:-conductor}"
CONDUCTOR_PORT="${PODIUM_CONDUCTOR_PORT-}"
CONDUCTOR_PORT_EXPLICIT="0"
if [ "${PODIUM_CONDUCTOR_PORT+x}" = "x" ]; then
  CONDUCTOR_PORT_EXPLICIT="1"
fi
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
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "Conductor data root must not be empty" >&2
        exit 2
      fi
      DATA_ROOT="$2"
      shift 2
      ;;
    --conductor-command)
      CONDUCTOR_COMMAND="${2:-}"
      shift 2
      ;;
    --port)
      if [ "$#" -lt 2 ]; then
        echo "Conductor port must be an integer between 1 and 65535" >&2
        exit 2
      fi
      CONDUCTOR_PORT="$2"
      CONDUCTOR_PORT_EXPLICIT="1"
      shift 2
      ;;
    --no-start)
      START_CONDUCTOR="0"
      shift
      ;;
    *)
      echo "Unknown installer option" >&2
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

CONDUCTOR_PORT="$(python3 - "$CONDUCTOR_PORT" "$CONDUCTOR_PORT_EXPLICIT" "$START_CONDUCTOR" <<'PY'
import socket
import sys

raw_port, explicit_port, start_conductor = sys.argv[1:]
if explicit_port == "1":
    if not raw_port:
        print("Conductor port must be an integer between 1 and 65535", file=sys.stderr)
        raise SystemExit(2)
    try:
        port = int(raw_port)
    except ValueError:
        print("Conductor port must be an integer between 1 and 65535", file=sys.stderr)
        raise SystemExit(2)
    if not 1 <= port <= 65535:
        print("Conductor port must be an integer between 1 and 65535", file=sys.stderr)
        raise SystemExit(2)
else:
    port = 0 if start_conductor == "1" else 8091

if start_conductor == "1":
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
            candidate.bind(("127.0.0.1", port))
            port = candidate.getsockname()[1]
    except OSError:
        if raw_port:
            print(f"Conductor port {port} is unavailable", file=sys.stderr)
        else:
            print("Could not choose an available Conductor port", file=sys.stderr)
        raise SystemExit(2)

print(port)
PY
)"

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
if [ -z "$DATA_ROOT" ]; then
  DATA_ROOT="${HOME}/.podium-conductors/${RUNTIME_ID}"
fi
mkdir -p "$DATA_ROOT"
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

PODIUM_RUNTIME_TOKEN="$RUNTIME_TOKEN" PODIUM_PROXY_TOKEN="$PROXY_TOKEN" \
python3 - "$CONDUCTOR_PORT" "$PODIUM_URL" "$RUNTIME_ID" <<'PY'
import json
import os
import sys
import urllib.request

port, podium_url, runtime_id = sys.argv[1:]
body = json.dumps({
    "podium_url": podium_url.rstrip("/"),
    "podium_runtime_id": runtime_id,
    "podium_runtime_token": os.environ["PODIUM_RUNTIME_TOKEN"],
    "podium_proxy_token": os.environ["PODIUM_PROXY_TOKEN"],
    "managed_mode": True,
    "conductor_id": runtime_id,
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
unset ENROLLMENT_TOKEN ENROLLED_JSON RUNTIME_TOKEN PROXY_TOKEN

echo "Podium conductor enrolled as ${RUNTIME_ID}."
echo "Conductor API: http://127.0.0.1:${CONDUCTOR_PORT}"
'''


def render_install_script() -> str:
    return INSTALL_SCRIPT + "    "

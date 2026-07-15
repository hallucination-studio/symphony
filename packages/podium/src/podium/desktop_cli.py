from __future__ import annotations

import sys
from typing import BinaryIO

from .desktop_app import DesktopLifecycle, default_data_root
from .desktop_health import handle_request
from .desktop_protocol import ProtocolError, encode_frame, read_frame


def run_desktop_protocol(
    *,
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: BinaryIO,
    lifecycle: DesktopLifecycle | None = None,
) -> int:
    exit_code = 0
    try:
        while True:
            request = read_frame(stdin)
            if request is None:
                break
            response, stopping = handle_request(request, lifecycle)
            stdout.write(encode_frame(response))
            stdout.flush()
            if stopping:
                break
    except ProtocolError as exc:
        stderr.write(f"event=podium_desktop_protocol_failed error_code={exc}\n".encode())
        stderr.flush()
        exit_code = 2
    except RuntimeError:
        stderr.write(
            b"event=podium_desktop_lifecycle_failed error_type=lifecycle "
            b"error_code=podium_desktop_shutdown_failed sanitized_reason=shutdown_failed "
            b"action_required=true retryable=false next_action=restart_desktop\n"
        )
        stderr.flush()
        exit_code = 3
    except OSError:
        stderr.write(
            b"event=podium_desktop_protocol_failed error_type=io "
            b"error_code=desktop_protocol_io_failed sanitized_reason=protocol_io_failed "
            b"action_required=true retryable=false next_action=restart_desktop\n"
        )
        stderr.flush()
        exit_code = 2
    finally:
        if lifecycle is not None and lifecycle.needs_shutdown:
            try:
                lifecycle.shutdown()
            except RuntimeError:
                exit_code = 3
    return exit_code


def main() -> int:
    lifecycle = DesktopLifecycle(default_data_root())
    lifecycle.start()
    return run_desktop_protocol(
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
        lifecycle=lifecycle,
    )


if __name__ == "__main__":
    raise SystemExit(main())

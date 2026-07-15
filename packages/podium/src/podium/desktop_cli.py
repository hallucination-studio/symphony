from __future__ import annotations

import sys
from typing import BinaryIO

from .desktop_health import handle_request
from .desktop_protocol import ProtocolError, encode_frame, read_frame


def run_desktop_protocol(*, stdin: BinaryIO, stdout: BinaryIO, stderr: BinaryIO) -> int:
    try:
        while True:
            request = read_frame(stdin)
            if request is None:
                return 0
            response, stopping = handle_request(request)
            stdout.write(encode_frame(response))
            stdout.flush()
            if stopping:
                return 0
    except ProtocolError as exc:
        stderr.write(f"event=podium_desktop_protocol_failed error_code={exc}\n".encode())
        stderr.flush()
        return 2


def main() -> int:
    return run_desktop_protocol(
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
    )


if __name__ == "__main__":
    raise SystemExit(main())

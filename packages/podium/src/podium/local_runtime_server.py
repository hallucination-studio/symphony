from __future__ import annotations

import logging
import os
from uuid import uuid4

from performer_api import LocalRuntimeEnvelope

from .local_sessions import (
    LocalSessionIdentity,
    LocalSessionRecord,
    LocalSessionRegistry,
    PodiumLocalSession,
)

LOGGER = logging.getLogger(__name__)


class LocalRuntimeServer:
    def __init__(self, registry: LocalSessionRegistry) -> None:
        self.registry = registry

    def open(self, identity: LocalSessionIdentity) -> tuple[LocalSessionRecord, int]:
        if self.registry.active_for_binding(identity.binding_id) is not None:
            raise ValueError("local_runtime_duplicate_binding")
        session_id = str(uuid4())
        expected = LocalRuntimeEnvelope(
            1,
            identity.instance_id,
            identity.project_id,
            identity.binding_generation,
            session_id,
            "handshake",
        )
        session, child_fd = PodiumLocalSession.create(expected)
        try:
            record = self.registry.register(identity, session, session_id=session_id)
            return record, child_fd
        except Exception:
            session.close()
            os.close(child_fd)
            raise

    def accept(
        self,
        session_id: str,
        *,
        peer_pid: int,
        binding_generation: int | None = None,
    ) -> LocalSessionRecord:
        record = self.registry.get(session_id)
        if record.state == "online":
            raise ValueError("local_runtime_duplicate_connect")
        if record.state != "pending":
            raise ValueError(f"local_runtime_session_{record.state}")
        try:
            if peer_pid != record.identity.expected_pid:
                raise ValueError("local_runtime_wrong_process")
            if (
                binding_generation is not None
                and binding_generation != record.identity.binding_generation
            ):
                raise ValueError("local_runtime_stale_generation")
            record.session.accept()
        except Exception:
            record.session.close()
            record.state = "closed"
            LOGGER.warning(
                "event=podium_local_session_rejected conductor_id=%s instance_id=%s "
                "project_id=%s binding_id=%s binding_generation=%s "
                "sanitized_reason=peer_identity_rejected retryable=false "
                "next_action=restart_conductor",
                record.identity.conductor_id,
                record.identity.instance_id,
                record.identity.project_id,
                record.identity.binding_id,
                record.identity.binding_generation,
            )
            raise
        record.state = "online"
        LOGGER.info(
            "event=podium_local_session_accepted conductor_id=%s instance_id=%s "
            "project_id=%s binding_id=%s binding_generation=%s retryable=false "
            "next_action=none",
            record.identity.conductor_id,
            record.identity.instance_id,
            record.identity.project_id,
            record.identity.binding_id,
            record.identity.binding_generation,
        )
        return record

    def process_exited(self, expected_pid: int) -> LocalSessionRecord:
        record = self.registry.process_exited(expected_pid)
        LOGGER.info(
            "event=podium_local_session_offline conductor_id=%s instance_id=%s "
            "project_id=%s binding_id=%s binding_generation=%s retryable=true "
            "next_action=restart_conductor",
            record.identity.conductor_id,
            record.identity.instance_id,
            record.identity.project_id,
            record.identity.binding_id,
            record.identity.binding_generation,
        )
        return record

    def close_all(self) -> None:
        self.registry.close_all()

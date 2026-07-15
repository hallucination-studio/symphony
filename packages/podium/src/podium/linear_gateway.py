from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from .linear_graphql_client import LinearGraphQLRequestError, execute_linear_graphql
from .linear_queries import LINEAR_QUERIES, PROJECTS_PAGE
from .linear_tokens import LinearTokenFailure
from .linear_validation import validate_projects_response, validate_projects_variables

LOGGER = logging.getLogger(__name__)
_CORRELATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")

AccessToken = Callable[[str], Awaitable[str]]
Transport = Callable[..., Awaitable[dict[str, Any]]]


class LinearGatewayFailure(RuntimeError):
    def __init__(self, code: str, correlation_id: str, *, retryable: bool) -> None:
        super().__init__(code)
        self.code = code
        self.correlation_id = correlation_id
        self.retryable = retryable

    def to_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "correlation_id": self.correlation_id,
            "sanitized_reason": self.code,
            "retryable": self.retryable,
        }


class LinearGateway:
    def __init__(
        self,
        access_token: AccessToken,
        *,
        transport: Transport = execute_linear_graphql,
    ) -> None:
        self.access_token = access_token
        self.transport = transport

    async def execute(
        self,
        installation_id: str,
        operation: str,
        variables: object,
        *,
        correlation_id: str,
    ) -> dict[str, Any]:
        self._validate_envelope(installation_id, operation, correlation_id)
        if operation != PROJECTS_PAGE:
            self._fail("linear_gateway_operation_denied", correlation_id, False)
        try:
            validated_variables = validate_projects_variables(variables)
        except ValueError:
            self._fail("linear_gateway_request_invalid", correlation_id, False)
        query = LINEAR_QUERIES[operation]
        try:
            token = await self.access_token(installation_id)
            if not isinstance(token, str) or not token:
                self._fail(
                    "linear_gateway_authorization_failed", correlation_id, False
                )
            data = await self.transport(
                access_token=token,
                query=query.document,
                variables=validated_variables,
                operation_name=query.operation_name,
            )
        except LinearGatewayFailure:
            raise
        except LinearTokenFailure as error:
            transient = error.code in {
                "linear_token_refresh_failed",
                "linear_identity_verification_failed",
            }
            self._fail(
                "linear_gateway_upstream_failed"
                if transient
                else "linear_gateway_authorization_failed",
                correlation_id,
                transient,
            )
        except LinearGraphQLRequestError as error:
            code = (
                "linear_gateway_authorization_failed"
                if error.status_code == 401
                else "linear_gateway_upstream_failed"
            )
            self._fail(code, correlation_id, error.retryable)
        except Exception:
            self._fail("linear_gateway_upstream_failed", correlation_id, True)
        try:
            return validate_projects_response(data, first=validated_variables["first"])
        except ValueError:
            self._fail("linear_gateway_response_invalid", correlation_id, False)

    def _validate_envelope(
        self, installation_id: str, operation: object, correlation_id: str
    ) -> None:
        if (
            not isinstance(correlation_id, str)
            or _CORRELATION_ID.fullmatch(correlation_id) is None
        ):
            self._fail("linear_gateway_envelope_invalid", "invalid", False)
        if (
            not isinstance(installation_id, str)
            or _CORRELATION_ID.fullmatch(installation_id) is None
            or not isinstance(operation, str)
        ):
            self._fail("linear_gateway_envelope_invalid", correlation_id, False)

    def _fail(self, code: str, correlation_id: str, retryable: bool) -> None:
        LOGGER.warning(
            "event=linear_gateway_failed correlation_id=%s error_type=linear_gateway "
            "error_code=%s sanitized_reason=%s action_required=%s retryable=%s "
            "next_action=%s",
            correlation_id,
            code,
            code,
            str(not retryable).lower(),
            str(retryable).lower(),
            "retry_gateway" if retryable else "inspect_linear_connection",
        )
        raise LinearGatewayFailure(code, correlation_id, retryable=retryable)

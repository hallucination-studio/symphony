from __future__ import annotations

import inspect
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx
from argon2 import PasswordHasher
from fastapi import FastAPI, Header, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse


TurnstileVerifier = Callable[[str, str | None], bool]


def create_app(
    *,
    turnstile_verifier: TurnstileVerifier | None = None,
    secure_cookies: bool = True,
    session_cookie_name: str = "podium_session",
    linear_webhook_secret: str = "",
) -> FastAPI:
    state = ManagedPodiumState(
        turnstile_verifier=turnstile_verifier or verify_turnstile_with_cloudflare,
        session_cookie_name=session_cookie_name,
        secure_cookies=secure_cookies,
        linear_webhook_secret=linear_webhook_secret,
    )
    app = FastAPI(title="Symphony Podium")
    app.state.podium = state

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": "Podium"}

    @app.get("/api/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/auth/register")
    async def register(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        if "@" not in email or len(password) < 8:
            return error_response(400, "invalid_credentials", "A valid email and password are required")
        if email in state.user_ids_by_email:
            return error_response(400, "email_already_registered", "Email is already registered")
        user_id = f"user_{len(state.users) + 1}"
        state.users[user_id] = {
            "id": user_id,
            "email": email,
            "password_hash": state.password_hasher.hash(password),
            "created_at": utc_now_iso(),
        }
        state.user_ids_by_email[email] = user_id
        session_token = state.create_session(user_id)
        json_response = JSONResponse({"user": public_user(state.users[user_id])})
        state.set_session_cookie(json_response, session_token)
        return json_response

    @app.post("/api/v1/auth/login")
    async def login(request: Request) -> JSONResponse:
        payload = await request.json()
        email = str(payload.get("email") or "").strip().lower()
        password = str(payload.get("password") or "")
        turnstile_token = str(payload.get("turnstile_token") or "")
        if not await state.verify_turnstile(turnstile_token, request.client.host if request.client else None):
            return error_response(400, "invalid_turnstile", "Turnstile verification failed")
        user = state.user_by_email(email)
        if user is None:
            return error_response(401, "invalid_login", "Invalid email or password")
        try:
            ok = state.password_hasher.verify(str(user["password_hash"]), password)
        except Exception:
            ok = False
        if not ok:
            return error_response(401, "invalid_login", "Invalid email or password")
        session_token = state.create_session(str(user["id"]))
        json_response = JSONResponse({"user": public_user(user)})
        state.set_session_cookie(json_response, session_token)
        return json_response

    @app.post("/api/v1/auth/logout")
    async def logout(request: Request, response: Response) -> dict[str, str]:
        podium_session = request.cookies.get(state.session_cookie_name)
        if podium_session:
            state.revoke_session(podium_session)
        response.delete_cookie(state.session_cookie_name)
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    async def me(request: Request) -> JSONResponse:
        podium_session = request.cookies.get(state.session_cookie_name)
        user = state.user_for_session(podium_session or "")
        if user is None:
            return error_response(401, "unauthorized", "Unauthorized")
        return JSONResponse({"user": public_user(user)})

    @app.post("/api/v1/runtime/enrollment-tokens")
    async def create_enrollment_token(request: Request) -> dict[str, str]:
        payload = await request.json()
        token = secrets.token_urlsafe(32)
        token_hash = hash_secret(token)
        runtime_group_id = str(payload.get("runtime_group_id") or f"group_{len(state.runtime_groups) + 1}")
        linear_workspace_id = str(payload.get("linear_workspace_id") or "")
        project_slug = str(payload.get("project_slug") or "")
        state.runtime_groups.setdefault(
            runtime_group_id,
            {
                "id": runtime_group_id,
                "linear_workspace_id": linear_workspace_id,
                "project_slug": project_slug,
                "workflow_profile": str(payload.get("workflow_profile") or "task"),
            },
        )
        state.enrollment_tokens[token_hash] = {
            "runtime_group_id": runtime_group_id,
            "used": False,
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        }
        return {"enrollment_token": token, "runtime_group_id": runtime_group_id}

    @app.post("/api/v1/conductors/register")
    async def legacy_conductor_register(request: Request) -> dict[str, Any]:
        payload = await request.json()
        conductor_id = str(payload.get("conductor_id") or "")
        return {
            "status": "accepted",
            "message": "accepted",
            "conductor_id": conductor_id,
        }

    @app.post("/api/v1/runtime/enroll")
    async def enroll_runtime(request: Request) -> JSONResponse:
        payload = await request.json()
        enrollment_token = str(payload.get("enrollment_token") or "")
        token_row = state.enrollment_tokens.get(hash_secret(enrollment_token))
        if token_row is None:
            return error_response(400, "invalid_enrollment_token", "Enrollment token is invalid")
        if token_row["used"]:
            return error_response(400, "enrollment_token_used", "Enrollment token has already been used")
        if token_row["expires_at"] < datetime.now(timezone.utc):
            return error_response(400, "enrollment_token_expired", "Enrollment token has expired")
        runtime_id = f"runtime_{len(state.runtimes) + 1}"
        runtime_token = secrets.token_urlsafe(32)
        proxy_token = secrets.token_urlsafe(32)
        runtime_group_id = str(token_row["runtime_group_id"])
        state.runtimes[runtime_id] = {
            "id": runtime_id,
            "runtime_group_id": runtime_group_id,
            "runtime_token_hash": hash_secret(runtime_token),
            "proxy_token_hash": hash_secret(proxy_token),
            "disabled": False,
            "revoked": False,
            "created_at": utc_now_iso(),
        }
        token_row["used"] = True
        websocket_url = str(request.base_url).rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
        return JSONResponse(
            {
                "runtime_id": runtime_id,
                "runtime_token": runtime_token,
                "proxy_token": proxy_token,
                "runtime_group_id": runtime_group_id,
                "websocket_url": f"{websocket_url}/api/v1/runtime/ws",
            }
        )

    @app.post("/api/v1/linear/webhooks/agent-session")
    async def linear_agent_session(request: Request, linear_signature: str | None = Header(default=None)) -> JSONResponse:
        raw = await request.body()
        if state.linear_webhook_secret:
            expected = hmac.new(state.linear_webhook_secret.encode(), raw, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(linear_signature or "", expected):
                return error_response(401, "invalid_signature", "Invalid Linear webhook signature")
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return error_response(400, "invalid_json", "Request body must be valid JSON")
        if payload.get("type") != "AgentSessionEvent":
            return JSONResponse({"status": "ignored", "queued": 0})
        event = normalize_agent_session_event(payload)
        queued = state.queue_dispatches(event)
        return JSONResponse({"status": "accepted", "queued": queued})

    @app.post("/api/v1/runtime/dispatches/lease")
    async def lease_dispatch(authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        dispatch = state.lease_dispatch(str(runtime["id"]))
        if dispatch is None:
            return JSONResponse({"dispatch": None})
        return JSONResponse({"dispatch": dispatch_public(dispatch)})

    @app.post("/api/v1/runtime/dispatches/ack")
    async def ack_dispatch(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = state.runtime_for_bearer(authorization or "")
        if runtime is None:
            return error_response(401, "unauthorized", "Unauthorized")
        payload = await request.json()
        dispatch = state.ack_dispatch(str(runtime["id"]), str(payload.get("dispatch_id") or ""), str(payload.get("status") or "accepted"))
        if dispatch is None:
            return error_response(404, "dispatch_not_found", "Dispatch not found")
        return JSONResponse({"dispatch": dispatch_public(dispatch)})

    @app.websocket("/api/v1/runtime/ws")
    async def runtime_ws(websocket: WebSocket) -> None:
        runtime = state.runtime_for_bearer(websocket.headers.get("authorization") or "")
        if runtime is None:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        runtime_id = str(runtime["id"])
        state.presence[runtime_id] = utc_now_iso()
        try:
            while True:
                message = await websocket.receive_json()
                kind = str(message.get("type") or "")
                if kind in {"hello", "heartbeat"}:
                    state.presence[runtime_id] = utc_now_iso()
                    await websocket.send_json({"type": "ping"})
                elif kind == "dispatch.ack":
                    dispatch = state.ack_dispatch(runtime_id, str(message.get("dispatch_id") or ""), str(message.get("status") or "accepted"))
                    await websocket.send_json({"type": "dispatch.ack.ok", "dispatch": dispatch_public(dispatch) if dispatch else None})
                else:
                    await websocket.send_json({"type": "error", "code": "unsupported_message"})
        except WebSocketDisconnect:
            state.presence.pop(runtime_id, None)

    @app.post("/api/v1/linear/graphql")
    async def linear_graphql(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        runtime = state.runtime_for_proxy_bearer(authorization or "")
        if runtime is None:
            state.proxy_audit.append({"allowed": False, "reason": "unauthorized", "timestamp": utc_now_iso()})
            return error_response(401, "unauthorized", "Unauthorized")
        if runtime.get("disabled") or runtime.get("revoked"):
            state.proxy_audit.append({"runtime_id": runtime["id"], "allowed": False, "reason": "runtime_disabled", "timestamp": utc_now_iso()})
            return error_response(401, "runtime_disabled", "Runtime is disabled")
        payload = await request.json()
        state.proxy_audit.append(
            {
                "runtime_id": runtime["id"],
                "allowed": True,
                "operation_name": payload.get("operationName"),
                "timestamp": utc_now_iso(),
            }
        )
        return JSONResponse({"data": {}})

    return app


@dataclass
class ManagedPodiumState:
    turnstile_verifier: TurnstileVerifier
    session_cookie_name: str
    secure_cookies: bool
    linear_webhook_secret: str = ""
    password_hasher: PasswordHasher = field(default_factory=PasswordHasher)
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    user_ids_by_email: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtime_groups: dict[str, dict[str, Any]] = field(default_factory=dict)
    enrollment_tokens: dict[str, dict[str, Any]] = field(default_factory=dict)
    runtimes: dict[str, dict[str, Any]] = field(default_factory=dict)
    dispatches: dict[str, dict[str, Any]] = field(default_factory=dict)
    presence: dict[str, str] = field(default_factory=dict)
    proxy_audit: list[dict[str, Any]] = field(default_factory=list)

    async def verify_turnstile(self, token: str, ip: str | None) -> bool:
        if not token:
            return False
        result = self.turnstile_verifier(token, ip)
        if inspect.isawaitable(result):
            result = await result
        return bool(result)

    def user_by_email(self, email: str) -> dict[str, Any] | None:
        user_id = self.user_ids_by_email.get(email)
        return self.users.get(user_id or "")

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        self.sessions[hash_secret(token)] = {
            "user_id": user_id,
            "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
            "revoked": False,
        }
        return token

    def revoke_session(self, token: str) -> None:
        row = self.sessions.get(hash_secret(token))
        if row is not None:
            row["revoked"] = True

    def user_for_session(self, token: str) -> dict[str, Any] | None:
        row = self.sessions.get(hash_secret(token))
        if row is None or row.get("revoked") or row["expires_at"] < datetime.now(timezone.utc):
            return None
        return self.users.get(str(row["user_id"]))

    def set_session_cookie(self, response: Response, token: str) -> None:
        response.set_cookie(
            self.session_cookie_name,
            token,
            httponly=True,
            secure=self.secure_cookies,
            samesite="lax",
            max_age=30 * 24 * 3600,
        )

    def runtime_for_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["runtime_token_hash"]), token_hash):
                return runtime
        return None

    def runtime_for_proxy_bearer(self, authorization: str) -> dict[str, Any] | None:
        token = bearer_token(authorization)
        if not token:
            return None
        token_hash = hash_secret(token)
        for runtime in self.runtimes.values():
            if hmac.compare_digest(str(runtime["proxy_token_hash"]), token_hash):
                return runtime
        return None

    def queue_dispatches(self, event: dict[str, Any]) -> int:
        queued = 0
        for group in self.runtime_groups.values():
            if group.get("linear_workspace_id") and group.get("linear_workspace_id") != event.get("workspace_id"):
                continue
            if group.get("project_slug") and group.get("project_slug") != event.get("project_slug"):
                continue
            dispatch_id = f"dispatch_{len(self.dispatches) + 1}"
            self.dispatches[dispatch_id] = {
                "dispatch_id": dispatch_id,
                "runtime_group_id": group["id"],
                "issue_id": event["issue_id"],
                "issue_identifier": event["issue_identifier"],
                "linear_workspace_id": event["workspace_id"],
                "project_slug": event["project_slug"],
                "routing_rule_id": group["id"],
                "workflow_profile": group.get("workflow_profile") or "task",
                "status": "queued",
                "leased_runtime_id": None,
                "leased_until": None,
                "created_at": utc_now_iso(),
            }
            queued += 1
        return queued

    def lease_dispatch(self, runtime_id: str) -> dict[str, Any] | None:
        runtime = self.runtimes[runtime_id]
        now = datetime.now(timezone.utc)
        for dispatch in self.dispatches.values():
            if dispatch["runtime_group_id"] != runtime["runtime_group_id"]:
                continue
            leased_until = dispatch.get("leased_until")
            retryable = isinstance(leased_until, datetime) and leased_until < now
            if dispatch["status"] not in {"queued", "leased"}:
                continue
            if dispatch["status"] == "leased" and not retryable:
                continue
            dispatch["status"] = "leased"
            dispatch["leased_runtime_id"] = runtime_id
            dispatch["leased_until"] = now + timedelta(minutes=5)
            return dispatch
        return None

    def ack_dispatch(self, runtime_id: str, dispatch_id: str, status: str) -> dict[str, Any] | None:
        dispatch = self.dispatches.get(dispatch_id)
        if dispatch is None or dispatch.get("leased_runtime_id") != runtime_id:
            return None
        dispatch["status"] = status
        return dispatch


async def verify_turnstile_with_cloudflare(token: str, ip: str | None) -> bool:
    secret = os.environ.get("CLOUDFLARE_TURNSTILE_SECRET_KEY", "").strip()
    if not secret:
        return False
    data = {"secret": secret, "response": token}
    if ip:
        data["remoteip"] = ip
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        response = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=data)
    try:
        payload = response.json()
    except json.JSONDecodeError:
        return False
    return bool(payload.get("success"))


def public_user(user: dict[str, Any]) -> dict[str, str]:
    return {"id": str(user["id"]), "email": str(user["email"])}


def dispatch_public(dispatch: dict[str, Any]) -> dict[str, Any]:
    return {
        "dispatch_id": dispatch["dispatch_id"],
        "issue_id": dispatch["issue_id"],
        "issue_identifier": dispatch["issue_identifier"],
        "linear_workspace_id": dispatch["linear_workspace_id"],
        "project_slug": dispatch["project_slug"],
        "routing_rule_id": dispatch["routing_rule_id"],
        "workflow_profile": dispatch["workflow_profile"],
        "status": dispatch["status"],
    }


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def bearer_token(authorization: str) -> str:
    return authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else authorization.strip()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_agent_session_event(payload: dict[str, Any]) -> dict[str, str]:
    session = payload.get("agentSession") if isinstance(payload.get("agentSession"), dict) else {}
    issue = session.get("issue") if isinstance(session.get("issue"), dict) else {}
    project = issue.get("project") if isinstance(issue.get("project"), dict) else {}
    assignee = issue.get("assignee") if isinstance(issue.get("assignee"), dict) else {}
    agent = session.get("agent") if isinstance(session.get("agent"), dict) else {}
    agent_user = agent.get("user") if isinstance(agent.get("user"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    return {
        "workspace_id": str(workspace.get("id") or payload.get("workspace_id") or ""),
        "project_slug": str(project.get("slugId") or payload.get("project_slug") or ""),
        "issue_id": str(issue.get("id") or payload.get("issue_id") or ""),
        "issue_identifier": str(issue.get("identifier") or payload.get("issue_identifier") or ""),
        "agent_session_id": str(session.get("id") or payload.get("agent_session_id") or ""),
        "assignee_id": str(
            assignee.get("id")
            or agent_user.get("id")
            or agent.get("userId")
            or session.get("agentUserId")
            or payload.get("assignee_id")
            or ""
        ),
    }

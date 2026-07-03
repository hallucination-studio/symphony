from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from cryptography.fernet import Fernet

from podium.models import LinearAppConfig, Session, User
from podium.store import PodiumStore


class AuthError(Exception):
    """Raised on authentication/registration failures.

    Carries a machine-readable ``code`` alongside the human-readable message so
    routes can translate to a stable API error contract.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


class AuthService:
    """Registration, login, sessions, and custom-app secret encryption.

    Passwords are hashed with argon2. Custom Linear app secrets are encrypted
    with Fernet using a key deterministically derived from ``secret_key``. An
    empty/blank ``secret_key`` raises ``RuntimeError`` at construction rather
    than allowing a half-configured state where sessions work but secrets
    cannot be handled.
    """

    def __init__(
        self,
        store: PodiumStore,
        secret_key: str,
        *,
        session_ttl: timedelta = timedelta(days=30),
    ):
        self.store = store
        self._secret_key = secret_key or ""
        if not self._secret_key.strip():
            raise RuntimeError(
                "PODIUM_SECRET_KEY is required and must not be empty; refusing to "
                "construct AuthService in a half-configured state"
            )
        self.session_ttl = session_ttl
        self._hasher = PasswordHasher()
        fernet_key = base64.urlsafe_b64encode(
            hashlib.sha256(self._secret_key.encode()).digest()
        )
        self._fernet: Fernet = Fernet(fernet_key)

    # ===== Registration / login =====

    def register(self, email: str, password: str) -> User:
        email = (email or "").strip()
        if not email:
            raise AuthError("invalid_email", "Email is required")
        if not password or len(password) < 8:
            raise AuthError("invalid_password", "Password must be at least 8 characters")
        if self.store.get_user_by_email(email.lower()) is not None:
            raise AuthError("email_taken", "An account with this email already exists")

        user = User(
            user_id=f"usr_{secrets.token_hex(16)}",
            email=email,
            password_hash=self._hasher.hash(password),
            workspace_id=f"ws_{secrets.token_hex(16)}",
            created_at=_iso(_now()),
            linear_app=None,
        )
        self.store.save_user(user)
        return user

    def authenticate(self, email: str, password: str) -> User:
        email = (email or "").strip()
        user = self.store.get_user_by_email(email.lower()) if email else None
        # Anti-enumeration: identical failure for unknown user or bad password.
        invalid = AuthError("invalid_credentials", "Invalid email or password")
        if user is None:
            # Still spend time hashing to reduce timing side-channel.
            try:
                self._hasher.hash(password or "")
            except Exception:
                pass
            raise invalid
        try:
            self._hasher.verify(user.password_hash, password or "")
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            raise invalid
        return user

    # ===== Sessions =====

    def create_session(self, user: User) -> Session:
        now = _now()
        session = Session(
            session_id=f"sess_{secrets.token_hex(24)}",
            user_id=user.user_id,
            created_at=_iso(now),
            expires_at=_iso(now + self.session_ttl),
        )
        self.store.save_session(session)
        return session

    def session_user(self, session_id: str) -> User | None:
        if not session_id:
            return None
        session = self.store.get_session(session_id)
        if session is None:
            return None
        try:
            expires_at = datetime.fromisoformat(session.expires_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            self.store.delete_session(session_id)
            return None
        if expires_at < _now():
            self.store.delete_session(session_id)
            return None
        return self.store.get_user(session.user_id)

    def delete_session(self, session_id: str) -> None:
        if session_id:
            self.store.delete_session(session_id)

    # ===== Secret encryption =====

    def encrypt_secret(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt_secret(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode()).decode()

    # ===== Custom Linear app =====

    def set_linear_app(
        self,
        user: User,
        client_id: str,
        client_secret: str,
        redirect_uri: str | None,
    ) -> User:
        config = LinearAppConfig(
            client_id=client_id,
            client_secret_encrypted=self.encrypt_secret(client_secret),
            redirect_uri=redirect_uri or None,
        )
        updated = User(
            user_id=user.user_id,
            email=user.email,
            password_hash=user.password_hash,
            workspace_id=user.workspace_id,
            created_at=user.created_at,
            linear_app=config,
        )
        self.store.save_user(updated)
        return updated

    def clear_linear_app(self, user: User) -> User:
        updated = User(
            user_id=user.user_id,
            email=user.email,
            password_hash=user.password_hash,
            workspace_id=user.workspace_id,
            created_at=user.created_at,
            linear_app=None,
        )
        self.store.save_user(updated)
        return updated

from __future__ import annotations

import base64
import hashlib
from datetime import timedelta

from cryptography.fernet import Fernet

from .store import PodiumStore


class AuthService:
    def __init__(self, store: PodiumStore, secret_key: str) -> None:
        if not secret_key or not secret_key.strip():
            raise ValueError("secret_key is required")
        self.store = store
        self.secret_key = secret_key
        self.session_ttl = timedelta(days=30)

    def _fernet(self) -> Fernet:
        key = base64.urlsafe_b64encode(hashlib.sha256(self.secret_key.encode()).digest())
        return Fernet(key)

    def encrypt_secret(self, plaintext: str) -> str:
        return self._fernet().encrypt(plaintext.encode()).decode()

    def decrypt_secret(self, ciphertext: str) -> str:
        return self._fernet().decrypt(ciphertext.encode()).decode()

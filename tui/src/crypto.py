"""
AES-256-GCM encryption module for SugarVault (Python).

Compatible with the TypeScript implementation in workers/vault/src/crypto.ts.
Uses scrypt for key derivation and AES-256-GCM for authenticated encryption.

Cross-language compatibility: encrypt in Python, decrypt in TypeScript and vice versa.
The scheme is identical: scrypt(password, salt, 32, {N:16384, r:8, p:1}) → AES-256-GCM key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


SCRYPT_KEYLEN = 32       # 256 bits for AES-256
SALT_BYTES = 16
IV_BYTES = 12            # GCM standard nonce size
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1


@dataclass(frozen=True)
class EncryptedPayload:
    """Mirrors the TypeScript EncryptedPayload interface."""
    salt: bytes       # 16 bytes
    iv: bytes         # 12 bytes
    auth_tag: bytes   # 16 bytes
    ciphertext: bytes


def derive_key(master_password: str, salt: bytes) -> bytes:
    """Derive a 256-bit key from a master password and salt using scrypt."""
    if not master_password:
        raise ValueError("master_password must not be empty")
    if not isinstance(salt, bytes) or len(salt) != SALT_BYTES:
        raise ValueError(f"salt must be {SALT_BYTES} bytes")

    kdf = Scrypt(
        salt=salt,
        length=SCRYPT_KEYLEN,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
    )
    return kdf.derive(master_password.encode("utf-8"))


def encrypt(plaintext: str, master_password: str) -> EncryptedPayload:
    """
    Encrypt plaintext with AES-256-GCM using a master password.
    Generates a random salt and IV for each encryption, ensuring
    identical plaintexts produce different ciphertexts.
    """
    if not isinstance(plaintext, str):
        raise TypeError("plaintext must be a string")
    if not master_password:
        raise ValueError("master_password must not be empty")

    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    key = derive_key(master_password, salt)

    aesgcm = AESGCM(key)
    # AESGCM.encrypt returns ciphertext || auth_tag (16 bytes appended)
    ct_and_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)

    # Split: last 16 bytes are the auth tag
    ciphertext = ct_and_tag[:-16]
    auth_tag = ct_and_tag[-16:]

    return EncryptedPayload(salt=salt, iv=iv, auth_tag=auth_tag, ciphertext=ciphertext)


def decrypt(payload: EncryptedPayload, master_password: str) -> str:
    """
    Decrypt an AES-256-GCM encrypted payload using the master password.
    Raises if the password is wrong or the ciphertext has been tampered with.
    """
    if not isinstance(payload, EncryptedPayload):
        raise TypeError("payload must be an EncryptedPayload")
    if not isinstance(payload.salt, bytes) or len(payload.salt) != SALT_BYTES:
        raise ValueError(f"payload.salt must be {SALT_BYTES} bytes")
    if not isinstance(payload.iv, bytes) or len(payload.iv) != IV_BYTES:
        raise ValueError(f"payload.iv must be {IV_BYTES} bytes")
    if not isinstance(payload.auth_tag, bytes) or len(payload.auth_tag) != 16:
        raise ValueError("payload.auth_tag must be 16 bytes")
    if not isinstance(payload.ciphertext, bytes):
        raise TypeError("payload.ciphertext must be bytes")
    if not master_password:
        raise ValueError("master_password must not be empty")

    key = derive_key(master_password, payload.salt)

    aesgcm = AESGCM(key)
    # Reconstruct ciphertext || auth_tag for AESGCM.decrypt
    ct_and_tag = payload.ciphertext + payload.auth_tag

    try:
        plaintext_bytes = aesgcm.decrypt(payload.iv, ct_and_tag, None)
        return plaintext_bytes.decode("utf-8")
    except Exception as err:
        raise ValueError(
            "Decryption failed: authentication tag mismatch (wrong password or tampered data)"
        ) from err


def payload_to_dict(payload: EncryptedPayload) -> dict:
    """Serialize an EncryptedPayload to a JSON-friendly dict with base64 values."""
    import base64
    return {
        "salt": base64.b64encode(payload.salt).decode("ascii"),
        "iv": base64.b64encode(payload.iv).decode("ascii"),
        "auth_tag": base64.b64encode(payload.auth_tag).decode("ascii"),
        "ciphertext": base64.b64encode(payload.ciphertext).decode("ascii"),
    }


def dict_to_payload(d: dict) -> EncryptedPayload:
    """Deserialize a dict back into an EncryptedPayload."""
    import base64
    return EncryptedPayload(
        salt=base64.b64decode(d["salt"]),
        iv=base64.b64decode(d["iv"]),
        auth_tag=base64.b64decode(d["auth_tag"]),
        ciphertext=base64.b64decode(d["ciphertext"]),
    )


def payload_to_bytes(payload: EncryptedPayload) -> bytes:
    """
    Serialize an EncryptedPayload to a single bytes blob for DB storage.
    Format: salt(16) || iv(12) || auth_tag(16) || ciphertext(variable)
    Matches the TS Buffer.concat approach.
    """
    return payload.salt + payload.iv + payload.auth_tag + payload.ciphertext


def bytes_to_payload(data: bytes) -> EncryptedPayload:
    """Deserialize a bytes blob back into an EncryptedPayload."""
    if len(data) < SALT_BYTES + IV_BYTES + 16:
        raise ValueError("Data too short to be a valid encrypted payload")
    offset = 0
    salt = data[offset:offset + SALT_BYTES]; offset += SALT_BYTES
    iv = data[offset:offset + IV_BYTES]; offset += IV_BYTES
    auth_tag = data[offset:offset + 16]; offset += 16
    ciphertext = data[offset:]
    return EncryptedPayload(salt=salt, iv=iv, auth_tag=auth_tag, ciphertext=ciphertext)

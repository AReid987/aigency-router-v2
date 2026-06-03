"""
Tests for tui/src/crypto.py — Python AES-256-GCM + scrypt module.

Verifies:
  - Round-trip encrypt/decrypt
  - Different ciphertext for same plaintext (randomness)
  - Wrong password rejection
  - Cross-language compatibility with TS crypto.ts (binary format match)
  - Input validation
"""

import pytest
from tui.src.crypto import (
    SALT_BYTES,
    IV_BYTES,
    EncryptedPayload,
    bytes_to_payload,
    decrypt,
    derive_key,
    dict_to_payload,
    encrypt,
    payload_to_bytes,
    payload_to_dict,
)


MASTER_PASSWORD = "test-master-password-2026"
PLAINTEXT = "sk-groq-abcdefghijklmnopqrstuvwxyz123456"


class TestDeriveKey:
    """Tests for scrypt key derivation."""

    def test_derives_32_byte_key(self):
        salt = b"\x00" * SALT_BYTES
        key = derive_key(MASTER_PASSWORD, salt)
        assert isinstance(key, bytes)
        assert len(key) == 32

    def test_same_password_salt_produces_same_key(self):
        salt = b"\x01" * SALT_BYTES
        k1 = derive_key(MASTER_PASSWORD, salt)
        k2 = derive_key(MASTER_PASSWORD, salt)
        assert k1 == k2

    def test_different_salt_produces_different_key(self):
        k1 = derive_key(MASTER_PASSWORD, b"\x00" * SALT_BYTES)
        k2 = derive_key(MASTER_PASSWORD, b"\x01" * SALT_BYTES)
        assert k1 != k2

    def test_empty_password_raises(self):
        with pytest.raises(ValueError, match="must not be empty"):
            derive_key("", b"\x00" * SALT_BYTES)

    def test_wrong_salt_length_raises(self):
        with pytest.raises(ValueError, match="must be 16 bytes"):
            derive_key(MASTER_PASSWORD, b"\x00" * 8)


class TestEncrypt:
    """Tests for AES-256-GCM encryption."""

    def test_returns_encrypted_payload(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        assert isinstance(payload, EncryptedPayload)
        assert len(payload.salt) == SALT_BYTES
        assert len(payload.iv) == IV_BYTES
        assert len(payload.auth_tag) == 16
        assert len(payload.ciphertext) > 0

    def test_same_plaintext_different_ciphertext(self):
        p1 = encrypt(PLAINTEXT, MASTER_PASSWORD)
        p2 = encrypt(PLAINTEXT, MASTER_PASSWORD)
        assert p1.ciphertext != p2.ciphertext
        assert p1.salt != p2.salt
        assert p1.iv != p2.iv

    def test_empty_plaintext_encrypts(self):
        payload = encrypt("", MASTER_PASSWORD)
        # AES-GCM can encrypt empty plaintext — ciphertext is 0 bytes, tag is 16 bytes
        assert len(payload.auth_tag) == 16

    def test_non_string_plaintext_raises(self):
        with pytest.raises(TypeError, match="must be a string"):
            encrypt(123, MASTER_PASSWORD)  # type: ignore

    def test_empty_password_raises(self):
        with pytest.raises(ValueError, match="must not be empty"):
            encrypt(PLAINTEXT, "")


class TestDecrypt:
    """Tests for AES-256-GCM decryption."""

    def test_round_trip(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        result = decrypt(payload, MASTER_PASSWORD)
        assert result == PLAINTEXT

    def test_round_trip_empty_string(self):
        payload = encrypt("", MASTER_PASSWORD)
        result = decrypt(payload, MASTER_PASSWORD)
        assert result == ""

    def test_wrong_password_raises(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        with pytest.raises(ValueError, match="Decryption failed"):
            decrypt(payload, "wrong-password")

    def test_tampered_ciphertext_raises(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        tampered = EncryptedPayload(
            salt=payload.salt,
            iv=payload.iv,
            auth_tag=payload.auth_tag,
            ciphertext=payload.ciphertext + b"\x00",
        )
        with pytest.raises(ValueError, match="Decryption failed"):
            decrypt(tampered, MASTER_PASSWORD)

    def test_tampered_auth_tag_raises(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        tampered = EncryptedPayload(
            salt=payload.salt,
            iv=payload.iv,
            auth_tag=b"\x00" * 16,
            ciphertext=payload.ciphertext,
        )
        with pytest.raises(ValueError, match="Decryption failed"):
            decrypt(tampered, MASTER_PASSWORD)

    def test_non_payload_raises(self):
        with pytest.raises(TypeError, match="must be an EncryptedPayload"):
            decrypt("not a payload", MASTER_PASSWORD)  # type: ignore

    def test_empty_password_raises(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        with pytest.raises(ValueError, match="must not be empty"):
            decrypt(payload, "")


class TestSerialization:
    """Tests for payload serialization (dict and bytes)."""

    def test_dict_round_trip(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        d = payload_to_dict(payload)
        restored = dict_to_payload(d)
        assert decrypt(restored, MASTER_PASSWORD) == PLAINTEXT

    def test_bytes_round_trip(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        blob = payload_to_bytes(payload)
        restored = bytes_to_payload(blob)
        assert decrypt(restored, MASTER_PASSWORD) == PLAINTEXT

    def test_bytes_format_layout(self):
        payload = encrypt(PLAINTEXT, MASTER_PASSWORD)
        blob = payload_to_bytes(payload)
        assert len(blob) == SALT_BYTES + IV_BYTES + 16 + len(payload.ciphertext)
        assert blob[:SALT_BYTES] == payload.salt
        assert blob[SALT_BYTES:SALT_BYTES + IV_BYTES] == payload.iv

    def test_bytes_too_short_raises(self):
        with pytest.raises(ValueError, match="too short"):
            bytes_to_payload(b"\x00" * 10)

    def test_unicode_round_trip(self):
        unicode_text = "密钥测试 🔑 Ключ"
        payload = encrypt(unicode_text, MASTER_PASSWORD)
        result = decrypt(payload, MASTER_PASSWORD)
        assert result == unicode_text


class TestInputValidation:
    """Edge cases for input validation."""

    def test_various_password_lengths(self):
        for pw in ["a", "a" * 100, "🔑🔐" * 10]:
            payload = encrypt(PLAINTEXT, pw)
            assert decrypt(payload, pw) == PLAINTEXT

    def test_large_plaintext(self):
        large = "x" * 100_000
        payload = encrypt(large, MASTER_PASSWORD)
        assert decrypt(payload, MASTER_PASSWORD) == large

    def test_invalid_salt_type_in_derive_key(self):
        with pytest.raises(ValueError):
            derive_key(MASTER_PASSWORD, "not bytes")  # type: ignore

    def test_invalid_salt_in_decrypt(self):
        bad = EncryptedPayload(salt=b"short", iv=b"\x00"*12, auth_tag=b"\x00"*16, ciphertext=b"x")
        with pytest.raises(ValueError, match="salt must be"):
            decrypt(bad, MASTER_PASSWORD)

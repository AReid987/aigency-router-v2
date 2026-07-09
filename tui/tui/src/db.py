"""
SQLite wrapper for SugarVault — reads/writes the same DB as the TypeScript vault worker.

Schema is identical to workers/vault/src/db.ts so both the iii vault worker
and the Python TUI/CLI can operate on the same database file.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Optional


@dataclass
class VaultEntry:
    """Mirrors the TypeScript VaultEntry interface."""
    id: str
    provider_id: str
    encrypted_payload: bytes
    virtual_colleague_id: Optional[str]
    is_active: bool
    created_at: str
    last_used_at: Optional[str]


class SugarVaultDB:
    """Thin wrapper over sqlite3 matching the TS SugarVaultDB schema."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS sugar_vault (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                encrypted_payload BLOB NOT NULL,
                virtual_colleague_id TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_used_at TEXT
            );

            CREATE TABLE IF NOT EXISTS vault_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sugar_vault_provider_id
                ON sugar_vault(provider_id);

            CREATE INDEX IF NOT EXISTS idx_sugar_vault_is_active
                ON sugar_vault(is_active);
        """)

    def store_key(
        self,
        id: str,
        provider_id: str,
        encrypted_payload: bytes,
        virtual_colleague_id: Optional[str] = None,
    ) -> None:
        self.conn.execute(
            "INSERT INTO sugar_vault (id, provider_id, encrypted_payload, virtual_colleague_id) "
            "VALUES (?, ?, ?, ?)",
            (id, provider_id, encrypted_payload, virtual_colleague_id),
        )
        self.conn.commit()

    def get_key(self, provider_id: str) -> Optional[VaultEntry]:
        cur = self.conn.execute(
            "SELECT id, provider_id, encrypted_payload, virtual_colleague_id, "
            "is_active, created_at, last_used_at "
            "FROM sugar_vault WHERE provider_id = ? AND is_active = 1 "
            "ORDER BY rowid DESC LIMIT 1",
            (provider_id,),
        )
        row = cur.fetchone()
        return self._row_to_entry(row) if row else None

    def get_key_by_id(self, id: str) -> Optional[VaultEntry]:
        cur = self.conn.execute(
            "SELECT id, provider_id, encrypted_payload, virtual_colleague_id, "
            "is_active, created_at, last_used_at "
            "FROM sugar_vault WHERE id = ?",
            (id,),
        )
        row = cur.fetchone()
        return self._row_to_entry(row) if row else None

    def get_all_keys(self) -> list[VaultEntry]:
        cur = self.conn.execute(
            "SELECT id, provider_id, encrypted_payload, virtual_colleague_id, "
            "is_active, created_at, last_used_at "
            "FROM sugar_vault ORDER BY rowid DESC"
        )
        return [self._row_to_entry(row) for row in cur.fetchall()]

    def deactivate_key(self, id: str) -> None:
        self.conn.execute("UPDATE sugar_vault SET is_active = 0 WHERE id = ?", (id,))
        self.conn.commit()

    def get_meta(self, key: str) -> Optional[str]:
        cur = self.conn.execute("SELECT value FROM vault_meta WHERE key = ?", (key,))
        row = cur.fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO vault_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    def get_key_count(self) -> int:
        cur = self.conn.execute("SELECT COUNT(*) FROM sugar_vault")
        return cur.fetchone()[0]

    def close(self) -> None:
        self.conn.close()

    @staticmethod
    def _row_to_entry(row: tuple) -> VaultEntry:
        return VaultEntry(
            id=row[0],
            provider_id=row[1],
            encrypted_payload=row[2],
            virtual_colleague_id=row[3],
            is_active=row[4] == 1,
            created_at=row[5],
            last_used_at=row[6],
        )

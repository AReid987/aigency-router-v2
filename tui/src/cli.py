"""
Voltron CLI — Typer-based commands for SugarVault key management.

Usage:
    voltron keys add --provider groq --key sk-xxx [--colleague colleague-id]
    voltron keys list [--decrypt] [--password PASSWORD]
    voltron keys remove --id <id>
    voltron tui [--db PATH]
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from tui.src.crypto import (
    bytes_to_payload,
    decrypt,
    encrypt,
    payload_to_bytes,
)
from tui.src.db import SugarVaultDB

app = typer.Typer(
    name="voltron",
    help="Voltron — SugarVault key management CLI for Aigency OS.",
    no_args_is_help=True,
)
keys_app = typer.Typer(help="Manage API keys in the SugarVault.")
app.add_typer(keys_app, name="keys")

console = Console()

# Default DB path — matches where the vault worker stores its DB
DEFAULT_DB_PATH = os.environ.get(
    "SUGAR_VAULT_DB",
    str(Path.home() / ".aigency" / "sugar_vault.db"),
)


def _get_db(db_path: str | None = None) -> SugarVaultDB:
    path = db_path or DEFAULT_DB_PATH
    db_dir = os.path.dirname(path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    return SugarVaultDB(path)


def _get_master_password(prompt: str = "Master password") -> str:
    """Get master password from env or interactive prompt."""
    env_pw = os.environ.get("SUGAR_VAULT_PASSWORD")
    if env_pw:
        return env_pw
    import getpass
    return getpass.getpass(f"{prompt}: ")


@keys_app.command("add")
def keys_add(
    provider: str = typer.Option(..., "--provider", "-p", help="Provider ID (e.g. groq, openai)"),
    key: str = typer.Option(..., "--key", "-k", help="API key to store"),
    colleague: str = typer.Option(None, "--colleague", "-c", help="Virtual colleague ID"),
    db_path: str = typer.Option(None, "--db", help="Path to SugarVault DB"),
    password: str = typer.Option(None, "--password", help="Master password (or set SUGAR_VAULT_PASSWORD)"),
) -> None:
    """Add an encrypted API key to the vault."""
    if not provider.strip():
        console.print("[red]Error:[/red] --provider must not be empty")
        raise typer.Exit(1)
    if not key.strip():
        console.print("[red]Error:[/red] --key must not be empty")
        raise typer.Exit(1)

    master_pw = password or _get_master_password()
    if not master_pw:
        console.print("[red]Error:[/red] Master password is required")
        raise typer.Exit(1)

    entry_id = str(uuid.uuid4())
    payload = encrypt(key, master_pw)
    blob = payload_to_bytes(payload)

    db = _get_db(db_path)
    try:
        db.store_key(entry_id, provider.strip(), blob, colleague)
        console.print(f"[green]✓[/green] Key stored for provider [bold]{provider}[/bold] (id: {entry_id[:8]}…)")
    finally:
        db.close()


@keys_app.command("list")
def keys_list(
    decrypt_keys: bool = typer.Option(False, "--decrypt", "-d", help="Decrypt and show key values"),
    password: str = typer.Option(None, "--password", help="Master password (or set SUGAR_VAULT_PASSWORD)"),
    db_path: str = typer.Option(None, "--db", help="Path to SugarVault DB"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
) -> None:
    """List all keys in the vault."""
    db = _get_db(db_path)
    try:
        entries = db.get_all_keys()
        if not entries:
            console.print("[dim]Vault is empty — no keys stored.[/dim]")
            return

        master_pw = None
        if decrypt_keys:
            master_pw = password or _get_master_password()

        if json_output:
            rows = []
            for e in entries:
                row = {
                    "id": e.id,
                    "provider": e.provider_id,
                    "colleague": e.virtual_colleague_id,
                    "active": e.is_active,
                    "created": e.created_at,
                }
                if decrypt_keys and master_pw and e.is_active:
                    try:
                        payload = bytes_to_payload(e.encrypted_payload)
                        row["key"] = decrypt(payload, master_pw)
                    except Exception:
                        row["key"] = "[decryption failed]"
                rows.append(row)
            console.print(json.dumps(rows, indent=2))
            return

        table = Table(title="SugarVault Keys", show_lines=True)
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Provider", style="green")
        table.add_column("Colleague", style="yellow")
        table.add_column("Active", style="bold")
        table.add_column("Created", style="dim")
        if decrypt_keys:
            table.add_column("Key", style="red")

        for e in entries:
            row = [
                e.id[:12] + "…",
                e.provider_id,
                e.virtual_colleague_id or "—",
                "✓" if e.is_active else "✗",
                e.created_at,
            ]
            if decrypt_keys:
                if e.is_active and master_pw:
                    try:
                        payload = bytes_to_payload(e.encrypted_payload)
                        row.append(decrypt(payload, master_pw))
                    except Exception:
                        row.append("[decryption failed]")
                else:
                    row.append("—")
            table.add_row(*row)

        console.print(table)
    finally:
        db.close()


@keys_app.command("remove")
def keys_remove(
    id: str = typer.Option(..., "--id", help="Key ID to deactivate"),
    db_path: str = typer.Option(None, "--db", help="Path to SugarVault DB"),
) -> None:
    """Deactivate a key (soft-delete)."""
    db = _get_db(db_path)
    try:
        entry = db.get_key_by_id(id)
        if not entry:
            console.print(f"[red]Error:[/red] No key found with id {id}")
            raise typer.Exit(1)
        db.deactivate_key(id)
        console.print(f"[green]✓[/green] Key {id[:12]}… deactivated for provider [bold]{entry.provider_id}[/bold]")
    finally:
        db.close()


@app.command("tui")
def launch_tui(
    db_path: str = typer.Option(None, "--db", help="Path to SugarVault DB"),
) -> None:
    """Launch the Textual TUI dashboard."""
    try:
        from tui.src.app import VoltronApp
    except ImportError as e:
        console.print(f"[red]Error:[/red] Textual not installed: {e}")
        console.print("Install with: pip install textual")
        raise typer.Exit(1)

    app_instance = VoltronApp(db_path=db_path or DEFAULT_DB_PATH)
    app_instance.run()


if __name__ == "__main__":
    app()

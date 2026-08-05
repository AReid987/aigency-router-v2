"""
Voltron TUI — Textual dual-pane dashboard for SugarVault.

Layout (per spec 04_AIGENCY_OS_UI-UX.md §2.2):
  - Left pane (70%): Routing log placeholder
  - Right pane (30%): Vault key table

Hotkeys:
  [F1]  Toggle verbosity
  [ESC] Quit
"""

from __future__ import annotations

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Header, Label, Static

from tui.src.db import SugarVaultDB


class RoutingLogPane(Static):
    """Left pane — placeholder for OmniGateway routing logs."""

    DEFAULT_CSS = """
    RoutingLogPane {
        width: 70%;
        height: 100%;
        border: solid $accent;
        padding: 1;
        overflow-y: auto;
    }
    """

    def compose(self) -> ComposeResult:
        yield Label("[bold cyan]Swarm Log[/bold cyan]", id="log-header")
        yield Static(
            "[dim]Routing logs will appear here when connected to OmniGateway.[/dim]\n"
            "[dim]Green = Fast Track | Blue = DAG | Yellow = Drift | Red = 429/5xx[/dim]",
            id="log-content",
        )


class VaultMatrixPane(Vertical):
    """Right pane — live table of vault keys."""

    DEFAULT_CSS = """
    VaultMatrixPane {
        width: 30%;
        height: 100%;
        border: solid $accent;
        padding: 1;
    }
    """

    def __init__(self, db_path: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.db_path = db_path

    def compose(self) -> ComposeResult:
        yield Label("[bold amber]Vault Matrix[/bold amber]", id="vault-header")
        table = DataTable(id="vault-table")
        table.add_columns("ID", "Provider", "Colleague", "Active", "Created")
        yield table

    def on_mount(self) -> None:
        self.refresh_keys()

    def refresh_keys(self) -> None:
        table = self.query_one("#vault-table", DataTable)
        table.clear()
        db = SugarVaultDB(self.db_path)
        try:
            for entry in db.get_all_keys():
                table.add_row(
                    entry.id[:10] + "…",
                    entry.provider_id,
                    entry.virtual_colleague_id or "—",
                    "✓" if entry.is_active else "✗",
                    entry.created_at[:19] if entry.created_at else "—",
                )
        finally:
            db.close()


class VoltronApp(App):
    """Voltron TUI — dual-pane dashboard for SugarVault management."""

    TITLE = "Voltron — SugarVault Dashboard"
    CSS = """
    Screen {
        layout: horizontal;
    }
    """

    BINDINGS = [
        Binding("f1", "toggle_verbosity", "Toggle Verbosity"),
        Binding("escape", "quit", "Quit"),
        Binding("r", "refresh", "Refresh Keys"),
    ]

    def __init__(self, db_path: str = "sugar_vault.db", **kwargs) -> None:
        super().__init__(**kwargs)
        self.db_path = db_path
        self.verbosity_level = 0  # 0=Info, 1=Debug, 2=Trace

    def compose(self) -> ComposeResult:
        yield Header()
        yield Horizontal(
            RoutingLogPane(),
            VaultMatrixPane(db_path=self.db_path),
        )
        yield Footer()

    def action_toggle_verbosity(self) -> None:
        self.verbosity_level = (self.verbosity_level + 1) % 3
        labels = ["Info", "Debug", "Trace"]
        self.notify(f"Verbosity: {labels[self.verbosity_level]}")

    def action_refresh(self) -> None:
        vault_pane = self.query_one(VaultMatrixPane)
        vault_pane.refresh_keys()
        self.notify("Keys refreshed")

    def action_quit(self) -> None:
        self.exit()

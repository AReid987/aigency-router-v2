# Story 4.1: TUI Scaffolding (Textual/Typer)

**Overview Description:** Build the Python command-line application to view live routing logs and manage SugarVault credentials securely.

**Complexity Score:** 8

**Dependencies:** Story 1.2

**Developer Guidance:** Use Textual's CSS-like Grid layout. Ensure the Vault pane can securely query the SQLite database without locking it for the Node.js backend. Use `typer` to handle CLI arguments elegantly.

### Checkbox Tasklist:
* [ ] Setup `typer` CLI entry points (`voltron start`, `voltron tui`).
* [ ] Build Textual app with dual panes (Swarm Log on left, Vault Matrix on right).
* [ ] Connect TUI inputs to SugarVault for secure key injection and active toggling.

### Acceptance Criteria:
* Running `voltron tui` launches a responsive terminal UI. 
* Adding a new API key via the TUI form instantly updates the SQLite DB.

### Resource URLs:
* Typer Docs: [https://typer.tiangolo.com/](https://typer.tiangolo.com/)
* Textual Docs: [https://textual.textualize.io/](https://textual.textualize.io/)

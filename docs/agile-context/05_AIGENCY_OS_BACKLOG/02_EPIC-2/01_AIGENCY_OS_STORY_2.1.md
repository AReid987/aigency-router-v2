# Story 2.1: SugarDB Telemetry Setup

**Overview Description:** Set up a secondary SQLite database to log Engram schema drifts, quota warnings, and Judge rejections for future Karpathy-style fine-tuning.

**Complexity Score:** 3

**Dependencies:** None

**Developer Guidance:** This database is completely unencrypted to ensure lightning-fast reads and writes. Use `PRAGMA journal_mode = WAL;` (Write-Ahead Logging) to prevent database locking when concurrent swarm tasks attempt to log telemetry simultaneously.

### Checkbox Tasklist:
* [ ] Initialize `./.sugar/telemetry.db` using `better-sqlite3`.
* [ ] Write schemas for `logs` and `drift_events`.
* [ ] Expose a `TelemetryLogger` TypeScript class with async fire-and-forget methods.

### Acceptance Criteria:
* System successfully creates the database file on boot.
* System successfully inserts 100 mock telemetry events in under 10ms without file lock errors.

### Resource URLs:
* SQLite WAL Mode: [https://sqlite.org/wal.html](https://sqlite.org/wal.html)

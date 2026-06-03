import Database from 'better-sqlite3'

export interface VaultEntry {
  id: string
  providerId: string
  encryptedPayload: Buffer
  virtualColleagueId: string | null
  isActive: boolean
  createdAt: string
  lastUsedAt: string | null
}

export class SugarVaultDB {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
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
    `)
  }

  storeKey(
    id: string,
    providerId: string,
    encryptedPayload: Buffer,
    virtualColleagueId: string | null = null
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO sugar_vault (id, provider_id, encrypted_payload, virtual_colleague_id)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(id, providerId, encryptedPayload, virtualColleagueId)
  }

  getKey(providerId: string): VaultEntry | null {
    const stmt = this.db.prepare(`
      SELECT id, provider_id, encrypted_payload, virtual_colleague_id, is_active, created_at, last_used_at
      FROM sugar_vault
      WHERE provider_id = ? AND is_active = 1
      ORDER BY rowid DESC
      LIMIT 1
    `)
    const row = stmt.get(providerId) as any
    if (!row) return null
    return this.rowToEntry(row)
  }

  getAllKeys(): VaultEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, provider_id, encrypted_payload, virtual_colleague_id, is_active, created_at, last_used_at
      FROM sugar_vault
      ORDER BY created_at DESC
    `)
    const rows = stmt.all() as any[]
    return rows.map((row) => this.rowToEntry(row))
  }

  deactivateKey(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE sugar_vault SET is_active = 0 WHERE id = ?
    `)
    stmt.run(id)
  }

  getMeta(key: string): string | null {
    const stmt = this.db.prepare(`
      SELECT value FROM vault_meta WHERE key = ?
    `)
    const row = stmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO vault_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    stmt.run(key, value)
  }

  getKeyCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sugar_vault
    `)
    const row = stmt.get() as { count: number }
    return row.count
  }

  close(): void {
    this.db.close()
  }

  private rowToEntry(row: any): VaultEntry {
    return {
      id: row.id,
      providerId: row.provider_id,
      encryptedPayload: row.encrypted_payload,
      virtualColleagueId: row.virtual_colleague_id,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }
  }
}

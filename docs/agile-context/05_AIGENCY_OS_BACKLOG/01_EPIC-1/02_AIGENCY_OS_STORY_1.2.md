# Story 1.2: SugarVault Initialization

**Overview Description:** Establish the foundational SQLite database for secure credential storage using AES-256-GCM encryption.

**Complexity Score:** 8 (Complex - Security Critical)

**Dependencies:** Story 1.1

**Developer Guidance:** Use Node.js native `crypto` module. The master key should be passed into the server instance via a secure memory buffer on startup, never written to disk. The `better-sqlite3` package should be used for synchronous, fast local reads.

### Checkbox Tasklist:
* [ ] Install `better-sqlite3` and configure connection to `./.sugar/vault.db`.
* [ ] Write SQL migration to create `credentials` table (id, provider, encrypted_key, virtual_colleague_id, active).
* [ ] Create AES-256-GCM encrypt/decrypt utility functions.
* [ ] Build TS class `VaultManager` to expose safe retrieval methods to the OmniGateway.

### Acceptance Criteria:
* SQLite file is generated on application boot if missing.
* Mock API keys inserted into the DB are stored as BLOB ciphertexts.
* `VaultManager.getKey('groq')` successfully returns plaintext only in memory.

### Resource URLs:
* better-sqlite3: [https://github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
* Node Crypto: [https://nodejs.org/api/crypto.html](https://nodejs.org/api/crypto.html
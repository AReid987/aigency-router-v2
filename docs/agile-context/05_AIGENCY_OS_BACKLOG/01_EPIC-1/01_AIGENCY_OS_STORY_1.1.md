# Story 1.1: Workspace Cleanup & Legacy Deprecation

**Overview Description:** Before we build the new architecture, we must purge the technical debt. This story involves safely removing all vector database dependencies (`ruvector-postgres`) and stripping out any legacy `.env` credential loaders that pose a security risk.

**Complexity Score:** 2 (Simple)

**Dependencies:** None

**Developer Guidance:** Do not just delete the folder. Ensure the `package.json`, `tsconfig.json`, and `pnpm-workspace.yaml` are completely stripped of any `ruvector` references. Run a full workspace compile after deletion.

### Checkbox Tasklist:
* [ ] Delete `ruvector-postgres` directory completely.
* [ ] Remove related DB drivers (pg, pg-pool) from root `package.json`.
* [ ] Search codebase for `process.env.OPENAI_API_KEY` and remove native loaders.
* [ ] Run `pnpm install` to ensure lockfile is clean and builds pass.

### Acceptance Criteria:
* Workspace compiles without errors.
* No references to Postgres or Ruvector exist in the codebase.
* `.env` file no longer contains active API keys for providers.

### Resource URLs:
* pnpm Workspaces: [https://pnpm.io/workspaces](https://pnpm.io/workspaces)
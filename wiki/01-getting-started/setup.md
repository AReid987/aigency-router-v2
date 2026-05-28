# Setup Guide

## Prerequisites

- **macOS** (primary development environment based on directory structure)
- **Git** for repository management
- One or more AI coding agents: Claude Code, Cline, Goose, Qwen, Roo, Trae, etc.
- **ICM CLI** (`icm`) for persistent memory (optional but recommended)

## Repository Structure

```mermaid
graph TD
    Root["aigency-router-v2/"] --> A["_bmad/"]
    Root --> B[".qwen/skills/"]
    Root --> C[".agents/skills/"]
    Root --> D["skills/"]
    Root --> E["docs/"]
    Root --> F[".claude/"]
    Root --> G[".cline/"]
    Root --> H["18 other agent dirs"]
    Root --> I["AGENTS.md"]
    Root --> J["skills-lock.json"]

    A --> A1["config.toml"]
    A --> A2["bmm/"]
    A --> A3["tea/"]
    A --> A4["core/"]
    A --> A5["custom/"]
    A --> A6["scripts/"]

    B --> B1["53 BMad skills"]
    C --> C1["Shared skills"]
    D --> D1["symlinks to .agents/skills"]

    style Root fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style A fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style B fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style C fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style D fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style I fill:#4a2e2e,stroke:#d45b5b,color:#e0e0e0
```
<!-- Sources: config.toml:1, _bmad/_config/manifest.yaml:1, skills-lock.json:1 -->

## Directory Quick Reference

| Path | Purpose | Citation |
|------|---------|----------|
| `.qwen/skills/` | Canonical BMad skill storage | (`_bmad/_config/skill-manifest.csv:1`) |
| `.agents/skills/` | Cross-agent shared skills (Stripe, etc.) | (`skills-lock.json:1`) |
| `skills/` | Symlinks to `.agents/skills/` for discoverability | (`skills/stripe-best-practices`) |
| `_bmad/` | BMad framework configuration and scripts | (`_bmad/config.toml:1`) |
| `docs/agile-context/` | Project documentation (PRD, architecture, UX) | (`docs/agile-context/project-brief.md`) |
| `docs/maestro/` | Maestro orchestration plans and state | (`docs/maestro/plans/`) |
| `.claude/skills/` | Claude Code agent skills (symlinked) | (`.claude/skills/bmad-create-prd/`) |
| `.cline/skills/` | Cline agent skills (symlinked) | (`.cline/skills/bmad-create-prd/`) |

## Initial Setup

### 1. Clone or Initialize

```bash
cd /path/to/aigency-router-v2
```

No build step is required — this is a content and configuration repository.

### 2. Verify Skill Manifest

```bash
cat _bmad/_config/skill-manifest.csv
```

This lists all 53 BMad skills with their directories. (`_bmad/_config/skill-manifest.csv:1`)

### 3. Verify Agent Symlinks

Ensure your target agent directories have valid symlinks:

```bash
ls -la .claude/skills/bmad-create-prd
# Should show: -> ../../.qwen/skills/bmad-create-prd
```

If symlinks are broken, recreate them:

```bash
ln -s ../../.qwen/skills/bmad-create-prd .claude/skills/bmad-create-prd
```

### 4. Configure ICM (Optional)

```bash
icm health
icm topics
```

See [AGENTS.md](../AGENTS.md) for ICM usage rules. (`AGENTS.md:1`)

### 5. Configure Custom Overrides

Create `_bmad/custom/config.user.toml` (gitignored) for personal agent overrides:

```toml
[agents.bmad-agent-dev]
name = "YourDevName"
description = "Your custom dev description"
```

(`_bmad/custom/config.user.toml:1`)

## Adding a New Skill

```mermaid
sequenceDiagram
    autonumber
    actor Dev
    Dev->>Dev: Create skill in .qwen/skills/new-skill/
    Dev->>Dev: Add SKILL.md with triggers, description, instructions
    Dev->>_bmad: Update _config/skill-manifest.csv
    Dev->>AgentDirs: Create symlinks for each target agent
    Dev->>skills-lock.json: Add hash entry (for external skills)
    Dev->>Git: Commit and push
```
<!-- Sources: _bmad/_config/skill-manifest.csv:1, skills-lock.json:1, _bmad/scripts/resolve_config.py:1 -->

## Syncing Skills Across Agents

Use the provided configuration scripts to resolve and propagate skills:

```bash
python _bmad/scripts/resolve_config.py
python _bmad/scripts/resolve_customization.py
```

(`_bmad/scripts/resolve_config.py:1`, `_bmad/scripts/resolve_customization.py:1`)

## Validation Checklist

- [ ] All agent skill directories have valid symlinks
- [ ] `skills-lock.json` hashes match actual file contents
- [ ] `_bmad/_config/skill-manifest.csv` is up to date
- [ ] `AGENTS.md` is present in repository root
- [ ] ICM is configured (if using persistent memory)

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Agent can't find skill | Broken symlink | Recreate symlink relative to agent dir |
| Skill content outdated | Cached by agent | Restart agent or clear skill cache |
| Config not loading | Missing custom file | Ensure `_bmad/custom/config.user.toml` exists |
| ICM not working | CLI not installed | `pip install icm-cli` or check PATH |

## Related Pages

- [Quick Reference](./quick-reference.md) — Day-to-day commands and workflows
- [Skills System](../02-deep-dive/skills-system/index.md) — Deep dive into skill anatomy
- [Agent Platforms](../02-deep-dive/agent-platforms/index.md) — Per-agent setup details

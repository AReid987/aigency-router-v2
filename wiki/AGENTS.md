# AGENTS.md — Aigency Router v2

## Project Context

Aigency Router v2 is a multi-agent AI skill orchestration hub. It distributes 53+ BMad skills to 18+ AI coding agent platforms via symlink-based replication. This repository is content and configuration — no build step, no server, no deploy.

## Conventions

### Skill Format
- All skills are directories containing `SKILL.md`
- Frontmatter must include: `name`, `description`, `triggers`
- Triggers are matched by agent runtime against user input
- Skills live canonically in `.qwen/skills/` and `.agents/skills/`

### Configuration
- `_bmad/config.toml` is installer-managed (read-only)
- `_bmad/custom/config.toml` for team overrides (committed)
- `_bmad/custom/config.user.toml` for personal overrides (gitignored)
- Run `python _bmad/scripts/resolve_config.py` after config changes

### Symlinks
- Never copy skills — always symlink from canonical store
- Primary canonical stores: `.qwen/skills/` (BMad), `.agents/skills/` (shared)
- `skills/` in root contains symlinks to `.agents/skills/`

### ICM (Mandatory)
This project uses ICM for persistent memory.

```bash
icm recall "query"
icm store -t errors-resolved -c "description" -i high -k "keyword1,keyword2"
icm store -t decisions-aigency -c "description" -i high
icm store -t preferences -c "description" -i critical
icm store -t context-aigency -c "summary" -i high
```

Store BEFORE responding when any trigger fires.

## Repository Structure

```
aigency-router-v2/
├── .qwen/skills/          # 53 BMad skills (canonical)
├── .agents/skills/        # Shared skills (canonical)
├── skills/                # Symlinks to .agents/skills/
├── .claude/skills/        # Symlinked skills
├── .cline/skills/         # Symlinked skills
├── .factory/skills/       # Symlinked skills
├── .qoder/skills/         # Symlinked skills
├── _bmad/                 # BMad framework config
│   ├── config.toml        # Resolved config
│   ├── core/              # Framework defaults
│   ├── bmm/               # Planning module
│   ├── tea/               # Testing module
│   ├── custom/            # Overrides
│   └── scripts/           # Config resolution
├── docs/                  # Project docs
│   ├── agile-context/     # PRD, architecture, UX
│   └── maestro/           # Orchestration plans
├── AGENTS.md              # This file
├── skills-lock.json       # External skill hashes
└── .gsd -> ~/.gsd/...    # GSD project management
```

## Key Files

| File | Purpose |
|------|---------|
| `_bmad/config.toml` | Resolved BMad configuration |
| `_bmad/_config/skill-manifest.csv` | Skill directory mapping |
| `_bmad/_config/files-manifest.csv` | File inventory |
| `skills-lock.json` | External skill integrity hashes |
| `.github/copilot-instructions.md` | GitHub Copilot context |

## Agent Personas

- **Mary** 📊 — Business Analyst (BMM)
- **John** 📋 — Product Manager (BMM)
- **Sally** 🎨 — UX Designer (BMM)
- **Winston** 🏗️ — System Architect (BMM)
- **Amelia** 💻 — Senior Developer (BMM)
- **Paige** 📚 — Technical Writer (BMM)
- **Murat** 🧪 — Test Architect (TEA)

## When Editing This Repo

1. Resolve source repository first (`git remote get-url origin`)
2. Read the skill you're modifying before changing it
3. Update `skill-manifest.csv` if adding/removing skills
4. Run `resolve_config.py` to sync symlinks
5. Use ICM stores at mandatory trigger points
6. Never edit `_bmad/config.toml` directly — use `custom/` overrides

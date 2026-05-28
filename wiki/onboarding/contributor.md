# Contributor Guide

Welcome to Aigency Router v2. This guide will get you from zero to your first skill contribution.

## Day 1: Understanding the Repository

Aigency Router is a **skill distribution hub**. It doesn't compile or deploy — it curates and distributes AI agent skills to 18+ coding platforms.

### Your First Commands

```bash
# See what skills exist
ls .qwen/skills/ | head -20

# Check if your agent's skills are linked
ls -la .claude/skills/ | head -10

# Read the main configuration
cat _bmad/config.toml

# Check the skill manifest
cat _bmad/_config/skill-manifest.csv
```

### Repository Map

| Directory | What You'll Do There | Citation |
|-----------|---------------------|----------|
| `.qwen/skills/` | Add or edit BMad skills | (`_bmad/_config/skill-manifest.csv:1`) |
| `.agents/skills/` | Add shared external skills | (`skills-lock.json:1`) |
| `_bmad/` | Configure modules and agents | (`_bmad/config.toml:1`) |
| `docs/` | Write project documentation | (`docs/agile-context/`) |

## Day 2: Your First Skill

### Skill Structure

Every skill is a directory with at minimum a `SKILL.md`:

```
my-skill/
├── SKILL.md          # Required
├── scripts/          # Optional helpers
├── resources/        # Optional assets
└── prompts/          # Optional prompt templates
```

(`.qwen/skills/bmad-help/SKILL.md:1`)

### SKILL.md Template

```markdown
---
name: my-skill
description: What this skill does and when to use it.
triggers:
  - trigger phrase 1
  - trigger phrase 2
---

# My Skill

## When to Use

Trigger this skill when the user says any of the trigger phrases above.

## Instructions

1. Step one
2. Step two
3. Step three

## Examples

### Example 1: Basic usage
...
```

### Testing Your Skill

1. Create the skill directory in `.qwen/skills/my-skill/`
2. Write the `SKILL.md`
3. Create a symlink in your agent directory:
   ```bash
   ln -s ../../.qwen/skills/my-skill .claude/skills/my-skill
   ```
4. Restart your agent and test the trigger phrase

## Day 3: Contributing Workflow

```mermaid
graph LR
    A[Edit Skill] --> B[Test Locally]
    B --> C[Update Manifest]
    C --> D[Run resolve_config.py]
    D --> E[Git Commit]
    E --> F[PR Review]

    style A fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style B fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style C fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style D fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style E fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style F fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
```
<!-- Sources: _bmad/scripts/resolve_config.py:1, _bmad/_config/skill-manifest.csv:1 -->

### Checklist Before Committing

- [ ] `SKILL.md` has valid frontmatter with `name`, `description`, and `triggers`
- [ ] Skill is added to `_bmad/_config/skill-manifest.csv`
- [ ] Symlinks are created for primary agents (`.claude`, `.cline`, `.qwen`, `.factory`, `.qoder`)
- [ ] If external skill, hash is added to `skills-lock.json`
- [ ] ICM memory stored for significant changes (`AGENTS.md:14-20`)

## Common Tasks

### Add a Trigger to an Existing Skill

Edit the `SKILL.md` frontmatter:
```yaml
triggers:
  - existing trigger
  - new trigger    # <-- add this
```

### Fix a Broken Symlink

```bash
# Find broken links
find .claude/skills -type l ! -exec test -e {} \; -print

# Recreate
ln -sf ../../.qwen/skills/bmad-create-prd .claude/skills/bmad-create-prd
```

### Update Agent Persona

Edit `_bmad/custom/config.user.toml` (personal) or `_bmad/custom/config.toml` (team):

```toml
[agents.bmad-agent-dev]
name = "YourName"
description = "Your custom description"
```

(`_bmad/custom/config.user.toml:1`)

## Debugging

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent ignores skill | Trigger not matched | Check exact trigger phrase in `SKILL.md` |
| Skill not found | Broken symlink | Recreate symlink |
| Wrong skill loaded | Similar triggers | Make triggers more specific |
| Config not applied | Missing resolve step | Run `python _bmad/scripts/resolve_config.py` |

## Related Pages

- [Setup](../01-getting-started/setup.md) — Detailed installation
- [Skills System](../02-deep-dive/skills-system/index.md) — Skill anatomy deep dive
- [Staff Engineer Guide](./staff-engineer.md) — Architecture philosophy

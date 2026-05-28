# Staff Engineer Guide

## System Philosophy

Aigency Router v2 is built on three principles:

1. **Single Source of Truth**: Skills live in one canonical location (`.qwen/skills/`) and are symlinked everywhere. Never copy. (`_bmad/scripts/resolve_config.py:1`)
2. **Agent Agnosticism**: The skill format is platform-neutral. Any agent that can read `SKILL.md` can use these skills. (`.qwen/skills/bmad-help/SKILL.md:1`)
3. **Layered Configuration**: From framework defaults to personal overrides, config merges predictably. (`_bmad/scripts/resolve_config.py:1`)

## Key Abstractions

### The Skill as Interface

A skill is an interface contract between human intent and AI execution:

```
Human Intent ("Create a PRD")
    ↓
Trigger Matcher (frontmatter triggers)
    ↓
Skill Body (instructions, workflows, examples)
    ↓
AI Execution (agent generates output)
```

(`.qwen/skills/bmad-create-prd/SKILL.md:1`)

### The BMad Module as Bounded Context

Modules enforce separation of concerns:

- **BMM** owns planning, requirements, and design. It generates artifacts in `_bmad-output/planning-artifacts/`.
- **TEA** owns testing, quality, and traceability. It generates artifacts in `_bmad-output/test-artifacts/`.
- **Core** owns framework mechanics — config resolution, manifest management, script orchestration.

(`_bmad/bmm/config.yaml:1`, `_bmad/tea/config.yaml:1`, `_bmad/core/config.yaml:1`)

## Architecture Decisions

### Why Symlinks?

**Decision**: Use symbolic links instead of copies or a package manager.

**Rationale**:
- Zero build step required
- Instant propagation of updates
- Native filesystem tooling (`find`, `ls`, `grep`) works transparently
- No dependency on npm/pip/cargo — this is a content repo

**Trade-off**: Broken symlinks when directories move. Mitigated by `resolve_config.py`.

(`_bmad/scripts/resolve_config.py:1`)

### Why Hash Locking for External Skills?

**Decision**: SHA-256 hash external skills in `skills-lock.json`.

**Rationale**:
- Supply chain security for skills sourced from documentation sites
- Detects unauthorized modifications
- Enables reproducible skill environments

**Trade-off**: Manual hash update when skills change. Acceptable for stability.

(`skills-lock.json:1`)

### Why Agent Personas?

**Decision**: Named, iconified personas instead of generic "assistant" roles.

**Rationale**:
- Users invoke specific expertise: "Talk to Winston about architecture"
- Each persona has a distinct communication style, reducing cognitive load
- Personas map 1:1 to skill categories (Mary → analysis skills, etc.)

**Trade-off**: Configuration overhead. Mitigated by TOML-based config.

(`config.toml:35-70`)

## Failure Modes

| Failure | Symptom | Root Cause | Mitigation |
|---------|---------|-----------|------------|
| Symlink desync | Agent uses outdated skill | `resolve_config.py` not run after manifest change | CI check or git hook |
| Trigger collision | Wrong skill activates | Overlapping trigger phrases | Namespace triggers: "bmad sprint planning" |
| Config override loss | Personal settings disappear | Edited `config.toml` directly | Document layered config in onboarding |
| ICM context rot | Agent loses session context | Missing `icm store` calls | `AGENTS.md` mandates stores at 5 trigger points |
| Skill manifest drift | New skill not discoverable | Forgot to update CSV | Validation script in `_bmad/scripts/` |

## Extension Points

1. **New Module**: Add ` _bmad/{module}/config.yaml` and register in `resolve_config.py`
2. **New Agent Platform**: Create `.{agent}/skills/` and add to `files-manifest.csv`
3. **New Skill Category**: Add category column to `skill-manifest.csv`
4. **Custom Script**: Place in `_bmad/scripts/` and reference from config

## Related Pages

- [Architecture](../02-deep-dive/architecture/index.md) — Component diagrams
- [BMad Framework](../02-deep-dive/bmad-framework/index.md) — Module internals
- [Contributor Guide](./contributor.md) — Day-to-day workflow

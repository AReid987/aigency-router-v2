# Skills System

The skills system is the core capability of Aigency Router. It defines how skills are structured, stored, versioned, discovered, and distributed to agent platforms.

## Skill Anatomy

Every skill is a self-contained directory following this structure:

```
skill-name/
├── SKILL.md          # Required: triggers, description, instructions
├── scripts/          # Optional: helper scripts
├── resources/        # Optional: templates, assets
├── prompts/          # Optional: prompt templates
├── steps-v/          # Optional: verification steps
├── steps-c/          # Optional: creation steps
└── steps-e/          # Optional: execution steps
```

(`_bmad/_config/skill-manifest.csv:1`, `.qwen/skills/bmad-create-prd/SKILL.md:1`)

## SKILL.md Format

```mermaid
graph LR
    subgraph "SKILL.md Structure"
        A[Frontmatter] --> B[Triggers]
        A --> C[Description]
        D[Body] --> E[Instructions]
        D --> F[Examples]
        D --> G[Workflows]
    end

    style A fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style B fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style C fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style D fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style E fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style F fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style G fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
```
<!-- Sources: .qwen/skills/bmad-create-prd/SKILL.md:1, .qwen/skills/bmad-dev-story/SKILL.md:1 -->

### Example Frontmatter

```yaml
---
name: bmad-create-prd
description: Create a PRD from scratch. Use when the user says...
triggers:
  - create a prd
  - product requirements document
  - write a prd
---
```

(`.qwen/skills/bmad-create-prd/SKILL.md:1`)

## Skill Categories

```mermaid
graph TB
    subgraph "BMad Skills Taxonomy"
        A[Product & Discovery] --> A1[bmad-create-prd]
        A --> A2[bmad-product-brief]
        A --> A3[bmad-market-research]
        A --> A4[bmad-domain-research]
        B[Design & UX] --> B1[bmad-create-ux-design]
        B --> B2[bmad-agent-ux-designer]
        C[Architecture] --> C1[bmad-create-architecture]
        C --> C2[bmad-check-implementation-readiness]
        D[Development] --> D1[bmad-dev-story]
        D --> D2[bmad-create-story]
        E[Testing] --> E1[bmad-tea]
        E --> E2[bmad-testarch-atdd]
        E --> E3[bmad-testarch-trace]
        F[Project Mgmt] --> F1[bmad-sprint-planning]
        F --> F2[bmad-retrospective]
        G[Review] --> G1[bmad-code-review]
        G --> G2[bmad-advanced-elicitation]
    end

    style A fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style B fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style C fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style D fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style E fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style F fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style G fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
```
<!-- Sources: _bmad/_config/skill-manifest.csv:1, _bmad/_config/files-manifest.csv:1 -->

## Distribution Model

Skills flow from canonical stores to agent directories through symbolic links:

```mermaid
sequenceDiagram
    autonumber
    participant Canon as .qwen/skills/
    participant Script as resolve_config.py
    participant Agent as .{agent}/skills/
    participant Runtime as Agent Runtime

    Script->>Canon: Read skill-manifest.csv
    Script->>Script: Determine target agents
    Script->>Agent: Create symlinks: ln -s ../../.qwen/skills/X
    Agent->>Runtime: Agent boots, scans skills/
    Runtime->>Agent: Parse SKILL.md frontmatter
    Runtime->>Runtime: Build trigger index
    Runtime->>Agent: Skill available for matching
```
<!-- Sources: _bmad/scripts/resolve_config.py:1, _bmad/_config/skill-manifest.csv:1 -->

## Skill Integrity

External skills (not BMad-native) are tracked in `skills-lock.json`:

```json
{
  "skills": {
    "stripe-best-practices": {
      "source": "docs.stripe.com",
      "sourceType": "well-known",
      "computedHash": "f0aac866fab408c8bf28f3acacbbf61539cea81b3aeb030fceb64be1ccddaf9e"
    }
  }
}
```

(`skills-lock.json:1`)

This enables:
- **Tamper detection**: Hash mismatch indicates modification
- **Provenance tracking**: Source URL for audit trails
- **Update validation**: New versions require explicit hash update

## Skill Manifest

The manifest at `_bmad/_config/skill-manifest.csv` maps skill IDs to directories and metadata:

| Field | Purpose | Example |
|-------|---------|---------|
| `skill_id` | Unique identifier | `bmad-create-prd` |
| `directory` | Relative path | `.qwen/skills/bmad-create-prd` |
| `category` | BMad module | `bmm` or `tea` |
| `agent` | Primary agent persona | `bmad-agent-pm` |

(`_bmad/_config/skill-manifest.csv:1`)

## Adding a New Skill

1. Create directory in `.qwen/skills/{skill-name}/`
2. Write `SKILL.md` with frontmatter, triggers, and instructions
3. Add entry to `_bmad/_config/skill-manifest.csv`
4. Run `python _bmad/scripts/resolve_config.py` to propagate symlinks
5. Commit changes

## Related Pages

- [Architecture](../architecture/index.md) — How skills fit into the system
- [Agent Platforms](../agent-platforms/index.md) — How agents consume skills
- [Setup](../../01-getting-started/setup.md) — Practical skill installation

# System Architecture

Aigency Router v2 follows a **hub-and-spoke distribution model** with a canonical skill store, symlink-based replication, and configuration-driven agent orchestration.

## High-Level Architecture

```mermaid
graph TB
    subgraph "Skill Sources"
        S1[.qwen/skills<br/>53 BMad Skills] -->|canonical| Hub
        S2[.agents/skills<br/>External Skills] -->|canonical| Hub
    end

    Hub["Distribution Hub<br/>_bmad/scripts/resolve_config.py"] -->|symlink| A1[.claude/skills]
    Hub -->|symlink| A2[.cline/skills]
    Hub -->|symlink| A3[.factory/skills]
    Hub -->|symlink| A4[.qoder/skills]
    Hub -->|symlink| A5[.agent/skills]
    Hub -->|symlink| A6[.agents/skills]
    Hub -->|symlink| A7[.goose/skills]
    Hub -->|symlink| A8[...15 more]

    A1 --> U1[Claude Code User]
    A2 --> U2[Cline User]
    A3 --> U3[Factory User]

    style S1 fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style S2 fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Hub fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style A1 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A2 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A3 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A4 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A5 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A6 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A7 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style A8 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
```
<!-- Sources: _bmad/scripts/resolve_config.py:1, _bmad/_config/manifest.yaml:1, config.toml:1 -->

## Component Diagram

```mermaid
graph LR
    subgraph "Configuration Layer"
        C1[config.toml] --> C2[core/config.yaml]
        C1 --> C3[bmm/config.yaml]
        C1 --> C4[tea/config.yaml]
        C5[custom/config.toml] -.override.-> C1
        C6[custom/config.user.toml] -.override.-> C5
    end

    subgraph "Skill Layer"
        S1[SKILL.md files] --> S2[skill-manifest.csv]
        S3[skills-lock.json] --> S4[Integrity Check]
    end

    subgraph "Agent Layer"
        A1[Agent Directories] --> A2[Symlinks]
        A2 --> A3[Runtime Skill Loading]
    end

    C1 --> S2
    S2 --> A2
```
<!-- Sources: _bmad/config.toml:1, _bmad/core/config.yaml:1, _bmad/_config/skill-manifest.csv:1, skills-lock.json:1 -->

## Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as AI Agent (Claude/Cline/etc)
    participant Dir as Agent Skills Directory
    participant Link as Symlink Resolver
    participant Canon as Canonical Skill Store

    User->>Agent: "Run sprint planning"
    Agent->>Dir: Search for matching skill
    Dir->>Link: Resolve symlink
    Link->>Canon: Read .qwen/skills/bmad-sprint-planning/SKILL.md
    Canon-->>Link: Return skill content
    Link-->>Dir: Return resolved content
    Dir-->>Agent: Load skill instructions
    Agent-->>User: Execute sprint planning workflow
```
<!-- Sources: .qwen/skills/bmad-sprint-planning/SKILL.md:1, _bmad/scripts/resolve_config.py:1 -->

## Configuration Resolution Order

```mermaid
graph TD
    Base["_bmad/core/config.yaml<br/>Framework defaults"] --> Merge1
    Merge1["Merge: _bmad/bmm/config.yaml<br/>Module config"] --> Merge2
    Merge2["Merge: _bmad/tea/config.yaml<br/>Module config"] --> Merge3
    Merge3["Merge: _bmad/custom/config.toml<br/>Team overrides"] --> Final
    Final["Merge: _bmad/custom/config.user.toml<br/>Personal overrides"] --> Output
    Output["Resolved Configuration<br/>_bmad/config.toml"]

    style Base fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style Merge1 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Merge2 fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style Merge3 fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style Final fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style Output fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
```
<!-- Sources: _bmad/scripts/resolve_config.py:1, _bmad/core/config.yaml:1, _bmad/custom/config.toml:1 -->

## Key Design Decisions

1. **Symlinks over copies**: Skills are symlinked, not copied, to ensure a single source of truth. (`_bmad/scripts/resolve_config.py:1`)
2. **Agent-agnostic storage**: The canonical store in `.qwen/skills/` is platform-neutral; agents read via symlinks. (`.qwen/skills/bmad-help/SKILL.md:1`)
3. **Hash locking**: External skills (Stripe) are SHA-256 hashed in `skills-lock.json` for supply chain security. (`skills-lock.json:1`)
4. **Layered config**: Configuration merges from framework defaults → module config → team overrides → personal overrides. (`_bmad/custom/config.user.toml:1`)

## Directory Boundary Map

```mermaid
graph TB
    subgraph "Content (Versioned)"
        A[.qwen/skills/]
        B[.agents/skills/]
        C[docs/]
    end

    subgraph "Configuration (Versioned + Local)"
        D[_bmad/custom/config.toml]
        E[_bmad/config.toml]
    end

    subgraph "Generated (Gitignored)"
        F[_bmad-output/]
        G[.wrangler/cache/]
    end

    subgraph "Local Only (Gitignored)"
        H[_bmad/custom/config.user.toml]
        I[.sugar/sugar.log]
    end

    style A fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style B fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style C fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style D fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style E fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style F fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style G fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style H fill:#4a2e2e,stroke:#d45b5b,color:#e0e0e0
    style I fill:#4a2e2e,stroke:#d45b5b,color:#e0e0e0
```
<!-- Sources: .gitignore:1, _bmad/custom/.gitignore:1, _bmad/config.toml:1 -->

## Related Pages

- [Skills System](../skills-system/index.md) — Skill anatomy and distribution mechanics
- [Agent Platforms](../agent-platforms/index.md) — Per-agent integration details
- [BMad Framework](../bmad-framework/index.md) — Module and persona architecture

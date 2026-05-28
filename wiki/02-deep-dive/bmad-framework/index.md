# BMad Framework

The **Business Modeler & Developer (BMad)** framework is the foundational orchestration layer of Aigency Router. It defines agent personas, modules, workflows, and artifact generation for the full software development lifecycle.

## Framework Structure

```mermaid
graph TB
    subgraph "BMad Framework"
        Core[core module] --> BMM
        Core --> TEA

        BMM[bmm module<br/>Planning & Requirements] --> BMM1[PRD Creation]
        BMM --> BMM2[Architecture Design]
        BMM --> BMM3[Story Breaking]
        BMM --> BMM4[Sprint Planning]

        TEA[tea module<br/>Testing & Quality] --> TEA1[Test Strategy]
        TEA --> TEA2[ATDD Workflows]
        TEA --> TEA3[Traceability]
        TEA --> TEA4[Test Automation]
    end

    style Core fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style BMM fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style TEA fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style BMM1 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style BMM2 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style BMM3 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style BMM4 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style TEA1 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style TEA2 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style TEA3 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style TEA4 fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
```
<!-- Sources: _bmad/core/config.yaml:1, _bmad/bmm/config.yaml:1, _bmad/tea/config.yaml:1 -->

## Agent Personas

BMad defines 7 specialized agent personas, each with a name, title, icon, and communication style:

```mermaid
graph LR
    subgraph "BMM Team (Software Development)"
        direction TB
        A[📊 Mary<br/>Business Analyst] --> B[📋 John<br/>Product Manager]
        B --> C[🎨 Sally<br/>UX Designer]
        C --> D[🏗️ Winston<br/>System Architect]
        D --> E[💻 Amelia<br/>Senior Developer]
        E --> F[📚 Paige<br/>Technical Writer]
    end

    subgraph "TEA Team (Software Development)"
        G[🧪 Murat<br/>Test Architect]
    end

    style A fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style B fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style C fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style D fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style E fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style F fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style G fill:#4a2e2e,stroke:#d45b5b,color:#e0e0e0
```
<!-- Sources: config.toml:35-70 -->

### Persona Details

| Persona | Name | Module | Communication Style | Citation |
|---------|------|--------|---------------------|----------|
| Analyst | Mary | BMM | "Treasure hunter narrating the find — thrilled by clues, precise once pattern emerges" | (`config.toml:40-43`) |
| Tech Writer | Paige | BMM | "Patient teacher using analogies that make complex things feel simple" | (`config.toml:45-48`) |
| PM | John | BMM | "Detective interrogating a cold case — short questions, sharper follow-ups" | (`config.toml:50-53`) |
| UX Designer | Sally | BMM | "Filmmaker pitching the scene before code exists, painting user stories" | (`config.toml:55-58`) |
| Architect | Winston | BMM | "Seasoned engineer at whiteboard — measured, laying out trade-offs" | (`config.toml:60-63`) |
| Developer | Amelia | BMM | "Terminal prompt — exact file paths, AC IDs, commit-message brevity" | (`config.toml:65-68`) |
| Test Architect | Murat | TEA | "Risk calculations and impact assessments; strong opinions, weakly held" | (`config.toml:70-73`) |

## Module Configuration

### Core Module

The core module provides framework-wide defaults:
- Project name resolution
- Output folder paths
- Language settings

(`_bmad/core/config.yaml:1`)

### BMM Module

The Business Modeler & Manager module handles planning:
- `planning_artifacts`: `_bmad-output/planning-artifacts`
- `implementation_artifacts`: `_bmad-output/implementation-artifacts`
- `project_knowledge`: `docs/`

(`_bmad/bmm/config.yaml:1`, `_bmad/config.toml:12-15`)

### TEA Module

The Test Engineering & Assurance module handles quality:
- `test_artifacts`: `_bmad-output/test-artifacts`
- `test_stack_type`: `auto`
- `ci_platform`: `auto`
- `risk_threshold`: `p1`
- `tea_use_playwright_utils`: `true`

(`_bmad/tea/config.yaml:1`, `_bmad/config.toml:17-30`)

## Workflow: PRD to Implementation

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant John as John (PM)
    participant Sally as Sally (UX)
    participant Winston as Winston (Architect)
    participant Amelia as Amelia (Dev)
    participant Murat as Murat (Test)

    User->>John: "Create a product"
    John->>John: bmad-create-prd
    John-->>User: PRD document
    User->>Sally: "Design the UX"
    Sally->>Sally: bmad-create-ux-design
    Sally-->>User: UX specifications
    User->>Winston: "Design the architecture"
    Winston->>Winston: bmad-create-architecture
    Winston-->>User: Architecture document
    User->>Amelia: "Implement this story"
    Amelia->>Amelia: bmad-dev-story
    Amelia-->>User: Implemented code
    User->>Murat: "Review test coverage"
    Murat->>Murat: bmad-testarch-trace
    Murat-->>User: Traceability matrix
```
<!-- Sources: .qwen/skills/bmad-create-prd/SKILL.md:1, .qwen/skills/bmad-create-ux-design/SKILL.md:1, .qwen/skills/bmad-create-architecture/SKILL.md:1, .qwen/skills/bmad-dev-story/SKILL.md:1, .qwen/skills/bmad-testarch-trace/SKILL.md:1 -->

## Configuration Resolution

```mermaid
graph TD
    A[core/config.yaml<br/>Defaults] --> B
    B[bmm/config.yaml<br/>Module] --> C
    C[tea/config.yaml<br/>Module] --> D
    D[custom/config.toml<br/>Team] --> E
    E[custom/config.user.toml<br/>Personal] --> F
    F[config.toml<br/>Resolved]

    style A fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
    style B fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style C fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style D fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style E fill:#5a4a2e,stroke:#d4a84b,color:#e0e0e0
    style F fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
```
<!-- Sources: _bmad/scripts/resolve_config.py:1, _bmad/core/config.yaml:1 -->

## Related Pages

- [Skills System](../skills-system/index.md) — How BMad skills are structured
- [Architecture](../architecture/index.md) — System design overview
- [Agent Platforms](../agent-platforms/index.md) — Where personas execute

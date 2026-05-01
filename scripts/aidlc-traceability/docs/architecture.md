<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Architecture Documentation

## System Overview

The AIDLC Traceability Matrix Tool is a Python CLI application that generates traceability matrices from AI-DLC project artifacts. It uses a 6-stage pipeline architecture with optional AI-powered analysis via Amazon Bedrock.

## Pipeline Architecture

```mermaid
flowchart TD
    A[Project Root] --> B[Stage 1: Discovery]
    B --> B1[find_aidlc_docs]
    B --> B2[discover_artifacts]
    B --> B3[discover_source_code]
    
    B1 --> C[Stage 2: Parsing]
    B2 --> C
    B3 --> C
    
    C --> C1[requirements.py]
    C --> C2[stories.py]
    C --> C3[units.py]
    C --> C4[components.py]
    C --> C5[code_plans.py]
    C --> C6[code.py]
    C --> C7[linker.py - Heuristic Links]
    
    C1 --> D{AI Enabled?}
    C2 --> D
    C3 --> D
    C4 --> D
    C5 --> D
    C6 --> D
    C7 --> D
    
    D -->|Yes| E[Stage 3: AI Analysis]
    D -->|No| F[Stage 4: Graph Building]
    
    E --> E1[Req→Story Agent]
    E --> E2[Story→Unit Agent]
    E --> E3[Unit→Component Agent]
    E --> E4[Component→Code Agent]
    
    E1 --> F
    E2 --> F
    E3 --> F
    E4 --> F
    
    F --> G[Stage 5: Coverage Analysis]
    G --> G1[detect_gaps]
    G --> G2[calculate_metrics]
    
    G1 --> H[Stage 6: Report Generation]
    G2 --> H
    
    H --> H1[Markdown Report]
    H --> H2[HTML Report]
```

## Multi-Agent AI Architecture

When AI analysis is enabled, four specialized agents run via Amazon Bedrock (Claude Sonnet):

```mermaid
flowchart LR
    subgraph "Amazon Bedrock"
        M[Claude Sonnet Model]
    end
    
    subgraph "Agent Layer (Strands SDK)"
        A1[Req→Story Agent]
        A2[Story→Unit Agent]
        A3[Unit→Component Agent]
        A4[Component→Code Agent]
    end
    
    subgraph "Artifacts"
        R[Requirements]
        S[Stories]
        U[Units]
        C[Components]
        CO[Code Files]
    end
    
    R --> A1
    S --> A1
    A1 -->|Relationships| G[Graph]
    
    S --> A2
    U --> A2
    A2 -->|Relationships| G
    
    U --> A3
    C --> A3
    A3 -->|Relationships| G
    
    C --> A4
    CO --> A4
    A4 -->|Relationships| G
    
    A1 <--> M
    A2 <--> M
    A3 <--> M
    A4 <--> M
```

Each agent is specialized for its artifact pair, preventing context pollution and enabling focused analysis.

## Data Flow

```mermaid
flowchart LR
    FS[Filesystem<br>aidlc-docs/ + src/] -->|Read-only| P[Parsers]
    P -->|Artifacts + Relationships| GB[Graph Builder<br>NetworkX DiGraph]
    GB --> A[Analysis<br>Gap Detection + Metrics]
    A --> R[Report Generator]
    R -->|Write| O[Output Files<br>.md / .html]
    
    P -.->|Optional| AI[Amazon Bedrock<br>AI Agents]
    AI -.->|Additional Relationships| GB
```

**Key properties:**

- The tool only **reads** project files; it does not modify them
- Reports are written to the local filesystem only
- Amazon Bedrock calls are outbound HTTPS (TLS 1.2+) and only occur when AI is enabled
- No data is persisted between runs

## Component Diagram

```mermaid
graph TB
    subgraph "CLI Layer"
        CLI[cli.py<br>Click Framework]
    end
    
    subgraph "Orchestration"
        PIPE[pipeline.py<br>6-Stage Pipeline]
    end
    
    subgraph "Discovery"
        DISC[discovery.py]
    end
    
    subgraph "Parsers"
        REQ[requirements.py]
        STOR[stories.py]
        UNIT[units.py]
        COMP[components.py]
        CODE[code.py]
        CPLAN[code_plans.py]
        LINK[linker.py]
    end
    
    subgraph "Analysis"
        GRAPH[graph.py<br>NetworkX]
        ANAL[analysis.py]
    end
    
    subgraph "Generation"
        MD[markdown.py]
        HTML[html.py]
    end
    
    subgraph "AI (Optional)"
        AGENT[agent.py<br>Strands SDK]
        BEDROCK[Amazon Bedrock]
    end
    
    CLI --> PIPE
    PIPE --> DISC
    PIPE --> REQ & STOR & UNIT & COMP & CODE & CPLAN & LINK
    PIPE --> GRAPH
    PIPE --> ANAL
    PIPE --> MD & HTML
    PIPE -.-> AGENT
    AGENT -.-> BEDROCK
```

## Technology Stack

| Component | Technology                      | Purpose                                       |
| --------- | ------------------------------- | --------------------------------------------- |
| CLI       | Click                           | Command-line interface                        |
| Models    | Pydantic                        | Data validation and serialization             |
| Graph     | NetworkX                        | Directed graph for traceability relationships |
| AI        | Strands Agents + Amazon Bedrock | Optional relationship discovery               |
| AWS       | boto3                           | Amazon Bedrock API access                     |
| Templates | Jinja2 (available)              | Report template rendering                     |
| Output    | Rich                            | Terminal formatting                           |

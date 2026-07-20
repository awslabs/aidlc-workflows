# AI-DLC Workflow Diagrams

This document contains all Mermaid diagrams that visualize the AI-DLC (AI-Driven Development Life Cycle) methodology. Each section includes a brief explanation followed by a rendered diagram. These diagrams are derived from the engine and conductor (`aidlc-orchestrate.ts` + `SKILL.md`), stage protocol (`stage-protocol.md`), stage files, and agent definitions.

> **Note:** These diagrams are also embedded inline in their relevant reference chapters. This file serves as a consolidated index of all diagrams in one place. `<record>/` in the diagrams below = the active intent's record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`.
>
> - Diagrams 1 and 7: [Architecture](01-architecture.md)
> - Diagram 8: [Orchestrator](03-orchestrator.md) -- Session Management section
> - Diagram 9: [Orchestrator](03-orchestrator.md) -- Scope Routing section
> - Diagram 10: [Knowledge System](10-knowledge-system.md)
> - Diagram 11: [Stage Protocol](04-stage-protocol.md) -- Approval Gates section
> - Diagram 12: [Orchestrator](03-orchestrator.md) -- State Tracking section

---

## 1. End-to-End Lifecycle

The AI-DLC methodology organizes work into five sequential phases. Each phase has a verification gate at its boundary that must pass before the next phase begins. The full lifecycle spans 32 stages across the five phases, with scope determining which stages actually execute.

```mermaid
graph LR
    subgraph INITIALIZATION["INITIALIZATION (0.1-0.3)"]
        Z1["Workspace Scaffold"]
        Z4["State Init"]
        Z1 -.->|"3 stages"| Z4
    end

    subgraph IDEATION["IDEATION (1.1-1.7)"]
        I1["Intent Capture"]
        I7["Approval & Handoff"]
        I1 -.->|"7 stages"| I7
    end

    subgraph INCEPTION["INCEPTION (2.1-2.8)"]
        N1["Reverse Engineering"]
        N7["Delivery Planning"]
        N1 -.->|"8 stages"| N7
    end

    subgraph CONSTRUCTION["CONSTRUCTION (3.1-3.7)"]
        C1["Functional Design"]
        C7["CI Pipeline"]
        C1 -.->|"3.1-3.5 per Bolt; 3.6-3.7 once after all Bolts"| C7
    end

    subgraph OPERATION["OPERATION (4.1-4.7)"]
        O1["Deployment Pipeline"]
        O7["Feedback & Optimization"]
        O1 -.->|"7 stages"| O7
    end

    Z4 -->|"auto-proceed"| I1
    I7 -->|"Verification Gate 1"| N1
    N7 -->|"Verification Gate 2"| C1
    C7 -->|"Verification Gate 3"| O1
    O7 -.->|"Feedback Loop"| I1

    style INITIALIZATION fill:#f3e5f5,stroke:#9c27b0
    style IDEATION fill:#e8f5e9,stroke:#4caf50
    style INCEPTION fill:#e3f2fd,stroke:#2196f3
    style CONSTRUCTION fill:#fff3e0,stroke:#ff9800
    style OPERATION fill:#fce4ec,stroke:#e91e63
```

---

## 2. Ideation Flow

The Ideation phase captures business intent, validates feasibility, defines scope, forms the team, creates rough mockups, and produces an initiative brief for approval. Stages marked ALWAYS execute for every scope; CONDITIONAL stages are skipped for certain scopes (e.g., poc, bugfix, refactor skip Market Research). Solid arrows indicate ALWAYS routing; dashed arrows indicate CONDITIONAL routing.

```mermaid
flowchart TD
    S11["1.1 Intent Capture & Framing\n(aidlc-product-agent)"]
    S12["1.2 Market Research\n(aidlc-product-agent)"]
    S13["1.3 Feasibility & Constraints\n(aidlc-architect-agent)"]
    S14["1.4 Scope Definition\n(aidlc-product-agent)"]
    S15["1.5 Team Formation\n(aidlc-delivery-agent)"]
    S16["1.6 Rough Mockups\n(aidlc-design-agent)"]
    S17["1.7 Approval & Handoff\n(aidlc-delivery-agent)"]
    VG1{{"Verification Gate:\nIdeation --> Inception"}}

    S11 ==>|ALWAYS| S12
    S11 -.->|"skip: poc, bugfix,\nrefactor, infra,\nsecurity-patch"| S14
    S12 -.->|CONDITIONAL| S13
    S12 -.->|"skip if no\nfeasibility needed"| S14
    S13 -.->|CONDITIONAL| S14
    S14 ==>|ALWAYS| S15
    S14 -.->|"skip: poc,\nbugfix, refactor"| S17
    S15 -.->|CONDITIONAL| S16
    S15 -.->|"skip if no UI"| S17
    S16 -.->|CONDITIONAL| S17
    S17 ==>|ALWAYS| VG1

    style S11 fill:#c8e6c9,stroke:#388e3c
    style S14 fill:#c8e6c9,stroke:#388e3c
    style S17 fill:#c8e6c9,stroke:#388e3c
    style S12 fill:#fff9c4,stroke:#f9a825
    style S13 fill:#fff9c4,stroke:#f9a825
    style S15 fill:#fff9c4,stroke:#f9a825
    style S16 fill:#fff9c4,stroke:#f9a825
    style VG1 fill:#ef9a9a,stroke:#c62828
```

---

## 3. Inception Flow

The Inception phase analyzes the codebase (for brownfield projects), discovers team practices, elicits requirements, produces user stories and mockups, designs the application architecture, decomposes into implementation units, and plans delivery. Stage 2.1 (Reverse Engineering) runs as a pipeline (2-link chain) and is shown in a hexagonal shape: first a developer subagent scans the code, then an architect subagent synthesizes the results and writes the artifacts.

```mermaid
flowchart TD
    S21{{"`**2.1 Reverse Engineering**
    (aidlc-developer-agent + aidlc-architect-agent)
    pipeline: 2-link`"}}
    S22a["2.2 Practices Discovery\n(aidlc-pipeline-deploy-agent)"]
    S22["2.3 Requirements Analysis\n(aidlc-product-agent)"]
    S23["2.4 User Stories\n(aidlc-product-agent)"]
    S24["2.5 Refined Mockups\n(aidlc-design-agent)"]
    S25["2.6 Application Design\n(aidlc-architect-agent)"]
    S26["2.7 Units Generation\n(aidlc-architect-agent)"]
    S27["2.8 Delivery Planning\n(aidlc-delivery-agent)"]
    VG2{{"Verification Gate:\nInception --> Construction"}}

    BF_CHECK{"Brownfield?\n(from Initialization 0.3)"}
    BF_CHECK -->|Yes| S21
    BF_CHECK -->|"No (greenfield:\nprompt user)"| S22a
    S21 -.->|CONDITIONAL| S22a
    S22a -.->|CONDITIONAL| S22

    subgraph RE_DETAIL["Two-Link RE Pipeline"]
        direction LR
        DEV_SCAN["Step 1: Developer\nCode Scan"]
        ARCH_SYNTH["Step 2: Architect\nSynthesis"]
        DEV_SCAN --> ARCH_SYNTH
    end

    S21 -.-> RE_DETAIL

    S22 ==>|ALWAYS| S23
    S22 -.->|"skip if no user-facing\nfeatures"| S25
    S23 -.->|CONDITIONAL| S24
    S23 -.->|"skip if no UI\nor mockups skipped"| S25
    S24 -.->|CONDITIONAL| S25
    S25 -.->|CONDITIONAL| S26
    S25 ==>|ALWAYS| S27
    S26 -.->|CONDITIONAL| S27
    S27 ==>|ALWAYS| VG2

    style S21 fill:#bbdefb,stroke:#1565c0
    style S22 fill:#c8e6c9,stroke:#388e3c
    style S27 fill:#c8e6c9,stroke:#388e3c
    style S22a fill:#fff9c4,stroke:#f9a825
    style S23 fill:#fff9c4,stroke:#f9a825
    style S24 fill:#fff9c4,stroke:#f9a825
    style S25 fill:#fff9c4,stroke:#f9a825
    style S26 fill:#fff9c4,stroke:#f9a825
    style VG2 fill:#ef9a9a,stroke:#c62828
    style RE_DETAIL fill:#e8eaf6,stroke:#3f51b5
```

---

## 4. Construction Flow

The Construction phase executes Bolt-by-Bolt per `bolt-plan.md`. Each Bolt covers a coherent slice of one or more Units of Work and runs stages 3.1–3.5 once. The walking-skeleton Bolt always runs first as a single-Bolt batch; subsequent Bolts may run in parallel batches as the dependency graph allows. After the final Bolt, stages 3.6 (Build and Test) and 3.7 (CI Pipeline) run once across all Bolts. Stage 3.5 (Code Generation) runs as a subagent and is shown in a hexagonal shape.

```mermaid
flowchart TD
    START(["Begin Construction"])

    subgraph PER_BOLT["Per-Bolt Loop (walking skeleton first; later Bolts may parallelise)"]
        S31["3.1 Functional Design\n(aidlc-architect-agent)\nCONDITIONAL"]
        S32["3.2 NFR Requirements\n(aidlc-architect-agent)\nCONDITIONAL"]
        S33["3.3 NFR Design\n(aidlc-architect-agent)\nCONDITIONAL"]
        S34["3.4 Infrastructure Design\n(aidlc-aws-platform-agent)\nCONDITIONAL"]
        S35{{"3.5 Code Generation\n(aidlc-developer-agent)\nsubagent: aidlc-developer-agent\nALWAYS per unit in Bolt"}}

        S31 -.-> S32
        S32 -.-> S33
        S33 -.-> S34
        S34 -.-> S35
        S31 -.->|"skip if not\nin plan"| S35
    end

    START --> PER_BOLT
    PER_BOLT -->|"More Bolts?"| PER_BOLT
    PER_BOLT -->|"All Bolts done"| S36

    S36["3.6 Build and Test\n(aidlc-quality-agent)\nALWAYS"]
    S37["3.7 CI Pipeline\n(aidlc-pipeline-deploy-agent)\nCONDITIONAL"]
    VG3{{"Verification Gate:\nConstruction --> Operation"}}

    S36 ==> S37
    S36 -.->|"skip CI if\nnot in scope"| VG3
    S37 -.-> VG3

    style PER_BOLT fill:#fff3e0,stroke:#e65100
    style S35 fill:#bbdefb,stroke:#1565c0
    style S31 fill:#fff9c4,stroke:#f9a825
    style S32 fill:#fff9c4,stroke:#f9a825
    style S33 fill:#fff9c4,stroke:#f9a825
    style S34 fill:#fff9c4,stroke:#f9a825
    style S36 fill:#c8e6c9,stroke:#388e3c
    style S37 fill:#fff9c4,stroke:#f9a825
    style VG3 fill:#ef9a9a,stroke:#c62828
```

---

## 5. Operation Flow

The Operation phase covers deployment, environment provisioning, observability, incident response, performance validation, and feedback. All seven stages are CONDITIONAL (the entire phase may be skipped for poc and bugfix scopes). All stages run inline. Stage 4.7 is the terminal stage; upon approval, the workflow is complete or a new Ideation cycle can begin.

```mermaid
flowchart TD
    S41["4.1 Deployment Pipeline\n(aidlc-pipeline-deploy-agent)"]
    S42["4.2 Environment Provisioning\n(aidlc-aws-platform-agent)"]
    S43["4.3 Deployment Execution\n(aidlc-pipeline-deploy-agent)"]
    S44["4.4 Observability Setup\n(aidlc-operations-agent)"]
    S45["4.5 Incident Response\n(aidlc-operations-agent)"]
    S46["4.6 Performance Validation\n(aidlc-quality-agent)"]
    S47["4.7 Feedback & Optimization\n(aidlc-operations-agent)"]

    S41 -.->|CONDITIONAL| S42
    S42 -.->|CONDITIONAL| S43
    S43 -.->|CONDITIONAL| S44
    S44 -.->|CONDITIONAL| S45
    S45 -.->|CONDITIONAL| S46
    S46 -.->|CONDITIONAL| S47

    S47 -->|"Approve"| DONE(["Workflow Complete"])
    S47 -->|"Start New Cycle"| IDEATION(["Return to Ideation 1.1"])

    style S41 fill:#fce4ec,stroke:#c62828
    style S42 fill:#fce4ec,stroke:#c62828
    style S43 fill:#fce4ec,stroke:#c62828
    style S44 fill:#fce4ec,stroke:#c62828
    style S45 fill:#fce4ec,stroke:#c62828
    style S46 fill:#fce4ec,stroke:#c62828
    style S47 fill:#fce4ec,stroke:#c62828
    style DONE fill:#a5d6a7,stroke:#2e7d32
    style IDEATION fill:#e8f5e9,stroke:#4caf50
```

---

## 6. Agent Collaboration Map

The full 14-agent roster comprises 11 domain agents, 2 review-only agents, and
the adaptive-workflows composer. This diagram intentionally covers the 11
domain agents and their primary artifact flows. The review-only agents perform
independent product and architecture checks, while the composer proposes and
reshapes adaptive stage plans; see the [Agent Reference](agents/README.md) and
[Reviewer Invocation](04-stage-protocol.md#reviewer-invocation).

The conductor (SKILL.md) performs each agent invocation as the engine directs;
agents never invoke each other directly. Information flows between agents
through artifacts stored in the intent's record dir
(`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`). The diagram culminates in
the feedback loop from aidlc-operations-agent back to aidlc-product-agent.

```mermaid
flowchart TD
    ORCH(["SKILL.md (Conductor)"])

    PA["aidlc-product-agent\n(Product Manager)"]
    DA["aidlc-design-agent\n(UX Designer)"]
    DLA["aidlc-delivery-agent\n(Delivery Manager)"]
    AA["aidlc-architect-agent\n(Solutions Architect)"]
    AWSA["aidlc-aws-platform-agent\n(AWS Platform)"]
    CA["aidlc-compliance-agent\n(Compliance)"]
    DSA["aidlc-devsecops-agent\n(DevSecOps)"]
    DEVA["aidlc-developer-agent\n(Developer)"]
    QA["aidlc-quality-agent\n(QA Engineer)"]
    PDA["aidlc-pipeline-deploy-agent\n(Pipeline/Deploy)"]
    OA["aidlc-operations-agent\n(SRE)"]

    ORCH -->|delegates| PA
    ORCH -->|delegates| DA
    ORCH -->|delegates| DLA
    ORCH -->|delegates| AA
    ORCH -->|delegates| AWSA
    ORCH -->|delegates| CA
    ORCH -->|delegates| DSA
    ORCH -->|delegates| DEVA
    ORCH -->|delegates| QA
    ORCH -->|delegates| PDA
    ORCH -->|delegates| OA

    PA -->|"requirements,\nstories, scope"| AA
    PA -->|"intent, scope"| DA
    PA -->|"prioritized backlog"| DLA
    AA -->|"architecture,\nunit specs"| DEVA
    AA -->|"NFR targets"| QA
    AA -->|"infra requirements"| AWSA
    DA -->|"mockups, UX specs"| DEVA
    DEVA -->|"code scan"| AA
    DEVA -->|"code artifacts"| QA
    QA -->|"test results,\nbug reports"| DEVA
    AWSA -->|"provisioned infra"| PDA
    DSA -->|"security review"| DEVA
    DSA -->|"security tests"| QA
    PDA -->|"deployed services"| OA
    CA -->|"compliance constraints"| AA
    DLA -->|"delivery plan"| DEVA
    OA ==>|"feedback loop:\noperational insights"| PA

    style ORCH fill:#e1bee7,stroke:#7b1fa2
    style PA fill:#c8e6c9,stroke:#388e3c
    style OA fill:#fce4ec,stroke:#c62828
    style DEVA fill:#fff3e0,stroke:#e65100
    style AA fill:#bbdefb,stroke:#1565c0
```

---

## 7. Execution Model

This implementation uses four active execution modes for stages. **Inline** stages execute directly within the orchestrator conversation (user can interact). **Subagent** stages delegate to a single agent via the Claude Code Task tool (hub-and-spoke when the stage declares support agents). **Pipeline** stages chain agents sequentially, each link advancing the work product (Reverse Engineering is the shipped example). **Mob** stages convene all support agents in parallel rounds (User Stories is the shipped example).

```mermaid
flowchart LR
    subgraph INLINE["Mode 1: Inline"]
        direction TB
        IN1["Orchestrator reads\nstage file"]
        IN2["Load agent persona\n+ knowledge"]
        IN3["Execute stage steps\ndirectly in conversation"]
        IN4["User interaction\navailable"]
        IN5["Approval gate\n(AskUserQuestion)"]
        IN1 --> IN2 --> IN3 --> IN4 --> IN5
    end

    subgraph SUBAGENT["Mode 2: Subagent (simple)"]
        direction TB
        SA1["Orchestrator reads\nstage file"]
        SA2["Prepare context:\nartifacts + persona"]
        SA3["Task tool call\n(subagent_type specified)"]
        SA4["Subagent executes\n(no user interaction)"]
        SA5["Return structured\nsummary to orchestrator"]
        SA6["Orchestrator presents\ncompletion + approval"]
        SA1 --> SA2 --> SA3 --> SA4 --> SA5 --> SA6
    end

    subgraph TWOSTEP["Mode 3: Pipeline (2-link RE chain)"]
        direction TB
        TS1["Orchestrator reads\nRE stage file"]
        TS2["Task: aidlc-developer-agent\ncode scan"]
        TS3["Developer returns\nscan results"]
        TS4["Task: aidlc-architect-agent\nsynthesis"]
        TS5["Architect produces\n9 artifacts"]
        TS6["Orchestrator presents\ncompletion + approval"]
        TS1 --> TS2 --> TS3 --> TS4 --> TS5 --> TS6
    end

    subgraph MOB["Mode 4: Mob (parallel rounds)"]
        direction TB
        MB1["Orchestrator reads\nstage file"]
        MB2["Lead drafts the\nartifacts inline"]
        MB3["Parallel Tasks: all\nsupport agents, blind"]
        MB4["Each writes its\ncontribution file"]
        MB5["Lead integrates;\nobjection triage\n(judgment -> human,\nknowledge -> round 2)"]
        MB6["Orchestrator presents\ncompletion + approval"]
        MB1 --> MB2 --> MB3 --> MB4 --> MB5 --> MB6
    end

    style INLINE fill:#e8f5e9,stroke:#4caf50
    style SUBAGENT fill:#e3f2fd,stroke:#2196f3
    style TWOSTEP fill:#fff3e0,stroke:#ff9800
    style MOB fill:#f3e5f5,stroke:#9c27b0
```

---

## 8. Session Resume Flow

When the user invokes `/aidlc`, the orchestrator checks for an active intent's `aidlc-state.md`. If found, it offers four resume options. If not found, it births the first intent. The orchestrator also checks for `.aidlc-recovery.md` to detect possible state corruption from context compaction.

```mermaid
flowchart TD
    START(["/aidlc invoked"])
    ARG_CHECK{"Arguments\nprovided?"}
    STATUS_CHECK{"Argument =\n--status?"}
    STATE_EXISTS{"Active intent\nexists?"}
    RECOVERY_CHECK{".aidlc-recovery.md\nexists?"}
    CORRUPTION{"State matches\nrecovery file?"}
    WARN["Warn user about\npossible corruption"]

    RESUME_MENU["AskUserQuestion:\nResume Options"]
    OPT_RESUME["Resume from\nlast checkpoint"]
    OPT_REDO["Redo\ncurrent stage"]
    OPT_JUMP["Jump to\nspecific stage"]
    OPT_FRESH["Start fresh\n(archive existing)"]

    STATUS_DISPLAY["Display read-only\nstatus summary"]
    SCOPE_DETECT{"Known scope\nor freeform text?"}
    KNOWN_SCOPE["Use explicit scope"]
    FREEFORM["Auto-detect scope\nfrom keywords"]
    CONFIRM_SCOPE["Confirm scope\nwith user"]
    BIRTH["Birth the intent:\nmint record dir,\nstate + audit, begin\nfirst stage"]

    START --> ARG_CHECK
    ARG_CHECK -->|Yes| STATUS_CHECK
    ARG_CHECK -->|No| STATE_EXISTS

    STATUS_CHECK -->|Yes| STATUS_DISPLAY
    STATUS_CHECK -->|No| STATE_EXISTS

    STATE_EXISTS -->|Yes| RECOVERY_CHECK
    STATE_EXISTS -->|No| SCOPE_DETECT

    RECOVERY_CHECK -->|Yes| CORRUPTION
    RECOVERY_CHECK -->|No| RESUME_MENU
    CORRUPTION -->|Mismatch| WARN --> RESUME_MENU
    CORRUPTION -->|Match| RESUME_MENU

    RESUME_MENU --> OPT_RESUME
    RESUME_MENU --> OPT_REDO
    RESUME_MENU --> OPT_JUMP
    RESUME_MENU --> OPT_FRESH

    OPT_FRESH -->|"archive + confirm"| BIRTH

    SCOPE_DETECT -->|"Known scope"| KNOWN_SCOPE --> CONFIRM_SCOPE
    SCOPE_DETECT -->|"Freeform text"| FREEFORM --> CONFIRM_SCOPE
    CONFIRM_SCOPE --> BIRTH

    style START fill:#e1bee7,stroke:#7b1fa2
    style RESUME_MENU fill:#bbdefb,stroke:#1565c0
    style BIRTH fill:#c8e6c9,stroke:#388e3c
    style WARN fill:#ffcdd2,stroke:#c62828
```

---

## 9. Scope Routing

> Scope routing table: see [Orchestrator Reference -- Scope Mapping](03-orchestrator.md#scope-to-stage-mapping).

---

## 10. Knowledge Loading Order

Each stage loads knowledge in a strict 6-step order. This ensures guardrails take precedence, followed by shared methodology, then agent-specific knowledge, then team customizations, and finally prior stage artifacts. The sequence diagram below shows the loading order for any stage activation.

> **Note:** Steps 1-5 are agent knowledge loading (defined in each agent file); Step 6 (prior stage artifacts) is context added by the orchestrator at runtime, not a file-loading step.

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant G as Rules
    participant SM as Shared Methodology
    participant AM as Agent Methodology
    participant TK as Team Knowledge
    participant TAK as Team Agent Knowledge
    participant PA as Prior Artifacts

    O->>G: Step 1: Load aidlc/spaces/<active-space>/memory/
    Note over G: org.md + team.md + project.md + phases/<phase>.md
    G-->>O: Rules loaded (strict-additive — all layers present)

    O->>SM: Step 2: Load .claude/knowledge/aidlc-shared/
    Note over SM: Shared methodology principles
    SM-->>O: Shared knowledge loaded

    O->>AM: Step 3: Load .claude/knowledge/[agent-name]/
    Note over AM: Agent-specific methodology
    AM-->>O: Agent methodology loaded

    O->>TK: Step 4: Load aidlc/knowledge/aidlc-shared/
    Note over TK: Team shared knowledge (if exists)
    TK-->>O: Team knowledge loaded

    O->>TAK: Step 5: Load aidlc/knowledge/[agent-name]/
    Note over TAK: Team agent-specific knowledge (if exists)
    TAK-->>O: Team agent knowledge loaded

    O->>PA: Step 6: Load prior stage artifacts
    Note over PA: As required by current stage inputs
    PA-->>O: Prior artifacts loaded

    Note over O: Stage execution begins with full context
```

---

## 11. Approval Gate Flow

Every stage (except the 3 Initialization stages) ends with an approval gate. The orchestrator logs the options to the audit trail before presenting them to the user, then logs the user's response afterward. After 3 revision cycles, an "Accept as-is" escape hatch becomes available. Ideation and Inception stages may also include a conditional third option to add a previously skipped stage.

```mermaid
flowchart TD
    COMPLETE["Stage work complete"]
    AUDIT_PRE["Append to audit.md:\nstage summary + options\n(fresh ISO timestamp)"]
    ASK["AskUserQuestion:\nApproval Gate"]

    APPROVE["Approve"]
    CHANGES["Request Changes"]
    ACCEPT["Accept as-is\n(escape hatch)"]
    ADD_STAGE["Add Skipped Stage\n(Ideation/Inception only)"]

    AUDIT_POST_A["Log: User approved\n(fresh timestamp)"]
    AUDIT_POST_C["Log: User requested changes\n(fresh timestamp)"]
    AUDIT_POST_ACC["Log: User accepted as-is\n(fresh timestamp)"]
    AUDIT_POST_ADD["Log: User added stage\n(fresh timestamp)"]

    REVISION_COUNT{"Revision\ncycle >= 3?"}
    NOTE_2ND["After 2nd revision:\nnote that escape hatch\nactivates next cycle"]

    REPORT_APPROVED["Report approved:\nengine completes + routes"]
    PROGRESS["Display progress line:\nN/total overall"]
    NEXT_STAGE["Proceed to next stage"]

    REVISE["Apply user feedback\nto stage artifacts"]
    RE_PRESENT["Re-present completion\nmessage"]

    ADD_EXEC["Insert skipped stage\ninto workflow"]

    COMPLETE --> AUDIT_PRE --> ASK
    ASK --> APPROVE
    ASK --> CHANGES
    ASK --> ACCEPT
    ASK --> ADD_STAGE

    APPROVE --> AUDIT_POST_A --> REPORT_APPROVED --> PROGRESS --> NEXT_STAGE
    ACCEPT --> AUDIT_POST_ACC --> REPORT_APPROVED

    CHANGES --> AUDIT_POST_C --> REVISION_COUNT
    REVISION_COUNT -->|"< 3"| NOTE_2ND --> REVISE --> RE_PRESENT --> AUDIT_PRE
    REVISION_COUNT -->|">= 3"| REVISE

    ADD_STAGE --> AUDIT_POST_ADD --> ADD_EXEC

    style COMPLETE fill:#e8f5e9,stroke:#388e3c
    style ASK fill:#bbdefb,stroke:#1565c0
    style APPROVE fill:#a5d6a7,stroke:#2e7d32
    style CHANGES fill:#fff9c4,stroke:#f9a825
    style ACCEPT fill:#ffccbc,stroke:#bf360c
    style ADD_STAGE fill:#e1bee7,stroke:#7b1fa2
    style NEXT_STAGE fill:#c8e6c9,stroke:#388e3c
```

---

## 12. State Tracking

The `aidlc-state.md` file tracks each stage with checkbox notation: `[ ]` (not
started), `[-]` (in progress), `[?]` (awaiting approval), `[R]` (revising),
`[x]` (completed), and `[S]` (skipped). The engine owns these transitions;
conductors report outcomes rather than editing checkbox state. The diagram also
shows the side flows for skip, redo, and jump operations.

```mermaid
stateDiagram-v2
    [*] --> NotStarted

    state "[ ] Not Started" as NotStarted
    state "[-] In Progress" as InProgress
    state "[?] Awaiting Approval" as Awaiting
    state "[R] Revising" as Revising
    state "[x] Completed" as Completed
    state "[S] Skipped" as Skipped

    NotStarted --> InProgress : engine route
    InProgress --> Awaiting : report awaiting-approval
    Awaiting --> Completed : report approved
    Awaiting --> Revising : report rejected
    Revising --> Awaiting : report revised

    NotStarted --> Skipped : scope composition
    InProgress --> Skipped : report skipped
    Revising --> Skipped : report skipped

    note right of Skipped
        Task created but immediately
        marked completed with skip reason.
        Description: "Skipped: [reason]"
    end note
```

```mermaid
flowchart TD
    subgraph NORMAL["Normal Flow"]
        direction LR
        NS1["[ ] Not Started"]
        IP1["[-] In Progress"]
        AW1["[?] Awaiting Approval"]
        CO1["[x] Completed"]
        NS1 -->|"engine route"| IP1
        IP1 -->|"report gate open"| AW1
        AW1 -->|"report approved"| CO1
    end

    subgraph SKIP["Skip Flow"]
        direction LR
        NS2["[ ] Not Started"]
        SK2["[S] Skipped"]
        NS2 -->|"scope composition"| SK2
    end

    subgraph REDO["Redo Flow"]
        direction LR
        CO3["[x] Completed\nor [-] In Progress"]
        NS3["[ ] Not Started"]
        IP3["[-] In Progress"]
        CO3 -->|"user requests redo\n(delete artifacts)"| NS3
        NS3 -->|"re-execute stage"| IP3
    end

    subgraph JUMP["Jump Flow"]
        direction LR
        IP4["[-] In Progress\n(stage A)"]
        NS4["[ ] Not Started\n(stage B)"]
        IP4B["[-] In Progress\n(stage B)"]
        IP4 -->|"user requests jump\n(warn about skipped stages)"| NS4
        NS4 -->|"begin target stage"| IP4B
    end

    style NORMAL fill:#e8f5e9,stroke:#4caf50
    style SKIP fill:#fff9c4,stroke:#f9a825
    style REDO fill:#e3f2fd,stroke:#2196f3
    style JUMP fill:#fce4ec,stroke:#e91e63
```

---

## Summary of Execution Modes by Stage

This reference table maps every stage to its execution mode and lead agent for quick lookup.

| Stage | Name | Mode | Lead Agent |
|-------|------|------|------------|
| 0.1 | Workspace Scaffold | inline (auto-proceed) | orchestrator |
| 0.2 | Workspace Detection | inline (auto-proceed, deterministic scanner) | orchestrator |
| 0.3 | State Init | inline (auto-proceed) | orchestrator |
| 1.1 | Intent Capture | inline | aidlc-product-agent |
| 1.2 | Market Research | inline | aidlc-product-agent |
| 1.3 | Feasibility | inline | aidlc-architect-agent |
| 1.4 | Scope Definition | inline | aidlc-product-agent |
| 1.5 | Team Formation | inline | aidlc-delivery-agent |
| 1.6 | Rough Mockups | inline | aidlc-design-agent |
| 1.7 | Approval & Handoff | inline | aidlc-delivery-agent |
| 2.1 | Reverse Engineering | pipeline (2-link) | aidlc-developer-agent + aidlc-architect-agent |
| 2.2 | Practices Discovery | subagent | aidlc-pipeline-deploy-agent |
| 2.3 | Requirements Analysis | inline | aidlc-product-agent |
| 2.4 | User Stories | mob | aidlc-product-agent |
| 2.5 | Refined Mockups | inline | aidlc-design-agent |
| 2.6 | Application Design | inline | aidlc-architect-agent |
| 2.7 | Units Generation | inline | aidlc-architect-agent |
| 2.8 | Delivery Planning | inline | aidlc-delivery-agent |
| 3.1 | Functional Design | inline | aidlc-architect-agent |
| 3.2 | NFR Requirements | inline | aidlc-architect-agent |
| 3.3 | NFR Design | inline | aidlc-architect-agent |
| 3.4 | Infrastructure Design | inline | aidlc-aws-platform-agent |
| 3.5 | Code Generation | subagent (aidlc-developer-agent) | aidlc-developer-agent |
| 3.6 | Build and Test | inline | aidlc-quality-agent |
| 3.7 | CI Pipeline | inline | aidlc-pipeline-deploy-agent |
| 4.1 | Deployment Pipeline | inline | aidlc-pipeline-deploy-agent |
| 4.2 | Environment Provisioning | inline | aidlc-aws-platform-agent |
| 4.3 | Deployment Execution | inline | aidlc-pipeline-deploy-agent |
| 4.4 | Observability Setup | inline | aidlc-operations-agent |
| 4.5 | Incident Response | inline | aidlc-operations-agent |
| 4.6 | Performance Validation | inline | aidlc-quality-agent |
| 4.7 | Feedback & Optimization | inline | aidlc-operations-agent |

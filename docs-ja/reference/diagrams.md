# AI-DLC ワークフロー図

このドキュメントには、AI-DLC（AI-Driven Development Life Cycle）方法論を視覚化したすべての Mermaid 図を収めています。各セクションでは、簡単な説明の後にレンダリング済みの図を示します。これらの図は、エンジンとコンダクター（`aidlc-orchestrate.ts` + `SKILL.md`）、ステージプロトコル（`stage-protocol.md`）、ステージファイル、エージェント定義から導かれています。

> **Note:** これらの図は、関連するリファレンス章にもインラインで埋め込まれています。このファイルは、すべての図を 1 か所にまとめたインデックスとして機能します。以下の図の `<record>/` は、アクティブな intent のレコードディレクトリ `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` を指します。
>
> - 図 1 と 7: [Architecture](01-architecture.md)
> - 図 8: [Orchestrator](03-orchestrator.md) -- Session Management セクション
> - 図 9: [Orchestrator](03-orchestrator.md) -- Scope-to-Stage Mapping セクション
> - 図 10: [Knowledge System](10-knowledge-system.md)
> - 図 11: [Stage Protocol](04-stage-protocol.md) -- Approval Gates セクション
> - 図 12: [Orchestrator](03-orchestrator.md) -- State File Schema セクション

---

## 1. エンドツーエンドのライフサイクル

AI-DLC 方法論は、作業を 5 つの連続したフェーズに整理します。Ideation、Inception、Construction の後の各境界には検証チェックが入り、プランがそれを実行するときに、フェーズを終えるステージ（Approval & Handoff、Delivery Planning、CI Pipeline）が書きます。Initialization はチェックなしで最初のフェーズへ引き渡します。ライフサイクル全体は 5 つのフェーズにまたがる 33 ステージにおよび、どのステージが実際に実行されるかはスコープによって決まります。

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

    subgraph INCEPTION["INCEPTION (2.1-2.9)"]
        N1["Reverse Engineering"]
        N7["Delivery Planning"]
        N1 -.->|"9 stages"| N7
    end

    subgraph CONSTRUCTION["CONSTRUCTION (3.1-3.7)"]
        C1["Functional Design"]
        C7["CI Pipeline"]
        C1 -.->|"3.1–3.5 per Unit in the recorded order; 3.6–3.7 once after all Units"| C7
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

    style INITIALIZATION fill:#f3e5f5,stroke:#9c27b0,color:#000
    style IDEATION fill:#e8f5e9,stroke:#4caf50,color:#000
    style INCEPTION fill:#e3f2fd,stroke:#2196f3,color:#000
    style CONSTRUCTION fill:#fff3e0,stroke:#ff9800,color:#000
    style OPERATION fill:#fce4ec,stroke:#e91e63,color:#000
```

---

## 2. Ideation のフロー

Ideation フェーズでは、ビジネス上の意図を捉え、実現可能性を検証し、スコープを定め、チームを編成し、ラフモックアップを作成し、承認用のイニシアチブブリーフを作ります。ALWAYS と記されたステージは、それを含むすべてのスコープで実行されます。あるスコープがどのステージを含むかは、そのプランで決まります。bugfix、refactor、infra、security-patch、classic、workshop、express は Ideation を実行しません。poc は Intent Capture のみを実行します。mvp は Market Research、Team Formation、Approval & Handoff を省きます。mvp と poc は、Approval & Handoff だけがフェーズチェックを書くため、チェックなしで Ideation を終えます。実線の矢印は ALWAYS のルーティングを、破線の矢印は CONDITIONAL のルーティングを表します。

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

    S11 -.->|"CONDITIONAL\n(enterprise, feature)"| S12
    S11 -.->|"mvp: no 1.2"| S13
    S12 -.->|CONDITIONAL| S13
    S12 -.->|"skip if no\nfeasibility needed"| S14
    S13 -.->|CONDITIONAL| S14
    S14 -.->|"CONDITIONAL\n(enterprise, feature)"| S15
    S14 -.->|"mvp: no 1.5"| S16
    S15 -.->|CONDITIONAL| S16
    S15 -.->|"skip if no UI"| S17
    S16 -.->|CONDITIONAL| S17
    S17 ==>|ALWAYS| VG1

    style S11 fill:#c8e6c9,stroke:#388e3c,color:#000
    style S14 fill:#c8e6c9,stroke:#388e3c,color:#000
    style S17 fill:#c8e6c9,stroke:#388e3c,color:#000
    style S12 fill:#fff9c4,stroke:#f9a825,color:#000
    style S13 fill:#fff9c4,stroke:#f9a825,color:#000
    style S15 fill:#fff9c4,stroke:#f9a825,color:#000
    style S16 fill:#fff9c4,stroke:#f9a825,color:#000
    style VG1 fill:#ef9a9a,stroke:#c62828,color:#000
```

---

## 3. Inception のフロー

Inception フェーズでは、（brownfield プロジェクトの場合）コードベースを分析し、チームの実践を発見し、要件を引き出し、ユーザーストーリーとモックアップを作成し、アプリケーションのアーキテクチャを設計し、実装ユニットへ分解し、デリバリーを計画します。ステージ 2.1（Reverse Engineering）はパイプライン（2 リンクのチェーン）として実行され、六角形で示されます。まず developer サブエージェントがコードをスキャンし、次に architect サブエージェントが結果を統合して成果物を書きます。

```mermaid
flowchart TD
    S21{{"`**2.1 Reverse Engineering**<br/>    (aidlc-developer-agent + aidlc-architect-agent)<br/>    pipeline: 2-link`"}}
    S22a["2.2 Practices Discovery\n(aidlc-pipeline-deploy-agent)"]
    S22["2.3 Requirements Analysis\n(aidlc-product-agent)"]
    S23["2.4 User Stories\n(aidlc-product-agent)"]
    S24["2.5 Refined Mockups\n(aidlc-design-agent)"]
    S25["2.6 Domain Design\n(aidlc-architect-agent)"]
    S26["2.7 Units Generation\n(aidlc-architect-agent)"]
    S28["2.8 Contract Design\n(aidlc-architect-agent)"]
    S27["2.9 Delivery Planning\n(aidlc-delivery-agent)"]
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
    S26 -.->|"if multi-unit"| S28
    S26 -.->|CONDITIONAL| S27
    S28 -.->|CONDITIONAL| S27
    S27 ==>|ALWAYS| VG2

    style S21 fill:#bbdefb,stroke:#1565c0,color:#000
    style S22 fill:#c8e6c9,stroke:#388e3c,color:#000
    style S27 fill:#c8e6c9,stroke:#388e3c,color:#000
    style S22a fill:#fff9c4,stroke:#f9a825,color:#000
    style S23 fill:#fff9c4,stroke:#f9a825,color:#000
    style S24 fill:#fff9c4,stroke:#f9a825,color:#000
    style S25 fill:#fff9c4,stroke:#f9a825,color:#000
    style S26 fill:#fff9c4,stroke:#f9a825,color:#000
    style VG2 fill:#ef9a9a,stroke:#c62828,color:#000
    style RE_DETAIL fill:#e8eaf6,stroke:#3f51b5,color:#000
```

---

## 4. Construction のフロー

次の図は、**新規にソースを生み出す単独 Unit のワークフロー**のデフォルトを示します。ユニットメジャーで、検証済みチェックポイントを伴う直列実行です。最初の DAG Unit は、skeleton-on のとき、動作する統合済みスライスを形成し、後続の Unit の前に本物のエンドツーエンドのチェックと人間の承認を通過しなければなりません。これは、以前の Construction 最初のステージレビューとは異なります。design-only、no-Unit、existing、team-owned の各パスは、記録済みのポリシーを保ちます。明示的な stage-major の選択も引き続き有効です。ランタイムの順序は `unit-of-work-dependency.md` に由来し、`bolt-plan.md` は計画のためのコンテンツです。

対象となる skeleton-off のワークフローは、Construction 入口で **Continue automatically** ／ **Review each checkpoint** を提示します。skeleton-on では、すでに選択が存在しない限り、本物の skeleton チェックポイントの後にそれを提示します。この承認の設定が swarm 実行を選ぶわけではありません。Plan Approval と、有効化されたサマリー確認は人間の停止点のままです。サマリー確認は `directive.ceremony.summary_confirmation === "on"` のときにのみ適用されます。Build and Test とオプションの CI Pipeline は、結果全体に対して一度だけ実行されます。

```mermaid
flowchart TD
    START(["Eligible source-producing solo Unit workflow"])
    NEXT["First or next Unit in DAG order"]
    subgraph PER_UNIT["Applicable work for this Unit"]
        S31["3.1 Functional Design — conditional"]
        S32["3.2 NFR Requirements — conditional"]
        S33["3.3 NFR Design — conditional"]
        S34["3.4 Infrastructure Design — conditional"]
        PLAN{{"Human Plan Approval before generation"}}
        S35{{"3.5 Code Generation<br/>Subagent work for this Unit"}}
        S31 -.-> S32
        S32 -.-> S33
        S33 -.-> S34
        S34 --> PLAN --> S35
        S31 -.->|Design stages skipped| PLAN
    end
    VERIFY["Real project check<br/>End-to-end for the skeleton"]
    CHECKPOINT{{"Verified checkpoint<br/>Skeleton: human approval<br/>Ordinary Unit: recorded completion policy"}}
    MORE{"More Units?"}
    BOOK["Completion-only stage bookkeeping"]
    S36["3.6 Build and Test — once"]
    S37["3.7 CI Pipeline — conditional, once"]
    VG3{{"Construction-to-Operation verification"}}
    START --> NEXT --> PER_UNIT --> VERIFY --> CHECKPOINT --> MORE
    MORE -->|Yes| NEXT
    MORE -->|No| BOOK --> S36
    S36 --> S37 --> VG3
    S36 -.->|CI skipped| VG3
```

<!-- Text fallback: For an eligible new solo workflow, complete each Unit's applicable design and Code Generation stages in DAG order, preserving human Plan Approval and any enabled summary confirmation. Verify the working result and approve its checkpoint: always human for the skeleton, according to recorded policy for ordinary Units. After all Units, settle bookkeeping and run Build and Test plus optional CI Pipeline. Other workflow paths retain their existing policy. -->

---

## 5. Operation のフロー

Operation フェーズは、デプロイ、環境のプロビジョニング、可観測性、インシデント対応、パフォーマンス検証、フィードバックをカバーします。7 つのステージはすべて CONDITIONAL です（mvp と poc のスコープでは、フェーズ全体がスキップされることがあります）。すべてのステージはインラインで実行されます。ステージ 4.7 は終端のステージで、承認されるとワークフローは完了します。

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

    style S41 fill:#fce4ec,stroke:#c62828,color:#000
    style S42 fill:#fce4ec,stroke:#c62828,color:#000
    style S43 fill:#fce4ec,stroke:#c62828,color:#000
    style S44 fill:#fce4ec,stroke:#c62828,color:#000
    style S45 fill:#fce4ec,stroke:#c62828,color:#000
    style S46 fill:#fce4ec,stroke:#c62828,color:#000
    style S47 fill:#fce4ec,stroke:#c62828,color:#000
    style DONE fill:#a5d6a7,stroke:#2e7d32,color:#000
```

---

## 6. エージェント協調マップ

14 エージェントの全ロースターは、11 のドメインエージェント、2 つのレビュー専用エージェント、そして adaptive-workflows のコンポーザーで構成されます。この図は、11 のドメインエージェントとその主要な成果物の流れを意図的に扱っています。レビュー専用のエージェントは独立したプロダクトとアーキテクチャのチェックを行い、コンポーザーは適応的なステージプランを提案して再構成します。[Agent Reference](agents/README.md) と [Reviewer Invocation](04-stage-protocol.md#reviewer-invocation) を参照してください。

コンダクター（SKILL.md）は、エンジンの指示どおりに各エージェントの呼び出しを行います。エージェントどうしが直接呼び出すことはありません。情報は、intent のレコードディレクトリ（`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`）に保存される成果物を通じてエージェント間を流れます。この図は、aidlc-operations-agent から aidlc-product-agent へ戻るフィードバックループで締めくくられます。

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

    style ORCH fill:#e1bee7,stroke:#7b1fa2,color:#000
    style PA fill:#c8e6c9,stroke:#388e3c,color:#000
    style OA fill:#fce4ec,stroke:#c62828,color:#000
    style DEVA fill:#fff3e0,stroke:#e65100,color:#000
    style AA fill:#bbdefb,stroke:#1565c0,color:#000
```

---

## 7. 実行モデル

この実装では、ステージに対して 4 つのアクティブな実行モードを使います。**Inline** のステージは、オーケストレーターの会話内で直接実行されます（ユーザーが対話できます）。**Subagent** のステージは、ハーネスのサブエージェントツール（Claude Code では Task ツール）を通じて単一のエージェントへ委譲し、ステージが支援エージェントを宣言している場合はハブアンドスポークになります。**Pipeline** のステージはエージェントを順に連結し、各リンクが作業成果物を前進させます（Reverse Engineering が出荷済みの例です）。**Mob** のステージは、支援エージェントを区切られたラウンドで集め、各貢献は互いに見えません（ハーネスが一度に複数をディスパッチできるところでは並列に、できないところでは順番に実行します）。User Stories が出荷済みの例です。

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

    style INLINE fill:#e8f5e9,stroke:#4caf50,color:#000
    style SUBAGENT fill:#e3f2fd,stroke:#2196f3,color:#000
    style TWOSTEP fill:#fff3e0,stroke:#ff9800,color:#000
    style MOB fill:#f3e5f5,stroke:#9c27b0,color:#000
```

---

## 8. セッション再開のフロー

ユーザーが `/aidlc` を呼び出すと、オーケストレーターはアクティブな intent の `aidlc-state.md` を確認します。見つかれば、チェックポイントから続行します（最初の呼び出しは `next --resume` です）。やり直し、特定のステージへのジャンプ、最初からのやり直しは、いつでも依頼できます。見つからなければ、最初の intent を作成します。

```mermaid
flowchart TD
    START(["/aidlc invoked"])
    ARG_CHECK{"Arguments\nprovided?"}
    STATUS_CHECK{"Argument =\n--status?"}
    STATE_EXISTS{"Active intent\nexists?"}

    CONTINUE["Carry on from the\ncheckpoint:\nnext --resume"]
    OTHER["Person asks to redo,\njump, or start fresh:\nreport --result resumed"]

    STATUS_DISPLAY["Display read-only\nstatus summary"]
    SCOPE_DETECT{"Known scope\nor freeform text?"}
    KNOWN_SCOPE["Use explicit scope"]
    FREEFORM["Agent proposes\nthe plan"]
    CONFIRM_SCOPE["Confirm scope\nwith user"]
    CREATE["Create the intent:\nmint record dir,\nstate + audit, begin\nfirst stage"]

    START --> ARG_CHECK
    ARG_CHECK -->|Yes| STATUS_CHECK
    ARG_CHECK -->|No| STATE_EXISTS

    STATUS_CHECK -->|Yes| STATUS_DISPLAY
    STATUS_CHECK -->|No| STATE_EXISTS

    STATE_EXISTS -->|Yes| CONTINUE
    STATE_EXISTS -->|No| SCOPE_DETECT

    CONTINUE -.->|"any time"| OTHER
    OTHER -->|"start fresh: confirm"| CREATE

    SCOPE_DETECT -->|"Known scope"| KNOWN_SCOPE --> CONFIRM_SCOPE
    SCOPE_DETECT -->|"Freeform text"| FREEFORM --> CONFIRM_SCOPE
    CONFIRM_SCOPE --> CREATE

    style START fill:#e1bee7,stroke:#7b1fa2,color:#000
    style OTHER fill:#bbdefb,stroke:#1565c0,color:#000
    style CONTINUE fill:#c8e6c9,stroke:#388e3c,color:#000
    style CREATE fill:#c8e6c9,stroke:#388e3c,color:#000
```

---

## 9. スコープのルーティング

> スコープルーティングの表: [Orchestrator Reference -- Scope Mapping](03-orchestrator.md#scope-to-stage-mapping) を参照してください。

---

## 10. 知識のロード順序

各ステージは、厳密な 6 ステップの順序で知識をロードします。これにより、ガードレールが最優先され、続いて共有の方法論、次にエージェント固有の知識、次にチームのカスタマイズ、最後に以前のステージの成果物という順序が確保されます。下のシーケンス図は、任意のステージ起動におけるロード順序を示します。

> **Note:** ステップ 1〜5 は `stage-protocol.md` のセクション 5 で定義されるエージェント知識のロードです。ステップ 6（以前のステージの成果物）は、ファイルのロードステップではなく、ランタイムにオーケストレーターが追加するコンテキストです。インラインのステージ、および mob のインラインリードでは、このステップはリード自身のペルソナ（`lead_persona`）を運び、`inline_context_paths` は支援ペルソナの直後、共有とエージェントの方法論（ステップ 2〜3）の前に、チーム知識（ステップ 4〜5）を並べます。サイズ上限は方法論から先にトリムします。ディスパッチされたエージェントは、下の順序でロードします。

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

    O->>TK: Step 4: Load aidlc/spaces/<active-space>/knowledge/aidlc-shared/
    Note over TK: Team shared knowledge (if exists)
    TK-->>O: Team knowledge loaded

    O->>TAK: Step 5: Load aidlc/spaces/<active-space>/knowledge/[agent-name]/
    Note over TAK: Team agent-specific knowledge (if exists)
    TAK-->>O: Team agent knowledge loaded

    O->>PA: Step 6: Load prior stage artifacts
    Note over PA: As required by current stage inputs
    PA-->>O: Prior artifacts loaded

    Note over O: Stage execution begins with full context
```

---

## 11. 承認ゲートのフロー

各ステージ（3 つの Initialization ステージを除く）は、承認ゲートで終わります。ゲートの監査証跡はレポートが所有します。`report --result awaiting-approval` は、質問が提示される前に保留されたゲート（`STAGE_AWAITING_APPROVAL`）を記録し、`report --result approved|rejected` は応答をそのまま記録します（`GATE_APPROVED`／`GATE_REJECTED`）。決して `aidlc-log.ts decision`／`answer` ではありません。3 回の修正サイクルの後、「Accept as-is」の脱出口が使えるようになります。Ideation と Inception のステージには、以前スキップしたステージを追加するための条件付きの第 3 の選択肢が含まれることもあります。

```mermaid
flowchart TD
    COMPLETE["Stage work complete"]
    REPORT_AWAITING["Report awaiting-approval:\nengine opens gate + emits\nSTAGE_AWAITING_APPROVAL"]
    ASK["AskUserQuestion:\nApproval Gate"]

    APPROVE["Approve"]
    CHANGES["Request Changes"]
    ACCEPT["Accept as-is\n(escape hatch)"]
    ADD_STAGE["Add Skipped Stage\n(Ideation/Inception only)"]

    REVISION_COUNT{"Revision\ncycle >= 3?"}
    NOTE_2ND["After 2nd revision:\nnote that escape hatch\nactivates next cycle"]

    REPORT_APPROVED["Report approved with the reply:\nengine emits GATE_APPROVED,\ncompletes + routes"]
    REPORT_REJECTED["Report rejected with feedback:\nengine emits GATE_REJECTED,\nrecords revising state"]
    REPORT_REVISED["Report revised:\nengine re-opens gate"]
    PROGRESS["Display progress line:\nN of M stages done"]
    NEXT_STAGE["Proceed to next stage"]

    REVISE["Apply user feedback\nto stage artifacts"]
    RE_PRESENT["Re-present completion\nmessage"]

    ADD_EXEC["Insert skipped stage into workflow\n(scope tooling records the change)"]

    COMPLETE --> REPORT_AWAITING --> ASK
    ASK --> APPROVE
    ASK --> CHANGES
    ASK --> ACCEPT
    ASK --> ADD_STAGE

    APPROVE --> REPORT_APPROVED --> PROGRESS --> NEXT_STAGE
    ACCEPT --> REPORT_APPROVED

    CHANGES --> REPORT_REJECTED --> REVISION_COUNT
    REVISION_COUNT -->|"< 3"| NOTE_2ND --> REVISE --> REPORT_REVISED --> RE_PRESENT --> ASK
    REVISION_COUNT -->|">= 3"| REVISE

    ADD_STAGE --> ADD_EXEC

    style COMPLETE fill:#e8f5e9,stroke:#388e3c,color:#000
    style REPORT_AWAITING fill:#e3f2fd,stroke:#1565c0,color:#000
    style ASK fill:#bbdefb,stroke:#1565c0,color:#000
    style APPROVE fill:#a5d6a7,stroke:#2e7d32,color:#000
    style CHANGES fill:#fff9c4,stroke:#f9a825,color:#000
    style REPORT_REJECTED fill:#fff3e0,stroke:#ef6c00,color:#000
    style REPORT_REVISED fill:#e3f2fd,stroke:#1565c0,color:#000
    style ACCEPT fill:#ffccbc,stroke:#bf360c,color:#000
    style ADD_STAGE fill:#e1bee7,stroke:#7b1fa2,color:#000
    style NEXT_STAGE fill:#c8e6c9,stroke:#388e3c,color:#000
```

---

## 12. 状態の追跡

`aidlc-state.md` ファイルは、各ステージをチェックボックス記法で追跡します。`[ ]`（未開始）、`[-]`（進行中）、`[?]`（承認待ち）、`[R]`（修正中）、`[x]`（完了）、`[S]`（スキップ）です。これらの遷移はエンジンが所有します。コンダクターはチェックボックスの状態を編集するのではなく、結果を報告します。この図は、skip、redo、jump の各操作の側方フローも示します。

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
        CO3 -->|"user requests redo\n(state reset, files kept)"| NS3
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

    style NORMAL fill:#e8f5e9,stroke:#4caf50,color:#000
    style SKIP fill:#fff9c4,stroke:#f9a825,color:#000
    style REDO fill:#e3f2fd,stroke:#2196f3,color:#000
    style JUMP fill:#fce4ec,stroke:#e91e63,color:#000
```

---

## ステージ別の実行モード一覧

このリファレンス表は、各ステージを実行モードとリードエージェントに対応づけ、すばやく参照できるようにしたものです。

| ステージ | 名前 | モード | リードエージェント |
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
| 2.6 | Domain Design | inline | aidlc-architect-agent |
| 2.7 | Units Generation | inline | aidlc-architect-agent |
| 2.8 | Contract Design | inline | aidlc-architect-agent |
| 2.9 | Delivery Planning | inline | aidlc-delivery-agent |
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

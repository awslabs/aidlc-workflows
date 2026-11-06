# ビジョンドキュメントの書き方

ビジョンドキュメントは、**何を、誰のために、なぜ作るか**、そして最初のリリースがどこで止まるかを記します。これは新しいワークフローへの主要な入力です。Intent Capture、Scope Definition、Requirements Analysis はこれを基に計画するので、それらが尋ねる質問は、あなたがすでに書いたことの手早い確認になります。

始めるのに必須ではありません。`/aidlc Build a REST API for inventory
management` は完全な依頼です。ビジョンドキュメントが報いるのは、まず複数の人でゴールに合意する必要があるとき、スコープが数文より大きいとき、またはワークショップを進めていて最初の一時間を質問ではなく意思決定に使いたいときです。

技術面の対、つまりスタック、ツール、許可されないものは、
[技術環境ドキュメント](technical-environment-guide.md)です。

---

## AI-DLC に渡す

ドキュメントをプロジェクトに保存し (Markdown かプレーンテキストが最適です)、最初の依頼でそれを名指しします。

```text
/aidlc Read ./vision.md and build what it describes
```

Codex CLI は `/aidlc` の代わりに `$aidlc` を使います。相対パスはプロジェクトルートから解決されます。内容を `<document>` と `</document>` の間に貼り付けたり、PDF や Word ファイルを名指ししたりもできます。それぞれがどう読まれるか、名前が複数のファイルに一致したときに何が起きるかは、
[Starting from an existing document](../02-your-first-workflow.md#starting-from-an-existing-document)
を参照してください。

ワークフローはドキュメントを指示ではなくデータとして扱います。それを基に計画し、すべての承認はあなたが与えるものです。Intent Capture はいずれにせよ質問をします。あなたのドキュメントがすでに答えているものは手早く確認でき、その未解決の問いは早いうちに出てきます。未解決の問いが倉庫ごとの数量についてだけだった短いビジョンドキュメントを Claude Code で走らせたとき、Intent Capture はそれについて自前の質問を一つ加えました (短縮し、罫線文字はプレーンテキストで示し、ラベルの入る場所を示すために質問文の前に `[Product owner]` を加えています)。

```text
 Warehouses
 Q9. [Product owner] Do the internal tools need stock counts per warehouse, or one total per SKU?
 The vision doc leaves this open, and it changes what a "count" means for every SKU.
 > 1. One total per SKU
   2. Per warehouse per SKU
   3. One total now; per-warehouse later
   4. Not yet defined
```

---

## 短い版

ほかに何も書かないとしても、この四つは書いてください。

```text
1. One paragraph saying what you are building and for whom
2. The features in the first release (what is IN scope)
3. What is NOT in the first release
4. Open questions: things you already know are uncertain or undecided
```

未解決の問いは任意ですが価値があります。Intent Capture と Requirements
Analysis はそれらを早いうちに質問へ変えます。そうしないと、その隙間が設計中に不意打ちとして現れます。

### 既存コードベースでの作業向け

```text
1. Current state: one paragraph on what the system does today
2. What we are adding or changing
3. Features IN scope for this piece of work
4. Features OUT of scope for this piece of work
5. What must NOT change: components, APIs or data the new work must not touch
6. Open questions
```

「変えてはならないもの」が最も重要です。Reverse Engineering はあなたの既存コードを読みますが、どの部分が立ち入り禁止かを知っているのはあなただけです。それを記すと、プランはそこから離れたままになります。

---

## 完全な構成

### 1. Executive Summary

三文から五文で。このセクションだけを読む人でも、プロジェクトが何か、誰のためか、なぜ存在するかが分かるはずです。

```markdown
## Executive Summary

[Project Name] is a [type of system or product] that lets [target users]
[core capability]. It addresses [business problem or opportunity] by
[approach or difference]. The expected outcome is [measurable result].
```

例:

```markdown
## Executive Summary

OrderFlow is a web-based order management platform that lets mid-size
retailers track inventory, process customer orders, and manage suppliers in
one place. It addresses the scattered tooling that causes fulfilment delays
and stock mismatches. The expected outcome is a 30% cut in order processing
time and no more manual stock reconciliation.
```

### 2. Business Context

```markdown
## Business Context

### Problem Statement
[The specific business problem. Be concrete: "orders wait two days for a
stock check" says more than "improve efficiency".]

### Business Drivers
[Why now: market pressure, a regulation, a contract, an internal need.]

### Target Users and Stakeholders
| User Type | Description | Primary Need |
|-----------|-------------|--------------|
| [Role] | [Who they are] | [What they need from the system] |

### Business Constraints
[Budget, regulation, organisational policy, deadlines, anything that is not
negotiable.]

### Success Metrics
| Metric | Today | Target | How it is measured |
|--------|-------|--------|--------------------|
| [Metric] | [Baseline] | [Goal] | [Method] |
```

### 3. Full Scope Vision

成熟時に製品がなりうるすべて。この部分は意図的に理想を描きます。これは、作ると約束することなく、最初のリリースがどこへ向かっているかをワークフローが見るのに役立ちます。

```markdown
## Full Scope Vision

### Product Vision Statement
[One sentence or a short paragraph: what the world looks like when the
product is fully realised.]

### Feature Areas
#### Feature Area 1: [Name]
- **Description**: [What this area covers]
- **Key capabilities**: [Capability 1], [Capability 2], [Capability 3]
- **User value**: [Why it matters to users]

### Integration Points
- [System or service]: [purpose of the integration]

### User Journeys
#### Journey 1: [Name]
1. [Step]
2. [Step]
**Outcome**: [What the user achieves]

### Growth and Roadmap (optional)
| Phase | Focus | Timeframe (if known) |
|-------|-------|----------------------|
| First release | [Core scope] | [Target] |
| Phase 2 | [Expansion] | [Target] |
```

### 4. First Release (MVP) Scope

測定可能な価値を届ける、最小の機能のまとまり。ここに挙がっていない機能は、最初のリリースには入りません。

```markdown
## MVP Scope

### Objective
[The one thing the first release must prove or deliver, in one or two
sentences.]

### Success Criteria
- [ ] [Testable criterion]
- [ ] [Testable criterion]

### Features In Scope
| Feature | Description | Why it cannot wait |
|---------|-------------|--------------------|
| [Feature] | [Short description] | [Reason] |

### Features Out of Scope
| Feature | Why it can wait | Target phase |
|---------|-----------------|--------------|
| [Feature] | [Reason] | [Phase 2, 3 or later] |

### Journeys the First Release Supports
#### Journey 1: [Name]
1. [Step]
2. [Step]
**Outcome**: [What the user achieves]
**Simplified compared with the full vision**: [What is missing or reduced]

### Assumptions and Accepted Limits
- **Assumption**: [Statement]. **Risk if wrong**: [Consequence]
- **Accepted limit**: [What is limited on purpose, and why]

### Definition of Done
- [ ] Every in-scope feature built and tested
- [ ] [Project-specific criterion]
- [ ] [Sign-off needed]
```

### 5. Risks, Dependencies and Open Questions

```markdown
## Risks and Dependencies

### Key Risks
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [Risk] | High / Medium / Low | High / Medium / Low | [Plan] |

### External Dependencies
- [Dependency]: [owner], [status]

### Open Questions
- [ ] [Question]
- [ ] [Question]
```

---

## 書き方の指針

すべきこと:

- 具体的で測定可能に。「注文処理時間を 30% 削減」は「速くする」に勝ります。
- 完全なビジョンと最初のリリースを分けて保つ。両者を混ぜると、そうやってスコープがにじみ広がります。
- スコープ外のリストを書く。これはスコープ内のリストと同じだけの価値があります。
- 営業資料のためではなく、チームのために書く。
- 前提を記して、それに異を唱えられるようにする。
- 誰かが実際にテストできる成功基準を与える。

してはならないこと:

- 「世界最高水準」「シームレス」「直感的」のような言葉を、裏付けの数字なしで使う。
- 技術や実装の詳細を並べる。それらは
  [技術環境ドキュメント](technical-environment-guide.md)に属します。
- 最初のリリースのセクションを飛ばす。どのプロジェクトにも出発点となる境界が必要です。
- 読み手が事業を知っていると思い込む。当たり前に思えても、問題の記述を書いてください。

---

## 各セクションの使われ方

| Section | Stage | How it is used |
|---------|-------|----------------|
| Executive Summary | Intent Capture & Framing | The problem, the users and the expected outcome |
| Business Context | Intent Capture & Framing, Requirements Analysis | The questions asked and how deep the requirements go |
| Full Scope Vision | Scope Definition, User Stories, Domain Design | Where the product is heading; personas and components |
| First Release Scope | Scope Definition, Requirements Analysis | The boundary of this piece of work |
| Features In / Out | Requirements Analysis, Units Generation, Code Generation | What gets built in this piece of work |
| Risks and Dependencies | Feasibility & Constraints, NFR Requirements | Risk and constraint assessment |
| Open Questions | Intent Capture & Framing, Requirements Analysis | Asked early as clarifying questions |

これらのステージのどれが動くかは、あなたが承認するプランによります。Express や
Bugfix のプランはそのうちのいくつかだけを動かします。すべてのステージは
[Phases and Stages](../04-phases-and-stages.md)、プランは
[Workflow Profiles](../workflow-profiles.md) を参照してください。

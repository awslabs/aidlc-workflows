# Ideation フェーズ -- stage リファレンス（1.1-1.7）

## フェーズの概要

Ideation フェーズは、AI-DLC ライフサイクルの 5 つのフェーズの 2 番目です。技術的な作業が始まる前に、
intent を捕らえ、実現性を検証し、scope を定義し、承認を確保することで、取り組み全体の土台を築きます。
enterprise と feature では stage 1.1 から 1.7 を実行し、Inception フェーズへの入場を制御する go/no-go の
gate で締めくくります。

7 つの stage の本体はすべて inline で実行され（stage の作業は会話の中で起き、subagent なし）、承認 gate、
質問フォーマット、完了メッセージについて標準の stage-protocol.md に従います。Intent Capture と
Rough Mockups は reviewer、Product Lead も指名します。review が `none` に設定されていない限り、gate の
前に 1 回の advisory パスのために別個の subagent として実行されます。orchestrator は、plan が実行する
stage を順にルーティングします。

**Ideation フェーズの主要な特徴:**

- すべての stage が inline 実行モードを使います（ユーザーとの直接の会話）。
- stage は、intent の record ディレクトリ配下の `<record>/ideation/<stage-name>/` にアーティファクトを生成します。`<record>` は `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` です（`audit/` の shard ディレクトリ、stage ごとの `memory.md`、verification レポートは同じ record ディレクトリ配下にあります）。
- Stage 1.1 を除くすべての stage は、以前の stage の出力に依存します。
- Stage 1.7 は、それを実行する scope（enterprise と feature）で、Inception へ hand-off する前にフェーズ境界の検証チェックを実行します。
- Intent Capture、Scope Definition、Approval & Handoff は ALWAYS の stage で、他の 4 つは CONDITIONAL です。ALWAYS は、その stage を含む scope の中で成り立ちます。mvp は Approval & Handoff を実行せず、poc は Intent Capture だけを実行します。

**scope 駆動の stage 包含:**

scope のコンパイル済みの plan は、その stage を順に一覧します。mvp では、Ideation は Rough Mockups で
終わり、その承認、または該当しないときに記録されるその skip が、Inception へ hand-off します（出力は
切り詰めています）。

```text
$ aidlc engine graph scope mvp
workspace-scaffold
workspace-detection
state-init
intent-capture
feasibility
scope-definition
rough-mockups
reverse-engineering
practices-discovery
requirements-analysis
...
```

| Scope            | 含まれる stage                             |
|------------------|---------------------------------------------|
| enterprise       | 1.1-1.7 すべて                                |
| feature          | 1.1-1.7 すべて                                |
| mvp              | 1.1, 1.3, 1.4, 1.6                          |
| poc              | 1.1（最小限）                               |
| bugfix           | なし（Ideation を完全に skip）            |
| refactor         | なし（Ideation を完全に skip）            |
| infra            | なし（Ideation を完全に skip）            |
| security-patch   | なし（Ideation を完全に skip）            |
| classic          | なし（Ideation を完全に skip）            |
| workshop         | なし（Ideation を完全に skip）            |
| express          | なし（Ideation を完全に skip）            |

---

## stage 要約テーブル

| Stage | Name                        | Condition   | Lead Agent      | Support Agents                              | Mode   |
|-------|-----------------------------|-------------|-----------------|---------------------------------------------|--------|
| 1.1   | Intent Capture & Framing    | ALWAYS      | aidlc-product-agent   | aidlc-architect-agent                             | inline |
| 1.2   | Market Research             | CONDITIONAL | aidlc-product-agent   | --                                          | inline |
| 1.3   | Feasibility & Constraints   | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent, aidlc-compliance-agent        | inline |
| 1.4   | Scope Definition            | ALWAYS      | aidlc-product-agent   | aidlc-delivery-agent                              | inline |
| 1.5   | Team Formation              | CONDITIONAL | aidlc-delivery-agent  | --                                          | inline |
| 1.6   | Rough Mockups               | CONDITIONAL | aidlc-design-agent    | aidlc-product-agent                               | inline |
| 1.7   | Approval & Handoff          | ALWAYS      | aidlc-delivery-agent  | aidlc-product-agent                               | inline |

---

## Stage 1.1: Intent Capture & Framing

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.1                                                                    |
| Condition        | ALWAYS -- Ideation を実行するすべての scope の最初の stage（enterprise、feature、mvp、poc） |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-architect-agent（技術的な文脈）                                    |
| Reviewer         | aidlc-product-lead-agent（source-grounding と product-quality のレビュー）       |
| Mode             | inline                                                                 |
| Completion Emoji | :bulb:                                                                 |

### 目的

Intent Capture は、Ideation を実行するすべての scope の最初の stage です。ビジネス上の問題を捕らえ、
ステークホルダーを特定し、成功指標を確立します。プロジェクトタイプ（greenfield か brownfield か）は、
既に Workspace Detection が設定しています。結果として得られる intent 記述とステークホルダーマップが、
すべての下流 stage が構築する土台になります。

その人自身の作業の説明が種です。stage は `project-description` ユーティリティでそれを読むため、
リクエストを再び尋ねることはありません。

### Inputs

- `project-description` ユーティリティからの権威あるプロジェクト説明（`$ARGUMENTS` や監査の `Request` から決して再構築されない）、そしてその人が指名した文書を `document-input` を通して読んだもの
- 以前のセッションからの既存の `<record>/` アーティファクト（あれば）
- `aidlc/spaces/<active-space>/memory/` からのガードレール

### Steps

1. **先行コンテキストを読み込む** -- `project-description` からプロジェクト説明を読む（指名された文書は `document-input` を通して）。既存のアーティファクトを確認する。ガードレールを読み込む。
2. **明確化の質問を生成する** -- `<record>/ideation/intent-capture/intent-capture-questions.md` を、初期説明、ワークフローが選んだ scope、使われた active-memory の rule を記す `## Sources` レジスタとともに作成する。ビジネス上の問題、顧客、成功指標、取り組みのトリガー、ステークホルダー、決定権限、コミュニケーションのニーズ、この最初の版が除外するものについて尋ねる（ワークフローが選んだ scope は、選択済みとして述べられ、決して再び尋ねられない）。A-E の選択肢（Claude Code では A-D）に X（Other）を加えた `[Answer]:` タグ形式を使う。tri-mode の質問フローを提示する。
3. **回答を集めて分析する** -- すべてのタグが埋まったか確認する。曖昧さ/矛盾の分析を実行する。
4. **grounded なアーティファクトを生成する** -- intent 記述とステークホルダーマップを生成する。実質的な各段落、リスト項目、表のデータ行は、インラインの `[desc]`、`[scope]`、`[Q<n>]`、`[memory:<id>]`、`[assumption]` のタグを持つ。両方のファイルが `## Assumptions & Open Questions` を含む。
5. **assumption を解決する** -- いずれかのアーティファクトが assumption を保持しているなら、ユーザーにそれを受け入れるか、フォローアップの質問に変換するか尋ねる。受け入れは assumption のラベルを保つ。主張を事実に昇格させない。
6. **完了を準備する** -- Product Lead の review を実行し、両方のアーティファクトを検証し、gate の結果を `aidlc-orchestrate.ts` を通して報告する。
7. **完了を提示し承認を求める** -- 標準の 2 選択肢 gate。

### Outputs

| ファイル                          | 内容                                                      |
|-------------------------------|---------------------------------------------------------------|
| `intent-statement.md`         | ソースタグ付きの Problem Statement、Target Customer、Success Metrics、Initiative Trigger、ワークフロー選択対ユーザー確認の Initial Scope Signal。必須の assumptions セクション |
| `stakeholder-map.md`          | ソースタグ付きのステークホルダーと関心、決定者対影響者、コミュニケーション要件。必須の assumptions セクション |
| `intent-capture-questions.md` | 許可されたソースのレジスタ、`[Answer]:` タグ付きの明確化の質問、必要なときの assumption confirmation |

### Notes

- Ideation を実行するすべての scope の最初の stage。その人の入力以外に先行アーティファクトはありません。
- `project-description` を通して読まれるその人の説明が、種のコンテキストです。
- 選ばれなかった選択肢は、除外でも要件でもありません。サポートされない内容は、省かれるか、フォローアップで引き出されるか、明示的な assumption としてのみ保持されます。
- intent 記述は、以後のすべての Ideation stage に送られ、Inception へ引き継がれます。

---

## Stage 1.2: Market Research & Competitive Analysis

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.2                                                                    |
| Condition        | CONDITIONAL -- 内部ツール、バグ修正、リファクタでは skip           |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | (none)                                                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :bar_chart:                                                            |

### 目的

外部の競合状況に照らして取り組みを検証します。競合分析、市場トレンド、build-vs-buy の評価、差別化戦略を生成します。

### Inputs

- Stage 1.1 からの intent 記述

### Outputs

| ファイル                            | 内容                                                    |
|---------------------------------|-------------------------------------------------------------|
| `competitive-analysis.md`       | 競合状況、競合のプロファイル、強み/弱み |
| `market-trends.md`              | 業界トレンド、規制の変化、市場規模             |
| `build-vs-buy.md`               | build-vs-buy-vs-partner の評価                          |
| `market-research-questions.md`  | `[Answer]:` タグ付きの明確化の質問                  |

### Notes

- skip の条件: 内部ツール、バグ修正、リファクタ。出荷された scope では enterprise と feature でのみ実行されます。
- Stage 1.3 Feasibility と Stage 1.7 Approval & Handoff に送られます。

---

## Stage 1.3: Feasibility & Constraint Analysis

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.3                                                                    |
| Condition        | CONDITIONAL -- 些細な変更では skip。技術的リスクやコンプライアンスのニーズには実行 |
| Lead Agent       | aidlc-architect-agent（技術的な実現性）                                |
| Support Agents   | aidlc-aws-platform-agent（AWS の状況）、aidlc-compliance-agent（規制のスキャン） |
| Mode             | inline                                                                  |
| Completion Emoji | :test_tube:                                                            |

### 目的

技術的な実行可能性を評価し、制約を特定し、RAID ログ（Risks、Assumptions、Issues、Dependencies）を確立します。マルチエージェントの stage です。architect が lead し、その後 aws-platform と compliance が入力を提供します。

### Inputs

- Stage 1.1 からの intent 記述
- Stage 1.2 からの market research（実行された場合）

### Outputs

| ファイル                         | 内容                                                       |
|------------------------------|----------------------------------------------------------------|
| `feasibility-assessment.md`  | 技術的な実行可能性、リスク分析                             |
| `constraint-register.md`     | 技術的、組織的、規制上の制約          |
| `raid-log.md`                | Risks、Assumptions、Issues、Dependencies                       |
| `feasibility-questions.md`   | `[Answer]:` タグ付きの明確化の質問                     |

### Notes

- mvp は、他のすべての mvp stage と同じく、scope の Standard 深度でこれを実行します。
- マルチエージェントのパターン: orchestrator はまず lead agent を実行し、その後 lead の出力をコンテキストとして support agent を実行します。

---

## Stage 1.4: Scope Definition & Prioritization

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.4                                                                    |
| Condition        | ALWAYS -- 深度は scope に適応する                                        |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-delivery-agent（キャパシティの現実チェック）                                |
| Mode             | inline                                                                 |
| Completion Emoji | :dart:                                                                 |

### 目的

scope の境界を確立します。MoSCoW、WSJF、RICE の優先順位づけと value stream map を使って、優先順位づけされた intent backlog（proto-units of work）を生成します。

### Inputs

- Stage 1.1 からの intent 記述
- Stage 1.3 からの feasibility assessment と constraint register（存在する場合）

### Outputs

| ファイル                              | 内容                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `scope-document.md`               | in/out scope の境界定義                          |
| `intent-backlog.md`               | proto-unit の優先順位づけされた backlog（MoSCoW/WSJF/RICE）    |
| `scope-definition-questions.md`   | `[Answer]:` タグ付きの明確化の質問                |

### Notes

- enterprise、feature、mvp で実行されます。深度は scope に従います。
- scope ドキュメントは、プロジェクト全体の権威ある境界になります。

---

## Stage 1.5: Team Formation & Mob Planning

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.5                                                                    |
| Condition        | CONDITIONAL -- 単独の開発者や小規模チームのプロジェクトでは skip          |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Mode             | inline                                                                 |
| Completion Emoji | :people_holding_hands:                                                 |

### 目的

チームの可用性を評価し、スキルを対応づけ、ギャップを特定し、mob 構成計画を生成します。

### Inputs

- Stage 1.4 からの scope ドキュメントと intent backlog
- Stage 1.3 からの feasibility assessment（存在する場合）

### Outputs

| ファイル                            | 内容                                                    |
|---------------------------------|-------------------------------------------------------------|
| `team-assessment.md`            | チームの可用性、RACI マトリクス、キャパシティ配分         |
| `skill-matrix.md`               | 必要対利用可能なスキル、ギャップ分析                 |
| `mob-composition.md`            | mob 構成計画、チームトポロジー                         |
| `team-formation-questions.md`   | `[Answer]:` タグ付きの明確化の質問                  |

### Notes

- skip の条件: 単独の開発者や小規模チームのプロジェクト。出荷された scope では enterprise と feature でのみ実行されます。
- Stage 2.9 Delivery Planning に送られます。

---

## Stage 1.6: Rough Mockups & Concept Visualization

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.6                                                                    |
| Condition        | CONDITIONAL -- 非 UI、API のみ、インフラのみでは skip       |
| Lead Agent       | aidlc-design-agent                                                           |
| Support Agents   | aidlc-product-agent（intent に照らして検証）                               |
| Reviewer         | aidlc-product-lead-agent（advisory）                                    |
| Mode             | inline                                                                 |
| Completion Emoji | :pencil2:                                                              |

### 目的

初期のコンセプトの可視化を生成します。UI 向け: 低忠実度のワイヤフレームとユーザーフロー図。非 UI 向け: システムコンテキスト図とインタラクションフローのスケッチ。すべての図は stage-protocol.md の ASCII 標準に従います。

### Inputs

- Stage 1.1 からの intent 記述
- Stage 1.4 からの scope ドキュメントと intent backlog

### Outputs

| ファイル                          | 内容                                                       |
|-------------------------------|----------------------------------------------------------------|
| `wireframes.md`               | 低忠実度のワイヤフレーム（UI）またはシステムコンテキスト図（非 UI） |
| `user-flow.md`                | コアなユーザーフロー図（UI）またはインタラクションフローのスケッチ（非 UI） |
| `rough-mockups-questions.md`  | `[Answer]:` タグ付きの明確化の質問                     |

### Notes

- skip の条件: 非 UI、API のみ、インフラのみの取り組み。
- Inception の Stage 2.5 Refined Mockups に送られます（その stage も実行される場合）。

---

## Stage 1.7: Initiative Approval & Handoff

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.7                                                                    |
| Condition        | ALWAYS -- Inception の前の最終 Ideation gate（enterprise、feature）   |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Support Agents   | aidlc-product-agent（完全性を検証）                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :white_check_mark:                                                     |

### 目的

すべての Ideation アーティファクトを 1 つの initiative brief にまとめ、すべての判断を記録し、フェーズ境界の検証を実行し、go/no-go の gate を提示します。

### Inputs

stage 1.1-1.6 からのすべての Ideation フェーズのアーティファクト。

### Steps

1. aidlc-delivery-agent の persona と知識を読み込む。
2. Ideation フェーズのアーティファクトをすべて読む。
3. 承認質問を生成する。
4. initiative brief をまとめる（すべての出力を結合した 1 ページ）。
5. フェーズ境界の検証（Intent -> Scope -> Intent Backlog の整合性）。
6. hand-off とフェーズ境界のアーティファクトを検証する。ライフサイクル state を直接編集しない。
7. 2 選択肢の承認 gate を提示する。承認時、engine が stage を完了し Inception へアトミックに遷移するよう、結果を報告する。

### Outputs

| ファイル                              | 内容                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `initiative-brief.md`             | すべての Ideation 出力を結合した 1 ページの要約           |
| `decision-log.md`                 | Ideation 中に行われたすべての判断の記録              |
| `approval-handoff-questions.md`   | `[Answer]:` タグ付きの承認質問                  |

フェーズ境界の検証:

| ファイル                                          | 内容                                    |
|-----------------------------------------------|---------------------------------------------|
| `<record>/verification/phase-check-ideation.md` | Ideation から Inception へのトレーサビリティチェック |

### 承認 Gate

標準の 2 選択肢 gate:

- **Approve** -- Inception フェーズへ進む
- **Request Changes** -- 改訂のフィードバックを提供する

### Notes

- フェーズ境界の stage。stage-protocol の governance に従って検証を実行します。
- initiative brief は、Ideation フェーズ全体のエグゼクティブサマリとして働きます。

---

## フェーズの要約

### 主要な出力

1. **Intent Statement**（1.1）-- 問題記述、対象顧客、成功指標、取り組みのトリガー、初期 scope シグナル。
2. **Stakeholder Map**（1.1）-- 主要なステークホルダー、決定者、コミュニケーション要件。
3. **Competitive Analysis**（1.2）-- 市場のポジショニング、build-vs-buy（該当する場合）。
4. **Feasibility Assessment and RAID Log**（1.3）-- 技術的な実行可能性、リスクレジスタ、制約（該当する場合）。
5. **Scope Document and Intent Backlog**（1.4）-- 権威ある scope の境界、優先順位づけされた proto-unit の一覧。
6. **Team Plan**（1.5）-- スキルマトリクス、mob 構成、キャパシティ配分（該当する場合）。
7. **Concept Mockups**（1.6）-- ワイヤフレーム/ユーザーフロー、またはシステムコンテキスト図（該当する場合）。
8. **Initiative Brief**（1.7）-- すべての Ideation 出力を統合したエグゼクティブ 1 ページ。
9. **Phase Boundary Verification**（1.7）-- トレーサビリティチェックの結果。

### Inception への hand-off

plan が実行する最後の Ideation stage（enterprise と feature では 1.7、mvp では 1.6（承認されたか skip
として記録されたかを問わない）、poc では 1.1）の承認時、フレームワークは Inception フェーズへ遷移します。
Inception は、brownfield の作業では Stage 2.1 Reverse Engineering で始まります。greenfield の作業では、
enterprise、feature、mvp では Stage 2.2 Practices Discovery で、poc では Stage 2.3 Requirements Analysis で
始まり、poc は Practices Discovery を実行しません。

## 相互参照

- [Orchestrator](../03-orchestrator.md) -- ルーティングロジック、scope から stage への対応づけ
- [Stage Protocol](../04-stage-protocol.md) -- 承認 gate、質問フォーマット、フェーズ境界の検証
- [Inception Stages](inception.md) -- 次のフェーズ
- [Initialization Stages](initialization.md) -- 前のフェーズ

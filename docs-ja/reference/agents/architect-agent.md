# aidlc-architect-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-architect-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

aidlc-architect-agent は中心的な設計権限で、ライフサイクルの3つの phase にまたがる、最もアーキテクチャ的に複雑な推論タスクを扱います。他の7つの高判断 agent とともに `judgment` tier を持ちます。3つの `templated` agent（delivery、pipeline-deploy、operations）は、主にテンプレートに従った計画、CI/CD、runbook の出力を生成します。

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| feasibility | Feasibility and Constraint Analysis | 技術的な実現可能性を評価し、統合の制約を特定し、制約レジスタとリスク評価を生成する |
| domain-design | Domain Design | システムアーキテクチャを設計する。bounded context、コンポーネントのインターフェース、アーキテクチャスタイルの選択、ADR |
| units-generation | Units Generation | ドメイン設計を、境界と依存の DAG を持つ実装可能な Units of Work に分解する。経済的な順序付け（何を最初に出すか、なぜか）は delivery-planning stage の判断 |
| contract-design | Contract Design | Unit 間の正式な contract と公開 API を定義する。各境界をどのデータが、どの形とプロトコルで越えるか、障害時の振る舞い、統合の仕組み、contract の所有 |
| functional-design | Functional Design | 詳細なドメインモデル、シーケンス図、API 仕様、データモデル、状態遷移を作成する |
| nfr-requirements | NFR Requirements | 非機能要件を、パフォーマンス、セキュリティ、スケーラビリティ、信頼性、可観測性の測定可能な目標とともに列挙する |
| nfr-design | NFR Design | NFR の技術的なアプローチを設計する。キャッシュ、サーキットブレーカー、レジリエンス、セキュリティアーキテクチャ、可観測性 |

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| intent-capture | Intent Capture and Framing | キャプチャされた intent に対して技術的な文脈と実現可能性の視点を提供する |
| reverse-engineering | Reverse Engineering（ディスパッチされた最終パイプラインのリンク） | aidlc-developer-agent からコードスキャンの結果を受け取り、一貫したアーキテクチャモデルに合成する |
| delivery-planning | Delivery Planning | ビルド順をアーキテクチャの依存とコンポーネントの結合に照らして検証する |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-product-agent | 要件、ユーザーストーリー、intent のバックログ |
| aidlc-developer-agent | reverse engineering の合成のためのコードスキャン結果 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-developer-agent | Unit of work の仕様、API contract、設計パターン |
| aidlc-quality-agent | テストの境界、検証のための NFR 目標 |
| aidlc-aws-platform-agent | ドメイン設計から導かれるインフラ要件 |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-architect-agent/`

| ファイル | 内容 |
|------|---------|
| adr-template.md | Architecture Decision Record のテンプレートと例 |
| architecture-guide.md | アーキテクチャのメソドロジーと設計プロセス |
| architecture-patterns.md | アーキテクチャスタイルのパターン（microservices、modular monolith、event-driven、serverless） |
| ddd-patterns.md | ドメイン駆動設計のパターン（bounded context、aggregate、entity、value object） |
| nfr-design-guide.md | 非機能要件の設計メソドロジー |
| nfr-design-patterns.md | NFR 実装の技術パターン（キャッシュ、サーキットブレーカー、レジリエンス） |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-architect-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存のアーキテクチャ図、テクノロジーレーダー、承認されたパターン、制約レジスタのような、プロジェクト固有のアーキテクチャの文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-architect-agent](../../guide/agents/architect-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-architect-agent.md`](../../../core/agents/aidlc-architect-agent.md)

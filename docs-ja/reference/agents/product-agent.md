# aidlc-product-agent -- 技術リファレンス

## 識別情報

| フィールド | 値 |
|-------|-------|
| 名前 | aidlc-product-agent |
| ティア | **judgment** |
| Claude Code ツール | セッションのツールセット全体を継承し、MCP ツールも含みます（`tools:` の許可リストはありません）。Read、Edit、Write、Glob、Grep、WebSearch、AskUserQuestion の利用が想定されています |
| 禁止されている Claude Code ツール | Task |

---

## ステージの所有

### リードするステージ

| ステージ | 名前 | このエージェントの役割 |
|-------|------|----------------------|
| intent-capture | Intent Capture and Framing | ステークホルダーの入力から、ビジネス上の意図、課題の記述、成功指標、初期の制約を捉えます |
| market-research | Market Research and Competitive Analysis | 競合状況、市場トレンド、内製と購入のトレードオフ、差別化の機会を調査します |
| scope-definition | Scope Definition and Prioritization | スコープの境界（内側／外側）を定め、優先順位付けのフレームワークを適用し、Intent Backlog を作成します |
| requirements-analysis | Requirements Analysis | Ideation の成果物から要件を構造化・形式化し、追跡可能でテスト可能な仕様にします |
| user-stories | User Stories | 要件を、ペルソナ・受け入れ基準・依存関係のマッピングを備えた INVEST 準拠のユーザーストーリーへと変換します |

### 支援するステージ

| ステージ | 名前 | このエージェントの貢献 |
|-------|------|-----------------------------|
| rough-mockups | Rough Mockups and Concept Visualization | ワイヤフレームを、捉えた意図とユーザーのニーズに照らして検証します |
| approval-handoff | Initiative Approval and Handoff | フェーズ移行の前に、イニシアチブのブリーフが完全かどうかを検証します |
| refined-mockups | Refined Mockups and UX Design | 洗練されたデザインを、ユーザーストーリーと受け入れ基準に照らして検証します |

---

## 協調のパターン

### 受け取る相手

| 送り元 | 成果物 |
|--------|-----------|
| ユーザー／ステークホルダーの入力 | 生のビジネスニーズ、ドメイン知識、プロジェクトの説明 |
| 既存のドキュメント | 以前の成果物、レガシーシステムのドキュメント |
| aidlc-operations-agent | 次の Ideation サイクルに向けた本番環境からの運用フィードバック（ライフサイクルのループを閉じます） |

### 引き渡す相手

| 送り先 | 成果物 |
|--------|-----------|
| aidlc-architect-agent | システム設計と分解のために検証済みの要件 |
| aidlc-developer-agent | コード生成のためのストーリー仕様 |
| aidlc-quality-agent | テストケース設計のための受け入れ基準 |
| aidlc-delivery-agent | デリバリー計画のための優先順位付け済みバックログ |

---

## 知識ソース

### 方法論（Tier 1）

パス: `.claude/knowledge/aidlc-product-agent/`

| ファイル | 内容 |
|------|---------|
| corner-checklist.md | 要件を書く／レビューするときにコンポーネントごとに洗い出すエッジ条件（空、欠落、部分的な失敗、1 つの事実が 2 か所にある、など） |
| functional-design-guide.md | 機能設計の方法論 |
| market-research-methods.md | 市場調査の手法とテンプレート |
| prioritization-frameworks.md | MoSCoW、WSJF、RICE、Kano の各フレームワーク |
| product-guide.md | プロダクトマネジメントの方法論 |
| requirements-elicitation.md | 要件収集の手法 |
| requirements-guide.md | 要件分析の方法論 |
| user-story-patterns.md | INVEST 基準、ストーリーのパターン、受け入れ基準のテンプレート |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-product-agent/`（スペースレベルの知識ディレクトリで、ユーザーが管理します）

チームがコンテンツを持ったときに作成する、スペースレベルのディレクトリです（エンジンはスペースの `knowledge/` フォルダを空の状態で作成します）。既存のペルソナ、市場調査、ドメインの用語集、ステークホルダーとのコミュニケーションの好みといった、プロジェクト固有のプロダクト知識がチームによって書き込まれます。

---

## 相互参照

- [エージェントリファレンス概要](README.md)
- [エージェントガイド: aidlc-product-agent](../../guide/agents/product-agent.md)
- [ステージのドキュメント](../04-stages/)
- 原本のソース: [`core/agents/aidlc-product-agent.md`](../../../core/agents/aidlc-product-agent.md)

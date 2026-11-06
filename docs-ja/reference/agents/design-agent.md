# aidlc-design-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-design-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、WebSearch、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| rough-mockups | Rough Mockups and Concept Visualization | Ideation の間に、低忠実度のワイヤーフレーム、コンセプトのスケッチ、初期の情報アーキテクチャを作成する |
| refined-mockups | Refined Mockups and UX Design | ワイヤーフレームを、インタラクション仕様、レスポンシブデザイン、アクセシビリティの注釈を伴う中〜高忠実度のモックアップに発展させる |

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| user-stories | User Stories | ストーリーをインタラクションの詳細と UX の受け入れ基準で豊かにする |
| domain-design | Domain Design | UI コンポーネントの仕様とデザインシステムのマッピングを貢献する |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-product-agent | ユーザーストーリー、ペルソナ、intent、ユーザージャーニーの文脈 |
| aidlc-architect-agent | コンポーネント設計の制約、UI に影響する技術的な制限 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-developer-agent | 実装のためのインタラクション仕様、コンポーネント仕様 |
| aidlc-quality-agent | テストのための UX の受け入れ基準、アクセシビリティ要件 |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-design-agent/`

| ファイル | 内容 |
|------|---------|
| accessibility-wcag.md | WCAG 2.1 AA のガイドラインと実装パターン |
| component-spec-template.md | コンポーネント仕様（状態、props、振る舞い）を文書化するテンプレート |
| interaction-design-patterns.md | ナビゲーション、フォーム、フィードバック、状態遷移のインタラクションパターン |
| ux-guide.md | UX デザインのメソドロジーと原則 |
| wireframing-guide.md | 低忠実度と高忠実度のワイヤーフレーミングの技法 |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-design-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存のデザインシステム、ブランドガイドライン、タイポグラフィの規則、コンポーネントライブラリのような、プロジェクト固有のデザインアセットで満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-design-agent](../../guide/agents/design-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-design-agent.md`](../../../core/agents/aidlc-design-agent.md)

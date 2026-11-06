# aidlc-delivery-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-delivery-agent |
| Tier | **templated** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| team-formation | Team Formation | 必要なスキルセットを評価し、mob チームを編成し、コミュニケーションの規範を定義する |
| approval-handoff | Initiative Approval and Handoff | イニシアチブの brief をまとめ、完全性を検証し、ステークホルダーの承認のために提示し、phase の引き継ぎを実行する |
| delivery-planning | Delivery Planning | Bolt のシーケンスを計画し（units-generation stage の依存 DAG を通じた経済的な順序付け）、mob を割り当て、Bolt ごとの Definition of Done と自信の仮説を定義する |

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| scope-definition | Scope Definition and Prioritization | scope をデリバリーの実現可能性と利用可能なキャパシティに照らして検証する |
| units-generation | Units Generation | unit の粒度を、計画のニーズとデリバリーの順序付けの要件に合わせる |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-product-agent | scope、優先順位、イニシアチブの枠組み、優先順位付けされたバックログ |
| aidlc-architect-agent | Unit、複雑さの見積もり、依存グラフ |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| すべての construction agent | デリバリープラン、mob の割り当て、Bolt のシーケンス |
| Orchestrator | phase ゲートの承認のためのイニシアチブの brief |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-delivery-agent/`

| ファイル | 内容 |
|------|---------|
| mob-programming-guide.md | mob プログラミングのパターン、役割（driver、navigator、researcher）、チーム編成 |
| team-topologies.md | チーム編成のパターンとコミュニケーションの構造 |
| workflow-planning-guide.md | デリバリー計画: economic-vs-topological の順序付け、WSJF、walking skeleton、Bolt DoD のパターン |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-delivery-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、チームの慣行、bolt のサイズ設定の好み、組織のキャパシティの制約のような、プロジェクト固有のデリバリーの文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-delivery-agent](../../guide/agents/delivery-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-delivery-agent.md`](../../../core/agents/aidlc-delivery-agent.md)

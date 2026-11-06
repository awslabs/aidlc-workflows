# aidlc-developer-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-developer-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| reverse-engineering | Reverse Engineering（コードスキャンのステップ） | 深いコードスキャンを行い、依存グラフ、API エンドポイント、データベースモデル、技術的負債の指標を抽出する |
| code-generation | Code Generation | アーキテクチャ仕様から Units of work を本番品質のコードとして実装する |

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery（Inception） | 相互に目隠しされたコードパターンのスポーク。命名規約、レイヤーの分離、エラー処理、ファイルの編成を、自身の contribution ファイルに書く |
| user-stories | User Stories | mob アンサンブルにおける実装可能性の声（ディスパッチされたコラボレーター。自身の contribution ファイルを書く） |
| functional-design | Functional Design | API contract の設計とデータモデルの仕様 |
| deployment-execution | Deployment Execution | データベースマイグレーションの実行と検証 |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-architect-agent | Unit of work の仕様、設計パターン、API 仕様 |
| aidlc-quality-agent | テスト要件、バグレポート、不具合の仕様 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-quality-agent | テストのための実装されたコード、テストのインフラ |
| aidlc-architect-agent | reverse engineering の合成のためのコードスキャン結果 |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-developer-agent/`

| ファイル | 内容 |
|------|---------|
| api-design-guide.md | API contract 設計のメソドロジー（REST/HTTP の規約、OpenAPI、AsyncAPI） |
| code-analysis-guide.md | コードベースの分析とリバースエンジニアリングの技法 |
| code-generation-guide.md | コード生成のメソドロジーと実装パターン |
| code-generation-patterns.md | どの言語にも当てはまるコード生成の原則（clean code、SOLID、エラー、ロギング、編成） |
| data-modelling-patterns.md | データモデル設計のパターン（リレーショナルと NoSQL） |
| re-artifacts.md | リバースエンジニアリングのアーティファクトの仕様 |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-developer-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、コーディング標準、フレームワークの規約、既存の API パターン、マイグレーション戦略のような、プロジェクト固有の開発の文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-developer-agent](../../guide/agents/developer-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-developer-agent.md`](../../../core/agents/aidlc-developer-agent.md)

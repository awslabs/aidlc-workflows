# aidlc-quality-agent -- 技術リファレンス

## 識別情報

| フィールド | 値 |
|-------|-------|
| 名前 | aidlc-quality-agent |
| ティア | **judgment** |
| Claude Code ツール | セッションのツールセット全体を継承し、MCP ツールも含みます（`tools:` の許可リストはありません）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion の利用が想定されています |
| 禁止されている Claude Code ツール | Task |

---

## ステージの所有

### リードするステージ

| ステージ | 名前 | このエージェントの役割 |
|-------|------|----------------------|
| build-and-test | Build and Test | テスト戦略を定め、テストスイートを生成し、受け入れ基準に対するカバレッジを検証し、品質ゲートを適用します |
| performance-validation | Performance Validation and Load Testing | 負荷テストを設計・実行し、NFR の目標値を検証し、ボトルネックを特定し、キャパシティプランニングの推奨事項をまとめます |

### 支援するステージ

| ステージ | 名前 | このエージェントの貢献 |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery | 互いに見えないスポークとして、テストの姿勢、カバレッジの下限、CI のブロックまたは警告の挙動を貢献ファイルに記録します |
| user-stories | User Stories | モブ編成の中でテスト可能性と受け入れ基準の観点を担い、自身の貢献ファイルを書きます |
| nfr-requirements | NFR Requirements | テスト可能な品質属性のシナリオと、計測可能な NFR の目標値を定めます |

---

## 協調のパターン

### 受け取る相手

| 送り元 | 成果物 |
|--------|-----------|
| aidlc-product-agent | テストケースを導き出すための、受け入れ基準付きユーザーストーリー |
| aidlc-architect-agent | NFR の目標値、設計のテスト可能性の評価、テストの境界 |
| aidlc-developer-agent | テスト対象として実装されたコード |

### 引き渡す相手

| 送り先 | 成果物 |
|--------|-----------|
| aidlc-pipeline-deploy-agent | CI/CD へのテストスイートの統合、品質ゲートの定義 |
| aidlc-operations-agent | 本番環境の監視のためのパフォーマンスのベースライン |

---

## 知識ソース

### 方法論（Tier 1）

パス: `.claude/knowledge/aidlc-quality-agent/`

| ファイル | 内容 |
|------|---------|
| nfr-reliability-guide.md | 信頼性の目標設定（SLA/SLO/SLI、可用性、回復目標）と可観測性の要件 |
| nfr-validation-methods.md | NFR の検証手法（負荷テスト、パフォーマンスのプロファイリング） |
| test-strategy-patterns.md | テストピラミッドのパターン、テストデータの戦略、品質ゲートの設計 |
| testing-guide.md | テストの方法論とテストケース設計の原則 |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-quality-agent/`（スペースレベルの知識ディレクトリで、ユーザーが管理します）

チームがコンテンツを持ったときに作成する、スペースレベルのディレクトリです（エンジンはスペースの `knowledge/` フォルダを空の状態で作成します）。既存のテストフレームワーク、カバレッジの目標値、パフォーマンスのベースライン、品質ゲートのしきい値といった、プロジェクト固有の QA コンテキストがチームによって書き込まれます。

---

## 相互参照

- [エージェントリファレンス概要](README.md)
- [エージェントガイド: aidlc-quality-agent](../../guide/agents/quality-agent.md)
- [ステージのドキュメント](../04-stages/)
- 原本のソース: [`core/agents/aidlc-quality-agent.md`](../../../core/agents/aidlc-quality-agent.md)

# aidlc-pipeline-deploy-agent -- 技術リファレンス

## 識別情報

| フィールド | 値 |
|-------|-------|
| 名前 | aidlc-pipeline-deploy-agent |
| ティア | **templated** |
| Claude Code ツール | セッションのツールセット全体を継承し、MCP ツールも含みます（`tools:` の許可リストはありません）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion の利用が想定されています |
| 禁止されている Claude Code ツール | Task |

---

## ステージの所有

### リードするステージ

| ステージ | 名前 | このエージェントの役割 |
|-------|------|----------------------|
| practices-discovery | Practices Discovery | ハブアンドスポーク方式のドラフト作成、人間へのインタビュー、統合をリードします。承認後は、コンテンツを active-space のチーム／プロジェクトメモリへ昇格させます |
| ci-pipeline | CI Pipeline | 品質ゲート、成果物の生成、セキュリティスキャンを備えた CI パイプラインを設計・構成します |
| deployment-pipeline | Deployment Pipeline | 昇格ゲート、デプロイ戦略、フィーチャーフラグ連携を備えた CD パイプラインを設計します |
| deployment-execution | Deployment Execution | デプロイを実行し、スモークテストを走らせ、ヘルスメトリクスを監視し、ロールバックを処理します |

### 支援するステージ

このエージェントは支援の役割を担いません。関わる 4 つのステージはすべてリードするステージです。

---

## 協調のパターン

### 受け取る相手

| 送り元 | 成果物 |
|--------|-----------|
| aidlc-developer-agent | ビルド可能なソースコード、テストスイート、ビルドスクリプト |
| aidlc-quality-agent | テスト要件、品質ゲートの定義 |
| aidlc-aws-platform-agent | 環境のエンドポイント、インフラの出力、シークレット |

### 引き渡す相手

| 送り先 | 成果物 |
|--------|-----------|
| aidlc-operations-agent | 可観測性の設定と監視のためにデプロイ済みのサービス |
| aidlc-quality-agent | パフォーマンス検証のためのデプロイ成果物 |

---

## 知識ソース

### 方法論（Tier 1）

パス: `.claude/knowledge/aidlc-pipeline-deploy-agent/`

| ファイル | 内容 |
|------|---------|
| cicd-patterns.md | CI/CD パイプラインのパターン、品質ゲート、成果物の管理 |
| deployment-strategies.md | デプロイ戦略のパターン（blue-green、canary、rolling、A/B テスト、フィーチャーフラグ）とロールバック |
| branching-strategies.md | 5 つのブランチ戦略（trunk-based、GitHub Flow、GitFlow、release branches、monorepo）と、それぞれの AI-DLC ワークツリーへのマッピング。Bolt-merge のディスパッチ時に調査されます |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-pipeline-deploy-agent/`（スペースレベルの知識ディレクトリで、ユーザーが管理します）

チームがコンテンツを持ったときに作成する、スペースレベルのディレクトリです（エンジンはスペースの `knowledge/` フォルダを空の状態で作成します）。既存のパイプライン構成、デプロイのランブック、リリース承認のワークフローといった、プロジェクト固有のデプロイコンテキストがチームによって書き込まれます。

---

## 相互参照

- [エージェントリファレンス概要](README.md)
- [エージェントガイド: aidlc-pipeline-deploy-agent](../../guide/agents/pipeline-deploy-agent.md)
- [ステージのドキュメント](../04-stages/)
- 原本のソース: [`core/agents/aidlc-pipeline-deploy-agent.md`](../../../core/agents/aidlc-pipeline-deploy-agent.md)

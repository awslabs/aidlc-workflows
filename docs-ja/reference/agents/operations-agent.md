# aidlc-operations-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-operations-agent |
| Tier | **templated** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| observability-setup | Observability Setup | CloudWatch のダッシュボード、アラーム、X-Ray トレーシング、構造化ロギング、カスタムメトリクスを構成する |
| incident-response | Incident Response | SSM の runbook を書き、重大度レベルを定義し、オンコール体制を確立し、カオス実験を設計する |
| feedback-optimization | Feedback and Optimization | 本番メトリクスを分析し、洞察を Ideation に還流させ、インフラとアーキテクチャの改善を推奨する |

### Support Stage

なし。stage グラフは performance-validation（4.6）に対して `support_agents: []` を記録します。その stage は aidlc-quality-agent が lead します。この agent が observability-setup（4.4）で立ち上げる運用のテレメトリとベースラインは、非公式にパフォーマンス検証に供給されますが、operations は 4.6 の正式な support agent ではありません。

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-aws-platform-agent | プロビジョンされたインフラ、CloudWatch の名前空間、スケーリングポリシー |
| aidlc-pipeline-deploy-agent | デプロイされたサービス、デプロイのメタデータ |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-product-agent | 次の Ideation サイクルのための運用フィードバック（ライフサイクルのループを閉じる） |
| aidlc-architect-agent | 本番の観察に基づくアーキテクチャ改善の推奨 |
| Orchestrator | 反復計画のためのフィードバックレポート |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-operations-agent/`

| ファイル | 内容 |
|------|---------|
| incident-response-guide.md | インシデント対応のメソドロジー、重大度レベル、ポストモーテムのテンプレート |
| nfr-performance-guide.md | パフォーマンスの監視と最適化のメソドロジー |
| observability-patterns.md | 可観測性のパターン（ダッシュボード、アラーム、トレーシング、ロギング） |
| slo-sli-patterns.md | SLO/SLI 定義のパターン、エラーバジェットのポリシー |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-operations-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存の runbook、オンコールのスケジュール、SLO 目標、監視ダッシュボードのような、プロジェクト固有の運用の文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-operations-agent](../../guide/agents/operations-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-operations-agent.md`](../../../core/agents/aidlc-operations-agent.md)

# aidlc-aws-platform-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-aws-platform-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

| Stage | 名前 | この agent が行うこと |
|-------|------|----------------------|
| infrastructure-design | Infrastructure Design | アプリケーションアーキテクチャを、AWS サービスの選択、CDK/CloudFormation テンプレート、VPC 設計、IAM ポリシー、コスト見積もりに変換する |
| environment-provisioning | Environment Provisioning | IaC 定義から dev/staging/production の環境を、ドリフト検出と環境の同等性とともにプロビジョニングする |

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| feasibility | Feasibility and Constraint Analysis | AWS サービスの可用性、リージョンの制約、クラウドプラットフォームの制限を評価する |
| domain-design | Domain Design | クラウドネイティブのパターン、マネージドサービスの統合、serverless の選択肢を助言する |
| contract-design | Contract Design | この stage の support agent。そのペルソナは、固有の務めなしに、サポートする stage の中に Contract Design を列挙する |
| nfr-design | NFR Design | NFR をインフラ仕様、オートスケーリングポリシー、レジリエンスの構成に変換する |
| feedback-optimization | Feedback and Optimization | 本番メトリクスに基づいて、コスト最適化の機会とインフラのチューニングを特定する |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-architect-agent | アプリケーションのトポロジー、コンポーネントのインベントリ、インフラ要件 |
| aidlc-devsecops-agent | セキュリティ要件、コンプライアンスのコントロール、暗号化の仕様 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-pipeline-deploy-agent | デプロイ先のための環境エンドポイント、インフラの出力 |
| aidlc-operations-agent | 可観測性のセットアップと監視のためのプロビジョンされたインフラ |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-aws-platform-agent/`

| ファイル | 内容 |
|------|---------|
| cdk-best-practices.md | AWS CDK の construct パターン、スタックの編成、テスト |
| cost-optimization-patterns.md | FinOps のパターン、right-sizing、reserved instances、savings plans |
| infrastructure-guide.md | インフラ設計のメソドロジーと環境のプロビジョニング |
| well-architected-framework.md | AWS Well-Architected Framework の6つの柱のリファレンス |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-aws-platform-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存の VPC 設計、AWS アカウント構造、承認されたサービスカタログ、コストのベースラインのような、プロジェクト固有のインフラの文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-aws-platform-agent](../../guide/agents/aws-platform-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-aws-platform-agent.md`](../../../core/agents/aidlc-aws-platform-agent.md)

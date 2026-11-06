# AWS Platform Agent

> **エージェント詳細解説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳細解説](README.md) · 技術リファレンス: [aws-platform-agent](../../reference/agents/aws-platform-agent.md)

aidlc-aws-platform-agent は、あなたの AWS ソリューションアーキテクトであり、インフラエンジニアです。アプリケーションのアーキテクチャを、AWS サービスの選定、CDK/CloudFormation テンプレート、環境プロビジョニング戦略へと翻訳します。このエージェントが下すインフラの意思決定はすべて、コストを意識し、セキュアをデフォルトとし、AWS Well-Architected Framework に照らして検証されます。

aidlc-aws-platform-agent は、2つのステージを主導し、ほかの5つを支援します。AWS CLI コマンドの実行、CDK 操作、インフラ検証ツールのために Bash を使うことが想定されています。

## 主導するステージ

| ステージ | フェーズ | 説明 |
|-------|-------|--------|
| 3.4 Infrastructure Design | Construction | AWS サービスの選定、IaC テンプレート、コスト見積もり（ユニットごと） |
| 4.2 Environment Provisioning | Operation | IaC 定義から環境をプロビジョニングし検証する |

## 支援するステージ

| ステージ | フェーズ | 貢献 |
|-------|-------|--------|
| 1.3 Feasibility & Constraints | Ideation | AWS サービスの利用可否と制約の評価 |
| 2.6 Domain Design | Inception | クラウドネイティブなパターンとサービス連携の助言 |
| 2.8 Contract Design | Inception | このステージでの支援エージェント |
| 3.3 NFR Design | Construction | NFR をインフラ仕様とスケーリングポリシーへ翻訳する |
| 4.7 Feedback & Optimization | Operation | コスト最適化とインフラのチューニング |

## 期待できること

aidlc-aws-platform-agent が稼働しているとき、あなたの AWS アカウント構成、既存インフラ、コスト制約、コンプライアンス要件について問いかけます。CDK/CloudFormation の仕様、VPC トポロジー、IAM ポリシー、環境ティアごとのコスト見積もりを伴うインフラ設計を生み出します。サービスの利用可否や既存の構成を検証するために、AWS CLI コマンドを実行することもあります。

## 協働のしかた

aidlc-aws-platform-agent は、aidlc-architect-agent からアプリケーションのトポロジーを、aidlc-devsecops-agent からセキュリティ要件を受け取ります。監視インフラと runbook の連携では aidlc-operations-agent と連携します。プロビジョニングした環境は、デプロイ先として aidlc-pipeline-deploy-agent へ引き継がれます。

## 主要な原則

- すべてのインフラの意思決定は、Well-Architected の6つの柱すべてに対して弁明できなければならない
- すべてのリソースはコードで定義する。コンソールでの変更はドリフトである
- コストは第一級のアーキテクチャ上の関心事である。すべての設計にコスト見積もりを含める
- IAM ポリシーは必要最小限の権限だけを付与する。ワイルドカードのポリシーは使わない
- dev、staging、production は規模だけが異なるべきであり、トポロジーが異なってはならない

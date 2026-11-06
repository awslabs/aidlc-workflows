# Compliance Agent

> **エージェント詳細解説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳細解説](README.md) · 技術リファレンス: [compliance-agent](../../reference/agents/compliance-agent.md)

aidlc-compliance-agent は、あなたの GRC（ガバナンス、リスク、コンプライアンス）アナリストです。ライフサイクルのすべてのステージが、該当する規制上の義務と組織のコンプライアンスポリシーを織り込むよう取り計らいます。規制要件を早期にスキャンし、技術的な統制へマッピングし、コンプライアンスリスクの RAID ログを維持し、設計が監査の期待に応えることを検証します。

aidlc-compliance-agent は支援役に徹し、いずれのステージも主導しません。その代わり、Ideation、Construction、Operation にまたがる4つのステージで、コンプライアンスの専門知識を提供します。

## 主導するステージ

aidlc-compliance-agent はいずれのステージも主導しません。

## 支援するステージ

| ステージ | フェーズ | 貢献 |
|-------|-------|--------|
| 1.3 Feasibility & Constraints | Ideation | 規制上の制約の特定、コンプライアンスの実現可能性、RAID ログの初期化 |
| 3.2 NFR Requirements | Construction | 規制由来の NFR マッピング、コンプライアンス統制の要件、データ分類 |
| 3.4 Infrastructure Design | Construction | データ所在地の検証、暗号化の要件、IAM のコンプライアンス統制 |
| 4.2 Environment Provisioning | Operation | コンプライアンス統制の検証、監査ログ、規制関連の構成チェック |

## 期待できること

aidlc-compliance-agent が（主導エージェントとともに支援役として）稼働しているとき、その焦点は規制フレームワーク、データ分類、統制のマッピングにあります。該当する規制（GDPR、HIPAA、PCI-DSS、SOC 2）、データの機微さの水準、既存のコンプライアンスポリシーについて問いかけます。コンプライアンス統制のマトリクスを作成し、是正が必要なギャップを示します。

## 協働のしかた

aidlc-compliance-agent は、aidlc-architect-agent からシステム設計とデータフローの情報を、aidlc-devsecops-agent からセキュリティ統制の詳細を受け取ります。設計に織り込むためのコンプライアンス要件と制約を aidlc-architect-agent へ返し、実装のためのセキュリティ統制の仕様を aidlc-devsecops-agent へ提供します。

## 主要な原則

- コンプライアンスは制約であり、後回しにするものではない。リリース時に見つかるギャップはプロジェクトの失敗である
- データ分類がすべての統制の意思決定を左右する
- コンプライアンスの主張には監査可能な証拠が要る。証拠のない統制は存在しないのと同じである
- 是正は、最も機微なデータと、罰則が最も重い規制に集中させる
- 規制に関する理解はチームで取り組むものである。aidlc-compliance-agent が教え、チームが実行する

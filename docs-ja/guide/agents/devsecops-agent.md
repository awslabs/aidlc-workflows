# DevSecOps Agent

> **エージェント詳細解説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳細解説](README.md) · 技術リファレンス: [devsecops-agent](../../reference/agents/devsecops-agent.md)

aidlc-devsecops-agent は、あなたのセキュリティエンジニアです。セキュリティを最後に後付けするのではなく、ライフサイクルのすべてのフェーズに組み込むよう取り計らいます。Ideation で特定されたコンプライアンス要件を受け取り、セキュリティ統制、脅威モデル、スキャンパイプライン、ランタイム監視として実装します。アプリケーションセキュリティ、クラウドセキュリティ、パイプラインセキュリティを扱います。

aidlc-compliance-agent と同様に、aidlc-devsecops-agent は支援役に徹します。Inception、Construction、Operation にまたがる5つのステージで、セキュリティの専門知識を提供します。セキュリティスキャンツールの実行のために Bash を利用できます。

## 主導するステージ

aidlc-devsecops-agent はいずれのステージも主導しません。

## 支援するステージ

| ステージ | フェーズ | 貢献 |
|-------|-------|--------|
| 2.2 Practices Discovery | Inception | コラボレーターがオンのとき、互いに見えないセキュリティプラクティスのスポーク。自らの貢献ファイルを記述する |
| 3.2 NFR Requirements | Construction | セキュリティ統制、脅威モデル、STRIDE 分析 |
| 3.4 Infrastructure Design | Construction | IAM ポリシーのレビュー、セキュリティグループの検証 |
| 3.6 Build and Test | Construction | SAST/DAST スキャン、依存関係の脆弱性、IaC の lint |
| 4.2 Environment Provisioning | Operation | セキュリティ態勢の検証（Security Hub、Inspector、GuardDuty） |

## 期待できること

aidlc-devsecops-agent が（支援役として）稼働しているとき、その焦点は攻撃面、トラストバウンダリ、セキュリティ統制にあります。セキュリティのアンチパターンがないか設計をレビューし、機微なデータフローが暗号化されアクセス制御されていることを検証し、サードパーティの依存関係に既知の脆弱性がないか評価します。

## 協働のしかた

aidlc-devsecops-agent は、aidlc-compliance-agent から規制要件を、aidlc-architect-agent からシステム設計を受け取ります。セキュアコーディングの実践では aidlc-developer-agent と、インフラのハードニングでは aidlc-aws-platform-agent と、セキュリティテストの要件では aidlc-quality-agent と連携します。そのセキュリティゲートとスキャン構成は、aidlc-pipeline-deploy-agent へ引き継がれます。

## 主要な原則

- 多層防御を。単一のセキュリティ統制が単一障害点になってはならない
- どこでも最小権限を。すべてのユーザー、サービス、プロセスに最小限の権限を
- 侵害を前提とする。内部コンポーネントも互いに認証・認可し合わなければならない
- デフォルトの構成はセキュアでなければならない
- 検証するまで、すべての入力は敵意あるものとして扱う。サニタイズするまで、すべての外部データは汚染されているものとして扱う
- セキュリティは要件であり、先送りできる機能ではない

# Architect Agent

> **エージェント詳細解説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳細解説](README.md) · 技術リファレンス: [architect-agent](../../reference/agents/architect-agent.md)

aidlc-architect-agent は、あなたのソリューションアーキテクトです。要件を堅牢なシステムアーキテクチャへと翻訳し、Architecture Decision Record (ADR) を作成し、ドメインモデルを設計し、プロジェクトを実装可能な作業単位へと分解します。パターンとトレードオフの観点で思考し、開発者がそのまま実装できる設計を生み出します。

aidlc-architect-agent は、ライフサイクルの中で単一のエージェントとして最も多くのステージ、合計7つを主導し、Ideation、Inception、Construction にまたがります。設計の主たる権限であり、他の判断力の高い7エージェントとともに `judgment` ティアを担うため、固定のモデルを指定せず、セッション自身のモデルと effort を引き継ぎます。`templated` ティアを担うのは delivery、pipeline-deploy、operations だけです。これらの出荷時ベースラインも、出力の大半がテンプレート化されているため、セッションのモデルと effort を引き継ぎます。

## 主導するステージ

| ステージ | フェーズ | 説明 |
|-------|-------|--------|
| 1.3 Feasibility & Constraints | Ideation | 技術的な実現可能性の評価と制約の分析 |
| 2.6 Domain Design | Inception | コンポーネントカタログ、ドメインモデリング、ADR |
| 2.7 Units Generation | Inception | 設計を実装可能な作業単位へ分解する |
| 2.8 Contract Design | Inception | ユニット間境界と公開/外部 API の API 契約 |
| 3.1 Functional Design | Construction | 詳細なドメインモデルとビジネスロジック（ユニットごと） |
| 3.2 NFR Requirements | Construction | 測定可能な目標値を伴う非機能要件（ユニットごと） |
| 3.3 NFR Design | Construction | キャッシュ、レジリエンス、セキュリティ、オブザーバビリティの技術的アプローチ（ユニットごと） |

また、ステージ 2.1 (Reverse Engineering) の統合ステップも主導します。ここでは aidlc-developer-agent からコードスキャンの結果を受け取り、9つのアーキテクチャ成果物を生み出します。コラボレーターをオフにすると、developer がそれらを記述し、architect は割り当てられません。

## 支援するステージ

| ステージ | フェーズ | 貢献 |
|-------|-------|--------|
| 1.1 Intent Capture | Ideation | 技術的な文脈を提供する |
| 2.1 Reverse Engineering (割り当てられるパイプラインの最終リンク) | Inception | コードスキャンの結果を一貫したアーキテクチャモデルへ統合する |
| 2.9 Delivery Planning | Inception | ビルド順序をアーキテクチャの依存関係と照らして検証する |

## 期待できること

aidlc-architect-agent が稼働しているとき、その焦点は境界、パターン、トレードオフにあります。既存システムの制約、技術の好み、スケーラビリティ要件、運用上の懸念について問いかけます。明示的な意思決定の根拠を伴う構造化された設計ドキュメント、markdown で記述されたコンポーネント図、そして重要な選択ごとの ADR を生み出します。

## 協働のしかた

aidlc-architect-agent は、aidlc-product-agent から要件を、aidlc-developer-agent からコードスキャンの結果を受け取ります。AWS サービスのマッピングでは aidlc-aws-platform-agent と、セキュア設計では aidlc-devsecops-agent と、規制上の制約では aidlc-compliance-agent と連携します。その出力（ユニット仕様、API 契約、NFR の目標値）は、aidlc-developer-agent、aidlc-quality-agent、aidlc-aws-platform-agent が利用します。

## 主要な原則

- すべての設計成果物は、明示的な根拠を伴う意思決定に辿れなければならない
- コンポーネントの境界を正しく定めることは、内部の詳細よりも重要である
- コンポーネント間の依存関係を徹底的に最小化する
- 再利用のためではなく、変更のために設計する。変更しやすさを最適化する
- 隠れた前提を明示する。データフロー、所有権、障害モードを表に出す
- 可逆な意思決定を優先する。不可逆なものは追加の精査対象として示す

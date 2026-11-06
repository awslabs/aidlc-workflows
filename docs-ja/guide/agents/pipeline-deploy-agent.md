# Pipeline & Deploy エージェント

> **エージェント詳説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳説](README.md) · 技術リファレンス: [pipeline-deploy-agent](../../reference/agents/pipeline-deploy-agent.md)

aidlc-pipeline-deploy-agent は、あなたの CI/CD エンジニアでありリリースマネージャーです。ビルドの仕様とインフラの対象を、commit から本番までコードを運ぶ、完全に自動化されたパイプラインに変えます。品質ゲート、ロールバックの安全性、完全な監査可能性を備えます。

aidlc-pipeline-deploy-agent は、Inception、Construction、Operation にまたがる 4 つのステージをリードします。パイプラインのツール、デプロイのスクリプト、スモークテストのコマンドを実行するための Bash アクセスを持ちます。

## リードするステージ

| ステージ | フェーズ | 説明 |
|-------|-------|-------------|
| 2.2 Practices Discovery | Inception | ハブアンドスポークの所見を下書きし、インタビューし、統合する。承認された実践を、いま使っているスペースの team/project メモリに昇格する |
| 3.7 CI Pipeline | Construction | 品質ゲートつきの CI パイプライン設定 |
| 4.1 Deployment Pipeline | Operation | デプロイ戦略とロールバック手順つきの CD パイプライン |
| 4.3 Deployment Execution | Operation | デプロイを実行し、スモークテストを走らせ、健全性を監視する |

## 支援するステージ

aidlc-pipeline-deploy-agent は、助言役として支援するステージはありません。

## 何が起きるか

Practices Discovery では、aidlc-pipeline-deploy-agent がまず下書きし、人へのインタビューのあと、互いに見えない quality、developer、devsecops の貢献を統合します（協力者がオフのときは、下書きがそのままインタビューへ進みます）。配送のステージでは、CI/CD インフラ、デプロイの対象、ブランチ戦略、ロールバックの要件について尋ね、パイプライン設定、デプロイ戦略、ロールバックの runbook を生み出し、Deployment Execution を監視します。

## どう協働するか

aidlc-pipeline-deploy-agent は、ビルドできるソースとテストスイートを aidlc-developer-agent から、品質ゲートの定義を aidlc-quality-agent から、環境のエンドポイントを aidlc-aws-platform-agent から受け取ります。デプロイしたサービスは、可観測性の設定のために aidlc-operations-agent に引き継ぎ、デプロイの成果物は、性能の検証のために aidlc-quality-agent に渡します。

## 中心となる原則

- どの commit もリリース候補である。すべてのゲートを通れば、本番の準備ができている
- どのデプロイにも、テスト済みのロールバックの道がなければならない
- CI パイプラインは、時間ではなく分で終えるべきである。遅いパイプラインは、まとめ処理を促す
- 品質ゲートは、欠陥のある成果物がユーザーに届くのを防ぐためにある
- スモークテストでサービスの健全性が確認できるまで、デプロイは終わっていない

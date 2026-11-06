# Developer Agent

> **エージェント詳細解説** · [ユーザーガイド](../00-introduction.md) › [エージェント](../06-agents.md) › [詳細解説](README.md) · 技術リファレンス: [developer-agent](../../reference/agents/developer-agent.md)

aidlc-developer-agent は、あなたのシニアソフトウェア開発者です。アーキテクチャ設計とユニット仕様を、本番品質のコードへと翻訳します。リバースエンジニアリングでは、aidlc-architect-agent が統合する対象となる深いコードスキャンを実行します。

aidlc-developer-agent は、Reverse Engineering のコードスキャンと Code Generation を主導し、2つの Inception アンサンブルの両方で割り当てられるコラボレーターとして働きます。Practices Discovery のハブ＆スポークではコードパターンの証拠を検証し、User Stories の mob では実装可能性の観点を提供します。Code Generation は、特定の作業に集中するサブエージェントとして動きます。ビルドツール、パッケージマネージャー、テストコマンドの実行のために Bash を使うことが想定されています。

Workspace Detection を含む Initialization は決定的なツールとして動き、aidlc-developer-agent は関与しません。

## 主導するステージ

| ステージ | フェーズ | 説明 |
|-------|-------|--------|
| 2.1 Reverse Engineering (code scan) | Inception | architect の統合向けに構造化された分析を生み出す深いコードスキャン。コラボレーターがオフのときは、9つの成果物も自ら記述する |
| 3.5 Code Generation | Construction | 設計仕様から作業単位を実装する（ユニットごと） |

## 支援するステージ

| ステージ | フェーズ | 貢献 |
|-------|-------|--------|
| 2.2 Practices Discovery | Inception | コラボレーターがオンのとき、互いに見えないコードパターンのスポーク。自らの貢献ファイルを記述する |
| 2.4 User Stories | Inception | コラボレーターがオンのとき、mob アンサンブルにおける実装可能性の観点。自らの貢献ファイルを記述する |
| 3.1 Functional Design | Construction | API 契約とデータモデルの入力 |
| 4.3 Deployment Execution | Operation | データベースのマイグレーション |

## 期待できること

Code Generation の間、aidlc-developer-agent はサブエージェントとして動くため、あなたが直接やり取りすることはありません。進捗インジケーターが表示され、完了すると結果が出ます。オーケストレーターがまずコード生成の計画を提示して承認を求め、その後サブエージェントが各ステップを実装します。

アプリケーションコードは、intent の record ディレクトリではなく、ワークスペースのルートへ直接書き込まれます。intent の record ディレクトリにある `code-summary.md` 成果物が、何が作成または変更されたかを記録します。

## 協働のしかた

aidlc-developer-agent は、aidlc-architect-agent からユニット仕様と設計パターンを、aidlc-quality-agent からテスト要件を受け取ります。CDK/インフラの整合では aidlc-aws-platform-agent と、セキュアコーディングでは aidlc-devsecops-agent と連携します。そのコードスキャンの結果は統合のために aidlc-architect-agent へ渡り、実装したコードはテストのために aidlc-quality-agent へ引き継がれます。

## 主要な原則

- 動作し、テストされた実装を届ける。Testing Contract にそのステップが含まれるとき（TDD、BDD、ATDD、またはカスタム）は、最初の生成の中でリファクタリングする
- プロジェクトの既存のパターンと規約に従う
- 読みやすくデバッグしやすいコードを書く。凝った抽象化は避ける
- 入力を早めに検証し、意味のあるエラーを投げ、例外を握りつぶさない
- 生成されるすべてのユニットに、少なくともハッピーパスのテストを含める
- リバースエンジニアリングでは、スキャンの徹底度が統合の品質を決める

# Operation フェーズ -- stage リファレンス（4.1-4.7）

## フェーズの概要

Operation フェーズは、AI-DLC ライフサイクルの 5 つのフェーズの 5 番目です。Construction から
構築・テスト済みのソフトウェアを受け取り、デプロイ、監視、インシデント対応の備え、性能検証、
継続的な最適化を通してそれを動かします。パイプライン設定、環境のプロビジョニング、デプロイの実行、
可観測性、インシデント対応、性能検証、フィードバック収集にまたがる 7 つの stage（4.1 から 4.7）を
扱います。

7 つの Operation stage すべてが **CONDITIONAL** です。scope と実行計画に基づいて実行されます。
mvp、poc、classic は Operation を完全に skip します。bugfix、refactor、infra、security-patch、express は
デプロイに焦点を当てた部分集合を実行します（下の Scope の適用範囲参照）。例えば express の plan は、
3 つの Operation stage で終わります。

```text
$ aidlc engine graph scope express
workspace-scaffold
workspace-detection
state-init
reverse-engineering
requirements-analysis
code-generation
build-and-test
deployment-pipeline
deployment-execution
observability-setup
```

すべての stage は **inline** で実行されます（Operation フェーズに subagent なし）。すべての stage は、
承認 gate、質問フォーマット、完了メッセージ、状態追跡について `stage-protocol.md` に従います。

---

## stage 要約テーブル

| Stage | Name                     | Execution   | Condition                                                              | Lead Agent          | Support Agents      | Mode                             |
|-------|--------------------------|-------------|------------------------------------------------------------------------|---------------------|---------------------|----------------------------------|
| 4.1   | Deployment Pipeline      | CONDITIONAL | CD パイプラインの作成や大幅な変更が必要なとき実行    | aidlc-pipeline-deploy-agent| (none)             | inline                           |
| 4.2   | Environment Provisioning | CONDITIONAL | AWS 環境のプロビジョニングや検証が必要なとき実行          | aidlc-aws-platform-agent  | aidlc-devsecops-agent, aidlc-compliance-agent     | inline                           |
| 4.3   | Deployment Execution     | CONDITIONAL | デプロイパイプラインと環境が準備できた後に実行            | aidlc-pipeline-deploy-agent| aidlc-developer-agent    | inline                           |
| 4.4   | Observability Setup      | CONDITIONAL | 監視・ダッシュボード・アラーム・トレーシングの設定が必要なとき実行    | aidlc-operations-agent    | (none)              | inline                           |
| 4.5   | Incident Response        | CONDITIONAL | 運用の runbook とインシデント対応手順が必要なとき実行 | aidlc-operations-agent | (none)              | inline                           |
| 4.6   | Performance Validation   | CONDITIONAL | NFR の性能目標を負荷下で検証する必要があるとき実行        | aidlc-quality-agent       | (none)              | inline                           |
| 4.7   | Feedback & Optimization  | CONDITIONAL | 継続的な運用監視と最適化が必要なとき実行    | aidlc-operations-agent    | aidlc-aws-platform-agent  | inline                           |

### マルチエージェントの stage

3 つの Operation stage が複数の agent を伴います。

- **4.2 Environment Provisioning**: aidlc-aws-platform-agent（lead） + aidlc-devsecops-agent（セキュリティ態勢の検証） + aidlc-compliance-agent（データ所在地、規制コントロール）
- **4.3 Deployment Execution**: aidlc-pipeline-deploy-agent（lead） + aidlc-developer-agent（データベースマイグレーション）
- **4.7 Feedback & Optimization**: aidlc-operations-agent（lead） + aidlc-aws-platform-agent（コスト最適化、drift 検出）

3 つすべてが inline です。conductor は、各 support agent の視点を自身のコンテキストで引き受け（lead と
同じように、その persona ファイルと知識を読み込む）、まず lead の出力を書き、その後各 support の視点を
重ねます。support agent は dispatch されず、貢献ファイルも書かれません。参加する support agent は、
directive の `support_agents`、つまり collaborators 設定の後に残った一覧です。

---

## Stage 4.1: Deployment Pipeline Configuration

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.1                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（デプロイパイプラインが既に存在し十分なら skip）                           |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | (none)                                                                                            |
| Inputs            | Stage 3.7 からの CI パイプライン設定、Stage 3.4 からのインフラ設計                          |

### 目的

CD パイプライン、デプロイ戦略、ロールバック手順、環境昇格の gate を設定します。

### Outputs

| Artifact                          | 説明                                                      |
|-----------------------------------|------------------------------------------------------------------|
| cd-config.md                      | CD パイプライン設定                                        |
| deployment-strategy.md            | デプロイ戦略（blue/green、canary、rolling）、昇格 gate|
| rollback-runbook.md               | ロールバック手順と runbook                                  |
| deployment-pipeline-questions.md  | 回答付きの明確化の質問                                |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

---

## Stage 4.2: Environment Provisioning

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.2                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（環境が既にプロビジョニング済みなら skip）                                            |
| Lead Agent        | aidlc-aws-platform-agent                                                                                |
| support_agents    | aidlc-devsecops-agent（セキュリティ態勢の検証）、aidlc-compliance-agent（データ所在地、規制コントロール） |
| Inputs            | Stage 3.4 からのインフラ設計、Stage 4.1 からの CD パイプライン設定                          |

### 目的

Construction からの Infrastructure as Code を使って、対象の AWS 環境をプロビジョニングし検証します。aidlc-devsecops-agent がセキュリティ態勢を検証し、aidlc-compliance-agent がデータ所在地と規制コントロールを確認します。

### Outputs

| Artifact                              | 説明                                                |
|---------------------------------------|------------------------------------------------------------|
| environment-inventory.md              | プロビジョニングされた環境のインベントリ                          |
| validation-report.md                  | インフラ検証レポート、ヘルスチェック            |
| environment-provisioning-questions.md | 回答付きの明確化の質問                          |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

---

## Stage 4.3: Deployment Execution

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.3                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（デプロイパイプラインと環境が準備できた後に実行。既にデプロイ済みなら skip） |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | aidlc-developer-agent（データベースマイグレーション）                                                             |
| Inputs            | Stage 4.1 からの CD パイプライン設定、Stage 4.2 からのプロビジョニングされた環境                       |

### 目的

実際のデプロイを実行します。アーティファクトをパイプラインに通し、smoke テストを実行し、ヘルスチェックを検証し、データベースマイグレーションを実行します。

AWS ターゲットでは、AWS CLI がインストールされているとき、stage はまず agent 自身のシェルで、デプロイの profile と region で `aws sts get-caller-identity` を実行します。それが失敗したら、どのデプロイの質問も尋ねる前に、認証情報をそのシェルから見えるようにするようその人に頼み、完全なアカウント ID をアーティファクトに決して書きません。

### Outputs

| Artifact                          | 説明                                                  |
|-----------------------------------|--------------------------------------------------------------|
| deployment-log.md                 | デプロイ実行ログ                                     |
| smoke-test-results.md             | デプロイ後の smoke テスト結果                          |
| health-check-report.md            | ヘルスチェック検証レポート                               |
| deployment-execution-questions.md | 回答付きのデプロイ前チェックの質問                  |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

---

## Stage 4.4: Observability Setup

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.4                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（可観測性が既に設定済みなら skip）                                            |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| Inputs            | Stage 3.3 からの NFR 設計、Stage 3.4 からのインフラ設計、デプロイされたアプリケーション             |

### 目的

監視、ダッシュボード、アラーム、SLO/SLI の追跡、ログクエリ、分散トレーシング、異常検出を設定します。

### Outputs

| Artifact                          | 説明                                                    |
|-----------------------------------|----------------------------------------------------------------|
| dashboards.md                     | CloudWatch ダッシュボード設定                            |
| alarms.md                         | 重大度、SNS ルーティング、エスカレーション付きのアラーム定義       |
| slo-config.md                     | SLO/SLI 追跡設定                                |
| log-queries.md                    | CloudWatch Logs Insights の保存クエリ                         |
| tracing-config.md                 | X-Ray トレーシング設定                                   |
| anomaly-config.md                 | 異常検出設定                                |
| observability-setup-questions.md  | 回答付きの明確化の質問                              |

### Notes

- どの Operation stage よりも多くのアーティファクトを生成します（6 つの content ファイル + 質問）。
- AWS 固有（CloudWatch、X-Ray、SNS）ですが、パターンは転用可能です。

---

## Stage 4.5: Incident Response & Runbook Generation

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.5                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（POC や非本番デプロイでは skip）                                         |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| Inputs            | Stage 4.4 からの可観測性のセットアップ、Stage 3.3 からの NFR 設計、Stage 3.4 からのインフラ設計 |

### 目的

運用 runbook、インシデント対応計画、エスカレーション手順を生成します。

### Outputs

| Artifact                          | 説明                                                    |
|-----------------------------------|----------------------------------------------------------------|
| runbooks.md                       | SSM Automation runbook ライブラリ                                 |
| incident-plan.md                  | インシデント対応計画（AWS Incident Manager 統合）      |
| escalation-matrix.md              | エスカレーションパス、オンコールローテーション、コミュニケーション手順  |
| incident-response-questions.md    | 回答付きの明確化の質問                              |

---

## Stage 4.6: Performance Validation & Load Testing

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.6                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（POC や性能が重要でないアプリケーションでは skip）                              |
| Lead Agent        | aidlc-quality-agent                                                                                     |
| Inputs            | Stage 3.2 からの NFR 要件、Stage 3.3 からの NFR 設計、Stage 4.4 からの可観測性のデータ    |

### 目的

デプロイされたアプリケーションに対して NFR の性能目標を検証するために、負荷テストを設計し実行します。

### Outputs

| Artifact                              | 説明                                                |
|---------------------------------------|------------------------------------------------------------|
| load-test-plan.md                     | シナリオ、ツール、設定を伴う負荷テスト計画    |
| test-results.md                       | 性能テスト結果（レイテンシ、スループット、エラー率） |
| nfr-validation-matrix.md             | NFR 目標対実測の検証マトリクス                    |
| performance-validation-questions.md   | 回答付きの明確化の質問                          |

---

## Stage 4.7: Continuous Feedback & Optimization

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.7                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL（一回限りのデプロイでは skip）                                                        |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| support_agents    | aidlc-aws-platform-agent（コスト最適化、drift 検出）                                           |
| Inputs            | すべての Operation フェーズのアーティファクト、本番監視のデータ                                         |

### 目的

SLO 準拠のレビュー、コスト最適化の分析、インフラの drift 検出、運用上の洞察の収集です。これは AI-DLC ワークフロー全体の **最終 stage** です。

### Outputs

| Artifact                              | 説明                                                |
|---------------------------------------|------------------------------------------------------------|
| slo-report.md                         | SLO 準拠レポート、エラーバジェットの消費率              |
| cost-analysis.md                      | AWS Cost Explorer の分析、最適化の推奨   |
| drift-report.md                       | AWS Config の drift 検出レポート、Trusted Advisor のレビュー  |
| feedback-loop.md                      | 運用上の洞察、改善提案、次の Ideation サイクルへの入力 |
| feedback-optimization-questions.md    | 回答付きの明確化の質問                          |

### 承認 Gate

厳密に 2 選択肢:

1. **Approve** -- ワークフロー完了。AI-DLC ライフサイクル全体が終わります。
2. **Request Changes** -- 改訂のフィードバックを提供します。

---

## フェーズの要約

**デプロイの stage（4.1-4.3）:**
- 4.1 Deployment Pipeline -- CD パイプライン設定、デプロイ戦略、ロールバック runbook
- 4.2 Environment Provisioning -- セキュリティ態勢のレビューを伴う AWS 環境のプロビジョニングと検証
- 4.3 Deployment Execution -- アーティファクトのデプロイ、smoke テスト、ヘルスチェック、データベースマイグレーション

**運用の準備状況の stage（4.4-4.6）:**
- 4.4 Observability Setup -- ダッシュボード、アラーム、SLO、ログクエリ、トレーシング、異常検出
- 4.5 Incident Response -- runbook、インシデント計画、エスカレーションマトリクス
- 4.6 Performance Validation -- 負荷テスト、NFR 目標の検証、キャパシティ計画

**継続的な改善（4.7）:**
- 4.7 Feedback & Optimization -- SLO 準拠、コスト分析、drift 検出、フィードバックループ

**Scope の適用範囲:**
- enterprise / feature / workshop: 全 7 stage
- infra: Stage 4.1-4.4（deployment-pipeline、environment-provisioning、deployment-execution、observability-setup）
- bugfix / refactor: Stage 4.1、4.3（deployment-pipeline、deployment-execution）
- security-patch: Stage 4.1、4.3（deployment-pipeline、deployment-execution）
- express: Stage 4.1、4.3、4.4（deployment-pipeline、deployment-execution、observability-setup）
- mvp / poc / classic: Operation フェーズを完全に skip（classic ではプレースホルダ）

## 相互参照

- [Orchestrator](../03-orchestrator.md) -- ルーティングロジック、scope マッピング
- [Stage Protocol](../04-stage-protocol.md) -- 承認 gate、状態追跡
- [Construction Stages](construction.md) -- 前のフェーズ

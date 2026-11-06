# 実践例

AI-DLC が動く様子を示す2つの完全なウォークスルーです。1つはバグ修正、もう1つは機能開発です。それぞれ、コマンドの呼び出し、ステージの進行、承認ゲート、成果物の出力を示します。

> **ハーネスに関する注記。** これらのトランスクリプトは **Claude Code** で記録しているため、その画面を示します。`/aidlc` と、`Task` 呼び出しでディスパッチされるサブエージェントのステージです。ステージの流れ、ゲート、成果物はどのハーネスでも同一で、ディスパッチの仕組みだけが異なります（Kiro は `subagent` ツール、Codex は `spawn_agent` サブエージェントを使います）。[Running on other harnesses](harnesses/README.md) を参照してください。

---

## バグ修正のウォークスルー

この例では、ユーザープロフィール API の null ポインタ例外を修正します。**bugfix** スコープは Minimal の深さで9ステージ（Initialization 3つ + ドメイン6つ）を実行します。

### 呼び出し

```
/aidlc bugfix
```

コンダクターは何を修正したいか尋ねます。

> **What would you like to build?**

あなたは次のように応答します。

> The user profile API returns HTTP 500 when the `display_name` field is null. The `GET /api/v1/users/:id/profile` endpoint crashes with a NullPointerException in `ProfileSerializer.serialize()`. This affects about 12% of user profiles created before display_name was made mandatory.

### 実行されるステージ

| # | ステージ | フェーズ | リードエージェント | モード |
|---|-------|-------|------------|------|
| 0.1 | Workspace Scaffold | Initialization | orchestrator | inline (auto-proceed) |
| 0.2 | Workspace Detection | Initialization | orchestrator | inline (auto-proceed) |
| 0.3 | State Init | Initialization | orchestrator | inline (auto-proceed) |
| 2.1 | Reverse Engineering | Inception | aidlc-developer-agent + aidlc-architect-agent | pipeline |
| 2.3 | Requirements Analysis | Inception | aidlc-product-agent | inline |
| 3.5 | Code Generation | Construction | aidlc-developer-agent | subagent |
| 3.6 | Build and Test | Construction | aidlc-quality-agent | inline |
| 4.1 | Deployment Pipeline | Operation | aidlc-pipeline-deploy-agent | inline |
| 4.3 | Deployment Execution | Operation | aidlc-pipeline-deploy-agent + aidlc-developer-agent | inline |

### Initialization（ステージ 0.1-0.3）— 自動進行

3つの Initialization ステージは、ユーザーとのやり取りなしに、1つの決定的なツール呼び出し（`aidlc-utility intent-create`）として1秒足らずで実行されます。

- **0.1 Workspace Scaffold** — 最初の intent を自動作成し、その記録ディレクトリを `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`（以下では `<record>/` と表記）に作ります。`<YYMMDD>` はコンパクトな UTC の日付プレフィックスで、記録が時系列にソートされるようにします。`<label>` はコンダクターによるリクエストの短いケバブケースの要約です。正規の id は `intents.json` のレジストリ行に入る UUIDv7 です
- **0.2 Workspace Detection** — ルールベースのスキャンが Java 17、Spring Boot 3.2、Maven、ブラウンフィールドプロジェクトを特定します
- **0.3 State Init** — `aidlc-state.md` をスコープ `bugfix`、深さ `Minimal`、実行対象としてマークされたドメインステージで初期化します

> Setting up the bugfix workflow for this: 6 stages, 6 approval gates.

### ステージ 2.1 — Reverse Engineering

2リンクのパイプラインがコードベースをスキャンします。まず aidlc-developer-agent のコードスキャン、次に成果物を書く aidlc-architect-agent の統合です。`aidlc/spaces/default/codekb/user-service/` にリポジトリ向けの9つの永続的な成果物を生み出します。

| 成果物 | 内容 |
|----------|------|
| `business-overview.md` | User service — profiles, preferences, auth tokens |
| `architecture.md` | Spring Boot monolith, 3-layer design |
| `code-structure.md` | 6 packages: controller, service, model, repository, serializer, config |
| `api-documentation.md` | 8 REST endpoints under `/api/v1/users/` |
| `component-inventory.md` | Controllers, services, repositories, and serializers catalogued |
| `technology-stack.md` | Java 17, Spring Boot 3.2, PostgreSQL 15, Jackson 2.15 |
| `dependencies.md` | Maven dependency tree, third-party libraries, version constraints |
| `code-quality-assessment.md` | 62% test coverage, basic CI |
| `reverse-engineering-timestamp.md` | When the scan ran, against which commit |

**承認ゲート:**

```
Reverse Engineering complete. How would you like to proceed?
- Approve        -> Continue to Requirements Analysis
- Request Changes -> Provide revision feedback
```

あなたは **Approve** を選びます。

### ステージ 2.3 — Requirements Analysis

aidlc-product-agent のペルソナがロードされ、`<record>/inception/requirements-analysis/requirements-analysis-questions.md` に明確化のための質問を作ります。

```markdown
## Q1. [Product owner] Bug Severity Classification
How severe is this bug for your users?
A. Critical — causes data loss or security exposure
B. High — blocks a core workflow for affected users
C. Medium — degraded experience but workaround exists
D. Low — cosmetic or minor inconvenience
X. Other (please specify)

[Answer]:
```

コンダクターはインタラクションモードを提示します。

```
How would you like to answer these questions?
- Guide me        -> Walk through each question interactively
- I'll edit the file -> Fill in answers directly
- Chat            -> Discuss freely
```

あなたは **Guide me** を選び、次のように答えます。Q1 = High、Q2 = ユーザー名をフォールバックに、Q3 = null をうまく扱う（マイグレーションなし）。

コンダクターは `requirements.md` を、3つの機能要件（null の扱い、シリアライザの修正、フォールバックロジック）と1つの非機能要件（応答時間のリグレッションなし）とともに生成します。

**承認ゲート:** あなたは **Approve** を選びます。

### ステージ 3.5 — Code Generation

コンダクターはコード生成プランを作り、aidlc-developer-agent のサブエージェントに委譲します。

**プラン:**
1. Fix `ProfileSerializer.serialize()` to handle null `display_name`
2. Add unit tests for null/non-null cases
3. Fix `ProfileService.getProfile()` defensive check
4. Add integration tests for the API endpoint

あなたはプランを承認します。サブエージェントは4つのステップをすべて実装します。

- **Modified**: `ProfileSerializer.java` (null-safe with username fallback)
- **Modified**: `ProfileService.java` (defensive null handling)
- **Created**: `ProfileSerializerTest.java` (2 unit tests)
- **Created**: `ProfileControllerIntegrationTest.java` (2 integration tests)

**承認ゲート:** あなたは **Approve** を選びます。

### ステージ 3.6 — Build and Test

aidlc-quality-agent がビルドとテストを実行します。

```
mvn clean compile        # BUILD SUCCESS
mvn test                 # 89 tests, 0 failures
mvn verify               # Integration tests pass
```

結果は `<record>/construction/build-and-test/test-results.md` にキャプチャされます。89テスト成功、0失敗、カバレッジは 62% から 64% に増加しました。

**承認ゲート:** あなたは **Approve** を選びます。

### ステージ 4.1 と 4.3 — デプロイ

Deployment Pipeline は既存のデリバリー構成を調べ、デプロイ戦略、CD 構成、ロールバックのランブックを記録します。このバグ修正は既存のターゲット環境を使うため、Environment Provisioning は飛ばされたままです。

承認後、Deployment Execution はテスト済みの成果物をそのパイプラインを通じてデプロイし、スモークテストとヘルスチェックを実行し、デプロイログを記録します。あなたは最後のゲートを承認し、ワークフローが完了します。

### 最終状態

```
aidlc/spaces/default/
  codekb/
    user-service/             # 9 space-level RE artifacts
  intents/260624-null-display-fix/
    aidlc-state.md            # All 9 stages marked [x]
    audit/                    # Full decision trail (per-clone shards)
    inception/
      requirements-analysis/ # requirements.md + questions
    construction/
      bugfix-null-display-name/
        code-generation/     # plan + summary
      build-and-test/        # instructions + test results
    operation/
      deployment-pipeline/   # CD config + strategy + rollback runbook
      deployment-execution/  # deployment log + smoke tests + health checks
```

ワークスペースルートのアプリケーションコード:
- `ProfileSerializer.java` (modified)
- `ProfileService.java` (modified)
- `ProfileSerializerTest.java` (created)
- `ProfileControllerIntegrationTest.java` (created)

### 主な観察点

1. **各ドメインステージの承認ゲート** — あなたが各決定を制御します
2. **Minimal の深さ** — 簡潔で的を絞った成果物。修正を定義するのに必要な質問だけ
3. **サブエージェントへの委譲** — 重い作業（RE、コード生成）はサブプロセスで走り、その間あなたは承認します
4. **完全な監査証跡** — すべての決定が ISO タイムスタンプとともに記録されます
5. **セッション再開** — どの時点で中断しても、`/aidlc` が進行中の状態を検出します

---

## 機能開発のウォークスルー

この例では、タスク管理アプリケーションの通知サービスを構築します。**feature** スコープは Standard の深さで33ステージすべてを実行します。このウォークスルーは全フェーズにわたる主要なステージを強調します。collaborators をオンにして（`/aidlc --collaborators on`）実行するため、以下の Inception のアンサンブルはフルの顔ぶれを示します。feature スコープはそれらをオフで出荷するので、通常それらのステージはリードエージェントだけで走ります。

### 呼び出し

```
/aidlc feature
```

> **What would you like to build?**

> A notification service for our task management app. Users should receive in-app notifications and optional email digests when tasks are assigned, due dates approach, or comments are posted. Support notification preferences per user.

### Initialization（ステージ 0.1-0.3）— 自動進行

3つの Initialization ステージは `aidlc-utility intent-create` の中で自動的に実行されます。Workspace Detection は次を特定します。TypeScript、Node.js 20、Express、PostgreSQL、既存の task サービスと user サービスを持つブラウンフィールドプロジェクトです。

> Setting up the feature workflow for this: 30 stages, 30 approval gates, 5 stages repeat per unit of work in Construction.

### Ideation フェーズ（ステージ 1.1-1.7）

**ステージ 1.1 — Intent Capture**（aidlc-product-agent）

aidlc-product-agent はまず許可されたソースの全体像を `intent-capture-questions.md` に記録し、次に問題、ターゲットユーザー、ステークホルダー、意思決定の権限、コミュニケーションのニーズ、スコープについて尋ねます。

```markdown
## Sources

- [desc] Initial description: "A notification service for our task management app..."
- [scope] Workflow-selected scope: `feature`.

## Q1. [Product owner] Which notification channels are in scope?
A. In-app only
B. In-app + email
C. In-app + email + push
D. In-app + email + push + SMS
X. Other

[Answer]: B. In-app + email
```

出来上がった成果物は、各主張をそのレジスタまたは確認済みの回答に結びつけ続けます。

```markdown
## Target Customer

Task-management users receiving assignment, due-date, or comment events. [desc]

## Notification Channels

In-app notifications and optional email digests are in scope. [Q1]

## Assumptions & Open Questions

None.
```

ステークホルダーマップは `Source` 列で同じタグを使います。裏付けのない内容はフォローアップとして尋ねられるか、`## Assumptions & Open Questions` の下に残ります。保持される前提にはあなたの明示的な受け入れが必要で、前提としてラベル付けされたままになります。その後 aidlc-product-lead-agent が、通常の承認ゲートの前にソースの裏付けをレビューします。

**ステージ 1.4 — Scope Definition**（aidlc-product-agent）

スコープの境界を定義します。スコープ内（3つのトリガータイプ、ユーザー設定、メールダイジェスト）、スコープ外（プッシュ通知、SMS、リアルタイムの WebSocket）です。`scope-document.md` と、優先順位付けされた項目を含む `intent-backlog.md` を生み出します。

**ステージ 1.7 — Approval & Handoff**（aidlc-delivery-agent）

すべての Ideation 出力を集約した initiative brief をまとめます。フェーズ境界の検証が、intent からスコープへのトレーサビリティを確認します。

> Progress: 7 of 30 stages done. Next: Reverse Engineering.

### Inception フェーズ（ステージ 2.1-2.9）

**ステージ 2.1 — Reverse Engineering**（pipeline）

既存のコードベースを2リンクでスキャンします。9つの成果物をリポジトリのスペースレベルのストア `aidlc/spaces/<active-space>/codekb/<repo>/` に書き、通知サービスが統合しなければならない既存のサービス構造、データベーススキーマ、API パターンを特定します。

**ステージ 2.2 — Practices Discovery**（aidlc-pipeline-deploy-agent）

これはサブエージェントのハブ・アンド・スポークです。aidlc-pipeline-deploy-agent が Reverse Engineering の証拠からドラフトを書き、続いて aidlc-quality-agent、aidlc-developer-agent、aidlc-devsecops-agent が、互いの貢献を見ずに並行してそのドラフトを調べます。人によるインタビューが証拠の欠落とポリシーの判断を解消し、その後リードが3つの貢献すべてを `team-practices.md`、`discovered-rules.md`、`evidence.md` に統合します。ゲートは **Approve** / **Request Changes** を提示します。Approve の後、`practices-promote` が `aidlc/spaces/<active-space>/memory/team.md` と `project.md` を書き、次にアトミックに、確定されたタイムスタンプと対応する `PRACTICES_AFFIRMED` の受領を記録します。それができて初めて、コンダクターはステージを承認済みとして報告します。昇格が欠けている、古い、または失敗していると、ゲートは開いたまま、ステージは未完了のままになります。

**ステージ 2.3 — Requirements Analysis**（aidlc-product-agent）

12の機能要件（通知トリガー、設定の CRUD、メールのレンダリング、ダイジェストのスケジューリング）と5つの非機能要件（配信レイテンシ < 5s、メールのリトライ、設定の保存）を生み出します。質問はエッジケースに踏み込みます。メール配信が失敗したらどうなるか。ダイジェストはどれくらいの頻度で走るべきか。

**ステージ 2.4 — User Stories**（mob）

aidlc-product-agent がまずペルソナとストーリーのドラフトを書きます。続いて aidlc-design-agent、aidlc-developer-agent、aidlc-quality-agent が、互いに見えない協力者としてそのドラフトを調べ、それぞれ本人印の付いた貢献ファイルを書きます。リードの aidlc-product-agent が3つの貢献すべてを `personas.md` と `stories.md` に統合してから、**Approve** / **Request Changes** のゲートを提示します。

**ステージ 2.6 — Domain Design**（aidlc-architect-agent）

aidlc-architect-agent が通知サービスのアーキテクチャを設計します。

- **コンポーネント**: NotificationService、PreferenceService、EmailRenderer、DigestScheduler — それぞれ振る舞い、依存元/依存先、所有するエンティティを持つ
- **エンティティの所有**: NotificationService は Notification + NotificationEvent を所有、PreferenceService は Preference を所有
- **根拠**: イベント駆動のトリガーパターン（ポーリングに対して）、メールキューに SQS（直接送信に対して）を Rationale セクションに記録

統合された `components.md`（`yaml` フェンスのカタログ + mermaid 図、サマリー、所有、根拠の表）に加えて `decisions.md`（ADR ログ）を生み出します。

**ステージ 2.7 — Units Generation**（aidlc-architect-agent）

3つの作業ユニットに分解します。

1. **notification-core** — Event handler, notification storage, in-app delivery
2. **notification-preferences** — Preference CRUD API, default preferences
3. **notification-email** — Email renderer, SQS integration, digest scheduler

`unit-of-work.md` と `unit-of-work-dependency.md` を生み出します。まず notification-core、次に notification-preferences、次に notification-email の順で、notification-email の設定ルックアップは preferences API に依存します。

**ステージ 2.8 — Contract Design**（aidlc-architect-agent）

システムが3つの統合ユニットに分かれるため、Contract Design はユニット間の境界を形式化します。notification-core が呼び出し元に公開する内部イベント契約と、notification-email が notification-preferences から消費する設定ルックアップ契約です。`contract-summary.md`（境界ごとに1行、それぞれインラインの仕様ブロック付き）を生み出します。

**ステージ 2.9 — Delivery Planning**（aidlc-delivery-agent）

Delivery Planning は notification-core を最初の統合スライスとして特定します。イベントは、保存された通知データと in-app 配信に届かなければなりません。後のデリバリーのまとまりは preferences と email を含み、実際の順序はそれらの依存関係に従います。Bolt ごとの DoD は `bolt-plan.md`、根拠は `risk-and-sequencing-rationale.md`、SES/SQS の依存は `external-dependency-map.md` に配置されます。エンジンは 2.7 の DAG と記録された反復の選択に従います。フェーズ境界の検証が、要件からアーキテクチャへの整合を確認します。

この例では、プロジェクトチェックは `bun run verify:notifications` です。イベントを投入し、保存と in-app 配信を検証します。コンダクターは提案するコマンドをファイル書き込みツールで `<record>/verification-command.txt` に書き、次に verification-command の決定を開きます。`decision` ツールの JSON 出力から完全な正規の `command` を、質問内のコードスパンへそのままコピーします。「Use this command to verify each completed Unit? `bun run verify:notifications`」のようにです。コマンドは決して省略されません。人は `<record>/verification-command.txt` を開くこともできます。正規コマンドは、最大1024文字の空でない単一行でなければなりません。制御文字や表示を偽装する文字（Unicode フォーマット文字。ゼロ幅や bidi 制御、行/段落区切り、ノーブレークスペース U+00A0 を含む）は拒否されます。あなたは **Approve** を選びます（そのチャット内、または新しいチャットで、それが最後に尋ねられた質問である間に）。その正確な回答を記録して初めて、タイプされたセッターがこのコマンドを intent のチェックポイント向けに認可します。

> Progress: 16 of 30 stages done. Next: Functional Design.

### Construction フェーズ（ステージ 3.1-3.7）

この新しいソースを生み出すソロのワークフローは、**unit-major、シリアルチェックポイントのデフォルト** に該当します。2.9 の Bolt プランは計画のコンテンツのままで、エンジンは `unit-of-work-dependency.md` からユニットをたどります。

**最初のユニット: notification-core — 動く統合スライス**

コンダクターは、後続のどちらのユニットを始めるよりも先に、notification-core を該当する設計ステージと Code Generation に通します。Functional Design は Notification と NotificationEvent のエンティティ、重複排除、レート制限をカバーします。NFR とインフラの作業は、該当する箇所で最初のスライスをカバーします。あなたはサマリーを確認し、生成の前にその Code Generation プランを承認します。するとユニットは、そのイベントハンドラ、通知リポジトリ、in-app 配信エンドポイントを生み出します。この例ではソースファイル3つとテストファイル4つです。

必要なレビューと完了の受領の後、コンダクターは記録されたコマンドを検証で実行します。

```bash
aidlc engine bolt checkpoint --action verify --unit "notification-core" --kind skeleton
```

より長いプロジェクトチェックには、`--action verify` に `--timeout-ms 3600000`（1時間）を加えます。デフォルトは30分で、値は最大 2,147,483,647 ミリ秒の正の整数でなければなりません。タイムアウトは所有しているプロセスグループ/ツリーを終了させ、検証を失敗として記録し、終了を確認できなければクリーンアップ不完全と報告します。[timeout contract](../reference/12-state-machine.md#construction-checkpoint-verification-timeout) を参照してください。

`verify` が `verified: true` を報告し、かつ現在のチェックポイントが `ready: true` を持ったときに初めて、コンダクターはセッションに紐づく承認の質問を開きます。

```bash
aidlc engine bolt checkpoint --action ask --unit "notification-core" --kind skeleton
```

「Verified with `bun run verify:notifications` (exit 0). Approve this completed notification-core?」を **Approve** / **Request Changes** とともに提示し、待ちます。コードスパンはサマリーではなく、記録された完全なコマンドを示します。あなたは **Approve** を選びます。このチェックポイントの質問への、その正確な返答だけが承認を認可します。そのチャット内、または新しいチャットで、それが最後に尋ねられた質問である間にです。無関係な返答、エージェント自身の言葉、別の質問への返答は認可しません。コンダクターは、あなたが答えたチャットに実際の選択を記録し、あなたが選んでいない `--user-input` を渡すことは決してありません。

```bash
aidlc engine bolt checkpoint --action approve --unit "notification-core" --kind skeleton --user-input 'Approve'
```

先の Functional Design のレビューそれ自体では、統合が機能することを確立できなかったでしょうし、その回答がこのチェックポイントを認可することもできません。`verify` を再実行すると、どのセッションであっても、この intent について開いているチェックポイントの質問とキャプチャ済みの応答が取り下げられます。コマンドと成果物が変わっていなくても、コンダクターは `verified: true` の後に再検証し、もう一度尋ねなければなりません。swarm バッチでは `finalize` に同じルールが適用されます。新しい検証とソースの着地の後、もう一度尋ねる前に `ready: true` を確認します。

自律性の選択がまだ記録されていない場合、ワークフローは次を提示します。

```
How should I continue building the remaining work?
  ▸ Continue automatically
  ▸ Review each checkpoint
```

あなたは **Continue automatically** を選びます。コンダクターは `autonomous` を記録し、シリアルに続行します。この承認の選択は swarm 実行を有効にしません。

**残りのユニット: notification-preferences、次に notification-email**

各ユニットは、次が始まる前に、それぞれ該当する設計ステージ、有効なサマリー確認、Plan Approval、コード、チェック、レビューを通ります。

- **notification-preferences** — Preference エンティティ、デフォルト、チャネルのトグル、CRUD API、リポジトリ、バリデーション。ソースファイル2つとテストファイル3つ。
- **notification-email** — 配信ルール、レンダラー、SQS コンシューマー、承認済みの設定ルックアップ契約を使ったダイジェストの cron ジョブ。ソースファイル4つとテストファイル5つ。

コンダクターは、あなたの記録済みの許可のもとで、検証済みの通常のユニットチェックポイントを、`ask` や `--user-input` なしに自動的に承認できます。Plan Approval と検証コマンドの選択は引き続きあなたを待ち、`directive.ceremony.summary_confirmation === "on"` のときのサマリー確認も同様です。すべてのユニットが承認されると、完了のみのステージディレクティブが、ステージ本体やレビュアーの作業なしに帳簿を整合させます。

**失敗はどう見えるか。** notification-email のチェックが、その SES のモックを構築できず失敗すると、ワークフローは止まって失敗を説明します。すでに完了した preferences ユニットは完了のままです。必要な修復プランの承認は人の決定のままで、自動完了の許可が失敗したチェックの検証とみなされることは決してありません。

**ステージ 3.6 — Build and Test**（aidlc-quality-agent、すべてのユニットの後に一度実行）

ビルド手順を生成し、3つのユニット全体でフルのテストスイートを実行します。47テスト成功、0失敗、カバレッジ 78% です。

**ステージ 3.7 — CI Pipeline**（aidlc-pipeline-deploy-agent）

lint、build、test、セキュリティスキャンのステージで CI パイプラインを構成します。品質ゲートはカバレッジ >= 75%、重大な脆弱性なしです。

> Progress: 23 of 30 stages done. Next: Deployment Pipeline.

### Operation フェーズ（ステージ 4.1-4.7）

**ステージ 4.1 — Deployment Pipeline** — ヘルスチェックゲート付きの Blue-green デプロイ戦略

**ステージ 4.2 — Environment Provisioning** — SQS キュー、SES 構成、通知保存用の DynamoDB テーブル

**ステージ 4.4 — Observability Setup** — 通知配信レイテンシ、メール送信レート、デッドレターキューの深さの CloudWatch ダッシュボード。配信失敗のアラーム。

**ステージ 4.7 — Feedback & Optimization** — SLO 目標（in-app 配信 99.9%、30秒以内のメール配信 99%）、コスト分析、フィードバックループのドキュメント。

### バグ修正との主な違い

| 観点 | Bugfix | Feature |
|--------|--------|---------|
| 実行ステージ数 | 9 | 33 |
| 深さ | Minimal | Standard |
| フェーズ | Initialization + Inception + Construction + Operation | 全5つ |
| 作業ユニット | Unit DAG なし。ステージレベルの作業 | 3 |
| Construction の進み方 | 既存のステージレベルのフロー | 新しい unit-major、シリアルチェックポイントのフロー（2.9 は引き続きデリバリーのまとまりを計画） |
| 条件付きステージ | ほとんど飛ばされる | ほとんど実行される |
| 承認ゲート | 通常のステージ承認 | 検証付きの人による skeleton チェックポイント。後の完了は記録された選択に従う。Plan Approval、検証コマンドの選択、サマリーは人のまま |

---

## 次のステップ

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — スコープがどのステージを実行するかを決める仕組み
- [How a Stage Runs](04-phases-and-stages.md) — ステージのプロトコルの詳細
- [Agents](06-agents.md) — エージェントのペルソナと責務
- [Artifacts Reference](14-artifacts-reference.md) — 成果物ディレクトリツリーの全体

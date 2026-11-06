# スコープ、深さ、テスト戦略

スコープは **どのステージが実行されるか** を制御します。深さは、各ステージが生む詳細の量を制御します。テスト戦略は、生成されるテストの数を制御します。合わせて、これらはライフサイクルをあなたのタスクに合わせます。手厚いエンタープライズ機能から、さっと済ませるバグ修正まで。

この章は、詳しいルーティングの参照です。どんな種類のワークフローを走らせるかを選んでいるなら、同じスコープを利用者向けの言葉で説明した [ワークフロープロファイル](workflow-profiles.md) から始めてください。

---

## 11 のコアスコープ

Core は 11 の名前付きスコープを出荷します。各スコープは、ステージの集合、デフォルトの深さレベル、デフォルトの Guard Policy 値（`enterprise` は strict、ほかは off。値が何をし、どう設定するかは [Guard Policy](13-customization.md#guard-policy) を参照）を定めます。プラグインのインストールはスコープを増やせます。インストールは、`aidlc engine plugin select <names>` で、どのプラグインのスコープが見えるかを絞れます。`plugins` の選択が core を無効にする（`aidlc` を省く）とき、core のスコープファイルはインストールされたまま残りますが、core を再び有効にするまで有効な実行時スコープではありません。Initialization のステージは、有効なすべてのスコープで依然として走ります。

下の各スコープのステージ数は、どのスコープも最初に走らせる Initialization の三つのセットアップステージの後に、そのスコープが走らせるステージです。`/aidlc --help` が与える数であり、既存コードに対する、その計画の提案と各ステージの開始が与える数です。新しいプロジェクトでは、提案は Reverse Engineering を省くので、それを走らせるスコープでは提案が一つ少なく言います。

### enterprise

**使うとき:** 完全な監査証跡、コンプライアンスレビュー、本番相当の運用を要する、規制のあるエンタープライズ機能をビルドするとき。

- **Stages:** All 30
- **Default depth:** Comprehensive
- **Includes:** 完全なコンプライアンス・セキュリティ・運用のステージ

### feature

**使うとき:** 完全な 33 ステージのライフサイクルで、どんな大きさでも新しい機能をビルドするとき。`--scope feature` または `/aidlc-feature` で明示的に選びます。

- **Stages:** All 30
- **Default depth:** Standard
- **Includes:** すべてのステージ、標準の成果物の詳細

### mvp

**使うとき:** グリーンフィールドの実用最小限の製品をビルドするとき。後半の運用ステージを飛ばしますが、完全な設計と Construction を保ちます。

- **Stages:** 20 of 30
- **Default depth:** Standard
- **Skips:** 七つの Operation ステージすべて（デプロイパイプライン、環境プロビジョニング、デプロイ実行、可観測性、インシデント対応、パフォーマンス検証、フィードバック）に加え、Ideation から Market Research、Team Formation、Approval Handoff（10 を飛ばし、20 を実行）

### poc

**使うとき:** 実現性をすばやく証明するとき。ほとんどの Ideation と Inception のステージを飛ばし、早くコードにたどり着くことに絞ります。

- **Stages:** 5 of 30
- **Default depth:** Minimal
- **Skips:** Market Research、Feasibility、Team Formation、Mockups、User Stories、ほとんどの Operation ステージ
- **Plan approval:** オフ。コードの計画が書かれると、それを挙げる一行が見え、コード生成が始まり、その行は、いつでも計画を見直すよう求められると言います。計画がビルドされる前に見ることや、どの計画についてもたずねられることも求められます

### bugfix

**使うとき:** 特定のバグを直すとき。intent のとらえからコード生成とテストまで、合理化された経路です。

- **Stages:** 6 of 30
- **Default depth:** Minimal
- **Includes:** 検証済みの修正が出荷されるよう、Deployment Pipeline と Deployment Execution
- **Skips:** Market Research、Feasibility、Team Formation、Mockups、ほとんどの設計とアーキテクチャのステージ、環境プロビジョニング、より広い運用の準備
- **Ceremony:** ステージの日記なし、修正の後の「次回に向けてそれを保つ?」の質問なし、成果物が書かれる前に確認する要約なし。センサー・すべてのステージ承認・plan approval はオンのままで、各ステージはリードエージェントだけで走ります。この作業に対して一つを戻すには `/aidlc --learnings on`、`/aidlc --summary-confirmation on`、`/aidlc --collaborators on` とタイプします

### refactor

**使うとき:** 機能を変えずに既存コードを片付けたり作り直したりするとき。

- **Stages:** 7 of 30
- **Default depth:** Minimal
- **Includes:** Functional Design に加え Deployment Pipeline と Deployment Execution
- **Skips:** bugfix と似ており、コード分析・設計・実装・既存経路でのデプロイに絞ります

### infra

**使うとき:** インフラの変更（新しい環境、CDK/CloudFormation の更新、コスト最適化）を行うとき。

- **Stages:** 10 of 30
- **Default depth:** Standard
- **Skips:** ユーザー向けのステージ（ストーリー、モックアップ、ユーザーフロー）。アーキテクチャ・インフラ・デプロイに絞ります

### security-patch

**使うとき:** CVE やセキュリティの脆弱性に対応するとき。セキュリティに関わるステージを通る速い経路です。

- **Stages:** 7 of 30
- **Default depth:** Minimal
- **Skips:** Market Research、Team Formation、Mockups、セキュリティ以外の設計ステージ

### classic

**使うとき:** v1 風の儀式が欲しいとき。Inception と Construction で、各ステージに人の承認（Construction では、作業が Unit を持つなら Unit ごと）を置きます。conditional なステージは実行時にプロジェクトに合わせます。Operation はプレースホルダのままです。ステージが宣言する実行モードは変わりません。collaborator はオフなので、各ステージはリードエージェントだけで走ります（`/aidlc --collaborators on` が補助エージェントを連れてきます）。

- **Stages:** 15 of 30
- **Default depth:** Standard
- **Default test strategy:** Standard
- **Skips:** すべての Ideation ステージ（1.1-1.7）、CI Pipeline（3.7）、すべての Operation ステージ（4.1-4.7）
- **Keywords:** なし。明示的に選ぶか、暗黙のデフォルトとして使われます
- **Ceremony:** walking skeleton と要約の確認はオフ。センサーが走り、learnings の儀式が走ります。レビューは参考です（ステージごとに一回のパス、承認ゲートでの指摘）。明示的な自律性は、マージ前の一回のレビューを保ちます。

intent の儀式を、`/aidlc --sensors on|off`、`/aidlc --learnings on|off`、`/aidlc --summary-confirmation on|off`、`/aidlc --plan-approval on|off`、`/aidlc --collaborators on|off` で上書きします。グローバルのキルスイッチ `AIDLC_DISABLE_SENSORS=1`、`AIDLC_DISABLE_LEARNINGS=1`、`AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`、`AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1`、`AIDLC_DISABLE_COLLABORATORS=1` は、それらを強制的にオフにします。plan approval はあなただけがオフにしますが、それを除けば、承認ゲート・人のターンの権限・監査・チームの書き込み保護は依然として当てはまります。[儀式のカスタマイズ](13-customization.md#ceremony-switches) を参照してください。

#### ワークショップや小さな作業のために停止を減らす

二つのステージごとの確認が、長い実行に停止を足せます。修正の後の learnings の質問と、要約の確認です。それらなしで計画を始めるには、両方のスイッチを要求と一緒にタイプして、新しい作業がそれらをオフにして作られるようにします。

```
/aidlc workshop --learnings off --summary-confirmation off <the work>
```

| Switch | 各ステージで取り除くもの | 失うもの |
|--------|-------------------------------|---------------|
| `--learnings off` | あなたがエージェントを直したステージの承認ゲートの前の「次回に向けてそれを保つ?」の質問と、ステージの日記（`memory.md`） | この作業からは何も `memory/project.md` や `memory/team.md` に書かれないので、次の実行は、この実行が教えたことを拾いません。すでにメモリにある practices は依然として読み込まれます |
| `--summary-confirmation off` | ステージが成果物を書く前の、あなたの答えの要約に対する `Looks correct` の確認 | ステージはあなたの答えからそのまま書きます。読み違えた答えは、承認ゲートで成果物に現れ、そこで直すと改訂のコストがかかります |

どちらのスイッチも、ステージの質問やその承認ゲートを取り除きません。`bugfix` と `express` はすでに両方をオフにして始まり、`classic` は要約の確認をオフにして始まります。すでに進行中の作業では、どちらか一つをあなた自身の言葉で求めるか、`/aidlc --learnings off` または `/aidlc --summary-confirmation off` とタイプします。要約の確認は、あなたが求めたときだけオフになります。

#### 進行中の classic intent を更新する

保存されたステージ計画は保たれます。Operation ステージが `EXECUTE` と記録された古い classic intent は、依然としてそれらを走らせ、ルーティング・次ステージの検索・ステータスは、その記録された計画に従います。新しい classic intent は、より小さいグリッドを使います。儀式のデフォルトは、古い intent が保存された儀式のフィールドを持たないとき、すぐに変わります。Sensors と Learnings は `on` に解決され、Summary Confirmation は classic から `off` に解決されます。要約の確認を有効にするには `/aidlc --summary-confirmation on` とするか、あなた自身の言葉で求めます。
保存された intent ごとの儀式の選択は、効いたままです。
環境のキルスイッチは、依然として優先します。

classic のレビュアーの上限も、すぐに変わります。レビュアーを持つステージは、上書きしない限り、参考の一回のパスで走ります。作業ごとの `--review` レベルは、スコープの上限を置き換えますが、ステージ自身のレビュークラスを超えられません。`--review adversarial` は、それを宣言するステージで adversarial レビューを戻し、advisory と宣言されたステージは advisory のまま、`--review none` は依然としてそれを下げます。以前の classic のグラフを、CI Pipeline と Operation ステージとともに走らせるには、`aidlc engine scope change --scope workshop` で intent を workshop に変えます。workshop は、完全な Inception から Operation の計画を保ち、デフォルトで Minimal のテスト戦略を使います。必要なら、そのスコープ変更に `--test-strategy standard` を足して、本番の Standard のテスト戦略を保ってください。

### workshop

**使うとき:** 確立された、完全な Inception から Operation のライフサイクルと、軽めの教育用テストの下限で、ファシリテートするワークショップやトレーニングラボを走らせるとき。

- **Stages:** 23 of 30
- **Default depth:** Standard
- **Default test strategy:** Minimal
- **Skips:** すべての Ideation ステージ（1.1-1.7）
- **Keywords:** `workshop`、`lab`、`training`

### express

**使うとき:** 設計のパスやレビュアーの送り出しなしで、要件からコードとテストを経て条件付きのデプロイの末尾まで、いちばん軽い経路が欲しいとき。

- **Stages:** 7 of 30
- **Default depth:** Minimal
- **Review cap:** None
- **Includes:** Initialization、conditional な Reverse Engineering、Requirements Analysis、Code Generation、Build and Test、そして conditional な Deployment Pipeline、Deployment Execution、Observability Setup のステージ
- **Skips:** Ideation、設計、Units Generation、Delivery Planning、CI Pipeline、環境プロビジョニング、後半の運用ステージ
- **Plan approval:** poc と同じくオフ。各コードの計画は、それを挙げる一行の後に、書かれたとおりにビルドされます。その行は、いつでも見直すよう求められると言います

---

## スコープルーティング表

正式なデータは、`.claude/scopes/aidlc-<name>.md` ファイル（スコープの identity）、プラグインのスコープファイル、それに各ステージの `scopes:` フロントマター（membership）にあり、`.claude/tools/data/scope-grid.json` にコンパイルされます。コンパイルされたグリッドは、現在のプラグイン選択で有効なスコープだけを含みます。ライブのコンパイル済みの表には `aidlc engine gen scope-table` を（利用者向けのワークフローとスコープの一行説明には `aidlc engine orchestrate help` を）実行します。

| Scope | EXECUTE / Total | Depth | Test Strategy | Use Case |
|-------|-----------------|-------|---------------|----------|
| `enterprise` | 33 / 33 | Comprehensive | Comprehensive | 規制のあるエンタープライズ機能、完全な監査証跡 |
| `feature` | 33 / 33 | Standard | Standard | 新しい機能の完全なライフサイクル |
| `mvp` | 23 / 33 | Standard | Standard | グリーンフィールド、後半の運用を飛ばす |
| `poc` | 8 / 33 | Minimal | Minimal | 実現性を速く証明する |
| `bugfix` | 9 / 33 | Minimal | Minimal | 特定のバグを直して出荷する |
| `refactor` | 10 / 33 | Minimal | Minimal | 既存コードを片付けて出荷する |
| `infra` | 13 / 33 | Standard | Standard | インフラの変更 |
| `security-patch` | 10 / 33 | Minimal | Minimal | CVE への対応 |
| `classic` | 18 / 33 | Standard | Standard | v1 風の Inception + Construction。暗黙のデフォルト |
| `workshop` | 26 / 33 | Standard | Minimal | 教育向けのテストを伴うファシリテートするライフサイクル |
| `express` | 10 / 33 | Minimal | Minimal | 要件から条件付きのデプロイまで、設計やレビュアーなし |
| (proposed) | Varies | Varies | Varies | エージェントがあなたの自由記述の intent から一つ提案し、あなたが確定する |

スコープは儀式の量で一桁も違います。`poc` は狭い一回のパスの経路を走らせ、`feature` は Initialization の後に 30 のステージと 30 の承認ゲート（新しいプロジェクトでは Reverse Engineering が飛ばされるのでそれぞれ 29）、そして Construction で作業の各 Unit に対して繰り返す五つのステージ（四つの設計ステージと Code Generation）を走らせます。スコープ確認の行は、実効の数（ステージ数、承認ゲート数、Unit ごとのファンアウト）を、見積もりに頼らず、コンパイル済みのグリッドとワークスペースのスキャンから計算して挙げます。グリーンフィールドの作業はリバースエンジニアリングを除き、`units-generation` を飛ばすスコープは、Unit の DAG がないので Unit ごとの節を省きます。ワークフローが始まる前に、あなたは何に同意しているかを知ります。

> **プロジェクトごとのデフォルトスコープ:** チームは、`.claude/settings.json` に `AWS_AIDLC_DEFAULT_SCOPE` を設定して、プロジェクトのデフォルトスコープをあらかじめ決められます。[カスタマイズ § プロジェクトごとのデフォルトスコープ](13-customization.md#per-project-default-scope) を参照してください。

---

## スコープ別ステージマトリクス

上のルーティング表は数を与えます。このマトリクスは、各ストックスコープの下で **どの** ステージが実行されるかを正確に示すので、ワークフローを始める前に何を通るかが見えます。✓ は、そのスコープの下でそのステージが EXECUTE であること、空のセルは SKIP を意味します。ステージ番号と名前は [フェーズとステージ](04-phases-and-stages.md) に一致します。

<!-- BEGIN scope-stage-matrix: derived from each stage's `scopes:` frontmatter via the compiled scope-grid.json — kept in sync by tests/unit/t244-scope-matrix-doc-sync.test.ts; do not hand-edit cells without re-checking that test -->
| # | Stage | `enterprise` | `feature` | `mvp` | `poc` | `bugfix` | `refactor` | `infra` | `security-patch` | `classic` | `workshop` | `express` |
|---|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 0.1–0.3 | Initialization (all 3 stages) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1.1 | Intent Capture & Framing | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| 1.2 | Market Research | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 1.3 | Feasibility & Constraints | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.4 | Scope Definition | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.5 | Team Formation | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 1.6 | Rough Mockups | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.7 | Approval & Handoff | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 2.1 | Reverse Engineering | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 2.2 | Practices Discovery | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 2.3 | Requirements Analysis | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 2.4 | User Stories | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.5 | Refined Mockups | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.6 | Domain Design | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.7 | Units Generation | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.8 | Contract Design | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.9 | Delivery Planning | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 3.1 | Functional Design | ✓ | ✓ | ✓ |  |  | ✓ |  |  | ✓ | ✓ |  |
| 3.2 | NFR Requirements | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ |  |
| 3.3 | NFR Design | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 3.4 | Infrastructure Design | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 3.5 | Code Generation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 3.6 | Build and Test | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 3.7 | CI Pipeline | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  | ✓ |  |
| 4.1 | Deployment Pipeline | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| 4.2 | Environment Provisioning | ✓ | ✓ |  |  |  |  | ✓ |  |  | ✓ |  |
| 4.3 | Deployment Execution | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| 4.4 | Observability Setup | ✓ | ✓ |  |  |  |  | ✓ |  |  | ✓ | ✓ |
| 4.5 | Incident Response | ✓ | ✓ |  |  |  |  |  |  |  | ✓ |  |
| 4.6 | Performance Validation | ✓ | ✓ |  |  |  |  |  |  |  | ✓ |  |
| 4.7 | Feedback & Optimization | ✓ | ✓ |  |  |  |  |  |  |  | ✓ |  |
| | **Total stages** | **33** | **33** | **23** | **8** | **9** | **10** | **13** | **10** | **18** | **26** | **10** |
<!-- END scope-stage-matrix -->

✓ は静的なスコープの membership を示します。ステージがそのスコープの計画に含まれることを意味し、無条件に実行されることを意味しません。CONDITIONAL なステージは、その条件が成り立たないとき実行時に飛ばされることがあり（たとえば、Reverse Engineering はブラウンフィールドのプロジェクトでだけ走ります）、保留中のステージは、承認された composer の提案を通じて作り変えられます（[composer](#the-adaptive-composer) を参照）。composed（カスタム）のスコープは、ここに挙げません。それらのグリッドは、ストックのものと並んで `scope-grid.json` にあります。

---

## エージェントが計画を提案する

スコープを明示的に指定する必要はありません。欲しいものを説明すれば、エージェントがあなたの言葉から計画を提案します。

```
/aidlc Build a REST API for inventory management
```

エンジンはあなたの要求を保ち、このプロジェクトで AI-DLC が出荷するすべての計画とともにエージェントに渡します。各計画がここで何ステージ走らせるか、何のためか、その作者が計画ファイルに書いたヒント語（`scopes/aidlc-<name>.md` の `keywords:`）です。ヒントは、あなたの言葉の残りと同じように、エージェントが読みます。ツールがそれらを照合することはありません。エージェントは、あなたが説明したものに合う計画を提案し、あなたはコンパイル済みのグリッドから直接、それとともに一つの質問を得ます。新しいプロジェクトでの `/aidlc Fix the timeout on the export endpoint` は、こう読めました。既存のコードベースでは bugfix も Reverse Engineering を走らせるので、その行は 6 ステージ・6 承認ゲートと言います。

```text
 Plan
 I'd run the "bugfix" plan for: "Fix the timeout on the export endpoint" - 5 stages, 5 approval
 gates. Do you want me to go ahead with it, use a different plan, or tailor one to this task?
 > 1. Go ahead with the "bugfix" plan
      5 stages focused on fixing this specific bug.
   2. Use a different plan
      Pick another ready-made plan.
   3. Tailor a plan to this task
      Have a plan composed specifically for this fix.
   4. Type something.
   5. Chat about this
```

進めてよければ進める、別の計画を使う（エージェントがほかの計画を長さとともに挙げ、あなたが一つ選ぶかその名前をタイプする）、または一つあつらえて、ワークフローが始まる前に軌道を直します。あなたが説明したものに合う出来合いの計画がないとき、エージェントは代わりにあつらえることを提案し（「None of the ready-made plans is an obvious fit for ...」）、直接選べる計画をその横に挙げます。あなたが要求と一緒にタイプした設定（`--depth minimal`、`--learnings off`）は、質問の答えに乗るので、作業はそれらとともに始まります。どの計画が提案されても、それがあなたの intent に合うか確かめてください。選ぶのは質問でのあなたです。

---

## 適応する composer

名前も提案もないとき使われるデフォルトの計画は `classic` です（プロジェクトは `AWS_AIDLC_DEFAULT_SCOPE` でそれを変えられます）。利用者向けのフローで、エージェントはあなたの要求を読み、出来合いの計画を提案するか、合うものがなければあつらえることを提案します。あなたが答える前に、何も始まりません。compose を強制することもできます。

```
/aidlc compose "harden the deployment pipeline and add observability"
/aidlc-compose "same thing, as a typeable shortcut"
/aidlc compose --report sonar.json     # compose from a scan report
/aidlc --new-scope "..."               # force a custom plan even on a stock match
```

composer エージェントはあなたのタスクを読み、五つの実装エントロピーの要素（intent のあいまいさ、コードベースの構造的な不確かさ、検証のエントロピー、リスク、未解決の前提）を見積もり、実行可能な最小のワークフローを組み立てます。成果が依存するすべての成果物を依然として生む、いちばん十分でない EXECUTE/SKIP のグリッドです。構造の見積もりは、CodeKB サーバーが設定されインデックスされているとき、CodeKB MCP の呼び出しグラフとコンポーネントの分析に根ざします（任意の外部ツール。AI-DLC には何も同梱されません）。そうでなければ、composer は制限されたワークスペースのスキャン（ブラウンフィールド/グリーンフィールド、言語）に戻ります。提案は短い申し出としてあなたに来ます。これがどんな種類の変更に見えるか、composer がどれだけの process を勧め、その手順が平たい言葉で、二、三文。それから計画の名前・ステージ数・承認の質問の一行と、承認の前に変えられる Guard Policy とそのスコープ設定の行です。あつらえた計画が、走るストックスコープが走らせるステージを飛ばすとき、または保つステージが使うステージを飛ばすとき（そのスコープが設計上省くものを超えて）、申し出は一度、一行でそれぞれを挙げて言います（「This plan skips Units Generation, which Contract Design, Functional Design and Code Generation use, and Deployment Execution」）。求めれば、エージェントはスコアの内訳（各要素を LOW/MED/HIGH の帯とその証拠で）と、すべての EXECUTE と SKIP の理由を示します。既存のコードで、あつらえた計画は常に Reverse Engineering を含み、それは再びスキャンする前に、以前のスキャンが残したコードマップを確認します。composer が CodeKB の証拠を持ちそれを省くことを提案する場合を除きます（下の CodeKB の根拠を参照）。計画が作られると、そのスコアと証拠の方法は、作業の最初の監査エントリに保たれます。あなたは承認・編集・却下します。明示的な承認の前に、何も書かれず、ワークフローも始まりません。計画は、それが承認された作業に当てはまるので、あなたが求めない限り、compose がスコープのリストに足すことはありません。承認すると:

- 提案がストックスコープに MATCHED したなら、AI-DLC はそのスコープで直接ワークフローを作ります（コードレベルの指摘でいっぱいのスキャンレポートは、ふつうこのやり方で `bugfix` か `security-patch` にルーティングされます）。
- CUSTOM な計画では、AI-DLC はいちばん近い適切なストックスコープ（walking skeleton がなく、計画の深さ以外のテスト戦略がなく、計画がゲートで示したとおり走るもの。新しいプロジェクトでは、`bugfix`・`refactor`・`security-patch` が合うときそれらよりも、新しい作業向けのもの）で、計画自身のステージの変更と深さとともに、同じターンでワークフローを作り、スコープファイルを書きません。作業の状態は `Plan: <name>` を記録します。composer が勧めゲートが示した名前（与えなかったときは `tailored plan`）で、`/aidlc status` がそれを示します。計画が走るスコープは、そこに挙げられません。カスタムな計画のゲートには二つ目の承認、**Approve and save as scope** があります。名前を求め（composer が一つ勧めます）、計画を再利用できるスコープとしても保ちます。
- 計画を後で保つには、平たい言葉で求めます（「save this plan as quick-fix」）。AI-DLC は `aidlc engine scope save --name quick-fix` を走らせ、走っている作業の現在の計画を、その設定と Guard Policy とともにスコープとして書き、それを再利用するコマンド（`/aidlc --scope quick-fix "..."`）を挙げます。保存されたスコープは、どのストックスコープとも同じように解決し、グラフの再コンパイルとエンジンの再インストールを生き延び、ハーネスの間を旅します（[保存されたスコープの置き場所](#where-a-saved-scope-is-stored) を参照）。
- すべての front/report の提案は、空でない `creationDescription` を帯びます。compose の要求にタスクのテキストが含まれていたなら、それはそのテキストそのままです。report だけとタスクのない提案は、承認された findings/plan からそれを導きます。同じターンの作成は、それを、composition の `--request` id（作業をそのゲートに結びつけます）とともに、リテラルの `--` 区切りの後に、一つのシェルセーフな argv 値（シェルで描画されるとき POSIX でシングルクォート）として渡すので、状態の Project フィールドと intent 記録の slug は、シェルのメタ文字を含む・フラグで始まる説明を保ちます。compose の承認は、スコープだけで説明なしでは続けられません。
- すでにほかの作業を抱え、何も選ばれていないプロジェクト（たとえば、intent 記録がコミットされたリポジトリの新しいクローン）では、AI-DLC はまず、承認された計画がその作業の一部か、別の新しい作業か、それへの変更かをたずねます。別の新しい作業を選ぶと、承認した計画が、そのステージの変更と設定とともに作られます。そこで別のストックの計画を挙げると、その計画が同じ設定で始まり、承認した計画自身のステージの変更はつきません。どちらでも作業は一度始まり、ゲートで言った「skip plan approval」は依然として当てはまります。

**ゲートでの設定:** ステージのグリッドに加え、front/report の提案は、計画の Guard Policy とその六つのスコープ設定（`sensors`、`learnings`、`summary_confirmation`、`plan_approval`、`collaborators`、`review_cap`）を挙げ、各グループを自分の行に一行の理由とともに置きます。それで、composed な計画は、ステージそのものと同じように、そのステージの中の儀式も削れます。小さく、よく分かった修正は、センサーと learnings をオフにし、レビューを advisory に上限した状態で走るかもしれません。MATCHED な提案は、ストックスコープの値から始まります。カスタムな計画は、自分のステージを選びますが、`classic` スコープの儀式、つまり compose なしで得られるワークフローから始まります。Guard Policy オフ、要約の確認と collaborator オフ、レビュー advisory、そしてセンサー・learnings・plan approval オン。composer は、あなたのタスクが理由を与えるときだけ設定を動かし（要約の確認は、タスクが非常にあいまいなときだけ戻ります）、メモリの層が strict に保たない限り Guard Policy をオフに保ちます。あなたはゲートでそれを上げられます。どちらでも、計画が走るストックスコープと異なる値は、この作業にだけ当てはまり、新しいスコープファイルはなく、あなたが保つ計画は、それらをそのフロントマターに蓄えます。承認の前にどの変更も求めれば行われます。ストックの計画の Guard Policy を下げると、その値を帯びるストックスコープの上の、カスタムな計画になります。plan approval はゲートが示す値を保つので、カスタムな計画は、走るストックスコープがたずねずにビルドするときも、それをオンに保ちます。ゲートで「skip plan approval for this work」と言えば、作業はそれをオフにして、あなたが設定して作られます。ほかのどの設定も承認ゲートを取り除きません。ワークフローの途中では、平たい言葉で求めれば（「turn sensors off」「give this full reviews」）、ゲートなしで走っている作業に変更が当てられます（[儀式のスイッチ](13-customization.md#ceremony-switches) を参照）。作業ごとに設定したレビューレベルは、そのスコープの上限を置き換えるので、より強いレビューはステージを変えず、スコープ自身のレベルを設定すると、そのふつうのレビューに戻ります。composer がワークフローの途中の compose で自分から勧める設定は、ゲートに現れ、あなたが承認したときだけ当たります。ワークフローの途中で要約の確認をオフにするのは、あなた自身が行う変更です。平たい言葉で求めるか（「skip the looks correct check from now on」）、ゲートでそれを承認すると、エージェントはそれをオフにし、あなたの言葉と、それを戻す方法とともに、一行でそう言います。plan approval は、あなただけが、あなた自身の言葉で、または `/aidlc config set plan-approval off` とタイプして、オフにします。composer がワークフローの途中でそれをオフにすることを提案することはありません。

**CodeKB の根拠（任意）:** CodeKB は、コードベースの事前計算された構造分析（呼び出しグラフ、コンポーネントインベントリ、パッケージ間の結合）を供する外部の MCP サーバーです。AI-DLC はそれを同梱せず、要しません。それなしでは、composer は制限されたワークスペースのスキャンから構造をスコア付けし、それがふつうの経路です。実際につないだとき、composer はそれを唯一の構造の証拠源として使い、提案でそれを引用します（`method: codekb`）。つなぎ方はハーネスによります。Claude Code では、サーバーをプロジェクトの `.mcp.json` に足します（サブエージェントはセッションの MCP サーバーを受け継ぎます）。Codex では、`config.toml` に `mcp_servers` エントリを足します。opencode では、opencode の設定に足します。Copilot CLI では `~/.copilot/mcp-config.json` に、VS Code では `.vscode/mcp.json` に足します。Kiro では、`.kiro/settings/mcp.json`（またはあなた自身の `~/.kiro/settings/mcp.json`）に `"disabled": true` なしで足します。Kiro CLI の v2 エンジンでは、それから config を再び走らせると、composer エージェントにそれを付与します。v3 エンジンと Kiro IDE では、composer はそのまま得ます。CodeKB を、フレームワーク自身の「codekb」ディレクトリ（`aidlc/spaces/<space>/codekb/`）と混同しないでください。それは Reverse Engineering ステージが書くローカルな成果物の置き場で、MCP サーバーとは無関係です。CodeKB の証拠があると、composer は Reverse Engineering を飛ばすことを提案することがあります。提案は、後続のステージがそのローカルな置き場なしで走ることを明かさねばならず、あなたがゲートで決めます。

**キーワードの衛生:** 保存されたスコープは `keywords: []` で出荷されるので、保存された計画は、エージェントの計画提案のステップにヒントを持ち込みません。将来のプロンプトのためにヒントを与えるのは、保存するときの明示的な選択であり（`scope save --keywords <word,...>`、単語一つずつ。別の計画がすでに持つヒントも保存され、保存は、計画提案が両方の下にそれを挙げると一行で言います）、副作用ではありません。

**進行中の recompose:** ワークフローの途中、`/aidlc compose` は、走っているワークフローの PENDING なステージを作り変えることを提案します。もう要らないものを飛ばし、要ると気づいた保留中のステージを戻します。composer は、完了したステージが実際に何を解決したかからエントロピーの要素を見積もり直すので、提案される各反転は、スコアを動かした証拠を挙げます（「feasibility settled the integration questions - risk re-scores MED」）。反転は、保留中の、カーソルより前のステージにだけ当たり（完了したステージと進行中のステージは凍結されます）、残りのどのステージも必要な入力を欠かないよう strict に検証され、監査ロックの下で `RECOMPOSED` 監査イベントとともに決定的な `recompose` 動詞を通って落ち着きます。一つの承認がステージの変更と設定をまとめて覆うとき、同じ `recompose` が両方を一つの書き込みで当てるので、計画が半分だけ変わったまま残ることはありません。要約の確認オフは、自分の設定を通り、あなたが承認したとき、エージェントがすぐ後でそれを当てます。Construction の最初の EXECUTE ステージは、recompose で反転できません。これはステージルーティングのアンカーを守ります。最初の設計ステージのレビューを、動く統合された skeleton の証明にするわけではありません。やり切った作業は、自分の計画でそれ以上のステージを取りません。もっと求めると、その最後のステージの後にそれらを走らせる計画が挙げられ、あなたが選ぶものに切り替えると（`/aidlc --scope <plan>`）、やってあることを保ったまま、そこで作業が開き直します。

リテラルの動詞は要りません。「what else can we cut? we already know this market」のような平たいチャットは、ワークフローの途中で作り変えの要求と認められ、同じゲートと同じ `recompose` 動詞を通ってルーティングされます。あなたがステージを自分で挙げると（「can we skip market research?」「drop market-research and team-formation」）、計画はすぐに、ゲートなしで変わり、返信は取り消しを挙げます。`recompose` は、計画が取れない変更を依然として拒否し、なぜかを言います。代わりに計画を挙げると（「switch this to the express plan」）、`/aidlc --scope express` がするように、作業はその場でそれに切り替わり、ゲートはありません。やってあることはやったまま残り、返信は何が変わったかを言います。あなたが貼った文書の中のテキストが、ステージを挙げたことになることはありません。Claude 以外のハーネスでは、リテラルの `/aidlc compose "<request>"` 動詞が、文書化された信頼できる経路のままです。

### 保存されたスコープの置き場所

ストックスコープはエンジンに属します。ビルドのたびにハーネスのツリーへ再生成されます。composed な計画から保存したスコープは *あなたのもの* です。エンジンのどこもそれを生まないので、あなたの作業の残りとともに蓄えられます。

| | Path | Role |
|---|---|---|
| **Record** | `aidlc/scopes/<name>.md` | 永続的な源。あなたのスコープファイルに、EXECUTE/SKIP の計画を抱える生成されたグリッドの領域を加えた、一つのファイル。`aidlc/` ツリーの残りとともにコミットする |
| **Projection** | `<harness>/scopes/aidlc-<name>.md` + `scope-grid.json` の一列 | 実行時が読むもの。`aidlc engine graph compile` が record から再生成する |

二つのことが続き、どちらもかつては失敗していました。

- **エンジンの再インストールでスコープを失えません。** ハーネスのツリーを置き換えると projection は捨てられます。次の `graph compile` が record からそれを作り直します。これはとりわけコピーチャンネルで効いてきます。そこでは `scope-grid.json` は、どのコピー被せも置き換える生成されたファイルです。
- **保存されたスコープはハーネスの間を旅します。** record は、共有された、ツール中立の `aidlc/` ツリーにあるので、`.kiro/` や `.codex/` で作業する協力者は、`.claude/` であなたが保存したスコープを、一度の `graph compile` の後に解決します。

以前のリリースの composed なスコープを持っているなら、それはハーネスのツリーにだけあります。更新後の最初の `graph compile` が、一度、あなたのためにその record を書きます。それ以降、record が源です。

#### record の形

sentinel のコメントの上はすべて、あなたが編集してよいものです。フロントマターも散文も、あなた自身の Markdown の見出しとフェンスしたコードを含みます。sentinel の間はすべて生成されます。その領域をファイルの **末尾** として扱ってください。散文をその上に書いてください。そこが `graph compile` がハーネスのツリーへ projection する部分だからです。END の sentinel の *下* に足したものは record に残りますが（すでにある record を書き直すものはありません）、ハーネスのスコープファイルへは運ばれません。

````markdown
---
name: my-lean-feature
depth: Standard
keywords: []
---

# my-lean-feature

Whatever you want to write, including a "## Stage Grid" heading of your own.

<!-- BEGIN aidlc composed-scope-grid: generated by `aidlc engine graph compile` — reshape the plan through /aidlc compose, not by editing here -->

```json
{ "stages": { "intent-capture": "EXECUTE", "units-generation": "SKIP" } }
```

<!-- END aidlc composed-scope-grid -->
````

計画は、その領域を編集してではなく、`/aidlc compose` で作り変えてください。手編集したグリッドは、ステージグラフに対して検証されないので、ステージが必要とする入力をステージから奪うことがあります。

sentinel の上の部分を編集するのはかまいませんが、`graph compile` がハーネスのスコープファイルを書くのは、それが **欠けている** ときだけで、あなたが編集したものを上書きしないことに注意してください。だから、record の `depth` や `description` を変えるなら、`<harness>/scopes/aidlc-<name>.md` を消して再コンパイルし、それを再び projection してください。計画そのものは常に record から来るので、これは記述のフィールドにだけ効きます。

#### record が読めないとき

フロントマター・その `name`・その生成されたグリッドの領域を欠く record は、ファイルパスと必要な編集を挙げて `graph compile` と `aidlc update` を **止めます**。コミットされた作業なので、黙って飛ばされることは決してありません。挙げられたファイルを直すか、消してください。ハーネスの projection がまだあるなら、次のコンパイルがそれから新しい record を埋め戻します。`/aidlc --doctor` の **Composed scope durability** 確認は、グリッドの列のないスコープファイル、まだ projection されていない record、そしてスコープがもう解決しない実行可能なワークフローを報告します。

---

## 3 つの深さレベル

深さは、各ステージで生まれる成果物の詳細レベルを制御します。スコープがデフォルトの深さを設定しますが、あなたが上書きできます。

| Depth | Artifact Detail | When to Use |
|-------|----------------|-------------|
| **Minimal** | 核となる要点だけ。短い文書、重要な判断、最小限の補助分析。 | 速い修正、パッチ、実証 |
| **Standard** | バランスの取れた詳細。完全な要件、根拠つきのアーキテクチャ判断、丁寧なテスト計画。 | ほとんどの機能と MVP |
| **Comprehensive** | 完全なエンタープライズの詳細。網羅的な要件、コンプライアンスマトリクス、詳しい NFR 仕様、完全な監査文書。 | 規制のある機能、エンタープライズのデプロイ |

### 深さがステージにどう効くか

各ステージで、エージェントはアクティブな深さに基づいて出力を調整します。

- **Minimal:** 1〜2 ページの成果物、重要な判断だけ、任意のセクションを飛ばす
- **Standard:** 完全な成果物、必要なすべてのセクション、簡潔な根拠
- **Comprehensive:** 広げた成果物、任意のセクションを含む、詳しい根拠付け、コンプライアンスの相互参照

### 深さを上書きする

深さは三つの地点で変えられます。

1. **`--depth` CLI フラグで**。呼び出し時に深さを上書きします。
   ```
   /aidlc --depth comprehensive
   /aidlc --scope bugfix --depth standard
   /aidlc --stage code-generation --depth minimal
   ```
2. **スコープの確認で**。エンジンが提案した計画を確定するよう求めたとき、ただ確定するのではなく `--depth <level>` で返します
3. **どの承認ゲートでも**。フィードバックの一部として、別の深さレベルを求めます

エージェントは、セッションごとに一度、その最初の完了メッセージで、現在の深さ（各文書にどれだけの詳細を書くか）とテスト戦略（いくつのテストを書くか）、そしてどの承認ゲートでもどちらも変えるよう求められることを、あなたに思い出させるよう求められます。あなたは、あなた自身の言葉で、または `/aidlc --depth <level>` で、いつでも求められます。

---

## スコープを直接指定する

### 明示的なスコープ

```
/aidlc feature
/aidlc bugfix
/aidlc enterprise
```

### 説明つきのスコープ

```
/aidlc bugfix Fix the login timeout issue
/aidlc poc Build a quick prototype for the search feature
```

### ユーティリティコマンドでスコープを上書きする

```
/aidlc --scope bugfix
/aidlc --scope enterprise --stage code-generation
```

`--scope` フラグは、ジャンプの操作のため `--stage`、`--phase`、`--depth` と組み合わせられます。

### 深さを上書きする

```
/aidlc --depth minimal
/aidlc --scope bugfix --depth comprehensive
/aidlc --scope enterprise --depth standard --stage code-generation
```

`--depth` フラグは、スコープのデフォルトの深さレベルを上書きします。有効な値: `minimal`、`standard`、`comprehensive`（大文字小文字を区別しません）。

### テスト戦略を上書きする

```
/aidlc --test-strategy minimal
/aidlc --depth standard --test-strategy minimal
```

`--test-strategy` フラグは、深さと独立してテスト戦略を上書きします。完全な説明は、下の [3 つのテスト戦略レベル](#the-3-test-strategy-levels) を参照してください。

---

## 3 つのテスト戦略レベル

テスト戦略は、生成される **テストの数** と、含まれる **テストの種類** を制御します。深さとは独立しています。深さは成果物の詳細（文書、図、質問）を制御し、テスト戦略はテストの量だけを制御します。この分離で、カバレッジより速さが大事なとき、完全な Standard 深さのワークフローを Minimal のテストで走らせられます。

### Minimal — ナイキストモデル

信号処理のナイキストレート（信号を復元するのに要る最小のサンプリング周波数）に着想を得ています。Minimal のテスト戦略は、すべての要件を検証するのに要る最小のテストを生成します。それ以上でも以下でもありません。

- **識別された要件ごとに 1 テスト**（コンポーネント駆動ではなく要件駆動）
- **ハッピーパスの下限:** どの要件も対応づかなくても、すべてのコンポーネントが少なくとも 1 つのハッピーパスのユニットテストを得ます
- **デフォルトでユニットテスト。** bugfix/security-patch の的を絞った回帰は、欠陥を再現するいちばん狭いレベルがそれのとき、統合や E2E を使うことがあります。関係ないテストの量は Minimal のままです。
- 典型的なプロジェクトで **合計 ~5〜15 テスト**
- 緩い指針です。安全が重要な文脈が要求すれば、エージェントは超えられます

**最適:** ワークショップ、トレーニングセッション、実証、速いバグ修正。完全なテストスイートに投資せずに正しさを検証したい、どんな文脈でも。

### Standard — コンポーネントごとモデル

コンポーネント間の境界を検証する、バランスの取れたテストカバレッジです。

- **コンポーネントごとに 5〜8 テスト**
- **ユニット + 統合テスト**（コンポーネント間の重要な境界）
- E2E・パフォーマンス・セキュリティのテストは、NFR 要件が明示的に求めるときだけ
- **テストピラミッドの比率:** ~75% ユニット / ~20% 統合 / ~5% E2E
- 緩い指針です

**最適:** ほとんどの機能と MVP。テストに過剰投資せずに、よいカバレッジを。

### Comprehensive — 完全カバレッジモデル

すべてのテストの種類にわたる、丁寧なテストカバレッジです。

- **コンポーネントごとに 10〜15 テスト**
- **すべてのテストの種類:** ユニット + 統合 + E2E + パフォーマンス（NFR があれば）+ セキュリティ（NFR があれば）
- **テストピラミッドの比率** がすべての種類にわたって当てはまります
- 緩い指針です

**最適:** エンタープライズの機能、規制のあるシステム、テストカバレッジの監査証跡を要する、どんな文脈でも。

### テスト戦略のデフォルトの働き

ほとんどのコアスコープは、テスト戦略を深さから受け継ぎます。だから `classic` は本番の Standard のテストの下限を使い、`express` は要件駆動の Minimal の下限を使います。`workshop` は、教育のセッションのため、Standard 深さで明示的な Minimal の上書きを保ちます。いつでも `--test-strategy` で上書きできます。

### テスト戦略を上書きする

テスト戦略は三つの地点で変えられます。

1. **`--test-strategy` CLI フラグで**。呼び出し時に上書きします。
   ```
   /aidlc --test-strategy minimal
   /aidlc --depth standard --test-strategy minimal
   /aidlc --scope bugfix --test-strategy comprehensive
   ```
2. **ワークフローの途中で**。アクティブなワークフローのテスト戦略を変えます。
   ```
   /aidlc --test-strategy comprehensive
   ```
3. **どの承認ゲートでも**。フィードバックの一部として、別のテスト戦略を求めます

### よくある深さ + テスト戦略の組み合わせ

| Depth | Test Strategy | Effect | When to use |
|-------|--------------|--------|-------------|
| Standard | Standard | 完全な成果物、バランスの取れたテスト | Feature、classic、ほかの本番スコープ |
| Standard | Minimal | 完全な成果物、ナイキストのテスト | ワークショップ、時間を区切ったセッション |
| Minimal | Minimal | 軽い成果物、要件駆動のテスト | Express、速いバグ修正、パッチ |
| Comprehensive | Comprehensive | すべてを完全に | 規制のあるエンタープライズ機能 |
| Comprehensive | Standard | 完全な成果物、バランスの取れたテスト | 実用的なテストのエンタープライズ |
| Minimal | Comprehensive | 軽い成果物、丁寧なテスト | 確信が要る重要なバグ修正 |

---

## 正しいスコープを選ぶ

| Situation | Recommended Scope |
|-----------|------------------|
| 本番アプリケーションの新しい機能 | `feature` |
| 一から作るグリーンフィールドの製品 | `mvp` または `feature` |
| 手法の速い検証 | `poc` |
| 直すべき既知のバグ | `bugfix` |
| ふるまいを変えないコードの片付け | `refactor` |
| 新しい AWS 環境や CDK の変更 | `infra` |
| CVE やセキュリティの脆弱性への対応 | `security-patch` |
| コンプライアンスを要する規制のある機能 | `enterprise` |
| 最小限の儀式の v1 風 Inception + Construction | `classic` |
| 軽量な要件からデプロイまでの実行 | `express` |
| AI-DLC のワークショップやトレーニングラボ | `workshop` |

迷ったら、変更の大きさで計画を選びます。小さく、よく分かった変更には、すべてのステージを走らせる `feature` で始めるのではなく、`express`（既知のバグなら `bugfix`）で始め、欲しい一つのステージを足します。

```
/aidlc express --add functional-design <the change>
/aidlc bugfix --add functional-design <what is broken>
```

`--add` は、この作業の計画にだけステージを置き、スコープの残りをそのままにするので、Functional Design 付きの `express` は、依然としてレビュアー・センサー・learnings の質問・要約の確認・plan approval なしで走ります。変更がまずそのコンポーネントの名指しを要るなら、代わりに `domain-design` を足します。すでに進行中の作業では、`/aidlc --add <stage>` が、まだ走っていないステージを足します（[CLI コマンド](12-cli-commands.md) の `--skip` / `--add` を参照）。完全なライフサイクルを要る本番の機能には `feature` を、Ideation や Operation のない v1 風の Inception と Construction の体験には `classic` を選んでください。

---

## 次のステップ

- [フェーズとステージ](04-phases-and-stages.md) — 各ステージが何をするか
- [エージェント](06-agents.md) — どのエージェントがどのスコープに参加するか
- [スキルとランナーコマンド](17-skills.md) — bugfix、express、feature、mvp、security-patch のための一語の `/aidlc-<scope>` ランナー
- [CLI コマンド](12-cli-commands.md) — 完全なコマンド参照
- [用語集](glossary.md) — 用語の参照

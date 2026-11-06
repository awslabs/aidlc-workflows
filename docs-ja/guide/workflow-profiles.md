# Workflow Profiles

AI-DLC は、すべてのタスクを同じ lifecycle に押し込めません。よくある種類の作業向けに、workflow profile の集合を出荷します。完全な feature、素早い bugfix、infrastructure の変更、軽量な Express 実行などです。

engine は workflow profile を scope と呼びます。この 2 つの語は、同じ選択を別の視点から表します:

- **Workflow profile** はユーザー向けの体験です。どんな種類の作業をしていて、どれだけの儀式が要るかです。
- **Scope** は `aidlc-state.md` に保存される engine の設定です。そのワークフローで使う、正確な stage ルート、depth、test strategy、review の上限、儀式のスイッチです。

`/aidlc <profile>` で profile を明示的に選ぶか、作業を説明して AI-DLC に 1 つ提案させてください。アシスタントはあなたの説明を読み、それに合う profile を提案するか、合うものが無ければ adaptive composer を提案します。何かが始まる前に、あなたがルートを確認します。明示的に名指しした profile は、名指ししたとおりに使われます。その後に作るものを添えれば、始まって stage とゲートの数を表示します。単独で名指しすれば、まず作業が何のためかを尋ねます。

## クイック選択

| Workflow profile | 向いているもの | ステージ | Depth | Test strategy | 始め方 |
|------------------|----------|--------|-------|---------------|------------|
| **Classic** | Inception と Construction を通した v1 風の儀式。Build and Test で終わる | 15 / 30 | Standard | Standard | `/aidlc classic` |
| **Express** | 要件からコードとテストまでの、もっとも軽い経路 | 7 / 30 | Minimal | Minimal | `/aidlc express` |
| **Feature** | 完全な lifecycle を使う production feature | 30 / 30 | Standard | Standard | `/aidlc feature` |
| **Enterprise** | 完全なトレーサビリティを伴う、規制下または高保証の作業 | 30 / 30 | Comprehensive | Comprehensive | `/aidlc enterprise` |
| **MVP** | Operation phase を省いた、本物の最初のプロダクト増分 | 20 / 30 | Standard | Standard | `/aidlc mvp` |
| **Proof of concept** | 最小限の有用な実装経路で実現可能性を試す | 5 / 30 | Minimal | Minimal | `/aidlc poc` |
| **Bugfix** | 焦点を絞った修正と回帰テストが要る既知の欠陥 | 6 / 30 | Minimal | Minimal | `/aidlc bugfix` |
| **Refactor** | プロダクトの振る舞いを変えずに既存コードを改善する | 7 / 30 | Minimal | Minimal | `/aidlc refactor` |
| **Infrastructure** | 環境、IaC、デプロイ基盤、またはコストの作業 | 10 / 30 | Standard | Standard | `/aidlc infra` |
| **Security patch** | CVE または焦点を絞った脆弱性対応 | 7 / 30 | Minimal | Minimal | `/aidlc security-patch` |
| **Workshop** | ファシリテーション付きのトレーニングまたはグループ配信セッション | 23 / 30 | Standard | Minimal | `/aidlc workshop` |

ステージ数は静的なルートを表します。どの profile も最初に走らせる Initialization の 3 つのセットアップステージの後のステージを数えます。plan の提案が示す数です。conditional と記されたステージは、その条件が当てはまらないとき、なお自己スキップできます。greenfield プロジェクトの Reverse Engineering などです。正確な stage-by-profile のマトリクスは、[Scopes, Depth, and Test Strategy](05-scopes-and-depth.md#stage-by-scope-matrix) を参照してください。

## `classic`

**Classic を選ぶのは次のとき:** v1 風の儀式が欲しいとき。Inception はステージごとに人間の承認が 1 回、Construction は Unit ごとに作り、各 Unit のコード plan を承認し、Review each checkpoint を選んでいれば、その checkpoint も承認します（Unit の design ステージ自体には停止がありません。team 所有の Unit は、自身のステージごと、または Unit 末尾のゲートを保ちます）。Ideation をスキップし、Operation をプレースホルダーのまま残します。ステージが宣言する実行モードと support エージェントは変わりません。

Classic は、あなたも `AWS_AIDLC_DEFAULT_SCOPE` も別の profile を名指ししないときの、暗黙の engine の既定です。会話的なコールドスタートのフローでは、豊かなタスク説明は、何かが作られる前に adaptive compose の提案を受けることがなおあります。Classic は Standard の artifact とテストを使います。walking-skeleton の儀式と summary 確認は off です。Sensor が走り、learnings の儀式も走ります。Review は advisory です（ステージごとに 1 パス、findings は approval gate で）。明示的な autonomy は、merge 前の単一 review を保ちます。Guard Policy は off が既定です。plan の再承認、review freeze、state transition、reviewer read scope は、指示されていない作業に対して退き、そのたびに `GUARD_STOOD_ASIDE` の行を記録します。Plan Approval は、なお engine によって尋ねられます。human-turn の権威と audit は有効なままです。

intent の scope を上書きするには、`/aidlc --sensors on|off`、`/aidlc --learnings on|off`、`/aidlc --summary-confirmation on|off`、`/aidlc --plan-approval on|off` を使ってください（plan approval を off にできるのはあなただけです）。`AIDLC_DISABLE_SENSORS=1`、`AIDLC_DISABLE_LEARNINGS=1`、`AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`、`AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` は、intent が on と言っても、該当する儀式を強制的に off にします。

問題そのものがまだ不明で、市場調査、実現可能性分析、または明示的な scope 探索が役立つときは、Classic を選ばないでください。代わりに Feature か Enterprise を選びます。

## `express`

**Express を選ぶのは次のとき:** 要件がすでに理解されていて、要件・実装・テスト、そして任意のデプロイ末尾を通る、サポートされた最短経路が欲しいとき。

Express は、Ideation、design パス、Unit 分解、Delivery Planning、CI Pipeline をスキップします。ステージの reviewer dispatch を無効にし、Minimal の artifact と requirement 駆動のテストを使います。Reverse Engineering とデプロイステージは conditional のままです。

Express は、sensor、learnings、summary 確認も off にします。intent ごとに上書きするには、[`/aidlc --sensors on|off`](12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls)、[`/aidlc --learnings on|off`](12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls)、[`/aidlc --summary-confirmation on|off`](12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls) を使います。

Express の [Guard Policy](13-customization.md#guard-policy) は off が既定です。plan approval、review freeze、state transition、reviewer read scope は、指示されていない作業に対して退き、そのたびに `GUARD_STOOD_ASIDE` の行を記録します。human presence は on のままです。1 つの intent について上げるには、`/aidlc --guard-policy strict` または `relaxed` とタイプします。

曖昧な、チームをまたぐ、規制下の、またはアーキテクチャ重めの作業には、Express を選ばないでください。その速さは、それらの判断面を意図的に取り除くことから来ます。

## `feature`

**Feature を選ぶのは次のとき:** production feature を作っていて、実用的な depth で完全な lifecycle が欲しいとき。

Feature は、セットアップ後の 30 ステージすべてを Standard depth で走らせます。intent の発見から、design、実装、デプロイ、フィードバックまでです。Enterprise の重いドキュメント下限なしに、未知を表に出す最も広い機会をワークフローに与えます。

## `enterprise`

**Enterprise を選ぶのは次のとき:** 作業が規制下、高リスク、audit に敏感、または形式的なコンプライアンスと運用の証跡を要するとき。

Enterprise は、セットアップ後の 30 ステージすべてを Comprehensive depth で走らせます。market、compliance、security、design、observability、incident-response、performance の作業を保ちます。文書化されていない判断のコストが、追加の儀式のコストより高いからです。

## `mvp`

**MVP を選ぶのは次のとき:** アイデアが可能かを試すだけでなく、本物の最初のプロダクト増分を出荷するとき。

MVP は、Standard depth で、Inception と Construction の完全な design/build 経路を保ちます。選んだ Ideation の儀式を削り、Operation phase をスキップします。プロダクトが production の運用と完全なフィードバック lifecycle を要するときは、Feature か Enterprise に移ってください。

## `poc`

**Proof of Concept を選ぶのは次のとき:** 主要な問いが、ある手法が機能しうるかどうかであるとき。

PoC は 5 ステージを Minimal depth で使います。ほとんどの product、design、運用の儀式を省きつつ、要件・コード・テストに素早く到達します。PoC は後の判断のための証拠であり、production 準備の profile ではありません。

## `bugfix`

**Bugfix を選ぶのは次のとき:** 欠陥が既知で、望む結果が検証付きの焦点を絞った修理であるとき。

Bugfix は 6 ステージを Minimal depth で使います。workspace の理解、要件、Code Generation、Build and Test、デプロイ経路を保ちつつ、discovery、広範な design、無関係な Operation の作業を落とします。

Bugfix は learnings と summary 確認も off にします。そのため、どのステージも diary を保たず、修正の後に「Keep that for next time?」とも尋ねません。Sensor、ステージの承認、plan 承認は on のままです。

## `refactor`

**Refactor を選ぶのは次のとき:** 内部の構造、保守性、技術的負債が改善する一方で、振る舞いは安定したままであるべきとき。

Refactor は 7 ステージを Minimal depth で使います。既存コードの理解、内部変更の定義、その実装、振る舞いが回帰しなかったことの証明、検証済みの結果をデプロイまで運ぶことを重視します。作業がユーザーに見える振る舞いを変えるなら、代わりに Feature を使ってください。

## `infra`

**Infrastructure を選ぶのは次のとき:** 結果が環境、IaC の変更、デプロイ基盤、プラットフォーム能力、またはコスト最適化であるとき。

Infrastructure は 10 ステージを Standard depth で使います。ユーザー向けのプロダクトの儀式を取り除き、要件、NFR、infrastructure 設計、CI/CD、デプロイ、observability に集中します。

## `security-patch`

**Security Patch を選ぶのは次のとき:** 既知の CVE、脆弱性、または狭く範囲を絞ったセキュリティ欠陥に対応しているとき。

Security Patch は 7 ステージを Minimal depth で使います。無関係なプロダクトの儀式を避けつつ、セキュリティ関連の要件、検証、実装、デプロイ経路を保ちます。焦点を絞ったパッチではなく、より広いセキュリティまたはコンプライアンスのプログラムには、Enterprise を使ってください。

## `workshop`

**Workshop を選ぶのは次のとき:** ファシリテーターがトレーニングラボまたは連携したグループセッションを率いているとき。

Workshop は Ideation をスキップします。ファシリテーターが演習を供給するからです。その後、Inception から Operation までの lifecycle を Standard depth で走らせます。教えるセッションを動かし続けるため、意図的に Minimal の test strategy を使い、通常の review を advisory 1 パスに上限付けします。複数参加者の運用レシピは [Workshop Mode](workshop-mode.md) にあります。

## AI-DLC に選ばせる、または compose させる

profile を暗記する必要はありません。作業を説明してください:

```
/aidlc Fix the login timeout bug
/aidlc Build a regulated payment approval service
/aidlc Create a lightweight prototype for the new search flow
```

出荷の profile があなたの説明に合うとき、アシスタントはそれを提案し、確認のために stage とゲートの数を示します。豊かまたは曖昧な作業は、adaptive composer を使う提案を受けます。composer は、あつらえた stage ルートを提案し、それを作る前に承認を待ちます。

その経路を強制するには、次を使います:

```
/aidlc compose "harden the deployment pipeline and add observability"
```

## Construction の承認と実行

新しくソースを生成する solo Unit ワークフローは、既定で、検証済みの完了 checkpoint を伴い、一度に 1 つの Unit を直列に作ります。これには Unit 分解と、ソースを生成する per-unit ステージの包含が要ります。design のみの作業や、Unit 分解をスキップする Express のような profile は、既存の stage フローを保ちます。team 所有の Unit ゲートは、別個の方針を保ちます。既存のワークフローと明示的な反復の選択は、新しい既定に変換されません。

skeleton-on では、最初の Unit が、最小の、動作する統合スライスとして計画されます。その該当する design 作業と Code Generation が終わり、本物の統合チェックが通り、後続の Unit が始まる前にあなたが skeleton を承認します。最初の design 文書は、動作する skeleton ではありません。skeleton-off は Construction の入口で Continue automatically / Review each checkpoint を提示します。skeleton-on は skeleton checkpoint の後に提示します。記録された選択は繰り返されず、Construction の間に autonomy を明示的に付与または取り消せます。

承認の方針と実行は別物です。対象となる Code Generation バッチを fan-out するには、stage-major の順序と swarm 実行を明示的に選びます。guided と自動のバッチ完了はどちらもサポートされます。unit-major は直列のままです。すべての Unit の Plan Approval、検証コマンドの選択、生成前の summary 確認は、なおあなたの回答を要します。対象となる swarm plan は、個別のレシートを伴う 1 つの Approve Plans の提示を共有できます。記録された人間認可の検証コマンドは、すべての Unit/バッチ checkpoint で再利用されます。それを変えるには、新しい人間のレシートが要ります。失敗は、なお停止させます。既存のワークフローは、新しい checkpoint/execution フィールドが無いとき、記録された反復と従来の振る舞いを保ちます。[Construction commands](12-cli-commands.md#construction-order-and-execution) を参照してください。

## 関連する制御

workflow profile がルートと既定を選びます。独立に調整できるものは次のとおりです:

- **Depth** は `--depth minimal|standard|comprehensive` で。
- **Test strategy** は `--test-strategy minimal|standard|comprehensive` で。
- **Review の上限** は `--review adversarial|advisory|none` で。有効なクラスは、ステージ自身が宣言するクラスで、設定時はこの実行ごとの上限で下げられ、そうでなければ profile の上限で下げられます。どちらの上限も、ステージを宣言値より上げられず、設定された実行ごとの上限は profile の上限を置き換えます。

これらの上書きは、ある profile を別の profile に変えるものではありません。選ばれた profile を調整します。規範的なルーティングのマトリクスと上書きの意味は、[Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) を参照してください。

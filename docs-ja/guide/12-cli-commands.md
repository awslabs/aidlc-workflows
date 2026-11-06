# CLI コマンド

AI-DLC には、ユーザーに向けた2つのコマンド面があります。ハーネスのチャットコマンドは `/aidlc`（Codex では `$aidlc`）でワークフローを動かし、インストールされたネイティブの `aidlc` コマンドはプロジェクトを初期化し、マシンのライフサイクル、診断、ライフサイクルのルートを提供します。

> **呼び出しのプレフィックスはハーネスで異なります。** Claude Code、Kiro IDE、Kiro CLI、Cursor、opencode、GitHub Copilot では `/aidlc` とタイプし、Codex CLI では `$aidlc`（または `/skills` → aidlc）です。以下のフラグと挙動はどちらでも同一で、プレフィックスだけが変わります。例では `/aidlc` を使います。Codex では `$aidlc` に置き換えてください。[Kiro CLI](harnesses/kiro-cli.md)、[Kiro IDE](harnesses/kiro-ide.md)、[Codex CLI](harnesses/codex-cli.md)、[Cursor](harnesses/cursor.md)、[opencode](harnesses/opencode.md)、[GitHub Copilot](harnesses/copilot.md) のハーネスガイドを参照してください。

> **Cursor のショートカット。** Cursor は `/aidlc-status`、`/aidlc-jump --stage <slug|#>`（または `--phase <name|#>`）、`/aidlc-scope <name>` もネイティブスキルとして公開します。これらは下記の該当する `/aidlc` 形式をパッケージ化し、同じエンジンを使います。別名であって、別の状態パスではありません。

---

## クイックリファレンス

| コマンド | 説明 |
|---------|-------------|
| `/aidlc [scope]` | 明示的なスコープで新しいワークフローを開始する |
| `/aidlc [description]` | 新しいワークフローを開始する。エージェントがあなたの説明からプランを提案する（合うものがなければ構成を申し出る） |
| `/aidlc compose "<task>"` | 適応型コンポーザーを強制する。タスクに合わせた EXECUTE/SKIP プランを提案する |
| `/aidlc compose --report <path>` | スキャンレポートから構成する（検出結果を小さな fix-and-ship の実行に振り分ける） |
| `/aidlc --new-scope '<task>'` | ストックのスコープが合うときでもカスタムプランの合成をコンポーザーに強制する |
| `/aidlc` | 開いているワークフローを再開する。まだ作業がなければ、何を作りたいか尋ねる |
| `/aidlc park` | アクティブなワークフローを現在のステージ境界でパークし、後のセッションや別の人に引き継ぐ |
| `/aidlc team-board [--snapshot] [--space <name>] [--intent <name>]` | 読み取り専用の Team Construction ボード（ユニットの進捗、クレーム、マージ準備） |
| `/aidlc intent [name]` | アクティブなスペースの intent を一覧する（`--all` はアーカイブ済みを含む）、または既存の intent に切り替える |
| `/aidlc intent archive <name>` | 進行中または完了した intent を、その記録を削除せずに退役させる。`unarchive <name>` で戻す |
| `/aidlc intent add-repo <name> [--url <address>]` | アクティブな作業に兄弟リポジトリをどのステージでも追加し、まだここになければ先にクローンする。`remove-repo <name>` で1つ取り除く（最後の1つは不可） |
| `/aidlc intent set-repos <name,...>` | アクティブな作業がカバーする兄弟リポジトリを正確に設定する。`--all` は記録されたすべてのリポジトリを保つ |
| `/aidlc intent add-checkout <path>` | ハーネスフォルダやプロジェクト外の worktree に保たれたコードをレビューがカバーするようにする。`remove-checkout <path>` で取り除く |
| `/aidlc space [name]` | スペースを一覧する、または既存のスペースに切り替える |
| `/aidlc space-create <name>` | デフォルトスペースの org ルールと、空のチーム・プロジェクトプラクティスから始まる新しいスペースを作る |
| `/aidlc knowledge <verb>` | 自分のドキュメントをインデックスし読む（`onboard`、`sync`、`list`、`show`、`associate`、`dissociate`、`rebind`、`summarize`） |
| `/aidlc <plugin command> [args]` | インストール済みのプラグインが追加するコマンドを実行する（ターミナルでは `aidlc <name>`）。`aidlc --help` がそれらをプラグインごとに一覧する |
| `/aidlc --status` | 読み取り専用のステータスサマリーを表示する |
| `/aidlc --config [section]` | プロジェクトのポリシーを会話的に構成し、正確で決定的な config フラグに落とし込む |
| `/aidlc --claim <unit> [--team <label>] [--rhythm <per-stage\|unit-end>]` | 開いているチーム所有のユニットをアトミックにクレームし、このチェックアウトをその試行にバインドする |
| `/aidlc --release <unit>` | トゥームストーンを公開して、スコープなしの main のライブのユニットクレームを解放する |
| `/aidlc unit adopt <unit>` | 新しいクローンで、チェックアウトされたライブのクレームブランチを採用する |
| `/aidlc unit participate` | このクローンをガイド付きのユニットクレームのピッカー用にマークする |
| `/aidlc unit publish <unit>` | スコープ付きチェックアウトのクリーンなコミット済み候補を、CAS でそのクレーム ref に公開する |
| `/aidlc unit pin <unit>` | スコープなしの main から、完了した1つの候補 OID をピンし検証する |
| `/aidlc unit gate <unit> ...` | ピンされた OID と世代に対してマージの決定を記録する |
| `/aidlc unit land <unit> ...` | 再開可能な git → state → audit の着地トランザクションを実行する |
| `/aidlc unit merge-status <unit>` | ローカルのピンされたマージのトランザクションジャーナルを読む |
| `/aidlc unit status` | 現在のクレーム可能、クレーム済み、依存でブロックされたユニットのセットを読む |
| `/aidlc --doctor [--check-updates]` | ヘルスチェックを実行する。明示的なフラグは更新のメタデータをリフレッシュする |
| `/aidlc --doctor --export` | 新しいヘルスチェックを実行し、共有用の小さな編集済み診断レポートを書く |
| `/aidlc --stage <slug\|#>` | 特定のステージにジャンプする |
| `/aidlc --stage <slug> --single` | 1つのステージを単独で、ワークフローを進めずに実行する |
| `/aidlc --phase <name\|#>` | フェーズの先頭にジャンプする |
| `/aidlc --scope <name>` | アクティブなスコープを変える |
| `/aidlc --depth <level>` | 深さのレベルをオーバーライドする（minimal、standard、comprehensive） |
| `/aidlc --test-strategy <level>` | テスト戦略をオーバーライドする（minimal、standard、comprehensive） |
| `/aidlc --project-type <type>` | この作業が新しいプロジェクトか既存のコードかを言う（greenfield、brownfield）。ワークフローの途中では、もう一度スキャンし、既存のコードについて Reverse Engineering を実行する |
| `/aidlc --review <class>` | この実行のステージレビューを設定し、スコープのキャップを置き換える（adversarial、advisory、none） |
| `/aidlc --guard-policy <value>` | ガードがこの作業についてどこまで身を引くかを設定する（strict、relaxed、off）。`--change-control` はその退役した名前 |
| `/aidlc --sensors <on\|off>` | この intent について、自動 Sensor の実行とブロッキング sensor のチェックを設定する |
| `/aidlc --learnings <on\|off>` | この intent について、学習の日誌と learning-gate の儀式を設定する |
| `/aidlc --summary-confirmation <on\|off>` | この intent について、統合サマリーの確認チェックポイントを設定する |
| `/aidlc --plan-approval <on\|off>` | この intent について、各コードプランがビルドされる前に承認用に表示されるかを設定する（オフにできるのは人だけ） |
| `/aidlc --collaborators <on\|off>` | この intent について、ステージが支援エージェントを連れてくるか、リードエージェントだけで走るかを設定する |
| `/aidlc --statusline <on\|off>` | ステータスラインに AI-DLC の進捗を表示する、または自分のものを戻す（Claude Code: あなただけ。Codex: プロジェクトの全員） |
| `/aidlc config get <key>` | アクティブなワークフローの config を表示する（`depth`、`test-strategy`、`review`、`guard-policy`、`sensors`、`learnings`、`summary-confirmation`、`plan-approval`、`collaborators`、`guard.<fence>`） |
| `/aidlc config set <key> <value> [--key value ...]` | 共有のセッターを通じて intent 設定を変える。フラグとしてタイプされた、または平易な言葉で頼まれた設定を、エージェントが実行する |
| `/aidlc config set guard.<fence> <on\|off>` | この作業について1つのフェンスをオフにする、またはポリシーの言葉より上にオンに戻す（review-freeze、state-transition、reviewer-scope。`guard.plan-approval` は `plan-approval` の別名） |
| `/aidlc config list` | アクティブなワークフロー設定13個すべてを一覧する（`--json` で構造化出力） |
| `/aidlc plugin select [names]` | このインストールの有効なプラグインリストを表示または設定する |
| `/aidlc plugin list` | インストール済みのプラグインと有効状態を一覧する |
| `/aidlc plugin sync` | インストール済みのプラグインルートを現在のインストールに合成する |
| `/aidlc plugin validate [path]` | オーサリングしたプラグインを検証する（`--with <base-root>` はベースプラグインのエージェントを確認。`--json` で構造化された所見） |
| `/aidlc plugin build <harness> [outDir]` | ホストプラグインの射影をビルドする（`--plugin-root <path>` でソースを選ぶ） |
| `aidlc plugin test [path] --install <project-root>` | ターミナルから。オーサリングしたプラグインが、変更されないプロジェクトのコピーに合成されることをテストする（`--harness <name>`、`--with <base-root>`、`--json`） |
| `/aidlc --version` | フレームワークのバージョンを表示する |
| `/aidlc --help` | 使い方の情報を表示する |
| `bun .claude/tools/aidlc-utility.ts select-plugins [names]` | プラグイン選択の直接のユーティリティ形式 |
| `aidlc engine worktree restore --slug <slug> [--parked <stamp>] [--raw]` | 脇に置かれた Bolt の試行のファイルを別のチェックアウトに回復する |
| `aidlc engine worktree purge --slug <slug> [--parked <stamp> \| --older-than <days>]` | 復元されたチェックアウトが消えた後、選んだローカルの回復 ref を取り除く |

`--status`、`--doctor`、`--help`、`--version` は、単独でも他のフラグの横でも走ります。説明の中では、それらはあなたが頼んだものの一部です。`/aidlc add a --version flag that prints the version from package.json` はその作業を始め、AI-DLC のバージョンは表示しません。

---

## ターミナルの色

6つの公開ターミナルコマンド（`config`、`doctor`、`version`、`update`、`use`、`uninstall`）は、人向けの出力にだけ控えめな色を使います。JSON、quiet な出力、ファイル、監査記録、非 TTY のストリームは色なしのままです。

色の選択は次の優先順位を使います。

1. `--no-color` は色を無効にします。
2. 設定された `NO_COLOR` 環境変数は、値にかかわらず色を無効にします。
3. `0` 以外の空でない `FORCE_COLOR` の値は色を有効にします。
4. そうでなければ、色は `TERM` が `dumb` でない TTY ストリームにのみ有効です。

決定は stdout と stderr について独立に行われます。1つのコマンドには `--no-color`、シェルやプロセスの環境には `NO_COLOR=1`、ANSI の色をサポートするが TTY 検出を公開しないターミナルラッパーには `FORCE_COLOR=1` を使います。

---

## コマンド判断ツリー

```mermaid
flowchart TD
    START(["What do you want to do?"])

    Q1{"Start a new\nworkflow?"}
    Q2{"Check or manage\nan existing workflow?"}
    Q3{"Verify the\nproject?"}

    A1["/aidlc feature"]
    A2["/aidlc Build a payments API"]
    A3["/aidlc"]
    A4["/aidlc --status"]
    A5["/aidlc --stage code-generation"]
    A6["/aidlc --phase construction"]
    A8["/aidlc --doctor"]

    START --> Q1
    START --> Q2
    START --> Q3

    Q1 -->|"Know the scope"| A1
    Q1 -->|"Describe what you want"| A2
    Q2 -->|"Resume where I left off"| A3
    Q2 -->|"See progress"| A4
    Q2 -->|"Jump to a stage"| A5
    Q2 -->|"Jump to a phase"| A6
    Q3 -->|"Verify setup"| A8

    style START fill:#e1bee7,stroke:#7b1fa2,color:#000
```

<!-- Text fallback: Starting a new workflow: use /aidlc classic (known scope) or /aidlc Build a payments API (the agent proposes a plan; the first intent auto-creates). Managing an existing workflow: /aidlc (resume), /aidlc --status (view progress), /aidlc --stage (jump to stage), /aidlc --phase (jump to phase). Verify setup: /aidlc --doctor (health check). -->

---

## 詳細リファレンス

### `/aidlc [scope]` — 明示的なスコープで始める

有効なスコープの1つで新しいワークフローを始めます。コアは11個の名前付きスコープを出荷します。プラグインがさらに追加でき、`select-plugins` が無効なプラグイン/コアのスコープをランタイムから隠せます。

**構文:**

```
/aidlc enterprise
/aidlc feature
/aidlc mvp
/aidlc poc
/aidlc bugfix
/aidlc refactor
/aidlc infra
/aidlc security-patch
/aidlc classic
/aidlc workshop
/aidlc express
```

**挙動:** フレームワークはスコープのキーワードを認識し、何を作りたいか尋ね（あなたが言うまで何も作られません）、そのプランでそのあなたの言葉をリクエストとして Initialization フェーズを実行し、最初のドメインステージを始めます。ワークフローがすでにアクティブなら、スコープのキーワード単独はその作業を続け、説明を伴うものはその説明が新しい作業かを尋ねます。より長い説明の最初の語でもあるキーワード（`/aidlc classic car rental website`）は、読まれるのであって仮定されません。アシスタントがどちらの意味かを判断し、一度あなたに尋ねることがあるので、その語が、あなたが選ばなかったプランに費やされることは決してありません。キーワードと1語（`/aidlc feature flags`、`/aidlc bugfix typo`）も同じように読まれるので、`feature flags` はあなたのリクエストのままで、`bugfix typo` はなおその typo についての bugfix 作業を始めます。コロンがそれをプランだと言い、他には何もそう言いません（`/aidlc bugfix: Fix duplicate todos`）。`--scope` も同じことを言います（`/aidlc --scope bugfix Fix duplicate todos`）。11個の選択肢すべての実践的な比較は [Workflow Profiles](workflow-profiles.md) を参照してください。

**例:**

```
/aidlc bugfix
> I'll use the bugfix plan. What should I work on? Tell me in your own words and I'll start it.
> The login API returns 500 when email contains a plus sign
```

---

### `/aidlc [description]` — 説明から始める

作りたいものを説明すると、エージェントがそれに合うプランを提案します。エンジンがそれを確認するよう求めます。

**構文:**

```
/aidlc Build a REST API for inventory management
/aidlc Fix the login timeout bug
```

**挙動:** エージェントはあなたの説明を読み、それに合うプランを提案します（バグ報告は通常 bugfix になります）。エンジンは、そのプランとその実効の儀式（ステージ数、承認ゲート数、ユニットごとのファンアウト。すべてコンパイル済みのグリッドから）を名づける1行の確認を尋ねます。新規プロジェクトの作業は reverse engineering を除外し、ユニットごとの文言は `units-generation` が走ってユニットの DAG を作るときだけ現れます。出来合いのプランが合わないときは、黙ったデフォルトの代わりに compose の申し出（下記の `/aidlc compose` を参照）が出ます。ワークフローが始まる前に、あなたが確認またはオーバーライドします。プランの名前で始まる説明は、すべての語を保ちます（`/aidlc classic car rental website` は car rental website についてです）。エージェントは、その語がプランを名づけているかを読みます。

**例**（新しいプロジェクト。既存のコードベースでは bugfix は Reverse Engineering も実行するので、行は 6 ステージと 6 承認ゲートと言います）:

```
/aidlc Fix the ProfileSerializer null pointer
> I'd run the "bugfix" plan for: "Fix the ProfileSerializer null pointer" - 5 stages, 5 approval gates. Do you want me to go ahead with it, use a different plan, or tailor one to this task?
```

**どのシェルも運べないリクエスト。** Windows では、cmd.exe は行の区切りでコマンドを終え、クォートの中でも `%NAME%` や `!NAME!` のペアを置き換え、aidlc ランチャーは cmd.exe にもう一度読まれます。そのどれかを保持するリクエストは、コマンドラインではなくファイルを通じてエンジンに届きます（Kiro IDE では、エージェントは二重引用符、`“` や `’` のようなタイポグラフィの引用符、`&`、`|`、`<`、`>`、`^` の1つ、または末尾のバックスラッシュを保持するリクエストもこの方法で送ります。Windows の PowerShell や cmd.exe がそれらを変えうるためです）。エージェントはそれを `aidlc/.aidlc-request-text/request.txt` に書き、他のフラグとともに `aidlc engine orchestrate next --request-file aidlc/.aidlc-request-text/request.txt` を実行します。エンジンは `aidlc/.aidlc-request-text/` のすぐ中の、リンクを通らない、最大 64 KiB のプレーンなファイルだけを直接読み、その語を書かれたとおりに使い、コマンドが進むとそのファイルを取り除きます。

---

### `/aidlc compose` — 適応型コンポーザー

ストックのスコープが合うときでもコンポーザーを強制します。3つの場面で機能します。

```
/aidlc compose "harden the deployment pipeline and add observability"
/aidlc compose --report sonar.json
/aidlc compose            (mid-workflow: re-shape the pending stages)
```

**挙動:** コンダクターがコンポーザーエージェントをディスパッチします。それはあなたのタスク（またはスキャンレポート、または走行中のワークフローの状態）を読み、読み取り専用の `detect` スキャンを実行し、5つの実装エントロピー成分（intent の曖昧さ、構造的な不確かさ、検証のエントロピー、リスク、未解決の前提。構成されているときは CodeKB MCP の分析に、そうでなければワークスペースのスキャンに基づく）を見積もり、スコアの内訳と、すべての EXECUTE と SKIP の理由とともに、最小の実行可能な EXECUTE/SKIP グリッドを提案します。あなたはゲートで承認、編集、拒否します。承認すると、ストックの一致には AI-DLC がワークフローを直接作り、カスタムプランには、もっとも近いストックのスコープ（新しいプロジェクトには、合えば新しい作業向けのもっとも近いもの）の上に、プラン自身のステージ変更（`--skip` / `--add`）とともに、同じターンでワークフローを作り、スコープファイルは書きません。プランはこの作業に属します。カスタムプランのゲートは **Approve and save as scope** も提供します。それは名前を尋ね、作業が作られるときにプランを再利用可能なスコープとして保ちます（[`scope save`](#aidlc-engine-scope-save-keep-a-plan-as-a-scope) がすることを）。あとで「save this plan as <name>」と言うと `scope save` 自体が走ります。すべての front/report の提案は、空でない `creationDescription` を運びます。供給されたときは正確な元のタスクテキスト、そうでなければレポート/プランに基づく説明です。タスクから始まった構成では、作成はゲートの `--request <id>` を渡し、エンジンが元の説明を取得します。レポート駆動またはタスクなしの構成は、その request id とともに、`--` の後の説明を1つのシェルセーフな引数として渡します。compose の承認は、スコープだけで説明なしでは続けられません。進行中の提案は、`recompose` 動詞を通じて、保留中のステージのサフィックスのフリップとして着地します（監査ロックのもと、strict 検証、`RECOMPOSED` が監査されます）。完了した作業の上ではコンポーザーは走りません。AI-DLC は、その最後のステージの後にそれを再び開くプランを、それぞれが実行するステージとともに名づけ、あなたが選んだものがそこで作業を再び開きます。`--new-scope` は合成を強制し、`--report <path>` は振り分けた検出結果を intent に種まきします。`/aidlc-compose` スキルは同じパスのタイプ可能なショートカットです。ワークフローの途中では、チャットでそう言うだけでもよく、オープンエンドなリクエスト（「what else can we cut?」）が認識され、同じゲートと動詞を通じてルーティングされ、文字どおりの `compose` は要りません。ステージを名づける（「can we skip market research?」）とプランが即座に変わり、undo が名づけられます（Claude 以外のハーネスでは、文字どおりの動詞が文書化された信頼できるパスのままです）。

全体のフローは [Scopes and Depth - The Adaptive Composer](05-scopes-and-depth.md#the-adaptive-composer) を参照してください。

---

### `/aidlc` — 既存のワークフローを再開する

状態ファイルが存在するとき、引数なしで実行して再開します。

**構文:**

```
/aidlc
```

**挙動:** `aidlc-state.md` を読み、保存されたチェックポイントから続けます。`/aidlc --resume` と同じです。やり直す、ステージにジャンプする、新しく始める、と言って別のことをします。詳細は [Session Management](11-session-management.md) を参照してください。

`/aidlc --resume` も、保存されたチェックポイントから直接続けます。その後にタイプされた語（`/aidlc --resume redo the scan`）は、パークされたワークフローが解除された後に、`/aidlc` 単独と同じように読まれます。明示的なターゲットが勝ち、通常のジャンプの挙動を通るべきときは `--stage <slug>` を加えます。

状態ファイルが存在しなければ、フレームワークはこれを新しいワークフローとして扱い、スコープ/説明を尋ねます。

---

### ワークフローの初期化 — 自動

手動コピーのインストールには scaffold コマンドはありません。Bun 形の `aidlc-copy-runtime-X.Y.Z.tar.gz` からのバージョン付き `runtime/<harness>/` シェルは、事前にビルドされて届き、ネイティブの `aidlc` 実行ファイルを必要とせず（`.claude/` エンジンと `aidlc/spaces/default/memory/`）、エンジンは、あなたが何を作るか説明し、提案されたプランを確認したときに最初の intent を作ります（作業のない素の `/aidlc` は何を作りたいか尋ね、スコープ単独は作業が何のためかを尋ねます）。作成は3つの Initialization ステージ（Workspace Scaffold、Workspace Detection、State Init）を1つの決定的なツール呼び出しとして実行します。intent の記録ディレクトリを `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`（`audit/` のシャードディレクトリ、スコープが実行する各フェーズの成果物ディレクトリ、`verification/`）に作り、空のスペースレベルの `aidlc/spaces/<space>/knowledge/` ディレクトリを作り、ルールベースのワークスペーススキャンを実行し、その intent の `aidlc-state.md` をスコープのプランとともに書きます。init シーケンスのイベント（`WORKFLOW_STARTED`、`WORKSPACE_SCAFFOLDED`、`WORKSPACE_SCANNED`、`WORKSPACE_INITIALISED`、加えてステージごとの `STAGE_STARTED`/`STAGE_COMPLETED`）を記録します。スコープを名づける（`/aidlc --scope feature`）と初期スコープが種まきされます。なければ、実際の `AWS_AIDLC_DEFAULT_SCOPE` 環境変数、次に記録された `aidlc config flags --default-scope` の値、次に `classic` を解決します。最初の実行の前にチーム知識やガードレールを加えるには、出荷される `aidlc/spaces/default/memory/` のファイルを編集します。スペースレベルの `aidlc/spaces/<space>/knowledge/` ディレクトリは最初の intent が存在すると（空で）作られ、そこから自由形式のファイルを加えます。

ネイティブの config コマンドが、好ましいプロジェクトのインストールとリフレッシュのパスです。フレームワーク開発者は、無視される Bun 形の `dist/` 射影を `bun scripts/package.ts` でローカルに生成できます。リリースユーザーはチェックアウトからコピーすべきではありません。

ネイティブのマシンインストールでは、ハーネスを開く前に一度 `aidlc config` を実行します。そのコマンドは同じシェルを敷き、リフレッシュのベースラインを記録します。ワークフローの intent の誕生は、最初のチャット呼び出しで自動のままです。

Claude Code では、ウェルカムメッセージは `.claude/settings.json` の `companyAnnouncements` エントリ経由でセッション開始時にレンダリングされます。他のハーネスはウェルカムメッセージを出荷せず、`/aidlc --status`（Codex では `$aidlc --status`）が作業の現状を示します。

**マルチリポジトリのワークスペース。** ワークスペースルートが複数の兄弟コードリポジトリ（それぞれ `.git` を持つ直下の子ディレクトリ）を保持するとき、作成ステップは intent が触れるリポジトリのセットをその `intents.json` の行に記録します。デフォルトでは、すべての兄弟リポジトリを **自動検出** します。intent を特定のサブセットにスコープするには、作成ツールが `--repos a,b`（リポジトリディレクトリ名のカンマ区切りリスト）を受け取ります。これらは、エンジンがあなたに代わって実行する決定的な `aidlc-utility intent-create` ステップのフラグで、あなたがタイプする `/aidlc` のフラグとは別物です。Construction の間、各 git 操作（worktree、swarm、Bolt）は1つのリポジトリをターゲットにします。コンダクターが `--repo <name>` を渡してそれを固定します。intent が複数のリポジトリにまたがるときにだけ必要です。記録されたリポジトリのない intent は単一リポジトリのデフォルトです（git はワークスペース/プロジェクトのディレクトリで走ります）。チーム所有のユニットは現在、その単一リポジトリのデフォルトを要します。記録された兄弟リポジトリのある作業は、誰がそのユニットをビルドするか尋ねられず、最初の Construction ステップが1行で、このセッションがそれらをビルドすると言います。`set-unit-ownership team` は、状態を変える前に同じ行で拒否します。[Artifacts Reference](14-artifacts-reference.md) を参照してください。

---

### `/aidlc park` — ワークフローをパークする

現在のステージ間境界でクリーンに止め、後のセッションで、または `aidlc/` ツリーがコミット・プルされた後に別の人が拾えるようにします。

**構文:**

```
/aidlc park
```

**挙動:** エンジンは動詞を `aidlc engine orchestrate park --person-asked`（エンジン自身の park で、AI-DLC が事前承認するエンジンコマンドでカバーされるので、エージェントは許可プロンプトなしに実行します）にルーティングします。それは `WORKFLOW_PARKED` を発行し、状態ファイルにパークマーカーを記録し、パークしたステージを報告します。ステージは進められず、完了とマークされるものもありません。ワークフローがアクティブでないとき、またはすでに Completed のとき、パークは拒否されます。ユニットスコープのチームチェックアウト（ユニットスコープのスタンプを運ぶ Construction の worktree）では、同じコマンドが代わりにそのユニットをローカルにパークします。チェックアウトローカルのユニットパークマーカーを書き、共有のワークフロー状態には触れず、ルーティングされたコマンドを通じて `parked` ディレクティブを発行します。そのチェックアウトでの次の `/aidlc` は、ユニットがそこでパークされたと報告します。`/aidlc --resume` で再開します。該当するマーカーをクリアして続けます。動詞は単一トークンです。より長い文の中の `park` は作業の説明として扱われるので、散文でパークするようコンダクターに頼むか、素の動詞をタイプします。

ユーザーごとのカーソル `aidlc/spaces/<space>/intents/active-intent` は gitignore されるので、パークされたワークフローをプルしたチームメイトは、`/aidlc --resume` の前に `/aidlc intent <name>` でそれを選びます。

---

### `/aidlc team-board` — Team Construction ボード

チーム所有の Construction の読み取り専用ビューです。ユニットの進捗、観測されたクレーム、ピンされたマージ準備、クレーム可能なユニット、ブロッカーです。`/aidlc --status` が `Unit Ownership: team` の下に付ける同じボードです。

**構文:**

```
/aidlc team-board
/aidlc team-board --snapshot
/aidlc team-board --space <name> --intent <name>
```

**挙動:** エンジンは動詞を `aidlc team-board` にルーティングし、状態、キャッシュ、監査に触れずにその出力をそのまま表示します。`--snapshot`、`--space <name>`、`--intent <name>` だけが受け入れられ、他のトークンは usage エラーです。`Unit Ownership: team` を要します。

---

### `/aidlc intent [name]` — intent を一覧または切り替える

素の `/aidlc intent` は、アクティブなスペースの進行中と完了の intent を一覧します。構造化出力には `--json` を加え（すべての行、アーカイブ済みを含む）、人向けの一覧でアーカイブ済みを表示するには `--all` を加えます。`/aidlc intent <name>` は、明確な slug またはフルの記録ディレクトリ名で、ユーザーごとの active-intent カーソルを既存の intent に切り替えます。intent を作ることも、ワークフローを進めることも決してありません。`/aidlc` の後に単独でタイプされた名前（`/aidlc auth`）は、それがここで正確に1つの intent の名前であるとき、同じようにその intent を選び、切り替えの行は、あなたがいた intent と、戻るコマンドを名づけます。`intent` の後の、動詞でも既存の intent の正確な名前でもない語（タイポ、または intent にできないこと）は、動詞と最近の intent 名とともにエージェントに渡され、あなたが何を意味したかを読むか一度尋ねます。名前の後にタイプしたもの（リクエスト、または `--guard-policy relaxed` のような設定）は、まるごとエージェントに渡され、ちょうど選ばれた intent について処理されます。

### `/aidlc intent archive <name>` — 終えない intent を退役させる

`/aidlc intent archive <name> [--reason '<text>']` は、進行中または完了した intent を `archived` ステータスに移します。何も削除されません。記録ディレクトリ、その成果物、監査シャードはそのまま残り、アーカイブ自体がその intent の監査証跡に `WORKFLOW_ARCHIVED`（`--reason` を与えたときはそれとともに）として記録されます。レジストリの行は `archived` に変わり、状態ファイルの `Status` は `Archived` に変わり、デフォルトの `/aidlc intent` 一覧はその行を隠します。アーカイブされた intent がアクティブなものだったなら、ユーザーごとのカーソルがクリアされるので、次の `/aidlc` は、退役したステージを再開する代わりに、どの intent で作業するか尋ねます（残りがなければ新しい作業を作ります）。

完了した intent もアーカイブできます。これが、終わった作業をデフォルトの一覧から隠す方法です。Bolt の worktree を持つ intent もアーカイブできます。出力が worktree を名づけ、それらは intent を戻すまでディスクにそのまま残ります。アーカイブは、クレームされたユニットを持つチーム所有の intent についてのみ拒否されます。それらのユニットは他のチェックアウトでまだ作業されているためです。

`/aidlc intent unarchive <name>` はそれを戻します。行と `Status` は元に戻り（進行中なら `in-flight` と、止まったステージの `Running`。完了した作業なら `complete` と `Completed`）、`WORKFLOW_UNARCHIVED` が記録されます。理由を記録するのは `archive` だけです。`unarchive` に与えた `--reason` は記録されず、出力がそう言います。カーソルは動かしません。続けたいときは `/aidlc intent <name>` で戻された intent に切り替えます。

### `/aidlc intent add-repo <name>`: すでに進行中の作業に兄弟リポジトリを追加する

作業は、作られたときに触れる兄弟リポジトリ（その時点のワークスペースの `.git` の子、または明示的な `--repos`）を記録します。その作業が別のリポジトリも変えると後で分かったとき、エージェントは理由とともに `intent add-repo <name>` を実行して1行であなたに伝えるか、あなたがそう言うとエージェントがあなたのために実行します。作業が読むだけのリポジトリは追加されません。リポジトリが記録され、変更が監査証跡に `INTENT_REPOS_CHANGED` として着地し、次に何が起きるかを言う1行を読みます。Reverse Engineering がすでに実行されていると、それと、コード知識を読むステージは、あなたがそれらを再訪するまで、新しいリポジトリについて遅れとして表示されます。まだ実行されていなければ、実行されるときに新しいリポジトリをカバーします。リポジトリが加わる前に尋ねられたいチームは、そのスペースメモリの `## Mandated` の下で1行でそう言います。

リポジトリがまだワークスペースにないとき、他のリポジトリの隣に先にクローンされます。`aidlc system workspace-sync` が使うのと同じコードと、あなた自身の git セットアップ（あなたの credential helper と `insteadOf` ルールが、あなた自身のシェルと同じように適用されます）でです。アドレスは、`--url` で与えたもの、なければリポジトリの `repos.json` エントリ、なければ `repos.json` の `org` です。エージェントは自分で `--url` を渡すことは決してないので、コード検索で見つけた名前は、あなたのチームの org からしかクローンできません。クローンはステージングフォルダで走り、ワークスペースロックのもとで所定の場所に移されます。それから `repos.json` エントリが書かれ（あなたのコメントとレイアウトを保ちます）、管理された `.gitignore` ブロックと `aidlc.code-workspace` がリフレッシュされ、それから初めて変更が記録されます。行はアドレスを名づけ、`https://user:token@host/...` のようなアドレスのユーザー部分は `***` と表示されます。チームがコミットする `repos.json` は、資格情報なしのアドレスを得ます。`repos.json` がないとき、ホスト型の `--url`（ホスト、オーナー、名前）は、オーナーを `org` と名づけるものを作り、行がそう言います。リストを共有するにはそれをコミットします。ローカルパス、または別の形のアドレスは、ファイルを作らずにリポジトリを追加します。クローンが失敗すると、何も記録も変更もされず、行が git の理由と手で実行する `git clone` コマンドを示します。`repos.json` の org も `--url` もないと、行がアドレスを尋ねます。

名前は単一のフォルダ名でなければならず、すでにそこにあるフォルダは Git のチェックアウト（実在の `.git` エントリ）でなければなりません。リポジトリのように見えるだけのフォルダは拒否され、区切りのある名前も同様です。このコマンドは、すでにリポジトリを記録する作業のためのものです。何も記録しない作業は、ワークスペースのフォルダ自体を自分のリポジトリとして扱います（`workspace reclassify` が最初のリポジトリを記録します）。最後に記録されたリポジトリを取り除くことは、同じ理由で拒否されます。

打ち切りはありません。Units Generation が承認された後も、リポジトリはなお追加（または削除）され、それが承認済みのユニットに何を意味するかは、作業の Guard Policy に従います。`strict` のもとでは、次のステップが、その変更でユニットがなお成り立つか、あるいは Units Generation に戻るかを一度あなたに尋ねます。`relaxed` または `off` のもとでは、作業は承認済みのユニットで続き、`CHANGE_ACCEPTED` として記録され、行は「Units Generation was approved before this change: carrying on with its Units and <name> added. You can go back to Units Generation any time.」と言います。新しいリポジトリを変えるユニットは、plan approval がオンのところで承認する Code Generation プランでそれを名づけます。追加時点の新しいリポジトリのファイルは、その前に取られたどのステージのソースベースラインにも加わるので、その既存のファイルがそのステージの間に行われた変更として報告されることは決してありません。

`/aidlc intent remove-repo <name>` は undo です。リポジトリをこの作業から取り除き、そのフォルダとその `repos.json` の行をそのまま残します。`repos.json` はワークスペースのリストであって作業のものではなく、行が手で取り除く方法を言います。Units Generation が承認された後に追加したリポジトリを取り除いても、他に決めることは何も残りません。

### `/aidlc intent set-repos <name,...>`: 作業がカバーするリポジトリを正確に言う

多くのリポジトリのワークスペースで、この作業がどれを必要とするか（「only orders and payments」）を言うと、エージェントが `/aidlc intent set-repos orders,payments` を実行します。作業はそれから正確にそれらをカバーし、各名前は `add-repo` が確認するのと同じように確認され、1行が何が変わったかと、残りは戻せると言います。`/aidlc intent set-repos --all` は作業が記録するすべてのリポジトリを保ちます。どちらにせよ、セットはそれからあなたのもので、作業が作られたときに `--repos` で名づけられたもののようになります。

作業が、ディスクで AI-DLC が見つけたリポジトリを10以上記録し、あなたがそれらを名づけなかったとき、Reverse Engineering は、どれも読む前に一度、それらすべてを読むか、一部だけかを尋ねます。多くを読むと長い時間がかかり多くのトークンを使うためです。あなたが名づけたセットと、unattended な実行は尋ねられません。ステップがコストを一度言い、すべてのリポジトリを読みます。あなたのリクエストがすでにどのリポジトリか（すべて、または名づけたもの）を言っていたとき、エージェントは尋ねる代わりにあなたのために設定します。ここでクローンされていない名前は、それをクローンする `intent add-repo` コマンドで拒否されます。set-repos 自体は決してクローンしません。Units Generation が承認された後、変更は着地し、`add-repo` と同じく Guard Policy に従います。

### `/aidlc intent add-checkout <path>`: 別のチェックアウトに保たれたコードをレビューがカバーするようにする

AI-DLC のレビューは、プロジェクトフォルダのコードをカバーします。その中にネストした worktree とクローンを含みます。この作業のコードが、ハーネスフォルダの worktree（Claude Code の `.claude/worktrees/<name>`）やプロジェクト外の worktree に保たれているとき、レビューはそれを見ないので、承認の質問は「AI-DLC found no source changes」と言い、レビューの後のそこの変更は気づかれません。`/aidlc intent add-checkout <path>` は、そのチェックアウトを作業について記録します。それ以降、レビューはそれをカバーし、レビューの後のそこの変更は、プロジェクトのどこでもと同じように捉えられ、承認はコードがどこで見つかったかを記録します。コードをそこに保つとき、エージェントがあなたのために実行し、ソースリストがハーネスフォルダの worktree のパスを名づけるユニットは、自分でそれを記録します。

パスは worktree またはクローン自体で、プロジェクトからの相対または絶対で、`.git` エントリを必要とします。表示される行はそれを `<label>@checkout` と名づけます。これは、ユニットのソースリストが、プロジェクト外のチェックアウトのコードを名づける方法です。質問は決してせず、記録はこのマシンに留まります。チームメイトのプロジェクトのコピーはそれを得ません。`/aidlc intent remove-checkout <path>` でまた取り除きます。

### `/aidlc space [name]` — スペースを一覧または切り替える

素の `/aidlc space` はスペースを一覧します。構造化出力には `--json` を加えます。`/aidlc space <name>` は、ユーザーごとの active-space カーソルを切り替え、そのスペースのメソッドファイルを、ハーネスネイティブのメソッド include が読む git 無視のコピー `aidlc/active-memory/` に書きます。追跡対象のファイルは変わりません。スペースを作ることも intent を進めることも決してありません。intent と同じく、動詞でもスペースの正確な名前でもない語は、動詞とスペース名とともにエージェントに渡され、名前の後にタイプした語は、エージェントが処理する切り替えとともに移動します。

### `/aidlc space-create <name>` — スペースを作る

フルの `memory/`、`knowledge/`、`codekb/`、`intents/` の形を持つ新しいチームスペースを作ります。別のチームの学習済みプラクティスではなく、デフォルトスペースの `org.md` とフレームワークのフェーズルールのコピーから始まり、空の `team.md` と `project.md` を持ちます。スペースを自動的には切り替えません。ワークスペースのモデル、切り替えの例、何がコミットされるかは [Spaces and Intents](03-spaces-and-intents.md) を参照してください。

### `/aidlc knowledge <verb>` — 自分のドキュメントをインデックスし読む

ドキュメント（PDF、Word と Excel のファイル、Markdown、プレーンテキスト、CSV）を `aidlc/spaces/<space>/knowledge/documents/` の下に、好きなように整理して置き、エージェントが推測ではなく引用できるようインデックスします。

| コマンド | 何をするか |
|---|---|
| `/aidlc knowledge onboard [path]` | プロジェクトのどこからでも1つのファイルやフォルダを追加する（`documents/` の外のものは先にコピーされ、結果がどこかを言う）、またはパスが与えられないとき `documents/` の下のまだインデックスされていないすべてのファイルを掃く |
| `/aidlc knowledge sync` | カタログをディスク上のものと突き合わせる。削除されたインデックスを再構築する |
| `/aidlc knowledge list [--json]` | カタログ — 各ドキュメントとその状態 |
| `/aidlc knowledge show <id>` | 1つのドキュメントの完全な記録と、抽出されたテキスト |
| `/aidlc knowledge associate <id> --intent [slug]` | ドキュメントを1つの intent にスコープする |
| `/aidlc knowledge dissociate <id> --intent [slug]` | そのスコープを取り除く |
| `/aidlc knowledge rebind <id> --to <path>` | 元が移動し*かつ*変わった行を修復する |
| `/aidlc knowledge summarize <id> --text-file <path> --source-revision <sha256> [--tags <csv>]` | LLM がオーサリングしたサマリー（と任意のタグ）を保存する — ツール自身はテキストを生成しない |

`--space <name>` はアクティブなもの以外のスペースをターゲットにします。`onboard` は冪等です。変わっていないファイルで再実行すると、2つめの行を書かず `already` と報告するので、掃くのは常に繰り返して安全です。すでにインデックスされたパスで **変わった** ファイルは `edited` と報告し、その行をその場でリフレッシュするので、1つのパスが2つのライブの行を運ぶことはありません。結果は `fresh`、`already`、`edited` で、読む価値があります。「no output changed」と「nothing happened」は別の結果だからです。

**バッチの上限。** パスなしの `onboard` と `sync` は、20ドキュメント/256 MiB の上限を、新しい、変わった、またはリトライの作業に適用し、すでに最新のカタログの行には適用しません。すでに突き合わせたカタログはより大きくても構いません。作業バッチが上限を超えたとき、影響を受けるファイルを個別に onboard してから再び sync します。上限に当たると何もインデックスされないので、拒否は決して中途半端ではありません。32 MiB を超える単一のドキュメントは、まったく読まれずに拒否されます。メッセージがそう言います。「refused」と「read, then refused」は、大きなファイルで非常に異なるコストだからです。

**スコープ。** `--intent` を省くとドキュメントはスペース全体です。すべての intent がそれを見られます。素の `--intent` はアクティブな intent を意味し、カーソルがないときは推測せず失敗します。`--intent <slug>` は1つを明示的に名づけ、slug がゼロまたは2つ以上の intent に一致すると失敗します（slug は完了した intent をまたいで繰り返しうるので、保存される関連付けは常に UUID で、slug を改名してもドキュメントを再び向けることはありません）。完了した intent へのスコープは、`--allow-inactive` を加えない限り拒否されます。これは、閉じた記録に証拠を後付けするために存在します。

**テキスト抽出**: Markdown、プレーンテキスト、CSV はそのまま読まれ、Word（`.docx`）と Excel（`.xlsx`）のファイルは AI-DLC 自身が、何もインストールせずに読みます。Word ファイルの段落とテーブル、ワークブックの各シートをテーブルとして、各数式の最後に保存された結果（日付と数値はファイルが保存するとおり。画像、チャート、コメント、ヘッダーは読まれません）。プロジェクトは任意のタイプについて自分の抽出器を構成でき、構成されたものが勝ちます。PDF は、何も構成されていなければデフォルトの抽出器（`pdftotext`）を得ます。他のどのタイプも `unsupported_type` としてカタログ化され引用可能です。抽出器を構成した後、`sync` を実行して、その検出されたタイプの変わっていない行をリトライします。AI-DLC が開けない Word や Excel のファイル（パスワード保護された、壊れた、または新しい名前で保存された古い `.doc` や `.xls` 形式のもの）は、理由とともに `extraction_failed` としてカタログ化されます。AI-DLC が読む前に追加された Word や Excel のファイルは、次の `sync` でそのテキストを得ます。構成された抽出器がインストールされていないと、ドキュメントは `extractor_unavailable` としてカタログ化されます。`list` で見え、ツールをインストールして `/aidlc knowledge sync` を実行すると直ります。同じ変わっていないパスで `onboard` を再実行すると `already` と報告し、抽出をリトライ **しません**。`sync` だけがこの状態の行を再プローブします。黙ってスキップされるものはありません。

**抽出には上限があります**: デフォルトの抽出器での PDF は50ページ（`pdftotext -l 50`、次に51ページ目のチェック）、抽出器の出力は200,000文字（Word や Excel のファイルのテキストも）です。上限を超えるとテキストは切られ、行は `truncated` を記録します。`show` は内容の上に `truncated  yes` の行を表示し（ページ上限が切ったときは `after page 50`）、`--json` のペイロードは `extraction` の中にフラグを運び、ページ切りには `pages_kept` を運びます。切られた抽出は部分的なビューとして扱います。「the document does not mention X」は、それ1つからは安全な結論ではありません。

各抽出器のプローブには5分のバックストップがあり、抽出にはドキュメントごとに15分あります。構成された抽出器の `timeoutMs` は抽出の予算をオーバーライドします。抽出のタイムアウトは `extraction_failed` を記録します。ドキュメントが正常に読まれたことを確立しません。これらの時間予算は、上のバイト、ページ、出力の上限を変えません。

構成された抽出器の `argv` は **ちょうど1つの `$IN`** を含まなければなりません。ドキュメントのパスが代入されるプレースホルダーです。それのない構成は、受け入れられるのではなく、ツールが起動するときに拒否されます。ファイルを決して受け取らないプロセスが、そうでなければ、そこにルーティングされた *すべての* ドキュメントの抽出テキストとして、表示したものを記録することになり、それは成功した抽出のように見えて、そうではないからです。2つ以上の `$IN` は同じ理由で拒否されます。意図が曖昧なので、閉じて失敗します。

**意図的に `remove` はありません。** ドキュメントを削除するとは、自分のファイルを削除して `sync` を実行することなので、ツールはあなたが所有するファイルに対して破壊的な動詞を持ちません。削除された元は、トゥームストーンされた行を残します。これは意図的に取り除かれたというカタログの記録で、リンクされた元が一時的に届かないことを意味する `source_unavailable` とは別物です。

> **ドキュメントのテキストはデータであって指示ではありません。** `show` はその警告を内容とともにインラインで出荷します。顧客の契約内の命令文は、その顧客のエンジニアに向けたものです。AI-DLC のワークフローを向け直すことも、許可を与えることも、コマンドを認可することも決してありません。

`/aidlc-knowledge` スキルは、コマンドとしてタイプされる、同じ画面です。

---

### `/aidlc --status` — 読み取り専用のステータス

現在のワークフローの進捗を、何も変えずに表示します。

**構文:**

```
/aidlc --status
```

**挙動:** アクティブな intent の `aidlc-state.md` を読み、次を表示します。スコープ（または、この作業向けに構成されたプランでは、代わりにその `Plan:` 行）、作業が新しいプロジェクトか既存のコードか（`Project Type: existing code (you said so)`）、既存のコードでは Reverse Engineering が最後にスキャンしたとき、またそれが単独で走ったとき（`, scanned 2026-10-03 23:17 UTC`）、深さとそれがどこから来たか（`Depth: Standard (from scope feature)`、または `set for this piece of work`。この作業向けに構成されたプランでは、それが走るストックのスコープとともに来た設定は `(from the approved plan)` と読め、深さ、Guard Policy、設定の行で同様）、それが異なるときのテスト戦略、現在のフェーズ、現在のステージ、プランのステージがいくつ完了したか（プラン提案が数えたのと同じ数え方で、セットアップなし。あなたが飛ばしたステージは数から外され名づけられ、`Completion: 4/4 stages (100%), skipped: Deployment Pipeline`、作業がそのステージで終わったときは `Completed (Deployment Pipeline skipped)`。一時停止した作業はそう言い、どう拾うかを言う `Paused at Deployment Pipeline (you stopped it); pick it back up with /aidlc --resume`）、レビュアーの設定とそれがどこから来たか（`Reviewers: advisory (from scope bugfix)`、またはこの作業についてオフにすると `off (set for this piece of work)`）、intent の Guard Policy の値とそれがどこから来たか（`Guard Policy: strict (from project.md)`、`off (from scope classic)`、`strict (set by you)`、またはフィールドのない古い intent には `strict (not set)`）、`Checks off:` 行（あなたや環境のスイッチがチェックをオフにしたときにだけ、それぞれを理由とともに名づける。`Checks off: state-transition (set by you)`。より低い Guard Policy がオフにするチェックは Guard Policy の行に付く）、ステージ進捗のリスト、そしてこのスペースの他の作業がまだ開いているとき、それを名づける `Also open:` 行（それに切り替えるよう頼める。`Also open: 261003-lunch-poll (ask to switch to it)`）です。無効な Guard Policy フィールドは、検証エラーと修復コマンドとともに利用不可として表示されます。完了ステージの検証の受領も調べます。完了したステージの入力が承認以降に変わったとき、次のステップが使う行でそう言い、やり直すかを尋ねます（`Something Practices Discovery used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Practices Discovery with the change?`、または作業が既存のコードになったときの `Practices Discovery ran before the code was here. I'm carrying on with it as it is. Do you want me to redo Practices Discovery with the code?`、または自分のドキュメントだけが編集されたときの `requirements.md changed after Requirements Analysis finished. I'm carrying on with it as it is. Do you want me to redo Requirements Analysis with your change instead?`）。影響する後のステージを名づけます（`Also affected: ...`）。AI-DLC 自身が今は違うやり方でする完了ステージは、あなたのものが何も変わっていなければ、自分の行で名づけられ、遅れではありません（`AI-DLC now does Functional Design differently from when yours ran; your work stands, and /aidlc --stage functional-design goes back to it (the stages after it reopen too).`）。チェックは advisory でルーティングを変えません。読めない受領と、受領のない完了は表示されません。現在のステージが承認待ちのとき、status はいつから待っているかを平易な時間で言います（`waiting since 2026-10-04 12:24 UTC, about 2 minutes`）。ワークフローがアクティブでなければ、進行中のワークフローがないと報告します。作業はあるがこの会話で選ばれていないとき（たとえばチームメイトのクローン）、各作業とその現状（完了、またはそのステージ）を名づけ、1つを続けるか新しい作業を始める方法を言います。

status は、各実効値とそのソースを持つ別々の **Sensors**、**Learnings**、**Summary Confirmation** の行も表示します。たとえば `Sensors: on (from scope classic)`、`Learnings: off (set by a command)`、`Summary Confirmation: off (set by you)`、または `Summary Confirmation: off (from env AIDLC_DISABLE_SUMMARY_CONFIRMATION)` です。欠けた保存済み設定は、現在のスコープ、次に `on (from default)` にフォールバックします。下記の儀式のコントロールを参照してください。

`Unit Ownership: team` のもとでは、スコープなしの main がレンダリングするのと同じボード、はっきりラベル付けされた **Team Construction Snapshot** を付けます。ユニットの進捗、ローカルに観測されたクレーム ref（プッシュ時刻ではなく、オーナー、世代、観測された動き）、ピンされたマージ準備、クレーム可能なユニット、ブロッカーです。スコープ付きとスコープなしのチェックアウトは同じボードをレンダリングします。このコマンドは状態、キャッシュ、監査をフェッチも変更もしません。明示的な `--space` と `--intent` のセレクタは、ヘッダー、ユニット DAG、クレーム、マージジャーナルを同じ選ばれたアイデンティティにバインドします。ボードは、利用可能または解放された作業をクレームする、ピンされたマージゲートを記録する、`aidlc unit land` を再開する、具体的な次のアクションで終わります。

---

### `/aidlc --claim <unit>` と `/aidlc unit claim <unit>` — チームユニットをクレームする

チーム所有の unit-major Construction ワークフローで、開いている1つのユニットをアトミックにクレームします。クレームレジストリは git ref `claim/<intent-id8>/<unit>` です。コマンドは compare-and-swap のセマンティクスでユニークなクレームコミットを書き、勝った nonce を検証し、次に gitignore されたチェックアウトローカルのスコープスタンプを書きます。同時にちょうど1人のクレーム者が成功します。

**構文:**

```
/aidlc --claim user-profile-api
/aidlc --claim user-profile-api --team "Alice"
/aidlc --claim user-profile-api --rhythm unit-end
/aidlc unit claim user-profile-api --team "Alice"
```

`--team` は人が読める保持者ラベルを供給します。`--rhythm` は任意で、このクレームを `per-stage` または `unit-end` に固定します。省くと、ワークフローの確定されたユニットゲートのリズムが使われます。クレームは、依存と必要な walking skeleton が完了するまで拒否され、ライブのクレームを持つチェックアウトは、スタンプされたユニットだけをルーティングします。main がユニットプランを変えようと Units Generation に戻っている間も、クレームはなお進み、その結果は、承認されたプランがそのユニット自身のエントリを変えると pin が main へのリベースを求めると、一度言います。

### `/aidlc unit adopt <unit>` — チームメイトのライブのクレームを採用する

新しいクローンで、正確なローカルのクレームブランチをフェッチしチェックアウトし、次を実行します。

```bash
git fetch origin refs/heads/claim/<intent-id8>/user-profile-api:refs/heads/claim/<intent-id8>/user-profile-api
git switch claim/<intent-id8>/user-profile-api
/aidlc unit adopt user-profile-api
```

採用は、チェックアウトローカルのスコープスタンプを書く前に、チェックアウトされたクレームの OID とペイロードを、スペース、intent UUID、ユニット、世代、nonce、バインドされた監査シャードを含めて、ライブの ref に対して検証します。以降の監査書き込みはクレームの既存のシャードを保ち、`publish` が同じ試行を続けます。オーナーのローカルの監査記録はクレームとともに来て（publish のハンドオーバーコミットが、オーナーのコミットの隣、main が着地させるものの外にそれを運びます）、このチェックアウトがすでに書いた行に加わるので、人がすでに答えた質問は答えられたまま残り、作業は彼らに再び尋ねずに再開します。

### `/aidlc --release <unit>` と `/aidlc unit release <unit>` — クレームを解放する

スコープなしの main のチェックアウトからライブのクレームを解放します。解放は、ref を削除するのではなく世代を進めるトゥームストーンを公開するので、古いスタンプされた試行はクレームに敏感な境界で閉じて失敗し、クレームの履歴は調べられるまま残ります。

```
/aidlc --release user-profile-api
/aidlc unit release user-profile-api
/aidlc unit release user-profile-api --expect-nonce <current-claim-nonce>
```

ユニットが解放され再クレームされた後、後の解放は `aidlc-unit.ts status` からの `--expect-nonce` を含まなければなりません。これはコマンドを後継の試行にバインドし、出力を失ったリトライがそれをトゥームストーンするのを防ぎます。

### `/aidlc unit participate` — ガイド付きピッカーを有効にする

このクローンの gitignore された参加者マーカーを書きます。その後、スコープなしの main での素の `/aidlc` は、クレーム可能、すでにクレーム済み、依存でブロックされた行を持つタイプ付きのユニットピッカーを発行します。マーカーのないファシリテーターのチェックアウトは、代わりに終端のファンアウト通知を受け取ります。

```
/aidlc unit participate
```

### `/aidlc unit publish <unit>` — 完了した候補を公開する

成果物、ソース、状態ミラー、監査シャードをコミットした後、スコープ付きのチームチェックアウトから実行します。

```bash
/aidlc unit publish user-profile-api
```

コマンドはクリーンな追跡対象ワーキングツリーを要し、ライブのクレーム ref を、クレームと実装の両方の履歴を保つ候補コミットに CAS 更新します。AI-DLC 自身の `.gitignore`、`AGENTS.md`、`opencode.json`（新しいクローンでセッションが始まるときに書かれる）の部分は、ここでも着地時でも数えられません。コミットされないまま残り、他のどの変更も両方を止めます。ユニットの `construction/<unit>/` フォルダの外の記録への変更（`contract-summary.md` のような Inception 成果物など）はなお公開されますが、pin はその候補を拒否するので、publish がそのファイルを名づけ、ブランチから取り出して main で変え、もう一度 publish するよう言います。クレームされたチェックアウトは、自分の監査行（セッション、ターン、回答）を、intent 記録の `.aidlc-engine/audit/` の下のローカルの記録に保ちます。AI-DLC の `.gitignore` がそれをコミットから外し、クレームの追跡対象シャードは、pin が受け入れるユニットの証拠だけを取ります。そのため候補はそのままのコミットで、ユニットが着地した後、クレームするチェックアウトでの main の素のプルは、それが書いたすべての行を保ったまま fast-forward します。

### `/aidlc unit pin <unit>` — 候補の証拠をピンする

スコープなしの main から実行します。

```bash
/aidlc unit pin user-profile-api
```

ピンはクレーム ref をフェッチし、その正確な OID/世代と新しいピントランザクション ID を記録し、成果物、ユニット受領、チームゲート、レビュアーの判定、Plan Approval、状態、監査シャードの転送を、そのコミットから直接読みます。マージも worktree の作成もしません。クレームにバインドされたチームシャードは、そのユニットの試行の受領だけを運べます。main 権限の行、別のユニットの記録/受領のパス、余分なシャード、他のワークフロー記録のパスは拒否されます。pin は、ユニットについての候補ベースのエントリ（その kind と依存）と、アクティブなユニットごとのステージ列も、ライブの main と比較します。変わった Construction 契約はリベースと再公開を要します。プランが他の場所で加える、落とす、変えるユニットはそうではありません。ユニット記録ツリーの外のプロダクトソースのパスは、人のマージゲートの証拠にリストされます。クレームされたチェックアウトに保たれたルール（スペースの `memory/project.md` や `memory/team.md`）もそこにリストされ、ユニットとともに着地します。

pin と land は、依存するすべてのユニットが main に着地するまで、ユニットを拒否します。

### `/aidlc unit gate <unit>` — ピンされたマージを決定する

```bash
/aidlc unit gate user-profile-api \
  --decision approve \
  --user-input "Approve pinned candidate"
```

受け入れられる決定は `approve` と `reject` です。コマンドは、ピンの後にタイプされた human turn が続くとき、人の回答を記録します（pin の出力が各回答についてこのコマンドを名づけます）。人の言葉は `--user-input` の代わりにファイルで来ることがあります。`--request-file aidlc/.aidlc-request-text/<name>.txt` で、AI-DLC があなたのためにコマンドを表示するときに書きます（pin の後、エージェントがあなたの返答を pin のコマンドが名づけるファイルに書きます）。途中でシェルが読まないようにです。ファイルは決定が記録されると消えます。ピンされたユニットは、pin がフェッチした統合ブランチへの通常のマージで着地するので、レビューされた OID は直接の親のままです。動いた ref、変わった世代、HOLD-MERGE マーカーは、承認の前に明示的な再ピンを要します。承認すると、その出力が land コマンド（`land`）を名づけ、エージェントが同じターンでそれを実行します。

ゲートの監査行は、人がピンの後に言ったこととそれが来たメッセージ（`Person Reply`、`Message Id`）を、エージェントの記述の隣に、ステージゲートの行がするように保ちます。そのチャットでピンの前にタイプされた自分の言葉の行が、決定で使われていないとき、行はピンの後のメッセージを名づけ、その言葉をその記録に残します。human-presence ガードがオフのときはどちらも保ちません。

### `/aidlc unit land <unit>` — ピンされたトランザクションを着地させる

```bash
/aidlc unit land user-profile-api --target main
```

着地はまず現在の統合ブランチをフェッチし、承認された証拠を、ユニット DAG のユニットのライブのエントリ（その kind と依存）と、アクティブなユニットごとのステージ列に対して再検証します。契約のドリフトは Git の変更の前に拒否し、リベース、再公開、再ピン、新しいマージゲートを要します。次に、main 所有のエンジンメタデータを保ちながらピンされた内容をマージし、ユニットの行を畳み、転送された監査受領を確定します。クラッシュ回復のため、冪等なステップを別々に実行します。

内容ポリシーは候補どおりです。main と候補の両方が共有ファイルを変えたとき、クリーンな自動マージでも、結果がピンされた候補の blob と等しくない限り、コミットの前に拒否されます。チームブランチを現在のターゲットにリベースし、そこで解決し、新しいピンのために再公開します。

```bash
/aidlc unit land user-profile-api --step git
/aidlc unit land user-profile-api --step state
/aidlc unit land user-profile-api --step audit
/aidlc unit merge-status user-profile-api
```

Gate と land は、クレームレジストリが使えない間、閉じて失敗します。正確なクレームの試行が `--step git` がそのレビューされたマージコミットを着地させた後にだけ解放されたとき、そのコミットを調べ、例外的な完了を了承します。

```bash
/aidlc unit land user-profile-api --step state \
  --accept-released-attempt \
  --user-input "I inspected the landed commit and accept completing this tombstoned attempt"
```

コマンドは、前任がピンされた OID である直後のトゥームストーンだけを受け入れ、了承を main 監査とトランザクションジャーナルに記録し、後継のクレームを拒否します。

### `/aidlc unit status` — ユニットのクレームを調べる

現在の統合状態とクレームレジストリを読み、クレーム可能、クレーム済み、待機中のユニットのセットを JSON で表示します。これはクレーム時/ステータスの画面で、構成された git リモートに接触することがあります。

チームモードは統合ブランチを、`project.md` の `## Way of Working` セクション、次に `team.md`、次に `org.md` から読みます。バッククォートで統合、ベース、マージターゲットのブランチを名づける最初の行が、ブランチが何と呼ばれていても勝ちます。どのレイヤーも名づけないとき、リモートのデフォルトブランチが使われます。git が使えない、またはリモートにない名前付きブランチは、別のレイヤーの選択に置き換えられるのではなく、それが来たファイルとともに報告されます。

```
/aidlc unit status
```

---

### `/aidlc --config [section]` — セッション内のプロジェクト構成

`models`、`runtime`、`providers`、`trust`、`flags`、`project` のいずれかを、ハーネスの会話を離れずに構成します。セクションなしでは、コンダクターがどのセクションを検討したいか尋ねます。セクションありでは、そのセクションの選択肢を提供しそれを変えずに残しながら、そこで何を変えたいかを常に尋ねます。そのセクションがすでにクリーンでもです。

コンダクターは現在の状態を `aidlc config <section> --show --json`（`aidlc config --show --json` はすべてのセクションを一度に読みます）で読み、変更を会話的に尋ね、列挙可能な選択肢には native の質問ピッカーを使います。「leave it」と言うとそのセクションをスキップします。受け入れられた各変更は、1つの正確な `aidlc config <section> <explicit value flags> --yes` コマンドを通じて着地します。コマンドとその出力が表示されます。別名は値を発明せず、素の `aidlc config --yes` を決して実行しません。

これはターミナルの構成作業です。変更が着地した後、または断った後、コンダクターは `next` の実行、進行、再開、ワークフローステージの実行をせずに止まります。

---

### `/aidlc --doctor` — ヘルスチェック

この実装の前提条件、構成、ステージグラフの整合性がすべて整っているかを検証します。クリーンと警告のみのレポートは 0 で終了し、失敗したチェックは 1 で終了します。フルのレポートはどちらの場合も stdout に書かれるので、オーケストレーターがどちらにせよそれを表に出します。コアの doctor チェックはあなたのどのファイルも変えません。AI-DLC 自身のアクティブなスペースのメモリのコピー（`aidlc/active-memory/`、Kiro IDE ではそのステアリングのコピー）を、すべてのセッション開始がするように最新にするので、最初の intent が作られる前にコマンドを安全に実行できます。intent が存在すると `HEALTH_CHECKED` 監査行も記録します。プラグインのチェックはインストール済みプラグインのコードを実行します。プラグイン作者は慣例上それらのスクリプトを読み取り専用に保つことを求められますが、ランタイムはその性質を強制できません。

ワークフローに問題があるとき、`--doctor` はその Project セクションに構造化された所見もリストします。それぞれ `fix:` 行を持つ `warn [<id>] <summary>` の行（たとえば `gate-unresolved`、`runtime-graph-missing`）で、未解決のゲート、欠けたランタイムグラフ、冷えたフック、その他の「進まない」原因についてです。ライブのレポートと `--export` は1つの分析を共有するので、所見はどちらでも同一です。

**構文:**

```
/aidlc --doctor
```

**何を確認するか:**

| チェック | 何を検証するか |
|-------|-------------------|
| 前提条件 | 自己完結したバイナリ、またはコピーインストールでは PATH の `bun` |
| インストール済みランタイム | バイナリチャンネルを使うとき、アクティブなマシンのバージョンとインストール済みのハーネスディストリビューション |
| プロジェクトスタンプ | プロジェクトのディストリビューション/バージョンを、プロジェクトを提供するエンジンと比較。リリースの `.aidlc-version` のピン、なければ走行中のリリース |
| フックの存在 | `settings.json` が結線するすべてのフレームワークのフックが `.claude/hooks/` に存在。結線されたが欠けたフックは明示的に失敗。AI-DLC のステータスラインは、オンにしたとき自分の `.claude/settings.local.json` から確認。進捗を示すだけなので、誰も結線しない `aidlc-statusline.ts` がオフの強制として報告されることはない。期待される名簿を `settings.json` から取るので、そこにフックを加えると自動的に確認される |
| フックが有効（Claude Code） | Claude Code の設定レイヤーで `disableAllHooks: true` が解決値でない（エンタープライズ管理ファイルとアルファベット順の `managed-settings.d/` フラグメント → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`、もっとも優先度の高い定義が勝つ）。解決された `true` は、存在するすべてのフックを黙ってスキップするので、明示的に失敗しレイヤーを名づける |
| プロジェクト構造 | `.claude/settings.json` が存在する（ファイルの存在だけ、内容の検証なし） |
| Kiro のフックがオフ | Kiro ハーネスで。`"enabled": false` を運ぶ `.kiro/hooks/` の各 AI-DLC フックファイル（`aidlc-*.json`）。Agent Hooks でフックをオフにすると Kiro が書く。ガードフック（`aidlc-guard-tool-call`）、返答レコーダー（`aidlc-record-human-turn`）、プロジェクトがまだ保つ古いガードファイルは失敗し、それぞれもう保護されないものを名づける。オフにされた他の AI-DLC フックは1つの警告。直し方は Kiro の Agent Hooks の下でフックを戻すこと |
| Kiro の ignore ソース | Markdown のコンダクターを持つ Kiro ハーネスで（`.kiro/agents/aidlc-aidlc.md`、Kiro IDE と Kiro CLI v3 が使う）。git のグローバルな excludes ファイル（git リポジトリで）、`~/.kiro/settings/kiroignore`、プロジェクトの `.gitignore`、`.kiroignore` を、エンジンがエージェントに `fs_read` で行わせる読み取りに対して個別に評価する。`harness.json` がコンパイル済みグラフで選ぶすべてのステージについて、ステージファイルと、コンダクターがインラインで保つペルソナと知識（Standard と Minimal の深さでのエンジン自身の名簿、ディレクティブの 8 KiB の `inline_context_paths` キャップ内）、加えて `stage-protocol.md` とその `stage-protocol-<name>.md` モジュール、各スキルの `SKILL.md` の隣のファイル。`stage-definition.md` のような貢献者専用のプロトコルファイルはロードされないので、カウントされない。プラグインは、どうコンポーズされたかに応じてカウントされる。`SKILL.md` ファイル、コンダクターエージェント（`agents/aidlc-aidlc.md`）、`aidlc-common/conductor.md`、そして `tools/`、`sensors/`、`hooks/`、`scopes/`、`steering/` は、`fs_read` ではなく Kiro 自身かエンジンがロードし、カウントされない。それらの一部だけを隠すルールは、カウントと、それが触れるフレームワークのフォルダとともに報告される。`.kiro/` を隠すグローバルソースのルールは失敗し、ソースと行を名づける。Kiro の `fs_read` ガード（Kiro IDE と Kiro CLI v3）がそのとき、すべてのステージ、エージェント、プロトコルの読み取りを拒否するため。ワークスペースソースのマッチは警告する。doctor はどの Kiro が走るか分からないため。Kiro IDE では `kiroAgent.agentIgnoreFiles` がそのファイルを名づけるときだけ適用され（デフォルトは `.gitignore` を含み、`[]` はワークスペースソースを無効にする）、doctor はその IDE 設定を読めない。Kiro CLI v3 は `.kiroignore` を適用し（そこでのマッチはそれらの読み取りを拒否する）、`.gitignore` は適用しない。警告がどちらかを言う。doctor が評価できないソース（たとえば `git` が PATH にない。git リポジトリではカスタムの `core.excludesFile` も隠す。または git がディスク上に存在するリポジトリを拒否する）は、通るのではなく `not evaluated` と警告する。行はソースを `~/.config/git/ignore` や `.gitignore` のような固定の名前で名づけ、パス、ルールテキスト、git のエラーテキストでは決して名づけない。別のファイルの `!.kiro/` は deny を取り消さない |
| ワークスペースシェル | `.claude/` + `aidlc/spaces/default/memory/` が存在する（出荷のシェル） |
| アクティブなスペースのメソッドコピー | `aidlc/active-memory/`（すべてのハーネスの include が読む git 無視のコピー）がアクティブなスペースの `memory/` ファイルを保持する。チェックはすべてのセッション開始がするようにまずそれを書くので、残った差は、そこに書けないファイル（警告） |
| VS Code のエージェントリクエスト上限 | Copilot のみ。`.vscode/settings.json` が `chat.agent.maxRequests` を 100 以上に設定。未設定（VS Code のデフォルト 50）、それより低い、数値でない（クォート内の数値を含む）、または読めないものは警告する。VS Code がそのとき長いステージを止めて「Continue to iterate?」と尋ね、誰かが答えるまでチャットが待つため。直し方がファイルに書く行を名づける |
| サブモジュール | `.gitmodules` が存在するとき、いくつのサブモジュールパスが宣言され、いくつが未初期化かを報告し、あるときは `git submodule update --init --recursive` を名づける（advisory、決して失敗しない） |
| Env スコープ | `AWS_AIDLC_DEFAULT_SCOPE`（設定されていれば）が有効なスコープを名づける |
| フックのハートビート | `.aidlc-engine/hooks-health/` がフック実行からのタイムスタンプを含む（自分のものがない記録には、それを作ったターンのビート、記録が存在する直前に書かれたものが、最初の5分間カウントされる）。ハートビートなしは、ワークフローの進行の前は advisory のみ。作業が進むと失敗し、もっとも新しいハートビートがもっとも新しいステージ/ゲートのイベントより5分以上遅れていると停止として失敗し、そのフックを走らせるハーネス自身のステップ（Claude Code では `.claude/settings.local.json` の `"disableAllHooks": false`、または組織のポリシー。`.claude/settings.json` が欠けている、有効な JSON でない、または AI-DLC のフックをどれも登録しないときは、代わりにそのファイルの修復）を示す。ハートビートはそれを書いたクローンに留まり、監査記録は git で移動するので、他のクローンの監査記録だけが進行を示すとき（プルしたチームメイトの作業）、代わりに警告になる。`This workflow was run in another clone (<machine>); this clone has no hook record for it yet`、このクローンに直すものはない |
| Claude の管理フックポリシー | Claude ハーネスのみ。既存の managed-settings リゾルバ（`AIDLC_MANAGED_SETTINGS_PATH`、現在とレガシーの Windows パス、macOS、Linux/WSL）とアルファベット順の `managed-settings.d/` フラグメントを使い、実効の `allowManagedHooksOnly` が `true` のとき失敗する |
| あなたの返答が記録されていない | ステージ/ゲートのイベントがあるのに監査に `HUMAN_TURN` がないとき、人の返答が記録されていない（だから次の承認は拒否される）と警告し、直し方としてハーネス自身のフックのステップを示す |
| フックのドロップ | `.aidlc-engine/hooks-health/<hook>.drops` のテレメトリ（それぞれ、ツール呼び出しを壊さないためにフックが飲み込んだ失敗を記録する）を、ドロップ数、最後のタイムスタンプ、フックごとのもっとも頻度の高い理由、そして対処（検査し、ファイルを削除する）とともに表に出す。最新の失敗が24時間未満のフックは、`--verbose` なしで表示される警告で（`Hook failures, the latest within the last day`）、すべての失敗を数える。1日後、またはファイルが削除されるとクリアされる。各理由は最初のコロンまで、フック自身のサマリーとして、秘密を伏せて表示される。その後の詳細はファイルに残る。古い失敗と、プラグイン compose フックからの `[advisory]` の行は、通る advisory の行。フックの通常の決定（Stop フックが、あなたが先に答えなければならないのでターンを終わらせること）は代わりに `<hook>.trace` に行き、決してカウントされない。`[degraded]` のドロップ（半分適用されたプラグイン compose）だけが失敗する |
| ワークスペースソース境界がバインドする | ワークフロー状態が存在するときのみ。Plan Approval がプランをバインドするのと同じワークスペースソースのウォークを実行する。フィンガープリントの最初の12桁の16進で通り、理由コードとパス（たとえば `budget-entries at .`、`dangling-symlink at linked/src`、`excluded-path at node_modules/pkg`）を名づけて失敗し、効力を持つ設定のもとでプランの質問が何をするかを言い、修復のテキストを与える。問題のパスを `.aidlc-source-paths.json` の exclude リストに加える、除外されたディレクトリの下の実在のソースをその paths リストに宣言する、壊れたシンボリックリンクを取り除く、次に `next` を実行する。Guard Policy strict で plan approval がオンのもとでは、Plan Approval の決定が拒否されると言い、最後の手段（あなた自身の言葉でだけ、チャットでアシスタントにとにかくプランをビルドするよう頼むと、プロジェクトのファイルのチェックなしにあなたの承認として記録される）を加える。そうでなければ、プランの質問がいつもどおり尋ねられ（plan approval がオフなら、プランは書かれたとおりビルドされる）、ビルドがプロジェクトのファイルのチェックなしに始まると言う |
| 現在のステップが古い | 続く間のみ。アシスタントが作業していたステップが古くなった（チャットがコンパクトされた、またはステップが発行された後にワークフローの状態が変わった）。いつ、なぜ、分かるときはどの状態の行が変わりどの AI-DLC コマンドが書いたかを言う。直し方は `next` を自分のコマンドとして実行すること。現在のステップをもう一度手渡し、まだ一致する承認を保つ（警告、決して失敗しない） |
| 状態のドリフト | アクティブな intent の `aidlc-state.md` が監査の最後の `WORKFLOW_COMPLETED` と一致する |
| 保留中の承認 | 現在のステージが有機的な承認ゲートで24時間以上待ったとき、詰まっているのではなく人を待っていると特定し、`/aidlc --status` を示す（advisory、決して失敗しない） |
| バックグラウンドサブエージェント | `aidlc/.aidlc-subagent-inflight` の新しいセッションスコープのエントリと古いエントリを報告する。新しいエントリは advisory。古い、または不正なエントリは正確な取り除きのガイダンスとともに失敗する。ないときは沈黙 |
| 脇に置かれた Bolt の試行 | 保存された試行の情報的なリスト。slug、stamp、日数での経過、モード（`snapshot`、`branch-tip`、保存された head には `legacy`。レビューされたソース ref だけが残るときは `evidence-only`）、復元されたチェックアウトの所有、そして任意の安全な表示コマンドやレンダリングエラーを持つタイプ付きの restore/purge の操作（purge は evidence-only のエントリにだけ）。これらのエントリは警告でも失敗でもない |
| サイクル検出 | `stage-graph.json` にサイクルがない |
| 孤児ステージファイル | グラフのすべての slug が、ディスクに一致する `<phase>/<slug>.md` を持つ |
| 未コンパイルのステージファイル | slug がコンパイル済みグラフにないディスク上のステージ `.md` を表に出す。プラグイン所有のファイルは `plugin sync` を名づけ、他のオーサリングされたステージは `aidlc-graph.ts compile` を名づける（advisory、決して失敗しない） |
| プラグイン選択 | 有効なプラグインリスト、プラグインごとの有効ステージ数、フルグラフの `enabled:false` フラグの一致、ちぎれた選択の回復ヒント |
| プラグイン合成 | オフラインのインストール対合成のバージョン/ハッシュの状態。sync または修復の対処を含む |
| 合成されたプラグイン面 | 有効なプラグイン所有のステージファイルがコンパイルされ、有効なプラグインの各貢献のサイドカーが読めて有効で、記録された各ターゲットステージが存在し、記録された各構造的な追加や文章のフラグメントがまだ存在し変わっていない |
| プラグインチェック | 有効なプラグインについてのみ、任意の `tools/<plugin>-doctor.ts` スクリプトを実行する。エラーの所見は doctor を失敗させ、advisory の所見は終了コードを変えずに見え、エクスポートされる |
| スコープ検証 | すべての有効なスコープ（プラグイン選択の後の `.claude/scopes/*.md` から）がクリーンに歩く（スコープ切り詰めのギャップの advisory は想定どおり） |
| 合成されたスコープの耐久性 | すべてのコンポーザーオーサリングのスコープが実在のプランに解決する。グリッド列のないスコープファイル（空の all-SKIP プランとして解決してしまう）、ハーネスツリーにまだ射影されていない耐久的な `aidlc/scopes/<name>.md` 記録、または記録された `Scope` に解決できる定義のない実行可能なワークフローで失敗する。compile が原因に届けるところでは `aidlc-graph.ts compile` を対処として名づける。その背後に **記録のない** 欠けた列は別に報告される。compile は、あるステージが `scopes:` フロントマターで宣言するスコープについてだけ列を出すため。その行は、記録の復元、スコープのステージタグ付けの完了、またはスコープファイルの削除を名づける。記録の記述的なフロントマターをその射影されたファイルと比較しない。グリッドは常に記録から来て、compile は手編集を上書きするのではなく既存のスコープファイルをそのまま残す |
| スキーマ検証 | すべてのステージの YAML フロントマターが `validateStageFrontmatter` を通る |
| グラフ参照 | すべての `consumes[].artifact` と `requires_stage[]` のターゲットが解決する |
| 重複する生産者 | 消費される各成果物に単一の生産者がある。複数の生産者はそのステージ slug とともに報告され、グラフのロード順で最初に解決される（advisory、決して失敗しない） |
| キーワードの重複 | 複数のプランが持つヒントは警告で、プランを名づける（プラン提案がそれを各プランの下にリストする） |
| ルールのドリフト | 矛盾のレビューのために、満たされた org ポリシーと重なるライブのチーム/プロジェクトの見出しを表に出し、ライフサイクルで古くなった重なりを別の stale-suppressed の行で報告する（advisory、決して失敗しない） |
| ペアになった sensor のカバレッジ | ペアになった Sensor を名づけるすべてのルールが、あるステージが実際に発火する Sensor に解決することを確認する（advisory、決して失敗しない） |
| ワークスペース記録 | `aidlc/` の下のコミットされていない変更を報告し、共有記録が1つのチェックアウトにだけ残らないようにする。`aidlc/.aidlc-request-text/` と、自分の実行について doctor が書くエントリだけが変更の監査ログを除く（それだけのとき、行は通りそう言う）。git がリクエストファイルを追跡または表示する間、またはフォルダが無視しない取り除かれたものを保つ間は、commit コマンドを与えない。`git add aidlc/` があなたのリクエストを取り込むため（advisory、決して失敗しない） |
| リクエストフォルダ | git が `aidlc/.aidlc-request-text/` のファイルを見られるときのみ。それらはあなた自身のリクエストを保つので、ステップを名づけ、決して実行しない。フォルダがまだ無視されていないとき、`aidlc/.aidlc-request-text/` の行をプロジェクトフォルダの `.gitignore` に加え（後のルールがそれを再び無視解除していないか確認）、プロジェクトフォルダで、git が追跡するとき `git rm --cached -r -f -- aidlc/.aidlc-request-text/`（ファイルは残る）を実行し、次にチームメイトのクローンもそれを落とすよう取り除きと `.gitignore` の変更をコミットしプッシュする（リフレッシュがそれをコミットされないまま残したかもしれない）。まだコミットされていない取り除きは行を保つ（advisory、決して失敗しない） |
| 宣言されたワークスペースのリポジトリ | `repos.json` が存在するとき、その宣言されたセットを、ランタイム検出がディスクで見る兄弟リポジトリと比較する（advisory、決して失敗しない） |
| ワークスペースの gitignore | `repos.json` が存在するとき、管理された `.gitignore` ブロックが宣言されたリポジトリのセットと一致するか確認する（advisory、決して失敗しない） |

**出力の例:**

```
AI-DLC doctor

Machine
  warn  Runtime hook PATH: bun is on this shell's PATH (/home/user/.bun/bin/bun) but not on the system-wide PATH
        fix: Nothing needs changing when you start Claude Code from a terminal: it hands that terminal's PATH to AI-DLC's hooks. If you start it from a desktop icon, the dock, or a service and AI-DLC's hooks do not run, add /home/user/.bun/bin to the PATH line in /etc/environment, ENV_PATH in /etc/login.defs, or a PATH= line in ~/.config/environment.d/*.conf, then restart Claude Code. Editing .bashrc or .zshrc does not change this check.
  warn  Update: update check unavailable while offline
        fix: run `bun .claude/tools/aidlc.ts update --check`
  ok    4 checks passed

Project (.claude, Claude Code)
  warn  Instruction file: block or file missing (.claude/CLAUDE.md)
        fix: run `bun .claude/tools/aidlc.ts config`
  ok    43 checks passed

Framework integrity
  ok    all 12 checks passed

0 problems, 3 warnings.
Warnings are advisory - if everything works, ignore them.
Add --verbose to see every check.
```

すべての Machine、Project、グラフ、スキーマ、ステージ、スコープ、sensor の行を広げるには `--verbose` を使います。すべての警告または失敗には、続く `fix:` のアクションが付きます。

---

### `/aidlc --doctor --export` — 診断レポートを書く

`--doctor` に `--export` を加えて、小さな編集済みの診断レポートを書き、誤動作するワークフローを、プロジェクトディレクトリ全体を共有せずにデバッグできるようにします。まず **新しい** doctor パスを実行し（レポートはキャッシュされた診断を決して反映しません）、次にレポートを書きます。レポートの書き込みは doctor の終了コードを決して変えません。

**構文:**

```
/aidlc --doctor --export
/aidlc --doctor --export --output <dir>
```

`--output <dir>` は出力場所をオーバーライドします。デフォルトはプロジェクトの下の `aidlc/diagnostics/` です。

**何を生むか:** システムの `tar` が使えるときはタイムスタンプ付きの `.tar.gz`、そうでなければレポートディレクトリが保たれ、共有の前に自分で圧縮する指示が付きます（新しいパッケージ依存なし、独自のアーカイブライターなし）。レポートは次を含みます。

| ファイル | 内容 |
|------|----------|
| `report.md` | 人が読めるワークフローのタイムラインと所見 |
| `report.json` | 機械可読なタイムライン、所見、サマリー |
| `manifest.json` | レポートのスキーマバージョン、AI-DLC のバージョン、ハーネス、ハッシュ化された intent id、ファイルごとの SHA-256 チェックサム、適用された編集、切り詰めの通知、除外リスト |
| `evidence/normalized.json` | allowlist された正規化済みのフィールドだけ。生のファイルは決して含まない |

**何を診断するか:** レポートは、監査証跡からワークフローの **タイムライン** を再構成し（ステージの所要時間、ゲート、リビジョン、ギャップ、長時間・不完全・スキップのフラグ。スキップされたステージはそのスキップ時刻を Completed として示す）、次に、よくある「進まない」原因について **決定的な** 条件→対処のルール（LLM なし）を実行します。未解決の承認ゲート、状態/監査のドリフト、欠けたランタイムグラフ / 冷えた・凍ったフックのハートビートです。所見は、ライブの `--doctor` が使うのと同じ共有の `DoctorFinding` モデルから来るので、コマンドとレポートは決して食い違えません。回復のバイパス（たとえば `AIDLC_DISABLE_*` の env var や「ワークスペースをアーカイブする」指示）を名づける対処は、常に自動化に安全でないとフラグされます。

`DOCUMENT_INDEXED`/`DOCUMENT_UPDATED`/`DOCUMENT_REMOVED` はスペースレベルの監査シャードに置かれます。`--doctor --export` はそのシャードを明示的に読み、アクティブな intent のシャードと組み合わせるので、レポートはワークフロー開始後のドキュメント履歴を含み、ワークフロー権限の読み手は intent スコープのままです。`list` と `show` は DocumentKB のカタログを直接読み続けます。

**安全性。** レポートは、ワークスペースのソース、生の状態/監査/ランタイムグラフのファイル、成果物/貢献/質問/メモリの本体、環境変数、コマンド出力を決して含みません。発行されるすべての文字列は編集されます。ホームディレクトリは `~`、プロジェクトルートは `<project>` になり、intent の id とユニット名はハッシュ化され、秘密らしい値はスクラブされます。実パスがプロジェクトルートの外に出る入力は拒否され（シンボリックリンクされた葉や親はツリーの外にたどられません）、ファイルごとと合計のサイズに上限があり（切り詰めは manifest に記録されます）、プラットフォームがサポートするところではファイルが所有者のみで作られます。

**出力の例:**

```
Diagnostic report created:
  aidlc/diagnostics/aidlc-diagnostic-report-20260714-153000-3f9a1c22.tar.gz

Findings:
  ERROR gate-unresolved
  WARNING runtime-graph-missing

No source files or artifact bodies were included.
```

---

### `/aidlc --stage <slug|#>` — ステージにジャンプする

slug または番号で特定のステージに直接ジャンプします。

**構文:**

```
/aidlc --stage code-generation
/aidlc --stage 3.5
/aidlc --stage requirements-analysis
/aidlc --stage 2.3
```

**挙動:** ワークフローがアクティブなら、ターゲットのステージにジャンプします（間のステージを警告とともにスキップ）。ジャンプとともにタイプされた `--scope`、`--depth`、`--test-strategy`、`--guard-policy` は先に適用され、次に変更された作業でジャンプが行われます（`--review` と `--sensors` のような儀式のスイッチは、先に単独で設定します）。ワークフローが存在しなければ、`--scope` と組み合わせてそこで始められます。

```
/aidlc --stage code-generation --scope bugfix
```

プランが飛ばすステージは行き止まりではありません。現在のステージの後に来るとき、ジャンプはまずそれをプランに戻し（`recompose --add`、ジャンプとその理由とともに記録）、それからジャンプし、1行がそう言い戻る方法を言います。まだワークフローがないとき、ステージは他のどのジャンプターゲットとも同じように走り、1行がスコープのプランの一部でないと言います。現在のステージの前に来るとき、または現在のステージのとき、戻ると後のすべてのステージがまた走ることになるので、ジャンプは、プランや進捗に触れずに今それを走らせる方法とともに拒否されます。`/aidlc --stage <slug> --single`。

---

### `/aidlc --stage <slug> --single` — 1つのステージを単独で実行する

`--single` を加えて、メインのワークフローを動かさずに単一のステージを単独で実行します。ステージは走り、あなたの作業がそのステージ用に保つ場所にそのドキュメントを書き、止まります。ワークフローの `Current Stage` は決して進みません（これはエンジンが強制し、慣例ではありません）。フルのライフサイクルにコミットせず、1つの方法論（要件分析、reverse-engineering のスキャン）を適用するのに使います。あなたの作業がすでにそのステージ用のファイルを保持するとき（それが承認したステージ、またはユニットのステップ）、実行はまずそれらのコピーを作業の記録に、`archive/<time>-<stage>/` の下に保ち、1行がそのフォルダとともにそう言います。あなたの作業は実行が書くものから進み、コピーが戻る道です。各実行は自分のコピーを保ちます。スコープが飛ばすステージも走ります。1行がプランの一部でないと言い、プランはそのまま残ります。隔離された実行は、なおステージに構成されたエージェントとレビュアーを使いますが、ワークフローの学習やワークフローの承認は求めません。その合成的な完了が監査ログに記録され、それからコマンドが止まります。それとともにタイプされた `--depth` や `--test-strategy` はその実行だけに適用されます。ワークフローの設定はそのまま残ります。`--review`、`--guard-policy`、`--guard.<check>` のスイッチ、儀式のスイッチ（`--sensors` など）は `--single` で拒否されます。それらなしでステージを実行します。

```
/aidlc --stage requirements-analysis --single
/aidlc --stage reverse-engineering --single
```

実行可能なすべてのステージは、タイプ可能な一語のランナー `/aidlc-<slug>` も出荷します。これは `/aidlc --stage <slug> --single` をパッケージ化したものです。フルのランナーファミリー（スコープランナー、ステージランナー、`/aidlc-init`、セッションビュー）は [Skills and Runner Commands](17-skills.md) に文書化されています。

---

### `/aidlc --phase <name|#>` — フェーズにジャンプする

特定のフェーズの最初のステージにジャンプします。

**構文:**

```
/aidlc --phase construction
/aidlc --phase 3
/aidlc --phase ideation
/aidlc --phase 1
```

**挙動:** `--stage` と同じですが、名づけられたフェーズの最初のステージをターゲットにします。`--scope` と組み合わせられます。

---

### `/aidlc --scope <name>` — スコープを変える

走行中のワークフローのアクティブなスコープを変えます。

**構文:**

```
/aidlc --scope bugfix
/aidlc --scope enterprise
```

**挙動:** `aidlc-state.md` のスコープ構成を更新し、どのステージが実行されどれがスキップされるべきかを再計算し、`SCOPE_CHANGED` 監査イベントを記録します。`--depth`、`--test-strategy`、`--review`、`--guard-policy`、`--sensors`、`--learnings`、`--summary-confirmation`、`--guard.<fence>` のスイッチと組み合わせられます。エージェントがあなたの言葉で頼んだ設定を加えるとき、`--message <id>` も加え、あなたが頼んだメッセージを名づけ、設定は `config set` と同じく `set by you` と読めます。スコープ由来の Guard Policy は、より厳しい新しいデフォルトに自動的に従います。より低いデフォルトは、エージェントがあなたがスコープ変更を頼んだメッセージ（`--message <id>`）を名づけるときに従います。そうでなければ走行中のワークフローはそのポリシーを保ち、出力が1行でそう言います。儀式の値は新しいスコープのデフォルトに従い、明示的な人のオーバーライドと欠けたレガシーの行は保たれます。メモリ strict はなお実効ポリシーを制御します。明示的なフラグは人の来歴を保ち、`config-change` と同じ引き下げルールに従います。現在のスコープを選んでも、供給された設定は、偽のスコープ変更イベントなしに、同じ構成アプライヤーを通じて適用されます。無効または未知のフラグ、または認可されていない `--guard-policy relaxed` や `--guard-policy off` は、CLI の更新全体を拒否します。ステージのチェックボックスは変わらず引き継がれます。開いている承認（`[?]`）とリビジョン（`[R]`）を含みます。ただし、新しいスコープが承認待ちのステージを飛ばす、または始まる前の現在のステージを飛ばす場合は、それらのステージは変更とともにスキップされます（`[S]`、1つの `STAGE_SKIPPED` 行と1つの出力行ずつ、単独で実行する `/aidlc --stage <slug> --single` を名づけます）。走行中の作業で、何もあなたを待たないとき（ステージが単に走っていた）、エージェントは同じターンで、新しいスコープがそれをもう走らせないときに次に走らせるステージへ続けます。承認、質問、ユニットのチェックポイントやサマリーがあなたを待つとき、ターンは終わり、エージェントは、そのステージが新しいプランに残り作業がユニットごとでないとき、作業がどこで拾われるかを言います。同じメッセージが、新しいプランがなお走らせるステージであなたを待つ承認にも答えたとき、作業が一時停止もユニットごとでもないとき（「approve, and switch back to the poc plan」）、エージェントはその回答を切り替えの直後に記録するので、作業は新しいプランから進みます。Practices Discovery のゲートでは変更依頼が同じように記録され、承認は、承認したプラクティスが保存されるのを待つので、次のメッセージを待ちます。完了した作業（`Status: Completed`）では、最後のものより後のステージを走らせる新しいスコープが、同じ書き込みでそのステージで作業を再び開き（`Status: Running`、ステージ `[-]`、1つの `STAGE_STARTED` 行、`intents.json` の行が `in-flight` に戻る）、エージェントが同じターンでそれに入り、切り替えの行と新しいスコープが変えた設定をステージの最初の行とともに言います。前に承認したものは承認のまま残り、`doctor` は再び開かれた実行を、以前の完了からのドリフトではなく実行として読みます。最後のステージの後に何も加えない新しいスコープは、作業を完了のまま残します。切り替えで飛ばすステージ（完了した poc 作業での `/aidlc --scope feature --skip ci-pipeline`）は、再び開くのがそのステージを拾う前にプランから外されるので、作業はそれより後で飛ばさなかった最初のステージで再び開き、エージェントは何が飛ばされたかと単独で実行する方法（`/aidlc --stage <slug> --single`）を言います。切り替えが加えるすべてのステージが飛ばされると、作業はそれらの飛ばしをプランに持ったまま完了のままです。ソロまたはチームのユニット所有で進行中のユニット作業について、変更は決して拒否されません。Units Generation がすでに作ったユニットは、新しいスコープが Units Generation を飛ばすときユニットごとに続き、新しいスコープが落とすステージのユニット承認やユニット作業は1行で名づけられます（たとえば「The beta Unit's NFR Requirements approval is no longer part of the plan.」）。逆に、作業がそれを走らせずに通過した後に選ばれた、Units Generation を走らせる新しいスコープは、ユニットを作りません。その Construction ステージは作業全体で一度走り、開いているゲートはその作業とともに開いたままで、Units Generation に戻る（`/aidlc --stage units-generation`）と作業がユニットに分かれます。

返信の最初の行は、作業が新しいプランで走らせるステージ（完了したもの、現在のステージから先のもの。現在のステージの後ろに新しいプランが加えるステージは、そこに戻るときだけ走ります）、いくつ完了したか、その承認ゲートを与え、戻る方法（`/aidlc --scope <old scope>`）を言います。切り替えて戻すと、同じ残りのステージが戻るときです。作業に合わせて仕立てたプランの後では、戻しません。次に、変更が飛ばした各ステージについて1行、落としたユニット作業を名づける1行、値が変わった設定ごとに1行が来ます。新しいスコープがそのまま残すデフォルトはリストされず、スコープとともにタイプした設定は、変わっても変わらなくても常に報告されます。

作業があるステージのサマリーを確認する同じ返信で、そのステージを持たないプランへの切り替え（「1. also can you switch this to the express plan?」）をタイプすると、エージェントはまず、あなたが確認したものからそのステージのドキュメントを書き、ステージの他は何も書きません。切り替えはそれから上記のようにステージをスキップし、新しいプランがそれを含まないと言い、後のステージがそれらのドキュメントを読みます。あなたが確認する前、またはドキュメントが書かれると、切り替えは上記のように進みます。

自律的な Construction（`Construction Autonomy Mode: autonomous`、人が「Continue automatically」を選んだ）のもとでは、人が頼んだスコープ変更は他のどれとも同じように通り、残りの作業は自動的に走り続けます。彼らのリクエストの記録のない変更、または `AIDLC_UNATTENDED=1` で実行された変更は拒否され（新しいプランを承認する人がいない）、拒否は `bun .claude/tools/aidlc-bolt.ts set-autonomy --mode gated` を名づけ、各 Bolt で承認のために止まるように切り替えるので変更が通せます。`recompose`（`/aidlc --skip` や `--add`、または承認された compose 提案）は同じルールに従います。

まだワークフローのない新しいプロジェクトでは、`--scope <name>` は代わりに始めます。`/aidlc <name>` とまったく同じように振る舞います。何を作るかとともに名づけると、ワークスペースが名づけられたスコープで初期化されワークフローがその最初のステージで始まります。単独で名づけると、まず作業が何のためかを尋ねます。

---

### `/aidlc --depth <level>` — 深さをオーバーライドする

現在または新しいワークフローの深さのレベルをオーバーライドします。

**構文:**

```
/aidlc --depth minimal
/aidlc --depth standard
/aidlc --depth comprehensive
```

**挙動:** ワークフローがアクティブなとき、`aidlc-state.md` の Depth フィールドを更新し `DEPTH_CHANGED` 監査イベントを記録します。`--scope` と組み合わせると、新しいスコープのデフォルトの深さをオーバーライドします。`--stage` や `--phase` と組み合わせると、ジャンプターゲットの実行コンテキストの深さを設定します。どの作業も存在する前にチャットでタイプすると、チャットが次に始める作業のために保たれ、エージェントが1行でそう言います。

**有効な値:** `minimal`、`standard`、`comprehensive`（大文字小文字を区別しません）。

**例:**

```
/aidlc --depth minimal                            Change depth of active workflow
/aidlc --scope bugfix --depth comprehensive        Bugfix with comprehensive analysis
/aidlc --stage code-generation --depth minimal     Jump with minimal depth
```

---

### `/aidlc --test-strategy <level>` — テスト戦略をオーバーライドする

テストの量の戦略を、深さとは独立にオーバーライドします。

**構文:**

```
/aidlc --test-strategy minimal
/aidlc --test-strategy standard
/aidlc --test-strategy comprehensive
```

**挙動:** 指定されないとき、スコープが自分のオーバーライドを宣言しない限り、現在の深さのレベルをデフォルトとします。独立に設定すると、Standard の深さ（フルの成果物）と Minimal のテスト（Nyquist モデル）のような組み合わせを許します。`aidlc-state.md` の `Test Strategy` フィールドを更新し `TEST_STRATEGY_CHANGED` 監査イベントを記録します。

**有効な値:** `minimal`、`standard`、`comprehensive`（大文字小文字を区別しません）。

**テスト戦略のモデル:**
- **Minimal (Nyquist):** 要件ごとに1テスト、happy-path のフロア、ユニットテストのみ（合計約5-15）
- **Standard:** コンポーネントごとに5-8テスト、ユニット + 統合
- **Comprehensive:** コンポーネントごとに10-15テスト、すべてのテストタイプ

各レベルの全詳細、デフォルトの挙動、よくある組み合わせは [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md#the-3-test-strategy-levels) を参照してください。

**例:**

```
/aidlc --test-strategy minimal                         Minimal testing for active workflow
/aidlc --depth standard --test-strategy minimal        Full artifacts, minimal tests
/aidlc --scope bugfix --test-strategy comprehensive    Bugfix with thorough testing
```

---

### `/aidlc --project-type <type>` — 新しいプロジェクトか既存のコードか

この作業が何かを、ワークスペースのスキャンに任せる代わりに言います。

**構文:**

```
/aidlc --project-type brownfield "add the hover tooltip"   Start on existing code
/aidlc --project-type greenfield "scaffold the new service"   Start as a new project
/aidlc --project-type brownfield                            Mid-workflow: this is existing code
```

どの時点でも平易な言葉でも言えます（「this is existing code, the frontend is in ui-repo」）。エージェントが同じコマンドを実行します。

**挙動:** 最初に、あなたが与えるタイプがスキャンの判定を置き換え、スキャンはなお言語、フレームワーク、ビルドシステムを埋めます。ワークフローの途中では `aidlc engine workspace reclassify --project-type <type>` を実行します。フォルダをもう一度スキャンし、`Project Type` を設定し、`Project Type Source: you` を記録し、`## Workspace State` をリフレッシュします。既存のコードについては、作業が始まって以降フォルダに追加されたリポジトリも記録し（何も記録されておらず Construction が始まっていないとき）、新しいプロジェクトのスキャンが外した、または空のフォルダ向けに構成されたプランが外した Reverse Engineering を戻します（`infra` のような Reverse Engineering を決して走らせないスコープは、それを外したままにします）。ワークフローがすでに Reverse Engineering を過ぎているとき、next を実行し、ワークフローはそれからあなたがいたステージに戻ります。完了したステージは完了のまま残り、返信は、コードが分かる前に完了したものを名づけるので、1つをやり直せます。新しいプロジェクトでは、完了していない Reverse Engineering はスキップされ、承認ゲートで待っているものも含みます。その質問はスキップとして閉じ、それが書いたドキュメントは残ります。Construction が始まると、プランはそのまま残り、返信は Reverse Engineering を単独で実行する方法を言います（あなたが今コードもスキャンするよう頼んだとき、エージェントがそれを実行します）。タイプが変わると、返信は undo の方法で終わります。`WORKSPACE_RECLASSIFIED` を記録します。

スキャンが作業を新しいプロジェクトとしてセットアップし、Construction の前にフォルダがコードを得たとき、`next` はそれが既存のコードかを一度あなたに尋ねます。どちらの回答もタイプをあなたのものとして記録するので、再び尋ねられません。あなたが与えるタイプはその作業にだけ成り立ちます。次の作業はフォルダをもう一度スキャンします。

**有効な値:** `greenfield`、`brownfield`（大文字小文字を区別しません）。

---

### `/aidlc --review <class>` — この実行のステージレビューを設定する

実行ごとのレビューオーバーライドを設定します。§12a のステージレビューが、アクティブなワークフローについてどれだけ重く走るかの上限で、スコープの `review_cap` を置き換えます。

**構文:**

```
/aidlc --review adversarial
/aidlc --review advisory
/aidlc --review none
```

**挙動:** レビュアーを持つ各ステージは、そのフロントマターでレビュークラスを宣言します。`adversarial`（レビュアーが成果物に反論し、リードが最大 `reviewer_max_iterations` パスにわたって所見を直す）または `advisory`（1回の通常フローのレビューパス。承認ゲートがエンジン所有の所見リストからその所見を、あなたが振り分けるために表示する）です。ステージごとの実効クラスは、ステージの宣言を1つの上限で下げたものです。これはオーバーライドが設定されているときはそれ、そうでなければスコープの `review_cap`（bugfix、poc、classic、workshop は `advisory` に制限、express は `none` に制限）です。したがって `--review advisory` は残りのすべての adversarial ループを1回の通常フローの意思決定支援パスにし、`--review none` はゲート付きのステージレビュアーのディスパッチをスキップし、`--review adversarial` は、制限されたスコープでも、各ステージ自身のクラスを走らせます。スコープ自身のレベルを設定する（たとえば bugfix で `--review advisory`、feature で `--review adversarial`）と、代わりにオーバーライドをクリアします。スコープの上限が再び適用され、後のスコープ変更に従います。どのオーバーライドも、クラスをステージの宣言より上げることも、ステージが宣言しないレビュアーを加えることもしません。オーバーライドなしでは、classic はゲート付きフローのレビュアーを持つステージごとに1回の advisory パスを走らせ、所見を承認ゲートで表示します。明示的な自律 construction は免除です。classic のもとでも、そのマージ前の単一レビュアーを保ちます。スコープの上限も儀式のスイッチも、そのレビューを無効にしません。`aidlc-state.md` の `Review Override` フィールドを更新し `REVIEW_CLASS_CHANGED` 監査イベントを記録します。ワークフローが作られるとき、または `--scope` とともに供給できます。現在と同じスコープは、review オーバーライドを捨てる代わりに config の変更として適用します。どちらのクラスでも、終端の受領を無効にする後の出力書き込みは、次の序数で1回の制限された回復リクエストを許します。

**有効な値:** `adversarial`、`advisory`、`none`（大文字小文字を区別しません）。

**例:**

```
/aidlc --review advisory              Single normal-flow pass, findings at the gate
/aidlc --review none                  No gated stage reviews this run
/aidlc --review adversarial           Each stage's own review class, above any scope cap
/aidlc --review advisory              On bugfix: back to bugfix's normal reviews
```

---

### ワークフローの構成 — 1つのアトミックなセッター

12個の intent 設定すべて（`guard.plan-approval` が `plan-approval` の別名なので、キーは13個）は、1つの CLI セッター `config-change` を共有します。異なる設定のフラグを1つのアトミックな CLI コマンドにまとめられます。付随する設定を連続するセッターに分けないでください。タイプされた引き下げコマンドでは、エージェントがこのセッターを、スイッチとその付随する intent 設定とともに1つのトランザクションで実行します。フックはメッセージを記録するだけです。これはアクティブな intent の構成で、`aidlc config flags` を通じたネイティブのプロジェクト構成とは別物です。

| config キー / スラッシュフラグ | 値 | 状態フィールド |
|-------------------------|--------|-------------|
| `depth` / `--depth` | `minimal`、`standard`、`comprehensive` | Depth |
| `test-strategy` / `--test-strategy` | `minimal`、`standard`、`comprehensive` | Test Strategy |
| `review` / `--review` | `adversarial`、`advisory`、`none` | Review Override |
| `guard-policy` / `--guard-policy` | `strict`、`relaxed`、`off` | Guard Policy |
| `sensors` / `--sensors` | `on`、`off` | Sensors |
| `learnings` / `--learnings` | `on`、`off` | Learnings |
| `summary-confirmation` / `--summary-confirmation` | `on`、`off` | Summary Confirmation |
| `plan-approval` / `--plan-approval` | `on`、`off` | Plan Approval |
| `collaborators` / `--collaborators` | `on`、`off` | Collaborators |
| `guard.plan-approval` / `--guard.plan-approval` | `on`、`off` | Plan Approval（`plan-approval` の別名） |
| `guard.review-freeze` / `--guard.review-freeze` | `on`、`off` | Guards Off / Guards On |
| `guard.state-transition` / `--guard.state-transition` | `on`、`off` | Guards Off / Guards On |
| `guard.reviewer-scope` / `--guard.reviewer-scope` | `on`、`off` | Guards Off / Guards On |

退役したキー `change-control` と退役したフラグ `--change-control` は、1リリースの間なお `guard-policy` に解決し、1行の非推奨の行を表示します。`config-change` と `scope-change` のユーティリティパスでは、両方の綴りを1つのコマンドで名づけることは、値が異なるとき拒否され、一致すると受け入れられます。`orchestrate next` では、両方の値が有効なとき2つのフラグの最後が勝ちます。`validate-grid` では、順序にかかわらず `--guard-policy` が `--change-control` に優先し、選ばれたフラグの最初の出現が使われます。どちらのフラグもスコープオブジェクトをオーバーライドし、そこでは文字列の `guardPolicy` が文字列の `changeControl` に優先します。

以下の各行は設定を組み合わせます。エージェントが実行するセッターは、引き下げを含め、リストされたすべての intent 設定を一緒に適用します。

```
/aidlc --depth minimal --review none --guard-policy relaxed --sensors off
/aidlc config set depth standard --test-strategy minimal --review advisory --guard-policy strict --sensors on --learnings on --summary-confirmation off
/aidlc --scope bugfix --guard-policy relaxed --sensors off --learnings on
```

ネイティブのディスパッチャー形式は `aidlc engine config set <key> <value>` に他の設定フラグを続けたものです。ターミナルでタイプすると、`aidlc config set <key> <value>`、`aidlc config get <key>`、`aidlc config list` が `engine` なしで同じ動詞に届きます。すべてのキーは同じユーティリティコマンドにルーティングされます。最初の設定が `--<key> <value>` になり、残りのフラグが転送されます。エージェントがあなたの言葉で頼んだことについて実行するとき、`--message <id>`、それを頼んだあなたのメッセージの id を加えます。エンジンは、メッセージがあなたのもので、このチャットを通じて来て、その後の決定で使い切られていない（その同じメッセージが与えた1つの承認や回答はそれを立たせたままにします）ことを確認します。設定はそのとき `set by you` と読め、オフにされた設定はあなたのメッセージ全体をその監査行に `Person Reply` として保ちます。確認できないメッセージは拒否され、拒否が理由を言います。`--message` なしでは、設定は、あなたが自分の行でそれをタイプした、または自分のターミナルでコマンドを実行したときにだけ `set by you` と読め、そうでなければ `set by a command` です（どちらにせよ適用されます）。引き下げ（チェックのオフ、plan approval やサマリー確認のオフ、Guard Policy の `relaxed` や `off`）は、代わりに拒否されます。`--person-words '<words>'` と `--person-words-file <file>` はなお取られますが何も証明しません。エンジンはそれらの言葉をエージェント自身のテキスト（`Conductor Summary`）として保ち、設定は `set by a command` と読めます。

```bash
aidlc engine config set guard-policy relaxed --sensors off --intent login-fix --space platform
bun .claude/tools/aidlc-utility.ts config-change --depth minimal --review none --guard-policy relaxed --sensors off --intent login-fix --space platform --project-dir /work/shop
```

`config-change` は、13個の設定フラグ（と退役した `--change-control` の綴り）、`--message`、`--person-words` または `--person-words-file`（なお取られますが何も証明せず、エージェント自身のテキストとして保たれます）、そして `--intent`、`--space`、`--project-dir` のセレクタだけを受け取ります。少なくとも1つの設定が必要です。セレクタは状態ファイル、メモリポリシー、監査シャードを同じターゲットに固定します。省かれた intent/space のセレクタはアクティブなワークフローの選択を使います。アクティブな intent や space を切り替えません。スコープも変えるときは `config-change --scope` ではなく `scope-change`（`/aidlc --scope` のルート）を使います。

タイプされた引き下げスイッチでは、`/aidlc config set guard-policy relaxed --intent <name> --space <name>` と `/aidlc --guard-policy relaxed --intent <name> --space <name> ...` の両方が、エージェントのセッターがそれを適用する作業を名づけます。フラグ形式の末尾の `...` は、任意のタスク説明を表します。省かれたセレクタはセッションのワークフロー選択を使います。存在しない名前付き intent は拒否され、作業が選ばれていないと、セッターはチャットが次に拾うか始める作業のために設定を保ちます。既存の作業を選ぶ（ピックの質問、`/aidlc intent <name>`、または1つの作業に着くスペース切り替え）とそこに適用され、作業を名づける行の後に一度そう言います。セッターは、変更の前に、認識されるすべての付随する intent 設定を検証します。不正なコマンド、未知のフラグ、欠けた値、無効な付随値は何も変えません。CLI のルートはその通常の検証エラーを報告します。

CLI は、状態を変える前にすべてのフラグと値を検証します。無効な値と未知のフラグはその更新全体を拒否します。未知のフラグはエラーで名づけられます。明示的な `--guard-policy relaxed` や `--guard-policy off` がメモリレイヤーの `Mode: strict` で拒否されると、付随する設定もスコープ変更も適用されません。エラーが編集すべきメモリファイルを名づけます。明示的な strict と無関係な設定は許可されたままです。1つのロックが、ターゲットの状態の読み取り、すべての設定の適用、監査バッチの追記、1回の状態書き込みをカバーします。監査の失敗は状態を変えずに残します。変更と出力は表のキー順に従います。`Last Updated` は、保存された状態が変わるときだけ変わります。すでに保存された選択の繰り返しは no-op ですが、スコープ由来の値を明示的なオーバーライドに変えると、値が同じでもその来歴を記録します。

`config get` は表のすべてのキーを受け取り、`config list` は13個すべてをその順で返します。Guard Policy、フェンス、儀式の読み取りは、status と同じく、実効値とソースを含みます。

```
/aidlc config get guard-policy
/aidlc config get plan-approval
/aidlc config get summary-confirmation
/aidlc config list
/aidlc config list --json
```

追加の読み取り専用の `guard.human-presence` ルックアップは `on (default)` または `off (env AIDLC_SKIP_HUMAN_PRESENCE_GUARD)` を報告します。作業ごとの設定ではなく、`config list` には含まれません。

ネイティブの読み取りの等価は `aidlc engine config get <key>` と `aidlc engine config list` です。`aidlc engine config --help` がすべての config の動詞を一覧します。以下のセクションは、この同じセッターが管理する Guard Policy、フェンス、儀式のポリシーを説明します。

#### `/aidlc --guard-policy <value>` — この作業の Guard Policy

intent の Guard Policy の値を設定します。フレームワークのガードが、目の前の作業についてどこまで身を引くかです。2つのことを決めます。人がすでに承認または確認したものが足元で変わっていたと分かったとき（コードプランが承認された後にソースファイルが動いた、レビューの後にレビュー済みのドキュメントが編集された、現在のサマリー確認なしに出力が保存された）に何が起きるか、そして、走行中のワークフローのどのステップも求めないアクションに対して、5つのフェンスのどれが持ちこたえるか、です。

**構文:**

```
/aidlc --guard-policy strict
/aidlc --guard-policy relaxed
/aidlc --guard-policy off
```

**挙動:** 変わった入力について、`strict` は承認を再び開きます。実行は、何が変わったかを名づける平易な文で止まり、承認を再び求めます。`relaxed` と `off` は、変更を `CHANGE_ACCEPTED` 監査行として一度記録し、1行であなたに伝え、続けます。あなたがコードプランを承認した後に動いたコードは例外です。ビルドはその行と行とともに続き、`strict` のもとで再び尋ねるのはプランやそのテスト指示への編集だけです。`strict` のもとでのユニットの並列ビルドは、あなたの変更（編集、コミット、`git pull`）についても再び尋ねる唯一のケースで、あなたがそれを取り消すか `relaxed` に設定するまで、次のユニットが着地するのを止めます（[Guard Policy](13-customization.md#guard-policy) を参照）。フェンスについては、`strict` は5つすべてを上げたままにし、`relaxed` は `plan-approval`（プランの再承認。編集されたプランについて再び尋ねない）と `review-freeze` を下げ、`off` はその2つに加えて `state-transition` と `reviewer-scope` を下げます。`human-presence` はポリシーの言葉で決して下げられません。

チャットから `guard-policy relaxed` や `guard-policy off` を設定するのは人の手です。彼らが `/aidlc --guard-policy relaxed`（その値には `off` を使う）をタイプすると、コンダクターの最初の `next` がセッターを名づけ、コンダクターが同じターンでそれを実行します。状態の行と監査行を書き、チャットで頼まれたとおり何が変わったかを言います。フックはメッセージを記録するだけです。彼らが平易な言葉で頼むと、コンダクターは彼らが頼んだ値で `config-change --guard-policy <strict|relaxed|off>` を実行し、前回の決定以降彼らからの返答が記録されているときに下げ、その出力をそのまま表示し、止まります。この Kiro IDE のビルドがプロンプトテキストを渡さないとハーネスが言っているなら、アクティブな作業はそのビルドで下げられない（そのアダプターも引き下げのセッターを拒否する）と言います。Kiro IDE を更新するか、より低いデフォルトのスコープから新しい作業を始めます。config 形式でもフラグ先行形式でも、`--intent <name>` と `--space <name>` が作業を選びます。省かれたセレクタはフックペイロードのセッションのワークフロー選択を使います。存在しない名前付き intent は拒否されます。作業が存在する前にタイプした Guard Policy `relaxed` や `off` のスイッチは、このチャットが次に始める作業のために保たれます。`Guard Policy relaxed for the piece of work you start now (set by you).` 拾う作業がそこにあるときは、チャットが拾うか始める作業に行きます（`... for the work you pick up or start next (set by you).`）。後の `strict` は、その前にオフにタイプしたチェックを取り戻します。リクエストとともにタイプすると、そのリクエストに付きます（`Guard Policy relaxed for the work you are asking for (set by you).`）。新しい作業は作成時にそれを取り、開いた作業を続けるとそこに適用されます。メッセージだけが開いた作業を変えることは決してありません。`off` 形式は `relaxed` の代わりに `off` を名づけます。フェンスのスイッチ（`guard.<fence> off`）も同じように機能します。作業が存在する前は `The review freeze check is off for the piece of work you start now (set by you).`、リクエストとともにタイプすると `The review freeze check is off for the work you are asking for (set by you).` です。1つの例外は、コードプランの質問が開いていて人がプランファイルを編集していないときです。そのとき、言葉とともにタイプされた設定はこの作業向けで、その言葉はその質問への返答です（`/aidlc --guard-policy off approve the plan`）。クォートされていない `--` の後の語は、なお新しい作業を説明します。フックは Windows でも走るので、タイプされたスイッチは、セッターサイドのセッションルックアップなしに、プロンプトを転送するすべてのハーネスで機能します。無関係な返答は何も開かず、`AIDLC_UNATTENDED=1` はプロンプト時の適用を抑制し CLI の引き下げを拒否します。スコープのデフォルトは尋ねずに適用されます。すでにオフのフェンス、またはすでに `set by you` とマークされた同一のポリシーの言葉には、CLI の更新が no-op なので鍵は不要です。メモリ strict と unattended のチェックの後、CLI のセッターが人のプロンプトなしに下げるのは2つのケースだけです。あなたが自分のターミナルでそれをタイプした（ターミナルの両端、コマンドにチャットのアイデンティティなし、エージェント用にターミナルを開くホストのマークなし）、これはあなた自身の行為です。または `fenceKeyBypassed` がフィクスチャやハーネス起動の presence バイパスを認識する、インラインの環境代入ではありません。session-start フックは、`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` で起動された attended なハーネスについて、その `presence-bypass-<session>` スタンプを Plan Approval ランタイムディレクトリに保ちます。モデルのツールは、[state-transition guard](../reference/06-hooks-and-tools.md#pretooluse-aidlc-state-transition-guardts) で強制されるとおり、フックを呼び出すことも `aidlc/.aidlc-sessions/` やどの `.aidlc-plan-approval/` や `<record>/.aidlc-engine/gate-words/` ディレクトリに書くこともできません。メモリ保持の strict はまず拒否し、ポリシーの言葉と、先に下げられたどのフェンスもオーバーライドします。`/aidlc --status` はそれを、マシン全体のキルスイッチが優先しない限り、`on (guard policy strict (from <layer>.md))` と表示します。

タイプされた `config set` の引き下げスイッチは、`config set <key> <value>` に任意で他の設定フラグ（`--depth minimal --sensors off`）と `--intent <name>`、`--space <name>` のペアを続けたものを受け取ります。未知のフラグや無効な値はコマンド全体を拒否し、それを名づけます。[Customization](13-customization.md#the-five-fences) を参照してください。Codex は `$aidlc` を使い、その拒否は `/aidlc` の代わりに `$aidlc` を名づけます。

ポリシーを `relaxed` に変えようとするセッターが、人が頼んだメッセージ（`--message <id>`）なしに実行されると、次で拒否します。

> Setting Guard Policy relaxed lowers fences, which is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

直接の `scope change --guard-policy relaxed|off` は同じルールを使います。チャットからの直接の `intent create --guard-policy relaxed|off` は、人がこのチャットでそれを頼んだとき、進行中の作業にセッターがあるのと同じように実行されます。彼らのメッセージがその背後の権限で、新しい作業は、フラグが彼ら自身のタイプした行にあるとき（または彼らのターミナルがそれを実行したとき）`Guard Policy: <value> (set by you)` を記録し、エージェントが加えたときは `(set by a command)` を記録します。どの作業も存在する前はそのメッセージはフックが来たとおりに保ったもので、作業が存在すると前回の決定以降の彼らのターンです。人が自分のターミナルで実行するコマンドは自身を運びます。人が作業の存在する前に、または新しい作業と同じメッセージでタイプした Guard Policy `relaxed` や `off` は、このチャットが次に始める作業のために保たれそのリクエストに答えます。そのための `intent create --request <id>` は、フラグの有無にかかわらず `Guard Policy: <value> (set by you)` を記録し、どの開いた作業も自分のポリシーを保ちます。作成時にスコープ自身のデフォルトを名づけると、別のプロンプトなしにスコープの値を記録します。より低いデフォルトのスコープに移る走行中のワークフローは、人がスコープ変更を頼んだときにそれを取ります。そうでなければより厳しいポリシーを保ち、1行でそう言います。このチャットに彼らのメッセージの記録がないと、作成は次で拒否します。

> Setting Guard Policy relaxed lowers fences, which is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

`off` の拒否は `relaxed` の代わりに `off` を使います。unattended な実行はドライバーのガイダンスも受け取ります。人がガード回復の `lower-fence` の選択肢を選ぶと、エージェントが彼らのために `config set guard.<fence> off` を実行し、1行で何が変わったかを言います。彼らがそれをタイプする必要は決してありません。

compose の作成はプランが走るスコープから Guard Policy を読み、スコープファイルは書かれません。一致したプランはそのストックのスコープのデフォルト、またはあなたが頼んだより厳しい値を保ち、カスタムプランは、デフォルトが承認された値またはそれより低いストックのスコープで走ります。コンダクターは、低いスコープのデフォルトを上げる `strict` または `relaxed` について `--guard-policy` を渡し、`off` については決して渡しません。compose ゲートで一致したプランをそのストックのデフォルトより下にフリップすると、コンポーザーはそれを編集として扱います。提案はその値を運ぶストックのスコープ上のカスタムプランになり、intent がそれから作られます。デフォルトより上へのフリップはプランを一致したままにします。あとであなたがタイプするものは何も残りません。コンポーザーは進行中の intent の値を決して変えません。

どの値もゲートを取り除きません。コンダクターはなおすべての承認の質問を尋ねなければなりません。下がったフェンスはその文章の義務を強制しません。レビュアーの判定は決して変わらず、どの証拠も削除されず、エージェントが人の代わりに答えることは決してできません。下がったフェンスを通る各パスは1つの `GUARD_STOOD_ASIDE` 行を書きます。その1行の通知の配信はハーネスによります。[Customization](13-customization.md#what-you-see-when-a-guard-decides) に記述があります。

共有の `config-change --guard-policy <value>` セッター（エージェントがタイプされたスイッチや平易な言葉のリクエストについて実行し、human-turn フックはメッセージを記録するだけ）は、`aidlc-state.md` の `Guard Policy` の行を `<value> (set by you)`（人が頼んだことを示す記録がないときは `(set by a command)`）として書き直し、監査バッチに `GUARD_POLICY_SET` 行を加えます。ポリシー行の書き込みはすべて退役した `Change Control` 行を取り除き、`Guard Policy` だけを保ちます。両方の行が異なるポリシーの言葉で存在すると、メモリが strict を保たない限り、status は次の `next` がそのうちの1つを保つまで `strict (from conflicting state lines)` を表示します（[where the value lives](13-customization.md#where-the-value-lives) を参照）。両方が一致するなら、`Guard Policy` の行が使われ、次のポリシー書き込みが退役したものを取り除きます。退役した relaxed や off の行だけを運ぶ記録は、あなたの次のメッセージでリネームされます。値は保たれ `Guard Policy` として書かれ、ポリシーの監査行はありません。それが起きていないところでは、すべての `/aidlc` 実行が通知を運びます。`/aidlc config set guard-policy relaxed` は値を保ち、`/aidlc config set guard-policy strict` はフェンスを上げ、どちらもそれを止めます。この通知の表示は行を書き直さず、退役した strict の行だけは通知を得ません。値は intent とともにコミットされ、セッションを生き残り、チームメイトに見えます。同じセッターが無効な行を修復し、古いテキストを記録します。ポリシーの平易なチャットのリクエスト（「stop asking me to re-approve when files change」など）はコンダクターが実行します。あなたが頼んだ値でセッターを実行し、前回の決定以降あなたからの返答が記録されているときに下げます。タイプされたスイッチ（`/aidlc --guard-policy relaxed` など）は同じセッターで、コンダクターがその最初の `next` から実行します。構成とスコープの変更について、行の `Old Value` は、メモリ実効の値ではなく、以前に保存された intent の値です（無効なら生のテキスト、行がなければ `strict`）。統治されたチェックポイントの観測はなお実効の old/new の値を記録します。行のない古い intent は、設定されるまで strict のままです。新しい intent はそのスコープのデフォルトから始まり、メモリレイヤーの `Mode: relaxed` や `Mode: off` が設定されているときはそこから始まります。メモリレイヤーの `## Guard Policy` セクションが `Mode: strict` と言うとき、明示的な `relaxed` や `off` は、供給された他の設定を含めコマンド全体を拒否し、そのファイルを名づけます。そこのメモリ行を編集して全員のためにそれを緩めます。明示的な strict の設定はなお許可されます。作成時にフラグをスコープとともに与えられます（`/aidlc --scope poc --guard-policy strict "..."`）。

退役したフラグ `--change-control` と退役した config キー `change-control` は、1リリースの間なお解決し、次のマイナーバージョンでの取り除きを名づける1行の非推奨の行を表示します。`config-change` と `scope-change` のパスでは、両方の綴りを1つのコマンドで渡すことは、値が異なるとき拒否され、一致すると受け入れられます。`orchestrate next` では2つの最後が勝ちます。

**有効な値:** `strict`、`relaxed`、`off`。

**例:**

```
/aidlc --guard-policy relaxed        Record and announce input changes, keep going
/aidlc --guard-policy strict         Approve again whenever an approved input changes
/aidlc --guard-policy off            Lower the four lowerable fences too (each pass-through logged)
```

#### `/aidlc config set guard.<fence> <on|off>` — 1つのフェンス、1つの作業

目の前の作業について、ポリシーの言葉に触れずに単一のフェンスをオフにし、その言葉がそれを下げているときでもオンに戻します。3つの作業ごとのスイッチは `review-freeze`、`state-transition`、`reviewer-scope` です。`guard.plan-approval` は `plan-approval` 設定の別名（[Plan approval](#aidlc-plan-approval-plan-approval) を参照）なので、`Guards Off` エントリを書きません。Human presence は鍵の保持者で、作業ごとのスイッチを持ちません。

**構文:**

```
/aidlc config set guard.review-freeze off
/aidlc config set guard.review-freeze on
```

**挙動:** フェンスをオフにすると `aidlc-state.md` に `- **Guards Off**: <comma list> (set by you)` と、`Guard`、`Scope`、`Source` を運ぶ1つの `GUARD_DISABLED` 監査行を書きます。オンに戻すと、そのリストから取り除き `GUARD_RESTORED` を書きます。`on` に設定すると、ポリシーで下げられたフェンスを上げ、`- **Guards On**: <comma list> (set by you)` にそれを記録し、同じフィールドで `GUARD_RESTORED` を書きます。Guard Policy の言葉を自分で設定すると、それに反する行をクリアし（同じコマンドが名づけるフェンスを除く）、変わる各フェンスについて同じ行を書きます。`off` は `Guards On` をクリアし、`strict` は `Guards Off` をクリアし、`relaxed` はどちらもクリアしません。その後の単一フェンスのスイッチはなお適用されます。すでに効力を持つ設定の繰り返しは、そう言う no-op です。ポリシーで下げられたフェンスに `on` を設定するのは no-op ではありません。どちらの状態行も human presence を受け入れず、保存された human-presence エントリは無視されます。`/aidlc --status` は、あなたや環境のスイッチがオフにした各フェンスと理由を名づける `Checks off:` 行を表示します。より低い Guard Policy がオフにするものは、ポリシーがどこから来たかを言うその `Guard Policy:` 行に付きます。優先順位は、環境のキルスイッチ、次にメモリが strict を保たない限り作業ごとの off、次に作業ごとの on、次に Guard Policy の言葉、次にデフォルトの on です。5つのうち4つにキルスイッチがあります。`state-transition` にはないので、ポリシーの言葉とこのスイッチがその唯一のコントロールです。

チャットから `guard.<fence> off` を設定するには、人が `/aidlc config set guard.<fence> off` または `/aidlc --guard.<fence> off` をタイプし、エージェントが同じターンでそのセッターを実行します。監査行を記録し何が変わったかを言います。自分の言葉で頼む、またはガードの `lower-fence` の選択肢を選ぶことでも機能します。エージェントがそのフェンスについてセッターを実行し、1行で何が変わったかを言います。両方の形式は `--intent <name>` と `--space <name>` を受け取ります。省かれたセレクタはフックペイロードのセッションのワークフロー選択を使います。存在しない名前付き intent は拒否されます。まだ状態ファイルがないとき、スイッチはこのチャットが次に始める作業のために保たれます。リクエストとともにタイプすると（`/aidlc --guard.<fence> off <description>`）、そのリクエストに付き、開いた作業を決して変えません。CLI のセッターは、前回の決定以降に人のターンが記録されているとき（空のレジャーはカウントされません）フェンスを下げます。すでにオフのフェンスは no-op で鍵は不要です。フックは Windows でも走るので、プロンプトを転送するすべてのハーネスが、セッターサイドのセッションルックアップなしに、タイプされたスイッチをサポートします。`AIDLC_UNATTENDED=1` はプロンプト時の適用を抑制し CLI の引き下げを拒否します。メモリ strict と unattended のチェックの後、`fenceKeyBypassed` だけが、フィクスチャやハーネス起動の presence バイパスを通じて、人のプロンプトなしの CLI 引き下げを許します。インラインの環境代入はそれを確立しません。メモリ保持の strict はまず拒否し、先に下げられたフェンスをオーバーライドします。`/aidlc --status` はそれを、マシン全体のキルスイッチが優先しない限り、`on (guard policy strict (from <layer>.md))` と表示します。その保存された `Guards Off` エントリは残り、メモリ行がもはや strict を保たなくなった後にだけ再び効きます。

review-freeze フェンスをオフにしようとするセッターが、あなたのために、あなたが頼んだメッセージを名づけずにエージェントが実行すると、次で拒否します。

> Turning the review-freeze check off is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

他のフェンスの拒否はそのフェンスの名前に置き換えます。unattended な実行はドライバーのガイダンスも受け取ります。あなた自身のターミナルでタイプした同じコマンドは、その理由で決して拒否されません。あなた自身の行為なので実行され、1行で言われ（「The review freeze check (it stops edits to work you already approved) is off for this piece of work, set by you. You can turn it back on any time.」）、set by you として記録されます。あなたのエディターが自分のエージェント用に開くターミナル（VS Code の Copilot、Kiro IDE、Cursor）はあなたのターミナルではありません。そこでは拒否は「To turn the review-freeze check off, ask for it in your Kiro chat.」と読め、あなたのツールを名づけます。このコマンドは、ポリシーの言葉が上げたままにするものを含め、3つの切り替え可能なフェンスを制御します。切り替え可能なフェンスのメインセッションの拒否はコマンドを名づけ、human-presence の拒否はスイッチを名づけません。この作業についてプロンプトフックが走っている間（そのハートビートが新しい）、それは人がまだ答えていないと言い、エージェントはターンを終え、人が聞くものはありません。そうでなければ、人がすでに送った返答に何が起きたかを言います。人が行動した後にだけフックを走らせるハーネスでは、それらをオンにするステップ、そうでなければ人向けの1行。「Your answer didn't reach AI-DLC. Please give it once more. If it happens again, type /aidlc --doctor.」Kiro CLI では、`/agent` で選ばれた別のエージェントにタイプされた返答は決して記録されないので、その行は「Your answer didn't reach AI-DLC. Type /agent and pick aidlc, then give it once more.」です。Kiro が agent "aidlc" が 3.0 エンジンのためにアップグレードが要ると言うとき、行は「Your answer didn't reach AI-DLC. Quit Kiro and start it again in this folder with: kiro-cli --v2 --agent aidlc (Kiro CLI 2.21.4 or later; for an older one, see the AI-DLC Kiro CLI guide), then give it once more.」です。エージェントは、彼らのためにチェックをオフにすると申し出ないよう告げられます。

人の返答の後にエージェントが記録した質問への `log answer` は、別の回答がすでにそれを記録していない限りその返答に記録されます。人は再び尋ねられません。

`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` だけが human presence を下げます。マシン全体に設定するか `aidlc config flags --bypass` で記録します（AI-DLC がそのときオフだと言います）。`AIDLC_UNATTENDED=1` は別に human-turn の発行を差し控えます。フェンスを下げるわけではありません。`guard.human-presence` を設定しようとするあらゆる試みは、非ゼロの終了コードと次のメッセージで更新全体を拒否します。`Human presence cannot be switched off: it is how AIDLC knows an approval or an answer came from a real person, so reply in the chat yourself. For a supervised session where nobody can reply, launch the CLI with AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 set.`

**有効な値:** `on`、`off`。

#### `/aidlc --sensors`、`--learnings`、`--summary-confirmation` — 儀式のコントロール

これら3つの独立したポリシーを、アクティブな intent について `on` または `off` に設定します。

```
/aidlc --sensors off
/aidlc --learnings on
/aidlc --summary-confirmation off
```

| フラグ / config キー | 状態・ステータスの行 | `off` が何をスキップするか |
|-------------------|----------------------|------------------|
| `--sensors` / `sensors` | Sensors | 自動の Sensor ディスパッチとブロッキング sensor のチェック。明示的な `sensor fire` は診断用に使えたまま |
| `--learnings` / `learnings` | Learnings | 学習の日誌と learning-gate の儀式 |
| `--summary-confirmation` / `summary-confirmation` | Summary Confirmation | ステージフロントマターが宣言する統合サマリーの `Looks correct` チェックポイントだけ。intent-capture の Assumption Confirmation は別の人の決定のまま、必須の質問とステージの承認も同様 |

**デフォルトと優先順位:** `1` に設定されたキルスイッチはそのポリシーを `off` に強制し、そうでなければ明示的な intent ごとの設定が勝ち、次に現在のスコープのデフォルト、次にスコープに設定がなければ `on` です。つまり **環境 → intent ごと → スコープ → on** です。出荷されるすべてのスコープは3つすべてを明示的に宣言します。classic は sensors と learnings を `on`、summary confirmation を `off` に設定し、bugfix は sensors を `on`、learnings と summary confirmation を `off` に設定し、express は3つすべてを `off` に設定し、他の8つは3つすべてを `on` に設定します。キーを省くスコープファイルはなお `on` にフォールバックします。新しい intent は、たとえば Sensors について `on (from scope classic)` としてスコープのデフォルトを保存します。スコープを変えると、明示的な値（`set by you` または `set by a command`）を保ちながら、スコープ由来の値を新しいデフォルトに運びます。これらのフィールドのない古い intent は、そのスコープ、次に `on` から解決します。スコープの選択とともに明示的な儀式のフラグは、スコープ由来のデフォルトではなく明示的なオーバーライドを書きます。これらのフラグは、互いに、そして depth、テスト戦略、review、Guard Policy、フェンスのスイッチと、1つの構成トランザクションで、スコープ変更の有無にかかわらず組み合わせられます。隔離された `--single` の実行は、その合成的なステージ開始イベントに記録された、選ばれたスコープのポリシーを完了まで使います。メインの intent の儀式オーバーライドを継承しません。開いた隔離された試行は別のスコープで再開できません。試行を完了するか、その記録されたスコープで再開します。記録されたスコープのないレガシーの隔離開始は summary confirmation を保ち、このスコープ比較を強制しません。

明示的な儀式の設定は、対応する状態行に `<value> (set by a command)` を書くか、セッターが人のタイプしたスイッチを適用する、または彼らがチャットで頼んだことを実行し、エージェントが彼らが頼んだメッセージを名づける（`config set <key> <value> --message <id>`、たとえば「lead agent only from here」の後）とき、エンジンがそれをこのチャットの彼らのものと証明する `<value> (set by you)` を書き、共有の監査バッチに `Key`、`Old`、`New`、`Source`、`Person Reply`（彼らのメッセージ全体）と、オフを頼んだときの `Message Id` を持つ `CEREMONY_SET` 行を加えます。`Old` は以前に保存された値（無効なら生のテキスト、行がなければスコープのデフォルト）で、環境のキルスイッチにオフに強制された値ではありません。監査キーは `sensors`、`learnings`、`summary_confirmation` です。コマンドは `Source: command` を記録し、人のタイプしたスイッチは `Source: you` を記録します。人自身の選択を繰り返すコマンドは no-op で `set by you` を保ちます。`intent-create --learnings off` のような作成フラグも `set by a command` を記録しますが、人がその設定をリクエストとともにチャットでタイプした（`/aidlc --learnings off <request>`、またはどの作業も存在する前）ときは `set by you` を記録します。保存されたオーバーライドは intent とともにコミットされセッションを生き残ります。環境のキルスイッチは、その保存された選択を上書きせずに優先します。儀式をオフにしても、フックをアンインストールまたは取り除く、必須のステージゲートを取り除く、明示的に自律 construction を選んだときに使われる単一のマージ前レビュアーを無効にする、ことはありません。

summary confirmation をオフにすると、人の `Looks correct` チェックポイントが取り除かれるので、フェンスのルールに従います。人が `/aidlc config set summary-confirmation off` または `/aidlc --summary-confirmation off` をタイプし、エージェントがそのセッターを実行します。説明の横では（`/aidlc --summary-confirmation off build the export`）フラグは新しい作業のもので、その作成に相乗りするので、進行中の作業はそのチェックポイントを保ちます。人が自分の言葉で頼むと、エージェントがセッター（`config set`、`config-change`、`scope-change`）を実行します。人が頼んだメッセージを名づけずに実行されると、次で拒否します。

> Turning summary confirmation off skips the person's `Looks correct` check before a stage writes its output, so it is their call. Run it with --message <id>, the message they asked in, when they ask for it.

明示的な選択としてすでに保存されたオフは no-op です。スコープ所有のオフ（たとえば `off (from scope classic)`）はなお人を要します。明示的として保存すると、後のスコープ変更より長生きしてしまうためです。`on` にする、スコープ自身のデフォルト、作成フラグは、タイプされたターンを要しません。それをオフにするコンポーザーの提案は、彼らがそれを運ぶプランを承認すると人のものになります。コンダクターがそのときセッター自身を実行します。フェンスと同じく、`AIDLC_UNATTENDED=1` は変更を拒否し、フィクスチャやハーネス起動の presence バイパスだけが人なしでそれを許します。

構成コマンドは、depth、テスト戦略、review、Guard Policy、フェンスのスイッチとともに、これら同じ3つのキーを公開します。たとえば、次は3つの儀式すべてと Guard Policy を一緒に設定します。

```
/aidlc config set guard-policy relaxed --sensors off --learnings on --summary-confirmation off
```

**環境のキルスイッチ:**

| 変数 | その値が正確に `1` のとき `off` に強制されるポリシー |
|----------|---------------------------------------------------|
| `AIDLC_DISABLE_SENSORS` | Sensors |
| `AIDLC_DISABLE_LEARNINGS` | Learnings |
| `AIDLC_DISABLE_SUMMARY_CONFIRMATION` | Summary Confirmation |
| `AIDLC_DISABLE_PLAN_APPROVAL_GUARD` | Plan Approval（メモリの Guard Policy strict ロックにも勝つ） |

他のどの値もポリシーをオフに強制しません。これらのスイッチは、ネイティブの config バイパスインターフェースを通じて明示的に記録することもできます。

```bash
aidlc config flags --bypass AIDLC_DISABLE_SENSORS --local --yes
aidlc config flags --bypass AIDLC_DISABLE_LEARNINGS --local --yes
aidlc config flags --bypass AIDLC_DISABLE_SUMMARY_CONFIRMATION --local --yes
aidlc config flags --show
```

記録されたスイッチをプロジェクトと共有するには `--local` の代わりに `--project` を使います。実際の環境変数は記録された config フラグに優先します。スイッチの変数が `1` 以外に設定されているところ（チェックが走るエディターや CLI）では、あなたが記録するスイッチはそこでそのチェックをオフにせず、`config flags --bypass` を実行するところに設定されているときは、コマンドが、sensors、learnings、使用トラッキングを除く各チェックについて、チェックがオフだと言う代わりにそう言います。スイッチの記録またはクリアは、その設定ファイル（と、どう設定されたかの AI-DLC の gitignore されたメモ `aidlc/.aidlc-sessions/recorded-switches.json`）だけを変え、ハーネスファイルをリフレッシュしないので、ワークフローが走っている間も機能します。次のチェックがそれを読み、再起動はありません。AI-DLC の管理された `.gitignore` ブロックはすでに `aidlc.settings.local.json` をリストします。それ以前のインストールでは、最初の `--local` の記録が、`.gitignore` を編集する代わりにクローン自身の `.git/info/exclude` を通じてファイルを git から外します。どちらの設定ファイルもあなたのコードとはカウントされないので、Code Generation の途中で記録してもステージの完了を止めません。コマンドは何も尋ねず（`--yes` は任意）、いくつものハーネスのあるプロジェクトで `--harness` を要さず、記録またはクリアしたものを、それを undo するコマンドとともに表示します。`--local`、`--project`、`--global` なしでは、`--bypass` はあなた自身の `aidlc.settings.local.json` に行き、あなた自身のターミナルでタイプした `--clear-bypass` は、それを記録するすべてのファイルからスイッチをクリアします。チャットからエージェントが実行すると、同じクリアが、セッターがするように（下記）チェックを戻します。あなた自身のエントリがクリアされ、プロジェクトの共有の `aidlc.settings.json` とこのマシンのファイルは名づけられ、決して変えられません。スイッチは、どのファイルかがそれを記録する間オンです。unattended な実行（`AIDLC_UNATTENDED=1`）は、頼む人がいないので `--bypass` を記録しません。`--clear-bypass` は常に行われます。チャットでエージェントが実行すると、あなたからチェックを奪う9つのチェック（下記）のうちの1つの `--bypass` は、あなたが頼んだときにだけ、チェックをオフにするすべてのセッターが従うルールで記録されます。エージェントが `--message <id>` であなたが頼んだメッセージを名づけ、エンジンがそれを、どの作業も存在する前も含めて証明します。そうでなければ何も記録せず、あなたの手だと言います。たとえば「Turning the human presence check off is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.」です。別のフラグも変えるコマンドは設定の変更でもあり、各部分に1行とともに同じように行われます。他のリリースファイルを持ち込むコマンド（`--download`、または別のリリースにピン留めされたプロジェクトが先に必要とする更新）も同様です。

スイッチは、どう設定されたか（このコマンド、ターミナル、ファイルへの編集）にかかわらず、記録された瞬間からカウントされます。あなたからチェックを奪う9つ（plan approval、review freeze、reviewer read scope、human presence、summary confirmation とそのチェック、ステージ出力のチェック、リビジョンバックストップ、パイプラインハンドオフのチェック）は常に言われます。エージェントが中継する次のステップは、チェックを名づける1行、何のためか、いつから、どう設定されたか、戻す申し出を運びます。たとえば、

> The review freeze check (it stops edits to work you already approved) is off for this project since 10:42, because you said: "turn the review freeze check off for this project". Do you want it back on?

あなたがチェックを自分でオフにした直後、その行は、あなたが今決めたことについて尋ねる代わりに戻る道を述べます。「You can turn it back on any time.」より広い場所が何かを変えるとき、それはその場所を一度提供します。この作業の後「Do you want it off for the whole project instead?」、このプロジェクトの後「Do you want it off for this whole machine instead?」です。そこですでにオフのチェックを頼むと、同じ申し出とともにそう言います。このマシン、プロジェクトのスイッチのないチェック、Guard Policy は、より広く行く先がないので、何も尋ねられず、あなた自身のターミナルで実行するコマンドにも何も尋ねられません。この作業についてのスイッチの後も、あなたがその summary confirmation とその learnings ステップを自分でオフに保つ間は何も尋ねられません。これがエージェントが「do not ask me anything」を記録する方法です。どちらかをオンに戻すと申し出が戻ります。

エンジンがそれをチャットのあなたのメッセージに結びつけられないとき、行はチェックがオフであることといつからかだけを言います。すべての新しいチャットは、チェックがオフのままの間、同じ行で開きます（opencode を除く。session-start のコンテキストを表示しません）。`config flags --show` と doctor の Flags 行（警告、doctor の終了コードを変えません）がそれをリストします。その申し出に自分の言葉で答えると、エージェントがコマンドを実行します。環境変数がなおチェックをオフに保つなら、コマンドがそう言います。チャットでの yes は、プロジェクトの共有の `aidlc.settings.json` やこのマシンの設定ファイルを決して変えないので、どちらかがスイッチを記録する間は、行が尋ねる代わりにそれを名づけて終わります。たとえば「The project's shared settings in aidlc.settings.json keep it off for everyone on this project. Changing that file changes it.」です。`--show` と doctor の行は、それが走る場所でそれをするコマンドを名づけます。あなた自身のターミナルではファイルを名づけないクリア、他のどこでも（IDE のターミナルを含む）スイッチを記録する各ファイルについて1つのクリアを、その `--local`、`--project`、`--global` とともに名づけます。スイッチはクリアされたが開いた作業がチェックを自分でオフに保つ（そのスコープやその Guard Policy）とき、行はそう言い、その作業についてもオンにするよう申し出ます。たとえば、

> The review freeze check (it stops edits to work you already approved) switch is cleared for this project, but it stays off for this piece of work: guard policy off (set by you). Do you want it on for this piece of work too?

逆に、スイッチがなおそれをオフに保つ間にこの作業についてチェックをオンに戻すと、それについてのあなた自身の `aidlc.settings.local.json` のエントリがクリアされ、行が設定自身の行の代わりにそう言います。たとえば、

> The review freeze check (it stops edits to work you already approved) is back on: aidlc.settings.local.json had kept it off for this project, and that entry is cleared.

プロジェクトの共有の `aidlc.settings.json` とこのマシンの設定ファイルは、そのリクエストから変えられません。行はファイルを名づけ、それを変えるとそれが変わると言います。たとえば、

> The project's shared settings in aidlc.settings.json keep the review freeze check (it stops edits to work you already approved) off for everyone on this project. Changing that file changes it.

あなた自身のターミナルでは、その行は代わりにそれをクリアするコマンドを名づけ、エディターや CLI が変数とともに起動されたときは、それなしで起動するよう言います。Sensors と learnings は同じように読め、このプロジェクトについてのチャットからのエージェントの `config flags --clear-bypass` も同様です。共有ファイルやこのマシンのものを変えるよう頼むと、エージェントが `--project` または `--global` でそこをクリアします。

`config get` は、スイッチがチェックをオフに保つ場所を名づけます。設定ファイルがそれを記録するとき `off (AIDLC_DISABLE_REVIEW_FREEZE_HOOK in aidlc.settings.local.json)`、エディターや CLI が変数とともに起動されたとき `off (env AIDLC_DISABLE_REVIEW_FREEZE_HOOK)` です。plan-approval のロックアウトの間、エージェント自身の `config flags --bypass` は、あなたが前回の決定以降話しているとき一度通り（unattended な実行からは決して通らず）、`--clear-bypass` は常に通ります。

#### `/aidlc --plan-approval` — Plan approval

各コードプランが、code generation がそれをビルドする前に承認用に表示されるかを、アクティブな intent について設定します。

```
/aidlc --plan-approval off
/aidlc config set plan-approval on
```

| フラグ / config キー | 状態・ステータスの行 | `off` が何をスキップするか |
|-------------------|----------------------|------------------|
| `--plan-approval` / `plan-approval`（`guard.plan-approval` も） | Plan Approval | Plan Approval の質問。プランが書かれると人は1行でそれを名づけるのを聞きビルドが始まる。`PLAN_APPROVAL_SKIPPED` 行がビルドされたフィンガープリントを記録する |

Express と poc はそれをオフで出荷し、他のすべての出荷のスコープはオンで出荷します。優先順位は他の儀式と一致し、1つ追加があります。`Mode: strict` を保つメモリの `## Guard Policy` セクションは、スコープや intent がオフと言うところでもそれをオンに保ち、`AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` がマシンでそれをオフにしてそのメモリのロックに勝ちます。変数がカウントされるのは、ハーネスセッションがそれとともに始まったとき、`config flags --bypass` で記録されたとき、またはプロジェクトにハーネスセッションが記録されていないときだけです。セッション内の1つのコマンドでインラインに設定されると無視されます。status はそのとき、たとえば `Plan Approval: on (guard policy strict (from project.md))`、またはセッションがそれとともに始まったときの `Plan Approval: off (from env AIDLC_DISABLE_PLAN_APPROVAL_GUARD)`、または `config flags --bypass` が記録したときの `Plan Approval: off (from AIDLC_DISABLE_PLAN_APPROVAL_GUARD in aidlc.settings.local.json)` と読めます。

それは人の手です。彼らが `/aidlc --plan-approval off` または `/aidlc config set plan-approval off` をタイプする（エージェントがセッターを実行する）か、自分の言葉で言う（「skip plan approval for this work」）とエージェントがセッターを実行します。人が頼んだメッセージを名づけずに実行されたセッターは次で拒否します。

> Turning plan approval off lets code generation start without the person approving the plan, so it is their call. Run it with --message <id>, the message they asked in, when they ask for it.

メモリが strict を保つと、拒否は代わりにメモリファイルを名づけます。作業が存在する前（compose ゲートやスコープ確認で）に言うと、人の言葉がそのリクエストに答えます。そのための `intent create --request <id>` は、フラグの有無にかかわらず `Plan Approval: off (set by you)` を記録し、そのチャットでの次の作成が、何を作ろうとそれらを使います。そのようなターンのないフラグ、または別のリクエストを名づけるかどれも名づけない作成は、拒否されるかスコープの値を保ちます。`on` にするのはタイプされたターンを要しません。スコープ変更は、スコープ由来の値を両方向で新しいスコープのデフォルトに運び、この intent 向けに設定された値を保ちます。`guard.plan-approval` は同じ設定を名づけるので、`/aidlc config set guard.plan-approval off` は `Guards Off` エントリではなく `Plan Approval` の行を書きます。オフの間にプランをレビューするよう頼むと、設定を変えずにその1つのプランを承認用に表示します。全挙動は [Plan approval](13-customization.md#plan-approval) を参照してください。

---

### `/aidlc --statusline <on|off>` — AI-DLC のステータスライン

Claude Code と Codex CLI で、ターミナル下部のステータスラインに AI-DLC の進捗を表示する、またはあなたがセットアップしたステータスラインを戻します。`aidlc config --statusline <on|off>` を実行し、何も尋ねず、何が変わったかと戻す方法を言う1行を表示します。あなたの作業について何も動きません。

- **Claude Code:** あなた自身の選択です。AI-DLC のステータスラインは、あなた自身の `.claude/settings.local.json`（git が無視します）に入るか、そこから出るので、チームメイトは影響を受けません。そのファイルのあなたのステータスラインは、AI-DLC のをオフにすると戻ります。
- **Codex CLI:** プロジェクトの選択です。Codex はプロジェクト内に人ごとの設定ファイルを持たないためです。共有の `.codex/config.toml` の AI-DLC の `status_line` の行だけを、プロジェクトで作業する全員のために加えたり取り除いたりします。各人は代わりに、Codex の `/statusline` で自分のステータスラインにタスクの進捗を加えられます。

初回実行のセットアップが同じ質問を一度尋ねます。何も尋ねないセットアップはステータスラインを加えません。[Status line](13-customization.md#status-line-claude-code-and-codex) を参照してください。

```
/aidlc --statusline off
aidlc config --statusline on
```

他のハーネスでは、そのツールにステータスラインはなく、`/aidlc --status` が作業の現状を示すと言います。

---

### `/aidlc --version` — フレームワークのバージョン

フレームワークのバージョン（`aidlc <X.Y.Z>`）を表示して終了します。読み取り専用で、ワークフローなしで機能し、再開のプロンプトを決して出しません。

**構文:**

```
/aidlc --version
```

---

### `/aidlc --help` — 使い方の情報

利用可能なコマンドとフラグのサマリーを表示します。

**構文:**

```
/aidlc --help
```

プラグインがコマンドを追加するプロジェクトでは、ターミナルでの `aidlc --help` がそれらを `PLUGIN COMMANDS` の下に、プラグインごとに一覧します。

---

### `/aidlc <plugin command>` — プラグインが追加するコマンドを実行する

プラグインは、レポートやダッシュボードのような自分のコマンドを追加できます。AI-DLC 自身のものを実行するのと同じように1つを実行します。

```
/aidlc test-pro-report --since 7d                          # in the chat ($aidlc in Codex)
aidlc test-pro-report --since 7d                           # in a terminal, native install
bun .claude/tools/aidlc.ts test-pro-report --since 7d      # in a terminal, copy install (your harness folder)
```

AI-DLC はプラグインのスクリプトを、自分のランタイムで自分で起動するので、コマンドはネイティブとコピーのインストールで、PowerShell、cmd、POSIX のシェルで機能します。名前の後のすべてはスクリプトに行き、その出力と終了コードがそのまま戻ります。あなたのツールは、どのコマンドにもするように、自分の権限設定をそれに適用します。AI-DLC はプラグインコマンドを事前承認しません。

- このプロジェクトでインストール済みでオンのプラグインだけが走ります。オフのとき、コマンドは1行でそう言い、それを戻す `aidlc config project --plugins` コマンドを名づけます。
- AI-DLC 自身のコマンドは常にその名前を保ちます。それらの1つ、プランのように、または別のプラグインのコマンドのように名づけられたプラグインコマンドは追加されません。それに出会うプラグイン sync が、両方を名づけて一度そう言い、`aidlc doctor --verbose` がそれをもう一度示します。
- 名前がより長い文を開くとき（`/aidlc test-pro-report on the login bug`）、エージェントはあなたがコマンドかリクエストかを意味したかを読み、判断できないときだけあなたに尋ねます。

---

## 決定的な CLI ツール

ネイティブのディスパッチャーは、ユーザー操作のための安定した公開ルートを公開します。バージョン付きリリースランタイムはそれらのルートを使います。ローカルに生成されたソース射影は、ハーネスディレクトリの下の Bun/TypeScript ツールで同じ操作を実装し、直接のツール呼び出しは、公開ルートのない配管になお役立ちます。下記にルートが文書化されているときはいつでも `aidlc` を好みます。

### 以前の質問と監査のタイムラインを読む

エージェントはこれらのコマンドを使って以前の回答とタイムラインを読みます。ワークフローを調べるために実行できますが、すべての `aidlc engine` ルートと同じく、これらはハーネスの機械で、あなた自身のスクリプトの安定したインターフェースとは別物です。

```bash
aidlc engine log answers --stage requirements-analysis
aidlc engine audit history
```

`log answers` は、ペアになった回答、開いている質問、まれな曖昧な回答（前に質問のないもの、または1秒で2人の書き手が並んだもの）を JSON で返します。1つの返答が、それが答えたメニューについて記録されたすべての質問を閉じます。`audit history` はイベントと自由形式のメモの JSON タイムラインを返します。`aidlc engine audit turns` はあなた向けです。あなたの各ターンを、送ったものとともに、このマシンのメッセージ記録から読んで一覧します。コミットされた監査は語を保たないためです。記録はそれを書いたマシンに1日留まるので、より古いターン、または別のクローンからのものは、その語がここにないと言います。

シェルが作用する文字（`$`、バッククォート、引用符、`%`、`&`、`|`、`<`、`>`、`^`、`!`、改行）を保持するテキストの回答は、コマンドラインではなくファイルを通じて `log answer` に届きます。エージェントはそれを `<record>/.aidlc-engine/answer-text/answer.txt` に書き、`--details-file .aidlc-engine/answer-text/answer.txt` を渡します。プロジェクトフォルダから、またはそのフルパスで名づけられた同じファイルも読まれます。エンジンはそのフォルダだけを、リンクを通らずに、最大 64 KiB 読み、読んだらファイルを取り除きます。`log decision` は `--decision-file` で質問を同じように取り、その選択肢を1行ずつ `--options-file` で取り（カンマを保持する選択肢は自分の `--option '<choice>'` としても行けます）、`learnings surface` は `--correction-file` で修正を取ります。エージェントが `next --request-file` 用に書いたファイルは回答にも機能します。`log answer --request-file aidlc/.aidlc-request-text/request.txt` が `next` のようにそれを読み、回答が取られると取り除くので、拒否された回答はそれを保ちます。`--details` や `--details-file` の横では渡されません。

素の `log answer` は、どの決定もまだ使っていない、質問が記録される前または後に送られた、このチャットでの人の返答を要します。どの質問に答えるかはエージェントの読みです。選択肢のある質問では、`--details` はエージェントが返答から読んだ選択肢で、どのフックも彼らの語を保たなかった、または返答がいくつもの質問に答えるところでは彼らの返答自体です。回答の行は、そのような各返答の語を保ちます（Person Reply）。より早い回答がすでに記録した1つを除きます（それが最新で質問がその前に記録されたときを除く）。そして最新のものを名づけ（Message Id）、いくつもあるときは古いものから順にそのすべてを名づけます（Message Ids）。エンジンがチャットを名づけられないとき、1つのチャットが返答した id だけを保ち、複数が返答したときはどちらも保たず、どちらにせよ回答を記録します。`log decision --message <id>` と `log answer --message <id>` は、別のエンジンの質問が開いている間に送られたものなど、1つのメッセージを代わりに名づけます。エンジンは記録が存在し、このチャットを通じて来た、または別のところでこの作業に送られ、その後の承認や決定で使い切られていないことを証明し、その語をどれも読みません。id はエンジンからエージェントへのテキストで、人に決して表示されません。ペアのルール、順序、フィルターは [Hooks and Tools](../reference/06-hooks-and-tools.md#read-only-audit-commands) を参照してください。

### `aidlc engine bolt set-autonomy` — Construction の承認を変える

Construction の間、自動的に続けるか各チェックポイントをレビューするかを明示的に頼みます。コンダクターは **Continue automatically** を `autonomous`、**Review each checkpoint** を `gated` として記録します。

```bash
aidlc engine bolt set-autonomy --mode autonomous --message <id>
aidlc engine bolt set-autonomy --mode gated
```

両方とも `Construction Autonomy Mode` を更新し `AUTONOMY_MODE_SET` を発行します。autonomy を与えるには、それを選んだ人のメッセージの id である `--message <id>` が要り、その付与はそのメッセージを使い切ります。その同じメッセージの承認（「approve the plan, and run Construction on its own from here」）、またはその中でエージェント自身の質問に与えた回答は、それを立たせたままにします。取り消しはメッセージを要しません。新しいチェックポイントのワークフローは、skeleton オフでは Construction 入口で、skeleton オンでは最初の動く統合ユニットがその skeleton チェックポイントを通った後に、その選択を提供します。既知の選択は再び尋ねられません。on-demand の変更は有効なままです。

autonomy は通常の完了承認を制御します。すべてのユニットは plan approval がオンの間なお Plan Approval を要し（オフでは各ユニットのプランは1行の後にビルドされスキップとして記録されます）、検証コマンドの選択と skeleton チェックポイントの承認は常に人を要します。生成前のサマリー確認は `directive.ceremony.summary_confirmation === "on"` のときだけ人を要します。失敗は停止します。`Construction Checkpoints` のない既存のワークフローは、そのレガシーの最初のステージと後のステージの承認を保ちます。チーム所有のユニットゲートは自分のポリシーを保ちます。

### チェックポイント検証のタイムアウト

`aidlc engine bolt checkpoint --unit <unit> --kind unit --action verify` は、承認されたプロジェクトチェックを、デフォルトの30分の制限で実行します。より長いチェックには `--timeout-ms 3600000`（1時間）を加えます。値は 1 から 2,147,483,647 ミリ秒の整数でなければならず、`--action verify` とのみ受け入れられます。各実行は、証拠リフレッシュのリトライを含め、その予算を使います。

タイムアウトは、検証を失敗として記録する前に、POSIX では所有するプロセスグループ、Windows ではプロセスツリーを終了させ、終了を確認できなければクリーンアップ不完全と報告します。POSIX では、SIGINT、SIGTERM、SIGHUP で検証を止めると、そのシグナルを所有するグループに転送します。それを無視するプロセスは、短い猶予期間の後にキルされます。クリーンアップは最大4秒を加えます。所有する POSIX グループのウォッチャーも、検証器が転送できない SIGKILL でキルされたとき、それを終了させます。中断された検証器は通る証明を記録できません。ハードキルは、始まった証明を未完了・未検証のまま残します。独立にデタッチされた POSIX のプロセスは、そのグループの外です。

### Construction の順序と実行

ユニット分解がスコープにある新しいソースを生み出すソロのユニットワークフローは、`Construction Checkpoints: enabled`、`Construction Iteration: unit-major`、`Construction Execution: serial` を記録します。1つのユニットが、次の前に、該当する設計ステージと Code Generation を通ります。設計のみとユニットなしのワークフローは既存のステージフローを保ち、チーム所有のユニットは自分のゲートリズムを保ちます。既存のワークフローと明示的な反復の選択は保たれます。swarm の実行を明示的に選ぶには、まず stage-major を選びます。

```bash
aidlc engine state set-construction-iteration stage-major
aidlc engine state set-construction-execution swarm
```

既存のワークフローを検証付きチェックポイントにオプトインするには、できればユニット作業が始まる前に、`aidlc engine state set-construction-checkpoints enabled` を使います。`disabled` はレガシーのチェックポイントフローを保ちます。これらのタイプされたセッターはランタイムの設定を更新します。汎用の `state set` は `Construction Checkpoints`、`Construction Execution`、`Construction Iteration`、`Construction Verification Command` を拒否します。それぞれ `set-construction-checkpoints`、`set-construction-execution`、`set-construction-iteration`、または受領にバインドされた `set-construction-verification-command` を使います。Construction の間、これらのどれも自分の言葉で変えます（「turn checkpoints off」、「from here on, build one unit at a time」、「run the Units in parallel」）。エージェントは質問を先にせずそのターンでそれをし、何が変わったかと戻せることを1行で言います。たとえば「Construction checkpoints (a stop after each Unit for you to check and approve it) are off for this work now (they were on). You can switch back any time.」です。変更はあなたの語とともに `CONSTRUCTION_POLICY_SET` として記録されます。セッターは、エージェントがあなたが頼んだメッセージを名づける（`<value> --message <id>`、`config set` のように証明される）とき、またはエージェントが提供したときにあなたが変更を選んだときにだけ変更を行うので、エージェントは自分でこれらを変えられず、unattended な実行は決してこれらを変えません。別のものを先に要する変更（並列ユニットは stage-major とチェックポイントのオンを要する）は両方を行い、両方を言います。

ステージの途中で `unit-major` に切り替える、またはチェックポイントをオンにすると、すでに完了したユニットを保ちます。`/aidlc` がまだ作業の残る次のユニットで続け、変更は `CONSTRUCTION_POLICY_SET` として記録されます。逆に、チェックポイントオフで `stage-major` に（反復を戻す、または stage-major の間にチェックポイントをオフにする）行くと、それらも保ちます。切り替え前に再び開いたユニット（戻るジャンプ、Redo、チェックポイントの Request Changes）は、なおそのやり直しを得て、終わると保ちます。

並べたビルドが準備された後に serial に切り替える（たとえば並列開始が止まった後の「build them one at a time instead」）と、承認したプランを保ちます。各ユニットがプロジェクト自体でそのプランからビルドされ、新しいプランの質問はありません。そのビルドが準備した worktree はそのまま残り、その Bolt は閉じたものとして記録されます。

実行は承認とは別です。swarm はガイド付き（`gated`）または自動（`autonomous`）の完了で機能します。Unit-major は serial のままで、矛盾する swarm 設定を拒否します。unit-major に戻る前に `aidlc engine state set-construction-execution serial` を実行します。既存の明示的な選択を保ちます。実行フィールドのないワークフローはレガシーの autonomy ベースの swarm ルーティングを保ちます。

実在の空でないユニット DAG と、ソースを生み出すステージを含む、チェックポイント有効なソロ作業では、skeleton オンは、stage-major が選ばれていても、後のユニットの前に、最初の DAG ユニットを最小の動く統合スライスとして常にビルドします。最初の設計ステージのレビューだけでは、動く skeleton を証明しません。すでに承認されたインラインのユニットは、後の swarm バッチから除外されます。

### `aidlc engine swarm prepare` — 再現可能なバッチを準備する

最初の保護された Code Generation の準備の前に、選ばれたベースがそれを再現できるよう、すでに承認された親アプリケーションソースをコミットします。これは、並列バッチに切り替える前の承認済みインライン skeleton ソースを含みます。Git が無視して追跡しないファイル（`.env` やログなど）は、それを `.aidlc-source-paths.json` にソースとして登録しない限り、その一部ではありません。それらはそのまま残り、ユニットの worktree は、どの Git チェックアウトと同じく、それらを持ちません。そのような無視されたリンクが指す先も同様で、サブモジュールのファイルはサブモジュール自身の ignore ルールで読まれます。それらのファイルの1つへの変更（プランを承認した後に書かれたテスト実行のログ、ビルド中の dev サーバーのログ）は、プランの承認を決して再び求めず、着地とステージの完了はそれをメインチェックアウトへの変更としてカウントしません。ルールはレガシーの autonomy と新しいチェックポイントのワークフローに同じく適用されます。autonomy の付与は自動のコミットを決して認可しません。

```bash
aidlc engine swarm prepare --batch <N> --units "<exact emitted Units>"
```

ツールは、どの子 worktree も作る前に、すべてのユニットについて読み取り専用のソース/承認の事前チェックを行います。ソースがコミットされていなければ、その拒否で子が置き去りにされることなく、commit-and-retry の指示を返します。明示的な認可とともにだけコミットし、次に現在の承認の証拠でリトライします。アプリケーションソースやプランが変わっていたら、必要な Plan Approval を再び提示します。要件はアプリケーションソースに関するもので、無関係なフレームワーク記録や他のファイルの一律のコミットではありません。

同じ事前チェックは、ユニットが実際に始まるコミットに `.gitmodules` エントリのない gitlink のために、ソースファイルがユニット worktree の空のフォルダになってしまうネストしたリポジトリを名づけます。それらを Git サブモジュールとして登録しそのエントリのある開始コミットを選ぶか、そのユニットを serial にビルドします。この拒否は子 worktree を作らず、親のコミットをしません。選ばれたベースが承認済みの親ソースを必要とするなら、準備はその親コミットで始まりその登録を確認します。明示的な discard の後の回復は、代わりに記録された Approval Source Commit を確認します。親がそれ以降変わっていてもです。

### Construction 検証コマンド — 人の認可を記録する

チェックポイント有効な作業では、Delivery Planning がプロジェクトのスキャンから、`bun test`、`pytest`、`make check` のような実在のプロジェクトチェックを提案します。構造化された **Approve** / **Request Changes** の質問が **Use this command to verify each completed Unit?** を尋ねます。コマンドを提示する前に、それを UTF-8 テキストとしてハーネスのファイル書き込みツール（Write/edit）で `<record>/verification-command.txt` に書き、シェルの `echo` や heredoc は決して使いません。リポジトリ由来のコマンドテキストは決してシェルの行に補間してはなりません。シェルの置換が承認の前に実行されうるためです。記録相対のパスだけを渡します。コマンドは、それが走るセッションを自分で見つけます。

```bash
aidlc engine log decision --stage "<directive.stage>" --checkpoint verification-command --command-file verification-command.txt --decision "Use this command to verify each completed Unit?" --options "Approve,Request Changes"
```
`decision` ツールの JSON 出力の `command` フィールドから、完全な正規コマンドを質問のコードスパンへそのまま正確にコピーします。サマリー、プレフィックス、ダイジェストを決して省略または置き換えません。コマンド内のバッククォートを保つのに十分な長さのコードスパンの区切りを使います。人は `<record>/verification-command.txt` を開くこともできます。


人の **Approve** / **Request Changes** の返答を、そのチャット、または新しいチャットでそれが最後に尋ねられた質問である間に待ちます。**Approve** だけが受領を認可します。無関係な返答、**Request Changes**、別の質問への返答は認可しません。人が選んでいない限り `--details "Approve"` を決して書きません。そのとき初めて実行します。

```bash
aidlc engine log answer --stage "<directive.stage>" --checkpoint verification-command --command-file verification-command.txt --details "Approve"
aidlc engine state set-construction-verification-command --command-file verification-command.txt
```

これらは `aidlc-log` の decision/answer のチェックポイント形式です。両方とも同じ `--stage`、`--checkpoint verification-command`、正規コマンドを要します。それぞれ走るセッションを自分で見つけ、`--session <id>` は、どのセッションか判断できないと報告するときだけそれをオーバーライドします。それぞれ `--command-file <path>` か `--command` のちょうど1つを受け取ります。両方もどちらもなしも拒否されます。コンダクターのシェル呼び出しにはファイル形式を使います。直接の引数は、シェルの補間なしに渡されるときだけ安全です。ファイルは作業の記録の通常のファイルで、記録から（`verification-command.txt`）、プロジェクトフォルダから（`aidlc/spaces/<space>/intents/<intent>/verification-command.txt`、どちらのスラッシュでも）、またはフルで名づけられます。記録の外の名前、`..` の部分、連鎖のシンボリックリンクは拒否され、ファイルは 16 KiB 以下です。ファイルは UTF-8 としてデコードされ、直接の引数とまったく同じように正規化されます。先頭/末尾の空白は、記録、ハッシュ、実行の前にトリムされます。結果のコマンドは空でなく、最大1024文字で、単一行でなければなりません。ツールは制御文字（改行、CR、タブ、NUL を含む）と表示を偽装する文字（Unicode フォーマット文字（ゼロ幅や bidi 制御を含む）、行/段落区切り、ノーブレークスペース（U+00A0））を拒否します。複数行のチェックはスクリプトに入れ、その呼び出しを記録します。`decision` は `Checkpoint: Construction Verification Command` と `Command SHA-256` を持つ `DECISION_RECORDED` を記録します。その JSON 出力は、完全な正規の `command` と `command_sha256` を `challengeId` と `challengeFile` の横に含みます。`answer` も `command_sha256` を表示します。`answer` は、一致する保留中の決定と、人がそのコマンドとセッションの現在の challenge に返答したという human-turn フックの記録を、`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` でも要します。`--details` はエージェントが彼らの返答から読んだ選択肢を名づけ、受領は彼らの正確な語を運びます。後の `HUMAN_TURN` だけでは不十分です。新しい決定の記録はセッションの以前の challenge と応答を置き換えます。成功した answer は、両方を消費する前に監査イベントを追記します。追記の失敗は同じ応答をリトライ可能なまま残します。古い、一致しない、正常に消費された応答は拒否されます。承認する返答（エージェントが人の返答を読み `--details "Approve"` を渡す。素の数字や別の語は選択肢を名づけないとして拒否される）は、ツール所有の `VERIFICATION_COMMAND_RECORDED` 受領を発行します。変更を求めるものは `QUESTION_ANSWERED` だけを記録し、状態を設定せずに別のコマンドを提案することを意味します。どちらも選ばない返答は、尋ねる1つのフォローアップとともに拒否されます。受領は、ステージ、チェックポイント、セッション、その正規コマンドの SHA-256、完全な正規コマンドを `Command Label`（決して切り詰めません）として、人の正確な選択を運びます。`aidlc-audit append` はこの予約された受領を作れません。

タイプされたセッターは `--command-file <path>`（同じ方法で名づける）か1つの位置引数のコマンドを受け取ります。両方は決して受け取りません。最新の現在のワークフローの承認受領がそのダイジェストと一致するときにだけ、`aidlc-state.md` の `## Runtime State` の下に `- **Construction Verification Command**: <cmd>` を書きます。その JSON 出力は `command_label`（完全な正規コマンド）と `command_sha256` を含みます。別の human turn を求めません。状態フィールドではなく受領が実行を認可します。検証は同じバインディングを確認します。古いワークフローと隔離されたステージの受領はそれを認可せず、別のコマンドの後の受領が前のものに取って代わります。一致する受領のないフィールド、または一致するフィールドのない受領は認可に当たりません。このフィールドを直接、または汎用の `state set` を通じて書かないでください。

記録されたコマンドは、この intent のすべてのユニット/バッチのチェックポイントで再利用されます。選択と後の変更は、自律的な完了のもとでも、常にこの decision/answer/setter のフローを要します。実行可能なチェックがまだない（greenfield）とき、人は Delivery Planning の間に延期できます。フィールドを未設定のままにすると、最初のチェックポイントが尋ねます。プレースホルダーのコマンドを決して発明または自動承認しません。

### `aidlc engine bolt checkpoint` — 完了したユニットを検証し承認する

エンジンはユニットとチェックポイントの種類（`unit` または `skeleton`）を名づけます。本体、レビュー、受領はすでに存在します。再ビルドではなくチェックポイントに従います。ユニットのコードやドキュメントがそのレビューの後に変わったとき、チェックポイントの `rereview` が1つの再チェックのリクエストを名づけ、エージェントが検証の前にそれを実行します。それは Guard Policy `strict` のもとで起きます。`relaxed` と `off` のもとでは代わりに変更が受け入れられ、承認済みのユニットは承認のまま残り、`verify` がその1行を `change_notices` として返します。レビューオフでも同じです。次のユニットの `verify`、または Construction ステージ自身のチェックが行を返します。ユニット自身のレビューが終わっていない（まだ判定なし、またはパスの残る NOT-READY）とき、`rereview` は `unfinished` を運びそれを終わらせるリクエストを名づけます。人がユニットをそのまま承認するよう言うなら、`verify` に `--over-unfinished-review --message <id>` を加えます。`<id>` は彼らがそう言ったメッセージです。Guard Policy `off`、`relaxed`、または作業用に設定された `strict` のもと、そのメッセージが証明され、求められたレビューがあれば、ユニットは検証され彼らの語がその承認（`review_not_finished.approved_in_words`: `approve` はもう何も尋ねません）になり、レビューが終わっていないとして、ステージゲートと同じく記録されます。後で来るそのレビューの判定は記録され、ユニットを承認のまま残します。チームのロックされた `strict` のもとでは、人に尋ねずにレビューが先に終わります。リトライされたレビューがまだ丸ごとのレビューを書かなかったときにコンダクターが記録する NOT-READY のフォールバックで終わったユニットは、一度尋ねられ（`review_not_finished.question`）、パスの選択肢なしに同じように承認されます。このユニット作業の実行で決して求められなかったユニットレビュー（戻るジャンプや再開の後、前のレビューはカウントされません）は、すべての Guard Policy のもとで必須です。`rereview` は `first` を運びその実行の最初のリクエストを名づけます。

```bash
aidlc engine bolt checkpoint --action status --unit "<Unit>" --kind <unit|skeleton>
aidlc engine bolt checkpoint --action verify --unit "<unit>" --kind <unit|skeleton>
aidlc engine bolt checkpoint --action verify --unit "<unit>" --kind <unit|skeleton> --over-unfinished-review --message <id>
```

検証は、記録された人が認可した `Construction Verification Command` を実行し、現在の成果物、ソース、試行にバインドされた証明を保存します。コマンドの引数を受け取りません。`construction_checkpoint.command_authorized` が false なら、`verify` を実行しません。[記録コマンドのフロー](#construction-検証コマンド--人の認可を記録する)を完了し、次に `next` を再実行します。skeleton のコマンドは、統合スライスを端から端まで証明し、通常のユニットの作業結果を確認しなければなりません。承認は現在の検証済みの証明を要します。人の承認の質問に「Verified with `<full command>` (exit 0)」を表示し、現在のツール出力から完全な `verification_command` を省略せずにコードスパンへコピーします。この表示ラベルは完全な正規コマンドで、プレフィックスではありません。`verify` が `verified: true` を報告し、かつ現在のチェックポイントが `ready: true` を持ったときに初めて `ask` を実行します。準備未了または未検証のチェックポイントを拒否します。**Approve** / **Request Changes** を提示する前に、現在のユニット、種類、フィンガープリント、検証証明 ID、認可されたコマンドのダイジェストについて、1回限りの質問を開きます。各 `checkpoint` アクションは走るセッションを自分で見つけます。`--session <id>` は、どのセッションか判断できないと報告するときだけオーバーライドします。

```bash
aidlc engine bolt checkpoint --action ask --unit "<unit>" --kind <unit|skeleton>
```

`ask` が `earlier_reply` を返すとき、人はユニットのレビューが走る間にそのセッションですでに答えています。レビューが求められた後、別の質問（learnings の質問など）が尋ねられる前にタイプされた彼らの語が、この質問の返答です。それらを読み、彼らが選んだアクションを、質問を表示せずに実行します。彼らが何も答えないときは、下記のように質問を提示し待ちます。`ask` が `left_out` を返すとき、人がユニットのビルドから除外するよう頼んだものが、質問の直前に言われます。たとえば「Left out of this build: AC2.1.1 and AC2.2.1.」です。`changed_files`（人が持ち込んだ、ユニットのビルドが変えたか削除したファイル）も戻る道とともに言われます。「The build changed README.md, a file you had before this work started. To put it back, run `git checkout HEAD -- README.md`.」です。`check_offer`（ステージのレビューパスが使い切られ、そのレビュー済みの作業が最後のレビューの後に変わったとき）も言われます。「Do you want me to have the new approach checked before you decide?」です。

このチェックポイントの質問への人の **Approve** / **Request Changes** の返答を、そのチャット、または新しいチャットで待ちます。自分の質問がないので、新しいチャットの返答は、別のチャットが尋ねたチェックポイントの質問のために、それが最後に尋ねられた質問でまだ開いている間、保たれます。それは一致するアクションだけを認可します。無関係な返答、エージェント自身の語、別の質問への返答は認可しません。人が選んでいない `--user-input` を決して渡しません。彼らが選んだアクションだけを実行します。

```bash
# Only after the human chose Approve:
aidlc engine bolt checkpoint --action approve --unit "<unit>" --kind <unit|skeleton> --user-input 'Approve'
# Only after the human chose Request Changes and supplied feedback:
aidlc engine bolt checkpoint --action reject --unit "<unit>" --kind <unit|skeleton> --user-input 'Request Changes' --reason '<human feedback>'
```

人が決めるとき、レビューの所見を直すよう頼むか1つを拒否するとき、approve に `--fix-finding "<review-artifact>#R-NN"` を加えるか、拒否に `--reject-finding '<review-artifact>#R-NN=<their reason>'` を加えます（レビュアーが直したとマークしたが彼らがそうでないと言うものには `--reopen-finding`）。ステージのゲートと同じく、所見ごとに一度です。

人が別のエンジンの質問が画面にある間に答えた（彼らの語が属するところ、新しい作業の申し出）とき、その返答はチェックポイントのために保たれません。拒否がそのメッセージを名づけ、approve や reject の `--message <id>` がそれを彼らの返答として記録します。アクションは応答を消費します。`verify` の再実行は、どのセッションであっても、この intent について開いているすべてのチェックポイントの質問とキャプチャされたチェックポイント応答を取り下げます。新しい検証が `verified: true` を報告した後にだけもう一度尋ねます。より古い証明への応答は、そのフィンガープリントとコマンドが変わっていなくても、より新しいものを承認できません。`human_required: false` の検証済みの通常のユニットは、`--user-input` なしに承認され `ask` を要しません。人の拒否は常に上記の検証済みの質問と回答のフローを要します。skeleton は常に人を要します。欠けている、または古い証拠は `errors` で説明されます。名づけられたレビュー/受領を、必要に応じて人に相談しながら、検証を発明したりチェックポイントの承認の質問を早く開いたりせずに修復します。検証、承認、拒否の後に `next` を再実行し、1つのユニットのチェックポイントを Code Generation ステージ全体の承認として決して報告しません。検証器は、証明ファイルの横にツール所有の `CHECKPOINT_VERIFICATION_RECORDED` 受領を記録し、承認はその受領を要します。手書きの証明ファイルはユニットを検証できません。証明ファイルがまったくないチェックアウト（新しいクローン、別のマシン）では、その受領が、証拠が変わっていないすでに承認されたユニットの証明の代わりになるので、何も再び走りません。

セッションごとに開けるのは1つの保護された質問だけです。保護された質問を1つずつ尋ね、他の何かの前に回答を待ちます。

バージョン4の証明と CLI の JSON は、`command_sha256` と完全な正規コマンドを `command_label` に、加えて終了ステータス、キャプチャされた stdout/stderr のフルのバイト数と SHA-256 ダイジェスト、各ストリームの最後の 2 KiB を `stdout_tail` と `stderr_tail` に保ちます。tail は、先頭の部分的なマルチバイトシーケンスを落とした後に UTF-8 としてデコードされます。改行とタブ以外の制御文字は U+FFFD に置き換えられます。フルの出力は保たれません。チェックはそれをメモリではなく一時ファイルに書くので、長時間走るスイートの出力が通るチェックを決して失敗させません。走る間にユニットのファイルを変えるチェック（フォーマッター、ジェネレーター）は、そのときのファイルに対してもう一度走ります。それがまたファイルを変えると、証明の `error` が、ファイルをそのままにするチェックを使うよう言います。プロジェクトチェックのコマンドは秘密を表示してはなりません。これらの診断の tail は秘密を伏せません。承認は `GATE_APPROVED` の `Verification Command SHA-256` を証明の `command_sha256` にバインドします。より早い認可コマンドのもとで承認されたユニットは、人が新しいものを承認するときその承認を保ちます。新しいコマンドがまだ承認されるユニットを検証し、セッターが `Using <command> from here on.` の行を `notice` として返します。失敗を説明するには tail を使います。より多くの診断が要るなら、新しく選んだコマンドではなく同じ認可されたプロジェクトチェックを使います。バージョン1からバージョン3の証明は、アップグレードの後は未検証です。記録されたコマンドを認可し、承認の前に `checkpoint --action verify` をもう一度実行します。

### `aidlc engine swarm check` / `finalize` — ネイティブ worktree を検証する

両方のコマンドは、Construction Checkpoints の有無にかかわらず、準備された各ユニット worktree で、intent の記録された人が認可した Construction Verification Command を実行します。

```bash
aidlc engine swarm check <Unit> [--test-file <protected spec>] [--show-output]
aidlc engine swarm finalize --batch <N> --units "<all Units>" --claimed "<converged Units>"
```

`--check-cmd` は、チェックポイントの有無にかかわらず任意です。供給されると、その正規のダイジェストが認可されたコマンドと一致しなければなりません。欠けた認可は実行を拒否します。通るコマンドを代わりに入れるのではなく、[記録コマンドのフロー](#construction-検証コマンド--人の認可を記録する)と `set-construction-verification-command` を完了します。ワークフローがないと、両方のコマンドは拒否します。`check --show-output` はコマンド自身の出力を走る間 stderr に送ります。stdout は1つの判定行を保ちます。並べたビルドでは、各ワーカーのブリーフと各レビュアーのレビューリクエスト（`test_command`）が `check <Unit> --show-output` を名づけ、プロジェクトのメインフォルダから走るので、あなたが承認したテストが AI-DLC 自身のコマンドを通じて走ります。`check` は advisory です。`finalize` はコマンドを再実行し、各クレームされたユニットをマージする前にレビューの証拠を検証します。`finalize` の再実行は、どのセッションであっても、この intent について開いているすべてのチェックポイントの質問とキャプチャされたチェックポイント応答を取り下げます。新しい検証、ソースの着地、`ready: true` のバッチステータスの後にだけもう一度尋ねます。検証済みのネイティブのパスだけが `SWARM_UNIT_CONVERGED` を、認可された `Command SHA-256` とともに受け取ります（より早いリリースの行はそれを欠くかもしれません）。`next` の前に、そのソースをネイティブの worktree マージを通じて着地させます。バッチがビルドする間に人がメインチェックアウトに行った編集は、strict な Guard Policy のもとでそのマージを止めます（拒否がステップを名づけます。彼らが変更を頼んだときは彼らのメッセージとともに `swarm allow-change`、次に同じマージがそれを保ちます。そうでなければそれらを取り消してマージをもう一度実行するか、それらを保つために `guard policy relaxed` と言います）。relaxed または off のもとではそれらは保たれ、`CHANGE_ACCEPTED`（`swarm-batch`）として一度記録され、マージが1つの `note:` 行を表示します。ステージが完了するとき、最後のマージの後に行われた編集にも同じことが当てはまります。

### `aidlc engine swarm allow-change` — メインチェックアウトで人が頼んだ変更

```bash
aidlc engine swarm allow-change <file>... --message <id>
```

strict な Guard Policy のもと、ユニットが並列にビルドされる間、メインチェックアウトはその着地によってのみ変わるので、各着地はそれを確認できます。人がそこで別のファイルを頼むとき（「also fix the typo in the README」）、その書き込みの plan-approval ガードの拒否が、彼らが頼んだメッセージとともにこのコマンドを名づけます。それはメッセージを証明し、彼らの語とともにファイルを現在の Code Generation の試行について `MAIN_CHECKOUT_CHANGE_ALLOWED` として記録し、彼らのために1つの `notice` 行を表示します。書き込みがそれから入り、着地、次のバッチの準備、ステージの完了が変更を保ち、それぞれそのメッセージとともに `CHANGE_ACCEPTED` として記録されます。AI-DLC 自身のファイルと、ビルド中のユニットがそのプランで名づけるファイルを拒否します（その変更はユニット自身のチェックポイントを通ります）。チームがメモリで保つ strict な Guard Policy のもとでは、何も変えず、それがどこで設定されているかを1行で言います。

### `aidlc engine bolt swarm-checkpoint` — 完了したバッチを承認する

swarm バッチが落ち着いた後、エンジンは別のバッチが始まる前に `swarm_checkpoint` を返すことがあります。その正確なバッチ番号とユニットリストを使います。

```bash
aidlc engine bolt swarm-checkpoint --action status --batch <N> --units "<comma-separated Units>"
```

status が `ready: true` を報告した後にだけ `swarm-checkpoint --action ask` を実行します。準備未了のバッチを拒否します。**Approve** / **Request Changes** を提示する前に、現在のバッチ、正確なユニットのセット、フィンガープリント、ユニットごとの `Command SHA-256` のセットについて、1回限りの質問を開きます。`checkpoint` と同じく、自分のセッションを見つけます。`--session <id>` はオーバーライドだけです。

```bash
aidlc engine bolt swarm-checkpoint --action ask --batch <N> --units "<Units>"
```
承認の質問に「Verified with `<full command>` (exit 0)」を表示します。検証コマンドのツール出力から完全な正規の `command` を省略せずにコードスパンへコピーし、バッククォートをより長い区切りで保ちます。


このチェックポイントの質問への人の **Approve** / **Request Changes** の返答を、そのチャット、または新しいチャットで待ちます。自分の質問がないので、新しいチャットの返答は、別のチャットが尋ねたチェックポイントの質問のために、それが最後に尋ねられた質問でまだ開いている間、保たれます。それは一致するアクションだけを認可します。無関係な返答、エージェント自身の語、別の質問への返答は認可しません。人が選んでいない `--user-input` を決して渡しません。彼らが選んだアクションだけを実行します。

```bash
# Only after the human chose Approve:
aidlc engine bolt swarm-checkpoint --action approve --batch <N> --units "<Units>" --user-input 'Approve'
# Only after the human chose Request Changes and supplied feedback:
aidlc engine bolt swarm-checkpoint --action reject --batch <N> --units "<Units>" --user-input 'Request Changes' --reason '<human feedback>'
```

所見のフラグ（`--fix-finding`、`--reject-finding`、`--reopen-finding`）はユニットのチェックポイントと同じように機能します。バッチの拒否はそれらを各ユニットの行に記録します。

アクションは応答を消費します。変わったチェックポイントは新しい質問と回答を要します。ユニットのチェックポイントと同じく、`--message <id>` は、別のエンジンの質問が画面にある間に人が送った返答を記録します。`finalize` の再実行は、どのセッションであっても、この intent について開いているすべてのチェックポイントの質問とキャプチャされた応答を取り下げます。新しい検証とソースの着地の後、`ready: true` を確認しもう一度尋ねます。`finalize` の前にキャプチャされた応答は、新しい証拠を承認できません。自動の完了は `human_required: false` のとき `--user-input` を省き `ask` を要しません。人の拒否は常にこの準備ができた質問と回答のフローを要します。準備は、各ユニットのネイティブの `Command SHA-256` が現在の認可された Construction Verification Command と一致することを含む、完了したバッチの現在の証拠から来ます。バッチの承認はそのダイジェストもバインドします。すでに承認されたバッチは、人が新しいコマンドを承認するときその承認を保ち、まだ承認されていないバッチはそれで新しい検証を要し、ダイジェストのない古いネイティブ受領は新しい検証を要します。バッチのクレームされたファイルや出力がチェックの後に変わったとき、strict な Guard Policy はそれを `changed_after_check: true` で準備未了にし、`ask` はそのとき人に Request Changes だけを提供します。relaxed または off のもとでは変更が保たれ、`CHANGE_ACCEPTED`（`swarm-batch`）として一度記録され、`ask` / `approve` がその行を `notices` で返します。バッチ全体を再ビルドしたりパスを発明したりするのではなく、`errors` を解決します。承認または拒否の後に `next` を再実行します。バッチの承認はステージ全体の承認ではありません。後の完了のみのステージディレクティブが、別の本体、レビュアー、人の learnings/承認の質問なしに帳簿を整えます。

Request Changes の後、`resume_existing: true` の `invoke-swarm` ディレクティブは、同じバッチと正確なユニットのセットを使います。拒否が前の承認を退役させたなら、準備の前にそのリビジョンの新しい Plan Approval を得ます。

```bash
aidlc engine swarm prepare --resume-existing --batch <N> --units "<exact emitted Units>"
```

worktree が残っていれば、ツールはそのソースを保ち古いメタデータをアーカイブします。ネイティブのソースの着地がそれを取り除いたなら、ツールはその着地の証拠を検証した後、すでに着地した親ソースから新しい子を作れます。どちらのパスもその拒否のリビジョンと実際の承認の証拠を保ちます。同じ intent、ターゲット、試行について承認が存在すると、セットアップのリトライは別の回答を要しません。`execution_allowed: true`（exit 0）の `testing-posture verify` も、`ok: false` のとき下がったフェンスのもとで承認後の継続を許します。その許しはより古い試行の承認を決して復活させません。その証拠のない欠けた子は拒否されます。マージされたすべての子が残ると仮定したり、拒否された resume を通常の prepare で置き換えたりしないでください。承認された開始点と異なるソースは、作業が再開する前に調整され承認されなければなりません。

### グループ化された Code Generation の Plan Approval

swarm バッチのいくつものユニットのプランが一度に準備できているとき、`next` はそれらについて1つの質問で尋ねます。各ユニットのサマリーとプランパス、次に **Approve all**、**Request Changes**、**I'll edit the files** です。人は自分の言葉で答え、エージェントが彼らが行った選択を `aidlc engine log answer --stage code-generation --checkpoint plan-approval --details "Approve Plan"`（または `'Request Changes: <what they asked>'`、または `"I'll edit the files"`）で記録し、一部のユニットには `--units "<unit>,<unit>"` を加えて次に残りを記録します。「approve all」はすべてのユニットを承認し、ユニットを名づける変更（「change billing: use Stripe」）はちょうどそのユニットをその語とともに差し戻し残りを承認します。質問ボックスでの「Approve all」のピックは、行われるとすぐ記録されます。タイプされた「Approve all」は、どの返答とも同じようにエージェントが記録するものです。すべてのユニットがなお、自分のプランにバインドされた自分の承認記録を得ます。古い記録済みバッチのコマンド（`aidlc engine log decision|answer --stage code-generation --checkpoint plan-approval --batch-file <manifest>`）は、更新の前に始まったグループ承認が終えられるようにだけ残ります。エンジンの質問が開いている間、それらは「Plan Approval is asked by the engine now. Run next, show the person the question it returns, and end the turn.」で拒否します。

いくつかの承認済みユニットが着地すると、残りの準備されたワーカーは、`next` が保留のセットを狭めるにつれ、その元の承認を保ちます。`testing-posture verify` が `execution_allowed: true`（exit 0）を報告するとき、編集された内容が承認されなかったと `ok: false` が正しく報告するときを含め、その既存の worktree を続けます。その継続について、`reason` は新しい承認なしに続けると言い、`approval_reason` は詳細な古いバインディングの理由を保ち、それは実行をブロックしません。既存のワーカーは、後の引き下げや引き上げを含め、検証済みの親 intent のライブの plan-approval フェンスを使います。部分的なバッチは別の承認の回答や新しい `prepare` を要しません。これはチェックポイントのリビジョンが準備された後にも当てはまります。中断されたリビジョンのセットアップは、その既存の現在の承認でリトライでき、成功した準備は以降の `next` ディレクティブからリビジョン準備の信号を取り除きます。最初の承認の後、同じターゲットと試行についてのプラン、テスト指示、Testing Contract の編集は、Guard Policy `relaxed` または `off` のもとで再承認なしに続きます。`strict` のもとでは編集されたプランについて再び尋ねられます。新しい試行はなお自分の承認を要します。編集された内容を承認済みと記述せずに、元の承認の証拠を保ちます。人の Retry がワーカーを明示的に discard するとき、そのネイティブの discard は再作成のためにコミットされた承認済みのベースラインを保てます。置き換えは、他のバッチのメンバーが続くか、すでに着地している間に同じ承認を保てます。欠けたディレクトリと無関係な古い discard の記録は、この回復を認可しません。ユニットごとの承認は、質問がどう提示されても必須のままです。[Construction Execution](../reference/03-orchestrator.md#construction-execution) を参照してください。

### `aidlc engine worktree restore` — 脇に置かれた試行のファイルを回復する

メインのプロジェクトチェックアウトから実行します。

```bash
aidlc engine worktree restore --slug <slug> [--parked <stamp>] [--raw] [--repo <name|.>] [--intent <intent>] [--space <space>]
```

これは `worktree discard` または認可された `bolt abort --discard` が保存したファイルを回復します。`--parked` なしでは、選ばれた intent の Bolt について最新の保存された `/head` を選び、それありでは正確なその stamp を選びます。stamp は、任意の数値の `-N` 衝突サフィックス付きの UTC `YYYYMMDDTHHMMSSZ` で、最新の選択のために数値順に並びます（`-10` が `-2` に続きます）。1つのリポジトリだけに存在する正確な stamp は、一般的な slug の曖昧さより先にそのリポジトリを選びます。選択がなお曖昧なら、`--repo <name>` が既存の兄弟 Git リポジトリを、`--repo .` がプロジェクトルートを選びます。回復は、同じ slug の `WORKTREE_CREATED` または `WORKTREE_DISCARDED` 監査の `Repo` フィールドに名づけられた有効な Git リポジトリを、その兄弟名がシンボリックリンクであっても受け取ります。フレームワークは、試行の worktree やパークを記録したまさにその場所で回復できます。その受け入れは slug スコープです。他の slug の記録が、この slug のリポジトリセットを決して広げません。現在または過去の intent のリポジトリリストのメンバーシップだけでは、シンボリックリンクを受け入れられません。intent リストの候補と記録されていない発見された兄弟は、その正規パスが正規のワークスペースルートの直下に留まる実在の直下の子ディレクトリでなければなりません（`isWorkspaceRepoDir`）。任意のパスと、同じ slug の監査来歴のないシンボリックリンクのエイリアスは拒否されます。Restore と purge は、このセレクタを現在の intent のリポジトリリストから独立に解決します。これは、ライブの worktree の create/discard コマンドのセレクタを変えません。ワークスペースのコンテキストを解決するのに必要なとき `--intent` / `--space` を使います。両方の回復コマンドは、選択や変更の前に未知のフラグと重複のフラグを拒否します。`--raw` は素の restore 専用のフラグで、purge は受け取りません。

人が試行の回復を頼むとき、コンダクターは成功した discard の中断の保存された `restore_operation` を、コマンド文字列ではなく使います。このタイプ付きの `EngineInvocation` はルート `worktree` を持ち、stamp が分かっているとき args `["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]` を持ちます。`aidlc engine worktree <args...>`（インストール済みの `aidlc engine worktree` ルート）を呼び出し、リストされた各 arg を別々の argv 引数としてそのまま渡します。args をシェルコマンドに結合したり slug だけの選択を再構築したりしません。リポジトリのセレクタは常に存在します。兄弟名か、ルートには `.` です。末尾のセレクタは、アクティブな intent が変わった後も、所有する intent を固定します。返されたすべての引数を保ちます。

`restore_hint` は、その操作から `renderEngineInvocation` がレンダリングする任意の人向けの表示テキストで、ネイティブ/ソースの選択、ハーネスディレクトリの検証、シェルセーフな引数のクォートを伴います。レンダリングが throw すると（たとえば無効なハーネスディレクトリ）、ヒントは省かれ `restore_hint_error` が理由を含みます。操作は使えたままです。レンダリングされたヒントの有無ではなく、`restore_operation` に基づいて復元を提供します。ヒントはコンダクターの実行入力ではなく、その不在は証拠のみの試行を確立しません。これはどの abort の引数、ガードの受け入れ、人の同意の要件も変えません。`worktree discard` は `parked_ref` と `parked_commit` を保ち、`parked_stamp`、`parked_mode`（`snapshot`、`branch-tip`、`evidence-only`）、`parked_repo`（プロジェクトルートは `null`、そうでなければ兄弟名）を加えます。`bolt abort` は `reason: "aborted"` を保ち、供給された `--reason` のテキストを追加の `abort_reason` フィールドにエコーします。常に `parked_ref` を含み、何もパークされなかったときは `null` です。非 null の `parked_ref` だけが `parked_stamp`、`parked_mode`、`parked_repo` を加えます。レビューの証拠だけが残ったとき、discard は `parked_mode: "evidence-only"` と `parked_commit: "-"` を報告します。abort はその4つのデスクリプタのフィールドを保ちますが、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` を省きます。

`snapshot` について、abort は `parked_excludes: ["ignored files", "eol/text=auto normalization"]` を報告します。`branch-tip` について、`["uncommitted files (no working tree existed)"]` を報告します。コミットされた作業だけが保てました。保存された名前空間は分かっているがその discard デスクリプタが使えないとき、フォールバックは、その stamp が厳密にパースされるときだけ `parked_ref` から `parked_stamp` を導出し、そうでなければ `null` を報告します。`parked_mode` と `parked_repo` を `null` にし、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` を省きます。保存されたモードもリポジトリも分からないためです。代わりに `recovery_hint` が、脇に置かれた試行とその正確な restore コマンドをリストするため doctor を実行するよう人に求めます。ヒントは平易なガイダンスで、実行可能な操作ではありません。このフォールバックは、どのファイルが保存されたかを確立せず、復元の申し出を正当化しません。名前空間が保存されなかった（`--discard` なしを含む）とき、`parked_ref` は `null` で、`parked_stamp`、`parked_mode`、`parked_repo`、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes`、`recovery_hint` はありません。

restore はブランチ `restore/bolt-<id8>_<slug>-<stamp>` に `.aidlc/restored/bolt-<id8>_<slug>-<stamp>` を作ります。ライブの `.aidlc/worktrees/bolt-<id8>_<slug>` チェックアウトや `bolt-<id8>_<slug>` ブランチに決して触れず、中断されたライフサイクルを再開せず、レビューの権限を復帰しません。restore のパスやブランチがすでに存在すると、上書きするのではなく拒否します。`/head` のない証拠のみの回復 ref を選ぶと、`--raw` でも拒否します。

```text
no restorable files were parked for <slug> <stamp>; only review evidence was kept
```

レガシーの restore は記録された名前を保ち、選ばれた intent の正確な `WORKTREE_DISCARDED` の `Parked ref` 来歴を要します。[Bolt identity](../../core/knowledge/aidlc-shared/worktree-info-schema.md#bolt-identity) を参照してください。

| 選択 | 挙動 |
|-----------|----------|
| 素の `--raw` | 保存された blob をバイト単位で書き、マーカーとレガシーの分類をオーバーライドする。`restore_mode` は `raw-requested` |
| `/snapshot` マーカー | 保存されたワーキングツリーの blob をバイト単位で書く。`restore_mode` は `snapshot` |
| `/branch-tip` マーカー | Git の通常のチェックアウト（フィルターとエンコーディング変換を含む）を使う。`restore_mode` は `branch-tip` |
| マーカーなし（レガシー） | ツールがオーサリングしたスナップショットコミットのアイデンティティを認識する。`legacy-snapshot` には生のバイトを、`legacy-branch-tip` には通常のチェックアウトを使う |

選択は表の順に従います。生のマテリアライズは smudge/process フィルターと `working-tree-encoding` をバイパスします。より早い `eol/text=auto` の正規化を逆転させず、無視された未追跡のファイルを回復しません。生で復元されたパスは、そのフィルターのもとで変更済みと表示されることがあります。実行可能モードは保たれます。シンボリックリンクは `core.symlinks` に従います。生のサブモジュールの gitlink は、復元されたサブモジュールのチェックアウトではなく空のディレクトリになります。必須の失敗するチェックアウトフィルターは通常の restore を失敗させます。`--raw` でリトライする前に、残っている restore のチェックアウトとその restore ブランチを明示的に取り除きます。失敗した生の restore は、その部分的なチェックアウトをその場に残し、そのパスを報告します。

成功の JSON は `restored: true`、`slug`、`parked_ref`、`worktree_path`、`branch`、`reviewed_source_refs`、`raw_bytes`、`restore_mode` を含みます。`reviewed_source_refs` は、再アクティブ化された ref ではなく、保持された回復の証拠を数えます。`materialized` は `raw_bytes` が `true` のときだけ現れ、サブモジュールの gitlink を除く、通常のファイルとシンボリックリンクを数えます。返された `worktree_path` を開いて、必要なファイルを調べるかコピーします。

Bun ベースのコピーインストールでは、`aidlc engine worktree` を `bun .claude/tools/aidlc-worktree.ts` に置き換え、`.claude` をあなたのハーネスディレクトリに置き換えます。回復のウォークスルーは [getting the files back](15-troubleshooting.md#a-bolt-attempt-was-set-aside-getting-the-files-back) を、スナップショットの契約は [State Machine](../reference/12-state-machine.md) を参照してください。

### `aidlc engine worktree purge` — 回復 ref を取り除く

```bash
aidlc engine worktree purge --slug <slug> [--parked <stamp> | --older-than <days>] [--repo <name|.>] [--intent <intent>] [--space <space>]
```

purge は、スナップショット/branch-tip のマーカーとレビューされたソース ref を含む、ローカルの回復 ref を compare-delete します。セレクタなしでは、選ばれた intent の Bolt のすべての保存された stamp を取り除きます。`--parked <stamp>` は1つの正確な stamp を選びます。`--older-than <days>` は、分数を含む非負の有限の日数を受け取り、そのしきい値より厳密に古い stamp だけを選びます。年齢は stamp の UTC `YYYYMMDDTHHMMSSZ` の部分から計算され、任意の `-N` 衝突サフィックスを無視します。コミット日はそれに影響しません。`--parked` と `--older-than` は組み合わせられません。共有の厳密なカレンダーパーサーは、あり得ない日付と時刻を正規化せず拒否します。`--older-than` では、パースできない stamp は生き残り `skipped_unparseable` に現れます。しきい値ちょうどの試行も生き残ります。正確な stamp または全 stamp の purge は、パースできない stamp を取り除けます。

purge は、選ばれた試行のどれかが復元されたチェックアウト（別の場所に移されたものを含む）を持つ間、拒否します。先にそのチェックアウトを明示的に取り除きます。ライブの Bolt のチェックアウトやブランチを決して取り除きません。成功の JSON は `{purged: <number-of-refs>, slug, stamps: [...], skipped_unparseable: [...]}` です。カウントは試行ではなく ref です。`skipped_unparseable` は常に存在し、`--older-than` がパースできない stamp をスキップしない限り空です。Restore と purge は監査イベントを加えません。

`/aidlc --doctor` と `aidlc doctor` は、保存された `/head` エントリや実際のレビューされたソース ref が存在するとき、**Parked attempts** の情報的なセクションを、通常と verbose の両方の出力で表示します。各エントリは、slug、正確な stamp、日数での年齢、モード（`snapshot`、`branch-tip`、`legacy`、`evidence-only`）、正規の復元されたチェックアウトの存在、そしてタイプ付きの回復の操作を含みます。JSON では、すべてのエントリが `purge_operation` を持ち、復元可能なエントリだけが `restore_operation` を持ちます。それぞれ、ルート `worktree` と、`purge` または `restore` で始まる args、続けて `["--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]` を持つ `EngineInvocation` です。コンダクターはそのルートを、各 arg を argv としてそのまま、シェル用に文字列を結合せずに呼び出します。任意の `restore_command` と `purge_command` は人向けの表示のための安全なレンダリングです。レンダリングが throw すると、対応するコマンドは省かれ、`restore_command_error` または `purge_command_error` が理由を説明し、操作は残ります。証拠のみのエントリは、purge の操作とそのコマンドまたはエラーのフィールドだけを持ちます。doctor は上記と同じ slug スコープの回復リポジトリの候補セットを使います。移された チェックアウトは doctor で復元済みと表示されないことがありますが、purge はなおその Git 登録を確認します。名前空間を持つ試行は、その所有者を intent レジストリの UUID を通じて解決します。レガシーの試行は、所有者の監査の正確な discard された `Parked ref` を要します。未知または曖昧な所有者と、帰属のないレガシーのパークは省かれます。doctor は同じ厳密な stamp パーサーを使います。あり得ない日付と時刻は JSON で `age_days: null` を持ち、人が読める出力で `unknown` を示します。これらのエントリは警告や失敗を生みません。ネイティブのコマンドなしで purge を実行するときは、restore 用に文書化されたコピーインストールのプレフィックスを使います。

### `aidlc engine workspace codekb` — コード知識のディレクトリを解決する

公開の読み取り専用クエリを使います。

```bash
aidlc engine workspace codekb --repo <repo>
```

アクティブなスペースの決定的な `aidlc/spaces/<space>/codekb/<repo>/` のパスを表示します。`--json` を加えると `{space, repo, dir, record, intent, stage, staged}` です。アクティブな記録、その intent の slug、リポジトリの Reverse Engineering のステージングフォルダとそこにすでにあるファイル（`record` と `intent` は作業が選ばれていないとき `null`）も、すべてプロジェクト相対のパスです。クエリは何も書かず、ディレクトリを作らず、監査イベントを発行しません。reverse-engineering のステージの文章が同じルートを呼び出すので、パスは決して手で導出されません。

### `aidlc-utility codekb-snapshot` — スキャンをソースとストアの世代にバインドする

これは **直接のユーティリティ呼び出し** で、`/aidlc codekb-snapshot` コマンドではありません。

```bash
bun .claude/tools/aidlc-utility.ts codekb-snapshot \
  --repo <repo> --paths src/payments/,src/catalog/ --json
```

reverse-engineering のスキャンの直前に、このコマンドは、完全な共有 CodeKB の世代に加えて、スキャンが調べるパスにわたるソースのフィンガープリントをキャプチャします。ソーストークンは、使えるときは Git ワーキングツリーのフィンガープリントを、Git の外ではバイト正確なツリーのフォールバックを使います。要求された各パスの下で、両方とも `.csproj`、`.fsproj`、`.vbproj` ファイルの隣の .NET の `bin/`、`obj/`、`out/` を外し、フォールバックは `node_modules/` のような依存とキャッシュのディレクトリと `.DS_Store` のようなツールの副産物のファイルもスキップするので、スキャン中の `dotnet build` がそれを無効にしません。`--paths` で名づけられたパスは常に読まれます。ワークスペースルートがリポジトリルートのとき、両方とも AI-DLC 自身のファイルも、`codekb-scope-diff`（下記）がするように外します。スペース+リポジトリのロックが、2つの値が同時の公開をまたぐのを防ぎます。返される `store_generation`、`source_fingerprint`、`paths` は `codekb-publish` の入力です。`head_commit` は知識ベースの Run Record が名づけるコミットです（Git の外、または最初のコミットの前は `unknown`）。

### `aidlc-utility codekb-publish` — ガードされた全成果物の公開

これは **直接のユーティリティ呼び出し** で、`/aidlc codekb-publish` コマンドではありません。

```bash
bun .claude/tools/aidlc-utility.ts codekb-publish \
  --repo <repo> \
  --staged <record>/.aidlc-engine/codekb-stage-<repo>/ \
  --paths src/payments/,src/catalog/ \
  --expect-store <generation> \
  --expect-source <fingerprint> \
  --json
```

ステージングされたディレクトリは、ちょうど9個の CodeKB 成果物を含まなければなりません。公開は、同じスペース+リポジトリのロックを取得し、両方のスナップショットの値を再確認し、timestamp の最終スコープのフィンガープリントを検証し、完全な候補を、ロールバックとクラッシュ回復とともに共有ストアにスワップします。同時の CodeKB の公開は `CODEKB_STORE_CHANGED` を返し、何も公開せず、last-writer-wins の上書きではなく新しい再マージを要します。strict な Guard Policy のもとでのソースの動きは `CODEKB_SOURCE_CHANGED`（または `CODEKB_CANDIDATE_STALE`）を返し、新しいスキャンまで何も公開しません。`relaxed` または `off` のもとでは、スキャンはキャプチャされたとおり公開され、コードをもう一度スキャンしたいか尋ねる1行（`--json` では `change_notices`）が付きます。

公開が成功した後、ユーティリティはステージングされたディレクトリを1ステップで脇に改名し、次に9個の各ファイルを、ちょうど公開したバイトと照合してすぐ取り除き、最後に空になったディレクトリを再帰なしで取り除きます。JSON の結果は `"staged_removed": true` を報告します。読まれた後に何かが変わった、または取り除きが失敗したとき、ユーティリティは、取り除いたファイルをそれらの公開されたバイトから再構築し、ディレクトリを丸ごと戻します（または、ステージングのパスがその間に再作成されたときは、改名したコピーをその隣に保ちます）。`"staged_removed": false` を報告し、保たれたディレクトリを stderr で名づけます。

### `aidlc-utility codekb-scope-diff` — 再実行の前にコード知識ベースを確認する

これは **直接のユーティリティ呼び出し** で、`/aidlc codekb-scope-diff` コマンドではありません。

```bash
bun .claude/tools/aidlc-utility.ts codekb-scope-diff --repo <repo>
bun .claude/tools/aidlc-utility.ts codekb-scope-diff --repo <repo> --compare <timestamp.md>
bun .claude/tools/aidlc-utility.ts codekb-scope-diff --repo <repo> --mint --paths src/payments/,src/billing/
bun .claude/tools/aidlc-utility.ts codekb-scope-diff --repo <repo> --check <timestamp.md>
```

reverse-engineering の再実行ガードです。codekb ストアはスペースレベルで intent 間で共有されます。フルの再スキャンがそれを置き換え、フォーカススキャンが新しい知識を累積的にマージするので、ステージはまず確認します。

- **Status モード**（デフォルト）は、ストアの `reverse-engineering-timestamp.md` の Scope of Analysis ブロックを読み、その分析されたパスにわたる内容のフィンガープリントを再計算します。判定は `NO_STORE`（最初のスキャン）、`CURRENT`（分析されたパスが変わっていない。再利用は安全）、`STALE`（分析されたパスが変わった）、`UNVERIFIED`（計算可能なフィンガープリントがない。たとえば git ワークツリーでない）、`UNKNOWN_SCOPE`（ストアがスコープ追跡より前）、`SCANNED`（このステージの実行がすでにリポジトリをスキャンしストアを公開した。そのリンク連鎖全体が、ステージが最後に始まった、ジャンプされた、変更を頼まれた以降に記録されている。再利用も再スキャンもなし）です。
- **Compare モード**（`--compare <incoming timestamp.md>`）は、入ってくる実行のスコープがストアのものをカバーするかを答えます。`COVERS`、または `NARROWER` に加えて deep カバレッジとしてもう主張されない正確なパスとコンポーネントです。`COVERS` はフォーカスマージのバックストップです。マージされたスコープがストアの検証済みのカバレッジを保ったことを意味します。`kind: full` のスコープはリポジトリルート（`./`）を含まなければならず、別のフルのスコープだけが、`NARROWER` の警告なしにフルのストアをカバーできます。古いまたは未検証のフォーカスマージでは、既存の文章が保たれ、検証できない分析されたパスは `shallow.paths` に降格されます。
- **Mint モード**（`--mint --paths <a,b,...>`）は、アーキテクトが合成時にスコープブロックに貼り付けるフィンガープリントを表示します（git ワークツリーの外、または pathspec が無効なとき `unknown`）。
- **Check モード**（`--check <timestamp.md>`）は、公開用に書かれた timestamp（ステージングされた候補など）を読み、そのスコープブロックが記録するものと、そのフィンガープリントがいま（`current`、`stale`、`unknown`）ソースと一致するかを持つ `VALID`、またはパーサーの理由を持つ `INVALID` を表示します。ストアを要しないので、最初のスキャンが公開の前にその候補を確認できます。

構造化された形には `--json` を加えます。常に判定を出力に持って 0 で終了します（usage エラーを除く）。何も書かず監査イベントを記録しません。1つの例外があります。比較されるファイルが、アクティブな intent 記録の `inception/reverse-engineering/` の、比較されるリポジトリについてのステージ自身の `scope-draft-<repo>.md` のとき、比較は判定にかかわらずそれを取り除き、そう言います（「The scope draft has been removed.」、または `--json` では `"draft_removed": true`）。フィンガープリントは、分析されたパスに制限された一時的なインデックスにわたる `git write-tree` で、その隣に一時的なオブジェクトストアがあります。リポジトリ自身の `.git` には何も書かれないので、ハーネスのサンドボックスが `.git` を読み取り専用に保つところでも機能し、オブジェクトを残しません。ワークスペースルートがリポジトリルートのとき、スキャンが決して読まない AI-DLC 自身のファイルを外します。`aidlc/` ワークスペース、ハーネスディレクトリ（`.claude/`、`.kiro/`、`.codex/`、`.cursor/`、`.opencode/`、`.aidlc/`）、`aidlc` という名前のエージェント・フック・スキルと、`.github/` と `.agents/` の下の生成されたステージランナー、インストール済みのハーネスの射影が書くすべてのルートファイル（`.gitignore`、`AGENTS.md`、`.mcp.json`、`.vscode/settings.json`、`opencode.json`、Cursor の `install.ts` など）、そして `aidlc.settings.json` と `aidlc.settings.local.json` です。だから AI-DLC の更新、設定の変更、インストールのコミットはストアを `CURRENT` のままにし、プロジェクト自身のファイルへの変更だけがそれを `STALE` にします。codekb/state の成果物が書かれるとき自身を無効にせずにソースのワーキングツリーの内容を追跡し、履歴を書き換えるリベースやスカッシュはそれを騙せず、編集を戻すと元のフィンガープリントが復元されます。

### `aidlc-utility detect` — 読み取り専用のワークスペーススキャン

`bun .claude/tools/aidlc-utility.ts detect --json` は、ワークスペースのスキャン（プロジェクトタイプ、言語、フレームワーク、ビルドシステム、宣言された git サブモジュールとその初期化状態の `submodules` 配列）に加えて、解決されたスコープのディレクトリとスコープグリッドのパス、そして `proposalPath`（コンポーザーが `validate-grid` が確認する前にそのグリッドを書く、プロジェクト相対のファイル `aidlc/spaces/<space>/intents/.aidlc-engine/composer-proposal.json`、git が無視する）を表示します。純粋な読み取りです。コンポーザーが、現在のハーネスでスコープデータがどこにあるかを知るためにそれを実行します。

### `aidlc engine workspace reclassify` — 新しいプロジェクトか既存のコードか

`aidlc engine workspace reclassify --project-type <greenfield|brownfield> [--intent <slug>] [--space <name>] [--message <id>] [--then-rerun]` は、ワークフローの途中の `/aidlc --project-type` と「このフォルダに今はコードがある」の質問への回答の背後のコマンドです。フォルダをもう一度スキャンし、1回のロックされた書き込みでタイプを人のものとして記録し、`WORKSPACE_RECLASSIFIED` としてまず監査します。`next` が表示するステップは、タイプを言った人のメッセージの id でエージェントが埋める `--message <id>` を名づけ、名づけられるメッセージの id と時刻を持ちます。エンジンは `config set` のようにそのメッセージを証明し、監査行がそれを `Message Id` として、その語を `Person Reply` として記録します。語のファイルは書かれません。ワークフロー自体を決して動かしません。Reverse Engineering を現在のステージの後ろに戻すとき、次の `next` がそれを走らせる redo のジャンプを名づけます。完了またはアーカイブされた作業では、タイプを記録しプランをそのまま残します。その返信は、ワークフローを続ける `done` ディレクティブです（`--then-rerun` では、同じリクエストがもっと頼んだときに使われ、同じ `next` をもう一度実行する `print`）。あなたが聞くのは、エージェントが話す次のステップとともに言われます。新しいタイプと見つかったもの、コードがある前に走ったステージとそれをどう redo するか、そしてタイプが変わるときそれをどう undo するか、です。コードが次に文書化されることは、redo のジャンプが走るときに言われるので（「Once you approve the code's documentation, we're back at Practices Discovery.」）、同じ息で頼まれた Reverse Engineering のスキップはそれを決して聞きません。

### `aidlc-workspace-sync` — 宣言されたリポジトリのセットをクローンし突き合わせる

これは **直接のツール呼び出し** で、`/aidlc workspace-sync` コマンドではありません。ワークスペースルートの任意の `repos.json` マニフェストに対してマルチリポジトリのワークスペースを突き合わせます（[Declaring the repo set](03-spaces-and-intents.md#declaring-the-repo-set-optional-manifest) を参照）。

```bash
aidlc system workspace-sync [--force]
```

それは、ライブの所有者が年齢で決して reap されないワークスペースロックで突き合わせをシリアライズし、次にクローンと生成されたファイルをステージングする前に読み取り専用の事前チェックを実行します。生成された出力は、no-replace のリンクと、可逆の同一ファイルシステムの改名でインストールされます。ステージングの間に `.gitignore` や `aidlc.code-workspace` が変わる、またはプランが読まれた後に `repos.json` が変わると、sync は古い状態を適用したり編集を上書きしたりするのではなく中断します。正常に置き換えられた以前の生成ファイルは、検査のために無視される `.aidlc-workspace-sync-recovery-*` ディレクトリの下に残ります。途中で切れた実行が残したステージングの `.aidlc-workspace-sync-txn-*` フォルダも無視され、削除できます。ツールは、`repos.json` で宣言されディスクにないリポジトリをクローンし、ワークスペースの `.gitignore` の管理ブロックをリポジトリごとに1つの `/{name}/` 行（加えてその2つの自分のフォルダパターン）に書き直し、ルートと各子リポジトリをリストする `aidlc.code-workspace` VSCode マルチルートファイルを書きます。Copilot のプロジェクトでは、そのファイルは VS Code のエージェントリクエストの上限 `"settings": { "chat.agent.maxRequests": 200 }` も運び、まだ settings のないファイルに一度加えられます。その settings にすでにあるキーと値は保たれます（ファイルは書き直されるので、その中のコメントは保たれません）。宣言された `branch` は新しいクローンにチェックアウトされます。すでにディスクにあるリポジトリは決して再クローンも切り替えもされません。そこのミスマッチは advisory のままです。

孤児のチェックアウト（ディスクにあるが `repos.json` にない）は実行をブロックし、`--force` を渡し、ツールがそれにローカルのみの状態がないと証明できるときにだけ、アクティブな兄弟のセットから取り除かれます。その証明は構成可能なステータスのデフォルトをオーバーライドし、未追跡と無視のファイルとディレクトリ（空のディレクトリを含む）、隠れたインデックスの状態、stash、ref と reflog、到達できない Git オブジェクト、リンクされた worktree、サブモジュール、LFS のオブジェクトストアを含みます。キャッシュされたリモート追跡の ref を信じる代わりに、各実在のリモートに問い合わせ、次に一致するオブジェクトグラフを隔離されたプローブにフェッチするので、広告されたが提供できない OID が取り除きを認可できません。そのストレージやオブジェクトの alternates がチェックアウトに依存するローカルのリモートは、回復としてカウントできません。

ライブリモートの証明の後、チェックアウトはトランザクションの隔離に移り、フルのローカルとライブリモートの証明をもう一度受け取ります。その隔離されたコピーは、再帰的に削除されるのではなく、無視される `.aidlc-workspace-sync-recovery-*` ディレクトリの下に保たれるので、すでにディレクトリを開いて保持しているプロセスが、証明とクリーンアップの間の遅い書き込みを失えません。保たれたチェックアウトと生成ファイルのバックアップを検査し、次にもう要らなくなったら回復ディレクトリを手動で削除します。どんな不確かさも手動のレビューのためにブロックします。終了コードは `0` 完全に同期、`1` ブロックまたはエラー（ライブのパスは変わらず）、`2` 同期されたが advisory の警告が残る（既存のチェックアウトのブランチのミスマッチなど）です。

マニフェストは任意で、ディスクを決してオーバーライドしません。intent の作成はなお、実際に存在する兄弟リポジトリを自動検出するので、このツールは宣言されたセットを再現し整えるだけです。`--doctor` はそれについて3つの advisory の行（コミットされていない `aidlc/` 記録、`repos.json` 対ディスクのドリフト、古い管理された `.gitignore` ブロック）を運びます。すべての advisory の行と同じく、それらは doctor の終了コードを決して変えません。

### プラグインの状態

`/aidlc plugin list` は、インストール済みのプラグイン名と各々が有効かを表示します。`/aidlc plugin select [names]` は公開コマンドです。`select-plugins` はその直接のユーティリティ形式で、`/aidlc select-plugins` コマンドではありません。`bun .claude/tools/aidlc-utility.ts select-plugins` は、現在の選択（`plugins` キーがないときは `all enabled (no selection)`）と既知のプラグイン名を表示します。設定するにはカンマ区切りのリストを渡します。

```bash
bun .claude/tools/aidlc-utility.ts select-plugins test-pro
bun .claude/tools/aidlc-utility.ts select-plugins aidlc,test-pro
```

複数のハーネスがインストールされたプロジェクトでは、`--harness-dir <dir>` が変えるインストールを名づけます（`aidlc engine plugin select aidlc --harness-dir .kiro`）。下記の `plugin sync` と同じです。それなしでは、ネイティブの `aidlc` が最初のもの（あれば `.claude`）を変えます。

コマンドは、名前を検証し、`.claude/tools/data/harness.json` を書き、新しく無効になったプラグインのマージされた貢献をコア のステージソースから剥がし（compose が書いたサイドカーを通じた構造的な追加、そのセンチネルマーカーを通じたスプライスされた文章。再有効化は次のセッション開始時に、または Kiro CLI と opencode ではプラグインのフォルダで `aidlc engine plugin sync --plugin-root <folder>` を実行したときにそれらを復元します）、無効なノードを `enabled:false` とマークしてフルグラフを再コンパイルし、ステージとスコープのランナーを prune/再生成し、生成されたスコープとステージの表（`tables.md`、オーケストレーターのスキルの隣）を1つのトランザクションでリフレッシュします。`aidlc` はコアです。それを省くと、常にオンの Initialization ステージを除くコアの画面を無効にします。アクティブなワークフローを立ち往生させる変更（そのスコープ、または新しい選択が無効にするプラグインが所有する、そのプランの保留中の EXECUTE ステージ）は、各依存を名づけて拒否されます。先にワークフローを完了またはアーカイブするか（パークされたワークフローは再開時になおそのプラグインを要します）、プラグインを有効のまま保ちます。ベースプラグインを省いてそれに基づくプラグインを保つと、そのプラグインを一時停止します。リストはタイプされたとおり書かれ、1行が、プラグインもオフにするコマンドとともに一度そう言い、そのベースがオフの間プラグインが加えるものは何も走らず、`plugin list` はそれを `paused` と表示し、ベースをオンに戻すと次のセッション開始時にそれを戻します（Kiro CLI と opencode では、プラグインのフォルダで `aidlc engine plugin sync --plugin-root <folder>` を実行したとき）。ベースをオンにする select がどれかを一度言います。

`/aidlc plugin sync`（`aidlc engine plugin sync`）は、ホストのプラグインインベントリからインストール済みのプラグイン compose フックを実行し、終わると `plugin sync complete: <n> plugin(s)` を表示します。繰り返し実行して安全です。ベースプラグインを先に、次にそれに基づくプラグインを合成します（プラグインはコアと最大1つのベースに基づき、そのマニフェストの `dependencies` で名づけられます）。そのベースに合成できないプラグイン（インストールされていない、プラグインのバージョン範囲の外、別のプラグインに基づく、2つのベースが名づけられる）は保留されます。sync が complete の行の後に1行で一度理由を言い、他のすべてのプラグインを合成して 0 で終了し、`--json` が `data.held` にそれをリストします。`aidlc engine plugin list` と doctor は、sync がそれを合成するまで行を保ちます。以前に合成された保留のプラグインはそのまま残ります。二度インストールされたプラグイン（その古い `aidlc-<name>` のコピーが再ビルドされたものの隣）は再ビルドされたものから合成し、sync は実行のたびに古いコピーの remove コマンドを名づける1行を表示し、`--json` で `data.superseded` としてリストします。session-start フックが自分のプラグインだけを名づけるホストでは、フックはそのプラグインのインストール済みベースを先に合成します。無効なエントリのあるインベントリ、または `hooks/compose.ts` のないプラグインルートは、sync 全体を拒否し、何が悪いかを名づけるので、何も半分合成されません。`--plugin-root <dir>` は合成するインストール済みのプラグインを名づけ、`AIDLC_PLUGIN_ROOT` がするのと同じです。Kiro IDE のフォルダにドロップされたフックは、プラグイン自身のフォルダ `./.kiro/aidlc-plugins/<name>` を渡します。`--harness-dir <dir>` は合成先のハーネスフォルダを名づけ、`AIDLC_HARNESS_DIR` がするのと同じで、複数のハーネスがインストールされたプロジェクト用です。Kiro CLI、Kiro IDE、Cursor、Copilot、opencode はインストール済みのプラグインのリストを保たないので、そこでのプラグインフォルダなしの sync は何も合成せず、プロジェクトで合成される各プラグインのコマンドを名づけます。

```text
$ aidlc engine plugin sync
aidlc engine plugin: Nothing synced: this tool keeps no list of your plugins, so name each one's folder: `aidlc engine plugin sync --plugin-root <test-pro's folder>`.
```

別のハーネスがプロジェクトで先に来るところ（`.kiro` の隣の `.claude` フォルダなど）では、ネイティブの `aidlc` はそれに合成するので、コマンドはハーネスも名づけます。`aidlc engine plugin sync --harness-dir .kiro --plugin-root <test-pro's folder>`。

そこで sync に送るすべての行（これ、変えたファイルのために拒否された sync、doctor の合成された面と未コンパイルステージの fix）は、行がそれを知るときプラグインの実在のフォルダとともに、同じコマンドを名づけます。Claude Code がプラグインレジストリ（`~/.claude/plugins/installed_plugins.json`）を持つ前のネイティブの Claude Code プロジェクトでは、`host inventory unavailable; run sync through an installed plugin's host hook` と言います。すべてのエンジンの再インストールまたはアップグレードの後にそれを再実行します。新しい `dist/<harness>/` のコピーは出荷のグラフとコアのステージソースを復元するので、以前に合成されたプラグインのグラフエントリと貢献のマージをもう一度適用しなければなりません。プラグイン SessionStart フックのあるホスト（Claude、Codex、Cursor、Kiro IDE）は次のセッション開始時に自己回復もします。Kiro CLI は明示的な sync を要します。

`/aidlc plugin validate [path]` と `/aidlc plugin build <harness> [outDir]` は、出荷されるスタンドアロンのオーサリングツールを、トップレベルの CLI を通じて公開します。検証はカレントディレクトリをデフォルトとします。build もそのプラグインルートをカレントディレクトリにデフォルトとします。別の場所で呼び出すときは `--plugin-root <path>` を渡します。両方とも `--json` を受け取ります。ベースに基づくプラグインの検証は `--with <base-root>`（そのベースのあなた自身のチェックアウト）を取るので、ベースのエージェントがリードするステージが、未チェックと報告される代わりに確認されます。

ターミナルから、`aidlc plugin test [path] --install <project-root>`（コピーチャンネルでは `bun .claude/tools/aidlc.ts plugin test ...`）は、出荷の compose テストを実行します。`[path]`（デフォルトでカレントディレクトリ）のプラグインを、`--install` が名づけるプロジェクトの使い捨てのコピーに合成し、compose のドロップ、グラフの失敗、ファイルを変える2回めの compose で `1` で終了します。プロジェクト自体は決して変わりません。そのプロジェクトに複数のハーネスがあるとき `--harness <name>`、ベースに基づくプラグインに `--with <base-root>`、1つの結果オブジェクトに `--json` を渡します。

### `aidlc-utility recompose` — 進行中のプランのフリップ

`aidlc engine recompose [--skip <slug,...>] [--add <slug,...>] [--sensors <on|off>] [--learnings <on|off>] [--summary-confirmation <on|off>] [--collaborators <on|off>] [--review <adversarial|advisory|none>] [--message <id>] [--reason <text>]` は、ライブの状態ファイルで、PENDING でカーソルより前のステージのプランのサフィックスをフリップします。両方のフラグはカンマ区切りのリストを受け取り、繰り返せます。すべての出現が累積し、重複する slug は一度数えられます。少なくとも1つのフリップを供給し、そのリストが空のフラグは省きます。素のフラグ、空の値、空の CSV 要素、未知のフラグ、余分な位置引数は usage エラーで、フリップは適用されません。設定フラグは、フリップとともに承認された設定を運びます。同じ状態の書き込みで適用され、その `CEREMONY_SET` または `REVIEW_CLASS_CHANGED` の行は `RECOMPOSED` の後なので、1つの承認がプランを半分変えたまま決して残しません。それらを承認した人のメッセージを名づける `--message <id>` があると、エンジンがそのメッセージを `config set` のように証明したとき、設定は `set by you` と読めます。単独の設定は `config set` を通ります。`--reason <text>` は、`RECOMPOSED` の行にプランが変わった理由を記録します。ジャンプがスキップされたステージをプランに戻すとき、エンジンがそれを渡します。完了した作業（`Status: Completed`）では何も変えません。拒否が、最後のものより後に頼まれたステージを走らせるプランを名づけ、1つに切り替える（`/aidlc --scope <plan>`）とそこで作業を再び開きます。

```bash
# Equivalent ways to skip both stages after approval:
aidlc engine recompose --skip market-research --skip team-formation
aidlc engine recompose --skip=market-research,team-formation

# Add both pending stages back:
aidlc engine recompose --add market-research --add team-formation
```

Feasibility が進行中の `mvp` プランで走る作業では、Rough Mockups だけをスキップするのは拒否されます。Refined Mockups がそれが書くものを要するためです。両方をスキップすると通り、それらを戻すと undo します。

```text
$ aidlc engine recompose --skip rough-mockups
{"error":"Recompose rejected by the strict validator:\n  - Stage \"refined-mockups\" requires artifact \"wireframes\" whose producer(s) [rough-mockups] are not on the \"recomposed mvp\" path. Strict (recompose) mode rejects a starved required input.\n  - Stage \"refined-mockups\" requires artifact \"user-flow\" whose producer(s) [rough-mockups] are not on the \"recomposed mvp\" path. Strict (recompose) mode rejects a starved required input.\nTo make the change, also add a stage that produces what is missing, or also skip the stage that needs it."}
$ aidlc engine recompose --skip rough-mockups,refined-mockups
Recomposed: 2 skipped (rough-mockups, refined-mockups), 0 added (none)
Stages in scope: 20
Completed: 4/20
$ aidlc engine recompose --add rough-mockups,refined-mockups
Recomposed: 0 skipped (none), 2 added (rough-mockups, refined-mockups)
Stages in scope: 22
Completed: 4/22
```

監査ロックのもとで走り、残りのステージを必須の入力で飢えさせるフリップを拒否します（`/aidlc --skip` で名づけたスキップを除く。その後、それを読むステージはあるものから走ります）。完了済み/進行中のステージ、カーソルより後ろのステージ（Construction が始まる前の Reverse Engineering は例外です。`next` がなおそれを走らせに戻る間はスキップでき、既存のコードでは戻せます。プランがスキップし、作業がちょうど通り過ぎて後ろで何も始まっていないステージ、たとえば Requirements Analysis が承認された直後の User Stories も同様です。戻せて、`next` が走らせに戻ります）、Construction の最初の EXECUTE ステージ（保護されたステージルーティングのアンカー）をどちらの方向にも動かすフリップ、Status が Running でないワークフローに対するどの recompose、そして自律的な Construction のもとで、あなたのリクエストの記録のない recompose、または `AIDLC_UNATTENDED=1` で実行されたもののフリップも拒否します。その拒否は `aidlc-bolt.ts set-autonomy --mode gated` を名づけ、各 Bolt で承認のために止まるように切り替えます。導出された状態フィールドを再構築し、`RECOMPOSED` を発行します。各ステージの拒否は、代わりにできることを名づけます。ステージにまたはそれを越えてジャンプ、`/aidlc --stage <slug> --single` で単独で実行、欠けた入力が関わるステージを追加またはスキップ、それを走らせるかスキップするスコープに変える、です。`/aidlc --skip <slug>`、`/aidlc --add <slug>`、スキップされたステージへのジャンプ、ワークフロー途中の `/aidlc compose` を通じて到達し、直接はタイプされません。`/aidlc compose` の質問で承認した変更（そのマーカー `aidlc/.aidlc-compose-pending` がディスクにあり新しい）については、出力がエージェント向けにもう1行で終わります。マーカーを削除し `next` を実行するので、あなたの作業が同じターンで続きます。

この作業がスキップしたステージを、AI-DLC が名づける undo で、または後であなた自身の言葉で戻すことも拒否されません。ステージは、スキップの前にプランが持っていたとおりに判断されます。

その場でスキップされたステージ（スキップしたとき始まっていたので、スキップとして表示される）は、`/aidlc --add <slug>` で、またはあなた自身の言葉でもう一度加えるとプランに戻り、次に走ります。Construction が始まっていない既存のコードでの Reverse Engineering（その後、作業はあなたがいたステージに戻ります）、そして作業がその後のステージにちょうど入ったばかりの他のどのステージもです。作業がさらに進むと、add は、ステージを単独で実行する方法 `/aidlc --stage <slug> --single` とともに拒否されます。

### `aidlc engine scope save` — プランをスコープとして保つ

`aidlc engine scope save --name <name> [--keywords <word,...>] [--intent <slug>] [--space <name>]` は、選ばれた作業の現在のプランを再利用可能なスコープとして保ちます。プランが走らせるステージ、その深さ、Guard Policy、5つの儀式の設定（sensors、learnings、summary confirmation、plan approval、collaborators）、その review レベルを、耐久的な記録 `aidlc/scopes/<name>.md` に書き、次にコンパイルするので、`/aidlc --scope <name>` がこのハーネスですぐ機能します。別のハーネスは次の `graph compile` でそれを拾います。走行中の作業はそのまま残ります。別のプランがすでに持つヒントは、それを名づける1行とともに頼まれたとおり保存されます。コンダクターは、「save this plan as quick-fix」と言うとそれを実行します。compose ゲートで **Approve and save as scope** を選ぶと、作業を作る一部として同じ save を実行し（`--save-as`）、またはキーワードも与えたときは、代わりにその直後に実行します。

たとえば、`mvp` プランで走る作業では、

```text
$ aidlc engine scope save --name quick-fix
Saved as scope quick-fix (20 stages, sensors on, learnings on, summary confirmation on, reviews adversarial).
Next time: /aidlc --scope quick-fix "<what to build>"
```

名前は、小文字、数字、単一のハイフンで、文字で始まり、最大40文字で、すでにスコープを名づけていてはなりません。`--keywords` はスコープをリクエストの語から推論可能にします。各キーワードは、文字、数字、ハイフンの1語で、`validate-grid --keywords` がするように、他のスコープが主張するキーワードに対して確認されます。それなしでは、スコープは `keywords: []` を出荷し名前でのみ解決します。greenfield の実行の reverse-engineering のスキップは保存されないので、スコープはなお既存のコードベースを reverse-engineer します。`SCOPE_SAVED` を発行します。サブエージェントはそれを実行できません。

### 自分のステージ変更を持つワークフローの作成（`--skip` / `--add`）

`next --scope <scope> --skip <slug,...> --add <slug,...> -- "<description>"` は、この作業にだけステージが落とされたり追加されたりした `<scope>` のワークフローを作ります。コンダクターがカスタムで構成されたプランについてそれらを渡し、あなたもそれらをタイプできます。プランを名づけないリクエストとともにタイプすると、それらはプランの質問であなたのものです。Go ahead は提案されたプランをそれらとともに作り、そのリストから選ぶ別のプランも同様で（プランがすでに外すか走らせるステージはそのプランで外されます）、Tailor a plan はそれらをコンポーザーに渡すので、それが示すプランはそれらを持ちます。各 slug はステージを名づけなければなりません。initialization のステージ、両方のリストにあるステージ、スコープがすでに行う変更（それがスキップするステージの `--skip`）は、何も作られる前に拒否されます。作業の状態は `Plan: <name>` を記録し（`--plan-name <name>`、コンダクターがコンポーザーの提案した名前とともに渡します。小文字、数字、ハイフン。それなしでは `tailored plan`）、スコープファイルは書かれません。`--save-as <name>`（コンダクターが **Approve and save as scope** について渡します）があると、作成は `scope save` がするように、その名前でプランをスコープとしても保存します。取られている、またはスコープを名づけられない名前は、何も作られる前に拒否されます。走行中のワークフローでは、`/aidlc --skip <slug,...>` と `/aidlc --add <slug,...>` が、承認の質問なしに（あなたがステージを名づけました）`recompose` を通じてその残りのステージをすぐ変え、何が変わったかと戻る道を1行で言います。同じコマンドでタイプされたスコープや設定が先に適用されます。あなたが名づける、すでに始まったステージ（進行中、変更を頼んだ後に修正中、または自分の承認の質問で待っている）は、どの種類のステージであれその場でスキップされ、作業は進むか、それがプランの最後のステージだったとき終わります（戻る道は、それを単独で実行する `/aidlc --stage <slug> --single`）。開いたゲートで同じメッセージにタイプされた承認も記録されるので、両方が一度起きます（いくつものステージを名づけた質問で、「skip Functional Design and approve the rest」はあなたがスキップしなかったものを一緒に承認します）。Construction が1ユニットずつ走る間、ユニットがいるステップは、あなたの語が言うとおり、そのユニットだけ、またはここからすべてのユニットについてスキップされます（ユニットを名づけないスキップはここからすべてのユニットについてです）。1つのユニットについての戻る道は `/aidlc --stage <slug> --unit <unit>` で、そのコードステップをスキップしたユニットはチェックポイントを持ちません。すべてのユニットを自分で作業するチームのメインチェックアウトは、スキップを同じように読みます。ユニットウォークの後のステップ、またはその後のステージ（Build and Test など）は、すべてのユニットについてプランから外れます。作業がちょうど通り過ぎたステージを加える（「Approve, and add User Stories next」が承認として先に記録される）、その後に何も始まっていないとき、戻されて次に走ります。add が先に来るときと同じです。プランが取れないフリップは、代わりにできることとともに拒否されます。

スキップの後、1行が名づける undo は、変更が名づけた最も早いステージを作業が通り過ぎるまで（追加したステージ: そのステージが始まるまで）、または、それより後にプランに何もないとき、作業が完了するまで保たれ、行がどちらかを言います。Construction が1ユニットずつ走る間、すべてのユニットについてプランから外れたユニットウォークのステップは、ウォークの後の最初のステージが始まるまで保たれます。すべてのユニットが通るまで作業がウォークに留まるためです。作業がなお負う Reverse Engineering は、最初の Construction ステージが始まるまで保たれます。その後、スキップされたステージは `/aidlc --stage <slug> --single` で単独で走ります。その直前のステージの開いたゲートでタイプされたスキップは、その方法だけを名づけます。そのゲートを承認する（同じ返信が通常そうします）と、作業がそれをすぐ通り過ぎるためです。

`--depth` と `--test-strategy` はちょうど `minimal`、`standard`、`comprehensive` を取ります。`next` は、コマンドを名づける前に他のどの値も拒否します。

### `aidlc-graph ars` — 決定的な ARS スコアリング

`bun .claude/tools/aidlc-graph.ts ars --iae <s> --csu <s> --ve <s> --r <s> --ua <s> [--completed <csv>] [--project-type <t>] [--method <codekb|fallback>]` は、適応型コンポーザーの Autonomy Risk Score の算術を計算します。そのバンドラベル付きの重み付き合成、LOW/MED/HIGH のコンポーネントバンド、出荷のコスト事前分布に対するステージごとの期待値スクリーン、グリッド差分のカウントで最も近いストックのスコープ、そして markdown として事前レンダリングされた2つのゲートテーブルです。すべての定数（重み、バンド境界、ステージコスト事前分布、EV しきい値）は `tools/data/ars-priors.json` から読まれるので、同じ5つのスコアは常に同じ数字をレンダリングします。コンポーザーは証拠からコンポーネントをスコアリングし、掛け算をする代わりにこの出力をコピーします。ファイルが名づけないプラグインステージは、その `ars:` フロントマターのブロックからスクリーンされる（両方あるときはファイルが勝つ）か、`no-prior` の行として着地します。各行の `priorSource` がどちらか（`shipped`、`stage`、`null`）を言います。`--completed`（カンマ区切りの slug）は、導出されたグリッドで、すでに EXECUTE で走ったステージを保ちます。`--project-type brownfield|greenfield` は、コンパイルされた `condition:` が別の種類のプロジェクトに制限するステージ（今日は Reverse Engineering、brownfield のみ）をスクリーンアウトします。Reverse Engineering はプロジェクトタイプで決まり、その CSU では決して決まりません。既存のコードで走り、`--project-type` なしでも走り（作成は新しいプロジェクトからそれを外します）、ステージ自身が、もう一度スキャンする前に以前のスキャンが残したコードマップを確認します。`--method` はコンポーザーの構造的な証拠のソースを名づけます。仕立てたプランの構成の間、5つのスコアとメソッドが保たれ、プランの作成がそれらをその最初の監査エントリに書きます（`WORKFLOW_STARTED`: `ARS Scores`、`ARS Method`）。`codekb` か `fallback` 以外は 1 で終了します。JSON の結果は stdout に着地します。範囲外のスコア、未知のステージ slug、事前分布スキーマの違反では 1 で終了します。黙ったフォールバックは決してありません。合成は、ゲートでの人のための **ADVISORY** な指標です。それに対して決定的にルーティングするものは何もありません。

```bash
bun .claude/tools/aidlc-graph.ts ars --iae 0.55 --csu 0.75 --ve 0.65 --r 0.50 --ua 0.55
bun .claude/tools/aidlc-graph.ts ars --iae 0.30 --csu 0.80 --ve 0.40 --r 0.20 --ua 0.10 \
  --project-type greenfield --completed intent-capture,scope-definition
```

### `aidlc-graph validate-grid` — 任意グリッドの依存チェック

`bun .claude/tools/aidlc-graph.ts validate-grid [--proposal <path>] [--strict] [--project-type <t>] [--keywords <csv>] [--guard-policy <strict|relaxed|off>] [--report] [--matched <stock-scope> | --custom]` は、任意の `{"<stage>": "EXECUTE"|"SKIP"}` JSON グリッドを検証します。`--proposal` なしでは、`detect --json` が表示する `proposalPath`、コンポーザーの提案ファイルを読みます。提案はコンパイルされたすべてのステージをちょうど一度名づけなければなりません。欠けたステージ、未知のステージ、無効なアクションはエラーです。寛容モードは `validate-scope` を映します（経路外の必須の生産者は advisory）。`--strict` はそれをハード拒否します（recompose の姿勢）。`--keywords` は、付与された各キーワードを、既存のスコープがすでに持つキーワードに対して確認します。共有されたものは、別のプランを名づける advisory で（`The hint "bug" is also bugfix's; the plan proposal lists it under both.`）、グリッドはなお検証されます（コンポーザーは、キーワードが付与されたときゲートの前にこれを実行し、`scope save --keywords` がヒントを保存し同じ行を表示します）。`--guard-policy`（または `stages` の隣の `guardPolicy` メンバー。退役した `--change-control` フラグと `changeControl` メンバーもなお解決します）は、コンポーザーの提案した Guard Policy の値を確認します。`strict`、`relaxed`、`off` 以外はエラーで、メモリレイヤーの `Mode: strict` のもとでの `relaxed` や `off` の提案はそのファイルを名づけて拒否され、受け入れられた値が `guard_policy` と `change_control` の両方としてエコーされます。`stages` の隣の `scopeSettings` メンバーは、コンポーザーの6つのスコープ設定を確認します。ちょうど `sensors`、`learnings`、`summary_confirmation`、`plan_approval`、`collaborators`（それぞれ `on` か `off`）と `review_cap`（`adversarial`、`advisory`、`none`）を名づけなければなりません。未知のキー、欠けたキー、他のどの語もエラーです。受け入れられた値が `scope_settings` としてエコーされ、`summary.off` がそれらがオフにするものをリストします。`--matched <stock-scope>` または `--custom` は、front/report の提案についてのコンポーザーのルートを名づけます。どちらも `scopeSettings` と Guard Policy を要します。どちらのルートもスコープファイルを書きません。`--matched` は、そのストックのスコープと異なるグリッドと、そのデフォルトより下の Guard Policy を拒否します（より厳しい値は作成が適用するものです）。他のどの設定も異なってよいですが、plan approval は、プランが走るスコープがそれをオンにしているところでオフにできません（ゲートで自分の言葉で人だけがそれをオフにします）。通る実行は `routing`、`matched_scope`、`creation_settings`（作成時にこの作業に適用されるタイプされた変更、たとえば `{"learnings": "off", "review": "adversarial"}`）をエコーします。`--custom` は、プランが走るストックのスコープ、Guard Policy のデフォルトが提案のものまたはそれより低い最も近いもの（`strict` にはどれでも）で、ゲートが示さないものを何も加えないもの（walking skeleton なし、プランの深さ以外のテスト戦略なし）を選びます。`--project-type greenfield` では、1つが適格ならいつでも `existing_code: true` とマークされたスコープ（`bugfix`、`refactor`、`security-patch` がマーク付きで出荷）より、新しい作業向けのものを好み、通る実行は `routing`、`base_scope`、`plan_changes`（そのスコープのグリッドをプランにする `skip` と `add` のステージリスト）、そのスコープに対する `creation_settings`、提案の `depth` メンバーがそのスコープのものと異なるときの `creation_depth` をエコーします。その `depth` メンバー（`minimal`、`standard`、`comprehensive`）を要し、どのストックのスコープもデフォルトとしないかそれより下の Guard Policy と、initialization のステージをスキップするプランを拒否します。front compose の間、通る `--matched` または `--custom` の実行は、compose ステップが開いたリクエストについてそのプランを、その `creation_depth`、その `creation_settings`、そのスコープのデフォルトより上の Guard Policy とともに保つので、カスタムプランを承認すると、ゲートが示したステージ、深さ、設定が作られます。`--matched` なしのすべての実行は、`custom_start`、カスタムプランが始まる `guard_policy` と `scope_settings`、つまり `classic` スコープの、プランが走るどのストックのスコープかのものもエコーします（`classic` が有効なスコープでないとき省きます）。すべての実行は、`matched_start`、一致したプランが運ぶストックのスコープ（`--matched` が名づけるもの、なければ最も近いもの）の `depth`、`guard_policy`、`scope_settings` もエコーするので、コンポーザーはそれらをスコープファイルではなくバリデーターから取ります。このマシンでキルスイッチ（`AIDLC_DISABLE_*`、設定または記録）がオフに強制する `on` の儀式は、advisory も得ます。スコープは `on` を保存するが儀式は走らないためです。結果は `nearest_stock`、提案からのグリッド距離でランク付けされたすべてのグラフ/プラグインオーサリングのストックのスコープ（`{scope, diff, differs}` 昇順、コンポーザーオーサリングのスコープを除く）も運ぶので、コンポーザーの matched-vs-custom の判定は、LLM の再カウントではなくバリデーターの数字です。`--report` はコードの検出結果のレポートのためのコンポーザーの実行です。`nearest_stock` はそのとき `bugfix` と `security-patch` だけをランク付けし、`--custom` はその2つからベースを選び、他のどのスコープでの `--matched` もエラーなので、レポートが、グリッドがたまたま近くにあるより軽いスコープ（レビュアーも plan approval もない `express` など）に決して着地しません。人がレポートのスコープを自分で名づけるとき、コンポーザーは `--report` なしで実行するので、彼らの選択が通ります。

`summary` は、プランが走らせるステージと承認ゲートを数えます。その `shown` のカウント、Initialization の後のステージは、人が読むすべての行が使う数です。`--project-type greenfield` では、作成が新しいプロジェクトでスキップする Reverse Engineering を外すので、プラン提案が示すカウントは作成が表示するものです。通る `--custom` の実行は、プランが、走るストックのスコープが走らせるステージを落とす（作成がスキップとして記録するステージ。Reverse Engineering は新しいプロジェクトで外されます。そこでは作成がスキップします）か、その自身の変更が、そのスコープが外さない必須の入力なしにそれが保つステージを残すとき、`skipped_inputs` を加えます。スキップされた各ステージを名前で、それが作るものを使うそれが保つステージとともに、どの保たれたステージもそうしないときは何もなし（`[{"stage": "Units Generation", "used_by": ["Contract Design", "Functional Design", "Code Generation"]}, {"stage": "Deployment Execution", "used_by": []}]`）で、プラン提案がそれを一度、1行で言います。ストックのスコープ自身の作られない入力は advisory だけのままです。

### `aidlc-sensor` — Sensor を調べ発火する

Sensor は、ステージ出力への `Write` や `Edit` のたびに走る決定的なチェックです（[Rules and the Learning Loop](09-rules-and-the-learning-loop.md) とリファレンスの [Sensor System](../reference/07-sensor-system.md) を参照）。PostToolUse フックがあなたのためにそれらを発火します。このツールは、1つを一覧、記述、手動で発火することを許します。

Sensors の儀式が `off` のとき、自動のフックディスパッチとブロッキング sensor のゲートチェックはスキップされます。フックはインストールされたままで、明示的な `fire` はここで記述された診断をなお実行します。

| サブコマンド | 何をするか |
|------------|--------------|
| `list` | すべてのフレームワークの Sensor（`id`、`kind`、`description`）をアルファベット順に表示する |
| `describe <id>` | 1つの Sensor のフルのマニフェスト（command、デフォルトの severity、`matches` glob、timeout）を表示する |
| `fire <id> --stage <slug> --output-path <path>` | ファイルに対して Sensor を実行し、`SENSOR_FIRED` 行とそのペアの結果行を発行する |

手動の fire は `SENSOR_FIRED` 監査行を、次に正確に1つの終端行を発行します。`SENSOR_PASSED`、`SENSOR_FAILED`、`SENSOR_COULD_NOT_RUN`（チェックのスクリプトがクラッシュした、起動できなかった、判定を表示しなかった）、または `SENSOR_BUDGET_OVERRIDE` で、続けてコンパクトな JSON の判定行です。失敗は `<record>/.aidlc-engine/sensors/<stage>/`（intent の記録ディレクトリ）の下に詳細ファイルを書きます。fire コマンドは sensor の結果についてなお 0 で終了します。Sensors が `on` のとき、ゲート入口は `blocking` のバインディングを別に強制し、検証済みのパスを要します。所見、使えないツール、走れなかったチェック、ディスパッチャーのエラー、不正な判定、タイムアウトはすべてそれを止めます。対話的なオーバーライドは、別の記録される `Fix findings` / `Override blocking sensors` の決定で、続けて正確な人の裏付けのある回答と、`--override-blocking-sensors --user-input "Override blocking sensors"` を使うリトライです。自律モードはオーバーライドできません。write で発火した結果は advisory のままです。フレームワークが出荷する6つの Sensor は `claim-sources`、`required-sections`、`upstream-coverage`、`traceability`、`linter`、`type-check` です。

```
bun .claude/tools/aidlc-sensor.ts list
bun .claude/tools/aidlc-sensor.ts describe required-sections
bun .claude/tools/aidlc-sensor.ts fire required-sections \
  --stage requirements-analysis \
  --output-path aidlc/spaces/default/intents/<YYMMDD>-<label>/inception/requirements-analysis/requirements.md
```

### `aidlc-learnings` — learning-gate ツール

これは section 13 の learnings ステップの決定的な半分です。ステージの完了メッセージの後、その承認の質問の前に、そのステージでエージェントを訂正したとき、オーケストレーターはそれを使って各訂正についての質問を表示し、次にあなたが保つもの（と、あなたが保つよう頼んだメモ、質問なし）を保存します。あなたは通常これを直接呼びません（オーケストレーターが自分の質問の周りで両方のステップを動かします）が、それが発行する監査行が意味を持つようにここにあります。質問は [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) が示します。

Learnings の儀式が `off` のとき、ワークフローはこれらのステップを自動的に呼ぶ代わりに、その日誌と learning gate を省きます。

| サブコマンド | 何をするか |
|------------|--------------|
| `surface --slug <stage-slug> [--correction <your change> \| --correction-file <file>]...` | エージェントがあなたの語で読んだ各訂正について、質問「You asked me to <it>. Keep that for next time?」を `Yes, for this project`、`Yes, for the team`、`No` とともに表示し（訂正がなければ質問なし）、ピックが書かれる `selections_file`（作業ごとに1つ、その記録の中）を名づける。ステージの `memory.md` 日誌は数えられ、決して提供されない。読み取り専用 |
| `persist --slug <stage-slug> --selections-json <selections_file>` | 確認された learnings（確認された learning はプラクティス）を `aidlc/spaces/<active-space>/memory/project.md` / `team.md` に書き（Sensor をバインドする learning には、プロジェクトティアの Sensor を scaffold しバインドする）、`RULE_LEARNED` / `SENSOR_PROPOSED` を発行する。`surface` がピックのための作業について名づけた `selections_file` だけを読み、他のどのパスも拒否する |

確認された learning は、現在のワークフローの次の該当するステージ（ルールファイルは各ステージの配信の前に再読されます）とすべての後のワークフローからエージェントに届きます。新しい Sensor は次のステージグラフのコンパイルでバインドします。

`surface` は、そのマシンローカルのファイルがコンパイルされているとき `runtime-graph.json` から日誌を見つけ、されていないとき同じパスを自分で割り出します。これはワークフローの最初のゲートでの通常の状態で、新しいクローンの見た目でもあります。その場合、グラフを再構築する `aidlc engine runtime compile` を名づけるメモを stderr に表示します。stdout の出力は影響を受けません。

### `aidlc-runtime` — ランタイムグラフを読む

ランタイムグラフ（intent の記録ディレクトリの `runtime-graph.json`）は、このワークフローで実際に何が起きたかのデータプレーンの記録です。どのステージが走ったか、各 `memory.md` 日誌がどれだけ満ちたか、どの Sensor が発火したか、各々が何を返したか。それは構造的な `stage-graph.json` のランタイムのミラーです。フレームワークはすべてのステージ遷移の後にそれを再コンパイルします。このツールは、コンパイルをトリガーするか1つのステージの行を読むことを許します。

| サブコマンド | 何をするか |
|------------|--------------|
| `compile` | `audit/` のシャードとステージごとの `memory.md` ファイルを歩き、`runtime-graph.json` を書き直す。すべての遷移でフックにより自動的に発火される |
| `read <stage-slug>` | `runtime-graph.json` から1つのステージの行（タイムスタンプ、エージェント、メモリの内訳、Sensor の発火、結果）を表示する |
| `summary [--json]` | グラフ全体にわたる決定的な集計（ステージ/フェーズの結果の集計、メモリエントリ数、Sensor の5状態の集計、キャプチャされた learnings、ワークフローの所要時間）を表示する。読み取り専用のセッションスキルが読むデータソース |

```
bun .claude/tools/aidlc-runtime.ts read requirements-analysis
```

`runtime-graph.json` は gitignore されます。成果物の形は [Artifacts Reference](14-artifacts-reference.md) を、フルのスキーマは [Runtime Graph](../reference/13-runtime-graph.md) リファレンス章を参照してください。

### `aidlc attest` — コミットの来歴

「どのレビューされた作業ユニットがこのコミットの変更を所有し、コミットされた内容はレビュアーが承認したものとまだ一致するか」に答えます。帰属はコミットされた内容から純粋に導出されます。`audit/` シャードのレビュー受領に加えて、あなたのチェックアウトではなく git ツリーから読まれたコミット済みの `reviewed-source-*.tsv` 証拠ファイルです。だから素の手動 `git commit` で、どのクローンでも、フックなし、コミットメッセージのトレーラーなし、プッシュされた ref なしで機能し、同じコミットは常に同じように解決します。

| サブコマンド | 何をするか |
|------------|--------------|
| `resolve [<commit>]` | 読み取り専用。コミットの first-parent デルタ（デフォルト `HEAD`）をレビューされたユニットに帰属させ、各変更されたパスを分類する。`verified`（コミットされた内容がレビューされた内容と等しい）、`drifted`（レビューされたがそれ以降編集された）、`unattested`（どのユニットもそれを主張しない）、`unverifiable`（証拠が欠けている、改ざんされた、または gitignore されたローカルのスナップショットにだけある。閉じて失敗する）、`indeterminate`（曖昧な受領。閉じて失敗する）、`excluded`（フレームワークのシェル/記録のパス。範囲のベースツリーにすでに確立されたハーネスのシェルで、変更が導入したマニフェストやあなたのチェックアウトにだけインストールされたシェルではない）。stdout に JSON レポート。`--commit <rev>` は位置引数のフラグ形式として受け取られる |
| `resolve --diff <base>..<head>` | 任意の範囲にわたる同じ分類（`...` は merge-base を使い、マージリクエストのセマンティクスと一致する） |
| `resolve … --fail-on drifted,unattested,unverifiable,indeterminate` | どのパスも名づけられたステータスの1つに一致すると 3 で終了する。ゲート形式。4つのどの部分集合も受け取る。**未検証のパスを通すつもりでない限り4つすべてを名づける** — `unverifiable` を省くと、レビューされた内容を何も確認できないパスが通る |
| `resolve … --record-ref <ref>` | テスト対象のコミットではなく `<ref>` のツリーから受領と証拠を読む。変更が書けない ref（保護されたブランチ、記録のみの ref）に向けるので、変更が自分の承認を供給できない |
| `resolve … --require-trust <level>` | レポート自身の基礎が `informational` \| `reproducible` \| `independent` \| `signed` に達しない限り 3 で終了する（`signed` は、判定が依拠するすべての入力（依拠された各受領の監査シャードと、それが選ぶ証拠ファイル）が署名されたコミットで届いたことを意味する）。すべてのレポートは、どれを達成しなぜかを言う `trust` オブジェクトを運ぶ |
| `anchor [--commit <rev>]` | コミットがレビューされた主張を着地させたことを記録する `SOURCE_COMMITTED` 監査行を追記する。エンリッチメントだけ。`resolve` はアンカーを決して読まないので、アンカーのない手動のコミットは何も失わない。デフォルトで明示的。`AIDLC_SESSION_ANCHOR=1` を設定すると、セッション開始時に最近のコミットも掃く |
| `anchor --reconcile [--max-commits <n>]` | first-parent の履歴（デフォルト100コミット）を掃き、帰属可能なコミットのアンカーをバックフィルする。すでにアンカーされ swarm マージされたコミットはスキップされ、帰属できないものは報告される |

```
# Gate a branch: three-dot (merge-base) range, all four failable statuses,
# receipts read from a ref the branch cannot write
bun .claude/tools/aidlc-attest.ts resolve --diff origin/main...HEAD \
  --record-ref origin/aidlc-records --require-trust independent \
  --fail-on drifted,unattested,unverifiable,indeterminate
```

そのレシピを決める3つの細部があります。`...`（3つのドット）を使います。`origin/main..HEAD` は *先端* を diff するので、ブランチポイントの後に `origin/main` に着地したものはこのブランチの変更として現れ false-fail します。十分な履歴をフェッチします。浅いチェックアウト（`actions/checkout` はデフォルトで深さ 1）は境界の親コミットを持たず、`resolve` はそれをツリー全体を黙って分類するのではなくエラーとして報告します。`fetch-depth: 0` を設定します。そして、*報告* しているのか *強制* しているのかを意図的に決めます。`--record-ref` なしでは、自分の受領を書く変更が自身を検証でき、レポートはそれを述べます（`trust.level: reproducible`）が防ぎません。両方の trust のフラグを落とすと、正直な情報的なレポートが得られます。

両方の動詞は `--repo <name>`（マルチリポジトリの intent）、`--space <name>`、`--intent <dir>` を受け取ります。各動詞は他方のフラグを無視するのではなく拒否します。脅威モデル、trust のはしご、ステータスのセマンティクスは [Commit Provenance](../reference/20-commit-provenance.md) リファレンス章を参照してください。

### セッションスキル — ワークフローについて報告する

3つの読み取り専用のスキルが、`aidlc engine runtime summary` が報告するものを、読みやすい出力でラップして表に出します。コマンドのようにタイプします。

| スキル | 何をするか |
|-------|--------------|
| `/aidlc-session-cost` | 決定的なコストビュー（所要時間、ステージの結果、メモリ、Sensor、learnings）。ターミナルのみ |
| `/aidlc-replay` | 非同期レビューのための読みやすいセッションの物語。ターミナルのみ |
| `/aidlc-outcomes-pack` | チームへのハンドオーバー文書。`OUTCOMES.md` を書く |

3つとも読み取り専用で（ステージの進行なし、監査の発行なし）、すべての数字を `aidlc engine runtime summary --json` から取ります。あなたのハーネスがスキルをスラッシュコマンドとして表に出さない（`/aidlc-session-cost` が無効と報告される）なら、そのコマンドを直接実行します。同じコストビューを生みます。フルのウォークスルーは [Session Management § Session Skills](11-session-management.md#session-skills) を参照してください。

---

## 環境変数

AI-DLC は以下のすべての変数を、ホストツールがそれを実行する環境から読みます。あなたのシェル、ホスト自身の設定（`.claude/settings.json` の `env` ブロックなど）、またはエンジンが自分の子プロセスに渡す値です。プロジェクトの `.env` ファイルは AI-DLC の設定ではありません。インストールされたエンジンはそれを決して読まないので、あなたがクローンするリポジトリは、それを出荷することで AI-DLC の振る舞いを変えられません。

### `AWS_AIDLC_DEFAULT_SCOPE`

プロジェクトの暗黙のスコープを事前設定します。リゾルバは、実際の環境変数（`.claude/settings.json` の `env` ブロックが供給する値を含む）、次に記録された `aidlc config flags --default-scope` の値、次に `classic` を読みます。

**構文（`.claude/settings.json` 内）:**

```json
{
  "env": {
    "AWS_AIDLC_DEFAULT_SCOPE": "classic"
  }
}
```

**有効な値:** `enterprise`、`feature`、`mvp`、`poc`、`bugfix`、`refactor`、`infra`、`security-patch`、`classic`、`workshop`、`express`。

**優先順位:** 明示的な CLI フラグ > エージェントが提案しあなたが確認したプラン > 実際の `AWS_AIDLC_DEFAULT_SCOPE` 環境変数 > 記録された default-scope フラグ > `classic`。共有のデフォルトを `aidlc config flags --default-scope feature --project --yes` で記録するか、このチェックアウトには `--local` を使います。出荷の settings env エントリを含む実際の環境値が、どちらの記録にも勝ちます。

**効果の範囲:** ワークフローの初期化時にのみ適用されます。intent の `aidlc-state.md` が存在すると、状態ファイルが権威です。フルのウォークスルーは [Customization § Per-Project Default Scope](13-customization.md#per-project-default-scope) を参照してください。

### 儀式のキルスイッチ

`AIDLC_DISABLE_SENSORS`、`AIDLC_DISABLE_LEARNINGS`、`AIDLC_DISABLE_SUMMARY_CONFIRMATION` は、正確に `1` に設定されると、それぞれ一致する儀式を `off` に強制します。状態ファイルを書き直さずに、intent ごととスコープの設定をオーバーライドします。優先順位、デフォルト、記録可能な `aidlc config flags --bypass` 形式は [Ceremony controls](#aidlc-sensors-learnings-summary-confirmation-ceremony-controls) を参照してください。

---

## 次のステップ

- [Skills and Runner Commands](17-skills.md) — タイプ可能な `/aidlc-<scope>` と `/aidlc-<stage>` のランナー、`--single` が何をするか
- [Session Management](11-session-management.md): 再入、redo、ステージジャンプの詳細
- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — スコープの定義、ステージのマッピング、テスト戦略のレベル
- [Troubleshooting](15-troubleshooting.md) — コマンドが期待どおりに振る舞わないとき
- [Glossary](glossary.md) — command、utility command、scope の定義

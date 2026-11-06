# opencode で AI-DLC を実行する

opencode ランタイムは、フレームワークのハーネス配布形態の一つで、オープンソースの
**opencode** ハーネス (opencode.ai) 向けです。決定論的なコアは一つ、ハーネスは複数という構成です。エンジン、状態機械、監査ログ、グラフ、swarm のレフェリー、learnings ゲートは、どの配布形態でもバイト単位で同一です。異なるのはシェルだけです。ソース／開発ツリーは、`core/` と `harness/opencode/` から
`bun scripts/package.ts opencode` によって、git 無視のローカル
`dist/opencode/` に**生成されます**。手で直接編集しないでください。

ハーネス固有のオンボーディングは `.aidlc/onboarding.md` にあり、
`opencode.json` の `instructions` リストから読み込まれます。ルートの `AGENTS.md` ブロックはハーネス中立で、エンジンディレクトリが異なる他のインストール済みハーネスと共有されます。opencode と Copilot は一つの `.aidlc/` インストールを共有できません。

## レイアウト: 意図的に二つのドットディレクトリ

opencode は `.opencode/tools/` と
`.opencode/tool/` の下にあるすべての `*.ts` をカスタムツール定義として自動インポートします。CLI 形式のエンジンスクリプト (トップレベルのディスパッチ、`process.exit`) をインポートするとセッションがクラッシュします
(opencode 1.17.18 で実際に再現しました)。そのため、この配布形態は次のように分けています。

- **`.aidlc/`** — AIDLC エンジンツリー (tools、hooks、skills、agents、
  knowledge、scopes、sensors、aidlc-common)。opencode はここをスキャンしません。同梱の
  `opencode.json` が `skills.paths: [".aidlc/skills"]` を登録するので、オーケストレーター skill と生成されたすべてのランナーはここで見つかります。
- **`.opencode/`** — ネイティブに消費されるサーフェスだけを置きます。14 のペルソナ
  サブエージェント (`agents/*.md`, `mode: subagent`)、`/aidlc` コマンド
  (`command/aidlc.md`)、フックアダプタープラグイン
  (`plugin/aidlc-opencode-adapter.ts`, opencode が自動検出) です。
  コマンドは、入力されるたびにインストール済みの skill を自分自身へ出力するので
  (`aidlc engine skill-text --harness-dir .aidlc`)、エージェントは skill をまるごと受け取ります。opencode は自前の skill ツールから読み込んだ skill を 50 KiB で切り、残りはプロジェクトの外、データフォルダーの下に保存するからです。

## 前提条件

- **opencode 1.18.29 以降、または OpenCode 2** — アダプタープラグインは、両系統が読み込む一つのオブジェクトをデフォルトエクスポートします。opencode 1 はその
  `server()` を呼び (`tool.execute.before`、`tool.execute.after`、`chat.message`、
  `session.idle`、`experimental.session.compacting`、`shell.env` の各フック。オブジェクト形式のエントリーポイントには 1.18.29 が必要です)、OpenCode 2 はその `setup()` を呼びます (see
  [On OpenCode 2](#on-opencode-2))。プロジェクトローカルの skill と agent の検出は両方で動きます。`opencode --version` で確認してください。
- **bun** — ソース／開発の `dist/`
  プロジェクションを生成または実行するときだけ必要です。ネイティブインストールとバージョン付きのリリースランタイムは、インストール済みの `aidlc` 実行ファイル経由でディスパッチします。
- **モデルプロバイダー** — 同梱のプロジェクト `opencode.json` と agent
  定義はモデルを固定しません。プロバイダーとセッションモデルはグローバルの opencode 設定が供給します。balanced のレビュアーは medium reasoning のバリアントだけを保持します。

## インストール

### ネイティブチャネル (推奨)

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
aidlc doctor
opencode
```

インストーラーは、リリースのメタデータ、実行ファイル、全ハーネスのランタイムアーカイブを、公開されている SHA-256 チェックサムと照合します。インストール済みのランタイムに Bun、Node.js、Git は不要です。ハーネスの選択は `aidlc config` で行います。

Windows では `install.ps1` をダウンロードして
`& $installer` を実行します。アカウントスコープ、User PATH への自動登録、`-NoModifyPath` については
[Windows installation](../18-install-and-lifecycle.md#windows-powershell) を参照してください。
エアギャップ環境向けのパッケージには、Unix では
`install.sh --from <release-directory> --offline`、Windows では
`& $installer -From <release-directory> -Offline` を使います。

`aidlc config` は `.aidlc/`、`.opencode/`、ワークスペースシェル、
`AGENTS.md`、管理対象の `.gitignore` ブロック、`opencode.json` 内の AI-DLC のエントリーを投影します。これらのエントリーは skill とメソッドのファイルを検出させ、AI-DLC 自身の直接の `aidlc engine *` コマンドをプロンプトなしで実行させ、`rm -r...` と `git push` の前に一度だけ確認します。他のすべてのシェルコマンドは、あなた自身の opencode 設定に従います。すでに `opencode.json` を持つプロジェクトでは、そのモデル、プロバイダー、instructions、権限ルール、コメントを保ちます。AI-DLC は自身のエントリーだけを追加し、その二つの確認はあなたの `bash` マップの先頭に置かれるので、その後ろにあるあなた自身のルールが判断します。グローバルの opencode 設定では、シェルルールをマップとして書いてください (`"bash": {"*": "ask"}`)。opencode はグローバルの短縮形 `"bash": "ask"` を、このファイルを含むプロジェクトマップで置き換えるからです。グローバルの `"git *": "allow"` でも、AI-DLC の `git push` の確認には一度だけ行き当たります。"Allow always" でそれは終わります。`aidlc config` と `aidlc doctor` は、グローバル設定に短縮形を見つけると、その旨を一行で伝えます。プロジェクトで opencode を起動し、
`/aidlc --doctor` を実行し、続いて `/aidlc` の後に作りたいものを入力してください。

### バージョン付き手動コピーの代替手段

特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` を
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) の説明どおりにダウンロードして展開し、
`RUNTIME_ROOT` を展開された `runtime/` ディレクトリに設定します。

1. 配布形態をプロジェクトにコピーします。

   ```bash
   cp -r "$RUNTIME_ROOT/opencode/.aidlc/"    your-project/.aidlc/
   cp -r "$RUNTIME_ROOT/opencode/.opencode/" your-project/.opencode/
   cp -r "$RUNTIME_ROOT/opencode/aidlc/"     your-project/aidlc/      # the workspace shell — a sibling of .aidlc/, not inside it
   ```

   コピーランタイムには `opencode.json` がないので、コピーがあなたのものを置き換えることはありません。
   ステップ 2 がそこへ AI-DLC の三つの要となる部分を追加するか、ファイルがなければ作成します。`skills.paths` (`.aidlc/skills` からの skill 検出)、
   `instructions` (`.aidlc/onboarding.md` のネイティブオンボーディングと、メソッドの glob `aidlc/active-memory/**/*.md` の両方。後者は `/aidlc space <name>` が書き換える、アクティブな space のメソッドを git 無視でコピーしたものです)、そして AIDLC の bash エントリーポイントと
   `.aidlc/tools/`、`.aidlc/hooks/` 下の編集に対する権限ルールです。代わりに `opencode.jsonc` を使っている場合は、ステップ 2 がそれらの部分をそちらへ追加し、コメントは保たれ、その横に `opencode.json` は作りません。
   アダプターは権限境界を強制します。対象は、パッケージされたツリーから埋め込まれたエントリーポイントでなければならず、チェーン、リダイレクト、展開、コマンド置換のない一つの直接コマンドとして呼び出されなければなりません。エンジンコードの編集は承認を求めます。

2. コピー自身のセットアップを、プロジェクトから一度だけ実行します。

   ```bash
   bun .aidlc/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness opencode
   ```

   これは、あなたの `AGENTS.md` と `.gitignore` の既存のすべての後ろへ AI-DLC の行を追加し、あなたの `opencode.json` へ AI-DLC のエントリーを追加 (またはファイルを作成) します。これは最初のワークフローの前に行われます
   (クローンごとの監査シャードは意図的にコミットされ、カーソルとマシンローカルのランタイムは無視されたままです)。

3. プロジェクトで opencode を起動し、`/aidlc --doctor` を実行し、続いて `/aidlc`
   の後に作りたいものを入力します。

opencode には session-start フックが注入するコンテキストのチャネルがないので、
`/aidlc` skill は、引数なしで呼ばれると読み取り専用のステータス探査を一度行います。既存のワークフローは、`/aidlc --resume` のときと同じように、止まった場所から続きます (やり直すか、あるステージへ飛ぶか、別のことをするために新規に始めるかを尋ねます)。
`/aidlc --resume` はその探査を飛ばし、そのまま続けます。

## 更新とバージョンのずれ

`aidlc update` はマシンのランタイムを更新しますが、プロジェクトを書き換えません。
`aidlc doctor` は、選択中のエンジンと異なるプロジェクトのスタンプを報告します。ワークフローの合間に、更新をプレビューして適用します。

```bash
aidlc config --dry-run
aidlc config
```

Config は管理対象のルートブロックとユーザー所有のファイルを保ち、ローカルのフレームワーク編集を衝突として報告します。`opencode.json` では、更新は AI-DLC が書き、誰も変えていないエントリーだけを更新します。あなた自身のエントリーと、あなたが編集した AI-DLC のエントリーは、そのまま残ります。
ワークフローを開いたままの更新は、設定変更 (`config
models`、`flags`、`providers`) と同じように完了し、開いている作業は続くと伝えます。
アップグレードとロールバックは、プロジェクトに触れないので、ワークフロー中でも安全なままです。

## このハーネスでの違い

- **質問は番号付きの散文の選択肢として表示されます** (構造化された質問
  ウィジェットはありません)。`[Answer]:` タグの付いた質問ファイルが信頼できる情報源であり続けます。
- **フックはアダプタープラグインに乗ります。** opencode には hooks.json／設定のフック
  レジストリがありません。`.opencode/plugin/aidlc-opencode-adapter.ts` が、opencode のプラグインフックのタイミングを `.aidlc/hooks/` のコアフック本体 (bun
  サブプロセスとして実行) へ対応づけます。ツール実行前のレビュアーの読み取りスコープと AIDLC の bash 境界、write/edit/apply_patch での監査とセンサー、bash での rebuild-stage-graph (エンジンエラーの正確なメッセージを TUI トーストでも表示)、todowrite での
  ステータスライン同期、task でのサブエージェントログ、各人間ターンでの存在
  ミント、コンパクション前の状態検証です。
- **転送ループの強制は助言的です。** Stop の継ぎ目は
  `session.idle` イベントで、ブロックではなく反応的です。コアの stop フックが
  `block` を返すと、プラグインはナッジプロンプトを注入してループを再開します
  (送った part の id でナッジを識別するので、ナッジがあなたのターンとして数えられることはありません)。ナッジは
  合成 part です。エージェントはそれを読み、あなたのチャットには表示されません。Esc でターンを止めたとき、またはエージェントが実行しようとしたコマンドを拒否したときは、あなたが再び書くまでナッジは続きません。会話中または
  一時停止中の人間は、フックの対話的な上限で解放されます。
- **`/aidlc` はあなたが入力したものを表示します。** opencode はコマンドのテンプレートまるごとをあなたのメッセージとして表示するはずでした。プラグインはエージェント向けにテンプレートを保ち、代わりにあなたの `/aidlc ...` の行を表示します。
- **あなたが入力したものだけがあなたの返答です。** opencode があなたのエディターで開いているファイルや選択範囲をメッセージに加えるとき (Zed のターミナル、またはエディター拡張を入れた VS Code のターミナル)、エージェントはそれも見ますが、AI-DLC はあなたが入力したものだけをあなたの言葉として保ちます。
- **ペルソナはネイティブのサブエージェントです** (`mode: subagent`)。コンダクターはほとんどのステージでそれらをインラインで取り込み、二つのサブエージェントステージ (2.1 reverse-engineering、3.5 code-generation) では `task` ツール経由で委譲します。ネイティブの権限マップが `task` を拒否するので、委譲されたエージェントは再び委譲できません。
  プラグインコンポジションは、プラグインペルソナ向けに同じ `.opencode/agents/` の双子を発行します。
- **space の切り替えは JSONC を保ちます。** `/aidlc space <name>` は
  `opencode.json` または `opencode.jsonc` のメソッド glob を、コメントや末尾カンマを削らずに更新し、明示的なペルソナのメモリパスを揃えたまま保ちます。
- **Construction swarm は task ツールのファンアウトだけで動きます** (`AIDLC_USE_SWARM=1`
  はうるさい no-op です。Workflow ツールは存在しません)。
- **セッション終了のタイミングはありません** — `SESSION_ENDED` 監査イベントは発行されません。
  コンパクション前の検証は発火します (`experimental.session.compacting`)。
- **ステータスライン／ウェルカムメッセージはありません** — `/aidlc --status` とゲートでの進捗
  行を使ってください。
- **MCP サーバー**: 何も同梱しません。必要なら
  `opencode.json` の `mcp:` の下に自分で設定してください。

## OpenCode 2 について

OpenCode 2 は opencode 1 のプラグイン関数を実行しないので、アダプターは V2 のエントリーポイント `setup(ctx)` も持ちます。これは同じフックロジックを V2 のプラグイン API から駆動します (2.0.24 で実地検証済み)。

| OpenCode 2 moment | Drives |
| --- | --- |
| `session.hook("prompt")` | presence minting and session-start (`chat.message`) |
| `tool.hook("execute.before")` / `("execute.after")` | the bash boundary, guards, reviewer scope, audit, sensors, stage graph, subagent log |
| `session.hook("compaction")` | state validation before compaction |
| `session.execution.succeeded` event | the Stop hook and its nudge (`session.idle`) |
| `session.execution.interrupted`, `permission.replied` events | no nudge after Esc or a rejected command |
| `shell.hook("create.before")` | each shell command acts on its own chat's work (`shell.env`) |

V2 は組み込みツールの名前を変えます (`bash` → `shell`、`task` → `subagent`、
`apply_patch` → `patch`)。アダプターはそれらを元に戻します。そのツールイベントは呼び出し元のエージェントを名指しするので、レビュアーの身元はイベント自体から分かります。ナッジは合成メッセージとして送られ、V2 はそれをプロンプトフックへ決して渡さないので、人間ターンとして数えられることはありません。サブエージェントのプロンプトはプロンプトフックへ届きます。アダプターは子セッションを親から識別し、それらを飛ばします。

OpenCode 2 のシェルイベントはコマンドの環境を運びますが、セッションは運ばないので、アダプターはそれに先立つシェルツール呼び出しからセッションを取ります。opencode 自身のターミナルで入力されたコマンドにはそうした呼び出しがなく、チャットを名指ししません。これは opencode 1 と同じです。

同梱の `opencode.json`、agent ファイル、`/aidlc` コマンドは opencode 1 の形を保ち、OpenCode 2 はそれをそのまま読みます。その形のままにしておいてください。`aidlc doctor` と `aidlc config` がその形を確認します。

opencode 1 と比べた機能低下:

- **ステータスライン同期なし。** OpenCode 2 には todo ツールがないので、
  `aidlc-sync-workflow-state.ts` を実行する `todowrite` の
  タイミングが決して起きません。ワークフローの状態はエンジン自身のコマンドで進み続けます。欠けているのは todo 駆動のステータスラインのミラーだけです。`/aidlc --status` を使ってください。
- **`/aidlc` はテンプレートを表示します。** OpenCode 2 には `command.execute.before`
  フックがないので、あなたのチャットは、入力した行ではなくコマンドのテンプレートを表示します。アダプターは入力した行をテンプレートから読み戻すので、
  `/aidlc --review none` のようなスイッチは保たれ、引数なしの `/aidlc` は opencode 1 と同じように一つのコマンドとして数えられます。
- **エンジンエラーのトーストなし。** OpenCode 2 はプラグインに TUI トーストのチャネルを与えません。コンダクター skill は、エンジンのエラーメッセージをそのまま表示し続けます。
- **デフォルトのシェル方言。** OpenCode 2 は `shell` 設定をプラグインに公開しないので、bash 境界は、プラットフォームのデフォルトシェルのやり方 (Linux と macOS では POSIX `sh`) でコマンドを読みます。

## インストールの検証

```bash
aidlc doctor                               # native install
bun .aidlc/tools/aidlc-utility.ts doctor   # source/development copy
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

doctor の opencode 固有の確認: アダプタープラグインが
`.opencode/plugin/` に存在すること、プロジェクトルートの `opencode.json` または `opencode.jsonc`
が存在すること、`.opencode/command/aidlc.md` が存在することです。

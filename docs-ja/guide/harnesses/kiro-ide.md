# Kiro IDE と Kiro CLI で AI-DLC を実行する

フレームワークのハーネスの一つです。この Kiro ランタイムは、同じ AI-DLC
メソドロジーを [Kiro](https://kiro.dev/) の中で動かします。Kiro IDE 1.x と Kiro CLI v3 は、一つの agent ハーネスを動かし、同じ `.kiro/` ツリーを読みます。決定論的なコアは一つ — ツール、33 のステージファイル、プロトコル、knowledge、センサー、スコープ、ルール — で、どのハーネスでもバイト単位で共有されます。異なるのはシェル (skills、agent サーフェス、hook の配線、起動) だけです。

ハーネス固有のオンボーディングは `.kiro/steering/aidlc-onboarding.md` にあり、その
`inclusion: always` フロントマターが自動で読み込みます。ルートの
`AGENTS.md` ブロックはハーネス中立で、インストール済みの他のハーネスと共有されます。エンジンディレクトリは依然として異なる必要があります (`kiro` と `kiro-ide` の配布形態は `.kiro/` を共有できません。`kiro` を持つプロジェクトでは、`aidlc config --harness kiro-ide` が `.kiro/` をこの配布形態にその場で切り替えます)。

> [!IMPORTANT]
> **Kiro で AI-DLC を動かすなら Claude Opus 4.8 を使ってください。** コンダクターはステージごとに複数ステップの儀式を進めます — 明確化の質問、成果物の生成、レビュアーのパス、learnings の儀式、そして承認ゲートです。Opus 4.8 は
> 儀式すべてに従い、どのゲートでも正しく止まります。弱いモデルは任意のステップ (レビュアーのパスと learnings の儀式) を飛ばし、ゲートを急ぐことがあります。ワークフローを始める前に、チャットのモデルを **Claude Opus 4.8** に設定してください。

## 前提条件

- **Kiro IDE 1.1.70 以降**、サインイン済み、または **Kiro CLI 2.24.1 以降**
  (`kiro-cli --version`)、サインイン済み。これらは、この配布形態が確認された最も古いビルドです。`/aidlc --doctor` は、PATH 上の
  `kiro-cli` がこれより古いと警告します。Kiro IDE のバージョンは読めません。
- チャットのモデルに **Claude Opus 4.8** を選択 (上の注を参照)
- **bun** は、ソース／開発の `dist/` プロジェクションを生成または実行するときだけ必要です。ネイティブインストールとバージョン付きのリリースランタイムは自己完結です。

> [!TIP]
> ソースから生成する `dist/` のインストールでは、IDE が hook とツールに渡す PATH 上に bun がなければなりません。ターミナルから開くと、IDE はそのターミナルの PATH を渡すので、そこで `bun --version` が動けば十分です。ドックやデスクトップアイコンから開くと、そうならないことがあります。hook が bun を見つけられないときは、そうしたターミナルで
> `bun .kiro/tools/aidlc.ts doctor` を実行してください。その `Runtime hook PATH`
> の行が、追加するディレクトリとその場所を名指しします。終えたら IDE を再起動してください。それまでは、そのターミナルから IDE を開いてください。

## インストール

### ネイティブチャネル (推奨)

Kiro IDE 自身のターミナルで、まだ信頼していないプロジェクトフォルダーでこれらのコマンドを実行すると、Kiro はまずそれを信頼するか尋ねます。自分のプロジェクトか、確認済みのものにだけ **Trust
Folder & Continue** を選びます。そうでなければ **Cancel** を選びます (see [First run](#first-run))。

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config --harness kiro-ide
aidlc doctor
```

インストーラーは、リリースのメタデータ、実行ファイル、全ハーネスのランタイムアーカイブを、公開されている SHA-256 チェックサムと照合します。インストール済みのランタイムに Bun、Node.js、Git は不要です。ハーネスの選択は `aidlc config` で行います。

Windows では `install.ps1` をダウンロードして
`& $installer` を実行します。インストール中に Kiro が開いていた場合、Kiro 自身のターミナルでインストーラーを実行したときを含め、最初の `/aidlc` の前に Kiro を完全に終了して開き直してください。Kiro は起動時の PATH を保つので、その hook、その
agent、その他のターミナルは、再起動するまで `aidlc` を見つけられません。
**Developer: Reload Window** では足りません。アカウントスコープ、User PATH への自動登録、`-NoModifyPath` については [Windows installation](../18-install-and-lifecycle.md#windows-powershell) を参照してください。
エアギャップ環境向けのパッケージには、Unix では
`install.sh --from <release-directory> --offline`、Windows では
`& $installer -From <release-directory> -Offline` を使います。

`aidlc config` は、プロジェクトを開く前に Kiro シェルを投影します。ネイティブの
`aidlc engine *` の信頼付与と、下でコピープロジェクト向けに挙げる正確な読み取り専用コマンドおよびチェックを再び有効にするコマンドは、コンダクター
(`.kiro/agents/aidlc-aidlc.md`) の権限の中に同梱されます。コンダクターが仕事を渡すどの agent も、それらのコマンドを拒否されます。一部のコマンドは、それから差し控えられます。`aidlc engine config set *` はあなたの作業の設定を変え、`aidlc engine adapter *` は IDE 自身の hook が実行するエントリーで、`$`、バッククォート、`>`、`<`、`&`、`@(`、`@{`、または改行を含む AI-DLC コマンドは、一つのコマンドより多くを実行、展開、またはリダイレクトできてしまいます。agent がこれらの一つを実行すると、Kiro IDE はまずあなたに確認します。以前のリリースは、これを
`.vscode/settings.json` の `kiroAgent.trustedCommands` にもマージしていました。Kiro IDE 1.x はもうそのキーを読まないので、そのエントリーは外せます。最初のワークフローの前に、
[First run](#first-run) に従ってください。Kiro IDE で `your-project/` を開き、フォルダーを信頼してウィンドウを再読み込みし、チャットパネルの agent ピッカーで **aidlc** を選び、
`/aidlc --doctor` を実行します。Kiro CLI では、プロジェクトで `kiro-cli --v3` を代わりに実行します。これは `aidlc` agent で開きます。初回、Kiro CLI 2.33.0 以降はこのワークスペースを信頼するか尋ねます。このフォルダーの中身が分かっているなら、
**Trust, continue** を選びます。Kiro CLI はそのときだけフォルダーの hook と agent を読み込むからです (**Don't trust** は終了します)。

### バージョン付き手動コピーの代替手段

特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` を
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) の説明どおりにダウンロードして展開し、
`RUNTIME_ROOT` を展開された `runtime/` ディレクトリに設定します。

```bash
mkdir -p your-project/.kiro your-project/aidlc
# Safe on fresh installs; required when upgrading from v2.5.56 or earlier.
for retired_hook in \
  audit-logger block mint runtime-compile stop sync-statusline \
  enforce-approval-gate plan-approval-guard review-freeze state-transition-guard \
  terminal-command-guard rebuild-stage-graph sync-workflow-state \
  after-shell write-audit-log terminal-command
do
  rm -f \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.json" \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.kiro.hook"
done
rm -f \
  your-project/.kiro/agents/aidlc.json \
  your-project/.kiro/agents/aidlc-*-agent.json \
  your-project/.kiro/hooks/aidlc-*.kiro.hook
# The copy replaces .kiro/settings/cli.json; keep the project's own first.
if [ -f your-project/.kiro/settings/cli.json ]; then
  cp your-project/.kiro/settings/cli.json your-project/cli.json.before-aidlc
fi
cp -R "$RUNTIME_ROOT/kiro-ide/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro-ide/aidlc/." your-project/aidlc/     # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cd your-project && bun .kiro/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness kiro-ide
```

最初の削除ループは v2.5.57 の hook 名の移行です。二つ目は、古い配布形態が同梱した Kiro CLI 形式の agent JSON と、Kiro IDE 1.x が決して実行しない IDE 0.x
`.kiro.hook` 登録を取り除きます。オーバーレイコピーでは、引退したファイルを削除できません。コピーは `.kiro/settings/cli.json` も置き換えます。これは Kiro CLI に v3 エンジンと `aidlc` agent を求めます (どの Kiro CLI リリースがそこのエンジンを読むかは下のリストを参照)。そのファイルは
`.kiro/` の残りと同じように AI-DLC が管理します。`aidlc config` は、同梱のものと異なるコピーを上書きする代わりに衝突で止まり、`--force` がそれを置き換えます。自分の Kiro CLI 設定は、ユーザーレベルの `~/.kiro/settings/cli.json`
に保ってください。Kiro CLI はそのファイルも読み、プロジェクトファイルが勝つのはそれが設定するキーだけです。
プロジェクトが設定を `.kiro/settings/cli.json` に保っていた場合、上のブロックはそれを
`cli.json.before-aidlc` として保存するので、そちらへ移せます。どちらの削除も、新規インストールでは no-op です。そのクリーンアップの後、
`cp -R <src>/. <dst>/` の形は、`your-project/.kiro` がすでにあるかどうかにかかわらずツリーの**中身**をコピーします。素の
`cp -r "$RUNTIME_ROOT/kiro-ide/.kiro" your-project/.kiro` は、既存の `.kiro/` の中に二つ目の `.kiro` を入れ子にし、IDE は新しいファイルを決して見ません。

`aidlc/` ディレクトリはワークスペースシェルです。エンジンが読む、作り付けの
`aidlc/spaces/default/memory/` メソッドツリーを同梱します。これは `.kiro/`
の**兄弟**なので、別にコピーします (または `$RUNTIME_ROOT/kiro-ide/` ツリー全体を一度にコピーします)。これがないと `/aidlc --doctor` は
「workspace shell ready」のチェックに失敗します。

コピープロジェクトでは、`aidlc` agent が AI-DLC のエンジンコマンド
(`bun .kiro/tools/aidlc.ts engine ...`)、そのツールスクリプト、その読み取り専用コマンド (`doctor` と `--doctor`。`--verbose` の有無によらず。`version`、
`--version`、`status`、`--status`、`config --help`、`config --show` と
`config <section> --show`。`--json` の有無によらず。そして
`config <section> --help`)、チェックを再び有効にする
(`config flags --clear-bypass <switch> --yes`) を、カードなしで実行します。ネイティブインストールも同じコマンドを、`aidlc ...` として、カードなしで実行します。それ以外の
`config` 変更 (素の `config`、ガイド付きセットアップを含む)、マシンの AI-DLC インストールを変えるコマンド (`use`、
`update`、`rollback`、`uninstall`、`system`)、そして `$`、バッククォート、`>`、`<`、`&`、`@(`、`@{`、または改行を含む AI-DLC コマンドは、まず Kiro のカードを示します。

バージョン付きランタイムはネイティブの `aidlc` コマンドを使います。Bun の形のソースプロジェクションが必要なフレームワーク開発者は、リポジトリをクローンし、
`bun install --frozen-lockfile` と `bun scripts/package.ts` を実行してから、git 無視のローカル `dist/kiro-ide/` 出力を代わりに使えます。

同梱の `.gitignore` は、ワークスペースのコミット／無視の切り分けを運びます。ユーザーごとのカーソル (`aidlc/active-space`、`aidlc/spaces/*/intents/active-intent`) とマシンローカルのランタイム (`aidlc/.aidlc-clone-id`、`runtime-graph.json`、センサー
キャッシュ、`spaces/*/knowledge/.sources.local.json`) は追跡対象外のままで、共有される記録 — メソッド memory、状態、監査シャード、成果物 — は git と一緒に動きます。最後の行、つまりコピー自身のセットアップが、それらの行と `AGENTS.md` の AI-DLC の部分を、ファイルにすでにあるすべての後ろへ加えるか、プロジェクトに何もないときはファイルを作ります。こうして AI-DLC のルールは、最初のワークフローの前にそろいます。

インストールは次を同梱します。

- `.kiro/skills/aidlc/SKILL.md`: aidlc agent への AI-DLC の指示。agent は、これを
  `question-rendering.md` と `composer.md` を隣に置いて、どのチャットでも最初の行から持つので、あなたの依頼に動く前にファイルを読みません。
- `.kiro/agents/aidlc-aidlc.md` — ワークスペースの agent セレクターに現れる同じコンダクター (`aidlc-*-agent.md` のスペシャリストより前に並ぶように名付けられています。Kiro は agent をファイル名順に挙げるので、`aidlc` がピッカーと `/` メニューで最初に来ます)。これは `invoke_sub_agent` (Kiro IDE) または
  `orchestrate_subagent` (Kiro CLI) 経由で委譲します。これらは、各ペルソナをそれ自身のツールと拒否ルールのもとで動かす派遣ツールです。
- `.kiro/agents/aidlc-*-agent.md` — 14 の委譲ペルソナすべて。`tools:` の付与と
  `permissions.rules` を運びます。委譲呼び出しでは、Kiro はペルソナの拒否ルールを強制しますが、そのコマンドはコンダクターの許可のもとで実行するので、各ペルソナは、委譲が実行してよい AI-DLC コマンドを除いてその許可を拒否します。委譲はワークフローを動かせず、ステージ状態を変えられず、intent や space を切り替えたり作ったりできません。コマンドをどう引用しても空白を入れてもです。Bolt の worktree を作り、マージし、破棄し、復元するのは pipeline-deploy ペルソナだけです。
  agent-v1 の JSON は同梱しません。それらのシェルルールは AI-DLC 自身のコマンドと `bun --version` を確認なしで実行します。プロジェクト自身のテストとビルドのコマンドは依然として確認します。
- `.kiro/settings/cli.json` — `"chat.agentEngine": "v3"` と
  `"chat.defaultAgent": "aidlc"` を設定します。Kiro CLI の v2 エンジンは
  `.kiro/hooks/` の登録をどれも動かさず、hook は内側からそれを検出できないので、Kiro CLI は `kiro-cli --v3` で起動してください。Kiro CLI 2.33.0 はエンジンをコマンドラインか自分の Kiro CLI 設定からだけ取ります。プロジェクトファイルのエンジン値を無視し、`kiro-cli settings --workspace
  chat.agentEngine` を拒みます。Kiro CLI 2.24.1 から 2.32.x はこのファイルからエンジンを読みます。
  Kiro IDE はこのファイルを読みません。`kiro-cli acp` はその
  `chat.defaultAgent` を読みますが、そのエンジン値は読まないので、ACP クライアントは `kiro-cli acp --agent-engine v3`
  を起動し、その `initialize` 要求で
  `clientCapabilities._meta.kiro.hooks` を `{ enabled: true, v2: true }` として宣言しなければなりません。さもないとセッションは hook を動かしません (see
  [Kiro CLI hooks not running](../15-troubleshooting.md#kiro-cli-hooks-not-running))。
- `.kiro/steering/aidlc-active-memory.md`: コンダクターと委譲 agent 向けに、アクティブな space のメモリテキストを運ぶ、常に含まれる steering。AI-DLC は、各チャット向けに
  `aidlc/spaces/<active-space>/memory/` からこれを書き、git の外に保ちます。メモリファイルを編集し、これは決して編集しないでください。チャットは始めたときのコピーを保つので、メモリ編集の後、新しいチャットが始まるまでステージルールは各ステップとともに届きます。
- `.kiro/steering/aidlc-onboarding.md` — 常に含まれるハーネスのセットアップとコマンド。
- `.kiro/hooks/aidlc-*.json` — Kiro の v2 hook 形式のフレームワーク hook。両方のサーフェスが、セッション開始時にこれらを登録します。Kiro IDE では Agent Hooks パネルに現れます。そこで一つをオフにすると、そのファイルに `"enabled": false`
  が書かれます。`/aidlc --doctor` がそれを報告し、次の AI-DLC ステップが変更ごとに一度そう伝え、`aidlc-record-human-turn` がオフのあいだ、承認は、フォルダーを信頼するよう言うのではなく、Agent Hooks の下でそれを戻すよう言います。AI-DLC は hook を決してあなたのために戻しません。IDE 0.x の `.kiro.hook` 形式はもう同梱されません。Kiro IDE 1.x は決してそれを実行しません。

## 初回実行

Kiro IDE は、あなたがフォルダーを信頼してウィンドウを再読み込みした後にだけ、フォルダーの hook を動かし、その `aidlc` agent を読み込みます。信頼されていないフォルダーは Restricted Mode で開きます。ウィンドウの上部のバナーと、ステータスバーの「Restricted Mode」です。それまでは、AI-DLC の hook は動かず、`aidlc` agent は agent ピッカーから欠け、最初の承認の質問はあなたの返信を見られません。

中身が分かっているフォルダーだけを信頼してください。自分のプロジェクトか、確認済みのものです。信頼すると、フォルダーの `.kiro` hook があなたのマシンでコマンドを実行できるので、他人のプロジェクトは、確認するまで Restricted Mode のままにしてください。

Kiro はこの信頼を早めに求めることがあります。信頼する前に Kiro IDE のターミナルをそのフォルダーで開くと (たとえばそこで `aidlc config` を実行するため)、Kiro はまず「Do you trust the authors of the files in this folder?」と尋ねます。分かっているフォルダーには **Trust Folder & Continue** を選びます。これはステップ 1 と同じやり方で信頼し、`aidlc config` が終わったら、ステップ 2 に進んでウィンドウを再読み込みします。そうでなければ **Cancel** を選びます。

1. Kiro IDE で `your-project/` を開きます。Restricted Mode のバナーがウィンドウの上部に出ていて、フォルダーの中身が分かっているなら、そこで **Manage** を選び、開いた Workspace Trust のページで **Trust** を選びます。
2. コマンドパレット (Ctrl+Shift+P、macOS では Cmd+Shift+P) を開いて
   **Developer: Reload Window** を実行します。
3. チャットパネルの agent ピッカーで **aidlc** agent を選びます (see
   [Start AI-DLC in a Kiro IDE chat](#start-ai-dlc-in-a-kiro-ide-chat))。
4. チャットで `/aidlc --doctor` を実行してセットアップを確かめ、それから
   `/aidlc <description>` でワークフローを始めます。

Kiro CLI では、`your-project/` で `kiro-cli --v3` を起動します。Kiro がこのワークスペースを信頼するか尋ね、このフォルダーの中身が分かっているなら、**Trust,
continue** を選びます。それからステップ 4 へ進みます。

`kiro-cli` が PATH 上にあると、セットアップは Kiro CLI のセッションモデルも提供します。これはあなたの個人の Kiro 設定 (`~/.kiro/settings/cli.json`) に保存されます。これは
Kiro CLI の設定です。Kiro IDE は、自身のモデルピッカーで選んだモデルを使います。この行でセットアップはモデルだけを保存し、effort は決して保存せず、Kiro auto より優先するモデルを勧めません。Enter は Kiro auto を保ち、Kiro IDE 自身のターミナルでは推奨のセットアップは尋ねず、Kiro auto のもとで各ホストがモデルを選ぶ場所を伝えます (Customize はそのステップ 2 で依然として尋ねます)。
`aidlc config models --session-model <id>` が後から保存します。

チャットメッセージを送った後に doctor が「AIDLC hooks have not run in this project yet」と報告するなら、ステップ 1 から 3 を繰り返します。See
[Troubleshooting: Kiro IDE hooks not running](../15-troubleshooting.md#kiro-ide-hooks-not-running)。

## 使い方

Claude Code ハーネスと同一です。`/aidlc <description>` がワークフローを始め、`/aidlc --status` が位置を報告し、`/aidlc --doctor`、`--stage`、`--phase`、`--depth`、`--test-strategy`、`--config [section]` はすべて動き、ステージごとの (`/aidlc-domain-design`) とスコープごとの (`/aidlc-feature`) ランナー
skill がインストールされます。init コマンドはありません。同梱のシェルがワークスペースを足場として作り、AI-DLC は最初の `/aidlc` で最初の intent を自動で作ります。

### Kiro IDE のチャットで AI-DLC を始める

Kiro IDE は、どの新しいチャットも、`aidlc` ではなく自身の **Default** agent で始めます。`.kiro/settings/cli.json` の `"chat.defaultAgent": "aidlc"` の行は Kiro
CLI の設定です。これは `aidlc` を `kiro-cli` セッションのデフォルト agent にするだけで、Kiro IDE はそのファイルを読みません。そこで、新しい Kiro IDE チャットごとに次を行います。

1. チャットパネルで agent ピッカーを開き、**aidlc** を選びます (そこにある AI-DLC の agent の最初のもの。その説明は「AI-DLC. Choose this agent in
   the agent picker」で始まります)。この
   agent は、AI-DLC のコマンドをあなたに尋ねずに実行させ、AI-DLC がスペシャリスト agent を連れてくるのを許し、チャットが始まるときすでに AI-DLC の指示を持っているので、最初の行に動く前にファイルを読みません。
2. 依頼全体を入力してから Enter を押します。たとえば `/aidlc --doctor` や
   `/aidlc build a to-do app` です。素の `/aidlc` も動きます。`/` メニューが開いているあいだ、Enter は行を最初のエントリー、つまり `/aidlc`
   自体に補完し、次の Enter がそれを送ります。
3. `/` メニューから `aidlc` を選んでも、チャットが使う agent は変わりません。チャットがまだ **Default** のままなら、最初の依頼への AI-DLC の最初の動きは自身のコマンドで、Kiro はそれを承認するよう求め、それから実行するコマンドごとに尋ねます。それを避けるには、まず agent ピッカーで **aidlc** を選びます (ステップ 1)。
   **Default** (または **Default v2**) では、`/aidlc` の依頼を入力すると、AI-DLC はチャットで一度これを伝えます。ただし、Kiro の承認カードの一つで AI-DLC のコマンドに **Always allow** をすでに選んでいる場合は別です。
   `/` メニューの `aidlc-...-agent` のエントリーは、AI-DLC がワークフロー中に連れてくるスペシャリストです。自分で始めるものではありません。

`aidlc` agent を選んでいれば、ふつうの言葉でも頼めます。たとえば
「start an AI-DLC workflow for a to-do app」や「continue my AI-DLC workflow」です。
Kiro のウェルカムパネル (Spec、Plan、Bug Fix、Quick Spec) は Kiro 自身のワークフローを挙げます。AI-DLC はそこに現れないので、上のようにチャットから始めてください。

### Supervised か Autopilot か

チャットボックス右下の **Autopilot** スイッチ (**Settings > Agent > Agent Autonomy** の下にもあります) は、agent が何をするかを Kiro 自身がどれだけ頻繁に承認を求めるかを設定します。ワークフローの途中でも、いつでも変えられます。これは、どの AI-DLC チェックポイントがあなたのために止まるかは変えません。

- **Supervised** (スイッチオフ): ファイルを変えるターンごとに、Kiro は
  **Review changes** カードを示し、あなたが **Accept** か **Reject** を選ぶまで待ちます。AI-DLC は質問、ステージドキュメント、プランをファイルに保つので、ワークフローは、AI-DLC 自身の質問の上に、これらのカードを多く示します。
- **Autopilot** (スイッチオン): ファイルの変更はカードなしで通ります。何が変わったかを見るには、チャットで **View changes** を選びます。
- どちらのモードでも、Kiro は、`aidlc` agent がまだ許可していないコマンドを **Allow** するようあなたに求めます。たとえばプロジェクトのテストコマンド、`git push`、再帰的な削除です。あなた自身のコマンドはどの AI-DLC ルールにも当たらないので、一つに **Always allow** を選ぶと、Kiro はそれを覚え、リダイレクトとチェーンも含みます。AI-DLC 自身のコマンドは、リダイレクト、チェーン、置換 (`>`、`&&`、`$(...)`) を含むと尋ねるので、許可された AI-DLC コマンドを別のものへ引き延ばせません。Kiro は、意図的に差し控えられた二つの AI-DLC コマンドの前にも尋ねます (see
  [Native channel](#native-channel-recommended))。
- Kiro CLI (その v3 エンジン) では、side-by-side のビルドでワーカーやレビュアーが尋ねると、Kiro はそれらの要求を「tool approval pending」のボックスにまとめます。(f) **Approve all pending and auto-approve future subagent requests** は、後で始まるレビュアーを含め、そのチャットの残りのあいだ、確認なしで要求どおりに実行させます。メインチャットからの要求は従来どおり尋ね、Kiro はそれの設定を何も書きません。

どちらのモードでも、AI-DLC は依然として、質問のそれぞれ、すべての承認ゲート、そしてプラン承認がオンのときの Code Generation の **Approve Plan** で止まり、あなたが入力した返信を待ちます (express と poc を除く同梱のすべてのスコープでデフォルトで、あなたが切り替えられます。see
[Plan approval](../13-customization.md#plan-approval))。Kiro のスイッチはこれらを飛ばせません。AI-DLC の hook はどちらのモードでも動きます。一つは、プランが承認されるまで、あるいはプラン承認がオフのときは、AI-DLC がプランを尋ねずに作ると記録するまで、コードの変更を拒みます。AI-DLC は、あなたが質問に返信を入力した後にだけ、答えや承認を受け付けます。ルーティンの承認を飛ばす AI-DLC の設定は、自身の Construction の選択 **Continue automatically** (see
[Your First Workflow](../02-your-first-workflow.md#construction-phase)) であって、Kiro の Autopilot ではありません。

ファイルの変更が起きるたびに読みたいとき、たとえば最初のワークフローや、どの変更も重要なコードでは Supervised を使ってください。クリックをずっと減らしたいときは Autopilot を使ってください。AI-DLC のチェックポイントには依然としてチャットで答え、変更は後から見渡せます。

### チャットがいっぱいになるとき

Kiro はチャットがどれだけ埋まっているかをあなたに示しますが、作業中の AI-DLC には数字を与えません。Kiro IDE と Kiro CLI の v3 エンジンは、チャットが 80% に達すると自分でそれを要約し、それ以降、agent はその要約から作業します。AI-DLC は、Kiro 自身のチャットの記録 (`~/.kiro/sessions/`。読み取り専用) を読み、Kiro がチャットを要約した後の最初の承認の質問または Unit のチェックポイントで、一時停止して新しいチャットで続ける申し出とともに、一行でそう伝えます。Kiro の自動コンパクションをオフにしていたら、チャットが 80% 埋まると同じ申し出が来ます。あなたの答えで決まります。自分で一時停止するものはなく、その行は一つのチャットで一度だけ伝えられます。

その行は、ステージの途中では現れません (いずれにせよ尋ねられる質問とともにだけ来ます)。また、このマシンに記録のないチャット、Kiro の更新がチャットの記録のしかたを変えたときも現れません。一つのウィンドウで二つの AI-DLC チャットを開いた Kiro IDE では、最後に始まったチャットを言うことがあります。いつでも手で同じことができます。

1. ステージの境界で止まります。同じ返信で承認して今は止めたいと伝えるか、
   `/aidlc park` と入力します。`/aidlc --status` は今や
   `Paused at <stage> (you stopped it); pick it back up with /aidlc --resume` を示します。
2. 新しいチャットを始めます。Kiro IDE では、新しいチャットを開き、agent ピッカーで **aidlc** を選びます (新しいチャットは Kiro の Default agent で始まります。see
   [Start AI-DLC in a Kiro IDE chat](#start-ai-dlc-in-a-kiro-ide-chat))。Kiro
   CLI では `/chat new` と入力します。
3. `/aidlc --resume` と入力します。`/aidlc --status` はもう Paused と言いません。

古いチャットが話したがファイルに書かなかったものは引き継がれません。だからステージの終わりが最良のタイミングです (see
[Changing Model Mid-Workflow](../11-session-management.md#changing-model-mid-workflow))。

## Kiro での hook の仕組み

Kiro IDE と Kiro CLI v3 は、`.kiro/hooks/` の下の v2 hook JSON ファイル
(`{"version":"v1","hooks":[{name,trigger,matcher,action}]}`。PascalCase の
トリガー) 経由で hook を登録します (`kiro` CLI 配布形態とは別の仕組みで、そちらは agent JSON の中に `hooks` ブロックを運びます)。ネイティブの hook コマンドは
`aidlc engine adapter kiro-ide` 経由で、ソース／開発コピーは投影された
`aidlc-kiro-adapter.ts` の shim 経由で通ります。どちらも、IDE イベントを、共有のコアフックが期待する形へ正規化します。どの Kiro ツールが書き込み、シェル、委譲、読み取りかは、アダプターの隣の一つの表 `aidlc-kiro-tool-names.ts` に設定されています。アダプターはそれを読みます。hook の登録は手書きの JSON で、そのマッチャーは同じシェル、委譲、監査される書き込みの名前を挙げます。

Kiro IDE 1.x と Kiro CLI v3 は、hook のコンテキストを **stdin 上の JSON** として届けます (snake_case:
`{ session_id, tool_name, tool_input, tool_response }`。古い 0.12 ビルドは代わりに
`USER_PROMPT` 環境変数を camelCase 相当で設定し、アダプターは両方を受け付けます)。初期のビルドは PostToolUse の書き込み／シェルツールの入力を空にしていたので、アダプターは、入力が何も運ばないとき結果テキストから書かれたパスを回復し、監査末尾の hook (`rebuild-stage-graph`、`sync-workflow-state`) は監査証跡から動きます。グラフ再構築の経路は、シェル結果とセッションの身元も保つので、成功した `intent-create` は呼び出し元のセッションに束縛されます。新しいイベントは正確な `session_id` を運び、レガシーのチャネルは、測定した `VSCODE_IPC_HOOK`/`VSCODE_PID`
環境から安定したホストインスタンスの身元を導き、SessionStart でそれを保ちます。新しい Stop も同様に、そのイベントローカルの `session_id` を優先し、一つの並行チャットが、intent の作成や選択の後、別のチャットのハンドオフを消費するのを防ぎます。レガシーの agentStop は、保たれた身元にフォールバックします。後の 1.x ビルドは一部の PreToolUse と委譲の入力を埋めます。アダプターはそれらのフィールドを保ちます。Windows では、決定論的なユーティリティがそれらの継ぎ目を使って、IDE のシェル結果の転送を避けます。送信されたプロンプトを公開するビルドは、ユーティリティを UserPromptSubmit で実行し、1.0.242 のようなビルド (そのプロンプトフィールドは空) は、正確な `execute_pwsh` PreToolUse コマンドにフォールバックします。ユーティリティはターンごとに一度動き、その UTF-8 テキストはターミナルのプロトコル／制御バイトなしで中継され、重複するシェル呼び出しは拒まれます。新しいチャットは、ターンと出力の状態を `session_id` ごとに保存します。セッションの身元のないコンテキストは、一つのレガシー互換バケットを使います。1.0 より前の camelCase ペイロードは、`toolArgs.command` 経由で同じフォールバックを取ります。生のプロンプトテキストは、より新しい世代の互換の形にすぎません。

ペイロードの取得は、**ペイロードに依存するターゲットに限定されています**
(`audit-and-sensors`、`log-subagent`、
`plan-approval-guard`、`rebuild-stage-graph`、`review-freeze`、
`state-transition-guard`、そしてそれらを動かす `guard-tool-call`、`person-message`、
`after-shell` のカード)、ターミナルコマンドの継ぎ目、さらに、新しい `session_id` のための
`session-start` と `continue-workflow`、正確な承認応答のための
`record-human-turn` です。空でない `USER_PROMPT`
は 0.12 ビルド (書き込まずに stdin を開く) ではすぐに消費されます。そうでなければアダプターは、Kiro が閉じるまで 1.x の stdin チャネルを読むので、忙しいマシンで遅く渡されたメッセージも丸ごと記録され、決して閉じないチャネルには 60 秒の安全上限があります。何も届かないときは、あなたのターンは記録されず (何も入力しなかったとは言いません)、agent は、このチャットの最後のメッセージが AI-DLC の記録に届かなかったと言うよう告げられるので、質問の一つに答えていたなら、その質問をまた尋ねられます。それ以外のターゲットはどちらのチャネルにも触れず、ゼロレイテンシーの経路を保ちます。

| Hook | Trigger (matcher) | Purpose |
|------|-------------------|---------|
| `aidlc-session-start` | `SessionStart` | Injects workflow resume context when a new session takes its first prompt (both surfaces; resuming an existing session does not fire it). Kiro IDE 1.1.14 runs no SessionStart hook in a new chat, so `aidlc-record-human-turn` does this work instead |
| `aidlc-record-human-turn` | `UserPromptSubmit` | One card for each message: it first finishes what the last write or command left to do (the two rows "after a write" and "after a command" below), then records a human-turn event on every prompt (human-presence gate), then runs status, doctor, help, navigation, and other terminal utilities before the model when prompt text is available, for the chat that typed the command. A prompt from a chat other than the last one seen, or from a chat not yet started, first starts that chat's session, as `aidlc-session-start` would, so the chat gets its `AIDLC Runtime Session:` line or resume context. A prompt Kiro makes itself (a Workflows step's brief, the notice that a workflow finished) is not counted as your turn: it is recorded as `HOST_TURN`, starts no session and answers no question |
| `aidlc-continue-workflow` | `Stop` | Forwarding-loop audit (advisory-only; the Stop trigger cannot block on the IDE - enforcement relies on the conductor's own Stop protocol) |
| `aidlc-guard-tool-call` | `PreToolUse` (every tool but a read) | One card: it first finishes what the last write or command left to do (the rows "after a write" and "after a command" below), then runs the four checks below, in this order, on the same call. Each check runs only for the tools beside it; every check runs even after one refuses, and the call is refused when any check refuses, with each reason once. A read (`read_file`, `list_directory`, a search) runs with no card: it cannot answer an approval or change the workspace. Nor does a helper agent handing its answer back (`subagent_response`): the call that acts on the answer is checked |
| `plan-approval-guard` | in `aidlc-guard-tool-call` (every tool but a read) | Enforces Code Generation Plan Approval with exact target classification when arguments are present. The shell tool is recognised under all three IDE names, `execute_bash`, `execute_pwsh` (Windows), and `shell`: each is forwarded to the shared guard as `Bash` and routed to legacy recovery identically, and with no active workflow no shell call is denied. `execute_pwsh` is marked as PowerShell, so while a plan waits for approval read-only cmdlets (`Get-Content`, `Select-Object`, `ConvertFrom-Json`, ...), `2>$null`, and `aidlc.cmd` or the full path of the installed engine still run; `Out-File`, `Set-Content`, `Add-Content`, `Tee-Object`, and `>` into a file do not. Legacy argument-less payloads permit only measured `fs_write`/`str_replace` plan-question writes as far as this hook goes; `review-freeze` and `state-transition-guard` refuse such a write, so it does not run. PostToolUse stays silent because 0.12 discards that output; the invoking Code Generation `next`/final `continue` directive carries one protected choice capability. Recovery first requires the person's yes to a plain recovery question, which the agent records; another live window cannot initiate it, while a replacement window can recover after the owner PID exits or an IPC-only endpoint disappears. Takeover clears old response evidence before rotating the challenge. An interrupted pre-write window remains a recovery latch even when PostToolUse never runs; definitive `toolSuccess:false` or recognized failure prose clears it because no mutation occurred, while unknown outcomes remain latched. Adapter-owned recovery preserves the human ask while clearing only violation/window state after successful reissue. `UserPromptSubmit` can submit exact recovery/approval labels but cannot reveal or transfer them. Unknown mutators fail closed and shared files/audit retain no plaintext secret. |
| `review-freeze` | in `aidlc-guard-tool-call` (writes and shells) | Refuses a write or shell mutation of a stage's reviewed output while a fresh terminal review receipt covers it, before the gate. Write tools reach the shared hook as Write/Edit with their target path and shell tools as Bash, with the chat's session; a delegated agent's own writes are judged the same way. An `execute_pwsh` command is read as PowerShell (backslash paths, `Set-Location`), here and in `state-transition-guard`. A call whose input cannot be read (a build older than Kiro IDE 1.1.70 or Kiro CLI 2.24.1 can send one with no arguments) is refused before the hook runs, inside or outside a workflow and with `AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1`, with a line naming the supported builds. |
| `state-transition-guard` | in `aidlc-guard-tool-call` (writes and shells) | Refuses tool-call writes to AIDLC hooks, session controls, runtime records, and the audit trail; the state tool refuses a direct `aidlc-state.ts` lifecycle verb itself, pointing to `aidlc-orchestrate.ts report`. Kiro IDE names no delegated agent on its calls, so a delegate's calls get the conductor's rules. A call whose input cannot be read is refused the same way as for `review-freeze`. |
| `terminal-command-guard` | in `aidlc-guard-tool-call` (`execute_bash\|execute_pwsh\|shell`) | Fallback for empty-prompt IDE versions: runs the classified utility once and refuses the duplicate Windows shell call. After a terminal command has run for a chat's turn, it also refuses that chat's other shell calls in the same turn, whatever they run (for a chat the payload names), so the turn of a `/aidlc --status` does not hand out the next stage. On Windows it also refuses an `aidlc` command with a value that cmd.exe would split (see the Windows quotes row below). On every shell it refuses an AI-DLC engine command whose reply goes to a file (`>`, `>>`, or a pipe into `Out-File`, `Set-Content`, `Add-Content`, `Tee-Object` or `tee`), so the agent runs it on its own and reads the reply from the result, which Kiro returns whole. A step command (`orchestrate next` or `continue`) whose reply the agent pipes or captures away from the result (a pipe into any program, `$(...)`, `$x = ...`, a discarded stream) is not refused: the next card forgets that the chat was handed that step's rules, so the agent's next step carries them again |
| after a write (`fs_write\|str_replace\|fs_append`) | no card: the next card does it | Logs artifact create/update, then fires applicable sensors. `aidlc-guard-tool-call` notes the file a write it lets through targets; the next card that runs anyway (the next guard, your next message, or the turn's end) records it before anything else, with the write's chat, when the file changed. A write that leaves its file as it was records nothing |
| `aidlc-log-subagent` | `PostToolUse` (`^(?!subagent_response$)(subagent_.+\|invoke_sub_agent\|orchestrate_subagent)$`) | Records `SUBAGENT_COMPLETED` with the delegate's identity, one row per stage of an `orchestrate_subagent` pipeline. The matcher is broad so any delegate name reaches the adapter; it leaves out the auxiliary `subagent_response` shell, which the adapter also drops on every other entry point. The record that each delegate was sent (`SUBAGENT_DISPATCHED`) is written by the guard card once it lets the call through |
| after a command (`execute_bash\|execute_pwsh\|shell`) | no card: the next card does it | The two hooks below, in this order, once per command, by the next card that runs anyway and before anything else in it. When the command made a new piece of work, the rebuild gets its name, so the chat that ran it joins it |
| `rebuild-stage-graph` | after a command | Recompiles the runtime graph (gated on the audit tail) |
| `sync-workflow-state` | after a command | Forward-only sync of `Current Stage` from the latest `STAGE_STARTED` in the audit (the IDE surfaces no task payload to parse); a Unit reopen after that start leaves `Current Stage` where the reopen put it |

`aidlc-session-end` には**登録がありません**。Kiro の `Stop` トリガーは、会話の終わりではなく、両方のサーフェスで、すべてのアシスタントのターンの終わりに発火するので、それを登録すると、同じセッションのプロンプトの間に偽の `SESSION_ENDED` を追加してしまいます。Kiro が本物のセッション終了イベントを公開するまで、`SESSION_ENDED` は記録されません。

Kiro は、これらの登録の一つが動くたびに「Run Command Hook」カードを示します。ファイルの変更、コマンド、または別の agent へのハンドオフの前に一つ、その後には何もなく、読み取りや、ヘルパーが答えを返すときには何もなく、あなたが送るメッセージごとに一つ、各ターンの終わりに一つ (それはそのターンの最後の書き込みやコマンドも終わらせます)、ヘルパーが終わったときに一つです。hook ファイルが古いプロジェクトは、`config` が更新するまで、依然として、書き込み後のカード、コマンド後のカード、メッセージごとの二つ目のカードを持ちます。更新は `aidlc-write-audit-log.json`、`aidlc-after-shell.json`、`aidlc-terminal-command.json` を取り除きます。

### hook のデバッグ

hook が期待どおりにふるまわないなら、デバッグログをオンにすると、各 hook が自身の決定経路 (どのゲートを通ったか、解決したパス、なぜ出たか) を
`<record>/.aidlc-engine/hooks-health/hook-debug.log` に追加します。これは**デフォルトでオフ**です。ログは書かれず、ふつうの実行にオーバーヘッドはありません。有効にする方法は二つあり、どちらでも動きます。

- **ファイルシステムのマーカー (Kiro IDE で最も簡単):** プロジェクトで
  `touch aidlc/.aidlc-hook-debug`
  (PowerShell では `New-Item -ItemType File aidlc/.aidlc-hook-debug`)
  を実行します。次の hook 発火ですぐ有効になり (IDE の再起動は不要)、
  `rm aidlc/.aidlc-hook-debug` で戻します。
- **環境変数:** `export AIDLC_HOOK_DEBUG=1`。hook は IDE が起動した環境を見るので、IDE を終了し、その変数をエクスポートしたターミナルから開きます。
  Windows では、代わりに PowerShell でユーザー変数として設定し、
  `[Environment]::SetEnvironmentVariable("AIDLC_HOOK_DEBUG", "1", "User")`、それから IDE を終了して開き直します (`"1"` の代わりに `$null` を入れてもう一度実行するとオフになります)。

## Kiro での違い

| Area | Claude Code | Kiro IDE and Kiro CLI |
|------|-------------|----------|
| Hook registration | `settings.json` `hooks` block | `.kiro/hooks/aidlc-*.json` v2 hook files (Kiro IDE 1.x, Kiro CLI v3 engine) |
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available: use `/aidlc --status` and the progress line at each gate; for a chat that is filling up, see [When the chat fills up](#when-the-chat-fills-up) |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | `invoke_sub_agent` (Kiro IDE) or `orchestrate_subagent` (Kiro CLI) → all 14 Markdown personas, each running under the `tools:` and deny rules in its own frontmatter and the conductor's command allow |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` when a new session takes its first prompt, and on Kiro IDE `SESSION_RESUMED` when a prompt returns to an earlier chat (no genuine session-end trigger, so no `SESSION_ENDED`; no pre-compaction event) |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | None shipped; AI-DLC's own chat, its 14 delegated personas and the agents your plugins add get every server in your workspace and user `.kiro/settings/mcp.json`, and each call asks you first (on Kiro CLI from a persona's second step). |
| Quotes in recorded text on Windows | Recorded as typed | Kiro IDE runs the agent's commands in Windows PowerShell 5.1, which drops empty arguments and removes a double quote inside a value unless it is written as `\"`. The agent writes quotes that way, so answers and feedback are recorded with their quotes. A value that also holds `&`, `<`, `>`, `^`, or a pipe sign is written with single inner quotes instead, because the `aidlc` command runs through cmd.exe, which would act on those characters; the hook refuses a command where one would reach cmd.exe outside its quotes. If a question or answer still arrives split in two, AI-DLC refuses to record it and says how to pass it, so the audit trail never keeps only part of it |
| Turning a guard, summary confirmation, or plan approval off mid-workflow | Ask in your own words and the agent runs the setter, or type the switch in chat, for example `/aidlc config set summary-confirmation off` | The same, except on Kiro IDE builds that give hooks an empty message (such as 1.0.242), which refuse the setter too. There, for summary confirmation or plan approval, run the terminal command the refusal names to turn it off now for all work, including the work running now (on a native install, `aidlc config flags --bypass AIDLC_DISABLE_SUMMARY_CONFIRMATION --local --yes` or `--bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD`; `--clear-bypass` turns it back on); for another guard, update Kiro IDE and type the switch |

それ以外のすべて — 状態機械、監査証跡、intent ごとの記録ディレクトリ下の成果物
(`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`)、learnings の儀式、センサー、スコープ、depth／test-strategy — は同一にふるまいます。それが同一だからです。ネイティブインストールは `aidlc` 経由で派遣し、ソースコピーは `.kiro/tools/` から対応するツールを実行します。

プロジェクトの `aidlc/` ワークスペースはハーネス中立です。プロジェクトをハーネス間で移す (または両方を並べて動かす) ことはサポート対象ですが未検証です。`/aidlc
--doctor` は、アクティブなワークフローを持つ、衝突するハーネスのセットアップを検出すると警告します。

### Unit のレビュアーはその Unit だけを読む

Unit のレビューのあいだ、レビュアーはその Unit のファイルと、与えられた共有コントラクトだけを読むことになっています。Claude Code と他のハーネスでは、hook がそれを守らせます。Kiro では、どの hook もレビュアーの読み取りを見分けられないので、代わりに Kiro がレビュアーにそれを守らせます。Unit のレビューごとに、AI-DLC はレビュアーのコピー `.kiro/agents/aidlc-scoped-review-<id>.md` を書きます。その権限は、他のすべての Unit の `construction/` フォルダー (別の作業の同名の Unit を含む) での読み取りを拒否し、そのコピーを派遣します。Kiro はそうした読み取りを拒み、検索結果からそれらのファイルを除きます。`cat` のようなシェルの読み取りは対象外で、まずあなたに尋ねます。コピーは、Unit の設計が統合ポイントとして名指しするものでさえ、他のどの Unit のファイルも開きません。レビュアーは、そのポイントを代わりに findings として記します。コピーは、レビューが動くあいだ Kiro の agent リストと `/` メニューに現れます。AI-DLC がそれを派遣するので、選ぶ必要はありません。その判定が記録されると削除されます。判定なしにレビューが終わったコピー (隔離された `--single` の実行の外で、Unit やステージをそれなしに承認した) は、後で片付きます。その作業がフォルダーの現在のものであるあいだ、AI-DLC は、その作業の記録を読めるようになると、その中でチャットが始まるか、その中でレビューが求められるか記録されるときに削除します。差し戻したレビューのコピーは、その Unit かそのステージを承認するまで残れます。
閉じたチャットが残した、以降何もしていないコピーは残ります。AI-DLC は、それを、別のチャットでまだ動いているレビューと見分けられないので、あなたが削除できます。
AI-DLC の `.gitignore` ブロックは、コピーをコミットから除きます。AI-DLC が書くべきコピーを書けないとき、または Kiro にコピーの名前の agent がないとき (古い Kiro ビルドは読み込まないことがあります)、AI-DLC は、コピーなしのときと同じように、レビュアー自身を派遣し、このレビューはそのチェックなしで動くと一行で伝えます。doctor はそのとき hook の欠落を数えます。AI-DLC が書けなかったコピーは `reviewer-scope` の下で原因を名指しし、Kiro が読み込まなかったコピーは `kiro-adapter` の下で、そのファイル
(`<record>/.aidlc-engine/hooks-health/kiro-adapter.drops`) がコピーを名指しします。Kiro CLI 2.31.0 と Kiro IDE 1.3.0 で、そしてワークフロー全体として Kiro CLI 2.31.1 で測定しました。並行して作られる Unit や、レビュアーの読み取りスコープのチェックがオフのあいだは、コピーはありません。Guard Policy `off` のもと (enterprise 以外のすべてのプランのデフォルト)、`guard.reviewer-scope off` のもと、または
`AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` のもとです。そのときレビュアーは、その指示によってのみ Unit に守られます。そうしたプランでコピーを持つには、その作業についてレビュアーの読み取りスコープのチェックをオンにするようチャットで頼みます (または
`/aidlc config set guard.reviewer-scope on` と入力します)。コピーは書かれたときの権限を保つので、チェックをオフにしても次の Unit のレビューから適用されます。

### 一つの agent を自身のモデルと effort で

Kiro では、どの AI-DLC agent も、その agent にモデルや effort が設定されていなければ、あなたのチャットのモデルと effort (Kiro IDE で選ぶモデル、または Kiro CLI のセッションモデル) で動きます。Kiro は、委譲された agent を自身のモデルと effort で動かせます。たとえばレビュアーを別のモデルファミリーで動かせます。

```bash
aidlc config models --agent architecture-reviewer --model gpt-5.6-terra --effort high --project --yes
```

AI-DLC はモデルと effort を `aidlc.settings.json` に記録し、その agent の
`.kiro/agents/aidlc-architecture-reviewer-agent.md` に `model:` (引用された文字列として) と `effortLevel:` を書きます。Unit のレビュアーコピーもそれらを保ちます。Kiro は、次にその agent を派遣するとき、すでに開いているチャットでも、それらを読みます。モデルは、あなたの Kiro が提供するものの一つでなければなりません
(`kiro-cli chat --list-models`、または Kiro IDE のモデルピッカー)。提供しないものは、その agent の派遣に失敗することがあります。モデルが取らない effort はモデル自身のデフォルトで動き、モデルは与えられたが effort は与えられなかった agent は、あなたのチャットのではなく、そのモデルのデフォルト effort で動きます。`--model default` と
`--effort default` はそれらを再び外します。プリセットやグループの effort
(`--preset`、`--reviewing-effort`) は、Kiro では依然として何も変えず、セットアップはそこでプリセットを記録せず、コンダクターはあなたのチャットのモデルを保ちます。

AI-DLC は、同梱する agent ファイルのモデルと effort の行 (`model:`、`effortLevel:`、他のツールが使う `effort:`、`variant:`、`tier:` のキー) を所有します。Claude Code でと同じようにです。`aidlc config` は、設定を持つ agent のそれらを書くので、手でではなく `aidlc config models` 経由で変えてください。`aidlc config models --check` は、設定と一致しない `model:` や `effortLevel:`
の行を、手で加えたものを含めて報告します。自分で加えた agent ファイルは触れられません。

agent の effort はすべてのツールで共有され、そのモデルはツールごとに記録されるので、ある agent に別のツール向けに記録された effort は、Kiro でも適用されます。
Kiro の agent ファイルに、ファイルが持っていたものと異なるモデルや effort の値を書く `aidlc config` の実行は、その実行自身が変える値以外は、一行でそう伝え、
`aidlc config models --show --harness kiro-ide` を名指しします。これを見ると各値がどこに設定されているか分かります。その agent に `--effort default` (または `--model default`) を、それが入っているファイルに `--project`、`--local`、`--global` (マシン設定) を、プロジェクトが別のハーネスを持つとき `--harness kiro-ide` を付けると、それを外します (このやり方で外した effort は、すべてのツールで消えます)。
`effortLevel` は Kiro のドキュメントにありません。Kiro CLI 2.31.1 の
v3 エンジンと Kiro IDE 1.3.0 で測定しました。

### Kiro の Workflows 機能は AI-DLC のレビューとヘルパーを止める

Kiro IDE の **Workflows** 機能 (Settings > **Kiro Agent > Workflows:
Enabled**、または **Enable Workflows** コマンド) は、仕事をバックグラウンドワークフローとして動かします。それがオンのあいだ、チャットは AI-DLC がレビューとヘルパーに使うサブエージェントツールを失います。`aidlc` agent では、それらは決して動かず、メインチャットが自分でその仕事をします。Default agent では、それらはバックグラウンドで動き、チャットのターンはそれらが終わる前に終わり、それらが実行するコマンドごとに **Approval needed in agent-aidlc-...** パネルで尋ね、Kiro は `/aidlc` の依頼を、AI-DLC ではなく自身のワークフローに渡すことがあります。Workflows は、オンにしていなければオフです。

スイッチは、あなたのすべてのプロジェクトに対する Kiro の設定です。Kiro はそれをあなたのユーザー設定からだけ読むので、ワークスペースの `.vscode/settings.json` の値は何もしません。それがオンで、このコンピューターでまだ答えていないとき、AI-DLC は、それをオフにするか一度尋ねます。`aidlc config` のあいだ、または最初の Kiro IDE チャットでです。`aidlc config --yes` は推奨の答えを取り、それをオフにします。yes と言うと、AI-DLC はその一つの設定だけを変えます。それからコマンドパレット (Ctrl+Shift+P) から **Developer: Reload
Window** を実行し、開いているチャットがそれを取り込むようにします。no と言うとオンのままで、AI-DLC はもう尋ねません。

後から変えるには、Kiro Workflows をオフまたはオンに戻すよう agent に頼むか、次を実行します。

```bash
aidlc config trust --kiro-workflows off --yes   # or: on
```

Kiro 自身の **Disable Workflows** と **Enable Workflows** のコマンドも同じことをします。
`/aidlc --doctor` は、Workflows がオンのあいだ、そして Kiro の設定ファイルに AI-DLC が読み進められないエラーがあるあいだ、警告を示します (Kiro はそこから依然として Workflows をオンと読むことがあります。次のチャットが一度伝え、直し方はそのファイルのエラーです)。

Kiro CLI は自身の Workflows スイッチを持ちます (`/settings` > Features >
**Workflows**、あなたの Kiro CLI 設定 `~/.kiro/settings/cli.json` の
`chat.enableWorkflows`)。それがオンのあいだ、Kiro CLI は両方のサブエージェントツールを `aidlc` agent から取り去るので、AI-DLC のレビューとヘルパーは Kiro CLI チャットで動きません。その「Workflows: sub-agent tool」設定はそれらを戻しません (Kiro CLI 2.31.1 と 2.32.0 で測定)。Kiro CLI のチャットは、そのスイッチを自分の Kiro CLI 設定からだけ読むので、プロジェクトの
`.kiro/settings/cli.json` の値はそれをオフにしません。AI-DLC は、自身の答えとともに、同じやり方でそれについて尋ねます。`aidlc config` のあいだ、または最初の Kiro CLI チャットで一度です。`aidlc config
--yes` は推奨の答えを取り、それをオフにします。AI-DLC は、Kiro CLI 自身の `kiro-cli settings` コマンド経由でそれを変えます。終えたら Kiro CLI を終了して `kiro-cli
--v3` をまた起動します。後から変えるには、agent に頼むか、次を実行します。

```bash
aidlc config trust --kiro-cli-workflows off --yes   # or: on
```

それがオンのあいだ、`/aidlc --doctor` は警告を出します。

### Windows で Kiro のターミナルに Command Prompt を使う

Kiro IDE は、agent のコマンドをあなたのデフォルトのターミナルプロファイルで実行します。それが **Command Prompt** のとき、Kiro は、コマンドが一秒以内に終わるときだけ、そのコマンドの返答を AI-DLC に渡します (Command Prompt にはシェル統合がないので、Kiro はコマンドを送った一秒後に結果を読み、どの実行でも exit code -1 になります)。ほとんどの AI-DLC ステップはもっと時間がかかります。そこで Command Prompt では、どの
AI-DLC コマンドもまず一行 `AI-DLC reply: aidlc/.aidlc-sessions/replies/<id>.txt`
を出力し、その返答をそのファイルにもターミナルにも書きます。Kiro がその行で結果を切るとき、agent はコマンドをまた実行する代わりに、ファイルから返答を読みます (最新の二十の返答が、git が無視するフォルダーに保たれます)。agent が PowerShell のやり方でシングルクォートで書いた値は、Command Prompt から、クォートを付けたままいくつかの語として届きます。AI-DLC はそれらを一つの値へ戻します。ステップは依然として余分なターンがかかるので、Kiro 自身が PowerShell を勧めます。

Kiro のターミナルが Command Prompt で、このコンピューターでまだ答えていないとき、AI-DLC は、それを PowerShell に設定するか一度尋ねます。`aidlc config` のあいだ、または最初の Kiro IDE チャットでです。`aidlc config --yes` は推奨の答えを取り、それを設定します。yes と言うと、AI-DLC はその一つの Kiro 設定
(`terminal.integrated.defaultProfile.windows`。あなたのすべてのプロジェクトに対して) だけを変えます。それから Kiro を再起動し、そのチャットがそれを使うようにします。no と言うとそのままで、AI-DLC はもう尋ねません。

後から設定するには、agent に頼むか、次を実行します。

```bash
aidlc config trust --kiro-terminal powershell --yes
```

Kiro 自身の **Terminal: Select Default Profile** コマンドも同じことをします。
`/aidlc --doctor` は、Kiro のターミナルが Command Prompt のあいだ警告を示します。

ターミナルが Command Prompt のあいだ、どの Kiro IDE チャットも、そのターミナルがどうふるまうか、頼んだときに PowerShell をどう設定するかを告げられるので、どのチャットも「set Kiro's terminal to PowerShell」を実行できます。Command Prompt を保ったなら、ステップの返答が初めて失われたとき、agent は何が起きたか、PowerShell がそれを避けることを一度伝えます。もう尋ねません。

### Windows でコマンドカードが「dministrator: ...powershell.exe」で終わる

Windows では、Kiro IDE のコマンドカードが、次のような行で終わることがあります。
`dministrator: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
を一度か二度です。これはターミナルウィンドウのタイトルで、出力の表示時に短く切られたものにすぎません。コマンドの結果も、AI-DLC が記録する内容も変わりません。

Kiro の設定に `"terminal.integrated.windowsUseConptyDll": false` を加えていたら、それを外して Kiro を再起動してください。それは Kiro にコマンド出力を折り返させ、Code Generation を止めることがあります。

### Kiro のメモリは古い AI-DLC の助言を運ぶ

Kiro IDE は、メモリをプロジェクトの外、ホームフォルダー下の `.kiro/memories/memories.db`
(Windows では `%USERPROFILE%\.kiro\memories\memories.db`) に保ち、開くすべてのワークスペースに読み込めます。以前の AI-DLC の実行で agent が保存したメモリは、そのプロジェクトとバージョンにだけ合い、他のどこでも誤っていたり安全でなかったりする診断や回避策を含むことがあります。`record-human-turn` のような hook コマンドを手で実行する、`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` を設定する、サマリー確認をオフにする、Kiro IDE を「sessionless」なハーネスと呼ぶ、などです。AI-DLC は agent に、そうした助言を決して保存せず、決してそれに従わないよう告げますが、それより前に保存されたメモリは依然として読み込まれます。

agent が「per my memory」と言ってこれらの一つを勧めたり、すでに Kiro IDE にいるのに「from Kiro IDE」から再開するよう告げたりしたら、次を行います。

1. そのメモリを無視し、今 `/aidlc` が言うことに従うよう告げます。ガードとチェックポイントはあなたが切り替えるものです。agent がコマンドを名指しし、あなたが入力します。
2. その種の助言を与えるメモリだけを削除します。AI-DLC の hook コマンドを手で実行する、ガードを飛ばす変数を設定する、チェックポイントをオフにする、Kiro IDE を「sessionless」と呼ぶ、すでにそこにいるのに Kiro IDE から再開するよう告げる、です。残りは保ちます。正確な Kiro IDE のノート (たとえばステータスラインがないこと)、他の AI-DLC のノート、`AIDLC_HOOK_DEBUG` のようなデバッグのヒントを含めてです (メモリの管理は Kiro のドキュメントを確認してください)。
3. 何かを削除する前に `memories.db` のコピーを保ち、ファイルを直接編集するならまず Kiro IDE を閉じます。それは AI-DLC のものだけでなく、Kiro のすべてのメモリを持ちます。

## フレームワーク開発者向け

`dist/kiro-ide` は、`core/` と `harness/kiro-ide/` から
`bun scripts/package.ts kiro-ide` によって**生成されます** (`{{HARNESS_DIR}}` トークンを
`.kiro` に置き換え、`rules/` → `steering/` にリネームしたコアのコピー)。その出力は git 無視のローカルです。`bun scripts/package.ts --check` は、独立した二つの一時ルートで二度ビルドし、その結果をバイト比較します。これが CI の決定論ガードです。Kiro IDE のサーフェスのオーサリング元は `harness/kiro-ide/` にあります。オーケストレーター skill
(`skills/aidlc/`)、常に含まれる active-memory の steering (`steering/`)、コンダクターの Markdown (`agents/aidlc-aidlc.md`)、hook アダプターと v2 hook JSON
ファイル (`hooks/`)、ペルソナの委譲シェル拒否 (`delegate-shell-deny.ts`)、オンボーディングの埋め込みです。それら
(または `core/`) を編集し、生成された `dist/kiro-ide` を手で編集しないでください。

このハーネスは、`kiro` CLI ハーネス (`harness/kiro/`) と四つの点で異なります。`/aidlc` skill と Markdown の `agents/aidlc-aidlc.md` がそのコンダクターのサーフェスです
(`settings/cli.json` はその agent を Kiro CLI のデフォルトにもします)。v2 hook
JSON ファイルを同梱します (`kiro` ハーネスは agent JSON の `hooks` ブロックに頼ります)。standing ルールを、CLI agent の resources ではなく、常に含まれる steering 経由で事前読み込みします。共有の Kiro プロジェクションは、コアペルソナの Claude 専用の `disallowedTools` キーを取り除きます。そしてそのマニフェストは、両方のハーネスが加える `tools:` の行の隣に、すべてのペルソナに `permissions.rules` フロントマターを加えます (ステージがインラインで読む各ペルソナも、それらなしで `.kiro/aidlc-common/personas/<agent>.md` として同梱されます。リードが自身のチャットで読むファイルです)。
`kiro` ハーネスの agent-v1 JSON は同梱しません。
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md) を参照してください。

## 次のステップ

インストールして有効化しましたか。メソドロジーはどのハーネスでも同じです。中立の章で続けてください。

- [Your First Workflow](../02-your-first-workflow.md) — 注釈付きのエンドツーエンドの実行。
- [Phases and Stages](../04-phases-and-stages.md) — 5 つのフェーズと 33 のステージ。
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — 実行の適切なサイズ調整。
- [Glossary](../glossary.md) — すべての用語の定義。

他のハーネス: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md)。

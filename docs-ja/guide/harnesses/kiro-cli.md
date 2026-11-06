# Kiro CLI で AI-DLC を実行する

> [!NOTE]
> Kiro CLI での AI-DLC は **Claude Opus 4.8** で最もよく動きます。これには
> **有料の Kiro プラン**が必要です。弱いモデルでは、コンダクターが任意のステージ
> ステップ (レビュアーのパス、learnings の儀式) を飛ばしたり、承認ゲートを急いだりします。
> IDE 向けの配布形態は
> [Kiro IDE で AI-DLC を実行する](kiro-ide.md)で別に説明しています。

> [!IMPORTANT]
> このページは `kiro` ハーネスを扱います。これは Kiro エンジンを固定しません。
> `kiro-cli --v2` で起動します (Kiro CLI 2.21.4 以降。古いものは
> [前提条件](#prerequisites)を参照)。対話的な
> `aidlc config` はこれを Kiro CLI (V2) として挙げます。Kiro
> CLI 2.24.1 以降を検出すると、これを Kiro より優先してデフォルトにします。ただし Kiro IDE
> 自身のターミナルでは Kiro が先に立ちます。Kiro CLI 2.24.1 以降で Kiro の v3 エンジンを
> 使うには `kiro-ide` ハーネスを使います。これは Kiro として挙げられ、Kiro CLI
> (`kiro-cli --v3` で起動) でも Kiro IDE でも動きます。既存の `kiro` プロジェクトでは、
> `aidlc config --harness kiro-ide` が `.kiro/` をその場で切り替え、`aidlc/`
> はそのまま保ちます。

フレームワークのハーネスの一つです。Kiro ランタイムは、同じ AI-DLC
メソドロジーを [Kiro CLI](https://kiro.dev/docs/cli/) で動かします。決定論的なコアは一つ
— ツール、33 のステージファイル、プロトコル、knowledge、センサー、スコープ、ルール
— で、どのハーネスでもバイト単位で共有されます。異なるのはシェル (skills、agent
設定、hook の配線、起動) だけです。

ハーネス固有のオンボーディングは `.kiro/steering/aidlc-onboarding.md` にあり、コンダクター agent の `resources` から読み込まれます。ルートの `AGENTS.md` ブロックはハーネス中立で、インストール済みの他のハーネスと共有されます。エンジンディレクトリは依然として異なる必要があります (`kiro` と `kiro-ide` の行は一つの `.kiro/`
インストールを共有できません)。

## 前提条件

- **Kiro CLI 2.6 以上** (`kiro-cli --version`)、ログイン済み (`kiro-cli login`)。
  このページのコマンドは、Kiro CLI を V2 エンジンで `--v2` 付きで起動します。これには
  Kiro CLI 2.21.4 以降が必要です。古いものでは、
  `kiro-cli chat --help` が挙げるものを確認してください。
  - `--agent-engine` がある場合 (2.19.2 にはあります)、`--v2` の代わりに
    `chat --agent-engine v2` を置きます。`kiro-cli --v2 --agent aidlc` は
    `kiro-cli chat --agent-engine v2 --agent aidlc` になり、`kiro-cli chat --v2 …`
    は `kiro-cli chat --agent-engine v2 …` になります。
  - それがない場合は、`kiro-cli chat` をエンジンフラグなしで起動します (たとえば
    `kiro-cli chat --agent aidlc`)。
- **bun** は、ソース／開発の `dist/` プロジェクションを生成または実行するときだけ必要です。ネイティブインストールとバージョン付きのリリースランタイムは自己完結です。

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
```

インストーラーは、リリースのメタデータ、実行ファイル、全ハーネスのランタイムアーカイブを、公開されている SHA-256 チェックサムと照合します。インストール済みのランタイムに Bun、Node.js、Git は不要です。ハーネスの選択は `aidlc config` で行います。

Windows では `install.ps1` をダウンロードして
`& $installer` を実行します。アカウントスコープ、User PATH への自動登録、`-NoModifyPath` については
[Windows installation](../18-install-and-lifecycle.md#windows-powershell) を参照してください。
エアギャップ環境向けのパッケージには、Unix では
`install.sh --from <release-directory> --offline`、Windows では
`& $installer -From <release-directory> -Offline` を使います。

最初のチャットセッションの前に、`aidlc config` が Kiro シェルを投影します。それから、プロジェクトルートで Kiro を起動します。

```bash
kiro-cli --v2
```

ネイティブのプロジェクションは、`aidlc engine *` のエンジンコマンドと、正確な読み取り専用コマンドおよびチェックを再び有効にするコマンド (`aidlc doctor`、`aidlc config <section> --show --json`
と、以下のセッション開始の項で挙げるもの) を許可します。また
`.kiro/settings/cli.json` に `chat.defaultAgent: "aidlc"` を同梱するので、エージェントフラグなしでも `/aidlc` が有効です。最初のワークフローの前に、チャットで `/aidlc --doctor` を実行してください。

### バージョン付き手動コピーの代替手段

特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` を
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) の説明どおりにダウンロードして展開し、
`RUNTIME_ROOT` を展開された `runtime/` ディレクトリに設定します。

```bash
mkdir -p your-project/.kiro your-project/aidlc
cp -R "$RUNTIME_ROOT/kiro/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro/aidlc/." your-project/aidlc/    # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cd your-project && bun .kiro/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness kiro
```

`aidlc/` ディレクトリはワークスペースシェルです。エンジンが読む、作り付けの
`aidlc/spaces/default/memory/` メソッドツリーを同梱します。これは `.kiro/`
の**兄弟**なので、別にコピーします (または `$RUNTIME_ROOT/kiro/` ツリー全体を一度にコピーします)。
これがないと `/aidlc --doctor` は「workspace shell ready」のチェックに失敗します。

バージョン付きランタイムはネイティブの `aidlc` コマンドを使います。Bun の形のソースプロジェクションが必要なフレームワーク開発者は、リポジトリをクローンし、
`bun install --frozen-lockfile` と `bun scripts/package.ts` を実行してから、git 無視のローカル `dist/kiro/` 出力を代わりに使えます。

同梱の `.gitignore` は、ワークスペースのコミット／無視の切り分けを運びます。ユーザーごとのカーソル (`aidlc/active-space`、`aidlc/spaces/*/intents/active-intent`) とマシンローカルのランタイム (`aidlc/.aidlc-clone-id`、`runtime-graph.json`、センサー
キャッシュ、`spaces/*/knowledge/.sources.local.json`) は追跡対象外のままで、共有される記録 — メソッド memory、状態、監査シャード、成果物 — は git と一緒に動きます。最後の行、つまりコピー自身のセットアップが、それらの行と `AGENTS.md` の AI-DLC の部分を、ファイルにすでにあるすべての後ろへ加えるか、プロジェクトに何もないときはファイルを作ります。こうして AI-DLC のルールは、最初のワークフローの前にそろいます。

それから、プロジェクトでセッションを開始します。

```bash
cd your-project && kiro-cli --v2
```

インストールは `.kiro/settings/cli.json` に `chat.defaultAgent: "aidlc"` を同梱するので、AI-DLC コンダクター agent がデフォルトで有効になり、`/aidlc` がそのまま使えます。
**このワークスペース設定は、あなたが設定しているかもしれないグローバルのデフォルト agent より優先されます**。自分のデフォルトを使いたいなら、その設定を外して
`kiro-cli --v2 --agent aidlc` を代わりに使ってください。

Kiro CLI は、`api.subagentTimeout` 秒のあいだ進捗を示さないヘルパー (レビュアー、ペルソナ、Unit ビルダー) を打ち切ります。そのデフォルトは 3600 で、AI-DLC は設定しません。始まらないヘルパーがステージを一時間抱え込むなら、自分の Kiro CLI 設定 (`~/.kiro/settings/cli.json`。`900`
は 15 分) で下げられます。出力は進捗として数えられ、沈黙は数えられません。それより長く何も出力しないヘルパーも打ち切られ、そのコマンド自体は動き続けるので、締め切りは最も長い静かなコマンド (デプロイ、最後にだけ出力するテスト実行) より上に保ってください。

同梱の agent はどれもモデルを固定しません。固定された ID は、そのモデルがユーザーの Kiro インストールで有効なときだけ解決します。チャットと、コンダクターが派遣する 14 のペルソナのそれぞれは、あなたのセッションモデルで始まります。これは Kiro 設定に保存されたもの (何も保存していなければ Kiro auto) です。`/model`
は今いるチャットだけを変えるので、コンダクターはそれに従い、ペルソナは依然として保存されたモデルで始まります。それらも動かすには、`/model set-current-as-default` で切り替えを保存するか、`aidlc config models --session-model <id>` でモデルを選んでください。

### セッションのモデルと effort

Kiro CLI は各 AI-DLC セッションを一つのモデルで動かし、エージェントごとの effort の面を持たないので、AI-DLC はセッションのモデルと effort を、あなたの**個人**の
Kiro 設定 (`~/.kiro/settings/cli.json`。Kiro 自身の
`/model set-current-as-default` が書くファイル) に保ち、プロジェクトには決して保ちません。モデルのリストは Kiro アカウントごとに異なり、同僚のアカウントにないプロジェクトモデルは、その人が送るすべてのプロンプトで失敗します。プロジェクトの `chat.modelDefaults` も、プロジェクト内であなたの個人マップ全体を置き換えてしまうので、同梱の `cli.json` はそれを運びません。

初回セットアップのステップ 2「Session model」は、Kiro アカウントが提供するモデルを、Kiro の並び順で、各モデルのクレジット倍率と `preview` または
`internal` タグ付きで挙げます。Kiro auto (Kiro 自身のデフォルトで、タスクごとに Kiro がモデルを選ぶ) のとき、AI-DLC はモデルを選ぶことを勧めます。そうすればあなたの effort プリセットがそれに適用されます。プリセットは、対話的セッション全体に一つの effort を設定します (Kiro CLI 2.28.0 は、保存された effort を
`kiro-cli chat --v2 --no-interactive` の実行には適用しません。そこでは `--effort` を渡してください)。

| Preset | Session effort |
|--------|----------------|
| `minimal` | `low` |
| `balanced` | `medium` |
| `thorough` | `xhigh` (extra-high) |

そのレベルを持たないモデルは一つ下のレベルになり、effort 設定のないモデルはモデルだけを保ちます。推奨されるデフォルトは、あなたがモデル用に effort を保存していない箇所にだけ effort を埋めます。すでに保存した effort は残り、セットアップはプリセットと異なるときに一行でそう伝えます。自分でプリセットを選ぶ (ステップ 3 または `aidlc config models` で) か、`aidlc config models` でセッションモデルを選ぶと、プリセットの effort が設定されます。agent やグループの設定はそのままにされます。`aidlc config models` は後から同じ選択肢 (「1 session model, 2 preset」) を示し、
`aidlc config models --session-model <id>` はアカウントのリストからモデルをプロンプトなしで保存します。アカウントがもう提供しない保存済みモデルはすべてのプロンプトで失敗するので、セットアップはそれを保つ代わりに別のモデルを尋ねます。`--dry-run` は個人の Kiro 設定の変更も示し、何も書きません。Kiro が書き込みを拒むと、AI-DLC は何が保存されたかを正確に伝え、`config models` は 5 (action needed) で終了します。
`aidlc doctor` は実際の設定を確認します。モデルがまだ提供されているか、保存された effort がモデルの提供するものか (プリセットが記録され、Kiro がモデルの effort レベルを挙げるとき)、どのプロジェクトファイルもそれを上書きしていないか、です。プリセットと異なる、あなたが保存した effort はあなたのものです。doctor はプリセットのレベルとそれを適用するコマンドを、警告なしで名指しします。古いリリースでセットアップしたプロジェクトを更新すると、AI-DLC の古い effort マップ (`claude-opus-4.8` が extra-high) を
`.kiro/settings/cli.json` から取り除き、そう伝えます。セッションモデルを選ぶには
`aidlc config models` を実行してください。
一つのセッションだけ上書きするには、チャットで `/effort <level>` または `kiro-cli chat --v2
--effort <level>` を使います (low|medium|high|xhigh|max。古い Kiro CLI は前提条件を参照)。Kiro IDE は `cli.json` を読みません。

## 更新とバージョンのずれ

`aidlc update` はマシンのランタイムを更新しますが、プロジェクトファイルはそのままにします。
選択中のエンジンと異なるプロジェクトのスタンプは、`aidlc doctor` が報告します。ワークフローの合間に、更新をプレビューして適用します。

```bash
aidlc config --dry-run
aidlc config
```

Config はユーザー所有の内容を保ち、ローカルのフレームワーク編集を衝突として報告します。ワークフローを開いたままの更新は完了し、開いている作業は続くと伝えます。アップグレードとロールバックは、プロジェクトを変更しないので、ワークフロー中でも安全なままです。

## 使い方

プロジェクトで `kiro-cli --v2` を起動し、`/aidlc <description>` でコンダクターを呼び出します。`/aidlc --status` は位置を報告します。`/aidlc --config [section]` はプロジェクト設定の変更をセッション内で集めます。`/aidlc --doctor`、`--stage`、`--phase`、`--depth`、`--test-strategy` はすべて動きます。ワークスペースのナビゲーションには `/aidlc intent [name]`、`/aidlc space [name]`、`/aidlc space-create <name>` を使います。ステージごとの (`/aidlc-domain-design`) とスコープごとの (`/aidlc-feature`) ランナー skill もインストールされます。

status、doctor、help、version、ワークスペースナビゲーションのコマンドは、モデルがそれらをワークフローの作業に変える前に、Kiro の hook が捌きます。その子出力は UTF-8 としてデコードされ、ターミナルのプロトコル／制御バイトは、そのプレーンテキストの中継境界でだけ取り除かれます。ふつうの Unicode、パス、タブ、改行、エスケープに見える文字どおりのテキストは変わりません。

**セッションはプロジェクトルートから開始してください。** ネイティブインストールは、インストール済みの `aidlc engine ...` コマンドと、次に挙げる同じ読み取り専用コマンドおよびチェックを再び有効にするコマンドを、書かれたとおり、`aidlc ...` として実行し、事前承認します。
ソース／開発コピーは、AI-DLC 自身のワークフローコマンドだけを、プロジェクト相対で事前承認します。エンジンコマンド
(`bun .kiro/tools/aidlc.ts engine ...`)、読み取り専用の `doctor`、`version`、
`--version`、`--doctor` (`--verbose` の有無によらず doctor)、`status`、
`--status`、`config --help`、`config --show` と
`config <section> --show` (`--json` の有無によらず)、そして
`config <section> --help`、チェックを再び有効にする
`config flags --clear-bypass <switch> --yes`、AI-DLC のツールスクリプト
(`bun .kiro/tools/aidlc-<tool>.ts`) です。それ以外の `config` 変更 (チェックを無効にするものを含む)、マシンの AI-DLC インストールを変えるコマンド (`use`、`update`、`rollback`、`uninstall`、
`system`) とその裏のツールスクリプト (`aidlc-doctor.ts`、`aidlc-init.ts`、
`aidlc-lifecycle.ts`、`aidlc-machine-config.ts`)、絶対パス、
`KIRO_PROJECT_DIR` の展開、そして事前承認されないコマンドを加える行 (その前の `cd`、あるいは別のコマンドへのパイプや `&&`) は、依然として確認します。

**依然として確認が入るもの。** developer agent と `aidlc` agent は、プロジェクトファイルを確認なしで書きます。トップレベルの名前がドットで始まらない、プロジェクト内のどのパスでもです。side-by-side のビルドでは、ワーカーが Unit のチェックアウト
(`.aidlc/worktrees/<unit>/`) に同じやり方で書きます。そこのコードと記録は確認なしで通り、そのチェックアウト自身の `.git`、`.gitignore`、他のドットエントリーは確認します。Kiro CLI の v2 エンジンでは、そのチェックアウトのドットフォルダー (その `.kiro/`、`.github/`) も通り、Unit が着地するまでそのチェックアウトに留まります。それらの `.kiro/` への書き込み (`aidlc` agent 自身の
`.kiro/sensors/` ファイルは除く)、`.git/`、他のどのトップレベルのドットエントリー、そしてプロジェクトの外のものは、依然として確認します。あなた自身のテストとビルドのコマンド (`bun test`、`npm test`、`pytest` など)、`git push`、再帰的な削除も依然として確認するので、実行の前に一つずつ目にします。side-by-side のビルドでは、ワーカーとレビュアーは、あなたが承認したテストコマンドを AI-DLC 自身の `swarm check` 経由で実行し、それは確認しません。side-by-side のビルドでワーカーやレビュアーが確認を求めると、Kiro はそれらの要求を「tool approval pending」のボックスにまとめます。そこで (f) **Approve all pending and
auto-approve future subagent requests** を選ぶと、それらは、後で始まるレビュアーを含め、そのチャットの残りのあいだ、確認なしで要求どおりに実行できます。メインチャットからの要求は従来どおり確認し、Kiro はそれの設定を何も書きません。

**承認者のいないセッションは、プロンプトを出さずに止まります。** 事前承認のセットの外にあるものは、対話的な答えを必要とします。`kiro-cli chat
--v2 --no-interactive` のもとでは尋ねる相手がいないので、Kiro はコマンドをきっぱり拒み、`non-interactive mode (no user to approve)` を返します。ACP 越しでは、あなたのクライアントが
`session/request_permission` に答えなければなりません。それらの要求を無視するクライアントは、権限の失敗とまったく同じに見えます。`--trust-all-tools` は、`git push` と再帰的な削除を含め、すべてのコマンドを確認なしで実行します。全面的なシェルアクセスが許される使い捨てのサンドボックスの中でだけ使ってください。

**hook は Kiro CLI の v2 エンジンで、ACP 越しを含めて動きます。** この配布形態は、hook を `.kiro/agents/aidlc.json` に登録します。Kiro CLI は、`aidlc` agent がアクティブなあいだ、そのブロックを v2 エンジンで動かします。`kiro-cli acp`
も、`kiro-cli --v2` と同じやり方で `chat.defaultAgent` から agent を選びます。Kiro CLI の v3 エンジンは、AI-DLC が同梱する形ではそのファイルを動かさないので、セッションが v3 で始まる (たとえばクライアントが `kiro-cli acp --agent-engine v3` を起動する) か、別の agent に切り替わると、これらの hook はどれも動きません。hook がないと、`HUMAN_TURN` の受領が記録されないので、すべての承認と確認が拒まれます。書き込みイベントも記録されないので、レビューも拒まれます。

Kiro 自身が作るプロンプト (たとえば、サブエージェントが返った後に新しい
kiro-cli が送る `[SYSTEM] Sub-agent synthesis:` メッセージ) は、あなたのターンとして数えられません。これは `HOST_TURN` として記録され、どの質問にも答えません。あなた自身のメッセージは言葉が何であれ数えられます。Kiro のチャット記録がどちらかを示し、不明なものはあなたのものです。
最初のワークフローステージの後、`/aidlc --doctor` はこれを「Hooks have
never executed」と報告します。その前は、doctor が、AI-DLC の hook がこのプロジェクトでまだ動いていないと警告し、同じステップを名指しします。v3 エンジンで再起動してもこれは直りません。別の agent が選ばれているときは、`/agent` と入力して `aidlc` を選び、同じチャットで続けます。3.0 エンジンでは (Kiro が返信の下に
`agent "aidlc" needs upgrading for this agent engine` と表示します)、終了して、このフォルダーで `kiro-cli --v2 --agent aidlc` を代わりに起動します (ACP クライアントは `kiro-cli acp --agent-engine v2` を起動します)。Kiro
CLI を v3 エンジンで動かすには、
[Kiro IDE](kiro-ide.md) の配布形態を代わりに使います。既存のプロジェクトでは、
`aidlc config --harness kiro-ide` が `.kiro/` をその場で切り替え、`aidlc/`
を保ちます。それから `kiro-cli --v3` を起動します (フォルダーを信頼するか尋ねられ、中身が分かっているなら **Trust, continue** を選びます)。
[Kiro CLI hooks not running](../15-troubleshooting.md#kiro-cli-hooks-not-running) を参照してください。

### チャットがいっぱいになるとき

Kiro はチャットがどれだけ埋まっているかをあなたに示しますが、作業中の AI-DLC には数字を与えません。そこで AI-DLC は、Kiro が各ターンの終わりにチャット用に保存する数字 (`~/.kiro/sessions/cli/<chat id>.json`。読み取り専用) を読みます。それが 80% 以上になると、次の承認の質問または Unit のチェックポイントが、チャットがどれだけ埋まっているかを伝える一行を、一時停止して新しいチャットで続ける申し出とともに運びます。あなたの答えで決まります。自分で一時停止するものはなく、その行は一つのチャットで一度だけ伝えられます。

その行は、ステージの途中では現れません (いずれにせよ尋ねられる質問とともにだけ来ます)。また、Kiro がチャットの最初のターンを保存する前、このマシンに記録のないチャット、Kiro の更新が数字の保存のしかたを変えたときも現れません。Kiro 自身の数字が上がっていくのを見たら、手で同じことができます。

1. ステージの境界で止まります。同じ返信で承認して今は止めたいと伝えるか、
   `/aidlc park` と入力します。`/aidlc --status` は今や
   `Paused at <stage> (you stopped it); pick it back up with /aidlc --resume` を示します。
2. 新しいチャットのために `/chat new` と入力します。Kiro は古いものを保ち、`/chat resume`
   で戻せます。今いるチャットをリセットする `/clear` ではなく、これを使ってください。
3. `/aidlc --resume` と入力します。`/aidlc --status` はもう Paused と言いません。

古いチャットが話したがファイルに書かなかったものは引き継がれません。だからステージの終わりが最良のタイミングです (see
[Changing Model Mid-Workflow](../11-session-management.md#changing-model-mid-workflow))。

## Kiro での違い

| Area | Claude Code | Kiro CLI |
|------|-------------|----------|
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available: use `/aidlc --status` and the progress line at each gate; for a chat that is filling up, see [When the chat fills up](#when-the-chat-fills-up) |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | Kiro `subagent` tool → the agent configs (all 14 personas ship configs) |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` only (Kiro has no session-end / pre-compaction hooks) |
| Forwarding-loop enforcement (Stop hook) | Interactive + headless | Interactive sessions only — `--no-interactive` runs do not honor the stop-hook block |
| Permissions | `settings.json` allowlist | Source-generated projection: AI-DLC's own project-relative workflow commands (engine, read-only dispatcher commands, AI-DLC tool scripts); native and versioned release runtimes: `aidlc engine *`. Other shell commands prompt. |
| Welcome message | Rendered at session start from `settings.json` `companyAnnouncements` | None — Kiro has no welcome-render equivalent; the session-start hook injects resume context only |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | Ships the same 5 in `.kiro/settings/mcp.json`, all disabled by default; flip `"disabled": false` per server to enable it. Context7 is keyless on Kiro because Kiro sends configured HTTP header values verbatim instead of expanding environment placeholders. AI-DLC's own chat and its 14 delegated personas get every server in this file and in your `~/.kiro/settings/mcp.json` as of the last time config ran, and each call asks you first; a server you add later reaches them after you run config again. On Kiro CLI's v3 engine a persona gets every server in those files without a config run, from its second step. |

それ以外のすべて — 状態機械、監査証跡、intent の記録ディレクトリ下の成果物
(`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`)、learnings の儀式、センサー、スコープ、depth／test-strategy — は同一にふるまいます。それが同一だからです。ネイティブインストールは `aidlc` 経由で派遣し、ソースコピーは `.kiro/tools/` から対応するツールを実行します。

プロジェクトの `aidlc/` ワークスペースはハーネス中立です。プロジェクトをハーネス間で移す (または両方を並べて動かす) ことはサポート対象ですが未検証です。`/aidlc
--doctor` は、アクティブなワークフローを持つ、衝突するハーネスのセットアップを検出すると警告します。

## フレームワーク開発者向け

`dist/kiro` は、`core/` と `harness/kiro/` から
`bun scripts/package.ts kiro` によって**生成されます** (`{{HARNESS_DIR}}` トークンを
`.kiro` に置き換え、`rules/` → `steering/` にリネームしたコアのコピー)。その出力は git 無視のローカルです。`bun scripts/package.ts --check` は、独立した二つの一時ルートで二度ビルドし、その結果をバイト比較します。これが CI の決定論ガードです。Kiro のサーフェスのオーサリング元は `harness/kiro/` にあります。オーケストレーター skill
(`skills/aidlc/`)、agent の JSON (`agents/`)、hook アダプター
(`hooks/aidlc-kiro-adapter.ts`)、`settings/cli.json`、`settings/mcp.json`、`onboarding.fills.ts` です。それら (または `core/`) を編集し、生成された `dist/kiro` を手で編集しないでください。
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md) を参照してください。
ビルドは、それらの agent JSON のすべての hook コマンドに `; exit $LASTEXITCODE` を追加します (マニフェストの `hookCommandSuffix`)。Kiro CLI は hook を Windows では PowerShell で、それ以外では bash で起動し、その形は、どちらでも hook の exit
2 を Kiro に返すので、拒否は Windows でもツール呼び出しを止めます。

ライブ TUI のジャーニーテストが Claude の双子の隣にあります。
`tests/e2e/t-tui-kiro-intent-capture.serial.test.ts` は、同梱ツリーに対して `kiro-cli chat`
をキーストロークで駆動します (番号付き散文のゲートを「1」= 推奨の選択肢で答え、ディスク状態で終了)。`AIDLC_KIRO_TUI_LIVE=1` でオプトインします。tmux、`kiro-cli`、ログイン済みの Kiro セッションがないと、理由を添えてスキップします。

## 次のステップ

インストールして有効化しましたか。メソドロジーはどのハーネスでも同じです。中立の章で続けてください。

- [Your First Workflow](../02-your-first-workflow.md) — 注釈付きのエンドツーエンドの実行。
- [Phases and Stages](../04-phases-and-stages.md) — 5 つのフェーズと 33 のステージ。
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — 実行の適切なサイズ調整。
- [Glossary](../glossary.md) — すべての用語の定義。

他のハーネス: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md)。

# はじめかた

このページは、何もない状態から最初の承認済みステージまでを案内します。AI-DLC をインストールし、
`aidlc config` でプロジェクトを設定し、`aidlc doctor` で確認し、Claude Code で `/aidlc` を
最初の承認まで実行します。下の画面はどれも、まっさらなホームフォルダでの実機の実行からで、
断りのある箇所は刈り込んでいます。例の中で、`X.Y.Z` はインストールしたリリースを、`/home/you`
はあなたのホームフォルダを表し、Claude Code の作図文字（枠、矢印、チェック）はプレーンテキストで
示すか省いています。ほかのツールはいくつかのステップで違い、[ほかのツールでは](#on-the-other-tools)
に挙げます。

## 始める前に

- **ハーネスを 1 つ、インストールしてサインイン済みに。** このページは Claude Code を使います。
  3 つのツールについて、AI-DLC は動く最も古いバージョンを確認し、あなたのが古いと
  `aidlc doctor` が伝えます。

  | ツール | 最も古いバージョン |
  | --- | --- |
  | Codex CLI | 0.145.0 |
  | GitHub Copilot CLI | 1.0.74（VS Code だけのインストールは CLI を含まないことがあります） |
  | Kiro CLI | `kiro` 行は 2.6.0、`kiro-ide` 行は 2.24.1 |

- **Git。Codex CLI と Cursor 向け。** Codex CLI は Git リポジトリの中でだけプロジェクトのフックを
  見つけ、Cursor はその外では飛ばすことがあるので、新しいフォルダでは `aidlc config` の前に
  `git init` を実行してください。
- **ほかには何も要りません。** ネイティブのインストーラーが、AI-DLC の動くものをすべて持ってきます。
  Bun や Node.js は要りません。

## 1. AI-DLC をインストールする

macOS、Linux、WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

インストーラーは、AI-DLC に必要なものをすべて用意します。ネイティブの `aidlc` コマンドと、
各ハーネスの実行環境です。Bun や Node.js は要りません。ネイティブインストールは、フックと
コマンドを `aidlc` 経由で走らせ、`bun` を呼びません。Windows では、いま使っているアカウント
向けにインストールし、bin ディレクトリを永続の User PATH に登録し、いまの PowerShell プロセスを
更新します。ふつうの PowerShell ウィンドウから実行してください。「管理者として実行」で開いた
ウィンドウは、管理者としてのインストールが安全でないため、警告が出て確認を求められます。すでに
開いていたターミナルや IDE（Kiro、VS Code、Cursor）は、始めたときの PATH を持ったままなので、
`aidlc` を使う前に閉じて開き直してください。中でタブを開き直すだけでは足りません。PATH の変更を
どちらもしたくなければ、[`-NoModifyPath`](18-install-and-lifecycle.md#windows-powershell) を
使い、代わりに表示される直接のコマンドを呼びます。macOS、Linux、WSL では、`aidlc` が見つからない
ときはインストーラーの PATH の指示を当ててください。

macOS と Linux では、`~/.local/bin` がすでに PATH にあると、こう終わります。

```text
PASS installed AI-DLC X.Y.Z with all harness runtimes
Plugin marketplace for Claude Code and Codex: /home/you/.local/share/aidlc/plugins (add it once; updates keep it current)
Next: aidlc config
```

なければこうです。

```text
PASS installed AI-DLC X.Y.Z with all harness runtimes
Plugin marketplace for Claude Code and Codex: /home/you/.local/share/aidlc/plugins (add it once; updates keep it current)
Add AI-DLC to PATH for this shell:
  export PATH="/home/you/.local/bin:$PATH"
Then run: aidlc config
```

表示された `export` の行を実行し（残すにはシェルの起動ファイルに足します）、コマンドを
確認します。

```text
$ aidlc version
aidlc X.Y.Z (runtime X.Y.Z)
```

これらの行の前に、ダウンロードがリリースファイルごとに `Downloaded <file>` の行を 1 つずつ
出します。最近の GitHub CLI がないマシンは
`WARN GitHub CLI attestation verification is unavailable; continuing with SHA-256 release checksums.`
も出します。SHA-256 のチェックはつねに走ります。GitHub CLI は署名された由来のチェックを足します
（[リリースの認証](18-install-and-lifecycle.md#release-authentication)）。Windows では、
インストーラー自身の結果が `Installed AI-DLC X.Y.Z` で始まり、あとの画面のパスは `.claude\` の
ような Windows の区切りを使います。プラグインマーケットプレイスの行は、AI-DLC 自身のプラグイン
向けです。そのパスを Claude Code か Codex で一度足すか（[プラグイン](18-install-and-lifecycle.md#plugins)）、
使わなければ飛ばします。

プロジェクトのファイルを自分で管理したい、またはネイティブの実行ファイルをインストールできませんか。
手動コピーの道は、Bun が要る唯一の場所です。[Bun](https://bun.sh/) をインストールし、
[リリース](https://github.com/awslabs/aidlc-workflows/releases/latest) から
`aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードし、`runtime/<harness>/` ディレクトリをまるごと
プロジェクトにコピーし、[コピーチャネル](18-install-and-lifecycle.md#copy-channel) が示すとおり、
独自のセットアップを一度実行します。コピーは、あなたの `.gitignore` や `AGENTS.md` を置き換え
ません。AI-DLC は自分の行をそこに足します。手動コピーの道は、ネイティブの `aidlc` コマンドを
必要としません。

## 2. プロジェクトを設定する

プロジェクトのフォルダで `aidlc config` を実行します。AI-DLC は git のルートを上に探さないので、
このフォルダが `aidlc/` の置き場所になります。リポジトリが複数あるときは、
[`aidlc/` の置き場所](03-spaces-and-intents.md#where-aidlc-lives) を見てください。この実行は
新しい空のフォルダを使います。

```text
$ mkdir inventory-api && cd inventory-api && git init -q
$ aidlc config

  AI-DLC setup - first run in this project.

  Checked your machine and this repo:

    Harness    Claude Code detected  (2.1.296 on your PATH)
    Project    git repo, no AI-DLC files yet
    AWS        credentials not found
    Runtime    aidlc on this shell's PATH only: start Claude Code from a terminal

  Set up AI-DLC for Claude Code with recommended defaults?

    1. Yes, use recommended defaults   MCP servers on, all plugins, current model provider
                                       preserved
                                       Records balanced (default): medium project agent effort for
                                       deciding, reviewing, and writing up; your session
                                       (conductor) effort stays unchanged.
    2. No, customize step by step      harness, provider, preset, plugins, MCP, record layer
    3. Exit, nothing written

  Choice [1]:
```

答える前には何も書かれません。確認した内容は次のとおりです。

- **Harness**: PATH で見つけたツール。これ向けに設定します。複数あるときは、まずどれかを尋ねます。
  なければ [ハーネスをインストールする前に設定する](#set-up-before-you-install-a-harness) を
  見てください。
- **Project**: これが Git リポジトリか、AI-DLC がここに設定済みか。設定済みのプロジェクトでは、
  `aidlc config` はこれらの質問をせず、何がそろっているかを確認します
  （[プロジェクトの設定と更新](18-install-and-lifecycle.md#configure-or-refresh-a-project)）。
- **AWS**: AWS の認証情報が見つかったか。これは、モデルプロバイダーに Amazon Bedrock を選ぶときだけ
  関係します。
- **Runtime**: AI-DLC のフックが `aidlc` コマンドを見つけられるか。ターミナルから起動した
  Claude Code は、そのターミナルの PATH をフックに渡すので、シェルの PATH に `aidlc` があれば
  十分で、この行はターミナルから起動するよう言います。ここで数えた PATH の修正は、設定の最後に
  示されます。代わりにデスクトップのアイコンから Claude Code を起動するなら、ステップ 4 で
  `aidlc doctor` が何を足すか言います。

Enter を押すと、推奨の既定になります。記録される内容は次のとおりです。

- **MCP サーバーをオン**: [出荷される 5 つのサーバー](#mcp-servers-optional) を入れた `.mcp.json`。
- **すべてのプラグイン**: インストール済みのプラグインがすべて有効。
- **いまのモデルプロバイダーを保つ**: AI-DLC はプロバイダー設定を書かないので、Claude Code は
  あなたがすでに使っているプロバイダーとログインを保ちます。
- **balanced プリセット**: `aidlc.settings.json` に、AI-DLC 自身のエージェントが使う effort。
  あなた自身のチャットはモデルと effort を保ちます
  （[モデルと effort を選ぶ](18-install-and-lifecycle.md#choosing-a-model-and-effort)）。

次にもう 1 つ、Claude Code のステータスラインについて尋ねます。

```text
  Show AI-DLC's progress in your status line? It takes the place of your own while you work in this
  project.

    1. Yes  (recommended)
    2. No, keep mine

  Choice [1]:

  AI-DLC's status line shows in this project; /aidlc --statusline off turns it off.

  Writing project files ... done  (.claude/ and aidlc/, 316 files)
  Recording model preset ... done  (aidlc.settings.json in this project)
  Setup complete. Start your first workflow:

    claude                         open Claude Code in this repo
    /aidlc "what you want built"  describe your first intent
```

あなたの答えは `.claude/settings.local.json` と `aidlc.settings.local.json` に入ります。これは
あなた専用です（どちらも git で無視されます）。

### 代わりにカスタマイズする

選択肢 2 は 6 つのステップを歩みます。Enter で毎回 `[default]` を取ります。この実行は、
プロバイダーで Amazon Bedrock を選んだほかは、すべて既定のままでした。

```text
  Customize setup - 6 steps, Enter accepts the [default].

  Step 1 of 6 - Harness
  Detected on this machine: Claude Code.

    1. Claude Code     (detected, default)
    2. Codex CLI
    3. GitHub Copilot
    4. Cursor
    5. Kiro CLI (V2)
    6. Kiro            Kiro IDE and Kiro CLI on its v3 engine
    7. opencode
  Harness [1]:
  Using Claude Code.

  Step 2 of 6 - Model provider
  No AWS credentials were detected.
    1. keep current     inherit the provider already configured in the harness (default)
    2. amazon-bedrock   write the AWS region and profile to settings.local.json, just for you
  Provider [1]: 2
  AWS region [us-east-1]:
  AWS profile [default credential chain]:
  Using amazon-bedrock in us-east-1 with the default credential chain.

  Step 3 of 6 - Model effort preset
    1. balanced    medium effort for deciding, reviewing, and writing up (recommended, default)
    2. thorough    session effort for deciding and writing up, extra-high reviewing
    3. minimal     medium deciding and reviewing, low writing up
    4. unchanged   records no preset and keeps existing settings; new projects use shipped defaults
                   where agents inherit your session's model and effort
  Preset [1]:
  Using the balanced preset.

  Step 4 of 6 - Plugins
    1. all installed   (default)
    2. none optional   core AI-DLC only
    3. choose          comma-separated installed names
  Plugins [1]:
  Using all installed plugins.

  Step 5 of 6 - MCP servers
    1. on
    2. off
  MCP [1]:
  MCP servers on.

  Step 6 of 6 - Where to record the model preset
    1. this project, committed     aidlc.settings.json - shared with your team  (default)
    2. this project, just for you  aidlc.settings.local.json - gitignored
    3. this machine                every project you set up here
  Preset in [1]:
  Recording the model preset in this project, committed.

  Your choices - Enter to apply, or a number to change:
    1. Harness      Claude Code
    2. Provider     amazon-bedrock, us-east-1, default credential chain
    3. Preset       balanced
    4. Plugins      all installed
    5. MCP          on
    6. Preset in    this project, committed
  Apply? [Y/n]:
```

各ステップが書く内容は次のとおりです。

| ステップ | 書く内容 |
| --- | --- |
| 1. Harness | どのツールのファイルを設定するか（Claude Code なら `.claude/`）。 |
| 2. Model provider | `keep current` は何も書きません。`amazon-bedrock` は、`CLAUDE_CODE_USE_BEDROCK` と `AWS_REGION`（とプロファイル、指定したとき）を、共有の `.claude/settings.json` ではなく、あなた自身の `.claude/settings.local.json`（git が無視）の `env` ブロックに足します。プロジェクトの答えの記録はプロファイルを保ちません。 |
| 3. Model effort preset | ステップ 6 が選ぶファイルにプリセット名。`unchanged` は何も記録しません。 |
| 4. Plugins | どのインストール済みプラグインがオンか。 |
| 5. MCP servers | 出荷されるサーバーを入れた `.mcp.json`、またはなし。 |
| 6. Where to record the preset | `aidlc.settings.json`（コミット）、`aidlc.settings.local.json`（git が無視）、またはこのマシンの全プロジェクト向け設定。 |

`Apply?` は、ステップ番号でその答えを変え、`n` で何も書かずに止めます。ステータスラインの質問の
あと、Bedrock はあなたにしかできないステップを 1 つ残します。

```text
  One thing needs you - it can't be done automatically:

    Verify Amazon Bedrock model access in the recorded region and confirm the AWS principal has
    bedrock:InvokeModel permission.
    fix: aidlc config providers --check
```

### 質問なしで

スクリプト、CI、プロンプトのないターミナルには、ウィザードは出ません。各ハーネスの実行環境は
インストール済みなので、あなたのを指定します。`--yes` は確認します。MCP サーバーはオンにしません
（そのためには `--mcp defaults` を足します）。

```text
$ aidlc config --harness claude --mcp defaults --yes
configured /home/you/ci-demo for Claude Code X.Y.Z; next: open Claude Code in this project (if it is already open in this folder, exit it and start it again) and run `/aidlc --doctor`
```

Kiro IDE では、`--yes` は、設定がそこで尋ねる Kiro 設定（あなたの全プロジェクト向け）への推奨の
答えも取ります。Kiro の Workflows 機能を Kiro IDE と Kiro CLI でオフにし（オンの間は AI-DLC の
レビューとヘルパーが走りません）、Windows で Command Prompt が Kiro のターミナルのときは
PowerShell に設定します。Workflows を戻すには、`aidlc config trust --harness kiro-ide --kiro-workflows on --yes`
（Kiro IDE）または `aidlc config trust --harness kiro-ide --kiro-cli-workflows on --yes`（Kiro CLI）を
実行します。

`--harness` なしでは、何も書かずに止まります。

```text
$ aidlc config < /dev/null
error: multiple harnesses are installed; pass --harness <claude|codex|copilot|cursor|kiro|kiro-ide|opencode>
fix: aidlc config --harness <name>
```

何も書く前に config が何をするか見るには、プレビューします。ターミナルではハーネスと MCP の
選択を尋ね、それ以外ではハーネスを指定します。

```text
$ aidlc config --harness claude --dry-run
config plan for /home/you/ci-demo: create=330 update=0 merge=0 preserve=1 remove=0 conflict=0
```

質問なしの設定はモデルプリセットを記録しないので、AI-DLC のエージェントは出荷される既定を
使います。どの質問にもフラグがあります。[Config のオプション](18-install-and-lifecycle.md#config-options)
と `aidlc config <section> --help`。

### ハーネスをインストールする前に設定する

対応するツールが PATH にないとき、ウィザードはまず、どれを設定するかを、既定なしで尋ねます。

```text
  No supported harness CLI was detected. Choose one to configure:

    1. Claude Code
    2. Codex CLI
    3. GitHub Copilot
    4. Cursor
    5. Kiro CLI (V2)
    6. Kiro            Kiro IDE and Kiro CLI on its v3 engine
    7. opencode
  Harness [1-7]:

  That's not one of the choices - enter 1, 2, ... or 7.
  Harness [1-7]: 1
  Using Claude Code.
```

残りは同じで、`detected` の代わりに `Claude Code selected` になります。

## 3. config がプロジェクトに残したもの

```text
$ git status --short
?? .claude/
?? .gitignore
?? .mcp.json
?? aidlc.settings.json
?? aidlc/
```

| パス | 中身 | コミットする? |
| --- | --- | --- |
| `.claude/` | Claude Code の AI-DLC ファイル: `/aidlc` スキル、エージェント、ステージ、フック、ツール、`settings.json`（フック、権限、ウェルカムメッセージ） | はい |
| `aidlc/` | AI-DLC の記録: `aidlc/spaces/default/memory/` がルール（フレームワークの既定、あなたのチームとプロジェクト自身のもの）を持ち、各作業の記録がここに入ります | はい |
| `.gitignore` | AI-DLC 自身の印のついたブロック。あなたのものがあれば、それに足します | はい |
| `.mcp.json` | MCP サーバー、選んだとき | はい |
| `aidlc.settings.json` | モデルプリセット | はい |
| `aidlc.settings.local.json`、`.claude/settings.local.json` | あなた自身の選択（ここではステータスライン） | いいえ、git が無視 |

最初の 5 つをコミットすると、チームが同じ設定を得られます。
`git add .claude aidlc .gitignore .mcp.json aidlc.settings.json && git commit -m "Set up AI-DLC"`。
いつでも `aidlc config` を再実行すると、インストールしたリリースからファイルを更新します。
編集したものは保ちます
（[プロジェクトの設定と更新](18-install-and-lifecycle.md#configure-or-refresh-a-project)）。

## 4. 確認する

ここでは修正の 1 行を短くしています。

```text
$ aidlc doctor
AI-DLC doctor

Machine
  warn  Runtime hook PATH: aidlc is on this shell's PATH (/home/you/.local/bin/aidlc) but not on the system-wide PATH
        fix: Nothing needs changing when you start Claude Code from a terminal: it hands that terminal's PATH to AI-DLC's hooks. If you start it from a desktop icon, the dock, or a service and AI-DLC's hooks do not run, add /home/you/.local/bin to the PATH line in /etc/environment, ENV_PATH in /etc/login.defs, or a PATH= line in ~/.config/environment.d/*.conf, then restart Claude Code. Editing .bashrc or .zshrc does not change this check.
  ok    9 checks passed

Project (.claude, Claude Code)
  warn  AIDLC hooks have not run in this project yet
        fix: This is expected before your first Claude Code chat in this folder. ...
  warn  Workspace records: 8 uncommitted change(s) under aidlc/ (advisory - the shared records travel by git; commit & push so teammates get them: `git add aidlc/ && git commit && git push`)
        fix: add --verbose to see the details, correct the named condition, then run doctor again
  ok    49 checks passed

Framework integrity
  ok    all 12 checks passed

0 problems, 3 warnings.
Warnings are advisory - if everything works, ignore them.
Add --verbose to see every check.
```

新しいプロジェクトでは、この 3 つの警告は想定どおりです。1 つめはデスクトップのアイコンから
Claude Code を起動するときだけ関係し、2 つめは最初のチャットのあと、3 つめはコミットのあとに
消えます。`fail` の行は本当の問題で、その修正がついてきます。Claude Code の中では、
`/aidlc --doctor` が同じチェックを走らせます。

## 5. Claude Code での最初の実行

プロジェクトで Claude Code を起動します。

```text
$ claude
```

新しいフォルダで初めてのとき、Claude Code は、信頼するか尋ね、AI-DLC の設定が尋ねずに実行させる
コマンドを挙げます。

```text
 Accessing workspace:

 /home/you/inventory-api

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 ! This folder pre-approves 45 tool permissions in .claude/settings.json:
   WebSearch, Edit(/**), Bash(aidlc engine *), Bash(aidlc doctor), Bash(aidlc doctor --verbose),
 Bash(aidlc version), Bash(aidlc --doctor), Bash(aidlc --doctor --verbose), and 37 more
 These will apply without asking. Only proceed if you trust this configuration.

 > No, exit
   Yes, I trust this folder
```

自分のプロジェクトなら、**Yes, I trust this folder** を選びます。MCP サーバーがオンだと、
Claude Code は次に、`.mcp.json` の 5 つのサーバーのどれを有効にするか尋ねます。認証情報のある
ものを有効にするか、Esc ですべて飛ばします。AI-DLC はどちらでも動きます。

起動時、Claude Code は AI-DLC のウェルカムメッセージを表示します。その AI-DLC の見出しの下に
「`/aidlc` を実行してワークフローを始めるか再開してください。作りたいものを書くと、AI-DLC が
確認用のプランを提案します」と書き、続けてフェーズ、ステージ、スコープ（できあいのプラン）と、
それぞれが実行するステージを挙げます。いちばん最初の起動では、Claude Code が代わりに自身の
通知を出し `1 more notice hidden` と言うことがあります。ウェルカムはあとの起動で出ます。

では、作りたいものを書きます。

```text
> /aidlc Build a REST API for inventory management
```

エージェントはあなたの言葉を読み、プラン、つまりこの種の作業向けのできあいのステージの
組み合わせを提案します。ここでは `mvp` を選びました。あなたの言葉には別のが選ばれるかもしれません。

```text
 Plan
 I'd run the "mvp" plan for: "Build a REST API for inventory management" - 19 stages, 19 approval
 gates, 5 stages repeat per unit of work in Construction. Do you want me to go ahead with it, use
 a different plan, or tailor one to this task?
 > 1. Go ahead with the "mvp" plan
      19 stages: skips operations and ships the core API.
   2. Use a different plan
      Pick another ready-made plan (e.g. classic, feature, express, poc).
   3. Tailor a plan to this task
      Have a plan composed specifically for this work.
   4. Type something.
   5. Chat about this
```

Go ahead で作業が始まります。**Use a different plan** はほかを長さつきで挙げ、1 つ選ぶか名前を
打ちます。

```text
 Plan
 Which plan would you like for the inventory REST API?
 > 1. classic (14 stages)
      V1-style ceremony through Inception and Construction - the implicit default.
   2. feature (29 stages)
      Full lifecycle for new features, practical depth.
   3. express (6 stages)
      Lightest run: requirements to deploy, no design pass, no reviewers.
   4. poc (4 stages)
      Prove feasibility fast.
   5. Type something.
   6. Chat about this
```

この実行はそこで「mvp after all」と打ち、`mvp` で進みました。
[ワークフロープロファイル](workflow-profiles.md) に各プランがあります。**Tailor** は、
あなたの言葉からエージェントに独自のプランを提案させます。

どの質問にも **Type something**（自分の答え）と **Chat about this** があります。下の画面は、
ステージの最初の質問を除いて、この 2 つを省いています。

AI-DLC は次に、この作業の記録を作り、最初のステージ Intent Capture を始めます。その最初の
質問は、ステージの質問にどう答えたいか、です。

```text
 Answer mode
 I've created 8 questions at
 aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/intent-capture-questions.md.
 How would you like to answer them?
 > 1. Guide me
      Walk through each question interactively here
   2. I'll edit the file
      Fill in the answers in the file directly
   3. Chat
      Discuss freely; I'll extract the decisions from the conversation
```

選ぶのは一度で、以降のステージは同じ答えを使い、その旨を 1 行で言います（「さきほど選んだ
やり方で答えます: Guide me。ファイルを編集するかチャットがよければ言ってください」）。
**Guide me** では、質問が数問ずつ来ます。それぞれに選択肢と、その文の前に、ふだんだれが
答えるか（この画面は AI-DLC がそのラベルを出す前に取ったもので、`[Product owner]` を足して
ラベルの位置を示しています）がつきます。先頭の行が質問を挙げ、最後のあと **Submit** が答えを
レビュー用に示し、**Submit answers** が送ります。

```text
 < [ ] Q1 Problem  [ ] Q2 Users  [ ] Q3 Success  [ ] Q4 Trigger  Submit >
 Q1. [Product owner] What business problem should the inventory API solve first? (If it's not
 defined yet, pick "Type something" and say so.)
 > 1. Stock counts drift
      A. We don't know accurately what stock we have (counts drift, spreadsheets go stale)
   2. Stock-outs / overstock
      B. Levels aren't visible in time to reorder
   3. Shared source of truth
      C. Other systems (shop, ordering, warehouse tools) need one reliable source of stock data
   4. Multi-location tracking
      D. Tracking stock across several locations is manual and error-prone
   5. Type something.
   6. Chat about this
```

矢印キーと Enter で選択肢を選ぶか、**Type something** で自分の言葉で答えます。「Select all that
apply」と書く質問は複数取ります。すべての質問に答えると、エージェントは何かを書く前に、答えを
読み上げて一度確認します。

```text
 Confirm
 - Problem: other systems need one shared, reliable source of stock data (Q1)
 - Callers: internal staff tools and an online store / ordering system (Q2)
 - Success: at least one real consumer system integrated and using the API in daily work (Q3)
 - Trigger: a new business or product line that needs inventory tracking from day one (Q4)
 - Stakeholders: just you; you decide scope and priority; no progress reporting needed (Q5-Q7)
 - Out of the first version: supplier purchasing / automatic reorder, and any user interface (API
 only) (Q8)

 Does this all look correct before I generate the artifact?
 > 1. Looks correct
      Generate the artifact from these answers
   2. Request changes
      Revise one or more answers before generation
```

次に、ステージの文書を書きます。あなたの答えが決着させなかった前提に寄りかかるときは、前提の
ままにするか、質問に変えるかを尋ねます。レビュアーエージェントが主文書を読みます。途中で
エージェントを直していたら、その直しを次に残すか、ここで尋ねます。あなたは何も直していないので、
次は承認です。

次に最初の承認です（刈り込み: ソースチェックの行、レビューファイルのパス、3 つの所見のうち 2 つを
省いています）。

```text
Intent Capture & Framing is ready for your review. It produced intent-statement.md,
stakeholder-map.md and intent-capture-questions.md (8 questions, all answered), in
aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/.

Stage: Intent Capture & Framing
Review outcome: Concerns remain for your decision.

| ID   | Severity | Where                                      | Status |
|------|----------|--------------------------------------------|--------|
| R-01 | Minor    | intent-statement.md > Initial Scope Signal | New    |
| R-02 | Minor    | intent-statement.md > Initiative Trigger   | New    |
| R-03 | Minor    | intent-statement.md > Success Metrics      | New    |

> R-03 Finding: The table carries a single, binary success metric ("at least one real consumer
  system integrated and uses the API in daily work") with no accuracy, timeliness, or
  adoption-breadth dimension, ...
> R-03 Required action: Human should confirm at the gate that a single integration-adoption
  metric is sufficient, or ask a follow-up to add a data-accuracy or reliability metric before
  inception begins.

Decision options:
- Approve - continue.
- Request Changes - return to the listed artifacts so the required actions can be addressed.

Review: aidlc/spaces/default/intents/261013-inventory-rest-api/ideation/intent-capture/

The two wording points (R-01, R-02) are things I added that you didn't confirm, and they're easy
to remove. R-03 is your call: one success measure is enough, or you may want to add one for stock
accuracy. After you approve, the next step is Feasibility & Constraints.

Approve accepts the open review findings R-01 (...), R-02 (...) and R-03 (The table carries a
single, binary success metric ("at least one real...) as risk; you can also approve and ask for
one to be fixed, or reject one as not applying, saying why.

 Approval
 Intent Capture & Framing complete. How would you like to proceed?
 > 1. Approve
      Continue to Feasibility & Constraints
   2. Request Changes
      Provide revision feedback
```

文書は、名前の挙がったフォルダにあります。決める前に開いてください。**Approve** は進み、
開いている所見を受け入れます。**Request Changes** は、それらに対処するためステージを戻します
（何を変えるか、またはフォローアップの質問がほしい旨を言います）。この実行は承認しました。

```text
Progress: 1 of 19 stages done. Next: Feasibility & Constraints.
Now working on Feasibility & Constraints, wearing the architect hat.
```

この作業の記録は、いまこう持っています（主なファイルに刈り込み）。

```text
aidlc/spaces/default/intents/261013-inventory-rest-api/
  aidlc-state.md                 where the work stands
  audit/                         every question, answer and approval, as it happened
  project-description.json       your request, word for word
  ideation/intent-capture/       intent-statement.md, stakeholder-map.md,
                                 intent-capture-questions.md, reviews/review-01.md
  ideation/feasibility/          the next stage, under way
```

ここから各ステージは同じ流れです。質問、文書、レビュー、あなたの承認です。
[最初のワークフロー](02-your-first-workflow.md) がその流れの各部分を説明し、
[実例](16-worked-examples.md) が一通りの実行を追います。

## ほかのツールでは

ステップはどこでも同じで、違うのは次です。

| ハーネス | config 値 | 開く | 呼び出し |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `/aidlc` |
| Kiro（Kiro IDE、v3 の Kiro CLI） | `kiro-ide` | プロジェクトを開き、チャットパネルのエージェント選択で **aidlc** を選ぶか、プロジェクトで `kiro-cli --v3` を実行（Kiro がフォルダを信頼するか尋ね、中身が分かっていれば **Trust, continue** を選ぶ） | `/aidlc` |
| Kiro CLI（V2） | `kiro` | `kiro-cli --v2`（Kiro CLI 2.21.4 以降。古いものは [Kiro CLI](harnesses/kiro-cli.md#prerequisites)） | `/aidlc` |
| Codex CLI | `codex` | `codex` | `$aidlc` |
| Cursor | `cursor` | Cursor を開くか `agent` を実行 | `/aidlc` |
| opencode | `opencode` | `opencode` | `/aidlc` |
| GitHub Copilot CLI / VS Code | `copilot` | Copilot CLI または VS Code | `/aidlc` |

config のあと、あなたのツール向けに config が名前を挙げるステップを 1 つ終えます。

| ハーネス | よくある操作 |
| --- | --- |
| Claude Code | Claude Code がこのフォルダで既に開いているなら、終了して起動し直す |
| Kiro（Kiro IDE、v3 の Kiro CLI） | 設定したプロジェクトを開き、チャットパネルのエージェント選択で **aidlc** を選ぶか、プロジェクトで `kiro-cli --v3` を起動（Kiro がフォルダを信頼するか尋ね、中身が分かっていれば **Trust, continue** を選ぶ） |
| Kiro CLI（V2） | `kiro-cli --v2` を起動（Kiro CLI 2.21.4 以降。古いものは [Kiro CLI](harnesses/kiro-cli.md#prerequisites)）。プロジェクトが AI-DLC エージェントを選びます |
| Codex CLI | フックの信頼のプロンプトを承認するか、生成された信頼のシードを当てる |
| Cursor | 設定したプロジェクトを開くか `agent` を実行 |
| opencode | プロジェクトで `opencode` を起動 |
| GitHub Copilot | プロジェクトのフォルダを信頼する |

ウェルカムメッセージは Claude Code だけのものです。AI-DLC は Claude Code で自分のステータス
ラインを描きます。Codex では、設定が Codex の組み込みのステータスラインを提供し、AI-DLC が
最新に保つタスクの進捗を載せます。Kiro CLI 2.24.1 以降での Kiro の v3 エンジンには、`kiro-ide`
を使い `kiro-cli --v3` を起動します（フォルダの信頼を尋ねられ、中身が分かっていれば
**Trust, continue** を選ぶ）。`kiro` は Kiro CLI（V2）です（[Kiro CLI](harnesses/kiro-cli.md) に、
既存の `kiro` プロジェクトの切り替え方があります）。

Kiro IDE では、**aidlc** エージェントは、フォルダを信頼してウィンドウを再読み込みしたあとにだけ
エージェント選択に現れます。Restricted Mode のバナーが出たら、そこで **Manage**、次に **Trust**
を選び、**Developer: Reload Window** を実行します（[最初の実行](harnesses/kiro-ide.md#first-run)
を見てください）。まだ信頼していないフォルダで Kiro IDE 自身のターミナルを使うと、Kiro はまず
信頼するか尋ねます。自分のプロジェクトか、中身を確認したものにだけ **Trust Folder & Continue** を
選んでください。信頼すると、そのフォルダの `.kiro` フックがあなたのマシンでコマンドを実行できる
ようになるからです。

[ほかのハーネスで動かす](harnesses/README.md) の各ツールの章が、残りを扱います。

## AWS Bedrock の設定

Claude Code、Codex、opencode のディストリビューションは、ユーザーがすでに設定したプロバイダーを
保ちます。Amazon Bedrock は明示的な選択肢です。

### プロバイダーに依らない既定

AI-DLC は、出荷される Claude Code、Codex、opencode のプロジェクト設定で、モデルプロバイダーを
選びません。ハーネスは、ユーザーがすでに設定したプロバイダー、認証、モデル、コンテキストの設定を
保ちます。balanced のレビュアーエージェントは推論の effort に上限をかけることがありますが、
プロバイダー固有のモデルを固定はしません。

### Bedrock を設定する（任意）

上のカスタマイズ設定のステップ 2 で `amazon-bedrock` を選ぶか、あとで `aidlc config providers` で
選びます。次に:

1. Amazon Bedrock のモデルカタログで、設定した Anthropic モデルへのアクセスを有効にします。
2. ふつうの SDK の認証情報チェーンで AWS の認証情報を渡します。たとえば `aws configure` や
   `aws sso login --profile <profile>` です。
3. それらのモデルが使えるリージョンを使います。
4. `aidlc config providers --check` を実行し、まだ保留のものを見ます。

認証情報と個人の上書きは、共有の `.claude/settings.json` の外に置きます。`.claude/settings.local.json`
か、標準の AWS 認証情報ファイルに入れます。

Claude Code ですでに選んだプロバイダーを保つには、`aidlc config providers` で `keep current` を
選びます（または `--provider current` を渡します）。別の Claude Code 対応のプロバイダーを
明示的に記録するには、`aidlc config providers --provider other --yes` を実行します。これは、
共有のプロジェクト設定から古い AI-DLC 所有の Bedrock の上書きを外し、手動の設定ステップを保留に
します。そのプロバイダーの認証フローを終え、`aidlc config providers --acknowledge --yes` を
実行してステップを完了にします。[Claude Code の認証ガイド](https://code.claude.com/docs/en/authentication)
を見てください。

IAM の詳細、モデルアクセス、SSO、リージョンの困りごとは、
[Claude Code on Amazon Bedrock](https://community.aws/content/2tXkZKrZzlrlu0KfH8gST5Dkppq/claude-code-on-amazon-bedrock-quick-setup-guide)
と [Amazon Bedrock のドキュメント](https://docs.aws.amazon.com/bedrock/) を見てください。

## MCP サーバー（任意）

推奨の既定は、Claude Code のプロジェクトで出荷される MCP サーバーをオンにします。質問なしの
設定は `--mcp defaults` で足します。

```bash
aidlc config --harness claude --mcp defaults
```

外すには `--mcp none` を使います。コピーチャネルのインストールはそれらなしで始まります。足すには
`bun .claude/tools/aidlc.ts config project --harness claude --mcp defaults --yes` を実行します。
既定のセットは次のとおりです。

| サーバー | 提供するもの | 認証情報 |
| --- | --- | --- |
| `context7` | ライブラリと SDK のドキュメント | `CONTEXT7_API_KEY` |
| `aws-mcp` | AWS API アクセス | AWS 認証情報チェーン |
| `aws-pricing` | AWS の料金の問い合わせ | AWS 認証情報チェーン |
| `aws-iac` | Infrastructure-as-code ツール | AWS 認証情報チェーン |
| `aws-serverless` | サーバーレス開発ツール | AWS 認証情報チェーン |

4 つの AWS サーバーは `uvx` を要し、標準の AWS 認証情報チェーンを使います。

Claude セッションのどのエージェントも、使える MCP サーバーを引き継ぎます。認証情報がないと
サーバーは使えませんが、ワークフローは止まりません。コミットされる `.mcp.json` に秘密を
入れてはいけません。

## 更新する

`aidlc update` はマシンの実行環境を更新します。設定済みのプロジェクトは書き換えません。
各プロジェクトを更新してください。進行中の作業は続きます。

```bash
aidlc update
cd /path/to/your-project
aidlc doctor
aidlc config
```

config はプロジェクト所有の中身を保ち、ワークフローが開いている間の更新も行われ、その作業が
続くかを伝えます。プラグインを使うプロジェクトは、エンジンの更新のあと `/aidlc plugin sync` を
実行してください。

バージョンの選択、プロジェクトの固定、オフラインインストール、ミラー、カスタム CA、リリースの
認証、自動化、アンインストールは、[インストールとライフサイクル](18-install-and-lifecycle.md) を
見てください。

## 困ったとき

まずこれから。

```bash
aidlc doctor
```

次に、フック、プロバイダーのアクセス、承認ゲート、古い状態、診断は
[困ったとき](15-troubleshooting.md) を使います。ハーネス固有の設定の問題は、対応する
[ハーネスガイド](harnesses/README.md) にあります。

## 次のステップ

- [オンボーディング: ガイド付きの最初の一週間](onboarding.md) - 考え方の全体像と、初めてのチーム向けの 5 回のガイド付き実行
- [ワークフロープロファイル](workflow-profiles.md) - 正しいワークフローを選ぶ
- [最初のワークフロー](02-your-first-workflow.md) - 実行の各部分の意味
- [スペースと intent](03-spaces-and-intents.md) - プロジェクトの状態を理解する
- [対話モード](07-interaction-modes.md) - 質問とゲートで作業する
- [インストールとライフサイクル](18-install-and-lifecycle.md) - ネイティブの実行環境を管理する

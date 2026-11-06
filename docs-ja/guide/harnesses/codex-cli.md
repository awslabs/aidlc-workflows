# AI-DLC on Codex CLI

Codex runtime は、フレームワークの harness ディストリビューションの 1 つで、OpenAI の **Codex CLI** harness 向けです。1 つの決定的な core に、多くの harness。engine、state machine、audit log、graph、swarm referee、learnings gate は、どのディストリビューションでもバイト単位で同一で、異なるのは外殻だけです。ソース/開発ツリーは、`bun scripts/package.ts codex` によって `core/` と `harness/codex/` から、gitignore されたローカルの `dist/codex/` に**生成**されます。決して手で編集しないでください。

プロジェクトの `.codex/config.toml` は、[Codex configuration reference](https://developers.openai.com/codex/config-reference/) に文書化されたとおり、`developer_instructions` を Codex の onboarding に設定します。信頼されたプロジェクトの Codex セッションは、ファイルを読まずにこの onboarding を受け取ります。`.codex/onboarding.md` は、人間が読めるコピーとして同じ内容を保ちます。harness 非依存のルート `AGENTS.md` ブロックは、そのコピーを列挙し、engine ディレクトリの異なるほかのインストール済み harness と共有されます。

新しい Codex セッションで、この harness の AI-DLC コマンドを尋ねてください。回答は `.codex/onboarding.md` を読まずに `$aidlc` と `.agents/skills/` を名指しするはずです。`$aidlc --doctor` が、読めるコピーを検証します。

### ルート instruction の上書き

各ディレクトリで、Codex は `AGENTS.md` より前に `AGENTS.override.md` を確認し、最初に存在するファイルを選びます（[Codex's file selection](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/agents_md.rs) を参照）。空、または空白のみの上書きは、何の instruction も寄与しません。`AGENTS.md` にフォールバックもしません。`AGENTS.override.md` という名のディレクトリは選ばれませんが、instruction ファイルへの symlink は選ばれます。

Doctor は、Codex が選ぶルートファイルを確認し、上書きが優先するときそれを名指しします。欠けた、または変わった AI-DLC ブロックは、advisory の警告を出します。config や refresh を止めてしまう `AGENTS.md` 内の壊れたブロックも、Codex が上書きを読み込むときでさえ報告します。Doctor はどちらのファイルも編集しません。

Config とプロジェクトの refresh は、なお AI-DLC ブロックを上書きではなく `AGENTS.md` に書きます。プロジェクトが `AGENTS.override.md` を保つなら、現在の `<!-- BEGIN AI-DLC:agents -->` から `<!-- END AI-DLC:agents -->` までのブロックを `AGENTS.md` からそこへコピーし、あなた自身のテキストを保ってください。壊れた、または重複したブロックには、新たなコピーを足さず、そのブロックと壊れたマーカー行を置き換えてください。必要なら先に `AGENTS.md` を refresh します。native インストールでは `aidlc config` を、手動 copy インストールでは `bun .codex/tools/aidlc.ts config` を使います。以後の refresh の後、コピーしたブロックを更新してください。これは、`developer_instructions` を通じて供給される native の onboarding を変えません。

## 前提

- **Codex CLI >= 0.145.0** — それより前のリリースは、ターン途中の自動 compaction の後、compact ソースの `SessionStart` を遅延させるので、1 回のモデル継続が、復元されたワークフローの mission 無しで走ることがあります。0.139.0 より前のリリースは、信頼できる subagent の role 帰属と、ハイフン付き agent-TOML の解決も欠きます。`/aidlc --doctor` が pin について助言します。`codex --version` で確認してください。
- **bun** は、ソース/開発の `dist/` projection を生成または実行するときだけです。native インストールとバージョン付きリリース runtime は自己完結です。
- **対象プロジェクトの Git リポジトリ** — Codex は、プロジェクトの `.codex/hooks.json` をその中でだけ発見します。native インストーラと AI-DLC runtime 自体は、Git に依存しません。
- **モデル provider** — 出荷のプロジェクト `config.toml` は 1 つを選びません。Codex は、provider、認証情報、model、context window、reasoning effort を `~/.codex/config.toml` から継承します。Agent の role は選ばれた model を継承し、balanced な reviewer は自身の medium reasoning-effort の上限だけを保ちます。モデル provider はそのユーザーレベルのファイルで設定してください。Codex はプロジェクトレベルの `model_provider` と `model_providers` を無視します。信頼されたプロジェクトの `.codex/config.toml` にある `model` などのほかの設定は、ユーザー設定に優先します。そのため、意図的な共有の上書きのためだけに、プロジェクトレベルの model キーを加えてください。

## インストール

### Native channel（推奨）

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
codex
```

インストーラは、リリースのメタデータ、実行ファイル、全 harness runtime アーカイブを、公開された SHA-256 チェックサムと照合して検証します。インストールされた runtime は、Bun、Node.js、Git を要しません。harness の選択は `aidlc config` で起きます。

Windows では、`install.ps1` をダウンロードし、`& $installer` を走らせます。アカウントの scope、User PATH の自動登録、`-NoModifyPath` は [Windows installation](../18-install-and-lifecycle.md#windows-powershell) を参照してください。エアギャップのパッケージには、Unix では `install.sh --from <release-directory> --offline`、Windows では `& $installer -From <release-directory> -Offline` を使ってください。

`aidlc config` は、Codex の外殻を projection し、`.gitignore` と `AGENTS.md` の AI-DLC ブロックを merge し、`.codex/config.toml`、hook、permission ルール、対応する `.codex/trust-seed.toml` を書きます。Codex は、それらの hook が走る前に、プロジェクト固有の hook trust のアクションを 1 つ要します:

- `codex` を起動し、hook ダイアログで **Trust all and continue** を選びます（通り過ぎた場合は、Codex で `/hooks` とタイプし、`t` を押してすべてを trust し、それから Esc を押します。同じチャット内のあなたの次のメッセージに数えられます）。または
- `.codex/trust-seed.toml` の `<PROJECT_DIR>` を絶対プロジェクトパスに置き換え、その完全な `[hooks.state]` 集合を `$CODEX_HOME/config.toml` に merge します。その hook パスの既存の集合は、重複した TOML テーブルを追記するのではなく、置き換えてください。

生成された `.codex/config.toml` はプロジェクト scope に保ち、`~/.codex/config.toml` に merge しないでください。`developer_instructions` がこのプロジェクトの AI-DLC onboarding を運ぶからです。provider と model の設定は、あなたのユーザー config に保ってください。それから Codex で `$aidlc --doctor` を走らせます。

生成された `sandbox_mode = "workspace-write"` は、`[shell_environment_policy]` のメンバーではなく、トップレベルの TOML 設定です。AI-DLC は、それを `developer_instructions` と並ぶ自分自身のエントリの 1 つとして追跡します。provider の回答はそれを変えず、refresh はあなたが設定した値を保ち（リリースが別の値を出荷するときは注記を添え）、キーが取り除かれていたときは出荷の値を戻します。ファイルの残りはあなたのものです。現在の provider を選ぶと、帰属可能な従来の Bedrock の既定だけが取り除かれます。sandbox の方針は変わりません。

### バージョン付き手動 copy の代替

[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) に述べたとおり、特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードして展開し、それから `RUNTIME_ROOT` を展開した `runtime/` ディレクトリに設定します。

1. ディストリビューションをあなたのプロジェクト（**git リポジトリ**でなければなりません。Codex はプロジェクトの `.codex/hooks.json` をその中でだけ発見します）にコピーします:

   ```bash
   cp -r "$RUNTIME_ROOT/codex/.codex/"  your-project/.codex/
   cp -r "$RUNTIME_ROOT/codex/.agents/" your-project/.agents/
   cp -r "$RUNTIME_ROOT/codex/aidlc/"   your-project/aidlc/      # the workspace shell (spaces/default/memory) — a sibling of .codex/, not inside it
   ```

   `aidlc/` ディレクトリは workspace の外殻です。engine が読む、ビルド済みの `aidlc/spaces/default/memory/` メソッドツリーを出荷します。これは `.codex/` の**兄弟**なので、別にコピーします（または `$RUNTIME_ROOT/codex/` ツリー全体を一度にコピーします）。それが欠けていると、`$aidlc --doctor` は「workspace shell ready」のチェックに失敗します。

2. copy 自身の setup をプロジェクトから一度走らせます:

   ```bash
   bun .codex/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness codex
   ```

   これは、最初のワークフローの前に、すでにそこにあるすべての後に（または作成して）、AI-DLC の行をあなたの `AGENTS.md` と `.gitignore` に加えます。各 intent の `audit/` 配下の clone ごとの audit シャードは意図的に commit されます（各 clone が自分の `<host>-<clone>.md` を書くので、並行の追記が git 衝突しません）。一方、ユーザーごとのカーソルと machine ローカルの runtime state は ignore されたままです。

3. プロジェクトを trust し、hook trust を事前 seed します。Codex は信頼されていない hook を決して走らせません（`--dangerously-bypass-hook-trust` フラグもそれらを走らせません）。対話的な TUI セッションを 1 回走らせて hook ダイアログで「Trust all and continue」を選ぶか、AI-DLC のソース checkout から決定的に事前 seed します。その pin された開発依存を一度インストールし、それからエントリを生成します:

   ```bash
   bun install --frozen-lockfile
   bun scripts/package.ts codex trust --project "/abs/path/to/your project"
   ```

   このコマンドは、`$CODEX_HOME/config.toml` 向けに、貼り付けてすぐ使える `[hooks.state]` エントリを表示します（各ハッシュは、Codex がハッシュするとおり、hook のイベント、その matcher、そのコマンド、その timeout を覆い、パスは覆いません。表示されたエントリは、コピーされた `hooks.json` に対して正確です）。コマンドは完全な出力を TOML として直列化するので、クォートされたパス、空白、Windows のバックスラッシュが保たれます。hook マニフェストが `<project>/.codex/hooks.json` に無い場合、その正確なパスを明示的に渡します:

   ```bash
   bun scripts/package.ts codex trust \
     --project "/abs/path/to/your project" \
     --hooks-json "/abs/custom path/hooks.json"
   ```

   両方の引数をシェルでクォートしてください。`--hooks-json` は、Codex の trust の identity としてそのまま使われます。エントリを生成した後、正規化したり置き換えたりしないでください。コマンドの完全な stdout をユーザー config に貼り付けます。同じ `hooks.json` パスのエントリがすでに存在する場合、その完全な集合を置き換えてください。重複した TOML テーブルは config 全体を無効にするので、2 つ目のコピーを追記しないでください。

   AI-DLC のアップグレードが `.codex/hooks.json` を変える（新しい matcher を加えるアップグレードを含む）たびに、この trust コマンドを再実行してください。新しい Codex セッションを開く前に、古いテーブルを置き換えてください。そうしないと Codex は、起動時に変わった hook について再び尋ねます（Codex 0.160.0 で見られます）。

4. `your-project/` に戻り（手順 3 は AI-DLC のソース checkout から走りました）、信頼されたプロジェクトで、出荷の config を `.codex/config.toml` に保ちます。`~/.codex/config.toml` に merge しないでください。その `developer_instructions` がこのプロジェクトの AI-DLC onboarding を運びます。次で検証します:

   ```bash
   cd your-project
   bun .codex/tools/aidlc-utility.ts doctor
   ```

バージョン付き runtime は native の `aidlc` コマンドを使います。Bun 形式の projection が要るフレームワーク開発者は、リポジトリを clone し、`bun install --frozen-lockfile` と `bun scripts/package.ts` を走らせ、それから gitignore されたローカルの `dist/codex/` の出力を使えます。ソース checkout の trust ジェネレータは、それらの Bun 形式の hook コマンドに固有で、native runtime は使いません。

## Refresh とバージョンのずれ

`aidlc update` は machine runtime を更新しますが、プロジェクトを書き直しません。`aidlc doctor` は、プロジェクトの runtime stamp を選ばれた engine と比べます。ワークフローの合間に、プロジェクトの refresh をプレビューして適用します:

```bash
aidlc config --dry-run
aidlc config
```

Config は、ユーザー所有のコンテンツを保ち、ローカルのフレームワーク編集を衝突として報告します。ワークフローが開いている間の refresh は実行され、開いている作業が続くと言います。アップグレードと rollback は、プロジェクトファイルに触れないので、ワークフロー中も安全なままです。refresh は Codex の hook identity を変えることがあるので、config の後に Codex が要求したら、新しい trust ダイアログを承認するか、対応する trust-seed エントリを置き換えてください。

## 使い方

orchestrator を `$aidlc`（または `/skills` → aidlc）に scope か説明を続けて起動します。Claude harness と同じコマンドです（`$aidlc --status`、`$aidlc --config [section]`、`$aidlc --help`、関連する形）。stage runner は明示のみです。`$aidlc-domain-design`、`$aidlc-bugfix` などです（37 の runner 説明がインデックスを汚さないよう、暗黙の skill マッチングから除外されています）。

## Claude Code との harness の違い

- **ゲート**は、出荷の config フラグが有効にすると `request_user_input` ツールで描画され、そうでなければ番号付き散文のフォールバックになります（番号か自由テキストで答えます）。ゲートのセマンティクスは、どちらでも engine にあります。Codex はなおその picker を開発中と記すので、出荷の `.codex/config.toml` はそれを on にし、それについての Codex の起動時の警告を off にします。このプロジェクトで作業する間、それはほかの開発中の機能についての警告も隠します。1 つのセッションで番号付き散文のゲートにするには、Codex を `codex -c features.default_mode_request_user_input=false` で起動します。
- **ステータス行、プロジェクトの選択**: ワークフローの位置は、`update_plan` ツール（`task-progress` のステータス行項目）と `$aidlc --status` に乗ります。AI-DLC のステータス行は、誰かが選ぶまで off です。setup が一度尋ね、`$aidlc --statusline on|off`（または `aidlc config --statusline on|off`）が、共有の `.codex/config.toml` の AI-DLC の `[tui]` `status_line` 行を、プロジェクトで作業する全員に対して加えるか取り除きます。Codex はプロジェクトに人ごとの設定ファイルを持たないので、各人は代わりに、Codex の `/statusline` で自分のステータス行にタスク進捗を加えられます。
- **時間切れになる質問ボックス**: Codex は、約 2 分回答が無いと質問ボックスを閉じます。あなたの代わりに何も答えられません。戻ってくると、同じ質問がチャットで待っています。
- **sandbox 下の Git**: `workspace-write` は、設計上、sandbox 内で `.git` を読み取り専用に保ちます。対話的セッションは自動で権限を上げ、出荷の `.codex/rules/default.rules` が `git worktree`/`commit`/`add` を事前許可します。headless 実行（CI）は `writable_roots = ["<main repo>/.git"]` を要します。出荷の `config.toml` にテンプレートがあります（リンクされた worktree は `<main>/.git/worktrees/*` に解決されるので、main リポジトリの `.git` でなければなりません）。
- **sandbox 下のネットワーク**: 出荷の `.codex/config.toml` は `[sandbox_workspace_write]` の下に `network_access = true` を設定するので、このプロジェクトで Codex が sandbox 内で走らせるコマンドは、あなた自身の Codex 既定が何であれ、ネットワークに到達できます（パッケージのインストールや依存の取得のため）。このプロジェクトで閉じたままにするには、そこに `network_access = false` を設定します。refresh はあなたが設定した値を保ちます。1 つのセッションだけなら、Codex を `codex -c sandbox_workspace_write.network_access=false` で起動します。
- **Swarm の下限 = developer subagent**: 発行された Construction Unit ごとに `aidlc-developer-agent` subagent が 1 つ、並んで、それぞれがその Unit の Bolt 用の隔離された worktree で作業し、同じ決定的な referee を伴います。それらはあなたの sandbox 内で、あなたの承認設定で走ります。あなたが承認した test コマンドは、AI-DLC 自身の `swarm check` を通じて走り、出荷のルールがそれを許すので、尋ねずに、sandbox の外で走ります。`AIDLC_USE_SWARM=1` はここで Workflow ツールを持たず、loud-degrade します（`SWARM_DEGRADED` が audit されます）。
- **main チャットであなたがタイプしたものだけが、あなたの返信として数えられます。** Codex は、subagent のブリーフと、エージェントがそれに送るすべてのフォローアップを、あなたのメッセージと同じ prompt hook を通じて送り、自身の reviewer（`/review`、auto-review）にも同じことをし、subagent の id かその自身のスレッドのトランスクリプトで印を付けます。AI-DLC はそれらを決してあなたのターンとして数えません。承認を満たさず、あなたの回答や変更要求としても読まれません。subagent 自身のスレッド（`/subagents`）に切り替えてそこでタイプすると、そのメッセージは worker 向けなので、main チャットの質問にも答えません。
- **Session lifecycle**: Codex は SessionEnd イベントを持ちません。閉じられていないセッションは、次のセッション開始時に、推論された `SESSION_ENDED` の audit 行として調停されます。compaction の後、Codex は `source=compact` の SessionStart を発行します。そのサポートされたイベントは、compaction 後の最初の継続の前に、ワークフローの mission を再注入します。この即時のドレインが、AI-DLC が Codex >= 0.145.0 を要する理由です。
- **Artifact の audit 忠実度**: headless の `codex exec` 実行では、モデルはしばしばシェルの heredoc でファイルを書き、それが `apply_patch` の hook matcher を迂回するので、`ARTIFACT_*` の行がまばらになり得ます。対話的な TUI セッション（system prompt が `apply_patch` を義務付ける）が、高忠実度の audit モードです。
- **AIDLC のルール層**は、workspace ルートの `aidlc/spaces/<active-space>/memory/` 配下にあります（1 つの手編集可能なソースで、どの harness でも同一）。Codex はそれらの ambient include を持ちません。engine が active な space のファイルを読み、各ステップにそのルールを手渡します（`config.toml` は `AIDLC_RULES_DIR` を空で出荷し、engine はそれを none として読むので、2.11.0 からコピーされたプロジェクトは自分のツールで refresh します。以前のリリースの行が名指しする space は、次の `aidlc config` で空にされます）。Codex の native な `.codex/rules/` ディレクトリは、AIDLC メソッドとは別の、Starlark の permission ルールを保ちます。
- **welcome メッセージなし**: Claude harness は、セッション開始時に `settings.json` の `companyAnnouncements` から Phases/Stages/Scopes の onboarding バナーを描画します。Codex に相当するものはありません。session-start の経路は、ワークフローコンテキストだけを注入します。
- **MCP server**: Codex は、`config.toml`（プロジェクトの `.codex/config.toml` または `~/.codex/config.toml`）の `[mcp_servers.<name>]` テーブルから MCP 定義を読みます。要るサーバーをそこに加えてください。出荷の config は**何も**宣言しません（Claude harness は `.mcp.json` で 5 つを出荷し、Codex は既定で 0 を出荷します）。

## 再生成

```bash
bun scripts/package.ts codex          # regenerate dist/codex from core/ + harness/codex/
bun scripts/package.ts --check        # build twice and byte-compare (every harness)
```

Core の `.ts` ファイルは、`core/tools/` と `core/hooks/` のソースとバイト単位で同一です（`tests/unit/t150-codex-packaging.test.ts` で pin）。散文は、packager が `.codex` に置換する `{{HARNESS_DIR}}` トークン（加えて `rules/` → `aidlc-rules/` の rename）を運び、これが許された唯一の変換クラスです。ライブの end-to-end の歩みは `tests/e2e/t-exec-codex-status.serial.test.ts` です（gate: `AIDLC_CODEX_EXEC_LIVE=1`）。

## 次のステップ

インストールして trust しましたか。メソドロジーはどの harness でも同じです。中立の章を進めてください:

- [Your First Workflow](../02-your-first-workflow.md) — 注釈付きの end-to-end 実行。
- [Phases and Stages](../04-phases-and-stages.md) — 5 phase と 33 stage。
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — 実行の right-sizing。
- [Glossary](../glossary.md) — すべての用語の定義。

ほかの harness: [Running AI-DLC on Kiro IDE](kiro-ide.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md)。

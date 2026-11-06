# AI-DLC on Cursor

Cursor runtime は、フレームワークの harness ディストリビューションの 1 つで、[Cursor](https://cursor.com) 向けです。1 つのツリーが **Cursor IDE** と **Cursor CLI**（`agent`）の両方に対応します。両者は同じ `.cursor/` の発見を共有します。1 つの決定的な core に、多くの harness。engine、state machine、audit log、graph、swarm referee、learnings gate は、どのディストリビューションでもバイト単位で同一で、異なるのは外殻だけです。ソース/開発ツリーは、`bun scripts/package.ts cursor` によって `core/` と `harness/cursor/` から、gitignore されたローカルの `dist/cursor/` に**生成**されます。決して手で編集しないでください。

harness 固有の onboarding は `.cursor/rules/aidlc-onboarding.mdc` にあり、`alwaysApply: true` を通じて自動で読み込まれます。ルートの `AGENTS.md` ブロックは harness 非依存で、engine ディレクトリの異なるほかのインストール済み harness と共有されます。

## レイアウト

Cursor は、これまでで最も「native」な port です。標準の core projection を直接消費します（`emit.ts` 無し、分割されたドットディレクトリ無し）。ディストリビューションは次のとおりです:

- **`.cursor/`** — フレームワークツリー。Cursor は、いくつかのサブディレクトリだけを native な意味として読みます。`rules/`（常に適用される onboarding。1 つの標準と 4 つの phase メソッドのポインタ）、`agents/`（native subagent としての 14 のペルソナ）、`skills/`（orchestrator、ユーティリティショートカット、生成された stage runner）、`hooks.json` + `hooks/`（hook の配線とアダプタ）、`cli.json`（permission）、`mcp.json`（MCP サーバー。加える場合）です。その傍らの engine ディレクトリ（`tools/`、`aidlc-common/`、`knowledge/`、`sensors/`、`scopes/`）は、Cursor にとって不活性なデータで、安全にディレクトリを共有します。
- **`aidlc/`** — workspace の外殻（engine が読む、ビルド済みの `aidlc/spaces/default/memory/` メソッドツリー）。`.cursor/` の兄弟です。
- **`AGENTS.md`** — Cursor が自動で読むプロジェクトルートの ambient instruction。

## 前提

- **Cursor** — IDE、または Cursor CLI（`curl https://cursor.com/install -fsS | bash` でインストール。`agent` として起動）。両方がこのインストールの `.cursor/` サーフェスを読みます。cursor-agent 2026.07 に対して検証済みです。hook（`.cursor/hooks.json`）と skill（`.cursor/skills/`）は current-line 機能です。
- **bun** は、ソース開発か、任意の手動 copy の `install.ts` ヘルパーのためだけです。インストール後、native とバージョン付きリリース runtime は `aidlc` を起動します。
- **名前付きモデル向けの有料 Cursor プラン** — Free アカウントは `Auto` しか使えません。tier 付きのペルソナサーフェスは**model pin 無し**で出荷されます（Cursor では全 tier が null に projection されます。model の利用可否はプラン依存です）。そのため、すべてのエージェントがあなたのセッションの model を継承します。`--model` を渡す headless CLI 実行には、それを許すプランが要ります。Bedrock BYOK は IDE のみです。Pro では static なキー、Teams では IAM role です（Cursor の model 設定に対して doc 検証済みで、ここではライブ検証していません）。CLI は、Cursor 自身のバックエンドを通じて model をルーティングします。

## インストール

### Native channel（推奨）

[Install and Lifecycle](../18-install-and-lifecycle.md) に述べたとおり native コマンドをインストールし、それから:

```bash
cd your-project
aidlc config --harness cursor
aidlc doctor
```

Cursor は、git リポジトリに無いフォルダではプロジェクト hook をスキップすることがあり、それらが無いとあなたの承認が決して記録されません。プロジェクトがまだ git リポジトリでなければ、Cursor で開く前にその中で `git init` を走らせてください（すでに開いているなら Cursor を完全に再起動します）。`aidlc config`、copy インストーラ、`/aidlc --doctor` は、それが欠けているときすべてそう言います。

### バージョン付き手動 copy の代替

[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) に述べたとおり、特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードして展開し、それからそのバージョン付き projection をインストールします:

```bash
bun "$RUNTIME_ROOT/cursor/install.ts" your-project
```

copy インストーラは single-harness です。そのルートセクションはプライベートな `AIDLC CURSOR` マーカーを使い、`aidlc config` の所有権 baseline を書きません。multi-harness プロジェクトは、代わりに `aidlc config --harness cursor` で Cursor を加えなければなりません。copy インストーラは、`aidlc config` がすでに管理するルートブロックを拒否します。

インストーラは、完全な copy を preflight し、プロジェクト所有の衝突を拒否し、`.cursor/.gitignore` と既存のメソッド memory を保ち、`.cursor/hooks.json` と `.cursor/cli.json` を構造的に merge し、既存の `AGENTS.md` と `.gitignore` ファイルを置き換えるのではなく、印の付いた AI-DLC セクションを加えます。フレームワークの所有権を `.cursor/aidlc-install.json` に記録します。再実行は、`aidlc/active-space` と明示的な plugin の選択/compose 状態を保ちつつ管理ファイルをアップグレードし、その space を、削除後に復元されたファイルを含むすべての可変なルールとペルソナのポインタに再適用します。plugin-compose された stage ファイルは、contribution sidecar または seam sentinel がその stage を識別するときだけ保たれ、インストーラは保つすべての管理パスを表示します。無関係な core stage は、通常のレシートハッシュの衝突/アップグレード処理を通って続きます。`aidlc/` 外殻は、engine が読む、ビルド済みの `aidlc/spaces/default/memory/` メソッドツリーを出荷します。それが無いと、`/aidlc --doctor` は「workspace shell ready」のチェックに失敗します。

Cursor IDE でプロジェクトを開き（またはその中で `agent` を始め）、`/aidlc --doctor` を走らせ、それから `/aidlc` に作りたいものを続けます。native なユーティリティショートカットは、`/aidlc-status`、`/aidlc-jump --stage <slug>`（または `--phase <name>`）、`/aidlc-scope <name>` です。

## この harness で異なる点

- **質問は番号付き散文の選択肢として描画されます**（構造化質問の widget 無し）。`[Answer]:` タグ付きの質問ファイルが信頼できる情報源のままです。
- **hook は `.cursor/hooks.json` に乗ります**。AIDLC アダプタ（`.cursor/hooks/aidlc-cursor-adapter.ts`）を通じてで、Cursor の camelCase の hook イベント（`sessionStart`、`sessionEnd`、`beforeSubmitPrompt`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`preCompact`、`stop`）を、バイト共有の core hook 本体（bun サブプロセスとして走る）に対応づけます。各 human ターンでの human-turn 記録、ツールが走る前の state-transition・reviewer read-scope・review-freeze・plan-approval の各ガード、write/edit での audit と sensor、失敗した Task の帰属クリーンアップ、shell での stage-graph 再構築、compaction 前の state 検証です。**PreToolUse ガード**は、Cursor の `{"permission":"allow"|"deny"}` の stdout チャネルで答え（`deny` は `agent_message` を加えられます）、`failClosed: true` を登録します。空の stdout は不正な JSON なので、IDE は呼び出しをブロックします。不正な入力も操作を deny します。欠けたかクラッシュするガードは、ほかのどの harness でも同様に、何も拒否せず、`doctor` がそれを名指しします。Cursor は自分の shell ツールを `Shell` と名付けます。アダプタはそれを core hook の `Bash` に対応づけます。ファイルが `path` にある `StrReplace` として届く edit は `Edit` として扱われるので、ほかの edit と同様に記録され確認されます。Cursor の first-class な `Delete` ツール（この harness 独自で、ほかではどこでも削除は shell を通ります）は、reviewer-scope ガードに write として提示されるので、unit-scope の reviewer が兄弟 unit の artifact を削除できません。Shell ペイロードのネストした `cwd`/`working_directory` フィールドは、共有のガード契約に昇格されるので、相対的な read と write が、Cursor が実行する場所で確認されます。
- **forwarding-loop の強制は advisory です。** Cursor の `stop` hook は stop を拒否できないので、core の stop hook が `block` と答えるとき、アダプタは代わりにフォローアップの nudge を表に出します（opencode と同じ姿勢）。そのホストの `loop_limit` は、Cursor の既定 5 ではなく 10 で、これは core の autonomous な no-progress 上限 8 を覆います。conductor skill の forwarding loop が、本当の規律です。
- **background agent は side worker です。** ワークフローが foreground のチャットで走っている間にあなたが始める Cursor の background agent（review、test 実行、コード変更）は、そのワークフローから外れます。セッション開始時に、それはワークフローコンテキストの代わりに短い注記を得ます。ワークフローは foreground のチャットに属すること、`/aidlc` や AIDLC のワークフローコマンドを走らせず、`aidlc/` や `.cursor/` 配下の AI-DLC 自身のファイル（その hook、tool、skill、agent、`aidlc` rule）を編集しないこと、あなた自身の Cursor 設定（`.cursor/mcp.json` など）は問題なく、read と `bun .cursor/tools/aidlc.ts status` も問題ないこと、です。その stop は forwarding nudge を得ず、その prompt は human ターンとして決して数えられず、そのセッション終了は記録されません。何もブロックされません。注記が唯一のガードなので、それを無視する agent は、どの harness でも 2 つ目のセッションが動かせるのと同様に、なおワークフローを動かせます。Cursor は background agent を `sessionStart`、`beforeSubmitPrompt`、`sessionEnd` でだけフラグするので、アダプタは、その会話の後の stop のためにフラグを `aidlc/.aidlc-cursor-subagents/` に記録し、`sessionEnd` でそれを取り除きます。記録が書けない場合、agent は通常どおり走り、その stop は foreground の nudge を得ます。
- **本物の session-end の瞬間が存在します**（Codex とは違い）。`sessionEnd` が発火するので、`SESSION_ENDED` の audit イベントが発行されます。compaction 前の検証も発火します（`preCompact`）。
- **ペルソナは native subagent です。** `.cursor/agents/` の 14 のペルソナ `.md` ファイルは、frontmatter の `name` で発見されます。conductor は、ほとんどのステージでそれらを inline で取り、2 つの subagent ステージ（2.1 reverse-engineering、3.5 code-generation）では `task` ツールを通じて委譲します。worker agent は `task` ツールを得ないので、委譲先は再び委譲できません。
- **subagent の identity は再構築されます。** Cursor は hook ペイロードに subagent ごとの identity を発行しません（その `subagentStart`/`subagentStop` イベントは文書化されていますが CLI では決して発火しません）。そのため、アダプタは `aidlc/.aidlc-cursor-subagents/` 配下に保護されたプロジェクトローカルの runtime ledger を、加えて独立した `aidlc/.aidlc-cursor-subagent-*.json` の active-delegation witness を保守します。トップレベルの会話は `sessionStart`/`beforeSubmitPrompt` で自身を登録し（subagent の会話はどちらのイベントも得ません）、各 Task の spawn がその agent を記録し、reviewer read-scope の強制が、登録されたトップレベルセッションでない会話からの呼び出しを帰属させます。親の次の同期的 Task dispatch が、その前の記録を retire してログします（Cursor CLI は Task の `postToolUse` を発行しません）。本物の親をまたぐ曖昧さは、reviewer がライブな間は常に保守的なままなので、reviewer-scope の強制を無効にできません。委譲されたツールは、祖先の delete や引用符無しの shell glob/character-class のパスを通じてでも、ledger や dispatch 記録にアクセスできません。どの delegation witness も active な間に primary ledger が欠けるか読めない場合、操作は、委譲された agent の帰属を失う代わりに fail closed します。委譲先は通常の Shell コマンドを使えますが、汎用のインタプリタと動的なコマンド評価は deny されます。Cursor の native な read/search ツールを使い、実行可能な probe は親の会話に走らせてください。委譲先に与えられる AI-DLC 自身のコマンド（Reverse Engineering の scope フィンガープリントとそのチェックなど）は、その instruction が綴るとおりに、一度に 1 つのプレーンなコマンドとして走ります。これらの委譲の限界は、reviewer read-scope または state-transition チェックがその作業単位について保たれる間だけ当てはまります。両方が退くと（Guard Policy off がそうします）、委譲先は main の会話のように build・test・search を走らせ、Task は記録が書けないときでも始まり、Cursor 自身の承認が当てはまります。
- **生成された stage と scope の runner は明示のみです。** Cursor は、plugin runner を含む生成された runner skill に `disable-model-invocation: true` を受けるので、通常のコーディング prompt が、state を変えるワークフローショートカットを auto-activate できません。
- **ユーティリティショートカットは native skill です。** `/aidlc-status`、`/aidlc-jump`、`/aidlc-scope` は、2 つ目の engine 経路を作らずに、スラッシュメニューの発見を改善します。すべてが `disable-model-invocation: true` を運びます。Cursor は、ユーザーが選んだときだけそれらを起動します。従来の `.cursor/commands/` サーフェスは出荷されません。
- **メソッドルールは read instruction で、import ではありません。** Cursor のルールは `@` インポート行を展開しません。`.cursor/rules/aidlc.mdc` は常に適用され、active な space の org/team/project ファイルを指します。4 つの `.cursor/rules/aidlc-phase-*.mdc` rule は agent が決め、関連するときだけ対応する phase ファイルを指します（cursor-agent でライブ検証済み。phase を枠にした prompt は対応する phase rule を正確に読み込み、無関係な prompt はどれも読み込みません）。`sessionStart` hook が、ライブのワークフローコンテキストを別に注入します。5 つすべてのルールファイルは、`aidlc/active-memory/`、すなわち engine の git-ignore された active な space のメソッドのコピーを読みます。`/aidlc space <name>` は、ルールではなくそのコピーを書き換えます。
- **Construction swarm は task-tool fan-out のみで走ります**（`AIDLC_USE_SWARM=1` は loud な no-op で、Workflow ツールは存在しません）。
- **statusline / welcome メッセージなし** — `/aidlc-status`（または `/aidlc --status`）とゲートの進捗行を使ってください。
- **Tab 補完は**このインストールに**触れられません**。設定にかかわらず、Cursor 自身の model に乗ります。
- **Permission**: `.cursor/cli.json` は、AI-DLC 自身のワークフローコマンドだけを事前承認します。その engine コマンド、`doctor`、`version`、`status`（とその `--doctor`、`--version`、`--status` の綴り、`--verbose` 付きの doctor）、`config --help`、`config --show`、読み取り専用の `config <section> --show`（`--json` の有無）と `--help` の形、チェックを on に戻すこと（`config flags --clear-bypass <switch> --yes`）、そしてその `aidlc-*.ts` ツール（プロジェクトレベルの `cli.json` は permission だけを運びます）です。native インストールは、インストールされた `aidlc` コマンドとして走る同じコマンド、そして `aidlc engine ...` を事前承認します。それ以外のすべての shell コマンドは、ほかの `config` 変更（チェックを off にすることも）、machine の AI-DLC インストールを変えるコマンド（`use`、`update`、`rollback`、`uninstall`、`system`）、そしてそれらの背後のツールスクリプトを含め、あなたの Cursor 承認設定に従います。
- **MCP server**: 何も出荷しません。必要なら `.cursor/mcp.json` 配下に自分のものを設定してください。
- **headless の `agent -p` 実行は approval gate を通れません。** human-presence の mint は `beforeSubmitPrompt` に乗り、Cursor はそれを対話的な submission についてだけ発火します（cursor-agent 2026.07 に対して検証済み）。そのため、print モードの実行は `HUMAN_TURN` を記録せず、gate 付きのステージは設計上その承認を拒否します。無人のモデルが自分の作業を承認するのを許す代わりにです。headless モードは、読み取り専用のユーティリティ（`--status`、`--doctor`、`--version`）と、autonomous な Construction（gate に人間がいないので免除されます）に使ってください。gate 付きのワークフローは、対話的な Cursor セッションで走らせてください。これは Cursor の限界ではなく、フレームワークの presence gate の性質です。どの harness も human-prompt イベントから presence を mint します。
- **セッション内の設定は対話的です。** Cursor のチャットで `/aidlc --config [section]` を使ってください。conductor が、正確な決定的 config フラグを着地させる前に、選択を集められます。

## インストールの検証

```bash
bun .cursor/tools/aidlc-utility.ts doctor        # all checks pass on a fresh copy in a git repository
agent -p "/aidlc --status" --output-format text --trust   # /aidlc --status through the CLI
```

doctor の Cursor 固有のチェックは、`.cursor/hooks.json` の hook 配線、`.cursor/cli.json` の AI-DLC コマンドの permission 事前承認、`.cursor/rules/aidlc.mdc` の標準ルール、4 つすべての phase-rule ポインタ、そしてプロジェクトが git リポジトリ内にあるかどうかです。

> **スクリプトの罠: Cursor CLI は常に 0 で終了します。** headless の `agent -p "<prompt>" --output-format text --trust` は、実行がエラーになっても終了コード 0 を返すので、CI のチェックは、終了ステータスではなく、発行されたテキストに対して assert しなければなりません。名前付きモデル（`--model`）は有料プランを要します。無ければ `Auto` を使ってください。

## 次のステップ

インストールして検証しましたか。メソドロジーはどの harness でも同じです。中立の章を進めてください:

- [Your First Workflow](../02-your-first-workflow.md) — 注釈付きの end-to-end 実行。
- [Phases and Stages](../04-phases-and-stages.md) — 5 phase と 33 stage。
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — 実行の right-sizing。
- [Glossary](../glossary.md) — すべての用語の定義。

ほかの harness: [AI-DLC on opencode](opencode.md) · [the harness family index](README.md)。

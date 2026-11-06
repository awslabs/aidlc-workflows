# 新しいハーネスへの AI-DLC 移植

AI-DLC は**1 つの core、多くのハーネス**から出荷されます。今日は Claude Code、Kiro CLI、Kiro IDE、Codex CLI、Cursor、opencode、GitHub Copilot で、その集合は開かれています。手で書かれるソースは、ハーネス中立の `core/` に、CLI ごとの薄い `harness/<name>/` 面を加えたものです。パッケージャー（`scripts/package.ts`）が、無視されるローカルの Bun コピーツリーをそれぞれ `dist/<harness>/` の下に、そのネイティブな対応物を `dist-release/<harness>/` の下に実体化します。別のハーネスの追加は**1 つのディレクトリと 1 つのマニフェストの行**です。エンジン、方法論、投影の所有、ハーネスディレクトリ/ルールの解決は `core/` の編集をまったく要しません。任意の例外は 2 つで、ハーネスごとの `--doctor` アーム（ステップ 2 を参照）と、プロトコルモジュール内のツールの束縛サブセクション（ステップ 4 の末尾を参照）です。このページはその契約を歩きます。

> このリポジトリでの「harness」の 3 つの意味。**`harness/`**（トップレベル。このページが扱う CLI ごとの配布面）、**`docs/harness-engineering/`**（このガイド）、**`tests/harness/`**（テストスイートのヘルパーライブラリ）。無関係で、配布なのは最初のものだけです。

## 形

```
core/                      # harness-neutral source — not edited to add a harness (save the optional --doctor arm)
harness/
  claude/  manifest.ts · skills/aidlc/ · onboarding.fills.ts · settings.json
  kiro/    manifest.ts · skills/aidlc/ · agents/*.json · hooks/aidlc-kiro-adapter.ts · settings/cli.json · onboarding.fills.ts
  codex/   manifest.ts · emit.ts · skills/aidlc/ · hooks/aidlc-codex-adapter.ts
  opencode/ manifest.ts · emit.ts · skills/aidlc/ · command/ · plugin/
  copilot/ manifest.ts · emit.ts · skills/aidlc/ · hooks/aidlc-copilot-adapter.ts
scripts/
  package.ts               # bun scripts/package.ts [<name>] [--check]
  manifest-types.ts        # the HarnessManifest contract every manifest implements
dist/<name>/               # GENERATED Bun-invocation channel
dist-release/<name>/       # GENERATED native-aidlc channel
```

`core/` の散文は、ハーネスディレクトリを `{{HARNESS_DIR}}` で名指し、フレームワークを `{{INVOKE}}` で呼び、生成された接頭辞が要るところで `{{TOOL_PREFIX}}` を使います。パッケージャーは、宣言されたディレクトリと、2 つの呼び出しポリシーの 1 つを置換します。

| チャネル | `{{INVOKE}}` | `{{TOOL_PREFIX}}` |
|---------|--------------|-------------------|
| `dist/` | `bun <harness-dir>/tools/aidlc.ts` | `bun <harness-dir>/tools/` |
| `dist-release/` | `aidlc` | `aidlc ` |

core の散文が、質問ファイルが質問の選択肢にどう文字を振るかを言うところでは、`{{OPTION_LETTERS}}` を書きます。`A-E`、またはマニフェストの `questionOptions` が設定する短い範囲（下記）です。

この変換は Markdown と構造化コマンド面（`.json`/`.toml`/`.hook`）、そして TypeScript 内の呼び出しトークンに適用されます。一般的なソースの書き換えではありません。`core/tools/aidlc-lib.ts` のランタイム `harnessDir()` の継ぎ目は、なお出荷されたレイアウトからディレクトリを導くので（開かれた集合。ツール自身のパスで、ハードコードされた一覧ではありません）、同じ書かれたツールのソースがすべてのツリーで実行されます。受け入れゲートは**ジェネレーターの決定性**です。`package.ts --check` は、両方のチャネルとすべてのプラグイン投影を、独立した 2 つの一時ルートで 2 回ビルドし、完全な出力をバイト比較します。ローカルの `dist/` や `dist-release/` を読みません。

パッケージャーは `harness/` を走査して `manifest.ts` を探すことでハーネスを**発見する**ので、新しいディレクトリは既定の `bun scripts/package.ts` と `--check` でビルドされ、パッケージャー自身を編集しません。「1 つのディレクトリと 1 つのマニフェストの行、共有コードの編集ゼロ」の文字どおりの意味です。

## ステップ 1 — マニフェスト（宣言的な 80%）

`HarnessManifest`（`scripts/manifest-types.ts`）を export する `harness/<name>/manifest.ts` を作ります。フィールドは次のとおりです。

- `name` / `harnessDir` — トークンが置換されるディレクトリ（たとえば `.foo`）。
- `productName` / `configNextStep` — ライフサイクルと `aidlc config` が消費する、ユーザー向けの投影メタデータ。ホストコマンドは正確に保つ。
- `choiceName` / `choiceNote`（任意） — `aidlc config` のハーネスメニューが `productName` の代わりに示すものと、その横に示すもの。Kiro CLI（V2）と Kiro のように、製品を別のものと共有するハーネスのため。プレーン ASCII テキストのみ。最初に ASCII の英字か数字、次に英字、数字、スペース、`.,()+-`。名前は 1〜15 文字、注記は 1〜60 文字。パッケージャーはそうでないテキストのマニフェストを拒否し、`aidlc config` はそのような投影を提示しない。
- `firstRunSteps` / `editorTerminalApp` / `hookActivation`（任意） - 初回実行に他のハーネスにないステップが要るホストのためだけ。`firstRunSteps` は `aidlc config` を終える 2 つの次ステップ行を置き換える。`editorTerminalApp` はエディターの内蔵ターミナルが設定する `TERM_PROGRAM` の値で、そこで `aidlc config` を実行すると、このハーネスがウィザードの既定の選択になる。`hookActivation` は、人が動くまでフックを 1 つも実行しないかもしれないホストのため。その中のどのテキストも、ホスト自身の言葉で、人自身のステップだけを名指し、フック、エンジン、理由には決して触れない。`<entry>`、`<folder>`、`<next>` はインストールのために埋められる（`<next>` はエンジンの `next` コマンド。`next` の停止では、止まったコマンドをまた実行するよう言う固定の語なので、そのリクエストが保たれる）。`recovery` は doctor の修理。`agentStep` は、エージェント自身のシェルコマンドのフックが、自分のチェックを切っていても、エンジンが実行する前に記録にハートビートを残すときにだけ設定する。エージェントが自分で何をするかを言い、次に人に示す正確な行を引用する。
  その後 `next` は、ステージがハートビートなしで始まっていると、どの作業よりも前にそれを `print` として停止し、同じ状態で、付き添いの「新しい人間の返事がない」拒否が、それを「do not ask them to answer again」とともに運ぶ。
  そうでなければ、または `agentStep` のないハーネスでは、その拒否は代わりに `missedReply` を与える（`AIDLC_UNATTENDED=1` の実行は自分の説明を得る）。まだ返事していないかもしれない人に向けて言葉にされる（「If the person already replied, ...」）。`missedReplyInHost`（`{ env, text }`）は、名指しの環境変数のどれかがエージェントのシェルに設定されているとき、1 つのホストに自分の行を与える（`NAME=value` のエントリはその値を保つときで、`NAME=value` の変数が別の値を保つときは無し）。Kiro IDE はそれを `TERM_PROGRAM=kiro`（そのエージェントのコマンドが運ぶ）と、`VSCODE_IPC_HOOK`/`VSCODE_PID`（そのフックだけが運ぶ）に使うので、VS Code のターミナル（`TERM_PROGRAM=vscode`）の Kiro CLI が Kiro IDE と取り違えられない。`agentStepInHost`（`{ env, text }`）は `agentStep` について同じことをするので、エージェントは自分のツールの行だけを得る。ツールごとに 1 行だと、あるエージェントが間違ったものを示した。`registration`（`{ file, missing, invalid, unwired }`）は、ホストが AI-DLC のフック登録を読むプロジェクト JSON ファイルを名指す。それが欠けている、有効な JSON でない、AI-DLC のフックを 1 つも登録していないあいだ、どの設定もそれらのフックを戻さないので、ステップは人に向けた `missing` か `unwired`（その `<repair>` はフックを戻す doctor のコマンド）または `invalid` の行になり、doctor は `recovery` と `notRunYet` の代わりに同じ行を与える。Claude Code は `.claude/settings.json` にそれを宣言する。
  `startedInsideProject` は、ホストがプロジェクトの内側のフォルダで始めたチャットの行で、そこではどの設定もフックを戻さない。人は `agentStep` の代わりにそれを示され、doctor は `recovery` と `notRunYet` の代わりにそれを与える。エンジンがそのフォルダを知るのは、実行中のチャットのホスト自身の記録からだけで、`aidlc-lib.ts` の `hostChatStartFolder` が、それを宣言する 2 つ、Claude Code と Codex CLI のためにそれを読む。新しいホストは、そこでその記録も読まれる必要がある。`notRunYet` は、ハーネスのフックがすべてのチャットメッセージに、どのワークフローも含まない最初のものより前にハートビートを残すときにだけ設定する（human-turn フックがそうで、Copilot と Kiro IDE のアダプターもそう）。すると doctor は、ハートビートが存在しないあいだそのテキストで警告し、`agentStep` があれば、人のメッセージが 1 つも残さなかったとき、最初の `next` がどの作業よりも前にエージェントのステップで停止する。`notRunInWorkflow` は `agentStep` とだけ設定する。人が存在チェックを切ったので `next` が停止しないとき、エンジンがその一文をすべてのディレクティブの `change_notices` に加える。Claude Code、Codex CLI、Kiro CLI、opencode は `recovery`、`agentStep`、`notRunYet` を宣言する（Kiro CLI は `missedReply` も。そのエージェントピッカーを名指す）。Copilot は `notRunInWorkflow` も、Kiro IDE は `recovery`、`missedReply`、`missedReplyInHost`、`notRunYet`、`agentStep`、`agentStepInHost` を宣言する。Kiro にコマンドの実行を許していないフォルダでは、どの AI-DLC コマンドも実行できないので、Kiro IDE はそのステップを orchestrator スキルにも保つ。
- `directiveMaxBytes`（任意） - 1 つのシェル結果を、エンジンの 28 KiB のディレクティブキャップより少なく保つホストのため。エンジンはどのディレクティブもそれ以下に保つ。ステージルールは収まるあいだだけインラインで乗り、load-steering の部分は収まるよう切られる。ホストの切り捨てより下に、末尾の改行の余地を持って大きさを合わせる（UTF-8 のバイト数は決して文字数を下回らない）。Copilot だけがそれを宣言する（19,000 バイト。VS Code の 20,000 文字のターミナル結果のため）。ネイティブエンジンは、それを古いリリースで設定されたプロジェクトにも、出荷されるランタイムから適用し、プロジェクト自身の値がそれを超えることを決して許さず、複数のハーネスがインストールされたプロジェクトでは、宣言された最小の限界が勝つ。ステップが収まらないとき、エラーはハーネス名をキーとする固定一覧（`core/tools/aidlc-runtime-paths.ts` の `HOST_LABELS`）からホストを名指し、プロジェクトが編集できる `productName` からは決して名指さない。そこにハーネスを加えるか、さもないと「this assistant」と読まれる。
- `questionOptions`（任意） - 構造化された質問ボックスが、自分の Other 行のほかに 5 つより少ない選択肢を示すホストのため。示す数と、その `question-rendering.md` が名指すもの。質問ファイルは各質問の選択肢に A からその文字まで、`X. Other` の前に文字を振るので、エージェントは各質問をボックスにまるごと入れる。無ければ、ファイルは A-E を使う。Claude Code だけがそれを宣言する（4。AskUserQuestion のため）。
- `agentFinishRecorded`（任意） - `{ env: [...] }`。自分の stop イベントが、ヘルパーをディスパッチしたエージェントがヘルパーの結果を見る前に `log-subagent` フック（その `SUBAGENT_COMPLETED` 行）を、すべてのディスパッチで実行するホストのためだけ。`env` は、ホストがそのエージェントのシェルに設定する変数を名指す。そのようなホストでは、リクエスト以降にそのレビュアーの完了行なしで記録されたレビュー判定は、どのレビュアーも終える前に記録されたと印され、人はそれを 1 行で聞く。それを宣言するのは、行が先に着地することをライブのチェックが示した後だけにする。後で書くか、まったく書かないホストでは、あるレビューを終えたレビュアーがいないと人に告げてしまう。Claude Code だけがそれを宣言する（`CLAUDE_CODE_SESSION_ID`）。他のどのホストも、代わりにディスパッチの記録から同じ印を得る。ディスパッチが `deliver-stage-rules` フックに届くアダプターはそこにそれを書き、ディスパッチフックを実行しないものは、ヘルパーを放すときに `hook_event_name: "SubagentStart"` を、ヘルパーの `agent_type` とともに `log-subagent` へ転送する。どちらも無ければ、ホストは決して印をつけない。
- `statusLine`（任意） - AI-DLC がその進捗を示せるステータスラインを持つホストのためだけ。そのホスト自身の形で（Claude Code: `{ type, command }`、Codex: `{ items }`）。それは `tools/data/harness.json` に発行され、ホストが読む設定ファイルには決して発行されない。プロジェクトのファイルは各人自身のステータスラインの場所を取ってしまうからで、エンジンは誰かがそれを選んだときにだけ書く（`core/tools/aidlc-statusline-choice.ts` が、ホストごとにどこかを所有する）。
- `rootIntegrations` — 通常の投影が発行するすべてのプロジェクトルートのファイルで、それぞれに明示的な init マージポリシーを持つ（`managed-block`、`json-map`、`json-array`、`whole-file`、`jsonc-settings`、`json-entries`）。`json-entries` は、チーム自身の JSON 設定ファイル（opencode の `opencode.json`）のため。config は AI-DLC の値と配列の文字列を、どの深さでも無いところにだけ加え、チーム自身のコマンドの許可ルールをマップの先頭に加えてその後のチームのルールが決めるようにし、他のすべてを保ち、自分が書いた値をなお保つエントリだけを辿るか退役させる。その部分は root-blocks で出荷され、コピーランタイムはそのファイルを外す。`jsonc-settings` は、エディター自身の JSONC 設定ファイル（Copilot の `.vscode/settings.json`）のため。config は、プロジェクトが設定していないときだけ各出荷トップレベルキーを加え、他の誰かが設定した値を決して変えず、他のすべてのキー・コメント・行を保ち、加えたキーを記録してチームが後で取り除いたキーが戻されないようにし、その値がなお自分の加えたものであるキーだけを退役させる。コピーランタイムはそのようなファイルを外すので、コピーがチーム自身のものを置き換えることは決してない。マーカー/JSON の身元、任意性、正確なレガシー採用ハッシュをここで宣言する。パッケージャーは、管理ディレクトリでも宣言されたルート統合でもない発行トップレベルエントリを拒否する。`shared: "union"` は、インストールされたハーネスにまたがって managed-block の行の集合を組み合わせる。`shared: "identical"` は、宣言するどのハーネスも所有できるバイト同一の内容を宣言するので、それを出荷する 2 つのハーネスが共存できる。`shared` が無ければ、そのブロックは排他的。
- `nativeRootIntegrations`（任意） — リリースチャネル専用のルートファイル。trust seed のようなもの。同じマージ契約に、書かれた `src` を加えたもの。
- `tierFlavor` — 既存の Claude/Codex/Kiro/OpenCode エージェントの model/effort 投影の形を選ぶ。それはマニフェストのデータで、`name` から推論されることは決してない。
- `kiroLayout`（Kiro の行のみ） — `agent-v1`（フックを運ぶ JSON エージェント）または `kas`（Markdown エージェントと単独の `.kiro/hooks/*.json`。Kiro IDE 1.x と Kiro CLI v3 が実行する）。それは `harness.json` に書かれ、レイアウトに依存するランタイムコードは、`name` からではなくインストール済みツリーからそれを読む。
- `hookCommandSuffix`（Kiro `agent-v1` の行のみ、任意） - パッケージャーが、その行の `agents/*.json` のすべてのフックコマンドに付け足すテキストで、ホストがフックを始めるシェルが終了コードを返すようにする（Kiro CLI: `; exit $LASTEXITCODE`。Windows の PowerShell、他では bash のため）。書かれた JSON はそれなしでコマンドを運ぶ。
- `coreDirs: DirMap[]` — どの `core/<src>` ディレクトリが `<harnessDir>/<dst>` に投影されるか。ここでディレクトリを改名したり落としたりする（Kiro `rules → steering`。Codex `rules → aidlc-rules` で `skills/` を落とす — emit を参照）。3 つのセッションスキルはツリー内ハーネス（claude、kiro、kiro-ide）の core ディレクトリで、codex は代わりにそれらを emit する。
- `harnessFiles: FileMap[]` — `harness/<name>/<src>` から各チャネルにそのままコピーされる、書かれた面（対応するテキスト形式はトークン置換を得る）。`projectRoot: true` は、ハーネスディレクトリの横にファイルを着地させる（たとえば `AGENTS.md`）。
- `orchestratorSkillPath`（任意） — 組み立てられた orchestrator `SKILL.md` へのプロジェクトルート相対パス。既定は `<harnessDir>/skills/aidlc/SKILL.md`。`.agents/skills/aidlc/SKILL.md` のような、そのツリー外の emit 所有のレイアウトには宣言する。
- `frontmatterAdditions`（任意） - 投影中に、core 投影された `.md` のフロントマターに付け足されるファイルごとの YAML 行で、他のハーネスに出荷されてはならないハーネス固有のフィールドのため（kiro-ide はその委譲ターゲットのエージェントファイルに `tools: ["read", "write", "shell"]` を注入する。IDE はサブエージェントのツール付与を `.md` フロントマターから読む）。core を単一ソースに保つためにマニフェストのデータとして宣言される。パッケージャーは、打ち間違えたパス、欠けたフロントマターブロック、core がすでに宣言するキーでエラーにする。
- `nativeReplacements`（任意） — リリースチャネルがその汎用の呼び出し書き換えの前に差し込む正確な `{ from, to }` テキストで、コピーチャネルの綴りが機械的なネイティブ形を持たない投影された内容のため（kiro-ide のペルソナシェルの deny）。パッケージャーは `from` が投影に無いときエラーにし、その投影された呼び出しのチェックは `to` テキストを飛ばす。それはルート表から生成される。
- `rulesRename` - 改名されたルールディレクトリ（`"steering"` | `"aidlc-rules"` | `null`）。パッケージャーはそれをコピーされたディレクトリと、散文内の `<harnessDir>/rules/` 参照に適用し、マニフェスト名とルールディレクトリの両方を記録する、生成された `tools/data/harness.json` に発行する。ルール自体は空間メモリ層（`aidlc/spaces/default/memory/`）から来て、グラフコンパイルがすべてのハーネスについて `AIDLC_RULES_DIR` を通じてそれを読む。改名されたディレクトリのためのコンパイル済みルールパスへの走査は、なお実行され、今日は何も変えない。ランタイムのパス解決は、エンジンディレクトリを共有するハーネスを区別するために名前を使い、`rulesSubdir()` は改名を読む。だから実際のインストールは、ハードコードなしに両方の事実を解決する。これが `rulesRename` を純粋なマニフェストデータにする継ぎ目で、ここで設定すればビルドの散文とランタイムが従い、`core/` の編集はない。
- `onboarding: OnboardingSpec` — `core/templates/onboarding.md` から中立の案内を、`core/templates/onboarding-harness.md` からハーネス固有のセットアップを、`harness/<name>/onboarding.fills.ts` で描く。`dst` は出力を名指し、`projectRoot: true` はそれをエンジンディレクトリの横に置く。`harnessDst` をツリールート相対のネイティブ onboarding パスに設定すると、`dst` を中立のみに保ち、埋められたハーネス骨格を別に発行する。`harnessDst` が無ければ、両方の部分が連結される（ネイティブが先、間に空行 1 つ）。Claude と Copilot が要るとおり。ネイティブ骨格の先頭の `frontmatter` スロットは、常時 on の steering/rules を支える。中立の骨格はマーカーを含んではならない。パッケージャーは、すべての `shared: "identical"` のルートパスについてバイトの身元を検証する。`emit.ts` が onboarding を所有するか、onboarding が出荷されないときだけ `null` を使う。
- `skipRunnerGen` — ハーネスが `<harnessDir>/skills/` を出荷しないときに設定する（Codex は `emit` を通じてそのスキルツリーを `.agents/skills/` に発行する）。すると、パッケージャーは標準のランナー生成ステップを飛ばす。
- `emit` — 任意のプラグイン（ステップ 3）。要らないハーネスには `null`。
- `plugin`（任意） — ホストプラグインのマニフェストディレクトリと配送の種類。省くと `<harnessDir>-plugin` とストア配送を導く。フォルダドロップのホストにだけ `kind: "kiro"` を設定する。ホストがマニフェストディレクトリ以外からプラグインのカタログを読むとき `marketplaceDir` を設定する（Codex: `.agents/plugins`）。

Claude のマニフェストは最小のリファレンス（改名なし、emit なし）です。Kiro のは改名 + `harnessFiles`（エージェント JSON とアダプター）に、分割された root/native onboarding を加えます。Codex はネイティブ専用のルート統合と命令的な発行を示します。

パッケージャーはこれらのフィールドから `tools/data/harness.json`、`aidlc-stamp.json`、`aidlc-projection.json` を書きます。最初はランタイム設定、stamp はバージョン/配布/ハーネスを特定し、投影記述子はインストールの所有の契約です。その任意のプロジェクト相対の `onboarding` パスは、診断が追うネイティブファイルを特定します（onboarding がルートファイルのときは無し）。`aidlc config` は一貫しない、または安全でない記述子を拒否するので、`emit.ts` で並行するメタデータを生成しないでください。

## ステップ 2 — フックアダプター（ハーネスごとの shim）

core のフックは Claude 形の stdin を通常の形として消費します。新しいハーネスは**1 つの書かれたアダプター**（`harness/<name>/hooks/aidlc-<name>-adapter.ts`。`harnessFiles` に並ぶ）を出荷し、ハーネスのフックペイロードをその契約に正規化し、共有の core フックへサブプロセスでパイプします。core のフックをロジックとアダプターに分割しないでください。core の本体は、明示的な呼び出しトークンの投影を除いて、すべてのハーネスにわたってバイト共有のままです。`--check` が、生成された両方の形が同じソースから来たことを証明します。

アダプターをハーネスのイベントに、ハーネス自身のやり方で配線します。Kiro は `agents/aidlc.json` にターゲットを登録し、Codex は `hooks.json` を発行します。実際の core フックの消費側があるイベントだけを登録します。

6 つのフックはフローを変えるもので、その制御チャネルを転送する必要があり、ただパイプするだけではいけません。Stop フックは stdout の `{"decision":"block"}` で答え、`aidlc-deliver-stage-rules` は委譲されたプロンプトを書き換え、PreToolUse の reviewer-scope、review-freeze、plan-approval、state-transition のガードは exit 2 + stderr の理由で答えます（アダプターがその exit コードを中継したとき、ツール呼び出しは拒否されなければなりません）。新しいハーネスが pre-tool の継ぎ目からツール呼び出しを硬くブロックできないなら、reviewer-scope と review-freeze の登録を省き、死んだフックを配線する代わりに隙間を文書化します。散文の境界がそこをなお支配します（stage-protocol-reviewer-unit.md の読み取り範囲、stage-protocol-reviewer.md §12a のレビューフリーズ）。ハーネスのペイロードがサブエージェントの身元を運ばないとき、ハーネスがエージェントごとのフックを支えるところで、reviewer-scope の登録をレビュアーエージェント自身に絞ります（Kiro CLI のパターン。すると、アダプターは `agent_type` を照合する代わりに `scoped_registration` を主張します）。

> **認められた唯一の `core/` の編集: doctor のアーム。** `/aidlc --doctor`（`core/tools/aidlc-utility.ts`）はインストール済みツリーをヘルスチェックし、新しいハーネスは、自分のインストール面（アダプター + 配線ファイルの存在、バイナリバージョンの下限）のためのハーネスごとのアームをそこに加えます。これは意図的なハーネスごとの*ロジック*で、データではありません。バージョンチェックは CLI を生成して semver を比べ、どのマニフェストの行も表現できません（3 つの関心の規則。知識はコードに置かれる）。だからこれは「`core/` の編集ゼロ」の恵まれた例外で、違反ではありません（意図的な設計のトレードオフ）。それは優雅に劣化します。アームのないハーネスは、失敗せず汎用のチェックを得るだけです。他のすべて、つまりディレクトリの解決、ルールディレクトリの改名、パッケージングは、純粋なマニフェストデータのままです。

## ステップ 3 — `emit.ts`（命令的な 20%、必要なときだけ）

宣言的な行が表現できない構造的な分岐が `emit.ts` です。マニフェストが参照するプラグインで、パッケージャーが `EmitContext`（`repoRoot`、`coreRoot`、`harnessRoot`、`harnessName`、`distRoot`、`harnessDir`、チャネルを意識した `substituteToken`、`tierCap`）で呼びます。発行側はその出力を `distRoot` の下に書きます。Codex のが作業例です。`config.toml`、`hooks.json`、フック trust のプリシード、ネイティブ onboarding のスキルパス書き換え、エージェント TOML の転置、`.agents/skills/` ツリー（`AIDLC_HARNESS_DIR` の下で `core/tools/aidlc-runner-gen.ts` の export された render 関数から組まれ、決して再実装されない）です。すべての面が書かれたファイルであるハーネス（Claude、Kiro）は `emit: null` を設定します。

`--check` では、パッケージャーが 2 つの独立した一時 `distRoot` の集合を供給し、各ビルドでチャネルごとに同じ発行側を 1 回実行し、2 つの完全な生成ルートを比べます。`<harnessDir>` の外の emit 所有のファイル（たとえば `.agents/skills/`）は、だから宣言的な出力と同じ、欠け・差異・孤児のチェックに参加します。発行されるコマンドテキストは常に `ctx.substituteToken` を通してください。さもないと、発行側が静かに Bun コマンドをネイティブチャネルに入れられます。

## ステップ 4 — 境界のある変換クラス

許される変換は、ハーネス/ルールの投影、2 つの呼び出しトークン、宣言された tier/frontmatter の追加、そして `rewriteNativeInvocations` のネイティブなホスト面の書き換えです。そのネイティブパスは、コマンドの許可一覧、フック/アダプター/ステータスラインのルート、onboarding のランタイムテキスト、ネイティブな trust エントリを更新し、次に AIDLC のツール/フックへの、生き残ったトークンや Bun の呼び出しを拒否します。目隠しの `sed` はありません。`core/` の真実なハーネス固有のリテラル（`$CLAUDE_PROJECT_DIR` の注記、workspace-detection のハーネスディレクトリ列挙）は、トークンを運ばず、変えずに通ります。core-hygiene とネイティブ投影のテストが境界を守ります。

もう 1 つの投影が、各ツリーを自分のツールに保ちます。construction、topology、reviewer、swarm のプロトコルモジュールは、それぞれハーネスごとに 1 つの `### <tool>` の束縛サブセクションで終わり、`scripts/harness-bindings.ts` はツリーに自分のものだけを出荷します。移植するには、それらの各実行にツールのサブセクションを加え、その見出しを `BINDING_HEADINGS` に加えます。そうするまで、ツリーはすべてのツールのサブセクションを出荷します。

## ステップ 5 — テスト + ゲート

- パッケージ決定性テスト（`t145`）は `package.ts --check` を実行し、発見されたすべてのハーネスの両方のチャネルと、すべてのプラグイン投影を、ディスク上の生成ツリーを要さずにカバーします。
- `t243-install-mechanism` は、コピー投影が Bun の呼び出しを保ち、リリース投影が AIDLC の Bun 呼び出しを含まず、メタデータが安全で網羅的で、ネイティブ専用の統合が `dist-release/` にだけ現れることを主張します。
- `t238-build-binaries` は、ネイティブディスパッチャーをコンパイルし、`PATH` に Bun なしで、生成されたすべてのハーネスのランタイムを行使します。
- `<name>` フックアダプターの契約テストは、ライブで捕まえたペイロードをアダプターに通し、観測できる core フックの効果を主張します。
- ライブジャーニーは `skipReason()`（`AIDLC_<NAME>_*_LIVE=1` の環境 + バイナリの存在 + 認証済み）にゲートされた e2e として出荷され、決定論的なティアできれいに飛ばされ、移植がマージされる前にローカルで green に実行されます。

`bun scripts/package.ts <name>` を実行して両方のローカルチャネルを実体化し、`--check` で決定論的な生成を証明し、決定論的なスイート（`bash tests/run-tests.sh --smoke --unit --integration -P 8`）とライブジャーニーでゲートします。

## 次へ

これで弧が閉じます。データ面を形づくり（01〜08 章）、いまその core を新しい CLI に描きました。ここから。

- [ハーネスエンジニアガイドの概要](00-overview.md)に戻れば、完全な地図があります。
- 新しいハーネスは、他のものと並んで**ユーザー向けの章**を得ます。既存のものがどう読めるかは、ユーザーガイドの[他のハーネスで実行する](../guide/harnesses/README.md)の仲間を見てください。
- 規範的なビルドの契約（マニフェストの型、`emit` プラグインの API、`harnessDir()` の継ぎ目）は、開発者リファレンスの[Architecture § ソース対配布](../reference/01-architecture.md#source-vs-distribution-one-core-many-harnesses)に置かれています。

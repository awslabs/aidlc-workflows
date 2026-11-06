# AI-DLC on GitHub Copilot (CLI + VS Code)

Copilot runtime は、フレームワークの harness ディストリビューションの 1 つで、**GitHub Copilot** 向けです。そして 1 回のインストールが両方の Copilot サーフェスに対応します。スタンドアロンの Copilot CLI（`copilot`）と VS Code agent モードです。GitHub は、その 2 つを同じプロジェクト発見パス（`.github/skills/`、`.github/agents/`、`.github/hooks/`、ルートの `AGENTS.md`）に収束させたので、フレームワークは両方が読む 1 つのツリーを出荷します。1 つの決定的な core に、多くの harness。engine、state machine、audit log、graph、swarm referee、learnings gate は、どのディストリビューションでもバイト単位で同一で、異なるのは外殻だけです。ソース/開発ツリーは、`bun scripts/package.ts copilot` によって `core/` と `harness/copilot/` から、gitignore されたローカルの `dist/copilot/` に**生成**されます。決して手で編集しないでください。

完全な onboarding は、ルートの `AGENTS.md` に留まります。Copilot 固有のセットアップと、method ファイルのライブな `@` インポートブロック、続いて中立のプロジェクトガイダンスです。Copilot の managed ルートブロックは専有のままで、中立のみのブロックを出荷する harness とは共有されません。プロジェクトの instruction を merge するとき、それらのインポートを保ってください。

## レイアウト: engine ディレクトリと .github 外殻

- **`.aidlc/`** — AIDLC engine ツリー（tools、hooks と Copilot アダプタ、agents、knowledge、scopes、sensors、aidlc-common、そして Copilot CLI のコマンドランチャー `bin/aidlc-engine`）。どちらの Copilot サーフェスもそれをスキャンしません。ユーザーに見えるものはすべて `.github/` に乗ります。
- **`.github/`** — native に消費される `aidlc` 名の出力だけです。hook 配線（`hooks/aidlc.json`）、14 のペルソナのカスタムエージェント（`agents/aidlc-*-agent.md`）、完全な skill ツリー（`skills/aidlc*/` — orchestrator、per-stage runner、scope runner、session skill）です。あなたのリポジトリ自身の `.github/` コンテンツ（workflow、template）は触れられません。インストールはこれらのファイルを merge し、すべて接頭辞で衝突しません。
- **`.vscode/settings.json`**: VS Code の設定 1 つ、`chat.agent.maxRequests` で、あなたのプロジェクトがそれを設定していないときだけ加えます（[VS Code request cap](#vs-code-request-cap) を参照）。copy runtime はこのファイルを含めません。

## 前提

- **Copilot CLI ≥ 1.0.74 かつ/または VS Code ≥ 1.130** — PascalCase の hook 登録（その後、両サーフェスが同一の snake_case ペイロードを配信）、ブロッキングな PreToolUse の deny チャネル、ブロッキングな Stop hook、`.github` の skills/agents 発見について、検証された系列です。`copilot --version` / `code --version` で確認してください。VS Code の agent hook は Preview 機能で、doctor は任意の Copilot CLI バージョンだけを確認するので、`code --version` は自分で確認してください。[Facilitator Guide](../facilitator-guide.md#github-copilot-on-windows) に、hook が走ることを証明する準備完了チェックがあります。
- **bun** は、ソース/開発の `dist/` projection を生成または実行するときだけです。native インストールとバージョン付きリリース runtime は `aidlc` を使います。
- **フォルダの信頼**: 各 Copilot サーフェスが自分のものを確認します。
  - Copilot CLI は、`trustedFolders` リストが覆うフォルダ（そのフォルダ自身、または 1 つ上のフォルダ）でだけリポジトリの hook を走らせます。リストは、`COPILOT_HOME`、無ければ `~/.copilot`（Windows では `%USERPROFILE%\.copilot`）の `config.json` にあります。対話的な `copilot` 実行は、prompt を受け取る前にフォルダの信頼を確認するよう求めます。「Yes, and remember this folder for future sessions」を選んで記録します。`aidlc config` は、リストがフォルダを覆わないとき教えます。
  - VS Code agent モードは、そのリストを決して読みません。その hook は、**Chat: Use Hooks** 設定（`chat.useHooks`）が on の、信頼された workspace（VS Code Workspace Trust）でだけ走ります。その設定は、組織が off にできる preview 機能です。`aidlc config` は、プロジェクトがそれを設定していないとき、フォルダの `.vscode/settings.json` でそれを on にし、フォルダの値が off のユーザー設定に勝ちます。スキップされた hook は、チャットにメッセージを残しません。Agent Debug Logs パネルがそれを示します。
  - `/aidlc --doctor` は、CLI のリストがフォルダを覆わないとき警告します。VS Code のスイッチは見えませんが、あなたのメッセージに対して hook が 1 つも走らないとき、AI-DLC はチャットでそう言います（下の「AI-DLC は hook が走っていないとき言う」を参照）。
- **モデル provider** — このインストールの何もモデルを pin しません。サインイン済みの Copilot はそのまま動きます。BYOK は GitHub の認証なしでまったく動きます（例: Amazon Bedrock の Anthropic 互換 endpoint: `COPILOT_PROVIDER_BASE_URL=https://bedrock-runtime.<region>.amazonaws.com/anthropic`、`COPILOT_PROVIDER_TYPE=anthropic`、bearer token、そして `COPILOT_MODEL=<catalog name>` + `COPILOT_PROVIDER_WIRE_MODEL=<Bedrock model id>`。`copilot help providers` がその集合を文書化します）。VS Code では、model picker か Custom Endpoint provider を使います。すべての AI-DLC エージェントはあなたの Copilot セッションの model と effort を使うので、そこで選んでください。[Choosing a Model and Effort](../18-install-and-lifecycle.md#choosing-a-model-and-effort) を参照してください。

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
aidlc config --harness copilot
aidlc doctor
```

### バージョン付き手動 copy の代替

[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel) に述べたとおり、特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードして展開し、それから `RUNTIME_ROOT` を展開した `runtime/` ディレクトリに設定します。

1. ディストリビューションをあなたのプロジェクトにコピーします:

   ```bash
   mkdir -p your-project/.aidlc your-project/aidlc your-project/.github
   cp -R "$RUNTIME_ROOT/copilot/.aidlc/."  your-project/.aidlc/
   cp -R "$RUNTIME_ROOT/copilot/aidlc/."   your-project/aidlc/    # the workspace shell — a sibling of .aidlc/, not inside it
   cp -R "$RUNTIME_ROOT/copilot/.github/." your-project/.github/  # MERGE — everything is aidlc-prefixed, nothing of yours is overwritten
   ```

2. copy 自身の setup を一度走らせます:
   `cd your-project && bun .aidlc/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness copilot`。
   これは、すでにそこにあるすべての後に、AI-DLC の行をあなたの `AGENTS.md`（method include を含む）と `.gitignore` に加えるか、プロジェクトに何も無いとき作成します（clone ごとの audit シャードは意図的に commit され、カーソルと machine ローカルの runtime は ignore されたままです）。これが無くても、AI-DLC は最初のチャットが始まるときそれらを加えます。
   VS Code では、`.vscode/settings.json` がそのキーを設定していなければ、`"chat.agent.maxRequests": 200` も加えてください（[VS Code request cap](#vs-code-request-cap) を参照）。copy runtime はそのファイルを含めないので、それをコピーしてもあなた自身のものを決して置き換えません。

3. フォルダを trust します。プロジェクトで `copilot` を対話的に一度起動し、trust prompt を受け入れます（または `~/.copilot/config.json` の `trustedFolders` にプロジェクトの絶対パスを加えます）。

4. どちらのサーフェスでも、`/aidlc --doctor` を走らせ、それから `/aidlc` に作りたいものを続けます。

Bun 形式の projection が要るフレームワーク開発者は、リポジトリを clone し、`bun install --frozen-lockfile` と `bun scripts/package.ts` を走らせ、それから gitignore されたローカルの `dist/copilot/` の出力を使えます。

## この harness で異なる点

- **1 つのインストール、2 つのサーフェス。** skill、ペルソナ、instruction、hook は、CLI でも VS Code agent モードでも同一に振る舞います。下の相違は明示的に挙げます。
- **runner はタイプしたときだけ始まります。** 生成された各 runner（`/aidlc-bugfix`、`/aidlc-<stage>`、`/aidlc-init` とその他、plugin runner を含む）は `disable-model-invocation: true` を運ぶので、エージェントは自分でそれを始めず、runner の説明が Copilot の skill リストから外れたままになります。1 つをタイプすることは、VS Code チャットと対話的 CLI で従来どおり動きます。headless の `copilot -p "/aidlc-bugfix ..."` は、あなたの行をプレーンテキストとしてエージェントに手渡します。ルートの `AGENTS.md` が、その runner のファイルを読んで従うよう言うので、runner はなお走ります。
- **質問は番号付き散文の選択肢として描画されます。** 両サーフェスは native な picker ツールを露出しますが、picker の回答はツールの結果として返り、human-presence ガードが要する信頼された `UserPromptSubmit` イベントを発火しません。セッションで選ばれたワークフローが妥当な `Status: Running` の state を持つ間、matcher の無い PreToolUse ガードがそれらの picker 呼び出しを deny し、番号付き散文を描画してターンを終えるようモデルに指示します。完了または使えない state を含め、走っているワークフローが無ければ、native picker に触れません。人の次のチャットメッセージがそれを満たします。`[Answer]:` タグ付きの質問ファイルが信頼できる情報源のままです。
- **あなたがタイプしたものだけが、あなたの返信として数えられます。** エージェントが作業を subagent（reviewer、builder）に手渡すとき、VS Code と Copilot CLI は、エージェントの書いたブリーフを、あなたのチャットメッセージと同じやり方で hook に配信します。AI-DLC はそのブリーフを認識し、決してあなたのターンとして記録しません。承認を満たさず、あなたの回答や変更要求として読まれず、タイプされたスイッチも適用しません。あなたがタイプしたものは、subagent がまだ走っている間でも、従来どおり数えられます。例外は VS Code のみで、subagent があなたのチャットで始まってからブリーフが届くまでの最初の数秒です。そのときの、AI-DLC がブリーフに照合できないメッセージは、そのブリーフと見なされて数えられず、それがあなたのものだった場合は、再び返信するよう求められます。Copilot CLI は決してあなたのチャットにブリーフを送らないので、そこではあなたがタイプするすべてのメッセージが数えられます。ターンが作業未完了のまま終わるときの、AI-DLC 自身のエージェントへの注記（「The last AI-DLC step stopped on a problem: ...」など）も、あなたのターンではありません。Copilot CLI はそれをチャットメッセージとして返し、AI-DLC はそれを認識し、あなたのものとして記録しません。
- **`/aidlc` をあなたの要求とともにタイプすると、あなたの言葉が保たれます。** Copilot は、あなたがスラッシュ名で起動した skill を、あなたがタイプした行としてではなく、あなたの言葉を埋めた skill 自身のテキストとして AI-DLC に手渡します。AI-DLC は、テキストがあなたの言葉入りのインストール済み skill ファイルと正確に一致するとき、その行（`/aidlc` に、skill のテキストが運ぶ場所からそのまま取ったあなたの言葉を足したもの）を再構築するので、エージェントの最初のコマンドがそれを何も運ばないときでも、あなたの要求が記録に残り、作業に届きます。そのファイルと正確に一致しないものは、Copilot が配信したとおりに記録されます。
- **AI-DLC のエージェントはステージルールを得て、builder はあなたの plan 承認を待ちます。** エージェントが AI-DLC のエージェントの 1 つを VS Code の `runSubagent` ツールで始めても CLI の `task` ツールで始めても、AI-DLC は現在のステージのルールをそれに手渡し、Code Generation の間は、あなたが plan を承認するまで developer エージェントを始めません。エージェントは、両サーフェスで同じ「先に plan を承認せよ」の拒否を得ます。
- **AI-DLC は hook が走っていないとき言います。** 両サーフェスは、チャットに一言も無くリポジトリ hook をスキップするので（上の「フォルダの信頼」を参照）、AI-DLC がそれを見張ります。あなたの最初のメッセージに対して hook が 1 つも走っていないとき、または hook が一度も走っていないワークフローでステージが始まった後、次のステップは作業をしません。VS Code では、エージェントがフォルダの `.vscode/settings.json` で Chat: Use Hooks を自分で on にし（VS Code がその編集を許すよう求めます）、「Fixed. Send your next message here to carry on.」と言います。同じチャットでのあなたの次のメッセージが、hook とともに走ります。設定がすでに on だった場合、組織がそれを off にしたと言います。あなたが human-presence チェックを off にした場合、作業は続き、エージェントは代わりに一度あなたに伝えます。フォルダでの最初の Copilot チャットの前に、`/aidlc --doctor` は「AIDLC hooks have not run in this project yet」と警告します。ステージの後は、同じ手順で失敗します。走るがクラッシュする hook も、あなたのアクションを通し、そのエラー行を `.aidlc-engine/hooks-health/<hook>.drops` に残します。doctor がそれを読みます。
- **hook は native に強制します。** アダプタ（`.aidlc/hooks/aidlc-copilot-adapter.ts`。`.github/hooks/aidlc.json` が配線）は、core-guard のブロックを Copilot の `permissionDecision: deny` に変換します。reviewer read-scope の境界と state-transition ガードが、実際にツール呼び出しを拒否します。SessionStart と Stop の応答は、CLI のトップレベルフィールドと VS Code が要する `hookSpecificOutput` エンベロープの両方を運びます。CLI ではライブ検証済みです。VS Code agent モードでは、同じ deny/block チャネルが文書化され、アダプタが `runTerminalCommand`、`createFile`、`editFiles`、`readFile` のような文書化された名前を正規化しますが、IDE 側はまだライブ検証されていません。検証されるまで、IDE の強制は best-effort と扱ってください。アダプタは、名前を変えないホストが送るかもしれない、Copilot runtime 自身のツール名と形も読みます。シェルとしての `powershell` と `pwsh`、`paths` を伴う `grep`、patch がプレーンテキストまたは `toolArgs` で届く `apply_patch` です。
- **VS Code では、AI-DLC の routine なコマンドは Allow prompt 無しで走ります。** VS Code agent モードは通常、すべてのターミナルコマンドの前に「Run command? Allow / Skip」を尋ねるので、各ワークフローステップがクリックを待つことになります。アダプタは、AI-DLC がステージ中に走らせる routine なコマンドに `allow` と答えます。`next`、`continue`、`report`、`park`、読み取り専用の `next` の形、engine が名指しするフラグ付きの `doctor`（または `--doctor`）、`--version`、`--status`、`--help`、AI-DLC 自身のチェック（`engine sensor-traceability`、`sensor-required-sections`、`sensor-upstream-coverage`、`sensor-claim-sources`。これらはファイルを読みます。traceability チェックは、ステージがそのテーブルを始めるためにそれを走らせるとき、記録にステージ自身の coverage テーブルも書きます）、そして AI-DLC 自身のコマンドテーブルのプロジェクトコマンド（`engine log`、`engine state`、`engine runtime`、`engine learnings`、`engine testing-posture`、`engine intent list`、`engine intent add-checkout` とその他）を、直接・source-dispatcher・compiled・tool-script のいずれの綴りでも答えます。copy チャネルの `aidlc-utility.ts <verb>` は、その `engine workspace <verb>` の綴りと同じ答えを得ます。次のすべてが成り立つときにだけ答えます:
  - 呼び出しが VS Code のチャットセッションを運び、AI-DLC のすべてのガードが通り、ワークフローコマンドがこのセッションのワークフローに照合される。
  - それが、PowerShell、cmd、POSIX シェルがすべて同じように読む 1 つのプレーンなコマンドである。すなわち、chaining、pipe、末尾の 1 つの `2>&1` 以外の redirect、前置の環境変数代入、シェル展開が無く、それらのシェルのどれかが特別に扱う文字（`$`、バックティック、`%`、`^`、`!`、`#`、波括弧、`@`、`\`、または活字体の引用符など）が、引用符の中でさえ無い。引用された語は、空白、`?`、丸括弧、`;`、そして二重引用符の中のアポストロフィを保てます。二重引用符のテキストは、空白があるとき `|`、`&`、`<`、`>` も保てます。`--details "Q1: A - both ends included (closed range)"` や `--options "Keep the note|Skip it"` のようにです。引用符の外、単一引用符の中、または空白の無い二重引用符の中では、それらは prompt を保ちます。プレーン ASCII の外のテキスト（アクセント付きの文字など）も prompt を保ちます。Windows では、VS Code のターミナルが PowerShell か cmd のとき、バックスラッシュはプレーンなパス区切りなので、`C:\work\app`、`.aidlc\tools\...`、または `--project-dir 'C:\work\app'`（engine がプロジェクトフォルダを表示するとおり）のようなパスは、クリック無しで走ります。閉じる引用符の直前のバックスラッシュだけが prompt を保ちます。Git Bash や WSL のターミナルでは、バックスラッシュはなお prompt を保ちます。PowerShell のターミナルでは、プロジェクトフォルダ自身への `cd` または `Set-Location` を 1 つ、そのフルパスで、最初に置けます。`cd C:\work\app; aidlc engine orchestrate next` は、plan が承認を待つ間も、`aidlc engine orchestrate next` のように走ります。ほかのどのフォルダ（サブフォルダを含む）への `cd` も prompt を保ちます。インストールされた `aidlc` は、走るフォルダをプロジェクトと見なすからです。`cd` 無しでコマンドを走らせるか、プロジェクトフォルダ自身に `cd` してください。
  - パスとして読まれるすべての引数がプロジェクトの内側に留まる。
  - どのオプションも AI-DLC に自分で走らせるコマンドを手渡さない（`--check-cmd`）。
  - 素の `aidlc` がインストールされたランチャーである。プロジェクトが `aidlc` という名のファイル（`aidlc.cmd`、または `PATHEXT` が挙げる任意の拡張子）をルートか `PATH` 上のフォルダに持つとき、コマンドは prompt を保ちます。cmd は、`PATH` を探す前に作業フォルダのファイルを走らせるからです。

  それ以外のすべては AI-DLC から答えを得ないので、VS Code の prompt またはあなた自身の承認設定が当てはまります。エージェントがあなたのプロジェクト向けに書くコマンド（build、test、`git` など）、machine レベルのコマンド（`update`、`uninstall`、`use`、`config`、`system ...`）、ホストが走らせる hook・アダプタ・statusline のエントリ、そして次の AI-DLC コマンドで、走る前に各々を見られるよう prompt を保ちます:
  - あなたの作業を捨てるか merge するコマンド: `engine worktree discard`、`purge`、`merge`、`unit land`、`engine intent archive`、`engine swarm finalize`、`engine bolt abort`（`--discard` の有無にかかわらず。Bolt の abort はあなたの同意を要します）。
  - どのステージ・ゲート・review を見るかを変えるコマンド: 最後の質問以降あなたが返信していないときの `engine recompose`（あなたが plan の変更を承認した後、それを適用する recompose はクリック無しで走ります）、`next --skip`、`next --add`、`engine jump execute`、`engine scope change`、`engine intent create --skip`、`engine intent remove-checkout`（review が覆うものからコードを取り出します）、`engine config set` と `next config set`、`engine bolt set-autonomy`、state-transition チェックがその作業について off（あなたまたはあなたの Guard Policy により）の間の `engine state` の status 変更（そのとき変更が着地するため）、そしてゲートの setter（`set-unit-gate-rhythm`、`set-construction-checkpoints`、`set-skeleton-stance`、`set-status`）。そのチェックが on の間、AI-DLC は `engine state` の status 変更自体を拒否するので、クリックするものはありません。`set-construction-checkpoints`、そしてあなたのチェックの 1 つ（plan approval、summary 確認、fence、Guard Policy）への `engine config set` は、最後の判断以降その変更をチャットで求めたときクリック無しで走り、チェックを on に戻すことは常にそうです。
  - 進行中の作業を切り替えるコマンド: `engine intent switch`（または `engine intent <name>`）と `engine space switch`（または `engine space <name>`）。
  - team の `unit` コマンド。あなたのリモートを通じて claim と承認を共有します（`unit merge-status` を除くすべて）。
  - AI-DLC が出荷しないコードを走らせる、またはインストール済みの skill を書き換えるコマンド: `engine sensor fire`（チェックが名指しするものを走らせます）、`engine sensor-linter` と `sensor-type-check`（あなたのプロジェクトの linter と type checker を走らせます）、`engine knowledge onboard`、`sync`、`engine workspace document-input --onboard`（あなたの harness が名指しする document extractor を走らせます）、`engine plugin sync`、`select`、`build`、`plugin build`、そして `engine gen runners` と `runner-scopes`。

  engine がエージェントに自身の applicability チェックでスキップさせる conditional なステージはクリック無しのままで、`doctor` も同様です。`doctor` は、あなたが自分で走らせるときと同じく、リリースフィードから update チェックを refresh することがあります。クリックのスキップは、あなたの代わりに判断を記録しません。engine がステージ承認を記録する前に、あなたは、ステージが始まって以降かつ最後の判断以降に、チャットメッセージを送っていなければなりません。prompt hook がそれを記録します。ゲートが示された後のもの、またはエージェントがそれへのあなたの回答と名指しするものです。そのチェックは、あなたがターンを取ったことを確認するもので、あなたが何を意図したかではないので、エージェントが返す報告を読んでください。これは VS Code 自身の auto-approve を使わないので、組織ポリシーがそれを off にする場所でも動きます。AI-DLC のほかと同様に、チャット hook が有効である必要はあります。Copilot CLI では、アダプタは permission decision を与えません。同じコマンドがそこで prompt 無しでどう走るかは、2 つ下の点です。
- **Copilot CLI では、AI-DLC によるあなたの作業の記録が prompt 無しで書かれます。** `/aidlc` skill が使われている間、Copilot は `aidlc/spaces/<space>/intents/` 配下のファイルを「Do you want to create ...?」と尋ねずに作成・編集します。skill がそのパスを許すからです（`.github/skills/aidlc/SKILL.md` の `allowed-tools`）。Copilot はパスをその末尾で照合するので、パスが `aidlc/spaces/<name>/intents/` で終わるあなたのフォルダも数えられます。あなた自身の `--deny-tool` はなお勝ち、Copilot は、space の `memory/` ファイルを含むほかのどのファイルへの書き込みも従来どおり尋ねます。
- **Linux と macOS の Copilot CLI では、AI-DLC の routine なコマンドが prompt 無しで走ります。** VS Code が Allow クリック無しで走らせるコマンド（上のリスト、同じ条件下）は、`.aidlc/bin/aidlc-engine <command>` として送られます。これは AI-DLC がプロジェクトにインストールするランチャーで、`/aidlc` skill がそれを許します（その `allowed-tools` の `shell(.aidlc/bin/aidlc-engine)`）。ランチャーは、AI-DLC の hook が渡すコマンドだけを走らせます。それ以外の、エージェントがタイプしたものや hook off で走らせたものは、代わりに走らせるプレーンなコマンドとともに止まり、Copilot がそれについて尋ねます。VS Code で prompt を保つコマンドはここでも保ち、エージェント自身のコマンドも同様です。Windows のターミナルでは、AI-DLC のコマンドは従来どおり尋ねられます。
  - Copilot は shell ルールをコマンドの最初の語に対して確認し、これらのコマンドは今やランチャーで始まるので、あなた自身の `--deny-tool=shell(bun)` や `shell(aidlc)` はもうそれらを止めません。止めるには、ランチャーも deny します: `--deny-tool='shell(.aidlc/bin/aidlc-engine)'`。
  - 組織が Copilot の permission を管理する場所では、ランチャーはダイアログを省きません。その [enterprise managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings) がいずれかの permission ルールを持つと、Copilot は、それらが許さないすべてのコマンドの前に尋ね、AI-DLC のものも含みます。`Shell(bun *)` や `Shell(aidlc *)` だけの managed deny は、AI-DLC のコマンドをブロックしません。Copilot は代わりにそれらについて尋ねます。それらをブロックするには、管理者が `permissions.deny` で、bun や aidlc に加えて `Shell(.aidlc/bin/aidlc-engine)` と `Shell(.aidlc/bin/aidlc-engine *)` を deny します。
  - 正確に `shell(bun)` または `shell(aidlc)` を許す `copilot -p` スクリプトは、`--allow-tool='shell(.aidlc/bin/aidlc-engine)'` を加えます。それが無いと Copilot はランチャーを拒否します。`-p` には尋ねる相手がおらず、skill のルールはそこで当てはまりません。
- **コマンド追跡は正確で best-effort です。** AI-DLC は、単純な直接の orchestrator、source-dispatcher、本物の compiled な `next`、`continue`、`report`、`park` コマンドを追跡します。末尾の 1 つの `2>&1` はサポートされます。inspection コマンドは `aidlc` の部分文字列から分類されません。曖昧な wrapper や、引数に active なシェル展開（`$VAR`、glob、brace 展開、先頭の `~`）を含むコマンドは、変更されず追跡されずに走ります。hook が、シェルが最終的に生む argv をハッシュできないからです。直接に見える複合コマンドは拒否されます。現在の物理プロジェクトの外の明示的な `--project-dir` は、現在のプロジェクトの coordination が書かれる前に拒否されます。
- **AI-DLC が照合できない `continue` も、なお先へ進みます。** hook が、AI-DLC コマンドの記録を見つけられないか信頼できないとき（例えば記録が削除された後、または hook とターミナルがプロジェクトパスを異なって綴るとき）、それは拒否する代わりにコマンドを走らせ、engine がディスクから答えます。自身の記録が一致すれば次の部分、一致しなければ現在のステップです。もう「could not match this Copilot command」の後に part 1 が再び、ということはありません。audit は、そのような pass ごとに 1 つの `COORDINATION_STOOD_ASIDE` の行を保ちます。VS Code では、このやり方で通る routine なコマンドも、なお Allow クリック無しで走ります。
- **engine が、どの harness でも continuation の replay を担います。** Copilot は、Claude、Codex、Cursor、Kiro、Kiro IDE、opencode と同じ、記録ローカルでアトミックな single-use カーソルを使います。native の token 検証が最初に走り、それから engine が完全な token の SHA-256 を比べ、active-directive ロックのもとで stdout の前に正確な successor を publish します。Copilot のセッション所有権と配信の証跡は、そのマーカーを豊かにしますが、replay を担いません。欠けた、不正な、v1、pre-shared のマーカーは、同じトランザクションの中で一度回復します。新しい `next` がカーソルをリセットします。crash、migration、rollback、ファイルシステムの限界は、Developer Reference の共有カーソル契約を参照してください。
- **Stop は現在配信された Copilot directive を保ちます。** 正確なホスト `tool_use_id`、または書き換えられた engine 入力を通じて運ばれ PostToolUse が返すアダプタ ID が、session-scope の Stop と Resume の振る舞いの配信を確定できます。正確な相関が得られないとき、実行は追跡されずに許され、Post は推測しません。新しい単純な `next` が追跡された配信を復元します。相関の喪失は、恒久的な deny を作りません。claim が試みられると、プロジェクト・state・セッションの所有権の拒否は明示的な deny です。別のセッションは、所有者の現在の token を追跡されない作業として実行できません。ワークフローを先へ進める `report`（承認、スキップ、終わったステップ）は、停止点ではありません。エージェントはすぐに `next` を走らせます（または、人が同じ返信でワークフローをそこで今は止めるよう求めたとき park します）。それでも止まる場合、Stop は新しい `next` を、止めるよう求めた人には `park` を名指しするので、次のステージが同じターンで始まります。ワークフロー完了の report と、孤立した single-stage の実行だけが、そこでターンを終えます。
- **従来の Resume と会話の待機は session-scope です。** Stop は、本物の会話的応答がきれいに終わるのを許します。2.6.19 より前のインストールが書いた Resume マーカーは、owner-scope のままです。明示的な `next --resume` がそれに優先し、直接続きます。prompt のテキストとルールの内容は、coordination マーカーに永続化されません。
- **ホストの証跡は意図的に有界です。** 書き換えと運ばれる ID のエコーは、macOS の Copilot CLI 1.0.79 で、noninteractive モードでライブ検証されました。VS Code の `tool_use_id`、`updatedInput`、`tool_response` の経路は、その文書化された Preview 契約から覆われますが、ここではライブ検証されていません。Copilot cloud agent は、このリリースのサポートされた AI-DLC サーフェスの外です。
- **ほとんどのステージは、追加の 1 ステップでルールを読み込みます。** VS Code のターミナルツールは、コマンド結果を 20,000 文字までしか丸ごと保ちません。それより長いものはファイルに保存され、チャットはその始めと終わりだけを見ます。AI-DLC は、Copilot で表示するすべての instruction を 19,000 バイト未満に保つので、ルールが傍らに収まらないステージは、それらを先に送り、モデルがそれらとともに表示された `continue` コマンドを、ステージが始まる前に走らせます。Construction では、それが各 Unit の各ステージで起きます。native インストールでは、これは `aidlc update` を走らせるとすぐ、すでに進行中のワークフローに届きます。`aidlc config` の refresh は要りません。`.aidlc-version` で以前のリリースに pin されたプロジェクトは、そのリリースを走らせ続けるので、pin されたプロジェクトは、このリリース以降で `aidlc config --pin` を走らせるとこれを得ます。
- **追加のステップをクリック無しで走らせます。** VS Code が各ターミナルコマンドを許すよう求める場合、その Allow オプションから **Configure Auto Approve...** を選び、`chat.tools.terminal.autoApprove` 設定に `"aidlc engine orchestrate": true` を加えます。VS Code はその後、AI-DLC のワークフローステップを尋ねずに走らせ、ほかのコマンドは通常の確認を保ちます。ワンクリックの **Allow `aidlc ...` in this Session** または **Allow `aidlc ...` in this Workspace** も動きますが、それは `aidlc config`、`aidlc update`、`aidlc uninstall` を含む、すべての `aidlc` コマンドのクリックを省きます。コピーされた Bun runtime では、ステップは `bun .aidlc/tools/` で始まるので、そこでのワンクリックオプションはすべての `bun` コマンドを許すことになります。AI-DLC 自身は auto-approve 設定をインストールしません。
- **hook 配線は設計上 matcher-free です**: VS Code は hook matcher をパースしますが無視するので、各アダプタの対象は代わりに `tool_name` で自己フィルタします。matcher は IDE で静かに広がってしまうでしょう。
- **Reviewer の identity は配信ではなく相関されます**: PreToolUse のペイロードは呼び出しごとの agent フィールドを運びません。アダプタは、SubagentStart/SubagentStop（VS Code の `agent_type`/`agent_id` フィールドを含む）を通じて委譲を括り、subagent がちょうど 1 つ active なとき identity を転送します。曖昧な重複は、その呼び出しについて fail open します（reviewer モジュールの散文の境界がなお支配します）。
- **ペルソナは `model:` pin を運びません。** 2 つのサーフェスは model 値の構文で食い違います（CLI は frontmatter の文字列をそのまま BYOK provider に転送します。IDE の表示名はそこで 400 を返します）。エージェントはセッションの model を継承します。この harness での tier projection は、type ごとに model を省きます。
- **worker ペルソナは、明示的な組み込みの `tools:` 許可リストを使います。** それは、nested な委譲を無くすため、Copilot の `agent` 委譲ツールを省きます。Copilot には all-except-agent の形が無いので、委譲された worker は任意の MCP ツールを継承しません。
- **AIDLC の plugin は Copilot-native なサーフェスを使います。** compose された plugin ペルソナと生成された stage/scope runner は、`.github/{agents,skills}` に着地します。plugin の選択はそれらのパスを再生成し、`.aidlc/skills` や `.opencode/agents` を決して作りません。
- **Session-end**: VS Code は SessionEnd を文書化しないので、共有の hook マニフェストは両ホストでそれを省きます。アダプタは、次の SessionStart で、推論された provenance（codex パターン）とともに、前のセッションを調停します。
- **method include は AGENTS.md の `@` インポートに乗ります**（CLI でライブ検証済み。VS Code は `@` インポート展開を文書化しますが、そこでライブ検証されていません）。`@` 行と `.github/agents/` のペルソナの twin は、`aidlc/active-memory/`、すなわち engine の git-ignore された active な space のメソッドのコピーを読みます。`/aidlc space <name>` は、ブロックではなくそのコピーを書き換えます。
- **statusline なし**。`/aidlc --status` とゲートの進捗行を使ってください。
- **Construction swarm は subagent fan-out のみ**です（`AIDLC_USE_SWARM=1` は loud な no-op です）。
- **MCP**: 何も出荷しません。サーバーを加える場合、ここでサーフェスが食い違う点に注意してください。CLI は `~/.copilot/mcp-config.json` を、VS Code は `.vscode/mcp.json` を読みます。conductor はそれらを使えますが、委譲された worker ペルソナは使えません。

## VS Code request cap

VS Code agent モードは、1 ターンで `chat.agent.maxRequests` 回のリクエスト（既定 50）の後に止まり、「Continue to iterate?」と尋ねます。チャットはその後、誰かが答えるまで静かに待つので、容易に 50 を超えるツール呼び出しをする無人の Construction ステージは、途中で止まったまま座ります。そのため `aidlc config --harness copilot`（初回インストールとすべての refresh）は、プロジェクトの `.vscode/settings.json` に `"chat.agent.maxRequests": 200` を加えます:

- プロジェクトがそのキーを設定していないときだけです。あなたのチームがすでに設定した値は、`--force` でも決して変えられません。
- ほかのキー、コメント、レイアウトに触れずに（ファイルは JSONC です）、何も無いときはファイルを作成します。
- AI-DLC が加えた値だけが、AI-DLC のものとして記録されます。後のリリースがその設定の出荷を止めた場合、config は、AI-DLC が書いた値をまだ保つ間だけそれを取り除き、AI-DLC が作成した場合だけファイルを取り除きます。`aidlc uninstall` はプロジェクトファイルを決して編集しないので、あなたの設定は残ります。
- AI-DLC がキーを加えた後、あなたが保つ設定ファイルからそれを取り出すのはあなたの選択で、config はそれを戻しません。設定ファイルがまったく無い checkout は、それを再び得ます。

その設定は window-scope なので、プロジェクトの値がユーザー設定に勝ちます。AI-DLC の `.gitignore` ブロックは `.vscode/*` を git から外すので、その値は各 checkout のものです。config は、それが走る場所で加えます。コピーされたプロジェクト（copy チャネル）には、このファイルを merge する config ステップが無く、その runtime は 1 つを出荷しないので、キーは自分で加えてください。`/aidlc --doctor` は、プロジェクトの値が 100 未満、未設定（あなたのユーザー設定、無ければ VS Code の既定の 50 が当てはまります）、数でない（引用符付きの数を含む）、または読めないとき警告し、書くべき行を名指しします。AI-DLC が加えた後にあなたのチームが保つ設定ファイルから取り出したキーについては警告しません。

multi-root の window は、この window-scope の設定を、フォルダの `.vscode/settings.json` ではなく、その `.code-workspace` ファイルから読みます。そのため Copilot プロジェクトでは、`aidlc system workspace-sync` は、それが生成する `aidlc.code-workspace` に `"settings": { "chat.agent.maxRequests": 200 }` も一度だけ書きます。まだ settings の無いファイルにだけです。ファイルの settings にすでにあるキーと値は、取り除かれたキーを含め、あなたのチームのもので残ります。workspace-sync はファイルを書き換えるので、その中のコメントは保たれません。そのファイルが存在するとき、doctor はそれも確認します。workspace を開くときはいつでも、それが担当のファイルだからです。

## 検証

```bash
cd your-project
copilot -p "/aidlc --doctor" -s --allow-all-tools   # or run /aidlc --doctor in VS Code chat
```

doctor は、engine ツリーとすべてのアダプタ依存、ルートの `AGENTS.md`、`.github` の配線ファイル、Copilot CLI のバージョン下限、フォルダの信頼を確認します。Copilot CLI は任意です。VS Code のみのインストールは `Harness CLI: optional copilot is not installed` と報告し、合格します。VS Code は、CLI が無いとき「Install GitHub Copilot CLI? (y/N)」と尋ねる、自分の代役の `copilot` をターミナルの PATH に置くので、doctor と初回 setup はそれを決して走らせません。そのフォルダの先に本物の CLI を探し、無ければ未インストールと報告します。下限未満のインストール済み CLI は警告で、決して失敗ではありません。この harness の決定的な engine テストは、`tests/unit/t248-copilot-packaging.test.ts`、`t249-copilot-adapter.test.ts`、`t250-copilot-adapter-security.test.ts`、`t-copilot-directive-budget.test.ts` です。ライブの journey は `tests/e2e/t-exec-copilot-status.serial.test.ts` と `tests/e2e/t-exec-copilot-release-journey.serial.test.ts` で、`AIDLC_COPILOT_EXEC_LIVE=1` で gate されます。Full Suite は両方を Linux、macOS、Windows で走らせます。

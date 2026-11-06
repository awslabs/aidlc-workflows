# ファシリテーターガイド

このページは、AI-DLC ワークショップを運営する人、またはチームが最初のワークフローを進めるのを支援する人のためのものです。当日の前に何を確認するか、実行を小さく保つ方法、チームが詰まったときにどうするかを扱います。参加者は代わりに [Onboarding](onboarding.md) を読んでください。

---

## ワークショップ前: 準備完了の合格ライン

チームに AI-DLC をインストールして問題を報告してもらうだけでは足りません。hook が一度も走らないマシンは何も報告しませんし、ほとんどの harness では、新規インストール直後の `aidlc doctor` は、どの hook も走る機会を得る前に合格してしまいます。マシンが準備完了なのは、実際のワークフローステージを 1 つ走らせ、doctor が hook の発火を示したときだけです。

次の手順を各参加者のマシンで、チームが作業するフォルダで実行してください。フォルダの信頼と hook 設定はフォルダごとなので、使い捨てフォルダでは証明できることが少なくなります。

1. **プロジェクトをセットアップします。** プロジェクトフォルダのターミナルで `aidlc config --harness <name>`（例: `copilot`）を実行します。`Setup check - N of M sections need you.` の表を表示し、フラグした内容を順に案内すると提案します。
   - 合格: `Runtime` 行が `[ok]` と `hook PATH ready` を示し、`Trust` 行が `[ok]` を示します。`on this shell's PATH only` を示す `Runtime` 行も、そのターミナルからツールを起動すれば合格です。Copilot では、Copilot CLI がフォルダを信頼していないとき `Trust` 行が `[needs]` を示します。VS Code 自身のスイッチは見えないため、それは手で確認してください。[GitHub Copilot on Windows](#github-copilot-on-windows) を参照してください。
   - `Models` または `Providers` が `[needs]` を示しても、hook は止まりません。何を答えるかは [Troubleshooting](15-troubleshooting.md#native-install-channel) の `Models` 行と `Providers` 行を参照してください。
   - GitHub Copilot、Cursor、Kiro IDE では、`Models` 行が `[ok]` を示し、ホストを名指しします（例: `every agent uses your GitHub Copilot session's model and effort`）。そこでどのモデルと effort を選ぶかは、当日の前にチームと合意してください。Opus の無いチームは medium effort から始めるべきです。[Choosing a Model and Effort](18-install-and-lifecycle.md#choosing-a-model-and-effort) を参照してください。
2. **インストールを確認します。** `aidlc doctor` を実行します。
   - 合格: 要約行が `0 problems` を示します。
   - すべての警告を読んでください。`Runtime hook PATH` の警告は、ホストが `aidlc` を見つけずに hook を起動する可能性を意味します。まずこれを直してください。GitHub Copilot と Kiro IDE では、フォルダでの最初のチャットの前に `AIDLC hooks have not run in this project yet` が出るのは想定どおりです。手順 4 で、hook が走るかどうかが分かります。
3. **ステージを 1 つ実行します。** 同じフォルダで harness を開き、使い捨てのワークフローを始めます。例:

   ```text
   /aidlc express Add a --version flag to the CLI
   ```

   （Codex CLI では `$aidlc`。）初期化ステージは自動で走ります。最初の実ステージが何かを尋ねてきたら（質問または承認）、harness が示すとおりに答えてください。picker が出る場合は選択肢を選び（Claude Code、Codex CLI）、選択肢が番号付けされたチャットでは番号かあなたの回答をタイプします（GitHub Copilot とその他）。GitHub Copilot で、AI-DLC の hook がこのプロジェクトで走っていないとエージェントが言う場合は、ワークショップの前に、名指しされたスイッチを直してください。
4. **hook の発火を確認します。** ターミナルに戻り、`aidlc doctor --verbose` を実行します。
   - 合格: `Hooks last fired:` の行が、hook 名と現在時刻を列挙します（例: `plan-approval-guard` と `continue-workflow`）。
   - 不合格: `Hooks have never executed although this workflow has progressed`、または hook が一度も発火していないという `Hook heartbeat data` 行は、ホストがこのマシンで AI-DLC の hook を走らせていないことを意味します。ワークショップの前に直してください。
   - 未準備: `Hook failures, the latest within the last day` の警告は、hook がそのとき報告できなかった失敗に遭ったことを意味します。行が理由を名指しします。
   - 未準備: `Your replies are not being recorded: ...` の警告は、あなたの回答が AI-DLC に届いておらず、後で承認が拒否されることを意味します。その fix 行が、このツールでの手順を名指しします。
5. **テストを片付けます。** チャットで `/aidlc intent archive <name>` を、テスト作業の名前を付けて実行します（`/aidlc intent` が名前を列挙します）。何も削除されません。次の `/aidlc` は、どの作業を続けるかを尋ねるか、残りが無ければ新しい作業を説明するよう求めます。hook が部分的にしか動かないマシンでは、チャットがこれを拒否する場合があります。そのときは、代わりに自分のターミナルで `aidlc engine intent archive <name>` を実行します。

各チームに、ワークショップの 1 週間前に、参加者のマシンでの手順 1、2、4 の出力を求めてください。チームにとっては数分の手間で、hook・PATH・フォルダの信頼が配線されているかどうかが分かります。

`workshop` scope（`/aidlc workshop`）は、ファシリテーション付きのグループセッションそのもののためのものです。これは 23 ステージの実行であり、準備完了チェックではありません。

---

## ワークショップ前: ビジョンノートと技術環境ノートを持参する

各チームに、最初のセッションに短いノートを 2 つ持ってきてもらってください。これにより、最初の 1 時間が、質問に答える時間から回答を確認する時間に変わります。

- **ビジョンノート**: 何を誰のために作るか、最初のリリースの機能、そこに入らないもの、すでに未決と分かっている問いを、1 段落で。当日は最初の要求に入ります: `/aidlc workshop Read ./vision.md and build what it describes`（Codex CLI では `$aidlc workshop ...`）。[Writing a Vision Document](writing-inputs/vision-document-guide.md) を参照してください。
- **技術環境ノート**: 言語とバージョン、framework、test ツール、cloud とデプロイモデル（または「local only」）、禁止ライブラリとその理由・代替、セキュリティの基本、そして典型的な endpoint・関数・テストの短い例を 1 つ。最初の実行の前に、これを `aidlc/spaces/default/knowledge/aidlc-shared/technical-environment.md` に保存してください。すべてのステージがそこを読みます。[Writing a Technical Environment Document](writing-inputs/technical-environment-guide.md) を参照してください。

各ガイドは短い版から始まります。ワークショップにはそれで十分です。既存コードベースで作業するチームは、この作業が変えてはならないものをビジョンノートに加えます。

---

## 付随タスクを小さく保つ: scope を名指しする

素の `/aidlc <description>` は、エージェントがその言葉から plan を提案するか、1 つを compose すると提案します。既定の `classic` は、セットアップ後に 30 ステージ中 15 を走らせます。平易な言葉のバグ報告は、通常 `bugfix` が提案されます。エージェントが代わりに compose を提案するとき、提案の横のリストは `bugfix` を先頭に名指しし、既定を選ぶとはるかに大きなワークフローが走ります。scope を最初の語として名指ししてください:

| 付随タスクが… | タイプ | ステージ |
|---|---|---|
| 修正の分かっている既知のバグ | `/aidlc bugfix <what is broken>` | 6 / 30 |
| 小さな変更、または素早い end-to-end の試し | `/aidlc express <the change>` | 7 / 30 |

`feature` は全ステージ（30 / 30）を走らせます。付随タスクではなく、production の feature に向いています。すべての scope は [Workflow Profiles](workflow-profiles.md) を参照してください。

付随タスクは、それ専用のプロジェクトフォルダで始めてください。チームの主ワークフローと混ざらないようにします。

キックオフで参加者にこう伝えてください。計画されたユースケース外の付随タスクは、既定ではなく `bugfix` か `express` を使う、と。

---

## 質問を減らす: depth

depth は、各ステージがいくつ質問するか、その文書がどれだけ長くなるかを決めます。`Standard` depth では、ステージはおよそ 5〜8 の質問を目指します。`Minimal` ではおよそ 2〜4 を目指します。これらは目標であり上限ではありません。曖昧な回答や矛盾は、なお追加の質問を招きます。

- ワークフローの途中では、`/aidlc --depth minimal` とタイプします。実行中のワークフローの depth を変えます。
- 開始時には、scope の後に付けます。例: `/aidlc classic --depth minimal <the work>`。

`bugfix`、`express`、`poc`、`refactor`、`security-patch` は、すでに `Minimal` が既定です。`classic`、`feature`、`workshop` は `Standard` が既定です。[Scopes and Depth](05-scopes-and-depth.md#the-3-depth-levels) を参照してください。

---

## 停止を減らす: learnings と summary 確認

`workshop` は、各ステージで 2 つのチェックを保ちます。`Looks correct` の summary 確認と、グループがエージェントを修正した後の「Keep that for next time?」という learnings の質問です。部屋の中では、これはグループが必要とする以上の停止になることがよくあります。作業を始めるときに両方を off にします:

```
/aidlc workshop --learnings off --summary-confirmation off <the work>
```

質問と approval gate は引き続き走ります。learnings off は、実行から何もプロジェクトや team の memory に保存されないことを意味します。summary 確認 off は、誤読された回答が、artifact が書かれた後の approval gate で捕まることを意味します。learning loop を教えることがセッションの一部なら、learnings は on のままにしてください。[Fewer stops](05-scopes-and-depth.md#fewer-stops-for-a-workshop-or-small-work) を参照してください。

---

## Construction: 一度に 1 つの Unit

Inception が作業を複数の Unit に分けると、Construction はそれらを 2 とおりに走らせられます:

- `unit-major`: 1 つの Unit が、次の Unit が始まる前に、その design ステージと Code Generation を通ります。チームは動くコードをより早く見られます。
- `stage-major`: どの Unit も、いずれかの Unit が次に進む前に 1 つのステージを通ります。そのため、6 つの Unit を持つチームは、各ステージで 6 組の質問に答えます。scope が walking skeleton を作る場合、その最初の Unit はなお、残りより先にコードまで通します。

scope が作業を Unit に分けてコードを書く新しい solo ワークフローは、作成時に `Construction Iteration: unit-major` を記録します。Construction が始まる前に、作業の `aidlc-state.md`（`aidlc/spaces/<space>/intents/` 配下）を開き、その行を確認してください。`stage-major` とあるか、行が欠けている場合（これも stage-major を意味します）は、Inception の間に切り替えます。エージェントに頼むか、プロジェクトフォルダでこれを実行します:

```bash
aidlc engine state set-construction-iteration unit-major
```

これが `Select Construction Execution: serial` で拒否される場合、作業は Unit を並行で作るよう設定されています。先に `aidlc engine state set-construction-execution serial` を実行してから切り替えます。

Construction がすでに始まっていたら、チャットで言ってください（「ここからは一度に 1 つの unit を作って」）。エージェントは即座に切り替え、取り消し方を示します。すでに終わった Unit は作業を保ちます。[Construction order and execution](12-cli-commands.md#construction-order-and-execution) を参照してください。

---

## リカバリー手引き

同じ拒否がリトライ後も戻ってくる、エージェントがコマンドを繰り返して同じエラーになる、エージェントが走らせるすべての `aidlc` コマンドが拒否される。こうしたとき、チームは詰まっています。待ってもそのようなループは解けませんし、エージェントは考えて抜け出せません。

### 1. ループを止める

エージェントを止めます（チャットの stop ボタン、またはターミナル harness では Esc）。リトライごとに時間とクレジットがかかります。

### 2. 自分のターミナルから診断レポートを取る

自分で直接ターミナルを開き、プロジェクトフォルダに移動して、次を実行します:

```bash
aidlc doctor --export
```

AI-DLC のチェックは、エージェントがすることに対して働きます。あなたが自分のターミナルでタイプするコマンドはエージェントの行為ではないので、エージェントが試すすべてのコマンドが拒否される状態でも、これは動きます。doctor は編集済みのレポートを `aidlc/diagnostics/` 配下に書き、そのパスを表示します。ソースコードも文書本文も含みません。問題を報告するときに添付してください。[Sharing a Diagnostic Report](15-troubleshooting.md#sharing-a-diagnostic-report) を参照してください。

### 3. fix 行を読む

`aidlc doctor` は、すべての問題と警告の下に `fix:` 行を表示します。何よりも先にそれに従ってください。

### 4. 症状を照合する

| チームが見ているもの | すること |
|---|---|
| ワークフローが待ったまま進まない | 質問か approval gate を示しているなら、それはあなたを待っています。示されたもの、列挙された選択肢の 1 つ、またはゲートでの **Approve** / **Request Changes** に答えてください。どちらも示さず、バックグラウンドで作業がまだ走っているとエージェントが言うなら、それが終わるのを待ちます。`/aidlc --status` が、どこにいるかを示します。ステージを離れるには、`/aidlc --stage <slug>` でジャンプします。 |
| 回答や承認が記録されない、または hook が一度も実行されていないと doctor が言う | ホストが AI-DLC の hook を走らせていません。doctor が名指しするもの（PATH、フォルダの信頼、hook の承認、選ばれたエージェント）を直し、harness を再起動し、準備完了の合格ラインをもう一度実行してください。 |
| Code Generation 中にエージェントの `aidlc` コマンドが拒否され、それが `cd <path>;` で始まる | 各 `aidlc` コマンドを、前に何も付けずに単独で実行するよう、エージェントに頼んでください。チェックは、コマンドの前の `cd` が既存のフォルダをフルパスで名指しするときそれを読み、そのフォルダで走ったと判定します（Windows では、Git Bash の `cd /c/path` がフルパスとして数えられます）。読めない `cd`（相対パス、変数、`cd C:\path` のようなクォートされていない Windows パスなど。後者は `;` で連結された PowerShell 行でのみ読まれます）は拒否します。`aidlc --status`、`aidlc doctor`、`aidlc engine orchestrate next` を単独で使うのは許されます。古いビルドは、現在のフォルダを離れるすべての `cd` を拒否し、一部はこの状態で素の `aidlc --status` と `aidlc doctor` も拒否します。次の行へ進んでください。 |
| plan が承認された後でも、Code Generation 作業が `Plan Approval authority is ambiguous or stale`（Guard Policy `off` のもとでは `cannot select one approval target`）で拒否される | まず、拒否が名指しするコマンドを、書かれたとおりに単独で、エージェントに走らせてください。拒否は、このインストールが走らせる形で綴ります。native インストールでは `aidlc engine orchestrate next`、copy したものでは `bun <harness-dir>/tools/aidlc-orchestrate.ts next` です。拒否が plan はすでに承認済みだと言うなら、誰ももう一度承認する必要はありません。同じ拒否が戻ってくるなら、下の最後の手段を使ってください。`/aidlc --plan-approval off` と Guard Policy `off` は、3 つの例外を除き、この拒否を解きません。Guard Policy `off` のもとでは、チャットの compaction が退けたビルドステップは、その plan が承認済みなら自分で進むので、そこでこの拒否は現れません。Guard Policy `relaxed` または `off` のもとで開いた Code Generation ゲートでも現れず、そこでは承認済みの plan から作業が進みます。Unit が並行で作られている間は、下げられた fence が stand-aside の行とともに書き込みを通し、fence が on のときは Unit のコードは `.aidlc/worktrees/` 配下の準備済み worktree に属し、そこでは通ります。 |
| 会話が長い、または混乱している | 新しいチャットを開き、`/aidlc --resume` とタイプします。ワークフローは、古い会話からではなく、ディスク上のファイルから続きます。 |

### 最後の手段: Plan Approval チェックを off にする

`AIDLC_DISABLE_PLAN_APPROVAL_GUARD` は、Code Generation 中に作業を拒否するチェックを off にします。人がセッションを見ている間だけ、そして間違った拒否を越えるためだけに使ってください。

一番速い方法は再起動を要しません。チャットで言ってください（「このプロジェクトでは plan approval チェックを off にして」）。エージェントが下のコマンドを走らせ、あなたがちょうど頼んだのでチェックが通します。または、プロジェクトフォルダのターミナルで自分で実行します:

```bash
aidlc config flags --bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD --local --yes
```

これはワークフローの実行中に効き、チェックはエージェントの次の行動から off になります。対象は、このマシンのこのプロジェクトのすべてのワークフローです。その後 AI-DLC は、チェックが何のためか、off であること、いつからかをチャットで伝え、戻すと提案し、off のままの間は各チャットの冒頭で繰り返します（opencode を除く。session-start コンテキストを示しません）。チームが問題を越えたらすぐ、その提案にあなたの言葉で答えるか、同じコマンドを `--bypass` の代わりに `--clear-bypass` で実行します。

または、harness が起動する環境に `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` を設定します。対象は、それで起動した harness のすべてのワークフローです。hook はその環境から読むので、harness を起動する前に設定してください:

- まず harness のすべてのウィンドウを閉じます。
- VS Code を使う Windows PowerShell では:

  ```powershell
  $env:AIDLC_DISABLE_PLAN_APPROVAL_GUARD = "1"
  code C:\path\to\project
  ```

- macOS または Linux では: `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 code /path/to/project`（`code` の代わりに harness 自身のコマンドでも可）。

チームが問題を越えたらすぐ、その変数を付けずに harness を再起動してください。

どちらのやり方でもチェックが off の間、ワークフローの audit trail は、それが off だったこと（`GUARD_DISABLED`）を記録します。

### いつ方針転換するか

AI-DLC のデバッグは、チームが来た目的ではありません。この手引きをひととおり試した後、チームが同じ失敗に二度当たったら、止めてください。診断レポートを保ち、チームをフォールバック計画に移します。例えば、各マシンで準備完了の合格ラインを通った harness です。切り替えが数分で済むよう、フォールバックはワークショップの前に合意しておいてください。

---

## 各 harness がワークフローをどれだけ強く強制するか

AI-DLC はどこでも同じ engine を走らせますが、各ホストが hook に与える力は異なります。弱い行は、ワークフローがエージェントの指示遵守に多く頼ることを意味し、失敗を見逃しやすくなります。

| Harness | 質問の現れ方 | AI-DLC はエージェントの行動を拒否できるか | ターンの終わりに | hook が走るのは次のときだけ | 知っておくべき差分 |
|---|---|---|---|---|---|
| Claude Code | native picker。picker の回答はあなたのターンとして数えられる | はい、すべてのチェック | ステップが報告されるまでワークフローを進め続ける | セットアップ後にフォルダで Claude Code が起動され、`"disableAllHooks": true` 設定も組織ポリシーも止めていない（doctor が確認） | 特になし |
| Codex CLI | picker。フォールバックとして番号付きの散文。picker の回答は数えられる | はい、すべてのチェック | ワークフローを進め続ける | プロジェクトの hook が信頼されている（対話的な信頼パス 1 回、または出荷された信頼 seed） | AI-DLC のステータス行はプロジェクトの選択で、その中の全員に効く（`$aidlc --statusline on`） |
| GitHub Copilot（CLI と VS Code） | 番号付きの散文。あなたの回答をタイプ。picker はワークフロー実行中は拒否される。回答が数えられないため | はい、Copilot の deny チャネルを通じて。CLI ではライブ検証済み。VS Code では文書化済みだが、まだライブ検証されていない | ワークフローを進め続ける | VS Code では、workspace が信頼され、Chat: Use Hooks が on（組織が off にできる）。Copilot CLI では、フォルダが `trustedFolders` にある。`aidlc` はホストが起動する PATH 上になければならない | ステータス行なし。フォルダで Copilot チャットが始まるまで doctor が警告し、あなたのメッセージに対して hook が 1 つも走らないとき、チャットがそう言う。実ステージとあなたの返信が、なお完全な準備完了チェック |
| Cursor | 番号付きの散文 | はい | ターンを保持できない。リマインダーはフォローアップのメッセージとして届く | プロジェクトが git リポジトリ内にあり、フォルダが信頼されている（doctor がリポジトリを確認） | headless の `agent -p` 実行は approval gate を通れない。ステータス行なし |
| Kiro CLI | 番号付きの散文 | はい | 対話的セッションではワークフローを進め続ける。`--no-interactive` 実行では進めない | `aidlc` エージェントが active | ステータス行なし。session-end も pre-compaction の hook もなし |
| Kiro IDE | 番号付きの散文 | 一部: Plan Approval、review-freeze、state-transition チェック、ターミナルコマンドチェック。reviewer read-scope チェックは hook ではない。作業についてこのチェックが on の間、Kiro は、AI-DLC が書く reviewer のコピーを通じて、各 Unit の reviewer をその Unit に留める | ターンを保持できない。エージェント自身の指示がワークフローを進め続ける | フォルダが信頼され、ウィンドウが再読み込みされ、`aidlc` エージェントが選ばれている（hook が走るまで doctor が警告） | ステータス行なし |
| opencode | 番号付きの散文 | はい | ターンを保持できない。リマインダーは新しい prompt として送られる | AI-DLC plugin がインストールされている（doctor が確認） | session-end イベントなし。ステータス行なし |

ステータス行が無いところでは、`/aidlc --status`（Codex CLI では `$aidlc --status`）と各ゲートの進捗行を使ってください。[Running on other harnesses](harnesses/README.md) 配下の各 harness の章に詳細があります。

---

## GitHub Copilot on Windows

多くのワークショップは、Windows の VS Code で Copilot を走らせます。当日の前にこれらを確認してください:

- **通常の PowerShell ウィンドウからインストールします**。「管理者として実行」で開いたものではありません。その後 VS Code を閉じて開き直し、ターミナルと hook が新しい PATH を見えるようにします。[Install](18-install-and-lifecycle.md#install) と [Windows PowerShell](18-install-and-lifecycle.md#windows-powershell) を参照してください。
- **VS Code のバージョン。** `code --version` を実行します。AI-DLC は 1.130 以降を必要とします。doctor は、任意の Copilot CLI のバージョンだけを確認し、VS Code は確認しません。
- **フォルダの信頼。** Copilot CLI は、`config.json` の `trustedFolders` リストが覆うフォルダ（そのフォルダ、または 1 つ上）でだけ、リポジトリの hook を走らせます。プロジェクトフォルダで `copilot` を 1 回走らせ、「Yes, and remember this folder for future sessions」を選ぶか、フォルダのフルパスを自分で加えます。doctor は、CLI が読むのと同じファイル（Windows では `%USERPROFILE%\.copilot`、または `COPILOT_HOME`）を読み、それがフォルダを覆わないとき警告します。VS Code はそのリストを決して読みません。その hook は、Chat: Use Hooks 設定が on の信頼された workspace でだけ走り、組織がそれを off にできます。doctor はどちらも見えないので、両方を VS Code で確認してください。
- **`aidlc` コマンドを単独で走らせます。** セッションの冒頭で、エージェントに伝えてください。「各 aidlc コマンドを、前に cd を付けずに単独で走らせて」。Code Generation 中は、`cd C:\path && aidlc --status` のようなコマンドは拒否され、`aidlc --status` 単独は許されます。
- **タイプして答えます。** 番号かあなたの回答をチャットにタイプします。picker の回答は、ワークフロー実行中は拒否されます。
- **各 Windows マシンで [準備完了の合格ライン](#before-the-workshop-the-readiness-pass-mark) を実行します。** そこで VS Code が hook を走らせることを証明する、唯一のチェックです。

残りの Copilot セットアップは、[AI-DLC on GitHub Copilot](harnesses/copilot.md) を参照してください。

---

## 関連する読み物

- [Onboarding](onboarding.md) - 参加者の最初の 1 週間
- [Multi-Team Construction and Workshop Mode](workshop-mode.md) - 複数チームが 1 つの intent の Unit を作る
- [Workflow Profiles](workflow-profiles.md) - すべての scope とそれを使うとき
- [Writing a Vision Document](writing-inputs/vision-document-guide.md) と [Writing a Technical Environment Document](writing-inputs/technical-environment-guide.md) - 2 つの事前ノート
- [Troubleshooting](15-troubleshooting.md) - 症状と対処

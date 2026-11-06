# スペースと intent

[最初のワークフロー](02-your-first-workflow.md)では、1 回の実行を最初から最後まで
たどりました。ですが実際の仕事は、一度に一つだけということはめったにありません。進行中の
機能があり、急ぎのバグが飛び込み、別のチームが同じリポジトリを共有します。この章では、
AI-DLC が **多く** の作業を **一つ** の場所（*ワークスペース*）でどう整理するか、そして
その中を行き来するために使う二つの概念、**スペース** と **intent** を説明します。

手短に言うと、**intent** は一つの作業（ライフサイクルの 1 回の実行）で、**スペース** は
一つのチームの intent・ナレッジ・やり方の世界です。ほとんどの人は単一のスペース
（`default` と呼ばれます）で作業し、スペースを意識することはありません。intent を始めて、
その間を切り替えるだけです。この章の残りでは、その仕組みと、何がどこにあるのかを示します。

---

## 一つのワークスペースを、作業の中身で整理する

`aidlc config` を実行すると、選んだエンジンをハーネス自身のディレクトリ
（Claude Code では `.claude/`、Kiro では `.kiro/`、Codex では `.codex/`、Cursor では
`.cursor/`、opencode と GitHub Copilot では `.aidlc/`）に投影し、あわせてハーネス自身が
読むフォルダ（Codex の `.agents/skills/`、opencode の `.opencode/`、GitHub Copilot の
`.github/`）にも投影します。これらがハーネスによって *唯一* 異なるレイアウト部分です。
それ以降、AI-DLC が生み出すものはすべて、プロジェクトルート直下の中立なひとつの `aidlc/`
ディレクトリに置かれます。整理の軸は *何を作業しているか* であり、たまたま動かしている
ハーネスは関係ありません。あなたが見るのは `aidlc/` で、エンジンディレクトリを開く必要は
ありません。

次に、二つのチームといくつかの進行中 intent を持つ完全なワークスペースを示します
（エンジンディレクトリは `.claude/` として示していますが、該当ハーネスでは `.kiro/` や
`.codex/` と読み替えてください）。上から下へ読んでください。この章の残りが土台にする、
考え方のモデルです。

```
my-project/
│
├── .claude/                      THE ENGINE — tools, hooks, skills, agents.
│                                 (or .kiro/ / .codex/ — the one harness-specific dir)
│                                 You never browse this; it just runs /aidlc.
│
├── aidlc/                        EVERYTHING AI-DLC — neutral, browsable, committed to git
│   ├── active-space              ← cursor: which space you're in (gitignored, per-user)
│   └── spaces/
│       ├── default/              ★ the only space most people ever see
│       │   ├── memory/           THE METHOD — how this team works (committed)
│       │   │   ├── org.md          framework defaults
│       │   │   ├── team.md         your team's practices  (adds to org)
│       │   │   ├── project.md      project-specific practices (adds to org and team)
│       │   │   ├── phases/         phase-scoped rules
│       │   │   └── templates/      your output-format overrides, one per artifact
│       │   │
│       │   ├── knowledge/        DOMAIN KNOWLEDGE — standards an agent reads (committed)
│       │   │   │                   free-form; empty until you add files
│       │   │   ├── documents/      YOUR ORIGINALS — PDFs, Word, Markdown (you own this)
│       │   │   │                     nest them however you like; never reorganised
│       │   │   └── documentkb/     THE CATALOG — derived from documents/ (tool-owned)
│       │   │       ├── index.json     every indexed document, with its state
│       │   │       └── <doc-id>/      metadata.json + extracted content.md
│       │   ├── codekb/           CODE KNOWLEDGE — what each repo is (committed, per-repo)
│       │   │   └── <repo>/          architecture, component inventory, freshness marker
│       │   │
│       │   └── intents/          THE RECORD — one subdir per piece of work
│       │       ├── active-intent   ← cursor: which intent is current (gitignored)
│       │       ├── intents.json    the registry: every intent + its scope/repos/status
│       │       ├── 260620-inventory-api/        ✓ a completed intent
│       │       └── 260624-export-bug/           ◷ an in-flight intent
│       │           ├── aidlc-state.md             where this intent is in the lifecycle
│       │           ├── audit/                     the decision trail
│       │           └── inception/requirements-analysis/requirements.md   …artifacts
│       │
│       └── payments-team/        another SPACE (another team) — identical shape
│           └── memory/  knowledge/  codekb/  intents/
│
├── repo-a/                       YOUR CODE REPOS live as siblings (each its own git)
└── repo-b/                       an intent can span more than one
```

このツリーは、複数のコードリポジトリを持つプロジェクトを示しています。リポジトリが一つの
プロジェクトは、同じ構成でリポジトリ自身がワークスペースになったものです
（[`aidlc/` が置かれる場所](#where-aidlc-lives)）。

このツリーから取り出しておきたいことが三つあります。これが考え方のすべてだからです。

- **`aidlc/spaces/<space>/`** は一つのチームの自己完結した世界です。やり方（`memory/`）、
  ナレッジ、コードナレッジ、そしてすべての intent の記録を持ちます。`spaces/default/` は
  最初から用意されており、ソロ開発者や単一チームなら、その先を見ることはありません。
- **`intents/<YYMMDD>-<label>/`** は一つの作業です。[最初のワークフロー](02-your-first-workflow.md)
  が埋めた、実行ごとの記録です。`<YYMMDD>` は記録が時系列に並ぶための短い UTC 日付で、
  `<label>` は短く人が読める名前です。識別そのものはディレクトリ名ではなくレジストリの
  UUIDv7 が担うため、同じ日・同じラベルの intent が二つあっても区別されたままです。
- **二つのカーソル**（`active-space` と `active-intent`）は、*今あなたがどこにいるか* を
  記録します。これらはユーザーごと（gitignore 対象）なので、二人のチームメイトが同時に
  別々の intent に居ても、共有ファイルを取り合うことはありません。

> **古いバージョンからの移行?** 以前のリリースは、一つのワークフローをプロジェクトルートの
> 一つのフラットなディレクトリに置いていて、新しい実行がそれを上書きしていました。
> ワークスペースモデルは、それを上記の intent ごとの記録ディレクトリに置き換えるので、
> 多くの作業を並べて持ちつつ、一方が他方を潰すことがなくなります。

---

## intent — 作業ごとに一つ

**intent** は AI-DLC ライフサイクルの 1 回の実行で、一つのタスクにスコープされています。
すべての intent は、スペースの `intents.json` レジストリに 1 行を持ち
（`{uuid, slug, dirName, scope, repos, status}`）、その実行の状態・監査証跡・成果物を保持する
**記録ディレクトリ** を持ちます。`uuid`（UUIDv7）が正規で衝突しない識別子であり、`dirName`
は人が読める記録ディレクトリ名をそのまま記録します。末尾にカンマ、コメント、BOM を残す
手編集があっても、すべての行として読めます。何も読めなくなったリストが上書きされることは
ありません。次の新しい作業は、そのバイト列を新しいリストの隣に
`intents.json.unreadable-<UTC time>` として残し、あなたに一度だけ知らせます。

行の `status` は intent のライフサイクルです。作成時から `in-flight`、スコープ内の最後の
ゲートが閉じると `complete`、やり切らない作業を退役させたり、やり切った作業を隠したりする
と `archived` になります（`/aidlc intent archive <name>`）。アーカイブは何も削除しません。
記録ディレクトリ・監査証跡・Bolt の worktree はそのまま残り、デフォルトの一覧がその行を
表示しなくなるだけです（`/aidlc intent list --all` では表示されます）。
`/aidlc intent unarchive <name>` で、進行中であれ完了であれ、元の状態に戻ります。

intent を作る専用のコマンドはありません。作業を最初に説明したとき、エージェントがそれに
対する計画を提案します。

```
/aidlc Build a REST API for inventory management
```

計画を確定すると、AI-DLC は intent とその記録ディレクトリを作り（[はじめかた](01-getting-started.md)
の実行では `aidlc/spaces/default/intents/261013-inventory-rest-api/`）、それをアクティブな
intent にして、前章のように最初のステージを始めます。

### 二つ目の作業を始める

ここでワークスペースの真価が出ます。機能の途中で、無関係なバグに手を付ける必要が出たと
しましょう。何かをアーカイブしたり初期化コマンドを実行したりはしません。新しい作業を説明
するだけです。

```
/aidlc Fix the timeout on the export endpoint
```

すでに intent がアクティブなとき、AI-DLC はこれが現在の機能の続きではなく *新しい無関係な*
作業かもしれないと認識し、最初の intent と並べて二つ目を始める前に **たずねます**。

```text
 New request
 Work is already in progress on: "Build a REST API for inventory management". You said: "Fix the
 timeout on the export endpoint". What should I do?
 > 1. Part of the active work
      Continue the current workflow
   2. Separate new piece of work
      Set it up alongside the current one as "bugfix" work (6 stages, 6 approval gates) without changing it
   3. Reshape the active work
      Change how the remaining plan is shaped
   4. Type something.
   5. Chat about this
```

- **2** を選ぶと、AI-DLC はそのオプションが挙げる計画で、最初の intent の隣に二つ目の
  intent を作ります（ここでは大きさとしてエージェントが `bugfix` を提案しました）。
  オプションが計画を挙げていない場合は、次に新しい作業の計画を選びます。その実行で
  エージェントはこう言いました。「エクスポートのタイムアウト修正を、バグ修正プランを
  使って別の作業として用意し、Requirements Analysis で待たせています。あなたの inventory
  API の作業は feasibility ステージのまま変わっていません」。最初の intent の記録
  ディレクトリ・状態・進み具合は、残したとおりに正確に保たれます。
- **1** を選ぶと、AI-DLC はあなたのメッセージをアクティブな intent の一部として扱います。
- **3** を選ぶと、AI-DLC はアクティブな intent の残りの計画をどう作り変えるかを、あなたと
  一緒に詰めます。

作業を続けるとだけ伝えた場合（`/aidlc carry on`、"proceed"、"keep going"、あなた自身の
言葉で）は何もたずねません。AI-DLC はあなたの言葉を読んで、アクティブな作業を続けます。
作業がどこまで進んだかをたずねた場合（`/aidlc how far along are we?`、あなた自身の言葉で）
も何もたずねません。AI-DLC はステータスからあなたの質問に答えます。プロジェクトに作業が
あるのにまだ何も選ばれていないときは、どの作業を取り上げるかをたずねます。あなたの言葉で
作業を挙げれば（`/aidlc continue auth`）、それを取り上げて続けます。

新しい作業と一緒にタイプした設定は、あなたが選んだ作業についていきます。
`/aidlc --depth minimal --learnings off Fix the timeout on the export endpoint` は同じ質問を
します。**2** を選べば、新しい intent がその深さと learnings off で始まります。**1** か
**3** を選べば、それらはアクティブな intent に適用されます（**3** の場合は計画が作り変え
られる前に）。この方法で下げた Guard Policy も、あなたが選んだ作業についていき、AI-DLC は
それを一度だけ知らせます。チームが Guard Policy を strict に保っている場合、新しい intent
は strict で作られます。計画名を先に挙げた場合（`/aidlc bugfix Fix the timeout`）も同じ
質問をし、その計画を提案します。計画名があなた自身の最初の語でもある場合
（`classic car rental website`）、アシスタントはどちらの意味かを読み取り、あなたの語が
選んでいない計画に使われることがないよう、一度だけたずねることがあります。
アクティブな intent と異なるスコープを説明とともにタイプした場合も同じで
（`/aidlc --scope express "add a health endpoint"`）、新しい作業を先に扱います。**1** を
選べば、その説明が新しい express の作業を始め、アクティブな intent はそのままです。**2** を
選べば、アクティブな intent が express に変わります。説明のない `--scope`
（`/aidlc --scope express`）は、たずねずにアクティブな intent のスコープを変えます。
別の計画名を単独でタイプした場合（`/aidlc workshop`）は、その計画での新しい作業か、
アクティブな intent をそれに移すかのどちらかを意味します。アシスタントはどちらの意味かを
読み取り、判別できないときは一度だけたずね、その計画での新しい作業なら、何かが始まる前に
その作業が何のためかをたずねます。

AI-DLC がたずねずに二つ目の intent を作ることはありません。プロンプトが本当に現在の作業の
続き（ゲートへの回答、要件の修正）であれば、アクティブな intent にとどまります。作業が
明らかに別物のときだけ、この提案が現れます。

### intent を切り替える

スペースの intent を一覧し、名前（slug）で切り替えます。同じ実行で、エクスポート修正が
アクティブな状態から。

```text
> /aidlc intent
Intents in space "default":
  261013-inventory-rest-api  [in-flight]
* 261013-export-timeout-fix  [in-flight]

> /aidlc intent inventory-rest-api
Now working on inventory-rest-api. You were on export-timeout-fix: /aidlc intent export-timeout-fix goes back.
```

`*` がアクティブな intent を示します。

切り替えは、呼び出したセッションの束縛を更新し、`active-intent` カーソルへ書き込みます。
そのセッションの次の `/aidlc` は、止めた場所からそのまま intent を再開します。同じステージ、
同じ状態、同じ監査証跡です。いくつでも intent を同時に抱えて自由に行き来でき、それぞれが
独立した実行です。

> 素の `/aidlc intent` は読み取り専用で、一覧するだけです。機械可読な出力には `--json` を
> 足します。フラグの完全な参照は [CLI コマンド](12-cli-commands.md) を参照してください。

### 一つのチェックアウトでの並行セッション

各ライブセッションは、マシンローカルな束縛を
`aidlc/.aidlc-sessions/<session-id>.binding.json` に保ちます。束縛はセッションのスペースと
intent を記録するので、別のターミナルや IDE ウィンドウが、このセッションのワークフローを
黙って動かすことなく、共有カーソルを動かせます。

束縛は、その intent がどう選ばれたかも記録します。記録を見つけることと、それに参加する
ことは同じではありません。新しいクローンでは、チームメイトの intent 記録はコミットされて
いても `active-intent` カーソルはコミットされていないので、その 1 件の記録は解決されますが、
どのセッションもまだそれに参加していません。最初の `/aidlc` はどの intent を作業するかを
たずね、AI-DLC のフックは、セッションが `/aidlc intent <slug>` を実行する（または自分の
intent を作る）まで、あるいはこのマシンがその記録を選ぶ（別のチャットやターミナルから
`active-intent` カーソルがそれを指す）まで、その記録に手を付けません。選択の後に開いた
チャットがそうするのと同じように、次のターンで黙ってそれに参加します。まだ参加していない
チャットでタイプした内容は、それでも保たれ、intent 記録の外、そのチャット自身のメッセージ
記録に残ります。以前のバージョンが束縛したセッションは、あなたのカーソルが同じ記録を指す
限り、その intent の作業を続けます。そうでなければ、その intent への再束縛が提案されます。
以前のバージョンが印を付けたが束縛しなかったセッションは、再開時にその印に従うので、
アップグレードをまたいで開いたままのチャットは自分の intent を続けます。
AI-DLC の worktree コマンドを使わずに作った素の `git worktree`（あるいはホストがチャット
ごとに作るもの）は、自分のカーソルを持たずに始まるので、メインチェックアウトがこのマシンで
持つものを読みます。メインチェックアウトが居るスペースを開き、worktree がその intent の
記録を持っていれば intent も開くので、そこのチャットは次の段落が言うようにその作業の上に
います。worktree で intent を切り替えると、worktree 自身の intent カーソルができ、メイン
チェックアウトのものはもうそれを動かしません。worktree が居る intent をアーカイブすると、
メインチェックアウトでのように、そこでその intent が解決されなくなります。メイン
チェックアウトにもカーソルがないときは、`/aidlc intent <slug>` で intent を選びます。この
マシンでクレームされた Unit は、その Unit の intent として数えられます。Unit 参加マーカーは
チェックアウト全体のもので、どの intent も名指ししないので、特定の記録への参加としては
数えられません。

あなたのカーソルが作業を指しているときに開いたチャットは、その作業の上にいます。そこでの
`/aidlc` は、何もたずねずに、作業を今の位置から続けます。Claude Code、Codex CLI、Kiro CLI、
opencode では、その作業のチェック（Code Generation 中の Plan Approval、レビューの凍結）が、
そこでの最初の AI-DLC ステップ（`/aidlc`、回答、あなたが求めるレビュー、あなたが変える
設定）からチャットを押さえます。だから、同じフォルダで別のことのために開いたチャットは、
ワークフローのないフォルダのようにあなたの要求を実行します。Cursor、GitHub Copilot、Kiro
IDE（および Kiro CLI v3）では、コマンドがどのチャットで動くかを AI-DLC に伝えられないので、
そこではチェックが最初からチャットを押さえます。AI-DLC がその作業のために作った worktree、
またはこのマシンでクレームされた Unit は、どのホストでも最初からチャットを押さえます。

セッションの識別は一つの順序に従います。

1. フックに届いたホストのセッション id。
2. ハーネスプロセスから受け継いだ有効な `AIDLC_SESSION_OVERRIDE`、または AI-DLC の opencode
   プラグインが動くチャットのために各シェルコマンドに与えるもの（opencode の `shell.env`
   フック）。これで一つの opencode ウィンドウ内の二つのチャットが、それぞれ自分の作業に
   対して動きます。
3. ホストがエージェント自身のシェルで名指しするチャット。Codex の `CODEX_THREAD_ID`、
   Claude Code の `CLAUDE_CODE_SESSION_ID`（その `CLAUDE_PID` が名指すプロセスが生きている
   間）、または Kiro CLI の `KIRO_SESSION_ID`。チャットが終わった後も開いたままのシェルは
   その変数を持ち続けるので、Claude Code の id はそのチャットのプロセスが生きている間だけ
   読まれます。死んだ pid や不在の pid は、それを未読のままにします。Kiro CLI はシェルに
   pid を置かないので、Codex のように、その id は単独で成り立ちます。ほかのハーネスは、
   そこでチャットを名指ししません。
4. 最も近い、生きている PID 系譜のエントリ。
5. セッション識別なし。

この方法で見つかったすべての id、そしてすべてのフックペイロードのセッション id は、どの
チャットや作業記録を読むよりも前に、一つの関門を通ります。ヘルパー自身の id（spawn された
Codex エージェントやレビュースレッドのもの、Kiro CLI の委譲のもの、Copilot サブエージェント
のもの）は、どのチャットに属するかに応じて、そのチャットへ対応づけられます。両方を示す
最初のフックペイロードを見て、アダプターがその組を控えます。これはエンジンが自力では学べない唯一の事実です。それから
そのチャットの束縛が読まれ、まだ束縛のないチャット（SessionStart をそれに対して一度も実行
しなかったホスト、またはチャットが開いた後に入れたフック）は、SessionStart が新しいチャット
に適用するのと同じ規則で最初の接触で束縛されます。このマシンが参加している共有カーソルが
指す作業へ、なければどの記録にも束縛せずに、黙って。それ以降、チャットはその作業の上に
とどまります。別のウィンドウでタイプした切り替えが動かすのはカーソルで、チャットはそのままです。
ここの 1 件の記録がまだ選ばれていなかったという理由だけでどの記録にも束縛されていない
チャットは、どの入口でも再び読まれます。カーソルが記録を指せば、同じやり方で、黙ってその
作業に参加します。セッション識別がまったくないコマンド（あなた自身のターミナル）は、
カーソルに従い続けます。

識別がわかると、明示的なスペースや intent のセレクタが勝ち、次にそのセッションの束縛、
それから共有の `active-space` と `active-intent` カーソル（既存の 1 件 intent と空の
ワークスペースへのフォールバック付き）の順です。

ヘッドレスの自動化では、`AIDLC_SESSION_OVERRIDE` をハーネスプロセスに設定します。個々の
ツールコマンドには設定しません。すると spawn されたすべてのツールが同じ識別を
受け継ぎます。その上書きが PID 系譜から見つかった識別と食い違う場合、AI-DLC はどちらの
ワークフローを書く前にも拒否し、再束縛のために、所有している会話か、intent とスペースの
切り替え動詞を指し示します。`AIDLC_SESSION_OVERRIDE_SOURCE=payload` は同一ユーザー間の
内部契約であって、認証されたセキュリティ境界ではありません。両方の変数を意図して設定する
ことは、意図した正規のセッション切り替えのように扱われます。

カーソルは書き込み透過の互換性状態のままです。だから束縛を持たない古い環境や非対応の環境は、
以前とまったく同じように動きます。

セッション束縛はスペースをまたいでワークフロー選択を隔離しますが、ハーネスネイティブの
メソッドインクルードは、依然としてチェックアウト全体で一つの面です。各インクルードは、
アクティブなスペースのメモリファイルの、git で無視される 1 コピー `aidlc/active-memory/`
を読みます。これは SessionStart とスペース切り替え動詞が、選ばれたスペースのために書き
ます。だから別々のスペースにある二つの同時セッションは、ハーネスが次に届ける環境ルールが
どのスペースのものかを、互いに上書きしうります。このインクリメントは一つのスペース内の
並行 intent をサポートします。並行する複数スペースの環境メソッド配送は、今後の課題のまま
です。

スペースの切り替えは、追跡されるファイルを何も変えません。インクルードはどのチームメイト
にも同じで、`aidlc config` はほかの出荷ファイルと同じようにそれらを更新します。インクルード
が以前のリリースの切り替えによって別のスペースを指していたインストールは、次の更新で
出荷ファイルの状態に戻り、衝突はありません。

Codex アダプターは、検証済みのフックペイロードのセッションをすべてのコアフックの子に
固定し、Codex は実行するすべてのコマンドにセッションを `CODEX_THREAD_ID` として与えます
（0.145.0 以降、AI-DLC がサポートする最小。フックはそれを受け取りません）。だからツールは
そこから id を読み、すべてのコマンドはエージェントが書いた語をそのまま保ちます。macOS
サンドボックスが `ps` を拒否しても、Codex のワークフロー選択は弱まらず、出荷された
`.codex/rules/default.rules` のプレフィックスは、エージェントが実行するものと一致します。
Windows x64 と arm64 では、ネイティブのプロセスハンドル・作成時刻・親 PID が、Linux と
macOS と同じ 2 秒 / 64 系譜の上限内で、所有するセッションを識別します。再利用された PID
世代や検証されていない系譜は、セッションを選びません。
共有プロセスのハーネスは、依然として一つのプロセスを使うチャットを区別できません。Kiro IDE
のマルチチャットもそうです。複数セッションの opencode では、シェルコマンドが自分のチャットを
運び（項目 2）、ファイル書き込みの監査行・センサー・to-do リストの同期もそうします。
ペイロードを持つフックの子は、ペイロードのセッションに従います。その親を持たないツールは、
系譜が得られないとき、ハーネスプロセスが有効な `AIDLC_SESSION_OVERRIDE` を持たない限り、
依然として共有カーソルにフォールバックします。

既知の制限: それら共有プロセスのチャットにおけるフック書き込みと、intent・スペースの切り替え
動詞は、既存の v2 の共有カーソルと `.current-session` のふるまいを保ちます。だから一つの
チャットが、別のチャットのナビゲーションやフック属性に影響しうります。それらの経路の
セッションごとの隔離は、今後の課題です。例外は、Kiro IDE のチャットにタイプされた intent や
スペースの切り替えで、どちらの形でも（`/aidlc intent switch <name>` または
`/aidlc intent <name>`、`space` でも同じ）、プロンプトフックがそれをそのチャットの
セッションで実行するので、そのチャットだけを束縛します。

---

## スペース — チームごとに一つ

**スペース** は一つのチームの完全な世界です。自分の `memory/`（やり方）、`knowledge/`、
`codekb/`、`intents/` を持ちます。この章でここまで起きたことはすべて、`default` という名の
一つのスペースの中で起きました。これは自動で作られます。**ソロ開発者や単一チームなら、
ここで話は終わりです。スペースを名指しすることはなく、すべてそのまま動きます。**

スペースは、**一つのプロジェクトを複数のチームが共有し**、それぞれが自分のやり方・ナレッジ・
記録を衝突させずに持ちたい場合のために存在します。チームを足すことは純粋に追加的です。
同じ構成の新しい `spaces/<name>/` が `default/` の隣に現れます。何も動かず、何も移行しません。

スペースの作成・一覧・切り替えは、intent の動詞をそっくりなぞる動詞で行います。

```
/aidlc space                      List all spaces
/aidlc space create payments-team Create a new space, starting from the default space's org rules
/aidlc space switch payments-team Switch the active space to "payments-team"
```

一つ作ると、何を用意したかを出力します。

```text
> /aidlc space create payments-team
Space created: payments-team
  memory/org.md (copied from default), team.md, project.md, phases/, templates/, codekb/, knowledge/
Switch to it with /aidlc space payments-team.
```

短い `/aidlc space-create <name>` と素の `/aidlc space <name>` の形も使えます。

新しく作られたスペースは、デフォルトスペースの `aidlc/spaces/default/memory/org.md`
（あなたのチームがそこに加えた変更ごと）のコピー、フレームワーク自身のフェーズルール、
そして真新しい空の `team.md` / `project.md` のやり方ファイルで始まります。新しいチームは、
別のチームのやり方を受け継がず、自分のやり方を自分で築きます。その `knowledge/` と
`codekb/` も空で始まります。コピーは一度だけ作られます。後でデフォルトスペースの `org.md`
を変えても、新しいスペースには届きません。
[何が引き継がれ、何が引き継がれないか](#what-carries-over-and-what-doesnt) に、何が共有され、
何が共有されないかを載せています。

スペースを切り替えると、二つのものがカーソルに自動でついていきます。

1. **AI-DLC 自身のリゾルバ**。次に始める intent、エージェントが読み込むやり方とナレッジは、
   すべて切り替え先のスペースから来ます。
2. **ハーネスがコンテキストに読み込むルール**。切り替えは、新しいスペースの `memory/`
   ファイルを `aidlc/active-memory/` に書き込みます。これは、あなたのハーネスのネイティブな
   ルールインクルードが読む、git で無視されるコピーです（Claude の `@` インポート、Kiro CLI
   のリソース、Cursor のルール、opencode の instructions、Copilot の `AGENTS.md`。Kiro IDE の
   steering ファイルはテキスト自体を運び、Codex ではエンジンが各ステップにルールを渡します）。
   こうして次のターンはそのチームのやり方の下で動きます。

追跡されるファイルは変わらないので、切り替えがコミット済みのツリーをかき回すことはなく、
pull するチームメイトがあなたのスペースを拾うこともありません。コピーはセッションごとに閉じず
チェックアウト全体にかかるので、別々のスペースにある同時セッションは、ワークフロー記録の
選択は束縛されたままでも、環境メソッドの配送で競合しうります。

### どのスペースに居るかを知る

Claude Code で AI-DLC のステータスラインをオンにしていると、その行は、あなたが居る作業から
始まり、スペースが複数になれば、その前にスペースから始まります。シェルのプロンプトが現在の
ディレクトリを示すのと同じ、持続する「あなたはここにいます」です（バーと区切りのドットは
プレーンテキストで示され、行はウィンドウの端で切られます）。

```text
[AIDLC] default - inventory-rest-api - IDEATION [##--------] 1/4 > Feasibility -- Architect Age...
```

`default` しか持たない単一チームのユーザーは、スペース名をまったく見ません。どのハーネス
でも、`/aidlc space` と `/aidlc intent` が、`*` 印とともに今いる場所を一覧します。

---

## `aidlc/` が置かれる場所

**`aidlc/` は `aidlc config` がインストールするフォルダに置かれ、そのフォルダがあなたの
ワークスペースです。** それは、あなたがそれを実行するフォルダか、`--project-dir` で名指し
するフォルダです。AI-DLC は git ルートを上に探しに行きません。サブフォルダにインストール
すれば、そのサブフォルダは自分のハーネスフォルダと自分の `aidlc/` を、自分のスペースと
intent とともに持ちます。ハーネスを同じフォルダで開いてください。

二つのレイアウトが、ほとんどのチームをカバーします。

### 一つのリポジトリ、またはモノレポ

```
inventory-api/        ← run `aidlc config` here; this is the git repo
├── .claude/          the harness files (committed)
├── aidlc/            rules, knowledge, and the record of each piece of work (committed)
├── .gitignore        AI-DLC adds its own marked block
└── src/              your code
```

すべてがコードとともに、同じリポジトリ・同じプルリクエストで旅をします。モノレポも同じ
レイアウトです。リポジトリルートで `aidlc config` を実行すれば、すべてのパッケージが一つの
`aidlc/` を共有します。このレイアウトの作業はリポジトリを記録しないので、生成コードと git
操作はフォルダ自身にとどまります。ただし、そのリポジトリが、自分の `.git` を持つ直下の
子フォルダ（初期化済みのサブモジュールやネストしたリポジトリ）を持たない限りです。持って
いれば、AI-DLC はそれらのフォルダをリポジトリとして扱い、次のレイアウトのようになります。
代わりにインストールを一つのパッケージのサブフォルダに置けば、そのパッケージは別の `aidlc/`
を、自分の記録とともに持ちます。git は分けられません。ブランチと worktree は依然として
リポジトリ全体に属します。git がサブフォルダからリポジトリを解決するからです。複数のチームが
リポジトリを共有するなら、チームごとのスペース（上記のスペースを参照）の方が合います。
サブフォルダへのインストールは、パッケージが本当に独立したプロジェクトのときだけ使って
ください。

### 一つの `aidlc/` の隣に複数のリポジトリ

```
my-project/           ← run `aidlc config` here
├── .claude/          the harness files
├── aidlc/            records for work that spans the repos
├── repos.json        optional: the repos to clone (see below)
├── .gitignore
├── checkout-api/     its own git repo
└── checkout-web/     its own git repo
```

コードリポジトリは、`aidlc/` の隣にあって自分の `.git` を持つフォルダです。AI-DLC がそれを
自分で見つけます（[一つの intent で複数リポジトリ](#multiple-repos-in-one-intent)）。作業の
記録は `aidlc/` に一度だけ置かれ、リポジトリごとには置かれないので、両方のリポジトリに触れる
変更でも、一組の要件と一つの監査証跡を持ちます。

それらを抱えるフォルダは git リポジトリである必要はなく、AI-DLC がそれをリポジトリにする
こともありません。`.git` やプロジェクトファイルを持たないので、`aidlc config` はフォルダの
確認をあなたに求めることがあります（スクリプトでは `--project-dir` を渡します）。これが
`aidlc/` にとって何を意味するか。

- **あなた一人なら:** 何もすることはありません。`aidlc/` は、追跡されないまま、あなたの
  ディスクに残ります。
- **チームなら:** そのフォルダで `git init` を実行し、それ自身の小さなワークスペース
  リポジトリとして push します。コードリポジトリは自分のリモートを持つ別々のリポジトリの
  ままで、ワークスペースリポジトリはそれらを追跡してはいけないので、まず除外しておきます。
  `repos.json` に挙げたリポジトリについては
  [`aidlc-workspace-sync`](12-cli-commands.md#aidlc-workspace-sync-clone-and-reconcile-the-declared-repo-set)
  ツールがやってくれます。そうでなければ、それぞれに無視行を足します。それから
  `git status` を実行し、それが挙げるもの（`aidlc config` が書いて git が無視しないすべて、
  それに `repos.json`）をコミットします。正確なファイルはハーネスによって違うので、パスを
  手で選ばないでください。チームメイトはワークスペースリポジトリをクローンし、sync ツールを
  実行してコードリポジトリをその隣にクローンします。
- **Codex CLI と Cursor:** Codex は git リポジトリの中でしかフックを見つけず、Cursor は
  その外ではフックを飛ばすことがあるので（[はじめかた](01-getting-started.md)）、どのように
  共有するにせよ、そのフォルダで `git init` を実行してください。

### どちらのレイアウトか

| あなたの状況 | 使うもの |
|---|---|
| コードが一つのリポジトリにある | 一つのリポジトリ: その中にインストール |
| 一つの作業が複数のリポジトリを変える | 一つの `aidlc/` の隣に複数のリポジトリ |
| 複数のチームが同じリポジトリを共有する | 一つのワークスペース、チームごとのスペース（上記のスペースを参照） |
| 無関係なプロジェクト | それぞれに別のフォルダと `aidlc/`。記録・ルール・ナレッジは共有されず、マシン全体の設定とアクティブなリリースだけが両方に届きます（[何が引き継がれるか](#what-carries-over-and-what-doesnt)） |

各レイアウトで何をコミットするかは
[何がコミットされ、何がされないか](#whats-committed-and-whats-not) にあります。

---

## 一つの intent で複数リポジトリ

intent は一つのリポジトリに限られません。コードリポジトリは、どれか一つの中にネストせず、
ワークスペースフォルダで `aidlc/` の隣に並ぶので、intent は必要なだけ多くの
リポジトリにまたがれます。

リポジトリの集合は **intent が作られるとき** にとらえられ、あなたが余分に何かをタイプする
ことはありません。デフォルトでは、AI-DLC がすべての兄弟リポジトリ（自分の `.git` を持つ
ワークスペースルート直下の子それぞれ）を自動で見つけ、その集合を intent の `intents.json`
行に記録します。Construction の間、各 git 操作はそこで自動的に正しいリポジトリに結び
つけられます。

各リポジトリは、あなたが与えたフォルダ名で記録されます。空白、アクセント、アポストロフィ、
ほかの文字も使えます（`my lib`、`C# lib`、アクセント付きの名前）。いくつかの文字は AI-DLC が
頼るものを壊すので、名前にそれを含むフォルダは作業から外され、最初のステップがどのフォルダを
なぜ外したかを言います。`<` `>` `:` `"` `|` `?` `*`（Windows はフォルダ名にこれらを持て
ません）、`&` `^` `%`（Windows での AI-DLC のコマンド）、カンマ（リポジトリ名を区切ります）、
アポストロフィと `!`・`$`・バッククォートの組み合わせ（Windows の PowerShell と Git Bash で
両方を同じに読んでクォートする人はいません）、`-` という名前や `--` で始まる名前、
`@checkout` で終わる名前、空白で始まる・終わる名前。

```
my-project/
├── aidlc/          # AI-DLC's records
├── checkout-api/   # repo-a   ┐ both auto-discovered as siblings;
└── checkout-web/   # repo-b   ┘ an intent here can touch either or both
```

リポジトリを記録しない intent は、ふつうの単一リポジトリの場合です。記録ディレクトリの
詳細は [成果物リファレンス](14-artifacts-reference.md) を、用語集の
[複数リポジトリ intent](glossary.md) を参照してください。

### リポジトリ集合を宣言する（任意のマニフェスト）

自動検出には、兄弟リポジトリがすでにクローンされている必要があります。共有ワークスペースの
新しいチェックアウトではそうではないので、チームメイトはどのリポジトリをどこにクローン
するかを知っていなければなりません。ワークスペースルートの **任意の** `repos.json`
マニフェストは、その期待される集合を記録し、一つのコマンドで再現できるようにします。

```json
{
  "org": "your-github-org",
  "repos": [
    { "name": "checkout-api", "branch": "main" },
    { "name": "checkout-web" }
  ]
}
```

`org` はデフォルトのクローンホストを与えます（`url` を持たないリポジトリは
`git@github.com:<org>/<name>.git` からクローンされます。エントリに `url` を設定して上書き
します）。`branch` は新しいクローンのチェックアウトを選び、すでにディスクにあるリポジトリ
には参考となる期待です。省けばそのリポジトリ自身のデフォルトを使います。リポジトリ名は、
ワークスペース直下の一つのフォルダの名前で、検出されたフォルダが持ってよい文字（上記）を
使えます。この
[CLI コマンド](12-cli-commands.md#aidlc-workspace-sync-clone-and-reconcile-the-declared-repo-set)
ガイドは、このファイルを読んで、欠けているリポジトリをクローンし、gitignore ブロックを最新に
保ち、VSCode のマルチルートワークスペースを生成する `aidlc-workspace-sync` ツールを説明して
います。

[`/aidlc intent add-repo <name>`](12-cli-commands.md#aidlc-intent-add-repo-name-add-a-sibling-repo-to-work-already-under-way)
も、このファイルを書きます。作業が必要とするのにここで誰もクローンしなかったリポジトリは、
そのエントリからクローンされます。エントリのないリポジトリは `org`（またはあなたが与える
アドレス）からクローンされ、一つエントリを得ます。ファイルのコメントとレイアウトは保たれ
ます。`repos.json` がまだないとき、ホスト付きの `--url`（ホスト・オーナー・名前）は、その
オーナーを `org` とするものを作るので、チームとリストを共有するにはコミットしてください。
ここに書かれたアドレスが資格情報を保つことはありません。

マニフェストは便利さのためであって、二つ目の真実の源ではありません。**実行時はディスクが
勝ちます**。intent の作成は、依然として実際に存在する兄弟を自動検出するので、リポジトリは
宣言されていてもいなくてもクローンされた瞬間に使えますし、クローンされなかった宣言済みの
リポジトリは、単に集合の一部になりません。マニフェストは、sync ツールと、宣言された集合と
ディスクが食い違ったときに知らせる参考用の `--doctor` 行だけを動かします。（この「ワーク
スペースマニフェスト」は、パッケージングファイルであるハーネスの `manifest.ts` とは無関係
です。）

---

## 何が引き継がれ、何が引き継がれないか

AI-DLC が知っていることはすべてファイルにあるので、共有はフォルダに従います。スペースは
境界、ワークスペースは境界、そして git が人とマシンの間でファイルを運びます。

| 対象 | スペース内の intent 間 | スペース間 | プロジェクト間（別々の `aidlc/` フォルダ） |
|---|---|---|---|
| ルール: `org.md`、`team.md`、`project.md`、`phases/` | 共有。各ステージが現在のファイルを読む | 新しいスペースはデフォルトスペースの `org.md` とフレームワークのフェーズルールの一度きりのコピーを得る。その `team.md` と `project.md` は空で始まる。その後は何も流れない | ファイルをコピーするか、テンプレートリポジトリから始める（下記） |
| あなたが保つ learnings | アクティブなスペースの `project.md`、または昇格すれば `team.md` に入る | 共有されない。各スペースが自分のものを持つ | 欲しい行をコピー |
| あなたの文書（`knowledge/`） | 共有。`associate` は文書のリストに intent を足し、繰り返せる。intent のない文書はスペース全体のもの | 共有されない。各スペースが自分のフォルダを持つ | `onboard` はファイルをコピーして入れ、プロジェクト外のパスを拒否するので、そのファイルを別のプロジェクトにコピー |
| コードナレッジ（`codekb/`） | 共有、リポジトリごと。現在のスキャンはあなたの選択で再利用できる | 共有されない。別のスペースは再びスキャンする | 各プロジェクトが自分でスキャンする。同じリポジトリのチームメイトのクローンはスキャンを再利用できる |
| 保存したスコープ（`aidlc/scopes/`） | 共有 | ワークスペースのすべてのスペースで共有 | ファイルをコピー |
| 出力形式の上書き（`memory/templates/`） | 共有 | スペースごと。新しいスペースにはコピーされない | ファイルをコピー |
| あなたが足すエージェント（ハーネスフォルダ内） | 共有 | すべてのスペースで共有 | ファイルをコピー |
| リポジトリリスト（`repos.json`） | ワークスペースに一つ | ワークスペースに一つ | プロジェクトごと |
| モデルとフラグのポリシー | 共有 | 共有 | マシン設定ファイルに一度設定し、マシンのすべてのプロジェクトに適用。プロジェクト自身の `aidlc.settings.json` が値ごとに上書きするが、バイパスは別で、ファイルをまたいで積み上がる（[階層](18-install-and-lifecycle.md)）。モデルと effort のポリシーは Cursor と GitHub Copilot では効かず、そこではすべてのエージェントがツールで選んだモデルを使う。Kiro IDE では一つのエージェント自身のモデルと effort だけが効き、プリセットやグループの effort は効かない |
| Kiro CLI のセッションモデルと、プリセットが設定する effort | 共有 | 共有 | あなた個人の Kiro 設定に保存され、すべての Kiro CLI プロジェクトが使う。エージェントやグループのポリシーの変更はこうはならない |
| 更新・オフライン・ミラー・CA バンドルの設定 | 共有 | 共有 | マシン専用。プロジェクトファイルからは設定できない |
| Kiro IDE の Workflows スイッチと、Windows でのデフォルトターミナル | 共有 | 共有 | プロジェクトの外、Kiro のユーザー設定に保たれる。セットアップが一度たずね（`aidlc config --yes` は推奨の答えを採る）、`aidlc config trust` が求めに応じて変える。その IDE で開くすべてのプロジェクトに適用 |
| Kiro CLI の Workflows スイッチ | 共有 | 共有 | プロジェクトの外、あなた自身の Kiro CLI 設定に保たれる。Kiro IDE プロジェクトでは、セットアップが一度たずね、Kiro IDE のものとは別に保たれる答えで（`aidlc config --yes` は推奨の答えを採る）、`aidlc config trust --kiro-cli-workflows off|on --yes` が求めに応じて変える。Kiro CLI を実行するすべてのプロジェクトに適用 |
| AI-DLC リリースそのもの | 共有 | 共有 | 固定リリース（`.aidlc-version`）のないネイティブプロジェクトは、マシンがアクティブにしているリリースを実行するので、`aidlc update` はそのようなすべてのプロジェクトでそれを変える（自分のファイルは次の `aidlc config` で追いつく）。コピーしたプロジェクトは自分のコピーしたリリースを実行 |

それらのマシン全体の設定・IDE の選択・アクティブなリリースを除けば、AI-DLC には二つの
プロジェクトを結ぶものはありません。
チームメイトは共有ファイルをリポジトリの pull で得ます。
[何がコミットされ、何がされないか](#whats-committed-and-whats-not) にあるユーザーごとの
ファイルが旅をすることはありません。

### 多くのプロジェクトのための基準

多くのプロジェクトに同じ初期ルールを与えるには、組織がどこでも欲しい `org.md`・`team.md`・
ナレッジファイルを持つ `aidlc/` を抱えたテンプレートリポジトリを保ちます。新しいプロジェクト
はそのコピーから始め、自分の `project.md` を足します。変更を展開するには、テンプレートを
変え、ほかのどの変更とも同じように、プルリクエストを通して各プロジェクトに取り込みます。

新しいリリースをプロジェクトの上にコピーして更新すると、コピーはデフォルトスペースの
`org.md` と `phases/` ルールを出荷されたものに置き換え、`team.md` と `project.md` は保ち
ます。コミットする前に git diff を確認してください
（[コピーチャンネル](18-install-and-lifecycle.md#copy-channel)）。ネイティブな
`aidlc config` の更新は、すべてのスペースのメモリファイルを保ちます
（[プロジェクトの設定または更新](18-install-and-lifecycle.md#configure-or-refresh-a-project)）。

---

## 何がコミットされ、何がされないか

`aidlc/` は git にチェックインされ、チームがその作業を **共有** します。やり方、intent
レジストリ、各 intent の状態、監査証跡、成果物はすべてリポジトリとともに旅をします。二種類の
ファイルは、代わりに意図して **gitignore** されます。

| gitignore される（ユーザーごと、マシンローカル） | なぜ |
|---|---|
| `aidlc/active-space`、`…/intents/active-intent` | カーソル。「今どこにいるか」。コミットすると、ユーザーごとのナビゲーションが共有リポジトリの状態になり、チームメイトが intent 作成とカーソル切り替えを取り合うことになる。 |
| `.../intents/<id>/runtime-graph.json`、`.aidlc-*`、`aidlc/.aidlc-sessions/`、`aidlc/.aidlc-active-space-*.tmp` | 派生した、マシンローカルな実行時の状態。セッションごとの束縛と PID 系譜のエントリを含む。 |
| `aidlc/.aidlc-request-text/` | エージェントがエンジンに読ませるためにファイルに書いた要求。コマンドが進めば消される。進まなかったときに残ったものは、共有された作業ではなくあなたの語。 |
| `…/knowledge/documentkb/.journal/` | 進行中の文書トランザクションごとに一つのディレクトリ。一時的でクローンごと。コミットされたジャーナルは、並行する `sync` のたびにマージ衝突になる。 |
| `…/knowledge/.sources.local.json` | *このマシン* が、リポジトリ外にある文書をどこで見つけるか。パスは定義上マシン固有なので、コミットするとすべてのチームメイトのチェックアウトが壊れる。今日このようなリンクを作るコマンドはない（`onboard` はファイルを `documents/` にコピーする）ので、ふつうこのファイルを見ることはない。 |

スペースの下のそれ以外のすべて（`memory/**`、`knowledge/**`、`codekb/**`、`intents.json`、
各記録の `aidlc-state.md`、`audit/` のシャード、成果物）はコミットされます。目安は、
**カーソルと実行時のスクラッチはローカル、共有された作業はコミット** です。

pull・rebase・stash pop が、ある記録の `aidlc-state.md` に git の衝突を残したとき（二つの
クローンが同じ作業を進めた）、次のステップはあなた自身の側から続け、git のマーカーなしで
記録を書き戻します。もう一方がどこにいるか、そしてそれを採る git コマンドを、一度だけ言い
ます。git は、あなたが add するまでそのファイルを衝突として示します。

`knowledge/documents/` と `knowledge/documentkb/` はどちらもコミットされますが、別々の当事者
が所有しており、その違いが設計のすべてです。`documents/` はあなたの原本を持ちます。そこで
ファイルを足し・動かし・消し、フレームワークがそれらを整理し直すことはありません。
`documentkb/` はツールが導く目録で、ワークスペースロックの下でトランザクショナルに書かれ
ます。その **索引** は再構築できます。`documentkb/index.json` だけを消せば、
`/aidlc knowledge sync` が、生き残った文書ごとの `metadata.json` ファイル（tombstone を含む）
からそれを作り直します。`documentkb/` ツリー全体を消すのは、別の、回復不能な操作です。
すべての `metadata.json` も壊すので、文書 id と tombstone は失われます。`sync` はそのとき、
生き残った原本を新しい id の新しい行として再オンボードします。これが、`documentkb/` の手編集が
近道ではなく誤りである理由でもあります。次の `sync` が、`documents/` が実際に持つものに
それを調停し戻すからです。

---

## 次のステップ

- [フェーズとステージ](04-phases-and-stages.md) — 一つの intent の実行の中で何が起こるか
- [ナレッジ](08-knowledge.md) — スペースの `knowledge/` にチームの基準を足す
- [ルールと学習ループ](09-rules-and-the-learning-loop.md) — スペースの `memory/` のやり方がどう書かれ学ばれるか
- [成果物リファレンス](14-artifacts-reference.md) — intent ごとの記録ディレクトリの詳細
- [CLI コマンド](12-cli-commands.md) — `space` / `intent` 動詞の完全な参照
- [用語集](glossary.md) — スペース、intent、記録ディレクトリ、複数リポジトリ intent の定義

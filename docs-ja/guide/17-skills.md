# スキルとランナーコマンド

**AI-DLC はコマンドの集合体です。** `/aidlc` オーケストレーターに加えて、タイプして使える一語のランナーコマンドが用意されています。スコープごとに1つ、ステージごとに1つ、そしてセットアップ用に1つです。これらはオーケストレーターがすでに公開しているスライスへの入り口なので、`/aidlc` だけでフレームワーク全体にたどり着けますし、フラグを省いて使いたい入り口を直接タイプすることもできます。

> **ハーネスに関する注記。** この章では Claude Code の画面を使って説明します。スキルは `.claude/skills/` 以下に置かれ、ピッカーから先頭の `/` を付けてタイプします。Kiro は同じランナーセットを `.kiro/skills/` 以下に用意し（こちらも `/` でタイプ）、Codex は `.agents/skills/` に用意して `$` でタイプします（`$aidlc-bugfix`）。ランナーの*セット*と各ランナーの動作はハーネス間で同一で、ディレクトリとプレフィックスだけが異なります。[Running on other harnesses](harnesses/README.md) を参照してください。

---

## 多数のスキル、1つのエンジン

この実装が同梱するすべてのコマンドは `.claude/skills/` 以下のスキルです。いずれも同じ決定的なエンジンを動かし、起動前に何を組み込んでおくかだけが異なります。

- **`/aidlc`** — フルオーケストレーターです。フラグは組み込まれていません。やりたいことを説明すると、エージェントがそれに合うプランを提案し、あなたが確認すると、プラン内のすべてのステージを完了まで進めます。もっともよく使うものです。
- **スコープランナー** — `/aidlc-bugfix`、`/aidlc-express`、`/aidlc-feature`、`/aidlc-mvp`、`/aidlc-security-patch`。同じフルワークフローで、スコープが固定され、提案するプランはありません。
- **ステージランナー** — `/aidlc-domain-design`、`/aidlc-code-generation` ほか28種類。1つのステージを単独で実行し、メインのワークフローには一切触れません。プラグイン所有のステージは、`/test-pro-integration` のように、プラグインのプレフィックスを付けた素のコマンド名を使います。
- **`/aidlc-init`** — 作業を1つ開始します。`--scope <name>` と説明を渡すと、intent を作成し（Initialization フェーズ全体を実行）、1ステップで止まります。`--scope <name>` だけなら、まだ何も作らず、作業の目的を尋ね、あなたの回答で開始します。説明だけなら、まず `/aidlc` と同じプラン提案を表示し、その後 `/aidlc` と同じように続行します。`/aidlc` と違い、スコープ名で始まる説明（"feature flags for billing"）も説明として読まれます。進行中の作業はそのまま残り、新しい作業がその隣で始まります。
- **セッションスキル** — `/aidlc-session-cost`、`/aidlc-replay`、`/aidlc-outcomes-pack`。ワークフローに対する読み取り専用ビューで、[Session Management](11-session-management.md) で扱います。
- **`/aidlc-compose`** — 適応型コンポーザーです。あなたのタスクを読み、それに合うステージを提案し、承認後はそれ自身のプランとして実行します。`/aidlc compose` と同じです。[The Adaptive Composer](05-scopes-and-depth.md#the-adaptive-composer) を参照してください。
- **`/aidlc-knowledge`** — DocumentKB です。チーム自身のドキュメント（PDF、Word ファイル、Markdown、プレーンテキスト）をスペースごとのカタログにインデックスし、エージェントが引用できるようにします。セッションスキルと同様にスタンドアロンですが、読み書き可能です。カタログを変更し、ドキュメント監査イベントを発行します（ワークフロー状態には触れません）。`/aidlc knowledge <verb>` と同じ画面です。動詞については [CLI Commands](12-cli-commands.md) を参照してください。

ランナーができることはすべて、`/aidlc` にフラグを付けて到達できます。ランナーはパッケージングです。`/aidlc-bugfix` とタイプして `/` メニューに表示されるのは使い勝手の良さであって、それ以上のものではありません。すべてのランナーを削除すればショートカットは消えますが、機能は残り、`/aidlc` のフラグから到達できます。

生成されるランナーは、ホストが許す限り**明示的呼び出しのみ**です。Claude Code、Cursor、GitHub Copilot（VS Code と CLI）では各ランナーに `disable-model-invocation: true` が付き（Codex では `agents/openai.yaml` に `allow_implicit_invocation: false`）、エージェントが自分からランナーを起動することはなく、その説明はモデルが毎ターン読むスキル一覧にも現れません。ランナーはあなたがタイプして起動します。ヘッドレスの `copilot -p "/aidlc-bugfix ..."` でもランナーは実行されます。Copilot はタイプされた行をテキストとしてエージェントに渡し、同梱の `AGENTS.md` がそのランナーのファイルを読むようエージェントに指示します。Kiro CLI、Kiro IDE、opencode にはこの設定がないため、そこではエージェントが自分からランナーを起動できます。`/aidlc` はランナーではなく、エージェントが引き続き使えます。

---

## スコープランナー — 問題クラスごとの名前付きの入り口

スコープランナーは、1つのスコープを固定してフルワークフローを動かします。どういう種類の作業かがすでに分かっていて、プラン提案を省きたいときに使います。

```
/aidlc-bugfix          Fix a specific bug
/aidlc-express         Lightest run: requirements to deploy, no design pass, no reviewers
/aidlc-feature         Full lifecycle for new features, practical depth
/aidlc-mvp             Skip operations, ship the core
/aidlc-security-patch  CVE response
```

いずれもオーケストレーターに `--scope` を渡すのと同じです。

```
/aidlc-bugfix          ==  /aidlc --scope bugfix
/aidlc-express         ==  /aidlc --scope express
/aidlc-feature         ==  /aidlc --scope feature
```

`/aidlc` に渡すのとまったく同じように、説明とフラグをそのまま渡せます。

```
/aidlc-bugfix The profile API returns 500 when display_name is null
/aidlc-feature --status
```

**コアスコープのうち5つがランナーを同梱します。** スコープファイルで `runner: true` が付いた、利用頻度の高いものです。フレームワークは合計11個のスコープを定義します（[Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) を参照）。それ以外の `enterprise`、`poc`、`infra`、`refactor`、`classic`、`workshop` は常にオーケストレーターから到達できます。プラグイン所有のスコープも `runner: true` を設定でき、そのランナーは `/test-pro-validation` のように、プラグインのプレフィックスを付けた素のスコープ名を使います。

```
/aidlc --scope enterprise
/aidlc --scope poc
```

ワークフローが始まると、そのスコープは `aidlc-state.md` に固定されるため、同じランナーを再実行するとワークフローを再開し、やり直しにはなりません。別のスコープで動かすには、`/aidlc --scope <name>` を使います。

---

## ステージランナー — 1つのステージだけ実行し、ワークフローはそのまま

ステージランナーは**1つのステージを単独で**実行します。そのステージに設定されたエージェントとレビュアーを使い、合成的な完了を記録し、ワークフローの学習や承認ゲートなしで止まります。メインワークフローの `Current Stage` を進めることはなく、ツール自体がその隔離を強制します。

```
/aidlc-domain-design
/aidlc-code-generation
/aidlc-requirements-analysis
/aidlc-reverse-engineering
```

いずれも `/aidlc --stage <slug> --single` をパッケージ化したものです。

```
/aidlc-code-generation    ==  /aidlc --stage code-generation --single
```

### どんなときに使うか

- **ワークフローにコミットせず、方法論の一部だけを適用する。** ある問題について要件分析をしたいけれど、ライフサイクル全体を動かす準備はできていない。`/aidlc-requirements-analysis` を実行し、成果物を得て、止めます。
- **あなた自身がオーケストレーターの場合。** 作業を手で並べていて、目の前のステージだけをフレームワークに実行させたい。人が主導し、フレームワークは方法論のステージを1つ供給します。
- **ステージを単独で再実行する。** メインワークフローが別の地点でパークされている間に行います。この実行はワークフローを動かしません。すでにあるファイルをコピーしたうえで、作業を保管する場所にそのステージのドキュメントを書き出します。

### なぜ安全か

`--single` の不変条件はツールで強制されます。`next --single` は作業開始前に隔離された開始を記録します。`report --single` はその同じ合成的な試行だけを閉じることができ、開始のない直接の完了は拒否します。どちらの操作もメインワークフローの `Current Stage` を書き換えません。ランナーがメインのポインタを進めようとすれば、エンジンはエラーを返します。作業の記録にすでにそのステージのファイルがある場合、`next --single` は実行開始前にそれらをその記録内の `archive/<time>-<stage>/` にコピーし、1行でそのフォルダ名を示します。

3つのブートストラップ用の **initialization** ステージにはステージランナーがありません。intent を半分だけ作ることには単独の意味がないからです。代わりに initialization フェーズ全体が1つのコマンドとしてパッケージ化されています。

```
/aidlc-init --scope <name> <description>   create the intent in one step, then stop
/aidlc-init --scope <name>                 ask what the work is for, then start it
/aidlc-init <description>                  plan offer first, then continue (a leading scope name is part of the description)
```

---

## ランナーファミリー一覧

| ファミリー | 例 | 何をするか | オーケストレーターでの等価表現 |
|---|---|---|---|
| Orchestrator | `/aidlc` | フルワークフロー。確認用にプランが提案される | - |
| Scope-runner | `/aidlc-bugfix`、`/aidlc-express`、`/aidlc-feature`、`/aidlc-mvp`、`/aidlc-security-patch` | フルワークフロー。スコープ固定、確認するプランなし | `/aidlc --scope <name>` |
| Stage-runner | `/aidlc-domain-design`、`/aidlc-code-generation` ほか（合計30） | 1ステージを単独で実行。ワークフローは進めない | `/aidlc --stage <slug> --single` |
| Init wrapper | `/aidlc-init` | 作業を開始する。`--scope` と説明があれば1ステップで作成、`--scope` だけなら目的を先に尋ね、説明だけならプラン提案を先に出す | `/aidlc --scope <name>`、または新規ワークスペースでの `/aidlc <description>`（先頭のスコープ名は例外） |
| Session views | `/aidlc-session-cost`、`/aidlc-replay`、`/aidlc-outcomes-pack` | 読み取り専用のワークフローレポート | [Session Management](11-session-management.md) を参照 |
| Composer | `/aidlc-compose` | タスクに合わせたプランを提案し、承認後に実行する | `/aidlc compose` |
| Document knowledge | `/aidlc-knowledge` | チーム自身のドキュメントをインデックスし読む（スペースごとの DocumentKB） | `/aidlc knowledge <verb>` |

ライフサイクル内の実行可能なステージごとに、ステージランナーが1つあります。全セットを見るには、スキルディレクトリを一覧表示します。`aidlc config` で Claude Code 向けにセットアップされたプロジェクトでは（省略表示）、次のようになります。

```text
$ ls .claude/skills/
aidlc
aidlc-approval-handoff
aidlc-bugfix
aidlc-build-and-test
aidlc-ci-pipeline
aidlc-code-generation
aidlc-compose
...
aidlc-session-cost
aidlc-team-formation
aidlc-units-generation
aidlc-user-stories
```

これは42個のエントリです。`/aidlc`、30個のステージランナー、5個のスコープランナー、`/aidlc-init`、`/aidlc-compose`、`/aidlc-knowledge`、そして3個のセッションスキルです。

---

## 自分のランナーを書く — ステージファイルを書く

フレームワークをカスタマイズするなら、ここが肝心です。**ランナーは手書きしません。** コンパイル済みのステージグラフとスコープファイルから生成されます。

ステージランナーを追加するには、ステージを追加します。ステージファイルを書き、グラフを再コンパイルし、再生成します。

```bash
aidlc engine gen runners
```

ジェネレーターはコンパイル済みのステージ一覧（唯一の真実のソース）を読み、実行可能なステージごとにランナーのシェルを出力します。新しいステージの `/aidlc-<your-stage>` コマンドは自動的に現れます。書くランナーファイルも、コピーするボイラープレートもありません。スコープランナーも同じように、フロントマターで `runner: true` を宣言したスコープについて動作します。`scopes --all` はすべてのスコープファイルについてランナーを出力します。

```bash
aidlc engine gen runner-scopes      # generate scope-runners
```

ランナーのセットは手入力ではなく派生されるため、対象となるステージやスコープからずれることがありません。ディスク上のセットが真実のソースと食い違った瞬間に、2つのチェックが CI を失敗させます。

```bash
aidlc engine gen runners --check             # stage-runner drift
aidlc engine gen runner-scopes --check       # scope-runner drift
```

何もずれていないプロジェクトでは、ステージランナーのチェックはこう表示します。

```text
$ aidlc engine gen runners --check
stage-runner set is in sync with the compiled stage graph (30 runners).
```

ランナーを再生成せずにグラフへ追加されたステージ、あるいは消えたステージの孤児ランナーは、差分とともに明示的に失敗します。ステージファイルを追加して再生成することが、オーサリングの全工程です。ランナーは、ジェネレーターがあなたに代わって維持する帰結として付いてきます。

ステージファイルを書く仕組みについては、[Customization](13-customization.md) と [Phases and Stages](04-phases-and-stages.md) を参照してください。エンジン、ディレクティブ契約、ランナーのシェルが内部で `next`/`report` をどう動かすかについては、リファレンス章の [Skill System](../reference/17-skill-system.md) を参照してください。

---

## クイックリファレンス

```
# Full workflow
/aidlc                              propose a plan, run everything
/aidlc --scope enterprise           any of the 11 scopes

# Scope-runners (the 5 high-traffic doors)
/aidlc-bugfix · /aidlc-express · /aidlc-feature · /aidlc-mvp · /aidlc-security-patch

# One stage, isolated (never advances your workflow)
/aidlc-code-generation              == /aidlc --stage code-generation --single

# Start a piece of work (Initialization phase)
/aidlc-init --scope <name> <desc>   create it in one step, then stop
/aidlc-init --scope <name>          ask what the work is for, then start it
/aidlc-init <description>           plan offer first, then continue

# Add your own: write a stage/scope file, then
aidlc engine gen runners
aidlc engine gen runner-scopes
```

関連項目: [CLI Commands](12-cli-commands.md) · [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) · [Customization](13-customization.md)

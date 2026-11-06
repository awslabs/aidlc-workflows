# カスタマイズ

AI-DLC は、チームのニーズに合わせられるよう設計されています。この章では、設定のオーバーライド、スコープの構成、ステージのカスタマイズ、ステータスライン、ツールの権限を扱います。

> **ハーネス固有の設定。** ハーネスに依存しないカスタマイズ（スコープの構成、ステージの深さ、知識、ルール）は、どのハーネスでも適用されます。この章の仕組みレベルの設定（`settings.json` / `settings.local.json`、statusline コマンド、`$CLAUDE_PROJECT_DIR`、ツール権限のブロック）は **Claude Code 固有** です。Kiro CLI は `.kiro/settings/cli.json` とそのエージェント設定で同等のものを構成します。Kiro IDE はエージェントの Markdown の `tools:` と `permissions.rules` を使います。Codex は `.codex/config.toml` と Starlark のルール、Cursor は `.cursor/hooks.json` と `.cursor/cli.json`（権限のみ）、opencode はプロジェクトルートの `opencode.json`、Copilot は `.github/hooks/aidlc.json`（フックの結線）と `~/.copilot/config.json`（フォルダの信頼）を使います。各ハーネスの画面については、[Running on Kiro CLI](harnesses/kiro-cli.md)、[Running on Kiro IDE](harnesses/kiro-ide.md)、[Running on Codex CLI](harnesses/codex-cli.md)、[AI-DLC on Cursor](harnesses/cursor.md)、[AI-DLC on opencode](harnesses/opencode.md)、[AI-DLC on GitHub Copilot](harnesses/copilot.md) を参照してください。

---

## 設定のオーバーライド（`settings.local.json`）

共有の `.claude/settings.json` はプロジェクトのもので、バージョン管理にコミットされます。AI-DLC は、あなたのフック、deny ルール、カスタムの `statusLine`、環境、その他の設定を保ちながら、自身のフック登録とコマンドの allow エントリをリフレッシュします。注記が、何が復元または保持されたかを説明します。このファイルに `--force` は不要です。退役した出荷時 allow エントリは自動では削除されません。チームに影響を与えずに、自分のローカル環境向けに設定をオーバーライドするには、個人用のオーバーライドファイルを作ります（たとえば AI-DLC のステータスラインが自分向けにオンになっているなどの理由で `.claude/settings.local.json` がすでにある場合は、上書きコピーせず、そこに自分のキーを追加します）。

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

このファイルは `.gitignore` に載っているため、あなたの個人的な変更がコミットされることはありません。次の用途に使います。

- モデル選択のオーバーライド（たとえば別の Opus や Sonnet のモデル ID への切り替え）
- 自分のローカルセットアップ向けの環境変数の設定
- 自分のセキュリティ要件に合わせたツール権限の調整

---

## エージェントのモデルとエフォート（ティア）

出荷時のエージェントは `tier:`（`judgment` | `balanced` | `templated`）付きで作られ、ビルドがそれを各ハーネスのネイティブなモデル/エフォートキーに射影します。記録されたモデルポリシーがない場合、judgment と templated のエージェントはセッションのモデルとエフォートを継承します。balanced のレビュアーは Claude Code では Sonnet を medium エフォートで使い、Codex と opencode はセッションのモデルを継承し各自の medium の推論設定を適用します。Kiro、Cursor、Copilot ではすべてのティアがセッションのモデルとエフォートを継承します。射影テーブルの全体は [Agent System](../reference/05-agent-system.md) を参照してください。

初回実行のウィザードは `balanced` の **プリセット** をデフォルトにします。これはレビュアーの **ティア** とは別物で、3つのグループすべてに medium エフォートを記録します。Kiro IDE、Cursor、Copilot ではプリセットを記録しません。そこではエージェントがセッションのモデルとエフォートを保つためです（Kiro では、そのエージェントにモデルやエフォートが設定されていない限り）。プリセットの選択は `aidlc config models --preset balanced --project --yes` で行います。

| プリセット | 判断 | レビュー | 書き上げ |
|--------|----------|-----------|------------|
| `thorough` | session effort | `xhigh` | session effort |
| `balanced` | `medium` | `medium` | `medium` |
| `minimal` | `medium` | `medium` | `low` |

プリセットはエフォートだけを設定し、モデル ID は決して設定しません。エージェントごとの例外はグループのダイヤルをオーバーライドし、グループのダイヤルは出荷時のティアのデフォルトをオーバーライドします。Kiro IDE、Cursor、Copilot はこれらのグループエフォートのダイヤルを表現できません。そこに記録したポリシーは保持され、効かないキーとして書かれることはなく、表現できなかったものとして報告されます。Kiro CLI は各セッションを1つのモデルで実行するため、そこではプリセットが対話セッション全体に1つのエフォートを設定し（`minimal` は low、`balanced` は medium、`thorough` は extra-high）、セッションのモデルとともにあなたの個人用 Kiro 設定に保存されます。[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort) を参照してください。明示的なグループダイヤルには、依然として Kiro CLI の画面がありません。プロファイル、オーバーライド、アップグレードのパスについては [Model Policy](18-install-and-lifecycle.md#model-policy) を参照してください。

1つのエージェントのエフォートを変えるには、`aidlc config models --agent <name> --effort <low|medium|high|xhigh|max> --project --yes` を実行します。モデルを固定するには、`--effort` の代わりに `--model <id>`（インストールで有効なモデル ID）を使うか、両方を渡します。`--effort default`（または `--model default`）はそのエージェントの該当設定だけを取り除き、プリセットやグループが再び適用されます。コマンドはそれを変更の undo として表示します。`--project` の代わりに `--local` を使うと、変更を自分だけにとどめます。config は変更を設定ファイルに記録し、それをもとにそのエージェントのファイルを書き換えます。config が書き込む場所で `aidlc-*-agent` ファイルを手編集しないでください。`aidlc config models --check` は手編集をドリフトとして報告し、次の `aidlc config` が記録された値を戻します。Claude Code、Codex、opencode は、1つのエージェントについてモデルとエフォートの両方を受け取ります（Codex は `max` を `xhigh` として、opencode は `xhigh` を `high` として実行します）。Kiro CLI はモデルを受け取り、エフォートはモデルと一緒のときだけ受け取ります。Kiro IDE（および v3 エンジンの Kiro CLI）は、1つのエージェントについてモデルとエフォートの両方を受け取り、そのエージェントの `.kiro/agents/aidlc-<name>-agent.md` に書き込みます（[One agent on its own model and effort](harnesses/kiro-ide.md#one-agent-on-its-own-model-and-effort)）。プリセットやグループのエフォートはそこでは何も変えません。Cursor と Copilot では、すべてのエージェントがセッションのモデルとエフォートを保ち、コマンドはそこで適用できなかったものを伝えます。ソースから自分のディストリビューションをビルドする際に、すべてのエージェントの上限を設けるには、`core/memory/org.md`/`project.md` のフロントマターに `tier_cap:` を設定するか、パッケージャーを `AIDLC_TIER_CAP=<tier>` で実行します。どちらも `bun scripts/package.ts` のパック時のつまみで、ランタイムの設定とは別です。

---

## プロジェクトごとのデフォルトスコープ

プロジェクト内のすべてのワークフローを同じスコープで始めるべきときは、`.claude/settings.json` の `env` ブロックに `AWS_AIDLC_DEFAULT_SCOPE` を設定します（出荷時のファイルはこれを `classic` に設定済みで、フレームワークのハードコードされたフォールバックと一致します。既定でフルのライフサイクルを走らせるには `feature` に設定します）。

```json
{
  "env": {
    "AWS_AIDLC_DEFAULT_SCOPE": "feature"
  }
}
```

出荷時の `env` ブロックには AI-DLC のスコープのデフォルトしか含まれません。プロバイダーとモデルの設定は Claude Code とユーザーが所有し続けます。

これを設定すると、暗黙のスコープ解決は `feature` を使います。あるいは、`aidlc config flags --default-scope feature --project --yes`（このチェックアウト向けなら `--local`）でプロジェクトのデフォルトを記録します。実際の `AWS_AIDLC_DEFAULT_SCOPE` 環境変数は記録されたフラグに勝ちます。したがって、出荷時の設定の env エントリは、あなたがそのエントリを変更または削除するまで権威を持ち続けます。intent の `aidlc-state.md` が（その記録ディレクトリの下に）存在すると、そのスコープが権威を持ち、暗黙のデフォルトの変更は進行中のワークフローを変えません。

**優先順位（高いものから低いものへ）:**

1. 明示的な CLI フラグ: `/aidlc feature` や `/aidlc --scope bugfix` が勝ちます。
2. フリーテキストに対してエージェントが提案するプラン: `/aidlc fix the login bug` は依然として `bugfix` が提案され、`/aidlc-init "fix the login bug"` も同様です。ユーザーは既存の確認プロンプトで、提案されたプランをオーバーライドできます。
3. 実際の `AWS_AIDLC_DEFAULT_SCOPE` 環境変数。`.claude/settings.json` が供給する値を含みます。
4. 記録された `aidlc config flags --default-scope` の値（ローカル設定は共有のプロジェクト設定をオーバーライドします）。
5. `classic` — 一致しないフリーテキストの解決や、`--scope` なしの直接の `intent-create` 呼び出しが使う、フレームワークのフォールバック。`--scope` なしで説明を伴う `/aidlc-init` は、代わりに `/aidlc` と同じプラン提案を表示します。

**有効な値:** `enterprise`、`feature`、`mvp`、`poc`、`bugfix`、`refactor`、`infra`、`security-patch`、`classic`、`workshop`、`express`。無効な値は、呼び出し時に明確なメッセージでエラーになります。チームは `.claude/scopes/aidlc-<name>.md` ファイルを置き、メンバーステージの `scopes:` リストにタグ付けすることで、追加のスコープを定義できます。[Contributing: Adding a Scope](../reference/11-contributing.md#adding-a-scope) を参照してください。チームは `.claude/agents/` に追加のエージェントも定義できます。[Contributing: Adding an Agent](../reference/11-contributing.md#adding-an-agent) を参照してください。

**設定の検証:** `/aidlc --doctor` を実行して、構成されたデフォルトスコープが有効であることを確認します（環境と記録されたデフォルトはこのチェックを共有します）。出荷時の値では、その詳細リストに次が含まれます。

```text
  ok    AWS_AIDLC_DEFAULT_SCOPE=classic (valid)
```

Claude Code の外のターミナルでの `aidlc doctor` は `.claude/settings.json` から `env` ブロックを得ないため、そこでは、あなたのシェルが `AWS_AIDLC_DEFAULT_SCOPE` を設定しているか、`aidlc config flags --default-scope` でデフォルトが記録されているときにだけこの行が表示されます。作業が走るスコープは、`/aidlc --status` の `Scope:` 行に表示されます。

なぜスコープだけで、深さやテスト戦略ではないのか。各スコープは深さを宣言し、テスト戦略は、スコープがオーバーライドしない限りその深さを継承します。したがって `classic` は Standard/Standard、`workshop` は Standard/Minimal、`express` は Minimal/Minimal で始まります。どちらかをオーバーライドする必要があれば、CLI で `--depth` または `--test-strategy` を渡します。

**機密の値:** `.claude/settings.json` はバージョン管理にコミットされます。シークレット、資格情報、個人のオーバーライドをここに置かないでください。機密なものには `.claude/settings.local.json`（gitignore 済み）を使います。

---

## スコープの構成

スコープは、どのステージがどの深さとテスト戦略で実行されるかを制御します。AI-DLC は11個の名前付きスコープを提供します。全体の表（EXECUTE/総ステージ数、デフォルトの深さ、テスト戦略、各スコープのユースケース）は、[Scopes, Depth, and Test Strategy § The 11 Core Scopes](05-scopes-and-depth.md#the-11-core-scopes) が唯一のソースです。このセクションでは、それらを *構成* しオーバーライドすることを扱います。

### スコープを選ぶ

明示的に指定するか、あなたの言葉からエージェントに提案させます。

```
/aidlc enterprise       # Explicit scope
/aidlc Build a payments API  # The agent proposes a plan, or offers to tailor one
/aidlc Fix the login bug     # The agent proposes "bugfix"; you confirm
```

### ランタイムでのオーバーライド

ワークフローのどの時点でもスコープをオーバーライドできます。

- **どの承認ゲートでも**: 別のスコープや深さを求めます
- **ユーティリティコマンド経由**: `/aidlc --scope enterprise` がアクティブなスコープを変えます
- **ステージの組み入れ**: Ideation と Inception の承認ゲートで、以前に飛ばしたステージをワークフローに戻せます

---

## Intent の構成

9つの intent 設定は、`depth`、`test-strategy`、`review`、`guard-policy`、`sensors`、`learnings`、`summary-confirmation`、`plan-approval`、`collaborators` で、この順です。さらに3つのキー、`guard.review-freeze`、`guard.state-transition`、`guard.reviewer-scope` は、1つの作業について1つのガードをオフまたはオンに切り替え、`guard.plan-approval` は `plan-approval` の別名です。CLI のルートは1つのアトミックなセッター `config-change` を共有します。設定付きでタイプされた `/aidlc` の行は、human-turn フックが丸ごと記録しますが、何も適用しません。エージェントがその行についてそのセッターを一度実行し、行上のすべての設定を1つのトランザクションで検証し適用します。設定は別々の更新に分けず、1つのコマンドにまとめます。

```
/aidlc --depth standard --test-strategy minimal --review advisory --guard-policy relaxed --sensors off --learnings on --summary-confirmation off
/aidlc config set guard-policy strict --sensors on --learnings on
/aidlc --scope bugfix --review none --guard-policy relaxed --sensors off
```

ネイティブでの同等は、`aidlc engine config set <key> <value>` に残りの `--key value` フラグを続けたものです。`config get <key>` は13個すべてのキーを受け取り、`config list`（任意で `--json`）は、Guard Policy、切り替え可能なフェンス、儀式の実効値とソースを含む13個すべてを返します（`guard.plan-approval` は `plan-approval` の別名で、同じものを読みます）。

```
/aidlc config get guard-policy
/aidlc config get plan-approval
/aidlc config get summary-confirmation
/aidlc config list --json
```

タイプされた `config set`、`get`、`list` のリクエストはディスパッチ中に実行され、ターンが終わる前にコマンドの実際の出力を返します。拒否された設定はそのエラーを返します。成功した設定はワークフローを進めません。タイプされた `/aidlc` の行で下げられたガードは同じセッターを通り、エージェントが行ごとに一度実行します。フックは何も適用しません。

追加の読み取り専用の `guard.human-presence` ルックアップは `on (default)` または `off (env AIDLC_SKIP_HUMAN_PRESENCE_GUARD)` を報告します。これは作業ごとの設定とは別物で、`config list` には含まれません。

`config-change` は、それらの設定フラグと `--intent`、`--space`、`--project-dir` のセレクタだけを受け取り、少なくとも1つの設定が必要です。たとえば次のようにです。

```bash
bun .claude/tools/aidlc-utility.ts config-change --guard-policy relaxed --sensors off --intent login-fix --space platform --project-dir /work/shop
```

タイプ形式の `/aidlc config set guard-policy relaxed --intent <name> --space <name>` と `/aidlc --guard-policy relaxed --intent <name> --space <name> ...` は、エージェントのセッターがスイッチを適用する intent とスペースを指定します。フラグ形式の末尾の `...` は、任意のタスク説明を表します。存在しない名前付き intent は拒否されます。状態ファイルがない場合、行上のすべての設定（Guard Policy、plan approval、フェンスのスイッチ、儀式、collaborators、深さ、テスト戦略、review）は、このチャットが次に始める作業のために保持され、エージェントが1行でそう伝えます。どの作業も存在しない前に Claude Code のチャットでタイプした `/aidlc --test-strategy minimal` は、次を得ました。

```text
Test strategy will be minimal for the piece of work you start now (set by you).
```

セレクタは、アクティブなカーソルを切り替えずに、状態、メモリポリシー、監査について同じ intent を対象にします。供給された値はすべて変更の前に検証され、無効な値や未知のフラグは、問題のフラグを示して更新全体を拒否します。メモリで強制された strict ポリシーは、明示的な `relaxed` または `off` の Guard Policy 設定を、すべての付随設定やスコープ変更とともに拒否します。明示的な strict と無関係な設定は許可されたままです。1つのロックが、状態の読み取り、共有のアプライヤー、監査バッチ全体、1回の状態書き込みをカバーします。監査の失敗は状態を変えずに残します。`Last Updated` は、来歴の変更を含む、実際に保存された変更についてのみ変わります。同じ保存済みの選択の繰り返しは何もしません。

スコープ変更は同じフラグを受け取り、同じアプライヤーを使います。現在と同じスコープでも、供給された設定は適用されます。スコープが所有する Guard Policy は、より厳しい新しいデフォルトに従います。より低い新しいデフォルトは、あなたがスコープ変更を求めたときにだけ従い、そうでなければ現在の値が残り、出力が1行でそう伝えます。儀式の行は、新しいスコープのデフォルトを引き続き追跡します。明示的なオーバーライド（`set by you` または `set by a command`）と、欠けているレガシーの行は保持されます。メモリは引き続き実効ポリシーを制御します。明示的なフラグは明示的な来歴を記録し、`config-change` と同じ引き下げ要件に従います。新しいスコープ自身のレベルと等しい review レベルは `Review Override` フィールドを空文字列にクリアするので、ステージの宣言とそのスコープの review キャップが適用されます。それ以外のレベルは、この作業についてキャップを置き換えます。

### 儀式のスイッチ

スコープは5つの独立した儀式のデフォルトを所有します。それぞれ `on` または `off` を受け取ります。出荷されるすべてのスコープは、デフォルトに頼らず、5つすべてを明示的に宣言するようになりました。1つを省くスコープファイルは、依然として `on` にフォールバックします。Classic は sensors、learnings、plan approval を `on`、summary confirmation を `off` に設定します。Bugfix は learnings と summary confirmation を `off` に設定し、sensors と plan approval を `on` に保ちます。Express は最初の4つをオフにします。poc は plan approval もオフにします。`collaborators` は on デフォルトの例外です。`enterprise` でのみ on で出荷され、他のすべてのスコープでは off なので、初回の実行は軽量で、チームは意図的に collaborators を再度有効にします。

| スコープキー | intent ごとのフラグ | グローバルキルスイッチ | off が取り除くもの |
|-----------|-----------------|--------------------|------------------|
| `sensors` | `/aidlc --sensors on\|off` | `AIDLC_DISABLE_SENSORS=1` | Sensor の実行とそのゲートチェック |
| `learnings` | `/aidlc --learnings on\|off` | `AIDLC_DISABLE_LEARNINGS=1` | ステージの learnings の読み書きの儀式 |
| `summary_confirmation` | `/aidlc --summary-confirmation on\|off` | `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1` | 出力前の独立したサマリー確認チェックポイント |
| `plan_approval` | `/aidlc --plan-approval on\|off` | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` | 各コードプランがビルドされる前に承認を求める停止（[Plan approval](#plan-approval)） |
| `collaborators` | `/aidlc --collaborators on\|off` | `AIDLC_DISABLE_COLLABORATORS=1` | ステージの支援エージェント。off はすべてのステージをリードのみで実行する（ブラインドのスポーク、mob ラウンド、パイプラインの支援リンクなし）。レビュアーは影響を受けない |

優先順位は、グローバルキルスイッチ（`1`）→ 有効な intent フィールド → スコープのデフォルト → `on` です。キルスイッチは `aidlc config flags --bypass <NAME>` でも記録できます。新しい intent は `aidlc-state.md` の `Guard Policy` の後に `Sensors`、`Learnings`、`Summary Confirmation`、`Plan Approval`、`Collaborators` を、それぞれ `on (from scope classic)` のようなソースラベル付きで保存します。この作業向けに構成されたプランでは、`--status` はそのラベルを `(from the approved plan)` と表示します。状態ファイルはスコープを保ちます。ラベルは、記録があなたが求めたことを示すとき `set by you` と読めます。自分の行でスイッチをフラグとしてタイプした（設定をその隣にタイプして）、自分のターミナルでコマンドを実行した、あるいは自分の言葉で求めてエージェントがあなたが求めたメッセージをセッター（`--message <id>`）で指定した場合です。エンジンは、それがこのチャットの、後の決定で使い切られていない、あなたのものであることを証明します。あなたのメッセージ全体が監査行に載ります。それを求めなかった返答（「looks good, carry on」）の後にエージェントが自分で実行する設定も、効力を持ち、`set by a command` と読めます。リクエストとともにタイプする sensors、learnings、summary confirmation（`/aidlc --learnings on build the export`）、またはどの作業も存在しない前にタイプしたものも、そのリクエストが作る作業について `set by you` と読めます。あなたがそのチャットで求めた後、新しい作業を始めるコマンドが運ぶ plan approval や Guard Policy も同様です。エンジンは、コマンドに代えてあなたの言葉をフラグの背後に置きます。あなたのメッセージが背後にない、エージェントが自分で加えるフラグは、エージェントやスクリプトが実行するコマンドによって作られ、`set by a command` と読めます。進行中の作業への変更は、どちらにせよ `CEREMONY_SET` を記録します。新しい作業を始めるコマンドのフラグは、それなしで新しい状態ファイルに保存されます。進行中の作業について summary confirmation や plan approval をオフにするには、あなた自身のターンが必要です。エージェントが実行すると、それをタイプするよう求めるメッセージとともに拒否されます。フックにメッセージテキストを渡さない Kiro IDE のビルドでは、タイプすることが機能しないため、拒否は Kiro IDE を更新するよう求めます（[Kiro IDE guide](harnesses/kiro-ide.md#whats-different-on-kiro)）。`/aidlc --status` は実効値とソースを表示します。スコープの変更は、あなたのオーバーライドを保ちながらスコープ由来の設定を更新します。欠けているか不正なフィールドは、実行をブロックせずにスコープにフォールバックします。summary confirmation を、設定またはスコープ変更でオンにすると、その後に走る作業に適用されます。ゲートで待っているステージや、すでに終わったユニット作業は、持っていなかったサマリーを求められません。

コンポーザーは、これら5つに加えてスコープの `review_cap` を compose ゲートで提案し、承認前にそのどれでも変更できます。plan approval は、コンポーザーが自分でオフにすることのない唯一のものです。ゲートで「skip plan approval for this work」と言えば、作業はそれをオフにして作られ、set by you になります。値はこの作業にのみ適用され、ストックのプランでもカスタムでも同様です。スコープとして保存したプランはそれらをフロントマターに保存するので、そのスコープの新しい intent はすべてそれらで始まります。キルスイッチは依然として勝ちます。ゲートは、強制的にオフにする `on` の値をマークし、ワークフローの途中ではエージェントが、どこで設定されているかを探さずに、スイッチはその外で取り除く必要があると1行で伝えます。

名づけた承認そのものである plan approval を除き、これらのスイッチは承認ゲート、human-turn の権限、監査、チームのクロスユニット書き込み保護を取り除きません。Classic は walking-skeleton の儀式をオフにし、ゲート付きフローのレビューを advisory に制限します。明示的な autonomy はマージ前の単一のレビューを保ちます。

隔離された `--single` の試行は、メインの intent の儀式オーバーライドではなく、選択されたスコープのポリシーを使います。そのスコープは合成的なステージ開始イベントに記録され、完了まで固定されます。別のスコープでの再開は拒否されます。記録されたスコープのないレガシーの隔離開始は、summary confirmation を保ち、このスコープ比較を強制しません。

### Plan approval

code generation がコードプランからビルドする前に、AI-DLC はそのプランの承認を求めます。`plan_approval` の儀式が、この作業で求めるかどうかを決めます。

- **On**（express と poc を除く出荷のすべてのスコープ）: 各プランはそのサマリーとパスとともに、**Approve Plan**、**Request Changes**、**I'll edit the files** で表示され、あなたが答えるまで何もビルドされません。
- **Off**（express と poc）: プランが書かれると1行が表示され、ビルドが始まります。

  > Plan written: aidlc/spaces/default/intents/260820-checkout/construction/code-generation/code-generation-plan.md. Plan approval (you approve each code plan before it is built) is off for this piece of work (from scope poc). Starting code generation now. You can ask me to go over the plan at any time.

  監査証跡には、ビルドされたプランのフィンガープリントを運ぶ `PLAN_APPROVAL_SKIPPED` 行が付き、質問ファイルは `[Answer]: Plan approval off` と読めます。あなたが承認したことを記録するものはありません。

**まずプランをレビューする。** plan approval がオフのとき、各プランを示す行は、いつでもそれを確認するよう求められると伝え、ビルドが始まります。あなたの言葉で求めると、そのプランが承認のために表示され、ビルドは待ちます。設定はオフのままです。次のプランは尋ねずにビルドされます。あなたが求めたときにプランがすでにビルド中なら、そのビルドは終わり、次にそのプランがビルドされたものの隣に表示され、あなたが答えるまで他には何も始まりません。承認はビルドされたものを保ちます。あなたが求める変更は、そのユニットの承認ゲートで戻ってきて、そこで **Request Changes** があなたの言葉とともに差し戻します。

**オフにするのはあなただけ。** 自分の言葉で言うか（「skip plan approval for this work」）、`/aidlc --plan-approval off` または `/aidlc config set plan-approval off` をタイプすると、エージェントがセッターを実行します。どちらにせよこの作業に適用され、`CEREMONY_SET` 行を記録します。あなたの答えを待っているプランは、それからビルドされます。plan approval に言及する質問や発言は何も変えません。作業が存在する前、compose ゲートやスコープ確認で、あなたの言葉はそのリクエストに答えます。そこから作られる作業は plan approval がオフ、set by you で始まります。作業を説明する前に言うと、次にあなたが行うリクエストに答えるか、他の作業がここにあってそれを代わりに拾う場合は、その作業に適用され、あなたは一度その旨を聞きます。他のどのリクエストから作られる作業も、そのスコープの値を保ち、先に `/aidlc --plan-approval on` をタイプするとその言葉が取り消されます。エージェントは自分でオフにすることも提案することも決してありません。前回の決定以降あなたからの返答がない状態で実行すると、そのセッターは拒否されます。オンにする（`/aidlc --plan-approval on`）のは、エージェントを含めどこからでも機能し、次のプランから適用されます。`guard.plan-approval` は同じスイッチの別名です。`/aidlc config set guard.plan-approval off` は plan approval をオフにし、`Guards Off` 行を書きません。

**編集されたプラン。** あなたが承認した後に編集されたプランについて再度尋ねるかは、この設定ではなく Guard Policy の判断です。`strict` は再度尋ね、`relaxed` と `off` は1行とともに続行します（[Guard Policy](#guard-policy) を参照）。

**オンに保つもの、どこでもオフにするもの。**

- メモリの `## Guard Policy` セクションに `Mode: strict`（`org.md`、`team.md`、`project.md` のいずれか）があると、express と poc を含め、リポジトリ上の全員について plan approval がオンに保たれます。オフにしようとすると、そのファイルを示す文で拒否され、`/aidlc --status` は `Plan Approval: on (guard policy strict (from project.md))` を表示します。
- マシンのスイッチ `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` は、そのマシン上のすべての作業について plan approval をオフにし、メモリのロックに勝ちます。それが効くのは、ハーネスがそれとともに起動されたとき（session-start フックがそのセッションについて記録します）、`aidlc config flags --bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD` で記録されたとき、またはプロジェクトにハーネスのセッションが記録されていないとき（CI、素の CLI 実行）です。セッション内で自分向けにそれを設定するコマンドは、未設定であるかのように読まれます。そのようにビルドされた各プランは、`Source` にそのスイッチを示して、スキップとして記録されます。

**スコープの変更** は新しいスコープの値に従います。feature から express への移動は plan approval をオフにし、express から feature への移動はオンにします。この作業向けにあなた自身が設定した値は残り、メモリのロックは依然として勝ちます。これは Guard Policy とは異なります。Guard Policy では、より低いスコープのデフォルトは、あなた自身がスコープ変更を求めたときにだけ従い、そうでなければより厳しい値が残ります。

**チームモード。** 各ユニットのプランは、そのユニットの所有者が自分のチェックアウトで承認します。plan approval がオフだと、そこで尋ねずにビルドされ、チームのマージは承認の代わりにスキップの記録を受け入れます。

**Kiro IDE。** フックにメッセージテキストを渡さない Kiro IDE のビルドは、プランをレビューするリクエストを聞けないため、そこではすべてのプランが承認のために表示され続け、1行が、Kiro IDE を更新するとプランが尋ねずにビルドできると伝えます。

`/aidlc --status`、`/aidlc config get plan-approval`、`/aidlc config list` は、実効値とそれがどこから来たかを表示します。たとえば `Plan Approval: off (from scope poc)` です。

### Guard Policy

Guard Policy は、`strict`、`relaxed`、`off` の3つの値を持つ1つの設定です。あなたが取り組む作業について、フレームワークのガードがどこまで身を引くかを決めます。2つのことをカバーします。すでに承認したものが足元で変わっていたと分かったときに何が起きるか、そして5つのフェンスが、誰も求めていない作業に対してどれだけ強く持ちこたえるかです。

**承認済みの入力が変わったとき。** レビュー済みのドキュメントがそのレビューの後に編集された、または出力が現在のサマリー確認なしに保存された場合です。

- `strict` は承認を再度開きます。実行は、何が変わったかを示す1つの平易な文で止まり、再びあなたに尋ねます。あなたの確認が最新で、エージェントがその前に保存したドキュメントが保存し直されていないだけで、まだ何もそれをレビューしていないとき、エージェントはまずそれを保存し直し、それで解消しないときにだけあなたに尋ねます。
- `relaxed` と `off` は進み続けます。変更は監査証跡に `CHANGE_ACCEPTED` 行として一度記録され、あなたはそれについて1行を聞き、実行は続きます。何も削除されません。承認とその証拠はそのまま残ります。

あなたがコードプランを承認した後に他のコードが動いても（`git pull`、別のユニットの着地）、どの値でも再度尋ねることはありません。ただし以下に1つの例外があります。プランの承認はプランとそのテスト指示に関するものです。ビルドは続き、あなたはどのファイルが動いたかを聞き（たとえば `2 files changed since this plan was approved: src/api.ts, src/db.ts. Building auth now.`）、`CHANGE_ACCEPTED` 行がそれを記録します。あなたが取り入れた AI-DLC の更新はあなたの変更ではありません。そのファイルは決して示されず、それらがすべての動いたものだったときは、何も言われず記録もされず、ユニットの並列ビルドが、それらをコミットするよう求めずに始まります。

例外は `strict` のもとでのユニットの並列ビルドです。Code Generation が始まった後にプロジェクトで起きた変更で、ユニット自身の着地、AI-DLC の更新、Git が無視して追跡しないファイルのいずれでもないもの（あなたの編集やコミット、`git pull`）は、次のユニットが着地するのを止めます。`relaxed` と `off` のもとでは、ユニットはその変更を保ったまま着地し、1行がそう伝えます。変更があなたがプランを承認した後に来たものなら、`strict` はユニットがセットアップされる前にプランを再度承認するよう求め、再び承認しても着地での停止は解除されません。進むには、変更を取り消してエージェントに続行を伝えるか、この作業について Guard Policy を `relaxed` に設定し（`/aidlc --guard-policy relaxed`）、ユニットはそれを保ったまま着地します。チームがメモリで `strict` をロックしている場合、そのスイッチはそのファイルを示す行で拒否されるので、そこでは変更を取り消すことが進む道です。

**フェンスがどれだけ強く持ちこたえるか。** `strict` は5つのフェンスすべてを上げたままにします。`relaxed` はプランの再承認とレビューの凍結を下げます。`off` はその2つに加えて、状態遷移とレビュアーの読み取りスコープを下げます。どの値も human presence やクレーム済みチェックアウトのユニット書き込み所有権を下げません。下げられたフェンスも、何かを通すたびに監査行を書きます。

**プラン自体が承認後に変わったとき。** 同じユニットまたはステージのターゲットと試行について、プラン、テスト指示、Testing Contract の編集は、`relaxed` または `off` のもとでは必須の再承認なしに続きます。`strict` のもとでは、それらの編集は承認を再度開きます。編集されたプランについて再度尋ねられます。どちらにせよ、何が変わったかを示す1行が表示されます。たとえば「Your approved plan changed before the build: step 4 now says ... instead of ...」で、エージェントはあなたが承認したプランに戻すかを尋ねます。ビルドがすでに始まっていると、同じ行がビルドが進行中だと伝え、代わりに承認済みのプランをビルドすると申し出ます。はいと言うか、どのチャット（`/aidlc` の後も）でも自分の言葉で求めると、あなたが与えたプラン、テスト指示、承認が戻され、続くビルドは承認済みのプランのものになります。これは Guard Policy だけの判断です。[plan approval](#plan-approval) 設定は、そもそもプランについて尋ねるかどうかだけを決めます。同じルールは、同じ intent、ターゲット、試行の中での Testing Posture、スコープ、テスト戦略、プロジェクトタイプの変更後の更新もカバーします。必要に応じて契約と指示をリフレッシュし、フェンスが下がったまま続けます。`strict` のもとでの1つの例外は、ビルドのレビューの後に行った Testing Posture の変更（learnings のステップで保つテストの慣行など）で、そのビルドの承認を再度開きません。次のプランから適用されます。実効のフェンス設定が決め、`/aidlc --status` がそれを表示します。それでもプランを再度レビューするよう求められます。

初期の Plan Approval（[plan approval](#plan-approval) がオンの間）や他のゲートは、引き続き必須です。フェンスが下がっても、編集された内容が承認されたという意味にはなりません。あなたの元の回答と承認の証拠は、あなたが実際に承認したものの記録として残ります。どのレビュアーの判定も変わらず、どの証拠も削除されず、エージェントがあなたの代わりに答えることは決してできません。

AI-DLC は Plan Approval を自分で求めます。プランのサマリーとパスを **Approve Plan**、**Request Changes**、**I'll edit the files** とともに表示します。Code Generation が始まって以降、または前のプランが承認されて以降に、ワークスペースのファイルがすでに変わっているとき（プランに先行したエージェント、またはあなた自身の編集）、サマリーはそれらを示す1行で終わります。「Already changed before you approved: src/app/page.tsx.」です。それ以降に承認されたプランが示すファイルは、そのプラン自身のビルドで、リストされず、AI-DLC の更新が変えた AI-DLC 自身のファイルもリストされません。エージェントは、この作業のどのチャットからでも、あなたが行った選択を、あなたの正確な言葉とともに記録します。「Approve, but add a test for the empty cart」は承認に指示を加えたものです。エージェントはそれをプランに加え、承認はそのときのプランをカバーします。プランを編集するか、`code-generation-questions.md` に回答を書いて、終わったとエージェントに伝えることもできます。下がった plan-approval フェンスが許す内容の変更について、再承認の停止を加えることはありません。

既存の委譲されたワーカーは、検証済みの親 intent のライブの plan-approval 設定に従います。それを下げたり上げたりすると、次のチェックで適用されます。その設定を適用するためにワーカーを作り直す必要はありません。

#### スコープごとのデフォルト

| スコープ | デフォルト |
|-------|---------|
| enterprise | strict |
| poc, express, classic, bugfix, feature, mvp, refactor, workshop, security-patch, infra | off |

`bugfix`、`classic`、`express`、`feature`、`infra`、`mvp`、`poc`、`refactor`、`security-patch`、`workshop` は `off` で出荷されます。`classic` は暗黙のデフォルトスコープなので、スコープを名づけない作業も `off` で始まります。`enterprise` では、`off` はあなたが求めるものです。コンポーズされたプランはスコープファイルを書きません。一致したプランはそのストックのスコープのデフォルト、またはあなたが求めたより厳しい値を運び、カスタムのプランは、あなたがそのゲートで承認した値、またはそれより低い値をデフォルトとするストックのスコープで走ります。スコープとして保存したプランは、その値を `guard_policy: <value>` として保存します。

intent の作成は、プランが走るスコープから Guard Policy を読みます。コンダクターは、低いスコープのデフォルトを上げる `strict` または `relaxed` について `--guard-policy` を渡し、`off` については決して渡しません。compose ゲートで一致したプランの Guard Policy を下げると、それはその値を運ぶストックのスコープ上のカスタムプランになります。上げると、プランは一致したままです。どちらにせよ intent は作成時にその値を取ります。コンポーザーは進行中の intent の値を決して変えません。

#### 設定する3か所

1. **スコープファイル。** `scopes/aidlc-<name>.md` の `guard_policy: strict | relaxed | off` は、そのスコープ上のすべての新しい intent が始める値です。出荷されるすべてのスコープがそれを宣言します。何も宣言しないスコープファイルは、`enterprise` を除く出荷のすべてのスコープと同じく off で始まるので、strict にしたいプラグインやコンポーズされたスコープは `guard_policy: strict` と言います。
2. **メモリ。** `aidlc/spaces/<space>/memory/org.md`、`team.md`、`project.md` のいずれかにある、1行 `Mode: strict` を持つ `## Guard Policy` セクションは、リポジトリ上の全員について strict を保ちます。スコープのデフォルトや intent ごとの値に勝ち、[plan approval](#plan-approval) をオンに保ちます。明示的な `--guard-policy relaxed`、`--guard-policy off`、`/aidlc config set guard.<fence> off`、または plan approval のオフは、メモリファイルを示す文で拒否され、コマンドの付随設定やスコープ変更は適用されません。フェンスを `on` にするのは許可されたままです。`Mode: relaxed` または `Mode: off` は、値がスコープ由来のすべての作業についてポリシーを設定し（status がそれを表示します。たとえば `Guard Policy: off (from team.md)`）、宣言する最も狭いレイヤーが勝ちます（`project.md`、次に `team.md`、次に `org.md`）。1つの作業向けに設定した値はそれを保ち、どのレイヤーの `Mode: strict` もすべてに勝ちます。空のセクションは何も変えません。それ以外の値は、ファイルと3つの許可された値を示す検証エラーです。
3. **intent。** `/aidlc --guard-policy relaxed|off`、`/aidlc config set guard-policy relaxed|off`、または確認の言葉 `guard policy relaxed|off` をタイプすると、エージェントが同じターンで、選択された作業についてセッターを実行し、監査行を記録します（`/aidlc --status` はそれを `Guard Policy: relaxed (set by you)` と表示します）。他の intent 設定を含むタイプされたコマンドは、まずすべての値を検証し、それらすべてを同じロックのもとで適用します。不正なコマンドや無効な付随は何も変えません。タイプされたスイッチの後、コンダクターは `next` を実行し、スタンドアサイドの行、またはそれを注入するハーネスでの `AIDLC Guard Policy: ...` フックコンテキストを中継します。平易な言葉のリクエスト（「stop asking me to re-approve when files change」、「be strict about changes」）はコンダクターが実行します。あなたが求めた値で `config-change --guard-policy <strict|relaxed|off>` を実行し、前回の決定以降あなたからの返答が記録されているときに下げ、その出力をそのまま表示し、止まります。この Kiro IDE のビルドがプロンプトテキストを渡さない場合、アクティブな作業は下げられません。Kiro IDE を更新するか、より低いデフォルトのスコープから新しい作業を始めます。スコープの変更は、スコープが所有するポリシーを自動的に上げることがあります。より低いスコープのデフォルトは、あなたがスコープ変更を求めたときに従います。それ以外のスコープ変更は、より厳しい値をそのままにし、1行でそう伝えます。作成時にスコープ自身のデフォルトを名づけると、スコープの値を記録します。単独の退役した `Change Control: relaxed|off` フィールドは、その値を変えずに、ポリシーの監査行を書かずに、自動的に正規化されます。

#### 値がどこに置かれるか

解決された値は、作成時に intent の `aidlc-state.md` に `- **Guard Policy**: <value> (from scope <name>)` として書かれ、フラグ、タイプされた確認の言葉、またはコンダクターがセッターを通じて実行する平易な言葉のリクエストによって書き換えられ、値だけで読まれます。状態ファイルは intent とともにコミットされるため、値はセッションをまたいで生き残り、チームメイトは同じものを見ます。走行中の intent の実効値を変えるメモリの編集は、次に統治されたチェックが走るとき、メモリファイルを示す `GUARD_POLICY_SET` 行として記録されます。このフィールドが存在する前に作られた intent は、あなたが設定するまで `strict (not set)` のままです。ただし、メモリファイルが `relaxed` または `off` を宣言していれば、それもそれに適用されます。無効なフィールドは、3つの値のいずれかを持つ `/aidlc --guard-policy` が修復するまで使えません。次の intent は、再びそのスコープのデフォルトから始まります。

状態ファイルが、異なるポリシーの言葉で `Guard Policy` と退役した `Change Control` の両方を運んでいる場合（リネーム前のリリースのチームメイトは、状態ファイルが git で移動するので、両方を残すことがあります）、次の `next` はそのうちの1つを保ち、唯一の行として書きます。監査証跡が最後に設定されたと示すもの、なければあなた自身が設定したもの、なければスコープが始めるもの、なければより厳しいものです。`Source: command` と、両方の行を示す `Settled` フィールドを持つ `GUARD_POLICY_SET` 行を記録し、何も尋ねません。あなた自身の最後の選択を保ったときは何も言いません。記録が判別できなかったときは、どれを保ったかを一度だけ言います。たとえば次のようにです。

> This work had two settings for how closely AI-DLC checks changes, and they disagreed. The record does not say which was set last, so AI-DLC keeps the stricter one: it checks everything. You can change it any time.

それまで status は `strict (from conflicting state lines)` を表示します。メモリで strict を保つチームは strict を保ち、2つの行はそのまま残ります。両方が一致するなら、`Guard Policy` 行が使われます。ポリシー行の書き込みはすべて退役した行を取り除き、1つの設定を残します。

#### この設定は以前は Change Control と呼ばれていました

古い綴りはすべてこのリリースでも機能し、次のマイナーバージョンで取り除かれます。スコープキー `change_control`、状態フィールド `Change Control`、メモリ見出し `## Change Control`、フラグ `--change-control`、config キー `change-control` です。退役したフラグや config キーをタイプすると、新しい綴りを示す1行が表示されます。退役したスコープキーやメモリ見出しは、何も言わずに読まれます。古い名前を書き直すものはありません。ポリシー行の書き込みはすべて、それが唯一の行でも `Guard Policy` の隣に現れていても、退役した `Change Control` 行を取り除きます。`CHANGE_CONTROL_SET` 監査イベントは、古いレジャーで引き続き読めます。新しい行は `GUARD_POLICY_SET` です。

退役した `Change Control: relaxed` または `Change Control: off` 行だけを運ぶ作業は、あなたの次のメッセージでリネームされます。AI-DLC は値を保ち、行を `Guard Policy` として書き、ポリシーの監査行を書きません。そのリネームが起きていないところでは、すべての `/aidlc` 実行がディレクティブの `change_notices` に通知を運び、それを表示しても行は書き直されません。たとえば次のようにです。`This work still has an old setting that lets AI-DLC skip some of its checks (it asks you to confirm less often). Do you want to keep that, or have AI-DLC check everything again? I'll ask again until you choose.` `/aidlc config set guard-policy relaxed` または `guard policy relaxed` をタイプすると、エージェントのセッターがその値を保ち、行を `Guard Policy` として書き直します。あるいは strict を求めると、コンダクターがセッターを通じてフェンスを上げます。どちらの書き込みも通知を止めます。退役した strict 行だけは通知を得ず、次に Guard Policy 設定が書かれるときに書き直されます。

### 5つのフェンス

フェンスは、何も求めていないアクションを拒否するガードです。ワークフローが現在実行しているステップは、それを必要としません。3つのフェンスは、1つの作業についてオフにし、またオンに戻せます。plan approval フェンスは代わりに [plan approval](#plan-approval) 設定に従い、編集されたプランについて再度尋ねるかは Guard Policy が決めます。Human presence は鍵の保持者で、作業ごとのスイッチを持ちません。

| フェンス | 何を拒否するか | 作業ごとのスイッチ | マシン全体のキルスイッチ |
|-------|-----------------|------------|--------------------------|
| Plan approval | プランが承認される前、または plan approval がオフのとき、エンジンが尋ねずにビルドすると記録する前のコード | なし: `guard.plan-approval` は [plan approval](#plan-approval) 設定の別名 | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1`（plan approval をオフにする） |
| Review freeze | レビューの受領後のレビュー済み内容への編集 | `guard.review-freeze` | `AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1` |
| State transition | ワークフロー自身の代わりの直接のライフサイクルコマンド | `guard.state-transition` | なし |
| Reviewer read scope | ディスパッチされたレビュアーが兄弟ユニットの内容を読んだり検索したりすること | `guard.reviewer-scope` | `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` |
| Human presence | 背後に本物の human turn のない承認や回答 | なし: 鍵の保持者は in-band のスイッチを持たない | `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` |

```
/aidlc config set guard.review-freeze off
/aidlc config set guard.review-freeze on
```

フェンスやポリシーの言葉を下げるのは人の判断です。自分の言葉で求めるとエージェントがセッターを実行し（「turn the guards off」のようにガード全体をオフにするよう求めると Guard Policy を `off` に設定します）、または `/aidlc config set guard.<fence> off`、`/aidlc --guard-policy relaxed|off`、確認の言葉 `guard policy relaxed|off` を、1つの値を選んでタイプします。エージェントのセッターは、タイプされたスイッチを `--intent <name>` と `--space <name>` で選択された作業、またはそれらのセレクタが省かれたときはチャットのワークフロー選択で選択された作業に適用し、状態と監査行を書きます。それを注入するハーネスでは、`AIDLC Guard Policy: ...` をフックコンテキストとして報告します。存在しない名前付き intent は拒否されます。作業が存在する前にタイプした Guard Policy `relaxed` または `off` のスイッチは、このチャットが次に始める作業向けです（`Guard Policy relaxed for the piece of work you start now (set by you).`）。リクエストと同じメッセージでタイプすると、そのリクエストに付きます（`Guard Policy relaxed for the work you are asking for (set by you).`）。新しい作業は作成時にそれを取り、代わりに開いた作業を続けることを選ぶとそこに適用されます。メッセージだけが開いた作業を変えることは決してありません。`/aidlc --guard.review-freeze off fix the parser` のようなフェンスのスイッチも同じように機能します（`The review freeze check is off for the work you are asking for (set by you).`）。1つの例外は、コードプランの質問が開いていて、あなたがプランファイルを編集していないときです。そのとき、言葉とともにタイプされた設定（`/aidlc --guard-policy off approve the plan`、またはあなたの選択で `strict`）はこの作業向けで、その言葉はその質問へのあなたの返答です。クォートされていない `--` の後の言葉は、依然として新しい作業を説明します。plan approval の `off`、フェンスのスイッチ、作業が存在する前にタイプした他のすべての設定（儀式、collaborators、深さ、テスト戦略、review）は、このチャットが次に始める作業について、同じように保たれます。無関係な返答は何も開きません。

CLI のセッターは、前回の決定以降あなたからの返答が届いたときにだけ下げ、スイッチの権限のセッションルックアップを行いません。承認と同じメッセージで求めた設定は、その承認に相乗りします。「approve, and turn plan approval off」はそれをオフにして1ステップで承認します。「Approve the plan, and run Construction on its own from here」も両方を行います。設定はどちらの順でも、どの質問でも成り立ちます。エージェントはまずあなたの回答（承認、またはサマリー、コードプラン、Construction の質問への回答）を記録し、それからその返答にまだ乗っている設定を記録できます。すでに承認や別の決定を与えたあなたのメッセージは、あなたが別のメッセージを送った、チェックがエージェントを止めた、または次の質問が出た後には、設定を後から変えません。したがってエージェントは、あなたの以前の「Approve」であなたのチェックの1つをオフにできません。それ自身のメッセージで求めると、すぐに行われます。コードプランがあなたの承認のために書かれると、plan approval は、その質問が表示された後にあなたが送るメッセージでのみオフになります。その前に求めていたら、そのプランは一度尋ねられ、1行が理由を伝え、再びそう言うとオフになります。そのメッセージでエージェント自身の質問に与える回答も、それを立たせたままにします（エージェントが変更を申し出たときにあなたが選ぶ選択肢は、それを求めるあなたのリクエストです）。あなたのメッセージの後に記録される他のどの決定も、それを使い切り、承認は常に自身の返答を必要とします。フックは Windows でも走るので、タイプされたスイッチは、プロンプトを転送するすべてのハーネスで機能します。すでにオフのフェンス、またはすでに `set by you` とマークされた同一のポリシーの言葉には、CLI の更新が no-op なので鍵は不要です。

ガードの質問が「turn the check off for this piece of work」を提示するとき、それを選ぶだけで十分です。エージェントがあなたのためにそれをオフにし、スイッチが表示する行で、この作業についてオフで、いつでも戻せると、一度伝えます。Codex ではスキルは `$aidlc` です。

スイッチをタイプするとは何か。`/aidlc`（または `$aidlc`、`aidlc`）で始まり、フラグを先に運ぶメッセージです。たとえば `/aidlc --guard-policy relaxed`、`/aidlc --guard-policy off --guard.state-transition off`、`/aidlc --guard-policy relaxed build the auth service`（説明はフラグに続き、読まれません）です。同じコマンドの頭の後の `config set guard-policy relaxed|off` または `config set guard.<fence> off`（任意で他の設定 `--depth minimal --sensors off` と `--intent <name>`、`--space <name>` のペアが続く）、または確認の言葉 `guard policy relaxed|off` 単独です。未知のフラグや無効な値は、それを示して行全体を拒否します。大文字小文字と末尾のピリオドは問題になりません。スイッチに言及する質問や発言は、スイッチとは区別されます。`/aidlc why was config set guard.plan-approval off suggested?` は何も変えず、説明の後に置かれたフラグも同様です。

チャットからの直接の `intent create --guard-policy relaxed|off` は、値が選択されたスコープのデフォルトを下回るとき拒否されます（`off` のスコープでの `relaxed` は引き上げで、適用されます）。作業を作り、あなたがより低い値を求めるとエージェントがセッターを実行します。作業が存在する前、または新しい作業とともにタイプした値は、あなたが求めた作業について `set by you` と記録されます。直接の `scope change --guard-policy relaxed|off` は `config-change` と同じ引き下げルールに従います。より低いスコープのデフォルトは、人がスコープ変更を求めたときに適用されます。それ以外のスコープ変更は、走行中のワークフローのより厳しい値を保ち、1行でそう伝えます。`AIDLC_UNATTENDED=1` はプロンプト時の適用を抑制し、CLI の引き下げを拒否します。メモリ strict と unattended のチェックの後、CLI のセッターが人のプロンプトなしに下げるのは、あなたが自分のターミナルでそれをタイプしたとき（あなた自身の行為）、または `fenceKeyBypassed` がフィクスチャやハーネス起動の presence バイパスを認識したときだけで、インラインの環境代入では下げません。session-start フックは、`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` で起動された attended なハーネスについて、その `presence-bypass-<session>` スタンプを Plan Approval ランタイムディレクトリに保ちます。

モデルのツールは、[state-transition guard](../reference/06-hooks-and-tools.md#pretooluse-aidlc-state-transition-guardts) で強制されるとおり、フックを呼び出すことも、`aidlc/.aidlc-sessions/` やどの `.aidlc-plan-approval/` や `<record>/.aidlc-engine/gate-words/` ディレクトリに書くこともできません。

メモリファイルが Guard Policy strict を保つ場合、`/aidlc config set guard.<fence> off` はそのファイルを示す文で拒否されます。そのファイルの `Mode: strict` 行を編集して、リポジトリ上の全員について変えます。フェンスを `on` にするのは許可されたままです。

メモリ保持の strict は、あなたが先に下げたフェンスもオーバーライドします。保存された `Guards Off` エントリは intent に残りますが、`/aidlc --status` はそのとき、そのフェンスを `Checks off:` 行から外します。エントリが再び効くのは、メモリ行がもはや strict を保たなくなった後だけです。マシン全体のキルスイッチは依然として優先されます。

1つをオフにすると、`aidlc-state.md` に `- **Guards Off**: review-freeze (set by you)` と1つの `GUARD_DISABLED` 監査行が書かれます（行には1つのラベルがあります。そのすべてのチェックがあなたのものである間は `set by you`、1つがそうでなくなると `set by a command`）。オンに戻すと、そのリストから取り除かれ、`GUARD_RESTORED` が書かれます。`on` に設定すると、ポリシーで下げられたフェンスも上げ、`- **Guards On**: review-freeze (set by you)` を記録し、`GUARD_RESTORED` を書きます。行は切り替え可能なフェンスだけを名づけます（plan approval がそれ自身の設定になる前に書かれた `plan-approval` エントリは、依然として読まれます）。保存された human-presence エントリは無視されます。`/aidlc --status` は、誰かがオフにした各チェック（この作業についてのあなた、またはこのマシンの環境）と、それがどこから来たかを示す `Checks off:` 行を表示します。plan approval フェンスはそこに、承認後に編集されたプランへのチェックである `plan re-approval` として表示されます。より低い Guard Policy がオフにするチェックは、そこにリストされません。それらはポリシーがどこから来たかを伝える `Guard Policy:` 行に付きます。優先順位は、マシン全体のキルスイッチ、次にメモリが strict を保たない限り作業ごとの off、次に作業ごとの on、次に Guard Policy の言葉、次にデフォルトの on です。Guard Policy の言葉を自分で設定すると、その方向にすべてのチェックをカバーします（各変更は `GUARD_DISABLED` または `GUARD_RESTORED` として書かれます）。`off` はこの作業がオンに保ったチェックをクリアするので、オンに残るものはありません。`strict` はオフにしたチェックをクリアするので、オフに残るものはありません。`relaxed` はどちらもクリアしないので、チェックをオンやオフに戻すことは決してありません。メモリ保持の strict は依然として勝ち、その後にあなたが切り替える単一のチェックも依然として適用されます。

reviewer-scope 設定は、ディスパッチされたレビュアーの読み取り/検索の境界を統治します。1つのチームユニットを所有するとスタンプされたチェックアウトは、依然として別のユニットの `construction/` サブツリーに書けません。その所有の境界は、Guard Policy、作業ごとのフェンス設定、`AIDLC_DISABLE_REVIEWER_SCOPE_HOOK` で切り替えられません。

自分の言葉で求めるとエージェントが実行します。タイプされたスイッチは同じセッターで、エージェントが最初の `next` から実行します。切り替え可能なフェンスのメインセッションでの拒否は、そのスイッチを名づけます。フェンスをオフにしようとするセッターが、あなたが求めたメッセージを名づけずに実行されると、次を言います。

> Turning the review-freeze check off is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

plan approval をオフにしようとする CLI のセッターは、次を言います。

> Turning plan approval off lets code generation start without the person approving the plan, so it is their call. Run it with --message <id>, the message they asked in, when they ask for it.

ポリシーを `relaxed` に変えようとするセッターが、あなたが求めたメッセージを名づけずに実行されると、次を言います。

> Setting Guard Policy relaxed lowers fences, which is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

スコープのデフォルトを下回る明示的な `relaxed` フラグでの作成（`enterprise` 上）が、そのチャットにあなたのメッセージの記録なしに実行されると、同じことを言います。

> Setting Guard Policy relaxed lowers fences, which is the person's call. Run it with --message <id>, the message they asked in, when they ask for it.

他のフェンス名と `off` は、対応する名前や値を使います。unattended な実行はドライバーのガイダンスを付け足します。メモリ保持の strict は、スイッチを適用したりバイパスをチェックしたりする前に拒否し、代わりに編集すべきメモリファイルを名づけます。human-presence の拒否はスイッチを名づけません。人からの返答の記録がないこと、すでに送られた返答に何が起きたか（ハーネスのフックの手順、または `/aidlc --doctor`）を言い、再び返答するよう求めることは決してありません。

Human presence は5つの中でもっとも厳しいものです。あなたの承認をあなたのものにするのがこれなので、Guard Policy も作業ごとの設定もそれを下げません。`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` だけが、マシン全体に設定するか `aidlc config flags --bypass` で記録して下げ、AI-DLC はそれがオフの間あなたに伝えます。`AIDLC_UNATTENDED=1` は別に human-turn の発行を差し控えます。フェンスを下げるわけではありません。

### 誰がこれを求めたか: 権限の連鎖

ガードが見るすべてのアクションは、何かが決まる前に分類されます。それは記録された human turn、ワークフロー自身の指示、そのどちらでもないもののどれにカバーされるか。この分類は誰が働いていたかを記録します。それは、人のタイプしたスイッチについてエージェントが実行するセッターとは別物です。

- **あなたの grant。** ワークフローが最後にエージェントに何をするか伝えた後にあなたが送ったメッセージ。ワークフローが次の指示を出すまで、そのターンのためにディスパッチされたコンダクターとエージェントを分類します。フェンスやポリシーの変更を認可しません。
- **ワークフローの指示。** エンジンが現在効力を持たせているステージ。誰が行うかにかかわらず、その指示が求める作業をカバーし、その中でまだ保留中の承認を含みます。ループが自身のステップの1つを飛ばすことはカバーしません。それこそがフェンスが気づくものです。
- **どちらでもない。** あなたからの以降の何もない、指示の外の何か。もっとも狭いカバーで、読めない信号がフォールバックする先です。

ここで問われるのは、誰がタイプしているかとは別の点です。開発者エージェントはコンダクターの言葉で動き、コンダクターはあなたの言葉で動くので、権限は連鎖を下へ流れます。コンダクターがエージェントをディスパッチするとき、その瞬間に効力を持つ権限がディスパッチにスタンプされ、エージェントがそれを継承します。エージェントは自分のために grant を発行できず、読めない信号は、カバーされる範囲をむしろ狭めます。信号はフレームワークがすでに保っているものです。あなたの最後のプロンプトを、ワークフローの最後の進行コマンドに対して記録する `.aidlc-engine/` の下のターンマーカー、active-directive マーカーのカウンター、進行中のエージェントレジャーのディスパッチスタンプです。

この分類は、フェンスを下げることも、人のタイプしたスイッチの代わりになることも決してありません。その仕事は証拠の証跡です。下がったフェンスが何かを通すたびに、監査行が効力を持つ権限を名づけるので、読み手は、それが起きたとき誰が働いていたかを見られます。`strict` のもとで変わった入力は、この分類にかかわらず、統治された境界で尋ねられます。

### ガードが判断するときに見えるもの

- **身を引く。** 1行がフェンスを下げたものを名づけ、作業は続きます。`Continuing past the plan re-approval check because it is off for this piece of work (guard policy relaxed (set by you)). Recorded in the audit trail: dispatch of aidlc-developer-agent`。1つの `GUARD_STOOD_ASIDE` 行が、フェンス、効力を持つ権限、grant がどう証明されたか、そしてアクターがメインセッションかディスパッチされたエージェントかを記録します。「are you sure」と尋ねられることは決してありません。フェンスはすでにオフです。

  Claude Code ではフックが1つの JSON `systemMessage` を発行し、Claude Code はそれをフックメッセージとしてあなたに示します。モデルはそれを見ず、`GUARD_STOOD_ASIDE` 行が記録です。Codex、opencode、Kiro CLI では、素のフックの行が見えます。Kiro IDE では見えません。IDE はフックの出力をセッション開始時とプロンプト送信時にだけエージェントに渡すので、そこでのスタンドアサイドは静かで、監査行だけがその記録です。拒否は別です。フックがツール呼び出しをブロックすると、エージェントはその理由を見ます。行は intent にすでに監査証跡があるときにだけ書かれるので、レジャーがまだない新規プロジェクトに対する Kiro IDE でのスタンドアサイドは、行も監査行も残しません。下がったフェンスが何を通したかを知りたいなら、その行を見たことに頼るのではなく、intent の `audit/` シャードの `GUARD_STOOD_ASIDE` 行を読みます。
- **持ちこたえる。** メモリが Guard Policy strict を保たないとき、切り替え可能なフェンスのメインセッションでの拒否は、何が足りないかを言い、エージェントに通す道を申し出るよう伝える1文を加えます。いま本当にこれをするつもりなら、この作業について review-freeze のチェックをオフにするかを尋ね、あなたがそう言うとオフにして1行でそう伝えます。メモリが strict を保つとき、拒否はスイッチを申し出る代わりにメモリファイルを名づけます。human presence は代わりに、人からの返答の記録がないと言い、それを繰り返すよう決して求めず、スイッチを決して宣伝しません。
  plan approval はスイッチを決して名づけません。それをオフにするのは常にあなたのアイデアだけです。まだ承認していないプラン、または `strict` のもとで承認後に編集されたプランは、`next` を実行することで尋ねられます。
  ディスパッチされたエージェントは、スイッチの1文を決して見ません。その拒否はエージェントをメインセッションへ向け直します。
- **尋ねる。** `strict` のもとでは、あなたが何かを承認した後に変わった入力は、何が変わったかを名づけて一度尋ねられます。

---

## ステージのカスタマイズ

各ステージは `.claude/aidlc-common/stages/[phase]/` にある自己完結した `.md` ファイルです。ステージファイルは次を指定します。

- **メタデータ** — ステージ番号、フェーズ、実行モード、リード/支援エージェント
- **入力** — ロードする先行成果物
- **ステップ** — 番号付きの実行シーケンス
- **出力** — 生み出す成果物
- **完了** — 承認ゲートのパターン

ステージの振る舞いを変えるには、そのステージファイルを直接編集します。すべてのステージは、共有パターン（承認ゲート、質問の形式、状態の追跡）についてステージプロトコルを参照します。

### 深さのレベル

各スコープには、成果物の詳細度を制御するデフォルトの深さがあります。

| 深さ | 説明 |
|-------|-------------|
| **Minimal** | 簡潔な成果物、的を絞った分析、任意の内容なし |
| **Standard** | バランスの取れた詳細、一次と二次の関心事をカバー |
| **Comprehensive** | 完全な詳細、広範な分析、すべての任意の内容を含む |

どの承認ゲートでも、別のレベルを求めることで深さをオーバーライドできます。

---

## ステータスライン（Claude Code と Codex）

**Claude Code** と **Codex CLI** では、AI-DLC はターミナル下部のステータスラインに作業の進み具合を表示できます。あなた自身がセットアップしたステータスラインの場所を取るので、あなたの選択です。初回実行のセットアップで一度尋ね、いつでも切り替えられます。他のハーネスにはステータスラインがなく、`/aidlc --status` と各ゲートの進捗行でワークフローの位置を示します。

Claude Code では次のように見えます。`mvp` プランでの実行からです（描画文字をプレーンテキストで表示。モデル、コンテキスト、コストは右に続きます）。

```text
[AIDLC] inventory-api - IDEATION [##--------] 1/4 > Feasibility -- Architect Agent
```

ここには順に、作業、現在のフェーズ、フェーズの進捗（バーと比率の両方で、どちらも現在のフェーズにスコープされる）、ステージの表示名、リードエージェントが並びます。Reverse Engineering が10以上のリポジトリを分析している間は、ステージ名の後に、そのうち何個が終わったかが続きます。`> Reverse Engineering 37/190` のようにです。どの作業も選択される前は `[AIDLC] ready` と読めます。右には Claude Code のモデル、次に `ctx:N%`、コンテキストウィンドウのどれだけが使われているかが来ます。Claude の使用レジャーにデータがあると、入出力のトークンと `$<usd>` が、アクティブなワークフローと現在のトランスクリプト/セッションについてのみ続きます。以前のワークフローとセッションは除外されます。`AIDLC_DISABLE_USAGE_TRACKING=1` を設定すると、使用トラッキングが完全にオフになり、このセグメントが取り除かれます。[Your First Workflow](02-your-first-workflow.md) が各セグメントを説明します。

`$<usd>` の値は **公開のリスト価格** から値付けしたローカルの見積もりで、請求ではありません。Amazon Bedrock が記録されたプロバイダーのとき（`CLAUDE_CODE_USE_BEDROCK=1`）、Bedrock が実際に請求する額は、あなたの推論プロファイル、リージョン、サービスティア、交渉済みまたはサブスクリプションの価格によるので、この数字は請求書と一致しないことがあります。長いワークフローのトークン量の大半はキャッシュ読み取りで、割引されたキャッシュ読み取りレートで請求されるため、カウントと見積もりは着実に増えます。それは実際の使用そのものです。新しい使用を自分のレートで値付けするには、`AIDLC_MODEL_RATES` をレートファイルに向けます（[Rate table and overrides](../reference/06-hooks-and-tools.md#rate-table-and-overrides) を参照）。すでに記録された合計は、値付けされたレートを保ちます。見積もりを表示したくないなら（プレゼン、画面共有、録画の間など）、`AIDLC_DISABLE_USAGE_TRACKING=1` を設定します（[Troubleshooting](15-troubleshooting.md#statusline-shows-a-cost-segment-you-dont-want-or-usage-tracking-concerns) を参照）。

### オンまたはオフにする

- 初回実行のセットアップで（AI-DLC がまだないプロジェクトでの `aidlc config`）、AI-DLC は尋ねます。「Show AI-DLC's progress in your status line? It takes the place of your own while you work in this project.」自分のステータスラインをすでに持っているときの推奨の答えは「No, keep mine」、持っていないときは「Yes」です。
- その後いつでも: チャットで `/aidlc --statusline on` または `/aidlc --statusline off`（Codex では `$aidlc --statusline on|off`）、ターミナルで `aidlc config --statusline on|off`。何も尋ねず、1行を表示します。何が変わったかと、どう戻すかです。たとえば次のようにです。

  ```text
  $ aidlc config --statusline on
  AI-DLC's status line shows in this project; /aidlc --statusline off turns it off.
  ```
- 何も尋ねないセットアップ（`--yes`、CI、スクリプト、コピーチャンネル、初回チャットのチームメイトのクローン）は、ステータスラインを加えません。
- このリリースの前にすでに AI-DLC のステータスラインを表示していたプロジェクトは、質問なしでそれを保ちます。それがあなた自身のステータスラインを覆っている場合、次のリフレッシュ（またはチームメイトのクローンでの最初のチャット）が一度そう伝えます。「AI-DLC's status line replaces yours here; /aidlc --statusline off gives yours back.」

**Claude Code: あなた自身の設定。** あなたの選択は、git が無視するあなた自身の `.claude/settings.local.json` に置かれるので、各チームメイトが自分で選び、共有の `.claude/settings.json` の中は何も変わりません。あなたの答えは `aidlc.settings.local.json`（これも無視される）に保たれるので、セットアップは二度と尋ねません。AI-DLC は、答えを推奨するためだけにあなた自身の `~/.claude/settings.json`（または `$CLAUDE_CONFIG_DIR/settings.json`）を読み、決して書きません。チームが共有の `.claude/settings.json` に設定したステータスラインはそのまま残ります。組織の管理された Claude Code 設定がステータスラインを選ぶとき、彼らのものがあなたの選んだものを表示します。

AI-DLC の値は次のとおりです。

```json
"statusLine": {
  "type": "command",
  "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts\" engine statusline"
}
```

（ネイティブインストールでは `aidlc engine statusline`）。`.claude/tools/data/harness.json` で出荷され、あなたがオンにしたときにだけ `.claude/settings.local.json` に届きます。

**Codex CLI: プロジェクトの設定。** Codex はプロジェクト内に人ごとの設定ファイルを持たないので、Codex ではその選択はプロジェクトのものです。`on` は AI-DLC の `status_line` 行を共有の `.codex/config.toml` の `[tui]` テーブルに、プロジェクトで作業する全員のために書き、`off` はその1行を取り出します。ファイルの他は何も変わらず、あなた自身の `~/.codex/config.toml` は、答えを推奨するためだけに読まれ、決して書かれません。各人は代わりに、Codex の `/statusline` で自分の Codex ステータスラインにタスクの進捗を加えられます（`task-progress` の項目が、AI-DLC が最新に保つものです）。AI-DLC が書く行は次のとおりです。

```toml
[tui]
status_line = ["model-with-reasoning", "git-branch", "task-progress", "context-used"]
```

### 形式のカスタマイズ

`.claude/hooks/aidlc-statusline.ts` を直接編集します。ステータスラインは、ネイティブインストールでも、プロジェクトのコピーを実行します。出力形式はファイル末尾付近の `main()` 関数で定義されます。フックは `aidlc-state.md` からフェーズ、ステージ、エージェントを読み、ステージの slug を表示名にマップし、同じフェーズローカルのチェックボックス解析から unicode の進捗バーと `n/m` の比率の両方を組み立てます。

このファイルは AI-DLC のものなので、プロジェクトで次の `aidlc config` は、それを置き換える代わりにあなたの編集で止まります。

```text
$ aidlc config --harness claude --yes
error: 1 config conflict(s): .claude/hooks/aidlc-statusline.ts (locally modified or unowned)
fix: to keep your version, move .claude/hooks/aidlc-statusline.ts somewhere else and run the same command again; to take the shipped version over it, run it again with --force.
```

`--force` で出荷版を取る前に、自分のバージョンのコピーを保っておきます。

---

## ツールの権限

`.claude/settings.json` の `permissions.allow` リストは、ワークフローが呼び出しごとの権限プロンプトなしに走るよう、Claude Code のツールを事前承認します。ネイティブインストールでセットアップされたプロジェクトでは、次のように始まります（全部で45エントリ）。

```json
"permissions": {
  "allow": [
    "Edit(/**)",
    "Task",
    "WebSearch",
    "Bash(aidlc engine *)",
    "Bash(aidlc doctor)",
    "Bash(aidlc doctor --verbose)",
    "Bash(aidlc version)",
    "Bash(aidlc --doctor)",
    "..."
  ]
}
```

Claude Code 2.1.296 は、そのフォルダを信頼するか最初に尋ねるときにそれらを名づけます（短縮、描画文字をプレーンテキストで表示）。

```text
 Accessing workspace:
 /home/you/inventory-api
 ...
 ! This folder pre-approves 45 tool permissions in .claude/settings.json:
   WebSearch, Edit(/**), Bash(aidlc engine *), Bash(aidlc doctor), Bash(aidlc doctor --verbose),
 Bash(aidlc version), Bash(aidlc --doctor), Bash(aidlc --doctor --verbose), and 37 more
 These will apply without asking. Only proceed if you trust this configuration.
 Security guide
 > No, exit
   Yes, I trust this folder
```

`Edit(/**)` は、プロジェクト内のどこでもファイルを作成・変更することをカバーします。プロジェクト設定では、Claude Code は先頭の `/` をプロジェクトルートに固定します。プロジェクトの外への書き込みは、Claude Code のデフォルトと同じく尋ねます。プロジェクト内の読み取りと検索にはエントリが要りません。コピーチャンネルは AI-DLC 自身のワークフローコマンドだけを、AI-DLC が実行するとおりにそれぞれリストして事前承認します。そのエンジンコマンド、`doctor`、`version`、`--doctor`、`status`、読み取り専用の `config <section> --show --json` と `--help` 形式、そしてその `aidlc-*.ts` ツールです。ネイティブリリースはそれらを `Bash(aidlc engine *)` に書き換えます。`config` の変更、マシンの AI-DLC インストールを変えるコマンド（`use`、`update`、`rollback`、`uninstall`、`system`）、そしてその背後のツールスクリプトは、どのエントリにも一致しないので、Claude Code 自身のプロンプトで承認します。素の `Bash` はありません。Claude Code は複合コマンドのすべてのサブコマンドを個別に照合し、既知の安全な環境変数の固定セットだけを剥がすので、エンジンコマンドは素で走るときにだけ事前承認されたままです。`cd ... &&` のプレフィックス、絶対パスの `$CLAUDE_PROJECT_DIR`、`VAR=1` のプレフィックス、`jq` へのパイプ、`$(...)` のキャプチャはすべてプロンプトを出します。プロジェクト自身のビルドとテストのコマンドはリストの外にあり、一度プロンプトを出します。「Yes, and don't ask again」と答えると、それらのルールが `.claude/settings.local.json` に保存されます。

### 権限の仕組み

- **事前承認であって上限ではない**: `settings.json` の allow リストは尋ねずに走るものを決めます。それがリストしないツールやコマンドも、Claude Code のプロンプトを承認すれば走ります
- **Claude Code のエージェントはフルのセッションツールセットを継承します**。デフォルトで。`disallowedTools: Task` は、このハーネスでネストしたサブエージェントの起動をブロックします
- **任意のエージェントごとの絞り込み**: エージェントは、フロントマターに `tools:` の allowlist を加えることで絞り込めます。省くとすべてを継承します。`tools:` をリストすると、完全修飾の `mcp__<server>__<tool>` の id も同時にリストしない限り、継承した MCP ツールが落ちます

### 権限を広げる

追加の機能が必要なカスタムステージを作る場合にのみ、allow リストにツールを加えます。

### 権限を絞る

allow リストからツールを取り除くと、使うたびに手動の承認を要します。`Task` を取り除くと、4つのディスパッチされるステージ（2.1 Reverse Engineering パイプライン、2.2 Practices Discovery サブエージェント、2.4 User Stories mob、3.5 Code Generation サブエージェント）が、委譲ごとに権限を求めることに注意してください。Workspace detection（0.2）は `aidlc-utility intent-create` の中で決定的に走ります。`Task` を使いません。

---

## AI-DLC を拡張する

上記の設定、スコープ、深さ、ステージの編集は、あなたが走らせるワークフローの日々のチューニングをカバーします。チーム向けにフレームワーク自体を作り変えたいとき（ステージを加える、エージェントを加える、スコープを定義する、常設のルールを教える、決定的なチェックを結線する、ドメイン知識を加える）、それは独自のガイドを持つ別の仕事です。**[Harness Engineer Guide](../harness-engineering/00-overview.md)** です。

分かれ目はデータかコードかです。そのガイドのすべては、YAML フロントマター付きの Markdown ファイルか、フレームワークが読む JSON config です。TypeScript の編集はありません。各拡張の行き先は次のとおりです。

| したいこと | 出発点 |
|--------------|----------|
| ステージの動作を編集する、または新しいステージを加える | [Anatomy of a Stage](../harness-engineering/01-anatomy-of-a-stage.md)、[Adding a Stage](../harness-engineering/02-adding-a-stage.md) |
| エージェントを加える、または変更する | [Adding an Agent](../harness-engineering/03-adding-an-agent.md) |
| スコープを定義する、またはチューニングする | [Scopes](../harness-engineering/04-scopes.md) |
| 常設のルールを教える、または学習ループを運用する | [Rules and the Learning Loop](../harness-engineering/05-rules-and-the-loop.md) |
| 決定的なチェック（sensor）をステージに結線する | [Sensors](../harness-engineering/06-sensors.md) |
| チームのドメイン知識を加える | [Team Knowledge](../harness-engineering/07-team-knowledge.md) |

変更がフレームワークの *コード*（オーケストレーター、フック、CLI ツール、コンパイルパイプライン）へのものなら、それは [Developer Reference](../reference/00-overview.md) です。

---

## 知識とルール

2層の知識システムと、ルール/学習ループのシステムの詳細については、次を参照してください。

- [Knowledge](08-knowledge.md) — チーム知識のディレクトリと方法論のリファレンスファイル
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) — 振る舞いのルールと自己学習のフロー

---

## 次のステップ

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — スコープからステージへの完全なマッピング
- [Agents](06-agents.md) — エージェントの権限と機能
- [Troubleshooting](15-troubleshooting.md) — ステータスラインの問題、フックの構成
- [Glossary](glossary.md) — スコープ、深さ、ガードレール、知識の定義

# センサーシステム

この章の具体的な `dist/claude/` パスは、`bun scripts/package.ts` がマテリアライズする、
無視されるローカルプロジェクションを指します。インストール済みプロジェクトは、`.claude/`
の下で同じ相対パスを使います。

> 対象読者: Tier 2/3（チーム導入者、フレームワーク貢献者）。

この章は、AI-DLC センサーマニフェストの**スキーマリファレンス**です。マニフェストは、
ステージ出力への書き込みで発火する決定的な検査です。センサーは制御ループのフィードバック側の
半分です。ルールはフィードフォワード側の半分です（次章の [Rule System](08-rule-system.md) を
参照）。[Plane Architecture](02-plane-architecture.md) の章は、その両方を、コンパイルが各
ステージノードに解決する制御プレーンの入力として位置づけます。

この章は、マニフェストの*ファイル形式*を扱います。センサーマニフェストが何を含むか、
ステージがセンサーをどうインポートするか、出荷される 6 つのマニフェストがどう設定されるか
です。ワークフロー中にセンサーがどう発火するかの利用者向けの見方については、User Guide の
[Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) を参照してください。

> **パス規約。** 以下の `<record>/` = アクティブインテントの記録ディレクトリ
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`（コンパクトな UTC 日付プレフィックスと
> 短い kebab-case ラベルなので、記録ディレクトリは時系列でソートされます。正規の id は
> `intents.json` レジストリ行に保存された UUIDv7）。出荷マニフェストの 2 つのドキュメント
> 形状センサーの `matches` グロブは、やはりレガシーなアーティファクトツリーのパスを運ぶ点に
> 注意してください（スキーマを文書化する箇所で下に原文のまま引用）。

ランタイムの振る舞いについては [Stage Protocol](04-stage-protocol.md) を参照してください。
ステージ定義のファイル形式の対応物は [Stage Definition](15-stage-definition.md) に存在します。

---

## マニフェストの場所とファイル名

センサーマニフェストは次に存在します。

```
dist/claude/.claude/sensors/aidlc-<id>.md
```

フレームワークが出荷するすべてのマニフェストは、`aidlc-` のファイル名プレフィックスを運びます
（より広いフレームワークファイルの規約に合わせて）。フロントマターの `id:` フィールドは、
ファイル名の語幹から `aidlc-` プレフィックスを除き、`.md` サフィックスを剥がしたものと
等しくなければなりません。

| ファイル名 | 必須の `id:` |
|---|---|
| `aidlc-required-sections.md` | `required-sections` |
| `aidlc-linter.md` | `linter` |

ファイル名から id へのルールは、`tests/unit/t86-sensor-manifest-schema.test.ts` が強制します。
`aidlc-` プレフィックスは、**ユーザーが出荷するカスタムセンサーを含め、すべてのセンサーに
必須です**。コンパイルリゾルバは `SENSOR_FILE_REGEX = /^aidlc-([a-z][a-z0-9-]*)\.md$/`
（`aidlc-graph.ts` の `loadSensors`）でマニフェストを発見するので、プレフィックスのない
ファイルは静かにスキップされ、ステージに結び付くことは決してありません。カスタムセンサーは
`aidlc-<id>.md` と名付け、`id: <id>` を設定してください。

---

## センサーマニフェストのスキーマ

すべてのマニフェストは、YAML フロントマターと本体を持つ Markdown ファイルです。フロントマター
は構造化されたコントラクト（純粋な能力記述子）で、本体は検査を文書化する人間向けの散文です。
マニフェストは、どのステージが使うかではなく、*センサーが何であるか*を記述します。関係は、
ステージのフロントマター `sensors:` フィールド経由でステージ側に存在します（下の
[How stages import sensors](#how-stages-import-sensors) を参照）。

ネイティブインストールが持つ、出荷される `required-sections` マニフェスト:

```markdown
---
id: required-sections
kind: deterministic
command: aidlc engine sensor-required-sections
default_severity: advisory
fire_on: gate
description: Checks at the gate that stage output contains the required H2 headings
category: document-shape
matches: "**/{aidlc-docs,intents,codekb}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  h2_count: integer
  headings: string[]
  findings_count: integer
  edge_block: string
  template: string
  template_expected: string[]
  template_missing: string[]
  config_warning: string
  message: string
timeout_seconds: 300
---

# required-sections sensor

With no template for the output, no heading is required: the stage's prose
shapes the file, so the check passes and still reports the output's `##`
headings. When a template applies (below), its `##` headings are required.
```

コメントはフィールド行から外してください。パーサーはトップレベルフィールドの値の後の
`# ...` を値の一部として読むので、`id: demo-check   # required` は id を
`demo-check   # required` にし、マニフェストは読み込みに失敗します。エンジンは、マニフェストを
どう読むかを示します。ここでは出荷される `linter` です。

```text
$ aidlc engine sensor describe linter
id: linter
kind: deterministic
command: aidlc engine sensor-linter
default_severity: advisory
description: Wraps the project's configured linter (eslint by default for v0.5.0); fires on TS/JS code outputs
category: code-quality
matches: **/*.{ts,js}
timeout_seconds: 1200
path: .claude/sensors/aidlc-linter.md
```

| フィールド | 必須 | 型 | 注記 |
|---|---|---|---|
| `id` | はい | kebab-case 文字列 | ファイル名の語幹から `aidlc-` プレフィックスを引いたものに等しい。ルールファイルの `pairing:` フィールドから相互参照される（[Rule System](08-rule-system.md) を参照）。 |
| `kind` | はい | enum | 今日は `deterministic` だけが受け入れられる。他の値はパース時に拒否される。下の [`kind` enum](#kind-enum) を参照。 |
| `command` | はい | 文字列 | 正規の呼び出しプレフィックス。出荷センサーは `aidlc engine sensor-required-sections` のようなネイティブデリゲートを使う。カスタムセンサーは、`bun .claude/tools/aidlc-sensor-<id>.ts` のように、その TypeScript ワーカーを名指しする。ディスパッチャーは `.ts` ファイル名（または `sensor-<id>` デリゲート）を取り、そのファイルをインストール済みのツールフォルダから実行する。ネイティブインストールでは、ファイルは `aidlc-sensor-<id>.ts` と名付けられ、`export function main(argv)` を持たなければならない。センサーディスパッチャーは `--stage <slug>` と、`input_schema` が選ぶパスフラグを足す: `file_path` を宣言するとき `--file-path <path>`、さもないと `--output-path <path>`。[`command:` invocation contract](#command-invocation-contract) を参照。 |
| `default_severity` | はい | enum | `advisory` または `blocking`。blocking は `fire_on: gate` で強制される。書き込み発火の blocking 宣言は、このリリースでは advisory のまま。 |
| `description` | はい | 文字列 | 一行の人間向け説明。 |
| `category` | 任意 | 文字列 | 自由形式の記述的ラベル（出荷マニフェストは `document-provenance`、`document-shape`、`code-quality` を使う。閉じた enum ではない）。 |
| `fire_on` | 任意 | enum | `write` または `gate`。既定は `write`。 |
| `matches` | 任意 | グロブ文字列 | ディスパッチで消費される能力フィルタ。下の [`matches` filter](#matches-filter) を参照。 |
| `input_schema` | 任意 | オブジェクト | 呼び出しコントラクト。ブロックマッピングまたは一行のフローマッピングとして。ディスパッチャーはそのキーを読んでパスフラグを選ぶ: `file_path` を宣言すると `--file-path`、他のキーは `--output-path` を選び、キーを宣言しないマニフェストは出荷ルーティング（`linter` と `type-check` だけ `--file-path`）を保つ。値は、まだ何も読まない型ヒント。将来の LLM ディスパッチは、それらをテンプレートコントラクトとして使う。出荷センサーの一部が受け取る追加フラグ（`--consumes`、`--deliverables`、テンプレートフラグ）は、これらのキーではなく、やはりセンサー id で選ばれる。 |
| `output_schema` | 任意 | オブジェクト | 今日は advisory。将来の LLM ディスパッチは、それをパースコントラクトとして使う。 |
| `timeout_seconds` | 任意 | int | 発火ごとの実時間上限。省略時は 1,200 秒を使う。 |

---

## `kind` enum

`kind` フィールドはディスパッチ機構を宣言します。スキーマは今日、ちょうど 1 つの値を
受け入れます。

- `deterministic` - ディスパッチャーが、発火ごとのフラグでマニフェストのワーカーを実行します。
  ワーカーは、ブール値 `pass`（加えて `findings` と、監査行が記録する数 `findings_count`）を
  持つ JSON 行を 1 つ stdout に表示し、検査が通っても失敗しても exit 0 します。ディスパッチャー
  が失敗の詳細ファイルを書きます。Exit 127 は `tool-unavailable` と注記された pass として
  記録されます。起動できないワーカー、他の非ゼロ exit、ブール値 `pass` のない出力は、
  `script-error` と注記された `SENSOR_COULD_NOT_RUN` として記録され、pass として記録される
  ことは決してありません（ゲートが何を言い、blocking ゲートの結び付きがそれで何をするかに
  ついては [`default_severity`](#default_severity) を参照）。

他のどの `kind`（`llm` を含む）も、パース時に拒否されます（「他の種類は将来のリリース向けに
予約」）。

`kind` の未知の値（`deterministic` 以外）は、パース時に拒否されます。前方互換は*未知のキー*に
適用されます（[Forward-compat policy](#forward-compat-policy) を参照）。既知のキーの未知の値
には適用されません。

---

## ステージがセンサーをインポートする方法

pull 方式のオーサリング: 各ステージのフロントマターが、それが使うセンサーを宣言します。
コンパイルリゾルバは、宣言された各 id をマニフェストレジストリで調べ、`sensors_applicable`
配列をステージのコンパイル済みグラフノードに焼き込みます。オーサリング方向は参照の局所性です。
ステージファイルを開けば、そのステージが走るときどの検査が発火するかが正確に見えます。

```yaml
# dist/claude/.claude/aidlc-common/stages/construction/ci-pipeline.md
---
slug: ci-pipeline
phase: construction
# ...
requires_stage: [...]
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
inputs: ...
outputs: ...
---
```

`sensors:` は裸の id のリストです。id は各マニフェストのフロントマター `id:` フィールドに
一致し、それは（ファイル名↔id コントラクトにより）ファイル名の語幹から `aidlc-` プレフィックス
を引いたものに等しくなります。コンパイルリゾルバは次を行います。

1. `dist/claude/.claude/sensors/` を歩き、すべての `aidlc-<id>.md` マニフェストをパースします。
2. 解決時の O(1) 検索のために、マニフェストを id でインデックスします。
3. 各ステージについて、宣言された各インポート id を調べ、未知のときは例外を投げます（発火時に
   静かにではなく、コンパイルで大きく失敗）。
4. `fire_on`、`default_severity`、`category`、`matches` を、解決済みの `sensors_applicable[]`
   エントリにコピーします。
5. ステージごとの解決済み配列を、正規の `data/stage-graph.json` に出します（FIELD_ORDER は
   ピン留め: `rules_in_context` の後）。

ランタイムの PostToolUse hook、`gate-start`、`revise` は、何が発火するかを決めるために
グラフノードから `sensors_applicable` を読みます。どれもそのためにマニフェストを再オープンしません。
ディスパッチャーは、`command`、`input_schema`、`timeout_seconds`、そしてパスに対する独自の
`matches` 再検査のためだけに、発火ごとにマニフェストを読み直します。グラフがコピーしたもの
すべて（`fire_on`、`default_severity`、`category`、hook の `matches` フィルタ）と新しいインポートは、
次のコンパイルを待ちます。ネイティブインストールでは、出荷される 6 つのセンサーは id で
バンドルされたワーカーを実行するので、その `command` を編集しても何も変わりません。センサーの
編集後は再コンパイルしてください。

### ステージごとのセンサーマトリクス（33 のフレームワークステージ）

| ステージ | `sensors:` |
|---|---|
| 3 つの初期化（workspace-scaffold、workspace-detection、state-init） | `[]`（決定的なセットアップ。エージェントがオーサリングした markdown はなし） |
| `intent-capture` | `[claim-sources, required-sections, upstream-coverage]`（`claim-sources` は、ステージの成果物にまたがって、見える インラインの出所、権威あるソースレジスタの値、正確な人間が確認した仮定を検査する） |
| 他の ideation 6 個、他の inception 6 個、operation の markdown ステージ 7 個 | `[required-sections, upstream-coverage]` |
| `user-stories`、`domain-design`、`units-generation` | `[required-sections, upstream-coverage, traceability]` |
| `build-and-test` | `[required-sections, upstream-coverage, type-check]`（linter は意図的に省略 — ビルドが正規の lint を実行する） |
| `ci-pipeline` | `[required-sections, upstream-coverage, linter, type-check]` |
| ユニット単位の construction-design ステージ 4 個（`functional-design`、`infrastructure-design`、`nfr-design`、`nfr-requirements`） | `[required-sections, upstream-coverage, linter, type-check, traceability]` |
| `code-generation` | `[required-sections, traceability]`（`linter` と `type-check` はインポートされない: それらはすべてのファイル書き込みで走り、結果を誰も読まなかった） |

`traceability` はゲート（`fire_on: gate`）で、各ステージの完成した表に対して走ります。
Requirements Analysis は、自分の `traceability.json` のために検査をインポートしません。そこに、
`requirements.md` が定義する FR と NFR の ID を、書かれたとおり（`ids`、それぞれ `kind` を持ち、
サブ要件には `of` を持つ）記録し、後のすべての検査はそこからそれらの ID を取ります。欠けている、
または正確でないレコードは、各表の要件をその表が列挙するとおりに残し、加えて FR と NFR の
パターンが `requirements.md` で見つける ID を、レコードの前と同じく残します。後のステージは、
`engine sensor-traceability --stage <slug> --output-path <table> --write-upstream` で表を
始めます。これは、検査が求めるすべての上流 ID を、それぞれ `GAP` 行とともに足し、欠けている
ものがなければ何も書きません。

フォークは、ステージの `sensors:` リストを直接編集してステージをカスタマイズします。結び付きは、
カスタマイズされる対象の隣に存在します。マニフェストは純粋な能力記述子で、ステージを対象に
するフィールドを運びません（`applies_to:` はありません。pull 方式のオーサリングがそれを
取り除きました）。厳格加算型のランタイムが適用されます。フォークがステージにセンサーを欲しがる
なら、インポートします。欲しがらないなら、省きます。考慮すべき上書き層はありません。

---

## `matches` フィルタ

`matches` は、マニフェスト上の任意のトップレベル能力記述子です。センサーが分析できるファイルの
グロブ形状を宣言します — *「このセンサーはこのグロブに一致するファイルを分析する」* — そして
コンパイル時のリゾルバではなく、ディスパッチで消費されます。

| マニフェスト | `matches` |
|---|---|
| `aidlc-claim-sources.md` | `**/{aidlc-docs,intents}/**` |
| `aidlc-required-sections.md` | `**/{aidlc-docs,intents,codekb}/**` |
| `aidlc-upstream-coverage.md` | `**/{aidlc-docs,intents,codekb}/**` |
| `aidlc-traceability.md` | `**/traceability.json` |
| `aidlc-linter.md` | `**/*.{ts,js}` |
| `aidlc-type-check.md` | `**/*.{ts,tsx}` |

`fire_on: write` では、`matches` が発火フィルタです。hook は、書き込まれているパスをグロブと
比較し、グロブのないエントリは決して発火しません。`fire_on: gate` では、`gate-start` と `revise`
が、存在する宣言済みの成果物をすべて列挙し、各センサーの `matches` 能力の外のパスをスキップし、
一致するパスだけをディスパッチします。省略されたグロブは、すべての成果物を受け入れます。
ステージ全体の出力を読む `upstream-coverage` と `claim-sources` は、出力フォルダごとに 1 回、
questions や timestamp ファイルでない最初の成果物に対してディスパッチします。コードナレッジ
ベースのステージ（Reverse Engineering）では、`required-sections` と `upstream-coverage`
（`PATH_SET_SENSOR_IDS`、`aidlc-graph.ts`）がステージに対して 1 回ディスパッチします。発火は
最初の一致するパスを名指しし、一致するすべてのパスを `--paths-stdin json` の後ろに stdin で
取り、センサーは各ファイル（またはフォルダ）を単独でのように評価し、失敗した発火の
`SENSOR_FAILED` 行がその `Failed outputs` フィールドに失敗したファイルを列挙し、ゲートの
検査行がそれを読んで `<repo>/<file>` を名指しします。blocking の結び付きは、発火がカバーする
すべてのパスを、その前にフィンガープリントされたバイトに保ちます。1 ファイルの呼び出しは
決して stdin を読みません。Construction 自律のもとでエンジンが自分で承認するゲートは、blocking
センサーだけをディスパッチします（advisory の証拠は、そこで読み手がいません）。出荷される 6 つの
マニフェストはすべてグロブを宣言します。コンパイルリゾルバはそれを `sensors_applicable[]` に
コピーします。

空文字列（`matches: ""`）はパース時に落とされるので、省略されたグロブとして振る舞います。
書き込み発火のセンサーはグロブを宣言すべきです。ゲート発火のセンサーは、宣言済みのすべての
成果物を分析するためにそれを省いてもかまいません。

### ルールとセンサーの相互参照

ルールファイルは、センサーにフィードフォワードするために `pairing: aidlc-required-sections`
（`aidlc-` プレフィックス付き）を使います。センサーマニフェストの `id:` は `required-sections`
（プレフィックスなし）です。doctor のカバレッジ検査は、マニフェスト `id` に照合する前に、
ルールの `pairing:` 値から `aidlc-` プレフィックスを剥がして正規化します。

---

## `default_severity`

`advisory` の結果は、監査行を生成しますが、ステージゲートをブロックしません。ゲートの前、
ステージのドキュメントが引き継がれるとき（`aidlc-state.ts` の `completionChecksStep`）、advisory
ゲート検査が一度走ります。レビュー要求（`aidlc-log.ts review`。状態ツールの `completion-checks`
コマンド経由で、`{"held":false}` か `{"held":true,"message":...}` を表示）か、試行でレビューが
求められなかったとき、ゲートを開く、または改訂後に再び示す報告です。試行の最初のそのような
引き継ぎ（`reviewAttemptWindow` が読む下限）は、下限以降にその（検査、出力）ペアのどれも
`SENSOR_FIRED` 行を持たないとき（パスは正規に比較）、必須の各出力が存在すれば一度、スコープの
宣言済み出力（1 ユニットのもの。行に `Unit` 付き）に対して advisory 検査を発火します。発火が
指摘を報告すると、引き継ぎは何も記録せず `print` を返します。各検査のゲート自身の文、詳細
ファイル、同じコマンドです。注記付きの pass は何も保ちません。人が求めたレビュー
（`--person-asked`）、`--retry-pending` や `--single` の要求、人の Override の選択、swarm
ワーカーのチェックアウト、エンジンが自分で承認するゲートは、保たれません。ゲートが開く、または
再び示されるとき、オーケストレーターの返信は、その `narration` の、ステージが生成したものの
後の行に、宣言済み出力での最新結果が失敗である検査ごとに 1 文を運び（`aidlc-state.ts` の
`failedCheckNotices`。高々 3 文とカウント）、エージェントが承認の質問とともに人にそれを言います。
変更行は、変わったものを保ちます。その後、1 行（いくつあっても）が、走れなかった検査（スクリプト
がクラッシュした、または起動しなかった、またはゲートがそれを実行するディスパッチャーから判定を
得なかった）を、宣言済み出力、またはステージが書いてまだそこにあるファイル（`type-check` の
ような書き込み発火の検査）に対して名指しします。走れなかった検査、または注記付きで記録された
pass（ツール利用不可）は、何も評価せず、以前の失敗を解消しません。ユニット自身のゲートは、
そのユニットの出力と書き込みだけを名指しします。センサーがオフだと何も言いません。`blocking` の
ゲートの結び付きは、検証された pass でのみ進みます。報告された指摘、ディスパッチャーの
exit/spawn/timeout 失敗、不正または不一致の判定、`SENSOR_BUDGET_OVERRIDE`、
`SENSOR_COULD_NOT_RUN`、そして注記を運ぶ `SENSOR_PASSED` 行はすべて、ゲートが開く前に
`gate-start`、`revise`、または承認時に回復された改訂の再入を止めます。

オペレーターは、指摘を直してリトライするか、別の明示的な上書き決定を下せます。conductor は、
`Fix findings,Override blocking sensors` を提供する `DECISION_RECORDED` を記録し、新しい人の
ターンを待ち、正確な `QUESTION_ANSWERED` を記録し、その後 `--override-blocking-sensors
--user-input "Override blocking sensors"` でゲート報告をリトライします。その選択が立っている間
（それ以降ステージで何も尋ねられ、答えられ、送り返されておらず、ゲートがまだ開いていない）、
`next` は、自律、チームのユニットゲート、単独の歩行が先に負うユニットステップの外で、ステージ
ではなく同じ報告を名指しします。裸のフラグ、提供されていない／言い換えられた選択、人間に
裏付けられた受領の欠如、または自律モードは拒否されます。記録された答えは、そのオプションを
ラベルで、または提供されたリスト上の番号で名指しします。Fix findings は、Request Changes が
するように新しい試行を始めます。レビュー済み出力が修正のために開き、リトライされた報告は新しい
レビューを必要とします。各ユニットのレビューが独自のところ（ユニット主体の作業、Construction の
チェックポイント、チームが所有するユニット）では、それは、1 つとともにログされたときその選択の
ユニットで、さもないと、失敗した blocking の検査がその最新結果で名指しした出力を持つユニット
だけです。どのユニットの出力も名指ししなかった検査、またはステージ主体の作業は、すべてのユニット
を再び始めます。成功した上書きは、センサー id、任意の詳細パス、評価理由を
`STAGE_AWAITING_APPROVAL` に記録します。すでに開いたゲートを再検証すると、`Revalidated: true`
を持つ新しい行を出し、受領を再利用可能なまま残すのではなく、認可の受領を消費します。このリリース
では、書き込み発火のセンサーは `blocking` を宣言してもかまいませんが、PostToolUse のディスパッチ
は advisory のままです。

---

## `fire_on`

`write` は既定で、増分的な PostToolUse フィードバックを保ちます。`gate` は、`gate-start` が
最初のゲートを開く直前、`revise` が改訂作業後にゲートに再入する前、そして承認時の改訂バックストップ
が回復された再入を行う前に、存在する宣言済みの成果物ごとに 1 回（`upstream-coverage` と
`claim-sources` は出力フォルダごとに 1 回、Reverse Engineering の `required-sections` と
`upstream-coverage` はステージに対して 1 回）発火します。誰もゲートに答えないとき（Construction
自律のもとでエンジンが自分で承認）、blocking センサーだけが発火します。advisory の証拠は、そこで
読み手がいません。`aidlc-sensor.ts fire` が `SENSOR_FIRED` と終端の両方の行の周りで監査ロックを
取るので、ディスパッチは状態トランザクションの外で起きます。blocking のディスパッチは、評価前に
一致するすべてのアーティファクトをフィンガープリントし、各センサーの後にそのフィンガープリントを
検査し、状態トランザクションの中で再び検査します。変わったバイトは、ゲートへの入場を拒否し、
リトライで評価されなければなりません。

ディスパッチャーは、終端行の後に 1 つのコンパクトな JSON 判定を表示します: `fire_id`、
`sensor_id`、`stage`、`output_path`、`result`、`detail_path`、そして任意の `note`。ゲートの
強制は、判定の同一性を検証し、blocking の結び付きに対して、注記のない `passed` 結果以外の
あらゆるものを非 pass として扱います。明示的な `--artifacts` パスと発見された成果物は、正規に
解決され、ステージの正規の produce ディレクトリの中にとどまらなければなりません。絶対パス、
トラバーサル、シンボリックリンクの脱出は、センサーをリダイレクトできません。

`failed` 結果は、その指摘を `detail_path`、ステージのセンサーディレクトリの下の新しい
`<sensor-id>-<fire-id>.md` ファイルに書きます。後の注記のない `passed` 結果は、同じ出力に
対するそのセンサーの以前のレポートだけを削除します。ステージの他の出力のレポートはそのまま
残り、後の結果が注記付きの pass や予算の上書きのときもレポートは残ります。それらは何も評価
しなかったからです。以前の `SENSOR_FAILED` 行は、剪定後もその `Detail path` を保ちます。
ファイルではなく監査行が記録です。

---

## `command:` 呼び出しコントラクト

マニフェストの `command:` は、完全な argv ではなく、**正規の呼び出しプレフィックス**です。
出荷される各センサーは、センサーごとの独自のスクリプトを名指しします。ディスパッチャー
（`aidlc-sensor.ts`）は、発火時にランタイムコンテキストを足します: 常に `--stage <stage-slug>`、
その後、マニフェストの `input_schema` が宣言するファイルフラグです。コードセンサーは `file_path`
を宣言し `--file-path <file>` を得ます。ドキュメントセンサーは他のキー（`output_path`、
`stage_slug`）を宣言し `--output-path <file>` を得ます。

```
<command> --stage <stage-slug> --output-path <file-being-written>   # document sensor
<command> --stage <stage-slug> --file-path   <file-being-written>   # code sensor
```

`input_schema` のキーを宣言しないマニフェストは、元のルーティング（`linter` と `type-check`
だけが `--file-path` を得る）を保ちます。そのため、フォークやプラグインが足すコードセンサーは、
キーを宣言しなければなりません。さもないとそのスクリプトは `--output-path` を受け取ります。

```yaml
input_schema:
  file_path: string
```

したがって、次を持つマニフェスト:

```yaml
command: aidlc engine sensor-required-sections
```

は、少なくとも `--stage <slug> --output-path <file>` を足して（加えて `required-sections` が
id で得るテンプレートフラグ）ディスパッチされます。H2 見出しが 1 つの intent statement に対して
手で発火:

```text
$ aidlc engine sensor fire required-sections --stage intent-capture --output-path aidlc/spaces/default/intents/261013-tagged-notes/ideation/intent-capture/intent-statement.md
{"fire_id":"f00255f3","sensor_id":"required-sections","stage":"intent-capture","output_path":"aidlc/spaces/default/intents/261013-tagged-notes/ideation/intent-capture/intent-statement.md","result":"failed","detail_path":"aidlc/spaces/default/intents/261013-tagged-notes/.aidlc-engine/sensors/intent-capture/required-sections-f00255f3.md"}
```

詳細ファイルの指摘（その JSON ブロックをここではフェンスなしで表示）:

```text
## Findings

{
  "pass": false,
  "h2_count": 1,
  "headings": [
    "## Problem Statement"
  ],
  "findings_count": 1
}
```

マニフェストは発火ごとのフラグをエンコードしません。ディスパッチャーがそれらを足します。
マニフェストは純粋な能力記述子のままです。

---

## ゲート儀式の引き継ぎ（surface stdout / selections-file in）

§13 の学習ゲートは tool-as-actor です。決定的なツール（`aidlc-learnings.ts`）と conductor
（ライブの `/aidlc` セッション）の間の往復には 2 つの脚があり、その間にナレッジステップと判断
ステップがあります。

1. **`surface`（stdout）。** conductor は、人がステージでそれを訂正したとき、または次回のために
   何かを保つよう求めたとき（それを読むのが conductor のナレッジ）だけ、それを実行します。
   `aidlc engine learnings surface --slug <stage-slug> --correction '<their change>'`（訂正ごとに
   1 つの `--correction`、またはシェルが読む文字を 1 つ持つもの向けには、レコードの answer-text
   フォルダの `--correction-file`）は、構造化された JSON を表示します: `candidates[]`（訂正ごとに
   1 つ、それぞれ `id`、`correction`、`default_scope: "project"` を運ぶ）と `questions[]`:
   それぞれ「You asked me to <correction>. Keep that for next time?」と、正確なオプション
   `Yes, for this project`、`Yes, for the team`、`No`、そしてその `question_kind`。`--correction`
   がないと質問を表示しません。ステージの `memory.md` 日記は数えられ（`memory_entries_total`）、
   決して提供されません。AskUserQuestion のフィールド名はありません。純粋なドメインデータです。
2. **conductor がそれらの質問を尋ねる（判断は人のもの）。** それぞれが独自の質問です。人の選択
   だけが尋ねられるものです。conductor は、その訂正から実務行を書き、自分でそれを適合する見出し
   にルーティングします。保つよう求められたメモは、尋ねられません。
3. **受け入れ競合検査（ナレッジ → オーケストレーター LLM。どの選択が persist に届くかを制御）。**
   保たれた各学習について、conductor は、提案された単一の日付付きエントリを `org.md` の一致する
   `## <section>`（§5 受け入れゲートの一行版）と比較します。矛盾があると、conductor は、矛盾する
   org の文をインラインで可視化し、ユーザーが修正／スキップ／エスカレーションします（判断 →
   ユーザー。ユーザー上書きの道なし）。競合のないもの、またはユーザーがエスカレーションした選択
   だけが進みます。センサーマニフェストには org セクションの対応物がなく、この検査をスキップします。
4. **`persist`（selections-file in）。** conductor は、保たれた選択を `surface` が返す
   `selections_file` パスに書きます: `<record>/.aidlc-engine/learnings/<slug>-selections.json`、
   またはインテントレコードがないとき `aidlc/spaces/<space>/intents/.aidlc-engine/learnings/<slug>-selections.json`
   （どちらも gitignore）、そして `aidlc engine learnings persist --slug <slug> --selections-json
   <selections_file>` を呼びます。ツールは決定的なライターです。競合を決して判定せず、そのファイル
   だけを読みます（他のどこかの、またはリンク経由で到達する selections ファイルは拒否されるので、
   1 つのプロジェクトの 2 つのチャットが互いの選択を保存することは決してありません）。各学習を実務
   として `aidlc/spaces/<surface-time-space>/memory/{project,team}.md` にルーティングし、センサー
   選択については、1 つの `withAuditLock` の中で 2 書き込みのインストール（マニフェスト + 元の
   ステージ `sensors:` フロントマター）を行い、その後 `RULE_LEARNED` / `SENSOR_PROPOSED` を出します。

selections-file は再生アーティファクトです。クラッシュした persist は、人間に再プロンプト
せずに同じ JSON を再生します（書かれた行ごとの `<!-- cid:<intent-slug>:<slug>:<content-hash> -->`
マーカー経由の内容存在冪等性 — 学習自身のテキストの完全な SHA-256 ハッシュで、その位置の候補
id ではありません）。selections-file は、候補が可視化されたとき一度結び付けられた `space`/`intent`
も運びます。`persist` はそれらを使い、ライブのアクティブインテントカーソル自体を決して再解決
しません。書き込み前に、このスペースと任意の非 null のインテントレコードがまだ存在すること、
そして要求されたスラッグが surface 時の `stage_slug` に一致することを検証します。

---

## スキャフォールドされたマニフェストの既定

センサー提案がゲートで確認されると、ゲート儀式ツールは、`<project>/.claude/sensors/aidlc-<id>.md`
に新しい**プロジェクト層**のマニフェストをスキャフォールドします。出荷されるフレームワーク
ディストリビューションには決してしません（プロジェクトごとの学習ループは、フレームワークを
変えてはなりません。フレームワークディストリビューションのパスは拒否されます）。選択がフィールド
を供給し、ツールはそれを与えられたとおりに書きます。

| フィールド | 書かれ方 | 注記 |
|---|---|---|
| `id`、`kind`、`command`、`default_severity`、`description`、`matches` | 選択の文字列 | 6 つすべてが必須。`persist` は 1 つを欠く選択を拒否する。マニフェストはやはりスキーマを通らなければならない: `kind: deterministic`、そしてツールフォルダのワーカーを名指しする `command`、ネイティブインストールでは `bun .claude/tools/aidlc-sensor-<id>.ts` と名付けられる |
| `category` | 選択が持つとき書かれる | |
| `timeout_seconds` | 供給されたとき書かれる | ディスパッチャーのフォールバックは `1200` 秒 |
| `fire_on` | 書かれない | なので、スキャフォールドされたセンサーは書き込み発火（既定） |
| `input_schema`、`output_schema` | 書かれない | `input_schema` のキーがないと、カスタムセンサーは `--output-path` を得る |

マニフェストをスキャフォールドした後、ゲート儀式ツールは、同じ `withAuditLock` トランザクション
の中で、元のステージの `sensors:` フロントマターリストに新しい id を足します（pull 方式の
オーサリングの 2 書き込みインストール）。センサーは、次のワークフローがコンパイルされると完全に
配線されます。これは、認められた唯一のステージフロントマター編集です。インポートリストを増やし
（形は不変で、内容は不変ではない）、`## Steps` / `## Sensors` / `## Learn` の本体は決して増やしません。

出荷される 6 つのマニフェストは、明示的な発火ごとの上限を設定します。`claim-sources`、
`required-sections`、`upstream-coverage`、`traceability` は `timeout_seconds: 300` を使います。
`linter` と `type-check` は `1200` を使います。ディスパッチャーのフォールバックは、5 分の通常と
15 分の複合の [runtime backstops](06-hooks-and-tools.md#runtime-and-native-hook-budgets) の和です。
各 ESLint のプローブ／設定／lint のサブプロセスは 5 分です。TypeScript のプローブは 5 分、
コンパイルは 15 分です。発火ごとの上限は、ネストしたコマンドを含め、センサープロセス全体を
境界づけます。明示的により短いマニフェスト値は、権威あるままです。

書き込み hook は、各ディスパッチャーサブプロセスに既定で 30 分を与えます。
`AIDLC_SENSOR_TIMEOUT_MS`（またはプロジェクト／ユーザーの `sensorTimeoutMs` 設定）が、その
囲む許容を上書きします。より短い囲む上限は、ディスパッチャーが終端センサー行を公開する前に
それを中断することがあります。hook は doctor 向けにドロップを記録します。センサー自身の発火
ごとの上限に達すると `SENSOR_BUDGET_OVERRIDE` を生成します。不完全なネストした lint/compile の
実行は could-not-run のパスに従い、利用できないプローブは tool-unavailable のパスに従います。
どちらも、blocking ゲートの検証された pass を確立しません。ゲートのディスパッチは、別途
`AIDLC_GATE_SENSOR_DISPATCH_TIMEOUT_MS` を受け入れます。未設定のとき、センサーの発火ごとの
上限を超える囲むタイムアウトを足しません。

---

## 前方互換の方針

センサーマニフェストの消費側（コンパイル、ディスパッチャー、ゲート儀式のスキャフォールディング、
doctor）は、**未知のマニフェストキー**を許容しなければなりません。将来のリリースが任意の
`cool_new_field:` を足すと、古い消費側はマニフェストをパースし、そのフィールドを無視し、続けます。
これにより、フォークやアップグレード前のワークスペースを壊さずに、スキーマを加算的に進化させられます。

前方互換は、既知のキーの未知の値には適用されません。上の [`kind` enum](#kind-enum) に文書化した
とおり、`kind` の未知の値は、パース時に拒否されます。同じ原則が、他の enum 形状のフィールド
（`default_severity`、`fire_on`）に適用されます。

---

## 将来のリリース向けに予約

いくつかのセンサー能力は、スキーマで予約されていますが、まだアクティブではありません。そのため、
それらが着地したときフィールドの形は安定しています。

- **`kind: llm` ディスパッチ** - LLM が評価するセンサー。スキーマは、`deterministic` 以外の
  `kind` をパース時に拒否します。
- **書き込み時の blocking** - `blocking` は書き込み発火のマニフェストで受け入れられますが、この
  リリースではゲート発火の失敗だけが強制されます。パーサーはその組み合わせを拒否しません。

## 次のステップ

- **ルール** — 制御ループのフィードフォワード側の半分は、`pairing:` フィールド経由でこれらの
  センサーと組み合わさります。[Rule System](08-rule-system.md) を参照してください。
- **利用者向けの学習ループ** — センサー提案がゲートでどう可視化され確認されるか、そして確認
  された提案がどう新しいマニフェストをスキャフォールドするか。User Guide の [Rules and the
  Learning Loop](../guide/09-rules-and-the-learning-loop.md) を参照してください。
- **コンパイルの境界** — `sensors_applicable` がワークフロー開始時に一度解決され、発火時に
  グラフノードから読まれる仕組み。[Plane Architecture](02-plane-architecture.md) を参照してください。

上のスキーマに加え、`dist/claude/.claude/sensors/` の出荷される 6 つのマニフェストが、動く例です。

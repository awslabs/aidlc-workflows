# Sensors

センサーは、該当する書き込み時やステージの承認ゲートで自動的に走る、決定的なチェックです。ルールがエージェントの読むプロセ（[Rules and the Learning Loop](05-rules-and-the-loop.md)）であるのに対し、センサーは実際に走るコードです。ルールのフィードフォワードに対して、センサーは制御ループのフィードバック側を担います。ルールが「ユーザーストーリーは Given/When/Then に従う」と述べ、センサーは、必要な見出しがエージェントの書いたファイルにあるかをバイト単位で検証します。

この章では、ハーネスエンジニアがセンサーで実際に行う作業を物語ります。同梱の 6 つを理解し、新しいマニフェストを作り、それを走らせたいステージに紐づけます。フィールドごとの完全な契約は Developer Reference の [Sensor System](../reference/07-sensor-system.md) にあります。この章では、スキーマの判断ごとにそこへ指し示し、内容の繰り返しは避けます。

---

## センサーとは

センサーマニフェストは、YAML フロントマターを持つ Markdown ファイルで、`core/sensors/` 配下に置きます。フロントマターは純粋な**能力の記述子**です。チェックが何であり、どう呼び出すかを述べます。どのステージがそれを使うかは述べません。その紐づけはステージ側にあり、これがこの章の中心的な考えであり、マニフェストとステージが疎結合でいられる理由です。

ランタイムの振る舞いを決める性質が 3 つあり、どれも何かを作る前に押さえておく価値があります。

- **`fire_on: write` は作成中に走ります。** `PostToolUse` フックが、Write または Edit のたびに、該当する各センサーを走らせます。`fire_on` を省略したときの既定値です。
- **`fire_on: gate` は成果物ごとに一度走ります。** `gate-start` がステート処理を開く直前に、ステートツールが、宣言された既存の各成果物パスについて、ゲートに紐づく各センサーを一度走らせます（`upstream-coverage` と `claim-sources` はステージ出力全体を読むので、出力フォルダごとに一度です）。Reverse Engineering では、そのファイルが各リポジトリのコードナレッジベースフォルダで繰り返されるため、`required-sections` と `upstream-coverage` はステージに対して各リポジトリのファイルを通して一度走り、失敗したファイルはそのリポジトリ名とともに示されます（`service-007/dependencies.md`）。Construction 自律のもとでエンジン自身が承認するゲートは blocking センサーだけを走らせます。そこでは advisory な証拠に読み手がいないからです。センサーのディスパッチャーが audit ロックを取るため、ディスパッチは処理の外にとどまります。
- **advisory なゲートチェックも、ゲートの前に一度走ります。** ステージの文書が書かれて引き渡されると、その試行の最初の引き渡し（レビュー依頼か、レビューを経ずにゲートを開くレポート）が、それらの文書に対して advisory なゲートチェックを走らせます。あるチェックが指摘を報告すると、引き渡しは何も記録せず、エージェントの手番として戻り、指摘と同じコマンドを示します。エージェントは自分のぶんを直し、再度走らせ、進みます。こうしてレビューは整った文書を見て、すべてのチェックを再度走らせるゲートは、残っているものだけを示します。blocking チェックはゲートでのみ走ります。人が依頼するレビュー、独立した `--single` 実行、スワームワーカーのチェックアウトで組み立てられる Unit、エンジン自身が承認するゲートは、このステップを飛ばします（`aidlc-state.ts` の `completionChecksStep`）。
- **severity がゲートの強制を決めます。** `advisory` の結果は記録され、ゲートはそのまま開きます。`blocking` の紐づけは、検証された合格を要します。指摘、使えないツール、スクリプト/ディスパッチャーのエラー、不正な verdict、タイムアウトは、ゲートへの入室を止めます。オーバーライドは、素のフラグではなく、別途ログされる人間の決定であり、自律モードでは禁じられています。オーバーライドが成功すると、`STAGE_AWAITING_APPROVAL` に id、任意の詳細パス、理由が記録されます。blocking の強制は、このリリースでは `fire_on: gate` にのみ適用されます。write で走るセンサーは `blocking` を宣言できますが、その結果は advisory のままです。

走るたびに、intent の `audit/` シャードに 1 行残ります。イベント名（ログを grep するとき大文字小文字がそのまま効きます）は、センサーが始まると **`SENSOR_FIRED`**、合格すると **`SENSOR_PASSED`**、ギャップを見つけると **`SENSOR_FAILED`**、スクリプトがクラッシュしたか起動できないと **`SENSOR_COULD_NOT_RUN`** です。失敗した行は、`<record>/.aidlc-engine/sensors/<stage-slug>/`（intent のレコードディレクトリ内）配下の詳細ファイルにリンクし、そこに具体的なギャップ（欠けた見出し、参照されていない上流成果物、lint エラー）を名指します。実行中にこれがどう見えるかのユーザー向けツアーは、User Guide の [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) にあります。

---

## 同梱される 6 つのセンサー

`.claude/sensors/` 配下に 6 つのマニフェストが同梱され、それぞれ `aidlc-` を接頭辞に持ちます。

| マニフェスト | ディスパッチ | チェック内容 |
|----------|----------|--------|
| `aidlc-claim-sources.md` | Gate | Intent Capture の各主張が、解決可能なソースタグを持つ。登録された description、scope、memory の値が、信頼できる入力と一致する。残された assumption が、人間の明示的な確認と正確に一致する |
| `aidlc-required-sections.md` | Gate | チームテンプレートが適用されるとき、出力がそのテンプレートの `##` 見出しを備える。テンプレートがなければ何も要求しない。失敗は、欠けているものを一文で示す |
| `aidlc-upstream-coverage.md` | Gate | ステージの成果物（集合として評価される）が、そのステージが要求を宣言した（`required: true`）、または `cited: true` を付けた各上流成果物を、slug、wikilink、生成ステージのディレクトリパスのいずれかで参照する |
| `aidlc-traceability.md` | Gate: `**/traceability.json` | 安定した上流 ID、ステータス、決定的なターゲット、派生したビジネスルールの orphan を検証する |
| `aidlc-linter.md` | Write: `.ts` / `.js` | 設定された linter（既定で ESLint）をラップする |
| `aidlc-type-check.md` | Write: `.ts` / `.tsx` | 設定された型チェッカー（既定で `tsc`）をラップする |

6 つすべてが `matches:` の glob で絞られます（詳しくは後述）。provenance チェックと 2 つの文書形状チェックは成果物ツリーにスコープされ（同梱マニフェストは `**/{aidlc-docs,intents}/**` を持ちます。per-intent のレコードツリーに、移行前プロジェクト向けの旧 `aidlc-docs/` の枝を残しています）、traceability は `**/traceability.json` に、2 つのコード品質チェックはそれぞれの言語 glob（`**/*.{ts,js}`、`**/*.{ts,tsx}`）にスコープされます。2 つの文書形状チェックは 3 つめの `codekb` の枝を加え、reverse-engineering が書くスペースレベルの CodeKB にも届きます。自分で作る前に、`aidlc-required-sections.md` を端から端まで読んでください。6 つの中でもっとも小さく、フロントマターとプロセ本体という全体の形を示します。

---

## 紐づけの仕組み: pull authoring

マニフェストは**ステージを対象とするフィールドを持ちません**。`applies_to:` はなく、フレームワークは意図的にそれを取り除きました。ステージは、自分のフロントマターでセンサーを名指すことで、自分の出力に何が走るかを決めます。

```yaml
# core/aidlc-common/stages/construction/ci-pipeline.md (フロントマター、ほかのキーは省略)
---
...
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
...
---
```

これが **pull authoring** であり、ハーネスモデルのほかのあらゆる紐づけと同じ向きです。コンシューマー（ステージ）が能力（センサー）を名指し、その逆はありません。`sensors:` のリストは素の id（`aidlc-linter` を縮めた `linter`）を持ちます。id がマニフェストのフロントマター `id:` フィールドと一致し、それは `aidlc-` 接頭辞を外したファイル名のステムに等しいからです。

利点は参照の局所性です。ステージファイルを開けば、そのステージが走るときに何のチェックが走るかがそのまま見えます。このステージを対象にすると主張するマニフェストを探して、すべてを走査する必要はありません。同じ `sensors:` 区画は [Anatomy of a Stage](01-anatomy-of-a-stage.md) でステージ側から説明されています。ここではセンサー側から見ています。

グラフがコンパイルされると、リゾルバが `.claude/sensors/` を歩き、すべてのマニフェストを id で索引し、各ステージについて宣言された各インポートを引きます。id にマニフェストがなければ、ステージ実行時に黙って失敗するのではなく、コンパイル時に大声でエラーにします。ステージがどのセンサーをインポートするかはグラフノードに焼き込まれ、各マニフェストの `matches` も同様で、これは write フックがセンサーを走らせるか判断するのに使います。ディスパッチャーはセンサーが走るたびにマニフェストを読み直すので、変えた `command` や `timeout_seconds` は次の発火から効きますが、変えた `matches` と新しいインポートは次のコンパイルを待ちます。予測可能な振る舞いのため、センサーを編集したら再コンパイルしてください。native インストールでは、同梱される 6 つのセンサーのワーカーは id で選ばれるので、同梱マニフェストの `command` を編集しても別のものは走りません。別のチェックには自分の id が要ります。リゾルバの完全な仕組みは [How stages import sensors](../reference/07-sensor-system.md#how-stages-import-sensors) にあります。

---

## 新しいセンサーを作る

センサーの追加は 2 つの書き込みです。マニフェスト、そして紐づけです。

**1. `core/sensors/aidlc-<id>.md` にマニフェストを置く。** ファイル名のステム（`aidlc-` 接頭辞を外したもの）は、フロントマターの `id:` と一致していなければなりません。フロントマターは短く、必須が 5 フィールド、任意がいくつかです。

| フィールド | 必須 | 内容 |
|-------|----------|------------|
| `id` | yes | kebab-case。`aidlc-` を外したファイル名のステムに等しい |
| `kind` | yes | 今日受け付ける値は `deterministic` だけ |
| `command` | yes | ディスパッチャーが走らせる、正規の呼び出しプレフィックス |
| `default_severity` | yes | `advisory` か `blocking`。blocking はゲートディスパッチでのみ強制される |
| `description` | yes | 一行の人間向け説明 |
| `category` | no | 自由形式のラベル（同梱マニフェストは `document-shape`、`code-quality` を使う） |
| `fire_on` | no | `write` か `gate`。既定は `write` |
| `matches` | no | write パスのフィルタ。ゲートディスパッチでは、glob を省くと宣言された全成果物を受け入れる |

`command:` が持つのは呼び出しの**プレフィックス**であって、完全な argv そのものではありません。ディスパッチャーは発火時にランタイムのコンテキストを付け足します。常に `--stage <slug>`、続いてマニフェストの `input_schema` が宣言するファイルフラグです。`file_path` キーを宣言するセンサーは `--file-path <path>` を受け取り（`linter` や `type-check` などのコードセンサー）、ほかのキーを宣言するものは `--output-path <path>` を受け取ります（文書センサー）。追加するコードセンサーは `input_schema:` の下に `file_path` を宣言しなければならず、さもないとそのスクリプトは `--output-path` を受け取ります。こうしてマニフェストは純粋な能力の記述子のままで、発火ごとのフラグを一切持ちません。ディスパッチャーが組み立てる正確な呼び出しは [`command:` invocation contract](../reference/07-sensor-system.md#command-invocation-contract) に記されています。完全なスキーマ（`input_schema`、`output_schema`、`timeout_seconds`、未知のキーに対する前方互換ポリシー）は [Sensor Manifest Schema](../reference/07-sensor-system.md#sensor-manifest-schema) を参照してください。

**2. id をステージの `sensors:` リストに加えて紐づける。** ディレクトリに置かれたマニフェストは、ステージがインポートするまで何もしません。チェックを走らせたいステージを開き、素の id をそのフロントマターの `sensors:` リストに加えると、紐づけは次のコンパイルで効きます。センサーを複数のステージで走らせるには、それぞれに id を加えます。strict-additive で、考えるべきオーバーライドレイヤーはありません。あるステージでセンサーの発火を止めるには、そのステージから id を外します。マニフェストは変わらず、インポートのリストだけが変わります。

`aidlc-` のファイル名接頭辞は、カスタムを含むすべてのセンサーで必須です。コンパイルのリゾルバ（`aidlc-graph.ts` の `loadSensors`）は、`SENSOR_FILE_REGEX = /^aidlc-([a-z][a-z0-9-]*)\.md$/` でマニフェストを見つけ、接頭辞のないファイルは黙って飛ばすので、見つからず、ステージに紐づきません。センサーを `core/sensors/aidlc-<id>.md` と名づけ、`id: <id>` を設定してください。ファイル名と id の規則は、接頭辞のあとのステムに適用されます。

### 完全な例

文書にまだ TBD が残っているあいだ失敗する、ゲートセンサーです。マニフェスト `aidlc-no-tbd.md` を sensors フォルダに置きます。

```markdown
---
id: no-tbd
kind: deterministic
command: bun .claude/tools/aidlc-sensor-no-tbd.ts
default_severity: advisory
description: The document has no TBD left in it
category: document-shape
fire_on: gate
matches: "**/intents/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings: string[]
  findings_count: number
timeout_seconds: 60
---

# no-tbd

Fails when a stage output still says TBD, listing each line that does.
```

そしてワーカー `aidlc-sensor-no-tbd.ts` を tools フォルダに置きます。ワーカーは `main(argv)` をエクスポートし（native エンジンがファイルをインポートして呼び出し、最後の行が Bun のもとでそれを走らせます）、`--output-path` のあとのパスを読み、`pass`、見つけたもの、`findings_count`（audit 行が記録する件数。なければ行は 0 になります）を JSON 1 行で出力します。何を見つけても exit 0 です。

```ts
// no-tbd sensor: print {"pass", "findings", "findings_count"} for the file after --output-path.
import { readFileSync } from "node:fs";

export function main(argv: string[]): void {
  const file = argv[argv.indexOf("--output-path") + 1];
  const lines = readFileSync(file, "utf-8").split("\n");
  const findings = lines.flatMap((line, i) => (/\bTBD\b/.test(line) ? [`line ${i + 1}: ${line.trim()}`] : []));
  console.log(JSON.stringify({ pass: findings.length === 0, findings, findings_count: findings.length }));
}

if (import.meta.main) main(process.argv.slice(2));
```

`no-tbd` をステージの `sensors:` リストに加えて再コンパイルします。インストール済みの Claude Code ツリー（`.claude/sensors/` と `.claude/tools/` の 2 ファイルを、[Adding a Stage](02-adding-a-stage.md) の glossary ステージに紐づけたもの）では、エンジンがこう記述します。

```text
$ aidlc engine sensor describe no-tbd
id: no-tbd
kind: deterministic
command: bun .claude/tools/aidlc-sensor-no-tbd.ts
default_severity: advisory
description: The document has no TBD left in it
category: document-shape
matches: **/intents/**
timeout_seconds: 60
path: .claude/sensors/aidlc-no-tbd.md
```

そして TBD 行のあるファイルに対して手で発火させます（`fire` は 1 行を出力します）。

```text
$ aidlc engine sensor fire no-tbd --stage glossary-capture --output-path aidlc/spaces/default/intents/261013-lab/inception/glossary-capture/glossary.md
{"fire_id":"cd665332","sensor_id":"no-tbd","stage":"glossary-capture","output_path":"aidlc/spaces/default/intents/261013-lab/inception/glossary-capture/glossary.md","result":"failed","detail_path":"aidlc/spaces/default/intents/.aidlc-engine/sensors/glossary-capture/no-tbd-cd665332.md"}
```

詳細ファイルは、ワーカーが出力した finding を載せます（ここでは JSON ブロックをフェンスなしで示します）。

```text
## Findings

{
  "pass": false,
  "findings": [
    "line 6: - Reorder level: TBD"
  ],
  "findings_count": 1
}
```

そして audit シャードに失敗行が入ります。

```text
## Sensor Failed
...
**Event**: SENSOR_FAILED
**Fire id**: cd665332
**Sensor ID**: no-tbd
**Stage slug**: glossary-capture
**Output path**: aidlc/spaces/default/intents/261013-lab/inception/glossary-capture/glossary.md
**Detail path**: aidlc/spaces/default/intents/.aidlc-engine/sensors/glossary-capture/no-tbd-cd665332.md
**Findings count**: 1
```

行が直されると、次の発火は `"result":"passed"` を報告し、先の詳細ファイルは削除されます。非ゼロで終了したワーカーは `"result":"could-not-run"` として記録され、`"note":"script-error: exit-1"` のような注記が付き、ゲートはチェックを走らせられなかったと述べます。

---

## 判断どころ: `fire_on`、`matches`、`default_severity`

マニフェストの大半は機械的です。2 つのフィールドが本当の作成の判断を担います。

**`fire_on` — 役に立つチェックの境界はどこか。** 繰り返しのチェックが役立つ、速くて逐次のフィードバックには `write` を使います。最終的なステージ出力に対して一度だけ走るべき、成果物全体またはファイル横断のチェックには `gate` を使います。省略すると `write` になります。

**`matches` — どんな形のファイルを解析すべきか。** `fire_on: write` では、この glob が発火フィルタであり、事実上必須です。フックは書き込まれたパスが一致したときだけ発火し、`matches` のないエントリは決して発火しません。`fire_on: gate` では、ステートツールが同じ能力チェックを、宣言された既存の各成果物に適用し、一致するファイルだけをディスパッチします。`matches` を省くと、すべてを受け入れます。コード品質センサーはこれをコードの glob に設定し（`aidlc-linter.md` は `**/*.{ts,js}`、`aidlc-type-check.md` は `**/*.{ts,tsx}`）、コードの書き込みでだけ発火してプロセでは静かにします。文書形状センサーは成果物ツリーにスコープされ、ステージが書くどの markdown 成果物でも発火します。チェックが意味を持つファイルの形を決め、それを覆うもっとも狭い glob を書いてください。空の `matches: ""` は parse 時に拒否されます。write で発火するセンサーは形を名指さなければならず、gate で発火するセンサーはこのフィールドを省いて宣言された全成果物を受け入れられます。完全な振る舞いは [`matches` filter](../reference/07-sensor-system.md#matches-filter) にあります。

**`default_severity` — シグナルか強制か。** `advisory` は結果を記録して続けます。`blocking` は、ディスパッチャーが検証された合格を返さないかぎり、gate で発火するセンサーを止めます。指摘、評価できない状態、不正な出力、タイムアウトはすべて拒否します。オペレーターは問題を直すか、ログされる 2 択のプロンプトから `Override blocking sensors` を明示的に選び、フラグと正確な `--user-input` を付けて再試行できます。自律モードはオーバーライドできません。write で発火するセンサーの blocking はスキーマが受け付けますが、このリリースでは advisory のままです。ポリシーは [`default_severity`](../reference/07-sensor-system.md#default_severity) にあります。

---

## 学習ループがセンサーを代わりにインストールするとき

センサーは、いつも手で作るとはかぎりません。§13 の学習ゲートは、ワークフロー中にセンサーの提案を確認すると、1 つインストールできます。決定的なチェックがステージの出力で発火すべきだと決め、ゲートでそれにチェックを入れると、フレームワークは手でやるのと同じ 2 つの書き込みをします。**project-tier** のマニフェストをプロジェクトの `.claude/sensors/aidlc-<id>.md` に足場として作り（同梱のフレームワーク配布ではありません）、新しい id を発端のステージの `sensors:` インポートリストに、アトミックに加えます。そのゲート確認の経路は **`SENSOR_PROPOSED`** の audit 行を出すので、紐づけが黙ってインストールされることはありません。ループとその `SENSOR_PROPOSED` 行は [Rules and the Learning Loop](05-rules-and-the-loop.md) で扱い、ユーザー向けのウォークスルーは User Guide の [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) にあります。

この章の手で作る経路と、ループがインストールする経路は、同じ成果物（マニフェストとインポートリストのエントリ）を生みます。違うのは、誰が始めるかです。ファイルを直接編集するあなたか、ワークフロー中にあなたがした修正を捉えるゲートかです。

---

## Next

[Team Knowledge](07-team-knowledge.md) — エージェントが作業前に読み込むドメインコンテキストを与えます。ハーネスエンジニアが形づくる最後のデータ面です。

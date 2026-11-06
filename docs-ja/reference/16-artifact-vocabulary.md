# アーティファクト語彙

この章は、AI-DLC のアーティファクト名について成文化したルールです。各ステージの
`produces:` と `consumes[].artifact:` の YAML フロントマターに現れる正規の
文字列を扱います。命名の形、衝突解決の方針、ファイルシステムパスの規約、そして
コマンドラインからライブのレジストリを見る方法を取り上げます。

レジストリ自体は導出されるもので、書かれるものではありません。「どの正規名が
存在するか」の権威ある情報源は、すべてのステージファイルの `produces[]` フィールドを、
各ステージの `optional_produces[]`（ステージがユニットごとに条件付きで書くかもしれない
アーティファクト。フィールドリファレンスは `15-stage-definition.md` を参照）と
和集合にしたものです。そのため、条件付きで生成される名前も登録されたままで、その
生成元に解決できます。`core/tools/aidlc-graph.ts` のヘルパーが、コンパイル済みの
ステージグラフを読み、その和集合を集合として返します。これはスコープ（`aidlc-lib.ts` の
`validScopes()`）やエージェント（`aidlc-lib.ts` の `loadAgents()`）に使われているのと
同じパターンです。レジストリをこの章の外に置くことで、並行して手で保守される
リストが招くドリフトを防ぎます。

---

## ここでのアーティファクトとは

アーティファクトとは、生成側ステージが YAML フロントマターで宣言する正規の識別子です。
他のステージは、`consumes[]` で同じ識別子を参照して読み取り依存を宣言します。消費される
識別子には、必ず生成元が 1 つだけあります。消費されない名前は、それぞれの記録ディレクトリ
の下で独立したファイルを書くステージどうしで共有してもかまいません。識別子は短い
kebab-case の文字列で、ファイル拡張子も、フォルダのプレフィックスも、スラッシュもありません。

具体例として、Scope Definition ステージのフロントマター
（`core/aidlc-common/stages/ideation/scope-definition.md`）を挙げます。

```yaml
slug: scope-definition
# ...
produces:
  - scope-document
  - intent-backlog
  - scope-definition-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
  - artifact: constraint-register
    required: false
```

ここで `scope-document`、`intent-backlog`、`scope-definition-questions` は
scope-definition ステージが生成するアーティファクトです。`intent-statement`、
`feasibility-assessment`、`constraint-register` はそれが消費するアーティファクト
（他のステージが生成したもの。最初のものは `intent-capture`、他の 2 つは `feasibility`）です。

このレジストリでアーティファクトでないもの:

- **ファイルパス。** `<record>/ideation/scope-definition/scope-document.md`
  （`<record>/` はインテントの記録ディレクトリ `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`）
  はファイルシステム上の場所です。正規名は `scope-document` です。下の
  「ファイルシステムの対応付け」を参照してください。
- **ファイル名。** ディスク上の `.md` ファイルと正規名は一致しなくてかまいません
  （衝突時を除き、たいていは一致します）。
- **状態の配管。** `aidlc-state.md` と `audit/` のシャードは、`produces[]` 経由の
  ステージではなく、ツール（`aidlc-state.ts`、hook スクリプト）が管理します。これらは
  レジストリに一切現れません。
- **ランタイム値。** "user's prose answer" や
  "workspace classification (greenfield/brownfield)" のような文字列は、ステージ間で永続
  する耐久的なアーティファクトではなく、動的なデータです。

---

## 導出のルール

1. **ステージファイルが権威を持ちます。** 各ステージの `produces:` リストは、その
   ステージが出すすべての正規名を宣言します。`consumes:` は、ステージが依存する正規
   文字列を名指しします。
2. **レジストリは計算されるもので、書かれるものではありません。**
   `aidlc engine graph artifacts` を実行すると、ライブのレジストリが表示されます。
   1 行に 1 つの名前が、アルファベット順に並びます。ツールは、コンパイル済みの
   `stage-graph.json` から、すべてのステージの `produces[]` と `optional_produces[]`
   を和集合にします。
3. **この章に並行リストはありません。** 読み手が列挙を求めるなら、ツールを実行します。
   この章は、正規名をレジストリ表として一覧しません。
4. **所属は doctor が検証します。** `/aidlc --doctor` は "Graph references" 検査
   （`aidlc-utility.ts`）を実行します。すべての `consumes[].artifact` エントリと
   `requires_stage[]` スラッグは、導出されたレジストリに対して解決できなければなりません。
   孤立した消費側は、壊れた参照として報告されます。

33 個すべてのステージファイルが `produces:` を宣言しているので、導出は完全なレジストリを
返します。ツールは空のデータに対してもきちんと定義されています。`produces:` を持たない
ステージは何も貢献しないだけです。ただし出荷されるフレームワークでは、すべてのステージが
埋まっています。

---

## 命名のルール

すべての正規名は `/^[a-z][a-z0-9-]*$/` を満たさなければなりません。これは
`core/tools/aidlc-stage-schema.ts` の `SLUG_RE` が強制する形です。つまり:

- **小文字のみ。** `ScopeDocument` や `SCOPE_DOCUMENT` ではなく `scope-document`。
- **ファイル拡張子なし。** `scope-document.md` ではなく `scope-document`。
- **フォルダのプレフィックスなし、スラッシュなし。**
  `ideation/scope-definition/scope-document` ではなく `scope-document`。
- **文字で始める。** `s1` は合法です。`1-thing` は違います。
- **内部のハイフン、数字、小文字のみ。** アンダースコア、空白、Unicode 文字は不可。

質問アーティファクトは、慣例として `<stage-slug>-questions` の規約に従います。ユーザー
入力を集めるステージは、主な成果物の隣に兄弟の `<slug>-questions` 正規名を宣言します。
慣例であって、パーサーのルールではありません。

この形はフラットな名前空間です。`<phase>/<stage>/<artifact>` のような階層的な
プレフィックスはありません。これは他のすべての AI-DLC 識別子と一致します。エージェント
スラッグ、スコープ名、ステージスラッグ、フェーズ名はすべてフラットな kebab です。

---

## 衝突の方針

2 つのステージは、いずれかのステージがその名前を消費するとき、`produces[]` と
`optional_produces[]` にまたがって同じ正規名を宣言**してはなりません**。`aidlc-graph compile`
は、その曖昧さを拒否します。ランタイムの消費解決は、所有する生成元を 1 つ必要とするからです。
エラーは、すべての生成ファイルと 1 つの消費ステージを名指しします。同じ消費される概念が
2 つのステージから出されるときは、曖昧さをなくす別々の名前を選んでください。

共有名は、どのステージも消費しないとき有効です。出荷される `traceability` アーティファクトは
このパターンに従います。9 つのステージがそれぞれ自分の記録ディレクトリの下に自分の
`traceability.json` を書き、下流のどのステージも `producersOf()` で `traceability` を
解決しません（トレーサビリティ検査は、Requirements Analysis の記録をそのパスで読みます）。

今日の 1 つの例: `build-and-test`（Construction）と `performance-validation`（Operation）の
両方が、`test-results.md` というファイルを書きます。正規名は分割されているので、2 つが
配線上で衝突することはありません。

- `build-test-results` — `build-and-test` が出します。そのステージの兄弟名、
  `build-instructions`、`build-and-test-summary`、そしてそのステージが
  `optional_produces` の下で宣言する戦略依存の `integration-test-instructions`、
  `performance-test-instructions`、`security-test-instructions` と対になります。
- `unit-test-instructions` は `code-generation` がユニットごとに生成し、`build-and-test`
  が消費します。
- `source-manifest.json` は、`code-generation` が宣言するアーティファクトに対する、
  エンジンが必須とするユニット単位の相方です。これは意図的に `produces[]` に**ありません**。
  その集合を変えると、進行中のアーティファクトフィンガープリントがさかのぼって無効になる
  からです。この厳格な JSON マニフェストは、作成、変更、削除されたアプリケーションソース
  パスを記録します。終端レビューのスタンプにはこれが必要で、そのバイト／内容の主張は
  `Unit Source Fingerprint` に結び付けられます。
- `load-test-results` — `performance-validation` が出します。同じステージがすでに生成する
  `load-test-plan` と対になります。

両方の名前とも、今日はそれぞれのステージの `produces:` リストに出荷されています。

**ディスク上のファイル名は一致しなくてかまいません。** 両方のステージが、それぞれの
フォルダで `test-results.md` に書き続けてかまいません。正規名は配線上の識別子であって、
ファイル名ではありません。

---

## ファイルシステムの対応付け

アーティファクトは、`(正規名) + (生成側ステージ) + (ユニット単位フラグ)` から導出できる
パスでディスク上に存在します。Markdown が既定の拡張子です。正規の `traceability`
アーティファクトは構造化データの例外で、`traceability.json` に解決されます。2 つの配置の
形があります。

- **ユニット単位でないステージ（30 個中 25 個）:**
  `<record>/<phase>/<stage>/<artifact-filename>`
  例: `feasibility-assessment`（Ideation の `feasibility` ステージが生成）は
  `<record>/ideation/feasibility/feasibility-assessment.md` に存在します。

- **ユニット単位の Construction ステージ（30 個中 5 個）:** `nfr-requirements`、
  `nfr-design`、`functional-design`、`infrastructure-design`、`code-generation`。
  これらは Construction 中に、作業ユニットごとに各アーティファクトのコピーを 1 つずつ
  出します:
  `<record>/construction/{unit-name}/<stage>/<artifact-filename>`
  例: `functional-spec`（`functional-design` が生成）は
  `<record>/construction/{unit-name}/functional-design/functional-spec.md` に存在します。

ユニット単位かどうかは、ステージの `for_each: unit-of-work` フロントマターフィールドで
宣言されます。ユニットごとに 1 回走る 5 つの Construction ステージはこれを持ち、残りは
省きます。将来のヘルパーは、ステージグラフと正規名からパスを機械的に計算できるでしょう。

`aidlc-lib.ts` の `artifactFilename()` は、ディレクティブ、ユニット単位のカバレッジ、
完了ガード、レビューフィンガープリントが使う共有の拡張子リゾルバです。`traceability` を
除くすべてのアーティファクトは `<canonical-name>.md` に解決されます。`traceability` は
`traceability.json` に解決されます。

**レビュー記録はアーティファクトではありません。** レビュアーを伴うステージのレビュー結果
（判定、指摘、レビュアー、リクエスト id、それが結び付けるフィンガープリント、レビュー本文）
は、フレームワークが所有する記録に存在します。ステージスコープでは
`<record>/.aidlc-engine/reviews/<stage>/stage/<attempt>/<iteration>.json`、
ユニットでは `<record>/.aidlc-engine/reviews/<stage>/units/<unit>/<attempt>/<iteration>.json`
で、`aidlc-log.ts review --verdict` だけが書き、`REVIEW_COMPLETED` 行がそのダイジェスト
とともに名指しします。同じコマンドは、レビュアーのレポートの代わりにそのレビュー時点で
エンジンが所有する指摘リストを置いた、読める形のレビューのコピーを、レビュー対象の
アーティファクトの隣の `<stage dir>/reviews/review-NN.md` に書きます。このコピーは人間向けで、
アーティファクトではなく、読み返されることは一切ありません。ステージの `review_artifact`
は、レビューがどの宣言済みアーティファクトについてのものかを名指しします（ゲートの
`**Review:**` パスと、`--reject-finding` / `--reopen-finding` / `--fix-finding <artifact>#R-NN`
のセレクタキー）。レビュアーはそれに書き込むことはありません。アーティファクト内部の終端
`## Review` セクションは、レビュー記録が存在する前に記録されたレビューです。移行のために
読めますが、新たに書かれることは一切ありません。

**サマリー認可もアーティファクトではありません。** ステージ（とユニット）のアクティブな
サマリー確認は、ステージスコープでは
`<record>/.aidlc-engine/summary-authorization/<stage>/stage.json`、ユニットでは
`<record>/.aidlc-engine/summary-authorization/<stage>/units/<unit>.json` に存在します。
`Looks correct` で `aidlc-log.ts answer --checkpoint summary-confirmation` が書き、
`Request changes` で削除します。受領行が運ぶ `Summary Authorization Id` を保持します。
write-audit hook がこれを読んで、ステージの `ARTIFACT_CREATED`/`ARTIFACT_UPDATED` 行に
スタンプし、完了がそれらのスタンプを現在の受領と比較します。これは出力ではなく、レビュー
されることもなく、`produces[]` に列挙されることもありません。

**Codekb はスペースレベルの例外です。** Reverse-engineering の 9 つのアーティファクト
（`business-overview`、`architecture`、`code-structure`、`api-documentation`、
`component-inventory`、`technology-stack`、`dependencies`、`code-quality-assessment`、
`reverse-engineering-timestamp`）は、インテント単位の記録ディレクトリの下に**解決しません**。
これらは、耐久的でリポジトリ単位のコードナレッジベース
`aidlc/spaces/<space>/codekb/<repo>/` に着地します。これはスペース内のすべてのインテントで
共有されるストアで、インテントではなくリポジトリで鍵付けされます。パスは、`resolveArtifactPath`
（`core/tools/aidlc-orchestrate.ts`）の `isCodekb` 分岐を通じて、記録相対のルールの外で
解決されます。同じディレクトリは、読み取り専用のネイティブルート
`aidlc engine workspace codekb` が表示します。複数のリポジトリを記録する作業では、ステップ
がこれらのアーティファクトをそれぞれ 1 回、`aidlc/spaces/<space>/codekb/{repo}/<name>.md`
として名指しし、その `repos_note` が `{repo}` がどのリポジトリを表すかを言います
（`resolveArtifactPaths`）。そのため、どんな規模のワークスペースも 1 ステップに収まります。
完了検査とセンサーは、やはりすべてのリポジトリのファイルを読みます。

**衝突では正規名 ≠ ファイル名。** 衝突が分割されているところ（上を参照）では、ディスク上の
ファイル名が分割前の形（`test-results.md`）を保ち、正規名が曖昧さを解消した版になることが
あります。信頼できる情報源としては、ファイルシステムではなく、ステージの `produces:` リスト
と `aidlc engine graph artifacts` を使ってください。

---

## ライブのレジストリを見る方法

```bash
aidlc engine graph artifacts
```

正規名を 1 行に 1 つ、アルファベット順に表示します。

これはコンパイル済みのグラフを読むので、最後のコンパイルが見たものを一覧します。この
リリースのネイティブインストールでは、122 個の名前を表示します（出力は省略）。

```text
$ aidlc engine graph artifacts
accessibility-checklist
alarms
anomaly-config
api-documentation
approval-handoff-questions
...
$ aidlc engine graph artifacts | wc -l
122
```

数を知るには `wc -l`、フィルタには `grep`、ドリフト検査には期待されるベースラインとの
`diff` にパイプしてください。

---

## アーティファクトの追加や改名

この章への編集は不要です。レジストリは導出されます。

**新しいアーティファクトを追加するには:**

1. 生成側ステージの `.md` ファイルを編集し、その `produces:` リストに正規名を追加します。
2. 検査するインストール済みプロジェクトでグラフを再コンパイルします
   （`aidlc engine graph compile`）。`artifacts` は、ステージファイルではなくコンパイル
   済みのグラフを読みます。
3. `aidlc engine graph artifacts` を実行して、現れることを確認します。
4. `/aidlc --doctor` を実行して、もう存在しない名前を参照する消費側がないことを確認します
   （"Graph references" 検査）。

**アーティファクトを改名するには:**

1. 生成側ステージの `produces:` エントリで改名します。
2. 消費するすべてのステージの `consumes[].artifact` エントリで改名します。
3. 再コンパイルします。その後 `/aidlc --doctor` が、更新し忘れた消費側を捉えます。古い名前は
   生成元欠落エラーになります。

ステージグラフの CI ドリフト検出（`aidlc-graph compile --check`）は、YAML ソースから
`stage-graph.json` を再生成し忘れた改名を捉えます。

---

## 安定性

アーティファクト名の安定性方針は次のとおりです。

- 改名と削除はメジャーバージョンの変更です。
- 追加はマイナーバージョンで出荷します。

この方針はライブデータに対して強制できます。タグ時点のレジストリと HEAD 時点のレジストリの
ドリフトは、1 行の `diff` です。

---

## 相互参照

- `core/aidlc-common/protocols/stage-definition.md` —
  権威あるステージ形式の仕様。`produces[]` / `consumes[]` を構造化フィールドとして
  定義します。
- [Stage Definition](15-stage-definition.md) — 仕様についての叙述の章。
- [State Machine](12-state-machine.md) — 監査イベントの並行導出パターン。正規の enum は
  ドキュメントではなく `aidlc-audit.ts` に存在します。
- [User Guide — Artifacts Reference](../guide/14-artifacts-reference.md)
  — 利用者向けのアーティファクトライフサイクルとディレクトリレイアウト。
- `core/tools/aidlc-graph.ts` — 導出ツール（`artifactsRegistry()` +
  `artifacts` CLI サブコマンド）。

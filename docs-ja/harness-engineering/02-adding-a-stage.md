# ステージの追加

ステージはワークフローグラフのノードです。消費・生成するアーティファクト、それをリードするエージェント、実行方法を宣言する作業の単位です。ステージを 1 つ加えることは、ハーネスエンジニアが行う中で最も構造的な変更です。方法論そのものに新しいステップを導入するのですから。この章では端から端までのレシピをたどります。フェーズを選び、ファイルを書き、依存エッジを配線し、グラフをコンパイルし、新しいステージが思ったとおりの場所に着地することを確かめます。

まず[ステージの構造](01-anatomy-of-a-stage.md)を読んでください。その章はファイル形式（フロントマターの契約と 3 区画の本文）を扱い、このレシピはそれをすでに理解している前提です。ここでは*ワークフロー*に焦点を当てます。扱うのは判断のポイントと検証のステップで、フィールドごとのスキーマは扱いません。網羅的な契約については、この章は各ステップで[Stage Definition](../reference/15-stage-definition.md)へリンクします。

この規律は、開発者リファレンスの[スコープの追加](../reference/11-contributing.md#adding-a-scope)と[エージェントの追加](../reference/11-contributing.md#adding-an-agent)のレシピを映しています。番号付きのステップ一覧、そして*何が自動で検証され*、*何を自分で確かめなければならない*かの明確な区別です。

---

## 始める前に: 新しいステージが正しい一手か

新しいステージは、既存のどのステージも生成しないアーティファクトを生成するとき、あるいは既存のどのステージも扱わない形でアーティファクトを消費するとき、その居場所を得ます。*既存のステージが行うことを*変えたいだけなら、つまりステップを書き換える、リードエージェントを変える、センサーを付ける、なら、そのステージファイルをその場で編集します。新しいノードは要りません。その場での編集は[ステージの構造](01-anatomy-of-a-stage.md)を参照してください。

ステージの追加は**データ作業**です。YAML フロントマターを持つ Markdown ファイルを書き、JSON アーティファクトを再コンパイルします。TypeScript の変更はありません。心に留めておく境界は 1 つです。グラフの*コンパイラ自体*に新しい振る舞いが必要なら（まだ理解できないフロントマターのキー、新しい走査規則）、それは開発者リファレンスの関心事であって、ハーネスの作業ではありません。仕様がすでに知っている予約キー（`on_failure`、`blocks_on`、`timeout`、`retry`）は[Stage Definition](../reference/15-stage-definition.md)に並び、今日は拒否されます。そのどれかに手を伸ばすのは、コードの側へ一線を越えたということです。`when:` は別です。スキーマはこれを受け入れて検査しますが、まだ何も作用しないので、`when:` を持つステージはそれが無いかのように `scopes:` の下で実行されます。

---

## ステップ

### 1. ステージがどのフェーズに属するかを決める

ステージファイルは
`core/aidlc-common/stages/<phase>/<slug>.md`
の下に置かれます。フェーズはそのディレクトリです。5 つあります。

```
core/aidlc-common/stages/
├── initialization/
├── ideation/
├── inception/
├── construction/
└── operation/
```

ステージがどのフェーズに座るかは見た目の問題ではありません。コンパイル時にどの `phases/<phase>.md` ルール層がステージに付くかを決めます。construction フェーズのステージは construction フェーズのルールを継承し、inception のステージは inception のルールを継承します。（initialization にはフェーズルールファイルがありません。）整理しやすい場所ではなく、その作業がライフサイクルの中で実際に起きる場所に、ステージを置いてください。

### 2. 必須のフロントマターでステージファイルを作る

選んだフェーズのディレクトリに新しい `<slug>.md` を置きます。slug はファイル名の語幹で、それ以外のあらゆる場所でのステージの身元です。`requires_stage` のエッジ、スコープのマッピング、監査ログで使われます。慎重に選んでください。後で改名すると波及します。

フロントマターはグラフのエッジと実行契約を宣言します。構造の重みを担うフィールドはこれです。

| フィールド | 何をするか |
|-------|--------------|
| `requires_stage` | 依存エッジ。このステージの前に実行されなければならないステージ。 |
| `consumes` | このステージが読むアーティファクト。それぞれに `required` のブール値を持つ。 |
| `produces` | このステージが書くアーティファクト（その前方エッジ）。 |
| `lead_agent` | ステージを所有するペルソナ。 |
| `support_agents` | コンダクターがリードの後に読み込む任意の視点。pipeline の連鎖には一意のエージェントが必要。 |
| `mode` | `inline`、`subagent`、`pipeline`、`mob`、または予約の `agent-team`。 |
| `for_each` | 任意。インスタンスが反復を駆動するアーティファクトを指定する。 |
| `summary_confirmation` | 任意。常にファイル裏付けの回答を集めるステージには `required`、条件付きの質問フローには `if-present`。 |
| `reviewer` / `review_artifact` | 任意の対。レビューエージェントと、レビューの対象となる必須の Markdown `produces` エントリ（そのレビュー記録はそのアーティファクトに紐づく）。 |

Requirements Analysis の後に `feature` の下でだけ実行される用語集ステップという、小さな完全なステージは、こう見えます（このままでコンパイルできます）。

```markdown
---
slug: glossary-capture
phase: inception
execution: CONDITIONAL
condition: Execute when the requirements use domain terms the team must agree on. Skip when every term is already defined.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - glossary
consumes:
  - artifact: requirements
    required: true
requires_stage:
  - requirements-analysis
sensors:
  - required-sections
scopes:
  - feature
inputs: <record>/inception/requirements-analysis/requirements.md
outputs: glossary.md (under this stage's record dir, engine-resolved)
---

# Glossary Capture

Collect the domain terms the requirements use and agree one meaning for each.

## Steps

1. Read `<record>/inception/requirements-analysis/requirements.md` and list every domain term it uses.
2. For each term, write one plain definition and the requirement IDs that use it.
3. Write `glossary.md` with `## Terms` and `## Open Terms` sections.
4. Follow stage-protocol.md for the approval gate.

## Sensors

This stage's output is a markdown artefact under `<record>/inception/glossary-capture/`.

Imports: `required-sections`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working, and take the learnings step before the approval gate; that module says
when it asks the person anything. When the module is absent, skip both the diary
and the step.
```

本文は `## Steps` で始まります。リードエージェントが従う命令形の散文です。`## Sensors` 区画は次に、出力の場所、フロントマターの正確なインポート、上流のターゲットを要約します。ステージ固有のセンサーの例外は保ってください。最後の `## Learn` 区画は、`directive.protocol_modules` に `learnings` が並ぶときだけ `stage-protocol-learnings.md` の 13 節を指します。そうでなければ日記とステップを飛ばします。いつステップが尋ねるか、そしてブートストラップ・単独実行・Unit ごとの免除は、モジュールが所有します。完全なフィールド表・型・制約は、[フィールドリファレンス — いつ使うか](../reference/15-stage-definition.md#field-reference-when-to-use)を参照してください。

### 3. グラフがステージを配置するように依存エッジを配線する

ここで新しいステージが実際にワークフローに組み込まれます。3 つのフィールドが配線を担い、互いに一致していなければなりません。

- **`requires_stage`** はエッジを符号化します。2 種類のエッジを担います。*意味的なデータ依存*（「私はアーティファクト X を消費し、それはステージ Y が生成する」→ `Y` を加える）と、*表示順のエッジ*（同じフェーズにあってデータ依存はないが実行順が固定の 2 つのステージ）です。コンパイラのアルファベット順タイブレークに頼らず、順序エッジを明示して書いてください。タイブレークはあなたの明示的な配置の下の安全網にすぎません。
- **`consumes`** はステージが読むアーティファクトを並べます。各エントリは `required` のブール値を持ち、その範囲は*有効なプラン*に限られます。`required: true` は「生成側のステージがこのスコープで実行されるなら、この consume は満たされなければならない」という意味であって、「生成側が常に実行される」という意味ではありません。ブラウンフィールドモードでだけ必要な consume は `conditional_on: brownfield` を取ります。無条件の consume はこのフィールドをまったく省きます（`always` という値はありません）。
- **`produces`** は前方エッジを並べます。下流のステージが「アーティファクト Z を生成するのは誰か」と尋ねると、グラフは `producersOf()` で答えます。つまり `produces: [Z]` を宣言したステージが、その上流に配線されます。消費されるアーティファクトはすべて、`produces` と `optional_produces` を通じて、ちょうど 1 つの生成側に解決されなければなりません。`aidlc-graph compile` は重複を拒否し、両方の生成側ファイルを示します。アーティファクト名の再利用が有効なのは、どのステージもそれを消費しないときだけです。

この 3 つを一致させれば、コンパイラがステージを自動で配置します。位置づけのために `stage-graph.json` を手で編集することは決してありません。`requires_stage`、`consumes[].required`、`consumes[].conditional_on`、`for_each` の機微（集約が宣言ではなく*推論*される仕組みを含む）は、[フィールドリファレンス — いつ使うか](../reference/15-stage-definition.md#field-reference-when-to-use)で扱います。

### 4. ハーネスを再生成し、`stage-graph.json` を再コンパイルする

`core/` の下にいま書いた YAML が正本です。パッケージャーを実行して、無視されるローカルの `dist/<harness>/`（Bun コピー）と `dist-release/<harness>/`（ネイティブ）を `core/` から実体化します。これは新しいステージファイルを両方のチャネルにコピーし、各グラフを再コンパイルします。

```bash
bun scripts/package.ts            # materialize both channels for every harness
bun scripts/package.ts --check    # build twice and byte-compare
```

ランタイムはコンパイルされたアーティファクト `<harness-dir>/tools/data/stage-graph.json`
（たとえばインストール済み Claude ツリーの `.claude/tools/data/stage-graph.json`）を読みます。これは、パッケージャーが呼び出すグラフコンパイラが YAML から作ります。すでにインストール済みのツリーで反復しているなら、そのツリーのグラフを直接再コンパイルできます。

```bash
aidlc engine graph compile
```

どちらにせよ、オーサリングフローは一方向のパイプラインです。`core/` の YAML を編集し、パッケージャー（またはインストール済みツリーに対する `compile`）を実行すると、JSON が更新され、ランタイムのローダー（`loadStageGraph()`）が新しいノードを変えずに拾います。`stage-graph.json` を手で編集してはいけません。これはビルドアーティファクトで、手編集は次のコンパイルで上書きされます。完全なパイプライン図と CI のドリフトガードは[オーサリングフロー](../reference/15-stage-definition.md#authoring-flow)にあります。

### 5. 現れることを確かめる — そしてどのスコープで

新しいノードがコンパイルで入ったことを確かめ、どこで実行されるかを見ます。

```bash
# Topological order of the full graph — your slug should appear
aidlc engine graph topo

# Who produces / consumes your stage's artifacts
aidlc engine graph producers <artifact>
aidlc engine graph consumers <artifact>

# The stages on a given scope's path — does your stage run for this scope?
aidlc engine graph scope <scope-name>

# Dependency sanity for a scope
aidlc engine graph validate-scope <scope-name>
```

上記の用語集ステージを、インストール済みの Claude Code ツリーに `.claude/aidlc-common/stages/inception/glossary-capture.md` として置き、`aidlc engine graph compile` でコンパイルすると、feature のパスにそれが含まれます（短縮して示します）。

```text
$ aidlc engine graph scope feature
...
requirements-analysis
user-stories
refined-mockups
domain-design
units-generation
contract-design
delivery-planning
glossary-capture
functional-design
...
$ aidlc engine graph producers glossary
glossary-capture
```

これは Requirements Analysis の直後ではなく、Inception の末尾に着地します。新しいステージは、すでにそこにあるステージの後の、そのフェーズの次の空き番号を取り、既存のステージは番号を振り直されません。Unit ごとに 1 回実行される新しいステージ（`for_each: unit-of-work`）は、その番号が何であれ、そのフェーズの他の Unit ごとのステージと一緒に実行されます（[Stage Definition](../reference/15-stage-definition.md#for_each)）。前のステージから新しいステージへのエッジはコンパイルで拒否されます。`glossary-capture` を User Stories の `requires_stage` に加えると、同じツリーはこう表示します（長いダッシュを `-` で示します）。

```text
$ aidlc engine graph compile
aidlc-graph compile: Compile invariant violated: stage "user-stories" (2.4) requires "glossary-capture" (2.10) - dependency must be lower-numbered. Fix: either renumber in stage-graph.json to match the dependency direction, or remove the offending requires_stage edge.
```

真新しいステージは、どのスコープでも**自動では実行されません**。スコープの所属はいまステージ自身に載ります。そのフロントマターの `scopes:` 一覧が、実行されるスコープをすべて指定します。どのスコープも指定しないステージは、どこでも `SKIP` です。だからステージを加えた後は、どのスコープで実行すべきかを決め、各スコープ名をステージの `scopes:` 一覧に加えます。そして再コンパイルすると転置が `scope-grid.json` を更新します。[Scopes](04-scopes.md)を参照してください。これは意図的な継ぎ目です。ステージ本文を書くとステージが*存在*し、`scopes:` タグがそれを*実行*させます。

---

## ステージを加えるには、ステージファイルを書く — ランナーはオプトインの糖衣

この章の見出しは、その拡張性の契約でもあります。**ステージを加えるには、ステージファイルを書く。** 構造的に必要なのはそれだけです。ステージがグラフにコンパイルされれば（上記のステップ 2〜4）、スキルや登録を要せず、すぐにそれ自身で実行できます。

```bash
aidlc engine orchestrate next --stage <your-slug> --single
```

エンジンの `--single` モードは、その 1 つのステージを単独で実行します。そのステージの `run-stage` ディレクティブを 1 つ発行し（リードエージェント、解決された consumes/produces のパス、ルール、センサー付き）、コンダクターがそれを実行し、合成 id のライフサイクルが監査ログにコミットされます。`next --single` はディスパッチの前に `STAGE_STARTED` を記録し、`report --single` は `STAGE_COMPLETED` を記録する前にその境界を必要とします。
ディレクティブは `single: true` を運ぶので、コンダクターは設定された本文、トポロジー、レビュアー、完了チェックを実行し、`report --single --stage <slug> --result completed` で 1 回報告し、`done` で止まります。ワークフロー学習を実行せず、ワークフローの承認ゲートも開きません。
`--single` の実行は意図的に単独です。**メインワークフローの `Current Stage` には決して触れません**。ツールは単独実行からメインワークフローを進めることを拒否します。ステージのドキュメントは、作業がそれらを保つ場所に書き、すでにそこにあるファイルのコピーを記録の `archive/` フォルダの下に保った後に書きます。

### ランナースキルは任意のパッケージング

出荷される実行可能なステージはすべて、`skills/aidlc-<slug>/SKILL.md` に薄いランナースキルも得ます。だから `/aidlc-<slug>`（たとえば `/aidlc-domain-design`）としてタイプできます。これらは **`--single` フラグへのオプトインの糖衣**です。`next --stage <slug> --single` を駆動する、約 6 行のシェルです。手書きではありません。実行可能なコンパイル済みステージの slug ごとに、ジェネレーターが 1 つずつ発行するので、ランナーの集合とステージの集合が手作業でずれることは決してありません。（3 つのブートストラップ initialization ステージは、ステージごとのランナーを得ません。単独の `--single` の意味を持たないからです。init フェーズ全体が代わりに `/aidlc-init` コマンドです。`--scope` と説明があればエンジンの intent-create の一手をパッケージし、`--scope` だけで他に何もなければまず作業の目的を尋ね、説明だけならエンジンに新しい作業を求め、プランの提案をまず示します。）ステージを加えた（または取り除いた）後は、ランナーを再生成します。

```bash
# Regenerate every runner dir from the compiled stage list
aidlc engine gen runners

# CI drift guard: exits 1 if the runner set != the compiled stage set
aidlc engine gen runners --check
```

ランナーは **`hooks:` ブロックを持ちません**。決定論的な背骨（監査、センサー、ランタイムグラフのコンパイル、状態検証）は `settings.json` でプロジェクト全体に及ぶので、どのランナーもそれを無償で継承します。ランナーごとに複製するものはありません。そしてランナーはコンダクターのペルソナを手で読み込みません。エンジンがそれを届け、手渡す `run-stage` ディレクティブに焼き込みます。ランナーの本文は、何をするかと、駆動する 1 つのコマンドを述べるだけです。

ランナースキルをすべて削除しても、どのステージも `/aidlc --stage <slug> --single` で実行できます。ランナーはすでに実行可能なステージをパッケージするだけで、ステージファイルが定義です。オーサリングのパスは「ステージファイルを書く」であり、これからもそうです。

これらのランナーの背後にある規範的な契約、つまりエンジン・コンダクター・`run-stage` ディレクティブがコンパイル済みステージをどうタイプ可能な `/aidlc-<slug>` スキルに変えるかは、開発者リファレンスの[Skill System 4 節（スキルとランナー）](../reference/17-skill-system.md)を参照してください。

---

## 何が自動で検証され、何を自分で確かめなければならないか

### 何が自動で検証されるか

- **グラフ配置。** `compile` すると、ステージのエッジ（`requires_stage`、`consumes`、`produces`）がグラフに解決されます。トポロジカル順序、生成側/消費側の検索、循環検出はすべて、追加の編集なしに新しいノードを勘定に入れます。
- **コンパイル時のフィールド検証。** コンパイラはグラフを作りながらフロントマターを検証します。オーサリングの誤りは実行時に静かにではなく、`compile` で大きく失敗します。`lead_agent` や `support_agents` の値は `loadAgents()` を通じて実際の `.claude/agents/*.md` ファイルに対して検査されます。更新すべきハードコードのエージェント列挙はありません。対応ファイルのないエージェントを指定したステージはコンパイルに失敗します（`lead_agent "<name>" has no matching .claude/agents/*.md`）。だから打ち間違いが、実行時に 404 になるグラフを出荷することはありません。予約の `orchestrator` slug（コンダクター自身。ブートストラップ initialization ステージで使われる）は免除されます。エージェントファイルがないからです。pipeline ステージは `lead_agent` と `support_agents` にまたがる重複した連鎖の身元も拒否します。
- **ドリフトチェック。** ソースのチェックアウトでは、CI がすべてのツリーを `core/` から作り、`bun scripts/package.ts --check` が 2 回ビルドしてバイト比較します。だから生成ファイルは入力にならず、コミットし忘れるものはありません。インストール済みのツリーでは、`aidlc engine graph compile --check` はグラフがステージファイルと一致すれば `0` を返し、ステージが再コンパイルなしに編集されると `1` を返して ``stage-graph.json is out of date. Run `aidlc engine graph compile` to regenerate.`` と表示します。
- **フェーズルールの付加。** ステージはディレクトリでそのフェーズを宣言するので、対応する `phases/<phase>.md` ルール層がコンパイル時に付きます。そのエッジを自分で配線することはありません。

### 何を自分で確かめなければならないか

- **スコープの参加。** コンパイラはステージをグラフに配置しますが、どのスコープがそれを実行するかは**決めません**。各スコープ名をステージ自身の `scopes:` フロントマター一覧に加える（そして再コンパイルして転置が `scope-grid.json` を更新する）まで、新しいステージはグラフに存在しても、どこでも実行されません。気になる各スコープについて `aidlc engine graph scope <scope-name>` で確かめてください。
- **本文の散文。** パースされるのはフロントマターだけです。`## Steps` の本文は、ステージが起動したときにリードエージェントが読みます。他のステージファイルの構造に合わせて書いてください。パーサーは曖昧または欠けた指示を捕まえません。
- **散文とエッジの一致。** `requires_stage` と `## Steps` の散文はずれることがあります。パーサーはエッジだけを見て、散文は見ません。ステップが「the intent statement を読む」と言うなら、対応する生成側ステージが実際に `requires_stage` になければなりません。手で同期を保ってください。
- **あなたのスコープでの `required` の意味。** `required: true` の consume は、生成側を飛ばすどのスコープでも意味を失います。それはバグではなく正当です。しかし、ステージ本文が生成側の不在を優雅に扱うこと（「if available」のフォールバックのパターン）を確かめるのはあなたです。
- **ドキュメント。** 新しいステージが、ドキュメントが手で数える件数や表（ステージ数、フェーズ一覧）を変えるなら、同じ変更でそれらも更新します。ドキュメントのポリシーに従います。

---

## 境界のケース: データ作業かコード作業か

ステージファイルを書いてグラフを再コンパイルするのは、まるごとハーネスエンジニアのデータ作業です。Markdown、YAML、JSON、`.ts` はありません。静かに越えてはいけない一線はこれです。ステージを動かすためにグラフの*コンパイラ*が違う振る舞いをする必要があるなら、つまり認識しないフロントマターのキー、新しいエッジの種類、新しい走査規則なら、それはデータを読むコードの変更であり、ここではなく[開発者リファレンス](../reference/15-stage-definition.md)に属します。仕様の予約キー名前空間は、まさに将来の構造拡張が予測可能に着地するために存在します。場当たりの追加を避けるためのものです。そのキーのどれかに消費側が出荷されるまで、スキーマはそれを拒否します。コンパイラがまだ実装していないキーが欲しくなったら、立ち止まってください。それはフレームワークの変更で、検証の規律については[エージェントの追加](../reference/11-contributing.md#adding-an-agent)とその兄弟のコントリビューションレシピに従いますが、実装はコードに置かれます。

---

## 次へ

[エージェントの追加](03-adding-an-agent.md) — 新しいステージが `lead_agent` として指定するペルソナを書き、それがリードまたはサポートするステージに束ねます。

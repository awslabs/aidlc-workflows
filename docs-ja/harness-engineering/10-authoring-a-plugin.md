# プラグインの作成

> [ハーネスエンジニアガイド](00-overview.md)の一部です。前提:
> [ステージの構造](01-anatomy-of-a-stage.md)。設計リファレンス（仕組み、インストール時の根拠、ハイブリッドの配布モデル、実装状況）:
> [Plugin Mechanism](../reference/18-plugin-mechanism.md)。

**AIDLC プラグイン**（**プラグイン**）は、再利用可能で任意の AIDLC コントリビューションの集合です。新しいステージ、エージェント、スコープ、センサー、方法論の知識、そして既存の core ステージへの追加的な変更を、自分のディレクトリにパッケージし、自分のリポジトリから公開し、ユーザーの選んだプラグインの集合にまたがってユーザーのインストールに**合成**します。プラグインは `core/` を決して編集しません。すべてのプラグインを無効にすると、インストールは素の core のように振る舞います（プラグインのファイルはインストールされたままなので、また有効にできます）。

一次プラグイン（AIDLC チームが出荷）と三次プラグイン（他の誰か）は**機構的に同一**です。同じ構造、同じ継ぎ目、同じ composer、同じ保証です。唯一の違いは出所です。そのプラグインがどのリポジトリに置かれ、誰がレビューしたかです。

新しいリポジトリを `aidlc-plugin-create.ts` で始めます。この章ではその後、より豊かな `test-pro` リファレンスプラグインを端から端まで歩きます。

## プラグインを書くか、素のステージ/ルールを書くか

- **ステージ/エージェント/ルール**（[2〜6 章](00-overview.md)）は、全員が得るフレームワークの恒久的な一部です。
- **プラグイン**は _任意で所有される_ もので、自分のリポジトリで出荷し、オプトインのスコープ（および/または `when:` 述語）の下でだけ有効になり、消費者が自分のインストールに合成するかを選びます。すべてのプロジェクトが望むわけではないドメインパック（operation フェーズ全体、コンプライアンスのプラグイン、テストのプラグイン）に使います。

## 1. ディレクトリ + マニフェスト

プラグインは、宣言的なマニフェストと core 形のサブツリーを持つディレクトリ（そして git リポジトリ）です。

```text
test-pro/
  .aidlc-plugin/plugin.json                          # the manifest
  stages/construction/test-pro-integration.md        # NEW stages
  stages/operation/test-pro-full-suite.md
  contributions/construction/nfr-requirements.md      # MODIFY existing core stages (§3)
  contributions/construction/nfr-design.md
  contributions/construction/build-and-test.md
  contributions/operation/performance-validation.md
  sensors/aidlc-coverage-threshold.md                 # NEW sensor manifests
  sensors/aidlc-requirement-coverage.md
  tools/aidlc-sensor-coverage-threshold.ts            # the sensor scripts
  tools/aidlc-sensor-requirement-coverage.ts
  tools/test-pro-doctor.ts                             # optional /aidlc --doctor checks
  scopes/test-pro-validation.md                       # NEW plugin scope
  agents/test-pro-metrics-agent.md                    # NEW support persona
  knowledge/test-pro-metrics-agent/methodology.md     # plugin methodology knowledge
  tests/plugin.test.ts                                # plugin content and compose tests
```

`.aidlc-plugin/plugin.json` は**宣言的な**マニフェストです。そのトップレベルは共通のプラグインマニフェストの形を映すので（マーケットプレイスやホストのツールがそれを一覧・バージョン管理・信頼できます）、AIDLC 固有の設定は入れ子の `aidlc` ブロックに置かれます。

```jsonc
{
  "name": "test-pro",                 // == dir name; "core", "aidlc", and "aidlc-*" are reserved
  "version": "0.1.0",                 // semver
  "description": "Full-featured testing plugin — unit/branch coverage, functional, integration, regression, edge, and API positive+negative.",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core"],           // core plus at most one base, e.g. ["core", "compliance@^1.2.0"]
  "aidlc": {
    // "marketplace": "acme-aidlc-plugins",  // optional, your plugin's catalogue (below)
    "contributes": {                  // which subtrees this plugin ships
      "stages": "stages/",            // NEW stage files
      "overlays": "contributions/",   // CONTRIBUTION files (§3 — modify existing)
      "agents": "agents/",            // NEW personas
      "scopes": "scopes/",            // NEW scope identities
      "knowledge": "knowledge/",      // methodology knowledge for agents
      "sensors": "sensors/",          // sensor manifests
      "tools": "tools/"               // runnable sensor, doctor, and command scripts
    },
    "commands": {                     // optional: commands people run as `aidlc <name>` (§4)
      "test-pro-report": { "script": "tools/test-pro-report.ts", "description": "Print the coverage report" }
    }
  }
}
```

`contributes` は慣習的なプラグインのサブツリーを宣言します。設定可能なルーティングはまだ実装されていないので、存在する各値は上に示した正確な正規パスを使わなければなりません。VALIDATE、BUILD、TEST は、`"stages": "custom-stages/"` のような代替を拒否します。その内容を静かに省くことはしません。`tools` は CLI スクリプトをハーネスの `tools/` ディレクトリに着地させるので、プラグインは**実行可能なセンサー**（その `sensors/` のマニフェスト + その `tools/` のスクリプト）、任意の doctor チェック、そしてそのコマンドの背後のスクリプト（`commands`、下記）を出荷できます。テストとフィクスチャはプラグインのトップレベルの `tests/` ディレクトリに保ち、`tools/` の中には決して置きません。合成は `tools/tests/`、`tools/__tests__/`、`tools/fixtures/` の下のファイル、そして同居する `*.test.ts` と `*.spec.ts` のファイルを落とし、`/aidlc --doctor` が示す補助的な落ちを記録します。また、古い合成バージョンが残したペイロードがないか、インストール済みの tools ツリーをスキャンします。それらのレガシーファイルは出所を運ばないので、その移行の補助注記は、いま合成しているプラグインに帰属させずにインストール済みのパスを名指します。`overlays` は特別です。その正規ディレクトリは `contributions/` で、そのファイルはプリミティブなサブツリーとしてコピーされるのではなく、マージに消費されます。

`memory`（正規は `memory/`）はプラグインのハウスルールを運びます。`rules.md` と `phases/<phase>.md` で、`aidlc.rulesLevel` が `rules.md` の着地するルールファイルを名指します（Method/rules、4 節）。

プラグインが使うキーだけを出荷します。`test-pro` はサポートエージェント、プラグインスコープ、エージェントごとの方法論知識を出荷します。それでもリードには `aidlc-quality-agent` を再利用します。

> **番号の範囲はありません。** ステージ番号は表示専用なので、プラグインはマニフェストで番号の範囲を**主張しません**。§2 を参照。

## 2. 新しいステージを加える

プラグインのステージは、2 つの追加規則を持つ通常のステージファイル（[ステージの構造](01-anatomy-of-a-stage.md)を参照）です。

- その `plugin:` フィールドがプラグインを名指します。
- それが `produces:` するアーティファクトは `<plugin>-` を接頭辞としなければなりません（たとえば `test-pro-integration-test-results`）。

同じ論理プラグイン名が、所有するすべてのステージ、スコープ、エージェント、コントリビューションに現れなければなりません。合成はその身元をプラグイン自身のマニフェストから取り、すべてのビルドがそれを運びます。内容はそのパッケージを改名もなりすましもできません。不一致はスキップされ、`/aidlc --doctor` のために記録されます。

`bundle:` は改名前の所有キーで、修理を名指すエラーで拒否されます。`plugin:` と書いてください。その語は、将来ありうるプラグインの集合という概念のために予約されています。

ステージの**身元は slug** で、重要なあらゆる場所（エッジ、ジャンプ、解決）でそうです。`number:` は**表示ヒント**にすぎません。ステージのグラフ位置は、その slug ベースの `requires_stage` エッジから来て、コンパイル済みの番号値は**エンジン**が割り当てます。あなたではありません。最初のコンパイルで、プラグインの新しいステージは自分の `requires_stage` エッジで順序づけられ、独立したステージの間のタイブレークにだけ書かれた `number:` 値を使い、そのフェーズの次の空きインデックスを与えられます。だから、理にかなって読め、エッジと一致する番号を書いてください（`test-pro-integration` は `3.6` の `build-and-test` の後の `3.85`）。*相対的な*順序が運ぶものです。しかし絶対値はグラフに決して着地せず、ステージの挿入は core の番号を振り直さず、あなたは範囲を主張しません（だから、調整されていない 2 つのプラグインが番号で衝突することは決してありません）。

Unit ごとに 1 回実行されるステージ（`for_each: unit-of-work`）は、どの番号を得ても、その Unit とともに実行されます。`requires_stage: [code-generation]` する Construction のステージは `ci-pipeline`（`3.8`）の後に番号づけられますが、各 Unit はそれを自分の Code Generation の直後に実行し、その承認は Build and Test の前に来て、チームの最後の Unit が作業を Build and Test に進めます。core の Unit ごとのステージと同じです（[Stage Definition](../reference/15-stage-definition.md#for_each)）。そのようなステージは、Unit の後に intent ごとに 1 回実行されるステージ（たとえば `build-and-test`）を require できません。コンパイルがそのエッジを拒否します。

プラグインがインストールされる前に始まった作業は、そのステージの Stage Progress 行を持ちません。エンジンは、作業が最初にそのステージに届いたとき、そのフェーズの前に来る行の後に、各行を書きます。

ステージを `scopes:` でスコープにゲートし（他のどこでも SKIP）、任意で `when:` 述語を宣言します。`test-pro-full-suite` は、その上流の生成側がプランにあるときだけ実行される*意図*です。

```yaml
scopes:
  - enterprise
when:
  producer-in-plan: test-pro-regression-suite
```

> **`when:` はパースされるが、まだ評価されません。** スキーマは述語を検証し、パーサーはそれを読みますが、今日はどのエンジンの消費側も作用しません。`when:` を運ぶステージは、宣言された `scopes:` の下で無条件に EXECUTE です。前方互換のために書いてください。ただし、いまは実際の振る舞いを `scopes:` にゲートします。

スコープの所属と `when:` 述語は[Scopes](04-scopes.md)を参照してください。

ステージに `ars:` で**composer 事前分布**を与えると、`/aidlc compose` がそれを機械的にスクリーニングできます。出荷される `tools/data/ars-priors.json` は core ステージだけを名指すので、このブロックが無いと、あなたのステージは `aidlc-graph ars` の出力に、composer が判断でだけ決められる `no-prior` 行として現れます。

```yaml
ars:
  targets: [ve, r]   # the ARS components the stage reduces: iae | csu | ve | r | ua
  cost: 4            # 1 (trivial) .. 5 (heavy); null = never numerically screened
```

2 つの任意のキーがエントリを完成させます。`role:` はステージのスクリーニングのされ方を変えます。`initialization` と `core` は常に実行され、`structural` は既定で SKIP でゲートの判断に委ねられ、`phase-gate` はそのフェーズの他の作業が実行されるときだけ実行されます。`project_types: [brownfield]` は、ステージを 1 種類のプロジェクトに制限する `condition:` を映します。スキーマはこのブロックを priors ファイルのエントリのように検証し、コンパイルがそれをグラフノードにコピーします。出荷される priors のエントリは常に勝つので、このブロックはあなた自身のステージでだけ意味を持ちます。[Stage Definition](../reference/15-stage-definition.md) § `ars` を参照してください。

## 3. 既存の core ステージを変更する（コントリビューション）

これがコントリビューションの継ぎ目です。core ステージを**編集せずに**追加的に変えます。コントリビューションは `<plugin>/contributions/<phase>/<slug>.md` に置かれ、`contributions/` のちょうど 1 ディレクトリ下です。より高く置かれたり、より深く入れ子になったりしたファイルは決して読まれないので、validator がそれを報告し、合成がドロップログに記録します。これは `test-pro` の `nfr-requirements` へのコントリビューションです。

```markdown
---
target: nfr-requirements      # the existing core stage you're enriching
plugin: test-pro
adds:                         # STRUCTURAL — set-unioned into the stage node
  produces:
    - test-pro-testability-requirements   # <plugin>- prefixed
  required_sections:
    - "Testability Requirements"          # declared; not enforced today (below)
    - "Coverage Targets"
fragments:                    # PROSE — spliced into the stage body
  - anchor: after-step:6
    order: 100
---

## fragment: after-step:6

### Step 6b (test-pro): Capture testability NFRs

…prose the agent will see, appended after the target stage's Step 6…
```

加えられるもの（すべて追加的。設計上、**上書きも削除もありません**）。「Status」は、合成フックが今日マージするものと、設計されたが先送りのものを示します（doc 18 §5/§8 を映す。実装するか格下げし、決して静かな no-op にしない）。

- `adds.produces` / `adds.consumes` / `adds.sensors` — ✅ ターゲットステージのソースフロントマターに集合和される。
- `adds.required_sections` — ✅ ステージの `required_sections` にマージされる。ただし**今日は機械的に強制されない**ことに注意。このフィールドは書かれて検証されるが、コンパイル済みグラフノードに届かず、出荷される `required-sections` センサーはその期待をテンプレートから導くので、節が欠けてもまだステージを失敗させるものはない。いまは宣言的な意図として扱う。
- `adds.scopes` — ✅ ターゲットステージの `scopes:` 一覧に集合和される。2 つの防護柵がある（各違反はドロップログに記録され、決してマージされない）。スコープの身元ファイルがインストールされていなければならず（`scopes/<name>.md` が同じプラグインで出荷される）、そのファイルの `plugin:` フロントマターがあなたのプラグインを正確に名指さなければならない。core ステージを core や他プラグインのスコープの下に置くことはできず、所有は名前の接頭辞から推論されるのではなく、インストール済みファイルの宣言された所有者から読まれる。既存の core ステージを自分のプラグインのスコープの下にルーティングするのに使う。たとえば、自分の discovery ステージに core の Inception 以降を加えたスコープを運ぶ方法論プラグインのように。
- `adds.requires_stage` — ✅ ターゲットの `requires_stage` に順序エッジを集合和する。依存はすでにインストールされ、ターゲットより前にコンパイルされなければならない。より小さいステージ番号（ピン留めされたステージはフェーズが動いても番号を保つ）、またはまだ番号づけられていないステージには、より早いフェーズ。stage-definition ガイドが求めるエッジ（「X を消費し、それはステージ Y が生成する → Y を require」）や、フェーズをまたぐ順序に使う。プラグインが加えるステージはそのフェーズの最大を超えて蒔かれるので、core ステージを同じフェーズ内でそれを require させることはできない（それが RFC #1100）。そのようなエントリ、未知の slug、自己エッジ、新しいステージの間で循環を閉じるエッジは、ドロップログに記録され、決してマージされない。マージされたエッジは、合成とランタイムのアップグレードのたびに再チェックされる。もう成り立たないものは取り除かれ、新しい core が自分で宣言するものは core のものになる。どちらもプラグインのコントリビューションの記録を残す。
- `fragments` — ✅ ステージ本文に継ぎ合わされる散文ブロック。各 fragment の散文は、コントリビューションファイルの `## fragment: <anchor>` ブロック。

### Fragment のアンカー

| アンカー             | fragment を挿入する位置                                              | Status |
| ------------------ | ------------------------------------------------------------------ | ------ |
| `after-step:<n>`   | `### Step <n>` の直後（次の `###`/`##` の前）            | ✅ |
| `before-step:<n>`  | `### Step <n>` の直前                                  | ✅ |
| `end-of-steps`     | `## Steps` ブロックの末尾                                 | ✅ |
| `in:<Compartment>` | 名指しの `## <Compartment>` ブロックの末尾（たとえば `in:Sensors`） | ✅ |
| `after-preflight`  | ペルソナのみ。委譲知識プリフライトブロックの直後   | ✅ |
| `end-of-body`      | 書かれた本文の末尾（吸収されたレビュアー知識の前） | ✅ |
| `after-questions`  | 質問を生成するステップの後                                | ⏳ 未実装 — `locateAnchor` にケースがなく、「unknown anchor」を落とす。`after-step:<n>` を使う。 |

Fragment は `(order, plugin)` で決定論的に順序づけられます。同じ `(plugin, anchor, order)` の衝突は、1 ファイル内でも、この実行の 2 つのコントリビューションファイルにまたがってでも、**ドロップログに記録されます**（last-writer-wins ではありません）。*異なる* 2 つのプラグインが同じステージにコントリビュートするとき、その構造的な追加は集合和され、その fragment はこの同じ順序で交互になります。本当にマージされます。

継ぎ合わされた各 fragment は、内容ハッシュを運ぶセンチネルコメント（`<!-- plugin:<plugin>:<anchor>:<order>:<hash> --> … <!-- /plugin:… -->`）で包まれます。これが、再合成をべき等に保ち、アップグレードされた fragment がその前のブロックを置き換えるやり方です。合成は、うまく適用された各 fragment のアンカー、order、ハッシュを、プラグインコントリビューションのサイドカーにも記録します。その出所は、散文のみのプラグインでも存在するので、doctor はエンジンの再インストール後に、欠けたマーカーや変わった fragment 本文を検出できます。そこから 2 つのオーサリング規則が従います。

- **fragment 散文の中のマーカーに似た行は安全です。** 閉じマーカーはブロックの内容ハッシュを運ぶので、散文の中の `<!-- /plugin:... -->` 行（そのハッシュを欠く）は、決してブロックの終わりと取り違えられません。
- **ハッシュなしマーカーのインストール:** マーカーがハッシュを運ばないブロック（ハッシュが加わる前に合成された）は、アップグレードで認識されず、2 つ目のコピーが継ぎ合わされます。きれいなベースから再合成するか、古いブロックを手で 1 度削除します。

### core ペルソナにコントリビュートする

`contributions/agents/<agent>.md` の下のコントリビューションは、ステージではなく core ペルソナをターゲットにします。`target:` はエージェントの slug（`<harness>/agents/<agent>.md` のファイル語幹）です。エンジンの core エージェント名簿のペルソナだけが適格です。他のどれか、たとえばプラグインが出荷するペルソナは、validator に拒否され、合成にドロップログで記録されます。ペルソナは**散文の fragment だけ**を取ります。そのフロントマターは身元とティアなので、`adds:` ブロックは補助的な落ちで拒否されます。アンカーは `in:<H2>`（新しい協業の箇条書きには `in:Collaboration`）、`after-preflight`（パッケージャーが注入する委譲知識プリフライトの直後。ディスパッチされたすべてのワーカーが見なければならない必須の指示の場所）、`end-of-body` です。

```yaml
---
target: aidlc-quality-agent
plugin: test-pro
fragments:
  - anchor: in:Collaboration
    order: 100
---

## fragment: in:Collaboration

- **Works with (test-pro)**: test-pro-metrics-agent (…)
```

Fragment は、ステージの fragment とまったく同じように、継ぎ合わされ、サイドカーに記録され、無効化で剥がされます。それはすべてのハーネスでエージェントに届きます。合成はそれを Markdown ペルソナと、ハーネスがそこから作るネイティブなエージェントファイル（Codex のエージェント TOML、OpenCode と Copilot のネイティブエージェント）に書き、Kiro CLI のエージェント JSON は Markdown ペルソナからそのプロンプトを読み込みます。

### エンジンのアップグレードのライフサイクル

エンジンの再インストールは、ストックの `dist/<harness>/` グラフと core ステージのソースを、実効インストールの上にコピーします。プラグイン名前空間のファイルとコントリビューションのサイドカーは、そのオーバーレイを生き延びられますが、そのグラフエントリと、構造的または散文のコントリビューションのマージは消えます。作者は、再合成をアップグレードの指示の一部にすべきです。すべてのエンジン再インストールやアップグレードの後に `/aidlc plugin sync` を実行します（またはプラグイン合成フックを持つホストで新しいセッションを始めます）。合成はべき等なので、これは変わらないコントリビューションを重複させずに、同じ実効面を復元します。`/aidlc --doctor` は、壊れた状態を **Composed plugin surface** として報告します。有効なプラグインのサイドカーが読めない、または不正、記録されたターゲットステージがもう存在しない、記録された構造的または散文のコントリビューションが欠けている、または変わっているとき、このチェックはフェイルクローズします。Consume の記録は `artifact`、`required`、任意の `conditional_on` を保ち検証します。古いサイドカーからの artifact のみの記録は引き続き互換です。無効なサイドカーは、すでに合成されたステージから安全に再構築できません。ストックのエンジンをリフレッシュし、そのサイドカーを取り除き、次に `plugin sync` を実行します。

### プラグインのアップグレードのライフサイクル

プラグインの新しいバージョンの再合成（合成フックを持つホストでの新しいセッション、`aidlc engine plugin sync`、または `bun <plugin-root>/hooks/compose.ts`）は、インストール済みのコピーがなおプラグインのインストールしたものであるところで、新しいステージ、スコープ、エージェント、知識、センサー、ツールを取ります。合成は `tools/data/plugin-owned-<key>.json`、つまり `plugin sync` が書くのと同じハッシュで証明された記録で、それを証明します。人が変えたコピーはそのままで、落ちのログ（`/aidlc --doctor` が示す）がファイルとステップを名指します。変更を別の場所へ移し、ファイルを取り除き、合成を再実行します。その記録が存在する前に合成されたプロジェクト（`tools/data/plugin-owned-<key>.json` が無い）は、差異のある各ファイルを同じように報告します。同一のファイルは、現在の合成の最初の実行で記録されるので、後のアップグレードは何も要しません。新しいバージョンがその古い `(anchor, order)` でもう出荷しない散文の fragment は、そのサイドカーの記録とともに取り除かれるので、動いた fragment は 1 度だけ現れます。新しいバージョンがもう宣言しない構造的な追加（`adds.*`）は、合成だけでは取り除かれません。`plugin sync` が、再合成の前にそれらを剥がします。

## 4. 他のプリミティブのパッケージング

`test-pro` はステージ、コントリビューション、センサー、サポートエージェント、スコープ、方法論知識を出荷します。プラグインはハウスルール（Method/rules、下記）も出荷できます。

- **エージェント。** `plugin:` を設定した `agents/<plugin>-<role>-agent.md` を置きます。プラグインの接頭辞が core の `aidlc-` ファイル名接頭辞を置き換え、ファイル名の語幹はフロントマターの `name` に等しくなければなりません（たとえば `agents/test-pro-metrics-agent.md` は `name: test-pro-metrics-agent` を持ちます）。合成の後に自動で発見され、プラグインのステージがそれを `lead_agent`/`support_agents` として名指せます。異なる内容の同じパスの衝突は上書きされません（合成が落ちのログを記録します）。ただし、インストール済みファイルが、合成がインストールして以来変わらない、あなたのプラグイン自身の以前のコピーなら、再合成が新しいコピーを取ります。OpenCode の合成は、ネイティブな `.opencode/agents/` のサブエージェントの双子も作り、入れ子の `task` 委譲を拒否します。[エージェントの追加](03-adding-an-agent.md)を参照してください。
  Kiro IDE と Kiro CLI v3（`kiro-ide` の投影）では、合成があなたのエージェントに、AI-DLC 自身のペルソナが持つツール・MCP サーバー・ルールを与えるので、Kiro の `tools:` と `permissions:` はエージェントから外します（Claude Code は `tools:` 行をその許可一覧として読みます）。あなたのステージはそれをディスパッチできます。Kiro は、人が Always allow を選ぶまで、aidlc エージェントがそれに作業を手渡す前に人に尋ねます。各 MCP 呼び出しの前に尋ねるのと同じです（aidlc エージェントは AI-DLC 自身のペルソナだけを名前で許します）。これはこのリリース以降で作られたプラグインを要します。作り直してまた置いてください。
  Kiro CLI V2（`kiro` の投影）では、ステージがディスパッチするプラグインのエージェントは、手書きのエージェントファイル `.kiro/agents/<agent>.json`（agent-v1 JSON。使う各 MCP サーバーを `tools` で `@<server>` と名指す）と、`.kiro/agents/aidlc.json` の `toolsSettings.subagent.trustedAgents` のそれへの trust エントリを要します。V3 と Kiro IDE ではどちらも要しません。
  Kiro CLI では、ネイティブにディスパッチされるプラグイン名簿ワーカーの手書きの agent-v1 JSON は、その `resources` 配列に `file://aidlc/active-memory/**/*.md`（エンジンのアクティブ空間メモリのコピー。どのインストールでも同じパス）も含み、少なくとも 1 つの既存の Markdown ファイルに解決しなければなりません。プラグインワーカーが core ワーカーと同じアクティブステージのルールを受け取るからです。
- **センサー。** マニフェスト `sensors/aidlc-<id>.md` **と**その `tools/` の下のスクリプトの両方を出荷します（両方。マニフェストだけでも発見できますが、そのスクリプトは実行するために `tools/` に置かれなければなりません）。`sensors/` のトップの `aidlc-<id>.md` の名前は、慣習ではなく硬い要件です。センサーの発見は `sensors/` を平坦にスキャンし、`aidlc-<id>.md` に一致する basename だけを索引するので、他の名前の（またはサブディレクトリに入れ子の）マニフェストは合成されても決して発火しません。合成はいま、そのようなマニフェストを、死んで着地させるのではなく、ファイルと要る形を名指す劣化した落ち（`--doctor` が示す）で拒否します。センサーを `sensors:` で自分のステージに、またはコントリビューションの `adds.sensors` で core ステージに束ねます。[Sensors](06-sensors.md)を参照してください。
- **Method/rules。** 実践ルールを言葉で `memory/rules.md`（すべてのステージ）と `memory/phases/<phase>.md`（1 つのフェーズ）として出荷し、`rules.md` の着地するルールファイルのために `"aidlc": {"rulesLevel": "team"}`（または `org`、`project`）を設定します。Plugin sync は、各空間でそのファイルの末尾に、プラグインが所有する 1 つの節として、見出しを 1 レベル下げて書きます。人は `/aidlc plugin select --rules-level <plugin>=<level>` でそれらを動かせます。`## Guard Policy` と設定行（`Mode:`、`Methodology:`、`Ordering:`）は書かないでください。validate がそれらを拒否します。プラグインはルールを出荷し、決してロックしないからです。`rules/` ディレクトリを**出荷しないでください**。そのパスはもう読まれません。[Rules and the Loop](05-rules-and-the-loop.md)と[The Plugin Mechanism](../reference/18-plugin-mechanism.md)の 7 節を参照してください。
- **知識。** エージェントごとの**方法論**知識を `knowledge/<agent-slug>/` の下に出荷します。フレームワークが出荷する `<harness>/knowledge/` ツリーに投影され、そのエージェントがステージをリードまたはサポートするとき読み込まれます。注意: **ドメイン/チーム知識**（`aidlc/spaces/<space>/knowledge/`）はブートストラップ時は空のユーザーランタイム状態で、プラグインはそれを出荷しません。[チーム知識](07-team-knowledge.md)を参照してください。
- **スコープ。** スコープの**身元**は `scopes/<plugin>-<name>.md` の下に出荷する 1 ファイルです。プラグインの接頭辞が core の `aidlc-` ファイル名接頭辞を置き換え、ファイル名の語幹はフロントマターの `name` に等しくなければなりません（たとえば `scopes/test-pro-validation.md` は `name: test-pro-validation` を持ちます）。core の `classic` 既定が無効のとき、プラグインスコープをフォールバックとして指名するには `freeform_default: true` を設定します。選択された core/plugin の集合にまたがって、それを主張できるのは多くとも 1 つの有効なスコープで、グラフのコンパイルは曖昧な集合を拒否します。プラグインが書くステージの所属はその `scopes:` フロントマター一覧で、コントリビューションの `adds.scopes`（§3）は既存の core ステージにあなたのスコープを加えます。ベースの上に作られたプラグインは、ベースのステージを自分のスコープで `include_stages: [acme-1-intent-capture, acme-3-code-generation]` で実行します。コンパイルはそれらをそのスコープの列にだけ置き、ベースのステージとスコープはそのままです。それはベースのステージだけを名指します。`include_stages` は 2.11.0 より新しい AI-DLC リリースを要します。2.11.0 とそれ以前はそれを無視するので、そこではスコープはあなた自身のステージだけを実行します。[Scopes](04-scopes.md)を参照してください。

### doctor チェックを出荷する

プラグインに、`/aidlc --doctor` が検証すべきインストール前提条件や合成されたファイルがあるとき、`tools/<plugin>-doctor.ts` を加えます。スクリプトは任意で、プラグインが有効なあいだだけ実行されます。`AIDLC_PROJECT_DIR`、`AIDLC_HARNESS_DIR`、`AIDLC_PLUGIN_NAME` を受け取り、他の stdout なしに JSON の契約を出力しなければなりません。

Doctor の発見は、インストール済みプラグインの身元を、所有するステージとスコープのメタデータと、`tools/data/` の下の合成サイドカーから導きます。合成がコントリビューション（センサー、produces、オーバーレイ）をマージしたプラグインは、ステージもスコープも所有しなくても発見できます。

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(
  process.env.AIDLC_PROJECT_DIR ?? process.cwd(),
  process.env.AIDLC_HARNESS_DIR ?? ".claude",
);

console.log(JSON.stringify({
  checks: [{
    pass: existsSync(join(root, "tools", "my-plugin-helper.ts")),
    label: "my-plugin helper installed",
    fix: "Run `bun <harness-dir>/tools/aidlc-utility.ts plugin-sync` or re-run hooks/compose.ts.",
    severity: "error",
  }],
}));
```

既定の `error` の振る舞いには `severity` を省きます。doctor を失敗させてはならない、見える所見には `advisory` を使います。スクリプトは読み取り専用で依存なしに保ちます。doctor はその実行時間/出力を境界づけ、スクリプトの失敗を診断行に変えます。

### コマンドを出荷する

人がオンデマンドで実行するツール（レポート、ダッシュボード、ジェネレーター）を持つプラグインは、それを `aidlc.commands` で名指します。各名前を、その `tools/` に直接ある 1 つの `.ts` スクリプトと、1 行の説明にマッピングします。

```json
"commands": {
  "test-pro-report": { "script": "tools/test-pro-report.ts", "description": "Print the coverage report" }
}
```

人はそれを AI-DLC 自身のコマンドのように実行します。ターミナルで `aidlc test-pro-report`（コピーインストールでは `bun <harness-dir>/tools/aidlc.ts test-pro-report`）、チャットで `/aidlc test-pro-report`（Codex では `$aidlc test-pro-report`）です。あなたのステージの散文も同じように `{{INVOKE}} test-pro-report` と名指し、それが各インストールの正しい形になります。
AI-DLC は、doctor が doctor チェックを始めるのと同じように、スクリプトを自分のランタイムで始めます。コピーインストールでは Bun、ネイティブでは `aidlc` バイナリで、間にシェルを挟まないので、PowerShell、cmd、POSIX シェルのどれでも動きます。スクリプトは名前の後のすべての引数、stdin、stdout、stderr を得て、その終了コードが通ります。`AIDLC_PROJECT_DIR`、`AIDLC_HARNESS_DIR`、`AIDLC_PLUGIN_NAME` が設定されます。ネイティブインストールでは、スクリプトが実行する `aidlc` コマンドがエンジンに届きます。コピーインストールでは、スクリプトは `bun $AIDLC_HARNESS_DIR/tools/aidlc.ts`（`AIDLC_PROJECT_DIR` から実行）として届きます。人がそこでタイプするコマンドです。`aidlc --help` は、あなたのコマンドをあなたのプラグインの下に、その説明とともに並べます。

- **名前:** 小文字、数字、`-`。英字で始まり、多くとも 40 文字。プラグイン名を接頭辞にします。短い一般的な語は、人自身の文を開くこともできる（`/aidlc report the bug`）ので、AI-DLC はそのときエージェントにどちらの意味かを読むよう尋ねます。
- **AI-DLC の名前は AI-DLC のまま:** `aidlc plugin validate` は、AI-DLC 自身のコマンドが使う名前（`doctor`、`config`、`plugin`、`space`、…）を拒否します。プランの名前や、すでに有効なプラグインが名前で持つ名前は、プラグインがインストールされるとスキップされ、sync が 1 度、両方を名指す 1 行で言います。doctor がその行を保ちます。
- **オンのときだけ:** コマンドは、そのプラグインがインストールされ、プロジェクトでオンのあいだだけ実行されます。オフのとき、`aidlc <name>` は 1 行でそう言い、またオンにする `aidlc config project --plugins` コマンドを示します。
- `VALIDATE` と `BUILD` は、不正なエントリ（ルール `manifest-commands`）を拒否します。不正な名前、`tools/` の外または欠けたスクリプト、`contributes.tools` がない、未知のキーです。そのフィールドより古い AI-DLC はそれを無視します。コマンドは単に無いだけです。
- プラグインがコマンドを名指す前に合成されたプロジェクトは、次のプラグイン sync でそれらを記録します（Claude Code と Codex では新しいセッション、他では `plugin sync`）。

## 5. 配布 + インストール

出荷されるビルダーは、あなたのプラグインを、一度に 1 つのハーネス向けの**本物のホストプラグイン**として発行します。`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、Copilot の `.plugin/plugin.json`、Kiro のフォルダ投影を含みます。

```bash
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> <harness> [outDir]
```

既定の出力は `<plugin-root>/dist/<harness>/` です。公開する各ハーネスについて 1 度実行します。リポジトリのパッケージャーは同じ発行側を使って、一次の `dist/plugins/<name>/<harness>/` ツリーを作るので、そのバイト一致のガードが外部のビルドも守ります。出力を、semver タグと `marketplace.json` を持つ git リポジトリに公開します。チームはホストのネイティブなコマンドを通じてインストールします。

ホストはあなたのプラグインを、あなたが選んだ名前で示します。プラグインはマニフェストの `name` で、`aidlc.marketplace` が名指すカタログに並ぶか、それを省くとプラグイン自身の名前で並びます。`aidlc` 名前空間は AI-DLC 自身のもの（私たちのプラグインは `aidlc-plugins` カタログに `aidlc-<name>` として示されます）なので、validate と build は、`aidlc` という名前、または `aidlc-` で始まる名前のカタログを、どの大文字小文字でも拒否します。2 つ目の `aidlc-plugins` カタログは Claude Code で私たちのものを置き換えます。公開する各リポジトリは自分のカタログ名を要します。ホストは名前ごとに 1 つのカタログを保つからです。

### Claude / Codex（ホストストア）

```bash
# teams run these in their host CLI:
/plugin marketplace add <your-org>/<your-plugin-repo>    # Claude
/plugin install acme-standards@acme-aidlc-plugins        # Claude

codex plugin marketplace add <your-org>/<your-plugin-repo>   # Codex
codex plugin add acme-standards@acme-aidlc-plugins           # Codex
```

**SessionStart フック**（発行されたプラグインに同梱）が、その注入された現在のルートについて、`aidlc engine plugin sync` と同じトランザクショナルな sync の実装を呼びます。プラグインのサブツリーとコントリビューションをマージし、結果を検証し、ステージグラフ + スコープグリッドをコンパイルし、バージョン/ソースハッシュの合成 stamp を書きます。orchestrator はそのコンパイル済みグラフだけでルーティングするので、プラグインのステージは合成された瞬間に実行されます。編集する散文もスキルファイルもありません。

Sync は、合成しながらライブのプロジェクトを決して編集しません。関連するハーネス、`.agents`、`aidlc` の面をステージングにコピーし、そこで合成して再生成し、`plugin-compose-<key>.json` とハッシュで証明された `plugin-owned-<key>.json` を書き、次に共有のトランザクションエンジンを通じてステージングされた差分をコミットします。障害は、すべてのファイル、モード、stamp、所有の記録を復元します。`--prune-missing` は意図的により厳しく、証明された完全なホスト目録、自動化での `--yes`、変わらない所有ハッシュを要します。ローカルまたは非所有のバイトは拒否されます。ターミナルでは何も尋ねません。刈り込むプラグインと、取り戻し方（ホストで再インストールし、次に sync）を名指し、次に刈り込みます。

### プロジェクトの選択

合成はプラグインのバイトをインストールします。選択は、どのインストール済みのステージ、スコープ、ランナー、コントリビューションが有効かを制御します。

```bash
aidlc engine plugin select aidlc,test-pro
aidlc engine plugin list
aidlc engine plugin sync
```

`plugin select` は、無効化されたコントリビューションの除去、グラフ/グリッドのコンパイル、ランナー、生成された表を、1 つのプロジェクトトランザクションにコミットする前にステージングします。再び有効にされたコントリビューションは、次の SessionStart sync で戻ります（合成フックを実行しない Kiro CLI と opencode では、プラグインのフォルダで `aidlc engine plugin sync --plugin-root <folder>` を実行したとき）。有効なワークフローが必要とするプラグインの無効化を拒否します。`PLUGIN_SELECTION_CHANGED` 監査の追記はコミットされる検証の一部なので、監査の失敗は選択全体をロールバックします。`plugin list` は別です。ホスト目録を合成/所有の stamp と比べ、選択を変えません。

### Kiro（ストアなし — フォルダドロップ、次に composer を明示的に実行）

```bash
# Copy the Kiro projection's .kiro folder into the project; the plugin lands
# in its own folder, .kiro/aidlc-plugins/<name>/, beside any other plugin:
cp -r <projection>/.kiro <project>/
# preferred when aidlc is on PATH:
AIDLC_PLUGIN_ROOT="<project>/.kiro/aidlc-plugins/<name>" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro aidlc engine plugin sync

# fallback: run the composer explicitly:
AIDLC_PLUGIN_ROOT="<project>/.kiro/aidlc-plugins/<name>" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "<project>/.kiro/aidlc-plugins/<name>/hooks/compose.ts"
# open in Kiro IDE or start kiro-cli --v3 (kiro-cli --v2 for the kiro projection, on Kiro CLI 2.21.4 or later) → /aidlc
```

> **Kiro の注記。** Kiro IDE 1.x または Kiro CLI v3 には `kiro-ide` の投影を使います。そのフォルダドロップは、ワークスペースルートから
> `aidlc engine plugin sync --harness-dir .kiro --plugin-root ./.kiro/aidlc-plugins/<name>` を実行する `version: "v1"` の
> `.kiro/hooks/aidlc-<plugin>-compose.json` SessionStart 登録を含みます。または、`aidlc` がインストールされていないところで、そのプラグインフォルダのクロスプラットフォームな
> `hooks/aidlc-plugin-compose.ts` Bun ランチャーです。
> Kiro は `timeout` のないフックを 60 秒後に止めるので、その登録は 1800 秒を要求します。AI-DLC は
> すでにプロジェクトにある登録にはそれを加えません。このリリース以降で作られた投影がそれを運びます。
> `kiro` の投影はフック登録を発行しないので、上の明示的な composer コマンドの 1 つを実行します。どちらの投影も、退役した
> `.kiro.hook` のプラグイン登録を発行しません。

### Trust

Trust は**ホストネイティブ**です。何も作りません。
- Claude: 組織の管理者が `strictKnownMarketplaces` を設定します（管理され、上書き不可）。
- Codex: プラグインごとに 1 回の trust プロンプト。内容ハッシュでピン留め。
- Kiro: 該当なし（フォルダドロップ、ホストのゲートなし）。

> **具体例** — `plugin.json`、`marketplace.json`、`managed-settings.json`（組織の trust 設定）、`aidlc.lock.json` は
> [`examples/test-pro/`](../reference/examples/test-pro/)にあります。完全なプラットフォームチームの作業例は
> [Plugin Mechanism §9](../reference/18-plugin-mechanism.md)も参照してください。

## プラグインを作りテストする

出荷される骨格から始め、次に最も安いものから最も現実的なものまで、3 つのテストのティアを使います。

### プラグインを作る

決定論的な最小のプラグインリポジトリを作ります。

```bash
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir]
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir] --json
```

名前は小文字のケバブケースで、ターゲットディレクトリ名に一致しなければならず、`core`、`aidlc` にはできず、予約の `aidlc-` 接頭辞も使えません。`targetDir` が無いと、出力は `./<name>/` に着地します。CREATE は空でないターゲットを拒否し、既存のファイルを決して上書きしません。

骨格は、スキーマ妥当なマニフェスト、1 つの名前空間付きの例のステージ・スコープ・エージェント、完全なオーサリングフローのルート README、`tests/` の README を含みます。それは意図的に `hooks/compose.ts` を省きます。検証は文書化された不在の警告を報告し、BUILD が同梱の現在のフックを注入します。

### プラグインを検証する

ビルドまたは合成の前に、出荷される validator をプラグインリポジトリのルートに対して実行します。

```bash
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root>
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root> --json
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root> --with <base-root>
```

このツールはオフラインで単独です。`<plugin-root>` は `.aidlc-plugin/plugin.json` を含むディレクトリで、AIDLC プロジェクトやフレームワークのチェックアウトは要りません。exit `0` は妥当、`1` はオーサリングの所見、`2` は無効なコマンドの使い方を意味します。JSON 出力は、安定したファイル範囲の所見を持つ `{valid, errors, warnings}` です。

検証のチェックは次のとおりです。

- マニフェストが存在し、文書化された身元、SemVer、`aidlc.contributes` の形を持つこと。
- すべてのステージがパースされ、出荷されるステージスキーマを通り、slug、ファイル名、プラグインの所有が一致すること。
- スコープが `<plugin>-<name>.md` を使い、そのフロントマターの身元に一致し、対応する深さを宣言し、宣言された keywords を空でないブロックまたはフロー一覧としてパースすること。`include_stages` はあなたのベースのステージだけを名指す（自分のものや core ステージは決して名指さない。ベースのステージ slug は合成が要るとおり、その名前で始まる）。それぞれは、`--with <base-root>` があなたのベースのチェックアウトを名指さない限り、検査されないという警告で、そのベースはそれを持たなければならない。
- エージェントが `<plugin>-<role>-agent.md` を使い、そのフロントマターの身元に一致すること。
- 2 つのプラグインステージが、`produces` と `optional_produces` にまたがって同じアーティファクトを生成しないこと。どのステージもそれを消費しなくてもそうである。
- 生成されるアーティファクトがプラグイン名の接頭辞を使い、ステージ本文が空でなく、ステージのエージェント参照が、同梱の core にプラグインの名簿を加えたものに対して解決し、コントリビューションのターゲットが同梱の core ステージの slug に解決すること。ベースの上に作られたプラグインは、ベースのエージェントでステージをリードできる。ベースのチェックアウトがなければ、そのようなエージェント（`<base>-...`）は検査されないという警告になる。`--with <base-root>` はあなた自身のベースのチェックアウトを名指し、そのエージェントが勘定され、マニフェストが名指すベースでなければならない。ベースを宣言せず、core のものでも自分のものでもないステージ（`requires_stage`）やエージェントを名指すプラグインは、1 つのステップで失敗する。それを出荷するプラグインを `dependencies` に加えることである。
- 書かれたプラグインの内容が通常のファイルとディレクトリを使うこと。stages、scopes、agents、contributions、sensors、knowledge、tools、hooks の下のシンボリックリンクは、静かに省かれたり辿られたりするのではなく、拒否される。
- `tools/` が、合成がインストールにコピーする、入れ子の `tests/`、`fixtures/`、`*.test.ts` のペイロードを含まないこと。
- ベンダリングされた `hooks/compose.ts` が、存在するとき、validator に同梱のテンプレートとバイト同一であること。不在は妥当である。プラグインのビルドが現在のテンプレートを注入するからである。

ユーザー向けの `aidlc plugin validate`、`aidlc plugin build`、`aidlc plugin test` の動詞は、ネイティブインストールでもコピーチャネルでも、この同じ出荷ツールに委譲します（そこでは動詞は `bun <harness-dir>/tools/aidlc.ts plugin ...`）。`aidlc plugin create` は
[RFC #723 section 2e](https://github.com/awslabs/aidlc-workflows/issues/723)に先送りのままです。その出荷される Bun ツールを直接呼びます。

リポジトリのテストヘルパーの `validatePluginContent()` は、これらの共有ルールを同じツールに委譲し、チェックアウトを意識したフィクスチャの統合を保ちます。

### プラグインをビルドする

検証済みの 1 つのプラグインを、1 つのホストネイティブなプラグインに投影します。

```bash
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> claude
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> codex ./release/codex
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> cursor --json
```

ビルダーは、何かを書く前にインプロセスで検証を実行します。エラーはビルドを exit `1` で拒否し、警告は進みます。無効なコマンドの使い方と未知のハーネス名は exit `2` です。`outDir` が無いと、出力は `<plugin-root>/dist/<harness>/` に着地します。BUILD は、出力パスの、既存の出力サブツリーの中の、または信頼されたビルド境界と出力の間のシンボリックリンクも拒否します。既定の出力ではその境界はプラグインのルートなので、リンクされた `<plugin-root>/dist` は拒否されます。境界の上の環境のエイリアスは、他の点で所有される出力を無効にしません。

オーサリングフローは次のとおりです。

1. `aidlc-plugin-create.ts` で決定論的な骨格を**作る**。
2. プラグインが所有するステージ、スコープ、エージェント、他のコントリビューションを**書く**。
3. 書かれたルートをオフラインで**検証する**。
4. 支える各ハーネスの投影を**ビルドする**。
5. 実際のインストールの使い捨てのコピーに対して合成を**テストする**。
6. それらの生成されたディレクトリとマーケットプレイスのメタデータを、自分のリポジトリから**公開する**。

4 つのツールはすべて、コピーされた AIDLC ツールバンドルから実行され、AIDLC プロジェクトもフレームワークのチェックアウトも要しません。

### 合成をテストする

「このプラグインは自分のインストールにきれいに合成されるか」に、そのインストールを変えずに答えます。

```bash
aidlc plugin test [path] --install <project-root> [--harness <name>] [--with <base-root>] [--json]
```

`[path]` はプラグインのルートで、`aidlc plugin validate` と同じく現在のフォルダが既定です。この動詞は出荷される `aidlc-plugin-test.ts` を実行し、コピーされた tools フォルダはそれを `bun <tools-dir>/aidlc-plugin-test.ts <plugin-root> --install <project-root> ...` として実行します。

このツールはまず検証とビルドをし、選んだインストール面を一時の候補にコピーし、実際の発行された `hooks/compose.ts` を実行し、候補のグラフを再コンパイルし、プラグインのステージとスコープが存在することを検証し、べき等性を証明するため合成を 2 度目に実行します。どの合成の落ち、グラフの失敗、欠けたプラグインノード、2 回目のファイル変更も exit `1` です。無効なコマンドの使い方は exit `2` です。ライブのインストールは前後でハッシュされ、決して合成のターゲットになりません。

インストールが曖昧なとき `--harness` を渡します。`.kiro`（Kiro CLI か Kiro IDE）と `.aidlc`（Copilot か OpenCode）を含みます。ベースの上に作られたプラグインでは、`--with <base-root>` が、sync がベースを先に合成するのと同じく、あなたのベースのチェックアウトを候補に先に合成するので、インストールはベースを要しません。この単独のツールは、RFC #722 のマイルストーン 2 がリリースされたランタイムバンドルのチャネルを定義するまで、`--dist <version>` を予約します。

1. **内容の検証**は常時 on のベースラインです。書かれたプラグインのルートに対する `aidlc plugin validate` です。速く、正確なオーサリングの所見を与えますが、パッケージングや合成が成功することを証明しません。
2. **合成の統合**は既定の CI チェックです。実際のインストールに対する `aidlc plugin test` です。このティアは決定論的で、実際のビルダーと composer を行使しますが、モデル裏打ちのハーネスを起動しません。
3. **ライブのハーネス e2e** はオプトインの互換性の証拠です。作られたプラグインをホストにインストールしてそこで実行します。ライブの実行は、ホストが合成されたプラグインを発見して呼べることを証明しますが、インストール済みの CLI、資格情報、より多くの時間を要します。

#### あなたのプラグインのリポジトリで

プラグインリポジトリの CI は、人がいないどのマシンでもそうするように、ジョブで aidlc をインストールし（[インストールとライフサイクル](../guide/18-install-and-lifecycle.md#automation)）、3 つの動詞を実行します。テストが合成する先のインストールは、`aidlc config` が、公開するハーネスについて一時フォルダにセットアップするスクラッチプロジェクトです。

```bash
install_root="$(mktemp -d)"
aidlc config --project-dir "$install_root" --harness claude --yes
aidlc plugin validate
aidlc plugin test --install "$install_root"
aidlc plugin build claude
```

各コマンドは所見で非ゼロで終了するので、ジョブは最初の 1 つで止まります。公開する各ハーネスについて、同じようにそのスクラッチインストールをセットアップし、次にそれについて `aidlc plugin test --install <that install>` と `aidlc plugin build <harness>` を実行します。

#### このリポジトリの中で

`plugins/<name>/tests/*.test.ts` の下のプラグインテストは自動で発見され、統合のティアに加わります。1 つのプラグインのテストを実行するには次のようにします。

```bash
bash tests/run-tests.sh --integration --filter 'plugin-<name>'
```

これらのテストはこのリポジトリ自身の `tests/harness/plugin-kit.ts` のヘルパーを、相対パスでインポートして使うので、ここでだけ実行されます。自分のリポジトリのプラグインは、代わりに上の動詞を実行します。`validatePluginContent()` は共有ルールを出荷される validator に委譲し、`composePluginFixture()` はフックのサブプロセスと落ちの読み手を出荷される合成テストに委譲しつつ、そのテスト専用のフィクスチャ API を保ちます。最小の内容テストは次のとおりです。

```ts
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginContent } from "../../../tests/harness/plugin-kit.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin content is valid", () => {
  expect(validatePluginContent(pluginRoot)).toEqual([]);
});
```

プラグインがステージ、コントリビューション、エージェント、スコープ、センサー、ツールを出荷するときは、決定論的な合成テストを加えます。

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePluginFixture } from "../../../tests/harness/plugin-kit.ts";

test("plugin composes into a Claude install", () => {
  const fixture = composePluginFixture({
    plugin: "your-plugin",
    harness: "claude",
  });
  const graph = JSON.parse(
    readFileSync(
      join(fixture.projectDir, ".claude", "tools", "data", "stage-graph.json"),
      "utf-8",
    ),
  ) as Array<{ slug?: string }>;
  expect(graph.some((stage) => stage.slug === "your-plugin-stage")).toBe(true);
});
```

ここでのライブのティアには、`liveGateFor()` が返すゲートの背後でだけ `invokeHarness()` を呼びます。ライブのゲートは `AIDLC_CLAUDE_SDK_LIVE`、`AIDLC_KIRO_ACP_LIVE`、`AIDLC_CODEX_EXEC_LIVE`、`AIDLC_COPILOT_EXEC_LIVE`、`AIDLC_OPENCODE_RUN_LIVE`、`AIDLC_CURSOR_RUN_LIVE` です。設定されていないゲートはスキップの結果を返すので、green なテスト実行が、ライブのチェックが実行されなかったことを意味することもあります。

## 道の規則

- **番号は表示専用。** 理にかなった `number:` を書き、範囲を主張せず、ステージの挿入は core の番号を振り直しません。
- **アーティファクトの名前空間。** 生成するアーティファクトはすべて `<plugin>-` の接頭辞を持ち、core のアーティファクトや他のプラグインのものと衝突してはいけません。
- **プリミティブの名前は一意。** あなたのスコープ/エージェント/センサーは、core や他のプラグインと衝突してはいけません。衝突は帰属付きの合成エラーです。（プラグインのルールは自分だけの節に着地し、決してチームのものには入りません。）
- **ベースは多くとも 1 つ。** プラグインは core と多くとも 1 つのベースプラグインの上に作られます。`"dependencies": ["core", "acme@^1.2.0"]` です。ベース自身は core だけの上に作られます。Sync はベースを先に合成するので、あなたのステージはその後に順序づけられ（`requires_stage`）、そのアーティファクトを読み、そのエージェントを名指し、そのステージを自分のスコープで実行できます（`include_stages`）。それらは `--with <base-root>` で確かめます。`aidlc plugin create` は `["core"]` を書くので、ベースは手で加えます。そうするまで、validate と build は別のプラグインのステージやエージェントで止まります。さもないと名前がたまたま正しい順に並ぶときだけ合成されてしまいます。インストール済みのベースが欠けている、範囲の外、別のプラグインの上に作られている、またはあなたのスコープが含むステージを欠くなら、あなたのプラグインは合成されず（前に合成されたバージョンはそのまま）、人は理由を言う 1 行を見ます。他のすべてはなお合成されます。2 つ目のベース、自分の名前、npm が読めない範囲は `aidlc plugin validate` で失敗します（doc 18 §8）。
- **追加だけ。** コントリビューションは加えます。core ステージのフィールド、エージェント、散文を上書きも削除もできません。（上流の振る舞いを*変える*本当の必要は、プラグインの関心ではなくフレームワークの設計の決定です。）

## 関連

- [Plugin Mechanism](../reference/18-plugin-mechanism.md) — 規範的な設計です。マニフェスト、合成モデル、コントリビューションの継ぎ目、インストール時の根拠、ハイブリッドの配布モデル、マルチテナントのガード、実装状況（すべてこの 1 章にまとめられています）。
- [ステージの構造](01-anatomy-of-a-stage.md)、[Scopes](04-scopes.md)、[Sensors](06-sensors.md) — プラグインが合成する構成要素です。

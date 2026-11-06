# プラグインの仕組み

> 対象読者: Tier 2/3（チーム導入者、フレームワーク貢献者）。

> **パスの規約。** 以下の `<harness-dir>/` はハーネスのランタイムディレクトリ（`.claude` / `.codex` / `.kiro` / `.aidlc` / `.cursor`）を指します。`plugins/<name>/` は書かれたプラグインのソース、`dist/plugins/<name>/<harness>/` は `bun scripts/package.ts` が出力する、無視されるローカルなホストプラグインの射影です。

この章は、**AIDLC プラグイン** システムの正式なリファレンスです。これは任意の、所有された、バージョン管理された貢献のセット（新しい stage、agent、scope、sensor、doctor のチェック、そして *既存のコア stage への加算的な変更*）で、ハーネス中立のツリーとして一度書かれ、各ハーネス向けに **実際のホストプラグインとして出力されます**。プラグインは `core/` を決して編集しません。無効化されたプラグインのファイルはインストールされたままですが、その stage と scope はグラフから除外され、マージされた貢献はコア stage から取り除かれるので、ワークフローは素のコアとして実行されます。このシステムは、実証済みの編集不要の継ぎ目（加算的に合成される phase のルール）をあらゆる面に一般化し、それを専用のインストーラーではなく各ホスト自身のプラグイン機構を通じて配信します。関連リンク: [Stage Definition](15-stage-definition.md)（プラグインが書く stage の frontmatter。`plugin`/`number`/`when` を含む）、[Engine and Skill System](17-skill-system.md)（composer が供給し orchestrator がルーティングの基にするグラフ）、[Artifact Vocabulary](16-artifact-vocabulary.md)（名前空間の規則）、そして著述のウォークスルー [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md)。

---

## 1. プラグインとは何か

プラグインは、宣言的なマニフェストとコアと同じ形のサブツリーを持つディレクトリ（かつ git リポジトリ）です。次のことができます。

- 新しい stage（最初のコンパイル時に engine が番号を付ける。プラグインは表示番号の範囲を要求しません）、agent、scope、sensor を **追加** します（space memory のシードのためのメソッド/ルールは先送りです。バリデーターは `memory` の貢献を拒否します）。
- 貢献の継ぎ目（§6）を通じて、既存のコア stage を **加算的に変更** します。stage を編集せずに、それが produces・consumes・checks・instructs するものを豊かにします。

ファーストパーティのプラグイン（AIDLC チームが配布）とサードパーティのプラグイン（それ以外の誰か）は **機構的に同一** です。構造も、継ぎ目も、composer も同じです。両者は来歴（プラグインがどのリポジトリに住み、誰がレビューしたか）と、ホストがそれらをどう列挙するかで異なります。AI-DLC 自身のものは共有された1つの `aidlc-plugins` カタログに `aidlc-<name>` として現れ、それ以外の誰かのものは、その作者の名前のもと、独自のカタログに現れます（セクション9）。`plugins/test-pro/` が参照用のフィクスチャです。

この仕組みが守る **設計原則** は次のとおりです。

- **厳密に加算的で、決して上書きしない。** 貢献は *追加* だけを行います。構造的な面にわたる和集合は可換であり、これが独立した作者を安全にします。本当の衝突は、プラグインの帰属を伴うコンパイルエラーであり、暗黙に last-writer-wins になることは決してありません。
- **コアの不変性。** どのプラグインも `core/` のファイルを編集しません。プラグインが配布するものはすべて、そのプラグイン自身のツリーに住みます。
- **オフのとき可逆で不活性。** プラグインを無効化すると、それなしのインストールへ正確に再合成されます。
- **slug が同一性。** stage は、重要なあらゆる場所（エッジ、ジャンプ、解決）で slug によって識別されます。`number` は表示/順序のためだけなので、挿入されたプラグイン stage がコアの番号を振り直したり不安定にしたりすることは決してありません。

## 2. なぜインストール時か、ホストプラグインとして配信するか

繰り返し問われた設計上の問いは、プラグインが *ビルド時* のアーティファクト（中央で事前合成し、コピーして入れる）なのか、*インストール時* のもの（利用者のマシンで、選んだセットの上で合成する）なのか、でした。この仕組みは **インストール時** です。より広いエコシステム（npm、Cargo、Helm、VS Code、Nix）がすでに収束している、2つの構造的な理由によります。

- **組み合わせ爆発。** N 個のプラグインは最大 2ⁿ の有効なサブセットを生みます。中央のビルドはすべての組み合わせを事前合成できません。事前にビルドする価値のある唯一のアーティファクトは **素のコア**（空集合）で、誰にとっても同一です。
- **遅延解決。** 正しいプラグインのセット、そして同じ stage への2つのプラグインの貢献がどうマージされるかは、それらを選んだインストールでのみ分かります。

配信の手段は、専用の AIDLC インストーラーではなく **ホスト自身のプラグインシステム** です。フレームワークが対象とするすべてのハーネスは、すでにマニフェスト優先で git 配布のプラグインモデル（Claude Code の `.claude-plugin/`、Codex の `.codex-plugin/`）を配布しています。AIDLC プラグインは *その1つ* です。これが **ハイブリッド** です。ストアが存在するところ（Claude、Codex、opencode、Copilot は「ストア」のレイアウトとして射影）では実際のホストプラグイン、ストアのないもの（Kiro）にはフォルダへの配置です。その結果は次のとおりです。

- **私たちは配布インフラを運用しません。** 顧客は自前のプラグインリポジトリ（git + semver タグ + `marketplace.json`）をホストします。1つのマーケットプレイスのエントリが、混成のフリート向けに1つのプラグインを列挙します。
- **信頼はホストネイティブ。** 組織の制限はホストの管理された許可リスト（Claude の `strictKnownMarketplaces` はユーザーが上書きできない。Codex はハッシュ固定の信頼）を使います。AIDLC は信頼レイヤーを構築しません。
- **composer はインストール時に、ホストの hook によってトリガーされて実行されます。** 組み合わせごとの事前ビルドされたツリーはありません。SessionStart hook が、選ばれたセットをローカルで合成します。

> **セキュリティ上の注意 — Kiro のフォルダ配置にはインストール時の信頼ゲートがありません。** Claude と Codex は、プラグインの hook が実行できるようになる *前に*、自前の信頼プロンプト（管理されたマーケットプレイス / ハッシュ固定の承認）を通じてプラグインを仲介します。Kiro にはプラグインストアがないので、フォルダ配置のパスは実行可能なプラグインファイルを **同等のゲートなしに** コピーします。ツリーを配置すること *そのもの* が信頼の判断です。Kiro IDE の射影には、`aidlc engine plugin sync` を実行する `v1` の SessionStart 登録が含まれます。`aidlc` がインストールされていない場合は、`hooks/aidlc-plugin-compose.ts` の Bun ランチャーです。Kiro CLI の射影は、合成をあなたが明示的に実行するコマンドに委ねます。どちらの Kiro プラグイン配置も `git clone && run` のように扱ってください。あなたがコードを実行してもよいと思えるソースからのプラグインだけをインストールし、配置が持ち込む差分をレビューし、動くブランチを追うのではなく、レビュー済みのタグにプラグインリポジトリを固定してください。composer 自体は加算的で `core/` を決して編集しませんが、ユーザーのプロセス権限で実行されます。

貢献の継ぎ目（§6）がこれを重要にする理由です。それは構造的に VS Code の `contributes` + Cargo の加算的なフィーチャーの和集合であり、この分野で最もよく合成するモデルです。そしてそれは、ゲートキーピングなしに、ファーストパーティもサードパーティも含む *すべての* プラグインに利用できます。

## 3. プラグインの構造とマニフェスト

プラグインのツリーは `core/` の形を映すので、packager はそれをすべてのハーネスへ射影できます。一度書けばハーネス中立です。

ツリーは *設計上* の面として `core/` の全体の形を映します。✅ は packager が現在射影するサブツリー、⏳ は設計済みだがまだ射影されていないもの（§7）を示します。

```text
plugins/<name>/
  .aidlc-plugin/plugin.json              # マニフェスト
  stages/<phase>/<slug>.md               # ✅ 新しい stage（slug が同一性。number は表示専用）
  sensors/aidlc-<id>.md                  # ✅ 新しい sensor マニフェスト
  tools/<id>.ts                          # ✅ sensor スクリプト（sensor が実行できるように）
  tools/<plugin>-doctor.ts               # ✅ 任意の /aidlc --doctor チェック
  contributions/<phase>/<slug>.md        # ✅ コア stage への加算的な変更（§6）
  contributions/agents/<agent>.md        # ✅ コアのペルソナへの散文フラグメント（§6）
  agents/<plugin>-<role>-agent.md        # ✅ 新しい agent（stem == frontmatter の name）
  scopes/<plugin>-<name>.md              # ✅ 新しい scope（stem == frontmatter の name）
  knowledge/<agent-slug>/…               # ✅ agent ごとの METHODOLOGY の knowledge
  tests/                                 # プラグイン自身の内容検証（integration tier）
  memory/rules.md                        # ハウスルール、プラグインのレベルに1セクション（セクション7）
  memory/phases/<phase>.md               # phase ルール、その phase のルールファイルに1セクション（セクション7）
```

コアの scope ファイルはファイル名の接頭辞 `aidlc-` を使います。プラグインの scope ファイルはそれをプラグインの接頭辞（`<plugin>-<name>.md`）に置き換え、ファイル名の stem は frontmatter の `name` と等しくなります。プラグインの agent ファイルは同じ規則に従います。`<plugin>-<role>-agent.md` で、frontmatter の `name` は stem と等しくなります。

`.aidlc-plugin/plugin.json` は **宣言的な** マニフェストです。そのトップレベルは共通のホストプラグインマニフェストの形を映します（マーケットプレイスやホストのツールがそれを列挙・バージョン管理・信頼できるように）。AIDLC 固有の設定は、ネストした `aidlc` ブロックに隔離されます。

```jsonc
{
  "name": "test-pro",                 // == ディレクトリ名。"core"・"aidlc"・"aidlc-*" は予約。kebab-case
  "version": "0.1.0",                 // semver
  "description": "…",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core", "compliance@^1.2.0"],  // core と、最大1つのベースプラグイン（§8）
  "aidlc": {
    // "marketplace": "acme-aidlc-plugins",  // 他の誰かが作るプラグイン: そのカタログ（セクション9）
    // "rulesLevel": "team",           // インストールが別を設定しない限り memory/rules.md は team.md に入る（セクション7）
    "contributes": {                  // このプラグインが配布するサブツリー
      "stages": "stages/", "agents": "agents/", "scopes": "scopes/",
      "sensors": "sensors/", "knowledge": "knowledge/",
      "tools": "tools/", "overlays": "contributions/"
    }
  }
}
```

決定論的な最小限の書かれたプラグインリポジトリを作成します。

```bash
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir]
```

CREATE は空でないターゲットを拒否し、マニフェストに加えて、名前空間化された例の stage、scope、agent、tests の README を1つずつ出力します。結果はただちに有効です。BUILD が同梱の hook を注入するため、`hooks/compose.ts` は設計上ありません。

書かれたプラグインリポジトリを、ビルドする前に検証します。

```bash
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root> [--with <base-root>]
```

配布されるバリデーターは、AIDLC プロジェクトやフレームワークのチェックアウトなしに、オフラインで実行されます。マニフェスト、stage のスキーマ、scope と agent の同一性、プラグインローカルなアーティファクトの衝突、`tools/` 配下の誤ったテスト/フィクスチャのペイロード、そして同梱された `hooks/compose.ts` を、ツールに同梱されたテンプレートと照合してチェックします。プラグインのベースだけが供給できる stage agent は、`--with` がそのベースの作者のチェックアウトを名指ししない限り、警告になります。ベースを宣言しないプラグインでは、コアのものでもプラグイン自身のものでもない stage や agent は、`dependencies` を名指しするエラーになります。トップレベルの `aidlc plugin validate|build|test` のルートは、これらと同じ実装に委譲します。`create` のルートは [RFC #723 section 2e](https://github.com/awslabs/aidlc-workflows/issues/723) に先送りされたままです。

同じ外部リポジトリから1つのホスト射影をビルドします。

```bash
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> <harness> [outDir]
```

ビルダーは書き込む前に検証し、デフォルトは `<plugin-root>/dist/<harness>/` です。チェックアウトの packager と配布されるビルダーは、同じ emitter を呼びます。ハーネスのマニフェストが真実のソースのままです。パッケージングはそれらの射影レコードを `tools/data/plugin-targets.json` に出力し、スタンドアロンのビルダーがそれをオフラインで消費します。

選択されたインストールを変更せずに合成をテストします。

```bash
bun <tools-dir>/aidlc-plugin-test.ts <plugin-root> \
  --install <project-root> [--harness <name>] [--with <base-root>]
aidlc plugin test [plugin-root] --install <project-root> [--harness <name>] [--with <base-root>]
```

このツールは射影をビルドし、マニフェストから導かれるインストールのルートだけを使い捨ての候補にコピーし、実際の compose hook を2回実行し、drop のない1回目のパス、プラグインの stage と scope を含むクリーンな合成後のグラフ、そしてバイトレベルで安定した2回目のパスを要求します。共有のハーネスのリーフは `--harness` を必要とします。`--with` はベースのチェックアウトを先に候補へ合成します。`--dist` はサポートされません。ツールはそれを拒否します。

貢献のパスはプラグイン相対で、プラグインのルートから抜け出すことはできません。トップレベルは **寛容** です（前方互換性とツール間の許容のため、未知のキーを保持します）。`aidlc` ブロックは **厳格** です（著述のタイポを捕まえるため、未知のキーを拒否します）。射影は依然としてディレクトリの規約（`stages/`、`sensors/`、`tools/`、`contributions/`、`scopes/`、`agents/`、`knowledge/`）で内容を発見するので、宣言された各値はその正規のディレクトリと等しくなければなりません。設定可能なルーティングは先送りです。`memory` は `memory/` でなければならず、`memory/rules.md` を配布するプラグインは、それが入るレベルを `aidlc.rulesLevel`（`org`、`team`、`project`）に名指しします。stage の番号は表示専用なので、プラグインはマニフェストで番号の範囲を要求しません。`overlays` は正規の `contributions/` に対するマニフェスト上の名前で、コピーされるのではなくマージに消費されます。

## 4. 合成モデル

composer は `bare core + {chosen plugins}` の上で一度実行され、実効的なインストールを書き出します。どうトリガーされても **同じ composer** が実行されます。

| ホスト | トリガー | 信頼 |
|------|---------|-------|
| **Claude** | SessionStart hook（セッション生成時に即座に発火） | 管理された許可リスト（`strictKnownMarketplaces`） |
| **Codex** | SessionStart hook（最初のやり取りで遅延して発火） | 一度きりの信頼プロンプト、内容ハッシュ固定 |
| **Kiro CLI** | バイナリが PATH にあるときの `aidlc engine plugin sync`、またはフォルダ配置後の手動の `bun <plugin>/hooks/compose.ts` | 該当なし — フォルダ配置の配布 |
| **Kiro IDE** | フォルダ配置された射影が登録する SessionStart hook（`.kiro/hooks/aidlc-<plugin>-compose.json`。プラグインのフォルダ `.kiro/aidlc-plugins/<name>/` でランチャーを実行、`timeout` は 1800 秒） | 該当なし — フォルダ配置の配布 |

ステップ（トリガーに関わらず同一）:

1. ホストが提供するインストール済みのルート、マニフェストの同一性/バージョン、プロジェクトの選択を **発見して検証** し、ベースを先に置きます。プラグインは、それが構築の基とする1つのベースプラグインのあとに合成されます（§8）。
2. **新しいプリミティブをコピー**: 各プラグインの `stages`/`agents`/`scopes`/`knowledge`/`sensors`/`tools` のサブツリーを対応するハーネスのルートへコピーし、`{{HARNESS_DIR}}` トークンをハーネスの実際のディレクトリに置換します。プラグインの `memory/` はコピーされません。plugin sync がそれをルールファイルに書きます（セクション7）。
3. **貢献をマージ** — stage へのすべてのアクティブな貢献は、対象 stage のソースに畳み込まれます（§6）。構造的な面は和集合され、散文フラグメントはそのアンカーで継ぎ合わされます。
4. **コンパイル** — `aidlc-graph compile` が `stage-graph.json` + `scope-grid.json` を再生成します。orchestrator は完全にそれらからルーティングするので、プラグイン stage は合成された瞬間に実行されます。散文やスキルの編集は不要です。

合成は1回の N 方向のマージ（独立したオーバーレイの連なりではない）なので、**同じ stage に両方が貢献する2つのプラグインは本当にマージされます**。構造的な追加は和集合され、散文フラグメントは決定論的に順序付けられます。一方が他方を暗黙に上書きすることはありません。ランタイムは、合成に関して **読み取り専用** のままです。すべてのマージは合成時に起こり、セッションごとに起こることは決してありません。マージは（コンパイル済みの JSON ではなく）**stage のソース** を編集するので、後のどの `aidlc-graph compile`（例: rebuild-stage-graph hook）にわたっても **永続的** で、**冪等** です。SessionStart ごとの再実行は、新しいものを何も合成しません。

同じプラグインの新しいバージョンを再合成すると、そのプラグインがインストールしたファイルが、インストール以降変わっていなければ置き換えられます。その証拠はハッシュで証明されたレコード `tools/data/plugin-owned-<key>.json` で、`aidlc engine plugin sync` と compose hook の両方が書きます。人が変更したファイルは決して上書きされません。compose の drop ログがそれとステップ（変更を別の場所へ移す、ファイルを削除する、compose を再実行する）を名指しします。レコードがカバーしないファイル（コア、別のプラグイン、レコードが存在する前に合成されたコピー、またはローカルの編集）は同じように保持されて報告されますが、プラグインビルダーが書く knowledge のプリフライトの段落だけがプラグインのコピーと異なる場合（インストール時に再形成され決して記録されなかった agent 2.11.0）は別です。それはプラグイン自身の古いコピーであり、compose がそれを置き換えて記録します。新しいバージョンが古いアンカーと順序でもはや配布しない散文フラグメントは、stage からも contribution の sidecar からも取り除かれるので、移動したフラグメントは一度だけ現れます。

engine の再インストールはグラフのコンパイルとは異なります。新しい `dist/<harness>/` をコピーすると、コンパイル済みのグラフとコア stage のソースが上書きされるので、プラグインが所有するファイルと sidecar は残る一方で、グラフのエントリと貢献のマージは消えることがあります。engine をアップグレードするたびに `/aidlc plugin sync` を再実行してください。compose hook を持つホストは、次のセッション開始時にも面を修復します。doctor の **Composed plugin surface** チェックは、欠けているプラグインのグラフエントリと、古い構造的または散文の貢献の両方を検出し、sync は同じチェックを読みます。記録された追加（構造的な値、フラグメントのマーカー、または同じプラグインの別のフラグメント内にネストされたフラグメント）が失われたプラグインは、再び合成されます。マーカーはあるのにテキストが変わったフラグメントは、人の編集です。それがそのプラグインの唯一のギャップのとき、sync はそれをそのままにし、doctor は名指しし続けます。プラグインの別の追加が失われているとき、sync はプラグイン全体を再び合成し、プラグインの更新と同じく、そのフラグメントをプラグインのテキストで書き直します。読めない、または不正な有効プラグインの sidecar や、欠けている stage を対象とするレコードも、飛ばされるのではなくチェックに失敗します。すでに合成された構造的な値は、その来歴が壊れたあとでは安全に帰属させられないので、不正な sidecar は、ストックの engine をリフレッシュし、その sidecar を削除し、その後 `plugin sync` を実行して復旧してください。

## 5. 選択

プラグインは追加し、インストールは選択します。プラグインを合成すると、そのファイルがインストールにコピーされ、その加算的な貢献がマージされますが、そのインストールのユーザーが見るのは、`<harness-dir>/tools/data/harness.json` が名指しするプラグインだけです。

```json
{
  "harnessDir": ".claude",
  "rulesSubdir": "rules",
  "plugins": ["aidlc", "test-pro"]
}
```

`plugins` キーは任意です。なければ、インストール済みのすべてのプラグインが有効になり、既存のインストールを保ち、配布されるコアをバイト単位で同一に保ちます。あるときは、そのリストが有効なセットです。`aidlc` は暗黙のコアプラグインです。それを省くと、ファイルをインストール済みで再有効化可能なまま残しつつ、コアの stage/scope/runner を無効にします。3つの Initialization stage は例外です。ブートストラップにはプラグインの同一性がないので、それらの stage は有効なすべての scope で常に有効です。

選択を調べたり変更したりするには、決定論的なユーティリティコマンドを使います。

```bash
aidlc engine plugin select
aidlc engine plugin select test-pro
aidlc engine plugin select aidlc,test-pro
```

`select-plugins` は、ワークスペースの変更ロックを保持しながら、名前を既知のセット（`aidlc` に加えて、コンパイル済みのノードと scope ファイルで見つかったプラグイン名）と照合して検証します。プロジェクトの面をステージングにコピーし、そこで無効な貢献を取り除き、`harness.json` を書き、グラフ/グリッドを再コンパイルし、stage/scope の runner を再生成し、orchestrator スキルの横の `tables.md` にある生成された表をリフレッシュします。そうして初めて、ステージングをライブのプロジェクトと差分し、変更されたファイルの完全なセットを `aidlc-transaction.ts` に提出します。監査の追記がトランザクションのコミット済みバリデーターです。失敗すると、engine はすべての選択、グラフ、runner、表、貢献、sidecar のバイトを復元します。これは以前の3ファイルのスナップショットの慣行を置き換えます。`/aidlc --doctor` は有効なプラグイン、プラグインごとの有効 stage 数を報告し、グラフの `enabled:false` フラグが `harness.json` と食い違う場合はハードに失敗します。

`aidlc engine plugin list` は、インストール済みと合成済みを比べる別のステータスコマンドです。プロジェクトの選択を表示したり変更したりはしません。

**ベースが外されたプラグインは一時停止されます。** 選択はリスト全体なので、ベースプラグインを外し、その上に構築されたプラグインを残した人は、そのプラグインを自分で入力したことになります。`select-plugins`（および `aidlc config project --plugins`）は、入力されたとおりにリストを書き、その変更時に1行を一度だけ言います。`zeta is off. alpha builds on zeta, so alpha is paused until zeta is on again. To turn alpha off as well: /aidlc plugin select aidlc.` です。一時停止の間、プラグインが追加するものは何も実行されません。その stage、scope、runner はフィルターされ、マージされた貢献は取り除かれます。オフにされたプラグインと同じで、sync はそれをそのままにし、何も言いません。この規則には1つの所有者 `aidlc-lib.ts` の `pluginsEnabled()`（選択から一時停止されたプラグインを引いたもの。ベースはプラグインの合成スタンプから来る）があり、すべてのランタイムの読み手と doctor の選択一致チェックがそれを読みます。`pluginsSelected()` は入力されたとおりのリストです。`plugin list` はそのプラグインを `paused: needs zeta, which is off` と表示し、doctor は情報として列挙します。ベースを再びオンにすると、次のセッション開始時にプラグインが戻ります（Kiro CLI と opencode では、人が `aidlc engine plugin sync --plugin-root <folder>` を実行したとき）。それをオンにする select または `config project --plugins` が、どれかを一度だけ言います（`aidlc-lib.ts` の `pausedLine()` の横の `resumedLine()`。言葉は `nextCompose()` から）。開いた作業を取り残す一時停止は、どのオフ化とも同じく、プラグインとベースを名指しして拒否されます。`aidlc config project --plugins` を通じて、オフにされた、または一時停止されたプラグインは、マージされた貢献を同じ方法で失います。すべての config のリフレッシュが、そのステージングされたツリーで同じ規則 `aidlc-utility.ts` の `stripPluginsTurnedOff()` を実行します。

## 5a. インストール済みのインベントリ、合成スタンプ、sync

ホストは、公開済みとインストール済みの状態を所有します。AIDLC は、そのインストール済みの状態を、プロジェクトローカルな合成状態と、完全にオフラインで比較します。

- Claude はスキーマ v2 の `~/.claude/plugins/installed_plugins.json` と、`~/.claude/settings.json` の `enabledPlugins` を読みます。Claude の `local` または `project` インストールは、それ自身のプロジェクト、すなわちレコードの `projectPath`（インストールが実行されたフォルダ。サブディレクトリでもよい）を含むプロジェクトでのみ数えられます。ただし `project` インストールは、自身のレコードを持たないクローンや worktree でも、その `.claude/settings.json` がそのプラグインを有効にしているとき数えられます。Claude Code がそこでそれをロードするためです。レジストリは存在するのにその settings ファイルが読めないとき、Claude は現在のルートにフォールバックし、`plugin list` と doctor はそのファイルを要注意としてフラグします。レジストリがなければ settings ファイルは読まれません（下のフォールバックを参照）。
- Codex は `~/.codex/config.toml` で宣言されたプラグイン ID だけを読み、その後、`~/.codex/plugins/cache/<marketplace>/<plugin>/<version-or-local>/` 配下の正確なキャッシュパスを検査します。
- Kiro、Cursor、Copilot、OpenCode では、AI-DLC はホストのプラグインリストを読みません。それらは現在の hook に注入されたプラグインのルートだけを受け入れます。その呼び出しの外では、プロジェクトに合成されたプラグインは「比較されていない（ホストのプラグインリストなし）」として列挙され、決して「欠けている」とはされず、doctor は合成されたプラグインとそのバージョンとともにパスします。Claude と Codex は、レジストリのソースが消えた場合は同じフォールバックを使います。

各アダプターは1つのホストネイティブなマニフェストを読みます。`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`.kiro-plugin/plugin.json`（Kiro と Kiro IDE）、`.cursor-plugin/plugin.json`、Copilot の `.plugin/plugin.json`、または `.opencode-plugin/plugin.json` です。インストール済みのプラグインは、そのルートがプラグイン自身の `.aidlc-plugin/plugin.json`（その `name` がそのキー）を運ぶとき、AI-DLC のものです。そのファイルがプラグインとともに移動する前のビルド（リリースされたすべての test-pro）も、依然としてその `aidlc-<key>` のホスト名で知られます。同じホストリストにある別のベンダーのプラグインは、壊れたエントリを含め、そのままにされます。キーは安全で、バージョンは semver でなければなりません。重複した同一性は、すべてのソースパスとともに拒否されます。どのアダプターもホームディレクトリやキャッシュディレクトリを再帰的にスキャンしません。

合成のあと、AIDLC は `<harness-dir>/tools/data/plugin-compose-<key>.json` に、プラグイン名、バージョン、決定論的なソースハッシュを書きます。このハッシュは、ソートされた compose の入力パスに加えて、`{{HARNESS_DIR}}` 置換前の LF 正規化されたバイトをカバーします。ホストのラッパーと生成されたプロジェクトの出力は除外されるので、同一バージョンのベンダー編集とパスのみのリネームが見えます。

`aidlc engine plugin list [--verbose|--json]` は、ホストのインベントリをそれらのスタンプと比較します。デフォルトの出力は意図的に3つのアクションだけを持ちます。`current`、`run: aidlc engine plugin sync`、`needs attention: <remediation>` です。プラグインリストのないホストでは、合成されたプラグインは `not compared: no host plugin list` と読まれ、何も必要としません。verbose と JSON の出力は内部的な理由を保持します。version differs、source changed、not composed、legacy unstamped、disabled、missing、invalid/ambiguous、inventory unavailable、ベースのために保留（`dependency-unmet`。その STATUS は `needs attention:` で、sync が言った行。§8）、またはベースがオフのために一時停止（`paused`。素の状態。§5）です。2回インストールされたプラグイン、すなわち再ビルドされたものの横にある古い `aidlc-<name>` のコピーは、`installed-twice` です。再ビルドされたコピーが使われ、その STATUS が古いコピーの削除コマンドを名指しします。

`aidlc engine plugin sync` は、ステージングされたプロジェクトで、有効なインストール済みのプラグインをすべて、ベースを先に（§8）合成し、グラフと runner の面を再生成し、合成と所有のレコードを書き、ステージングされたプロジェクトを差分し、1つのプロジェクトトランザクションを提出します。期待状態のチェックは、同時進行のライブ編集を拒否します。コミットの失敗は、すべてのバイト、モード、スタンプ、所有レコードをロールバックします。ステージングされたコピーはリンクを持ちません。AI-DLC 自身のフォルダへの、またはその中へのリンク、あるいは sync が書くファイルへの途中にあるリンクは、何かが変わる前に sync を止め、そのリンクを、あるいはリンクがさらに内側にあるときはそれを含む AI-DLC のフォルダを名指しします。注入された現在のルートを持つサポートされたホスト hook は、そのプラグインだけに対して同じ実装を使います。素の sync は、欠けているインストール済みソースのために内容を削除することは決してありません。明示的な `aidlc engine plugin sync --prune-missing` は、証明された完全なインベントリ、非対話時の `--yes`、ハッシュで証明された所有を必要とします。ローカルで変更された、または所有されていないパスは拒否します。端末では何も尋ねません。prune するプラグインと、それらを取り戻す方法を名指しし、その後 prune します。プラグインファイルの同一性はそのコミット済みのテキストです。改行を変えるチェックアウト（Git for Windows の `core.autocrlf`）は、sync にとっても compose hook にとっても、プラグインのファイルの変更ではありません（[docs/reference/04-stage-protocol.md](04-stage-protocol.md) の「Line endings」の規則）。

list も doctor も sync も、リモートのプラグインレジストリをチェックしません。公開済みバージョンの発見はホストの責任のままです。

ソースツリーのインストールでは、`plugin-sync` ユーティリティ動詞（compose hook のフォールバックの前段）が、環境または `--plugin-root <dir>` から発見されたプラグインのルートの `hooks/compose.ts` ファイルを実行し、プラグインのルートが設定されていないときはきれいに終了します。Claude Code と Codex では `no installed plugins; nothing to sync` で、それ以外のところでは `plugin sync` がそこで表示する行で終了し、その行は合成された各プラグインのコマンドを名指しします（`aidlc-plugin.ts` の `noPluginListLine()` と `syncCommand()`）。ルートが設定されているのにどれも `hooks/compose.ts` を運ばない場合、exit 1 して各ルートと理由を名指しします。混成のセットでは、飛ばした各ルートを警告し、有効なルートを合成し、exit 0 します。

### プラグインコマンド

プラグインは、マニフェストの `aidlc.commands` でコマンドを名指しし、各名前を、その `tools/` 直下の1つの `.ts` スクリプトと1行の説明に対応付けます（`aidlc-plugin-validate.ts` の `readPluginCommands` が読み手です。`VALIDATE` と `BUILD` は、AI-DLC の名前を含め、不正なエントリを規則 `manifest-commands` のもとで拒否します）。compose はスクリプトをプラグインの他のツールとともにランディングします。`plugin sync` は、プラグインの所有レコードがそのスクリプトを保持する宣言済みのコマンドを、その合成スタンプ（`plugin-compose-<plugin>.json` の `commands`）に書くので、名前がコアや別のプラグインが所有するファイルを実行することは決してありません。`compositionIsCurrent` がそれらを比較するので、このフィールドができる前に合成されたプロジェクトは、次の sync でそれらを記録します。

`aidlc-plugin-commands.ts` の `pluginCommandTable` が、どのコマンドが実行されるかの唯一の所有者です。スタンプ、有効なセット（`pluginsEnabled()`。doctor が使うセット）、プランの名前を読み、プラグインを名前順に取り、AI-DLC 自身のコマンドが使う名前（`aidlc-command.ts` の `CORE_COMMAND_WORDS`）、プランの名前、または先行するプラグインが取った名前を飛ばします。オフのプラグインの空いている名前はオフのまま保たれます。勝者は、インストールされていてオンのものだけに依存し、どの sync が先に実行されたかには決して依存しません。sync は各スキップを一度だけ、両方を名指しする1行で言い（`skippedCommandLine`）、それをスタンプ（`skippedCommands`）に記録するので、後の sync は沈黙を保ちます。doctor はすべてのスキップをパスする行として表示します。

- **端末:** `aidlc <name> [args]`。dispatcher（`aidlc.ts` の `runPluginCommand`）は、自身のランチャーフラグのあとの最初の語を取ります。AI-DLC 自身の語の1つは以前どおり解決されます。名前の前の語だけがプロジェクトを選び（`runtimeProjectDirFrom`）、その後のすべてのトークンは `--json` と `--project-dir` を含めスクリプトのものです。`pluginScriptLaunch` を通じて、人の作業ディレクトリと stdio で、タイムアウトなしにスクリプトを起動し、exit コードをそのまま通します。オフのプラグインの名前は、それをオンにする `config project --plugins` コマンド（一時停止中はそのベース）を伴う1行を表示します。それ以外の語は、以前どおり未知コマンドのエラーです。
- **チャット:** `/aidlc <name> [args]` は変わらず engine に届きます（どのハーネスのスキルもプラグインコマンドを名指ししません）。`readNextLine` は、先頭のテーブル名を、オフのプラグインのものを含め、すべてのコアの先頭形式のあと、`next` 自身のフラグの前に読みます。単独、またはフラグ付き、または1語なら厳密で、`routeNext` が `--doctor` と同じく、エージェントが実行するコマンドを表示します。文が続くときは、engine 自身の名詞と同じく `command` の読み取りステップで、エージェントが人の意図したものを読みます。`isReadOnlyNextArgv` はその行に true（ワークフローの作業なし）を返し、`classifyTerminalCommand` は null を返すので、どのハーネスの継ぎ目もプラグインのコードを帯域外で実行しません。Kiro IDE の1引数の行は、その先頭の語で読まれます。
- **ヘルプ:** `aidlc --help` は、有効なコマンドを `PLUGIN COMMANDS` のもと、プラグインごとに、その説明とともに列挙します。それらを持たないプロジェクトは、持っていたヘルプを得て、engine ライブラリはそれのためにロードされません。
- ホスト自身の権限プロンプトが適用されます。どのプラグインコマンドも、インストールの事前承認リストにはありません。
- プラグインの管理（`aidlc plugin validate|build|test`、およびのちのマーケットプレイスの動詞）と、プラグインコマンドは別物です。`plugin` は AI-DLC 自身の語で、管理の動詞がプラグインのコードを実行することは決してなく、プラグインコマンドがプラグインを管理することも決してありません。

### プラグインの doctor チェック

有効なプラグインは `tools/<plugin>-doctor.ts` を配布できます。`/aidlc --doctor` は、合成されたハーネスのツールディレクトリでそのスクリプトを見つけ、シェルを介さず Bun で直接実行します。このとき `AIDLC_PROJECT_DIR`、`AIDLC_HARNESS_DIR`、`AIDLC_PLUGIN_NAME` が設定されます。ネイティブインストールでは、その Bun は `BUN_BE_BUN=1` で実行される `aidlc` バイナリです。バイナリの隣に配布されるプリロード（`aidlc-plugin-script-preload.ts`）が、スクリプトの実行前にその変数を外すので、スクリプトが実行する `aidlc` コマンドは engine に届きます。起動は1つの関数、`aidlc-plugin-script.ts` の `pluginScriptLaunch` で、プラグインコマンドもこれを使います（下記）。無効なプラグインのスクリプトは不活性のままです。`harness.json` に `plugins` の選択がないときは、インストール済みのすべてのプラグインが対象です。
stage や scope を所有するもの、あるいはその合成が `tools/data/` 配下に sidecar（`plugin-contrib-`、`plugin-owned-`、または `plugin-compose-<plugin>.json`）を残したものです。したがって sensor や overlay だけを配布するプラグインも、合成されれば発見でき、選択できます。

スクリプトは1つの JSON オブジェクトを stdout に書きます。

```json
{
  "checks": [
    {
      "pass": false,
      "label": "required connector is installed",
      "fix": "install the connector and re-run doctor",
      "severity": "error"
    }
  ]
}
```

`severity` のデフォルトは `error` です。失敗した error チェックは doctor を失敗させます。失敗した `advisory` チェックは、exit コードを変えずに表示され、エクスポートされます。パスしたチェックは通常どおり表示されます。doctor はインストール済みのプラグインをコードの信頼境界として扱いますが、失敗を封じ込めます。spawn エラー、タイムアウト（デフォルトは5分。`AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS` を正整数のオーバーライドとして使用）、非ゼロ終了、不正な JSON/形、不正なエントリは、doctor をクラッシュさせる代わりに上限付きの検出になります。出力はプラグインごとに50チェック行、stdout は 256 KiB、label/fix は300文字に上限が設けられます。

コンパイル済みの `stage-graph.json` は、インストール済みの stage のセット全体を永続化します。無効なノードは `"enabled": false` を運び、有効なノードはこのキーを省きます。ランタイムのローダーは無効なノードをフィルターするので、runner、状態行、scope の表、オーケストレーションは、選択されたグラフだけを見ます。`loadStageGraphAll()` は doctor と選択のツール向けに予約されています。stage の番号はグラフ全体から割り当てられるので、プラグインを無効化して後で再有効化しても、正確な番号が保たれます。選択フィルターは stage、scope、runner をカバーします。無効なプラグインの `agents/` と `knowledge/` のファイルはディスクに残り、ロード可能なままです（agent のロスターと knowledge の検索は選択フィルターされません）。それらの agent をディスパッチするはずの stage がフィルターされるので、何かが参照しない限り不活性です。

コンパイル済みの scope グリッドは、有効な scope の同一性だけを含みます。無効なプラグインの scope ファイルはディスクに残りますが、プラグインが再び選択されるまで有効なランタイムの scope ではありません。frontmatter が `freeform_default: true` と言う有効な scope は、混成のものを含むどのインストールでも、まず freeform/default のフォールバックです。そうでなく、コアが無効でプラグイン scope の所有者がちょうど1つ有効な場合、フォールバックはそのプラグインの最初の scope をアルファベット順で使います。複数のプラグイン scope の所有者が有効で、コアの好ましい `classic` フォールバックが利用できない場合、orchestrator はエラーになり、明示的な `--scope` を求めます。

プラグインを無効化すると、自身のファイルだけでなく、コア stage にマージしたものも取り除かれます。compose は、実際に適用した構造的な追加（対象 stage ごとの produces / sensors / `required` と任意の `conditional_on` を含む完全な consume エントリ / scopes / required_sections）と、正常に適用された各フラグメントの anchor/order/hash を、プラグインごとの sidecar（`tools/data/plugin-contrib-<key>.json`）に記録します。継ぎ合わされた散文フラグメントも自身のセンチネルマーカーを運びます。無効化時、`select-plugins` とすべての config のリフレッシュ（`aidlc config project --plugins` を含む）は、自身のロールバックトランザクションの内側で、1つの規則（`stripPluginsTurnedOff()`）を通じて、インストール済みの stage のソースから両方を取り除くので、無効化または一時停止されたプラグインの貢献は、有効な stage を操縦しなくなります。構造的な追加は、1つの strip（`aidlc-plugin.ts` の `stripRecordedAdds()`）を通じて出てきます。これは、オフにされたプラグイン、sync が削除または更新したプラグイン、合成された stage に対する config リフレッシュのチェックが共有します。記録された各値は、compose が書いたとおりに綴られたエントリを、なければ同じ意味の1エントリを取り除くので、stage がすでに持っていた引用符付きの行は残ります。再有効化は、次のセッション開始時に貢献を復元します（compose hook を実行しない Kiro CLI と opencode では、人がプラグインのフォルダを付けて `aidlc engine plugin sync --plugin-root <folder>` を実行したとき）。プラグインの compose が、バイト単位で同一に再マージします。select の行がどれかを言い、保留中のプラグインの行も、1つの規則（`aidlc-plugin.ts` の `nextCompose()`）から言います。保留の行は sync が実行したフォルダを名指しし、どのレコードもフォルダを告げない select の行は `<plugin's folder>` と言います。

compose hook と `select-plugins` は、同じ realpath をキーとするワークスペースロックで計画を直列化します。ライブのプロジェクトの変更は、その後トランザクション engine のルートロックと期待状態のチェックを通じてコミットされます。保護される範囲は、インストール済みの stage の編集、プラグインごとの sidecar、選択の書き込み、グラフ/グリッドのコンパイル、runner/表の生成、監査の検証、ロールバックをカバーするので、同時進行のプラグイン hook が互いの和集合の更新を失うことはできず、無効化が compose と競合して追跡されない貢献をアクティブに残すこともできません。

選択はコンパイル時に閉包チェックされます。有効な stage は、その唯一の producer stage が無効になっているアーティファクトを require できません。エラーは、consume する stage、アーティファクト、無効な producer stage、それらを提供するプラグインを名指しし、それらのプラグインを有効にするか consumer を無効にするよう告げます。これは、そうしなければ飢えた必須入力を持つ stage をルーティングしてしまう、プラグインのみの選択を捕まえます。無効な stage を指す `requires_stage` のエッジはエラーではありません（依存が決して実行されないとき、順序エッジは空虚です。プラグインのみのインストールは、プラグイン stage をコアのもののあとに順序付けるのが正当です）。ただし doctor はそのような drop されたエッジをアドバイザリーとして列挙します。

`select-plugins` は、アクティブなワークフローを取り残す変更も拒否します。実行中のワークフローの scope を所有するプラグイン、またはそのプランの保留中の EXECUTE stage を所有するプラグインの無効化は、各依存を名指しして拒否されます（まずワークフローを完了またはアーカイブしてください。park されたワークフローは再開時に依然としてそのプラグインを必要とするためです。あるいはプラグインを有効のままにしてください）。doctor は、すでに1つを取り残している選択でハードに失敗します。

選択がすでに存在するとき、プラグインの合成はそれを自動で有効にしません。compose hook は依然としてプラグイン自身のファイル（stages、scopes、agents、knowledge、sensors、tools。その stage・scope・runner はランタイムでフィルターされ、agent と knowledge は上記のとおりロード可能なまま）をコピーし、そのプラグインを露出させる select コマンドを名指しするアドバイザリーの drop を記録しますが、無効な間はコア stage のソースに貢献をマージしません。マージされた貢献は選択フィルターをバイパスし、それらをマージするとセッション開始のたびに無効化時の strip を取り消してしまうためです。選択キーがなければ、合成されたプラグインはただちにアクティブで、元の状態を保ちます。drop は、プロジェクトが AI-DLC を実行する方法で select を名指しします（ネイティブなインストールでは `aidlc engine plugin select`、コピーのチャネルでは `bun <harness-dir>/tools/aidlc-utility.ts select-plugins`）。プロジェクトのコピーに合成する `aidlc plugin test` では、select がインストール済みのプラグインだけを受け入れるので、プラグインがそこにインストールされていないときは、drop はまずプロジェクトにそれをインストールするよう言います。

`bundle` は現在、意図的に未使用です。この語は、将来ありうるプラグインの集合の概念のために予約されています。プラグインの所有は常に `plugin:` で表されます。

## 6. 貢献の継ぎ目

**contribution** は、名指しされた既存の stage を加算的に変更するためにプラグインが配布するファイルで、`contributions/<phase>/<slug>.md` にあります。対象を決して編集しません。

```yaml
---
target: build-and-test        # 豊かにされる既存のコア stage
plugin: test-pro
adds:                         # 構造的 — stage ノードに和集合される
  produces:
    - test-pro-regression-suite            # プラグイン名前空間化（§8）
  consumes:
    - artifact: test-pro-testability-requirements
      required: false
  sensors:
    - coverage-threshold
  required_sections:
    - "Branch Coverage"        # 宣言された H2（stage にマージ。まだ機械的には強制されない — §9 を参照）
fragments:                    # 散文 — stage の本体に継ぎ合わされる
  - anchor: after-step:8
    order: 100
---

## fragment: after-step:8

### Step 8a (test-pro): Branch + coverage enrichment
…agent が読む散文。対象 stage の Step 8 のあとに挿入される…
```

`bundle:` は予約で未使用です。プラグインの所有には `plugin:` を書きます。

**マージの意味:**

- **構造的な面** — 対象 stage のソース frontmatter への **和集合** です。可換で、順序に依存せず、調整されていない作者をまたいでも安全です。*現在実装済み:* `produces`、`consumes`（artifact + `required` + `conditional_on`。それぞれ保持）、`sensors`、`scopes`、`requires_stage`、`required_sections`。`adds.scopes` は2つのガードレールを運びます。scope の同一性ファイルがすでにインストールされていなければなりません（`scopes/<name>.md` のない名前は、全 SKIP のファントムとして解決されてしまいます）。そしてそのインストール済みファイルの `plugin:` frontmatter が、貢献するプラグインを正確に名指ししなければなりません。コア stage をコアや他プラグインの scope のもとに置くことは、もう一方の所有者が決して同意していない選択の意味を変えます。所有は、名前の接頭辞の規則ではなく、ファイルの宣言された所有者から来ます（ダッシュの接頭辞はプラグイン名をまたいで重なります。コアの scope は `plugin:` を宣言せず、決してマージしません）。違反するエントリは、マージされずログとともに drop されます。`adds.requires_stage` は順序エッジを和集合します。成り立たないエッジは、マージされずログとともに drop されます。依存は、対象以外のインストール済みの stage（コア、またはすでにディスク上にあるプラグイン stage）でなければならず、コンパイラ自身の規則により対象の前にコンパイルされなければなりません。完全に固定された番号が比較され（接頭辞、次にインデックス）、固定された行はその stage が phase ディレクトリを移っても番号を保ち、固定されていない stage だけがその接頭辞を phase ディレクトリから取ります。同じ compose が追加する stage は固定されておらず、その phase の最大値より後にシードされるので、インストール済みの stage が同じ phase 内でそれを require することはできません（プラグイン stage をコアのものの前に順序付けるのは RFC #1100 です）。2つの新しい同一 phase の stage の間では、サイクルを閉じない限りエッジは成り立ちます。scope がスキップする stage へのエッジは、コア自身の scope をまたぐエッジと全く同じく、そこでは空虚です。記録されたエッジは、すべての compose、ランタイムのリフレッシュ、Cursor の再インストールで再チェックされます。もはや成り立たないものは stage からも contribution の sidecar からも取り除かれ（まだ宣言されているエッジは、成り立てば再びマージされます）、入ってくるランタイムが今や自身で宣言するものはコアに渡されるので、後の無効化がコアのエッジを取り除くことは決してありません。
- **散文フラグメント**（step/question の散文の `fragments`）— 宣言されたアンカーで stage の本体に継ぎ合わされ、`(order, plugin)` で決定論的に順序付けられます。継ぎ合わされた各ブロックは内容ハッシュされたセンチネルで包まれ、その anchor/order/hash は contribution の sidecar に永続化されるので、再合成は冪等で、アップグレードされたフラグメントは以前のブロックを置き換え、散文のみのプラグインは検証可能な来歴を保ち、別々のプラグインのブロックは hook の発火順に関わらず `(order, plugin)` で交互に並びます。agent はランタイムでベースの本体 + 順序付けられたフラグメントを読みます。
- **決して上書きしない。** 貢献は追加だけができます。stage の `lead_agent` を変えたり、`consumes[].required` を緩めたり、フィールドを削除したり、既存の step の散文を置き換えたりはできません。上流の振る舞いを *変える* 本当の必要は、プラグインの中の静かなパッチではなく、フレームワークレベルの判断です。

**フラグメントのアンカー:**

| アンカー | フラグメントを挿入する位置 |
|--------|------------------------|
| `after-step:<n>` | `### Step <n>` の内容の直後（次の見出しの前） |
| `before-step:<n>` | `### Step <n>` の直前 |
| `after-questions` | まだサポートされていない。compose は未知のアンカーとして drop ログに記録する。`after-step:<n>` を使う |
| `end-of-steps` | `## Steps` ブロックの末尾 |
| `in:<Compartment>` | 名指しされた `## <Compartment>` ブロックの末尾 |
| `after-preflight` | ペルソナ: packager が注入する委譲された knowledge のプリフライトの直後 |
| `end-of-body` | 書かれた本体の末尾（レビュアーのペルソナに吸収される knowledge の前） |

**面ごと** — 上流の変更の種類ごとにプラグインが使うもの。「ステータス」は、compose hook が現在マージするものと、設計済みだが先送りされているものを示します。

| 変更 | 仕組み | ステータス |
|--------|-----------|--------|
| stage が新しい質問をする | question の散文の `fragments` | ✅ 実装済み |
| stage が追加のアーティファクトを produce する | `adds.produces` + それを出力する `fragments` の step | ✅ 実装済み |
| stage が新しいセクションを require する | `adds.required_sections` | ✅ マージ済み（⚠️ 宣言的 — まだ機械的に強制されない、§9） |
| stage に検証を追加する | `adds.sensors`（+ マニフェストと `tools/` スクリプトを配布） | ✅ 実装済み |
| consume エッジを追加する | `adds.consumes` | ✅ 実装済み |
| `requires_stage` エッジを追加する | `adds.requires_stage` | ✅ 実装済み（依存は対象の前にコンパイルされなければならない — より小さい完全な固定番号、またはまだ固定されていない stage ならより前の phase。違反はログとともに drop） |
| 既存の stage をプラグイン scope のもとに置く | コア stage への `adds.scopes`（自プラグインの scope のみ。インストール済みの同一性ファイルが必要）。プラグインのベースの stage への、scope の `include_stages:`（セクション7） | ✅ 実装済み |
| ハウスルールや phase ポリシーを注入する | `memory/rules.md`（すべての stage）と `memory/phases/<p>.md`（1つの phase）。各々、すべての space のルールファイルでプラグインが所有する1セクション（セクション7） | 実装済み |
| コアのペルソナを豊かにする（協働の箇条書き、必須のアンカー） | `in:<H2>`・`after-preflight`・`end-of-body` に `fragments` を持つ `contributions/agents/<agent>.md` | ✅ 実装済み（散文のみ。`adds.*` はアドバイザリーの drop で拒否される） |

## 7. メソッド/ルール、agent、knowledge、scope、アクティベーション

このセクションは、新しい stage と貢献の継ぎ目を超えた面を、作者が誤解しないようステータスを明示しながら説明します。

**メソッド/ルール: プラグインのハウスルール。** プラグインは慣行のルールを言葉で配布します。すべての stage 向けの `memory/rules.md` と、1つの phase 向けの `memory/phases/<phase>.md`（ideation、inception、construction、operation）です。そのマニフェストは `rules.md` が属するレベルを `aidlc.rulesLevel`（`org`、`team`、`project`）に名指しします。インストールは、`aidlc engine plugin sync` または `aidlc engine plugin select`（プラグイン名なしだと、select はレベルだけを変えます）の `--rules-level <plugin>=<level>` で別を選べます。質問はなく、無人のインストールはデフォルトを保ちます。選択は `aidlc/plugin-rules/<plugin>.json` に保たれます。プロジェクトに対する1レコードで、その中のすべてのハーネスが読み、チームのクローンが共有します。Plugin sync は各ファイルを、すべての space の対応するルールファイル（`aidlc/spaces/<space>/memory/<level>.md`、`phases/<phase>.md`）の末尾に、プラグインが所有する1セクションとして書きます。`## Rules from the <plugin> plugin` の見出し、stage の貢献が使うフラグメントマーカー、そのセクションがプラグインのものでチーム自身のルールは `team.md` に入ると言う1行、その後ルール、そしてプラグイン自身の見出しは1レベル下げて（決して `###` より上にはしない）書かれます。チームの書き手（practices discovery のセクション書き換え、learning loop の追記）はその見出しで止まるので、その中には決して書きません。その中の手編集は、次の sync で置き換えられます。このセクションは、ファイルの残りとともに、すべての stage で agent に届き、厳密加算が成り立ちます。何も何かを上書きしません。Validate は `## Guard Policy` と、AI-DLC がルールファイルから読む設定フィールド（`Mode`、`Methodology`、`Ordering`）を拒否します。プラグインはルールを配布するのであって、決してロックではありません。プラグインをオフにすると（plugin select または `aidlc config project --plugins`）、そのセクションがすべての space から取り除かれ、そのレベルが保たれます。オンにすると、次の compose（セッション開始、または Kiro CLI と opencode の `plugin sync`）で戻ります。新しい space はそれらとともに始まります。コピーチャネルのリフレッシュは、デフォルト space の `org.md` と phase ファイルを置き換えるので、doctor の Composed plugin surface の行は、次の compose がそれらを再び書くまで、欠けているセクションを名指しします。最初の配置、または移動は、ルールがどこへ行ったかを一度だけ言います。セッション開始からは、その行は agent が話す次のステップを待ちます。doctor のルールドリフトの行は、プラグインのセクションを `(plugin <name>)` と名指しします。

**Agents** *(✅ 射影 + 合成)。* プラグインは新しいペルソナを `agents/<plugin>-<role>-agent.md` のもとで配布し、frontmatter の `name` はファイル名の stem と等しく、`plugin: <plugin>` です。compose はそれらをコアや別のプラグインを上書きせずに `<harness>/agents/` へコピーします。同一のファイルは冪等なスキップで、同じ宛先での異なる内容は drop ログに記録されます。OpenCode では、compose は `mode: subagent`、`permission.task: deny`、OpenCode で有効な model/memory の frontmatter を持つネイティブな `.opencode/agents/` の双子も出力します。Kiro では、compose は `.kiro/agents/` のペルソナからサポートされない `disallowedTools: Task` の行を取り除きます。Kiro のネイティブな agent ツールの設定が、ネストした委譲を利用不可のままにします。異なる `disallowedTools` の値は drop ログに記録され、ペルソナはコピーされません。再 compose は、既存のペルソナを、射影前の composer からの正確で変更のない同一プラグインのコピーであるときにのみ移行させます。編集された、または他所のファイルは上書きしない振る舞いを保ちます。すでに合成されたサポートされない値はそのまま残され、再 compose の前に削除するファイルを名指しする、劣化した診断が付きます。

プラグインは `contributions/agents/<agent>.md`（§6）を通じて **コア** のペルソナを豊かにすることもできます。散文フラグメントだけで、`<harness>/agents/<agent>.md` の `in:<H2>`、`after-preflight`、`end-of-body` に継ぎ合わされ、contribution の sidecar に agent slug のもと記録され、無効化時に stage のフラグメントと全く同じように取り除かれます。同じフラグメントは、ハーネスがペルソナをディスパッチするすべてのファイルに届くので、指示はすべてのハーネスで agent に届きます。Markdown のペルソナ（engine のロスター、および Claude Code・Cursor・Kiro IDE のネイティブ agent。Kiro CLI の agent JSON はそのプロンプトをそれからロードします）に加えて、packager がそれから構築するハーネスネイティブの双子です。Codex の agent TOML の `developer_instructions` 文字列（TOML 用にエスケープされたフラグメントのテキスト）、OpenCode の `.opencode/agents/` と Copilot の `.github/agents/` のネイティブ agent、そして Kiro IDE では、そのツール権限のないペルソナ（`.kiro/aidlc-common/personas/<agent>.md`。stage がインラインで読む agent のために engine のロスターがそこで名指しするファイル）です。doctor はこれらのファイルのそれぞれをチェックし、リフレッシュはフラグメントをそれぞれに再生し、無効化と prune はそれぞれからそれらを取り除きます。

Kiro CLI、Codex、OpenCode では、engine のロスターの Markdown ペルソナは `mode: inline` でのみ利用できます。ネイティブなディスパッチは、ハーネスごとのディスパッチ面も必要とします。Kiro CLI では手書きの agent-v1 JSON に加えて conductor の `trustedAgents` リストへの登録、Codex では agent 設定の TOML（配布される `aidlc-*-agent.toml` の形）、OpenCode ではネイティブな `.opencode/agents/` の subagent ファイルです。`kiro-ide` の行（Kiro IDE と Kiro CLI v3）は代わりにインストール済みの agent Markdown そのものをディスパッチしますが、`tools:` が空でなく、`permissions.rules` が、効果が `allow`・`ask`・`deny` のいずれかである整形式の `capability`/`effect`/`match` エントリの空でないリスト（コア自身のペルソナは3つすべてを運びます）であるときに限ります。空の権限、欠けているまたは空の rules、不正なエントリ、その他のどの効果も拒否されます。したがって compose は、ディスパッチされるトポロジー（lead とサポートに対する `mob`・`pipeline`・`subagent`。モードに関わらずゲートのある stage の `reviewer:`）が、完全なインストール済みのディスパッチ面なしに agent を名指しするプラグイン stage を拒否し、その stage、agent、是正策を compose の drop ログに記録します。Kiro CLI では、JSON と `trustedAgents` の登録は独立にチェックされます。一方だけ持っていても stage は拒否されます。Kiro IDE では、IDE のパスは `aidlc.json` を決して読まず、compose がプラグイン自身の agent にその面そのものを与えます。プラグインが配布する各 agent に、インストールが `.kiro/tools/data/plugin-agent.md` に保持する行（それ自身の役割を持たないペルソナの `tools`・`includeMcpJson`・`permissions`。その shell の deny を含む）のうち、agent が宣言しない各キーを加え、`tools` の行はそれらの権限の横にのみ加えます。インラインでそれを読む lead のために、それらのないペルソナを `.kiro/aidlc-common/personas/<agent>.md` に書き、agent をディスパッチする stage を、自身が書くコピーで判断します。プラグインが配布しない agent は、依然としてそのインストール済みの `.md` が両方のブロックとともに書かれているか、stage が `mode: inline` に変えられている必要があります。Kiro CLI では、同じファイルがペルソナの2つのプロンプト行（`tools`・`includeMcpJson`）を保持し、すべてのプラグイン agent がそれを得ます。その agent-v1 JSON と `trustedAgents` のエントリは手書きのままです。これらの行は、それらを書く AI-DLC で構築されたプラグインに届きます（compose hook はプラグインの中に配布されます）。OpenCode では、プラグインが配布するペルソナは、ネイティブの双子の出力を生き残れるとき（閉じた frontmatter、射影できない `disallowedTools` がない）、面として数えられます。Kiro CLI と Codex の面は常に手書きなので、プラグイン自身のファイルがそれらのチェックを満たすことは決してありません。欠けている面を手書きで書き、compose を再実行すると、stage が受け入れられます。Markdown のペルソナは、それも使う受け入れられたインライン stage のために、合成されたままになります。

`agent-team` はスキーマ上予約されていますがランタイムの消費者がないので、compose はそれを選ぶプラグイン stage を、暗黙にインラインとして扱う代わりに、すべてのハーネスで拒否します。インストール済みの stage パーサーが利用できない場合、Kiro/Codex/OpenCode の compose は fail closed します。明示的な `mode: inline` のスカラーを持ち `reviewer:` のない stage だけが受け入れられます（引用符付きのスカラー形式も認識されます）。上書きしないアップグレードは、古い hook が合成した stage を削除できないので、これらのディスパッチチェックに失敗する既存の stage はディスクに残りますが、是正策を名指しする劣化したヘルス行を出します。

**Knowledge = メソドロジーのみ** *(✅ 射影 + 合成)。* プラグインは agent ごとのメソドロジーの knowledge を `knowledge/<agent-slug>/` に配布し、`<harness>/knowledge/<agent-slug>/` へ合成されます。ドメイン/space の knowledge（`aidlc/spaces/<space>/knowledge/`）は、ブートストラップ時は空のユーザーランタイム状態で、プラグインはそれを配布もシードもしません。

**Scopes** *(✅ 射影 + 合成)。* プラグイン scope の同一性は、`scopes/<plugin>-<name>.md` のもとの1ファイルで、frontmatter の `name` はファイル名の stem と等しく、`plugin: <plugin>` です。compose はそれを上書きせずに `<harness>/scopes/` へコピーします。プラグインが書いた stage でのメンバーシップは、それらの stage の `scopes:` frontmatter を通じて働きます。プラグイン scope は、好ましいコアの `classic` デフォルトが無効なとき自身を推挙するために `freeform_default: true` を設定できます。推挙を要求できる有効な scope は最大1つで、グラフのコンパイルは曖昧な選択セットを拒否します。既存のコア stage へのプラグイン scope の追加は、貢献の `adds.scopes`（§6）を通じて働きます。自プラグインの scope だけで、scope ファイルはマージの前にインストールされていなければなりません。ベース（セクション8）の上に構築されたプラグインは、ベースの stage を自身の scope の `include_stages:` リストに名指しすることで、自身の scope で実行します。コンパイルは各々をその scope の列に加え（stage のコンパイル済みの行がその scope を列挙します）、stage ファイルと他のすべての scope はそのままになります。インストール済みの stage がないインクルードは列から除かれ、コンパイルを失敗させることは決してありません。sync はプラグインを保留し、どの stage が欠けているかを言います（セクション8）。Validate は、そこでのコアまたは自身の stage と、ベースのものになりえない名前（プラグインの stage の slug はその名前で始まり、compose がそれを強制します）を拒否し、ベースのものを `--with` のベースのチェックアウトと照合します。

**アクティベーション（`when:`）** *(⚠️ 解析されるが評価されない)。* stage は構造化された `when:` 述語を運べます。`{producer-in-plan: X}` はスキーマ検証されて解析されますが、**まだどの engine 消費者も評価しません**。`aidlc-graph` が将来の置き場所として自身を名指ししています。したがって `when:` を運ぶ stage は、現在は宣言された scope のもとで無条件に EXECUTE です。プラグイン自身の stage は、プラグインが選択セットにあるときにのみ存在するので、「このプラグインがアクティブか」はすでに compose 時の事実です。

**composer のスクリーニング（`ars:`）。** 適応的な composer の期待値スクリーンは、stage ごとのコスト事前分布を `tools/data/ars-priors.json` から読みます。これはすべてのコア stage だけを名指しするので、プラグイン stage は `aidlc-graph ars` の出力に `no-prior` の行（「スクリーン不可」）として現れていました。プラグイン stage は、同じ4つの事実を自身の frontmatter の `ars:` ブロックで宣言します（`targets` と `cost`、任意の `role` と `project_types`）。stage スキーマ（したがって `aidlc-plugin-validate`）によって検証され、そのグラフノードにそのままコンパイルされ、事前分布ファイルにその slug のエントリがないときはいつでも `ars` サブコマンドが読みます。配布されたエントリが常に勝つので、コアのスクリーニングは変わりません。各スクリーン行は `priorSource`（`shipped` | `stage` | `null`）を運びます。[Stage Definition](15-stage-definition.md) の § `ars` を参照してください。

**`plugin.json` の `aidlc.contributes`。** VALIDATE はこのブロックを読み、未知のキーを拒否し、現在射影されるすべてのサブツリーに正確な正規の値を要求します。BUILD と TEST は同じ検出で停止し、直接の出力は、出力を置き換える前にパスの contract を再び検証します。emitter は依然として、任意のマニフェストパスを通すのではなく、ディレクトリの規約でバイトを発見します。設定可能なルーティングは先送りのままです。`memory` は `memory/` で受け入れられます（セクション7）。`aidlc.lock.json` の読み取りもありません。composer は現在、ロックファイルから何も解決しません。

## 8. マルチテナントのガード

決して調整し合わない独立した作者は、次によって安全に保たれます。

- **名前空間化。** 貢献されたアーティファクトの論理名は `<plugin>-` を接頭辞とします。`core-*` は予約です。プラグインの stage、agent、scope、sensor は、選択セット全体とコアに対して一意であるべきです。プリミティブなファイルの衝突は、上書きせず、帰属とともに drop ログに記録されます（暗黙のシャドウイングはありません）。唯一の例外は、プラグインがインストールして以降変わっていないプラグイン自身のファイルで、再 compose がそれをプラグインの新しいコピーで置き換えます。
- **浅いレイヤリング。** プラグインは、コアと最大1つのベースプラグインの上に構築します。
  それはマニフェストの `dependencies` に `"<plugin>"` または `"<plugin>@<range>"`（npm の範囲文法）として名指しされます。ベースはコアだけの上に構築するので、最長の連鎖はコア、ベース、チームプラグインです。ビルドはプラグイン自身の `.aidlc-plugin/plugin.json` をすべての射影にコピーします（ホストのマニフェストはそれを運べません。Claude Code はそこの `dependencies` キーを、有効にするホストプラグインとして読みます）。validate は2つ目のベース、自己依存、npm が読めない範囲を拒否します。Sync はベースを先に、その後それらの上に構築されたプラグインを合成します。AI-DLC はベースをインストールもフェッチもしません。インストールされた1つのバージョン（プラグインリストのないホストでは、プロジェクトに合成されたバージョン）を読み、ソルバーもロックファイルもありません。ベースがインストールされていない（またはまだプロジェクトにない）、ホストで無効、範囲の外、別のプラグインの上に構築、プラグインの scope がインクルードする stage（`include_stages`、セクション7）を欠く、あるいはマニフェストが2つのベースを名指しするか読めないプラグインは、保留され、決して解決されません。sync は1行を一度だけ言い、`tools/data/plugin-held-<key>.json` を書き、他のすべてのプラグインを合成して exit 0 します（`--json` は `data.held` を列挙します）。`plugin list` と doctor は、sync がそのプラグインを合成してレコードを削除するまでその行を表示します。以前に合成された保留中のプラグインは、素の sync が決して削除しないので、そのままで、その行がそう言います。セッション開始時の hook は自身のプラグインだけを名指しします。sync がプラグインリストを読む Claude Code と Codex では、hook はインストール済みのベースも先に合成するので、ホストの hook の順序は問題になりません。合成スタンプが `base` を記録するので、プラグインリストのないホストも1レベルの規則を保ちます。マニフェストがともに移動する前に構築された射影は、コアだけの上に構築します。
- **決定論的な順序付け。** 1つの非可換な面（散文フラグメント）は、ロード順ではなく、明示的な `(order, plugin)` で順序付けられます。
- **衝突は見える。** 本当に非可換な衝突（同じ stage の同じフラグメントアンカーで同じ順序、満たせないプラグイン間のエッジ、重複したプリミティブのパス）は、オーバーレイの順序で解決されるのではなく、帰属とともに drop または拒否されます。

## 9. 実装: 出力、インストール、具体例

共有のプラグイン emitter は、1つの書かれたルートを1つのホストプラグインへ射影します。`bun scripts/package.ts` は、発見されたファーストパーティの `plugins/<name>/` ルートに対してそれを呼びます。`aidlc-plugin-build.ts` は外部のプラグインリポジトリからそれを呼びます。各射影は、置換の権限を論理的なプラグインと正確なハーネスに束縛する `.aidlc-plugin-projection.json`、加えてホストネイティブなマニフェスト（`.claude-plugin/` / `.codex-plugin/` / Copilot の `.plugin/` / `.kiro-plugin/` / `.opencode-plugin/` / `.cursor-plugin/`）、他の誰かが構築するプラグインのためにホストが1つ読むところ（ホストのマニフェストの横。Codex は `.agents/plugins/marketplace.json` だけを読みます）での自身の `marketplace.json`、compose hook、そしてプラグインの内容（完全な `number`/`plugin`/`when` frontmatter を持つ stage。スキーマはそれらをネイティブに受け入れます）を運びます。有効な一致マーカーのない空でない出力は決してクリーンされません。強制バイパスはありません。Cursor はプラグイン agent の compose 入力を、Cursor が自動発見するルート `agents/` の外、`aidlc/agents/` のもとに保ちます。compose は、ハーネストークンを解決し、名前付きの model ピンを取り除いて、単一のネイティブなコピーをインストール済みの `.cursor/agents/` のロスターへ射影します。compose hook は、**ハーネス非依存** の、単一の可搬な `compose.ts`（bun。GNU 固有のシェルはなし）です。プラグインのルートは `CLAUDE_PLUGIN_ROOT | PLUGIN_ROOT | AIDLC_PLUGIN_ROOT` から解決し、出力された hook の場所にフォールバックします。プロジェクトディレクトリは `CLAUDE_PROJECT_DIR | AIDLC_PROJECT_DIR | PWD` から（Codex はプロジェクトディレクトリの変数を未設定のままにします。PWD がフォールバックです）、ハーネスのリーフは、各ホストコマンドまたは Cursor のランチャーが供給する `AIDLC_HARNESS_DIR` から解決します。Cursor のランチャーはさらに、SessionStart の `workspace_roots` を解析し、AI-DLC の Cursor インストールを運ぶ唯一のルートを選び、`AIDLC_PROJECT_DIR` が1つを選ばない限り、複数の一致するルートを拒否します。新しい stages/scopes/agents/knowledge/sensors/tools を上書きせずにコピーし、継ぎ目を冪等にマージし（内容ハッシュされたセンチネルの継ぎ合わせ、書き込み前の比較）、drop しなければならない貢献（欠けている対象、不正なアンカー、インストール済みの engine が受け入れないキー）を、セッションを失敗させる代わりに、プラグインごとの `<hooksHealthDir>/plugin-compose-<key>.drops` ファイル（コアの hook が書き、`/aidlc --doctor` がスキャンする、space ごとの同じヘルスディレクトリ）に記録します。このリポジトリが配布するプラグインは自身のカタログを運びません。packager は `dist/plugins/` のルートに、ホスト形式ごとに1つの `aidlc-plugins` カタログを書き（Claude Code の `.claude-plugin/`、Codex の `.agents/plugins/`、Copilot の `.plugin/`、Cursor の `.cursor-plugin/`。ストアのない Kiro や npm モジュールをインストールする opencode にはなし）、各プラグインを `./<name>/<harness>` のソースとともに列挙します。リリースのランタイムは同じ `plugins/` フォルダを運ぶので、人はそれを一度追加すればそのどれでもインストールできます。プラグインの stage と scope の runner は、配布される runner と全く同じく、ホストの明示的のみのガード（frontmatter の `disable-model-invocation: true`、または Codex の `agents/openai.yaml`）とともに、ハーネスのスキル発見のルート（`<harness-dir>/skills/`、Copilot の `.github/skills/`、Codex の `.agents/skills/`）にランディングします。インストールされたテスト/フィクスチャのペイロードは、合成するハーネスのリーフをキーとする、ハーネスごとの `plugin-compose-installed-tool-payloads-<harness>.drops` レコードで別個に監査されます。スキャンは、修正されたプラグインの射影がそのパスをもはや含まなくても、そのハーネスのインストール済みツールのツリーを歩くので、あるハーネスでのクリーンな compose が別のハーネスのアドバイザリーを消すことは決してありません。古い compose バージョンはツールファイルの来歴を保存しなかったので、レガシーのファイルは、たまたま次に compose するプラグインに帰属させずに報告されます。sensor マニフェストはコピー時の追加のガードを運びます。発見は `sensors/` をフラットにスキャンし、`aidlc-<id>.md` に一致する basename だけを索引するので、それ以外の名前の（またはサブディレクトリにネストされた）プラグインマニフェストは、合成はされても決して発火しません。compose はそのようなマニフェストを拒否し、ファイルと必要な形を名指しする劣化した drop を記録し、古い compose hook が同じように既にランディングさせたものを次回の実行で報告するので、名前を誤った sensor がディスク上で暗黙に死んでいることは決してありません。

ホストはプラグインをその作者の名前のもとに表示します。このリポジトリが配布するプラグインは AI-DLC 自身のものです。packager は `aidlc-plugins` カタログでそれらを `aidlc-<name>` と名付けます。他の誰かが `aidlc-plugin-build.ts` で構築するプラグインは、マニフェストの `name` をそのホスト名として、`aidlc.marketplace` が名指しするカタログ、またはそのプラグインにちなんで名付けられたカタログで保ちます。`aidlc` と `aidlc-` で始まる名前（どの大文字小文字でも）はそこで拒否されます。2つ目の `aidlc-plugins` カタログは Claude Code で私たちのものを置き換えてしまうためです。射影の中のプラグイン自身のマニフェストが、プラグインの同一性にとって権威的です。compose はそれから `<name>` を読み（古いビルドではホストパッケージ ID の `aidlc-<name>` から）、`plugin:` フィールドが異なる所有された stage、scope、agent、貢献の内容を拒否します。入ってくる scope/agent 名は、各ファイルが受け入れられるときに予約されるので、1つのプラグインツリー内の重複した同一性は、コンパイルの前に drop されます。構造的なリストの比較は、引用符付きと引用符なしの YAML スカラーを正規化します。compose は、トランザクション全体にわたって realpath をキーとするワークスペースロックも保持します。グラフのコンパイルが失敗すると、新しくコピーされたファイルと貢献の書き込みは、リトライマーカーが書かれる前に復元されます。

出力される SessionStart コマンドは、まず `PATH` 上の `aidlc` を探し、利用できるときは `aidlc engine plugin sync` を実行します。それなしだと、hook はプロジェクト自身の `<harness-dir>/tools/aidlc-plugin.ts sync` を Bun で実行するので、コピーのチャネルが同じ合成レコードを保ち、そのツールが欠けているときは直接の bun の `hooks/compose.ts` 呼び出しにフォールバックします（Cursor と Kiro IDE のランチャーは、それが拒否するときにも、古いプロジェクトでも合成できるようにフォールバックします）。

Cursor と Kiro はプラグインの hook をプラットフォームのシェル（Cursor: 人のシェル、または Windows では PowerShell。Kiro: `/bin/sh`、または Windows では cmd.exe）で実行するので、それらの hook は `sh -c` を運びません。Cursor の出力される hook は、Cursor のフラットな camelCase スキーマ（`hooks.sessionStart[].command`）を2つのエントリで使います。`aidlc engine plugin sync --harness-dir .cursor`（Cursor が hook の環境に置くプラグインルートとワークスペースを読む）と、`aidlc` のないインストールのための `bun ./hooks/aidlc-plugin-compose.ts .cursor` です。Cursor は各エントリを独立に起動するので、ランタイムが欠けている方は、もう一方を止めずに失敗します。その Bun ランチャーは `Bun.which` と `process.execPath` を使って `aidlc` を探し、その後プロジェクト自身の sync ツールまたは兄弟の `compose.ts` を実行します。Kiro ではプラグイン全体が自身のフォルダ `.kiro/aidlc-plugins/<name>/` にあるので、同じプロジェクトに配置された2つ目のプラグインが1つ目に重なることは決してありません。Kiro IDE の `v1` SessionStart 登録は、`/bin/sh` と cmd.exe で同じように読まれる1つのコマンドです。`aidlc engine plugin sync --harness-dir .kiro --plugin-root ./.kiro/aidlc-plugins/<name> || bun ./.kiro/aidlc-plugins/<name>/hooks/aidlc-plugin-compose.ts .kiro kiro-ide` です。Kiro は hook にプラグインルートを与えませんが、ワークスペースのルートで実行します。どちらも自身のハーネスを名指しするので、Cursor や Kiro IDE の横に Claude Code がインストールされたプロジェクトは、正しい方に合成します。

**インストール、ホストごと:**

```bash
# まず、無視されるローカルなプラグイン射影を実体化します:
bun scripts/package.ts

# Claude Code（dist/plugins が唯一の aidlc-plugins カタログ。コピーランタイムの
# plugins/ フォルダも同じ。ネイティブなインストールはそれを <install root>/plugins に
# 保ち、インストール・更新・使用・ロールバック時にリフレッシュします。）
/plugin marketplace add <repo-or-path>/dist/plugins   # ネイティブ: <install root>/plugins
/plugin install aidlc-<name>@aidlc-plugins        # SessionStart hook が次のセッションで合成します

# Codex CLI（git リポジトリ内で）
codex plugin marketplace add <repo-or-path>/dist/plugins   # ネイティブ: <install root>/plugins
codex plugin add aidlc-<name>@aidlc-plugins       # 一度きりの hook の信頼を承認します

# Kiro（ストアなし — フォルダ配置してから、composer を明示的に実行します）。
# 配置は射影の .kiro フォルダの1コピー。PLUGIN_ROOT はそれがランディングする
# プラグインのフォルダです（hooks/compose.ts + プラグインの内容を運びます）。
cp -r dist/plugins/<name>/kiro/.kiro <project>/
PLUGIN_ROOT="<project>/.kiro/aidlc-plugins/aidlc-<name>"
AIDLC_PLUGIN_ROOT="$PLUGIN_ROOT" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro aidlc engine plugin sync
# aidlc がインストールされていないときのフォールバック:
AIDLC_PLUGIN_ROOT="$PLUGIN_ROOT" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "$PLUGIN_ROOT/hooks/compose.ts"
```

その後、`/aidlc plugin list`（端末では `aidlc engine plugin list`）と `/aidlc --doctor` が、インストール済みと合成済みのプラグインのバージョンとソースハッシュを比較します。選択の診断は doctor に残り、scope を付けた実行（`/aidlc --scope enterprise`）は、有効なプラグイン stage を、その scope が経路上に置くところへルーティングします。

**具体例 — 混成のフリートにわたる test-pro。** プラットフォームチームは `test-pro` を一度公開します（そのリポジトリを validate し、`aidlc-plugin-build.ts` でサポートされる各ハーネスの射影をビルドし、`aidlc-plugin-test.ts` で各射影を使い捨てのインストール候補に対してテストし、`<plugin>--v<version>` タグをプッシュし、生成されたマーケットプレイスのメタデータを公開します）。Claude チームは `/plugin install`、Codex チームは `codex plugin add`（信頼を一度承認）、Kiro チームは `git pull` + composer の明示的な実行（上記）です。どの場合も、composer は test-pro の2つの新しい stage **と**、`build-and-test`/`nfr-requirements`/`nfr-design`/`performance-validation` への貢献をマージします。同じ豊かな、35 stage（コア 33 に test-pro の2つ）の、doctor でクリーンなインストールです。7つのハーネス射影（Claude、Codex、Cursor、Kiro CLI、Kiro IDE、opencode、GitHub Copilot）すべてにわたって検証されています。

**ステータス。** 実装済みで検証済み: `number`/`name`/`plugin`/`when`/`ars` のスキーマサポート（`aidlc-stage-schema.ts`）。stage が書く composer の事前分布（`ars:` がノードにコンパイルされ、配布される事前分布ファイルが名指ししない slug に対して `aidlc-graph ars` が読む）。書かれた `plugin` の所有を、コンパイル済みの stage ノードへコンパイル側で引き継ぐこと（コアはこのフィールドを省きます）。`harness.json` + `select-plugins` を通じたインストール時の選択。ステージングされた再生成、共有トランザクションの commit/rollback、監査の検証、全グラフの永続化、フィルターされたランタイムのロード、閉包チェック、runner の prune、doctor の行、compose のアドバイザリー drop を含みます。上限付きで fail-loud に実行する、選択を意識した `tools/<plugin>-doctor.ts` チェック。スタンドアロンでオフラインの著述ツール `aidlc-plugin-create.ts`、`aidlc-plugin-validate.ts`、`aidlc-plugin-build.ts`、`aidlc-plugin-test.ts`。決定論的なスキャフォールド、同梱の compose-hook テンプレート、マニフェストから導かれるハーネスのターゲットデータ、正規の貢献パスの検証、プラグイン/ハーネスに束縛された出力マーカーを備えます。それらと同じツールに委譲するトップレベルの `aidlc plugin validate|build|test` のルート。コンパイル済みのバイナリが compose テストの hook とグラフの子を Bun として実行すること。Kiro の現在ルートフォールバックを伴う、証拠に裏打ちされた Claude/Codex のインベントリ。決定論的な合成スタンプ、完全なインストール済み対合成済みの比較器、トランザクショナルな集約 sync、所有が安全な明示的な prune。プラグイン名前空間化された stage/scope runner の生成。共有の packager/スタンドアロンの emitter（発見されたすべてのハーネス射影）。プラグインの `stages/`、`scopes/`、`agents/`、`knowledge/`、`sensors/`、`tools/` に対する射影と上書きしない compose。ハーネス非依存の compose hook（`scripts/plugin-hooks-template/compose.ts`）。再利用可能な `tests/harness/plugin-kit.ts` のビルド、共有の compose サブプロセス/drop の読み取り、委譲された内容検証、ライブ呼び出しのヘルパー。`produces` / `consumes` / `sensors` / `scopes`（自プラグイン、インストール済みファイルでガード）/ `requires_stage`（順序でガード、compose・リフレッシュ・Cursor の再インストール時に再チェック）/ `required_sections` + 散文フラグメント（内容ハッシュ、冪等、順序が決定論的）のための貢献の継ぎ目。`tests/unit/t242-plugin-state.test.ts`（インベントリのフィクスチャ、ハッシュ、比較器、ロールバック、prune）、`tests/integration/t188-plugin-compose.serial.test.ts`（compose の仕組み）、`tests/integration/t224-plugin-selection.test.ts`（選択）、`tests/integration/t300-plugin-kit.test.ts`（再利用可能なキット）、`tests/integration/t327-plugin-author-routes.test.ts`（トップレベルの著述ルート）、`tests/unit/t-native-plugin-test.test.ts`（ネイティブなインストールでの `aidlc plugin test`）、`tests/unit/t314-plugin-validate.test.ts`（オフラインのバリデーター）、`tests/unit/t315-plugin-build.test.ts`（隔離されたバイト同一性のビルダー）、`tests/unit/t316-plugin-test.test.ts`（隔離された候補の compose 階層）、`tests/unit/t317-plugin-create.test.ts`（隔離されたツールチェーン全体のスキャフォールド）、`tests/unit/t313-plugin-doctor-checks.test.ts`（doctor runner）、`tests/unit/t354-plugin-dependencies.test.ts`（ベースを先に、保留の行、任意の順の hook）、そして各プラグイン自身の `tests/`（内容。integration tier に配線）によってガードされています。トップレベルの `aidlc plugin create` ルートは RFC #723 section 2e に先送りされたままで、`aidlc-plugin-test --dist` はサポートされません。**先送り / まだ未配線:** プラグインの `memory/` サブツリーの射影/マージと、設定可能な `aidlc.contributes` のルーティング。`when:` 述語の評価（解析済み、engine 消費者なし）。マージされた `required_sections` の機械的な強制（このフィールドはマージ + 検証されますが、コンパイル済みノードには届かず、配布される required-sections sensor はその期待をテンプレートから導くので、宣言されたセクションが欠けても stage を失敗させるものはまだありません）。`after-questions` のフラグメントアンカー（`locateAnchor` にはそのケースがなく、「unknown anchor」を drop ログに記録します。`after-step:<n>` を使ってください）。そしてロックファイルの読み取り（ベースプラグインのバージョンはインストールされたものから読みます。§8）です。新しい slug の番号シードはエッジを意識します。最初のコンパイルは、各 phase の新しい stage のバッチを、それら自身の `requires_stage` のエッジで順序付け（同点は書かれた `number:` のヒント、次に slug で決着）、その順に次の空き連番のインデックスを割り当てます。engine がすべての number の値を所有し（作者は何も要求しないので、調整されていないプラグインが衝突することはできません）、複数 stage のプラグインのサブ DAG はファイル名に関わらずフロー順でシードされ、すでに固定された行はその JSON の値を保ちます。書かれた `name:` が新しい slug の表示名をシードします。

## 10. 不変条件

- **コアは不変。** どのプラグインも `core/` を決して編集しません。
- **加算のみ。** 貢献は追加します。決して上書きも削除もしません。
- **オフのとき不活性。** すべてのプラグインを無効にすると、ワークフローは素のコアとして実行されます。プラグインの stage と scope はフィルターされ、マージされた貢献は取り除かれ、プラグインのファイルは再有効化のためにインストールされたままです。
- **1つの composer、ホストがトリガー。** 同じコードがどこで実行されても合成します。中央で事前ビルドされる唯一のアーティファクトは素のコアです。
- **プラグインは1つのホストプラグインそのもの。** packager は、ホストのネイティブなコマンドを通じてインストールされる、実際の `.claude-plugin/` / `.codex-plugin/` / Copilot の `.plugin/` / `.kiro-plugin/` / `.opencode-plugin/` / `.cursor-plugin/` のマニフェストを出力します。AIDLC は配布インフラを運用しません。
- **slug が同一性、number は表示専用。** プラグイン stage の挿入がコアの番号を振り直すことは決してありません。
- **信頼はホストネイティブ。** 組織の制限はホストの管理された許可リストを使います。AIDLC は信頼レイヤーを構築しません。
- **ゲートキーピングなし。** ファーストパーティとサードパーティのプラグインは機構的に同等です。来歴だけが違いです。

## 相互参照

- [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md) — 作者向けのウォークスルー（フィクスチャを端から端まで構築）。
- [Stage Definition](15-stage-definition.md) — `plugin`/`number`/`when`/`ars` を含む、stage の frontmatter の contract。
- [Artifact Vocabulary](16-artifact-vocabulary.md) — 論理名の名前空間化。
- [Engine and Skill System](17-skill-system.md) — composer が供給し orchestrator がルーティングの基にするコンパイル済みのグラフ。
- [`examples/test-pro/`](examples/test-pro/) 配下の設定ドキュメントの例（`marketplace.json`、`managed-settings.json`、`aidlc.lock.json`）。合成のタイミングの証拠と、順序付けられたビルドの履歴は、このリポジトリの git ログに保存されています。

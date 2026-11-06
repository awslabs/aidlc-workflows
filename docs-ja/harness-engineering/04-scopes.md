# Scopes

スコープは、ある種類の作業についてフレームワークの 33 ステージの*どれ*を実行し、どれを外すかを決めるダイヤルです。バグ修正に市場調査や環境のプロビジョニングは要りませんが、デプロイのパイプラインと実行のステージは走ります。規制のあるエンタープライズ機能には、ライフサイクル全体が要ります。ユーザーがステージを選ぶ手間を省くため、AI-DLC は 11 の名前付きスコープを出荷します。それぞれが全ステージ集合に対する EXECUTE/SKIP の判定を精選したもので、深さ・テスト戦略・任意のレビュー上限といったワークフローの既定と対になっています。スコープを選べば、残りが連鎖して決まります。

ハーネスエンジニアにとって、スコープは純粋なデータで、他のあらゆるプリミティブと同じようにファイルとして書かれます。2 つの半分からなります。1 つの `core/scopes/aidlc-<name>.md` ファイル（その身元、ルーティングのメタデータ、ワークフローの既定）と、ステージごとの所属タグ（各ステージのフロントマターの `scopes:` 一覧が、それが実行されるスコープを指定します）です。スコープの追加や調整に TypeScript は要りません。この章ではワークフローをたどります。スコープが何からできているか、チームスコープをどう加えるか、既存のものをどう調整するか、そしてツールが何を確かめ、何をあなたに残すかです。

ユースケースと、ユーザーが読むルーティング表を含む 11 スコープの完全なカタログは、ユーザーガイドの[Scopes, Depth, and Test Strategy](../guide/05-scopes-and-depth.md)を参照してください。この章は同じデータのオーサリング側です。

---

## スコープが何からできているか

スコープは 2 つの場所に書かれ、その分割こそが考え方のすべてです。スコープの*身元*はそれ自身のファイルに置かれ、その*所属*（どのステージがその下で実行されるか）は転置されてステージ側に置かれます。

**1. スコープファイル — `core/scopes/aidlc-<name>.md`。** スコープごとに 1 ファイルで、`core/sensors/` を映します。`feature` スコープのフロントマターはこう見えます。

```yaml
---
name: feature
depth: Standard
keywords: []
description: Full lifecycle for new features, practical depth
skeleton: on
runner: true
guard_policy: off
sensors: on
learnings: on
summary_confirmation: on
plan_approval: on
collaborators: off
---

# feature scope

The full-lifecycle scope for new feature work at practical depth. ...
```

スコープのフロントマターのフィールドはこれです。

| フィールド | 必須 | 何をするか |
|-------|----------|--------------|
| `name` | はい | スコープ名。core ファイルは `aidlc-<name>.md` を使い、プラグインのスコープファイルは `name` に等しい語幹を使う。 |
| `depth` | はい | 既定の詳細度。`Minimal`、`Standard`、`Comprehensive`。 |
| `testStrategy` | いいえ | 深さと独立にテスト量を上書きする。既定は `depth` に合わせる。 |
| `review_cap` | いいえ | このスコープでのレビュークラスの上限。`adversarial`、`advisory`、`none`。無いとスコープレベルの引き下げなし。上限はステージの `review_class` を下げられても上げられない。作業ごとの `--review` レベルは、その作業について上限を置き換える。自律スウォームのレビューはステージの宣言クラスを保つ。 |
| `keywords` | いいえ | `/aidlc <freeform text>` のプランを提案するときエージェントが読むヒント語（ツールは照合しない）。平坦な文字列一覧はブロック形式（`- item`）またはフロー形式（`[item, item]`）を使える。空一覧はオプトアウト。 |
| `description` | いいえ | `/aidlc --help` に描かれる 1 行説明。（orchestrator スキルの横の `tables.md` にあるコンパイル済みスコープ表は Scope / Depth / TestStrategy / EXECUTE / Total だけを示し、説明は載せない。） |
| `skeleton` | いいえ | `on` は、実践がスコープ依存のとき、スコープを walking-skeleton の儀式に参加させる。`off` または無しはオプトアウト。 |
| `existing_code` | いいえ | `true` はすでに存在するコードを変えるスコープを表し、合うものがあれば新規プロジェクトのカスタムプランが別のスコープで実行される。`false` または無しは、そのスコープが新規作業にも合うことを意味する。他の値は拒否される。 |
| `runner` | いいえ | `true` は既定で生成されるスコープランナーの集合にスコープを含める。 |
| `freeform_default` | いいえ | `true` は、推奨の core 既定（`classic`）が有効でないとき、選択を意識したフォールバックとしてこのスコープを指名する。 |
| `include_stages` | いいえ | プラグインスコープ専用。プラグインが土台とする 1 つのベースプラグインのステージのうち、このスコープが実行するものを、ブロックまたはフロー一覧で（`[acme-1-intent-capture, acme-3-code-generation]`）。コンパイルはそれぞれをこのスコープの列に置き、ステージと他のスコープはそのまま。プラグイン自身のステージは `scopes:` 一覧で、core ステージはコントリビューションの `adds.scopes` で加わるので、validate はここでどちらも拒否する。[プラグインの作成](10-authoring-a-plugin.md)を参照。 |
| `guard_policy` | いいえ | スコープの Guard Policy の既定。`strict`、`relaxed`、`off`。このスコープの作業でガードがどこまで退くか。人間が何かを承認・確認した後に入力が変わったとき何が起きるか（strict は承認を再開し、relaxed と off は変更を 1 度記録して人間に 1 行で伝え、続行する。プラン承認後に動いたワークスペースのソースは、どの値でも記録して続行する）と、どの権限フェンスが保たれるか（strict は何も下げず、relaxed は `plan-approval` と `review-freeze` を下げ、off はその 2 つに加えて `state-transition` と `reviewer-scope` を下げる。`human-presence` はこの語で下がらない）を決める。無しは off を意味するので、strict を望むプラグインや合成スコープはそれを宣言する。出荷の既定は `enterprise` で strict、他は off。メモリ層の `## Guard Policy` 節（`Mode: strict`）はあらゆるスコープ既定と intent ごとの切り替えに勝ち、その `Mode: relaxed` または `Mode: off` はスコープ既定を置き換える。[Guard Policy](../guide/13-customization.md#guard-policy)を参照。`change_control` は退役した綴りで、1 リリースだけ読まれる。両方のキーを異なる値で指定するファイルは拒否される。 |
| `sensors` | いいえ | `on` または `off`。センサーの実行とセンサーゲートの検査を制御する。無しは on。intent ごとの上書き: `/aidlc --sensors on\|off`。全体のキルスイッチ: `AIDLC_DISABLE_SENSORS=1`。 |
| `learnings` | いいえ | `on` または `off`。ステージ学習の読み書きの儀式を制御する。無しは on。intent ごとの上書き: `/aidlc --learnings on\|off`。全体のキルスイッチ: `AIDLC_DISABLE_LEARNINGS=1`。 |
| `summary_confirmation` | いいえ | `on` または `off`。ステージ承認ではなく、別個の出力前の要約確認を制御する。無しは on。intent ごとの上書き: `/aidlc --summary-confirmation on\|off`。全体のキルスイッチ: `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`。このスコープのスカラーは、ステージの `required` / `if-present` 宣言とは別物。 |
| `plan_approval` | いいえ | `on` または `off`。Code Generation がビルドする前に、各コードプランを承認するよう人に尋ねるか。`off` は、それを指す 1 行の後にプランを書かれたとおりにビルドし、`PLAN_APPROVAL_SKIPPED` を記録する。その 1 行は、いつでもプランを確認するよう頼めると人に伝える。無しは on。出荷の既定は `express` と `poc` で off、他は on。intent ごとの上書き: `/aidlc --plan-approval on\|off`。off にできるのは人だけ。全体のキルスイッチ: `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1`。`Mode: strict` を持つメモリの `## Guard Policy` 節は、このキーに勝って on を保ち、キルスイッチはそのロックに勝つ。[Plan approval](../guide/13-customization.md#plan-approval)を参照。 |
| `collaborators` | いいえ | `on` または `off`。ステージがサポートエージェント（collaborators）付きで実行されるか、リードだけで実行されるか。`off` はエンジンに各ステージへ空の実効 `support_agents` を渡させるので、どのトポロジーでもリードが単独で実行される。互いに見えない subagent スポークも、mob ラウンドもなく、pipeline のリードはその唯一で最後のリンクになる（連鎖が本来分けるはずのアーティファクトを書く）。ステージの書かれた `support_agents` 一覧はそのままなので、再び on にすると全員のアンサンブルが戻る。レビュアーの仕組みは独立で、影響を受けない。無しは on。出荷の既定は `enterprise` で on、他の 10 で off なので、初回は無駄がなく、チームは意図して collaborators を再び有効にする。intent ごとの上書き: `/aidlc --collaborators on\|off`。全体のキルスイッチ: `AIDLC_DISABLE_COLLABORATORS=1`。 |

ローダーはファイルにまたがる重複したスコープの `name` 値を拒否し、エラーで両方のファイルを示します。無効な儀式の値はファイル・キー・2 つの許される値とともに拒否されます。解決はキルスイッチ（`1`）→ 有効な intent 行 → スコープ既定 → on の順です。出荷されるスコープはすべて、既定に頼らず 5 つの儀式キーを明示的に宣言します。classic は sensors、learnings、plan approval を on、summary confirmation を off と宣言し、bugfix は sensors と plan approval を on、learnings と summary confirmation を off と宣言し、express はその 4 つすべてを off と宣言し、poc は plan approval を off、他の 3 つを on と宣言し、他の 7 つはその 4 つを on と宣言します。`collaborators` は `enterprise` でだけ on で、他のスコープでは off です。classic のゲート付きフローはレビューを 1 回の advisory パスに制限し、walking-skeleton の儀式を無効にします。一方、明示的な自律は単一のマージ前レビューを保ちます。

Express は sensors、learnings、summary confirmation を off にします。intent ごとに
[`/aidlc --sensors on|off`](../guide/12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls)、
[`/aidlc --learnings on|off`](../guide/12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls)、
[`/aidlc --summary-confirmation on|off`](../guide/12-cli-commands.md#aidlc-sensors-learnings-summary-confirmation-ceremony-controls)
で上書きします。

### Freeform default

`freeform_default: true` は、プラグイン選択の後に内部の `classic` 既定が使えないとき、使われるスコープをインストールに指名させます。この指名は唯一有効なプラグインのフォールバックより先に検査されるので、複数のスコープを持つプラグインは、アルファベット順で最初のスコープを受け入れる代わりに、自分の無駄のない既定を選べます。

**有効な**スコープのうち `freeform_default: true` を宣言できるのは、多くとも 1 つです。選択された core/plugin の集合が複数を含むと、グラフのコンパイルが失敗し、すべての主張者を示します。無効なプラグインの主張は、それらが一緒に有効になるまで衝突しません。このフィールドは明示的な打ち間違いを直しません。未知の `AWS_AIDLC_DEFAULT_SCOPE` の値は、やはり検証に失敗します。

### Walking-skeleton default

任意の `skeleton:` フィールドは、スコープ依存の walking-skeleton の姿勢を制御します。`skeleton: on` は、チームの `## Walking Skeleton` の実践が `scope-dependent` に解決されるとき、このスコープについて Construction が walking-skeleton の儀式で始まることを意味します。`skeleton: off` は、最初の Bolt が通常の Bolt として実行されることを意味します。無しは off が既定なので、合成/実行時承認のスコープとプラグインスコープは、明示的にオプトインしない限り、スケルトンの Bolt を生み出しません。

### 既存コードのためのスコープ

任意の `existing_code: true` フィールドは、すでに存在するコードを変えるスコープを表します（`bugfix`、`refactor`、`security-patch` がこれを出荷します）。合うものがあれば、composer が新規プロジェクトに合わせて仕立てたプランはそのようなスコープで実行されず、新規作業が修正として記録されません。そして、Reverse Engineering を落とす新規プロジェクトとしてスキャンされるフォルダでそのスコープの作業を作ると、そのスコープはふつう既存コードを対象にするという注記が表示されます。無しは、そのスコープが新規作業にも合うことを意味します。

### Guard Policy default

任意の `guard_policy:` フィールドは、このスコープの新しい intent が始まる値で、作成時にその状態ファイルに `- **Guard Policy**: <value> (from scope <name>)` と書かれます。人はその 1 つの intent について、`/aidlc --guard-policy <value>` とタイプするか自分の言葉で頼むことで変えられます。どちらでもエージェントが setter を実行し、`relaxed` や `off` に下げるには、前回の決定以降の人からのメッセージが要ります。この行を持たない古い intent は、明示的に設定されるまで strict のままで、次の新しい intent はまたスコープ既定から始まります。リポジトリの全員に 1 つの値を保つには、11 のスコープファイルを編集しないでください。メモリに 1 度宣言します（`aidlc/spaces/<space>/memory/org.md`、`team.md`、`project.md` の `## Guard Policy` に `Mode: strict`）。メモリの `strict` はあらゆるスコープ既定に勝ち、ファイルを示してチャットやフラグの切り替えを拒否します。メモリの `relaxed` または `off`（それを宣言する最も狭い層）はスコープから来た値を置き換え、人が 1 つの intent について設定した値は残ります。節が無いか空なら何も変わりません。3 つの値以外に対する検証エラーは、ファイルと許される値を示します。intent ごとのコマンドが無効な状態行を直します。

スコープの語は、この種類の作業がどれだけの儀式に値するかについての製品の言明です。それは唯一の制御ではありません。人は 1 つの作業について、切り替え可能な 4 つのフェンスの 1 つを `/aidlc config set guard.<fence> off` で下げられます。これは `Guards Off` の状態行と 1 つの `GUARD_DISABLED` 監査行を書きます。`on` を設定すると、ポリシーが下げたフェンスを上げられ、`Guards On` と `GUARD_RESTORED` を書きます。Guard Policy の語を設定すると、それに反する行が消えます。`off` は `Guards On` を消し、`strict` は `Guards Off` を消し、`relaxed` はどちらも消しません。Human presence は鍵の持ち手で、作業ごとの切り替えはありません。`AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` だけがそれを下げます。環境のキルスイッチは、マシン全体の上書きのままです。スコープで `off` を宣言するのは、その上のすべての作業がその 4 つのフェンスを下げて実行されるべきときだけにしてください。`enterprise` を除く出荷スコープがそうしています。たまにしか出会わないフェンスから人を救うには、作業ごとの切り替えを使ってください。次の作業は自分のスコープ既定から始まります。

`change_control:` はこのキーの退役した綴りです。1 リリースだけ読まれ、決して書かれません。両方のキーを同じ値で指定するスコープファイルは受け入れられ、異なる値で指定するものは、ファイルと両方の値を示して拒否されます。

**2. 所属タグ — 各ステージの `scopes:` フロントマター。** ステージは、`core/aidlc-common/stages/<phase>/<slug>.md` の自分のフロントマターで、それが実行されるスコープを指定します。

```yaml
scopes:
  - enterprise
  - feature
  - mvp
```

スコープを指定するステージは、その下で `EXECUTE` です。無しは `SKIP` です。パッケージングは各ステージの `scopes:` 一覧を、`<harness-dir>/tools/data/scope-grid.json` のコンパイル済み EXECUTE/SKIP グリッドに*転置*します。このグリッドはランタイムが読む、無視される生成投影で、手で編集もコミットもしません。3 つの initialization ステージはすべてのスコープを指定します（常に実行されます）。

その転置は*書かれた*スコープの仕組みで、この章が扱うのはそれです。合成プランから実行時に保存されたスコープ（`scope save`）は、それを宣言するステージを持たないので、転置できません。その持続的な定義はユーザー自身のツリーの `aidlc/scopes/<name>.md` に置かれ、コンパイルがそれをハーネスグリッドに投影します。あなたはそれらを書かず、それらはこのワークフローの一部ではありません。[保存されたスコープがどこに保管されるか](../guide/05-scopes-and-depth.md#where-a-saved-scope-is-stored)を参照してください。人が保存しない合成プランは、スコープをまったく書きません。ストックのスコープで実行され、自身のステージ変更はその作業の状態に記録されます。

理解する価値のある唯一の判断は、`depth` と `testStrategy` の関係です。深さは各ステージのアーティファクトがどれだけ詳細を運ぶかを制御し、テスト戦略はいくつテストが生成されるかを制御します。これらは意図的に独立しています。たいていの出荷スコープは `testStrategy` を off のままにして `depth` から継承します。`classic` は Standard/Standard、`express` は Minimal/Minimal です。`workshop` は Standard の深さと Minimal のテストで、明示的な分割を示します。スコープで分割したいなら、両方を宣言します。各レベルの意味は、ユーザーガイドの[3 つの深さレベル](../guide/05-scopes-and-depth.md#the-3-depth-levels)と[3 つのテスト戦略レベル](../guide/05-scopes-and-depth.md#the-3-test-strategy-levels)を参照してください。

フィールドごとの網羅的な契約は、開発者リファレンスの[コントリビューション: スコープの追加](../reference/11-contributing.md#adding-a-scope)に置かれています。`keywords` はプランを提案するときエージェントが読むヒントにすぎません。どのツールもそれをリクエストに照合しません。この章は判断を要約し、その節が規範的な仕様です。

---

## スコープはステージとどう関係するか

スコープとステージは互いを反対の端から指し、両方の向きを視野に収めておくと助かります。

**ステージ**は自分の身元を宣言します。そのフェーズ、リードエージェント、消費・生成するアーティファクト、そしていまは実行されるスコープ（その `scopes:` 一覧）です。**スコープ**は、その身元、ルーティングのメタデータ、ワークフローの既定を自分の `.md` ファイルで宣言し、その中にステージごとの所属はありません。所属はステージ側に置かれます。両者を結ぶのはスコープ名です。新しいステージを加えるとき（[ステージの追加](02-adding-a-stage.md)を参照）、スコープの所属を*そのステージに*置きます。その `scopes:` 一覧が、それを実行すべきスコープをすべて指定します。どのスコープも指定しないステージは、どこでも `SKIP` です。コンパイル時の転置が、それらのステージごとの一覧をグリッドに変えるので、所属は 11 の別々のスコープブロックで再宣言されるのではなく、ステージに 1 度だけ書かれます。

唯一の例外はプラグインスコープの `include_stages` で、これはそれが土台とするベースプラグインのステージを指定します。そのプラグインが編集できないファイルです。

その分離は、このガイドの残りが乗っているのと同じデータ対コードの線です（[ハーネスエンジニアガイド](00-overview.md)を参照）。スコープファイルは*身元*についてのデータ、ステージの `scopes:` 一覧は*所属*についてのデータ、コンパイル済みグリッドはその 2 つの転置です。

---

## チームスコープの追加

チームが `hotfix` スコープを望むとします。`bugfix` より無駄がなく、回帰テストとデプロイだけが欲しい緊急の本番パッチ向けです。変更は、新しいスコープファイル、実行すべき各ステージの `scopes:` タグ、そして再生成されたローカル投影です。下の規律を映してください。検証のステップと完全なコマンド行は[コントリビューション § スコープの追加](../reference/11-contributing.md#adding-a-scope)にあります。

### ステップ

1. **`core/scopes/aidlc-hotfix.md` を置く。** `aidlc-bugfix.md`（最も近い既存のスコープ）をコピーし、フロントマターを編集します。`name: hotfix` を設定し、`depth` を選び、freeform テキストのプランを提案するときエージェントが読むヒントとして `keywords` を加え（`[hotfix, urgent]`）、ヘルプテキスト用の `description`、スコープ依存の Construction 儀式の既定のための `skeleton: on|off` を加え、hotfix はすでに存在するコードを変えるので `aidlc-bugfix.md` から `existing_code: true` を保ち、このインストールの唯一のフォールバック指名であるときだけ `freeform_default: true`、`depth` と分かれるべきときだけ `testStrategy`、スコープがステージのレビューを下げるべきときだけ `review_cap` を加えます。意図を説明する短い散文の本文を書きます。
   `sensors`、`learnings`、`summary_confirmation` を `off` にするのは、スコープが省くべき儀式についてだけです。無いキーは on のままです。intent の上書きと全体のキルスイッチは上の表を使います。

2. **`hotfix` の下で実行すべきステージにタグを付ける。** `EXECUTE` にしたい各ステージで（`core/aidlc-common/stages/<phase>/` の下）、そのフロントマターの `scopes:` 一覧に `hotfix` を加えます。タグを付けないステージはそのスコープで `SKIP` です。3 つの initialization ステージはそれを含まなければなりません（常に実行されます）。

3. **再生成する。** `bun scripts/package.ts` を実行して、`scope-grid.json` とコンパイル済みスコープ表を含む、無視されるハーネス投影を作り直します。`bun scripts/package.ts --check` を実行して、2 つの独立したソースのみのビルドがバイト同一であることを確かめます。

4. **スコープが解決され受け入れられることを確かめる。** `/aidlc --doctor` を実行します。次に、新しいスコープでの init が正しい `Scope:` 行を持つ状態ファイルを生成し、環境既定として、そしてワークフロー途中の `--scope` 変更として受け入れられることを確かめます。

5. **プランのヒントを確認する**（`keywords` を埋めたときだけ。エージェントはプラン提案のステップでそれを読み、どのツールも照合しません）。freeform のフレーズに対するプラン提案のステップが、あなたのスコープをそのヒント付きで並べ、エージェントがそれを提案できることを確かめます。

6. **スコープを意識したドキュメントを更新し、ルーティングテストを加える。** いくつかのドキュメントがスコープを手で数えます。ユーザーガイドのスコープリファレンスとルーティング表、customization の章の有効値一覧、orchestrator リファレンスのスコープ対ステージのマッピングです。同じ変更で更新します。あなたのスコープが、既存のどのスコープも使わないパターンでステージを飛ばすなら、既存のスコープごとのテストを手本にワークフローテストを加えます。

7. **（任意）タイプ可能なランナーを生成する。** スコープは、そのファイルが着地した瞬間から `/aidlc --scope <name>` で十分に使えます。ランナーは要りません。1 語のコマンド（`/aidlc-hotfix`）が欲しいなら、スコープのフロントマターに `runner: true` を加え、`aidlc engine gen runner-scopes` を実行します。`aidlc engine gen runner-scopes --all` は、そのフラグに関わらず、すべてのスコープファイルについて `skills/aidlc-<scope>/SKILL.md` を発行します。各ランナーは、スコープを焼き込んだ `aidlc-orchestrate next --scope <name>` を `done` まで駆動する薄いシェルに、`/aidlc` orchestrator が持つのと同じ認識・提案（`AskUserQuestion`、決して自動作成しない）・`next --new-intent --scope <name>` の案内を運ぶ "Starting unrelated new work?" 節を加えたものです。ランナーはすでに実行可能なスコープをパッケージし、スコープファイルがその定義です。`hooks:` ブロックは運びません。決定論的な背骨（監査、センサー、rebuild-stage-graph、状態検証）は `settings.json` でプロジェクト全体に登録されているので、どのランナーもそれを無償で継承します。スコープファイルを加えたり改名したりするたびに、ジェネレーター（または `aidlc engine gen runner-scopes --check`）を再実行します。

### 何が自動で検証されるか

この実装は、実行時に `.claude/scopes/*.md` の存在から `validScopes()` を通じて有効スコープの一覧を導くので、ファイルが着地した瞬間に多くが収まります。

- スコープは一度にどこでも有効です。`init`、`--scope` 変更、環境既定の解決、`doctor` はすべて同じヘルパーを参照するので、どれもコード編集を要しません。
- エラーメッセージは、変更なしにあなたのスコープをアルファベット順で並べます。
- `keywords` を与えたなら、フロントマターの一覧が埋まった瞬間に、freeform な `/aidlc <text>` 向けにエージェントが読むプラン提案のステップのヒントとして現れます。SKILL.md の散文編集はなく、表の再生成だけです。
- パッケージングは常に現在のステージ YAML からグリッドを導くので、古いローカルの生成バイトはリリースの入力になりません。

### 何が自動で検証されないか

- **打ち間違えたスコープ名の `scopes:` タグもパースされます。** `hotfix` でなく `hotfx` を指定したステージのフロントマターはきれいにコンパイルされ、誰も求めないグリッドの列を作るだけです。落とし穴は、`validScopes()` が `.md` ファイルから導くので、ファイルのないスコープは呼び出し時に拒否されますが、ステージの打ち間違えたタグは、そのステージを本当のスコープから静かに落とすことです。`/aidlc --doctor` とスコープごとのテストがその防護柵です。
- **古いローカル投影は手作業の点検を誤らせます。** ステージの `scopes:` を編集しても、古い無視される `dist/` ツリーを使い続けると、そのローカルランタイムには古いグリッドが残ります。ローカルランタイムの点検の前に再生成します。CI とリリースの組み立ては常にソースから作り直します。
- **スコープごとのフェーズ列カバレッジ。** 出荷されるフェーズ列テストは、既知のスコープ名のハードコードされた一覧を反復します。新しいスコープは、その一覧を拡張するまでそれで検査されません。同じ変更でそれに加えてください。
- **手で保つドキュメント。** ユーザーガイドのステージ対スコープのマトリクスとスコープルーティング表は、コンパイル済みグリッドに対して検査されます（`t244-scope-matrix-doc-sync`）。だから新しいスコープは、その列と行がそこにあるまでそのテストに失敗します。残りは何も検査しない散文で、customization の章の有効値一覧やスコープの説明などです。スコープファイルと歩調を合わせるのは自分でやってください。

---

## 既存スコープの調整

調整はより小さな編集ですが、スコープではなくステージに着地します。2 つの変更がよく出てきます。

- **ステージを出し入れする。** ステージの `scopes:` 一覧にスコープ名を加えるか取り除きます。これは、たとえば、チームが最初の試作でも常に監視を配線するので `observability-setup` の `scopes:` に `mvp` を加える、というときのやり方です。1 つのタグを付け、`bun scripts/package.ts` で再生成し、`--doctor` を実行します。
- **既定の深さ、テスト戦略、レビュー上限を変える。** スコープの `core/scopes/aidlc-<name>.md` フロントマターで、`depth` を調整し、`testStrategy` を足し引きし、`review_cap` を足し引きします。最初の 2 つはアーティファクトとテストの量を調整し直し、`review_cap` はステージのレビュークラスを `adversarial`、`advisory`、`none` に下げます（決して上げません）。各スコープが自分の既定を運ぶので、変更はそのスコープを選ぶすべてのワークフローに適用されます。実行ごとの `--depth`、`--test-strategy`、`--review` は、対応する振る舞いをさらに下げられます。
- **儀式の既定を変える。** スコープファイルで `sensors`、`learnings`、`summary_confirmation`、`plan_approval`、`collaborators` を `on` または `off` に設定します。既存の intent 行はその選択を保ちます。スコープ変更はスコープ由来の行をリフレッシュしますが、intent ごとの上書きは保ちます。尋ねずに各コードプランをビルドする `plan_approval: off` と、各ステージをリードだけで実行する `collaborators: off` を除けば、どの儀式スイッチも、ステージ承認、人間のターン権限、監査、チーム書き込み保護、レビュアーを取り除きません。

どちらにせよ、上のステップ 3 の再生成と doctor の対が適用されます。編集は小さく、検証は同じです。

層についての注記。出荷スコープの調整は、フレームワークが出荷するファイルを直接編集します。ステージの `scopes:` タグや出荷された `core/scopes/aidlc-*.md` です。異なる既定を望むフォークにはそれで正当ですが、`aidlc-` の血統を運ぶファイルを変えていて、フレームワークのアップグレードがそれらを調整したがるかもしれないことは意識してください。出荷される 11 の横に真新しいスコープファイルを加えるのは、他の全員が頼る既定に触れずにチーム固有の振る舞いを望むときの、よりきれいな道です。

---

## 次へ

[Rules and the Learning Loop](05-rules-and-the-loop.md) — すべてのワークフローに入っていく常設の決定を書き、ループに 1 回限りの修正を持続的なルールへ昇格させます。

`.claude/scopes/` のファイルがワークフローの訪れるステージをどう駆動するか、そしてジェネレーターがそれをどうタイプ可能な `/aidlc-<scope>` スキルに変えるかという、規範的なスコープの形とランナーの契約は、開発者リファレンスの[Skill System 5 節（スコープの形）と 4 節（ランナー）](../reference/17-skill-system.md)を参照してください。

# ルールシステム

> 対象読者: Tier 2/3（チーム導入者、フレームワーク貢献者）。

この章は、ルールシステムのスキーマレベルのリファレンスです。ルールファイルがどこに置かれるか、スコープがどう導出されるか、継承チェーンがどう解決されるか、どのフロントマターフィールドが有効かを扱います。リゾルバ（`aidlc-graph.ts compile`）と doctor のルールドリフト検査が照合する仕様でもあります。ルールは制御ループのフィードフォワード側の半分です。[Sensor System](07-sensor-system.md) は、ルールと組み合わさる決定的検証側の半分を扱います。利用者向けのウォークスルー、つまり学習ループの儀式、銀行業務のワークサンプル、確定した学習がどうルールファイルへ着地するかについては、User Guide の [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) を参照してください。

## レイアウト

ルールは、アクティブスペースのメモリ層 `aidlc/spaces/<active-space>/memory/` に置かれます（ワークスペースルートに手で編集できる一式があり、各ハーネスはそれぞれのネイティブなインクルード経由で読み込みます。Claude の `@`-import スタブ、Kiro CLI のエージェントリソース、メモリテキストを運ぶ Kiro IDE の常時インクルード steering、Codex ではエンジンのステップ単位ルール配信、Cursor の常時適用 `.cursor/rules/aidlc.mdc` ルール、opencode の `instructions` グロブ、Copilot `AGENTS.md` の `@`-import）。ファイル名はスコープを表す中立的なものです。

```
aidlc/spaces/<active-space>/memory/
├── org.md
├── team.md
├── project.md
└── phases/
    ├── ideation.md
    ├── inception.md
    ├── construction.md
    └── operation.md
```

このレイアウトは、チームが書くハーネス設定（以前は別の practices 名前空間にあったもの）と、自己学習ガードレール（以前は 2 階層だったもの）を、`aidlc/spaces/<active-space>/memory/` という単一のアクティブスペースメモリディレクトリに統合します。

## ファイル名から導出するスコープ

ルールファイルは `scope:` フロントマターフィールドを**持ちません**。スコープはファイル名から導出されます。

| ファイル名のパターン | スコープ |
|---|---|
| `org.md` | `org` |
| `team.md` | `team` |
| `project.md` | `project` |
| `phases/<phase>.md` | `phase`（phase 値 = ファイル名） |

org、team、project、phase のルールは、パスをスコープ付けするフロントマターを持ちません。pull 方式のオーサリングは、その関係をステージ側に置きます。org / team / project は、ファイル名由来の普遍的な既定値として、すべてのステージに適用されます。一致する phase ルールが付くのは、ステージのフロントマターの `phase: <name>` フィールドが `phases/<name>.md` の pull インポートになっているからです。

## 5 層の継承

ルールは、ワークフロー開始時に 5 層のチェーンで解決されます。

```
org → team → project → phase → stage
```

org はフレームワークの既定値を運びます。team と project の層は、チームが確認した内容とプロジェクト固有の内容で拡張します。phase は直交しています。ステージがフロントマターですでに `phase: <name>` を宣言しているため、一致する `phases/<name>.md` ルールが付きます（`requires_stage` や `consumes` と同じオーサリング方向です）。stage ルールは将来利用のために予約されています。オーサリングされると、各 `aidlc-stage-<slug>.md` がステージの `slug:` 宣言経由で付きます。このチェーンが実装する、より広い 2 軸の設定モデルについては [01-architecture.md § Configuration layers](01-architecture.md) を相互参照してください。

コンパイル出力（`stage-graph.json` のステージ単位 `rules_in_context` フィールド）は、解決済みのチェーンを各ステージノードに焼き込みます。ランタイムはチェーンを一切たどりません。解決はコンパイルが受け持ちます。

## 厳格加算型のランタイムモデル

適用されるすべてのルールが `rules_in_context` に現れます。org、team、project のルールは連結され、ランタイムでは何も脱落しません。phase ルールは、そのルールのファイル名がステージの `phase:` 宣言と一致したときに付きます。グロブフィルタも、具体パスの合成もありません。エンジンは、アクティブスペースから実質的な各ルールファイルを読み、その HTML コメントブロック（出荷テンプレートが編集者向けに残すメモ）を除いたテキストを、ステージの `run-stage` に収まるとき（ほとんどのハーネスのほとんどのステージ）は `rules_content` として送ります。収まらないときは、テキストがまず 1 個以上の上限付き `load-steering` ディレクティブ経由で届きます（ディレクティブ予算が小さい Copilot のほとんどのステージ）。チャットが以前のステップからこの同一バンドルをすでに保持しているときは、`run-stage` がそれを `rules_held` として名指しし、テキストは運びません。継続トークンは、アクティブインテントの gitignore された `.aidlc-*` ランタイム状態下、あるいはインテントが存在する前はクローンローカルのセッションランタイム下にある、ランダムでマシンローカルな秘密鍵で鍵付けした整合性 MAC を運びます。トークンはステージ、ワークフロー状態、ルールバンドル、ルート、次パートを結び付け、公開プロジェクトパスからは再署名できません。新しい `next` は、必要になったときに遅延して鍵を発行します。サイズを基準にしたパスのフォールバックはありません。空のテンプレートは脱落し、読めない、または不正な必須ルールは修復ガイダンスとともに停止します。`default` 以外で、フレームワークの phase ルールファイルの 1 つを欠くスペース（`space create` がそれらをコピーする前に作られたスペースはこれを持ちません）には、ステージが必要とするときにフレームワークのコピーが与えられ、既にあるファイルを上書きすることはありません。配信はステージごとに繰り返されるので、ワークフローの途中で受け入れた学習は次のステージに届きます。

§13 の Learnings Ritual は、学習がリゾルバに届く前に、メモリゲートでオーケストレーターに競合（より狭いスコープが、より広いポリシーに矛盾すること）の選別を依頼します。検査はセクションレベルです。提案された日付付き学習エントリが `memory/project.md`（または `memory/team.md`）に書き込まれようとするとき、オーケストレーターは LLM 検査で `memory/org.md` の一致する見出しと比較します。競合が見つかると、ユーザーは**修正、スキップ、エスカレーション**のいずれかを選びます（上書きの道はありません）。競合のないもの、またはユーザーがエスカレーションした選択だけが `aidlc-learnings.ts persist` に届きます。これは `org.md` を読まず、比較を独自に判定しません。したがってこの検査は、監査の補助であって、決定的な強制の境界ではありません。practices-discovery の確認ゲートはもう 1 つの受け入れゲートですが、その昇格は、ユーザーの確認で正当化される決定的なセクション置換（`aidlc-state.ts practices-promote`）であり、自動の org 競合検査は走りません。書き込み後の org と team/project 内容のドリフトは、doctor のルールドリフト行（後述）で別途可視化されます。

この設計は、以前の `enforcement: enforced` キーワードと `overrides:` ブロックのモデルを置き換えます。両方のキーワードはスキーマから削除されました。フロントマターのパースは、以下の未知キー方針のもとでそれらを許容します。エラーにならず通過し、リゾルバは無視します。

doctor のルールドリフト検査は、要求に応じて書き込み後のドリフトを可視化します。org ルールが、team や project 内容がすでにディスクに着地した後に変わったとき、doctor は、team/project の実務ファイル（`memory/team.md`、`memory/project.md`）が、*内容のある* org 見出しと共有している `##` 見出しを決定的に見つけ、重複ごとに勧告候補として可視化します（ファイル、セクション、引用した org の一文を `Rule drift: N team/project rule(s) overlap org policy (review for contradiction)` として描画）。stale なファイルからの重複は、そのライブカウントから除かれ、`Rule drift: N stale-suppressed` として別途報告されます。doctor 自体は LLM を一切走らせません。検出はバイト単位で再現可能な見出し／文字列処理です。矛盾の判定、つまり受け入れゲートが走らせるのと同じセクションレベルの LLM 検査は、消費側オーケストレーターが観測時に行う、ブロックしない処理です。その後、人間が、可視化されたドリフトを修正、エスカレーション、または受け入れます。

## `pairing:` フィールド

ルールは、`.claude/sensors/aidlc-*.md` の決定的センサーと**組み合わせてもかまいません**。

```yaml
---
pairing: aidlc-required-sections
---
# or
pairing: feedforward-only
---
```

有効な値:

- `feedforward-only` — ルールにセンサーの相方がないという明示的な宣言です（フレームワークは決定的に検証できません）。
- `aidlc-<sensor-id>` — センサーのマニフェストファイルの語幹です。たとえば `id:` が `required-sections` のセンサーに対しては `pairing: aidlc-required-sections` です。`aidlc-` で始まらない他の値は、ルールの読み込み時に拒否されます。doctor は照合前にプレフィックスを剥がします。

doctor のペアリング済みカバレッジ行は、ペアリング済みと feedforward-only のルールを数え、ペアリングされていないルールをカバレッジの穴として可視化します（[Rule-drift detection](#rule-drift-detection) を参照）。

## ライフサイクルフィールド

すべてのルールファイルは、ファイルレベルのライフサイクルメタデータを宣言**してもかまいません**。

```yaml
---
status: active
stale_after: 2026-12-31
---
```

- `status` は `active`、`deprecated`、`draft` のいずれかだけを受け付けます。`deprecated` はファイルを stale にします。`active` と `draft` はしません。
- `stale_after` は `YYYY-MM-DD` 形式の実在するカレンダー日付でなければなりません。ファイルが stale になるのは、現在の UTC 日付がその値より厳密に大きいときだけなので、`stale_after` の当日自体はライブのままです。
- ライフサイクルは、個々の見出しではなくファイル全体に適用されます。stale な team/project ファイルの org 見出しとの重複は、ライブのルールドリフトカウントから、別の `stale-suppressed` 行へ移ります。

両フィールドとも任意で、不正な値はルールの読み込みを停止し、ファイルを名指しするエラーになります。org、team、project、phase のルールファイルで有効ですが、Tier-1 の決定的な消費側は、意図的に `/aidlc --doctor` での team/project 重複の抑制だけに限定されています。ライフサイクルメタデータは、厳格加算型のランタイムバンドルからルールを除去しません。

## ルールドリフトの検出

`/aidlc --doctor` は、ルール／センサーの状態を観測する勧告行を 2 つ出します。どちらも読み取り専用で、見つかったものは通過します。どちらの判定もヘルスチェックの終了コードを変えません。走れなかった検査（ルールファイルの読み込みや検証に失敗）は `Rule drift: check failed` または `Paired sensor coverage: check failed` と表示され、エラーを名指しして失敗します。doctor はコールドセーフです。ペアリング済みカバレッジ検査が出す `GUARDRAIL_LOADED` 監査行は、監査シャードがすでに存在するときだけ書かれます。インテントがまだない新しいシェルでは、doctor は行を表示しますが、何も出さず、ファイルも作りません。

- **Rule drift** — team/project の実務ファイル（`memory/team.md`、`memory/project.md`）ごとに、doctor は `memory/org.md` の*内容のある*見出しの下にも現れる `##` 見出しを見つけ、重複ごとに候補ペアとして可視化します（ファイル、セクション、org の最初の一文をそのまま引用）。org 本体が空の見出し（たとえば HTML コメントしか持たないフレームワーク既定の `## Forbidden`、`## Mandated`、`## Corrections`）は数えません。重複は両側に内容を持つ必要があります。ライブの重複は、既存の review-for-contradiction 行に描画されます。ライフサイクルが stale なファイルからの重複は、同じインライン詳細で、別の `Rule drift: N stale-suppressed` 勧告行に描画されます。各行のカウント N は、*構造上の*候補ペア数であって、LLM が確認した矛盾の数ではありません。doctor は決定的に検出し、矛盾の判定はオーケストレーター LLM が観測時に行います（[strict-additive section](#strict-additive-runtime-model) を参照）。
- **Paired sensor coverage**: `pairing: aidlc-<sensor-id>` を持つルールごとに、doctor は `aidlc-` プレフィックスを剥がし、名指しされたセンサーが少なくとも 1 つのステージの解決済みセンサー集合（`sensors_applicable`）に存在することを確認します。行は `Paired sensor coverage: P/(M-X) guardrails paired (X feedforward-only)` と表示されます。M は `pairing:` 値を持つルール数、X は feedforward-only のルール数（センサーを一切必要としません）、P は名指しされたセンサーが解決するルール数です。ペアリングされていないルール（センサー id が名指しされているが、どのステージも結び付けていないもの）はインラインで列挙されます。これは**ファイル存在の検査であって、意味的な検査ではありません**。結び付きが解決することを確認するのであって、センサーがルールに合うことを確認するのではありません。この行は、初期化済みプロジェクトで実行ごとに 1 回 `GUARDRAIL_LOADED` 監査イベントを出します（監査シャードのない手付かずのプロジェクトでは出力が抑制されます。上のコールドセーフ注記を参照）。

## 前方互換の方針

ルールフロントマターは、加算的な拡張によって前方互換です。

- 新しいフィールドは加算的に着地します。既存のルール行を書き直す必要はありません。
- 消費側は未知のフロントマターキーを許容**しなければなりません**（無視して通過させる）。これが、レガシーな `enforcement:` / `overrides:` キー（ユーザー拡張のオーバーレイにあれば）がエラーなく読み込まれる仕組みです。
- ルール本体の慣習（`## Forbidden`、`## Mandated` のようなセクション）は、既存のガードレールの慣習に従います。
- Learnings Ritual（メモリゲート）は、確定した各学習を、スペースメモリファイル（`memory/project.md`（既定）と `memory/team.md`（ワンクリック昇格。org スコープへの書き込みはなし））に、日記見出しのトピック下の日付付きエントリとして、実務として直接書き込みます。確定した学習は実務*そのもの*です。これらは practices-discovery が確認するのと同じファイルであって、別の `*-learnings.md` 面ではありません。リゾルバは、クリーンな整数チェーン `SCOPE_PRIORITY`（org:0、team:1、project:2、phase:3）でそれらを並べます。1.5 / 2.5 のような分数階層はありません。オーケストレーターは、上の `## Strict-additive runtime model` で説明した受け入れ競合検査（提案された単一の日付付きエントリ対 `memory/org.md` の一致セクション。修正 / スキップ / エスカレーション、上書きの道なし）を行い、その後 `aidlc-learnings.ts persist` が、その比較を再実行せずに受け取った選択を書き込みます。

## 次のステップ

- **センサー** — ルールが `pairing:` で組み合わせられる決定的な半分です。[Sensor System](07-sensor-system.md) を参照してください。
- **コンパイルの境界** — `rules_in_context` がワークフロー開始時に一度解決され、ワークフローを通じてグラフノードから読まれる仕組みです。[Plane Architecture](02-plane-architecture.md) を参照してください。
- **実務での学習ループ** — `memory.md` の日記、承認ゲートの儀式、銀行業務のワークサンプルです。User Guide の [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) を参照してください。
- **2 軸の設定モデル** — この 5 層チェーンが実装する、より広いルーティング原則です。[Architecture § Configuration layers](01-architecture.md) を参照してください。

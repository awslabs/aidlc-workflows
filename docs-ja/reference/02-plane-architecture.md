# プレーンアーキテクチャ

> 対象読者: Tier 2/3（チームの採用者、フレームワークの貢献者）。

この章では、AI-DLC の 3 プレーンアーキテクチャ、つまり control、data、management
という関心の分離と、それらを結ぶコンパイル境界を説明します。関連として
[Sensor System](07-sensor-system.md)（control プレーンの sensor マニフェスト）、
[Rule System](08-rule-system.md)（control プレーンの rule ファイル）、
[State Machine](12-state-machine.md)（data プレーンのライフサイクル）を参照してください。これは
設計の基盤です。sensor と rule のマニフェストは、その基盤が操作するソースファイルです。

---

## 1. 問題

AI-DLC には、rule、sensor、そしてワークフロー実行中に観測を捕らえて次回に自動で発火する場所へ
書き込む learning ループがあります。その土台のモデルには実際の複雑さがあります。複数の種類の
stage ごとのインポート、ファイル名で付与される universal-default の rule、sensor マニフェスト、
hook のチェーンです。顧客がフレームワークを使うのにそのすべてを学ばなくてよいようにすべきで、
フレームワークもホットパスでルックアップコストを払うべきではありません。

正しい枠組みは「設計を単純にする」ことでは *ありません*。それは *「このようなシステムにすでに
存在する規律を借りる」* ことです。現代のネットワーキングの 3 プレーンアーキテクチャが最も近い
類例で、その教訓はほぼそのまま転用できます。

---

## 2. ネットワーキングの類例

現代のルータ（または SDN コントローラ）は、その仕事を 3 つのプレーンに分けます。

- **management プレーン** — SNMP、syslog、ダッシュボード、NETCONF、gRPC、CLI。設定を入れ、
  可観測性を出します。人間のケイデンス（一度設定し、ときどき照会する）です。
- **control プレーン** — BGP、OSPF、IS-IS、経路計算。トポロジーが与えられたら、各パケットが
  どの経路を取るべきか決めます。トポロジーのケイデンス（秒から分）です。
- **data プレーン** — flow テーブル、ACL、ASIC のフォワーディング。テーブルルックアップにより、
  このパケットを今、ナノ秒で転送します。ラインレートです。

盗む価値のある 5 つの教訓があります。

### フィルタ評価がパケットレートで起きることはない

OSPF は、トポロジーが変わったときに最短経路を一度だけ計算します。その結果は data プレーンの
flow テーブルにインストールされます。以後のすべてのパケットはテーブルルックアップで、ナノ秒、
決定的、フィルタのロジックなしです。賢い仕事は *パケット時* ではなく *トポロジー変更時* に
起きます。

### プレーンのインターフェースは明示的

OpenFlow、P4、NETCONF、gRPC です。control プレーンは data プレーンのメモリに手を伸ばしません。
「この flow をインストールせよ」と告げる構造化メッセージを送ります。data プレーンが確認します。
これにより失敗モードが診断可能になります。拒否されたインストールは明確なシグナルであり、静かな
取りこぼしではありません。

### 失敗がきれいに分離する

control プレーンがクラッシュしても、data プレーンは最後にインストールされた rule を使って転送を
続けます。data プレーンが失敗すれば、control プレーンはハートビートで気づき、失敗を迂回して
再ルーティングします。どちらのプレーンももう一方を道連れにしないことが、荷重を支える性質です。

### テレメトリがループを閉じる

data プレーンは flow の統計、ドロップ、レイテンシを報告します。control プレーンはテレメトリを消費し、
判断します。輻輳を迂回して再ルーティングする、サービスをスケールする、ピアを down と印すなどです。
*data プレーンが報告し返すから、control プレーンは賢くなります。*

### 3 つのプレーン、3 つのケイデンス

management プレーンは人間のケイデンスで動きます。control プレーンはトポロジーのケイデンスで動きます。
data プレーンはラインレートで動きます。各プレーンは、その仕事が許すなら遅くてよいのです。

---

## 3. AI-DLC への対応づけ

その対応づけは、聞こえるよりも近いものです。（以下の `<record>/` = アクティブな intent の record
ディレクトリ `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`。監査証跡は `<record>/audit/` 配下の
clone ごとの shard のディレクトリです。）

| ネットワーキング | AI-DLC の類例 |
|---|---|
| control プレーン（BGP、OSPF、経路計算） | stage 定義、rule、sensor — 何が実行されるべきかのスキーマ |
| data プレーン（パケット転送、flow テーブル） | stage の実行、Bolt、agent の呼び出し — 実際の実行 |
| management プレーン（SNMP、ダッシュボード、CLI） | `/aidlc --doctor`、designer（将来）、監査クエリ、`CLAUDE.md` |
| ルーティングプロトコル（BGP / OSPF） | コンパイル: `aidlc-graph.ts compile` が stage frontmatter + rule + sensor を読み、各 stage の pull インポートをソースレジストリに対して解決し、グラフを出力する |
| ASIC にロードされた FIB（forwarding information base） | コンパイル時に解決された、stage ごとの `rules_in_context` + `sensors_applicable` を持つ `stage-graph.json` |
| OpenFlow / NETCONF（インターフェース） | `stage-graph.json` — コンパイルと orchestrator の間の明示的なインターフェース |
| テレメトリ（NetFlow、sFlow） | 監査ログ、sensor の発火、memory.md のエントリ → intent の `runtime-graph.json` |
| リアクティブな flow インストール（PACKET_IN） | learning ループ: data プレーンが観測を報告 → ユーザーが確認 → rule/sensor へのファイル書き込みと、新しい sensor バインディングが捕らえられたときの発生元 stage の frontmatter 編集 |
| プロアクティブな経路インストール（BGP アドバタイズ） | フレームワークの PR: どのワークフローが実行される前にも新しい stage/rule/sensor を出荷する |
| トポロジー変更 -> 経路の再計算 | パッケージ、インストール、または再設定（`graph compile`、保存された scope、プラグインの選択や compose）-> コンパイルが現在のソースファイルを読む |
| パケット飛行中も安定したプリインストール済み FIB | ワークフロー中の learning ループの書き込みは、進行中のコンパイル済み選択を変えない。選択されたファイルの rule テキストは各 stage 配信で読み直され、新しいファイルと sensor バインディングは次のコンパイルを待つ（§4 参照） |
| テーブルルックアップによるラインレートの転送 | orchestrator + dispatcher が、グラフノードから事前解決済みのフィールドを読む。runtime で解決の walk はない |

`stage-graph.json` のプレーンラベルと runtime の読み取りパターンは、FIB/ルートテーブル/CLI の
分離を映しています。設定は management プレーンから入ります。control プレーンがそれをコンパイルし、
data プレーンがルックアップで実行します。

---

## 4. コンパイル境界

荷重を支える洞察はこうです。ネットワーキングは、フィルタ評価や継承の walk をパケットレートに
置きません。そこではその仕事が高すぎるからです。control プレーンが一度計算して FIB にインストール
し、data プレーンがルックアップで転送します。AI-DLC は同じパターンに従います。フレームワークが
パッケージまたはインストールされるとき、またはその入力が変わるとき（`aidlc engine graph compile`、
保存された scope、プラグインの選択、プラグインの compose）に一度コンパイルし、解決済みのビューを
すべてのワークフローを通して読みます。

### 何がコンパイルされ、何がディスクに残るか

| 状態 | ライフサイクル | ディスク上のソース | コンパイル先 | 読み手 |
|---|---|---|---|---|
| stage DAG、scope ルーティング、アーティファクト生成 | フレームワークでバージョン管理（フレームワーク PR で変わる） | stage frontmatter（`.claude/aidlc-common/stages/*.md`） | `stage-graph.json` | orchestrator、doctor、designer |
| **Rules**（散文、規範的） | 可変。フレームワーク PR または learning ループの書き込み | `aidlc/spaces/<space>/memory/<scope>.md`（ファイル名由来。org/team/project はすべての stage に付与。コンパイル済みパスは `default` を指し、配信はアクティブ space を読む） | `stage-graph.json` のノードごとの `rules_in_context` | orchestrator（解決済みビュー）。Claude Code の自動ロードは、コンテキスト内の散文のためにソースを読む |
| **Sensors**（マニフェスト、検証チェック） | 可変。フレームワーク PR または learning ループの書き込み（マニフェストは一度記述し、stage は id でインポート） | `.claude/sensors/aidlc-<id>.md` | `stage-graph.json` のノードごとの `sensors_applicable` | dispatcher が stage 入場時に解決済みの一覧を読む。PostToolUse がそこから発火する |
| ワークフロー実行のテレメトリ | ワークフローごと、累積 | `audit/` の shard · `memory.md` · Bolt の fork | `<record>/runtime-graph.json` | doctor、gate の儀式、将来のワークフロー横断オブザーバ |
| stage ごとの観測ログ | stage の実行ごと | `<record>/<phase>/<stage>/memory.md`（Unit ごとの stage: `<record>/construction/<unit>/<stage>/memory.md`） | （コンパイルなし — 直接読む） | この stage の gate での gate の儀式 |

住み処の異なる 2 つのコンパイル済みアーティファクトです。`stage-graph.json` は、ハーネスの
`tools/data/` にあり、プロジェクトのすべてのワークフローに供し、解決済みの control プレーンビューを
運びます。stage DAG、scope ルーティング、アーティファクト生成、加えて継承を事前解決した stage ごとの
rule と sensor の一覧です。`runtime-graph.json` は各 intent の record にあり、transition クラスの監査
イベントごとに再コンパイルされます（監査ログの完全なイベントソーシングの walk です）。ディスク上の
ソースファイルが記述の表層で、コンパイル済みのグラフが runtime の読むものです。

### どのワークフローの前にも一度コンパイル

コンパイルは、stage frontmatter を読み、`aidlc/spaces/default/memory/` を walk し（rule 配信はその後
各ファイルをアクティブ space から読む）、`.claude/sensors/` を walk し、universal-default の rule を
ファイル名で付与し（`org.md`、`team.md`、`project.md` はすべての stage に適用）、その後各 stage の
pull インポートをソースレジストリに対してルックアップします。

- stage の `phase: <name>` フィールドが、対応する `phases/<name>.md` の rule を付与します（stage
  ごとに rule 1 つ）。[Rule System](08-rule-system.md) を参照してください。
- stage の `sensors: [<id>, ...]` の一覧が、各 id を `.claude/sensors/` に対して解決します。未知の
  id はコンパイルを声高に失敗させます。stage が、インポートした何かの発火に静かに失敗することは
  できません。[Sensor System](07-sensor-system.md) を参照してください。

コンパイルは、各 stage ノードに答えを焼き込んだ `stage-graph.json` を出力します。ワークフローを
通して、orchestrator と dispatcher はそれら事前解決済みのフィールドを読みます。ワークフロー中の
learning ループの書き込みはソースファイルを更新しますが、進行中のコンパイル済み選択は変えません。
選択された rule ファイルのテキストは各 stage 配信の前に新しく読まれるため、承認された learning は
同じワークフローの次 stage に届きます。まったく新しい rule ファイルや Sensor バインディングは、次の
グラフコンパイルで選択に入ります。BGP がパケット飛行中に経路を再計算しないのと同じ形です。トポロジー
（選択）は安定し、ペイロード（rule テキスト）はライブで読まれます。

### ロックされ、アトミック

コンパイルが初日から対処しなければならない 2 つの失敗モードがあります。この実装の swarm モードの
Bolt 向けの worktree は、ほとんどの場合、並列 agent の状態を分離しますが、`data/stage-graph.json` は
worktree スコープを越えてリポジトリ全体で共有されます。しかもユーザーは同じチェックアウトに対して
2 つのターミナルで `/aidlc` を起動できるため、いずれにせよコンパイルには防御が必要です。

- **並行コンパイル** は `data/stage-graph.json` への書き込みで競合します。コンパイルは
  `withAuditLock`（`aidlc-locks.ts` 内）の下で実行されるため、並行呼び出しは直列化されます。
  2 番目は 1 番目の完了を待ち、その後新しいソース状態に対して実行されます。
- **書き込み途中のクラッシュ。** 書き込み途中で中断されたコンパイルは、consumer に無効な JSON を
  読ませてはなりません。コンパイルは一時ファイルに書き、出力を検証し、その後 POSIX `rename(2)` で
  アトミックに rename します。reader は、前回のコンパイルの出力か新しいものかのどちらかを見ます。
  書き込みが半分のファイルを見ることはありません。

どちらのパターンも、state と audit の作業のためにすでにコードベースにあります。コンパイルはそれらを
継承します。

### 2 つのグラフ、2 つのライフサイクル

2 つのコンパイル済みアーティファクトは、異なる consumer と異なる更新ケイデンスを持ちます。

- **`stage-graph.json`** - control プレーン。フレームワークがパッケージまたはインストールされるとき、
  あるいはその入力が変わるときにコンパイルされます。インストールが再設定されない限り
  （`aidlc engine graph compile`、保存された scope、プラグイン選択の変更。いずれもこれを再コンパイル
  します）、ワークフローの実行中は安定です。orchestrator（DAG のトポロジー、scope ルーティング）、
  dispatcher（stage ごとの `sensors_applicable`）が読みます。Claude Code の自動ロードは、散文の
  コンテキストのためにソースの rule ファイルを並行して消費します。
- **`runtime-graph.json`** — data プレーン。`<record>/runtime-graph.json` にあるワークフローごとの
  アーティファクトです。transition クラスの監査イベントごとに再コンパイル（監査ログの完全な
  イベントソーシングの walk）されます。実行テレメトリを集約します。どの stage が実行されたか、どの
  Bolt が fork したか、どの sensor が発火したか、どの memory.md ファイルが存在するかです。gate の
  儀式（候補を浮上させる）、doctor（実行の健全性）、将来のワークフロー横断オブザーバが読みます。
  スキーマ、コンパイルのライフサイクル、復旧モデルについては [Runtime Graph](13-runtime-graph.md)
  を参照してください。

両者を混ぜるとキャッシュ可能性の境界を破ります。`stage-graph.json` はワークフローの生存期間を通して
キャッシュされたいのに対し、`runtime-graph.json` はイベントごとに変化します。同じアーティファクトに
すると、data プレーンが sensor の発火を報告するたびに control プレーン全体を再発行することになります。

### なぜ rule と sensor が同じコンパイルを流れるのか

コンパイルは、すべての control プレーン入力にわたって対称です。stage frontmatter、rule ファイル、
sensor ファイルはいずれもコンパイル時に `aidlc-graph.ts` が読み、すべてが解決済みの stage ごとの
ビューに寄与します。ネットワーキングもこれを行います。BGP と OSPF は同じ FIB に送り込み、ACL と
ポリシーは同じ flow テーブルに送り込みます。1 つのコンパイル済みビュー、複数のソースです。

具体的には、各 stage ノードは 2 つのフィールドを得ます。ネイティブインストールでの
`aidlc engine graph export` から（他のフィールドは省略。各 sensor エントリはそのマニフェストの
`matches` glob も運びます）。

```json
{
  "slug": "requirements-analysis",
  "phase": "inception",
  "sensors": ["required-sections", "upstream-coverage"],
  "rules_in_context": [
    {"path": "aidlc/spaces/default/memory/org.md", "scope": "org"},
    {"path": "aidlc/spaces/default/memory/team.md", "scope": "team"},
    {"path": "aidlc/spaces/default/memory/project.md", "scope": "project"},
    {"path": "aidlc/spaces/default/memory/phases/inception.md", "scope": "phase"}
  ],
  "sensors_applicable": [
    {"id": "required-sections", "path": ".claude/sensors/aidlc-required-sections.md",
     "fire_on": "gate", "default_severity": "advisory", "category": "document-shape"},
    {"id": "upstream-coverage", "path": ".claude/sensors/aidlc-upstream-coverage.md",
     "fire_on": "gate", "default_severity": "advisory", "category": "document-shape"}
  ]
}
```

`matches`（解決済みの sensor エントリに存在するとき）は sensor 側のケイパビリティフィルタ、つまり
*「この sensor は、この glob に一致するファイルを分析する」* であり、コンパイルがマニフェストから
stage の解決済みエントリへ一字一句のままスナップショットします。PostToolUse hook は発火時に、
マニフェストを開き直さずにそれを読みます。

2 つの帰結があります。

- **dispatcher は runtime で解決の walk を行いません。** stage 入場は、ノードから `sensors_applicable`
  を読みます。すでにルックアップ済みで、すでに付与済みです。PostToolUse はこの事前解決済みの一覧から
  発火します。
- **doctor と designer は 1 つの解決済みビューに問い合わせます。** 「この stage にはどの rule が
  適用されるか」「このファイルを編集するとどの sensor が発火するか」。どちらも `stage-graph.json`
  から直接答え、ファイルシステムの walk はありません。

### ネットワーキングの教訓の適用

control プレーン（コンパイル）が遅くて賢い仕事を一度行い、その後 data プレーン（orchestrator +
dispatcher の読み取り）が解決済みのビューの上で高速に実行します。コンパイルは stage ごとの
インポートをすべて解決します。すべての `sensors:` id がルックアップされ、すべての `phase:` が付与され、
universal-default の rule がファイル名で拾われます。ワークフローを通して、runtime はグラフノードから
事前解決済みのフィールドを読みます。BGP はパケット飛行中に経路を再計算しません。AI-DLC は、ワーク
フローの途中で自ら stage グラフを再コンパイルしません。ワークフロー中の learning ループの書き込みは
ソースファイルを更新します。すでに選択された rule ファイルは各 stage 配信で読み直され、新しい選択
（ファイル、sensor バインディング）は次のグラフコンパイルでコンパイル済みビューに入ります。

---

## 5. 創発的な性質としての復旧

いま説明した data プレーン、つまり `runtime-graph.json`、監査ログ、state ドキュメント、`memory.md`、
アーティファクトツリーは、それ自体のために支払っていない性質を持ちます。圧縮後やクリーンな再起動後に
始まった新しいハーネスセッションは、これら 5 つのソースを合わせて読み、前のセッションが止めたところ
から引き継ぐのに十分なワークフローの状態を再構築できます。復旧は別個の機能ではありません。それは
設計のデータ規律の創発的な性質です。

### 5 つのソース、1 つの絵

| ソース | 何を記録するか | 読む順 |
|---|---|---|
| アーティファクトツリー（`<record>/<phase>/<stage>/*.md`） | 判断そのもの、完成した形で | 1 番目 |
| stage ごとの `memory.md` | 意思決定の最中に気づかれたこと | 2 番目 |
| 監査ログ（`<record>/audit/` の shard） | 各判断がいつ起きたか、誰が承認したか | 3 番目 |
| state ドキュメント（`<record>/aidlc-state.md`、stage ごとの state） | 今ワークフローのどこにいるか | 4 番目 |
| `runtime-graph.json` | stage 横断の要約（所要時間、sensor の発火、learnings の件数） | 5 番目 |

アーティファクトが最初に来るのは、実際に合意されたことの永続的な記録だからです。他の 4 つのソースは
旅路についてのものです。何が検討されたか、いつ起きたか、何が保留か、stage をまたぐパターンがどう
見えるかです。他人の途中の作業を引き継ぐ人間も同じように読みます。出力が最初、メモが 2 番目、
タイムラインが 3 番目、現在のカーソルが 4 番目、要約ビューが最後です。

### 復旧がきれいに再構築できるもの

判断、出力、stage 内のコンテキスト、タイムライン、現在位置、そしてどの Bolt がどんな結果で fork した
かです。5 つのソースを読む新しいセッションは、ワークフローが何を生んだか、ユーザーがどんな修正を
したか、どの gate が承認されたか、何がまだ保留か、前回の実行がおおよそどう進んでいたかを知ります。

### 復旧が再構築できないもの

前のセッションの会話のリズムです。ユーザーの stage 途中の Q&A パターン、`memory.md` にコミットされる
前の LLM の作業仮説、飛行中に中断された部分的なツール呼び出しです。会話バッファはセッションとともに
消えます。これは LLM セッションに本来備わる性質であり、設計で修正できる種類のものと区別されます。復旧の
仕事は、新しいセッションに再び向きを合わせて続けるのに十分なものを与えることにあります。前の
セッションの正確な心的状態の再現までは目指しません。

### 整合性の制約

異なるコードパスで書かれた 5 つのソースは、復旧が機能するためにすべてそれなりに整合し続けなければ
なりません。監査ログが正準です（append-only で、「何が起きたか」の source of truth）。ツールが所有する
書き込み（state 遷移、監査行、runtime グラフ）は同じ `withAuditLock` プリミティブの下で実行されます。
agent 自身が書くアーティファクトと `memory.md` の日誌は、監査 hook がそれらを記録する前に着地します。
5 つのいずれかを監査ログに対して読む新しいセッションは、drift を検出して突き合わせられます。

### これがフレームワークにとって意味すること

フレームワークはすでにこれの小さな版を実践しています。今日の `aidlc-state.md` は、intent 作成時に
書かれセッションの resume 時に読まれる `Scope` フィールドを運ぶため、orchestrator が再導出せずとも
ワークフローの scope がコンテキスト圧縮を生き延びます。その一般化は、何か永続的なものを記録する
data プレーンのすべての部分が、state ファイルだけでなく、復旧の表層の一部になることです。より深い
原則は、*data プレーンが復旧のために構造化されている* ということです。すべての永続的な記録が復旧の
表層の一部なので、resume のパスは、後付けではなく、すでに存在する基盤の上の小さな追加になります。

---

## 次のステップ

この章はレンズです。開発者リファレンスの残りは、それを通して見た機構です。

- **動いている control プレーン** — orchestrator がコンパイル済みの stage グラフをどう駆動するか。
  [Orchestrator](03-orchestrator.md) を参照してください。
- **control プレーンの入力** — コンパイルが各 stage ノードに解決するソースファイル:
  [Sensor System](07-sensor-system.md)（マニフェスト）と [Rule System](08-rule-system.md)
  （rule ファイル）。
- **data プレーンのアーティファクト** — `runtime-graph.json` のスキーマ、コンパイルのライフサイクル、
  復旧モデル。[Runtime Graph](13-runtime-graph.md) を参照してください。
- **ユーザー向けのビュー** — フレームワークを構築する人ではなく、ワークフローを実行する人のために
  枠づけた control/data/management。[Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md)
  を参照してください。

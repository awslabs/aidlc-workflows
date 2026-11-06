# ランタイムグラフ

> 対象読者: Tier 2/3（チーム導入者、フレームワーク貢献者）。

この章は、ワークフロー単位の `runtime-graph.json` アーティファクトを扱います。これは
`stage-graph.json` のデータプレーンのミラーで、`aidlc-runtime.ts compile` が承認ゲートごとに
監査ログからマテリアライズします。[Plane Architecture](02-plane-architecture.md)（このアーティ
ファクトの動機となる制御／データプレーンの分離）と [State Machine](12-state-machine.md)
（その遷移がコンパイルを引き起こすライフサイクル）を相互参照してください。

---

## 1. それが何であるか

`stage-graph.json` は構造上の真実です。すべてのステージ定義、すべての `requires_stage` /
`produces` / `consumes` エッジです。ワークフロー実行をまたいで安定しています。

`runtime-graph.json` は実行の真実です。*現在の*ワークフローについて、どのステージが始まったか、
どれが承認されたか、各ステージの memory.md がどう見えるか、どのセンサーが発火したかです。
ワークフローごとに 1 ファイルで、`<record>/runtime-graph.json` に存在します。`<record>/` =
インテントの記録ディレクトリ `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`。その行は
`RuntimeStage` レコード（`aidlc-runtime.ts`）で、`stage-graph.json` の `GraphStage`
（`aidlc-graph.ts`）とは別の形です。2 つはステージスラッグで結合されます。

これは、消費側（`aidlc-lib.ts` の `resolveBoltDag` で読まれるエンジンのユニットバッチ。ユニット
プランファイルがないときのステータス行と `/aidlc --status`。`aidlc-learnings.ts` の
`learnings surface` の `memory_path` 検索。`aidlc-doctor-bundle.ts` の doctor のグラフ診断。
`runtime summary`）が、クエリごとに監査ログを再び歩くのではなく、マテリアライズされた 1 つの
ビューを読むために存在します。

---

## 2. スキーマ

以下の TS インターフェイスは、ロックされたコントラクトです。変えるには、同じ PR ですべての
消費側を更新する必要があります。

```ts
interface RuntimeGraph {
  workflow_id: string;            // ISO timestamp from LATEST WORKFLOW_STARTED audit row (so a re-created intent identifies the live workflow, not a dead one)
  scope: string;                  // from aidlc-state.md "Scope" field (or the latest WORKFLOW_STARTED row's Scope when the state has none)
  started_at: string;             // ISO 8601, same row as workflow_id
  stages: RuntimeStage[];         // chronological order by started_at
  bolt_dag?: BoltDag;             // present only when units-generation's unit-of-work-dependency.md carries a valid (well-formed, acyclic) fenced edge block; absent/malformed/cyclic blocks omit the node
}

interface BoltDag {
  units: { name: string; depends_on: string[]; kind?: string }[]; // verbatim from the authored edge block; new names use lowercase kebab-case, while safe legacy single-segment names beginning with a digit or containing uppercase letters, underscores, or dots remain accepted (the swarm derives a separate internal Bolt slug); kind (service|spec|ui|packaging|library) present only when the edge block tags the unit
  batches: string[][];            // topological levels; each level = units whose deps are all satisfied by prior levels; level entries sorted lexicographically (deterministic)
}

interface RuntimeStage {
  stage_slug: string;
  started_at: string | null;      // ISO from STAGE_STARTED; null when `instances` is present
  completed_at: string | null;    // ISO from STAGE_COMPLETED; null when pending OR when `instances` is present
  agent: string | null;           // lead_agent; null when `instances` is present
  memory_path: string;            // <record>/<phase>/<stage>/memory.md (parent stage path even on instance-bearing rows)
  memory_entries: number | null;  // null = no memory.md file OR `instances` is present; else parseMemoryHeadings.total (a per-Unit stage: every Unit's construction/<unit>/<stage>/memory.md plus this path's)
  memory_breakdown: {             // null when memory_entries is null
    interpretations: number;
    deviations: number;
    tradeoffs: number;
    open_questions: number;
  } | null;
  sensor_firings: SensorFiring[]; // SENSOR_FIRED rows in the stage window, paired to their terminal row by Fire id
  outcome: "approved" | "failed" | "pending";
  learnings_captured: {           // null on pending rows; on approved single-instance rows, RULE_LEARNED + SENSOR_PROPOSED rows in the window counted by Source
    from_orchestrator: number;
    from_user_addition: number;
  } | null;
  instances?: BoltInstance[];     // present only when a Construction stage's window holds STATE_FORKED rows for at least two distinct Bolt slugs
}

interface BoltInstance {
  bolt: string;
  worktree: string;
  started_at: string;
  completed_at: string | null;
  memory_path: string;
  memory_entries: number | null;
  memory_breakdown: { interpretations: number; deviations: number; tradeoffs: number; open_questions: number; } | null;
  sensor_firings: SensorFiring[];
  outcome: "approved" | "failed" | "pending";
}

interface SensorFiring {
  id: string;
  fire_id: string;                // 8-hex correlator (four random bytes) the sensor dispatcher stamps on every row of one fire
  result: "passed" | "failed" | "could-not-run" | "budget-override" | "incomplete"; // the dispatcher's four terminal rows, plus incomplete for a FIRED row with no terminal (in a still-open window, only once the newest stage-start or sensor row is 60 s past it)
  ts: string;                     // FIRED row's timestamp
  detail_path?: string;
}
```

`instances` が存在するとき、ステージ行の単一インスタンスフィールド（`started_at`、
`completed_at`、`agent`、`memory_entries`、`memory_breakdown`）は NULL です。`started_at` と
`completed_at` は、代わりに各インスタンスに乗ります。`memory_entries` と `memory_breakdown`
は、インスタンスでも null のままです（コンパイルは Bolt ごとの memory.md を読みません）。
ステージ行のフィールドとインスタンス配列のフィールドが共存することは決してありません。

### Bolt/ユニット依存 DAG（`bolt_dag`）

任意の `bolt_dag` ノードは、エンジンが並列ビルドバッチを計算するために読む、機械可読なユニット
依存グラフです — swarm のファンアウトにとって「DAG が許可」です。記録されたステージ主体の
パス上の任意の `directive.wave` のエンジン入力でもあります。wave を出す前に、エンジンは、
オーサリングされた依存アーティファクトに対してこのキャッシュを検証し、治癒したメモリ内の
バッチと kind を使って、ビルド、完了受領、ペアレビュー、ユニットメモリのパスを含む、ユニット
ごとの各エントリを解決します。conductor はそのディレクティブだけを消費します。このキャッシュ
されたノードを読んだり、兄弟のパスを再構築したりは決してしません。そのソースは、units-generation
（2.7）が `unit-of-work-dependency.md` に、人間が読める散文の隣にオーサリングする、**フェンス
付きの `yaml` `units:` エッジブロック**です。

```yaml
units:
  - name: auth
    kind: service
    depends_on: []
  - name: api
    depends_on: [auth]
```

各ユニットは、任意の `kind`（`service | spec | ui | packaging | library`）、つまりユニットが
何で*ある*かを運んでもかまいません。それは `bolt_dag.units[].kind` に原文のまま乗り、ユニット
ごとの construction design の剪定を駆動します（[Stage definition](15-stage-definition.md) の
`produces_kinds` を参照）。ステージの produces アーティファクトは、各ユニットの kind に適用
されるものに絞られます。タグのないユニットは `kind` キーを運ばず、完全な設計アーティファクト
マトリクスを保ちます。不正な kind 値は、ブロック全体を `malformed`（下を参照）にするので、
綴り間違いは誤った剪定ではなく 2.7 ゲートで大きく失敗します。

`compile` は、*その構造化ブロック*を（純粋なデータパース、モデル呼び出しなし）`units`（原文の
エッジ）と `batches`（トポロジカルレベル）にパースします。各バッチは、依存がすべて先のバッチで
満たされるユニットの集合なので、バッチのユニットは相互依存がなく、並列で走れます。レベルの
エントリは、出力前に辞書順でソートされるので、オーサリング順にかかわらずノードは決定的です。

ノードは、アーティファクトが欠けているとき（静かに）、またはアーティファクトは存在するが
そのエッジブロックが欠けている、不正（重複名、宙ぶらりんまたは自己依存、パース不能）、または
循環しているときに、**完全に省略されます**。そのとき `compile` は理由を名指しする stderr の
診断を書き、誤っているが有効な DAG を出すのではなく、`bolt_dag` をエンベロープから外します。
それらの失敗は、同じブロックを検証し `edge_block: ok | absent | malformed | cyclic` を報告する
`required-sections` センサーによって、2.7 ゲートで上流に可視化されます。エンジンは、2.7 レビュー
要求の前と 2.7 ゲートが開く前に同じブロックを読み、読めない間は、代わりにエージェントに欠陥と
ブロックの形を渡します。承認後に壊れるブロックは、Construction の `next` を、人へのエラーでは
なく、エージェントへの同じ修復ステップで止めます。エッジを構造化データとして（ナレッジ作業、
一度、2.7 承認ゲートの後ろで）オーサリングすることが、hook 発火の `compile` を再実行でバイト
同一に保つものです。コンパイルパスにモデルは座りません。orchestrate エンジンは、キャッシュ
された `bolt_dag` を `unit-of-work-dependency.md` に対して検証し、ノードが欠けているか、その
オーサリングされたアーティファクトと食い違うとき、読み取り側でユニットごとの反復を自己治癒
します。グラフファイル自体は、次のコンパイルでのみ修復されます。

---

## 3. コンパイルのライフサイクル

コンパイルは、遷移クラスの監査出力ごとに、PostToolUse Bash hook
（`.claude/hooks/aidlc-rebuild-stage-graph.ts`）が呼びます。hook は、conductor からのすべての
`Bash` ツール呼び出しで発火します。これらのコンパイルフィルタの前に、hook はエンジンの
`error` ディレクティブのメッセージを人間に中継し、新しいインテントをそのセッションに結び付け
ます（[Hooks and Tools](06-hooks-and-tools.md#posttooluse-rebuild-stage-graphts) を参照）。
どちらもコンパイルに影響しません。その後、安価にフィルタします。

1. **コマンドフィルタ**（`aidlc-lib.ts` の `classifyRuntimeCompileCommand`）: `state`、`jump`、
   `bolt`、`unit`、`utility` ツール、`orchestrate report`、そして意味的なワンショットルート
   （`aidlc status`、`doctor`、`version`、`help`、`scope change`、`config set`、`recompose`、
   `report`）だけが早期 exit を通り抜けます。runtime ルートは拒否されます（再帰ガード）。
   `aidlc-log.ts` はおしゃべりなステージ内イベントだけを出します。`aidlc-worktree.ts` は
   WORKTREE_* イベントだけを出します。
2. **監査存在ガード** — インテントの `audit/` シャードがまだ存在しないなら exit します。
3. **ハートビート** - doctor の静かな hook 検出のために
   `<record>/.aidlc-engine/hooks-health/rebuild-stage-graph.last` を書きます。
4. **末尾 3 ブロックの末尾読み**: アクティブインテントのすべての `audit/` シャードを 1 つの
   バッファにマージし、`\n---\n` で分割し、最後の 3 エントリを取ります。
5. **イベントクラスフィルタ**:
   `**Event**: (GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|UNIT_MERGED|WORKFLOW_COMPLETED)`
   を 3 ブロックのいずれかに照合します。一致しないなら exit します。
6. **ディスパッチ** — `aidlc engine runtime compile ...`。

`WORKFLOW_COMPLETED` は遷移集合にあるので、最終ステージの承認がコンパイルを発火させます。
`aidlc-state.ts` の `handleCompleteWorkflow` は 4 つの監査行（STAGE_COMPLETED + PHASE_COMPLETED
+ PHASE_VERIFIED + WORKFLOW_COMPLETED）を出し、そのうち最後の 3 つが `PHASE_COMPLETED +
PHASE_VERIFIED + WORKFLOW_COMPLETED` です。（承認パスでは、承認がすでに STAGE_COMPLETED を
出したのでそれが抑制され、`GATE_APPROVED` が実行に先立つので、最終ステージの承認は、いずれに
せよ 1 つの Bash 呼び出しで 5 行を足します。）正規表現に `WORKFLOW_COMPLETED` がないと、
ランタイムグラフは最終ステージを承認済みと決して記録しません。

コンパイル自体は、完全な監査ログを歩き（なので結果は遷移増分ではなくイベントソース）、
`STAGE_STARTED` を同じスラッグの次の `STAGE_COMPLETED` とペアにし、`aidlc-lib.ts` の
`parseMemoryHeadings()` 経由で各ステージの memory.md を読み、`withAuditLock` の中で
`writeFileAtomic` 経由でアーティファクトをアトミックに書きます。

### 最初のコンパイルの前のウィンドウ

`init`、`intent create`、`orchestrate next` は遷移クラスのコマンドではないので、それらの
コマンドだけを走らせた新しいワークフローは、最初のゲートが報告するとき、やはり
`runtime-graph.json` を持ちません。一般的なパスでは、ファイルは最初のゲート付きステージでの
`orchestrate report --result awaiting-approval` で初めて現れます。より早い `aidlc status`、
`config set`、またはコピーチャネルのユーティリティ `intent-create` ルートは、たまたま走ると
それをより早くコンパイルしますが、ファイルは最初のゲートでもまだ欠けているかもしれません。
消費側はそれが存在すると仮定できません。新しいクローン、`git clean`、または 1 つのドロップ
された hook コンパイルは、ファイルが gitignore されマシンローカルなので、ワークフローの途中で
同じ穴を残します。したがって消費側は、欠けているファイルを通常の状態として扱い、再計算または
劣化しなければならず、決して失敗してはなりません。`learnings surface` は、それが読む 1 つの
フィールド（`memory_path`。コンパイルが導出するのとまったく同じく導出）を静かに再計算するので、
stage-protocol の section 13 の儀式は、最初のゲートでもやはり走ります。不正なファイル、または
`memory_path` なしで存在する行は、別です。それは破損で、失敗します。

---

## 4. 結果 enum と時系列ペアリング

3 つの結果値: `"approved" | "failed" | "pending"`。

- **approved** — `STAGE_STARTED@T1` が、後の `STAGE_COMPLETED@T2` とペアになります。行の
  `completed_at` は `T2` です。
- **pending** — `STAGE_STARTED@T1` に、そのスラッグの後の `STAGE_COMPLETED` がありません。
  行の `completed_at` は `null` です。
- **failed** — `instances[]` の親ステージロールアップだけが出します（単一インスタンスの
  ステージは `"approved" | "pending"` のままです）。Construction ステージの `instances[]` が
  空でないとき、親の `outcome` はそのインスタンスのロールアップです: すべて approved → `approved`、
  いずれか failed → `failed`、さもないと（いずれか pending、失敗なし）→ `pending`。単一
  インスタンスのステージは `failed` を出しません。基になる `BOLT_FAILED` イベントが、
  instances を持つパスの外では Construction ステージのスコープを持たないからです。

再ジャンプの扱い: `/aidlc --stage <slug>` は、すでに完了したスラッグに対して `STAGE_STARTED`
を再出力します。監査ログは `STAGE_STARTED@T1, STAGE_COMPLETED@T2, STAGE_STARTED@T3` を運びます。
ペアリングルールは `STARTED@T1` を `COMPLETED@T2` に照合し → approved を生むはずですが、
そのスラッグの最新の `STAGE_STARTED` が、より早い行を上回ります — スラッグごとに 1 行、最新の
STARTED が勝ちます。なので結果は、`started_at: T3, completed_at: null` の pending 行です。

単一ステージの除外: `--single` のステージランナー実行は、その `STAGE_STARTED`/`STAGE_COMPLETED`
ペアを、合成の `**Workflow**: single-stage:<slug>` id（監査のみ。`aidlc-orchestrate.ts` の
`handleSingleReport` を参照）の下でコミットします。ペアリングは、`Workflow` フィールドが
`single-stage:` で始まる `STAGE_*` 行をスキップします。それらの行はどのメインワークフローにも
属さないので、メインの `runtime-graph.json` に行を作ったり完了させたりすることは決してなく
（したがって `summary` のカウントを水増しすることも決してありません）。メインワークフローの
`STAGE_*` 行は `Workflow` フィールドを運びません。不在は、行が保たれることを意味します。同じ
除外が `aidlc-state.ts` の `hasStageAuditEvent` の重複排除検査に適用されるので、単一実行の
`STAGE_COMPLETED` が、同じスラッグのメインワークフロー自身の完了出力を抑制することはできません。

---

## 5. MEMORY_EMPTY の意味

`MEMORY_EMPTY` 監査行は、ステージ行が次のすべてを満たすとき、コンパイルが出します（唯一の
発行者: `audit-format.md` のイベントレジストリの Learning Loop セクションが
`tools/aidlc-runtime.ts compile` を列挙）。

- `outcome === "approved"`（pending 行は出さない。下を参照）
- `memory_entries === 0`（ファイルは存在し、4 つの正規の §13 見出しの下のエントリはゼロ）

ゼロエントリの pending 行は出しません。まだ進行中のステージは、conductor がまだ memory.md に
書いていないため、正当にゼロエントリかもしれません。進行の途中で MEMORY_EMPTY を出すと、本当の
日記スキップを表さないノイズが生じます。シグナルは「ゼロエントリでステージが承認された」で、
これはステージが承認済みであることを要します。

### 冪等性 — (slug, gate-completion) ごとにちょうど一度

`runtime-graph.json` 自体は、同じ監査ログに対する再コンパイルをまたいでバイト等価です。
MEMORY_EMPTY の出力は、より強いです。**`(stage_slug, completed_at)` タプルごとに高々 1 つの
MEMORY_EMPTY 行**です。

ロックされたセクションの中で、コンパイルはインテントの `audit/` シャードを読み直し、ゼロ
エントリで承認された各スラッグの既存の MEMORY_EMPTY 行をスキャンし、以前の行の Timestamp が
このスラッグの `completed_at` 以降なら出力を抑制します。これは次を意味します。

- ゼロエントリでステージが承認した後の最初のコンパイルは、1 つの MEMORY_EMPTY 行を出します。
- 同じワークフロー中のその後のすべてのコンパイルは、そのスラッグに対して再出力しません。
- `--stage <slug>` の再ジャンプ + 再承認は、新しい `STAGE_COMPLETED`（より後の `completed_at`）
  を生みます。再承認時にステージがまだ空なら、以前の行の Timestamp が今や新しい completed_at
  より前なので、新しい MEMORY_EMPTY 行が出ます。

ロックされたセクションの中で MEMORY_EMPTY が出た後にアーティファクトの書き込みが失敗すると、
監査ログは、runtime-graph.json が決して着地しなかったステージに対して N 個の MEMORY_EMPTY 行を
運びます。次のコンパイルは、その抑制スキャンでそれらの行を見て、再出力をスキップします。
その後アーティファクトが着地します。重複出力も、幻のアーティファクトもありません。

---

## 6. memory.md 欠落のルール

memory.md が存在しない（決して作られなかった日記）ステージは、null のカウントを得て、
MEMORY_EMPTY 行はありません。

- `memory_entries: null`、`memory_breakdown: null`、MEMORY_EMPTY 出力なし。
- 両フィールドは一緒に動きます。判別子は「`parseMemoryHeadings` が実行されたか」です。
  memory.md が存在する（ゼロバイトでも）なら実行され、キーは数です。memory.md が欠けている
  なら、両方とも `null` です。

---

## 7. 復旧ソース

`runtime-graph.json` とインテントの `audit/` シャードは、イベントソースのペアを成します。
シャードは追記専用のイベントログです。`runtime-graph.json` は、最後の遷移クラスの出力時に
取られたマテリアライズされたスナップショットで、すべてのコンパイルがログ全体からそれを
再導出します。

5 つの復旧ソース、人間の読み順で:

1. **アーティファクトツリー**（`<record>/<phase>/<stage>/`）— 何が生成されたか。
2. **memory.md**（`<record>/<phase>/<stage>/memory.md`）— conductor が捉えることを選んだもの。
3. **audit/ シャード** — 正規のイベントログ。実際に何が起きたか。
4. **aidlc-state.md**: アクティブステージのカーソル。
5. **runtime-graph.json** — マテリアライズされたビュー。監査を再び歩くよりクエリが速いが、
   常にそこから再導出できる。

### pending 行の鮮度の注意

pending 行の `memory_entries` と `memory_breakdown` は、最後のコンパイル時にスナップショット
されました。ステージが進行中で、conductor が最後のコンパイルの発火以降により多くのエントリを
書いたなら、スナップショットは遅れます。復旧の消費側は、復旧時に memory.md を再パースしなければ
なりません。pending 行のスナップショットされたカウントを信用してはなりません。

`aidlc-state.ts resume`（`handleResume`）は `runtime-graph.json` を読みません。`aidlc-state.md`
のカーソルフィールド（現在のステージ、フェーズ、ステータス、スコープ、エージェント、次の
ステージ、ゲート状態、設定されているときユニットチェックポイント）を報告し、その後にステージ
活動のない `SESSION_COMPACTED` 行を監査末尾でスキャンします。

### 並列 Bolt の進行中復旧

`aidlc-runtime.ts fragment-fork`（`aidlc-bolt start --worktree` が呼ぶ）は、メインの
`runtime-graph.json` を Bolt の worktree にバイトコピーします（メインに何もないときはそこに
空のグラフを書きます）。`fragment-merge`（`aidlc-bolt complete --merge` が呼ぶ）はそれを
削除します。どちらも監査行を出しません。コンパイルは、Construction フェーズのステージの
ウィンドウが、少なくとも 2 つの別々の Bolt スラッグの `STATE_FORKED` 行を持つとき、
`BoltInstance[]` を埋めます。完全なライフサイクルは section 11 にあります。

worktree フラグメントの内容を読む消費側はありません。`fragment-merge` はそれをハッシュして
削除し、swarm 復旧はそれを resume アーカイブに移し、`resume` は `aidlc-state.md` と監査末尾
（上）から報告し、メインのマージ後の `runtime-graph.json` はメインの監査シャードから再ビルド
されます。

---

## 8. CLI 面

```bash
# Walk audit + memory.md, write runtime-graph.json (invoked by hook).
aidlc engine runtime compile

# Print one stage row from runtime-graph.json (debug/test surface).
aidlc engine runtime read <stage-slug>

# Print deterministic aggregates over runtime-graph.json: stage/phase
# outcome tallies, memory-entry counts by category, sensor 5-state
# tallies, learnings captured, and workflow duration. Read-only; the
# session skills (session-cost, replay, outcomes-pack) consume the
# --json shape so every number they render comes from here, not from
# LLM-side counting.
aidlc engine runtime summary [--json]

# Byte-copy main runtime-graph.json into a Bolt's worktree fragment
# (one-shot; called by `aidlc-bolt start --worktree`). No audit emit —
# the fragment lifecycle rides on STATE_FORKED + AUDIT_FORKED.
aidlc engine runtime fragment-fork --slug <kebab-slug>

# Remove the worktree fragment (idempotent; called by
# `aidlc-bolt complete --merge`). No audit emit — the fragment
# lifecycle rides on STATE_MERGED + AUDIT_MERGED. Main's runtime-graph
# is rebuilt event-source by the post-Bash compile hook on AUDIT_MERGED.
aidlc engine runtime fragment-merge --slug <kebab-slug>
```

すべてのサブコマンドは、標準の cwd ベースの解決を上書きするために `--project-dir <path>` を
受け付けます。

コンパイルは、通常の運用では hook 駆動です。手動の呼び出しは、テストとデバッグのために
存在します。

---

## 9. なぜ hook 駆動で、LLM ツール結合ではないのか

以前のプラン改訂は、`handleApprove` / `handleAdvance` / `handleComplete --merge` の中に
`spawnSibling(..., "aidlc-runtime.ts compile", ...)` 呼び出しを挿入することを提案しました。
そのアプローチは、[Plane Architecture](02-plane-architecture.md) に文書化された、荷重を担う
信条に違反します。

> 決定性が必要なところでは、ツールを使う。ナレッジが必要なところでは、LLM/エージェントを
> 使う。判断が必要なところでは、人間を使う。

ランタイムグラフのコンパイルは、特定のセッションの外から観測できなければならないデータ
プレーンの基盤です。それを LLM が呼ぶツールに結合すると、LLM の脱落が決定性の保証を壊します。
人間が Approve をクリックした後に、conductor が `{{INVOKE}} engine orchestrate report
--stage <slug> --result approved --user-input "Approve"` を呼び忘れると、監査行は決して
追記されず、コンパイルも決して発火しません。ランタイムグラフは静かに遅れ、復旧の基盤が破損します。

PostToolUse Bash hook は、LLM が次に何をするかにかかわらず、conductor の実際のコマンド呼び出し
で発火します。監査を出す隠しディスパッチャールート（`aidlc engine state ...`、`jump ...`、
`bolt ...`、`utility ...`、`orchestrate report ...`）が、決定的なアンカーです。

---

## 10. ハーネスのディスパッチ

コンパイル hook はコア hook で、Claude Code のものではありません。Claude Code はそれを
`settings.json` の PostToolUse Bash hook として登録します。Codex、Copilot、Cursor、Kiro CLI、
Kiro IDE、opencode のアダプターは、そのシェルの post-tool イベントを同じ
`aidlc-rebuild-stage-graph.ts` に転送します。Kiro IDE はシェルコマンドを可視化しないので、
そのアダプターは `source: "ide-audit-sync"` を送り、hook はコマンドフィルタをスキップし、監査
末尾でゲートし、`runtime-graph.json` がすでにすべての監査シャードと少なくとも同じ新しさなら
コンパイルをスキップします。

---

## 11. フラグメントのライフサイクル

Bolt ごとのランタイムグラフフラグメントファイルは、`<worktree>/<record>/runtime-graph.json`
に存在し、gitignore され、メインの場所をミラーします。そのライフサイクルは次のとおりです。

1. **Bolt 開始でのフォーク。** `aidlc-bolt start --worktree --slug <slug>` は、state-fork +
   audit-fork の後に `aidlc-runtime fragment-fork --slug <slug>` に委譲します。単一読み取り
   プロトコル: `readFileSync` を一度バッファに、`writeFileSync` をバッファからフラグメント
   パスに、同じバッファを stdout エンベロープのためにハッシュします。並行するコンパイルが
   フォークの途中でメインを書き直すのに対して、バイトコピー／ハッシュの競合を閉じます。
   メインにまだ runtime-graph.json がないなら、フラグメントは worktree の状態カーソルに
   アンカーされた空のグラフです。
2. **Bolt の生存中の進化。** PostToolUse のコンパイル hook は、遷移クラスの監査出力ごとに
   （worktree 内の遷移を含め）発火します。各発火は、worktree の監査ビューから worktree の
   runtime-graph.json（フラグメント）を再コンパイルします。フラグメントは、この Bolt の
   audit-fork の瞬間にアクティブだった兄弟に対して `instances[]` が埋まった状態になることが
   あります。後から始まる兄弟は、worktree の監査がフォーク時のスナップショットなので、
   フラグメントに現れません。
3. **Bolt 完了でのマージ（solo/swarm パス）。** `aidlc-bolt complete --merge --slug <slug>`
   は、state-merge + audit-merge の後に `aidlc-runtime fragment-merge --slug <slug>` に委譲
   します。fragment-merge は、stdout の観測可能性のためにフラグメントをハッシュし、それを
   `unlinkSync` し、JSON エンベロープを出します。親 Bash 呼び出しが返った後、コンパイル hook が
   メインで再発火し、ちょうどマージされたスラッグに対して `instances[]` が埋まった状態で
   メインの runtime-graph を再ビルドします。
4. **多層防御の削除。** `aidlc-worktree merge` と `aidlc-worktree discard` は両方とも
   `git worktree remove` を呼び、それが推移的にフラグメントを削除します。fragment-merge の
   明示的な削除は、暗黙のクリーンアップと、多層防御のパターンとして対になり、state-merge と
   `git worktree remove` が状態側ですでに対になっているのをミラーします。
5. **失敗モード。** `fragment-fork` の失敗（worktree 欠落、フラグメントがすでに存在、
   バイトコピーの IO エラー、spawn タイムアウト）は、`aidlc-bolt` に、doctor の帰属のための
   `Reason: fragment-fork-*` フィールド付きの `BOLT_FAILED` を出させます（IO／ガードのエラーには
   `fragment-fork-failed`、spawn SIGTERM には `fragment-fork-timeout`）。state-fork + audit-fork
   はロールバックされません（それぞれすでに自分の監査行を出しました）。audit-merge がすでに
   着地した後の `fragment-merge` の失敗は、珍しい部分成功の監査シグネチャ
   `BOLT_COMPLETED → STATE_MERGED → AUDIT_MERGED → BOLT_FAILED (Reason: fragment-merge-*)` を
   生みます（IO／ガードのエラーには `fragment-merge-failed`、spawn SIGTERM には
   `fragment-merge-timeout`）。フラグメントファイルは、暗黙の `git worktree remove` のクリーン
   アップまで残ります。メインに対するその後のコンパイルは、一貫したランタイムグラフを生みます
   （この位置の BOLT_FAILED はインスタンスを `"approved"` と採点します。ロールアップの
   STATE_MERGED 優先の順序が、Bolt の内容がすでにメインに伝播したことを反映するからです。
   ここの BOLT_FAILED は復旧のテレメトリで、継ぎ目を記録し、内容自体は無傷のままでした）。

---

## 次のステップ

- **なぜデータプレーンがこう構造化されているか** — `runtime-graph.json` を、2 つ目の信頼できる
  情報源ではなく `stage-graph.json` のミラーにする、制御／データプレーンの分離。[Plane
  Architecture](02-plane-architecture.md) を参照してください。
- **コンパイルを引き起こすライフサイクル** — その監査出力がコンパイル hook を駆動する、
  ワークフロー / フェーズ / ステージの遷移。[State Machine](12-state-machine.md) を参照してください。
- **このグラフが導出される監査ログ** - 132 イベントの分類と発行者レジストリ。[State Machine](12-state-machine.md)
  と、User Guide の [State and Audit Trail](../guide/10-state-and-audit.md) を参照してください。

# Multi-Team Construction and Workshop Mode

Team 所有の Construction は、複数の人間チームが、1 つの承認済み intent から異なる Unit を作れるようにします。workshop mode は、同じ仕組みの 1 つの応用です。engine の契約は scope 非依存です:

- `Construction Iteration: unit-major`
- `Unit Ownership: team`
- 妥当な Unit 依存 DAG
- 共有の git 名前空間、または 1 つのローカル ref データベースを共有する兄弟 worktree

team 所有は現在、workspace ルート自体がソースの Git リポジトリであることを要します。記録された兄弟リポジトリの集合を持つ作業は、誰が Unit を作るかを尋ねられません。Construction が始まると、AI-DLC はこのセッションがそれらを作ると 1 行で言います。各チームが Unit を 1 つずつ所有する形は、リポジトリをまたぐ作業ではまだ利用できないからです。`set-unit-ownership team` も、state を変える前に同じ行で拒否します。

integration lead は、scope 無しの main から作業します。各 delivery チームは、1 つの claim した Unit に刻印された checkout から作業します。claim した checkout は、その Unit の正確な Construction 連鎖、ステージ 3.1 から 3.5 を、graph の順で走らせます。チームの keyed レシートがその audit シャードとともに届くため、main は merge の後にそれらのステージを再実行しません。

Workshop scope のステージグリッドと Minimal の test 下限は、[Scopes and Depth](05-scopes-and-depth.md#workshop) を参照してください。

---

## 役割とトポロジー

| 役割 | 責務 |
|------|----------------|
| **Integration lead** | main 上で Inception と必要な walking skeleton を駆動し、claim を監視し、完了した候補を pin し、merge gate を提示し、承認された Unit を land する |
| **Unit team** | 依存の揃った Unit を 1 つ claim し、その scope 付き 3.1-3.5 連鎖を走らせ、artifact/レシート/ソースを commit し、候補を publish する |
| **Review group** | Unit の選ばれた team gate と、main 側の pin された merge gate に答える |

2 つのトポロジーは、同じコマンドと証跡を使います:

コマンド例は、harness 非依存の公開文法を使います。インストールした harness の `/aidlc` コマンド面か、その packaged な `aidlc` dispatcher を通して走らせてください。どの例も `.claude/`、`.kiro/`、`.codex/` のツールパスを前提にしません。

### チームごとに clone

各チームが共有リモートを clone します。claim の調整と候補の publication は、`refs/heads/claim/<intent-id8>/<unit>` を使います。

```bash
git clone <shared-remote> payments-team
cd payments-team
git fetch --all
aidlc unit claim payments --team "Payments team"
```

### 兄弟 worktree

1 つのリポジトリが兄弟 worktree を作ります。claim は、リモートが設定されていないときにだけ、アトミックな `git update-ref` を通じて共有のローカルブランチ名前空間を使います。`origin` が存在すれば、兄弟 worktree は、別々の clone と同じリモート裏付けの claim を使います。このトポロジーは、1 台のマシンと決定的テストに便利です。演習全体が意図的にローカル/オフラインのときだけ、リモートを取り除いてください。

Bolt のディレクトリとブランチは `bolt-<id8>_<slug>` を使います。`<id8>` は選ばれた intent のレジストリ UUID の接尾辞で、`refs/heads/claim/<id8>/<unit>` の Unit claim でも使われます。そのため並行する intent は、衝突せずに、1 つの checkout 内でも、1 つの clone の worktree をまたいでも、同じ Unit slug を使えます（[#1252](https://github.com/awslabs/aidlc-workflows/issues/1252)）。命名と従来互換は [Bolt identity](../../core/knowledge/aidlc-shared/worktree-info-schema.md#bolt-identity) を参照してください。`create` が返すパスを使ってください。この例は intent の identity `7c31e9a0` を前提にします。

```bash
# From unscoped main:
# Optional local-only mode: git remote remove origin
aidlc engine worktree create --slug payments --base main
cd .aidlc/worktrees/bolt-7c31e9a0_payments
aidlc unit claim payments --team "Payments team"
```

下の同じ scope 付き build と `publish` のコマンドを、その worktree から走らせてください。main が候補を land して push した後、main に戻り、完了したローカル worktree を `aidlc engine worktree discard --slug payments` で破棄します。Bun ベースの copy インストールでは、代わりに `bun .claude/tools/aidlc-worktree.ts create` と `discard` を同じフラグで走らせ、`.claude` をあなたの harness ディレクトリに置き換えてください。discard は、checkout とブランチを取り除く前に、追跡ファイル、ignore されていない非追跡ファイル、review 済みのソース ref を退避します。その作業を後で調べるには、`aidlc engine worktree restore --slug payments` を走らせます。これは `.aidlc/restored/` 配下に隔離された checkout を作り、新しいライブの `bolt-7c31e9a0_payments` に触れません。保存された 1 つの試行には `--parked <stamp>` を、checkout 変換を迂回するには素の `--raw` を加えます。ignore された非追跡ファイルは保存されず、保存時の `eol/text=auto` 正規化は restore で元に戻せません。

recovery の ref を取り除くには、`aidlc engine worktree purge --slug payments` を使い、任意で 1 つの試行には `--parked <stamp>` を、非負の有限な日数より厳密に古い試行には `--older-than <days>` を付けます。年齢は stamp の UTC タイムスタンプを使い、その `-N` 衝突接尾辞は無視します。2 つのセレクタは互いに排他です。purge は、ほかへ移されたものを含め、一致する restore 済み checkout が存在する間は拒否します。Doctor は、保存された試行を情報として列挙し、正確な slug・stamp・リポジトリに対する型付きの `restore_operation` と `purge_operation` の値を示し、その後に `--intent <record-dir-name> --space <space>` を続けて、active な intent が変わった後も操作を所有する intent に結び付けたままにします。conductor は、列挙された各 arg を正確に argv として、決してシェルコマンドに結合せずに、その `worktree` engine ルートを起動します。任意の `restore_command` と `purge_command` は、安全な人間向け表示テキストです。描画の失敗は、該当するコマンドを省き、操作を保ったまま `restore_command_error` または `purge_command_error` を供給します。保存すべきものが review 済みソース ref だけだった場合、その試行は `parked_commit: "-"` の `evidence-only` です。ファイルは復元できず、abort は `restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` を省き、doctor は purge 操作とその command-or-error フィールドだけを提示します。recovery の手順は [getting the files back](15-troubleshooting.md#a-bolt-attempt-was-set-aside-getting-the-files-back) を、フラグは [CLI Commands](12-cli-commands.md#aidlc-engine-worktree-purge-remove-recovery-refs) を参照してください。

作成は、レジストリ UUID の無い intent を拒否します。Construction の前に、その intent を adopt するか作り直してください。クリーンアップも、Bolt ブランチが別の worktree パスで checkout されているときは拒否し、そのブランチや retained/parked ref を削除する代わりにその所有者を名指しします。アップグレード前の従来の `bolt-<slug>` Bolt は、一致する intent の provenance があるときにだけ、merge・discard・purge を完了できます。新しい Bolt はその形を決して使いません。`doctor` は両方の形を報告します。

通常の scope 付き `next`、lifecycle、review、gate の作業は offline-first です。ネットワークアクセスは、明示的な claim、publish、status、pin、merge-ref の検証操作に限られます。

---

## Construction の準備

integration lead は Inception を完了します。これには次を含みます:

1. 権威ある Unit DAG。
2. `Construction Iteration: unit-major`。
3. `Unit Ownership: team`。
4. team gate のリズム、`per-stage` または `unit-end`。
5. 確定したブランチ戦略。

Inception が 2 つ以上の Unit で終わると、Construction への最初のステップが、誰が作るかを一度だけ、どの scope でも compose されたワークフローでも尋ねます。**Just me** は `Unit Ownership: solo` を記録し、このセッションが Unit を作ります。**Several teams** は `Unit Ownership: team` を記録し、途中で stage ごとの plan を一度に 1 つの Unit へ切り替えます（選択がそう言い、lead が各 Unit の末尾で 1 回の承認を求めない限り、各チームが毎ステージの後に自分の Unit を承認するとも言います）。Unit が 1 つの plan、Unit plan の無いもの、または Construction がすでに進行中のものは、決して尋ねられません。どちらも選ばない返信は、このセッションが作るままにし、最初のステップが、最初の Unit が作られる前にチームを求めるよう言います。team の承認は、lead が各 Unit の末尾で 1 回の承認を求めない限り（最初の team 承認の質問の前に `set-unit-gate-rhythm unit-end`）、毎ステージの後（`per-stage`）に来ます。最初の team ステップがそれを提示します。まだどのチームも Unit を取っていない間、そのステップはまた、このセッションがここで最初の DAG Unit（scope が 1 つ走らせるなら walking skeleton）から Unit を作ること、そしてチームが代わりに 1 つを取る方法を一度言います。git を通じて作業を共有し、それからチーム自身の clone で `aidlc unit participate` と `/aidlc` を走らせます（下の「Claim、build、publish」を参照）。

scope が `skeleton: on` を記録すると、最初の DAG Unit が walking skeleton です。claim が開く前に scope 無しの main 上で走り、merge-back gate を要しません。push された main 上の Unit Progress 行が完了すると、claim が開きます。`skeleton: off`、または作業の state に記録された `Skeleton Stance: off` では、依存の揃った Unit が即座に開きます。

チームが claim する前に、承認済みの Inception の state と artifact を publish してください:

```bash
git push origin main
```

claim は依存バッチごとに開きます。「Delivery planning is complete」は、すべての Unit が claim 可能という意味ではありません。Unit は、すべての `depends_on` 行が merge されるまでブロックされたままです。

---

## Claim、build、publish

### 1. Claim

参加者の clone で:

```bash
git fetch --all
aidlc unit participate
```

guided な picker には `/aidlc` を走らせるか、直接 claim します:

```bash
aidlc unit claim payments --team "Payments team"
```

同時の claim 者のうち、ちょうど 1 人が勝ちます。コマンドは、checkout に space、intent、Unit、generation、nonce、gate リズムを刻印します。自身の audit シャードがすでに main 上にある checkout（lead 自身の checkout、またはそのコピー）は、Unit の証跡を claim 自身の新しいシャードに保つので、新しい clone のように publish と pin ができます。

同じ試行を別マシンのチームメイトに渡すには、claim の ref を push します。チームメイトは fetch し、正確なローカルの `claim/<intent-id8>/<unit>` ブランチを checkout し、それから次を走らせます:

```bash
aidlc unit adopt payments
```

adopt は、checkout されたペイロードをライブの ref と照合し、claim の束縛された audit シャードを保つので、チームメイトは後続の試行を作らずに resume して publish できます。

### 2. Build

claim した checkout で `/aidlc` を走らせます。engine は、刻印された Unit だけをルーティングします:

1. Functional Design (3.1)
2. NFR Requirements (3.2)
3. NFR Design (3.3)
4. Infrastructure Design (3.4)
5. Code Generation (3.5)

Plan Approval は、Code Generation の間、必須のままです。

gate リズムが team の review 点を制御します:

- `per-stage`: 確定した `(stage, Unit)` ごとに 1 ゲート。
- `unit-end`: 3.5 の後に 1 つの team 完了ゲート。
- どちらのリズムも、main 上に 1 つの pin された merge gate を追加します。

完了した artifact、ソース、state mirror、audit シャードを commit します。publication は、クリーンで追跡された checkout を要します。AI-DLC 自身が `.gitignore`、`AGENTS.md`、`opencode.json` に書く部分（新しい clone でセッションが始まるときに書く）は数えません:

```bash
git add -A
git commit -m "Complete payments Unit"
aidlc unit publish payments
```

`publish` は、ツリーがチームの commit 済みの作業で、親が claim 履歴と実装履歴の両方を束ねる候補 commit を作ります。claim の ref を CAS 更新します。publication は integration ではありません。候補は、pin が受け入れる行と review が記録するレシートの名前を持つ claim の audit シャード（AI-DLC はそれらを commit の外に保ちます）を運び、ほかのすべての audit シャードとステージの共有 diary を main が持つとおりに運びます。残されたものは checkout 自身の履歴に留まり、publish は何行かを言います。Unit の `construction/<unit>/` フォルダの外のほかのレコードへの変更（`contract-summary.md` のような Inception artifact）も publish されますが、pin はそれを拒否するので、publish がそのファイルを名指しします。それをブランチから取り出し、変更を main で行い、また publish してください。

---

## Pin、gate、land

すべての merge コマンドは、scope 無しの main から走ります。

### 1. 候補を pin する

```bash
git fetch --all
aidlc unit pin payments
```

pin は、1 つの正確な候補 OID と試行 generation を記録します。証跡は、merge や worktree 作成ではなく、git オブジェクトの plumbing で読まれます:

- 必要な Unit artifact。
- active なステージの `UNIT_COMPLETED` レシート。
- claim リズムでの team gate 承認。
- 必要な各 review の `READY` verdict、または `NOT-READY` のままだった review の後のステージの team 承認で、その未決の findings を受け入れるもの（findings の修正を求めた承認は、次の review を待ちます）。証跡の `reviewers_ready` は、未決が何も無い状態で承認されたステージだけを保ちます。`reviewers_approved_over_concerns` は、どちらの verdict でも、findings が未決のまま承認されたすべてのステージを、各 findings の id、severity、承認がそれに対して記録したものとともに名指しします。
- Plan Approval のフィンガープリントと明示的な承認。
- 候補の state 行。
- 転送可能な team audit シャード。

**信頼モデル。** claim 束縛の team シャードは、そのチーム自身の試行 keyed の `UNIT_COMPLETED`、team-gate、reviewer レシートを運ぶ場合があります。それらの行はチームの主張です。pin は必要な artifact とフィンガープリントを再検証し、人間が残りの信頼を pin された merge gate で review します。team シャードは、`HUMAN_TURN`、`MERGE_DISPATCH_*`、`UNIT_MERGED`、unit-merge gate、別の Unit のレシート、別の/新しい audit シャードを、決して運べません。claim した checkout は、pin が受け入れる行だけを claim のシャードに書き、それ以外に記録するもの（セッション、ターン、回答）は、intent record の `.aidlc-engine/audit/` 配下のローカルレコードに、すべての commit の外に留まるので、land の後の claim 者の pull はすべての行を保ちます。pin と land も、claim した Unit のサブツリーの外のワークフローレコードの変更を拒否します。Unit の record ツリーの外のプロダクトソースパスは、人間の重複判断のためにゲート証跡に見えたままで、チームが Unit を作る間に保ったルール（space の `memory/project.md` または `memory/team.md`）も同様で、それは Unit とともに main に land します。どの共有ファイルとも同様に、claim 以降に main が変えたルールファイル（別の Unit の保たれたルールが先に land した）は、land を止めます。main に rebase し、また publish し、また pin してください。

claim が release/re-claim されるか、ref が pin の後に動くと、gate と land のコマンドは拒否します。`pin` をまた走らせ、新しい OID を明示的に review してください。レジストリに到達できない場合、gate と land は、pin が tombstone されていないことを証明できないため、fail closed します。

### 2. merge gate を提示する

pin の出力は merge gate（`merge_gate`）を運びます。質問、その strategy と target、各回答を記録するコマンドです。エージェントは、pin 自身のターンで一度それを尋ねます。pin された Unit は、pin が fetch した integration ブランチへの通常の merge（strategy `merge`）で land するので、review された OID が直接の親になります。それは人に選択として問われず、チームの merge 既定（出荷の `org.md` では squash）が、ほかのすべての merge で保たれます。pin の後の人の返信が、ゲートが記録する回答です。

integration lead は、証跡サマリーと pin された OID を人間に提示し、それから回答を記録します。返信は、pin のゲートコマンドが名指しするファイルに入り、エージェントのファイルツールで書かれるのでシェルが読まず、ゲートはそこから読みます:

```bash
aidlc unit gate payments \
  --decision approve \
  --request-file aidlc/.aidlc-request-text/gate-payments.txt
```

承認の出力は land コマンドを名指しし、それ以上の質問無しで同じターンで走ります。却下は候補を merge されないまま保ちます。`Merge-Held: true` を運ぶ候補は、チームが HOLD-MERGE の手順を解消し、また publish し、main が re-pin するまで拒否されます。

### 3. Land

```bash
aidlc unit land payments --target main
```

land は順序付けされ、resume 可能です:

1. **まず Git コンテンツ。** integration ブランチを re-fetch し、承認された Unit の Unit DAG 内のエントリ、その kind、active なステージ列、証跡がまだ最新であることを検証し、それから pin された OID を merge します。contract のドリフトは mutation の前に拒否し、rebase、republish、re-pin、新しい merge gate を要します。main の `aidlc-state.md`、runtime graph、カーソル、engine マーカーは保たれます。チームの新しい audit シャードと Unit ごとの artifact/ソースが land します。本物のソース衝突は、クリーンな checkout に abort で戻り、ファイルを列挙します。共有ファイルのクリーンな自動 merge も、その結果が pin された候補と異なるとき拒否されます。rebase して republish してください。Unit 行は 1 つも fold されていません。Unit は、それが依存するすべての Unit が land した後にだけ land します。
2. **State fold。** intent ごとのロックのもとで、候補の転送されたレシートを導出し、main の singleton とほかの行を保ちつつ merge された Unit 行を書き、それから `UNIT_MERGED` を発行します。
3. **Audit/finalize。** main の state と merge lifecycle の行を commit し、それからローカルトランザクションを完了と記します。

Unit を claim した checkout が land した main を pull すると、それはもうその Unit に束縛されません。そのレコードは Unit が merge されたと示し、その履歴は merge された claim を保つので、`/aidlc`、pin、次の claim が、main 上と同様にそこで動きます。

recovery のためにステップを個別に駆動できます:

```bash
aidlc unit land payments --step git
aidlc unit land payments --step state
aidlc unit land payments --step audit
```

各ステップは冪等です。`merge-status` がローカルトランザクションを示します:

```bash
aidlc unit merge-status payments
```

land した target ブランチを push して、ほかのチームと将来の claim チェックが新しい integration の state を観測できるようにします:

```bash
git push origin main
```

依存するものは、merge された行から claim 可能になります。最後の行が merge された後、Unit ごとのブロックが落ち着き、main は Build and Test (3.6)、それから CI Pipeline (3.7) を、solo の Construction とまったく同じようにルーティングします。

---

## Dispatcher、status、ヘルスチェック

scope 無しの main では、team の fan-out が active な間、`/aidlc` は turn-terminal な dispatcher です。1 つの決定的なボードをそのまま描画します:

- Unit Progress。owner、ステージ/ゲートごとのセル、merge された state を含みます。
- ローカルの claim スキャン。owner、試行 generation、**観測された ref の活動**を含みます（git の ref は push タイムスタンプを運びません）。
- merge gate または land の recovery を待つ pin された候補。
- claim 可能な Unit と、依存でブロックされた Unit。

同じボードを読み取り専用のスナップショットとして見るには、main または任意の scope 付き checkout から `/aidlc --status` を走らせます。fetch を行わず、state・キャッシュ・audit 行を書きません。明示的な space/intent セレクタは、status ヘッダー、Unit DAG、claim、merge ジャーナルを 1 つの identity に保ちます。ボードは、次の claim、gate、`aidlc unit land` の recovery コマンドを名指しします。現在 claim 可能な Unit の無い参加者は、main の solo walk に落ちる代わりに、この terminal なボードを受け取ります。release された claim 履歴だけでは fan-out は active のままになりません。ライブの claim も未完了の merge トランザクションも残っていないとき、main は通常の Construction walk を再開します。

新しい clone が複数の intent を持ち、active-intent カーソルが無いとき、picker は混在した team workspace に、`team construction, 2 units claimable` や `parked at code-generation` のような status を注記します。終わった intent は、続けるものが何も無いので、どの workspace でも picker から外されます。`/aidlc intent list` はなおそれらを示します。ほかのすべての作業は、どこにいるか（`at Requirements Analysis`）とともに列挙されます。そこでの素の `/aidlc` や `/aidlc --resume` は、常に尋ねます。作業が無いとは決して答えません。

`/aidlc --doctor` は、ローカルのみの claim 調停を加えます:

- release/supersede された試行で、checkout の stamp がまだ残っているものは、修正の要る stale-stamp の findings です。
- 既知の観測タイムスタンプを持つが 24 時間 ref の動きが観測されないライブの claim は、anomaly です。release は明示的な人間の判断のままです。
- 観測タイムスタンプの無いアップグレード前のキャッシュは、誤った inactivity の findings ではなく baseline の advisory を受けます。
- intent id がローカルにもう存在しない claim ref は、orphan の findings です。

Doctor は、claim を決して fetch も release もしません。

---

## Release、salvage、resume

チームが仕上げられない場合、integration lead が scope 無しの main から claim を release します:

```bash
aidlc unit release payments
```

release は generation を上げる tombstone を publish します。古いレシートは履歴に残りますが、後続や merge を認可できません。後続の新しく claim した checkout に cherry-pick するかコピーして、有用なソース/artifact を保ってください。

1 つの狭い競合には、明示的な recovery があります。review された merge commit がすでにローカルに land し（`land --step git`）、その正確な試行がその後 release された場合、land した commit を調べ、fold の前に人間の了承を記録します:

```bash
aidlc unit land payments --accept-released-attempt \
  --user-input "I inspected the landed commit and accept completing this tombstoned attempt"
```

これは、predecessor が pin された OID である直近の tombstone に対してのみ、state fold の前に受け入れられ、後続の claim には決して受け入れられません。ジャーナルと main の audit が、tombstone と了承を記録します。

事前の release/re-claim の後、意図的な 2 回目の release は、現在の nonce に束縛します:

```bash
aidlc unit status
aidlc unit release payments --expect-nonce <nonce>
```

claim した checkout は、ネットワークアクセス無しで、ローカルの stamp とディスクの証跡から resume します。新しいチームメイトの checkout は、正確な claim ブランチで `aidlc unit adopt <unit>` を一度使わなければなりません。claim、adopt、publish、pin の前に pull/fetch してください。通常の scope 付き `/aidlc` resume は、レジストリを要しません。

---

## 2 日間のワークショップの歩み

### Day 1

1. ファシリテーターがグループと Inception を走らせます。
2. 有効なら、ファシリテーターが main 上で walking skeleton を作って gate し、それから main を push します。
3. Alice が `billing` を claim し、Bob が `notifications` を claim します。
4. 各チームが scope 付き 3.1-3.5 連鎖と team gate を走らせます。
5. 各チームが commit し、`aidlc unit publish` を走らせます。

### Day 2

1. ファシリテーターが Alice の候補を pin し、その証跡を review し、merge gate を記録し、land します。
2. main が push され、`billing` に依存するどの Unit も claim 可能になります。
3. ファシリテーターが Bob の pin された候補について pin/gate/land を繰り返します。
4. 最後の行が merge されると、main 上の `/aidlc` が Build and Test、それから CI Pipeline をルーティングします。
5. グループが、結合された audit シャードの `UNIT_MERGED`、gate、reviewer の行を review します。

チームは main への push を争いません。候補の ref は、claim 束縛の CAS publication を通じてのみ動けます。main が、review された pin された OID を直列化します。

---

## 関連する読み物

- [Facilitator Guide](facilitator-guide.md) - 準備完了チェック、付随タスク向けの scope、リカバリー手引き、各 harness がワークフローをどれだけ強く強制するか
- [CLI Commands](12-cli-commands.md) - claim、publish、pin、gate、land
- [State and Audit](10-state-and-audit.md) - clone ごとのシャードと merge されたレシートの下限
- [Construction](../reference/04-stages/construction.md) - Unit-major のルーティングと gate リズム
- [Runtime Graph](../reference/13-runtime-graph.md) - 別個の solo/swarm Bolt merge 経路
- [Branching Strategies](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) - merge-dispatch strategy の選択

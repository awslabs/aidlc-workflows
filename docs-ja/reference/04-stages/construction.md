# Construction フェーズ -- stage リファレンス（3.1-3.7）

## フェーズの概要

Construction フェーズは、Inception の design アーティファクトを、動作しテストされたソフトウェアに変換します。
functional design、非機能要件と design、infrastructure design、コード生成、build/test の検証、CI パイプライン
設定にまたがる 7 つの stage（3.1 から 3.7）を扱います。

Construction は、AI-DLC 方法論の 5 つのフェーズの 4 番目です。コンパイル済みの scope グリッドが、どの stage を
実行しどれを skip するかを決めます。runtime の Unit batch は `unit-of-work-dependency.md`（stage 2.7）から
来ます。Delivery Planning（Stage 2.9）は、承認された Bolt plan を生成します。計画の内容であり、walk の
ソースではありません。

すべての stage は、承認 gate、質問フォーマット、完了メッセージ、状態追跡について `stage-protocol.md` に
従います。

> **パスの規約。** 各ワークフローのアーティファクトは、その **intent record ディレクトリ** 配下にあります。
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` です（`<space>` は非デフォルトの space が使われていない
> 限り `default`、`<YYMMDD>-<label>` は intent ディレクトリで、レコードが時系列でソートされるよう `260624` の
> ようなコンパクトな UTC 日付の接頭辞と短い kebab-case のラベルです）。以下、`<record>/` はそのディレクトリの
> 省略形です。例: `<record>/construction/{unit-name}/functional-design/` は
> `aidlc/spaces/default/intents/<YYMMDD>-<label>/construction/{unit-name}/functional-design/` に展開されます。
> ディレクトリ名は人間が読めるラベルで、正準の同一性は `intents.json` レジストリ行に保存された UUIDv7 です。
> （intent ごとのレイアウトより前に作成されたプロジェクトはフラットなツリーを使っていました。engine が初回
> 実行時にそれらを移行します。）

---

## Construction の walk

[Bolt](../../guide/glossary.md) は、Delivery Planning で記録される計画されたデリバリースライスです。
Definition of Done、confidence 仮説、所有関係を持つ 1 つ以上の Unit です。runtime の順は、`bolt-plan.md` の
グループ化ではなく、`unit-of-work-dependency.md` と記録された iteration の選択に従います。

Unit の分解と scope 内のソース生成の unit ごとの stage を含む新しい単独ワークフローは、
`Construction Checkpoints: enabled`、`Construction Iteration: unit-major`、`Construction Execution: serial` に
デフォルトします。1 つの Unit の該当する design とソース生成の stage を、次の前に完了します。明示的な
stage-major の選択は保ちます。design のみと Unit なしのワークフローは、その既存の stage フローを保ちます。
team が所有する作業は `unit_gate` を使います。checkpoint 設定のない既存のワークフローは、レガシーの最初の
stage の review を保ちます。その後の stage 承認は、checkpoint がオフの作業のものと同じく、1 つの質問として
来ます。

skeleton-on の適格な checkpoint 作業では、最初の DAG Unit が最小の動作する統合スライスです。stage-major が
選ばれていても、後の Unit の前に、Code Generation を含むその該当する stage を完了します。その実際の端から
端までのプロジェクトチェックが通り、人間がその検証された skeleton を承認しなければなりません。レガシーの
最初の Construction stage の承認は stage の review にすぎず、統合 skeleton が構築されたことを確立しません。

すべての Unit/batch の checkpoint は、intent の記録された、人間が認可した `Construction Verification Command` を
再利用します。Delivery Planning が、プロジェクトのスキャンからそれを提案します。コマンドを提示する前に、
ハーネスのファイル書き込みツール（Write/edit）で `<record>/verification-command.txt` にそれを書きます。
シェルの `echo` や heredoc は決して使いません。リポジトリ由来のコマンドテキストは、置換が承認の前に実行され
得るシェル行に決して差し込みません。`log decision` と `log answer` の両方が
`--checkpoint verification-command --command-file verification-command.txt` を取り、実行されるセッションを
見つけます。`decision` ツールの JSON 出力の `command` フィールドから、完全な正準コマンドを正確に
verification-command 質問のコードスパンにコピーします。決して省略しないでください。コマンドの
バッククォートを保つ区切りを選びます。人間は `<record>/verification-command.txt` も開けます。正準コマンドは、
最大 1024 文字の非空の 1 行です。制御文字と表示を偽装する文字（ゼロ幅や bidi 制御を含む Unicode フォーマット
文字、行/段落の区切り、no-break space U+00A0）は拒否されます。人間の **Approve** / **Request Changes** の
返信は、尋ねたチャットで、またはそれが最新に尋ねられた質問である間は新しいチャットで、回答を保留中の
コマンドにバインドします。**Approve** だけが receipt を認可します。無関係な返信、**Request Changes**、別の
質問への返信はしません。人間が選んだのでない限り `--details "Approve"` を決して書きません。それがあって
初めて、対応する Runtime State フィールドを書くために
`state set-construction-verification-command --command-file verification-command.txt` を実行します。実行可能な
チェックがまだ存在しないとき、人間は先送りできます。最初の checkpoint がその後尋ねます。フィールド単独では
なく、現在の承認 receipt が実行を認可します。それを変えるには新しい receipt と型付きの setter が必要で、
汎用の `state set` や自動的な選択は決して使いません。

skeleton-off は Construction 入場時に **Continue automatically** / **Review each checkpoint** を提示します。
skeleton-on は本物の skeleton checkpoint の後にそれを提示します。記録された選択のない出力された提示だけが
自動で促します。オンデマンドのリクエストは、Construction 中に選択を変えられます。回答は通常の完了質問を
制御します。Plan Approval、verification command の選択、有効な summary confirmation、失敗したチェックの成功
検証を、認可することは決してありません。

```text
Eligible new source-producing solo Unit workflow:
  Default: unit-major + serial + verified Unit checkpoints
  Skeleton-on: first whole integrated Unit → real check → human approval
  When offered: Continue automatically / Review each checkpoint
  Remaining Units: applicable stages → checks → completion per recorded policy
  Completion-only stage directives: bookkeeping over recorded Unit approvals

Existing, design-only, no-Unit, or team-owned workflow:
  Preserve its recorded path and applicable stage or Unit-gate policy

After the per-unit work:
  Build and Test, then CI Pipeline if included, run once across the solution
```

**汎用の body の前に checkpoint をルーティングする。** `construction_checkpoint` directive は、既存の Unit
作業を検証して承認します。Code Generation を再実行しません。それが `rereview` を運ぶとき、その review
リクエストを尋ねずに直ちに実行し、その後検証して 1 つの承認質問を尋ねます。`rereview` は 3 つのケースの
1 つを指名します。Unit のコードや文書が完了した review 以降に変わった、Unit 自身の review が完了して
いない（`unfinished`: まだ verdict なし、またはパスの残る NOT-READY）、または、この Unit の作業の実行で
一度も求められなかった（`first`）です。完了した review の後の変更を再チェックするのは Guard Policy
`strict` だけです。`relaxed` と `off` では、その変更が 1 行とともに受け入れられ、Unit の承認が立ち、未完了
または未依頼の review は依然として指名されます。review がオフでも同じです。その行は、次の checkpoint の
`verify`、Construction stage 自身のチェック、または、承認質問とその人の回答の間に行われた変更には、その
`approve` から来ます。`command_authorized: false` では、どの `verify` よりも前に verification-command 質問を
尋ね、人間の decision/answer/setter のフローを完了し、その後 `next` を呼びます。承認質問に
「Verified with `<full command>` (exit 0)」を見せます。`verification_command` は完全な正準の記録された
コマンドで、省略されたラベルではありません。`swarm_checkpoint` は、後の batch 作業の前に完了した batch を
扱います。検証、承認、reject の後、`next` を呼びます。1 つの Unit や batch のために stage 全体を承認しては
いけません。`verify` が `verified: true` を報告し、現在の checkpoint が `ready: true` を持った後に初めて、
`aidlc engine bolt checkpoint --action ask --unit "<unit>" --kind <unit|skeleton>` で人間の Unit/skeleton
承認質問を開きます。`ask` は、ready でないまたは未検証の checkpoint を拒否します。人間の batch 質問には、
status が `ready: true` を報告した後に初めて、`aidlc engine bolt swarm-checkpoint --action ask --batch <N> --units "<Units>"` を
実行します。Unit の `ask` が `earlier_reply` を返すとき、Unit の review が実行される間にその人がこのチャットで
既に答えています。質問を見せず、その語が選んだとおりに `approve` または `reject` を実行します。その語が何も
答えないときは、質問を見せて待ちます。そうでなければ **Approve** / **Request Changes** を提示して待ちます。
この checkpoint 質問への人間の返信は、conductor がそれから読むアクションを認可します。そのチャットで、
または新しいチャットで、です。自身の質問を持たない新しいチャットの返信は、別のチャットが尋ねた checkpoint
質問のために、それが最新に尋ねられた質問でまだ開いている間、保たれます。無関係な返信、agent 自身の語、別の
質問への返信はしません。これらのコマンドはそれ自身のセッションを見つけます。人間が選んでいない `--user-input` を
決して渡しません。同意はワンショットで、現在の checkpoint の fingerprint、verification proof ID、認可された
コマンドのダイジェストにバインドされます（batch 質問は fingerprint と Unit ごとの `Command SHA-256` の集合を
バインドします）。`verify` または swarm の `finalize` を再実行すると、この intent の開いたすべての checkpoint
質問と、捕らえた checkpoint の応答が、どのセッションでも取り下げられます。再検証し、`verified: true`
（batch: source landing 後の `ready: true`）を確認し、再び尋ねます。より古い応答が新しい証跡を承認する
ことはできません。自動承認（`human_required: false`）は `ask` も `--user-input` も必要としません。人間の
拒否は常にこの検証済みの質問と回答のフローを必要とします。

`construction_policy.completion_only: true` かつ `human_completion_required: false` の stage は、body、質問、
reviewer、learnings の促しを skip し、その後、創作されたユーザー入力なしで `awaiting-approval` と `approved` を
報告します。他の完了 gate は `human_completion_required` に従います。ポリシーのないレガシーパスは、その
既存の人間 gate の手順を保ちます。

Version-4 の checkpoint proof は、コマンドの `command_sha256` と完全な正準コマンドを `command_label` に、
加えて exit status、stdout/stderr の完全なバイト数と SHA-256 ダイジェスト、各ストリームの最後の 2 KiB を
`stdout_tail` と `stderr_tail` に保持します。これらの tail は checkpoint CLI の JSON にも現れます。先頭の
部分的なマルチバイト列を落とした後 UTF-8 としてデコードされ、改行とタブ以外の制御文字は U+FFFD に置き換え
られます。完全な出力は保持されません。プロジェクトチェックのコマンドは秘密を出力してはなりません。tail は
秘密を黒塗りしません。失敗を説明するのに tail を使います。さらなる診断は、新たに選んだコマンドではなく、
同じ認可されたプロジェクトチェックを使います。レガシーの version-1 から version-3 の proof は、Unit が承認
できる前に `aidlc engine bolt checkpoint --action verify --unit "<unit>" --kind <unit|skeleton>` での再検証を
必要とします。`GATE_APPROVED` は `Verification Command SHA-256` を proof のダイジェストにバインドします。
verifier は proof ファイルの横にツールが所有する `CHECKPOINT_VERIFICATION_RECORDED` receipt を記録し、承認は
その receipt を必要とします。手書きの proof ファイルは Unit を検証できません。proof ファイルがまったくない
チェックアウト（まっさらな clone、別のマシン）では、その receipt が、証跡が変わっていない承認済みの Unit の
proof の代わりになるため、何も再実行されません。

`plan_approval` がオンの間、Code Generation の Plan Approval は、すべての Unit について生成前の人間の停止の
ままです。Grouped Plan Approval は、正確なライブの swarm Unit 集合を一緒に提示できますが、個別の receipt は
やはり記録します。生成前の summary confirmation は、`directive.ceremony.summary_confirmation === "on"` の
ときだけ必要です。checkpoint と承認のコマンドについては
[Construction commands](../../guide/12-cli-commands.md#construction-order-and-execution) を参照してください。

**iteration と実行は別物です。** unit-major は serial です。適格な checkpoint 作業に対して明示的に swarm を
選ぶには、stage-major を選び、その後 `Construction Execution: swarm` を選びます。guided と automatic の完了が
両方サポートされます。autonomy の回答は、実行や iteration の順を変えません。既に承認された inline の Unit が、
後の swarm によって再構築されることはありません。execution 設定のないレガシーワークフローは、その既存の
autonomy ベースの swarm ルートを保ちます。

**team が所有する gate。** `Unit Ownership: team` では、`per-stage` のリズムが、その Unit が前進する前に、
settle された各 `(stage, Unit)` を gate します。`unit-end` は、その最後の該当する unit ごとの stage の後に
一度 gate します。これらは単独の checkpoint ポリシーとは別のままです。engine は `Unit Progress` を更新し、
各 gate の report はその Unit を指名するため、decision と receipt の床はその作業にスコープされたままです。

team モードの claim は、compare-and-swap の更新で `claim/<intent-id8>/<unit>` の ref を使います。成功した
claim は gitignore されたチェックアウト stamp を書きます。そのチェックアウトは stamp された Unit だけを
ルーティングし、ライフサイクル、review、gate、fork の証跡に claim 世代を運びます。scope のない main は、
claim がライブの間、終端の fan-out notice を出力します。`aidlc-unit.ts release <unit>` は、ref を削除する
代わりに tombstone を書き、履歴を保ちつつ stale な試行を無効にします。参加者の clone は、
`aidlc-unit.ts participate` で一度 guided claim picker にオプトインします。facilitator main はそのマーカーを
あえて省きます。スコープされたルーティングと receipt の書き込みは offline-first です。claim 時の stamp が
権威あります。レジストリの liveness は、fork/release のような claim に敏感な境界でのみ再チェックされます。
利用できないリモートは警告して stamp から進みます。オンラインの stale または release された試行は拒否
されます。

完了したチームはコミットして `aidlc unit publish <unit>` を実行します。scope のない main はその後、正確な
claim-ref の OID を pin し、worktree を materialize せずにそのアーティファクト/receipt/gate/review と Plan
Approval を検証し、1 つの人間マージ gate を記録し、`aidlc unit land` を通して候補を land します。Git の内容は
Unit の行が fold される前に land します。main が所有する state/runtime のマーカーは保たれ、チームの新しい
audit shard がその attempt でキー付けされた receipt を運び、`UNIT_MERGED` が行を印します。ソースの衝突は
state の mutation の前に abort します。最後にマージされた行の後、Build and Test と CI Pipeline が main で一度
ルーティングされます。

**unit ごとの batch wave（オプション、stage-major のみ）。** 記録された stage-major のパスで、engine は
4 つの inline design stage（3.1–3.4）の 1 つに対して `directive.wave` を出力することが *あります*。wave は
1 つの healed な DAG スナップショットから来ます。conductor は `runtime-graph.json` を読んだり兄弟のパスを
導出したりしません。Code Generation（3.5、`workspace_requires: true`）は決して wave に適格ではありません。
並行する builder が共有ワークスペースへの書き込みで衝突するからです（swarm パスの unit ごとの worktree は、
まさにこの分離のために存在します）。そしてその初回の Plan Approval は、`plan_approval` がオンの間、どの実行
モードでも必須の停止です。engine のその人への質問は、builder の返却メッセージに畳み込めません。`plan_approval` が
オフ（express と poc がデフォルトで）だと、engine はそれを指名する 1 行の後に plan を書かれたとおりに構築し、
`PLAN_APPROVAL_SKIPPED` を記録します。`relaxed` または `off` の Guard Policy では、plan 再承認の fence は、
指示されていない作業に対して脇に置かれ、拒否する代わりに `GUARD_STOOD_ASIDE` を記録します。承認後、同じ
ターゲットと試行の内容編集は、下の Code Generation の effective-fence のルールに従います。下げられた fence は、
別の Plan Approval の停止なしに continuation を許します。

各エントリは、kind で解決された consumes、明示的な不在の consumes、すべての produces、該当する必須の部分集合、
Unit ローカルの日誌パス、build 状態、ペアになった review 状態、その wave 完了 receipt がまだ必要かどうかを
運びます。builder は、親の stage ファイル、inline コンテキストの名簿、警告、正確な累積したステアリングの
content を受け取ります。ブロックされた builder は、オプションや kind 免除のパスではなく、該当する必須の
パスを withhold します。build と review の後、`unit complete --wave` がライブのエントリを検証し `UNIT_COMPLETED` を
出力します。各 Unit のメモはそれ自身の日誌に留まります。engine は、該当するすべての Unit がその証跡を
すべて持つまで現在の batch を保ち、その後、依存する batch または単一の stage gate を許します。wave は
`Construction Iteration: unit-major` の下では決して適用されません。並列 dispatch のプリミティブのない
ハーネスは、エントリを serial に処理します。完全な契約については `stage-protocol-wave.md` の
§「Per-unit batch waves」を参照してください。

**並列 batch。** engine が出力する、依存の準備できた正確な Unit に従います。明示的な stage-major/swarm の
実行は、適格な Code Generation の Unit を並行して dispatch できます。checkpoint が有効なワークフローでは、
完了した各 batch が、後の作業の前に、guided または automatic の完了のための `swarm_checkpoint` を返します。
レガシーの swarm の settle は、その既存の stage gate を保ちます。`BOLT_STARTED` / `BOLT_COMPLETED` は、swarm
パスでは Unit/worktree ごとです。`SWARM_COMPLETED` が batch を閉じます。serial の inline の作業は、その Unit
ライフサイクルと checkpoint の receipt を使います。

各新しい Bolt worktree は、ブランチ `bolt-<id8>_<slug>` 上の `.aidlc/worktrees/bolt-<id8>_<slug>` です。intent
レジストリの UUID 接尾辞 `<id8>` は Unit claim と共有されるため、並列の intent は、ブランチや retained/parked
の ref を共有せずに Unit の slug を再利用できます。作成は、レジストリ UUID のない intent を拒否します。
Construction の前に intent を adopt または再作成します。命名と、アップグレード前のレガシー Bolt を古い形の
新しい Bolt を作らずに終わらせる provenance チェックについては
[Bolt identity](../../../core/knowledge/aidlc-shared/worktree-info-schema.md#bolt-identity) を参照してください。
cleanup は、別の worktree パスでチェックアウトされたブランチを拒否し、その所有者のブランチと ref を保ちます。

main のチェックアウトが初期化した submodule は、各新しい Bolt worktree でも、base が記録するコミットで、
main のチェックアウト自身のコピーから clone されて（ネットワークや認証情報なし）セットアップされます。
未初期化の submodule は空のディレクトリのままです。land は、そこのコピーにコミットされていない変更や、
main のチェックアウトのコピーが欠くコミットがあるとき、worktree を保ち、submodule を指名します。
committed-source チェックは、初期化された submodule を、ライブのソース walk がするように（そのコミットと
そのファイル）読むため、submodule を持つクリーンなチェックアウトは、それ自身の `HEAD` に一致します。

初回の保護された prepare の前に、すべての Unit が、現在の承認または許された承認後 continuation、加えて
コミットされ再現可能な親アプリケーションソースの read-only プリフライトを受けます。これはレガシー autonomy と
新しい checkpoint に適用されます。コミットされていない承認済みソースのスナップショットは、どの子が作られる
前にも拒否されます。それをコミットする明示的な認可を得て、その後リトライします。inline skeleton の承認済み
ソースは、後の並列 batch の前にコミットされなければなりません。prepare がそのコミットを自動で行うことは
決してありません。

`resume_existing: true` の reject された batch は `prepare --resume-existing` を使います。reject が先の承認を
退役させたなら、そのリビジョンの新しい Plan Approval を得ます。その承認の後のリトライは、同じ intent、
ターゲット、試行に対して lowered-fence の continuation を使えます。`execution_allowed: true` は `ok: false` でも
それを許し、より古い試行の承認を蘇らせません。生き残った worktree はソースを保持し、先のメタデータを
アーカイブします。ネイティブの source landing が子を削除したなら、必要な landing の証跡が存在するとき、
ツールは既に land された親のソースからそれを再作成でき、reject のリビジョンを保持します。マージ後のすべての
子の保存を約束するわけではありません。[Swarm prepare](../../guide/12-cli-commands.md#aidlc-engine-swarm-prepare-prepare-a-reproducible-batch) を
参照してください。

**失敗処理。** Code Generation の失敗は、autonomy のモードに関わらず常に Construction を halt します。
選択肢は retry（失敗した Unit だけを再実行）、skip（`[S]` と印して続ける。依存先も失敗する可能性がある）、
abort です。並列 batch の成功した兄弟は、その `[x]` の status とアーティファクトを保ちます。正準の手順は
`stage-protocol-checkpoint.md` と `stage-protocol-construction.md` の §「Halt-and-ask on failure」を参照して
ください。通常の失敗プロンプトの Abort は、worktree を保って Construction を一時停止します。`--discard` を
明示的に運ぶ stale-review recovery の abort は、代わりに追跡されたファイルと ignore されていない追跡外の
ファイル、reviewed されたソースの ref を park し、その後ライブのチェックアウトとブランチを削除します。人間の
選択を得た後、返された abort コマンドを変えずに実行します。存在するとき、abort 結果の `restore_operation` は、
route `worktree` と、保存された slug・stamp・リポジトリ（`--repo <name>` または `--repo .`）を選ぶ正確な引数、
その後にアクティブな intent が変わった後も recovery がその intent にバインドされ続けるよう
`--intent <record-dir-name> --space <space>` を持ちます。人間の restore リクエストでは、`{{INVOKE}} engine
worktree <args...>` を、一覧された各引数を別個の argv 引数として正確に渡して呼び出します。シェルコマンドに
決して結合しません。restoration は、新しいライブの Bolt を上書きしたり古い試行の review の権威を蘇らせたり
せずに、`restore/bolt-<id8>_<slug>-<stamp>` 上の `.aidlc/restored/bolt-<id8>_<slug>-<stamp>` にファイルを
復旧します。`restore_hint` は、実行の入力ではなく、オプションの人間向け表示テキストのみです。安全な
レンダリングが失敗すると、hint は省かれ、`restore_hint_error` が理由を説明し、操作は残ります。hint ではなく
操作に基づいて restoration を提示します。review の証跡だけが残ったなら、`evidence-only` の記述子には
restoration の操作、hint、hint エラー、除外がありません。作業ファイルは保存されず、restore は拒否し、doctor は
purge のみを提示します。[復旧の手順](../../guide/15-troubleshooting.md#a-bolt-attempt-was-set-aside-getting-the-files-back) が、
何が脇に置かれたか、除外、正確な restore の選択、情報提供の doctor の一覧と purge のオプションを説明します。
レガシーの restore は、レガシーの名前を保ち、選択された intent の正確な `WORKTREE_DISCARDED` の `Parked ref` の
provenance を必要とします。

---

## stage 要約テーブル

| Stage | Name                  | Execution   | Condition                                                                                          | Lead Agent          | Support Agents    | Mode                       | Per-Unit |
|-------|-----------------------|-------------|----------------------------------------------------------------------------------------------------|---------------------|-------------------|-----------------------------|----------|
| 3.1   | Functional Design     | CONDITIONAL | 新しいデータモデル、複雑なビジネスロジック、ビジネスルールの design が必要                             | aidlc-architect-agent     | aidlc-developer-agent   | inline                      | Yes      |
| 3.2   | NFR Requirements      | CONDITIONAL | 性能・セキュリティ・スケーラビリティ・信頼性・可観測性の要件が必要、または技術スタックの選択が必要 | aidlc-architect-agent     | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent   | inline                      | Yes      |
| 3.3   | NFR Design            | CONDITIONAL | NFR Requirements が実行され、NFR パターンの design が必要                                          | aidlc-architect-agent     | aidlc-aws-platform-agent| inline                      | Yes      |
| 3.4   | Infrastructure Design | CONDITIONAL | インフラサービスの対応づけが必要、デプロイアーキテクチャが必要、またはクラウドリソースが必要   | aidlc-aws-platform-agent  | aidlc-devsecops-agent, aidlc-compliance-agent   | inline                      | Yes      |
| 3.5   | Code Generation       | ALWAYS      | 実行計画のすべての unit で常に実行                                               | aidlc-developer-agent     | (none)            | subagent (aidlc-developer-agent)  | Yes      |
| 3.6   | Build and Test        | ALWAYS      | すべての unit ごとの stage が終わった後に常に一度実行                                         | aidlc-quality-agent       | aidlc-devsecops-agent   | inline                      | No       |
| 3.7   | CI Pipeline           | CONDITIONAL | CI パイプラインの作成や大幅な変更が必要なとき実行                                | aidlc-pipeline-deploy-agent| (none)           | inline                      | No       |

---

## Stage 3.1: Functional Design

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.1                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL（実行計画による）                                                                  |
| Condition         | 新しいデータモデル、複雑なビジネスロジック、ビジネスルールの design が必要。新しいビジネスロジックのない単純なロジック変更なら skip。 |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-developer-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | unit-of-work.md、unit-of-work-story-map.md、stories.md（生成された場合）、requirements.md、domain design のアーティファクト |
| Outputs           | `<record>/construction/{unit-name}/functional-design/` -- functional-spec.md、rules.md、entities.md、traceability.json、CONDITIONAL: frontend-components.md（Unit kind による） |

### 目的

単一の unit of work のビジネスロジック、ドメインモデル、ルールを設計します。aidlc-architect-agent が lead し、
aidlc-developer-agent が技術的な実現性の入力を提供します。

### Inputs

- `<record>/inception/units-generation/unit-of-work.md` からの unit の定義
- `<record>/inception/units-generation/unit-of-work-story-map.md` からの割り当てられた story
- `<record>/inception/user-stories/stories.md`（生成された場合）からのそれらの story の acceptance criteria
- `<record>/inception/requirements-analysis/requirements.md` からの requirements
- `<record>/inception/domain-design/` からの domain design のアーティファクト

### Steps

1. **Unit のコンテキストを読む** -- unit の定義、割り当てられた story とその acceptance criteria、requirements、domain design のアーティファクトを読む。

2. **Functional Design Plan を作成する** -- unit の scope を分析し、`[Answer]:` タグを使う文脈に適した質問を持つ質問ファイルを `<record>/construction/{unit-name}/functional-design/functional-design-questions.md` に作成する。焦点領域:
   - ビジネスロジックのワークフローとアルゴリズム
   - ドメインモデルとエンティティの関係
   - ビジネスルール、制約、検証ロジック
   - データフローと変換
   - 他の unit や外部システムとの統合点
   - エラー処理とエッジケース（Standard と Comprehensive の深度では、product agent の `corner-checklist.md` に照らしてコンポーネントごとに掃かれる。requirements が既に settle した corner は引き継がれる）
   - フロントエンドコンポーネント（コンポーネント階層、props/state、インタラクションフロー、フォーム検証）
   - ビジネスシナリオ（端から端までのユーザーの旅路、happy/unhappy パス、並行性のエッジケース）

3. **回答を集めて分析する** -- stage-protocol.md の質問フローに従って回答を集める（対話モードの選択を提示、回答を集める、ファイルに書き戻す）。必須の曖昧さ分析を行う:
   - 曖昧な回答（「mix of」、「not sure」、「depends」、「probably」）を特定する
   - 回答間の矛盾を確認する
   - アーティファクト生成に必要な欠けた詳細を指摘する
   - 少しでも曖昧さが見つかれば: フォローアップの質問を作り、進む前に解決する

4. **アーティファクトを生成する** -- `<record>/construction/{unit-name}/functional-design/` に次を生成する:
   - **functional-spec.md**: unit のビジネスロジックの詳細なアルゴリズム、ワークフロー、データ変換、処理シーケンス、決定木
   - **rules.md**: decision rule、検証ロジック、制約、ポリシー、条件付きの振る舞い、ビジネス不変条件
   - **entities.md**: エンティティ、関係、データ構造、属性、ライフサイクル状態、エンティティ相互作用のパターン
   - **frontend-components.md**（CONDITIONAL -- unit がフロントエンド/UI を含むときのみ）: コンポーネント階層、props/state の設計、インタラクションフロー、フォーム検証ルール、API 統合点

5. **完了を準備する** -- unit の Functional Design のアーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

6. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact                 | 説明                                                              |
|--------------------------|--------------------------------------------------------------------------|
| functional-spec.md  | アルゴリズム、ワークフロー、データ変換、処理シーケンス、決定木 |
| rules.md        | decision rule、検証ロジック、制約、ポリシー、条件付きの振る舞い |
| entities.md       | エンティティ、関係、データ構造、属性、ライフサイクル状態   |
| frontend-components.md   | （CONDITIONAL）コンポーネント階層、props/state、インタラクションフロー、フォーム検証、API 統合 |
| traceability.json        | 各 story の acceptance criterion を Unit に対応づけたもの（stories.md がないときは story map の Unit の FR 行。story map がないときはすべての FR。sub-requirement を持つ要件はその `FR{n}.{m}` ID を通して）。それぞれが rules.md の `BRx.y` ルールへの `OK`、理由を伴う `N/A` または `Deferred`、または `GAP` |

Unit がどのファイルを得るかはその kind に従います。`ui` Unit は entities.md も rules.md も得ず、`ui` Unit
だけが frontend-components.md を得て、`packaging` Unit はそれらを 1 つも得ません。

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes

- 質問ファイルは、`<record>/construction/{unit-name}/functional-design/functional-design-questions.md` で stage アーティファクトと同じ場所に配置されます。
- frontend-components.md は、unit がフロントエンド/UI の作業を含むときのみ生成されます。
- すべての質問は tri-mode の対話フロー（Guide me / I'll edit the file / Chat）を使います。

---

## Stage 3.2: NFR Requirements

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.2                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL（実行計画による）                                                                  |
| Condition         | 性能・セキュリティ・スケーラビリティ・信頼性・可観測性の要件が必要、または技術スタックの選択が必要。NFR 要件がなく技術スタックが既に決まっているなら skip。 |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent                                       |
| mode              | inline                                                                                            |
| Inputs            | functional design のアーティファクト、requirements.md、RE のアーティファクト                                        |
| Outputs           | `<record>/construction/{unit-name}/nfr-requirements/` -- performance-requirements.md、security-requirements.md、scalability-requirements.md、reliability-requirements.md、observability-requirements.md、tech-stack-decisions.md、traceability.json（Unit kind による） |

### 目的

単一の unit について、性能、セキュリティ、スケーラビリティ、信頼性、可観測性、技術選択にわたる非機能
要件を定義します。aidlc-architect-agent が lead し、aidlc-devsecops-agent がセキュリティの入力を、
aidlc-compliance-agent が規制の入力を、aidlc-quality-agent がテスト容易性と測定可能性の入力を提供します。

### Inputs

- `<record>/construction/{unit-name}/functional-design/` からの functional design のアーティファクト（存在する場合）
- `<record>/inception/requirements-analysis/requirements.md` からの requirements
- `aidlc/spaces/<active-space>/codekb/<repo>/` からのリバースエンジニアリングのアーティファクト（存在する場合）

### Steps

1. **先行アーティファクトを読む** -- functional design のアーティファクト（存在する場合）、requirements、リバースエンジニアリングのアーティファクトを読む。

2. **NFR カテゴリを評価する** -- NFR カテゴリにわたって unit を分析する:
   - **Performance**: 応答時間、スループット、レイテンシ目標、リソース利用
   - **Security**: 認証、認可、データ保護、コンプライアンス要件
   - **Scalability**: 負荷処理、成長の見込み、スケーリング戦略
   - **Reliability**: 可用性目標、fault tolerance、disaster recovery、データ耐久性
   - **Observability**: 監視、logging、alerting、tracing の要件

3. **質問を生成する** -- 不明瞭な NFR 領域について、`[Answer]:` タグを使う質問ファイルを `<record>/construction/{unit-name}/nfr-requirements/nfr-requirements-questions.md` に作成する。定量化できる目標と具体的な制約に焦点を当てる。

4. **回答を集めて分析する** -- stage-protocol.md の質問フローに従って回答を集める。必須の曖昧さ分析を行う:
   - 曖昧な回答（「fast enough」、「highly available」、「secure」）を特定する
   - NFR 目標間の矛盾を確認する
   - 欠けた定量的な目標を指摘する
   - 少しでも曖昧さが見つかれば: フォローアップの質問を作り、進む前に解決する

5. **アーティファクトを生成する** -- `<record>/construction/{unit-name}/nfr-requirements/` に次を生成する:
   - **performance-requirements.md**: 応答時間の目標、スループット要件、レイテンシの予算、リソースの制約、ベンチマーク
   - **security-requirements.md**: 認証要件、認可モデル、データ保護、コンプライアンス、脅威の考慮
   - **scalability-requirements.md**: 負荷の見込み、スケーリングのトリガー、キャパシティ計画、データの成長、並行性の目標
   - **reliability-requirements.md**: 可用性目標（SLA/SLO）、fault tolerance 要件、backup/recovery、graceful degradation
   - **observability-requirements.md**: 監視要件、logging 標準、分散 tracing のニーズ、alerting の閾値、ダッシュボード要件、SLI/SLO の定義
   - **tech-stack-decisions.md**: 技術選択と根拠 -- 言語、フレームワーク、データベース、インフラツール、各選択の正当化

6. **完了を準備する** -- unit の NFR Requirements のアーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

7. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact                     | 説明                                                                |
|------------------------------|----------------------------------------------------------------------------|
| performance-requirements.md  | 応答時間、スループット、レイテンシの予算、リソースの制約、ベンチマーク |
| security-requirements.md     | 認証、認可、データ保護、コンプライアンス、脅威        |
| scalability-requirements.md  | 負荷の見込み、スケーリングのトリガー、キャパシティ計画、並行性         |
| reliability-requirements.md  | 可用性目標（SLA/SLO）、fault tolerance、backup/recovery           |
| observability-requirements.md | 監視、logging、tracing、alerting、ダッシュボード、SLI/SLO の定義    |
| tech-stack-decisions.md      | 各選択の根拠を伴う技術選択                       |
| traceability.json            | 各 inception `NFR{n}`（User Stories が実行されず story map が Unit の NFR 行を与えるときはそれら）をその `NFRx.y` ID に対応づけたもの、または該当しない理由を伴う `N/A` |

Unit がどのファイルを得るかはその kind に従います。scalability、reliability、observability の requirements は
`service` Unit 向けで、performance は `service` と `ui` の Unit 向けです。

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes -- NFR 粒度の拡張

この stage は **6 つの Markdown アーティファクト** と `traceability.json` を生成します。NFR Requirements に
2 ファイルだけを定義する upstream のリファレンスから拡張されています。より細かい粒度がトレーサビリティを
改善し、単一ドキュメントを過負荷にせずに関心ごとのレビューを可能にします。6 つのファイルは、performance、
security、scalability、reliability、observability を専用のアーティファクトに分け、技術選択の根拠のための
専用の tech-stack-decisions.md を加えます。

---

## Stage 3.3: NFR Design

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.3                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL（NFR Requirements が実行された場合のみ）                                               |
| Condition         | NFR Requirements が実行され、NFR パターンの design が必要。NFR Requirements が skip されたなら skip。 |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-architect-agent                                                                                   |
| support_agents    | aidlc-aws-platform-agent                                                                                |
| mode              | inline                                                                                            |
| Inputs            | NFR requirements のアーティファクト、functional design のアーティファクト                                           |
| Outputs           | `<record>/construction/{unit-name}/nfr-design/` -- performance-design.md、security-design.md、scalability-design.md、reliability-design.md、observability-design.md、logical-components.md、traceability.json（Unit kind による） |

### 目的

NFR 要件を具体的な design パターンとアーキテクチャの解決策に変換します。aidlc-architect-agent が lead し、
aidlc-aws-platform-agent がインフラとプラットフォームの入力を提供します。

### Inputs

- `<record>/construction/{unit-name}/nfr-requirements/` からの NFR requirements
- `<record>/construction/{unit-name}/functional-design/` からの functional design のアーティファクト（存在する場合）
- アーキテクチャの文脈のための `<record>/inception/domain-design/` からの domain design

### Steps

1. **先行アーティファクトを読む** -- NFR requirements、functional design のアーティファクト（存在する場合）、アーキテクチャの文脈のための domain design を読む。

2. **Design の質問を生成する** -- `[Answer]:` タグを使う文脈に適した質問を持つ質問ファイルを `<record>/construction/{unit-name}/nfr-design/nfr-design-questions.md` に作成する。焦点領域:
   - resilience パターン（circuit breaker、bulkhead、fallback 戦略）
   - scalability パターン（水平対垂直、データパーティショニング、caching の階層）
   - 性能の最適化（レイテンシの予算、スループット目標、リソース pooling）
   - セキュリティのアプローチ（defense in depth、zero trust、暗号化標準）
   - 可観測性のアプローチ（メトリクスと SLI/SLO の目標、構造化 logging、tracing の深さ、alerting の哲学、ダッシュボードのニーズ）
   - 論理コンポーネントの境界（サービスの分離、failure domain、blast radius）

3. **回答を集めて分析する** -- stage-protocol.md の質問フローに従って回答を集める。必須の曖昧さ分析を行う:
   - 曖昧な回答（「mix of」、「not sure」、「depends」、「probably」）を特定する
   - 回答間の矛盾を確認する
   - アーティファクト生成に必要な欠けた詳細を指摘する
   - 少しでも曖昧さが見つかれば: フォローアップの質問を作り、進む前に解決する

4. **NFR の解決策を設計する** -- 各 NFR カテゴリの具体的な解決策を設計する:
   - **Performance**: caching 戦略、クエリ最適化、connection pooling、async 処理、CDN の利用、lazy loading、ページネーション
   - **Security**: 認証フロー、認可モデル、暗号化（at rest と in transit）、入力検証、CSRF/XSS 保護、secrets 管理、audit logging
   - **Scalability**: 水平/垂直スケーリングのアプローチ、負荷分散、データパーティショニング/シャーディング、queue ベースの decoupling、stateless な設計
   - **Reliability**: circuit breaker、backoff 付きの retry ポリシー、health check、graceful degradation、failover 戦略、データレプリケーション
   - **Observability**: メトリクス収集戦略、構造化 logging の設計、分散 tracing アーキテクチャ、alerting ルール、ダッシュボード仕様、SLI/SLO 追跡、correlation ID の伝播

5. **アーティファクトを生成する** -- `<record>/construction/{unit-name}/nfr-design/` に次を生成する:
   - **performance-design.md**: caching アーキテクチャ、最適化戦略、リソース pooling、async パターン、性能の予算
   - **security-design.md**: 認証/認可アーキテクチャ、暗号化の設計、入力検証戦略、セキュリティヘッダ、コンプライアンスコントロール
   - **scalability-design.md**: スケーリングアーキテクチャ、負荷分散、データパーティショニング戦略、キャパシティの閾値、auto-scaling ルール
   - **reliability-design.md**: resilience パターン、circuit breaker の設定、retry ポリシー、health check の設計、failover 手順、backup 戦略
   - **observability-design.md**: メトリクス収集アーキテクチャ、構造化 logging の設計、分散 tracing 戦略、alerting ルールとエスカレーション、ダッシュボード仕様、SLI/SLO の定義、correlation ID の伝播
   - **logical-components.md**: 論理的なインフラコンポーネントのインベントリ -- サービス境界、failure domain、blast radius のマッピング、コンポーネントの分離戦略、共有リソースの特定。NFR パターンがどこに適用されるかのコンポーネントレベルのビューを提供することで、NFR design の判断と Infrastructure Design を橋渡しする。

6. **完了を準備する** -- unit の NFR Design のアーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

7. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact               | 説明                                                                     |
|------------------------|---------------------------------------------------------------------------------|
| performance-design.md  | caching アーキテクチャ、最適化戦略、リソース pooling、async パターン |
| security-design.md     | 認証アーキテクチャ、暗号化の設計、入力検証、セキュリティヘッダ        |
| scalability-design.md  | スケーリングアーキテクチャ、負荷分散、データパーティショニング、auto-scaling ルール  |
| reliability-design.md  | resilience パターン、circuit breaker、retry ポリシー、failover 手順      |
| observability-design.md | メトリクス、構造化ログ、tracing、alert、ダッシュボード、SLI/SLO の定義      |
| logical-components.md  | コンポーネントインベントリ、サービス境界、failure domain、blast radius のマッピング  |
| traceability.json      | Unit の NFR requirements の各 `NFRx.y` をその design 解決策に対応づけたもの   |

Unit がどのファイルを得るかは、NFR Requirements と同じく、その kind に従います。`spec` と `packaging` の
Unit は logical-components.md を得ません。

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes -- NFR Design 粒度

この stage は **6 つの Markdown アーティファクト**（5 つの NFR 固有の design と logical-components.md）と
`traceability.json` を生成します。NFR Design に 2 ファイルだけを定義する upstream のリファレンスから
拡張されています。logical-components.md アーティファクトは、NFR パターンがコンポーネントレベルでどこに
適用されるかを対応づけることで、NFR design と Infrastructure Design（Stage 3.4）の間の橋渡しとして働きます。

---

## Stage 3.4: Infrastructure Design

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.4                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL（実行計画による）                                                                  |
| Condition         | インフラサービスの対応づけが必要、デプロイアーキテクチャが必要、またはクラウドリソースが必要。インフラの変更がなくインフラが既に定義されているなら skip。 |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-aws-platform-agent                                                                                |
| support_agents    | aidlc-devsecops-agent, aidlc-compliance-agent                                                           |
| mode              | inline                                                                                            |
| Inputs            | NFR design のアーティファクト、domain design、functional design                                       |
| Outputs           | `<record>/construction/{unit-name}/infrastructure-design/` -- infrastructure-specification.md（deployment + services + CONDITIONAL shared）、monitoring-design.md、cicd-pipeline.md、traceability.json（Unit kind による） |

### 目的

単一の unit のインフラ、デプロイアーキテクチャ、監視、CI/CD パイプラインを設計します。aidlc-aws-platform-agent が
lead し、aidlc-devsecops-agent がインフラのセキュリティを保証し、aidlc-compliance-agent がデータ所在地と
規制の制約を確認します。

### Inputs

- `<record>/construction/{unit-name}/nfr-design/` からの NFR design（存在する場合）
- `<record>/construction/{unit-name}/functional-design/` からの functional design（存在する場合）
- `<record>/inception/domain-design/` からの domain design
- `<record>/construction/{unit-name}/nfr-requirements/` からの NFR requirements（存在する場合）

### Steps

1. **先行アーティファクトを読む** -- 文脈のためにすべての先行 design アーティファクト（NFR design、functional design、domain design、NFR requirements）を読む。

2. **Infrastructure の質問を生成する** -- `[Answer]:` タグを使う文脈に適した質問を持つ質問ファイルを `<record>/construction/{unit-name}/infrastructure-design/infrastructure-design-questions.md` に作成する。焦点領域:
   - デプロイ戦略（containerized、serverless、hybrid、multi-region）
   - compute/storage/networking（サイジング、トポロジー、レイテンシ要件）
   - 監視のアプローチ（メトリクス、logging、tracing、alerting の閾値）
   - CI/CD パイプライン（build stage、デプロイ戦略、ロールバック手順）
   - secrets 管理（vault、環境変数、ローテーションポリシー）
   - スケーリングポリシー（auto-scaling のトリガー、キャパシティの上限、コストの制約）

3. **回答を集めて分析する** -- stage-protocol.md の質問フローに従って回答を集める。必須の曖昧さ分析を行う:
   - 曖昧な回答（「cloud-based」、「auto-scale」、「standard monitoring」）を特定する
   - 回答間の矛盾を確認する
   - アーティファクト生成に必要な欠けた詳細を指摘する
   - 少しでも曖昧さが見つかれば: フォローアップの質問を作り、進む前に解決する

4. **Infrastructure を設計する** -- 4 つの領域にわたってインフラを設計する:
   - **Deployment Architecture**: compute モデル（コンテナ、serverless、VM）、networking トポロジー、storage 戦略、環境レイアウト（dev/staging/prod）
   - **Infrastructure Services**: データベース（種別、サイジング、レプリケーション）、cache（戦略、eviction）、メッセージキュー、検索サービス、CDN、DNS、ロードバランサ
   - **Monitoring & Observability**: メトリクス収集、log 集約、分散 tracing、alerting ルール、ダッシュボード、SLI/SLO 追跡
   - **CI/CD Pipeline**: build stage、test stage、deploy stage、環境昇格、ロールバック戦略、feature flag、アーティファクト管理

5. **アーティファクトを生成する** -- `<record>/construction/{unit-name}/infrastructure-design/` に次を生成する。内容を **表形式** に保つ（deployment、services、shared、monitoring は表）:
   - **infrastructure-specification.md**: コアなインフラ design。**Deployment** の表（compute、networking、storage、environments、IaC、サイジング）、**Infrastructure Services** の表（データベース、cache、messaging、統合、service discovery）、CONDITIONAL の **Shared Infrastructure** の表（unit をまたぐ共有リソース + 所有/アクセスの境界）を、すべて 1 つのドキュメントに
   - **monitoring-design.md**: NFR Design の observability-design 戦略を実装する監視。表形式で、メトリクス/KPI、alert、SLI/SLO、加えて log 集約と tracing の設定、ダッシュボード仕様
   - **cicd-pipeline.md**: パイプライン stage、build 設定、test 自動化の統合、デプロイ戦略（blue-green、canary、rolling）、ロールバック手順、環境昇格、CI/CD での secrets 管理

6. **完了を準備する** -- unit の Infrastructure Design のアーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

7. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact                       | 説明                                                               |
|--------------------------------|---------------------------------------------------------------------------|
| infrastructure-specification.md | Deployment（compute/networking/storage/environments/IaC）、infrastructure services、CONDITIONAL の共有リソース。表形式 |
| monitoring-design.md           | メトリクス、alert、SLI/SLO、log、tracing、ダッシュボード。可能なところは表形式 |
| cicd-pipeline.md               | パイプライン stage、build 設定、デプロイ戦略、ロールバック手順   |
| traceability.json              | インフラを必要とする各 `NFRx.y` design 判断を、そのリソースまたは設定に対応づけたもの |

Unit がどのファイルを得るかはその kind に従います。`spec` Unit はそれらを 1 つも得ず、`library` Unit は
cicd-pipeline.md と traceability.json のみを得ます。

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes -- Infrastructure Design の統合

この stage は **3 つの Markdown アーティファクト** と `traceability.json` を生成します。Deployment、
infrastructure services、共有リソースは、単一の表形式 `infrastructure-specification.md` に統合されました
（upstream のリファレンスの単一のインフラドキュメントに近い）。一方、`monitoring-design.md` と
`cicd-pipeline.md` は、下流の Operation stage がそれらを独立に消費するため（observability-setup が
monitoring を読み、deployment-pipeline が CI/CD の design を読む）、専用のアーティファクトのままです。
共有インフラは、複数の unit がリソースを共有するときだけ存在する、仕様の CONDITIONAL なセクションです。

---

## Stage 3.5: Code Generation

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.5                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS（unit ごと）                                                                                 |
| Condition         | 実行計画のすべての unit で常に実行する。                                             |
| Per-Unit          | Yes                                                                                               |
| Lead Agent        | aidlc-developer-agent                                                                                   |
| support_agents    | (none -- 集中した実装)                                                                  |
| mode              | subagent（Task ツールの subagent_type: aidlc-developer-agent）                                               |
| Inputs            | この unit のすべての先行 design アーティファクト                                                          |
| Outputs           | アプリケーションコード（ワークスペースルート） + `<record>/construction/{unit-name}/code-generation/` -- code-generation-plan.md、code-generation-questions.md、unit-test-instructions.md、code-summary.md、traceability.json、加えて engine が必要とする付随の source-manifest.json（Unit 作業のみ） |

### 目的

単一の unit of work のすべてのアプリケーションコード、テスト、設定を生成します。それを含むすべての scope の
すべての Unit で実行されます。infra は、そのコンパイル済みの plan が示すように、Code Generation も Build and
Test も実行しません。

```text
$ aidlc engine graph scope infra
workspace-scaffold
workspace-detection
state-init
practices-discovery
requirements-analysis
nfr-requirements
nfr-design
infrastructure-design
ci-pipeline
deployment-pipeline
environment-provisioning
deployment-execution
observability-setup
```

コードはワークスペースルートに書かれ、`<record>/` には決して書かれません。

### 重要なルール

- アプリケーションコードはワークスペースルートへ。`<record>/` には決して書かない。developer のそこでの唯一の変更は、各ステップを終えたときに plan のそのステップのボックスをチェックすることである
- Brownfield: ファイルをその場で変更する。`ClassName_modified.java` のような重複を決して作らない
- この作業が作成しなかった、プロジェクトに既にあるファイル（README、LICENSE、docs、configs）は、新しいプロジェクトでも、その人のものである。それらをそのままにしてコードをその周りに構築する。この作業自身の、何で構築したか・どう実行するかのメモは `code-summary.md` に、そのテストコマンドは既に `unit-test-instructions.md` にある。それらの 1 つを変えるのは、その人が頼むか、それなしでは作業が構築できない（brownfield では、作業が変えるコード）ときだけである。変更を plan に指名し、gate で一度言い、ファイルとその中で何が変わったか、そして戻り方があるときはそれだけを指名する
- test 自動化のために、対話的な UI 要素に `data-testid` 属性を加える
- この順で作業する: plan（Step 2）、Step 3（その人の Plan Approval。plan approval がオフのときはその 1 行の notice だけ）、generation（Step 4）、Step 5 のファイル、その後 review（directive が `reviewer` プロトコルモジュールを一覧するとき）と completion（Step 6）。review は終わった作業をチェックする。reviewer は Step 5 のファイルが存在する前に決して実行されない。directive が既に `plan_approval.status: "approved"` を運ぶとき（resume または継続された build）、ディスク上の plan と test instructions が承認されたものである。Step 2 と 3 を skip し、それらをそのまま構築する。承認された plan やその test instructions を決して書き直さない。その人が頼むときだけ変える
- Unit（`directive.unit` が存在する）には、review の前に、Step 5 で engine が必要とする付随の `source-manifest.json` を書く。この unit が作成・変更・削除したすべてのアプリケーションソースのパス（シェルコマンド、scaffolding、ジェネレータが書いたファイルを含む）を一覧する。Unit なしの作業は `source-manifest.json` を書かない
- NFR Requirements、NFR Design、Testing Contract の coverage の床からの測定可能な品質目標は、入力であり提案ではない。ステップを通すために、定義された目標（test や build 設定の閾値設定を含む）を決して緩め・下げ・無効にしない。代わりにギャップを表面化する。

### Inputs

- `<record>/construction/{unit-name}/functional-design/` からの Functional design（存在する場合）
- `<record>/construction/{unit-name}/nfr-requirements/` からの NFR requirements（存在する場合）
- `<record>/construction/{unit-name}/nfr-design/` からの NFR design（存在する場合）
- `<record>/construction/{unit-name}/infrastructure-design/` からの Infrastructure design（存在する場合）
- `<record>/inception/domain-design/` からの domain design
- `<record>/inception/units-generation/unit-of-work.md` からの unit の定義
- `<record>/inception/units-generation/unit-of-work-story-map.md` からの story map

### Steps

この stage は **2 部構成** です。planning の後に generation が続きます。

#### PART 1 -- Planning（Steps 1-3）

1. **すべての Unit アーティファクトを読む** -- 現在の unit のすべての design アーティファクト（functional design、NFR requirements、NFR design、infrastructure design、domain design、unit の定義、story map）を読む。

2. **Code Generation Plan を作成する** -- 各実装ステップのチェックボックスを持つ詳細な plan を `<record>/construction/{unit-name}/code-generation/code-generation-plan.md` に作成する。story から code step へのトレーサビリティを含める。各 plan ステップを、それが実装する user story に対応づける。

   `aidlc-testing-posture.ts render` を実行し、その完全な `## Testing Contract` JSON ブロックを plan に貼り付ける。resolver は org/team/project の Testing Posture セクションを追加的に読む。project の coverage や integration のメモは該当するが、team の方法論を消さない。矛盾するより狭い方法論は拒否される。

   contract は方法論固有の plan プロファイルを供給する:

   - **TDD** -- 該当するすべてのテスト可能なレイヤー（data、repository、ビジネスロジック、API、frontend）に対する Red/Green/Refactor。
   - **BDD** -- 観測可能な feature スライスの前の実行可能な behavior シナリオ、その後レイヤー横断の実装、green シナリオ、refactoring。レイヤーローカルな TDD には変換されない。
   - **ATDD** -- 完全なレイヤー横断の feature 実装の前の実行可能な acceptance test。その失敗出力を記録して実行し、その後 acceptance-green と refactoring。
   - **Custom/mixed** -- 追認された正確な順序が保たれる。シナリオ優先の BDD と実装後の下位レベルの unit test のような組み合わせを含む。
   - **Test-after** -- 該当するすべてのテスト可能なレイヤーに対して、実装の後に test。

   greenfield の plan は、最初の Red/シナリオ/acceptance ステップの前に、最小の実行可能な test コマンドを bootstrap する。brownfield の plan は、まず既存のコマンドを検証する。選択された Test Strategy が volume/types を供給し、scope がその床（coverage/CI、的を絞った regression、または追加の床なし）を加える。どちらの義務ももう一方を置き換えない。Minimal では、bug/security の的を絞った regression は、それが欠陥を再現する最も狭いレベルであるとき、1 つの integration/E2E test を加えることがある。

   **test ファイルは plan で必須である。** plan は次のステップを含まなければならない:
   - unit test ファイル（コンポーネント/モジュールごとに 1 つ、主要な behavior のカバレッジを伴う）
   - test 設定（vitest.config、jest.config、または同等物）

   plan が test ファイルのステップを省くなら、ユーザーに提示する前にそれらを加えなければならない。test は Build and Test に先送りされない。その stage は検証と拡張をするのであり、ゼロから作らない。

   明確な実行順序とトレーサビリティのために、各 plan ステップを順番に番号づける（Step 1、Step 2 など）。

   directive から 1 つの code-generation record ディレクトリを解決する。`directive.unit` が存在するときは `<record>/construction/<directive.unit>/code-generation/`、そうでなければ Unit なしの stage ディレクトリ `<record>/construction/code-generation/` である。Plan Approval の前に、そこに `unit-test-instructions.md` も作成する。アクティブな test 戦略に合わせる:
   - **Minimal**: 要件駆動の unit test（要件ごとに 1 test、コンポーネントごとに happy-path の床）、合計おおよそ 5-15 test
   - **Standard**: コンポーネントごとに 5-8 test、主要な behavior のカバレッジを伴う
   - **Comprehensive**: コンポーネントごとに 10-15 test、徹底的なカバレッジを伴う

   test フレームワークのセットアップと設定、最初の test-first サイクルの前に利用できる正確な実行可能コマンド、期待される coverage 目標、mocking/stubbing のガイダンス、test データ管理を含める。すべての実行コマンドは、正確な test ファイルのパスまたは正確な unit フィルタを使って、この unit にスコープされなければならない。`npm test` のような素のプロジェクト全体のコマンドは許容されない。Build and Test がすべての unit のコマンドを実行するからである。プロジェクト全体に設定された coverage の床は、これらのコマンドではなく、Build and Test が完全なスイートで測定する（1 つの Unit の test では、runner の閾値が他の Unit の test がカバーするソースで失敗し得る）。ファイルは床を指名し、Unit の実行を通すためにプロジェクトの coverage 設定の床の閾値を決して変えない。床の閾値が失敗し得るコマンドは、その後に閾値の exit が止めるステップを残さない。Build and Test は、その exit が後のステップを止めたコマンドを免除しないからである。Unit またはそのパスの 1 つに設定された coverage 目標は、それ自身の Unit スコープのチェックを得る。

   plan は、engine が承認を求めるときにその人に見せる短い `## Summary`（Builds、Touches、Tests の行）で始まる。

3. **Plan Approval** -- engine が尋ねる。両方のファイルが書かれると、conductor は `next` を実行する。準備できた plan（空でない plan と instructions、有効で現在の Testing Contract、読めるワークスペースソース）は、`next` に build の代わりに `plan-approval` ask を返させる。質問、各ターゲットの summary と plan のパス、そして **Approve Plan**、**Request Changes**、**I'll edit the files** である。engine は `code-generation-questions.md`（質問、両方のタグ、空の `[Answer]:`）を書き、質問を保護された runtime ディレクトリに記録する。conductor はそれを見せてターンを終える。human-turn hook は、質問の後のその人のすべての返信を、この作業上のどのチャットからでも保ち、打たれた語から何も選ばない（質問ボックスでの選択はホスト自身の構造）。conductor は、返信がどの質問に答えるか読み、`answer --checkpoint plan-approval` でその選択を記録する。それはそのときのファイルの fingerprint を取り、回答、receipt、その人の語を伴う `PLAN_APPROVAL_RECORDED` 行を書く。その人は代わりに、そのファイルが招くように、questions ファイル自身の `[Answer]:` 行に回答を書いてそう言える。engine は、同じ質問が立っている間、そこに書いた回答を決して上書きしない。どんな語でもそう言うとき（「done」、「I put my answer in the file」）、conductor はその行を読み、その人がした選択を記録する。行自体は何も承認せず、engine の receipt が承認する。質問が開かれたこのチャットでのその人のメッセージが、既に変更を求めている（「go back to code generation: also accept -S」。完了した作業でも、または 1 つの Unit のステップの変更を指名する redo）で、それが求めた redo または jump 以外のどの decision もそれを使っていないとき、conductor はそれをその質問の Request Changes として、その語とともに記録する（`--message` が読むように、メッセージ記録が証拠）。承認は依然として質問が見せられた後の返信を必要とし、改訂された plan の質問はそれ自身のものを必要とする。次の `next` は、`plan_approval.status: "approved"`（build）、`revise`（その人の語とともに）、`repair`（編集が壊した Testing Contract）、または `plan`（ファイルを仕上げる）を伴う run-stage を返す。edit モードでは、その人がファイルを変えるか questions ファイルに回答を書いて done と言い、conductor が書かれたものを読んでその選択を記録する。その間、guard は conductor のそれらのファイルへの書き込みを拒否する。準備できていない plan は決して尋ねられない。`next` は代わりに修復を指名する。

   同じターゲットと試行の承認後の plan、instruction、Testing Contract の編集は、Guard Policy `strict` では再び尋ねる。`relaxed` または `off` では、build は更新された内容で続く。元の証跡を保つ。編集された内容はそれで承認されたのではない。Testing Posture、scope、戦略、プロジェクトタイプの変更は、同じルールに従う。承認後の他のコードの移動は、どの Guard Policy でも再び尋ねない。build は、ファイルを指名する 1 つの `change_notices` 行とともに続く。`strict` の swarm は、その人自身のファイルについての例外である。prepare は plan が再び承認されるまで拒否し、source landing は、それが取り消されるか Guard Policy が `relaxed` になるまで同じ変更を拒否する。別の intent やターゲット、新しい試行、または実際の初回承認の欠如は、依然としてそれ自身の承認を必要とする。reject された gate（Code Generation の完了 gate、Unit checkpoint、または swarm batch checkpoint）の後、plan が以前に承認されたもののままである間、`next` はまずその gate からのその人の語とともに `revise` を返すため、続く質問は改訂された plan を見せる。`/aidlc --stage code-generation`（`Reopen: jump`）または Redo（`Reopen: redo`）を通してステップを reopen すると、新しい試行を始め、任意の編集を要求せずに、plan を現状について尋ねる。`Reopen: change` と gate の Request Changes は、依然としてその人のフィードバックとともに `revise` を返す。`next` の再実行、または同じターゲットと試行の再発行された directive は、それを決して reopen せず、その間に engine が言ったこと（圧縮したチャット、park されて resume された作業、guard-recovery の質問）もそうである。`next` は、それが置き換える directive ではなく、ルーティングされた directive が build する plan の承認を読む。forwarding-loop の continuation は決して承認ではない。

   `testing-posture verify` は、continuation が許されるとき、`ok: false` が現在の内容が承認されていないと言っても、exit 0 で `execution_allowed: true` を報告する。その実行結果を使う。`begin` と `brief` もそれを尊重する。
   わかりやすい `reason` は continuation を説明する。`approval_reason` は stale なバインディングの詳細を保ち、新しい承認の停止ではない。内容とソースの両方が変わったとき、read-only の `verify` は `change_notices` でソースの変更もプレビューする。generation の開始（guard dispatch と swarm の準備を含む）は、受け入れたソースの変更を記録・通知し、下げられた fence の下でソースの provenance を再ベースライン化する。元の承認の fingerprint、回答、session は変わらない。既存の委譲された worker は、その検証された親 intent のライブの fence に従う。後の下げや上げを含む。欠けたアーティファクト、または不正か構造的に不完全な Testing Contract は、実行の前に修復が必要で、自動的な新しい承認の儀式は不要である。`obligations.strategy` は `test_strategy` に一致しなければならない。`strategy_volume` と `scope_floor` の両方が非空の義務を含まなければならない。下げられた fence も、実行の provenance を必須のままにする。generation が始まる前に、バインドできないソース、または失敗した runtime/audit の公開は、操作をブロックする。その運用上の失敗を修復し、同じ承認と fence 設定でリトライする。有効な人間が発行した break-glass receipt は、その既存の source-binding の例外を保持する。作業ごとの fence を下げても、真の初回承認、実行可能なアーティファクト、現在のターゲット/試行の権威を置き換えない。直接の書き込みと developer dispatch は、どの generation の開始を公開する前にも、選択された各ターゲットを検証する。それらの実行要件が満たされない間、plan のレコードの修復は利用可能なままである。複数のターゲットを選ぶ dispatch は、開始全体にわたって generation 権威のロックを保持する。公開中にいずれかのターゲットが失敗するかソースが変わると、その dispatch が新たに始めた各 receipt が復元される。リトライはその後、現在のソースを再び確認する。元の承認と下げられた fence 設定は変わらない。

#### PART 2 -- Generation（Steps 4-7）

4. **Code を生成する** -- directive の `narration` は、この build のためのユーザーの行で、委譲の前に一度言われる。engine は plan ファイルから plan を数え、両方の行に対して一度である:
   開始時の「Generating unit-2's code for 9 plan steps. This may take several minutes depending on project complexity. I'll show a summary when complete.」、中断された build が引き継ぐところ（「Picking up unit-2's code at step 5 of 9 (1-4 done).」、コードが書かれていてステップが印されていないときは「Picking up unit-2's code: the plan marks none of its 9 steps done, checking what is built.」）。plan が「Step N」の見出しの下にタスクをグループ化するとき、両方の行はタスクを数えて見出しを指名する（「Generating unit-2's code for the 19 tasks in 4 plan steps ...」、「Picking up unit-2's code at task 7 of 19, in Step 3 (tasks 1-6 done).」）。agent は自らステップを数えない。

   aidlc-developer-agent subagent（subagent_type="aidlc-developer-agent"）で Task ツールに委譲する。

   **subagent に渡されるコンテキスト:**
   - まず、一字一句、`aidlc-testing-posture.ts brief --unit <unit>`（または `--stage-level`）の出力。その最初の行は正確なターゲットマーカー、unit 作業には `AIDLC-UNIT: <directive.unit>`、Unit なしの directive には `AIDLC-STAGE: code-generation`。その 2 行目は現在の plan からの `AIDLC-TESTING-CONTRACT: <contract_sha256>`。その fence がオンのとき、dispatch guard は欠けた・異なる・stale なハッシュを拒否する。文脈的な依存関係は追加のターゲットマーカーを受け取らない。
   - 現在の UNIT のみ（すべての unit ではない）の design アーティファクト
   - 各 inception フェーズのアーティファクトの、そのファイルパス付きの 1-2 行の要約（requirements の要約、stories の要約、domain design の要約）。subagent は完全な内容が必要なら特定のファイルを Read できる
   - 現在の plan と unit-test-instructions.md。その出力は既に approval-content の投影を使ってそれを運ぶ。終端の `## Review` 付録を取り除き、タスクマーカーをリセットし、間隔を正規化した plan、加えて instructions をバイト単位で。fingerprint は付録を除くため、それは実行すべき作業ではない。その fence がオンのとき、dispatch guard はそれを引用する handoff を拒否する。許された承認後の編集の後、編集を承認済みと呼ばずに現在のブリーフを使う
   - 同じ plan の build が中断されたとき、その出力はそのマーカー行の後に `## Progress before the interruption` セクションも運ぶ。plan ファイルがチェックするステップ（またはチェックがないときは、build が始まって以降その指名ファイルが変わったステップ）、done ステップがコードスパンで指名する、プロジェクトにない各ファイル（そのファイル名のファイルがどこかにあれば素のファイル名も数える）を、worker が判断する事実として述べ、続けるステップである。チェックも指名ファイルも何が済んだか言わないとき、build がコードを書き plan がそのステップのどれも印していないと言い、終わった各ステップをチェックするよう頼む。build が、現状の plan と instructions で既に始まったときだけ現れる（このターゲット、stage 試行、承認された内容の receipt が `generation` にあり、ディスク上の内容が承認された内容、または、fence が承認後に編集された plan のために下げられたときは、generation 開始がその receipt に保った編集された内容である）。Redo、reject された gate、新しい承認、または build が始まった後に編集された plan は、ステップを新たに始める。build が新しい承認の下で始まるとき、engine は plan ファイルのタスクマーカーを `[ ]` に戻す（ファイルの他は何も変わらず、fingerprint は同じ）ため、以前のチェックは決して数えない。swarm batch はそれ自身の continuation ルールを保つ。このセクションはヒントであり、gate、review、receipt の証跡では決してなく、チェックは fingerprint の外に留まる
   - プロジェクトのワークスペースの詳細（aidlc-state.md からの言語、フレームワーク、規約）
   - 各 plan ステップを順番に実行し、チェックボックスを完了と印す指示。その progress セクションがあるときはそれが言うところから始める
   - 現在のブリーフの Testing Contract が権威ある。subagent は独立に memory を再解決しない。その contract の TDD、BDD、ATDD、test-after、custom/mixed のプロファイルを正確に実行する。
   - NFR Requirements、NFR Design、Testing Contract の coverage の床からの測定可能な品質目標は、入力であり提案ではない。subagent は、ステップを通すために、定義された目標（test や build 設定の閾値設定を含む）を決して緩め・下げ・無効にしてはならない。代わりにギャップを表面化しなければならない。

   **コンテキスト予算:** すべての unit ではなく、現在の unit の design アーティファクトだけを渡す。inception のアーティファクトを、完全な内容を埋め込むのではなくファイルパスで要約する。subagent が、ワークスペースにすべてのコード、test ファイル、設定アーティファクトを生成する。

5. **Code Summary と Source Manifest を生成する** -- subagent の完了後、次を文書化する `<record>/construction/{unit-name}/code-generation/code-summary.md` を作成する:
   - 作成/変更されたファイル
   - 主要な実装の判断
   - test カバレッジの要約
   - plan からの逸脱

   Unit（`directive.unit` が存在する）には、`<record>/construction/<directive.unit>/code-generation/source-manifest.json` も作成する。これは、宣言された `produces[]` アーティファクトではなく、厳密な version-1 の JSON 付随ファイルである。`stage: "code-generation"`、正確な unit 名、unit が作成・変更・削除したすべてのアプリケーションソースのパス（シェル・scaffolding・ジェネレータが書いたファイルを含む）を含む `writes` 配列を記録する。パスは POSIX 相対で、glob や `..` を使わない。末尾の `/` は生成されたディレクトリツリーを claim する。main ワークスペースのマルチリポジトリの実行では、各エントリがその記録された `repo` を指名する。Bolt をホストする worktree の中では、パスはその選択されたリポジトリに対して相対で、`repo` を省く。

   stage ファイルはこの形を与える:

   ```json
   {
     "stage": "code-generation",
     "unit": "u1-auth",
     "version": 1,
     "writes": [
       { "path": "src/auth/login.ts" },
       { "path": "src/auth/generated/" },
       { "repo": "repo-a", "path": "src/api/routes.ts" }
     ]
   }
   ```

   engine はこのスキーマを検証し、それなしでは終端の unit ごとの review の記録を拒否します。そのバイトと
   claim は `Unit Source Fingerprint` に加わります。Guard Policy strict では、すべての新しい reviewed な
   manifest の外で変わった stage-source のパスは完了をブロックします。relaxed または off ではそれらは保たれ、
   Unit の外でどのファイルが変わったかがその人に一度告げられます。

   zero-Unit の directive（`directive.unit` が不在）は `source-manifest.json` を書かず、そのための Unit
   ディレクトリも作りません。engine は manifest を Unit についてのみ読み、zero-Unit の review は代わりに
   ワークスペースのソース全体をバインドします。その Step 5 のファイルは
   `<record>/construction/code-generation/code-summary.md` と
   `<record>/construction/code-generation/traceability.json` です。

6. **Review、その後 Completion を準備する** -- directive が `reviewer` プロトコルモジュールを一覧するとき、
   `stage-protocol-reviewer.md` のセクション 12a に従って、アーキテクチャ reviewer がまず終わった作業
   （plan、test instructions、code summary、traceability、そして Unit については `source-manifest.json` が
   claim するソースパス）をチェックします。review は、stage の `review_artifact` である `code-generation-plan` に
   対して記録されます。これは review がどこにファイルされるかを指すのであり、plan が構築される前の plan の
   review ではありません。Unit については、engine は Step 5 のファイルが存在するまで review リクエストを
   拒否します。その後、unit のコードと summary のアーティファクトを検証します。state を編集しません。
   gate の結果を `aidlc-orchestrate.ts` を通して報告します。

7. **完了** -- 完了メッセージと承認 gate を提示します。

### Outputs

| Artifact                  | 説明                                                                 |
|---------------------------|---------------------------------------------------------------------|
| code-generation-plan.md   | チェックボックス、story のトレーサビリティ、ステップ順を持つ詳細な plan  |
| code-generation-questions.md | 永続化された Plan Approval の質問と明示的な人間の回答              |
| unit-test-instructions.md | unit ごとのセットアップ、スコープされた実行コマンド、coverage、mock、test データ |
| code-summary.md           | 作成/変更されたファイル、判断、test カバレッジ、plan からの逸脱        |
| traceability.json         | 割り当てられた upstream ID の、コード/test ターゲットによる構造化されたカバレッジ |
| source-manifest.json      | engine が必要とする厳密な付随の attribution インデックス、Unit 作業のみ。あえて `produces[]` に入れない |
| （アプリケーションコード） | ワークスペースルートに書かれたすべてのソースコード、test、設定         |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes

- **2 部構成**: planning フェーズ（Steps 1-3）は、ユーザーとの対話と plan approval を伴って inline で実行
  されます。generation フェーズ（Steps 4-7）は、Task ツールを通して aidlc-developer-agent subagent に委譲
  します。これは、完全に inline で実行されるほとんどの Construction stage とは異なります。
- **Developer-agent subagent**: Code Generation は、inline 実行ではなく `subagent_type="aidlc-developer-agent"`
  を使います（Task ツールを通して委譲）。subagent を使う唯一の Construction stage です。aidlc-developer-agent は
  `tools:` の allowlist を宣言せず、`Task` を拒否します。
- **コンテキスト予算**: 現在の unit の design アーティファクトだけが subagent に渡されます。inception
  フェーズのアーティファクトは、subagent が必要なものを選択的に Read できるよう、ファイルパス付きの
  1-2 行で要約されます。
- **test ファイルの必須の組み込み**: test ファイルは Code Generation の plan の一部でなければなりません。
  Stage 3.6（Build and Test）は test を検証し拡張しますが、ゼロから作りません。
- **Source-manifest の強制**（Unit 作業のみ）: `source-manifest.json` は engine が検証するもので、Markdown の
  `required-sections` ターゲットではありません。その厳密なスキーマと `Unit Source Fingerprint` は、すべての
  exact/directory のソース claim をバインドします。engine は、それが不在または不正のとき終端の review を
  拒否し、Guard Policy strict では、新しい reviewed な claim の和集合の外で変わったソースについて stage の
  完了を拒否します。
- **Unit スコープの実行**: 各 unit ごとの test instruction ファイルは、exact な test パスまたは exact な
  unit フィルタを使うため、unit をまたぐ実行 stage がすべての unit についてプロジェクト全体のスイートを
  再実行しません。
- **Brownfield の認識**: brownfield プロジェクトでは、subagent は重複を作る代わりに既存のファイルをその場で
  変更します。

---

## Stage 3.6: Build and Test

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.6                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | ALWAYS（すべての unit の完了後）                                                                 |
| Condition         | すべての unit ごとの stage が終わった後に常に一度実行する。                                      |
| Per-Unit          | No（すべての unit について一度実行）                                                             |
| Lead Agent        | aidlc-quality-agent                                                                                     |
| support_agents    | aidlc-devsecops-agent                                                                                   |
| mode              | inline                                                                                            |
| Inputs            | すべての unit にまたがるすべての code generation の出力                                            |
| Outputs           | `<record>/construction/build-and-test/` -- build-instructions.md、build-and-test-summary.md、test-results.md。戦略依存（`optional_produces` の下で宣言）: integration-test-instructions.md（Standard 以上）、performance-test-instructions.md と security-test-instructions.md（Comprehensive、その NFR kind が存在するとき）、加えて他の CONDITIONAL な test instruction ファイル |

### 目的

unit をまたぐ test instructions を生成し、unit ごとの unit test instructions を消費し、その後 Bash を通して
実際に build と test を実行します。この stage はすべての unit にまたがって動作します。unit ごとではありません。
aidlc-quality-agent が lead し、aidlc-devsecops-agent がセキュリティテストの専門知識を提供します。

### Inputs

- `<record>/construction/*/code-generation/code-summary.md` からの、すべての unit にまたがる code generation の出力
- `<record>/construction/*/code-generation/unit-test-instructions.md` からの unit ごとの test instructions
- 各 unit の `nfr-requirements/` と `nfr-design/` ディレクトリ配下のすべての該当するアーティファクト
- stage レベルまたは unit ごとの `code-generation-plan.md` にある、すべての現在の `## Testing Contract`。
  これには、下げられた plan 再承認 fence が許した承認後の編集と、plan approval がオフで構築された plan を
  含みます。どちらも人間が承認したとは記述されません。CI の義務（contract の "Run the selected tests in CI
  before merge." の行、または memory ノートの "CI execution before merge"）は、plan が CI Pipeline を実行する
  とき（`ci-pipeline` が `aidlc-state.md` で `EXECUTE` と一覧され `[S]` でない）だけターゲットです。そうで
  なければその理由とともに `N/A` と記録され、決して失敗ではありません。CI Pipeline がまだ先にある（`[ ]`）
  間は、そのターゲットは CI Pipeline が満たすべきものです。Owning Stage `ci-pipeline` とともに `N/A` と
  記録され、plan の後の方にある CI Pipeline が、これらの test を merge の前に実行するよう CI をセットアップ
  するという理由を伴い、決して失敗ではありません

### Steps

1. **テスト要件を分析する** -- すべての unit にまたがる code generation の summary と unit ごとの test
   instructions を読む。NFR Requirements、NFR Design、すべての現在の Testing Contract からの、測定可能な
   すべてのターゲットの source-complete なインベントリを構築する。各ターゲットについて、安定した ID、
   ソースのパス/セクション、期待値、その実際の値を生むチェック、それを所有する後の validation stage があれば
   それを記録する。必要なすべての test 種別をカタログ化する。

2. **Build Instructions を生成する** -- `<record>/construction/build-and-test/build-instructions.md` を作成する:
   - 依存関係のインストール手順
   - 環境のセットアップ（env 変数、config ファイル、ローカルサービス）
   - build コマンド（compile、bundle、transpile）
   - build の検証手順
   - よくある build の問題のトラブルシューティング

3-7. **追加の Test Instructions を生成する** -- アクティブな test 戦略を参照し、一致する unit をまたぐ
   instruction ファイルを生成する:
   - **Minimal**: 追加ファイルを生成しない。unit test は Code Generation によって unit ごとにカバーされる。
   - **Standard**: 主要な境界と unit をまたぐ相互作用のための `integration-test-instructions.md` を生成する。
   - **Comprehensive**: integration の instructions に加えて、performance NFR が存在するとき
     `performance-test-instructions.md`、security NFR が存在するとき `security-test-instructions.md` を生成する。
   - どの戦略でも、プロジェクトの文脈が必要とするとき、具体的に名付けた contract、E2E、accessibility、
     または他の instruction ファイルを加える。

   すべてのファイルは `<record>/construction/build-and-test/` に入る。
   各ファイルは、フレームワークのセットアップ、実行コマンドとフィルタ、coverage ターゲット、test データまたは
   環境のセットアップを含む。

8. **Build and Test Summary を生成する** -- `<record>/construction/build-and-test/build-and-test-summary.md` を
   作成する:
   - 全体の build status と前提条件
   - test 種別のインベントリ（どの test 種別が生成されたか）
   - プロジェクトと各 Unit の coverage の期待
   - Target ID、Source、Expected、Actual、Evidence、Owning Stage、Verdict を持つ Target Verification Matrix
   - 該当するターゲットは `Pending` で始まる。`N/A` が有効なのは、source-complete なインベントリが該当する
     測定可能なターゲットを 1 つも見つけなかったとき、または plan がここで該当なしとするターゲット（CI
     Pipeline を実行しない、またはそれがまだ先にある plan の CI の義務）についてだけである
   - 準備状況の評価（build-ready、test-ready、deployment-ready）
   - 既知の制限または未解決の項目

9. **Build と Test を実行する** -- instruction ファイルに文書化された build と test のコマンドを **Bash を
    通して** 実行しようとする:

    a. **Build**: build-instructions.md からの build コマンドを Bash を通して実行する。出力を捕らえる。
    b. **Unit tests**: stage レベルの
       `<record>/construction/code-generation/unit-test-instructions.md`（存在するとき、Express を含む）と
       すべての unit ごとの `code-generation/unit-test-instructions.md` からコマンドを集め、同一のコマンドを
       重複排除し、別個のコマンドをそれぞれ一度実行する。コマンドは unit スコープであるべきで、ファイルが
       プロジェクト全体のコマンドを含むなら、それを一度だけ実行し、unit ごとに一度は決してしない。二重計上
       せずに unit ごとの pass/fail を報告する。プロジェクト全体に coverage の床が設定されているとき、
       プロジェクトのフルスイートの coverage コマンドは、それ自身の coverage 設定で一度実行され（マルチ
       リポジトリの intent では、床が適用される各リポジトリで一度、その行の Evidence にリポジトリを指名する）、
       その実行が Target Verification Matrix のプロジェクト全体の床の行の evidence である。あるリポジトリの
       実行が別のリポジトリの床の evidence になることは決してない。新しいまたは既に承認されたファイルからの
       unit スコープのコマンドで、その出力が、選択されたすべての test が通ったことと、プロジェクト全体の床の
       閾値（測定されるすべてのソースに対して 1 つ、runner がファイルごとにチェックするときでも）が非ゼロの
       exit の唯一の原因であることを示すものは、passed として数え、その exit と理由を test-results.md に記録
       する。これが適用されるのは、その exit がそのコマンドの後のステップを止めなかったときだけである。その
       後のステップがそれのために実行されなかったとき（`… && <lint>` のように連鎖した 1 つ、コマンドが呼ぶ
       スクリプトやライフサイクル hook の 1 つ、または build ツールの後のタスクやフェーズ。コマンドが実行する
       スクリプト・hook・タスクやフェーズの定義と、その出力から判断する）、そのコマンドは免除されず、その
       非ゼロの exit は failed なコマンドである。他のどの非ゼロの exit（1 つのパスや Unit に設定された閾値を
       含む）も失敗である。1 つの Unit に設定されたターゲットは、それ自身の Unit スコープの evidence を
       必要とする。
    c. **Integration tests**（該当する場合）: integration test コマンドを実行する。結果を捕らえる。
    d. **他の該当するチェック**: performance、security、contract、E2E、accessibility、他の生成された
       instruction ファイルからの、該当するすべてのコマンドを実行する。デプロイ済みまたは本番に近い環境を
       必要とし、現在の実行計画に名付けられた owning な validation stage を持つチェックだけを先送りする。
       その stage とその期待される evidence のパスを記録する。ターゲットは `Unverified` のままで、この stage を
       成功させることはできない。予定された owning stage がなければ、それは単に `Unverified` である。
    e. **結果を finalize して報告する**: どの exit パスでも、
       `<record>/construction/build-and-test/test-results.md` と `build-and-test-summary.md` を次とともに作成
       または更新する:
       - Build status（success/failure + 出力）
       - Test 結果（合計、passed、failed、skipped）
       - 失敗の詳細（test 名、assertion、stack trace）
       - Coverage レポート（test フレームワークが対応する場合）
       - finalize された Target Verification Matrix。該当するすべてのターゲットが、実際の値、evidence、
         owning stage、最終の `Met`、`Not Met`、または `Unverified` の verdict を持つ。Step 9 の後に `Pending` の
         verdict は残らない。
       - `## Loop-Back Log`（失敗ラダーの rung 3 または 4 が loop-back を発火したときのみ）: 試行ごとに 1 つの
         `### Loop-back N -- <ISO timestamp>` エントリ（Diagnosis / Root-cause stage / Planned fix /
         Estimated impact）。追記のみ。再実行を生き延びる（loop-back の再入では Modify であり、決して Redo で
         はない）。

    **失敗エスカレーションのラダー。** build または test のコマンドが失敗するか、該当するターゲットが
    `Not Met` または `Unverified` のとき、この stage は失敗しています。どの失敗種別についても同じラダーに
    入る前に、matrix と summary を finalize します。ターゲットを下げる・緩める・無効にするのは、決して
    受け入れられる fix ではありません。

    1. **stage 内の fix（最大 2 回の試行）** -- この stage 自身の remit の中にある根本原因（test config、
       build スクリプト、環境のセットアップ、または実行可能なターゲットのチェック）について: evidence を読み、
       失敗している設定や scaffolding を特定し、fix を適用し、失敗したステップを再実行し、ターゲットの matrix を
       更新する。
    2. **分類し影響を見積もる** -- stage 内の試行が尽きたか、診断が upstream を指すとき: 根本原因が、欠陥の
       大きさに関わらず生成されたソースや test コードにあるか、または code-generation のアプローチ選択
       （ライブラリ/バージョン、コンテナイメージ、インスタンスタイプ、アルゴリズム、フラグ）にあるかを決める。
       差し替え可能な次元で fix を見つけ、その影響（工数、金銭的コスト、リスク）を見積もる。影響を見積もって
       いない工数の仮定に基づいて、実行可能なパスを scope 外と宣言してはいけない。
    3. **自律的な有界 loop-back** -- `Construction Autonomy Mode: autonomous`、影響を見積もった fix が存在し、
       `## Loop-Back Log` の下に 3 件未満のエントリがあるとき: 診断 + 影響を見積もった fix を記録し、fix が
       指名する Unit（原因がすべてにまたがるときだけすべての Unit）について engine を通して code-generation を
       reopen し、loop-back プロトコルモジュール（`aidlc-common/protocols/stage-protocol-loopback.md`）の
       「Build-and-Test failure loop-back」に従って、その settlement を意識したルートを前方に replay する。
       失敗した実行の gate は提示されない。その有効な learnings の儀式は、最終的に通る実行に委ねられる。
       `learnings` モジュールが不在のとき、日誌も儀式も実行されない。
    4. **Halt-and-ask** -- gated/unset のモード、境界が尽きた、または特定可能な fix がない: 失敗をログに
       記録し、loop-back プロトコルモジュール（`aidlc-common/protocols/stage-protocol-loopback.md`）からの
       halt-and-ask の質問を提示する。候補の fix が存在するときは影響を見積もった 3 選択肢の変種
       （Retry with fix [estimated impact] / Accept failure / Abort）、rung 2 が 1 つも見つけなかったときは
       no-fix の 2 選択肢の変種（Accept failure / Abort）である。

    **Loop-back replay のルーティング。** Construction の checkpoint がオフで、Code Generation が unit
    ライフサイクルの receipt を一度も使わなかったなら、保存されたアーティファクトは all-covered の
    `gate: true` の fast path を取れる。その gate の前に、計画された fix と決定論的な Modify/Keep の判断を
    適用する。checkpoint がオン（receipt は最初の Unit から必須）のとき、またはいずれかのライフサイクルの行が
    存在したら、receipt モードは sticky になり、jump は unit ごとの作業を再発行する。`unit start` /
    `unit complete` を再発行し、ターゲットの Unit に Modify を、残りに Keep を適用し、Unit ごとに宣言された
    reviewer を実行する。どちらのパスも、settle/承認の gate の前に、reopen された各 Unit について新しい
    現在の試行の `REVIEW_COMPLETED` を記録しなければならない。reopen がそれらの Unit の以前の review を無効に
    するからである。fix が指名しない Unit は、その作業と承認を保つ。unit-major の下では swarm は決して発火せず、
    replay は serial な unit ごとの walk に従う。改訂された Code Generation の plan は、依然として新しい人間の
    Plan Approval を必要とする。

    replay は新しい stage の試行の下で Code Generation の plan を修復するため、以前の承認はもう適用されない。
    delta を Loop-Back Log に記録し、修復された plan を書く。`next` はその後、どの fix generation の前にも、
    plan approval を再びその人に求める。gated な "Retry with fix" の選択は jump を認可するのであって、改訂された
    plan の承認ではない。

    **Swarm の cheap path。** jump は新しい exact な stage 試行の `Run floor` 境界トークンを作るため、stale な
    収束の行は数えられない。stale な worktree/branch を park/discard し、新しい `prepare` を実行する。`finalize` が
    その現在の prepare の stamp を必要とするため、それらは新しい試行に adopt できない。保存された abort 結果
    または doctor の `restore_operation` は、存在するとき、現在の試行の権威ではなく、park されたファイルを
    別個に復旧する。その `worktree` engine ルートを、一覧された各引数を正確に argv として呼び出し、決して
    シェルコマンドに結合しない。hint とレンダリングされたコマンドは人間向けの表示テキストのみで、レンダリングの
    エラーは型付けされた操作を除去しない。evidence-only の試行には restore 操作も復旧すべきファイルもない。
    まず `check` を実行する。green な Unit は builder のターンを skip できるが、`finalize --claimed` に入る前に、
    新しい worktree で終端の現在の試行の reviewer receipt を依然として必要とする。`finalize` は、試行の stamp と
    ともに、その receipt の現在のアーティファクトの fingerprint も検証する。

    単一 stage の実行（`--single`）は rung 2 で止まる。動かすべき main ワークフローの位置がないからである。
    影響を見積もった選択肢はログに記録され、その実行の isolated-run の summary に提示される。

    **成功時。** 成功した準備状況の結果は、すべてのコマンドが通り、該当するすべてのターゲットが `Met` である
    こと、またはターゲットが 1 つも該当しないときは単一の説明的な `N/A` の行を必要とする。

10. **Cross-Unit Final Coverage Gate** -- `aidlc engine sensor-traceability --stage build-and-test` を実行する。
    これは、`requirements.md` のすべての `FR` と `NFR`（sub-requirement を持つ要件はその `FR{n}.{m}` ID を
    通して）と、`stories.md` のすべての `AC`（User Stories が実行されたとき）を報告する。それぞれ、stage
    レベルまたは unit ごとの Code Generation の `traceability.json` が、既存のターゲットファイルとともにそれを
    `OK` でカバーするとき built である。sub-requirement を持つ要件は、各 Unit が自身のもの（その NFR
    Requirements が書いた `NFR1.x`。`NFR1` 単独の行はそれらをカバーしない）を built したとき built である。
    そうでなければ自身の行によって、または User Stories が実行されたときは、User Stories がそれを trace した
    story のすべての acceptance criterion を通して built である。何も build しないものは、それを trace した
    最新の stage（User Stories、NFR Requirements、その後 Code Generation）が、それを一覧するそこのすべての
    表でその理由とともに `N/A` と印したとき settle される。理由のない `N/A` は settle されない。その出力から、
    verdict、ID ごとの coverage、カバーされていないすべての ID とともに `cross-unit-traceability.md` を書く。
    カバーされていない ID は、承認 gate で示される finding である。

11. **Completion を準備する** -- build/test の evidence を検証する。stage や phase の state を編集しない。
    報告された gate の結果が transition を所有する。

12. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact                          | 説明                                                            | Condition          |
|-----------------------------------|-----------------------------------------------------------------|--------------------|
| build-instructions.md             | 依存関係のインストール、env のセットアップ、build コマンド、トラブルシューティング | Always             |
| integration-test-instructions.md  | 前提条件、unit をまたぐテスト、外部依存、データのセットアップ    | Standard/Comprehensive |
| performance-test-instructions.md  | 負荷テスト、NFR シナリオ、ベースライン、ストレス/ソークテスト    | NFR perf が存在する場合 |
| security-test-instructions.md     | SAST/DAST、認証テスト、injection テスト、コンプライアンス        | NFR sec が存在する場合  |
| contract-test-instructions.md     | consumer-driven な contract、スキーマ検証、API 互換性            | マイクロサービスの場合   |
| e2e-test-instructions.md          | ブラウザ自動化、ユーザーの旅路、クロスブラウザ                  | UI 駆動の場合       |
| accessibility-test-instructions.md| WCAG 準拠、スクリーンリーダー、キーボードナビゲーション          | ユーザー向け UI の場合  |
| build-and-test-summary.md         | 全体の status、test インベントリ、coverage、準備状況の評価      | Always             |
| test-results.md                   | 実際の build/test の実行結果、pass/fail、coverage               | Always             |
| cross-unit-traceability.md        | すべての Unit にまたがる FR/NFR/AC の coverage、verdict、カバーされていない ID | Always             |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes

- **実際の Bash 実行**: この stage は test instructions を文書化するだけではありません。Bash を通して実際に
  build と test のコマンドを実行し、本物の結果を捕らえます。コードベースに対して本物のコマンドを実行する
  数少ない stage の 1 つです。
- **品質ターゲットの evidence**: source-complete な matrix は、どの exit パスでも finalize されます。
  デプロイ済み環境のチェックは後の owning stage を指名することがありますが、`Unverified` のままです。
  `Not Met` と `Unverified` はどちらも失敗ラダーに入ります。
- **失敗エスカレーションのラダー**: stage 内の fix は 2 回の試行で有界です。根本原因が upstream の生成された
  コードまたは code-generation のアプローチ選択にあるとき、stage は fix を分類しその影響を見積もり、その後、
  code-generation への有界な自律 loop-back（最大 3、test-results.md の追記のみの `## Loop-Back Log` で数える）を
  実行するか、影響を見積もった halt-and-ask の質問を提示します。loop-back プロトコルモジュール
  （`aidlc-common/protocols/stage-protocol-loopback.md`）の「Build-and-Test failure loop-back」を参照して
  ください。再入は settlement を意識し、`plan_approval` がオンの間は修復された plan について Plan Approval を
  再び求め（以前の承認は前の試行のものです）、該当するすべての Code Generation Unit が新しい現在の試行の
  review を持つまでその gate に到達できません。
- **CONDITIONAL な test 種別**: performance test、security test、contract test、E2E test、accessibility test は、
  関連する条件が満たされるとき（NFR requirements が存在、マイクロサービスアーキテクチャ、UI 駆動の
  アプリケーション、ユーザー向けのインターフェース）だけ生成されます。
- **unit をまたぐ scope**: unit ごとである stage 3.1-3.5 とは異なり、Build and Test はすべての unit が生んだ
  すべてのコードにまたがって一度実行されます。個々の unit ではなく、統合されたコードベースを検証します。
- **フェーズの完了**: この stage は（該当するなら 3.7 とともに）Construction フェーズの終わりを印します。
  最終の承認されたレポートが、engine に Construction を完了と印させ、atomically に Operation へルーティング
  させます。

---

## Stage 3.7: CI Pipeline

### Metadata

| プロパティ          | 値                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 3.7                                                                                               |
| Phase             | Construction                                                                                      |
| Execution         | CONDITIONAL（CI が既に存在し十分なら skip）                                                     |
| Condition         | CI パイプラインの作成や大幅な変更が必要なとき実行する                                            |
| Per-Unit          | No（すべての unit について一度実行）                                                             |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | (none)                                                                                            |
| mode              | inline                                                                                            |
| Inputs            | Stage 3.5 からの code generation の出力、Stage 3.6 からの build/test の結果                        |
| Outputs           | `<record>/construction/ci-pipeline/` -- ci-config.md、quality-gates.md、ci-pipeline-questions.md |

### 目的

quality gate、アーティファクト管理、build/test 自動化を伴う CI（Continuous Integration）パイプラインを
設定します。aidlc-pipeline-deploy-agent が lead し、support agent はいません。

### Inputs

- `<record>/construction/build-and-test/` からの build/test の結果
- `<record>/construction/infrastructure-design/` からの Infrastructure design（存在する場合）
- 既存の CI 設定のためのワークスペースプロファイル

### Steps

1. **先行コンテキストを読み込む** -- build/test の結果、infrastructure design（存在する場合）、既存の CI 設定の
   ためのワークスペースプロファイルを読む。

2. **明確化のための質問を生成する** -- `<record>/construction/ci-pipeline/ci-pipeline-questions.md` を質問
   とともに作成する:
   - どの CI ツールが使われているか（CodePipeline、CodeBuild、GitHub Actions、Jenkins）?
   - branch 戦略は何か?
   - merge の前にどの quality gate が必要か?
   - どのアーティファクトリポジトリが使われているか（ECR、CodeArtifact、S3）?

   stage-protocol.md の質問フローに従う。

3. **回答を集めて分析する** -- 既存のインフラと team の能力に照らして CI の選択を検証する。

4. **アーティファクトを生成する** -- CI パイプライン設定（buildspec.yml、workflow YAML、または同等物）、
   quality gate の定義、アーティファクトリポジトリの設定を作成する。

5. **Phase Boundary Verification** -- Construction から Operation への検証チェックを実行する:
   - アーキテクチャからコード、テストへの整合
   - すべてのコードが design に trace する
   - acceptance criteria に照らした test カバレッジ
   - 結果を `<record>/verification/phase-check-construction.md` に書く

6. **Completion を準備する** -- CI と境界のアーティファクトを検証する。stage や phase の state を編集しない。
   報告された gate の結果が transition を所有する。

7. **完了** -- 完了メッセージと承認 gate を提示する。

### Outputs

| Artifact                  | 説明                                                     |
|---------------------------|----------------------------------------------------------|
| ci-config.md              | CI パイプライン設定（buildspec、workflow YAML など）      |
| quality-gates.md          | merge/昇格のための quality gate の定義                   |
| ci-pipeline-questions.md  | 回答を伴う明確化のための質問                             |

### 承認 Gate

厳密に 2 選択肢: Approve / Request Changes。

### Notes

- **Phase boundary verification**: これは Construction フェーズの最後の stage です。Construction から
  Operation へのフェーズ境界の検証チェック（stage-protocol-governance.md のセクション 13 に従う）を行い、
  アーキテクチャがコードに trace し、コードが test に trace することを検証します。結果は
  `<record>/verification/phase-check-construction.md` に書かれます。
- **CONDITIONAL な実行**: プロジェクトが既に十分な CI パイプラインを持つなら、この stage は skip されます。
  plan（scope に加えて、その人が加える任意の skip や add）がそれに到達するかどうかを決め、stage は依然として
  それ自身の条件を適用します。Delivery Planning が計画するのは Bolt であり、stage ではありません。
- **unit 後の実行**: Stage 3.6 と同じく、この stage は unit ごとの作業がすべて完了した後に一度実行され、
  unit ごとではありません。

---

## フェーズの要約

Construction フェーズは、フェーズ化された construction フローを通して、Inception の design を動作する
ソフトウェアに変換します:

**unit ごとの stage（3.1-3.5）:**
- 3.1 Functional Design -- ビジネスロジック、ドメインモデル、ルール（architect が lead）
- 3.2 NFR Requirements -- 性能、セキュリティ、スケーラビリティ、信頼性、可観測性、技術スタック
  （architect が lead）
- 3.3 NFR Design -- NFR カテゴリの具体的なパターン（architect が lead）
- 3.4 Infrastructure Design -- デプロイ、サービス、監視、CI/CD（aws-platform が lead）
- 3.5 Code Generation -- 2 部構成の planning + subagent を通した generation（developer が lead）

**unit 後の stage（3.6-3.7）:**
- 3.6 Build and Test -- instruction の生成 + 失敗診断を伴う実際の Bash 実行（quality が lead）
- 3.7 CI Pipeline -- CI 設定 + フェーズ境界の検証（pipeline-deploy が lead）

**主な特徴:**
- stage 3.1-3.4 は CONDITIONAL。3.5-3.6 はそれらを含むすべての scope で実行される（infra はどちらも持たない）。3.7 は CONDITIONAL
- どの CONDITIONAL な stage に到達するかは、Delivery Planning ではなく plan（scope に加えて、その人が加える任意の skip や add）から来る。それぞれ依然としてそれ自身の条件を適用する
- 新しいソースを生む単独の Unit ワークフローは、unit-major、serial 実行、検証された Unit checkpoint に
  デフォルトする。明示的な iteration の選択と、既存のレガシー、design のみ、Unit なし、team が所有する
  パスを保つ。
- NFR のアーティファクトは、upstream のリファレンスと比べて拡張された粒度を使う（requirements に 6 つの
  Markdown ファイル、design に 6 つ、それぞれ `traceability.json` を伴う）
- Infrastructure Design は、3 つの Markdown アーティファクト（専用の monitoring と CI/CD のファイルを伴う）に
  加えて `traceability.json` を生成する
- Code generation は、コンテキスト予算のコントロールを伴う aidlc-developer-agent subagent を使う
- Build and Test は、実際のコマンド実行と自動化された失敗診断を行う
- CI Pipeline は、Operation へ移行する前にフェーズ境界の検証を含む

**upstream のリファレンスからの意図的な逸脱:**
- NFR Requirements: 6 つの Markdown ファイルに加えて traceability.json（リファレンスの 2 から拡張）
- NFR Design: logical-components.md を含む 6 つの Markdown ファイルに加えて traceability.json
  （リファレンスの 2 から拡張）
- Infrastructure Design: 3 つの Markdown ファイルに加えて traceability.json。統合された
  infrastructure-specification.md（deployment + services + shared）に加えて、専用の monitoring-design.md と
  cicd-pipeline.md
- plan/question ファイルを stage のアーティファクトと同じ場所に配置

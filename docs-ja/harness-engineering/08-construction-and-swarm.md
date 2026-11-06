# Construction and the Swarm

Construction は AI-DLC がものを作る場所です。Unit ごとのステージが実行され、**スウォーム**がその作業を多くの Unit に一度に広げられる場所です。ここはまた、「自分は何を、どう形づくれるのか」への最もきれいな答えが、どのつまみが誰のものかを正直に言うことを求める、ハーネスの部分でもあります。ここでのレバーの一部は、他のどの章も教えるとおりデータとして書かれる、ハーネスエンジニアとしてのあなたのものです。他のつまみは、ゲートの人間と、実行を起動するオペレーターのものです。この章はそのすべてを歩き、線を正確に引くので、正しい面に手を伸ばし、自分のものでない面を押すのをやめられます。

通した筋は、このガイドの残りが運ぶのと同じものです。`core/` の下の**データ**（ルール、ステージ、センサーのチェックコマンド）を編集して Construction を作り直し、コードは決して編集しません。Construction が違って感じられるのは、その最も目立つ振る舞いの 2 つ（自律の付与、スウォームのドライバー）が、意図的に*データファイルではない*事柄に支配されているからで、それを認めることで、存在しない設定を書くのを防げます。

---

## 3 つの関心、3 人の所有者

フレームワークの設計原則は、あらゆる決定を、それがどんな種類のものかで分けます。決定論はツールに属し、知識はエージェントに属し、判断は人間に属します。Construction のスウォームはその分割を具体にしたもので、どれか 1 つのつまみに触れる前に全体像を収めておく価値があります。

| Construction の関心 | 所有者 | どこに置かれるか |
|---|---|---|
| チームの自律の**姿勢**（常設の既定） | あなた、ハーネスエンジニア | `core/memory/{team,project}.md` のルール（データ） |
| 何を**並列化できるか** | あなた、ハーネスエンジニア | `units-generation` ステージとその依存 DAG（データ） |
| スウォームが信頼する**収束チェック** | あなた、ハーネスエンジニア | プロジェクト自身のビルド/テストコマンド + 保護された仕様（データ + プロジェクト設定） |
| このプロジェクトの実際の自律の**付与** | 人間 | 実行時の明示的な提案またはオンデマンドのリクエスト |
| スウォーム**ドライバー**の選択 | オペレーター | `AIDLC_USE_SWARM` 環境変数 |
| 収束の**判定**、マージバック、監査 | ツール | `aidlc-swarm.ts`（コード → 開発者リファレンス） |

「あなた」と記された 3 行がこの章の本体です。他の 3 つは、あなたのデータが形づくるランタイムを理解する必要があるので扱いますが、どれも自分では書きません。

---

## 自律の姿勢 — あなたの本当のレバー、ルールとして書く

常設の推奨は `core/memory/org.md` の `## Walking Skeleton` の下に置かれ、`team.md` と `project.md` で精緻化されます。新しくソースを生む単独 Unit のワークフローは、3 つの独立した設定を記録します。

| 設定 | 新規ワークフローの既定 | 意味 |
| --- | --- | --- |
| `Construction Checkpoints` | `enabled` | 現在の証拠を使って、完了した単独 Unit を検証し承認する |
| `Construction Iteration` | `unit-major` | 次の前に、1 つの Unit の適用可能なステージを終える |
| `Construction Execution` | `serial` | 直列にビルドする。明示的なスウォーム実行には stage-major が要る |

`Construction Verification Command` は別個の intent レベルの Runtime State フィールドで、自動の既定はありません。Delivery Planning が実際のプロジェクトチェックを提案し、タイプされた setter が書く前に人間の承認の受領を記録します。実行可能なチェックのないグリーンフィールドプロジェクトは、最初のチェックポイントに先送りしてよいでしょう。同じコマンドがすべての Unit/バッチのチェックポイントに再利用されます。それを選ぶか変えるには[記録されたコマンドのフロー](../guide/12-cli-commands.md#construction-verification-command-record-human-authorization)が要り、汎用の `state set` や自律の付与は決して使いません。
コマンドを提示する前に、それをハーネスのファイル書き込みツール（Write/edit）で `<record>/verification-command.txt` に書きます。シェルの `echo` や heredoc は決して使いません。リポジトリ由来のコマンドテキストを、承認の前に置換が走りうるシェル行に補間してはいけません。
`log decision`、`log answer`、`state set-construction-verification-command` には `--command-file verification-command.txt` を使います。両方の log 呼び出しは自分のセッションを見つけるので、`--session` を渡さず、1 つも探さないでください。`decision` ツールの JSON 出力の `command` フィールドから、完全な正規コマンドをそのまま verification-command の質問のコードスパンにコピーします。決して省略しません。コマンドのバックティックを保つ区切りを選びます。人間は `<record>/verification-command.txt` を開くこともできます。正規コマンドは、多くとも 1024 文字の、空でない 1 行です。制御文字と表示を偽装する文字（Unicode 書式文字。ゼロ幅と bidi 制御、行/段落区切り、ノーブレークスペース U+00A0 を含む）は拒否されます。
人間の **Approve** / **Request Changes** の返事を、そのチャットか、それが最新の質問であるあいだの新しいチャットで記録します。**Approve** だけが受領を認可します。無関係な返事、**Request Changes**、別の質問への返事ではありません。人間がそれを選ばない限り、`--details "Approve"` を決して書かないでください。

チェックポイントのポリシーは、単独の所有、空でない実際の Unit DAG、含まれるソースを生む Unit ごとのステージを要します。設計のみと Unit 無しの作業は、既存のステージフローを保ちます。skeleton-on では、最初の DAG Unit を、最小の動く統合スライスとして計画します。それは適用可能な Unit ごとの設計ステージと Code Generation をすべて完了し、実際のエンドツーエンドのチェックを通し、stage-major を選んでいても、後の Unit が始まる前に人間のスケルトン承認を受けます。最初の設計ステージのレビューだけでは、動くスケルトンではありません。`bolt-plan.md` の計画マーカーは実際の DAG を並べ替えません。

skeleton-off では、エンジンは Construction の入口で **Continue automatically** / **Review each checkpoint** を提示します。skeleton-on では、実際のスケルトンのチェックポイントの後にその選択を提示します。コンダクターは `offer_autonomy` に従い、`bolt set-autonomy` で人間の選択を記録し、選択が分かればラダーを繰り返して尋ねません。オンデマンドの付与/取り消しのリクエストは引き続き使えます。自律は通常の完了承認を変えますが、人間の Plan Approval、検証コマンドの選択、有効な要約確認を決して供給せず、失敗したチェックを通すこともありません。
要約確認は `directive.ceremony.summary_confirmation === "on"` のときだけ適用されます。

スウォーム実行を選ぶには、stage-major を明示的に選び、次に `Construction Execution: swarm` を選びます。ガイド付き（`gated`）と自動（`autonomous`）のバッチ完了は両方とも対応します。自律の付与は順序も実行も変えません。Unit-major は直列のままで、矛盾するスウォーム設定を拒否します。新しいフィールドの無いレガシーワークフローは、既存の最初のステージレビューと自律ベースのスウォームルーティングを保ちます。unit-major では、それらの遅いステージ承認は 1 つの質問です。チームが所有する作業は `unit_gate` と、自身のステージごとまたは Unit 末尾の承認のリズムを保ちます。

あなたは[Rules and the Learning Loop](05-rules-and-the-loop.md)のルール層を通じて推奨を形づくります。実際の付与はなお人間が選びます。たとえば、チームはこう推奨できます。

```markdown
## Walking Skeleton

Until our integrated checks have proved reliable, recommend **Review each
checkpoint**. Review the working first slice and each ordinary completed Unit
or swarm batch before proceeding. Plan Approval, verification command selection,
and any enabled summary confirmation remain human decisions even when we later select
**Continue automatically**.
```

信頼されたプロジェクトでは、同じ見出しがスケルトンの検証後に **Continue automatically** を推奨できます。ルールは案内を供給するだけで、記録された自律の付与や、スウォーム実行への静かな切り替えは決して供給しません。

---

## チェックポイントと承認の証拠

`run-stage` が `construction_checkpoint` を運ぶとき、Unit 本文とレビューはすでに実行されています。`rereview` フィールドが、レビュー以降に変わったコードやドキュメントの 1 度の再チェックを指定し、尋ねずにまず実行します（Guard Policy `strict` のときだけ。`relaxed` と `off` では変更が受け入れられ、承認は保たれます）。本文/レビュアー/ゲートのロジックより前にそれをルーティングします。`command_authorized: false` のときは、verification-command の質問を尋ね、どの `verify` よりも前に人間の決定/回答/setter のフローを完了し、`next` を再実行します。
そうでなければ `bolt checkpoint --action verify --unit <unit> --kind <unit|skeleton>` を実行します。それが実行するのは、記録された、人間が認可したコマンドです。verify 時にその場で選んだテキストを実行することはありません。現在の検証済みの証拠だけを承認し、承認の質問に「Verified with `<full command>` (exit 0)」を示し、ツール出力の完全な正規 `verification_command` を省略せずに使います。スケルトンは常に人間を必要とし、通常の Unit は `human_required` に従います。
`swarm_checkpoint` も同様に、次のバッチの前に完了したバッチをルーティングします。
`verify` が `verified: true` を報告し、現在のチェックポイントが `ready: true` を持った後にだけ、`aidlc engine bolt checkpoint --action ask --unit "<unit>" --kind <unit|skeleton>` で人間の Unit/スケルトン承認の質問を開きます。`ask` は未準備または未検証のチェックポイントを拒否します。人間のバッチの質問には、status が `ready: true` を報告した後にだけ、`aidlc engine bolt swarm-checkpoint --action ask --batch <N> --units "<Units>"` を実行します。
次に **Approve** / **Request Changes** を提示して待ちます。このチェックポイントの質問への人間の正確な返事が、対応するアクションを認可します。そのチャットか新しいチャットで、です。自分の質問を持たない新しいチャットの返事は、別のチャットが尋ねたチェックポイントの質問のために保たれます。それが最新の質問であって、まだ開いているあいだです。認可できるのはその返事だけです。無関係な返事、エージェント自身の言葉、別の質問への返事は、アクションを認可せずに終わります。これらのコマンドは自分のセッションを見つけます。人間が選ばなかった `--user-input` を決して渡さないでください。同意は 1 回限りで、現在のチェックポイントのフィンガープリント、検証証明の ID、認可されたコマンドのダイジェストに束ねられます（バッチの質問はフィンガープリントと Unit ごとの `Command SHA-256` の集合を束ねます）。`verify` またはスウォームの `finalize` を再実行すると、この intent について開いているすべてのチェックポイントの質問と、捕まえたチェックポイントの応答が、どのセッションでも取り消されます。再検証し、`verified: true`（バッチ: ソース着地後に `ready: true`）を確かめ、また尋ねます。古い応答は新しい証拠を承認できません。自動承認（`human_required: false`）は `ask` も `--user-input` も要しません。人間の拒否は常に、この検証済みの質問と回答のフローを要します。
承認/拒否は `next` に戻り、1 つの Unit やバッチについて Code Generation ステージ全体を決して承認しません。完全なアクションの形は[チェックポイントのコマンド](../guide/12-cli-commands.md#aidlc-engine-bolt-checkpoint-verify-and-approve-a-completed-unit)を参照してください。

バージョン 3 のチェックポイント証明は、コマンドの SHA-256 と完全な正規コマンドを表示ラベルとして、出力の生データの代わりに出力のバイト数とダイジェストと並べて保管します。それより前の証明バージョンは、認可されたコマンドでの再検証を要します。
検証者はツールが所有する `CHECKPOINT_VERIFICATION_RECORDED` の受領を証明ファイルと並べて記録し、承認はその受領を要します。手書きの証明ファイルは Unit を検証できません。証明ファイルがまったく無いチェックアウト（新しいクローン、別のマシン）では、その受領が、証拠が変わらない、すでに承認済みの Unit の証明の代わりになるので、何も再実行されません。

`construction_policy.completion_only: true` と `human_completion_required: false` を運ぶ最後のステージディレクティブは、記録された承認を調整するだけです。本文、質問、レビュアー、学習の提示を飛ばし、ユーザー入力なしで `awaiting-approval` を、次に `approved` を報告し、`next` を呼びます。証拠のエラーは、名指しのレビュー/受領の修理を要し、必要に応じて人間に相談します。でっち上げの検証や、未検証のチェックポイント承認の質問は決してありません。

Plan Approval は、その提示がまとめられていても、個別に束ねられたままです。複数の Unit のプランが一緒に用意できたとき、`next` は 1 つのエンジンの質問でそれらについて尋ね、エージェントは Unit ごとに人の選択を記録します（`log answer --checkpoint plan-approval --units`）。各承認はその Unit 自身のプランに束ねられます。「approve all」はすべての Unit を承認し、1 つの Unit を名指す変更はその Unit だけを戻します。[CLI リファレンス](../guide/12-cli-commands.md#grouped-code-generation-plan-approval)を参照してください。

部分的な着地の後、`next` は残りの Unit を名指し、有効な用意されたワーカーは元のグループの承認とワークツリーを保ちます。続ける前にその親とワークツリーの実行許可を確かめます。`testing-posture verify` は、現在の承認、または下げられた plan-approval フェンスでの内容変更の続行について、`execution_allowed: true`（exit 0）を使います。`ok: false` はなお、編集された内容が承認されなかったことを意味します。元の承認の証拠を保ってください。
許される続行では、`reason` が作業を続けられる理由を説明し、`approval_reason` が診断の詳細を保ちます。委譲されたワーカーは、検証済みの親 intent のライブのフェンスを使うので、それを下げたり上げたりすると、すでに用意されたワーカーに次のチェックで適用されます。
発行された Unit の集合が小さくなったからといって、初期の準備を繰り返さないでください。失敗はなお人間の Retry/Abort の決定のために止まり、チェックポイントの Request Changes は新しい改訂を始めます。その改訂のネイティブな準備が記録されれば、以降のディレクティブは別の承認なしにそのワーカーを続けます。中断したセットアップの回復は、現在の承認を再利用します。ワーカーに束ねられた受領を置き換えることはしません。
1 つのワーカーを明示的に捨てるネイティブレビュアーの Retry では、準備が、別のワーカーの承認や保留中の作業を変えずに、その記録されたコミット済みの承認済みベースラインを復元できます。捨てることは現在のワーカーを特定しなければなりません。無いことだけでは回復の付与になりません。チェックポイントの改訂はその `--resume-existing` のルートを保ち、初期バッチは通常の準備を使います。

## 何を並列で実行できるかを形づくる — Bolt-DAG

スウォームは作業を多くの Unit に広げるので、「何を一度に実行できるか」は上流、inception で、`units-generation` ステージが決めます。そのステージは `unit-of-work-dependency.md` を生成し（`core/aidlc-common/stages/inception/units-generation.md` が `produces: unit-of-work-dependency` を宣言します）、そのアーティファクトの中で、必須のフェンス付き `yaml` エッジブロックが、すべての Unit をその `depends_on` 一覧とともに並べます。

コンパイラはそのブロックを `runtime-graph.json` の `bolt_dag` ノードに読み込みます。このノードは、エッジブロックが整形式で非循環の**ときだけ**存在します。無い、不正、循環のブロックは、ノードをまるごと省きます（[Runtime Graph](../reference/13-runtime-graph.md)、44 行のスキーマ注記）。`bolt_dag` ノードは `batches` も運びます。すべての Unit の依存が先行レベルで満たされるトポロジカルレベルで、だからバッチの Unit はその間にエッジを持たず、一緒に広がれます。

5 つの **Unit ごとの** Construction ステージは、それぞれフロントマターで `for_each: unit-of-work` を宣言します。

人間のチームの所有では、delivery planning が `Construction Iteration: unit-major` と `Unit Ownership: team` を組み合わせられます。するとエンジンは同じ DAG/アーティファクト/受領の証拠から `## Unit Progress` を導き、単独パスの 1 つの遅い承認の代わりに、ステージごとまたは Unit 末尾の Unit ゲートを使います。このチーム所有のパスは自身のポリシーを保ちます。単独の所有は、その記録された状態が選ぶ、チェックポイント有効またはレガシーのパスを使います。

| ステージ | 実行 |
|---|---|
| `nfr-requirements` | Unit ごとに 1 回 |
| `functional-design` | Unit ごとに 1 回 |
| `nfr-design` | Unit ごとに 1 回 |
| `infrastructure-design` | Unit ごとに 1 回 |
| `code-generation` | Unit ごとに 1 回 |

4 つの設計ステージについては、Unit ごとのカバレッジがさらに **kind でフィルタされます**。各 Unit の `kind`（2.7 エッジブロックでタグ付け）が、ステージの `produces_kinds` マップを通じて、その Unit が実際に負う produces アーティファクトを選びます。エンジンは run-stage ディレクティブの produces パスとカバレッジチェックの両方をその集合に刈り込むので、`spec` Unit はデプロイドキュメント無しで infrastructure-design を完了し、`packaging` Unit はファイル 0 個で functional-design を完了します。タグの無い Unit は完全なマトリクスを保ちます。

（残る 2 つの Construction ステージ、`build-and-test` と `ci-pipeline` は、末尾に全体にわたって 1 回実行されるので、Unit ごとの広がりの一部ではありません。）

**この並列の面は、`units-generation` が実行されるスコープにだけ存在します。** `enterprise`、`feature`、`mvp`、`classic`、`workshop` です。増分のスコープ（`bugfix`、`refactor`、`security-patch`）と `poc`/`infra`/`express` は `units-generation` を決して実行しないので、エッジブロックを生まず、`bolt_dag` を運ばず、スウォームが広げるものが無いまま Construction を単一パスで実行します。本当の Unit DAG を持つところでスウォームを形づくってください。Unit 0 個の実行は通常のステージ実行を保ちます。オンデマンドの承認の好みは DAG もスウォームも作りません。

ここでのハーネスのレバーは間接的ですが本当です。**`units-generation` が捕まえる依存構造を形づくることで、何が並列化されるかを形づくります。** 相互依存の少ない粗い Unit を好むチーム案内を書けば、より多くの Unit が同じバッチに着地し、同時に実行されます。きつく深く連鎖した依存は、作業を多くの小さなバッチに直列化します。これに影響するのは、`units-generation` ステージの散文と、分解しながら architect エージェントが読むルールを通じてです。分解そのものはエージェントが人間とともに下す知識の判断で、それが書くトポロジーを、コンパイラがバッチに変えます。

エッジブロックを `bolt_dag` に変えるコンパイルとパースはコード側にあり、あなたが書く対象の外です。そのパーサーを形づくるのはコードの変更です → [開発者リファレンス](../reference/13-runtime-graph.md)を参照してください。

---

## 収束を配線する — プロジェクト自身のチェックが信頼される信号

Code Generation のスウォームは計画を迂回しません。`prepare` の前に、発行されたすべての Unit は、構造化された Testing Contract、Unit 範囲のテスト指示、一致する承認フィンガープリントを含む、現在の人間承認済みのプランを持たなければなりません。初期の保護された prepare の前に、承認された親アプリケーションのソースも、コミットされ再現可能でなければなりません。ツールは、最初のワークツリーを作る前に、レガシー自律と新しいチェックポイントポリシーの両方で、すべての Unit を読み取り専用で検証します。承認されたソースが未コミットなら、commit-and-retry の修理で拒否し、その拒否から子を残しません。コミットは明示的な認可のときだけ行います。prepare も自律の付与も、あなたのためにコミットしません。承認されたインラインのスケルトンソースは、後の並列バッチの前にこの明示的なコミットを要します。各ワーカーはなお、承認済みの Unit マーカー、contract ハッシュ、プラン、指示を受け取ります。

拒否されたバッチは、その拒否改訂の新しい Plan Approval の後に、`prepare --resume-existing` で再開します。既存のワークツリーはそのソースを保ち、古いメタデータをアーカイブします。ネイティブなソース着地が子を取り除いたところでは、ツールは、検証済みの着地の証拠を持つ、すでに着地した親ソースからそれを作り直せます。拒否改訂は保たれ、古い承認で置き換えられません。その証拠の無い、欠けた子は拒否されます。マージされた子がすべて存在し続けると約束しないでください。

スウォームのワーカーは自分の Unit が収束したと主張できます。フレームワークはその主張を鵜呑みにしません。正本の信号はプロジェクト自身の**チェックコマンド**で、referee が実行します。exit `0` は本当に収束、それ以外の exit はまだです。これが、自律 Construction のためにハーネスエンジニアが確実にする最も重要な 1 つです。プロジェクトに本当に実際のチェックコマンドと保護された仕様があり、スウォームが収束を確かめる信頼できる相手を得ることです。

2 つの面が信号を運びます。

- **チェックコマンド。** Unit が完了したことを証明するものは何でも。`npm test`、`pytest`、ビルドとリントのスクリプト、CI のローカル相当です。referee はループ中に Unit ごとに実行し、finalize で再び実行します。green な exit だけが、Unit の作業をマージさせます。
- **保護された仕様ファイル。** referee は、指定された `--test-file` を、その fork された git のベースラインと改ざん防止で比べられるので、ワーカーが「完了」を定義するテストを静かに弱めて、red なチェックを green にすることはできません。relaxed または off の Guard Policy では、変わった保護ファイルは Unit を失敗させず `change_notices` に報告されます。受け入れ基準を符号化する仕様が存在し、指された先のファイルであることを確かめます。

あなたのハーネスの貢献は、その両方を本物で意味のあるものにすることです。常に通るチェックや、空の仕様は、スウォームにゴム印を手渡します。`org.md` の `## Testing Posture` ルールは、選ばれた Test Strategy とスコープごとの追加の下限をすでに組み合わせます（たとえば `mvp`/`feature` は 80% のカバレッジを足します）。`team.md` でより厳しい構造化された方法論/順序を書くのが、それらの下限を捨てずに実行のリズムを変えるやり方です。

センサーが散文の側でチェックを補います。`units-generation` がすでにインポートする `required-sections` と `upstream-coverage` のセンサーは、ゲートでアーティファクトの形とカバレッジを検証します。[Sensors](06-sensors.md)の力で、プロジェクト固有の収束や required-sections のセンサーを書き、同じ隙間を見張り続ける Construction ステージの出力に束ねられます。その 2 つはゲートで発火し、補助的です。あなたが足すセンサーは、その `fire_on` が言うとおり、各書き込みかゲートで発火し、ゲートをブロックするセンサーは、その所見が直されるか人が上書きするまでゲートを止めます（[Sensors](06-sensors.md)を参照）。プロジェクトのチェックコマンドが、硬い収束のゲートです。それらは 2 つの半分を働きます。センサーはアーティファクトの形を見張り、チェックは Unit がマージしてよいかを決めます。

---

## ドライバーの継ぎ目 - `AIDLC_USE_SWARM`

スウォームが物理的にどう広がるかは、環境変数で選ばれ、これが**オペレーターのつまみ**だとはっきり言う価値があります。`.claude/` のデータファイルではなく、`settings.json` にもありません（広がりのときにコンダクター側で読まれます）。あなたはそれを書かず、あなたのデータが形づくるランタイムを知るために理解します。

| `AIDLC_USE_SWARM` | ドライバー | 振る舞い |
|---|---|---|
| 未設定または `"1"` でない | subagent フロア | コンダクターは 1 つのメッセージで N 個の並列 `Task` 呼び出しを、Unit ごとに 1 つ発行する。 |
| `"1"` | インライン Dynamic Workflow | コンダクターは、その JS が Unit ごとのパイプラインと反復キャップを所有する `Workflow` を書く。 |
| `"1"` だが Workflow ツールが使えない | フロアへ大きく劣化 | コンダクターはフロアにフォールバックし、`--degraded-from ultracode` を渡すので referee が `SWARM_DEGRADED` を発行する。 |

両方のドライバーは各 Unit の Code Generation を実行し（subagent として実行される唯一の Unit ごとのステージで、スウォームがディスパッチするのはこれです。Unit ごとの設計ステージはスウォームの一部ではありません）、同じプロジェクトチェックに対して収束します。違いは純粋に、並列の作業がどうディスパッチされるかだけです。暴走の最後の防壁は、ハーネスの **Stop-hook の上限**（`core/hooks/aidlc-continue-workflow.ts`、`blockCap()` / `defaultBlockCap()` の対、`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` として公開）に置かれ、スウォームツール自身の外です。この自律 Construction のパスでは、既定の上限は **8 ブロック**です（対話の既定は 2。明示的な `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` が両方を上書きします）。ドライバーの継ぎ目の契約は[Skill System § 6](../reference/17-skill-system.md#6-the-swarm-referee-the-driver-seam-and-the-bolt-dag)にあります。

ドライバーと一緒に動かない判断が 1 つあります。失敗は**常に止まって人間を再び関わらせます**。`aidlc-common/protocols/stage-protocol-construction.md`（「Halt-and-ask on failure」）のとおり、自律モードに関わらずです。referee の `finalize` がその exit-2 の封筒を返すと、コンダクターはバトンを人間に戻します。ハンズオフモードは、失敗の停止を大きく保ちながら、ハッピーパスのゲートを取り除きます。

---

## どこでコードの変更になるか

線はきれいです。ここまでのすべて、つまり自律の姿勢ルール、エッジブロックを生む Unit 分解、プロジェクトのチェックコマンドと保護された仕様、補完するセンサーは、`core/` の下やプロジェクト設定であなたが書くデータです。コードに触れずに Construction を形づくります。

スウォームの機構はコードで、それを形づくるのは開発者リファレンスの領域です。

- **referee** `aidlc-swarm.ts` — ステートレスな `prepare` / `check` / `finalize` サブコマンドです。保護された Code Generation の prepare は、レガシー自律でも新しいチェックポイントでも、まずすべての Unit の承認済み Testing Contract、フィンガープリント、コミット済みの親ソースを検証し、それからワークツリーを fork します。各新しいワークツリーは、intent の記録をプロジェクトが持つままに（コミット済みでもそうでなくても。finalize が持ち帰る記録です）始まるので、ワーカーはその Unit の機能設計を読みます。`--resume-existing` は、その子が生き延びても検証済みのネイティブなソース着地の後に作り直されなければならなくても、拒否改訂を保ちます。残りのコマンドは判定を実行し、マージ前にすべての主張された Unit を再検証し（嘘をつくコンダクターのガード）、レビュー済みの記録アーティファクトと束ねられたソースマニフェストをスナップショットして着地し、ワーカーの他の記録編集（contract、そのプランが更新する business rule）を、インラインのビルドが残すように 1 行ずつメインの記録ラインに持ち込み、AIDLC メタデータのマージバックを直列化し、referee が所有する 6 つの `SWARM_*` イベントを発行します。git がマージできない記録編集は、プロジェクトのコピーをそのままにし、Unit のステージフォルダの `not-merged/` の下に保存し、1 行で言われます。次にコンダクターは、収束した各 Unit について `aidlc-worktree merge` を呼びます。その別個の不変なソース着地が `SWARM_SOURCE_MERGED` を発行します。
- **エンジン** `aidlc-orchestrate.ts` - ちょうど 6 つのサブコマンドを持つ決定論的なルーターです。`next`、`continue`、`report`、`park`、`team-board`、`wait` です。`continue` は内部のステアリング転送、`team-board` は読み取り専用の Team Construction クエリ、`wait` は委譲された作業の、境界のある読み取り専用の待機です。Construction のバッチがいつスウォームに適格かを決めます。
- **Bolt-DAG パーサー** — エッジブロックを `runtime-graph.json` に読み込むコンパイルステップです。

3 つすべての規範的な契約は[Skill System § 6](../reference/17-skill-system.md#6-the-swarm-referee-the-driver-seam-and-the-bolt-dag)で、`bolt_dag` ノードのスキーマは[Runtime Graph](../reference/13-runtime-graph.md)にあります。コンダクター自身の章は[Orchestrator](../reference/03-orchestrator.md)です。

ユーザーガイドの[Construction flow](../guide/04-phases-and-stages.md#phase-3-construction)は、適格でソースを生む単独パスを示します。実際の統合された Unit チェックと人間のスケルトン承認、続いて提示されたときの **Continue automatically** / **Review each checkpoint** です。レガシーの最初のステージレビューと、保たれた設計のみ・Unit 無し・チーム所有のパスも区別します。自律の選択は、実行とは独立に通常の完了承認を制御します。7 つの `SWARM_*` 監査イベント（referee からの 6 つ、ソース着地からの `SWARM_SOURCE_MERGED`）は[State and Audit](../guide/10-state-and-audit.md)にカタログされています。

---

## 次へ

- **[新しいハーネスへの移植](09-porting-to-a-new-harness.md)** — このガイドの集大成です。`core/` のすべてのデータ面を形づくりました。最後のステップは、その core を*新しい* CLI に描くことです。1 つの `harness/<name>/` ディレクトリ、マニフェストの行、フックのアダプター、パッケージの決定性のゲートです。
- [ハーネスエンジニアガイドの概要](00-overview.md)に戻れば、形づくるデータ面の完全な地図があります。
- コードレベルのスウォーム、エンジン、Bolt-DAG の契約は[開発者リファレンス § Skill System](../reference/17-skill-system.md)です。Construction を形づくることがデータ編集でなくなり、コードの変更になる線です。

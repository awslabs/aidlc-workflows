# テスト

## 概要

AI-DLC のテストスイートは**すべて TypeScript** です。各テストは `bun` のもとで実行される `t*.test.ts` ファイルで、シェル（`.sh`）のテストファイルは 1 つもありません。これは構成そのものによるプラットフォーム不変性の保証です。同じファイルが macOS、Linux、ネイティブ Windows で同一に実行されます。

スイートは **4 つのレベル** `smoke`、`unit`、`integration`、`e2e` に分かれており、それぞれ `tests/` 以下に 1 つのディレクトリを持ちます。この 4 レベルは、速度と網羅性のバランスをとる古典的な 3 層のテストピラミッドに対応します。

```
            /\
           /  \    ACCEPTANCE — full workflows, artifact + experience verification
          / L3 \   Level: e2e  ·  When: local --release/--all; pre-release confidence
         /------\
        /        \
       /   L2     \  STAGE — individual stages with stub input, verify artifacts
      /------------\ Level: integration  ·  When: local default/--ci; PR gates
     /              \
    /      L1        \  PROTOCOL — contracts, structure, cross-references
   /------------------\ Levels: smoke + unit  ·  When: local changes and PR CI
```

`--ci` プロファイルとフラグなしの既定は、どちらも **smoke + unit + integration** を実行します（つまり integration レベルはローカルの `bun tests/run-tests.ts` のたびに一緒に走ります）。`--release` / `--all` は `e2e` を加えます。上のピラミッドは各レベルが概念的にどこに位置するかを示すもので、実際の選択は後述のプロファイルフラグで行います。

### テストの境界と担当

ディレクトリは実行の選択子であって、コストの約束ではありません。特に `unit` には現在、CLI、インストーラー、ネイティブビルド、完全なワークフローのテストが含まれます。`--no-llm` はモデルゲートを閉じますが、テストを独立したユニットテストに変えるわけではありません。テストは、そのアサーションが検証する境界で分類します。

| 種類 | 何を証明するか | 既存の例 |
| --- | --- | --- |
| Unit | 制御された入力を使い、関数の直接呼び出しを通してルールや変換を検証する | バージョン文法、ドキュメントスキーマ、シャード選択 |
| プロセスまたはアダプター契約 | 実際の境界における終了ステータス、stdin/stdout、ファイルシステムへの影響、ハーネスのペイロード | フックアダプター、インストール、プロセスのクリーンアップ |
| 決定的ジャーニー | 複数のエンジンステップ、応答、ガードが組み合わさり、期待される結果になる | プラン承認、scope runs、guard matrix |
| ライブジャーニー | 実際のエージェントとハーネスが、人の期待する結果を届ける | SDK、ターミナル、IDE の受け入れジャーニー |

入力のバリエーションは、契約を忠実に検証できる最も安価な層に置きます。プロセス・並行性・プラットフォームの検査は、その境界自体が検証対象の挙動であるときに置きます。ライブジャーニーは正確な失敗注入の代わりにはなりませんし、アダプターの配線を証明するためにすべてのユニット入力をすべてのハーネスで再生する必要もありません。

リグレッションを追加する前に、同じ挙動を担当するスイートを探してください。セットアップと境界が一致するなら、それを拡張します。2 つ目の `covers:` クレームのために、同一の入力とアサーションを 2 回実行する必要はありません。1 つのケースで、コマンド・状態変化・監査イベントをまとめてカバーできます。繰り返されている本体を削除する前に、フィクスチャ、フック、パラメータ表、プラットフォーム実装を比較してください。

オンボーディング契約は `t-tui-onboarding` が担当します。`t-e2e-driver-isolation` は IDE のプロセス/プロファイル分離のケースを担当します。`t47-failure-injection` は 4 つの CLI 失敗とその `ERROR_LOGGED` の証跡を担当します。これらの固有のアサーションは、別のファイルで再生されるのではなく、それぞれのスイートに残ります。

リリースフィクスチャは、生成された copy/native ツリーを読み、独立したアーカイブを構築し、要求されたバージョンを各アーカイブのスタンプにメモリ内で適用します。すべての配布物のディスクコピーをもう 1 つ持つ必要はありません。各呼び出しは現在のソースを読み、自分の出力を持ちます。後のソース変更は反映され、1 つのフィクスチャを壊しても別のフィクスチャや生成されたツリーは変わりません。

4 つの選択子と現在の CI 送り先は、より広いインベントリが issue #2774 で再編成される間も据え置かれます。ファイルを移動する際は、その発見、カバレッジクレーム、プラットフォーム選択、シャードアフィニティ、マージ前に必須の実行を保たなければなりません。セットアップ時間、テスト時間、ランナー使用量は別々に測定します。ディレクトリ移動やケース数の減少だけでは性能上の成果とは言えません。

`tests/harness/test-budget.ts` の共有ポリシーは、タイムアウトを失敗のバックストップとして扱います。コールドインポート、アンチウイルス、プロセス生成、プロバイダのスケジューリングはランナーによって大きくばらつきます。1 回速く走ったことが適切なタイムアウトを定めるわけではありません。指定のない決定的ケースは、どの OS でも 10 分を得ます。1 つのフィクスチャ全体で共有プロファイルを選び、より小さい運用上のオーバーライドは取り除いてください。

| ワークロード | 既定の上限 |
| --- | --- |
| ネイティブプロセスまたは CLI の起動 | 5 分 |
| ランタイム引き継ぎフィクスチャ | 20 分 |
| コンパイルまたは projection 生成 | 15 分 |
| フィクスチャのセットアップおよび CLI 負荷の高いケース | 30 分 |
| マルチワークツリーのケース全体 | 60 分 |
| ライブ起動 | 10 分 |
| ライブコマンドまたはアーティファクト生成作業 | 30 分 |

これらは上限です。成功した操作はすぐに返ります。テストが意図的に検証するタイムアウトは、明示的かつ短いままにします。担当、終了ステータス、再帰、人の境界、その他の正しさに関するアサーションは引き続き強制されます。経過した実時間はこれらのアサーションの代わりにはなりません。テストが性能ではなく挙動を証明するときは、直接の状態か注入したクロックを使ってください。

本番のツールとスタンドアロンバイナリのゲートは、`core/tools/aidlc-runtime-budget.ts` に運用上の既定値を共有しています。[runtime and native hook budgets](06-hooks-and-tools.md#runtime-and-native-hook-budgets) を参照してください。明示的な呼び出し側の予算や、意図した応答性の契約は、既定の実行バックストップとは別に保たれます。

予算のレビューには、ネストしたサブプロセス、セットアップ、ポーリングの期限、クリーンアップ、CI の制限が含まれます。Bun のケース上限だけを引き上げても、より短い子プロセスの上限は直せません。ドライバの操作は、実際に親に残っている予算を使います。順次の操作はその予算を共有します。後続の操作すべてに最大限の割り当てを確保しないでください。ライブケースのヘルパーは、作業・セットアップ・クリーンアップの各フェーズを囲むように寛大な Bun 上限を与えますが、権威を持つのはファイルの期限です。先行する作業がファイルの時間を消費した後に、各フェーズに最大値を約束するわけではありません。

インフラストラクチャも同じ共有ポリシーを使います。

| 操作 | 既定の上限 |
| --- | --- |
| プロセス識別情報の発見 | 10 分 |
| 1 回のプロセス照会または終了呼び出し | 5 分 |
| プロセスツリーのクリーンアップ | 15 分 |
| スーパーバイザーの終了とステータス公開 | 17 分 |
| 最終的なターミナル出力のドレイン | 2 分 |
| ターミナルクライアントのシャットダウン（デーモンの退役を含む） | 合計 19.5 分 |
| ワーカーのクリーンアップと確認 | 合計 20 分 |

これらは操作あたりの最大許容量です。ファイルのクリーンアップは一度だけ最大 5 分を確保し、親の期限が各操作の割り当てを切り詰めます。`remainingCleanupTimeoutMs` は、予約された末尾を含む元のハード期限を使い、作業予約を二重に差し引くことはしません。ハード期限が切れた時点では、最小限の即時退役の試行だけを許します。ターミナルクライアントは、1 つのシャットダウン期限を RPC とデーモン退役待ちの両方で共有します。ポーリングは必要な証跡が得られしだい返りますが、識別情報や退役の証跡が欠けていればやはり失敗します。

ディスパッチされたすべてのファイルは、通常の integration/SDK ファイルも含めて、独立したスーパーバイザー期限を持ちます。`--file-timeout N` はそれを秒単位で上限設定します（分離 E2E 以外では既定で 2 時間）。`--run-timeout N` は 1 つの作業期限を、セットアップと選択されたすべてのファイルで共有します。予算が尽きると見える形で失敗し、必須のアサーションをスキップすることはありません。ランは 1 つのクリーンアップ区切りを保つため、あるファイルのクリーンアップを早く終えても、予約された時間にさらなる作業を入れることはできません。ドライバはファイルのエンベロープのうち最大 5 分をティアダウンに残し、その間もランナーは所有するプロセスを退役させ、作業が協調しなければ失敗を記録します。これらのフラグはディスパッチされた作業を制限します。コーディネーターの退役、フィクスチャの保持、レポートの公開はそれに続きます。そのネイティブなクリーンアップ検査も有界に保たれ、CI を囲むステップ/ジョブの制限が、収集に対する最終的な実時間のバックストップになります。プロセスのクリーンアップが不確かな場合は、フィクスチャを保持します。ログには、解決された許容量、絶対期限、クリーンアップ予約が記録されます。

配布物のカバレッジは契約ごとに分かれています。

- `t145-packaging-parity.test.ts` は、copy、native、plugin の各 projection が、独立した 2 回のクリーンなパッケージャー実行にわたって決定的であることを証明します。
- `t238-build-binaries.test.ts` は、スタンドアロンバイナリのクロージャをコンパイルして調べます。ネイティブルート、フック/アダプター、プロジェクトの変更、そして `PATH` に `bun` がない状態での最終的なインストール後のレイアウトを含みます。
- `t242-plugin-state.test.ts` は、ホストインベントリの正規化、構成ハッシュ、トランザクショナルな同期のロールバック、所有権を守る prune を証明します。
- `t243-install-mechanism.test.ts` は、アーカイブの拒否、共有トランザクションエンジンとリカバリ経路、プロジェクトの init/refresh の所有権、チェックサム、ライフサイクル、ピン、オフラインパッケージ、copy/native projection の分離をカバーします。
- `t244-install-management.test.ts` は、マシン構成、アップデートの発見、インストーラーのハーネス選択、Windows のライフサイクル面、補完、リリースワークフローの候補の連続性をカバーします。
- `t330-release-channel-grammar.test.ts` は、閉じた stable と preview のバージョン ID 文法、そのインストーラーとライフサイクルのリテラル、ランチャーシム経由で走る preview インストールをピン留めします。
- `t331-preview-channel-lifecycle.test.ts` は、`config --channel`、チャネルを意識した `update` と `update --check`、API 失敗を利用不可として扱うこと、stable への切り戻し、preview の保持、preview のピンをカバーします。
- `t332-preview-release-pipeline.test.ts` は、注釈付きタグの prerelease 公開、preview のプランナーとノート、プランレコードをカバーします。1 UTC 日のうちに複数の変更済みソースの preview を検査します。スケジュール公開の後の手動実行も含みます。変更のないソースと追い越されたソースはスキップし、ドラフトと孤立したタグは、空いている id での再試行プランニングを許します。ワークフローのアサーションは、`main` が進んだ後に開始時のコミットをプラン・公開する実行、stable タグをスケジュール/手動の preview から分離すること、共有の `release-preview` 並行性、契約ゲートの祖先関係、チャネル固有の provenance 署名者、ビルドのスタンプ、そして preview ワークフローを失敗させずに preview をビルドし続ける失敗した Full Suite をカバーします。
- `t-ci-preview-test-report.test.ts` は、preview の Full Suite レポートをカバーします。各アーティファクト自身の実行から得た失敗ファイルとケース（ランナーのフィクスチャ実行は決して含まない）、失敗したジョブ、無害化されたマークアップ、レポートのサイズ予算、answers corpus のセクション（ライブアーティファクトの最終試行から読み、成功時も失敗時も、公開ノートには入れない）を扱います。
- `t-live-answers-nightly.test.ts` は、answers corpus の夜間実行をカバーします。日付ローテーション、Claude SDK ライブジョブでそれを開くスイッチ、報告されるが負債にはならないミス、そして例外を投げるドライブはやはり失敗すること、夜間レポートが読み戻すサマリーを扱います。
- `t-ci-full-suite-evidence.test.ts` は、任意の Full Suite 証跡インスペクターと、正確なコミット/実行の一致をカバーします。`t-release-promotion.test.ts` は、実際の Git 履歴を使い、preview の選択、正確なソースの保持、メタデータ、コントロールのスナップショット、再試行、エントリから描画される stable ページ（2.11.1 のページがゴールデン）、走査された貢献者リスト、main のメタデータ同期をカバーします。

テストランナーはテスト発見の前に、プロセスロックのもとですべての projection を再生成します。そのため新しいクローンは、既存の `dist/` バイトに依存しません。CI も、生成されたツリーを消費する各ジョブの前に明示的なパッケージステップを実行します。バイナリとリリースのパッケージャーは、`dist-release/` を読む前に自分で再生成と決定性の検査を行います。

リリース CI は、Linux、macOS、Windows にネイティブ smoke を加え、7 つのターゲットアーティファクトをそれぞれのネイティブランナーアーキテクチャ上でビルドし、Bun と Node.js が共有する文書化済みの `libgcc` と `libstdc++` のランタイム前提をインストールした後、使い捨ての Alpine コンテナで 2 つの musl プローブを実行します。musl マトリクスは `fail-fast: false` を使い、CI が 1 つのチェックサム検証済み候補をステージングする前に、両アーキテクチャが報告するようにします。Unix と Windows のライフサイクルジャーニーは、署名権限なしでそれらのバイトを消費します。ワークフローはその後それらを attest し、1 つのワークフローアーティファクトをアップロードします。`release` はタグとチェックサムを再チェックし、`GITHUB_TOKEN` でソースリポジトリに GitHub Release を作成し、アップロードされたアセットインベントリを候補と比較します。公開が候補を再ビルドしたり再パッケージしたりすることはありません。

`tests/harness/release-fixture.ts` は、生成された projection マニフェストから決定的なリリースディレクトリを構築し、リダイレクト、遅延、切り詰め、captive-portal、過大なメタデータ、欠落アセットといった障害を伴ってローカルで提供できます。フィクスチャを作成するには `bun tests/harness/release-fixture.ts --output <dir>` を実行します。通常のスイートはオフラインのままです。公開リリースのメタデータとチェックサムの契約チェックを有効にするには、t243 の実行時に `AIDLC_RELEASE_CONTRACT_LIVE=1` を設定します。

決定的な e2e スライス（`bash tests/run-tests.sh --debug -P 8 --e2e --filter "^t[0-9]"`）は CI で `--no-llm` を付けて実行され、ローカルの開発ループは既定で smoke + unit + integration になります。merge、worktree、swarm の経路に触れるブランチは、レビューラウンドの前にこのスライスをローカルでも実行すべきです。通常の Bolt と swarm 実行のモード境界のリグレッションは、既定のティアからは見えないためです。

**ファイル名の規約。** テストのファイル名は `t<NN>[-description].test.ts` です。存在するレベルディレクトリと、任意の人間向けの説明だけです。名前に**メカニズムのセグメントはありません**。テストのメカニズム（CLI を起動するのか、SDK を駆動するのか、ライブ TUI を描画するのか）は、その本体が実際に呼ぶドライバから計算される *導出集合* であって、ファイル名で宣言されるものではありません。各テストが何をカバーするかの機械検証されたインデックスは、ディスク上の `covers:` ヘッダーから `tests/gen-coverage-registry.ts` によって新たに構築され、ここで手入力の表に保持したりコミットしたりすることはありません。後述の [Test Registry](#test-registry) を参照してください。

### Markdown アダプターのカバレッジ

`core/tools/aidlc-markdown.ts` の `markdownBlocks` は、可視性、コンテナ、定義、クレーム分割を扱う唯一のブロックインタープリタです。`visibleMarkdownLines` がそれを投影します。これは組み込みの `Bun.markdown` レンダラーに支えられています。テストは、2 つ目の CommonMark オラクルを維持するのではなく、消費側の結果を守ります。別系統の `Bun.markdown.render` レビュー権限の経路は、既存のセキュリティカバレッジを保ちます。

- `t341-markdown-blocks.test.ts` は、作成された CommonMark/GFM のブロック境界の例、正確なインラインコードと HTML span の列、アダプターが補正する 4 つの `Bun.markdown` の逸脱（空のタスク項目、見出しやフェンスに入り込むテーブル、コンテナを抜けるフェンス、段落の下にインデントされたタグ）、描画を変えてしまうため除外すべきプローブ、文字も数字もない行、エンティティで綴られたプローブマーカー、描画予算、ダイジェストの fail-closed な質問境界、描画ツリーを偽造してはならない制御文字をカバーします。
- `t343-raw-html-consumer-contracts.test.ts` は、サマリーダイジェストと answers、Change Control セクション、生の HTML の内外での Plan Approval の選択/再ベースライン化を検査します。`t344-visible-markdown-goldens.test.ts` は、影響を受けない可視性とダイジェストのバイトをピン留めします。`t345-receipt-scope-migration.test.ts` は、v1/v2 の receipt の互換性とパーサーアップグレードのリカバリをカバーします。
- `t247-claim-sources-sensor.test.ts` は、可視性の安全性を両方向で守ります。隠されたテキストはクレームの根拠になれず、隠されたフェンスのように見えるテキストが、実在する参照定義を消したり、確認済みの前提を短くしたりすることもできません。同じ行の HTML コメント、処理命令、宣言、CDATA セクション、または閉じる生タグの後に続くテキストはクレームです。

## レイヤー 1: プロトコル（すべての変更、LLM なし）

LLM を呼ばずに、オーケストレーターの構造的な正しさを検証します。これらが通れば、プロトコルは内部的に整合しています。ステージが有効なファイルを参照し、入出力が正しく連鎖し、ルーティングテーブルがステージファイルと一致します。

**レベル:** smoke、unit、integration

**何をテストするか:**
- ファイルの存在、権限、命名規約（smoke）
- copy/native ディスパッチを通した 17 すべてのフックソース、ステージのフロントマター、ナレッジインベントリ（unit）
- scope とステージの対応付け、グラフの整合性、ステージ I/O の契約チェーン、プロトコル準拠（integration）
- ステージの出力からステップへの検証: 宣言されたすべての出力が instruction のステップで参照されていること（integration、`aidlc-validate.ts` CLI ツール経由で決定的）
- scope runs: 出荷されるすべての scope を、人の最初のリクエストから done まで駆動する（integration、`tests/integration/t-scope-run-*`、後述）
- scope-host runs: すべてのハーネスツリー（Claude、Codex、Copilot CLI、Kiro CLI、Kiro IDE、Cursor、opencode）で、各ツリー自身のフックを通して 1 つの classic ジャーニーを実行する（integration、`tests/integration/t-scope-host-*`、後述）
- guard matrix: 承認された作業のもとでファイルが変わったときに人が遭遇するもの。Guard Policy、レビュー上限、プラン承認ごと（integration、`tests/integration/t-guard-matrix-*`、後述）

**実行:** `bun tests/run-tests.ts --no-llm`。既定のプロファイルには integration レベルが含まれるため、ランには LLM が必要で、`claude` CLI が PATH にあると常にライブモデルゲートが開きます。`--no-llm` はそのゲートを閉じ、このレイヤーを LLM なしに保ちます。決定的なテストはそれでも実行されます。`bash tests/run-tests.sh` は既存の POSIX コマンド向けの互換ラッパーです。scope runs、scope-host runs、guard matrix は、`--filter` がそれらを選択したとき、または `--release`/`--all` を付けたときにのみ実行されます（CLI リファレンスを参照）。

### scope runs

`tests/harness/scope-run.ts` は、出荷される scope を、モデルなしで実際のエンジンを通して駆動します。スクリプト化された代役がエージェントを演じ、Claude スキルが行うようにエンジンのコマンドを実行し、Claude Code が発火させるであろうフックを発火させます。別の person スクリプトだけが、human-turn フックを通して質問やゲートに答える部分で、すべてのエンジン呼び出しは本番のガードプロファイルのもとで実行されます。各 `t-scope-run-<scope>.test.ts` ファイルは、散文ではなく、状態、監査レコード、ディレクティブ、ファイルを検査します。

- 実行されるステージとスキップされるステージが、ステージファイルの `scopes:` リストと一致すること。
- 人のものとして記録されたすべての決定が、person スクリプトが送ったターン（`tests/harness/person-turns.ts`）に裏付けられること。裏付けのないものがあるときは、ターンの台帳と各 intent の監査証跡・状態がテストのログフォルダの `unbacked-decisions-<id>/` の下に保持され、フィクスチャが削除されてもイベントの順序が残ること。
- scope ファイルのスイッチが状態とディレクティブに現れること。
- ランが done で終わり、すべての出力がディスク上にあること。

`t-scope-run-new-scopes.test.ts` は、独自のファイルを持たない出荷済み scope のいずれかを駆動するため、新しい scope は出荷された当日にカバーされます。`t-scope-run-moves-*` は、人自身の言葉、新しい作業とともに入力された設定、実行途中での切り替え、その日の中断からの再開をカバーします。新しい種類のステップを持つステージは、代役がそのステップを学ぶまでランに失敗します。ランが免除する既知のエンジンブロックは、`KNOWN_STOP_BLOCKS` にそれにちなんだ名前の `test.todo` とともに列挙されます。`t-scope-run-moves-own-file-*` は、各 Guard Policy のもとで、bugfix と、2 つの Unit をステージごとに構築する classic を歩きます（`tests/harness/own-file-moves.ts`）。エージェントが人にターンを渡すたびに、開いているステージが生成したファイルを 1 つ変更し、ステップを再表示するか `next` を実行します。各 move は、人が再び尋ねられるか作業が前進し、そのステップの後に拒否が戻ってこないときに合格します。CI は scope runs を独自の integration ジョブとして実行します。プルリクエストとマージキューでは Linux、夜間 Full Suite（その `scope_runs` ジョブ）と `full_verification` Full Suite では Linux、macOS、Windows です。3 つの classic own-file ファイルは `own-file-moves` として別に、マージキューとそれらの Full Suite で実行されますが、プルリクエストでは実行されません。

### すべてのハーネスツリーでの scope runs

`tests/harness/scope-hosts.ts` は、同じ代役と person スクリプトを、別のツールのツリー上で、そのツール自身のフックを通して実行します。各ホストはツリーを出荷どおりにインストールし、エージェントのシェルにそのツールが与えるもの（Codex の `CODEX_THREAD_ID`、Kiro の `KIRO_SESSION_ID`）を与え、あらゆる瞬間（チャット開始、人の入力や選択、シェルやファイルツールの実行、ヘルパーの送信、ターン終了）に、ツリーの配線が登録する各コマンドを、そのツールのペイロードを渡して実行します。`.codex/hooks.json`、`.github/hooks/aidlc.json`、Kiro CLI のエージェント JSON（`.kiro/agents/<agent>.json`、ツール名とそのエイリアスに対するグロブマッチャー。ヘルパーは自分のセッションのもとで自分のエージェントのフックを実行する）、Kiro IDE のフックカード（`.kiro/hooks/*.json`、ファイル名順の正規表現マッチャー。書き込みやコマンドの後にカードは実行されないため、Kiro と同じく次のカードがその作業を行う）、Cursor の `.cursor/hooks.json`（マッチャーなし。すべての回答は exit 0 の JSON で、ターン終了はフォローアップメッセージを送ることしかできず、ジャーニーはそれをブロックされた引き継ぎとして読む）、opencode のプラグイン（1 つの opencode プロセス、ホストが待つワーカースレッドに読み込まれる。拒否はフックが投げたエラー）です。`tests/unit/t-scope-hosts.test.ts` は、それらのペイロードを各ツールから記録したもの（`tests/fixtures/<tool>-hook-payloads`）と照合してピン留めします。各ツールの回答はそれぞれの形で読まれます。Codex と Kiro は exit 2 で拒否し、Copilot は deny 判定で拒否し、Copilot はフックが書き換えたコマンドを実行し、Kiro の person-turn フックはターンの最初の `next` を自分で実行することがあるため、エージェントはその応答に基づいて動きます。すべてのツール呼び出しがフックを発火させるため、拒否はランを止め、失敗するフックコマンドは問題になります。ホストは、インストールされたリリースがセットアップしたプロジェクト上でも実行できます（`ScopeHost.launcher`）。その場合、エージェントのコマンドと配線のフックは人の `aidlc` を通して実行され、代役はインストールされたエンジンが名付ける `aidlc engine ...` コマンドに基づいて動きます。リリースのアップデートチェックはこれを使います。

各 `t-scope-host-<harness>.test.ts`（`claude`、`codex`、`copilot`、`kiro`、`kiro-ide`、`cursor`、`opencode`）は 1 つのジャーニーを駆動します。design ステージをスキップした classic で、2 つの Unit を 1 つずつ構築し、それぞれでチェックポイントを置きます。最初の Unit のチェックポイントの後、人はその日の作業を中断し、新しいクローンから作業を拾い上げ（クローンが保持するものだけが残ったフォルダで、最初のクローンの監査シャードが最後にソートされる）、2 つ目のチャットで `/aidlc --resume` を使って続けます。ジャーニーは、scope runs が検査するもの、加えて 2 つの監査シャード、2 つのチャット、各 Unit のチェックポイントが一度だけ尋ねられること、人が遭遇すべきでない回り道（拾い上げたばかりの作業を再開するよう告げられるなど）がないこと、代役自身のステップの 1 つのために状態遷移ガードが脇に退くことがないこと（classic はガードを切って実行されるため、ヘルパーが取れないステップはそこでのみ現れる）を検査します。CI はこれらを独自の integration ジョブ（`scope-hosts`）として実行します。プルリクエストとマージキューでは Linux、夜間 Full Suite（その `scope_runs` ジョブ）と `full_verification` Full Suite では Linux、macOS、Windows です。

### guard matrix

`tests/harness/guard-matrix.ts` は、同じ代役を使い、各 Guard Policy（`off`、`relaxed`、`strict`）、レビュー上限、プラン承認設定のもとで、2 つの Unit（Requirements、Units Generation、Code Generation、Build and Test）を持つ classic を駆動します。各 `t-guard-matrix-<change>.test.ts` ファイルは、人が変更を加える地点で 1 つの変更を加えます。後続の Unit が承認済み Unit のファイルを編集する、手作業の編集、承認待ちの間のプラン編集、ステージ途中の pull、revert、人が求める 2 回目のレビュー、Unit 間のエンジンアップデート、人自身の off への切り替え、composed scope、そして出荷どおりの classic です。ドキュメントの変更は Functional Design も歩きます。Unit 2 が構築される間に、Unit 1 の承認済みの機能設計やコードプランが（Unit 2 のエージェントまたは人によって）編集されるか、設計が削除されます。これらの `-waves` ファイルは Functional Design をステージごとに実行し、その後、人が 1 つずつ Unit を求めます。ランが遭遇するすべての拒否には従います。人はエンジンが提示する救済を選ぶか、エージェントがそれが名付けるコマンドを実行します。各ケースは次を検査します。

- Guard Policy off では、人を拒否したり再び尋ねたりしないこと（変更されたドキュメントの場合、relaxed でも同じ。削除された場合は、それを再び作る一度の停止のコストがあり得て、再び作らなければならない）。
- ポリシーが on のとき、その変更について人は多くても一度だけ尋ねられること。
- そのステップが取られた後に拒否が戻ってこないこと（デッドロック）。
- 人のものとして記録されたすべての決定が、人が送ったターンに裏付けられ、ランが done で終わること。
- レコードが、変更された Unit ごとに、何が変わったかを名付ける CHANGE_ACCEPTED 行と人のための行をそれぞれ多くても 1 つ保ち、何も変わらなかったときは 1 つも持たないこと。

エンジンが現時点でブロックするケースは、そのブロックにちなんだ名前の `test.todo` で、本体に実際の検査を持つため、修正が入ればそれが有効になります。CI は guard matrix を scope runs と同じ場所で、2 つの所要時間を均衡させたジョブで実行します。どちらも `^t-guard-matrix-` を選択し、`--shard 1/2` と `--shard 2/2` がそのインベントリを重複なく分割します。最も長い変更マトリクスは、エージェント編集を手作業編集から、Unit ごとの削除をステージごとの削除から分けて、より小さいファイルに分けます。どのシナリオも、やはり新しいプロジェクトを開始し、同じ人の体験とレコードの検査を伴って完全なワークフローを実行します。分割された各ファイルは、元ファイルの所要時間の半分を見積もりとして開始します。通常の重み更新が、それを観測されたタイミングに置き換えます。

## レイヤー 2: ステージ（CI push、LLM、数分）

既知のワークスペースと状態のフィクスチャを使い、個々のステージを分離して実行します。決定的な入力を与えたときに各ステージが正しいアーティファクトを生成することを検証します。

**レベル:** integration

**何をテストするか:**
- プリフライトのヘルスゲート: Claude CLI が PATH にあること、AWS 認証情報が有効であること、Claude が応答すること（exit 0）、応答が空でないこと（preflight）
- CLI ツールのユーティリティハンドラ: intent-create、--doctor、--status、--stage、--phase（integration）
- greenfield/brownfield スタブを使った個々のステージ、アーティファクトの検証（integration）

**実行:** `bun tests/run-tests.ts --ci`

## レイヤー 3: 受け入れ（release、LLM、数時間）

完全なワークフローを実行し、体験を検証します。状態遷移を超えて、アーティファクトの内容、ステージ間の整合性、ドメインの正しさを検査します。

**レベル:** e2e

**何をテストするか:**
- brownfield スタブを使った bugfix の完全なライフサイクルとアーティファクトのアサーション
- greenfield スタブを使った POC の完全なライフサイクルとアーティファクトのアサーション
- 状態の進行、scope ルーティング、監査の完全性、jump のメカニズム
- ステージ instruction の品質（明瞭さ、論理の流れ、曖昧さの検出）に対する LLM による意味レビュー

**実行:** `bun tests/run-tests.ts --release`

## クロスプラットフォームのカバレッジ

テストスイートは、ネイティブの Bun ランナーを通して macOS、Linux、Windows で実行されます。

```bash
bun tests/run-tests.ts [--ci | --all --debug -P 8]
```

`bash tests/run-tests.sh ...` は POSIX 互換ラッパーとして残っており、同じ TypeScript ランナーに委譲します。リポジトリのテストと copy チャネルのフック/ツールには `bun` が必要です。ネイティブなリリース projection は、インストールされた `aidlc` バイナリを通してフック/ツールを呼び出します。Bash は主要なランナーの基盤ではありません。

ターミナルセッションは、3 つすべてのプラットフォームで既定でネイティブ `bun` を使います。`tmux` は Linux/macOS での明示的な代替です。macOS では、containment は開始時に検査されるプロセス識別情報と、継承された `AIDLC_TUI_CONTAINMENT` トークンを使い、launchd に再親化した後の、切り離された double-fork の子孫を見つけます。祖先関係から逃れ、かつスクラブされた環境で exec する子孫は、macOS では検出できません。Linux の subreaper containment と Windows の Job Object にはこの制限はありません。

**スイートに組み込まれた移植性の制約:**

- **パス**: `tests/harness/fixtures.ts` の `createTestProject` は一時的なプロジェクトパスを正規化し、JSON とネイティブ `bun` を通してきれいに往復できるようにします。
- **その場での編集**: テストでは TypeScript のファイル書き込みを優先してください。シェルヘルパーが避けられない場合は、BSD/GNU 固有の `sed -i` 形式を避けてください。
- **`grep -qiF`**: Git Bash には `-i` と `-F` を組み合わせたときの既知のバグがあります。パターンに正規表現のメタ文字がなければ `-i` だけを使ってください。修正される前は t16 がこれに当たっていました。
- **`tar` アーカイブ**: macOS の `tar` は既定で `._*` の AppleDouble サイドカーファイルを注入します。クロスプラットフォームのテスト実行のためにソースをまとめるときは、`COPYFILE_DISABLE=1 tar …` または `git archive` を使ってください。
- **Windows での LLM のタイミング**: Windows EC2 からの Bedrock 呼び出しは、macOS からより明らかに遅いことがあります（初回のコールドスタート、MSYS のプロセスフォークのオーバーヘッド）。SDK/tui テストは、ドライバの結果面に対してアサートし、ランナーのプリフライト/ファイル単位の Claude ゲートに、基盤の不在と本当の失敗を分けさせるべきです。

**Windows でスイートを手動で実行する:**

1. Bun **1.4.4 以降**、スイートのその他のツーリング用の Node.js、Claude Code CLI をインストールします。
2. フルスイートまたは POSIX ラッパーの互換性 smoke を実行する場合は Git for Windows をインストールします。ネイティブランナーの経路自体は Bash を必要としません。
3. Bun が `@xterm/headless` を解決できるよう、リポジトリの開発依存関係をインストールします。既定の Windows TUI バックエンドは Bun のネイティブ PTY を使います。
4. ライブの Claude TUI カバレッジには `AIDLC_TUI_LIVE=1` を設定します。`AIDLC_TUI_BACKEND` は未設定のままにするか `auto`/`bun` に設定します。必要に応じて `AIDLC_BUN_BIN` で具体的な `bun.exe` を選択します。
5. Kiro IDE スライスには、Kiro IDE をインストールしてサインインし、`AIDLC_KIRO_IDE_LIVE=1` を設定します。GUI テストは、そのユーザーがログインしているデスクトップセッションで実行します。スケジュールされたタスクは「Run only when user is logged on」を使って、このセッションでランナーを起動できます。既定の Windows バイナリは `%LOCALAPPDATA%\Programs\Kiro\Kiro.exe` です。`AIDLC_KIRO_IDE_BIN` でオーバーライドします。
6. `bun tests/run-tests.ts --all --debug -P 8` を実行します。

WSL や Docker は不要です。サポートされる検証基盤はネイティブ Windows です。

Kiro CLI のカバレッジには、サインイン済みのネイティブ `kiro-cli.exe` を `PATH` に置きます。`AIDLC_BUN_BIN` を検証済みの Bun 実行ファイルにピン留めし、そのディレクトリを `PATH` の先頭に保ってください。Kiro のインストールには古いバンドル Bun が含まれることがあります。ACP ファイルには `AIDLC_KIRO_ACP_LIVE=1` を設定します。ターミナルファイルには `AIDLC_KIRO_TUI_LIVE=1` と `AIDLC_TUI_LIVE=1` を設定します。ネイティブ Bun ターミナルバックエンドが Windows の入力と画面キャプチャを扱います。これらのファイルは、実行前に CLI、アカウント、選択されたターミナルバックエンドを検査し、サポートされる各プラットフォームで同じジャーニーのアサーションを行います。

**再現可能な MR10 Windows EC2 ランブック:**

1. SSM アクセスを備えた使い捨ての Windows Server 2022 ホストを立ち上げます。

   ```bash
   aws cloudformation deploy \
     --stack-name aidlc-windows-test \
     --template-file tests/harness/windows/windows-test.cfn.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides VpcId=vpc-... SubnetId=subnet-...
   ```

2. テスト対象のコミット済み git ツリーを同期します。

   ```bash
   bun tests/harness/windows/sync.ts --stack-name aidlc-windows-test HEAD
   ```

3. ボックスにリポジトリの開発依存関係をインストールします。

   ```bash
   bun tests/harness/windows/ssm-run.ts --stack-name aidlc-windows-test -- \
     powershell -ExecutionPolicy Bypass -File C:\aidlc\tests\harness\windows\setup.ps1 -ProjectDir C:\aidlc
   ```

4. ライブ TUI を有効にした状態で、Windows の `--all` ゲートを実行します。

   ```bash
   bun tests/harness/windows/ssm-run.ts --stack-name aidlc-windows-test -- \
     powershell -ExecutionPolicy Bypass -File C:\aidlc\tests\harness\windows\run-all.ps1 -ProjectDir C:\aidlc -Parallel 8
   ```

5. ホストを撤去します。

   ```bash
   aws cloudformation delete-stack --stack-name aidlc-windows-test
   ```

SSM オブザーバーは、API 照会とポーリングで 1 つの期限を共有します。期限が切れると、リモートの終了は未確認として報告され、遅れて届くターミナルの応答が、期限切れの観測を成功したランに変えることはできません。

`run-all.ps1` は、`bun tests/run-tests.ts --all --debug -P <N>` を呼び出す前に `AIDLC_BUN_BIN` と `AIDLC_TUI_LIVE=1` をエクスポートします。そのプリフライトは、共有の `selectedTuiBackend` と `tuiUnavailableReason` ヘルパーを Bun 経由で呼び、選択されたバックエンドの前提条件を検査します。Node はフルスイートのツーリングの前提のままです。前提条件の検査がジャーニーをスキップするとき、ライブのオプトインがカバレッジを確立するわけではありません。キャプチャされたファイル単位の結果を確認してください。スクリプトは `C:\Users\Administrator\.local\bin` と systemprofile のホームにわたって Claude バイナリを調べます。ネイティブインストーラーは、CloudFormation UserData のブートストラップを実行したユーザー（EC2Launch v2 では Administrator）の下に `claude.exe` を配置するためです。

スタックは、完全な `--all -P 8` ライブ実行向けに既定で **`c5.4xlarge`** です。より小さいホストは並列負荷のもとで競合を増やします。`InstanceType` を下げるときは、より軽いティア選択を使ってください。上記の共有タイムアウトのバックストップは、あるホストの観測された所要時間を性能要件として扱うことなく、ランナーのばらつきを許容します。

## ターミナルドライバ

`tests/harness/tui-drive.ts` は、名前付きセッションを通して対話的な CLI を駆動します。`tests/harness/tui-runtime.ts` の共有セレクターは、`AIDLC_TUI_BACKEND` からバックエンドを選びます。

| 選択値 | プラットフォームと前提条件 |
|-----------|----------------------------|
| 未設定または `auto` | Linux、Windows、macOS でネイティブ `bun`。 |
| `bun` | Linux、Windows、macOS。**Bun >=1.4.4**、`Bun.Terminal`、`bun:ffi`、`@xterm/headless` が必要。ネイティブ containment は x64/arm64 をサポート。Linux は pidfd のシグナリングと待機のために glibc、procfs、kernel >=5.4 が必要。Windows は ConPTY が必要。macOS は libSystem のプロセス識別情報と継承された所有権トークンを使う（環境スクラブの制限については [Cross-Platform Coverage](#cross-platform-coverage) を参照）。 |
| `tmux` | Linux/macOS での明示的な代替。ドライバを実行する Bun と `PATH` 上の `tmux` が必要。 |

`auto` はプラットフォームで選びます。前提条件が欠けているときに別のバックエンドにフォールバックすることはありません。空文字列を含む未知の値は設定エラーです。`AIDLC_BUN_BIN` は、`bun` と `tmux` のバックエンドに対して Bun 実行ファイルをオーバーライドします。1 つのセッションでは、コマンドをまたいで同じバックエンド選択を保ってください。ネイティブ Bun バックエンドは tmux を必要としません。

`tests/harness/tui-bun-backend.ts` のネイティブデーモンは、`Bun.spawn` のインライン `terminal: { ... }` オプションを使い、PTY とその出力コールバックを所有します。`tests/harness/tui-screen.ts` は、それらのバイトを `@xterm/headless` を通して解析し、エミュレーターの応答を PTY に返します。コマンドは、Linux ではローカルソケット、Windows では名前付きパイプを通してデーモンに届くため、PTY と画面は個別のドライバ呼び出しを超えて存続します。

各ネイティブセッションは、自身のデーモン、PTY、画面、認証済みの IPC エンドポイントを持ちます。並列ワーカーには、別々のセッション名、プロジェクト、`CLAUDE_CONFIG_DIR` プロファイルを与えてください。テストランナーは、ターミナルセッションの数とは独立に Bedrock の並行性を上限設定しなければなりません。

`tests/harness/tui-bun-process.ts` は、Linux の subreaper と pidfd 所有権、または Windows の Job Object で子孫を監督します。`kill` は、確認されたプロセスのクリーンアップとデーモンの退役を待ちます。`wait-dead` はデーモンのプロセス識別情報を検査します。開始ロックは OS が所有し、中断されたスターターが終了すると解放されます。フィクスチャのクリーンアップも、ネイティブセッションのクリーンアップが未確認の間はプロジェクトの削除を拒否します。

セッションレコードと最終スナップショットは `AIDLC_TUI_BUN_ROOT`（既定: OS の一時ディレクトリを使う `$TMPDIR/aidlc-bun-tui`）の下に残ります。既定のルートも明示的なルートもプライベートでなければなりません。POSIX ではモード **0700** で現在のユーザーが所有する実ディレクトリ、Windows では現在のユーザーの所有者 SID を持ち、Everyone、BUILTIN\Users、Authenticated Users に許可 ACE がないことです。シンボリックリンク、ジャンクション、その他の Windows リパースポイントは拒否されます。ドライバは、存在しないルートをプライベートな権限で作成します。安全でない既存のルートは、権限を変更するのではなく拒否します。POSIX では、明示的ルートのすべての祖先は現在のユーザーまたは root が所有し、sticky でない限り group/other の書き込みビットがないことが必要です。暗黙のルートの一時的な親は、現在のユーザー所有かモード **1777** でなければなりません。それらの祖先がサンドボックス uid 所有としてファイルシステムに報告される制御されたテストホスト（たとえば `/` が `nobody` に属するオーバーレイファイルシステム）では、`AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS=1` を設定すると所有権の要件だけがスキップされます。書き込みビットのルールとここでのその他すべての検査は引き続き強制されます。Windows はルート/セッションの所有者と DACL を検証しますが、祖先の ACL の信頼はまだ検証しません。後述の generation ハンドシェイクは引き続き強制されます。安全でない事前作成されたルートを削除するか、`AIDLC_TUI_BUN_ROOT` を信頼された祖先の下のプライベートディレクトリに向け、その設定をコマンドをまたいで一貫させてください。

テストランナーは、ログディレクトリの権限とは独立に、信頼された OS の一時ディレクトリの下に、各ファイルへ別々のプライベートなネイティブルートを与えます。確認されたトランスポートのクリーンアップの後、セッションレコードとスナップショットをそのファイルの `tui-bun/` アーティファクトにアーカイブし、一時的なネイティブルートを削除します。クリーンアップが不確かな場合は、診断のためにライブの名前空間を保持します。

起動レコードは、ルートとセッションの各ディレクトリのファイルシステム識別情報にピン留めされたプライベートな通常ファイルです。クライアントとデーモンの両方が、信頼する前に所有権、権限、セッション識別情報を検証します。デーモンはさらに、PTY やスーパーバイザーを作成する前に、スターターが argv を通して供給する新しい generation を持つ **starting** レコードを要求し、コマンドを解放する直前に両方の記録済みディレクトリ識別情報を再チェックします。再生された完了済みレコードはコマンドを認可できません。診断が信頼されないディレクトリに書き込まれることはありません。

ターゲットの終了ステータスと PTY の終了ステータスは別々です。Bun は、通常の Linux の slave-close EIO を PTY ステータス `1` として報告します。ドライバは、確認されたスーパーバイザーの終了とクリーンアップの後にそのステータスを受け入れます。Bun のコールバックは、他の POSIX read エラーを区別する errno を公開しません。到達不能なセッションと未確認のクリーンアップは引き続きエラーです。

キャプチャは、キューに入った出力が解析された後に、現在のアクティブなビューポートを読みます。プレーンテキストはソフトラップされた行を結合し、末尾の空行をトリムします。ANSI キャプチャは、パレットと RGB の色を含む現在のセルとその属性から再構築されます。スクロールバックと以前に消去された出力は除外されます。JSON は、空のセルと、全角文字のための幅ゼロの継続セルを含む完全な物理グリッドを保持します。

既存の `start`、`send`、素の `capture`、`startup`、`wait` の各コマンドは、その呼び出し規約を保ちます。`send --keys '<text>' --literal` はリテラルテキストを送ります。`--literal` なしでは、名前付きキーが解釈され、`1`/`2` のような任意のテキストはリテラルのままです。`--no-enter` が設定されない限り Enter が付加されます。`wait --stable-ms N` はその画面安定性の条件を保ち、`startup --ready-pattern '<regex>'` はその起動時のナビゲーション挙動を保ちます。

Bun バックエンドは、次のキャプチャと入力のコマンドをサポートします。

| コマンド | 挙動 |
|---------|----------|
| `resize --session <name> --width N --height N` | PTY とエミュレーターの両方をリサイズする。列 2–500、行 1–200、最大 40,000 セル。 |
| `paste --session <name> --text '<text>'` | **暗黙の Enter なし**でテキストを貼り付ける。アプリケーションがそのモードを有効にしているときだけ bracketed-paste マーカーを使う。CRLF と単独の LF は CR になり、既存の単独 CR は保持される。 |
| `capture --session <name> --physical` | 物理的な可視行を伴うプレーンテキストを返す。既定の論理キャプチャ API は保つ。 |
| `capture --session <name> --json` | 完全なセルデータを持つ整合した `TuiSnapshot` を返す。 |
| `capture --session <name> --ansi` | 現在のビューポートを、セルの色とスタイルを ANSI シーケンスとして返す。 |

メニュー検出は常に物理行を消費します。Bun は `text`、ラップフラグ、ANSI を変えずにスナップショットのセルからこれらを導出します。tmux はこれらの読み取りで `-J` を省きます。これにより、ConPTY のラップメタデータが可視のメニュー選択肢を前の行に結合するのを防ぎます。外部の自動化は、`--json` や `--ansi` とは別に `capture --physical` を選べます。

`wait --pattern` と `startup --ready-pattern` は既定で `--view auto` です。物理テキストが先に試され、同じフレームの論理テキストがフォールバックになります。これにより、本物のソフトラップにまたがるリテラルパターンを保ちつつ、行にアンカーされた UI パターンもサポートします。1 つの解釈を選ぶには `--view physical` または `--view logical` を使います。Bun は両方を 1 つのスナップショットから得ます。tmux は両方を 1 つの同期コマンドリストでキャプチャします。メニューアクションは、パターンビューの選択にかかわらず常に物理ビューを調べます。安定性は、全体の期限を再開することなく、一致したビュー上で測定されます。

ライブの待機は、時計だけでなく、画面が表示するものに基づいて終わります。待機がエージェントの作業を見た（ステータススピナーと経過タイマー、バックグラウンドエージェントの待機、実行中のサブエージェントの行、または実行中コマンドのバックグラウンドのヒント）後、Claude の空のプロンプトが 30 秒間変わらないままだと、ターンは終了しています。`wait` はそのパターンが一度も描画されなければ最後のペインとともに失敗し、`answer-gate` はメニューが現れずその終端条件が満たされなければ失敗し、リビジョンリカバリは自由記述のフィードバックをそのアイドルプロンプトでのみ入力します。ドライバが認識しない画面は作業中として数えられるため、ハングのバックストップは引き続き適用されます。記録されたセッションを通じて、ターン内で最も長いアイドルに見える一時停止は 0.5 秒未満でした。`wait --through-turn-end` はターンの終わりを過ぎても待ち続けます。`answer-gate` は、ハイライトされた選択肢からフッターまでのメニューの行が 0.5 秒にわたって同じに読めたときにのみメニューに答えます。そのため描画の途中で捉えられたメニューは、その前半だけで答えられることはありません。5 秒後もまだ変化している行は、メニュー待ちに戻されます。メニューに答えた後、キャレットと、自分のキーが動かすチェックボックスのマークを除いて、ハイライトされた選択肢からフッターまでのそのメニューの行が変わらないまま、最大 5 秒待ちます。そのため、遅いまたは部分的な再描画が二重に答えられることはありません。それらの行が再描画されるか、その終端条件が着地すると待機を止め（`--stop-at-approval-gate` を付けると、再描画だけが終わらせます）、5 秒後もなお無傷のメニューは再び答えられます。

`resize`、`paste`、`capture --json` は Bun バックエンドを必要とします。ANSI キャプチャは tmux でも利用できます。`--json` と `--ansi` は相互排他です。

これらは同じドライバを通して呼び出します。たとえば次のとおりです。

```bash
bun tests/harness/tui-drive.ts resize --session demo --width 120 --height 40
bun tests/harness/tui-drive.ts paste --session demo --text "draft input"
bun tests/harness/tui-drive.ts capture --session demo --json
```

`TuiSnapshot` は `tests/harness/tui-screen.ts` で定義されており、`sequence`、`cols`、`rows`、ゼロ始まりの `cursor: { x, y }`、`buffer`（`normal` または `alternate`）、`text`、`ansi`、`lines` を含みます。各行は `wrapped` フラグと `cells` 配列を持ちます。各セルは `chars`、`width`、`fg`/`bg` の色（`mode: default|palette|rgb`、数値 `value`）、およびブール値の `bold`、`dim`、`italic`、`underline`、`inverse`、`invisible`、`strikethrough` の属性を持ちます。sequence は、解析された出力やリサイズの後に進みます。変化のないキャプチャは進めません。ラップが保留中のとき、カーソルの `x` は `cols` と等しくなることがあります。

ユニットスイート `tests/unit/t-tui-runtime.test.ts` と `tests/unit/t-tui-screen.test.ts` は、ランタイム選択とターミナルのトランスクリプトに対する決定的な検査を定義します。スクリーンスイートには、次に対する UTF-8 のリグレッションが含まれます。

- 正確に 85 バイトの ANSI/Unicode プリフライトペイロードを、空の端チャンクを含む 86 通りの 2 チャンク分割位置すべてで。
- 1 から 85 バイトまでのすべての固定チャンクサイズで、書き込みの間にパーサーをドレインする。テキスト、物理セル、幅、色、ANSI が一致しなければならない。
- `0x80` 継続バイトを含む、選ばれた 2、3、4 バイト文字のすべてのバイト分割。
- 残りのバイトが届くまで `flush()` 呼び出しをまたいで保持される不完全な UTF-8。
- 不正な UTF-8 が、静かに消えるのではなく `U+FFFD` 置換セルとして描画されること。

スクリーンは、xterm の文字列 API の前に増分的な `StringDecoder` を使います。xterm 5.5 のバイトデコーダは、保存された継続バイトが `0x80` のとき、断片化された em ダッシュ（`E2 80 94`）のように文字を失うことがあります。

`tests/unit/t-tui-bun-process-linux.test.ts` は実際の Linux の監督を検証します。`tests/integration/t-tui-bun-lifecycle.test.ts` は Windows Job Object、シグナル、子孫のクリーンアップをカバーします。`tests/unit/t-tui-process-identity.test.ts` は、中断されたスターターを含め、識別情報とロック解放をカバーします。`tests/integration/t-tui-bun-backend.test.ts` は、8 つの同時セッション、入力、ANSI/セルのキャプチャ、リサイズ、貼り付け、再起動、IPC エラー、デーモンの退役を含めて、トークン不要のターゲットに対して公開 CLI を実行します。

TUI プリフライトは、選択されたバックエンドをキャリブレーションします。ネイティブのライフサイクルは上記の別のカバレッジを持ちます。ライブモデルのジャーニーは既存のオプトインを保ちます。一時的な Claude のフィクスチャは、開発用の instruction や外部インポートのプロンプトを継承しないよう、リポジトリの祖先の外に置いてください。

## プリフライト検証

フィルタのないライブ対応レベル（integration または e2e）を実行する前に、ランナーは `tests/integration/t19.test.ts` をゲートとして実行します。これは **Claude Agent SDK**（integration ティアが使うのと同じライブ経路）を通してごく小さな実際のターンを駆動し、決定的な面に対してのみアサートします。スキップされたプリフライトは、既定のランを失敗させずに Claude ゲートを閉じます。`AIDLC_CLAUDE_SDK_LIVE=1`、`AIDLC_TUI_LIVE=1`、または `--require-coverage` は、代わりに完全でスキップのない合格の証跡を要求します。実際のプリフライトの失敗、タイムアウト、クリーンアップエラーは、どのモードでもランを失敗させます。プリフライトがスキップされても失敗しても、決定的なファイルはやはり実行され、Claude 依存のファイルはファイル単位の `SKIP` エントリを受け取ります。

SDK ドライバは、各 `driveAidlc()` 呼び出しに一時的な `CLAUDE_CONFIG_DIR` を与え、セッションの永続化を無効にします。そのためライブテストは、コマンドサンドボックス内でホームディレクトリが読み取り専用のときも含め、ユーザーの `~/.claude.json` と Claude のトランスクリプトに手を触れません。呼び出し単位の `env.CLAUDE_CONFIG_DIR` は、焦点を絞ったキャリブレーションのために引き続き利用できます。

1 つのドライブは 1 つのセッションで、既定では最初のターンの結果で終わります。人の次のメッセージを必要とするジャーニーは `nextMessage` を渡します。ターンが終わると、ターン番号と、それまでのドライブの累計（ピッカー、ツール結果、Stop フック。1 ターン分には前のターンの累計を引く）を受け取り、同じセッションに送るメッセージを返します（または何も返さずドライブを終える）。`chatAboutQuestionWhen` は、Claude Code の "Chat about this" ボタンと同じようにピッカーに答えるため、質問は開いたままになります。`answerScript` の仕様 `{ text }` は、人自身の言葉をピッカーに入力します。`captureStopHooks` は、各 Stop フックの判定をそのターンとともに記録します。`stopWhen` は、それまでのツール結果がそれを満たした時点でドライブを終えます。これは、複数の結果を必要とする停止（作業を作るステップの前か後に届き得るエンジン行）向けです。

Claude Code セッションの内側から起動されたスイート（`CLAUDECODE=1`）は、そのセッションの `ANTHROPIC_DEFAULT_*_MODEL` の既定をそのドライブに渡しません。SDK にバンドルされた Claude Code がセッションのモデルより古く、それを拒否することがあるためです。ドライブの最終プロバイダが Bedrock のとき、プロジェクト設定やテストが設定しなかったモデルには CI のピン留めされたモデル（`scripts/ci-credential-broker.ts` の `CI_BEDROCK_MODELS`）が与えられ、それ以外はバンドルの既定が使われます。CI を含むその他のシェルからのランは、その環境を変えずに保ちます。

| アサーション | 面 | 失敗時 |
|-----------|---------|---------|
| AWS 認証情報が有効 | `aws sts get-caller-identity` が exit 0（`aws` CLI がない場合はスキップで PASS） | bail — Bedrock には IAM 認証が必要 |
| ライブターンが終端の結果に達する | SDK 実行が `undefined` でない `resultEvent` を生成する（ティアが必要とするバイナリが存在し到達可能） | bail — 基盤/API に到達不能 |
| ターンがエラーなく完了する | `resultEvent.is_error === false`（`claude -p` の exit 0 の決定的な等価。124/137 のハングはこれを undefined のままにする） | bail — API が無応答 |
| 応答が空でない | 実行が *何らかの* 出力を捉えた。`tool_result` またはアシスタントのテキスト（内容ではなく存在） | bail — API が何も生成しなかった |

ここでの red は本物の環境の所見（`claude` の欠如、期限切れの認証情報）であって、やわらげるべきフレークではありません。まさに、下流の LLM ティアを素早く打ち切るというゲートの役目です。

## Test Registry

スイートは**登録されるのではなく発見されます**。`bun tests/run-tests.ts` は 4 つのレベルディレクトリ（`tests/{smoke,unit,integration,e2e}/`）を歩き、見つけた `t*.test.ts` をすべて実行します。同期を保つべき手入力のテスト単位の表はありません。テストファイルを追加するだけで、ランナーがそれを拾います。

各テストが *何をカバーするか* は、`tests/gen-coverage-registry.ts` が、テストファイルの先頭コメントブロックの `covers:` ヘッダー（通常は 1 行目。いくつかのファイルは正当に 1 つも宣言せず、単にカバレッジクレームに寄与しない）から機械的に追跡します。ジェネレーターは、フレームワークのユニットを 7 つのクラス（`function`、`audit`、`scope`、`stage`、`hook`、`subcommand`、`render-surface`）にわたって列挙し、各 `covers:` クレームを列挙されたユニットに対応付け、ユニットごとにそのクレームとステータスを持つエントリを 1 つ構築します。

レジストリは**決してコミットされません**。コミットされたコピーはほぼすべての PR で変わるため、キューに入った PR がそれで衝突したり、リベースのたびに再生成しなければならなかったりしました。代わりに CI がそれを新たに構築します。必須の `Tests (smoke + unit)` チェックの一部である、まとめられた **Checks** ジョブのカバレッジステップが `--check --base HEAD^1` を実行します。これは、テスト対象のコミットとその最初の親（PR のベース、またはキューで前に並ぶエントリ）についてレジストリを構築します。親は独自のパッケージャーとジェネレーターで一時ディレクトリに構築され、親がカバーしているのにコミットがまだ保持していながらもはやカバーしなくなった各ユニットを名指しして失敗します。カバレッジは増えることしかできません。クレームのない新しいユニットは列挙されますが失敗することはなく、コードが削除または改名されたユニットは損失になりません。テストがなくなるときにユニットのカバーを保つには、それを検証する別のテストにその `covers:` クレームを追加します。

```bash
bun tests/gen-coverage-registry.ts                             # write tests/.coverage-registry.json locally (gitignored)
bun tests/gen-coverage-registry.ts --check                     # the anti-rot guards on a fresh build
bun tests/gen-coverage-registry.ts --check --base origin/main  # and fail if a unit main covers lost its claim
```

ジェネレーターは、パッケージ化された `dist/claude` ツリーからユニットを読みます。そのツリーが、チェックアウトとは別のソース（`core/`、`harness/`、`plugins/`、またはパッケージャー自身のスクリプト）からパッケージ化された場合、両方のコマンドは 1 行で拒否します。まず `bun scripts/package.ts` を実行してください。`package.ts` は、入力のコンテンツフィンガープリントをハーネスごとに `dist/.package-sources.json`（`scripts/package-sources.ts`）に記録するため、編集を元に戻すのに再ビルドは不要です。入力が途中で変わったビルドは記録されず、再度実行するよう告げて失敗します。ジェネレーターの `AIDLC_COVERAGE_*` のシームから生じる一時ツリーには `core/` がなく、チェックされません。

ある関数、監査イベント、scope、ステージ、フック、サブコマンド、レンダーサーフェスをどのテストが検証するかを調べるには、レジストリをローカルに書き出して読むか、`covers:` ヘッダーを直接 grep します。unit ティアはすべてのツリーで `--check` を実行するため、壊れた列挙器はゲートを red にします。

> **注:** t19 は unit（`tests/unit/t19.test.ts`、jump CLI ツール）と integration（`tests/integration/t19.test.ts`、ライブプリフライトゲート）の両方に現れます。こうした衝突は、素の ID ではなく、レベル/ファイルパスで区別します。

## トリガーポイント

| トリガー | レイヤー | コマンド | 場所 |
|---------|-------|---------|-------|
| `git commit` | L1 | `bun tests/run-tests.ts` | ローカル（pre-commit フック） |
| プルリクエストの push | 高速な決定的ゲート | `ci.yml`: 契約/Linux smoke/production-guard をまとめたジョブ、加えて 10 個の重み付き Linux unit シャードと、`deterministic-tests.yml` を使う 5 つの決定的 integration ジョブ。クロス OS のネイティブターミナルとライブ OS 分離のジョブはスキップされる | GitHub Actions |
| マージキュー（`merge_group`） | 完全な決定的ゲート | `ci.yml` が、キューに入ったマージコミットに対してプルリクエストのゲートを Linux、macOS、Windows で再実行する（10 個の Linux unit シャード、16 個の Windows unit シャード。scope runs、scope-host runs、guard matrix は Linux のみ。macOS では unit ティアは、macOS を名指す unit ファイルと変更が触れるファイルだけを、16 シャードではなく 2 ジョブで実行する）。各 OS に分離 E2E を加え、アサーションで失敗した smoke、unit、integration ファイルを `Flaky test` 警告とともに一度再試行し、ネイティブターミナルの unit（Linux arm64、macOS、Windows）とライブ OS 分離の検査（Linux、macOS、Windows）、さらに 3 つの参考扱いの Windows レーンを加える。同じコミットからステージングされたリリース候補に対する Windows PowerShell 5.1 での文書化済み `install.ps1` ワンライナー、`PATH` から Git Bash を除いたフック契約、WSL 1 内で文書化済み `install.sh` でインストールしたコンパイル済みバイナリに加えた smoke ティアである | GitHub Actions |
| 手動の決定的ワークフローディスパッチ | 的を絞った決定的再現 | `deterministic-tests.yml` は、不変のソース SHA、ランナー、ティア、unit に必須の N/M シャード、任意の `integration-shard`、任意かつ手動専用の `diagnostic_filter` を受け付ける。1 つのランナーがモデルゲートを閉じて実行する | GitHub Actions |
| `platform_regressions=true` を付けた手動 CI ディスパッチ | 拡張された決定的マトリクス | `ci.yml` が、まとめられた check ジョブで Linux smoke を実行する。共有ワークフローが macOS/Windows smoke、10 個の Linux と 16 個の macOS/Windows unit シャード、integration と分離 E2E を、scope runs、scope-host runs、guard matrix を Linux で、実行する | GitHub Actions |
| 夜間 preview / 手動 preview ディスパッチ | 宣言された夜間マトリクス | `preview-release.yml` が、変更のないソースに対しても `full-suite.yml` を呼び、ネイティブの義務、リリース契約、有界なホスト型ライブシャード、そして scope runs、scope-host runs、guard matrix を Linux、macOS、Windows で実行する | GitHub Actions |
| `full_verification=true` を付けた明示的な手動 Full Suite | 認証情報なしの候補検証 | 未マージの PR を含め、選択されたワークフローヘッドに対して OIDC や AWS 認証情報を受け取らないすべてのジョブを実行する。ライブレーンには `live_verification` が必要。別の証跡は stable の公開に消費されない | GitHub Actions |
| `live_verification=true` を付けた明示的な手動 Full Suite | 候補のライブ検証 | 選択されたワークフローヘッドに対してのみ、ライブ準備とホスト型ライブ/リリース契約のジョブを実行する。別の証跡は stable の公開に消費されない | GitHub Actions |
| preview の昇格 | 正確なソースのリリース検証 | `release.yml` が preview の親と、許可されたメタデータ/コントロールの変更を検証し、stable バージョンでビルドして native/installer/lifecycle/upgrade の挙動を検査する。CI や Full Suite は繰り返さない | GitHub Actions |

L1 は git の pre-commit フックで強制できます。`bun tests/run-tests.ts || exit 1`。

必須の `Tests (smoke + unit)` ステータスは、まとめられた check ジョブ（パッケージの決定性、typecheck、lint、インストーラーの ShellCheck、Linux smoke、production guards）の成功も要求します。契約チェックとテストマトリクスは並列で走り、集約はその両方を待ちます。その名前は変わらないため、リポジトリの必須ステータスチェックがそれらをまとめてカバーします。

GitHub ホスト型ランナーが失敗したという理由だけでマージキューが PR を落としたとき、`merge-queue-notice.yml` は PR に 1 件のコメントを投稿し、その旨を述べ、ジョブを名指しし、メンテナーが再度追加できることを記します。これは各マージキュー CI 実行の後に `workflow_run` で走り、デフォルトブランチだけをチェックアウトし、組み込みトークンを `actions: read`、`checks: read`、`contents: read`、`pull-requests: write` で使います。`.github/scripts/merge-queue-notice.ts` が、GitHub の記録から読んだシグネチャを担当します。

- `failed_checks` による除外では、すべての red なジョブが、ランナーを失ったか（"The hosted runner lost communication with the server"、失敗したステップなし）、"Could not resolve host: github.com" でチェックアウトに失敗したかのいずれか。
- `checks_timed_out` による除外では、除外時点でまだ開いていたすべてのジョブが、ランナーを待っていたか、まだ "Prepare unit test substrates" にあったかのいずれか。

テストの失敗、コンフリクト、手動の除外、`.github/` を変更する PR、すでにキューに戻っている PR、すでに説明済みの実行については何も投稿せず、キューへの追加・削除・マージも行いません。`t-ci-merge-queue-notice` が、`tests/fixtures/merge-queue-notice/` の実際の除外の切り詰められた記録でこれをピン留めします。

PR CI は厳格なままです。失敗したファイルは再試行なしで PR 上で red になるため、フレークは導入された場所で見つかります。マージキューは異なります。1 つのフレークなファイルが PR を落とし、その後ろに並ぶすべてのグループを再ビルドするためです。そこでは `ci.yml` が smoke、unit、integration の各レグに `retry-once` を渡し、それらは `--file-retries 1` でティアを実行します。最初の試行でアサーションに失敗したファイル（失敗したケース、完全な JUnit 証跡、ファイルタイムアウトなし、クリーンアップ失敗なし、最大 10 分、ランに少なくとも 5 分残っていること）は、新しいプロセスと一時ディレクトリでもう一度実行されます。自身のケースタイムアウトを超えて走ったケースは失敗ケースであり、失敗がそうしたケースタイムアウトのみのファイル（遅い Windows ランナーがケースをタイムアウトさせたもの）は最大 45 分走っていてもなお 1 回の再試行を得ます。`retries.json` はそれを `caseTimeoutsOnly` とマークします。ルールは `tests/lib/file-retry.ts` にあり、分離ライブ再試行と共有されます。失敗ケースのないクラッシュや非ゼロ終了、1 つもケースを実行しなかったファイル、期限を超えて走ったファイル、2 回目の失敗は決して再試行されません。person-turn の失敗も同様です。ドライブの `PersonTurnError`（`tests/harness/person-turns.ts`: 人の応答の裏付けなしに人のものとして記録された決定、または人が答える前に始められた作業）で失敗したケースは、`NO RETRY` 行とともにそのファイルを red に保ちます。2 回目の試行での合格が、人が遭遇するはずの破綻を隠してしまうためです。最初の試行が実行したすべてのケースに合格する再試行だけが、最初の失敗を置き換えます。2 回目の失敗、またはそれらのケースの 1 つをスキップするか 1 つも実行しない再試行は、失敗のままです。再試行は、最初の試行の証跡がまるごと脇に退けられた後にのみ始まります。そのいずれかが退けられない場合、ファイルは再試行されません。2 回目の試行での合格が静かに行われることは決してありません。ジョブは `Flaky test` 警告（"<file> passed on its second attempt (merge queue)"）を表示し、ステップサマリーは "Passed on retry" の下にそれを列挙し、ファイルの `summary.txt` の行は `PASS` を保ちつつその下に "passed on retry" 行を置き、ランのログディレクトリの `retries.json` はフレークのトリアージのためにすべての再試行を記録します。最初の試行のログと JUnit は、2 回目のものの隣に `<file>.attempt-1.*` として残ります。分離 e2e と Full Suite はこのフラグを決して取りません。`t-runner-production-guards` と `t-ci-retry-report` が、ルール、ランナー、レポートをカバーします。

macOS ランナーは最も遅く、ホスト型ランナーの数も最も少ないため、マージキューのペースを決めます。macOS unit セット全体は、マージグループあたり約 245 ジョブ分かかります。キューでのみ、`ci.yml` は macOS unit シャードに `macos-merge-selection` を渡し、`scripts/ci-macos-unit-selection.ts` が、ソースが macOS または darwin を名指す unit ファイル（毎回計算され、保持されたリストではない）に加えて、変更がその最初の親（キューで前に並ぶエントリ）に対して触れる unit ファイルを選び、キューの 2 つの macOS unit ジョブに重みで広げます。全体で約 60 ジョブ分です。選ばれたファイルは、そのアフィニティグループの残りを連れてきます（t249 は t238 がビルドするバイナリを読む）。各シャードは、その分担を 1 つのシャード全体として実行し（`--shard 1/1`、そのため必須のコンパイル済みカバレッジなどのシャードルールが成り立つ）、他のファイルを `--exclude` で除外します。そのため、macOS でスキップするファイルは、シャード全体と同じく `SKIP` のままです。選ばれたファイルのないシャードは、インストールの前に止まります。変更が diff できない、選ばれた名前がテストファイルの文法の外にある、または選択が失敗したとき、シャードは全体で実行されます。macOS の smoke、integration、分離 E2E、ネイティブターミナルの unit、Linux と Windows、PR CI、夜間 Full Suite は、すべてのファイルを実行します。`t345` がこれをピン留めします。

`main` は本番ではありません。PR CI とマージキューは上記の高速ゲートのままで、必須のホスト型ライブティアは `full-suite.yml` で走ります。`preview-release.yml` は、preview のソース SHA に対する別の実行として、毎晩それをディスパッチします。その失敗はその実行と preview ノートで見えるままですが、preview ワークフローを失敗させることはありません。契約チェックが通れば、preview のネイティブ smoke、ビルド、アーティファクト検証が Full Suite と並列で走ります。公開は、検証済みアーティファクトと完了したテストレポートの両方を待つため、preview のリリースノートは Full Suite やアップグレードの警告を保ちます。変更のないソースも、ビルドと公開をスキップしつつ、契約チェックと Full Suite を走らせます。

stable の昇格は、公開済み preview のソースを選び、バージョンメタデータとピン留めされた公開コントロールだけを加えます。CI や Full Suite を繰り返すことはありません。preview の以前の結果は、失敗を含めて見えるままです。昇格を選ぶかどうかはメンテナーの判断です。新しくビルドされた stable バイナリは、公開前にやはりパッケージング、インストーラー、ライフサイクル、アップデートの検査に合格します。[昇格の手順](../../DEVELOPERS.md#4-promote-a-preview-to-production) を参照してください。

同じワークフロー ref 上で同じ検証選択を持つ新しいディスパッチは、古い実行をキャンセルします。そのため push 後にライブ検証を再ディスパッチすると、前のヘッドに対する実行を置き換えます。リリース目的のディスパッチも `ref` 入力をキーにし、preview が呼ぶ Full Suite 実行がこの方法でキャンセルされることは決してありません。

`ci.yml` と `full-suite.yml` は、同じ再利用可能な `.github/workflows/deterministic-tests.yml` を呼びます。呼び出し側は、不変の `ref`、ランナー、ティア、unit または integration のシャード、任意のファイル `filter` と `exclude`（どちらも既定では空で、ティア全体が走る）、アーティファクトラベルを選びます。両者とも integration を 6 つのジョブに分けます。scope runs（`filter`、`t-scope-run-*`、classic own-file ファイルの `exclude` 付き）、それらの classic own-file ファイル（`own-file-moves`）、scope-host runs（`filter`、`t-scope-host-*`）、2 つの所要時間均衡シャードの guard matrix（`filter: ^t-guard-matrix-`、`integration-shard: 1/2` または `2/2`）、その他すべて（3 つすべての `exclude`）です。PR CI は Linux smoke、10 個の重み付き unit シャード、`own-file-moves` を除くすべての integration ジョブを選びます。`own-file-moves` はマージキューのみが加えます。`full_verification` の Full Suite は、smoke、OS ごとに 16 個の unit シャード、6 つの integration ジョブ、Linux/macOS/Windows での分離 E2E を選びます。夜間 Full Suite は決定的ティアを一切走らせません。その `scope_runs` ジョブが、scope runs、`own-file-moves`、scope-host runs、guard matrix を 3 つすべてで共有ワークフローに呼ばせます。integration と E2E は OS ごとに独立したジョブとして、それぞれ新しい Bun ランナープロセスで走ります。すべての呼び出しは新しいチェックアウトを持ち、Bun 1.4.4 のもとで固定された依存関係をインストールし、projection を一度再生成し、`--debug -P 8 --no-llm` で Bash ラッパーを呼びます。E2E 実行は `--isolated-e2e` を保ちます。smoke は各チェックアウト内で直列のままで、unit も macOS シャード（[Unit Sharding](#unit-sharding)）を除いて同様です。ワークフローの共有は、コマンドとセットアップを共有するのであって、以前のテスト結果を共有するのではありません。

CI は、コードの契約、インストーラーの ShellCheck、カバレッジのラチェット、PR の changelog 保持、Linux smoke、production-guard の検査を 1 つのジョブにまとめます。smoke と production guards は、別々のランナープロセスとログディレクトリを使い、依存関係のインストールと生成された projection だけを共有します。macOS と Windows は独自の smoke ジョブを保ちます。Linux smoke は、マージキューの再試行とフレークテストの報告ポリシーを保ちます。各検査は独自のステップと失敗を保ち、独立した検査は先行する検査が失敗しても続きます。カバレッジはやはり最初の親と比較し、changelog の保持は固定された PR ベースを使います。必須の `Tests (smoke + unit)` ステータスは、このまとめられたジョブの成功を要求します。PR CI は 17 のランナーを割り当て、マージキューは既存のプラットフォーム選択とともに 51 を割り当てます。ライブハーネスとネイティブビルドのマトリクスは変わりません。

リポジトリの `default-branch` ルールセットは、マージキューのビルド並行性を 8 から 2 グループに制限します。この設定はこれらのワークフローとは別に GitHub で管理され、マージバッチ内の PR 数ではなく、同時のマージグループビルドを制限します。必須の検査は、やはり各グループのコミットで走ります。

Full Suite は、手動の決定的マトリクスを 12 の同時ジョブに、夜間の scope/guard マトリクスを 3 に制限します。69 すべての手動決定的ジョブと 12 すべての夜間 scope/guard ジョブは、やはり走ります。スイート軸が先に来るため、ジョブの生成は Linux、macOS、Windows を交互にします。この順序はプラットフォームごとのクオータではありません。どのジョブが一緒に実行されるかは、ランナーの空きとジョブの所要時間が決めます。ライブシャードは、Linux 4、macOS 2、Windows 3 ジョブという既存の制限を保ちます。これらはマトリクスごとの制限であって、組織のクオータではありません。同時のワークフローは、やはりホスト型のキャパシティを共有します。並行性を下げると、Full Suite の実行が長くなる一方で、PR やキューとの競合は減らせます。

スタンドアロンの決定的、ネイティブターミナル、production-guard のテストジョブは、5 時間のジョブバックストップと 270 分の実行ステップを使います。ランナーは、呼び出し全体で 4 時間の作業期限を共有し、smoke と分離決定的 E2E を含め、ファイルごとに 2 時間の期限を持ちます。この階層は、作業が止まった後にプロセスを退役させ、レポートを仕上げ、ログを無害化し、証跡をアップロードする時間を残します。unit の作業は重複なく分割されたままです。CI では 10 個の Linux シャード、16 個の Windows シャード、マージキューでは選ばれた 2 個の macOS シャード、拡張された手動 CI では 16 個の macOS シャードです。Full Suite のフル検証は OS ごとに 16 個を使います。コンパイル済みの producer/consumer のアフィニティは保たれます。

まとめられた CI check ジョブは、チェックアウトの前に共有の 270 分作業期限を開始し、その 5 時間のジョブ上限のうち 30 分を、プロセスのクリーンアップと証跡収集のために残します。チェックアウトと Bun のセットアップはそれぞれ 15 分の上限を持ち、両者を合わせても作業のエンベロープを消費できません。後続のすべてのセットアップと契約のコマンドは `scripts/ci-check-budget.sh` を通して走り、これはプロセスグループのタイムアウトで残りの期限を強制し、それが切れた後は開始を拒否します。独立した検査はやはり失敗を収集し、無害化は、Bun が利用できる限り、失敗したコマンドの後も対象のままです。smoke は残りの作業時間の多くても半分を受け取り、残りの半分を production guards のために確保します。guards は、そのステップが始まるときに実際に残っている時間を受け取ります。各呼び出しは 4 時間の上限も保ちます。尽きた予算は、テストを起動する前にステップを失敗させます。既存のケースとファイルの上限は、各呼び出しの残りの予算の中でやはり適用されます。

同じ階層が、マージキューのネイティブターミナル検査、Full Suite のネイティブの義務、production-guard の検査に適用されます。これらの経路は、より小さいケース、ファイル、ラン、ステップの上限をひそかに再導入してはなりません。いずれも、キャプチャされた `--debug -P 8` のラッパー実行と証跡収集を保ちます。認証情報付きのライブジョブは、独立した 1 時間の認証境界を保ちます。70 分のステップ内の 60 分のファイル、80 分のジョブです。そのネストしたドライバの操作は、残りのファイル予算から割り当てます。

焦点を絞った決定的再現には、候補ブランチ上で直接 `deterministic-tests.yml` をディスパッチします。

```bash
gh workflow run deterministic-tests.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-source-sha>' -f runner=windows-latest -f tier=unit \
  -f unit-shard=1/1 -f 'diagnostic_filter=^t-tui-runtime$'
```

`diagnostic_filter` は手動専用のファイル名正規表現で、再利用可能な CI 呼び出し側には公開されません。unit ティアは `unit-shard=N/M` を必要とします。`1/1` はフィルタの前にすべての unit ファイルを選びます。smoke、integration、e2e では `unit-shard` を省きます。その既定は空です。integration はさらに `integration-shard=N/M` を使って、フィルタ済みインベントリの 1 つの区画を再現できます。各再現は、モデルゲートを閉じ、同じ不変のチェックアウト、有界なランナー、無害化された証跡パスを持つ 1 つの新しいランナーを使います。既定のアーティファクトは `ci-deterministic-probe-<OS>` です。これらの的を絞った診断は、フルスイートやリリースを認定するものではありません。

POSIX の unit ジョブは tmux を必要とします。共有セットアップはまず `command -v` を検査し、それが欠けているときにのみ Linux では apt、macOS では Homebrew を使います。Linux の unit ジョブは、zsh がなければそれもインストールします。欠けているツールは、互換性のケースをスキップするのではなく、セットアップを失敗させます。

共有ワークフローは、チェックアウトされたコミットを呼び出し側の SHA に結び付けます。リリース目的の Full Suite 実行は、plan ジョブでその SHA を `main` に対して認可します。手動検証は代わりに、それを選択されたワークフローヘッドに結び付けます。PR CI は、ライブ認証情報を受け取ることなく、その PR のマージコミットをテストできます。各実行は、チェックアウトルートの `tmp/ci-deterministic/run.log` に stdout/stderr をキャプチャし、そのパスと実際のログスタンプを表示し、無害化が成功した後にこのキャプチャと `tests/logs/` の両方を保持します。アーティファクトは、呼び出し側のラベルに実際のランナー OS を加えたものを使い、証跡を 90 日間保持します。`ci.yml` は `evidence-optional: true` を渡します。どのワークフローもその `ci-deterministic-*` アーティファクトをダウンロードしないためです。アップロードの失敗はジョブに報告されますが、それを失敗させることはなく、そのためアップロードのタイムアウトが、テストに合格した PR を落とすことはできません。テストステップ自身の終了コードは、やはりジョブを失敗させます。CI の `ci-native-*` と `ci-check-evidence` のアップロードも同じルールに従います。Full Suite はこの入力を渡さないため、手動フル検証実行の `full-suite-deterministic-*` のアップロードは必須のままです。その実行は、人にその証跡を手渡すために存在し、キューに入った PR がそれを待つことはありません。

夜間の修正が着地する前のプラットフォーム検証には、`gh workflow run ci.yml --ref <branch> -f platform_regressions=true` をディスパッチします。これは既存の決定的マトリクスを 3 つすべての OS に拡張し、integration と並んで分離 E2E ジョブを加えます。Linux パスを先に走らせたり、別の広いリグレッションスライスを付け足したりはしません。フルの unit シャードには、tmux、path、workspace-fixture、macOS のリグレッションが含まれ、t238/t249 はその重み付きアフィニティグループに保たれます。これらは夜間テストと同じ POSIX のプロビジョニングとキャプチャ経路を使います。焦点を絞ったネイティブ、production guard、OS 分離の検査は必須のままです。手動 CI は、モデル呼び出しをせず、Full Suite の結果を生成しません。

## スタブ

### Greenfield スタブ: `tests/fixtures/greenfield-todo/`

ソースコードのないプロジェクトの説明です。ワークスペース検出は greenfield と分類します。ideation ステージ向けに、LLM へ決定的な intent コンテキストを与えます。

内容: TypeScript と Vite を使った React Todo アプリを説明する `README.md` だけです。

### Brownfield スタブ: `tests/fixtures/brownfield-todo/`

最小の React+TypeScript+Vite ソース（約 10 ファイル、約 200 LOC）です。ワークスペース検出は brownfield と分類します。RE、requirements、design の各ステージには、分析する具体的なコードがあります。

内容:
- `package.json` — react、react-dom、typescript、vite、vitest
- `tsconfig.json`、`vite.config.ts`、`index.html`
- `src/main.tsx`、`src/App.tsx`
- `src/types/todo.ts` — Todo インターフェース（id、title、completed）
- `src/components/TodoList.tsx` — リスト + 追加フォーム（約 40 行）
- `src/components/TodoItem.tsx` — チェックボックス + タイトル + 削除ボタン
- `src/hooks/useTodos.ts` — addTodo、toggleTodo、deleteTodo

### RE アーティファクトフィクスチャ: `tests/fixtures/re-artifacts/`

下流のステージテスト向けに事前シードされたリバースエンジニアリングの出力です。セットアップ時に、テストプロジェクトのスペースレベルのリポジトリストア `$PROJ/aidlc/spaces/default/codekb/<repo>/` にコピーされます。

内容: brownfield-todo アプリを説明する 4 つの最小の .md ファイル（architecture-overview、technology-stack、codebase-analysis、integration-points）です。

### Inception アーティファクトフィクスチャ: `tests/fixtures/inception-artifacts/`

construction へ jump するテスト向けに事前シードされた inception フェーズの出力です。セットアップ時に `$PROJ/aidlc/spaces/default/intents/<record>/inception/{requirements-analysis,domain-design,units-generation}/` にコピーされます。

内容: Todo アプリを説明する最小の .md ファイル（requirements、統合された `components.md` カタログ、unit-of-work、unit-of-work-story-map）です。Unit 名: `todo-core`。

### Construction アーティファクトフィクスチャ: `tests/fixtures/construction-artifacts/`

construction の途中のステージ（たとえば code-generation）へ jump するテスト向けに事前シードされた construction フェーズの出力です。セットアップ時に `$PROJ/aidlc/spaces/default/intents/<record>/construction/todo-core/functional-design/` にコピーされます。

内容: todo-core ユニットのコンポーネント仕様と状態管理を説明する 1 つの最小の .md ファイル（functional-design）です。

### 入力コーパス: `tests/fixtures/aidlc-input/corpus.json`

人が `/aidlc` の後に入力するもの、そして作業が進行中のときに素のチャットで入力するものです。1 つのワークスペース状態（`fresh`、`work-open`、`plan-question-open`、`gate-open`、`two-similar-records`）での入力行ごとに 1 項目で、`meaning`（人が意図することを平易な言葉で）と `expected.engine`（エンジンの最初のステップがしなければならないこと。許される directive の種類、それが名指すべきコマンドや言葉、メッセージレコードの言葉と設定、質問が人に届いてよいかどうか）を持ちます。ドキュメント、スキル、ステージの散文、ヘルプテキストが出荷するすべての `/aidlc` の例（`source` と `documented` が由来を運ぶ）、input-forms 監査、そしてバリエーション（タイプミス、語順、シェルごとのクオート、CRLF と unicode、ゲートやプラン質問での応答、ワークスペースの言葉、平易な言葉での設定、廃止されたフラグ、空行、曖昧な行）からシードされます。期待がまだマージされていない変更を必要とする項目は `after` を持ち、その変更がソースに入るまでスキップされます。共有の仕組みは `tests/harness/aidlc-input-corpus.ts` にあります。`tests/unit/t-aidlc-input-corpus.test.ts` は、すべての項目を Claude Code の human-turn フックと `next` を通して実行し、カテゴリごとに 2 項目の固定サンプルを Codex、Kiro CLI、Kiro IDE のフックも通して実行します（`AIDLC_INPUT_ONLY=<ids>` が実行を絞り、`AIDLC_INPUT_PARALLEL` がフィクスチャプールを設定）。`tests/e2e/t-live-aidlc-input-corpus.serial.test.ts` は、要求に応じてサンプルを実際のエージェントを通して駆動します（`AIDLC_INPUT_LIVE=1`）。ディスク上で起きたことは、各項目の `expected.end`（作業、人が設定した設定、切り替わったレコード、答えられたゲートやプラン、尋ねられた質問）に対してスクリプトが判定し、エージェントが人に伝えたことは、項目の `meaning` と短いルーブリック（平易な言葉、製品自身の名前、エンジン内部に触れない、`ambiguous` な項目でのみ質問）に対してモデルが判定し、カテゴリごとのスコアと、トランスクリプトの抜粋付きのすべてのミスを含むレポートが `AIDLC_INPUT_REPORT_DIR` の下に着地します。

### 回答コーパス: `tests/fixtures/aidlc-answers/corpus.json`

AI-DLC が尋ねるすべての質問に人が返すものです。その質問が開いている状態（ステージゲート、Accept as-is 付きのゲート、ブロッキングセンサーの質問、コードプランの質問、Unit とバッチのチェックポイント、検証コマンド、Construction ポリシーの変更、サマリー確認、エージェントが尋ねたステージの質問、インタラクションモードの質問、ルーティングの質問、プランの提示と scope の確認、レコードの選択、プロジェクトタイプの質問、一時停止した Unit、ガードリカバリの問い、再入、再び開かれたステージ、learnings の質問、jump のターゲット）での応答ごとに 1 項目で、`meaning`（人が意図すること）、`reader`（応答が選択肢の表示どおりの正確な選択なら `tool`、それ以外は `agent`）、`expected.engine`（ツールが応答だけから記録してよい選択、保たれなければならない言葉、エンジンのステップ）、`expected.end`（実際のエージェントが動いた後に人が終わる状態、ライブチェック用）を持ちます。応答は、素のチャットで入力される、`/aidlc` または `$aidlc` の後に入力される、質問ボックスで選ばれる、のいずれかです。期待がまだマージされていない変更を必要とする項目は `after` を持ち、それが着地するまでスキップされます。共有の仕組みは `tests/harness/aidlc-answers-corpus.ts` にあります。`tests/unit/t-aidlc-answers-corpus.test.ts` は、すべての項目を各ホストの human-turn フック、次いでエンジンのステップとエージェントの answer コマンドを通して実行します（`AIDLC_ANSWERS_ONLY=<ids>` が実行を絞り、`AIDLC_ANSWERS_PARALLEL` がプールを設定）。`tests/e2e/t-live-aidlc-answers-corpus.serial.test.ts` は、要求に応じてサンプルを実際のエージェントを通して駆動します（`AIDLC_ANSWERS_LIVE=1`）。実際のエージェントがまず質問を表示し（フィクスチャの状態での素の `/aidlc`）、次いで人がチャットで、`/aidlc` の後で、または質問ボックスで応答します。スクリプトはディスク上のものを `expected.end`（人の言葉を傍らに添えて記録された選択、メッセージレコード、2 回尋ねられた質問）に対して判定し、モデルはエージェントが人に伝えたことを `meaning` と `says` に対して判定し、質問ごとのスコアと、トランスクリプトの抜粋付きのすべてのミス、そして夜間レポート用のサマリーを含むレポートが `AIDLC_ANSWERS_REPORT_DIR` の下に着地します。夜間もそれを、Claude SDK ファミリーの Linux ライブジョブで実行します。そこではそれ自身のスイッチはファイルに届きません。GitHub Actions で `AIDLC_CLAUDE_SDK_LIVE=1` を付けると Claude Code だけを駆動し、日付ローテーションで選ばれた質問ごとに 1 項目を駆動します（2026-10-15 から始まるローテーションの N 晩目は、各質問の項目 N をその質問の項目数で割った余りを、コーパス順で駆動するため、最大の質問が持つ項目数と同じ数の晩のうちにすべての項目が巡ってくる）。そしてすべてのミスを失敗させずに報告します（ファイル内の `NIGHTLY_MISSES_FAIL` は、要求時と同じく、ミスをそれの失敗にする）。例外を投げるドライブ、1 つも項目を駆動しない実行、変更された実際のホームは、やはりファイルを失敗させます。夜間レポートの Answers コーパスのセクションがその結果を表示します（[夜間フルスイートのマトリクスとプロビジョニング](#nightly-full-suite-matrix-and-provisioning) を参照）。2 つのライブチェックは `tests/harness/live-corpus.ts`（ゲート、シードされたサンプルと夜間のローテーション、スクラッチのプロジェクトとホーム、ホームのダイジェスト、モデルの判定者、レポートとそのサマリー）を共有します。

## 状態フィクスチャ

| フィクスチャ | プロジェクトタイプ | Scope | 状態 | 使用元 |
|---------|-------------|-------|-------|---------|
| `state-pre-workspace-detection.md` | -- | feature | Welcome+scaffold 完了、次は workspace-detection | t70, t71 |
| `state-initialization-done.md` | Greenfield | feature | Init 完了、次は intent-capture | t73 |
| `state-brownfield-init-done.md` | Brownfield | bugfix | Init 完了、次は RE | t72 |
| `state-mid-inception.md` | Brownfield | bugfix | RE 完了、次は requirements-analysis | t74 |
| `state-mid-ideation.md` | Greenfield | feature | Intent+market 完了、次は feasibility | t08, t10, t11, t12, t20, t22, t24, t25, t37 |
| `state-construction.md` | -- | -- | Construction フェーズ | t07, t10, t11, t26, t57 |
| `state-operation.md` | -- | -- | Operation フェーズ | t07, t10, t11 |
| `state-completed.md` | -- | -- | 全ステージ完了 | t08, t11 |
| `state-jumped.md` | Brownfield | bugfix | jump 履歴のあるワークフロー途中 | t11, t37, t42 |
| `state-corrupted.md` | -- | -- | 無効/破損した状態 | t08, t10 |

## ステージテストの追加方法

1. テストするステージを選び、それがどの状態フィクスチャを必要とするかを特定します（状態は、そのステージを現在/次のステージとして示さなければなりません）。
2. `tests/fixtures/` に状態フィクスチャを作成するか再利用します。
3. `tests/integration/tNN-stage-SLUG.test.ts` を作成し、シェルの TAP ヘルパーではなく、共有の TypeScript ハーネスヘルパー（`tests/harness/fixtures.ts`、`tests/harness/sdk-drive.ts`、`tests/harness/tui-drive.ts`、`tests/harness/plugin-kit.ts`、`tests/harness/exec-drive.ts`）を使います。
4. `bun tests/run-tests.ts --integration` で、または直接 `bun test tests/integration/tNN-stage-SLUG.test.ts` で実行します。

## 受け入れアサーションの追加方法

`tests/e2e/` 以下の既存の e2e ワークフローテストにアーティファクトのアサーションを追加するには、次のようにします。

1. 現在のテストを読み、それがすでに何を検査しているかを理解します。
2. 既存の `test(...)` ブロックの中に `expect(...)` のアサーションを追加します（bun:test は呼び出しそのものからアサーションを数えるため、同期を保つべき `plan` 行はありません）。
3. 柔軟なパターンを使います。`readFileSync` の内容に対して、正確な文字列ではなく `/[Tt]odo/` をマッチさせます。
4. 非決定的な LLM の出力形式に依存するアサーションには、`test.skipIf(...)` または早期 return を使います。
5. サイズ下限の検査には `expect(statSync(path).size).toBeGreaterThan(minBytes)` を使います。

## アサーション設計の原則

- **キーワードクラス** — 大文字小文字を区別しない正規表現を使う: `[Tt]odo`、`[Rr]eact`、`[Bb]rownfield`
- **柔軟な発見** — 正確な名前を検査するのではなく、`find` + `wc -l` でファイルを数える
- **サイズ下限** — 最小の内容には `statSync(path).size` を `toBeGreaterThan()` とともに使う
- **優雅な劣化** — アサーションが非決定的な LLM 出力に依存するときは `skip` を使う
- **内容より構造** — 内容を検査する前に、markdown の見出し（`^#`）、ファイルの存在、ディレクトリの作成を検査する

## 環境変数

| 変数 | 既定値 | 説明 |
|----------|---------|-------------|
| `AIDLC_TEST_TIMEOUT` | `1800` | `claude -p` 呼び出しごとのタイムアウト（秒）。`0` はその操作タイマーを無効にする。ファイル/ランの期限はなお適用される。 |
| `AIDLC_TUI_BACKEND` | `auto` | ターミナルドライバ。Linux/Windows/macOS でネイティブ `bun`。明示的な値: `bun`、`tmux`。[ターミナルドライバ](#terminal-driver) を参照。 |
| `AIDLC_TUI_BUN_ROOT` | `<os.tmpdir()>/aidlc-bun-tui` | ネイティブのレコード/スナップショット。コマンドをまたいで同じルートを使う。ユーザー所有かつプライベート（POSIX では 0700、Windows では現在のユーザーが所有者で Everyone/Users/Authenticated Users の許可 ACE なし）でなければならず、シンボリックリンク/リパースポイントであってはならない。存在しないルートはプライベートに作成され、安全でない既存のルートや識別情報が置き換わったセッションディレクトリは拒否される。 |
| `AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS` | 未設定 | 一時ディレクトリの祖先がサンドボックス uid（root でも現在のユーザーでもない）に所有される制御されたテストホスト、たとえば `/` が `nobody` に属するオーバーレイファイルシステムでのみ `1` に設定する。これがないと、すべてのライブなネイティブルートのティアがセットアップで失敗し、エラーがこの変数を名指す。POSIX の明示的ルートの祖先の所有権検査だけをスキップする。sticky ビットなしで他のユーザーが書き込める祖先と、シンボリックリンク/リパースポイントはなお拒否され、プライベートルートの所有者、モード、generation ハンドシェイクは引き続き強制される。 |
| `AIDLC_BUN_BIN` | 現在の Bun 実行ファイル、なければ `PATH` 上の `bun` | Bun と tmux の TUI バックエンド向けの実行ファイルのオーバーライド。Linux/Windows/macOS でのネイティブ PTY 使用には Bun >=1.4.4 が必要。 |
| `AIDLC_NODE_BIN` | 未設定 | 分離ライブツール環境とテストフィクスチャに提供される Node 実行ファイル。TUI バックエンドを選択するものではない。 |
| `AIDLC_TEST_GUARD_PROFILE` | `fixture`（ランナー設定） | テスト向けのランナー提供の診断情報。`fixture` または `production` で、ランナー CLI が選択する。継承された値はプロファイルを選択しない。ランナーがすべてのテスト子プロセスでそれを置き換える。 |
| `AIDLC_TEST_COMPILED_DIR` | `<runner log dir>/compiled`（ランナー設定） | t238 から t249 へのラン所有の引き継ぎ。検証済みのネイティブ `aidlc` / `aidlc.exe` と隣接する `runtime/`。ランナーがすべての子プロセスで継承値を置き換え、アーティファクトをファイル単位の一時クリーンアップの外に保ち、他のランから分離する。 |
| `AIDLC_TEST_COMPILED_EXECUTABLE` | 未設定 | ランナーの引き継ぎなしでの、直接のシャード化されていない t249 呼び出し向けの任意の既存実行ファイル。ビルドの出力先では決してなく、欠けたシャード化された引き継ぎの代わりにはならない。 |
| `AIDLC_TEST_UNIT_PARALLEL` | 未設定 | `tests/unit-shard-weights.json` の `parallel` エントリの代わりに、`--unit --shard` 実行が一度に開始するファイル数の試験的な上限（どのプラットフォームでも）。`-P` が上限のまま。CI は決して設定しない。[Unit Sharding](#unit-sharding) を参照。 |
| `AIDLC_TUI_SETTING_SOURCES` | `project,local` | ライブの `claude` TUI 起動に注入される設定ソース。プロジェクトの設定と、それ自身の `.claude/settings.local.json`（AI-DLC のステータスラインが人の選択である場所）で、ユーザー設定は決して含まない。ユーザーの Claude 設定を意図的に含める焦点を絞ったキャリブレーションでのみ `default` または空の値を使う。 |
| `AIDLC_TUI_TRACE_POLL_MS` | `10000` | 長いジャーニーが次のメニューやディスクの終端条件を待っている間の、TUI NDJSON トレースにおける `answer_gate_poll` スナップショットの最小間隔。 |
| `AIDLC_ACP_DIAGNOSTIC_TRACE` | 未設定 | ACP デバッグトレースとともに `1` に設定すると、ツールの入力/チャンクイベント、セッション/ターンの識別情報、キャンセル要求、集約された入力の形状を含むプライベートな `<trace>.protocol.ndjson` サイドカーを書き出す。エージェントの散文イベント、prompt/auth の RPC ボディ、プロセス環境は除く。ツール入力はプライベートな診断データのまま。制限: イベントあたり 1 MiB、ファイルあたり 64 MiB。`diagnostic_incomplete` または `json_parse_error` は、キャプチャが完全なプロトコル証跡を確立できないことを意味する。 |
| `AIDLC_INPUT_LIVE` | 未設定 | `/aidlc` 入力コーパスのサンプルを実際のエージェントを通して駆動するには `1` に設定する（`tests/e2e/t-live-aidlc-input-corpus.serial.test.ts`）。各ハーネスは独自のゲート（`AIDLC_CODEX_EXEC_LIVE`、`AIDLC_KIRO_ACP_LIVE`、`claude` バイナリ）を保つ。 |
| `AIDLC_INPUT_HARNESSES` | `claude,codex,kiro` | ライブ入力チェックが駆動するエージェント。 |
| `AIDLC_INPUT_SAMPLE` | `3` | ライブ入力チェックのコーパスカテゴリあたりの項目数、または項目 id のカンマ区切りリスト。 |
| `AIDLC_INPUT_SEED` | `1` | ライブ入力チェックのサンプルのシード。再実行で同じ項目を駆動する。 |
| `AIDLC_ANSWERS_LIVE` | 未設定 | 回答コーパスのサンプルを実際のエージェントを通して駆動するには `1` に設定する（`tests/e2e/t-live-aidlc-answers-corpus.serial.test.ts`）。各ハーネスは独自のゲート（`AIDLC_CODEX_EXEC_LIVE`、`AIDLC_KIRO_ACP_LIVE`、`claude` バイナリ）を保つ。 |
| `AIDLC_ANSWERS_HARNESSES` | `claude,codex,kiro` | ライブ回答チェックが駆動するエージェント。 |
| `AIDLC_ANSWERS_SAMPLE` | `2` | ライブ回答チェックの質問あたりの項目数、または項目 id のカンマ区切りリスト。プールは、新しいチャットが遭遇できる応答。素の `/aidlc` はエージェントがチャットで尋ねた質問を再び表示するため、検証コマンドへの応答と Construction ポリシー質問への応答はすべて駆動される。ステージの質問と learnings は `/aidlc` とともに入力された応答にとどまり、ドライブはチャット応答の後のエージェントの言葉を判定できない。ガードリカバリのフィクスチャは満たせないため、unit チェックのみで読まれる（`tests/harness/aidlc-answers-corpus.ts` の `liveReply`）。 |
| `AIDLC_ANSWERS_SEED` | `1` | ライブ回答チェックのサンプルのシード。再実行で同じ項目を駆動する。 |
| `AIDLC_ANSWERS_REPORT_DIR` | ランのログフォルダ（`AIDLC_TEST_LOG_DIR`、なければ `tests/logs`）の `aidlc-answers-live` | ライブ回答チェックがそのレポート、トランスクリプト、夜間レポートが読むサマリーを書き出す場所。 |
| `AIDLC_INPUT_REPORT_DIR` | `tests/logs/aidlc-input-live` | ライブ入力チェックがそのレポート（カテゴリごとのスコアと、トランスクリプトの抜粋付きのすべてのミス）を書き出す場所。 |
| `AIDLC_INPUT_ONLY` | 未設定 | unit 入力チェック（`tests/unit/t-aidlc-input-corpus.test.ts`）を絞るコーパス項目 id のカンマ区切りリスト。 |
| `AIDLC_INPUT_PARALLEL` | `6` | unit 入力チェックのフィクスチャプールのサイズ。 |
| `AIDLC_KIRO_IDE_LIVE` | 未設定 | macOS または Windows でサインイン済みの Kiro IDE デスクトップジャーニーを実行するには `1` に設定する。 |
| `AIDLC_KIRO_IDE_BIN` | プラットフォーム既定 | Kiro IDE 実行ファイルをオーバーライドする。既定は macOS では `/Applications/Kiro.app/Contents/MacOS/Electron`、Windows では `%LOCALAPPDATA%\Programs\Kiro\Kiro.exe`。 |
| `AIDLC_KIRO_IDE_SEED` | 生成されたシード | 任意の Kiro ユーザーデータディレクトリ。テストは起動前にそれを使い捨ての一時ディレクトリにコピーし、ソースプロファイルを決して変更しない。 |
| `AIDLC_KIRO_IDE_DIAGNOSTICS` | 未設定 | 任意のファイル単位の NDJSON 診断パス。IDE 起動ごとに最大 64 のライフサイクルレコードを含む。所有 PID、タイムスタンプ、browser-close プロトコルイベント、子の exit/close とフォールバックのシグナル。レコードはエンドポイント、プロファイルの内容、生のエラーテキスト、環境値を除く。診断 I/O の失敗はテストの失敗の代わりにはならない。 |

## CLI リファレンス

```bash
# Entrypoints
bun tests/run-tests.ts        # Native cross-platform runner
bash tests/run-tests.sh       # POSIX compatibility wrapper

# Level flags (combinable)
--smoke         # Structural validation
--unit          # Unit directory, including existing process and workflow contracts
--integration   # Cross-component contracts and stage/CLI utilities
--e2e           # Full lifecycle, worktree, and rendered terminal journeys

# Profile flags (shortcuts)
(default)       # smoke + unit + integration
--ci            # smoke + unit + integration
--release       # smoke + unit + integration + e2e
--all           # Same as --release

# Output modifiers
--production-guards # Run selected tests with guard bypasses and direct authority
                    # off; neutralize inherited off-switches. Default: fixture.
--verbose       # Write per-test logs to tests/logs/
--no-llm        # Force all live-model gates closed while deterministic
                # integration/e2e tests still run. Also via AIDLC_NO_LLM=1.
--debug         # Implies --verbose; streams per-test output and writes SDK/TUI
                # driver traces to tests/logs/
--filter PAT    # Only run tests whose filename matches extended regex PAT
--exclude PAT   # Leave out tests whose filename matches PAT; the rest run as an ordinary tier
--parallel N    # Run up to N test files concurrently within a tier (alias: -P N).
                # Default: 1 (serial). Smoke is always serial; unit is too, except
                # a --shard run on a platform the unit weights cap (macOS).
--file-timeout N  # Independent file ceiling in seconds for every tier; caps isolated E2E too.
                  # Default: 7200 outside isolated E2E.
--run-timeout N   # Shared work deadline in seconds across setup and all selected files.
--shard N/M     # Run one duration-balanced unit or integration shard.
                # Requires --unit or --integration with no other tier/profile.
--isolated-e2e  # Run e2e in independent checkouts; -P sets worker count.
--e2e-plan      # Print selected files/resources without builds or test execution.
                # Requires --e2e; implies --isolated-e2e, not --e2e.
--bedrock-parallel N  # Concurrent Bedrock test files (default 2).
--kiro-parallel N     # Concurrent Kiro test files (default 2).
--ide-parallel N      # Concurrent IDE files, also charged to Kiro (default 1).
--e2e-file-timeout N  # Outer isolated-file deadline in seconds (default 10800).
--e2e-timings FILE    # Prior runner summary.txt for duration-based ordering.
--e2e-cancel-file FILE # Create this file to request cancellation on any platform.
```

`--no-llm`（または `AIDLC_NO_LLM=1`）は、導出された Claude ゲートを閉じ、すべてのライブモデルのオプトインを `0` に強制します。Claude TUI、Kiro ACP/TUI/IDE、Codex exec、opencode の実行です。それらのティアの決定的なテストは、トークン不要の TUI 基盤のプリフライトを含め、やはり実行されます。これにより、CLI がインストールされライブ変数が `1` として継承されたときでも、ライブモデルのコストやフレークなしに、CI へフルティアの決定的プロファイルを与えます。

ライブ SDK と TUI のハーネスドライバは、既定でプロジェクト自身の Claude 設定ソースを使います。SDK ドライバはコピーされたテストの `.claude/` プロジェクト設定とフックを読み込み、TUI ドライバはさらに、人による AI-DLC のステータスラインの選択がある、そのプロジェクトの `.claude/settings.local.json` を読み込みます。どちらも開発者のユーザーレベルのフック/設定を除きます。これはインストールされたフレームワークの面を反映し、ローカルの対話的な設定がテストの挙動を変えるのを防ぎます。明示的なドライバオプションまたは `AIDLC_TUI_SETTING_SOURCES` が、キャリブレーションのための脱出ハッチのままです。

`--all --debug`（および `--release --debug`）は、環境がすでに設定していない限り、既定で `AIDLC_TUI_LIVE=1` にします。これにより、「トレース付きですべて」のプロファイルが、既定でライブのトークンを消費する TUI ジャーニーを実行します。それらのファイルをテスト内の SKIP 経路に保つには、`AIDLC_TUI_LIVE=0` を明示的に設定します。

`--exclude` は同じ名前にマッチしますが何も選択しません。それがマッチするファイルはティアから除外され、残りは以下の通常のフィルタなしのルールを保ちます。`--shard` を付けると、まずシャードが選ばれ、次いでそれがマッチするファイルがそこから除外されます。

scope runs、scope-host runs、guard matrix（`t-scope-run-*`、`t-scope-host-*`、`t-guard-matrix-*`）はファイルごとに数分かかるため、`--filter` のない実行はそれらを除外し、その旨を述べます。フルの `--release` と `--all` の受け入れはそれらを保ちます。CI ジョブと同じく、`--integration -P 8 --filter '^t-(scope-run|scope-host|guard-matrix)-'` で単独で実行します。

明示的な **`--filter` は、選択された各ファイルでの実行を要求します**。ケースがすべてスキップされる（またはケースを 1 つも宣言しない）ファイルは、別の選択されたファイルが合格しても、ランを失敗させます。部分的にスキップされたファイルは、少なくとも 1 つのケースが成功して実行されればなお合格します。`expect()` の数は実行のシグナルではありません。マッチしないフィルタも失敗し、失敗したテストをでっち上げるのではなく、`Test files: 0` と `failures.txt` の説明を保ちます。

フィルタのないスイートは任意のスキップを保ち、すべてスキップのファイルを `SKIP` として報告します。`--no-llm`（または `AIDLC_NO_LLM=1`）は、混在した選択から Claude 依存のファイルをなお意図的に除外します。明示的なフィルタがそれらの除外されたファイルだけを選ぶと、ケースが 1 つも実行されなかったためランは失敗します。`--no-llm` なしでは、明示的に選択された Claude ファイルは、その基盤が利用できないとき失敗します。すべてのケースがスキップされたと報告する、他の明示的にフィルタされたライブファイルも失敗します。その文書化済みのライブ変数を有効にし、必要な CLI/認証を提供してください。ライブのオプトインだけでは実行の証跡になりません。

サマリーとファイル単位のログは、実行されたテストケース数とスキップされたテストケース数を、従来の `Total assertions` フィールド（スキップを含む JUnit テストケースを数える）とは別に報告します。`--verbose` / `--debug` は、Bun がそれを出力するとき、Bun の `<test-name>.junit.xml` をファイル単位のログの隣に保ちます。カバレッジの失敗は、`summary.txt` と `failures.txt` でファイルと救済を名指します。スキップされたケースに対してアサーション失敗がでっち上げられることはありません。

## ガードプロファイル

既定の **fixture** プロファイルは、合成的なテストのセットアップを便利に保ちます。テスト子プロセスで `AIDLC_SKIP_ARTIFACT_GUARD`、`AIDLC_SKIP_HUMAN_PRESENCE_GUARD`、`AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD`、`AIDLC_SKIP_REVISION_BACKSTOP`、`AIDLC_ALLOW_DIRECT_AUDIT_EVENTS` を `1` に設定します。その他の継承された
変数は、既存の挙動を保ちます。

本当のガード証跡を提供し、担当のコマンドやフックを検証するテストには、**`--filter` とともに `--production-guards`** を使います。これは呼び出しで選択されたすべてのテストに適用され、ティア選択やライブモデルゲートを変えません。たとえば、ランナー自身のプロファイル契約を検証します。

```bash
bash tests/run-tests.sh --debug -P 8 --unit --production-guards \
  --filter '^t-runner-production-guards'
```

production の子プロセスは、既知のガードスキップ、直接の監査/状態の権限スイッチ、記録可能なバイパス（ensemble 証跡、プラン承認、レビュアースコープ、レビューフリーズ、使用量追跡を含む）に対して `0` を受け取ります。継承された `AIDLC_SKIP_*`、`AIDLC_DISABLE_*`、`AIDLC_ALLOW_DIRECT_*` の変数も `0` に強制されます。これはランナーが `.claude/settings.json` の環境値を読み込んだ後に起こるため、シェルやプロジェクト設定のオフスイッチが、子プロセスの初期ガードプロファイルをひそかに変えることはできません。記録可能なバイパスに対する明示的なゼロは、`aidlc.settings.json` / `aidlc.settings.local.json` のバイパスリストより優先されます。単に変数を削除するだけでは、そのフォールバックが許されてしまいます。

ランナーは、起動時と stdout のサマリーで `Guard profile: fixture (...)` または `Guard profile: production (...)` を表示し、`--verbose` または `--debug` のもとで同じラベルを `summary.txt` とファイル単位のログに書き込みます。テストは、ガードを検証する前に `process.env.AIDLC_TEST_GUARD_PROFILE === "production"` をアサートできます。継承されたマーカーは決してプロファイルを選択しません。

これは子プロセス起動の環境契約です。テストコードとハーネスヘルパーは、やはり自分の環境をオーバーライドしたり、設定を書いたり、合成フィクスチャを構築したりできます。特に `resetAidlcEnv()` は `AWS_AIDLC_DEFAULT_SCOPE` と `AIDLC_SKIP_SOURCE_FRESHNESS` だけを削除します。プロファイルマーカーとその他のガード設定は保ち、テストが変えた後に production のゼロを復元することはしません。production プロファイルのラベルだけでは、個々のテストが production のガード証跡を使った証明にはなりません。そのクレームの一部として、選択されたテストの環境オーバーライドとセットアップをレビューしてください。

PR ワークフローのまとめられた `check` ジョブ（`Checks (contracts + smoke + production guards)`）は、production guards を有効にして、決定的ランナーとリカバリの契約を独自のステップで実行します。

```bash
bash tests/run-tests.sh --debug -P 8 --production-guards --unit --integration \
  --no-llm --filter '^(t-runner-production-guards|t-guard-recovery-production)' \
  > "$GITHUB_WORKSPACE/tmp/ci-guard-contract/production-run.log" 2>&1
```

このジョブはそのログディレクトリを作成し、テストが失敗したときも、無害化の後に smoke とガードのログに加えて `tests/logs/` を `ci-check-evidence` として収集します。アップロードの失敗はジョブを失敗させません。既存の `test` 集約（必須チェック名として保たれる `Tests (smoke + unit)`）は、`check` の成功を、smoke、すべての unit シャード、すべてのトリガーでの決定的 integration に加え、PR push 以外ではネイティブターミナルとライブ OS 分離のマトリクスとともに、要求します。production-guard のスライスはすべての PR push で走ります。両方のクロス OS マトリクスは、マージキューでそれに加わります。

このフィルタされたコマンドから `--production-guards` を外すと失敗します。`t-guard-recovery-production.test.ts` が fixture プロファイルのもとでジャーニーを 1 つも実行しないためです。合格するランナーの unit テストは、その欠けたカバレッジを隠せません。preview の `full-suite.yml` のフィルタのない決定的 integration ジョブは、意図した fixture プロファイルを保ち、production ジャーニーファイルを `SKIP` として報告します。PR CI と Full Suite の必須の production ジョブが、それらのジャーニーを検証します。Full Suite はさらに、その選択に対する完全なカバレッジを要求します。

## 並列実行

`--parallel N`（または `-P N`）は、ティア内で最大 N 個のテストファイルを同時に実行します。既定は直列（`1`）です。

**どういうときに役立つか。** ライブの integration と e2e のテストは、実時間の多くを CLI の起動とモデルのターンに費やします。integration のヘルパーは、テストごとに新しいプロジェクトを作成します。共有プロファイルや生成された出力を持つ E2E ファミリーは、さらに後述の分離チェックアウトモードを必要とします。

**スパイク結果（2026-05-06、Bedrock 経由の Opus 4.7）:**

| シナリオ | 直列 | `--parallel 4` | `--parallel 8` |
|---|---|---|---|
| 4 × `/aidlc --help` | 56s | 16s（3.5 倍） | — |
| 8 × `/aidlc --help` | — | — | 31s |

8 つの並列呼び出しはすべて `cache_read=73789` を観測しました。この過去のヘルプコマンドのプローブは、スロットリングや破損なしにプロンプトキャッシュの再利用を観測しましたが、同時のフルワークフローのキャパシティを確立するものではありません。

**何が直列のままか。** smoke ティアは `--parallel` を無視し、1 つのチェックアウト内で直列に走ります。unit ティアも、`tests/unit-shard-weights.json` が上限設定するプラットフォーム（macOS、[Unit Sharding](#unit-sharding) を参照）での `--shard` 実行を除いて同様です。unit CI は分離シャードで実時間を減らします。各共有ワークフロー呼び出しが新しいチェックアウトを持ちます。PR CI は Linux で 10 個の重み付き unit シャードと、integration 向けに 8 ワーカーを使い、最も長い integration ファイルを先に開始します。手動 Full Suite の `full_verification` は Linux、macOS、Windows のそれぞれで 16 シャードを使います。smoke は OS ごとに一度走り、決定的 integration と分離 E2E はそれぞれ 8 ワーカーで別々のジョブで走ります。まとめられた smoke/unit コマンドに `-P 8` を加えるだけでは、それらのティアは並列化されません。プリフライトゲート（`tests/integration/t19.test.ts`）も、LLM ティアがその終了ステータスに依存するため、直列に走ります。

**並列実行下の出力。** `START` マーカーはライブでストリームされます。最初の `DONE` の前に複数が現れることがあります。normal/verbose モードでは、TypeScript コーディネーターが各テストの TAP 本体をバッファし、そのファイルが終わるときに 1 ブロックとして書きます。`--debug` モードでは、Bun の stdout/stderr がライブでストリームされつつ、各テスト単位のログにも書かれます。並列のデバッグ出力はファイルのベースネームで前置されるため、重なり合うワーカーは帰属可能なままです。SDK/TUI/Kiro-ACP のドライバトレースは、ログの隣に `$LOG_DIR/sdk-drive-*.ndjson`、`$LOG_DIR/tui-drive-*.ndjson`、`$LOG_DIR/kiro-acp-drive-*.ndjson` として書かれます。分離 E2E はそれらをファイルのアーティファクトディレクトリの下に置きます。ランナーは、起動時と各テスト開始時にそのパスを表示します。Kiro-ACP のトレースには、ツール呼び出しと更新、出力のプレビュー、権限の回答、プロセスの stderr、result/timeout/end のイベントが含まれるため、タイムアウトを保持された証跡から調査できます。

**ワーカーの協調。** TypeScript ランナーは、ファイルごとに 1 つの Bun テストサブプロセスを開始し、アクティブな promise を追跡します。並列の上限に達すると、別のファイルを受け入れる前に、1 つのファイルの終了を待ちます。完了した各ファイルは `$LOG_DIR/_results/` に `.meta` サイドカーを得ます。ランナーはそれらのレコードを読んでサマリー表を埋めます。シェルラッパーは、すべてのプラットフォームでこのランナーに委譲します。

**ガイダンス。** 分離 E2E では、チェックアウトのキャパシティに `-P 8` を使い、`--bedrock-parallel 2` のような小さい明示的なプロバイダ制限から始めます。そのプロバイダの許容量を、同時のジョブとマシンに分けます。代表的なワークフローのスロットリング、レイテンシ、失敗を測定した後にのみ、それを増やします。個々の失敗を調査するには `--filter` を使います。

## 分離 E2E ワーカー

`--e2e --isolated-e2e` は、ワーカーのキャパシティをライブプロバイダのキャパシティから切り離します。`-P` はチェックアウトワーカーの数を制御します。既知の TUI、Codex exec、Kiro ACP/IDE、opencode の serial ファイルは同時に走れます。各ワーカーが自分のチェックアウト、生成されたツリー、アプリケーションプロファイル、一時フィクスチャ、ターミナル名前空間、出力ディレクトリを所有するためです。未知の `.serial.` ファミリーは、その共有リソースがレビューされるまで排他実行を保ちます。

一時プロジェクトは Git チェックアウトの外に置かれるため、リポジトリ発見がランナーのソースツリーを継承することはできません。失敗したフィクスチャは、プロセスのクリーンアップの後にログの隣に保持されます。新しい Claude プロファイルは初回実行の準備を受けます。所有の起動時モデルアップグレードの提示は、出荷されたモデルピンを保つため、その見える "No" の選択を通して辞退されます。

各ファイルは、信頼された OS の一時ディレクトリの下にプライベートな `AIDLC_TUI_BUN_ROOT` を受け取ります。確認されたセッションレコードとスナップショットは、その後そのプロファイルとログの隣にアーカイブされます。ワーカーのクリーンアップは、ネイティブドライバの認証済みセッションコントロールを使い、中断された開始を含めてデーモンの退役を検査します。これは成功、タイムアウト、キャンセルの後、一時ファイルが削除されるかワーカーが再利用される前に走ります。未確認のクリーンアップはディスパッチを止め、証跡を保持します。tmux のクリーンアップは、ワーカー自身のトランスポートにスコープされたままです。

コーディネーターは、未コミットの変更を含む現在の作成済みファイルをスナップショットし、独立したワーカーチェックアウトを作成する前に、生成された配布物を一度コピーします。既定のローカル Git クローンは、可能な場合はオブジェクトファイルをハードリンクし、ファイルシステムをまたぐ場合はコピーし、既存の alternate ストアを、その参照チェーンを延ばすことなく保ちます。alternate ストアを持つリンクされた worktree は、相対的なオブジェクト参照が正しく解決されるよう、初回スナップショットに Git トランスポートを使います。その選択されたリビジョンは保たれます。インストールされた依存関係は共有されます。作業ファイルと Git インデックスは独立です。テストは、やはり同じファイル、フィクスチャ、ライブのオプトイン、アサーションを実行します。テスト内のステップは、既存の順序を保ちます。スナップショットの準備中に、ソースを編集したり配布物を再生成したりしないでください。

相対シンボリックリンクは、ダングリングリンクを含めて元のターゲットを保つため、フィクスチャのエイリアスを通した書き込みはそのワーカー内にとどまります。スナップショットの準備は、絶対リンクとソースルートから逃れるリンクを拒否します。共有依存関係ディレクトリは明示的な例外です。追跡される子孫は、サイズ計算やコピーの前に構成要素ごとに検査されます。祖先の位置にあるシンボリックリンクやジャンクションは、その葉が通常ファイルに見えても、たどられるのではなく拒否されます。相対的な IDE シードパスと、パス値の実行ファイルオーバーライドは、ワーカーが始まる前にソースチェックアウトに対して解決されます。IDE は、やはりシードを自分のプライベートプロファイルにコピーします。

ビルドや CLI の起動なしに、完全な選択を確認します。`--e2e-plan` を `--e2e` と組み合わせます。これは `--isolated-e2e` を含意しますが、e2e ティア自体は選択しません。

```bash
bash tests/run-tests.sh --debug -P 8 --e2e --e2e-plan
```

明示的に有効にした Claude TUI 選択の例です。

```bash
AIDLC_TUI_LIVE=1 bash tests/run-tests.sh --debug -P 8 \
  --e2e --isolated-e2e --filter 't-tui-(?!kiro)' \
  --bedrock-parallel 2 \
  --e2e-timings tests/logs/<previous-stamp>/summary.txt
```

`--e2e-timings` は任意です。過去の所要時間はスケジューリングの順序を決めるのであって、選択を決めることはありません。新しいファイルはやはり走ります。履歴がなければ、ソースのタイムアウト値が大まかな順序のヒントを与えます。最も長い対象ファイルが先に始まります。飽和したリソースを使わない作業は、空いているワーカーを使えます。Bedrock、Kiro、IDE の制限は独立で、IDE ファイルは Kiro スロットと IDE スロットの両方を消費します。

これらの制限は、HTTP リクエストではなく **テストファイル** を数えます。ワークフローは内部で複数のモデル使用エージェントを起動できます。Claude SDK/TUI、Codex、既定の opencode の実行は、設定されたリージョンが異なっても Bedrock 予算を共有します。Kiro ACP/TUI/IDE は Kiro 予算を共有します。アカウント認証はホストが提供するままです。生成された IDE シードはオンボーディングを準備しますが、やはりサインイン済みのホストを必要とします。予算は 1 つのコーディネーターに適用されます。各ジョブに許容量全体を与えるのではなく、アカウント予算を同時のジョブやマシンに分けてください。これらのプロバイダ制限は分離 E2E のディスパッチに適用されます。integration は、やはり通常のティアごとのスケジューラを使います。別のホストと並べて実行するときは、ライブ SDK integration をフィルタしたファイルレーンで制限し、決定的 integration を別のチェックアウトに保ってください。unit シャードも別のチェックアウトを必要とします。パッケージングのテストがチェックアウト内で共有出力を再生成するためです。

ネイティブ Windows Codex のファイルも `windows-codex` の serial グループを共有します。新しいプロファイルは、[文書化済みの昇格 Windows サンドボックス](https://learn.chatgpt.com/docs/config-file/config-basic#windows-sandbox-mode) を選びます。そのセットアップはホストアカウントを使い、プロファイルをまたぐ同時の初期化はまだ検証されていません。無関係なハーネスが空いているワーカーとプロバイダスロットを使える一方で、Codex ファイルは一度に 1 つ走ります。Windows ホストでは Codex コーディネーターを 1 つだけ実行してください。これらのネイティブ実行には、ログイン済みの対話的セッションを使ってください。検証済みランタイムのサンドボックスコマンドは、SSH サービスセッションからは起動できませんでした。Linux と macOS の Codex ファイルは、引き続き Bedrock 制限を使います。

Windows では、同じネイティブランナーを `--e2e --isolated-e2e --filter 't-ide-kiro'` で使い、`AIDLC_KIRO_IDE_LIVE=1` を設定し、`--ide-parallel` を選びます。各 IDE 起動はそのシードをプライベートプロファイルにコピーし、Electron にデバッグポートを割り当てさせます。親は、PID を使ってポートを選ぶのではなく、その子のエンドポイントを待ちます。1 つの IDE ファイルから始め、次いで観測されたメモリと完了時間を使って 2 つを比較します。ネイティブコマンドは `bun tests/run-tests.ts --debug -P 8 --e2e --isolated-e2e ...` です。この経路は、古い Windows ラッパーの固定されたインストールディレクトリに依存しません。Windows プロファイルは、Electron のネストしたデータベースとログのパスをそのパス制限内に保つため、短いファイル単位の一時ディレクトリを使います。テストアーティファクトは、元のパスを保ちます。ティアダウンは、所有するブラウザの CDP エンドポイントを通して閉鎖を要求し、子が閉じるのを待ちます。クリーンアップの失敗はプロファイルを保持し、先行するテスト失敗の傍らに見えるままです。IDE アダプターは、プロンプト送信時にイベント提供のセッション ID も保つため、ワークスペース起動コールバックが観測されなかったときもセッション識別情報が利用できるままです。セッション ID のないプロンプトは、既存のフォールバック状態を保ちます。

GUI 実行のために、Windows デスクトップセッションをログイン済みに保ってください。インストールされた IDE を認証済みとして扱う前に、使い捨てのプロファイルでアカウントパネルを確認してください。IDE と CLI は別々のログインチェックを持ちます。サインイン済みの IDE は、Kiro CLI や Cursor CLI のゲートを満たしません。プロファイルシードは Windows ホストに保ち、テスト結果とトレースはそのユーザーデータディレクトリとは別に収集してください。

ランナーは、タイムスタンプ付きのログディレクトリの下に、次の追加アーティファクトを書き込みます。

- `e2e-plan.json`: 正確な選択インベントリ、見積もり、リソース要件。
- `e2e-events.ndjson`: ディスパッチ/完了のイベント、ワーカー ID、キューの時刻。
- `e2e-results.json`: 選択/前提ファイル、ソースのリビジョン/ダーティ状態、ワーカーの割り当て、ケースの pass/fail/skip 数、所要時間、timeout/cleanup の結果、診断的なスロットルパターンの数。
- `e2e-artifacts/<test>/`: 保持された JUnit と分離された SDK/TUI/IDE のトレース。
- `e2e-artifacts/<test>/deferred-cleanup.json`（分離ファイル実行では `attempt-N/` の下）: コーディネーターがネイティブプロセスの退役を検証した後の、Windows Codex フィクスチャの保持。これらのフィクスチャは成功時でも `retained-fixtures/` に移されます。保護されたサンドボックスファイルの最終的な削除はホストが担います。移動が拒否された（別のボリューム、またはフォルダ下のファイルがまだ保持されている）とき、フィクスチャはコピーされ元も保たれます。コピーも失敗すれば、それらはその場にとどまり、ラン log が 1 行でその旨を述べ、ファイルはそのケースが与えた結果を保ちます。
- `failed-fixtures/<label>-<pid>-<n>/`: 失敗したライブ SDK フィクスチャ（t183、t193）の有界なスナップショットで、`tests/harness/failed-fixture.ts` が取ります。フィクスチャ自体が、ホスト型ランナーが破棄する OS の一時ディレクトリの下に置かれるためです。`aidlc/` の下のワークフローレコードが先にコピーされます。リンクは決してたどられず、`node_modules/` と `.git/` はスキップされ、ファイル単位、ファイル数、合計サイズ、walk の上限が適用されます。`retained-fixture.json` は、除外されたすべてのエントリを理由別に数え、そのうち最初のものをパスで列挙します。ライブの収集器はそれをログツリーの残りとともにコピーし、サニタイザがアップロード前にそれを編集で伏せます。
- `e2e-artifacts/<test>/attempt-N/leg-evidence/`: すべてのライブレグが、合格か否かにかかわらず保つもので、`tests/harness/leg-evidence.ts` が各ドライバ自身の終点（SDK ドライブ、TUI セッションの kill、Codex exec、Copilot や opencode のターン）で、プロジェクトがまだディスク上にある間に取ります。`audit/<project>/` は、レグが駆動した各プロジェクトの各監査シャードのコピーを、プロジェクト内のそのパスで保持します。`words-*.ndjson` は、エージェントが人に見せた各テキストを、SDK のメッセージ、TUI セッションの Claude Code トランスクリプト、または Copilot と opencode の出力から、1 行ずつ（`ts`、`harness`、`turn`、`text`）保持します（Codex は自分の言葉を自分の exec ログに保つ）。8 KiB を超えるテキストと 256 KiB を超えるシャードは、始めと終わりを保ち、その間に切られた旨を述べます。レグはここに最大 1 MiB を保ち、`not-kept.txt` がそれに達したときに一度その旨を述べます。2 週間の夜間で、レグあたり約 20 KB を測定しました。サニタイザはこのフォルダをドライバトレース（後述）として扱います。
- `e2e-worker-storage.json`: チェックアウトプールの場所、推定スナップショットサイズ、チェックアウトコピーが保持されたかどうか。Windows プールは、深いレポートパスがフィクスチャのコピーを壊さないよう、システムの一時ディレクトリの下の短いプライベートパスを使います。

Kiro reviewer ジャーニーは、アサーションの前にその主要アーティファクトと一致したレビュー receipt を保存します。scope-exclusion ジャーニーは、タイムアウト時を含め、その最終状態と監査を保存します。そのジャーニーは、ワークフロー全体の完了と scope 由来の禁止ステージの検査を保ちつつ、完全に仕様化されたミニチュアのセキュリティパッチを使います。セットアップと 2 つの SDK ドライブは、元のケース期限を共有します。

ファイル単位の出力は増分的に保存されます。外側の期限や中断された実行は、失敗/不完全の結果のままで、合格する再試行に変換されることは決してありません。verbose/debug 実行は、ファイル単位の JUnit と、すべてのティアの実効カバレッジゲートの `.execution.json` レコードを保ちます。これらのレコードには、完全なプロセス環境や認証情報ではなく、カバレッジのコントロールが含まれます。すべてのテストファイルは、通常の smoke/unit/integration の実行を含め、所有のプロセススーパーバイザーのもとで走ります。デバッグログの書き込み失敗は、それ以上のディスパッチを止め、受け入れられたテストプロセスを退役させ、非ゼロのランナー結果を残します。通常のファイルもプライベートな一時ディレクトリとターミナル名前空間を受け取り、これによりランナーはテストが中断した後にネイティブセッションを退役させられます。結果ボリューム自体が書き込めない場合、欠けたキャプチャは不完全なままです。それらは成功したカバレッジを確立できません。

Codex のライブテストは `tests/harness/codex-test-lifecycle.ts` を使い、クリーンアップ時間を確保しつつ、元の失敗と完全な exec 出力を保ちます。Windows では、検証済みのランナー所有フィクスチャは、コーディネーターがそのプロセスツリーを退役させた後にのみ削除されます。失敗はそれらのフィクスチャを診断アーティファクトとともに保持します。exec ドライバは、Codex exec が提供できない対話的な `request_user_input` 機能を無効にし、スキルの散文による承認フォールバックを検証します。承認のアサーションとサンドボックスの権限は必須のままです。

Windows のプロビジョニングフィクスチャは、返る前にその一時アカウントとプロセスが退役されることを要求します。Windows サービスがまだ保持しているプロファイルハイブは、GitHub ホスト型ランナーでのみ VM 破棄のために記録されます。永続的なホストは、それを有界なクリーンアップ操作の中で削除しなければなりません。Windows の決定的 E2E ジョブは、チェックサムでピン留めされた Codex コマンドランナーをダウンロードし、`AIDLC_CODEX_RUNNER_PROBE` を設定して、既存のファイルシステムとアカウントのテストと並んでネイティブブートストラップのリグレッションを走らせます。モデル呼び出しはしません。ローカルの診断には、その変数を検証済みのランナー実行ファイルに向けます。任意で `AIDLC_CODEX_RUNNER_PROBE_ONLY=1` を設定して、ブートストラップとランチャーの検査を選びます。その診断選択は他のプロビジョニングケースをスキップし、完全なカバレッジの結果ではありません。

ワーカーの準備は、スナップショットとチェックアウトコピーのための空き容量に加えて 512 MiB の予約を検査します。各分離ファイルは、開始前に予約を検査します。`AIDLC_E2E_MIN_FREE_BYTES` は予約をバイト単位（非負整数）でオーバーライドします。この受け入れ検査は、すべてのランタイムのフィクスチャ増加を予測できません。通常のアサーション失敗は、そのフィクスチャと診断レコードを保持し、その後使い捨てのチェックアウトプールを解放します。`AIDLC_KEEP_TEMP=1` または未確認のプロセスクリーンアップは、調査のためにチェックアウトコピーを保持します。スケジューリングがライブワークフローの期限を延ばすことはありません。ターミナル基盤のプリフライトは、フィルタされた選択を含め、選択された TUI 作業の前に走ります。通常のアサーション失敗が、無関係なファイルの実行を妨げることはありません。

リビジョンループの TUI テストは、そのクリーンなジャーニーと reject/revise/approve のジャーニーを、別々のプロジェクト、Claude プロファイル、ターミナルセッションで同時に実行します。両方とも、クリーンアップのために時間を確保しつつ、1 つの 60 分のファイル予算内で同じ完了のマイルストーンに達しなければなりません。各ジャーニーは、自分のターミナル状態、ネイティブ忠実性の証跡、クリーンアップ結果を保持します。

このテストは、新しい Claude トランスクリプトで、確認された完了済みのルート HTTP 5xx 失敗の後にも待機を止めます。プロバイダのエラーとネイティブのトランスクリプトを記録し、所有の answer-gate クライアントを止め、通常のターミナルクリーンアップを行います。これはモデルを再試行したり、失敗を消したり、健全なワークフローの期限を変えたりはしません。ツールの出力、サブエージェントのエラー、復元された履歴、テストの完了マイルストーンの後のエラーは、この早期失敗を引き起こしません。

コントローラーが移植可能なキャンセルを必要とするとき、特にプロセスの終了が POSIX シグナルを届けない Windows では、`--e2e-cancel-file <path>` を使います。そのファイルを作成すると、ディスパッチが止まり、アクティブな所有ワーカーが終了します。POSIX の SIGINT/SIGTERM は同じクリーンアップ経路を使います。強制的なホスト/プロセスの終了はクリーンアップを実行できません。増分的な結果は、やはり未完了のファイルを表示します。

レガシーのサマリーと失敗ファイルの終了規約は利用可能なままです。失敗の終了コードは 255 で上限打ちされるため、256 の未完了ファイルを持つ実行が成功したプロセスステータスに巻き戻ることはできません。サマリーは完全な失敗数を保ちます。必須の夜間ゲートには `--require-coverage` を加えます。スキップされたケース、空のファイル、実行されなかった選択ファイル、空の選択は、非ゼロの終了を生みます。すべての verbose 実行は、選択されたインベントリとケース数を持つ `coverage.json` を書き、`Coverage: COMPLETE` または `INCOMPLETE` をテストの失敗とは別に表示します。必須ゲートにはプラットフォーム固有の選択を使ってください。広い発見実行での意図したプラットフォームスキップは、それらを満たしません。実効インベントリには、狭いファイル名フィルタのもとでも、自動的に必須となるプリフライトが含まれます。`requestedFiles` は元の選択を数えます。`selectedFiles` はそれらの前提を一度含みます。ターミナルの前提は、TUI ジャーニーが始まる前に、スキップされたケースのない、有効で空でない合格の証跡を生成しなければなりません。JUnit の証跡は、スイートの合計がそのテストケースのレコードと一致する完全なドキュメントでなければなりません。切り詰められたレポートの肯定的なヘッダーはゲートを満たせません。最終的なクリーンアップ/公開のエラーは、テストケースの結果とは独立に、ランを `ERROR` に設定します。`e2e-results.json` はさらに、すべてスキップのファイルを実行されたカバレッジと区別し、`coverageComplete` はスキップ、空、不完全のファイルでは false です。no-LLM やプラットフォーム固有の実行では、ライブカバレッジが正当に不完全になることがあります。完全な夜間カバレッジを主張する前に、期待されるプラットフォーム/プロバイダのジョブを集約してください。スロットルパターンの数は、出力における診断的な一致で、引用されたテキストを含むことがあります。それらはプロバイダのクオータ失敗を確立するものではありません。

## プラットフォームをまたぐ必須ジョブ

`tests/native-terminal-profile.json` は、決定的なターミナルコントロールを Linux/Bun、macOS/Bun、Windows/Bun、Linux/tmux のジョブに割り当てます。移植可能なコントロールは 3 つすべてのオペレーティングシステムで走ります。ネイティブ Linux と macOS の containment、Windows の Job Object と共有ハンドルの検査、互換性バックエンドには、明示的な担当があります。プロファイルは Linux arm64、macOS arm64（`macos-15`）、Windows x64 を対象とします。別のアーキテクチャには、個別の一致する義務を宣言してください。プラットフォーム固有のコントロールは、別々に選択可能なテストファイルにあります。そのアサーションはプロファイルによって必須のままです。プロファイルが名指すファイルに追加されたケースは、そのファイルを走らせる各ジョブに追加しなければなりません。Linux では unit ティアの `t-native-terminal-profile.test.ts` が、それらのファイルの各ケースを実行せずに列挙し、プロファイルが列挙しないケースがあれば失敗します。そのため PR は Full Suite より先にそれを満たします。

ディスパッチの前に、すべてのホストが受け取る作成済みソースを使って、1 つのプランを準備します。

```bash
bun tests/reconcile-tests.ts prepare \
  --profile tests/native-terminal-profile.json --cohort "nightly-$(date -u +%Y%m%dT%H%M%SZ)" \
  --repo . --output tmp/native-plan.json
```

プランには、正確なジョブ/ファイル/テストケースのインベントリ、cohort ID、未コミットのバイトを含む作成済みソースのダイジェストが含まれます。同じソースバイトとプランを他のホストにコピーします。プランと結果は、無視されるストレージまたは外部ストレージに保ちます。ルートパス、タイムスタンプ、Git コミット ID だけでは、ソースの識別情報になりません。

各ジョブを、一致するティア/フィルタのフラグと宣言されたバックエンドで実行します。たとえば、ネイティブプロファイルの Linux ジョブ向けに正確なフィルタを導出します。

```bash
TEST_MATRIX_PLAN=tmp/native-plan.json
TEST_MATRIX_JOB=linux-bun
TEST_MATRIX_FILTER=$(bun -e '
  const plan = await Bun.file(process.argv[1]).json();
  const job = plan.jobs.find(job => job.id === process.argv[2]);
  if (!job) throw new Error("unknown matrix job");
  const names = job.files.map(({path}) => {
    const parts = path.split("/");
    if (parts[0] !== "tests") throw new Error("expected native-profile test path");
    return `${parts[1]}-${parts.at(-1).replace(/\.test\.ts$/, "")}`
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  console.log(`^(?:${names.join("|")})$`);
' "$TEST_MATRIX_PLAN" "$TEST_MATRIX_JOB")
AIDLC_TUI_BACKEND=bun bash tests/run-tests.sh --debug -P 8 \
  --unit --integration --e2e --no-llm --isolated-e2e \
  --filter "$TEST_MATRIX_FILTER" \
  --matrix-plan "$TEST_MATRIX_PLAN" --matrix-job "$TEST_MATRIX_JOB" \
  > tmp/native-linux-run.log 2>&1
```

`--matrix-plan` と `--matrix-job` は厳格なカバレッジを含意します。ランナーは、ディスパッチの前に、実際のソース、プラットフォーム、アーキテクチャ、選択されたバックエンド、実効ファイルインベントリを検証します。クリーンアップとレポートの公開の後に `test-matrix-receipt.json` を封印し、実際の Bun バージョン、許可リストに載ったライブゲート、JUnit のハッシュ、検証されたテストケースの結果を記録します。ソースの変更、欠けたケース、スキップ、最終化の失敗は、成功した receipt を妨げます。分離ジョブは、そのチェックアウトが再利用または削除される前に、各ファイルの前後でワーカーの作成済みソースもハッシュします。その観測結果は `matrix-worker-source.json` に残ります。リコンシリエーションは、そのプラン、receipt、または参照された JUnit 証跡を上書きする出力パスを拒否します。Windows では、Bun 1.3.14 が、非同期の一時停止の後に同期的な子プロセスを早まってタイムアウトさせることがあります。ソース検証は、その読み取り専用の Git 照会からの早期の `ETIMEDOUT` だけを、多くても一度、残りの元の予算で再試行します。その回復をログに記録します。実際の期限の枯渇、他のエラー、テストの失敗は、この仕組みでは再試行されません。`t-test-source-timeout.test.ts` は、予算の契約と、実際の非同期ギャップのリグレッションの両方を検査します。

各 receipt をそのスタンプディレクトリとともに収集し、相対的な JUnit パスを保ち、その後すべての必須ジョブをリコンサイルします。

```bash
bun tests/reconcile-tests.ts reconcile --plan tmp/native-plan.json \
  --receipt "<linux-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<darwin-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<windows-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<linux-tmux-stamp>/test-matrix-receipt.json" \
  --output tmp/native-matrix-result.json
```

完全に一致するマトリクスだけが、終了コードゼロで終わります。欠けたジョブ、誤ったソース/cohort またはバックエンド、変更された JUnit、実際の失敗、矛盾する receipt は、失敗のままです。後の合格した receipt が、先行する失敗を消すことはできません。明示的に除外されたプロファイルの義務は `NOT_REQUESTED` として現れ、達成されたカバレッジとしては決して現れません。

このプロファイルは、ターミナルドライバと、保持された互換性コントロールを検証します。スケジュールされた preview は `full-suite.yml` を呼び、これがネイティブ receipt をリコンサイルし、宣言されたすべてのジョブの合格を要求します。スキップされたライブジョブはスイートを失敗させます。文書化された除外ファミリーはテストされないままです。

### 夜間フルスイートのマトリクスとプロビジョニング

`Full Suite` は、明示的な `ref` で呼び出せ、手動でディスパッチもできます（既定は `main`、両方の検証フラグは false）。その通常のプランは、未マージの PR を含む要求されたブランチやコミットを受け入れ、一度だけ解決します。すべてのマトリクスレグがその不変の SHA をチェックアウトします。preview と stable のリリースワークフローは、独自の公開ソースポリシーを強制します。Full Suite は、テストするためだけにコミットが `main` 上にあることを要求しません。スケジュールされた、および手動の `preview-release.yml` 実行は、ソースにすでに公開済みの preview があるときでも、パッケージングの決定性、typecheck、lint、インストーラーのシェルチェックの後にそれを呼びます。preview は PR CI のテストマトリクスを再び呼びません。Full Suite が自分のテストカバレッジを担います。失敗した Full Suite は、preview のビルドを止めません。`Release tests` ジョブは、失敗したレグ、失敗したジョブ、失敗したテストケースのレポートを `scripts/ci-preview-test-report.ts` で描画します。レポートを run サマリーと `preview-test-report` アーティファクトに書きます。合格でも失敗でも、レポートは answers corpus の夜間の読み（`### Answers corpus`）で終わります。合格した応答、種類別のミス（setup、エージェントが質問を一度も表示しなかったときのチェック自身のもの、record、question、words）、id 別の各ミスを、ライブチェックが `full-suite-live-*` アーティファクトに残すサマリーから示すか、1 つもなかったという行を示します。そのセクションはレポート専用で、公開ノートには決して入りません。公開される preview ノートはその後、警告で始まり、そのレポートで終わります。計画されたノートはまるごと保たれます。レポート、そしてそれでも余地がないときは警告が、先に道を譲ります。そのため、失敗したスイートが、計画されたノートが GitHub の 125,000 文字のリリース制限に収まる preview を止めることは決してありません。`update-from-previous` ジョブ（`scripts/ci-update-from-previous.ts`）は、最後の stable リリースのインストールを Linux、macOS、Windows で候補に更新し、すべてのハーネスプロジェクトのフック、refresh、doctor を実行します。各プロジェクトは、人自身のコミット済みアプリ、`.gitignore`、`AGENTS.md` を保持し、その作業はゲートで待ちます。更新の前に、最後のリリース自身のエンジンとフックのもとで、スクリプト化された代役（`tests/harness/work-open.ts`、そのツールの scope host 上）が bugfix を開始し、Requirements の質問に答え、開いた Requirements ゲートでその日の作業を止めます。7 つすべてのプロジェクトで並行してです。refresh の後、人は新しいチャットで `/aidlc --resume` と入力し、承認します。ゲートが戻ってこない、ステージが再び走る、回答が再び求められる、承認が人の応答に裏付けられない、次のステージが始まらない、または彼らがコミットしたファイルが AI-DLC のマークされた部分の外で変わったとき、チェックは失敗します。代役が最後のリリースで作業を開いたまま残すことがまったくできないとき、チェックはその旨を独自の行で述べます。ジョブの 2 つ目のレグ（`--channel copy`）は、copy チャネルについて同じことを行います。各プロジェクトは、最後のリリースの copy ランタイムからコピーされた `runtime/<harness>/` で、その `.sha256` に対して検査され、独自の `config --from` でセットアップされ、ガイドの Copy Channel が述べるとおり、候補の copy ランタイムからそのコマンドで refresh します。どちらかのレグが失敗したとき、preview はなお公開され、そのノートは警告で始まり、レポートはそれに対する行を得ます。`release.yml` は、それに失敗する stable リリースを公開しません。`Release result` は、成功した preview の公開か、意図したスキップを要求します。Full Suite は別に走ります。preview はその run ID を記録し、その run の証跡をダウンロードし、その実際の結果を、失敗を伝播させずに報告します。変更のないソースは公開をスキップしますが、やはりテストレポートを受け取ります。stable の昇格は、選択された preview のソースと新しいバージョンのコミットを検証し、その後ソース CI や Full Suite を繰り返すことなく、ネイティブバイナリ、インストーラー、ライフサイクルフロー、アップグレード、チェックサム、provenance をビルドして検査します。決定的なソースティアと production guards は、PR/merge CI と手動の `full_verification` に残ります。通常のリリース目的の Full Suite はそれらを省きます。preview は契約チェックと Full Suite を一度実行し、公開の重複排除は後続のビルドと公開のチェーンにのみ適用します。

未マージの PR のユーザー承認済みフル検証には、そのブランチを選び、`ref` をそのブランチの正確なワークフローヘッド SHA に設定します。

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f full_verification=true
```

フル検証は、認証情報を受け取らないすべてのジョブを実行します。ネイティブの義務とリコンシリエーション、すべての決定的ティア、production guards、Windows のリリース契約です。未マージのコードを選び得るため、3 つの `live_prepare_*` ジョブ、`live_linux`、`live_macos`、`live_windows`（OIDC と AWS 認証情報を要求するジョブ）を決して実行しません。候補のライブファミリーは、後述の別に認可されたモードである `live_verification` でカバーしてください。Full Suite のすべてのチェックアウトは `persist-credentials: false` を設定するため、候補のコードがディスク上でリポジトリトークンを見つけることは決してありません。それ以外は、通常の Full Suite 実行と同じファイルマトリクス、アサーション、タイムアウトを使います。別の `full-suite-verification-result` アーティファクトには、`purpose: "full-verification"` を持つ `full-suite-result.json` が含まれます。`passed` は、他のすべてのジョブの成功、6 つの live/preparation ジョブが `skipped` であること、`verificationFamily: "all"`、`omittedLegs` がまさにその 6 ジョブを名指すことを要求します。preview も stable の公開も、候補がマージされた後でも、この結果を消費しません。

`full_verification` は `workflow_dispatch` にのみ存在します。チェックアウトされた SHA が選択されたワークフローヘッドと等しいことを要求し、`live_verification` と相互排他で、family/file のフィルタを拒否します。push や pull-request のイベントが、特権的なフル検証を自動的に開始することはありません。

ユーザー承認済みのライブのみの候補検証には、候補ブランチで `live_verification=true` を付けて Full Suite を手動でディスパッチし、`ref` をそのブランチの正確なワークフローヘッド SHA に設定します。

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f live_verification=true
```

他のカバレッジがすでに実行中のときに 1 つのファミリーだけを繰り返すには、`-f verification_family=codex` を加えます。手動の選択肢は `all`（既定）、`claude-sdk`、`claude-tui`、`codex`、`copilot`、`opencode` です。`all` 以外のファミリーは、ライブ検証モードと、同じ手動イベント/正確なヘッドの検査を必要とします。元のプラットフォームごとの N/M シャード番号を保ちつつ、Linux/macOS/Windows でそのファミリーの行だけを選びます。スコープされた検証では、別の Windows リリース契約ジョブは省かれます。family セレクターは再利用可能な呼び出し側には公開されず、通常のリリース目的の実行は `all` を使わなければなりません。

1 つのテストファイルには、その正確なリポジトリパスも渡します。

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f live_verification=true \
  -f verification_family=claude-sdk \
  -f verification_test=tests/integration/t238-user-stories-mob.sdk.test.ts
```

そのファイルは、選択されたファミリーに属していなければなりません。未知のパスと一致しないファミリーは、プランニングを失敗させます。宣言されたプラットフォームで走ります。移植可能なテストは 3 つすべての OS を使い、Windows 専用のケースは Windows を使います。準備はそれらのランナーだけをカバーします。元のシャード識別情報は保たれ、結果は `verificationTest`、`verificationPlatforms`、省かれたジョブを明示的に記録します。この選択は、stable の公開に消費されません。

これらの検証入力は `workflow_dispatch` にのみ存在し、`workflow_call` には決して存在しません。認可には、そのイベントと、チェックアウトされた SHA が `github.sha` と等しいことが必要です。`main` でワークフローを選んでも、別のブランチのソースを認可できません。push や pull-request のトリガーが、特権的な検証を開始することはありません。このモードは `plan`、3 つの `live_prepare_*` ジョブ、`live_linux`、`live_macos`、`live_windows`、`release_contract_windows` を実行します。ネイティブターミナル/リコンシリエーション、決定的ティア、production guards を意図的にスキップするため、決定的 CI を繰り返しません。既存のプロバイダのオプトイン、厳格なライブカバレッジ、認証情報の分離は、引き続き有効です。

別の `full-suite-live-verification-result` アーティファクトには、`purpose: "live-verification"`、`verificationFamily`、`omittedLegs` の省かれたジョブ、`complete: false` を持つ `full-suite-result.json` が含まれます。その `passed` は、すべてのライブジョブの成功と、意図的に省かれたすべてのジョブが `skipped` であることを要求します。欠けた、失敗した、キャンセルされた、または予期せず実行されたジョブは失敗します。`main` の成功した検証でも、stable の公開には消費されません。通常の Full Suite 実行は `full-suite-result` というアーティファクト名を保ち、明示的に省かれた決定的と production-guard のジョブを除くすべてのジョブを要求します。リリース目的のない古いアーティファクトは、Full Suite の結果ポリシーを満たしません。

3 つの独立した `live_prepare_*` ジョブは、`live-prepare.yml` を呼び、contents-read 権限だけで依存関係をインストールして projection をパッケージ化します。各ライブ OS ジョブは、自分のプラットフォームの準備だけを待ちます。POSIX の準備は公式 Node 22.23.2 を選び、その完全なインストールプレフィックスを、ピン留めされた CLI とともにパックします（`ci-live-deps.py pack --cli ... --node-runtime ...`）。検証済みのアーカイブは `bin/node` とそのライブラリディレクトリの両方を必要とします。分離ランタイムはそのプレフィックスを root 所有のツールツリーにコピーし、ローダ相対のライブラリを保ちつつ `node/bin` を PATH に置きます。Node と CLI の起動は、ランナーディレクトリが保護された後に検査されます。単独の Homebrew 実行ファイルをコピーすると `@rpath/libnode` のような依存関係を失うため、サポートされません。Windows の CLI インストールは、その分離ユーザー内にとどまります。これは [#1306](https://github.com/awslabs/aidlc-workflows/issues/1306) を解決します。インストーラーは OIDC がスコープにある状態で決して走らず、認証情報付きのレーンは準備されたバイトを検証して展開するだけです。すべての認可された Full Suite 実行は、既存の `ai-pr-review` 環境を使って準備とホスト型ライブのジョブを実行します。このリリースワークフローには、別のライブオプトインのスイッチはありません。欠けた前提、スキップされたジョブ、失敗したテストは、通常の Full Suite 実行を失敗させます。それらは preview の公開をブロックしません。preview はなおビルドされ、そのノートは Full Suite の失敗レポートで終わり、別の Full Suite 実行だけが red のままです。stable の昇格は、それらの結果と警告を preview のページに保ち、警告行をその昇格レコードに保ち、stable ページがその preview をリンクします。スイートを繰り返したり、以前の失敗が合格したと主張したりはしません。stable の公開は、やはり新しいバイナリがインストールとアップグレードの検査に合格することを要求します。認証情報なしの Windows リリース契約ジョブも走ります。

宣言されたカバレッジは次のとおりです。

- 手動 `full_verification` でのみ: 決定的 smoke、16 個の独立した unit シャード、Linux、macOS、Windows での integration と分離 E2E。integration と E2E は別々のジョブで、それぞれ 8 ワーカーと、自分のランナープロセスと証跡を持ちます。すべての unit ファイルは OS ごとに 1 つのシャードに割り当てられます。各シャードは自分のデバッグログと結果を保ちます。
- 手動 `full_verification` でのみ: Linux の production-guard スライスが、ランナーとリカバリの契約に対して `--production-guards` と `--require-coverage` を選びます。そのためそれらのケースは、通常の fixture モードのティアがスキップしても検証されます。
- ソースに結び付けられたネイティブターミナルの義務。Linux arm64/Bun と tmux、macOS arm64/Bun（`macos-15`）、Windows/Bun 上です。ホスト型 Windows は他のツーリング向けに Node を提供します。Bun はピン留めされた依存関係をインストールします。
- ホスト型 Linux/macOS/Windows 上の Claude SDK、Claude TUI、Codex、Copilot CLI、opencode、release-endpoint の契約。厳格な SDK レグでの Claude プラグイン呼び出しを含みます。Copilot CLI は、認証情報ブローカーに対して、Codex が使う Mantle モデルで、独自モデル（BYOK）モードで走るため、GitHub サインイン、Copilot シート、トークンは関与しません。そのリリースジャーニー（`tests/e2e/t-exec-copilot-release-journey.serial.test.ts`）は、人が初日に行うことです。copy チャネルを通したセットアップ、doctor、文書化された最初のステップ、プラン質問、承認された Reverse Engineering で、入力された各行にメッセージレコードが伴い、各行は Copilot 自身の対話的ターミナルのプロンプトで入力されます（ネイティブターミナルドライバ上の `tests/harness/copilot-tui.ts`。`copilot -p` セッションはモデルに質問で止まるなと告げるが、ターミナルの人は誰もそれに遭遇しない）。2 つ目のケースはフォルダを信頼されないままにし、`copilot -p` を実行し、doctor が信頼の修正を名指すことを要求します。Codex のゴールデンジャーニー（`tests/e2e/t-exec-codex-journey-golden-bugfix.serial.test.ts`、Linux と Windows）は、同じ greeter を最初の行から Code Generation 承認まで修正し、プラン質問をその日に残して新しいセッションで承認します。Copilot のもの（`tests/e2e/t-exec-copilot-journey-golden-bugfix.serial.test.ts`、Linux のみ。Windows では再試行が許す 25 分を超えて走る）は、そのリリースジャーニーの copy チャネルインストール上で、Copilot 自身のターミナルで、新しいセッションを同じホームでの新鮮な `copilot` として、同じことを行います。opencode のもの（`tests/e2e/t-run-opencode-journey-golden-change.serial.test.ts`、Linux と Windows）は、同じリクエストを Reverse Engineering まで運び、そこで人が自分の言葉で 1 つの変更を求め、出荷された権限テーブルでリビジョンを承認します。
- Kiro ACP、TUI、IDE は、専用の分離 Windows デスクトップホストを待つ宣言された除外です。ローカルのライブ実行がそのカバレッジ経路のままです。
- Cursor は除外されます。そのベンダー CLI がエージェント環境から API キーを読むため、認証情報の分離が利用できません。除外が成功したカバレッジとして報告されることはありません。

`scripts/ci-live-filter.ts --list` は、発見されたファミリーの区画を表示します。
認可と依存関係のインストールの後、プランは `--matrix linux`、`--matrix macos`、`--matrix windows` を、`live_linux`、`live_macos`、`live_windows` ジョブの動的マトリクスとして出力します。各行の `shard: N/M` は、そのファミリー/プラットフォーム向けに所要時間を均衡させたグループを選びます。各 OS は、2 つの Claude SDK（Linux では 5 つ。ゴールデンジャーニーを走らせ、answers corpus を単独で、コーパスを自分のシャードで走らせる。Windows では 3 つ。こちらもゴールデンジャーニーを走らせる）、3 つの Claude TUI、1 つの Codex（Linux と Windows では 2 つ。ここで Codex のゴールデンジャーニーが走る）、1 つの Copilot、1 つの opencode シャードを持ちます。全体で 30 のライブハーネスジョブです。ゴールデンジャーニーは、そこで再試行が許す 25 分を下回る間、Linux と Windows で走ります。`tests/live-shard-weights.json` のタイミング重みはスケジューリングのヒントです。発見は、やはりすべての対象ファイルをプラットフォームごとにちょうど一度割り当てます。各 OS は独自の並行性上限を持ちます。Linux 4、macOS 2、Windows 3 のライブジョブです。すべてのシャードは多くても 2 つのファイルワーカーを持ちます。Windows Codex のファイルは serial のままです。Windows のリリース契約カバレッジは、その別のシャード化されていないジョブにとどまります。

`--isolated-files` は、生成状態と Git 状態を含めて、各ワーカーを次のファイルの前に元のチェックアウトスナップショットから復元します。各ファイル/試行は、新しい HOME/USERPROFILE、一時ディレクトリ、Claude/Codex/opencode と XDG のプロファイル、プライベートな Git config、ブローカー専用 AWS config のプライベートなコピーを得ます。インストールされたツールと依存関係は再利用されます。スロットが再利用される前に、既存のプロセス/トランスポートの退役検査が成功しなければなりません。クリーンアップの不確実性はディスパッチを止め、残りのファイルを不完全とマークします。

標準の権限設定: 2 つのゴールデンジャーニーは、プロジェクトの出荷された設定（設定ソースは user、project、local。user はドライブのスクラッチ config フォルダ）で、Claude Code を既定の権限モードで駆動し、すべてのプロンプトに yes と答えます。AI-DLC 自身のコマンドやレコード（`aidlc/` または `.claude/` を名指すもの）のプロンプト、またはプロジェクトの外への書き込みは、ジャーニーを失敗させます。その他のすべてのプロンプトはそのログに列挙されます（`tests/harness/stock-permissions.ts`）。他の Claude SDK ドライブは `bypassPermissions` を保ちます。Codex の `--json` ジャーニーは出荷された `workspace-write` サンドボックスを走らせ、サンドボックスが拒否した `.codex/` または `aidlc/` を名指すコマンドはそのターンを失敗させます。Copilot CLI のターミナルジャーニーは、各権限ダイアログにあらかじめ選ばれた "Yes" で答え、それらを何が引き出したか（AI-DLC のスキルは自分のレコード書き込みとその `.aidlc/bin/aidlc-engine` ランチャーだけを許す）で数えます。その `-p` のケースは `--allow-all-tools` で走るため、人自身の `--allow-tool` のルールが決めます。Claude のターミナルジャーニーは権限プロンプトをスキップし、opencode はすでに `--auto` なしで走ります。

`--file-retries 1` は、確認されたクリーンアップの後に、短い失敗ファイルだけを新鮮な状態で再試行し、両方の試行を `e2e-artifacts/<file>/attempt-N` の下に保持します。（`--isolated-files` なしでは、同じフラグが smoke、unit、integration のファイルを新しいプロセスで再試行します。マージキューは、前述のとおりそれを使います。）タイムアウト、不完全な証跡、クリーンアップの失敗、person-turn の失敗は再試行されません。person-turn の失敗は `Person-turn failure` のエラー行も表示します。再試行での合格は `Flaky live test` の警告を表示します。モデルサービスが原因で失敗したファイル（SDK ドライブの `ModelApiError`: Claude Code が 429、5xx、または切れた接続で実行を終えた。リクエストが原因の 4xx では決してない）は、1 回の再試行を保ち、`Model service failure` の警告を表示します。失敗したすべてのケースがサービスのものであるとき、`failures.txt` とプレビューレポートのその行は "the model service failed, not AI-DLC: infrastructure, not a test result" と読め、傍らの本当の失敗はファイルの通常の理由を保ちます。Windows のライブジョブは、分離された子の出力をそのログの外に保つため、収集された `e2e-results.json`（`bun scripts/ci-retry-report.ts --live tests/logs`）から、固定の文言とテストファイルの名前だけでこれらの行を述べます。合格したファイルは再実行されません。各シャードは、その認証済みの分離と必須の能力プリフライトを保ちます。手動の `--family FAMILY --test <repository-path>` は、そのシャード識別情報を保ちつつ、宣言されたプラットフォームでそのファイルだけを選びます。依存関係の準備は高速な gzip 圧縮を使い、起動を短くするため、結果のアーカイブを 2 回目の圧縮なしでアップロードします。

すべての Full Suite のジョブ名は、ランナー OS で始まり、次いでそのレーンとマトリクス項目が続きます。たとえば `Linux / claude-tui 3/3`、`macOS / deterministic unit-3`、`Windows / native-terminal bun`、`Windows / release-contract` です。そのため Actions UI は、run のジョブを OS でグループ化します。結果の `legs` はジョブ id を保ち、プレビューレポートは失敗したジョブを OS とレーンでグループ化します。

各認証情報付きジョブは、既存のロールから 3,600 秒のセッションを要求します。ジョブには 80 分の制限が、ライブテストステップには 70 分の制限があります。すべてのライブファミリーは、通常の integration/SDK ファイルを含め、3,600 秒の共有ランナー予算と独立したファイル期限を受け取ります。ドライバの作業は、そのエンベロープ内で最大 5 分をクリーンアップのために確保します。収集は失敗とタイムアウトの後も続きます。古いジャーニーのより長いローカルタイムアウトは、ホスト型の予算を延ばしません。枯渇は、不完全なカバレッジを伴う見える失敗です。

`bun scripts/ci-live-filter.ts claude-tui --platform linux` は、アンカーされたランナーフィルタを表示します。発見は、各ファイル自身の integration/e2e のライブゲート変数、導出された Claude 基盤のリスト、unit のリリース契約のオプトインを使います。汎用のプラグインヘルパーを使っても、それがサポートするすべてのプロバイダのカバレッジを主張することにはなりません。unit のゲートフィクスチャのテストは決定的で、ライブファミリーではありません。`PLATFORM_ONLY` は、一部のプラットフォームでのみ走るファイルと、プラットフォームの指定がない場合は、どのライブジョブも設定しない自分自身のスイッチでのみ開く要求時のチェック（入力コーパスのチェック）を名指します。選択されたファイルの中のスキップされたケースを隠すことは決してありません。すべてのライブプロバイダのレグは `--require-coverage` を使います。リリース契約のファイルは、プラットフォーム条件付きのケースを保ち、そのフラグを使いません。

ネイティブプロファイルの外では、決定的とリリース契約の結果はジョブの結果であって、個々のすべてのケースが OS マトリクスのどこかで走った証明ではありません。そのデバッグアーティファクトは、ファイル単位のケース数、スキップされたケース、JUnit を保ちます。そのようなすべてのケースを適用可能な OS に割り当て、それらの receipt をジョブ間でリコンサイルする、ソースに結び付けられたインベントリはありません。ティア全体に `--require-coverage` を適用すると、正当にプラットフォームに適用できないケースも拒否してしまいます。green なジョブが、それらのスキップを合格に変えることはありません。OS をまたぐ完全なケースカバレッジは、そのインベントリとリコンシリエーションが存在するまで、明示的なギャップのままです。

`--args` を加えると、完全なランナー引数を 1 行ずつ表示します。スクリプトがティア選択を担います。選択されたファイルのあるティアだけを出力し、各ファミリーの厳格カバレッジポリシーを適用します。ライブの integration と E2E のファイルは `--isolated-files` を使います。unit のリリース契約は、既存の実行経路を保ちます。production-guard のジャーニーは、fixture プロファイルのファイルとシャードを共有する場合を含め、production プロファイルを独立して受け取ります。ワークフローは `--run` を使って、ランナーをリポジトリルートから直接起動し、シェルの単語分割や Bash バージョン固有の組み込みなしに各引数を保ちます。

```bash
bun scripts/ci-live-filter.ts claude-sdk --platform linux --run -- --debug -P 8
```

e2e ファイルを含む選択には、`--e2e-plan` を付けて、テストを実行せずにそのプランを確認します。integration のみ、または unit のみの選択には付けないでください。そのモードは空の e2e 選択を意図的に拒否します。決定的な `--no-llm` 実行は、閉じた Claude ヘルスプリフライトを省き、意図したスキップを前提の失敗として扱うことなく、そのファイルをスキップとして記録します。

アーティファクトは `full-suite-native-plan`、`full-suite-native-<job>`（完全なログスタンプディレクトリと JUnit）、`full-suite-native-result`、`full-suite-production-guards`、`full-suite-deterministic-<suite>-<OS>`（suite は `smoke`、`unit-1` から `unit-16`、`integration`、`scope-runs`、`own-file-moves`、`scope-hosts`、`guard-matrix-1`、`guard-matrix-2`、`e2e`）、`full-suite-scope-runs-<OS>`、`full-suite-own-file-moves-<OS>`、`full-suite-scope-hosts-<OS>`、`full-suite-guard-matrix-1-<OS>`、`full-suite-guard-matrix-2-<OS>`（リリースの `scope_runs` ジョブ）、`full-suite-live-<family>-<slice-number>-<OS>`、`full-suite-live-release-contract-Windows`、そして目的別の結果（90 日保持）です。`purpose: "release"` には `full-suite-result`、`"live-verification"` には `full-suite-live-verification-result`、`"full-verification"` には `full-suite-verification-result` です。最終的な JSON は、`sha`、`runId`、`runAttempt`、`purpose`、`verificationFamily`、`coveragePolicy`、`passed`、`complete`、`legs` に各ジョブの結果、`disabledLegs: []`、`omittedLegs`、そしてソートされた `excluded` リストに `hosting: "excluded"` と宣言されたライブファミリーを記録します。`required-hosted-live-shards-v3` のもとでの `purpose: "release"` では、`passed` は、40 桁の 16 進コミット ID、`deterministic` と `production_guards` がちょうど省かれてスキップされていること、`scope_runs` を含む他のすべての宣言されたジョブが成功していることを要求します。欠けた、失敗した、キャンセルされた、または予期せずスキップされた必須ジョブは失敗します。`disabledLegs` は、Full Suite の結果ポリシーが過去の無効化ライブレポートを拒否できるよう保持されます。`complete` はさらに、除外ファミリーがないことを要求します。文書化された Kiro と Cursor の除外のもとでは false のままで、preview の公開の述語ではありません。それらの除外はスイートを失敗させずに警告します。無効化された必須ジョブはそれを失敗させます。任意のインスペクター `scripts/ci-full-suite-evidence.ts check` は、`sha` が要求されたコミット、`runId` がそれが来た run、`purpose` が `"release"`、`verificationFamily` が `"all"`、`coveragePolicy` が `required-hosted-live-shards-v3`、`passed` が true、`disabledLegs` が空、`omittedLegs` がちょうど 2 つの決定的/production-guard のジョブ ID であるときにのみ、結果を受け入れます。それらのジョブはスキップされていなければならず、他のすべての宣言されたジョブと追加のレグは成功していなければなりません。`complete` を要求しないため、文書化された除外は警告するだけです。昇格はこのインスペクターを呼び出したり、その合格を要求したりしません。ジョブの成功も、このポリシーマーカーも、OS をまたぐ完全なケースカバレッジをアサートしません。

ネイティブジョブは、`--debug -P 8` の Bash ラッパーと、変わらないマトリクスのプラン/ジョブセレクターを使います。そのアーティファクトには `tests/logs/` に加え、無害化されたルート `tmp/full-suite-native/` のキャプチャとリテラルのスタンプパスが含まれます。ネイティブ receipt のリコンシリエーションは、やはり receipt を再帰的に発見します。

共有される決定的アーティファクトには、`tests/logs/<stamp>/` と `tmp/ci-deterministic/`（完全な stdout/stderr とリテラルのスタンプパス）が含まれます。CI アーティファクトは `ci-deterministic-<suite>-<OS>` を使います。suite は、拡張 macOS/Windows 実行では smoke、Linux では unit-1 から unit-10、Windows と手動 macOS では unit-1 から unit-16、マージキュー macOS では unit-1 から unit-2、integration、scope-runs、own-file-moves（拡張マトリクスのみ）、scope-hosts、guard-matrix-1、guard-matrix-2、e2e（拡張マトリクスのみ）です。Linux smoke と production-guard の証跡は代わりに `ci-check-evidence` を共有し、`tmp/ci-smoke/`、`tmp/ci-guard-contract/`、`tests/logs/` を含みます。アップロードは、失敗したテストコマンドの後も含め、両方のログの場所が無害化に合格することを要求します。

Kiro ACP/TUI/IDE のライブファミリーは、夜間フルスイートでは宣言された除外で、警告として表示され、`complete: false` を残します。それらは、別の低特権の識別情報のもとで Kiro を走らせる、専用の分離 Windows デスクトップホストを必要とします。`AIDLC_KIRO_ACP_LIVE=1`、`AIDLC_KIRO_TUI_LIVE=1`、`AIDLC_KIRO_IDE_LIVE=1` を使ったローカル実行が、そのカバレッジ経路のままです。フォローアップの issue がホスト型レーンを追跡します。

stable 昇格のために preview を選ぶ前に、メンテナーは、選択されたソース SHA について記録された Kiro CLI のリリースジャーニーの結果を、各 Kiro ツリーごとに 1 つずつレビューします。setup が "Kiro CLI (V2)" として列挙する `kiro`、setup が "Kiro" として列挙し Kiro CLI の v3 エンジン向けにビルドされた `kiro-ide` です。ジャーニーは各ツリーをそのエンジン（`--v2`、`--v3`）で開始します。両方とも Kiro CLI で走り、どちらも Kiro IDE を駆動しません。その SHA の結果が存在しない場合は、サインイン済みの Kiro CLI を持つマシンで、preview のソースコミット上でジャーニー（`tests/e2e/t-tui-kiro-release-journey.serial.test.ts`。Copilot レーンと同じジャーニーで、対話的な `kiro-cli chat` ターミナルで、ツリーごとに一度）を実行します。

```bash
bun scripts/package.ts
AIDLC_KIRO_TUI_LIVE=1 AIDLC_TUI_LIVE=1 bun tests/run-tests.ts --e2e --production-guards \
  --require-coverage --filter t-tui-kiro-release-journey
```

`--require-coverage` は、いずれかのツリーのジャーニーがスキップされたとき、ランを失敗させます。一方のツリーがその SHA の結果をすでに持ち、他方が欠けているか失敗しているときは、`AIDLC_KIRO_RELEASE_TREE=kiro` または `AIDLC_KIRO_RELEASE_TREE=kiro-ide` をコマンドの前に置きます。そのツリーのジャーニーだけが走り、`--require-coverage` はそのツリーだけをカバーします。Linux では Kiro にスクラッチのホームを与え、マシンのサインインを保つため、`~/.kiro` には手を触れません。各ジャーニーは約 5 分かかります。クレジットは Kiro CLI が使うモデルに従います（Kiro CLI 2.32.0 で `claude-opus-5.5` を使う場合、それぞれ約 33）。ツリーごとに 1 行を表示します。たとえば `Kiro CLI 2.32.0 (kiro-ide) release journey on <commit>: PASS (5.1 min of turns, 33.23 credits, 3 permission prompts)` です。`<commit>` は、チェックアウトがそのコミットにない変更を持っていたとき（run はチェックアウトをそのままパッケージ化する）は `<commit> plus uncommitted changes` と読め、git が言えなかったときは `<commit> (git status failed)` と読めます。ソースコミットのクリーンなチェックアウトから実行してください。両方の行は、完全なソース SHA を含めて、昇格の前に選択された preview の GitHub リリースノートに記録されます。そのソースの既存の結果は再利用されます。昇格ワークフローは、その新しいメタデータコミット上でジャーニーを再実行しません。ワークフロー内のどこも、それらの手動の結果を読みません。メンテナーが [preview を本番に昇格する](../../DEVELOPERS.md#4-promote-a-preview-to-production) のステップ 2 でそれらをレビューします。修正は、昇格のために選ばれる前に、別の preview で出荷されます。

ライブジョブは、既存の `ai-pr-review` 環境とロールを使います。Full Suite を実行する前に、これらの前提を確認してください。

- 環境 `ai-pr-review` がシークレット `AWS_AI_PR_REVIEW_ROLE_ARN` を提供します。`live_linux`、`live_macos`、`live_windows` がその環境を選びます。シークレットはそれらのジョブの内側で解決されます。`full-suite.yml` を呼ぶワークフローは `secrets: inherit` を渡さなければなりません。それがないと、呼ばれた実行でシークレットが空に解決され、すべてのライブジョブが "Assume nightly Bedrock role" で失敗しました。各ライブジョブは今やシークレットを先に検査し、`secrets: inherit` を名指すメッセージでただちに失敗します。Kiro/Cursor の API キーのワークフローシークレットやホスト型ベンダーキーのレグはサポートされません。AWS ロールの OIDC 信頼は、このリポジトリの `environment:ai-pr-review` のサブジェクトにスコープされなければなりません。各 assume は、既存の 1 時間のロール期間内で 3,600 秒を要求します。ワークフローは、IAM セッション期間を変えることなく、作業を有界なファイルジョブに分割します。
- ロールは、`scripts/ci-credential-broker.ts` の CI 専用モデルテーブルへの Bedrock invoke/stream アクセスを必要とします。`us-east-1` の Claude Fable 5、Opus 4.8、Sonnet 4.6、Haiku 4.5 の推論プロファイル、同リージョンの opencode の Sonnet 4.6 既定、`us-east-2` の Bedrock Mantle 経由の Codex `openai.gpt-5.5`（Copilot CLI の独自モデルモードもこれを使う）です。テーブルはブローカーの許可リストと Claude クライアントのエイリアスをピン留めします。出荷されるユーザー設定はプロバイダ中立のままです。

環境アクセス、ロールの信頼、モデルの権限、または必須のライブ基盤が欠けていると、レディネスは失敗します。ワークフローは新しい環境やロールを作成しません。

Claude Code、Copilot CLI、opencode の npm バージョンはワークフローでピン留めされています。レジストリと互換性を確認した後に、それらのピンを意図的に更新してください。CLI/認証のプリフライトは、不在の基盤が合格したライブテストに見せかけるのを許すのではなく、声高に失敗します。

#### 認証情報の分離とアップロードされる証跡

ライブモデルはリポジトリの内容を受け取り、ツールを呼び出せるため、そのシェルとツール結果のトレースを、認証情報の信頼されないシンクとして扱います。AWS アクションは、後続のステップに AWS 認証情報をエクスポートすることなく、マスクされたステップ出力を返します。信頼された起動ヘルパーは、それらの値を自分のステップ env でのみ受け取り、JSON を stdin 経由で、切り離された環境スクラブ済みのブローカープロセスに送り、ライブエージェントが走る前に終了します。ブローカーは認証情報をメモリにのみ保存し、起動時に署名された STS `GetCallerIdentity` を行います。ブローカーから出るのは、その非秘密のアカウント、ARN、ループバックポートだけです。認証情報を返すルート、認証情報プロセス、認証情報ファイル、認証情報を持つエージェント環境はありません。

ループバックプロキシは、設定されたモデル ID と `POST /model/<id>/(invoke|invoke-with-response-stream|converse|converse-stream)`（任意で `/bedrock` の下）、加えて `model: openai.gpt-5.5` を持つ Codex Mantle の `POST /openai/v1/responses` だけを許します。クライアントの認証ヘッダーを除き、各上流リクエストに署名します。成功したストリームはバイト単位でそのまま転送されます。他のルートは禁止され、リダイレクトはたどられず、上流のエラーボディは、AWS のエラーが署名をエコーし得るため抑制されます。Mantle ルートでは、署名の前にリクエストから `reasoning.summary` を除きます。Mantle の `openai.gpt-5.5` は、モデルが推論し始めると、推論サマリーを求める応答で停滞し、Copilot CLI はリクエストごとにそれを求めます。Codex のようにそれを持たないリクエストは、送られたとおり転送されます。ブローカーは、リクエストごとに 1 行を `tests/logs/credential-broker.log` に追記します（メソッド、パス、許可されたモデル、ステータス、所要時間、最後のバイトの時刻、バイト数、応答が終わったかどうか）。ヘッダーやボディは決して含めません。そのため停滞したストリームが、アップロードされたログに現れます。ヘッダーの後 2 分間、上流がデータを送らない応答は終了されます（その行の `end=idle-timeout`）。SSE の `:` キープアライブコメントはデータではありません。Mantle はそれを 15 秒ごとに、停滞の間も送ります。

Claude は、文書化された `ANTHROPIC_BEDROCK_BASE_URL` と `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` を使います。その t19 プリフライトはブローカーの起動時識別情報を検査し、続いて実際の SDK ターンを行います。Codex 0.151.0 は `/openai/v1` で終わるプロバイダ `base_url` を使い、ループバックエンドポイントに対して検証します。サービス固有の Bedrock Runtime オーバーライドだけでは、Codex の Mantle トラフィックをリダイレクト **しません**。すべてのスクラッチ Codex ホームは、compose、workspace、memory のジャーニーを含め、共有の Bedrock 構成レンダラーを使います。分離 CI ランタイムの外では、`AIDLC_CODEX_AWS_PROFILE` を未設定または空のままにすると、`config.toml` からプロファイルが省かれ、AWS SDK の既定の認証情報チェーンが、EC2 インスタンスロールを含めて認証情報を解決できるようになります。既存の名前付きプロファイルを使い続けるには、`AIDLC_CODEX_AWS_PROFILE=codex`（またはその実際の名前）を設定します。`codex` という名前のプロファイルは、もはや暗黙に選択されません。`AIDLC_CODEX_AWS_REGION` は引き続き既定で `us-east-2` です。分離 CI ランタイムは、Linux、macOS、Windows でそのダミーの `broker` キーを選ぶため、明示的に `AIDLC_CODEX_AWS_PROFILE=codex` を設定します。Opencode のプロファイルもダミーキーだけを含みます。Opencode は、その前提検査がそのプロファイルを認識するよう `AWS_PROFILE=broker` を選びます。その文書化されたプロバイダ `endpoint` オーバーライドが、AI SDK のリクエストをプロキシ経由でルーティングします。Codex のシェルポリシーは、provider/broker/API/GitHub/Actions の変数を除き、ランナーは任意のライブテストを起動する前に CI コントロールプレーンの認証情報を取り除きます。

ホスト型の Linux/macOS ライブエージェントは、プライベートなチェックアウトコピーの中で、明示的な `sudo ... env -i` 環境と root 所有の読み取り可能/実行可能なツールを使い、別の非特権 `aidlc-live` ユーザーとして走ります。それらは、ランチャープロセスの procfs 環境、ランナーのホーム、元のチェックアウト、Actions のコマンドファイルを読めません。

Linux Codex の準備は、ディストリビューションの `bubblewrap` をインストールし、その AppArmor のアタッチメントを保ちつつ、ライブ PATH に `/usr/bin/bwrap` への root 所有のシンボリックリンクを公開します。Ubuntu が非特権のユーザー名前空間を制限するとき、準備は既存の `/etc/apparmor.d/bwrap-userns-restrict` プロファイルを読み込むか、`apparmor-utils` でディストリビューションの追加プロファイルを `apparmor-profiles` からインストールします。グローバルな制限は変わらないままでなければなりません。これは公式の [Codex sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites) に従います。Codex は `workspace-write` を保ちます。AWS セットアップの前に、スクラブされたライブユーザーは、bubblewrap のユーザー名前空間を作成し、Bun を実行し、そのプライベートな一時ディレクトリに書き込めなければなりません。その名前空間の中で root であっても、ランナーのホーム、元のチェックアウト、Actions の環境ファイル、ランチャーの環境、一時的なランナー所有/root 所有のセンチネルファイルを読んではなりません。この証明はブローカーの起動後に繰り返されます。失敗はライブ実行をブロックします。

Windows は、標準の Users のみのアカウントと、`C:\aidlc-live` の下の ACL 分離された work/home/tools を作成します。Task Scheduler が、ランナーセッションのデスクトップ ACL を避けつつ、その識別情報のもとで制限付きバッチログオンで各本体を起動します。準備は、既存のプリンシパルを保ちつつ `SeBatchLogonRight` だけを付与し、その後実際のバッチログオンタスクを検証します。Git と smoke のプローブを含む準備タスクは、既定で 30 分です。認証情報付きのテストタスクは、ワークフローの 70 分のライブテストステップ内で 64 分の上限を保ちます。5 分のネイティブ起動バックストップ内に開始されなかったタスクは、スケジューラのステータスと最後の 20 の運用イベントとともに失敗します。明示的な安全な環境と UTF-8 の識別情報/cwd/出力のログは残り、タスクは完了後に登録解除されます。セカンダリログオンの `Start-Process` は、タスク登録自体が失敗した場合にのみ報告されるフォールバックです。バッチセッションは session 0 を使うことがあります。この証明は、正しいユーザー識別情報と、ランチャーモジュール/`PROCESS_VM_READ`、ランナーディレクトリ、プライベートな認証情報状態に対するアクセス拒否を要求します。ブローカーはランナーの識別情報のもとにとどまります。非秘密のルートとモデルピンだけが、ライブユーザーの環境に渡ります。失敗した分離の証明は実行をブロックします。

Windows Codex は、その 2 つのネイティブサンドボックス識別情報もプロビジョニングし、新鮮なテストホームを使って両方を検証します。非ゼロで終了したプロビジョニング実行は、同じ新鮮なホストでもう一度走り、そのログは最初の実行のものの隣に保たれます。タイムアウトや未完了の出力ドレインは、やはりただちに fail-closed します。レディネスコマンドは、実際のサンドボックスのもとで PowerShell と Bun を通して走ります。シェルはプロジェクトで開始しなければならず、Bun はそのパスを正規化しなければならず、ワークスペースの外への認証情報の読み書きは拒否されたままでなければなりません。サンドボックス識別情報は、フィクスチャの上の 3 つのプライベートコンテナに対して、その内容を列挙したりファイルを読んだりする継承された権限なしに、ディレクトリのメタデータとトラバーサルアクセスを受け取ります。レディネスは、stderr の固定フェーズ診断とは独立に、ネイティブイニシャライザの終了ステータスを検査します。欠けた、または非ゼロのステータスは実行をブロックします。ネイティブランチャーは、ホスト型 Windows のコールドスタートのばらつきに対応するため、新鮮なホームの初期化に 5 分を許し、その期限が切れると実行を拒否します。各ネイティブ CLI プロセスは、再開される前にそれ自身の Windows ジョブに割り当てられます。CLI が終了した後、ランチャーは stdout と stderr をドレインする前にそのジョブの子孫を退役させるため、継承されたパイプハンドルが呼び出しを開いたまま保つことはできません。POSIX の収集は、管理者によるコピーの前に、専用アカウントのプロセスを止めます。macOS ではまず、サービスの再起動を止めるため、そのアカウントの launchd の user/GUI ドメインを退役させます。ゾンビのエントリは実行できません。他の残っているプロセス、またはインベントリの失敗は、収集を拒否します。失敗には、残っている PID/状態の行が含まれます。影響を受けるのは、このジョブが新しく作成したアカウントだけです。

すべてのマージキュー実行は、同じ準備と証明のスクリプトに加えて、サンドボックス識別情報のもとで `--smoke --filter '^t01'` を、プロバイダ認証情報なしに、3 つすべての OS で `test_live_isolation` を実行します。認証情報なしの Windows リリース契約の unit は、別に実行可能なままです。ホスト型 Windows のライブモデルカバレッジは本物で、オプトインのスタブや同一ユーザーの例外ではありません。

エージェントは、ジョブのタイムアウトまで、許可リストに載ったプロキシを通して消費し続けられます。IAM のモデル権限、クオータ、ランナーアクセスを制約してください。この境界はホストのカーネルと管理者を信頼します。OS の特権昇格はスコープ外です。Cursor は、その CLI がエージェントのツールシェルに API キーを公開するため、除外されたままです。Kiro は、ワークフロー注入の API キーなしに、専用の CI 識別情報を持つ Windows ホストの既存のサインインだけを使います。ランナー所有の収集は、アップロードの前に無害化のために完了したログをコピーします。サンドボックスが作成したコードを実行することはありません。

Windows のサンドボックスプロセスが止まった後、テストログと起動ログは独立に収集されます。失敗したテストツリーのコピーでも、検証済みの起動 stdout/stderr を `tests/logs/windows-launch-<uuid>/` の下に保持します。完全で検証済みのツリーだけが公開されます。どちらかのコピーが失敗すると、収集は失敗のままです。`tests/logs/windows-collection-<uuid>.json` は、ソースごとの完了と、失敗時には操作、安全な相対パス、例外コードを記録します。例外メッセージ、絶対パス、機密のパス構成要素は省きます。アップロードされた収集レポートやフォールバックログは、テストが合格したことを確立しません。

Windows のライブレグは、前進を止めたフックの証跡も保ちます。`scripts/ci-live-sandbox.ts` は、すべての Windows ライブファミリーに `AIDLC_TEST_HOOK_TRACE=1` を設定し、ランナーは `AIDLC_HOOK_TRACE_DIR` を各ファイル試行の `e2e-artifacts/<file>/attempt-<n>/hook-trace/` に結び付けます。そのため、その試行のすべてのフックプロセスが、そこに自分のフェーズを書きます（[Hook phase trace](06-hooks-and-tools.md#hook-phase-trace) を参照）。ライブ実行のスケジュールされたタスクが走る間、`.github/scripts/prepare-live-runtime.ps1` のランナー側の待機ループが、1 分に一度プロセステーブルを検査します。コマンドラインに `engine hook ` または `engine adapter ` を持つ、分離アカウント所有のプロセスが 10 分走ったとき、停滞したプロセスのツリー（その分離アカウントの親とすべての子）とそのスレッド状態を、プロセスごとに一度、`tests/logs/windows-launch-<uuid>/hook-stalls-run-<id>/` に 1 つの `hook-stall-<time>.json` として書きます。プロセスのメタデータだけを読み、所有権は停滞したプロセスとその親についてのみ検査します。すべての照会は、60 秒のスナップショット予算の残り（最大 15 秒）で上限打ちされます。スキップされた、失敗した、またはタイムアウトした照会は、スナップショットを `truncated` とマークします。所有者を検査できなかった停滞プロセスは、別のアカウントに属する可能性があるため、その id、名前、開始時刻だけ（コマンドラインなし、子なし）で `ownerUnknown` の下に列挙されます。それが run を失敗させることは決してありません。フックトレースの `.ndjson` ファイルは、後述のトレース保持ルールに従います。Linux と macOS のレグは、どちらもオンにしません。

すべてのフルスイートの `tests/logs/` アップロードは、まず `scripts/ci-sanitize-logs.ts` を実行し、無害化に失敗するとブロックされます。フルスイートと共有される決定的ジョブは、ツール呼び出し、完了の境界、タイムアウトの挙動が診断のために利用可能なままになるよう、対象となるドライバの NDJSON、`sdk-drive*`、`tui-drive*`、`e2e-artifacts/**/traces`、`leg-evidence/` を既定で保持します。リポジトリ変数 `AIDLC_NIGHTLY_UPLOAD_TRACES=0` は、トレースの保持をオプトアウトします。スタンドアロンのサニタイザは、その `AIDLC_NIGHTLY_UPLOAD_TRACES` 環境変数が `1` でない限り、これらのトレースをなお削除します。不正な UTF-8、UTF-16、NUL を含むファイル、その他の非テキストファイルは常に削除され、その相対パスと理由が `sanitizer-report.json` に記録されます。バイナリ/スクリーンショットの許可リストはありません。残った UTF-8 テキストは、AWS 認証情報、ベンダーキー、ベアラトークン、Anthropic キーについて編集で伏せられます。リンクは、ターゲットをたどることなく除去されます。編集は多層防御のままで、エンコードされた秘密に対する証明ではありません。生のテキストトレースを保持すると、その残存リスクが増します。

### すべてのライブレグを読む: トレース監査

合格するレグでも、人が遭遇する摩擦を示すことがあり、夜間はそのトレースを保ちます。`scripts/trace-audit.ts` は、メンテナーのために、彼ら自身のマシンで、分けて保たれる 2 つの層でそれらを読みます。

- `bun scripts/trace-audit.ts extract --run <full-suite run id>` は、メンテナー自身の `gh` で run の `full-suite-live-*` アーティファクトをダウンロードします（または `--dir <folder>` が、ダウンロードされた run、`tests/logs` フォルダ、ローカルのセッションフォルダ、すなわちスクラッチプロジェクト、Claude Code の config フォルダ、Codex のホームを読みます）。記録されたイベントとフィールドを数えて照合するだけで、読むフォルダの外に `table.txt` と `table.json`（チェックの所見、ガードの拒否、エンジンのエラー、人に再び手渡された質問、承認後に書かれたステージファイル、10 分以上の沈黙、再試行、エージェントのツールエラーごとに 1 行で、それぞれ run、ハーネス、OS、test、stage、証跡ファイルと行を名指す）と、レグごとに 1 つの `legs/<leg>/story.md`（人が何を入力し選んだか、何を尋ねられたか、エージェントが何を実行し述べたかを、時間順で、サイズ予算に切って、人のために記録された各決定をその人の応答を傍らに保って、読者が各応答をその記録に照らして判断できるように）を書きます。
- `bun scripts/trace-audit.ts judge <out>`（`scripts/trace-audit-judge.ts`、instructions は `scripts/trace-audit-judge.md`）は、各テストのレグを、メンテナー自身の `claude` に print モードで手渡します。読み取り（`Read`、`Grep`、`Glob`）のみ、判断対象のレグ自身のフォルダ内のみ可能で、セッションフォルダが置かれるホームには決してアクセスせず、既知のリスト（`--known`）と、開いている issue とプルリクエスト（`--issues`）を渡します。モデルは摩擦項目を JSON で返します。ツールは、各項目がいくつのレグで遭遇されたかを数え、`JUDGE.md` を書きます。`--dry-run` は各グループの入力を書き、モデルを呼びません。`--max-usd` と `--budget-kb` は各呼び出しを制限します。

抽出器は、run が保ったものだけを読みます。SDK ドライブのトレースは各ツール応答の最初の 240 文字を保ち、各レグの `leg-evidence/` フォルダは、それが駆動したすべてのプロジェクトの監査と、エージェントが人に伝えたことを保ちます。story はそれらをレグの他のイベントの中に時間で配置します。story は、レグがどちらも保たなかったとき、その先頭でその旨を述べます。

## Kiro prompt-hook のトランスポートコントロール

Kiro の agent-v1 prompt フックは、シェルツールの出力予算とは独立に、既定の `max_output_size` が 10 KiB です。アダプターは、non-steering のディレクティブを注入する前に、その説明テキストを含む完全な UTF-8 のディスパッチ前パケットを数えます。過大なパケットとすべての `load-steering` ディレクティブは、エンジンの完全な JSON が実際のツール呼び出しを通して返るよう、既存の正確な引数転送のラッチを使います。`--single` はフックのディスパッチ前を完全にスキップし、その最初の発行をそのツール呼び出しに委ねます。エンジンが正確に読む行（`readNextLine`）だけがそもそもディスパッチ前に処理されます。エージェントに手渡すものは手を触れずにエージェントに渡るため、このシームが、誰かが読む前に人の言葉に作用することは決してありません。

`t147-kiro-hook-adapter.test.ts` は、マルチバイトの内容、ネイティブシェルのエイリアス、保持されたターミナルガード、実際のマルチパートのエンジン往復で、10 KiB の境界を検査します。配信されたすべてのルールバイトを再構築し、各不透明な継続トークンを変えずに渡します。トークンが単独で残っても、完全なルール配信の証明にはなりません。それを切り詰められたルールの前に動かすことは、正しい修復ではありません。

これらの決定的なコントロールは、アダプターとエンジンの stdout をテストします。ネイティブ Kiro リリースのツールチャネルの上限をキャリブレーションするものではありません。そのトランスポート予算を変える前に、サポートされる各ネイティブプラットフォームで、上限近くの完全なペイロードを確認してください。フックの設定された `max_output_size` を増やすことも、そのキャリブレーションを必要とします。それはこのアダプターの保守的な注入ポリシーを変えません。

## Unit シャーディング

`--unit --shard N/M` は、発見されたすべての unit ファイルを、所要時間を均衡させた `M` 個のシャードのちょうど 1 つに割り当てます。割り当ては決定的で、各ファイルの OS ごとの所要時間を記録する `tests/unit-shard-weights.json` を使います。現在のプラットフォームの測定値が優先されます。そこで測定されていないファイルは、その最も遅い OS のフォールバックを使います。未掲載のファイルは 1 秒の既定の重みを受け取るため、新しいテストはコマンドを変えずに最も負荷の少ないシャードに加わります。`M` が割り当て可能なグループの数を超えると、ランナーは終了コード 2 で終わります。そのため、有効なシャードコマンドが 0 ファイルを実行した後に成功を報告することはできません。

シャードは、重みファイルが `parallel` の下で上限設定するプラットフォーム（macOS。そのマージキュー unit シャードがキューの進む速さを決める）を除いて、ファイルを 1 つずつ実行します。そこではシャードは、その数まで、決して `-P` を超えずに、一度に複数のファイルを開始します。それ以上は役立ちません。最も重い単一のファイルが下限を決めるためです。並行して、アフィニティグループが先に、単独で、その順序で走ります。t238 は t249 が読むバイナリをビルドし、そのリリースパッケージング（`scripts/package-release.ts`）が共有の `dist/` と `dist-release/` をその場で再生成するため、その瞬間にそれらを読むファイルはそれらが欠けていると気づくでしょう。他のファイルは、そのプラットフォームの重みで最長優先に、それぞれ自分の一時フォルダを持つ自分のプロセスで開始します。`AIDLC_TEST_UNIT_PARALLEL=<n>` は、macOS 以外での試験のために、どのプラットフォームでも 1 回の実行の上限を設定します。CI では何も設定しません。`--shard` のない実行は直列のままです。

別々のシャードは、別々のチェックアウトまたは CI ジョブで実行してください。`AIDLC_TEST_PACKAGE_READY=1` のないランナーは、同じツリーの他の実行の読み手のもとで、最初のファイルの前に `dist/` を再生成します。

アフィニティリストは、ファイルをまたぐ前提を明示的に保ちます。ネイティブバイナリビルダーのテストは現在、同じシャードで Copilot のコンパイル済みアダプターのカバレッジより前に走ります。すべてのネイティブ build/install のアサーションが通った後、t238 はその検証済みの実行ファイルと隣接する `runtime/` を、ランナー所有の
`AIDLC_TEST_COMPILED_DIR` にコピーします。そのプライベートな build/install のフィクスチャは、テストの後もやはり削除されます。公開されたコピーは、ランナーのクリーンアップまで（または verbose ログとともに保持されて）存続します。各ランナーは新しい引き継ぎディレクトリを割り当てるため、共有の `build/binaries` の出力が上書きされたり、前の実行から借用されたりすることはありません。シャード化された unit 実行は、t249 がこの引き継ぎを解決することを要求します。欠けたアーティファクトは、明示的な実行ファイルや古いリポジトリのビルドが存在するときでも、コンパイル済みのケースを静かにスキップするのではなく、失敗します。直接の、シャード化されていない t249 実行は、やはり `AIDLC_TEST_COMPILED_EXECUTABLE` またはローカルのネイティブビルド結果にオプトインできます。smoke ランナーの契約は、10 シャードと 16 シャードの両方の割り当てが、空でなく、互いに素で、完全な unit インベントリをカバーし、producer/consumer の順序を保ち、producer がフィルタで除かれたときコンパイル済みカバレッジを失敗させることを検証します。

2 つ以上のワーカーがあると、integration ティアはその並列ファイルを `tests/integration-weights.json`（サマリー行名をキーとする）で最長優先に開始します。そのため長いファイルが最後に始まってティアの実時間を決めることはありません。重みのないファイルと同点のものは名前順を保ちます。読める重みファイルがなければ、ファイルは名前順で始まります。serial ファイルと smoke ティアは影響を受けません。2 つ以上のワーカーを持つ unit シャードは、上記のとおり unit の重みでそのファイルを順序付けます。

`--integration --shard N/M` は、同じ integration の重みを使って、フィルタされた integration インベントリを均衡させます。フィルタリングは分割の前に起こります。除外はその後に適用されるため、ファイルを除外しても他のファイルがシャード間で移動することはありません。2 つの guard ジョブは、同じフィルタでこのモードを使います。ホスト型ジョブの数とワーカー制限は変わりません。

重みはファイルを均衡させて順序付けるだけで、ファイルを選択したり、スキップしたり、失敗させたりすることは決してありません。`scripts/ci-test-weights.ts refresh <dir>` は、`gh run download <run-id> -p 'ci-deterministic-*' -D <dir>` でダウンロードした決定的 CI 証跡から、両方の重みファイルを書き直します（複数の green なマージグループ実行を使う。各ファイルは OS ごとに中央値を取る。最も遅い中央値はそのフォールバックも更新する）。refresh に存在しないプラットフォームの測定値は保持されます。初期のプラットフォーム重みは、成功したマージグループ実行 `39029896320` から収集されました。スケジューリングの改善は、それらの学習測定値だけでなく、後続の実行に照らして確認しなければなりません。各 unit と integration のジョブの後、参考扱いの "Report outdated test weights" ステップが `scripts/ci-test-weights.ts report` を実行します。1 分を超え、かつその重みの 1.5 倍を超えて走ったファイルは、警告の注釈と、refresh コマンドを名指すジョブサマリーの行を得ます。このステップは常に成功するため、古い重みは CI を遅くしますが、ジョブを失敗させたり PR をマージキューから落としたりすることは決してありません。`t-ci-test-weights.test.ts` は、refresh、report、チェックインされた重みファイルをカバーします。

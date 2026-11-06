# コントリビューション

## 概要

この実装へのコントリビューションを歓迎します。このガイドは、前提条件、開発ワークフロー、テスト、そして変更を提出する方法を扱います。

> **パス規約。** 以下の `<record>/` = 作られたインテントの記録ディレクトリ
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`。インテント単位の状態、監査シャード、
> ナレッジ、アーティファクトが置かれる場所です。

## 前提条件

- **Claude Code** -- ネイティブインストール（推奨。自動更新）: macOS/Linux/WSL は `curl -fsSL https://claude.ai/install.sh | bash`、Windows PowerShell は `irm https://claude.ai/install.ps1 | iex`。または `brew install --cask claude-code`。（[Claude Code docs](https://code.claude.com/docs/en/quickstart) を参照）
- **bun 1.4.4 以降** -- ビルド、パッケージング、テスト、オーサリングされた TypeScript ソースの直接実行、ローカル生成の `dist/<harness>/` プロジェクションの利用に必要です。Bun 1.4.4 には CVE-2026-111497 向けの Brotli デコーダー修正が含まれます。ネイティブリリースランタイムは、インストール済みの `aidlc` コマンドを使います。`curl -fsSL https://bun.sh/install | bash` でインストールします。Windows では `powershell -c "irm bun.sh/install.ps1 | iex"` を使います。
- **timeout**（GNU coreutils）-- テストスイートが LLM テストのタイムアウト（L2/L3）に必要とします。Linux にはプリインストールされています。macOS: `brew install coreutils` の後、gnubin を PATH に追加します: `export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"`（`~/.zshenv` または `~/.zshrc` に）。
- **Bash** -- POSIX 互換ラッパー（`tests/run-tests.sh`）向けに任意です。主要なテストランナーは `bun tests/run-tests.ts` です。実行時、配布可能な hook はどれも Bash を必要としません。
- **Bedrock アクセス** -- ライブの統合テストと e2e テスト（L2/L3）の実行に必要です。L1 プロトコルテストには不要です。

クローン後、パッケージャー、型チェッカー、テストが使う、ピン留めされた開発依存を
インストールします。

```bash
bun install --frozen-lockfile
```

## リポジトリの構造

```
core/                # Hand-authored, harness-neutral source (tools, stages, agents, rules, knowledge, hooks)
harness/<name>/      # Per-harness authored surfaces; claude/, kiro/, kiro-ide/, codex/, opencode/, copilot/
scripts/package.ts   # The build: materializes ignored local projections (`--check` builds twice and compares)
scripts/build-binaries.ts # Release-only compiled CLI artifacts in ignored build/binaries/ after package --check
dist/<harness>/      # GENERATED + ignored: dist/claude/, dist/kiro/, dist/kiro-ide/, dist/codex/, dist/opencode/, dist/copilot/ — never hand-edit or commit
tests/               # All-TypeScript test suite (t*.test.ts, run via bun)
docs/                # Documentation
  guide/             # User guide (how to use AI-DLC)
  harness-engineering/  # Harness engineer guide (configure AI-DLC without code)
  reference/         # Developer reference (how it works internally)
```

完全なアーキテクチャについては、[reference/01-architecture.md](01-architecture.md) を参照してください。

## 開発ワークフロー

1. **フォークとブランチ** を `main`（統合ブランチであり PR のターゲット）から作り、その後 `bun install --frozen-lockfile` を実行します
2. **アーキテクチャを読む** -- [reference/01-architecture.md](01-architecture.md) が実行モデル、エージェント委譲、hook システムを説明します
3. **エントリポイントを理解する** -- 決定的なエンジン `core/tools/aidlc-orchestrate.ts`（サブコマンドはちょうど 6 つ: `next`、`continue`、`report`、`park`、`team-board`、`wait`。`continue` は内部ステアリングのトランスポート、`team-board` は読み取り専用の Team Construction クエリ、`wait` はディスパッチされた作業への上限付き読み取り専用の待機）がルーティングを所有します。conductor `harness/claude/skills/aidlc/SKILL.md` は、ディレクティブに従って動く薄い転送ループです。規範的なエンジン / ディレクティブ / conductor / swarm のコントラクトについては [The Skill System](17-skill-system.md) を参照してください
4. **変更を加える** -- `core/` のハーネス中立なソース（ツール、ステージ、エージェント、hook、ルール、ナレッジ）か、`harness/<name>/` のハーネス面（オーケストレーター skill、設定）を編集します。その後 `bun scripts/package.ts` を実行して、無視されるローカルの `dist/` と `dist-release/` ルートをマテリアライズします。どちらのルートも手で編集もコミットもしないでください。`package.ts --check` は、それらのディスク上ツリーを無視し、独立した一時ルートで完全なプロジェクションセットを 2 回ビルドし、結果をバイト単位で比較します。
5. **テスト** -- 提出前に `bun tests/run-tests.ts` を実行します
6. **提出** -- `main` に対して PR を開きます

リリースバイナリアーティファクトは `dist/` の一部ではありません。パッケージャーも生成しません。
`bun scripts/package.ts --check` がクリーンになった後、ネイティブアーティファクトには
`bun scripts/build-binaries.ts` を実行し、リリースマトリクスには `--all-targets` を
足します。スクリプトは、各実行ファイルを `build/binaries/<target>/` の下に書き、そのターゲットの
`runtime/<harness>/` ディレクトリの下に完全な生成ディストリビューションをステージングし、
`build/binaries/build-results-<target>.json` を書きます。ビルドホストで実行可能なターゲットは、
`PATH` 上に `bun` 実行ファイルがなくても、センサー、グラフコンパイル、検証、生成面の検査、
プラグイン選択／合成、オーケストレーション、通常の Bolt と自律 swarm の合成、パッケージ化
ランタイムの不変性、hook、statusline、アダプター、明示的なプロジェクトルーティング、doctor JSON、
init のドライラン、バージョン／プラグイン一覧、Unix 補完、パッケージ検証を実行します。
クロスアーティファクトは検査ゲートを受け、明示的に `UNVERIFIED` とラベル付けされます。
ホストで実行されたアーティファクトは `VERIFIED` とラベル付けされます。
ステージングされた `runtime/<harness>/` ツリーは読み取り専用のフォールバックです。変更を加える
コマンドは、インストール済みのプロジェクトハーネスを対象にしなければなりません。失敗した
ゲートはいずれもビルドを失敗させます。

ターゲットバイナリがそろった後、`bun scripts/package-release.ts` が、ローカルの
プロジェクションを再生成して検証し、`dist/` を帯域外の手動コピー用
`aidlc-copy-runtime-X.Y.Z.tar.gz` とその `.sha256` サイドカーにパッケージし、
`dist-release/` をマニフェスト記載の `aidlc-runtime-X.Y.Z.tar.gz` にパッケージし、
`version.json`、`checksums.txt`、`install.sh`、`install.ps1` を出します。ターゲットごとの
`runtime/` ディレクトリはスモークゲートのステージングです。リリースデータアーカイブは、
それらのサイドカーからコピーするのではなく、新しく生成したプロジェクションから再ビルドされます。
`--require-release-matrix` は、7 つすべてのターゲットと、各バイナリの一致する検証記録を
要求します。生成されたフラットなディレクトリは、インストーラーと `release packaging tooling`
が消費するコントラクトです。

リリースワークフローは意図的に候補を保存します。検証とインストーラー lint が最初に走り、
ターゲットネイティブのジョブがバイナリと証拠を生成し、`package-release.ts` が一度走って
`release-candidate` を作り、ステージングジョブが署名せずにチェックサムを取ってアップロードし、
Unix/Windows のライフサイクルジョブがそのバイトを消費します。`publish` が候補を再検証して
証明し、エクスポートされたバンドルを足し、完全なインベントリを検証し、1 つの
`attested-release` アーティファクトをアップロードします。`release` がタグとチェックサムを
再チェックし、`GITHUB_TOKEN` でこのリポジトリに GitHub Release を作り、アップロードされた
アセットのインベントリを検証します。候補を再ビルド、再パッケージ、差し替えしないでください。

安定版リリースは、選ばれた公開済みプレビューのソースコミットを昇格させます。プレビュータグ、
安定版バージョン、リリースノート、そして任意でコントリビューターリストとともに `main` で
`promote-release.yml` を実行するか、入力なしで実行して利用できるプレビューを一覧します。
準備されたタグには、バージョンメタデータとピン留めされた公開制御を持つ子コミットが 1 つ
含まれます。`release.yml` がその関係を検証し、安定版アーティファクトをビルドします。これは
CI や Full Suite を繰り返さずに、パッケージングとネイティブ／インストーラー／ライフサイクル／
アップグレードの検査を実行します。プレビューの結果と失敗はプレビューのリリースページに残り、
昇格記録はその警告行を保ち、安定版ページはそのプレビューにリンクします。公開後、メタデータ
だけのブランチと PR リンクが、現在の `main` にバージョンを記録します。[the release steps](../../DEVELOPERS.md#4-promote-a-preview-to-production)
を参照してください。
隔離された `.github/workflows/preview-release.yml` ワークフローは、`main` からのプレビュー
ビルドをスケジュールまたは手動でディスパッチし、コントラクト検査とリリースアセット検証を
通し、ネイティブの義務と上限付きのライブスイート（決定的な層は PR/マージ CI に残る）を
実行し、`AIDLC_BUILD_VERSION` をスタンプし、"latest" には決してならない注釈付きタグの
プレリリースを公開します。スケジュール実行と手動実行は `release-preview` のワークフロー
並行性を共有します。後の各実行はリリースを読み直し、最新の公開済みプレビューが同じソース
コミット、またはそれを含むより新しいコミットをすでに使っているとき、公開をスキップします。
その検査と Full Suite はやはり走ります。同じ UTC 日付で `main` がさらに進むと、プランナーは
次の空いている `.N` カウンターを割り当てます。ドラフトと孤立したタグはその id を予約するので、
リトライもそれらを越えて進みます。失敗した Full Suite はプレビュー公開をブロックしません。
プレビューノートは Full Suite の失敗レポートで終わります。別の Full Suite 実行は、Preview
Release ワークフローを失敗させずに、その失敗ステータスを保ちます。

安定版とプレビューの公開は、それぞれ `release` 環境と `preview` 環境を使い、独立して直列化
します。同日カウンター割り当てを含む完全な信頼設計は、[Supply-Chain Security](19-supply-chain-security.md)
です。

## Markdown 構造

ブロックの可視性、コンテナ、リンク参照定義、クレーム分割には、`core/tools/aidlc-markdown.ts`
の `markdownBlocks` を使ってください。これは組み込みの `Bun.markdown` レンダラーに支えられて
います。その `visibleMarkdownLines` プロジェクションは、消費側固有の可視性オプションを保ちます。
Markdown 依存、手製のブロックスキャナー、参照定義の文法を足さないでください。`Bun.markdown.render`
のレビュー権限レンダリングは、意図的に別のパスです。そのセキュリティ境界をブロックアダプターに
畳み込まないでください。アダプターがレンダラーからソース行を回復する仕組みについては
[Markdown structure](01-architecture.md#markdown-structure) を参照してください。

## 新しいツールコードの置き場所

`core/tools/aidlc-lib.ts` は新しいコードを受け付けません。新しい関数、型、定数は、その領域の
`core/tools/` 下のモジュール（既存の `aidlc-<area>.ts`、または新しいもの）に入れます。
`aidlc-lib.ts` には決して入れません。コードは一度に 1 領域ずつ、バイト単位でそこから移され、
1 行の `export ... from` を通じてそこからインポートできるままなので、`aidlc-lib.ts` を
インポートするものは何も変わりません。そこから分割されたモジュールは、`aidlc-lib.ts` を
インポートすることはありません。`tests/unit/t-aidlc-lib-only-shrinks.test.ts` は、`aidlc-lib.ts`
が宣言する名前が `tests/fixtures/aidlc-lib-declarations.txt` にないとき、そしてそれが
インポートするモジュールが逆にそれをインポートするとき（このルールの前にそうしていたものは
テストに列挙されています）に失敗します。移動は、そのリストから名前を削除し、`biome.json` の
ファイルサイズ上限を下げます。どちらも決して上げません。

## テスト

スイートは全面的に TypeScript（`t*.test.ts`、`bun` で実行）で、4 つのレベル — `smoke`、`unit`、`integration`、`e2e` — にわたり、3 層のピラミッド（smoke + unit = L1 Protocol、integration = L2 Stage、e2e = L3 Acceptance）に対応します。ピン留めされた開発依存のインストール後、L1 は外部サービスなしでローカルに走ります。ライブの統合テストと e2e のファイルは `claude` CLI ツール（と Bedrock の認証情報）を必要とし、それがないときはきれいにスキップします。

**クイックリファレンス:**

```bash
# L1 Protocol -- runs in seconds, no dependencies
bun tests/run-tests.ts

# L2 Stage -- CI pipeline (requires claude CLI tool)
bun tests/run-tests.ts --ci

# L3 Acceptance -- explicit local full acceptance (requires claude CLI tool)
bun tests/run-tests.ts --release

# POSIX compatibility wrapper
bash tests/run-tests.sh --ci

# Individual levels
bash tests/run-tests.sh --smoke        # File structure validation
bash tests/run-tests.sh --unit         # Hook behavior, stage content
bash tests/run-tests.sh --integration  # Cross-component and stage/CLI tests
bash tests/run-tests.sh --e2e          # Workflow, worktree, and terminal journeys
```

完全なテスト戦略、スタブ、新しいテストの足し方については、[reference/09-testing.md](09-testing.md) を参照してください。

## ディスパッチャールートの変更

`core/tools/aidlc.ts` は、公開、隠し、ホスト専用のコマンドルートのレジストリです。新しい
ルートは、振る舞いを偶然に継承するのではなく、すべてのポリシー次元を宣言しなければなりません。

1. `projectRequirement`、`outputModes`、`visibility`、`networkPolicy`、`mutationScope` を設定します。
2. `pinPolicy` を意図的に選びます: マシンのライフサイクル／管理には `active`、アクティブ
   バイナリの診断と修復には `inspect`、プロジェクトエンジンの振る舞いには `pinned`。
3. ルートを既存のツールに対応付けるか、`TOOLS` にツールを足します。hook、statusline、
   アダプター、低レベルのデリゲートは、公開エイリアスではなくルート専用のエントリを使います。
4. ルートとポリシーのアサーションを `tests/unit/t230-dispatcher-routes.test.ts` に足します。
   該当するときはグローバルフラグの順序とコンパイル／dev のパリティを含めます。
5. オーサリングされた散文がコマンドを呼び出すなら、`{{INVOKE}}` または `{{TOOL_PREFIX}}` を
   使って、コピーとネイティブプロジェクションが別物のまま保たれるようにします。両方のローカル
   チャネルを再生成し、パッケージの決定性ガードを実行します。
6. `mutationScope` と `networkPolicy` を正直に宣言します。これらは、Copilot が Allow プロンプト
   なしでコマンドを実行するかどうかも決めます。Copilot アダプターは VS Code では `allow` と
   答え、Windows ターミナル外の Copilot CLI では、`mutationScope` が `none` か `project` で
   `networkPolicy` が `forbidden` の `engine` または `public` ルートに対して、すべてのガードが
   通った後、skill が許す AI-DLC の `.aidlc/bin/aidlc-engine` ランチャーにコマンドを送ります。
   hook、アダプター、statusline のルートは決して該当しません。マシンを変える、またはネットワーク
   に到達するルートは、人の承認を保ちます。人の作業や git 履歴を削除、上書き、マージする動詞
   （たとえば `worktree discard`、`unit land`）、人が見るステージ、ゲート、レビューを変える動詞
   （たとえば `jump execute`。`recompose` は、最後のゲート以降に人が返信するまでだけ保ちます）、
   アクティブなインテントやスペースを切り替える動詞、人の同意を必要とする動詞（たとえば
   `bolt abort`）、リモートに到達する動詞、AI-DLC が同梱しないコードを実行する動詞（たとえば
   設定された抽出器を実行する `knowledge onboard`）は、`harness/copilot/hooks/aidlc-copilot-adapter.ts`
   の `keepsPrompt` にも足して、実行前に人がプロンプトを見るようにしなければなりません。
   AI-DLC に実行するコマンドやスクリプトを渡すオプションは、そこの `CALLER_RUNS` に属します。
   プロジェクト外のパスとして読める引数は、すでにプロンプトを保ちます。

## インストール機構の変更の追加

init、ライフサイクル、ピン留め、プラグイン管理におけるプロジェクトとマシンの変更は、
`core/tools/aidlc-transaction.ts` を使わなければなりません。ルート相対で重ならない操作から
`TransactionPlan` を組み立てます。コピー／ツリー操作には `expected` の宛先状態とソースハッシュを
含めます。意味的な検査は、トランザクションが成功して返った後ではなく、`validateCandidates` か
`validateCommitted` に置きます。コミット済みバリデーターの失敗はトランザクションの一部なので、
ロールバックします。

出荷前に障害注入のカバレッジを足します。適宜、ステージング、スナップショット、コミット、
コミット済み検証の前後で失敗させ、直前のすべてのバイトとモードが復元されること、ロックが
解放されること、不完全なロールバックが名前付きの復旧証拠を残すことをアサートします。
`t243-install-mechanism.test.ts` がエンジンのパターンです。`t224-plugin-selection.test.ts` と
`t242-plugin-state.test.ts` がプロジェクト変更の例です。

## ユーティリティハンドラーの追加

> **監査イベントを足す前に**、[State Machine](12-state-machine.md) を読んでください。この章は、分類のすべてのイベント、その発行者、そして「同一コミットのルール」を列挙します。コードと章の表を同じ PR で更新してください。さもないとドリフトテストが失敗します。

ユーティリティハンドラーは 2 つのカテゴリに分かれます。

### 決定的ハンドラー（推奨）
LLM の推論を必要としないハンドラー（テキストの表示、ファイルの読み／整形、前提条件の確認、ディレクトリの作成）向け:
1. `core/tools/aidlc-utility.ts` にサブコマンドを足します
2. 意味的なディスパッチャーの名詞／動詞を登録し、SKILL.md から `aidlc engine <noun> <verb>`（またはその公開ルート）経由で呼びます
3. タスク追跡は不要です。スクリプトは 1 秒未満で走ります
4. 監査ロギングは、`aidlc-audit.ts` の `appendAuditEntry` または `appendAuditEntries` 経由でスクリプト内で扱います（`**Event**:` の markdown ブロックを決して手書きしない）。複数設定の変更は、1 つの呼び出し側が保持するロックを使い、単一の状態書き込みの前に完全な監査バッチを追加します。
5. その動詞を `aidlc-utility` の usage 文字列に足します。生成された SKILL.md 領域を描画するなら、対応する `--check` ガードもこの章に文書化します。

コマンドが表示するテキストは、そのコマンド自身のコマンドラインを繰り返してはなりません。
VS Code のターミナルツールは、コマンドの出力を、それが実行したコマンドを繰り返す行まで
落とすので、"rerun `aidlc doctor`" と言った doctor の修正行は、チャットエージェントに空で
届きました。代わりに再実行を言葉で名指ししてください（"run doctor again"）。
`tests/harness/vscode-output-trim.ts` が、回帰テスト向けにこのルールをモデル化します。

`--help`、`--version`、`--status`、`--doctor` のハンドラーは参照実装です。`--doctor` は `--export`（任意の `--output <dir>` 付き）も受け付けます。これは新しい doctor パスを走らせ、その後、小さく編集された診断レポートを書きます。共有の `DoctorFinding` モデルとレポート組み立てのロジックは `core/tools/aidlc-doctor-bundle.ts` に存在するので、ライブレポートとエクスポートされたレポートは、1 つの判定の集合から引き出します。

インテント設定のハンドラーは、単一の変更パスを共有します。

| ディスパッチャールート | ユーティリティハンドラー | コントラクト |
|------------------|-----------------|----------|
| `aidlc engine config get <key>` | `config-get` | `depth`、`test-strategy`、`review`、`guard-policy`、`sensors`、`learnings`、`summary-confirmation`、`collaborators`、または 4 つの `guard.<fence>` キーのいずれかを読む。廃止されたキー `change-control` は `guard-policy` に解決される |
| `aidlc engine config list [--json]` | `config-list` | その順序で 13 個すべての設定を読む。Guard Policy、fence、ceremony の値は有効なソースを含む |
| `aidlc engine config set <key> <value> [--key value ...]` | `config-change --<key> <value> ...` | 与えられたすべての設定フラグを 1 つのトランザクションで適用する。すべてのキーがこのルートを使う |
| `aidlc engine scope change --scope <name> [--key value ...] [--message <id>] [--skip <slug,...>]` | `scope-change --scope <name> ...` | スコープを再計画し、同じ 12 個の設定のいずれかを同じトランザクションで適用する。要求されたスコープがすでに現在のものである場合も含む。完了済みの作業では、`--skip` が、切り替えがそこで再オープンするステージをプランから外す |

`config-change` は、12 個の設定フラグと `--message`（それ以前の `--person-words` 形式も含むが、
これらは何も証明しない）、`--intent`、`--space`、`--project-dir` だけを受け付け、少なくとも
1 つの設定を要求します。未知のフラグは名前で拒否し、いかなる変更の前にもすべての値を検証します。
共有のユーティリティアプライヤーは、候補の内容、`AuditEntryInput[]`、出力行を正規のキー順で
返します。書き込みはしません。両方の変更ハンドラーは、状態読み取り、適用、呼び出し側保持
ロックモードでの `appendAuditEntries`、単一の状態書き込みにわたって 1 つの `withAuditLock` を
保持します。Guard Policy 値が動くとき、いかなる書き込みの前にも `assertChangeControlLedgerWritable`
を呼びます。メモリ層の `Mode: strict` は、companion 設定とスコープ変更を含め、コマンド全体に
対して明示的な `--guard-policy relaxed` や `--guard-policy off` を拒否します。スコープ変更は、
スコープが所有する Guard Policy を自動で上げることがあります。より低い既定は、人がスコープ
変更を求めたときだけ新しいスコープに従います。さもないと現在の保存値が残り、出力が 1 行で
そう言います。メモリは有効値を制御し続けます。

状態とイベントのコントラクトを保ちます。`review adversarial` は空の `Review Override` を
保存します。明示的な Guard Policy と ceremony の値は、`settingTheirs` がその背後に人を見つける
とき（タイプされた切り替え、その人自身のターミナル、または `proveMessage` が証明したうえで
エージェントが `--message <id>` で名指しするその人のメッセージ）に `(set by you)` を使い、
それ以外では `(set by a command)` を使います。一方、継承されたスコープ既定はスコープの出所を
保ちます。スコープ変更は、明示的な上書きと、欠けているレガシーな Guard Policy/ceremony 行を
保ちます。実際に保存されたフィールドやソースの変更だけが、設定イベントを生成するか
`Last Updated` を更新します。ユーティリティアプライヤーは、`GUARD_POLICY_SET`、`CEREMONY_SET`、
fence 切り替えの `GUARD_DISABLED`/`GUARD_RESTORED` エントリを直接組み立てます。`aidlc-lib.ts` は、
統制されたチェックポイントが有効なメモリポリシーの変更を観測するとき、やはり
`appendGuardPolicySetRow` を使います。別のセッターラッパーを足したり、結合された要求を複数の
ディスパッチャー呼び出しに分割したりしないでください。

新しい設定は、裸の `setField` ではなく名前付きライターを通じてその行を書くので、以前の
リリースのレコードはその場で移行されます。Guard Policy のライターは `setGuardPolicyLine` で、
2 つ目を足すのではなく、残っている `Change Control` 行を改名します。`setGuardsOffLine` は、
fence が初めて切り替えられたときにその下に `Guards Off` 行を挿入します。廃止されたキー、フラグ、
見出し、状態フィールドは、1 リリースだけ読まれ、決して書かれません。廃止された FLAG と CONFIG
KEY のパスは `noteGuardPolicyRename` を呼ぶので、どちらかをタイプした呼び出し側は、プロセス
ごとにちょうど 1 行の非推奨行を見ます。廃止された状態フィールド、メモリ見出し、スコープ
フロントマターキーは静かに読まれます。以前のリリースが書いたレコードを読む人は、古い綴りを
選んでいないからです。

`codekb-path`、`codekb-snapshot`、`codekb-publish`、`codekb-scope-diff` のハンドラーは
**直接ユーティリティ動詞**です。ステージの散文が `/aidlc <verb>` ではなく
`bun <harness-dir>/tools/aidlc-utility.ts <verb>` を呼びます（`codekb-path` は、
`aidlc engine workspace codekb` としてディスパッチャー経由でも到達できます）。
`codekb-path` は読み取り専用で、`codekb-scope-diff` も、`--compare` がアクティブインテント記録の
`inception/reverse-engineering/` からそのリポジトリ自身の `scope-draft-<repo>.md` を除く点を
除いて、読み取り専用です。`codekb-snapshot` は、ソース／ストアの世代を返す前に、中断された
以前の CodeKB ディレクトリスワップを回復することがあります。`codekb-publish` は唯一の共有ストア
ライターです。完全な 9 ファイルの候補を検証し、スペース + リポジトリの比較交換ロックの下で
コミットします。どれも監査イベントを出さず、SKILL.md のタスク追跡を駆動しません。

`project-description` と `document-input` は、同じ読み取り専用の直接ユーティリティの形を
使います。両方の消費ステージは、まず `project-description` を呼びます。マークされたレコードは、
その正確な `project-description.json` 文字列をデコードしなければならず、マークされていない
2.6.115 以前のレコードは、明示的にレガシーな `Project` 状態フィールドにフォールバックします。
これらは、選ばれたパスをネイティブのファイル書き込みツールでアクティブレコードの固定された
`.aidlc-engine/document-input-path` トランスポートに書いた後、
`bun <harness-dir>/tools/aidlc-utility.ts document-input` を呼びます。顧客が選んだパスのバイトが、
シェルコマンドに入ることはありません。ハンドラーは、プロジェクトルートからパスを解決し、
含まれるファイルの同一性を記録し、読む前に、開かれたディスクリプタがそれと一致することを
要求します。親ディレクトリの置き換え、リダイレクト、サポートされない入力は拒否されます。
そのパスに何も存在しないとき、それは `git ls-files --cached --others --exclude-standard`
（`.git`、`node_modules`、隠しフォルダ、ネストしたリポジトリをスキップする歩行。リポジトリ外
でのみ）を通じて、その名前のプロジェクトの通常ファイルを一覧し、隠しフォルダ外のドキュメント
ファイルだけに一致させ、シンボリックリンクや、秘密に見えるファイル／フォルダ名を持つパスを
決して提示せず、唯一の一致を読むか、番号付きの選択のために一致を返します。リポジトリ内で git が
失敗するか、歩行が上限に達すると、何も選ばずパスを尋ねます。`project-description` は、貼り付け
られたドキュメントを人の指示から分けるので、どのステージも自分でそれを分けません。読み取りに
成功すると、DocumentKB と同じインラインの信頼できないパスと信頼できない内容の注意書きを
出します。`document-input --onboard` は、書き込む唯一の形です。PDF や Word ファイルに対して、
読んだバイトをアクティブスペースの `knowledge/documents/`（`link()` で公開されたステージング
ファイルなので、既存のファイルは置き換えられません）にコピーし、ナレッジツールの `onboard` と
`showDocument` をインプロセスで呼びます。git が無視するソース、または git が確認できないソースは、
`--include-ignored` が渡されない限り、`ask` を 1 つ返し、何もコピーしません。ステージは、人が
同意した後だけそれを足します。Copilot アダプターは、この形に対して Allow プロンプトを保ちます。
抽出器を実行するからです。

### LLM 駆動のハンドラー
エージェントの推論から恩恵を受けるハンドラー（ファイルシステムのスキャン、意思決定）向け:
1. **タスク追跡** -- セッションが `TaskCreate` と `TaskUpdate`（またはハーネスの skill がそれらを対応付けるプランや todo ツール）を提供するとき、論理ステップごとに `TaskCreate` でタスクを作り、作業の進行につれて `TaskUpdate`（`in_progress` -> `completed`）で遷移させます。これは Claude Code のタスクサイドバーを駆動します。それらのツールがないと、ステップは静かにスキップされます。
2. **statusline の更新** -- アクティブインテントの `aidlc-state.md` が存在するなら、`Current Stage` を一時的に、走っているユーティリティを説明するよう設定し（たとえば `running health check`）、終わったら元の値に戻します。`aidlc-statusline.ts` hook が、ターミナルのステータスバー向けにこのフィールドを読みます。
3. **監査ロギング** -- 適切な意味的ネイティブディスパッチャールートを呼びます。その裏付けハンドラーが内部で `appendAuditEntry` を呼びます。LLM の散文から `**Event**:` の markdown ブロックを決して手書きしないでください。[State Machine: Forbidden patterns](12-state-machine.md) を参照してください。

`intent-create` ハンドラーは完全に決定的です。3 つの init ステージ（workspace-scaffold、workspace-detection、state-init）すべてが、単一の `aidlc-utility intent-create` 呼び出しの中で走ります。ウェルカムメッセージは、`settings.json` の `companyAnnouncements` 経由でセッション開始時に描画され、ステージではありません。

## スコープの追加

スコープは、ファイル（その同一性）と、ステージごとの所属タグとしてオーサリングされます。同一性は `core/scopes/aidlc-<name>.md` に存在します。所属は、`core/aidlc-common/stages/` 下の各ステージのフロントマター `scopes:` リストに存在します。`init`、`scope-change`、`resolve-env-scope`、`doctor`、状態ツールにまたがる検証ロジックは、`core/tools/aidlc-lib.ts` の `validScopes()` 経由で、ランタイムに `.claude/scopes/*.md` ファイルから有効なスコープのリストを導出します。EXECUTE/SKIP グリッドは、ステージごとの `scopes:` リストの転置で、`tools/data/scope-grid.json` にコンパイルされます。スコープの追加に TypeScript の編集は不要です。

### 手順

1. **`core/scopes/aidlc-hotfix.md` を作る** — スコープの同一性です。フロントマター:
   - `name`（必須）: スコープ名。ファイル名の語幹と等しくなければなりません。
   - `depth`（必須）: `Minimal` | `Standard` | `Comprehensive`。
   - `keywords`（任意）: `/aidlc <freeform text>` のプランを提案するときにエージェントが読むヒント語。ツールはこれに一致しません。フラットな文字列リストは、ブロック（`- item`）形式でもフロー（`[item, item]`）形式でもかまいません。空のリストはヒントを運びません。[the agent proposes the plan](../guide/05-scopes-and-depth.md#the-agent-proposes-the-plan) を参照してください。
   - `description`（任意）: `/aidlc --help` と、オーケストレーター skill の隣の `tables.md` のコンパイル済みスコープ表に描画される一行要約。
   - `testStrategy`（任意）: depth とは独立にテスト戦略を上書きします。既定では depth に一致します。
   - `review_cap`（任意）: `adversarial` | `advisory` | `none`。このスコープのステージレビュークラスの上限を定めます。不在はスコープレベルの引き下げなしを意味します。上限はステージ宣言を下げられますが、決して上げられません。自律 swarm のレビューは免除されます。
   - `runner`（任意）: 既定の生成ランナーセットにスコープを含めるには `true` を設定します。
   - `existing_code`（任意）: `true` | `false`。不在は false を意味します。`true` は、すでに存在するコードを変えるスコープ（`bugfix`、`refactor`、`security-patch`）を示します。新しいプロジェクトのカスタムプランは、適合する別のスコープがあればそれで走り、新しいプロジェクトとしてスキャンされるフォルダでの作成は、スコープの Reverse Engineering を落とすときにそれを記録します。ローダーは他の値を拒否します。
   - `freeform_default`（任意）: 好ましいコア既定（`classic`）が有効でないとき、このスコープを指名するには `true` を設定します。高々 1 つの有効なスコープがこれを主張できます。グラフコンパイルは、曖昧な選択済みプラグインセットを拒否します。未知の明示的な `AWS_AIDLC_DEFAULT_SCOPE` 値は、やはり検証に失敗します。
   - `guard_policy`（任意）: `strict` | `relaxed` | `off`。スコープ上のすべての新しいインテントが始まる Guard Policy の既定です。人が何かを承認または確認した後に入力が変わったとき何が起きるか（strict は承認を再オープンし、relaxed と off は変更を一度記録して続ける）、そしてどの権限 fence が保たれるか（strict は何も下げない。relaxed は `plan-approval` と `review-freeze` を下げる。off はその 2 つに加え `state-transition` と `reviewer-scope` を下げる。`human-presence` はこの語で決して下げられない）を定めます。不在は off を意味し、`enterprise` を除くすべての出荷スコープの既定です。`skeleton` のように検証されます（ローダーはファイルと 3 つの値を名指しします）。メモリ層の `## Guard Policy` の `Mode: strict` は、どのスコープ既定にも勝ちます。その `Mode: relaxed` や `Mode: off` も、スコープ既定を置き換えます。`change_control` は廃止された綴りで、1 リリースだけ読まれます。両方のキーを異なる値で名指しすると拒否されます。
   - `sensors`（任意）: `on` | `off`。不在は on を意味します。センサー実行とセンサーゲート検査を制御します。インテント単位のフラグ: `/aidlc --sensors on|off`。グローバルキルスイッチ: `AIDLC_DISABLE_SENSORS=1`。
   - `learnings`（任意）: `on` | `off`。不在は on を意味します。ステージの learnings の儀式を制御します。インテント単位のフラグ: `/aidlc --learnings on|off`。グローバルキルスイッチ: `AIDLC_DISABLE_LEARNINGS=1`。
   - `summary_confirmation`（任意）: `on` | `off`。不在は on を意味します。ステージ承認ではなく、別の出力前サマリー確認を制御します。インテント単位のフラグ: `/aidlc --summary-confirmation on|off`。グローバルキルスイッチ: `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`。スコープの値は、ステージの `required` | `if-present` 宣言とは別物です。

   Ceremony キーは on/off 以外の値を拒否します。解決は、グローバルキルスイッチ（`1`）→ 有効なインテント状態行 → スコープ既定 → on です。すべての出荷スコープは、3 つすべてを明示的に宣言します。classic はセンサーと learnings を有効にしサマリー確認を無効にし、bugfix はセンサーを有効にし learnings とサマリー確認を無効にし、express は 3 つすべてを無効にし、他の 8 つは 3 つすべてを有効にします。キルスイッチは `aidlc config flags --bypass <NAME>` で記録できます。

   本体は散文の意図です — 「なぜこれらのステージか、なぜそれらをスキップするか」。`validScopes()` は `.claude/scopes/*.md` の存在から導出するので、ファイルが着地した瞬間にスコープは有効です。構造上の問題を捉えるには、編集後に `/aidlc --doctor` を実行してください。

   ```yaml
   ---
   name: hotfix
   depth: Minimal
   keywords:
     - hotfix
     - urgent
   description: Urgent production fix
   runner: true
   ---

   # hotfix scope

   Lean path for the urgent production patch — regression test and deploy, nothing else.
   ```

2. **メンバーステージにタグを付ける** — `hotfix` の下で走るべき各ステージ（`core/aidlc-common/stages/<phase>/` の下）で、そのフロントマター `scopes:` リストに `hotfix` を足します。タグを付けないステージは、そのスコープでは `SKIP` です。3 つの初期化ステージ（`workspace-scaffold`、`workspace-detection`、`state-init`）はこれを含まなければなりません。常に走ります。

3. **再コンパイル + scope-table の再生成** — `aidlc engine graph compile` が `scopes:` タグを `tools/data/scope-grid.json` に転置します。その後 `aidlc engine gen scope-table` が、オーケストレーター skill の隣の `tables.md` のコンパイル済みスコープ表向けに、正規の Markdown 領域を表示します。`<!-- BEGIN: compiled ... -->` / `<!-- END: compiled ... -->` マーカーの間の領域を生成されたまま保ち、その後 `aidlc engine graph compile --check` と `aidlc engine gen scope-table --check` を実行して exit 0（ドリフトなし）を確認します。

4. **スコープが解決することを確認する** - `bun core/tools/aidlc-utility.ts intent-create --scope hotfix --project-dir /tmp/scope-smoke` は成功し、`Scope: hotfix` を持つ状態ファイルを生成するはずです。

5. **`doctor` がそれを env の既定として受け入れることを確認する** — `AWS_AIDLC_DEFAULT_SCOPE=hotfix aidlc doctor` は、env 変数を有効と報告するはずです。

6. **プランのヒントがうまく読めるか確認する**（`keywords` を埋めた場合）- エンジンはもうそれに一致しません。エージェントがプラン提案ステップでそれを読みます（`next '<a request your plan is for>' --project-dir /tmp/scope-smoke` が各プランをそのヒントとともに表示します）。あなたのものの行が、プランが何のためかを平易な言葉で言っているか確かめてください。

7. **プランのパリティを確認する（任意だが推奨）** — `AIDLC_GRAPH_RESOLVE=1 aidlc engine graph resolve hotfix --stdout` がスコープのプランを出します。EXECUTE セットがタグを付けたものに一致するか目で確認します。

8. **スコープを意識したドキュメントを更新する** — `docs/guide/05-scopes-and-depth.md`（完全なスコープリファレンス。Stage-by-Scope Matrix を含む。そのセルは `tests/unit/t244-scope-matrix-doc-sync.test.ts` がコンパイル済みの `scope-grid.json` に対してドリフトガードします）、`docs/guide/13-customization.md`（有効値のリストとスコープ表）、`docs/reference/03-orchestrator.md`（スコープからステージへの対応）はすべて、スコープを明示的に列挙します。この章末のドキュメント方針に従い、同じ PR で更新してください。

9. **スコープルーティングのワークフローテストを足す** — スコープが既存のスコープと異なる振る舞いを持つなら（新しいフェーズスキップのパターン、新しい depth の組み合わせ）、`tests/e2e/t53.test.ts`（sdk スコープルーティング）か `tests/e2e/t-tui-t50-bugfix-scope.serial.test.ts`（tui スコープの通し）をモデルにしたルーティング済みジャーニーテストを足します。

### 自動で検証されるもの

- `validScopes().has("hotfix")` は、`.claude/scopes/aidlc-hotfix.md` ファイルが着地した瞬間に `true` を返します。すべての検証箇所がこのヘルパーを使います。
- エラーメッセージは、コードの変更なしに、新しいスコープをアルファベット順に列挙します。
- `/aidlc --doctor` は `AWS_AIDLC_DEFAULT_SCOPE=hotfix` を有効として扱います。
- 進行中のワークフローでの `aidlc-utility scope-change --scope hotfix` は、新しいスコープを受け入れます。
- 転置ドリフトガード: `aidlc-graph compile --check` は、ステージの `scopes:` タグが `scope-grid.json` の再コンパイルなしに編集されると、ビルドを失敗させます。`tables.md` のコンパイル済みスコープ表は、独自の `--check` ドリフトガード（t67）を持ちます。
- フリーフォームの `/aidlc <text>` のプラン提案ステップは、各スコープを、その `.claude/scopes/*.md` フロントマターの `keywords` ヒントとともに列挙します。エージェントがそれらを読み、プランを提案します。カスタムスコープは、インストールされ次第そのリストに現れます（SKILL.md の変更は不要）。ユーザーは、提案をスキップするために `--scope hotfix` を明示的に渡すこともできます。

### 自動で検証されないもの

- 綴りを間違えたスコープ名を持つ `scopes:` タグも、やはりコンパイルされます。誰も求めないグリッド列を生成し、そのステージを実際のスコープから静かに落とすだけです。`/aidlc --doctor` とスコープごとのテストがガードレールです。
- ステージスキップの意味（`PHASE_SKIPPED` イベント）。`tests/integration/t39.test.ts` は、スコープごとのループで 9 個の既知のスコープ名をハードコードします。新しいスコープは、そのリストが拡張されるまで走りません。同じ PR の一部として、新しいスコープをそのループに足してください。

## ステージの追加

ステージは、`core/aidlc-common/stages/<phase>/<slug>.md` の下の、YAML フロントマターを持つ Markdown ファイルとしてオーサリングされます。コンパイラはフロントマターを `tools/data/stage-graph.json` に読み込み、ランナージェネレーターは、コア ステージについてはコンパイル済みのステージリストから、タイプできる `/aidlc-<slug>` skill を出します（プラグインが所有するステージは、裸のプラグインプレフィックス付きスラッグを使います）。拡張性のコントラクトは「ステージを足すには、ステージファイルを書く」です。登録にエンジンの編集は不要です。エンジンはコンパイル済みのグラフからルーティングするからです。（完全なフィールドリファレンスと 3 区画の本体形式は、Harness Engineer Guide の [Anatomy of a Stage](../harness-engineering/01-anatomy-of-a-stage.md) と [Adding a Stage](../harness-engineering/02-adding-a-stage.md) に存在します。スキーマは [Stage Definition](15-stage-definition.md) です。）

### 手順

1. **ステージファイルを書く** - `core/aidlc-common/stages/<phase>/<slug>.md` を作ります。フロントマターは、`slug`、`phase`、`execution`/`condition`、`lead_agent` と任意の `support_agents`（エージェントスラッグで）、`mode`（`inline`、`subagent`、`pipeline`、`mob`。`agent-team` は予約されており未実装）、`consumes` / `produces`（アーティファクト語彙の名前）、ステージがユニットごとに条件付きでのみ書くアーティファクト向けの `optional_produces`（ユニット単位カバレッジから免除）、`requires_stage`（順序付けのエッジ）、`scopes:` 所属リスト、束ねる `sensors:`、ユニットごとに反復するなら `for_each`、そして（ユニット単位ステージでは）produces アーティファクトを各ユニットの kind に剪定する任意の `produces_kinds` マップを宣言します。本体は、ステージの 3 区画を運びます。完全なフィールドコントラクトについては [Stage Definition](15-stage-definition.md) を参照してください。

2. **グラフを再コンパイルする** — `aidlc engine graph compile` が新しいフロントマターを `tools/data/stage-graph.json` に読み込み、`scopes:` タグを `tools/data/scope-grid.json` に転置します。`aidlc engine graph compile --check` を実行して exit 0（ドリフトなし）を確認します。その後、`skills/aidlc/tables.md` の生成された表のミラーを `aidlc engine gen stage-table` と `aidlc engine gen scope-table` で更新し、`aidlc engine gen stage-table --check` と `scope-table --check` が両方とも exit 0 になることを確認します。ステージは `aidlc engine orchestrate next --stage <slug> --single` 経由で即座に実行できます。

3. **ランナーを再生成する** — `aidlc engine gen runners` が、実行可能なコンパイル済みステージごとに `/aidlc-<slug>` ランナー skill を出すので、あなたの新しいステージは、手でオーサリングすることなくタイプできるコマンドを得ます。`aidlc engine gen runners --check` を実行して、ディスク上のランナーセットがコンパイル済みのステージセットに一致することを確認します（ドリフトガード。ブートストラップ初期化ステージは設計上除外されます）。

4. **ステージがルーティングすることを確認する** — そのステージを含むスコープのワークフローで `aidlc engine orchestrate next` を駆動し、エンジンが、解決済みの `lead_agent`、ゲート、`consumes`、`produces` とともにあなたのスラッグを名指しする `run-stage` ディレクティブを出すことを確認します。

5. **スコープとステージを意識したドキュメントを更新する** — 新しいステージは、ステージ数とスコープごとのプランを変えます。`docs/guide/05-scopes-and-depth.md`（Stage-by-Scope Matrix。そのセルは `tests/unit/t244-scope-matrix-doc-sync.test.ts` がドリフトガードします）、`docs/reference/16-artifact-vocabulary.md`（非初期化ステージ数）、Harness Engineer Guide のステージ章、そしてプランを列挙するスコープリファレンスを更新します。この章末のドキュメント方針に従い、同じ PR で行ってください。

6. **テストを足し、カバレッジを更新する** — ステージの振る舞いのために `t*.test.ts` をオーサリングします（スイートは自動発見されるので、正しいレベルのディレクトリの下にファイルを置くだけでランナーには十分です。足すレジストリ行はありません）。その後 `bun tests/gen-coverage-registry.ts --check --base origin/main` がクリーンであることを確認します。これは、ユニットの main カバレッジがその主張を失ったときだけ失敗し、再生成やコミットするカバレッジファイルはありません。ステージランナーのドリフトガード `tests/unit/t129-stage-runner-drift.test.ts` は、生成されたランナーセットがコンパイル済みのステージセットに等しいことをアサートし、`tests/integration/t55-test-suite-drift.test.ts` は、古いパスとマーカーを掃き出します。

### 自動で検証されるもの

- **グラフ配置。** `compile` すると、ステージのエッジ（`requires_stage`、`consumes`、`produces`）が解決されて順序付けられます。`compile --check` は、ディスク上の `stage-graph.json` がフロントマターからドリフトすると、ビルドを失敗させます。
- **生成されたステージ表。** オーケストレーター skill の隣の `tables.md` の Stage Graph 表は、コンパイル済みの `stage-graph.json` から描画されます。`aidlc-utility stage-table --check` は、生成された領域がドリフトすると失敗します（t32）。
- **スキーマ + 参照。** `aidlc-graph.ts compile` は、`aidlc-stage-schema.ts` 経由ですべてのステージのフロントマターを検証し、`/aidlc --doctor` は `validateStageFrontmatter` と、すべての `lead_agent` / `support_agents` / `consumes` スラッグが解決する "Graph references" 検査を再実行します。
- **ランナーのパリティ。** `aidlc-runner-gen.ts check`（と `t129`）は、コンパイル済みのステージにランナーがないとき、または消えたステージのランナーが存在するとき、失敗します。

### 自動で検証されないもの

- **コンパイラが認識しない新しいフロントマターキー。** スキーマが実装しないキーを欲しがることはフレームワークの変更です。データを読むコードを編集するので、このレシピではなくエンジン／コンパイルパイプラインのパスに従います。[Stage Definition](15-stage-definition.md) の予約キー名前空間は、将来の構造拡張が予測どおりに着地するために存在します。
- **ドキュメントの列挙。** `docs/` にまたがるステージ数とスコープごとのプラン表は、手で保守されます。同じ PR で更新してください（下のドキュメント方針を参照）。

## エージェントの追加

エージェントのメタデータ（表示名、ナレッジファイルの例）は、`core/agents/` の下の各エージェントの `.md` フロントマターから読まれます。`core/tools/aidlc-lib.ts` の `loadAgents()` ヘルパーは、そのディレクトリのすべてのペルソナ `.md` ファイル（`aidlc-*` という名前のもの、または `display_name`、`examples`、`tier`、`plugin` を持つもの）を発見し、statusline hook が消費する（表示名を描画する）メタデータマップを導出します。エージェントの追加に TypeScript の編集は不要です。

### 手順

1. **エージェントファイルを作る** — 必須のフロントマターを持つ新しい `core/agents/<slug>-agent.md` を置きます。

   ```yaml
   ---
   name: <slug>-agent
   display_name: <Human-Readable Name>
   examples:
     - example-knowledge-file-one.md
     - example-knowledge-file-two.md
   description: >
     One-paragraph description of the agent's responsibilities and which stages it leads or supports.
   disallowedTools: Task
   tier: judgment
   ---
   ```

   `name` フィールドは、ファイル名の語幹と正確に一致しなければなりません。`display_name` は statusline が使う人間向けのラベルです。`examples` は、エージェント→examples 表に文書化された推奨ナレッジファイル名を列挙します。これらはユーザーへの提案で、ランタイムに読み込まれず、ディスクに書かれません。`tier`（`judgment` | `balanced` | `templated`）は、パッケージャーが各ハーネスのモデル／effort キーに投影するオーサリングのダイヤルです。コアフロントマターに生の `model:`/`effort:` を決してオーサリングしないでください（[Agent System](05-agent-system.md) を参照）。

2. **エージェントが発見されることを確認する** — `bun -e "import { loadAgents } from 'core/tools/aidlc-lib.ts'; console.log(loadAgents().find(a => a.slug === '<slug>-agent'));"` は、新しいエージェントのメタデータを表示するはずです。

3. **インテント作成がスペースナレッジディレクトリを作ることを確認する** - `bun core/tools/aidlc-utility.ts intent-create --scope poc --project-dir /tmp/agent-smoke` は、空のスペースレベル `aidlc/knowledge/` ディレクトリ（スペースの `intents/` の兄弟）を作るはずです。作成は、エージェントごとのサブディレクトリや README をシードしません。チームは、内容があるとき自分で `aidlc/knowledge/<slug>-agent/` を作ります。

4. **statusline が描画されることを確認する** — `Active Agent: <slug>-agent` を持つ状態ファイルをシードし、statusline hook を呼びます。出力は `--` 区切りの後に表示名を含むはずです。

5. **エージェントをステージに配線する** — ステージをリードまたはサポートすべき新しいエージェントは、`core/aidlc-common/stages/<phase>/` の下のステージ `.md` ファイルの `lead_agent` / `support_agents` フィールドで、各ステージのフロントマターに名指しされます。その後 `aidlc engine graph compile`（とドリフトガードとしての `compile --check`）を実行して、そのフロントマターから `tools/data/stage-graph.json` を再生成します。`stage-graph.json` を手で編集しないでください。これはコンパイル済みのアーティファクトで、次の `compile` が手動の変更を上書きします。これは発見とは別です。`loadAgents()` はエージェントを可視にし、（グラフにコンパイルされる）ステージフロントマターがそれをアクティブにします。

### 自動で検証されるもの

- `loadAgents()` は、次の呼び出し時に `.claude/agents/` の新しいペルソナ `.md` ファイルを発見します。コードの編集はありません。ペルソナは、`aidlc-*` という名前のファイル、またはフロントマターが `display_name`、`examples`、`tier`、`plugin` を持つファイルです。そこの他のファイルはホスト自身のエージェントで、そのままにされます。
- パーサーは、ペルソナの `name` または `display_name` が欠けていると、ファイル、欠けているフィールド、そして（`aidlc-*` という名前でないファイルでは）それをペルソナにしたキーを名指しして、例外を投げます。
- エージェントはスラッグでアルファベット順にソートされて返されるので、どのプラットフォームでの `readdirSync` の順序も同じ出力を生成します。
- インテント作成は、空のスペースレベル `aidlc/knowledge/` ディレクトリを作ります（エージェントごとのサブディレクトリや README をシードしません）。
- statusline の描画は、同じメタデータソースから表示名を導出します。
- `tests/unit/t61.test.ts` は、フィクスチャエージェントに対して 5 つすべてのプロパティをエンドツーエンドでアサートします。

### 自動で検証されないもの

- **ステージグラフへの参加**。ステージフロントマターは、`lead_agent` / `support_agents` フィールドでエージェントをスラッグで参照し、`aidlc-graph.ts compile` がそれらを `stage-graph.json` に運びます。どのステージのフロントマターでも名指しせずに新しいエージェントを足すと、エージェントは存在しますが決して走りません。ステージグラフのスキーマ検証（`core/tools/aidlc-stage-schema.ts`）は配線されています。`aidlc-graph.ts compile` はすべてのステージのフロントマターを検証し（`compile --check` が CI のドリフトガード）、`/aidlc --doctor` は、同じ `validateStageFrontmatter` と、すべての `lead_agent` / `support_agents` スラッグが解決する "Graph references" 検査を再実行します。
- **ナレッジファイルの存在**。`examples` は、エージェント→examples 表に文書化された推奨ファイル名のリストです。作られも検証もされません。ユーザーは、実際の内容を `aidlc/knowledge/<agent>/`（スペースレベルのナレッジディレクトリ）に置きます。
- **エージェントを列挙するドキュメント表**。`docs/reference/05-agent-system.md:119-131` の Phase Participation マトリクスと、`core/knowledge/aidlc-shared/knowledge-readme-template.md:16-29` のエージェント→examples 表は、手で保守されます。エージェントを足す同じ PR で更新してください（下のドキュメント方針を参照）。
- **`.claude/agents/<new-agent>.md` の本体の内容**。フロントマターだけがパースされます。本体の散文（Core Responsibilities、Collaboration、任意の Memory Focus、Key Principles）は、アクティブになったときエージェント自身が読みます。既存のエージェントファイルの構造に合わせて書いてください。

## ドキュメント方針

ファイル、ディレクトリ、コマンド、フラグを追加、削除、改名するとき:

1. 古い参照を `docs/` と `README.md` で grep します
2. すべての参照を同じコミットで更新します

## 権限方針

Plan Approval、レビュー、ゲート、ユニットライフサイクルの受領は、内容とステージの試行に結び付き、プロンプトを出したディレクティブの同一性にも、イベントの順序にも決して結び付きません。Plan Approval は、conductor ではなくエンジンが保持します。`next` は質問を公開し、何が尋ねられたかを記録しますが、答えは決して記録しません。答えは、人の返信からのみ記録されます。human-turn hook が正確な選択を記録し、conductor の `log answer --checkpoint plan-approval` が、質問が示されて以降の返信の後にだけ受け入れられて、読んだ選択を記録します。いずれにせよエンジンは、答えが記録されるときのプランファイルのフィンガープリントを取ります。そのフローで、他のどの conductor 実行コマンドも、Plan Approval の答え、受領、フィンガープリントタグを書きません。2 つのルールは [`12-state-machine.md`](12-state-machine.md#authority-invariants) に述べられています。提出前に、次に答えてください。

1. この変更は、いずれかのフィンガープリント、エポック、受領の同一性に入力を足しますか。その入力が検出する、人に見える変更を名指ししてください。それを変える人の行動がない（`next` の再実行、プローブ、ステータスクエリ、マーカーの書き直し、メタデータの更新）なら、それは同一性に属しません。代わりに出所として記録してください。
2. この変更は、クエリパスを書き込みにしますか。`next` はディレクティブを、そして Plan Approval については質問を公開しますが、答えは決して公開せず、受領は、プラン承認がオフのときにスキップされたレコードとしてのみ公開します（その権限は答えではなく設定です）。Stop-hook のプローブ、ルート検査、`--status`、`--doctor`、`team-board` は、権限状態を決して書きません。エンジンの観測者はさらに、耐久的な書き込みプリミティブで型付きの障壁に当たるので、偶発的な書き込みは、静かにではなく大きく失敗します。
3. この変更は、ガードに証拠を削除させますか。ガードの唯一の動きは拒否することです。拒否を表すために受領、チャレンジ、マーカーをクリアすることはなく、記録されたものを取り下げるのは明示的な人の決定だけです。
4. この変更は、`aidlc-state.md` にフィールドを足しますか。新しいフィールドは、既定でアクティブなディレクティブに結び付きます。それを状態ダイジェストから除外することは、そのフィールドをキャッシュとして意図的に分類することで、項目 1 と同じ名指しが必要です。

## 変更の提出

1. 何が変わったか、なぜかを明確に説明して、`main` に対して PR を開きます
2. L1 テストが通ることを確認します: `bash tests/run-tests.sh`
3. hook の変更には: `bash tests/run-tests.sh --unit` を実行します
4. 統合テストには: `bash tests/run-tests.sh --integration` を実行します（`claude` CLI ツールが必要）
5. 変更がファイル、コマンド、フラグに影響するなら、ドキュメントを更新します（上のドキュメント方針を参照）
6. 変更がいずれかのフィンガープリント、エポック、受領の同一性に入力を足すなら、それが検出する、人に見える変更を名指しします（上の権限方針を参照）

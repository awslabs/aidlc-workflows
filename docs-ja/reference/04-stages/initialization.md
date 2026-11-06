# Initialization フェーズの stage（0.1-0.3）

## フェーズの概要

Initialization フェーズは、AI-DLC ワークフローの 5 つのフェーズの最初です。stage 0.1 から 0.3 を実行し、**intent を作成** し、state ファイル、scope 内のフェーズごとに 1 つのディレクトリ、ワークスペースの分類、ルーティング設定とともに、その record ディレクトリを `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`（以下では `<record>/` と表記）に鋳造します。別個の scaffold コマンドはありません。ワークスペースのシェルはインストール済みまたはバージョン付きの `runtime/<harness>/` 投影に事前構築済みで同梱され、engine は、その人が何を作るか説明してそれが提案する plan を選ぶか、説明を伴う scope を指名する（`/aidlc --scope <name> "<description>"` または `/aidlc <name> "<description>"`）と、intent を作成します。作業のないプロジェクトでの素の `/aidlc` は、何を作るか尋ねます。

このフェーズの 3 つの stage すべてが、すべての scope で実行されます。条件付きの stage はありません。すべての stage は承認 gate なしで自動で進みます。

Claude Code では、ウェルカムメッセージは、セッション開始時に `.claude/settings.json` の `companyAnnouncements` エントリ経由でレンダリングされます。他のハーネスはどれも出荷しません。これは stage ではありません。stage ファイルも監査イベントもチェックボックスもありません。

3 つの stage すべては、作業が始まるときに engine が指名する作成コマンド、つまり 1 つの決定的な呼び出しの中で実行され、1 秒をはるかに下回って終わります。ネイティブインストールで、空のプロジェクトでは、次のとおりです。

```text
$ aidlc engine intent create --scope feature --arguments "A notes app where I can tag notes and search them" --label "tagged notes"
Intent created: 261013-tagged-notes (space: default)
State initialized: feature scope, 32 stages, Standard depth
Project type: Greenfield
Languages: Unknown
Frameworks: Unknown
Build System: Unknown
First post-init stage: intent-capture (IDEATION)
```

record ディレクトリ名は、作成日とラベル（`<YYMMDD>-<label>`）です。完全な説明は `<record>/project-description.json` に保たれます。

## scope 駆動の stage 包含

| Scope | 含まれる stage |
|-------|----------------|
| enterprise | 0.1-0.3 すべて |
| feature | 0.1-0.3 すべて |
| mvp | 0.1-0.3 すべて |
| poc | 0.1-0.3 すべて |
| bugfix | 0.1-0.3 すべて |
| refactor | 0.1-0.3 すべて |
| infra | 0.1-0.3 すべて |
| security-patch | 0.1-0.3 すべて |
| classic | 0.1-0.3 すべて |
| workshop | 0.1-0.3 すべて |
| express | 0.1-0.3 すべて |

## stage の要約

| Slug | # | Stage 名 | 条件 | Lead Agent | Mode |
|------|---|------------|-----------|------------|------|
| workspace-scaffold | 0.1 | Workspace Scaffold | ALWAYS | (orchestrator) | auto-proceed |
| workspace-detection | 0.2 | Workspace Detection | ALWAYS | (orchestrator) | auto-proceed |
| state-init | 0.3 | State Initialization | ALWAYS | (orchestrator) | auto-proceed |

---

## Stage 0.1 — Workspace Scaffold

| フィールド | 値 |
|-------|-------|
| Stage # | 0.1 |
| Slug | workspace-scaffold |
| Phase | Initialization |
| Lead Agent | (orchestrator) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed（承認 gate なし） |

### Steps
1. 必要なら `<record>/` ディレクトリを作成する
2. scope が実行する各フェーズのアーティファクトディレクトリと、`<record>/verification/` を作成する
3. 空の space レベルの `aidlc/spaces/<space>/knowledge/` ディレクトリ（自由記述。agent ごとのサブディレクトリも README もなし）と、空の CodeKB 親 `aidlc/spaces/<space>/codekb/`（その中のリポジトリのフォルダは Reverse Engineering がそれを書くと現れる）を作成する
4. intent の `audit/` shard を作成し、initialization の `WORKFLOW_STARTED` と `PHASE_STARTED` を記録する
5. `STAGE_STARTED`、`WORKSPACE_SCAFFOLDED`、`STAGE_COMPLETED` を記録する

### Inputs
- なし（エントリポイント）

### Outputs
- scope が実行するフェーズごとに 1 つのアーティファクトディレクトリ: `<record>/initialization/`、加えて少なくとも 1 つの EXECUTE stage を持つ `ideation/`、`inception/`、`construction/`、`operation/` の各々。scope が除外するフェーズにはディレクトリが付きません（bugfix の record には `ideation/` がない）。stage ごとのサブディレクトリはここでは作成されません。stage のディレクトリは、それが最初にアーティファクトを書くときに現れます
- `<record>/verification/`（すべての scope で作成）
- 空の space レベルの `aidlc/spaces/<space>/knowledge/` ディレクトリと `aidlc/spaces/<space>/codekb/` 親（space の `intents/` の兄弟）
- intent の `audit/` shard（そのヘッダ、workflow と phase の開始行、scaffold の行）

### Notes
- 冪等。すでに存在するディレクトリとファイルは skip する
- LLM 経由ではなく `aidlc-utility intent-create` の内部で実行される

---

## Stage 0.2 — Workspace Detection

| フィールド | 値 |
|-------|-------|
| Stage # | 0.2 |
| Slug | workspace-detection |
| Phase | Initialization |
| Lead Agent | (orchestrator — 決定的なルールベースのスキャナ) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed（承認 gate なし） |

### Steps
1. プロジェクトフォルダ直下と、6 階層まで、既知のソースフォルダ（`src/`、`app/`、`lib/`、`pages/`、`components/`、`tests/`）の中のソースファイルを数え、先頭でマニフェストとフレームワークのシグナルを読む。先頭に既存コードを示すものがないとき、コンテナフォルダ内のプロジェクトを探す。同じシグナルで 3 階層下までフォルダを walk し、コードを持つ最初のフォルダで分岐を止め、隠しフォルダ、下記の除外フォルダ、既知のソースフォルダ、サンプルやドキュメントのような名前のフォルダ（`doc`/`docs`、`example`/`examples`、`sample`/`samples`、`demo`/`demos`、`reference`、`testdata`、`fixtures`、`templates`、`scripts`、`aidlc`）を skip する。`apps/wordbook/` のプロジェクトは、greenfield に分類される代わりに、この方法で見つかる
2. 一次/二次言語を決めるために拡張子でファイルを数える。AI-DLC がプロジェクトに丸ごと書いたファイル（Cursor のルートの `install.ts` など）は決して数えない。各インストール済みのハーネスは、それらを `<harness directory>/tools/data/aidlc-projection.json` に一覧する
3. 既知の設定ファイル名でフレームワークを検出する（Next.js、Vite、Angular、Nuxt、Remix、Gatsby、Astro、Svelte、NestJS）、`package.json` の依存関係で React を、`manage.py` で Django を、それを指名する `Gemfile` で Rails を、それを指名する `pom.xml` で Spring Boot を検出する
4. マニフェスト + lockfile でビルドシステムを検出する（npm/yarn/pnpm/bun/poetry/uv/hatch/python/setuptools/pip/cargo/go/maven/gradle/composer/bundler）
5. `.gitmodules`（あれば）を宣言されたサブモジュールのパスについて読み、それぞれ初期化されているか調べる
6. `stages/initialization/workspace-detection.md` のルールを使って greenfield と brownfield を分類する
7. `STAGE_STARTED` + `WORKSPACE_SCANNED` + `STAGE_COMPLETED` のイベントを追記する

### Inputs
- プロジェクトのファイルシステム（read-only スキャン）

### Outputs
- ワークスペースの分類（greenfield/brownfield）
- 技術スタック（言語、フレームワーク、ビルドシステム）
- スキャン結果を捕らえる `WORKSPACE_SCANNED` 監査イベント。コードがプロジェクトフォルダ下の `apps/wordbook/` にあるプロジェクトでは、次のとおりです。

```text
## Workspace Scanned
**Timestamp**: 2026-10-13T12:59:58Z
**Event**: WORKSPACE_SCANNED
**Project Type**: Brownfield
**Languages**: TypeScript
**Frameworks**: React
**Build System**: npm (package.json)
**Nested Root**: apps/wordbook
**Details**: Deterministic rule-based scan
```

### Notes
- `aidlc-utility intent-create` の内部で決定的なスキャナとして実行される。LLM subagent の dispatch なし。
- シンボリックリンクはたどられない（`lstatSync` によるサイクル保護）
- `.claude/`、`.kiro/`、`.codex/`、`.opencode/`、`.aidlc/`、`.cursor/`、`node_modules/`、`.git/`、`dist/`、`build/`、`.next/`、`target/`、`vendor/` 内のファイルは決して数えない。`aidlc/` ツリーも数えない（トップレベルの数えはプロジェクトフォルダ自身のファイルだけを読み、コンテナの walk は `aidlc/` を skip する）
- `devDependencies` だけの `package.json` はツール/scaffolding として扱われ、それだけでは brownfield 分類を引き起こさない
- 少なくとも 1 つのサブモジュールのパスエントリを持つパース可能な `.gitmodules` は brownfield のシグナルである（submodule ディレクトリが未初期化でも、リポジトリのメタデータはコードを宣言する）。submodule のパスが未初期化のとき、スキャンは警告し `git submodule update --init --recursive` を指名する。`WORKSPACE_SCANNED` イベント（`Submodules` フィールド + `Details` の修正）と作成時の stdout に表面化し、conductor が中継できる。言語はスキャンされたまま
- その人の語がスキャンに優先する。`intent-create --project-type <greenfield|brownfield>` は `Project Type` を設定し `Project Type Source: you` を書く（そうでなければ `workspace scan`）。後で、`workspace reclassify --project-type <t>` が再スキャンして型をその人のものとして記録し、スキャンが greenfield としてセットアップした作業が Construction の前にコードを得ると `next` が一度尋ねる（[CLI ガイド](../../guide/12-cli-commands.md) の `/aidlc --project-type` 参照）

---

## Stage 0.3 — State Initialization

| フィールド | 値 |
|-------|-------|
| Stage # | 0.3 |
| Slug | state-init |
| Phase | Initialization |
| Lead Agent | (orchestrator) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed（承認 gate なし） |

### Steps
1. state ファイルを構築する（そのフィールドは `.claude/knowledge/aidlc-shared/state-template.md` に文書化されている。ツールがコードからそれを書く）
2. scope マッピング + depth + テスト戦略を適用する
3. greenfield では `reverse-engineering` を SKIP と印す
4. 最初の post-init stage を `[-]` に設定して、完全な `<record>/aidlc-state.md` を書く
5. `STAGE_STARTED`、`WORKSPACE_INITIALISED`、`STAGE_COMPLETED` を記録し、その後 plan が実行する最初のフェーズへの hand-off（`PHASE_COMPLETED`、`PHASE_VERIFIED`、`PHASE_STARTED`、その最初の stage の `STAGE_STARTED`）を記録する

### Inputs
- workspace-detection からのワークスペース分類（同じツール呼び出し）
- Scope: 作成コマンドが運ぶ `--scope`（その人が選んだ plan）。それなしで手作業で実行した場合は、環境または AI-DLC 設定の `AWS_AIDLC_DEFAULT_SCOPE`、なければ `classic`
- 渡された場合の depth / test-strategy のオーバーライド
- コンパイル済みの `tools/data/stage-graph.json` と `tools/data/scope-grid.json`

### Outputs
- `<record>/aidlc-state.md`（完全に埋められる）
- `WORKSPACE_INITIALISED` 監査イベント

### Notes
- initialization の後の最初の stage は、plan が実行する、stage 順で最初の stage で、greenfield では reverse-engineering が SKIP に設定されます。Ideation を実行する scope は、既存コードでも intent-capture から始まり、reverse-engineering は後で Inception で実行されます。出荷された scope では、次のとおりです。

| Scope | Greenfield は次から始まる | Brownfield は次から始まる |
|-------|----------------------|----------------------|
| enterprise, feature, mvp, poc | intent-capture | intent-capture |
| bugfix, express, refactor, security-patch | requirements-analysis | reverse-engineering |
| classic, workshop | practices-discovery | reverse-engineering |
| infra | practices-discovery | practices-discovery |

既に npm プロジェクトを持つフォルダでの bugfix では、次のとおりです。

```text
$ aidlc engine intent create --scope bugfix --arguments "Prices with an odd number of cents round the wrong way" --label "price rounding"
Intent created: 261013-price-rounding (space: default)
State initialized: bugfix scope, 9 stages, Minimal depth
Project type: Brownfield
Languages: TypeScript
Frameworks: Unknown
Build System: npm (package.json)
First post-init stage: reverse-engineering (INCEPTION)
```

- `/aidlc-init --scope <name> <description>`（明示的な作成パッケージング）から呼び出されたとき、orchestrator はこの stage の後に停止します。`/aidlc-init --scope <name>` 単独は、まず作業が何のためか尋ねます。説明だけの `/aidlc-init` は、まず plan 提示を見せ、その後 `/aidlc` と同じように続けます
- 作成が `/aidlc`（作業の説明とその人が選んだ plan、または説明を伴う指名された scope）から来るとき、conductor はその後 `next` を再実行し、同じチャットで最初の post-init stage へ続けます

---

## 再初期化

re-init フラグはありません。作成は intent ごとに一度実行されます。ワークスペースのシェル自体は事前構築済みで同梱され、再 scaffold されることはありません。既存の intent に対する 2 回目の `/aidlc` は、再初期化ではなくそれを resume します。やり直すには、`/aidlc intent archive <name>` で作業を脇に置き、`/aidlc "<what to build>"` で新しい作業を説明します。新しい作業はそれ自身の `<record>/` を得ます。アーカイブは、古い record とその監査証跡をディスクに保ちます（最初の行の矢印はここでは `->` として示します）。

```text
$ aidlc engine intent archive tagged-notes --reason "starting over with a smaller first step"
Archived intent -> 261013-tagged-notes (space: default). Its record and audit trail stay on disk; /aidlc intent list --all shows it and /aidlc intent unarchive 261013-tagged-notes brings it back.
$ aidlc engine intent list --all
Intents in space "default":
  261013-tagged-notes  [archived]

(no active intent - switch with /aidlc intent <name>)
```

## Notes

- 3 つの stage すべてが自動で進みます。Initialization フェーズに承認 gate はありません
- 作成ツールは、`Current Stage`、state のチェックボックス、監査行を、同じ呼び出しの中で自ら書きます
- conductor は initialization のライフサイクル state を直接編集することはありません
- Initialization から plan が実行する最初のフェーズへの hand-off には、governance 境界のチェックがありません。作成は、その背後にチェックなしで `PHASE_COMPLETED`、`PHASE_VERIFIED`、`PHASE_STARTED` の行を書きます

## 相互参照

- [Architecture](../01-architecture.md) — 実行モデルの概要
- [Orchestrator](../03-orchestrator.md) — ルーティングロジック
- [Stage Protocol](../04-stage-protocol.md) — 状態追跡のルール
- [Ideation Stages](ideation.md) — 次のフェーズ

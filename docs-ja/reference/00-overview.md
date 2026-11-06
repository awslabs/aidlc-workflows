# 開発者リファレンス概要

> [AI-DLC ドキュメント](../README.md) の一部 · [ユーザーガイド](../guide/00-introduction.md) · [ハーネスエンジニアガイド](../harness-engineering/00-overview.md) · **開発者リファレンス**

このリファレンスは、AI-DLC の内部アーキテクチャと実装を解説します。対象読者は、AI-DLC のコードベースそのもの、つまり orchestrator、hook、CLI ツール、stage-graph のコンパイルパイプライン、監査タクソノミー、テストスイートを変更する貢献者です。

ソフトウェアを作るために AI-DLC を使う場合は、[ユーザーガイド](../guide/00-introduction.md) から始めてください。設定によって AI-DLC の振る舞いを作り変える場合、つまり stage や agent の追加、scope の定義、rule や sensor の作成、チーム知識の追加を行う場合は、[ハーネスエンジニアガイド](../harness-engineering/00-overview.md) から始めてください。これらはコードの変更ではなくデータの変更です。ハーネスエンジニアガイドの各章はまずワークフローを順に説明し、網羅的なスキーマについては本リファレンスを参照します。

> **本リファレンスでのパス表記。** AI-DLC は一度だけ記述し、ハーネスごとに生成されます。そのためファイルは意図に応じて 4 つの命名規約のいずれかで示されます。
> - `core/…` -- 手作業で記述する、ハーネスに依存しない信頼できる唯一の情報源 (source of truth) です（例: `core/tools/aidlc-orchestrate.ts`、`core/aidlc-common/stages/`）。編集はここで行います。ファイルが *記述* または *変更* される場所をパスが示すときは、`core/` パスです。
> - `dist/<harness>/...` -- 無視される、ローカルで生成されるソースおよび開発用、手動コピー用の投影です（`dist/claude/.claude/`、`dist/kiro/.kiro/`、`dist/kiro-ide/.kiro/`、`dist/codex/`、`dist/cursor/`、`dist/opencode/`、`dist/copilot/`）。手で編集したりコミットしたりはしません。`bun scripts/package.ts` で生成されます。リリースでは、Bun 形式の `aidlc-copy-runtime-X.Y.Z.tar.gz` 内の `runtime/<harness>/` に格納されます。
> - `dist-release/<harness>/…` -- 対応する、無視されるネイティブ投影です。リリースでは `aidlc-runtime-X.Y.Z.tar.gz` 内の `runtime/<harness>/` に格納され、ネイティブインストーラとライフサイクルコマンドがこれを利用します。
> - `<harness-dir>/...`（例: `.claude/`、`.kiro/`、`.codex/`）-- *インストール済み* プロジェクト内の runtime の場所です。ここでコマンドが実行され、ワークフロー中にフレームワークが読み書きします（`aidlc engine graph compile`、`.claude/agents/` を読む `loadAgents()`）。このディレクトリはハーネスのパラメータです。
>
> 本リファレンスで素の `.claude/` パスが示される場合、それは Claude ハーネス固有の runtime の場所を指すものと読んでください。同じファイルは `core/` で記述され、各ハーネス自身のディレクトリへ出力されます。

## このリファレンスが扱う範囲

| 章 | トピック |
|---------|-------|
| [アーキテクチャ](01-architecture.md) | 5 層モデル、[設定レイヤー](01-architecture.md#configuration-layers) のルーティング原則、実行モデル、設計上の判断 |
| [プレーンアーキテクチャ](02-plane-architecture.md) | control / data / management プレーンの分離とその境界 |
| [Orchestrator](03-orchestrator.md) | SKILL.md の指揮者: forwarding ループ、gate の儀式、それが駆動する状態機械 |
| [Stage Protocol](04-stage-protocol.md) | 振る舞いの契約: approval gate、コンプライアンスチェックリスト |
| [Stages](04-stages/) | フェーズごとの stage ドキュメント（5 ファイル） |
| [Agent System](05-agent-system.md) | agent の構造、frontmatter 契約、設定マトリクス |
| [Hooks and Tools](06-hooks-and-tools.md) | hook システム、CLI ツール、132 イベントの監査タクソノミー |
| [Sensor System](07-sensor-system.md) | sensor マニフェストのスキーマ、PULL インポート、発火モデル、デフォルトの重大度 |
| [Rule System](08-rule-system.md) | rule ファイルのレイアウト、scope の導出、レイヤーチェーンの resolver、衝突 gate |
| [Testing](09-testing.md) | テストピラミッド、tier、stub、fixture、テストレジストリ |
| [Knowledge System](10-knowledge-system.md) | 2 層アーキテクチャ、DocumentKB の派生カタログ、読み込み順、テンプレート |
| [Contributing](11-contributing.md) | 開発ワークフロー、ユーティリティハンドラのチェックリスト、ドキュメントポリシー |
| [State Machine](12-state-machine.md) | workflow / phase / stage の各機械、132 イベントのタクソノミー、audit-first ルール |
| [Runtime Graph](13-runtime-graph.md) | コンパイル済みの `runtime-graph.json` アーティファクト: stage graph のデータプレーン側のミラー |
| [Harness Primitives Mapping](14-claude-features.md) | 各 AI-DLC の概念がハーネスのネイティブプリミティブにどう対応するか（Claude Code を詳しく） |
| [Stage Definition](15-stage-definition.md) | YAML frontmatter 契約、3 区画の本体、コンパイルパイプライン |
| [Artifact Vocabulary](16-artifact-vocabulary.md) | 命名ルール、衝突ポリシー、ファイルシステムへの対応、ライブレジストリの見方 |
| [Engine and Skill System](17-skill-system.md) | オーケストレーションエンジン（`next`/`report`/`park`）、型付き directive 契約、conductor、複数の skill、scope の形、swarm referee |
| [Plugin Mechanism](18-plugin-mechanism.md) | AIDLC プラグインシステム: マニフェスト、インストール時の構成を本物のホストプラグインとして行う仕組み、追加的な contribution の継ぎ目、マルチテナントのガード、現状の実装状況。作成の手順は [harness-engineering/10](../harness-engineering/10-authoring-a-plugin.md) を参照 |
| [Supply-Chain Security](19-supply-chain-security.md) | リリースの attestation、SLSA provenance、チェックサム、ワークフローの堅牢化、インストーラの防御、所有権、エンタープライズ向けの転送 |
| [Commit Provenance](20-commit-provenance.md) | コミットからレビュー単位への、内容由来の帰属: コミット済みの reviewed-source 証跡、`aidlc attest resolve`、`SOURCE_COMMITTED` アンカー |
| [Diagrams](diagrams.md) | すべての Mermaid 図を 1 か所に |
| [Agents](agents/) | agent の技術リファレンス（frontmatter、ツール、stage の所有関係） |

## ナビゲーションの仕方

- **新しい関心事（rule、方法論、知識の事実）はどこに属するか。** [Architecture: Configuration layers](01-architecture.md#configuration-layers) を読んでください。2 軸モデル（authorship × consumption）と境界テストが、新しい関心事を正しいファイルへ振り分けます。
- **新しい stage を追加するには。** [Stage Protocol](04-stage-protocol.md)、次に [Stages](04-stages/) の該当フェーズのファイル、続けて [Contributing](11-contributing.md) を読んでください。
- **stage 定義フォーマットを変更するには。** stage の `.md` ファイルを編集する前に [Stage Definition](15-stage-definition.md) を読んでください。stage ファイルのフォーマットはデータ駆動で、runtime はコンパイル済みの JSON を読みます。
- **アーティファクトを追加または改名するには。** [Artifact Vocabulary](16-artifact-vocabulary.md) を読んでください。この章は命名ルール、安定性ポリシー（改名・削除はメジャー、追加はマイナー）を説明し、ライブ一覧として `aidlc engine graph artifacts` を示します。レジストリは stage ファイルから導出され、手書きではありません。
- **新しい scope を追加するには。** [Contributing: Adding a Scope](11-contributing.md#adding-a-scope) を読んでください。scope はファイルで記述します。`.claude/scopes/aidlc-<name>.md` ファイルと、各メンバー stage への `scopes:` タグが必要で、TypeScript の編集は不要です。
- **新しい agent を追加するには。** [Contributing: Adding an Agent](11-contributing.md#adding-an-agent) を読んでください。agent は `.md` の frontmatter でデータ駆動され、TypeScript の編集は不要です。
- **agent を変更するには。** [Agent System](05-agent-system.md) と [Agents](agents/) 内の該当 agent のファイルを読んでください。
- **hook に取り組むには。** [Hooks and Tools](06-hooks-and-tools.md) と、hook のテストパターンについて [Testing](09-testing.md) を読んでください。
- **orchestrator を変更するには。** [Orchestrator](03-orchestrator.md) と [Architecture](01-architecture.md) を読んでください。監査イベントの追加・変更を行う場合は、[State Machine](12-state-machine.md) の章から始めてください。やらなければ drift テストに捕まります。

## ユーザーガイドとの関係

ユーザーガイド（`docs/guide/`）は AI-DLC が **何を** するか、そして **どう使うか** を説明します。この開発者リファレンスは **どう動くか**、そして **どう変更するか** を説明します。両方に登場するトピックもあります。

| トピック | ユーザーガイド | 開発者リファレンス |
|-------|-----------|-------------------|
| Agents | 何をするか、いつ現れるか | frontmatter 契約、追加・変更の仕方 |
| Knowledge | 会社標準の追加の仕方 | 読み込み順の内部、テンプレートシステム |
| Hooks | 何が記録されるか | hook の実装、監査イベントのタクソノミー |

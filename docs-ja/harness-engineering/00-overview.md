# Harness Engineer Guide

> [AI-DLC ドキュメント](../README.md)の一部 · [User Guide](../guide/00-introduction.md) · **Harness Engineer Guide** · [Developer Reference](../reference/00-overview.md)

AI-DLC は方法論であり、この実装はそれを、あなたが使うハーネス上ですぐに動く形で提供します。対応ハーネスは Claude Code、Kiro CLI、Kiro IDE、Codex CLI、Cursor、opencode、GitHub Copilot です。構成は 14 のエージェント（11 のドメインエキスパート、2 のレビュアー、そして composer）、33 のステージ、11 のスコープ、そして一式のルールとセンサーです。このガイドは、その方法論を作り変えたい人のためのものです。どのステージを走らせるかを変える、フレームワークが扱わないドメインのためにエージェントを追加する、スコープを絞り込む、フレームワークに恒常的なルールを教える、ステージに決定的なチェックを組み込む、といった作業です。

これらはすべて、コードを書かずに行えます。

---

## 3 種類の読者、3 つのガイド

AI-DLC のドキュメントは、トピックではなく「何をしたいか」で分かれています。

| ガイド | あなたは… | 変更するのは… |
|-------|----------|-------------|
| [User Guide](../guide/00-introduction.md) | AI-DLC を使ってソフトウェアを作る | `.claude/` の中は何も変えない。`/aidlc` を実行し、ゲートで回答し、成果物をレビューする |
| **Harness Engineer Guide**（このガイド） | チームに合わせて AI-DLC の振る舞いを形づくる | フレームワークが読む**データ**。ステージ、エージェント、スコープ、ルール、センサー、ナレッジ |
| [Developer Reference](../reference/00-overview.md) | AI-DLC *そのもの*を変える | そのデータを読む**コード**。オーケストレーター、フック、CLI ツール、コンパイルパイプライン、テストスイート |

このガイドと Developer Reference の境界はデータとコードの違いです。ハーネスエンジニアが触れるものはすべて、YAML フロントマターを持つ Markdown ファイルか、JSON の設定です。つまりフレームワークがランタイムに読み込む宣言的なデータです。ステージを追加する、エージェントを追加する、スコープを定義する。これらに *TypeScript の編集を要しない*ことが、フレームワーク自身の設計原則です。変更が `.ts`（オーケストレーター、フック、ツール）の編集を意味した瞬間に、Developer Reference の領域へ踏み込んだことになります。

---

## メンタルモデル: ステージは *what*、エージェントは *who*

フレームワークの大半を支える 2 つのプリミティブがあり、この両者を取り違えないことが仕事のすべてです。

- **ステージ**は作業の単位であり、*何* が起きるかを表します。消費・生成する成果物、それを率いるエージェント、そして実行方法を宣言します。ステージはワークフローグラフのノードです。
- **エージェント**はペルソナであり、*誰* が作業するかを表します。ドメインの専門性、ツールの allowlist、モデルを備えます。エージェントはステージ *の中に* 読み込まれます。

ステージは率いるエージェントを名指しますが、エージェントは自分のステージを名指しません。この非対称性は意図的なものです。これにより、作業の担当を付け替える（ステージを編集する）際にワーカーを書き直さずに済み、ワーカーを追加する（エージェントファイルを置く）際にも、あるステージがそれを使うと決めるまでワークフローを乱さずに済みます。

これらのステージを通して作業を進める仕組みが 2 つあり、ハーネスエンジニアはその両方が読むデータを形づくります。決定的なエンジン（`core/tools/aidlc-orchestrate.ts`。サブコマンドはちょうど 6 つ、`next`、`continue`、`report`、`park`、`team-board`、`wait`。`continue` は内部のステアリング転送、`team-board` は読み取り専用の Team Construction クエリ、`wait` はディスパッチ済み作業に対する境界付き・読み取り専用の待機です）は `aidlc-state.md` とコンパイル済みの `stage-graph.json` を読み、次に何を走らせるかを判断し、型付きのディレクティブを 1 つ発行します。コンダクター（`skills/aidlc/SKILL.md`）は、各ディレクティブを運び出す薄い転送ループです。ルーティングはエンジンにあり、あなたのステージファイル、スコープ、ルールがそれを導く入力になります。

ハーネスエンジニアが設定するそのほかのものは、この 2 つにぶら下がります。

- **スコープ**は、ある種類の作業で *どの* ステージを走らせるかを決めます（バグ修正はセットアップ後 30 ステージのうち 6 つを走らせ、エンタープライズ機能はすべてを走らせます）。
- **ルール**は、あらゆるワークフローに持ち込まれる恒常的な決定、つまりチームの「いつもこうする」です。
- **センサー**は、ステージに紐づく決定的なチェックです。該当する書き込み時や承認ゲートで走り、その紐づけは advisory にも blocking にもできます。
- **ナレッジ**は、エージェントが作業前に読み込むドメインのコンテキストです。

---

## コードなしで変えられるもの

これらはすべて、手で書く・ハーネス非依存のソースである `core/` の中で作ります。その後、ハーネスごとのツリーを再生成します（下記の[ビルドモデル](#the-build-model-author-in-core-regenerate-the-harnesses)を参照）。

| 変更 | どこで作るか | 章 |
|--------|-------|---------|
| ステージの動作を編集する | `core/aidlc-common/stages/<phase>/<slug>.md` | [Anatomy of a Stage](01-anatomy-of-a-stage.md) |
| 新しいステージを追加する | 適切なフェーズディレクトリ内の新規ファイル + グラフ配線 | [Adding a Stage](02-adding-a-stage.md) |
| エージェントを追加・変更する | `core/agents/<name>-agent.md` | [Adding an Agent](03-adding-an-agent.md) |
| スコープを定義する | `core/scopes/aidlc-<name>.md` + ステージごとの `scopes:` タグ | [Scopes](04-scopes.md) |
| 恒常的なルールを教える | `core/memory/{team,project}.md` | [Rules and the Learning Loop](05-rules-and-the-loop.md) |
| 決定的なチェックを組み込む | `core/sensors/` 配下のセンサーマニフェスト + ステージの `sensors:` インポート | [Sensors](06-sensors.md) |
| チームのドメインナレッジを追加する | `aidlc/knowledge/<agent>-agent/`（スペースレベルのナレッジディレクトリ。ランタイム） | [Team Knowledge](07-team-knowledge.md) |
| Construction とスワームの姿勢を形づくる | `core/memory/` + `units-generation` ステージ | [Construction and the Swarm](08-construction-and-swarm.md) |

各章は *どうやるか* を物語り、網羅的なスキーマは [Developer Reference](../reference/00-overview.md) へリンクします。リファレンスが規範的な契約であり、このガイドは作業のための物語です。

1 行だけ例外があります。チームのドメインナレッジは、*あなた* が自分のプロジェクトのスペースレベル（`aidlc/knowledge/`。スペースの `memory/`、`codekb/`、`intents/` と同階層）に、ランタイムで追加するコンテキストです。これは `core/` の外にあり、フレームワークがこれを上書きすることはありません。これ以外の上記のものは、`core/` で作るフレームワークのソースです。

## 命名ルールとそれが強制される場所

ステージのファイル名のステムはフロントマターの `slug` と一致していなければなりません。`aidlc-graph compile` は、ステムの不一致、ステージ slug の重複、消費される成果物に対する複数のプロデューサーを、ハードエラーとして拒否します。プロデューサー重複エラーは、生成している複数のステージファイルと 1 つのコンシューマーを名指します。どのステージも消費しない共有成果物名は有効なままです。センサーのファイル名/id のチェックはコンパイル時のハードエラーです。スコープとエージェントの宣言名の重複は、両方のファイルを名指すローダーエラーになります。スコープ/エージェントのファイル名と `name` のずれは、`/aidlc --doctor` が advisory として報告し、作者はファイルをリネームするか `name` を直せます。

---

## ビルドモデル: `core/` で作り、ハーネスを再生成する

ハーネスエンジニアが作るものはすべて `core/` にあります。これは手で書く・ハーネス非依存の信頼できるソースです（ステージは `core/aidlc-common/stages/`、エージェントは `core/agents/`、そしてスコープ、ルール、センサー、ナレッジ、ツール、フック）。ソース開発に使うハーネスごとの `dist/<harness>/` ツリー（`dist/claude/.claude/`、`dist/kiro/.kiro/`、`dist/kiro-ide/.kiro/`、`dist/codex/`、`dist/cursor/`、`dist/opencode/`、`dist/copilot/`）は、`core/` と薄い `harness/<name>/` の表層から**生成されます**。これらは無視されるローカル出力であり、コミットも手編集もしません。ループは常に次の通りです。

```bash
# 1. core/ のソースを編集する（dist/ は決して触らない）
$EDITOR core/aidlc-common/stages/inception/my-stage.md

# 2. core/ + harness/ からすべてのハーネスの両チャンネルを再生成する
bun scripts/package.ts

# 3. 決定的な生成を証明する（CI ガード）
bun scripts/package.ts --check
```

コミットするのは、手で書いた `core/` または `harness/` の編集です。生成されたルートはコミットしません。`--check` は、すべての copy、native、plugin の投影を、独立した一時ルートで 2 回ビルドし、バイト単位で比較します。以降の章のレシピで `aidlc engine graph compile`（または別のツール）を実行するよう書かれている場合、インストール済みコマンドは、そのツールをプロジェクトのアクティブなハーネスツリーに対して解決します。生成された copy チャンネルのプロセは Bun ディスパッチャーを使い、native のプロセは `aidlc` を使います。作者はチャンネル非依存の経路を使います。ここは作る場所ではありません。**あなたは `core/` で作り、ディスパッチャーはインストール済みの投影に対してツールを走らせます。** その、作ったソースと生成されたランタイムの切り分けを、このガイドを通じて取り違えないことが肝心です。完全なビルド契約については [Porting to a New Harness](09-porting-to-a-new-harness.md) と、Developer Reference の [Architecture § Source vs distribution](../reference/01-architecture.md#source-vs-distribution-one-core-many-harnesses) を参照してください。

---

## Developer Reference に踏み込むとき

変更がフレームワークのデータではなくコードに及ぶときは、[Developer Reference](../reference/00-overview.md) を参照してください。

- オーケストレーターのルーティングやステートマシン（[Orchestrator](../reference/03-orchestrator.md)、[State Machine](../reference/12-state-machine.md)）。規範的な engine/conductor/directive/runner/scope-shape/swarm の契約については [The Skill System](../reference/17-skill-system.md) を参照
- フックや CLI ツール（[Hooks and Tools](../reference/06-hooks-and-tools.md)）
- stage-graph のコンパイルパイプライン、または audit イベントの分類体系
- テストスイート（[Testing](../reference/09-testing.md)）

ステージやエージェントの追加はワークフローグラフに *触れます* が、それを読むコードは変えません。だからここで扱います。グラフのコンパイル方法を変える、あるいは新しい audit イベントを追加するのはコード変更であり、そちらで扱います。

---

## このガイドの構成

初めて読むときは順番に読んでください。

1. **[Anatomy of a Stage](01-anatomy-of-a-stage.md)** — ステージファイルの形式。フロントマター契約、3 区画のボディ、グラフがどうコンパイルされるか。何かを変える前に理解すべき、もっとも重要な 1 つです。
2. **[Adding a Stage](02-adding-a-stage.md)** — 端から端まで。ファイルを作り、依存エッジを配線し、コンパイルし、スコープに現れるのを見届けます。
3. **[Adding an Agent](03-adding-an-agent.md)** — ペルソナを作り、それが率いる・支えるステージに紐づけます。
4. **[Scopes](04-scopes.md)** — スコープとステージの対応を定義し、調整します。
5. **[Rules and the Learning Loop](05-rules-and-the-loop.md)** — レイヤーチェーン全体にルールを作り、ループに修正をルールへ昇格させます。
6. **[Sensors](06-sensors.md)** — 決定的なチェックを作り、ステージに紐づけます。
7. **[Team Knowledge](07-team-knowledge.md)** — エージェントにあなたのドメインコンテキストを与えます。
8. **[Construction and the Swarm](08-construction-and-swarm.md)** — ルールレイヤーでチームの Construction 自律姿勢を定め、`units-generation` を通じて、自律スワーム内の Unit ごとの Bolt が並列で走らせられるものを形づくります。
9. **[Porting to a New Harness](09-porting-to-a-new-harness.md)** — `harness/<name>/` ディレクトリ 1 つとマニフェストの 1 行で、`core/` を編集せずに別の CLI ハーネスを追加します。マニフェスト契約、フックアダプター、`emit.ts`。
10. **[Authoring a Plugin](10-authoring-a-plugin.md)** — 再利用可能で任意の **AIDLC プラグイン**を `plugins/<name>/` にパッケージします。新しいステージ/エージェント/スコープ/センサー/doctor チェックに加え、既存の core ステージへの追加的な貢献を、ハーネスごとに本物のホストプラグインとして発行します。設計は Developer Reference の単一の章（[18 mechanism](../reference/18-plugin-mechanism.md)）にあります。

## Next

[Anatomy of a Stage](01-anatomy-of-a-stage.md) から始めてください。ほかのすべての変更が土台にする形式です。

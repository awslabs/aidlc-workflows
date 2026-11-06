# エージェントの追加

エージェントはフレームワークの*誰*にあたります。ドメイン、ツールの許可一覧、ティアを持つペルソナです。出荷される 14 のエージェントは、11 のドメイン専門家（プロダクト、デザイン、デリバリー、アーキテクチャ、AWS プラットフォーム、コンプライアンス、DevSecOps、開発、品質、パイプラインデプロイ、運用をカバー）、2 つのレビュー専用エージェント、そして adaptive-workflows の composer からなります。フレームワークがカバーしないドメインがチームに必要になったとき（たとえばデータガバナンスのレビュアーやモバイルの専門家）、Markdown ファイルを 1 つ `core/agents/` に置いてペルソナを加えます。TypeScript はありません。

この章ではワークフローをたどります。ペルソナファイルとは何か、そのフロントマターでの判断のポイント、そして*見える*だけのエージェントはまだ*有効*ではないという 2 段階の真実です。フィールドごとの契約については、開発者リファレンスへリンクします。ユーザーの席からこれらのエージェントが誰なのかは、[ユーザーガイド — エージェント](../guide/06-agents.md)を参照してください。

---

## ペルソナファイルとは何か、どこに置かれるか

どのエージェントも `core/agents/<slug>-agent.md` の 1 つの平坦なファイルです。上に YAML フロントマター、下に Markdown 本文です。出荷されるファイルはすべて `aidlc-` 接頭辞を持ちます（`aidlc-architect-agent.md`、`aidlc-developer-agent.md`）。あなたが加えるファイルはあなたのもので、その接頭辞を使う必要はありません。出荷される 14 はフレームワークのファイルとして扱ってください。インストール済みのプロジェクトでは、そのどれかにローカルな編集を加えると、コピーをどこかへ移すか `--force` で出荷版を取るまで、次の `aidlc config` のリフレッシュが止まります。だから*既存のエージェントが知っていることを*カスタマイズするには、ファイルを編集せずチーム知識を通してください（[チーム知識](07-team-knowledge.md)を参照）。リフレッシュはこう言います。

```text
$ aidlc config --harness claude --yes
error: 1 config conflict(s): .claude/agents/aidlc-architect-agent.md (locally modified or unowned)
fix: to keep your version, move .claude/agents/aidlc-architect-agent.md somewhere else and run the same command again; to take the shipped version over it, run it again with --force.
```
 本当に新しいペルソナは別の一手です。あなたが所有し、アップグレードを生き延びる新しいファイルです。

フロントマターはフレームワークがパースする部分です。本文は、エージェントが起動したときに自分について読む散文です。責務、協業、メモリの焦点、作業の原則です。機械が読むのはフロントマターだけで、本文はエージェント自身の枠組みのためのもので、出荷ファイルの構造に合わせて書きます。パッケージャーは、必須の委譲知識プリフライトをすべてのハーネス投影に加えます。

ここに、`core/agents/aidlc-architect-agent.md` に書かれた実際のエージェントのフロントマターを示します。

```yaml
---
name: aidlc-architect-agent
display_name: Architect Agent
examples:
  - tech-stack.md
  - infrastructure-preferences.md
description: >
  Solutions architect responsible for domain design, contract design, NFR patterns, and component decomposition.
  Leads Feasibility, Domain Design, Units Generation, Contract Design, Functional Design, NFR Requirements, and NFR Design stages,
  and serves as the dispatched last link of the Reverse Engineering pipeline.
disallowedTools: Task
tier: judgment
---
```

---

## フロントマターの契約と、あなたが下す判断

フィールドごとの完全なスキーマはリファレンスに置かれています。ここでは、1 つ書くときに実際に下す判断を挙げます。

**`name` はファイル名の語幹と一致しなければなりません。** `aidlc-data-governance-agent.md` のファイルは `name: aidlc-data-governance-agent` を宣言します。パーサーはこれを手がかりにし、不一致は、決して解決されないエージェントを書く最も簡単な道です。ローダーはファイルにまたがる重複したエージェントの `name` 値を拒否し、エラーで両方のファイルを示します。

**エージェントは既定でセッションのツールセット全体を継承します。** 出荷される 14 のどれも `tools:` の許可一覧を宣言しないので、それぞれがセッションの提供するすべてのツールに届きます。`Read`、`Edit`、`Write`、`Glob`、`Grep`、`AskUserQuestion`、`Bash`、`WebSearch`、そして継承した MCP ツールも同様です。ペルソナを絞るには、使ってよいツールだけを指定する任意の `tools:` 許可一覧を加えます。`tools:` を並べるとペルソナはそこに指定したツールだけに絞られ、完全修飾の `mcp__<server>__<tool>` id も指定しない限り、継承した MCP ツールは落ちます（下の MCP 継承の注記を参照）。これに手を伸ばすのは、ドメインが本当に小さな面を必要とするときだけにしてください。たいていのペルソナは、すべてを継承させるのが最善です。

**MCP サーバーは継承され、エージェントごとに付与されるものではありません。** プロジェクトルートの `.mcp.json` で宣言された 5 つの MCP サーバーはセッションに供給され、どのエージェントもそのすべてを自動で継承します。書くべきエージェントごとの付与はありません。ペルソナをあるサーバーから*遠ざける*には、その `tools:` 許可一覧を、そのサーバーを省いた完全修飾の `mcp__<server>__<tool>` 一覧に絞ります（素の `mcp__<server>` トークンは no-op で、サーバー単位の付与ではありません）。この継承と制限のモデルは `t110` レジストリ整合性テストで検査されます（[テスト](../reference/09-testing.md)を参照）。

**`disallowedTools` は `Task` を含まなければなりません。** これは任意ではありません。エージェントは委譲されたワーカーとして実行され、エンジンの `run-stage` ディレクティブが `mode: subagent` を運ぶとき、コンダクター（ライブの `/aidlc` セッション）が `Task` 呼び出しを行います。`Task` を許すと、エージェントが自分のサブエージェントを生成でき、フレームワークが防ぐために作られている委譲の連鎖を広げてしまいます。出荷される各エージェントは `Task` を禁じており、あなたのものもそうしなければなりません。Kiro の投影はこの Claude 専用のフロントマターキーを取り除き、Kiro のネイティブなエージェントツール設定を通じて、同じ入れ子委譲なしの境界を強制します。他の `disallowedTools` の値は、パッケージングに失敗するか、プラグイン compose の際にドロップログに記録されます。

**`tier` は作業の種類を指定し、パッケージャーがそれをハーネスごとの model/effort キーに投影します。** core エージェントのフロントマターに生の `model:` や `effort:` を書くことは決してありません。それらは、無視されるローカルの `dist/<harness>/` ツリーとバージョン管理されたリリースランタイムでの投影の出力で、`core/tools/aidlc-tiers.ts` のティア表から導かれます。下流へ波及する多制約の推論を行うペルソナには `judgment` を選びます。曖昧な意図の解釈、密なコンテキストの下での設計トレードオフの比較です。judgment エージェントは、明示的なモデルポリシーが上書きしない限り、セッションのモデル*と* effort を継承します。明示的な基準に対して新しい入力を判断するレビュアー型のペルソナには `balanced` を選びます。出力が主にパターン追従で、方法論がすでにエージェントの知識ファイルに符号化されているときだけ `templated` を選びます。デリバリープラン、CI/CD YAML、runbook の雛形のようにです。記録されたポリシーが無いと、`balanced` レビュアーティアは Claude Code では Sonnet を `medium` effort で使います。Codex と opencode ではセッションモデルを継承し、medium の推論 effort を適用します。`judgment` と `templated` はセッションモデルと effort を継承します。ウィザード既定の `balanced` プリセットはレビュアーティアとは別です。それは Deciding、Reviewing、Writing up に対して明示的に medium effort を設定し、それらのモデルは変えません。Kiro IDE、Cursor、Copilot はセッションを継承するので、ウィザードはそこにプリセットを記録せず、記録されたプリセットはそのグループ effort ダイヤルを未表現として報告します。Kiro CLI エージェントはセッションモデルとプリセットの 1 つのセッション effort を継承します。迷ったら `judgment` を使ってください。投影表（とプロジェクトの `tier_cap`）は後でいつでもコストを下げられますが、低すぎるティアで書かれたペルソナは静かに推論が足りなくなります。完全な投影表とキャップの上書きは[Agent System](../reference/05-agent-system.md)を参照してください。

残り 2 つのフィールドは、振る舞いではなく表示を駆動します。`display_name` はステータスラインが描く人が読めるラベルです（architect は "Architect Agent" と表示されます）。`examples` は agent→examples 表に文書化された、推奨の知識ファイル名を並べます。これらは*ユーザーに示される提案*で、ランタイムは決して読み込まず、エンジンはディスクに書きません。

必須/任意の正確な表と共有設定のマトリクスは、[Agent System: フロントマターの契約](../reference/05-agent-system.md#frontmatter-contract)を参照してください。

---

## 見えることは有効ではない: 2 段階の真実

これが心に刻むべき 1 つのことです。ファイルを置くとエージェントが*見え*、ステージに配線するとそれが*有効*になります。両方のステップが必要で、さもないと存在するのに決して実行されないエージェントになります。

- **発見が見えるようにします。** `.claude/tools/aidlc-lib.ts` の `loadAgents()` が、次の呼び出しで `.claude/agents/` の各ペルソナ `.md` ファイル（`aidlc-*` という名前のもの、または `display_name`、`examples`、`tier`、`plugin` を持つもの）を読み、メタデータのマップを導きます。コードの編集も登録ステップもありません。ファイルの存在が登録です。この時点からステータスラインはその表示名を描け、チームはその空間レベルの `aidlc/knowledge/<slug>-agent/` ディレクトリの下に標準を加えられます。
- **ステージ束縛がそれを有効にします。** ステージは、フロントマターの `lead_agent` / `support_agents` フィールドで、リードとサポートのエージェントを slug で指定します（`.claude/tools/data/stage-graph.json` にコンパイルされます）。どこかのステージがあなたの slug を参照するまで、どの `run-stage` ディレクティブもそれを指定せず、コンダクターはそのペルソナに決して委譲しません。

これはフレームワークの核となる非対称性を映しています。ステージはそのエージェントを指定し、エージェントは自分のステージを決して指定しません。だからエージェントファイルだけでは、設計上そのままでは動きません。新しいペルソナを働かせるには、それを使うべきステージを編集します。束縛の仕組みは[ステージの追加](02-adding-a-stage.md)に置かれています。

各エージェントは、あなたが `core/knowledge/aidlc-<slug>-agent/`（フレームワークの方法論）に書く知識ディレクトリと、空間レベルの任意のチームオーバーレイ `aidlc/knowledge/<slug>-agent/`（あなたの標準）とも対になります。空間レベルの `aidlc/knowledge/` ディレクトリは自由形式で、ブートストラップ時は空です。中身ができたとき、チームがエージェントごとのサブディレクトリを作ります。エンジンはそれを雛形で作りません。2 層の知識ワークフローは[チーム知識](07-team-knowledge.md)で扱います。

---

## ステップ

リファレンスのレシピを映して、ここにワークフローを端から端まで示します。

1. **エージェントファイルを作る** — `core/agents/<slug>-agent.md` を必須のフロントマターで作ります。`name`、`display_name`、`examples`、`description`、`disallowedTools`（`Task` を含む）、`tier` です。任意の `tools:` 許可一覧はペルソナを絞ります。省けばセッションのツールセット全体を継承します。
   任意の `maxTurns: <n>` はエージェントのターン予算を制限します。Claude Code では束縛的で、opencode のネイティブな `steps:` キーに投影され、Codex CLI、Cursor、GitHub Copilot、両方の Kiro 面では不活性（ペルソナ散文のみ）です。これらはエージェントごとのキャップキーを公開しません（Codex の TOML 発行はペルソナのフロントマター引用を書き換え、kiro エージェントの JSON はそのキーを決して受け取りません。未知のフィールドにはスキーマがフェイルクローズします）。2 つのレビュー専用エージェントが今日それを出荷します（対の慣習はレビュアーペルソナの `## Turn Budget` 節を参照）。
   本文は出荷ファイルの構造（Core Responsibilities、Collaboration、任意の Memory Focus、Key Principles）に合わせて書きます。
2. **知識ファイルを加える** — ペルソナが起動時に読み込むべき方法論を、`core/knowledge/aidlc-<slug>-agent/` の下に加えます。
3. **ステージに配線する** — リードまたはサポートする各ステージファイル（`core/aidlc-common/stages/<phase>/<slug>.md`）の `lead_agent` / `support_agents` フロントマターに slug を加え、`bun scripts/package.ts`（またはインストール済みツリーなら `aidlc engine graph compile`）で再生成して `stage-graph.json` を再生成します。`stage-graph.json` を手で編集しないでください。これはビルドアーティファクトで、次のコンパイルが手作業の変更を上書きします（[ステージの追加](02-adding-a-stage.md#4-regenerate-the-harnesses-so-stage-graphjson-recompiles)を参照）。これがそれを有効にするステップです。
4. **チーム知識ディレクトリを文書化する** — チームが空間レベルの `aidlc/knowledge/<slug>-agent/` の下に標準を加えることを記します。エンジンはこのディレクトリを作りません。中身ができたときチームが作ります（空間の `aidlc/knowledge/` は自由形式で、ブートストラップ時は空です）。
5. **手で保つドキュメント表を更新する** — Phase Participation マトリクスと agent→examples 表は自分で再生成しません（下の「何が自動で検証されないか」を参照）。

完全なレシピは、発見・intent-create・ステータスライン検証のコマンド付きで、[コントリビューション: エージェントの追加](../reference/11-contributing.md#adding-an-agent)にあります。既存のエージェントのツール、ティア、ステージ割り当てを、加えるのではなく変えるには、[Agent System: エージェントの変更方法](../reference/05-agent-system.md#how-to-modify-an-agent)を参照してください。

### 何が自動で検証されるか

- `loadAgents()` は、次の呼び出しで `.claude/agents/` の新しいペルソナ `.md` ファイルを発見します。コードの編集も登録もありません。ペルソナは `aidlc-*` という名前のファイル、またはフロントマターに `display_name`、`examples`、`tier`、`plugin` を持つものです。そこにある他のファイルはホスト自身のエージェントで、そのままにされます。
- ペルソナの `name` や `display_name` が欠けていると、パーサーは例外を投げ、ファイル、欠けたフィールド、そして（`aidlc-*` という名前でないファイルには）それをペルソナにしたキーを示します。
- エージェントは slug でアルファベット順に並べて返されるので、発見の順序はどのプラットフォームでも同じです。
- intent の作成は空間レベルの空の `aidlc/knowledge/` ディレクトリを作ります。エージェントごとのサブディレクトリや README を作りません。
- ステータスラインは導かれたメタデータから表示名を描きます。

### 何が自動で検証されないか

- **ステージグラフへの参加。** `stage-graph.json` はエージェントを slug で参照します。そこに配線せずエージェントを加えると、存在しても決して実行されません。発見と有効化は別のステップです。
- **知識ファイルの存在。** `examples` は agent→examples 表に文書化された推奨ファイル名です。何もそれを作らず検査しません。実際の中身は `aidlc/knowledge/<slug>-agent/`（空間レベルの知識ディレクトリ）の下に置きます。
- **手で保つドキュメント表。** [Agent System](../reference/05-agent-system.md#phase-participation)の Phase Participation マトリクスと、知識 README テンプレートの agent→examples 表は手で編集します。エージェントを加える同じ変更で更新してください。
- **エージェントファイルの本文。** パースされるのはフロントマターだけです。本文の散文は、起動時にエージェント自身が読むので、出荷される 14 に合わせて丁寧に書いてください。

---

## 次へ

[Scopes](04-scopes.md) — ある種類の作業について、どのステージ（したがってどのエージェント）が実行されるかを決めます。

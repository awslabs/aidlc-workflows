# Agent System

この章では、agent のアーキテクチャを記述します。agent がどう構造化され、設定され、フレームワークに読み込まれるか、そしてどう追加・変更するかです。

ユーザー向けの agent の説明については、[ユーザーガイド -- Agents](../guide/06-agents.md) を参照してください。

---

## agent の構造

記述された各 agent は、`core/agents/` にあるフラットな `.md` ファイルで、YAML frontmatter の後に markdown の本体が続きます。packager はそれらの persona を各ハーネスの agent 表層に投影します。conductor は、投影されたファイルを読んで、inline の作業や委譲実行を枠づけます。

### frontmatter の契約

記述された各コア agent ファイルは、YAML frontmatter で始まります。出荷された architect agent のもの（`core/agents/aidlc-architect-agent.md` から）は、次のとおりです。

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

| フィールド | 必須 | 説明 |
|-------|----------|-------------|
| `name` | はい | agent 識別子。ファイル名と一致しなければならない |
| `display_name` | はい | persona の人間向けの名前。statusline に表示される。agent ローダは、`name` のないものと同じく、これのない AI-DLC agent ファイルを拒否する |
| `examples` | いいえ | agent の team フォルダ用の、提案される知識ファイル名。2 つの reviewer と composer はどれも持たない |
| `description` | はい | 役割の簡潔な要約 |
| `tools` | いいえ | オプションの allowlist。省くとセッションのツール集合全体を継承する。一覧すると agent を絞り、`mcp__<server>__<tool>` の id も一覧しない限り継承された MCP ツールを落とす |
| `disallowedTools` | 記述済みコアでは必須 | `Task` を含まなければならない。委譲するのは conductor だけ。packager は、ハーネスが別のネイティブのツールポリシー表層を使うとき、この Claude 方言のキーを削除または翻訳する |
| `tier` | はい | `judgment`、`balanced`、`templated`。記述するダイヤル。packager がそれを各ハーネスのネイティブの model/effort キーに投影する（下の Agent Tiers 参照）。生の `model:`/`effort:` は記述済みの frontmatter に決して現れない。それらは、無視されるローカルな `dist/<harness>/` ツリーとバージョン付きリリース runtime における投影の出力である。 |

Kiro IDE は、このコア契約を別の形で投影します。`disallowedTools` を削除し、`tools: ["read", "write", "shell"]` を加え、ケイパビリティでスコープした `permissions.rules` を加えます。`tools:` から `subagent` を省くことが、IDE のネイティブの語彙で同じ no-nested-delegation の制約を運びます。

### markdown 本体のセクション

frontmatter の下、markdown の本体は次を定義します。

| セクション | 目的 |
|---------|---------|
| **Core Responsibilities** | agent が何をするか |
| **Collaboration** | Receives from / Works with / Hands off to |
| **Memory Focus** | 関連するとき参照すべき agent 固有の memory トピック |
| **Key Principles** | agent の振る舞いのガイドライン |

---

## 共有設定

14 の記述された agent すべてが、共通の設定ベースラインを共有します。Claude Code では、どれも `tools:` allowlist を宣言しないため、各 agent は **セッションのツール集合全体** とプロビジョニングされた MCP ツールを継承し、出荷時の拒否として `disallowedTools: Task` を持ちます。他のハーネスはその意図をネイティブの表層に投影します。Kiro agent の Markdown は `disallowedTools` を省き、Kiro CLI の委譲先 JSON は `tools` から `subagent` を省き、Kiro IDE の委譲先 `tools:` 付与も同様に委譲を除外します。

### Claude Code のセッションツール集合

すべての Claude Code agent は、組み込みツールを継承します。次を含みます。

| ツール | 目的 |
|------|---------|
| Read | ファイルシステムからファイルを読む |
| Edit | ファイル内で正確な文字列置換を行う |
| Write | ファイルシステムにファイルを書く |
| Glob | 高速なファイルパターンマッチング |
| Grep | ripgrep を使った内容検索 |
| AskUserQuestion | 対話的なユーザープロンプト（メインスレッドの stage のみ） |

### 共通の拒否された Claude Code ツール

| ツール | 理由 |
|------|--------|
| Task | agent は委譲された worker として動く。Task の呼び出しを行うのは SKILL.md の conductor だけ。Claude は `disallowedTools: Task` を強制する。他のハーネスはそのネイティブの deny/allowlist 相当を使う。 |

### 各 persona が行使すると期待されるツール

Claude Code では、すべての agent は継承によって Bash と WebSearch に *到達できます*。この表は、方法論がどの persona にそれらを stage の作業で使うと **期待する** かを記録するもので、agent ごとの付与ではありません。Claude の persona を本当に制限するには、オプションの `tools:` allowlist を加えます（`mcp__<server>__<tool>` の id も一覧しない限り、継承された MCP を落とします）。

| ツール | 行使すると期待される |
|------|---------------------|
| Bash | aidlc-aws-platform-agent, aidlc-devsecops-agent, aidlc-developer-agent, aidlc-quality-agent, aidlc-pipeline-deploy-agent, aidlc-operations-agent |
| WebSearch | aidlc-product-agent, aidlc-design-agent, aidlc-compliance-agent |

### Agent Tiers

すべての agent の、記述するダイヤルは `tier:` です。それは persona が行う作業の種類を指名し、packager（`bun scripts/package.ts`）がそれを各ハーネスのネイティブの model/effort の形に投影します。

| Tier | Agents | 意味 |
|------|--------|---------|
| `judgment` | architect, aws-platform, compliance, composer, design, developer, devsecops, product, quality | 曖昧さの下での多制約の推論。出力が下流にカスケードする。決して格下げされない。セッションの model と effort の両方を継承する |
| `balanced` | architecture-reviewer, product-lead | reviewer 型の作業。明示的な基準に対する新しい入力。Claude Code は計測された Sonnet/medium のベースラインを使う。Codex と opencode はセッション model を継承しつつ medium の推論 effort を適用する |
| `templated` | delivery, operations, pipeline-deploy | 支配的にパターンに従う出力。方法論は既に知識にある（delivery plan、CI/CD YAML、runbook）。tier は Writing up の models-dial グループのままだが、その出荷ベースラインはセッション model と effort を継承する |

記録されたモデルポリシーのない出荷投影（`core/tools/aidlc-tiers.ts` が唯一の情報源）は、次のとおりです。

| Tier | Claude Code (.md frontmatter) | Codex CLI (.toml) | Kiro CLI agent JSON / Kiro IDE `.md` | Kiro CLI cli.json `chat.modelDefaults` | opencode (.md frontmatter) | Copilot (.md frontmatter) | Cursor (.md frontmatter) |
|------|-------------------------------|-------------------|--------------------------------------|-------------------------------------|-----------------------------|-----------------------------|--------------------------|
| `judgment` | `model: inherit`、`effort:` 行なし | `model`/`model_reasoning_effort` キーなし（config.toml のセッションデフォルトが適用） | フィールド省略（スキーマのフォールバック: ユーザーのデフォルト model） | tier エントリなし | `model:`/`variant:` キーなし（opencode.json のセッションデフォルトが適用） | 省略（セッション model を継承） | `model:` 省略（セッション model を継承） |
| `balanced` | `model: sonnet`、`effort: medium` | model 省略、`model_reasoning_effort = "medium"` | フィールド省略（下記参照） | tier エントリなし | model 省略、`variant: medium` | 省略（セッション model を継承） | `model:` 省略（下記参照） |
| `templated` | `model: inherit`、`effort:` 行なし | `model`/`model_reasoning_effort` キーなし（config.toml のセッションデフォルトが適用） | フィールド省略（下記参照） | tier エントリなし | `model:`/`variant:` キーなし（opencode.json のセッションデフォルトが適用） | 省略（セッション model を継承） | `model:` 省略（下記参照） |

この表の背後にある主要な事実です。

- **省略が継承の仕組みです。** Claude Code では、`effort:` キーのない agent .md はセッションの effort を継承し、pin された `effort:` はセッションを両方向にオーバーライドします（pin は cap であり floor ではない）。そのため、モデルポリシーが記録されていないとき、不在が judgment と templated の出荷デフォルトです。Codex では、`model` のない role TOML は出荷された `.codex/config.toml` のセッションデフォルトで spawn します（codex-cli 0.139.0 と 0.142.5 でライブ検証済み。現在 doctor が助言する最小は、即時の compact-session リロードには 0.145.0）。Kiro では、agent-v1 スキーマが不在の `"model"` のフォールバックを文書化します。「指定されなければ、デフォルト model を使う」（`/model` の永続化された設定）。
- **preset は、tier とは別の、明示的なグループ effort ポリシーです。** ウィザードのデフォルトの `balanced` preset は Deciding、Reviewing、Writing up を `medium` に設定します。`minimal` は Deciding と Reviewing を `medium` に、Writing up を `low` に設定します。`thorough` は Reviewing を `xhigh` に設定し、Deciding と Writing up はセッションの effort を継承します。これらは model ID を決して設定しません。agent ごとの例外がグループのダイヤルをオーバーライドし、それがこの出荷 tier 表をオーバーライドします。Kiro IDE、Cursor、Copilot はグループの effort を表現できないものとして報告するため、ウィザードはそこに preset を記録しません。Kiro CLI では preset は 1 つのセッション effort で、その人の個人の Kiro 設定にセッション model とともに保存されます（[Session model and effort](../guide/harnesses/kiro-cli.md#session-model-and-effort)）。アップグレードの道については [Model Policy](../guide/18-install-and-lifecycle.md#model-policy) を参照してください。
- **Kiro は model を決して pin しません。** 出荷された Kiro model ID は、その model がユーザーのインストールで有効なときにのみ解決されます。他の model を実行するセッションは、委譲された spawn をすべて `Invalid model ID` で拒否し、Kiro は Claude 方言の tier エイリアス（`opus`/`sonnet`）を完全に拒否します。そのため、普遍的に安全に pin できる値はありません。したがって、すべての Kiro tier は `"model"`（と `.md` frontmatter の `model:` 行）を省きます。すべての agent がセッション model を継承します。`TIER_PROJECTIONS` の kiro スロットと `kiroModelDefaults()` の機構は、インストールごとに解決可能な pin の仕組みが現れた場合に備えて、休眠したまま残ります。その人自身の agent ごとの pin は別です。インストールが提供する model を指名します。kiro-ide の行では、`aidlc config models --agent` がその agent の `model:`（クォートされた文字列）と `effortLevel:` をその `.md` に書きます（`core/tools/aidlc-model-policy.ts` の `applyModelPolicyToProjection`）。v3 engine 上の Kiro CLI と Kiro IDE は、両方で委譲された agent を実行します。
- **レガシーの Kiro CLI の行には agent ごとの effort 表層がありません。** kiro-cli は agent JSON の effort 風のキーで fail-close するため、model ごとの effort デフォルトは `settings/cli.json` の `chat.modelDefaults[<modelId>].output_config.effort` にしか乗れません。model を pin する tier がないので、出荷された `cli.json` は `chat.modelDefaults` を持ちません。プロジェクトのマップがその人の個人マップ全体を置き換えるため、セッションの model と effort は、`aidlc config` が書くその人の個人の Kiro 設定にあります（`core/tools/aidlc-kiro-session.ts` 参照）。そのファイルは CLI 専用です。Kiro IDE は cli.json を完全に無視し、その拡張に埋め込まれた model ごとのデフォルト（またはユーザーの `/effort` のセッション状態）を適用します。
- **Cursor も model を決して pin しません。** Cursor での model の利用可能性は plan に依存するため（Free アカウントは指名された model をすべて拒否し `Auto` しか実行できない）、pin された agent model は低い plan でインストールをハード失敗させます。したがって、すべての Cursor tier は `.md` frontmatter の `model:` 行を省き（Cursor には agent ごとの effort キーがない。effort は model-id の接尾辞に乗る）、すべての agent がセッション model を継承します。`TIER_PROJECTIONS` の cursor スロットは model のみで、plan に依存しない pin の仕組みが現れた場合に備えて休眠しています。

### Tier cap（投影のオーバーライド）

プロジェクトは、どの agent ファイルも編集せずに、pack 時により低い tier 投影を選べます。これはタクソノミーの上限であり、templated ベースラインが継承する今、保証されたコストの上限ではありません。

- **永続的なノブ:** space memory レイヤーのファイル（`core/memory/org.md` -> `team.md` -> `project.md`。最後の writer が勝つ。プロジェクトは org の上限を下げても上げてもよい）の YAML frontmatter の `tier_cap:` キー。例: `tier_cap: balanced` は、すべてのハーネスの投影で `judgment` を計測された reviewer ベースラインに対応づけます。`templated` の上限は、より高い tier を継承する Writing up 投影に対応づけます。明示的に低コストのポリシーが目的なら `aidlc config models` を使います。
- **呼び出しごとのオーバーライド:** `AIDLC_TIER_CAP` 環境変数が、1 回の packager 実行で memory レイヤーに勝ちます（`AIDLC_TIER_CAP=templated bun scripts/package.ts`）。memory の cap が有効な間に一度 UNCAPPED でビルドするには、それを最上位 tier に設定します。`AIDLC_TIER_CAP=judgment` は memory レイヤーに勝ち、何もクランプしません（空の値は uncapped ではなく unset を意味します）。

2 つのノブはスコープが異なります。memory の cap はリポジトリとともに動くため、write モードと `--check` モードの両方で適用され、両方の一時的な check ビルドが同じリポジトリ定義の cap を使います。環境変数はワンショットの write ノブで、`--check` の下では無視されます。CI の迷子の `AIDLC_TIER_CAP` が決定性の計測を変えてはなりません。packager は、1 つを無視するとき notice を出力し、cap 付きのすべての write 実行で、アクティブな cap とそのソースを指名します。

代わりに 1 つの agent だけを対象外にするには、その model と effort を例外として記録します。`aidlc config models --agent <name> --model <id> --effort <value> --project --yes`。config はそれを投影された agent ファイルに書きます。そのファイルへの手編集は `aidlc config models --check` で drift として報告され、次の `aidlc config` が記録された値を戻します。

---

## Agent 比較マトリクス

次の 2 列の `Yes` は、継承されたツールの期待される使用を意味し、アクセスの付与ではありません。

| Agent | Bash の期待される使用 | WebSearch の期待される使用 | Tier | Lead Stages | Support Stages | Total |
|-------|-------------------|------------------------|------|-------------|----------------|-------|
| aidlc-product-agent | No | Yes | judgment | 5 | 3 | 8 |
| aidlc-design-agent | No | Yes | judgment | 2 | 2 | 4 |
| aidlc-delivery-agent | No | No | templated | 3 | 2 | 5 |
| aidlc-architect-agent | No | No | judgment | 7 | 3 | 10 |
| aidlc-aws-platform-agent | Yes | No | judgment | 2 | 5 | 7 |
| aidlc-compliance-agent | No | Yes | judgment | 0 | 4 | 4 |
| aidlc-devsecops-agent | Yes | No | judgment | 0 | 5 | 5 |
| aidlc-developer-agent | Yes | No | judgment | 2 | 4 | 6 |
| aidlc-quality-agent | Yes | No | judgment | 2 | 3 | 5 |
| aidlc-pipeline-deploy-agent | Yes | No | templated | 4 | 0 | 4 |
| aidlc-operations-agent | Yes | No | templated | 3 | 0 | 3 |

**観察:**
- aidlc-architect-agent が最も広い stage 関与を持ちます（3 フェーズにわたる 10 stage）。
- 14 agent の全名簿のうち、9 の agent が `judgment` tier を持ち、3 が継承する `templated` tier を持ち、2 つの `balanced` reviewer だけが Claude Code、Codex、opencode で格下げされます。Kiro、Cursor、Copilot では、すべての tier がセッション model と effort を継承します。上のマトリクスは、11 のドメイン専門家 agent を扱います。
- aidlc-compliance-agent は純粋に advisory の役割で動きます（4 support stage、lead stage なし）。
- 11 agent のうち 6 が、CLI 対話に Bash を使うと期待されます。
- 3 agent が、調査タスクに WebSearch を使うと期待されます。

---

## フェーズ参加

| Agent | Init (0) | Ideation (1) | Inception (2) | Construction (3) | Operation (4) |
|-------|----------|--------------|---------------|-------------------|---------------|
| aidlc-product-agent | -- | L (intent-capture, market-research, scope-definition), S (rough-mockups, approval-handoff) | L (requirements-analysis, user-stories), S (refined-mockups) | -- | -- |
| aidlc-design-agent | -- | L (rough-mockups) | L (refined-mockups), S (user-stories, domain-design) | -- | -- |
| aidlc-delivery-agent | -- | L (team-formation, approval-handoff), S (scope-definition) | L (delivery-planning), S (units-generation) | -- | -- |
| aidlc-architect-agent | -- | L (feasibility), S (intent-capture) | L (domain-design, units-generation, contract-design), S (reverse-engineering, delivery-planning) | L (functional-design, nfr-requirements, nfr-design) | -- |
| aidlc-aws-platform-agent | -- | S (feasibility) | S (domain-design, contract-design) | L (infrastructure-design), S (nfr-design) | L (environment-provisioning), S (feedback-optimization) |
| aidlc-compliance-agent | -- | S (feasibility) | -- | S (nfr-requirements, infrastructure-design) | S (environment-provisioning) |
| aidlc-devsecops-agent | -- | -- | S (practices-discovery) | S (nfr-requirements, infrastructure-design, build-and-test) | S (environment-provisioning) |
| aidlc-developer-agent | -- | -- | L (reverse-engineering), S (practices-discovery, user-stories) | L (code-generation), S (functional-design) | S (deployment-execution) |
| aidlc-quality-agent | -- | -- | S (practices-discovery, user-stories) | L (build-and-test), S (nfr-requirements) | L (performance-validation) |
| aidlc-pipeline-deploy-agent | -- | -- | L (practices-discovery) | L (ci-pipeline) | L (deployment-pipeline, deployment-execution) |
| aidlc-operations-agent | -- | -- | -- | -- | L (observability-setup, incident-response, feedback-optimization) |

L = Lead、S = Support

---

## agent を追加する方法

agent の表示名と例の知識ファイルは、各 agent の `.md` frontmatter の `display_name` と `examples` フィールドで権威を持ちます。TypeScript の編集は不要です。完全な手順（必須の frontmatter フィールド、検証ステップ、自動で検証されるものと手動のもの）については、[Contributing: Adding an Agent](11-contributing.md#adding-an-agent) を参照してください。ステップの簡単な要約です。

1. `core/agents/{name}-agent.md` を必須の frontmatter で作成します。`name`、`display_name`、`description`、`disallowedTools`（`Task` を含む）、`tier`、そして agent に提案される知識ファイルがあれば `examples` です。コア frontmatter に生の `model:`/`effort:` を決して記述しないでください。それらは投影の出力です（上の Agent Tiers 参照）。オプションの `tools:` allowlist は継承されたツール集合を絞ります。省けばセッションのツール集合全体を継承します。`core/tools/aidlc-lib.ts` の `loadAgents()` が、次の呼び出しでそのファイルを発見します。
   インストール済みの agents ディレクトリ（`.claude/agents/`、`.kiro/agents/`、`.cursor/agents/` など）はホストと共有され、ホストはそこから自身の subagent を読みます。`loadAgents()` は、名前が `aidlc-` で始まるか、その frontmatter に `display_name`、`examples`、`tier`、`plugin` のいずれかがあるとき、ファイルを AI-DLC persona として扱い、そうしたファイルには `name` と `display_name` が必要です。他のどのファイルもホストのものです。AI-DLC はそれを読み込まず、stage の `lead_agent` として指名できず、それが dispatch されても stage の rule を付けません。`aidlc doctor --verbose` は、それらのファイルを advisory として一覧します。
2. `core/knowledge/{name}-agent/` に知識ファイルを追加します
3. agent が参加する stage ファイル（`core/aidlc-common/stages/`）に agent を追加します。各 stage の frontmatter に `lead_agent` / `support_agents` を設定します。コンパイル済みの `tools/data/stage-graph.json` は、その frontmatter から `bun scripts/package.ts` が生成します。生成された出力を手編集しないでください。
4. `bun scripts/package.ts` で、無視されるローカルディストリビューションを生成し、その後 `--check` を実行して 2 回ビルドし、決定的な出力を検証します。
5. agent から examples への行を、手で保守される知識テーブルに追加します（agent の team-knowledge フォルダは `aidlc/spaces/<space>/knowledge/{name}-agent/` で、内容があるときにチームが作成します。engine はそれを scaffold しません）
6. テストを更新します。ファイルの存在の smoke テスト、stage-agent の相互参照の feature テストです
7. このファイルと [reference/agents/](agents/) のドキュメントを更新します

## agent を変更する方法

- **ツールを変える**: frontmatter で `tools:` allowlist を加えるか編集して agent を絞ります。省けばセッションのツール集合全体を継承します。`tools:` 一覧は、`mcp__<server>__<tool>` の id も一覧しない限り、継承された MCP ツールを落とします。
- **tier を変える**: `tier:` を `judgment`、`balanced`、`templated` に編集して再生成します（`bun scripts/package.ts`）。代わりにインストール済みのプロジェクトで 1 つの agent に特定の model を強制するには、`aidlc config models --agent <name> --model <id> --project --yes` を実行します（Claude Code はエイリアス、完全な id、`inherit` を受け付けます）。投影された agent ファイルへの手編集は、次の `aidlc config` が戻します。
- **振る舞いを変える**: markdown 本体のセクション（responsibilities、principles）を編集します。
- **stage の割り当てを変える**: 関連する stage ファイル（`core/aidlc-common/stages/`）の `lead_agent` / `support_agents` を編集し、その後 `bun scripts/package.ts` で再生成します。コンパイル済みの stage グラフは stage の frontmatter から導出され、手編集されません。

---

## 相互参照

- [Architecture](01-architecture.md) -- agent レイヤーを含む 5 層モデル
- [Knowledge System](10-knowledge-system.md) -- 知識の読み込み順
- [Agents Technical Reference](agents/) -- agent ごとの技術的な詳細
- [Stage Protocol](04-stage-protocol.md) -- agent persona 読み込みのルール

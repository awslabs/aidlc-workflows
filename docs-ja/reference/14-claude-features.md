# ハーネスプリミティブの対応付け

AI-DLC の方法論の概念はハーネス中立です。各 CLI ハーネスは、それらを自分のネイティブな
プリミティブで表現します。この章は、AI-DLC の概念を各ハーネスが使うプリミティブに対応付け、
その後 **Claude Code** の表現を詳しく説明します（最も充実して文書化されたハーネスです。
Kiro CLI、Kiro IDE、Codex、opencode、GitHub Copilot、Cursor は、同じ概念をそれぞれの同等物で
表現します。章ごとの要約は [Running on other harnesses](../guide/harnesses/README.md) に、
ハーネスを足すためのソースコントラクトは [Porting to a New Harness](../harness-engineering/09-porting-to-a-new-harness.md)
にあります）。

hook については [Hooks and Tools](06-hooks-and-tools.md) を、ナレッジについては
[Knowledge System](10-knowledge-system.md) を参照してください。

---

## 概念からプリミティブへの対応付け（ハーネスごと）

AI-DLC の概念が定数で、それを運ぶプリミティブがハーネスのパラメータです。新しいハーネスに
移植するときは、列を足してください。

| AI-DLC の概念 | Claude Code | Kiro CLI | Kiro IDE | Codex CLI | opencode | GitHub Copilot | Cursor |
|----------------|-------------|----------|----------|-----------|----------|----------------|--------|
| **オーケストレーターの入口**（`/aidlc` + ランナー） | Skills (`/aidlc`) | Skills (`/aidlc`) | Skills (`/aidlc`) | Skills (`$aidlc`) | Command → skill (`/aidlc`; skills from `.aidlc/skills` via `skills.paths`) | Skills (`/aidlc`; `.github/skills/`) | Native skills (`/aidlc` plus `/aidlc-status`, `/aidlc-jump`, `/aidlc-scope`; `.cursor/skills/`) |
| **エージェントペルソナ**（全 14 個） | `.claude/agents/*.md` | `.kiro/agents/*.json` + persona `.md` | Conductor `agents/aidlc-aidlc.md` + 14 persona `.md` files with `tools:`/`permissions.rules` | `.codex/agents/` TOMLs | `.opencode/agents/*.md` (subagents) + persona `.md` | `.github/agents/*.md` (custom agents) + persona `.md` | `.cursor/agents/*.md` (native subagents) |
| **自動化**（監査、状態、追跡） | Hooks via `settings.json` | Hooks via `agents/aidlc.json` | `.kiro/hooks/aidlc-*.json` (v2 hook files, Kiro IDE 1.x and Kiro CLI v3) | Hooks via `.codex/hooks.json` (one adapter) | Adapter plugin (`.opencode/plugin/`) | Hooks via `.github/hooks/aidlc.json` (one adapter) | Hooks via `.cursor/hooks.json` (one adapter) |
| **標準ルール**（層チェーン） | `aidlc/spaces/<active-space>/memory/` (via `.claude/rules/aidlc.md` @-import stub) | `aidlc/spaces/<active-space>/memory/` (via agent resources) | `aidlc/spaces/<active-space>/memory/` (via always-included steering that carries the memory text, with live references as the fallback) | `aidlc/spaces/<active-space>/memory/` (via `AIDLC_RULES_DIR`) | `aidlc/spaces/<active-space>/memory/` (via `instructions` glob) | `aidlc/spaces/<active-space>/memory/` (via `AGENTS.md` @-imports) | `aidlc/spaces/<active-space>/memory/` (always-applied `rules/aidlc.mdc` standing pointer + four agent-decided phase pointers) |
| **ハーネスオンボーディングドキュメント** | `.claude/CLAUDE.md` (full) | `.kiro/steering/aidlc-onboarding.md` (agent resource) | `.kiro/steering/aidlc-onboarding.md` (always-included) | `.codex/onboarding.md` (`developer_instructions` in trusted project `.codex/config.toml`) | `.aidlc/onboarding.md` (`instructions`) | `AGENTS.md` (full, with `@`-imports) | `.cursor/rules/aidlc-onboarding.mdc` (always-applied) |
| **権限 / 設定** | `.claude/settings.json` | `.kiro/settings/cli.json` + agent config | Agent `.md` `tools:` + `permissions.rules` frontmatter; `.kiro/settings/cli.json` asks Kiro CLI for its v3 engine (start it with `kiro-cli --v3`) | `.codex/config.toml` (+ Starlark `rules/`) | `opencode.json` (project root) | `trustedFolders` (`~/.copilot/config.json`) + `--allow-tool` flags | `.cursor/cli.json` (permissions) + `.cursor/hooks.json` |

Kiro CLI、Kiro IDE、Codex、opencode、Cursor は、バイト同一でハーネス中立なルート `AGENTS.md`
ブロックを共有します。ネイティブセットアップは上記のパスに存在します。Copilot は、その完全な
ルートオンボーディングを専用に保ちます。一方、Claude の完全なオンボーディングは `.claude/` の
中にとどまります。共有オンボーディングは、エンジンディレクトリの衝突を許しません。

その下にある決定的なエンジン、状態機械、監査ログ、ステージグラフ、swarm レフェリーは、
すべてのハーネスでバイト同一です。それらを運ぶプリミティブだけが異なります。この章の残りは、
各プリミティブの **Claude Code** の表現を詳しく説明します。Kiro CLI、Kiro IDE、Codex、
opencode、Copilot、Cursor の同等物については、それぞれのガイド章を参照してください。

---

## Claude 固有

以下のセクションは、Claude Code が特にどのように各プリミティブを表現するか — その skill
フロントマター、エージェント読み込みモード、`settings.json` ブロック、`.mcp.json` モデル —
を説明します。他のハーネスは、上の表のプリミティブを通じて同じ概念を運びます。仕組みが Claude
専用のところ（`companyAnnouncements` のウェルカムメッセージ、statusline コマンド、
`AskUserQuestion` ゲートウィジェット）は、そのように明示します。

---

## Skills

### 入口としての SKILL.md

オーケストレーターは `.claude/skills/aidlc/SKILL.md` に存在します。ユーザーは `/aidlc` コマンドでそれを呼び出します。ファイルは、メタデータを宣言するために YAML フロントマターを使います。

```yaml
---
name: aidlc
description: >
  AI-DLC. Start, resume, or manage an AI-driven
  development lifecycle.
argument-hint: "[description | --status | --config [section] | --stage <slug|#> | --phase <name|#> | --help]"
user-invocable: true
---
```

オーケストレーターのフロントマターは `hooks:` ブロックを運びません。すべてのフレームワーク hook は `settings.json` でプロジェクト全体に登録されるので、オーケストレーターと、パッケージ化された、または手書きのすべてのランナーは、ランナーごとの `hooks:` ブロックをコピーせずに決定的な背骨を継承します。

| フィールド | 目的 |
|-------|---------|
| `name` | skill を Claude Code のコマンドシステムに `/aidlc` として登録する |
| `description` | skill の発見とヘルプテキストに表示される |
| `argument-hint` | 受け付ける引数を示すために `/aidlc` の後に表示されるプレースホルダーテキスト |
| `user-invocable` | ユーザーが直接起動できるよう `true` に設定する |

SKILL.md の本体は、薄い転送ループ、つまり conductor です。オーケストレーションエンジン（`aidlc-orchestrate next`）を呼び、それが返す型付きディレクティブに従って動き（ステージを走らせる、質問する、swarm をファンアウトする）、結果を報告し（`report`）、繰り返します。ステージ間の決定 — セッション検出、スコープからステージへの対応、ステージグラフ、ルーティング、ステージ進行 — は、このファイルではなく、エンジンと、それが読むコンパイル済みデータ（`tools/data/stage-graph.json`、`scope-grid.json`）に存在します。[Engine and Skill System](17-skill-system.md) を参照してください。

### プロジェクト全体の hook

すべてのフレームワーク hook は `settings.json` でプロジェクト全体に登録されます（ワークフロー背骨の hook は、そこでセッションライフサイクルと statusline の hook に加わります）。各 hook は**自己ゲート**します。そのワークフローの動作は、ワークフローがアクティブなときだけ走るので、AI-DLC の外での通常の Claude Code 利用中は、レコードに何も書きません（使用量を畳む hook は、やはりそのセッションと使用量の記帳を保ちます）。完全な詳細については [Hooks and Tools](06-hooks-and-tools.md) を参照してください。

### 付随ファイル

SKILL.md は、共有のプロトコルファミリーとステージファイルを参照します。

- **`aidlc-common/protocols/stage-protocol.md`** -- 33 ステージすべてに必須の静的プロトコル。
- **条件付きプロトコルモジュール** -- reviewer、ensemble、Construction、swarm、recovery、governance のファイル。そのトリガーが発火したときだけ読み込まれる。
- `stages/initialization/`、`stages/ideation/`、`stages/inception/`、`stages/construction/`、`stages/operation/` の**ステージファイル** -- 33 個の個別ステージ定義。

---

## Agents

### エージェントファイルの形式

この実装は、AI-DLC のエージェントロールを、`.claude/agents/` のフラットな `.md` ファイルとして描画します — 14 ファイル: 11 のドメイン専門ペルソナ、2 のレビュー専用エージェント（product-lead、architecture-reviewer）、そして adaptive-workflows の composer です。それぞれ YAML フロントマターの後に markdown 本体が続きます。フロントマターは、エージェントがアクティブになったときの Claude Code の振る舞いを制御します。本体は、ペルソナ、責任、協調パターン、関連するメモリの焦点、主要な原則を提供します。パッケージャーは、投影されたファイルに、コンパクトで必須の委譲ナレッジのプリフライトを注入します。

完全なエージェントシステムの文書については、[Agent System](05-agent-system.md) を参照してください。

### インライン対サブエージェントの読み込み

conductor は、4 つのステージトポロジーにわたって、2 つのエージェント起動モード（ペルソナ採用と Task ディスパッチ）を使います。

**インライン実行（33 ステージ中 29 個）:**
conductor はエージェントの `.md` ファイルを読み、メインの会話の中で直接そのペルソナを採用します。ユーザーはエージェントとリアルタイムで対話します。

**ディスパッチ実行（4 ステージ: 2.1 pipeline、2.2 subagent、2.4 mob、3.5 subagent）:**
conductor は、Claude Code の Task ツール経由で別々の Claude インスタンスに委譲します。ディスパッチされた各エージェントは隔離して走り、プロンプト経由でコンテキストを受け取り、構造化されたサマリーを返します。ensemble の協力者はさらに、リードが統合する貢献ファイルを書きます。

| ステージ | Claude Code サブエージェント種別 | エージェント | 理由 |
|-------|---------------------------|-------|--------|
| 2.1 Reverse Engineering | `aidlc-developer-agent` then `aidlc-architect-agent`（pipeline、2 リンクチェーン） | aidlc-developer-agent + aidlc-architect-agent | 深いコード分析が大きな中間出力を生む |
| 2.2 Practices Discovery | lead、3 つの並列サポートスポーク、lead 統合（subagent ハブアンドスポーク） | pipeline-deploy + quality + developer + devsecops | 独立した実務の証拠、人間のインタビュー、その後の統制された統合 |
| 2.4 User Stories | product lead に加え並列の design/developer/quality mob | 4 参加者 | 人間の判断を伴う、境界づけられた協調的ストーリー精緻化 |
| 3.5 Code Generation | `aidlc-developer-agent` | aidlc-developer-agent | コード記述は、ユニット仕様に集中したクリーンなコンテキストから恩恵を受ける |

Workspace detection（0.2）は以前サブエージェントでした。今は `aidlc-utility intent-create` の中で決定的に走ります。

### エージェント層（投影されるモデル + effort）

すべてのエージェントのオーサリングダイヤルは `tier:` です。パッケージャーは、それを Claude Code が読む `model:`/`effort:` フロントマターキーに投影します。

| 層 | エージェント | Claude Code の投影 | 根拠 |
|------|--------|------------------------|-----------|
| `judgment` | architect、product、design、developer、quality、devsecops、compliance、aws-platform、composer（9） | `model: inherit`、`effort:` 行なし - セッションのモデルと effort が勝つ | 決定が下流に波及する多制約の推論 - アーキテクチャの境界、インテントの解釈、UX のトレードオフ、コード合成、脅威の優先順位付け、規制のエッジケース、クラウドアーキテクチャ |
| `balanced` | architecture-reviewer、product-lead（2） | `model: sonnet`、`effort: medium` | 明示的なチェックリストに対するレビュー。計測されたレビュアーのベースラインが、出荷された開示済みのステップダウン |
| `templated` | delivery、pipeline-deploy、operations（3） | `model: inherit`、`effort:` 行なし | 出力は、主にテンプレート化された計画表、CI/CD YAML、または可観測性／ランブックのスキャフォールディング。層は Writing up のダイヤルグループのままで、出荷ベースラインは継承する |

省略された `effort:` キーはセッションの effort を継承し、ピン留めされたものは両方向でセッションを上書きします（ピンは上限であって下限ではありません）。judgment と templated は既定で継承します。balanced は計測されたレビュアーのベースラインをピン留めします。インストールごとの Writing up のダウングレードを記録するには `aidlc config models` を使ってください。ハーネスごとの完全な投影表と `tier_cap` の上書きは、[Agent System](05-agent-system.md) に存在します。

---

## Rules

### 層化されたルールファイル

この実装は、アクティブスペースのメモリ層 `aidlc/spaces/<active-space>/memory/` から振る舞いのルールを読み、`.claude/rules/aidlc.md` の @-import スタブ経由で Claude のコンテキストに引き込みます。このスタブは、`aidlc/active-memory/` にある、それらのファイルのエンジンの git-ignore されたコピーをインポートします（セッション開始時とスペース切り替え時に書かれるので、切り替えは追跡されるファイルを変えません）。継承チェーンの層ごとに 1 ファイルです。

```
aidlc/spaces/<active-space>/memory/
├── org.md                        # framework defaults (shipped)
├── team.md                       # this team's affirmed practices
├── project.md                    # this project's specialization
└── phases/                       # rules scoped to a phase
    ├── ideation.md
    ├── inception.md
    ├── construction.md
    └── operation.md
```

各ファイルはトピックの `##` 見出し（Way of Working、Testing Posture、Deployment、Code Style、Forbidden、Mandated など）を運びます。ワークフロー開始時、コンパイルリゾルバはチェーン **org → team → project → phase → stage** を歩き、解決済みのルールセットを各ステージのグラフノードに焼き込みます。モデルは**厳格加算型**です。すべての層から、適用されるすべてのルールが、エージェントのコンテキストに同時に現れます。より狭い層が、より広い層を静かに上書きすることは決してありません。保たれた学習について、受け入れプロトコルは、決定的なライターが走る前に、提案されたテキストをより広いポリシーと LLM 検査で比較するようオーケストレーターに依頼します。その検査は、ライターが強制する境界ではなく、監査の補助です。ランタイムは競合を調停しません。権威あるレイアウト、スコープの導出、競合の意味は [Rule System](08-rule-system.md) に存在します。

**なぜ org/team ファイルが簡潔なままか:** Claude Code は、スペースメモリファイルを（`.claude/rules/aidlc.md` の @-import スタブ経由で）各会話に、AI-DLC でないものも含めて読み込みます。出荷される層を簡潔でトピックに沿った構造に保つことで、通常の開発セッションを汚染するのを避けます。上流の仕様がルールに置く詳細な方法論は、代わりに `.claude/knowledge/aidlc-shared/`、または SKILL.md と stage-protocol.md に存在し、`/aidlc` がアクティブなときだけ読み込まれます。

### 学習ループ

ルールファイルは静的ではありません。学習ループは、ワークフロー内の訂正を、次回のための標準ルールに変えます。分業は意図的です。LLM は、ステージが走る間、ステージの `memory.md` 日記に観察を書き（Interpretations / Deviations / Tradeoffs / Open questions）、その後オーケストレーターが受け入れの比較を行います。候補抽出と永続化は決定的なツールです。選択と競合の処理は人間の決定です。

1. **日記（LLM）。** ステージ中、観察は、インテントの記録ディレクトリ `<record>/<phase>/<stage>/memory.md`、ユニット単位のステージでは各ユニットの `<record>/construction/<unit>/<stage>/memory.md` に蓄積されます（`<record>/` = `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`）。
2. **surface（ツール）。** 承認ゲートで、`aidlc engine learnings surface` が日記を読み、構造化された候補を出します。LLM は再パースも分類もしません。
3. **確認（人間）。** conductor が候補を描画します。どれを保つか、そして自由記述の追加については、宛先を導出する単一の見出しを選びます。
4. **受け入れ検査（オーケストレーター LLM）。** オーケストレーターは、保たれた各学習を `org.md` の一致セクションと比較します。矛盾は、あなたが修正、スキップ、エスカレーションするために可視化されます。
5. **persist（ツール）。** `aidlc engine learnings persist --slug <stage> --selections-json <selections_file>` は、`surface` が名指しした `selections_file` だけから（他のパスは拒否）結果の選択を読み、`org.md` を読まずに、確定した各学習を実務として `aidlc/spaces/<active-space>/memory/{project,team}.md` に日付付きエントリとして書き、センサー結び付きの学習については、1 つのロックされたトランザクションの中でマニフェストとステージ `sensors:` インポートをインストールします。`RULE_LEARNED` / `SENSOR_PROPOSED` を出します。

利用者向けのウォークスルー（ワークサンプル付き）は [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) に、ハーネスエンジニアのオーサリングの観点は [Rules and the Learning Loop](../harness-engineering/05-rules-and-the-loop.md) にあります。

---

## CLAUDE.md

### プロジェクトレベルの指示

`.claude/CLAUDE.md` は、すべての会話に読み込まれるプロジェクトレベルの指示を提供します。AI-DLC では、ブートストラップドキュメントの役割を果たします。

**主要なセクション:**

| セクション | 内容 |
|---------|----------|
| Prerequisites | 自己完結した `aidlc`。アトミックなファイルシステムロック |
| AI-DLC Structure | skill、エージェント、ルール、ナレッジ、hook の場所 |
| Conventions | アーティファクトはインテントの記録ディレクトリ `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` の下へ。アプリケーションコードはワークスペースルートへ |
| Session Resumption | 起動時に `aidlc-state.md` を確認し、チェックポイントから続ける |
| Git Integration | コミット方針（下を参照） |

### Git 統合

```
Commit: aidlc/ workspace (memory layer, intents registry, per-intent
        aidlc-state.md, audit/ shards, and stage artifacts)
Gitignore:
  - aidlc/active-space, aidlc/spaces/*/intents/active-intent  (per-user cursors)
  - aidlc/.aidlc-clone-id, aidlc/.aidlc-sessions/             (machine-local)
  - aidlc/spaces/*/intents/*/runtime-graph.json              (re-derivable)
  - aidlc/spaces/*/intents/*/.aidlc-*
```

監査証跡は**クローンごとのシャード**（`audit/<host>-<clone>.md`）としてコミットされます。各クローンは自分のシャードに追記するので、並行する追記が git で競合することは決してありません。ユーザーごとのセッションカーソルとマシンローカルな導出状態は無視されます。

---

## Settings

### 権限の設定

`.claude/settings.json` は、呼び出しごとの権限プロンプトなしにワークフローが走るよう、Claude Code のツールを事前承認します。

```json
{
  "permissions": {
    "allow": [
      "Edit(/**)",
      "Bash(bun .claude/tools/aidlc.ts engine *)",
      "Bash(bun .claude/tools/aidlc.ts doctor)", "...",
      "Bash(bun .claude/tools/aidlc-log.ts)", "Bash(bun .claude/tools/aidlc-log.ts *)", "...",
      "Task", "WebSearch"
    ]
  }
}
```

これがないと、Claude Code は初回使用ごとに「このツールを許可しますか」とプロンプトし、ワークフローを妨げます。特にユーザーが直接対話していないサブエージェント委譲中に顕著です。

### ステータス行の設定

```json
"statusLine": {
  "type": "command",
  "command": "aidlc engine statusline"
}
```

ターミナルのステータスを最新に保つため、ツール使用時だけでなく定期的に走ります。AI-DLC は
この値を `.claude/settings.json` ではなく `.claude/tools/data/harness.json` に出荷します。
共有ファイルは各人自身のステータス行より上位なので、値は、セットアップで選ぶか
`/aidlc --statusline on` を実行したとき、各人自身の `.claude/settings.local.json` を通じてのみ
Claude Code に届きます（[Status line](../guide/13-customization.md#status-line-claude-code-and-codex) を参照）。

### SessionStart と SessionEnd の hook 設定

```json
"hooks": {
  "SessionStart": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "aidlc engine hook session-start"
    }]
  }],
  "SessionEnd": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "aidlc engine hook session-end"
    }]
  }]
}
```

すべてのフレームワーク hook と同じく、`settings.json`（プロジェクト全体）に登録されます。セッションライフサイクルのイベントは、いずれにせよプロジェクト全体でなければなりません。`/aidlc` がアクティブになる前に発火し、それが終了した後にも発火するからです。`aidlc-session-start.ts` は resume コンテキストを注入し、`aidlc-session-end.ts` は監査の完全性のために `SESSION_ENDED` を出します。

### 個人設定の上書き

`.claude/settings.local.json`（gitignore）は、リポジトリに影響を与えずに共有設定を上書きします。

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

---

## MCP サーバー

### サーバーレジストリとしての .mcp.json

この実装は、その Model Context Protocol（MCP）サーバーを、`.claude/` の中ではなくその隣の、プロジェクトルートの `.mcp.json` で宣言します。ファイルは、サーバー名をそのトランスポートと起動設定に対応付けます。

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    },
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "AWS_REGION=us-east-1"
      ]
    },
    "aws-pricing": { "command": "uvx", "args": ["awslabs.aws-pricing-mcp-server@latest"] },
    "aws-iac": { "command": "uvx", "args": ["awslabs.aws-iac-mcp-server@latest"] },
    "aws-serverless": { "command": "uvx", "args": ["awslabs.aws-serverless-mcp-server@latest"] }
  }
}
```

出荷される 5 つのサーバーは、フレームワークのエージェントが手を伸ばす統合をカバーします。

| サーバー | トランスポート | 認証 | 目的 |
|--------|-----------|------|---------|
| `context7` | HTTP | `${CONTEXT7_API_KEY}` env パススルー | ライブラリ/SDK ドキュメント検索 |
| `aws-mcp` | `uvx`（`mcp-proxy-for-aws@latest`、`AWS_REGION=us-east-1`） | 標準の AWS 認証情報チェーン | AWS API アクセス |
| `aws-pricing` | `uvx`（`awslabs.aws-pricing-mcp-server@latest`） | AWS 認証情報チェーン | AWS 価格 |
| `aws-iac` | `uvx`（`awslabs.aws-iac-mcp-server@latest`） | AWS 認証情報チェーン | Infrastructure-as-code ツール |
| `aws-serverless` | `uvx`（`awslabs.aws-serverless-mcp-server@latest`） | AWS 認証情報チェーン | サーバーレスツール |

レジストリは、環境変数のプレースホルダーだけを運びます。コミットされた秘密はありません。認証情報はあなたのシェルを通じて流れます。`context7` は環境から `CONTEXT7_API_KEY` を読み、`uvx` で起動される 4 つの AWS サーバーは、あなたの標準の AWS 認証情報チェーンに対して認証します（`uv`/`uvx` は `curl -fsSL https://astral.sh/uv/install.sh | sh` でインストール）。認証情報を持たないサーバーは、単にそのセッションで利用できないだけで、ワークフローをブロックすることは決してありません。

`.mcp.json` がプロジェクトルートに存在するのは、それが Claude Code がプロジェクトスコープの MCP サーバーのために読むパスだからです。AI-DLC は、バージョン管理されたランタイムを持つネイティブの `aidlc` バイナリとしてインストールされ、`aidlc config` が `.claude/` ツリーをプロジェクトに敷きます（コピーチャネルは同じツリーをアーカイブとして出荷します）。これは Claude Code プラグインではありませんが、プロジェクトルートの `.mcp.json` の配置は、正規のプラグインの場所でもあるので、レジストリは変更なしにプラグインへ移植できます。

### プロビジョニングと継承

アクセスモデルは、プロビジョニングの後に継承が続くもので、その間に付与ステップはありません。

1. **一度宣言する。** サーバーはプロジェクトルートの `.mcp.json` に列挙されます。
2. **セッションにプロビジョニングする。** Claude Code は宣言されたサーバーを起動し、そのツールを `mcp__<server>__<tool>` の id としてセッションに公開します。
3. **どこでも継承する。** サブエージェントは、既定ですべてのセッション MCP ツールを継承します。AI-DLC のすべてのエージェント — インラインで走るものも、委譲されたサブエージェント（ディスパッチされるステージ 2.1、2.2、2.4、3.5 とその協力者）として走るものも — は、宣言されたすべてのサーバーに到達します。

エージェントごとの付与ステップはなく、必要でもありません。継承が既定で、すべてのエージェントにわたって加算的です。新しいエージェントファイルは、そのフロントマターにサーバーを列挙するからではなく、存在するだけで MCP アクセスを得ます。

### なぜエージェントごとの付与がないのか

これが荷重を担う教訓で、再び議論されないよう平易に述べる価値があります。**MCP アクセスは、追加によってエージェントに付与できません。継承されるもので、唯一のレバーは制限です。** Claude Code 2.1.159 に対する実証的なスパイクが境界を確立しました。

- エージェントは、フロントマターでサーバーを*名指し*しても何も得ません。加算的な付与フィールドはありません。継承がすでにエージェントにすべてのセッション MCP ツールを与えています。
- エージェントがサーバーを使うのを*防ぐ*には、その `tools:` 許可リスト（本物の Claude Code フロントマターフィールド）を、呼び出しを許される完全修飾の `mcp__<server>__<tool>` id に絞ります。内容のある `tools:` リストからツールを省くことが、それを拒否するものです。
- 裸の `mcp__<server>` トークンは**尊重されません**。サーバーレベルのワイルドカードはありません。完全修飾の `mcp__<server>__<tool>` id だけが一致します。
- `disallowedTools` は、拒否リスト側の本物の、動くフィールドです。この実装は、ネストしたサブエージェントの spawn をブロックするために `disallowedTools: Task` を使います。その拒否は MCP サーバーアクセスに影響しません。

スパイクは、別のフロントマターの罠も明らかにしました。`allowedTools` は Claude Code のサブエージェントフィールドとして認識**されず**、静かに無視されます。`allowedTools: Read` を宣言するエージェントも、やはり MCP ツールに到達し、継承全部と同じく振る舞いました。一方、同じエージェントが `tools: Read` では正しくそれを拒否しました。そのため、静かに無視される `allowedTools` フィールドは、出荷されるすべてのエージェントファイル（`.claude/agents/*.md`）から削除されました。エージェントは今、意図的にセッションのツールセット全体 — 組み込みツールも MCP ツールも — を継承し、宣言される唯一の制限は `disallowedTools: Task` です。文書化されたオプトインの絞り込みは、本物の `tools:` 許可リストで、完全修飾の `mcp__<server>__<tool>` id も列挙しない限り、継承した MCP を落とします。そのため継承全部は今、無視されるフィールドの事故ではなく、意図的で文書化されたモデルです。今日、すべてのエージェントが、宣言されたすべてのサーバーに到達します。

### settings.json の権限との関係

2 つの設定ファイルは異なる問いに答え、重なりません。

- `.claude/settings.json` の `permissions.allow` は、*組み込みの Claude Code ツール*（プロジェクト内のファイル編集、AI-DLC 自身のコマンド、Task、WebSearch）を事前承認し、セッションが初回使用でプロンプトしないようにします（上の [Settings](#settings) を参照）。MCP サーバーについては何も言いません。
- `.mcp.json` は、*どの MCP サーバーが存在するか*とその起動方法を宣言します。プロビジョニングと継承は、`settings.json` ではなく Claude Code の MCP 層が統制します。

セッションに MCP サーバーが現れるのは、`settings.json` の許可リストエントリではなく、`.mcp.json` と利用できる認証情報の関数です。エージェントごとの絞り込みは、配線されるとき、`settings.json` でも `.mcp.json` でもなく、エージェントの `tools:` フロントマターに存在します。

---

## 機能の相互作用マップ

| 機能 | ファイル | いつ読み込まれるか | 役割 |
|---------|---------|---------------|------|
| CLAUDE.md | `.claude/CLAUDE.md` | すべての会話 | ブートストラップ: 構造、前提条件、慣習 |
| Settings | `.claude/settings.json` | すべての会話 | Claude Code のツールを事前承認 |
| Rules | `aidlc/spaces/<active-space>/memory/*.md`（`.claude/rules/aidlc.md` の @-スタブ経由） | すべての会話 | 最小限のガードレール。自己学習の訂正 |
| Skill | `.claude/skills/aidlc/SKILL.md` | `/aidlc` 呼び出し時 | オーケストレーター: セッション、スコープ、委譲 |
| Skill annex | `.claude/skills/aidlc/composer.md` | エンジンの出力が composer エージェントを名指しするとき | ワークフロープランの作成: ディスパッチ、提案ゲート、承認が走らせるもの |
| Skill tables | `.claude/skills/aidlc/tables.md` | 読み込まれない。人間が読めるデータ | 生成されたスコープとステージの表（エンジンはコンパイル済みのグリッドとグラフからルーティングする） |
| ワークフロー背骨の hook | `.claude/settings.json` | 常にオン。ワークフローがないとき自己ゲート | PostToolUse、PreCompact、SubagentStop、Stop |
| Agents（インライン） | `.claude/agents/*.md` | ペルソナ起動 | 33 ステージ中 29 個: conductor がエージェントペルソナを採用 |
| Agents（ディスパッチ） | `.claude/agents/*.md` | Task ツール委譲 | 4 ステージ（2.1 pipeline、2.2 subagent、2.4 mob、3.5 subagent）: 隔離された実行 |
| Knowledge（第 1 層） | `.claude/knowledge/` | ペルソナ起動（ステップ 2-3） | 61 の方法論リファレンスファイル |
| Knowledge（第 2 層） | スペースレベルの `aidlc/knowledge/`（`intents/` の兄弟） | ペルソナ起動（ステップ 4-5） | チームが管理するカスタマイズ |
| Stage protocol | `stage-protocol.md` + 条件付きモジュール | すべてのステージの静的コア。モジュールはトリガー時 | 必須の振る舞いのコントラクト |
| Stage files | `stages/**/*.md` | エンジンのルーティング | 33 個の個別ステージ定義 |
| State file | `aidlc-state.md` | セッション開始時とその後ずっと | 永続的なワークフロー状態 |
| Audit shards | `<record>/audit/<host>-<clone>.md` | 実行を通じて | 追記専用の監査証跡。クローンごとに 1 シャード |

### 読み込みの並び

ユーザーが `/aidlc feature` を実行するとき:

```
1.  CLAUDE.md loads              (every conversation)
1a. statusLine command starts    (settings.local.json, when the person chose it -- runs continuously)
2.  settings.json loads          (every conversation; all hooks register here, project-wide)
2a. SessionStart hook fires      (settings.json -- if session resume)
3.  memory/ rules load            (every conversation)
4.  SKILL.md activates           (skill invocation -- the conductor)
5.  Conductor calls the engine   (`aidlc-orchestrate next $ARGUMENTS`)
6.  Engine reads state + graph   (decides the move, emits a typed directive)
7.  Conductor acts on directive  (run-stage: load agent .md + knowledge, run the body)
8.  Stage executes               (stage work)
9.  Hooks fire as needed         (Claude Code tool calls, compaction, subagent stop)
10. Conductor reports the outcome (`aidlc-orchestrate report` -- commits state)
11. Loop back to step 5          (next directive) until the engine emits the final `done`
```

ステップ 1-2a は、AI-DLC でないものも含め、すべての会話で起きます。そして、すべての hook が（skill 起動時ではなく）`settings.json` でプロジェクト全体に登録されるので、決定的な背骨は `/aidlc` が呼び出される前に整っています。各 hook は、ワークフローがアクティブでないとき、そのワークフローの動作を自己ゲートします。ステップ 3 はルール層を読み込みます。ステップ 4 以降は、ユーザーが `/aidlc` を呼び出したときだけワークフローをセットアップして駆動します。ステップ 5-11 はディレクティブごとに繰り返され、各反復が何をするかは、SKILL.md ではなくエンジンが決めます。

---

## 相互参照

- [Architecture](01-architecture.md) -- すべての機能層を含む 5 層モデル
- [Orchestrator](03-orchestrator.md) -- SKILL.md の掘り下げ
- [Agent System](05-agent-system.md) -- エージェントのフロントマター、ツール制限、エージェント層
- [Hooks and Tools](06-hooks-and-tools.md) -- hook システム、監査分類、CLI ツール
- [Knowledge System](10-knowledge-system.md) -- 2 層のナレッジ、読み込み順序
- [Porting to a New Harness](../harness-engineering/09-porting-to-a-new-harness.md) -- 上の対応付けに列を足す方法: マニフェスト、hook アダプター、`emit.ts` コントラクト
- [Running on other harnesses](../guide/harnesses/README.md) -- これらのプリミティブの Kiro CLI、Kiro IDE、Codex、Cursor、opencode、Copilot での表現

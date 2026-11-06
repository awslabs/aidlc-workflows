# ツール横断のプラグインマニフェスト比較

> **Addendum to Codex Manifest Shape Report** | June 26, 2026  
> **Sources**: OpenAI Codex ドキュメント、Anthropic Claude Code ドキュメント、Cursor 公式プラグインリポジトリ、OpenCode ドキュメント、HuggingFace Context Course  
> **比較対象のプラットフォーム**: Codex、Claude Code、Cursor、OpenCode、Pi

---

## プラットフォームのアーキテクチャモデル

AI コーディングツールのエコシステムは、2 つの基本的なアプローチに分かれます。

| モデル | プラットフォーム | 特徴 |
|-------|-----------|-----------------|
| **マニフェストファースト** | Codex、Claude Code | 宣言的な JSON マニフェスト + ルートレベルのコンポーネントディレクトリ。インストール時にコードは実行されません。 |
| **コードファースト** | OpenCode | JS/TS モジュールがフック関数をエクスポートします。プラグイン自体がコードです。 |
| **IDE 拡張** | Cursor（VS Code フォーク） | VS Code の拡張モデルを継承し、新しいプラグイン仕様を加えます |
| **パッケージベース** | Pi | 規約ベースのディレクトリを持つ `package.json` |

---

## マニフェストの並列比較

### Codex `.codex-plugin/plugin.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "description": "Text analysis skills",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Text Processor",
    "shortDescription": "Analyze text with AI",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": ["Analyze this text for readability"],
    "brandColor": "#10A37F",
    "logo": "./assets/logo.png"
  }
}
```

### Claude Code `.claude-plugin/plugin.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "description": "Text analysis skills",
  "author": { "name": "Your Name" }
}
```

**注目点**: Claude Code のマニフェストははるかに簡素です。コンポーネントは、明示的なパスで指し示すのではなく、規約（ディレクトリの存在）によって発見されます。`interface` オブジェクトはありません。

### OpenCode（マニフェストなし — コードがプラグイン）

```typescript
// .opencode/plugins/text-processor-plugin.ts
import type { Plugin } from "@opencode-ai/plugin"

export const TextProcessorPlugin: Plugin = async ({ project, client, $, directory }) => {
  return {
    "tool.execute.before": async (input) => {
      if (input.tool === "read") {
        await client.app.log({ body: { message: "Consider text analysis" } })
      }
    }
  }
}
```

### Pi `package.json`

```json
{
  "name": "text-processor-plugin",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"],
    "extensions": ["./extensions"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

---

## ディレクトリ構造の比較

### Codex
```
my-plugin/
├── .codex-plugin/
│   └── plugin.json          ← Manifest (ONLY file here)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── .mcp.json                ← MCP server config
├── .app.json                ← App/connector config  
├── hooks/
│   └── hooks.json
└── assets/
    ├── logo.png
    └── screenshot-1.png
```

### Claude Code
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          ← Manifest (ONLY file here)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── agents/                  ← UNIQUE: agent definitions
│   └── reviewer.md
├── .mcp.json                ← MCP server config
├── .lsp.json                ← UNIQUE: LSP server config
├── hooks/
│   └── hooks.json
├── monitors/                ← UNIQUE: background monitors
│   └── monitors.json
├── themes/                  ← UNIQUE: color themes
│   └── dracula.json
└── README.md
```

### OpenCode
```
my-project/
├── .opencode/
│   ├── plugins/
│   │   └── text-processor.ts   ← Plugin IS the code
│   └── package.json
├── opencode.json               ← npm plugin references
└── README.md
```

### Pi
```
my-package/
├── package.json                ← Manifest (no hidden dir)
├── skills/
│   └── analyze-text/
│       └── SKILL.md
├── extensions/                 ← Runtime TS/JS extensions
│   └── text-processor.ts
├── prompts/
└── themes/
```

---

## マニフェストのフィールド比較

| フィールド | Codex | Claude Code | OpenCode | Pi |
|-------|-------|-------------|----------|-----|
| **場所** | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` | N/A（コードファースト） | `package.json` |
| **必須** | `name` のみ | `name` のみ | N/A | `name` |
| **name の形式** | kebab-case | kebab-case | モジュールのエクスポート | npm スタイル |
| **version** | 任意（semver） | 任意（semver または git SHA） | N/A | 必須（semver） |
| **コンポーネントのポインター** | 明示的（`"skills": "./skills/"`） | 規約ベース（ディレクトリを自動検出） | N/A | 明示的（`"pi": {"skills": [...]}`） |
| **Interface/UI のメタデータ** | 豊富な `interface` オブジェクト（15 フィールド） | なし — マーケットプレイスのメタデータは marketplace.json | N/A | なし |
| **MCP の設定** | `.mcp.json`（マニフェストが指し示す） | `.mcp.json`（ルートで自動検出） | 別個の設定 | 任意の `.mcp.json` |
| **パスのルール** | `./` で始まり、`..` 不可 | `./` で始まり、`..` 不可 | N/A | 標準の node 解決 |
| **前方互換** | `extra` マップが未知を保持 | 認識されないフィールドは検証に失敗 | N/A | 標準の JSON |
| **検証** | SDK（Elixir） — 寛容で extra を保持 | 厳格なスキーマ — 未知を拒否 | N/A | npm の検証 |

---

## サポートされるコンポーネントの種類

| コンポーネント | Codex | Claude Code | OpenCode | Cursor | Pi |
|-----------|:-----:|:-----------:|:--------:|:------:|:---:|
| Skills（SKILL.md） | ✅ | ✅ | ❌（代わりに hooks） | ❌ | ✅ |
| MCP Servers | ✅ | ✅ | ❌（別個） | ✅（消費側） | ✅（アダプター経由） |
| App Connectors | ✅（.app.json） | ❌ | ❌ | ❌ | ❌ |
| Lifecycle Hooks | ✅ | ✅（30 以上のイベント） | ✅（25 以上のイベント） | ❌ | ❌ |
| Agents/Subagents | ❌ | ✅（agents/） | ❌ | ❌ | ❌ |
| LSP Servers | ❌ | ✅（.lsp.json） | ❌ | ❌（VS Code ネイティブ） | ❌ |
| Monitors | ❌ | ✅（実験的） | ❌ | ❌ | ❌ |
| Themes | ❌ | ✅（実験的） | ❌ | ❌（VS Code ネイティブ） | ✅ |
| Custom Tools | ❌（MCP 経由） | ❌（MCP 経由） | ✅（コード内） | ❌ | ✅（extensions 内） |

---

## 配布モデル

| 観点 | Codex | Claude Code | OpenCode | Cursor |
|-----------|-------|-------------|----------|--------|
| **主な配布** | Git リポジトリ | Git リポジトリ | npm + ローカルファイル | VS Code Marketplace（OpenVSX） |
| **マーケットプレイスの形式** | `marketplace.json`（JSON カタログ） | `marketplace.json`（JSON カタログ） | `opencode.json` の配列 | `.vsix` パッケージ |
| **スコープ** | Official、Repo、Personal | User、Project、Local、Managed | プロジェクトローカル | グローバル |
| **インストールキャッシュ** | `~/.codex/plugins/cache/` | `~/.claude/plugins/` | `node_modules` | `~/.vscode/extensions/` |
| **オフラインのサポート** | ✅（キャッシュが残る） | ✅（キャッシュが残る） | ✅（npm キャッシュ） | ✅ |
| **バージョンのピン留め** | マーケットプレイスエントリの `ref`/`sha` | git SHA または明示的なバージョン | npm semver | 拡張のバージョン |
| **CLI インストール** | `codex plugin install` | `claude plugin install` | npm install | ext install |
| **マーケットプレイスの CLI** | `codex plugin marketplace add` | （marketplace.json ファイル） | N/A | N/A |
| **ポリシーの制御** | `AVAILABLE`/`PREINSTALLED`/`HIDDEN` | スコープ付きの設定 | N/A | N/A |

---

## フック／イベントのシステム

| 側面 | Codex | Claude Code | OpenCode |
|--------|-------|-------------|----------|
| **イベント数** | 約 5〜6（SessionStart、Turn*、ToolCall*） | 30 以上のイベント | 25 以上のイベント |
| **フックの種類** | `command` のみ | `command`、`http`、`mcp_tool`、`prompt`、`agent` | JS/TS のハンドラー関数 |
| **信頼モデル** | 非管理（ユーザーの明示的な信頼が必要） | 非管理（明示的な信頼） | 自動ロード（プロジェクト内のコード） |
| **環境変数** | `PLUGIN_ROOT`、`PLUGIN_DATA` | `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_PROJECT_DIR` | コード内のコンテキストオブジェクト |
| **イベントマッチャー** | N/A | 正規表現パターン（例: `"Write|Edit"`） | ツール名のマッチング |
| **ブロック** | 不可 | 可（PreToolUse がブロックできる） | 可（before フックがブロックできる） |

---

## 主要なアーキテクチャの違い

### 1. 明示的なポインター vs 規約による発見

**Codex** は明示的なマニフェストのポインターを必要とします。
```json
{ "skills": "./skills/", "mcpServers": "./.mcp.json" }
```

**Claude Code** はディレクトリの存在で自動発見します。プラグインルートに `skills/` があれば、skills がロードされます。マニフェストに必要なのは `name` だけです。これにより Claude Code のプラグインは作りやすくなりますが、挙動を把握しにくくなります（暗黙の挙動）。

### 2. Interface のメタデータ: Codex だけ

Codex には、マーケットプレイス提示のための豊富な `interface` オブジェクト（ブランドカラー、ロゴ、スクリーンショット、スターターのプロンプト）があります。Claude Code のマニフェストには**等価なもの**がありません。すべての提示メタデータは、プラグイン自体ではなくマーケットプレイスのエントリに置かれます。

**なぜ重要か**: Codex のプラグインは、マーケットプレイスの目的において自己記述的です。Claude Code のプラグインは、発見しやすさをそのマーケットプレイスのエントリに依存します。

### 3. App Connectors: Codex 専用

Codex だけが、サードパーティサービスの認証（OAuth、API キー）のための `.app.json` を持ちます。Claude Code、OpenCode、Cursor は、プラグインシステムに認証コネクターを同梱せず、外部サービスの統合は MCP サーバーが扱うことを期待します。

**なぜ重要か**: Codex は「Slack/GitHub/Figma への接続」を、第一級のプラグインの関心として扱います。ほかはこれを完全に MCP へ委ねます。

### 4. Subagents: Claude Code 専用

Claude Code だけが、エージェント定義（モデルの選択、ツールの制限、分離）を持つ `agents/` ディレクトリをサポートします。Codex にエージェントの同梱はなく、その「サブエージェント」の概念はプラグインシステムの外で動きます。

### 5. LSP + Monitors + Themes: Claude Code の幅広さ

Claude Code は最も豊富なコンポーネントサーフェスを持ちます。LSP サーバー（リアルタイムのコードインテリジェンス）、monitors（バックグラウンドの stdout ウォッチャー）、themes です。これらにより Claude Code のプラグインは、完全な IDE 拡張に近づきます。Codex はより狭いが、よりすっきりしています。

### 6. 検証の哲学

| | Codex | Claude Code |
|--|-------|-------------|
| 未知のキー | `extra` マップに**保持** | **拒否** — 検証が失敗する |
| 前方互換 | ✅ ラウンドトリップを生き延びる | ❌ 未知を取り除かなければならない |
| 厳格さ | 寛容（name だけが必須） | 厳格（スキーマを強制） |

これは大きな分岐です。Codex のプラグインは、前方互換の実験的なフィールドを運べます。Claude Code の厳格な検証は、古いツールが新しいマニフェストの機能で壊れることを意味します。

### 7. ツール横断の可搬性

| 層 | 可搬か | 注記 |
|-------|-----------|-------|
| MCP サーバー | ✅ 普遍的 | 同じ `.mcp.json` が Codex、Claude Code、Cursor をまたいで動く |
| Skills（SKILL.md） | 🟡 ほぼ可搬 | 同じ形式だが、自動発見／起動が異なる |
| Hooks | ❌ ツール固有 | イベントが異なり、スキーマが異なる |
| マニフェスト | ❌ ツール固有 | `.codex-plugin/` ≠ `.claude-plugin/` |
| マーケットプレイス | 🟡 ほぼ可搬 | 同じ JSON 形式だが、パスが異なる |

**MCP が普遍的な相互運用の層です。** よく作られた MCP サーバーは、すべてのツールをまたいで動きます。MCP より上のすべて（skills、hooks、マーケットプレイスのメタデータ）はツール固有ですが、機能的なロジック（MCP サーバーのコード）は write-once、run-anywhere です。

---

## まとめ: どのモデルをいつ使うか

| したいこと | 最適なプラットフォームのモデル |
|----------------|-------------------|
| 宣言的で検査可能なプラグイン | Codex または Claude Code（マニフェストファースト） |
| 豊富なマーケットプレイス提示 | Codex（interface オブジェクト） |
| 最大限のコンポーネントの多様さ | Claude Code（agents、LSP、monitors、themes） |
| チーム横断の配布 | Codex または Claude Code（Git マーケットプレイス） |
| コードレベルのフック制御 | OpenCode（プログラム的なフック） |
| IDE ネイティブの拡張 | Cursor（VS Code モデル） |
| MCP の可搬性 | すべて（MCP は普遍的） |
| 前方互換のスキーマ | Codex（extra マップ） |
| 厳格な検証の安全性 | Claude Code（未知を拒否） |
| サードパーティサービスの認証 | Codex（.app.json コネクター） |

---

## 収束のテーゼ

表面上の違いにもかかわらず、エコシステムは収束しつつあります。

1. **普遍的な接着剤としての MCP** — すべてのツールが MCP サーバーを消費します。これが write-once の層です。
2. **共有された概念としての Skills** — YAML フロントマターを持つ SKILL.md は、Codex、Claude Code、Pi に現れます。形式はほぼ同一です。
3. **Git ネイティブの配布** — Codex と Claude Code はどちらも、Git リポジトリを指す `marketplace.json` カタログを使います。コンパイルステップもビルドシステムもありません。
4. **プラグイン = ディレクトリ** — どちらのマニフェストファーストのプラットフォームも、同じ物理的なパターンを共有します。隠れた設定ディレクトリ（`.codex-plugin/` または `.claude-plugin/`）に `plugin.json` があり、すべてのコンポーネントはプラグインルートにあります。

主な違いは**野心の範囲**です。Codex は Skills + MCP + Apps に集中します（すっきりして可搬）。Claude Code はコンポーネントの多様さを最大化します（agents、LSP、monitors、themes）。OpenCode はプログラム的に進みます（完全な JS/TS の制御）。しかし下層の MCP があるので、どのラッパーを選んでも機能的なツールは可搬です。

---

*Sources: [OpenAI Codex Plugins](https://developers.openai.com/codex/plugins/build), [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference), [Cursor Plugin Ecosystem](https://pyshine.com/Cursor-Plugins-AI-Code-Editor-Plugin-Specification/), [OpenCode Plugins](http://opencode.ai/docs/plugins), [HuggingFace Context Course Unit 3](https://huggingface.co/learn/context-course/unit3/anatomy.md)*

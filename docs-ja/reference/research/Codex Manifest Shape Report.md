# Codex マニフェストの形: Codex はアドインをどう管理するか

> **Deep Research Report** | June 26, 2026  
> **Sources**: OpenAI 公式ドキュメント、Codex SDK v0.16.1（HexDocs）、HuggingFace Context Course、コミュニティのガイド、GitHub issues  
> **Confidence**: High — 一次資料のドキュメント + SDK の型仕様 + 実務者による検証

---

## エグゼクティブサマリー

OpenAI Codex は**マニフェストファースト**のプラグインシステムを使い、すべてのプラグインは 1 つの必須ファイル `.codex-plugin/plugin.json` で識別されます。このマニフェストは、プラグインの同一性を宣言し、同梱されたコンポーネント（skills、MCP サーバー、app コネクター、ライフサイクルフック）を指し示し、マーケットプレイス提示のためのインストールサーフェスのメタデータを提供します。

**主な事実:**
- マニフェストで厳密に必須なのは `name`（kebab-case）だけです
- プラグインは最大 4 種類のコンポーネントを同梱します。Skills（頭脳）、Apps（手）、MCP Servers（神経系）、Hooks（ライフサイクル）
- 配布は Git ネイティブのマーケットプレイスを使います。リポジトリスコープ、個人、公式のいずれかにできる JSON カタログです
- プラグインは `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/` にインストールされます
- このシステムは前方互換です。未知のキーは `extra` マップを介してラウンドトリップのシリアライズを生き延びます

---

## 1. マニフェストファイル: `plugin.json`

### 場所と役割

マニフェストは `.codex-plugin/plugin.json` に置かれます。これは `.codex-plugin/` ディレクトリの中で許される唯一のファイルです。ほかのすべてのコンポーネント（`skills/`、`hooks/`、`assets/`、`.mcp.json`、`.app.json`）は、プラグインルートに置かれます。

マニフェストには 3 つの仕事があります。
1. プラグインを**識別する**（name、version、author）
2. **同梱されたコンポーネントを指し示す**（skills、MCP サーバー、apps、hooks）
3. **マーケットプレイスのメタデータを提供する**（説明、アイコン、法的リンク、スターターのプロンプト）

### 完全なマニフェストの例

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Bundle reusable skills and app integrations.",
  "author": {
    "name": "Your team",
    "email": "team@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/plugins/my-plugin",
  "repository": "https://github.com/example/my-plugin",
  "license": "MIT",
  "keywords": ["research", "crm"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Reusable skills and apps",
    "longDescription": "Distribute skills and app integrations together.",
    "developerName": "Your team",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Use My Plugin to summarize new CRM notes.",
      "Use My Plugin to triage new customer follow-ups."
    ],
    "brandColor": "#10A37F",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot-1.png"]
  }
}
```

> Source: [developers.openai.com/codex/plugins/build](https://developers.openai.com/codex/plugins/build)

---

## 2. フィールドリファレンス

### トップレベルの必須フィールド

| フィールド | 型 | 検証 |
|-------|------|------------|
| `name` | string | **空でない kebab-case**（小文字、数字、ハイフンのみ）でなければならない |

> 厳密に必須なのは `name` だけです。ほかはすべて任意です。

### トップレベルの任意フィールド

| フィールド | 型 | 目的 |
|-------|------|---------|
| `version` | string | Semver の文字列（例: `"1.0.0"`）。キャッシュパスを決める |
| `description` | string | 人が読める要約 |
| `author` | object | `{name, email?, url?}` |
| `homepage` | string | ランディングページの URL |
| `repository` | string | ソースコードのリポジトリ URL |
| `license` | string | SPDX 識別子（例: `"MIT"`） |
| `keywords` | string[] | 発見のためのタグ |
| `skills` | string | skills ディレクトリへのパス（`./` で始まらなければならない） |
| `mcpServers` | string | `.mcp.json` ファイルへのパス |
| `apps` | string | `.app.json` ファイルへのパス |
| `hooks` | string/array/object | パス、またはインラインのフック定義 |
| `interface` | object | インストールサーフェスのメタデータ（§3 を参照） |

### `interface` オブジェクト

| JSON キー | 目的 | 制約 |
|----------|---------|------------|
| `displayName` | マーケットプレイスでのプラグインのタイトル | — |
| `shortDescription` | プラグインカードの一行説明 | — |
| `longDescription` | 詳細ページの説明 | — |
| `developerName` | 公開者の名前 | — |
| `category` | マーケットプレイスのカテゴリ | 例: `"Productivity"` |
| `capabilities` | capability バッジ | 例: `["Read", "Write"]` |
| `websiteURL` | 外部リンク | — |
| `privacyPolicyURL` | プライバシーポリシー | 公開されるプラグインには必須 |
| `termsOfServiceURL` | 利用規約 | — |
| `defaultPrompt` | composer のスターターのプロンプト | **最大 3 件、各 128 文字以下** |
| `brandColor` | 16 進のカラー | 例: `"#10A37F"` |
| `composerIcon` | アイコンのパス | `./assets/icon.png` |
| `logo` | ロゴのパス | `./assets/logo.png` |
| `screenshots` | スクリーンショットのパス | `./assets/*` のパスの配列 |

---

## 3. 検証ルール（SDK が強制）

Codex SDK（Elixir、`Codex.Plugins.Manifest.parse!/1`）は、これらの安定したルールを強制します。

| ルール | 詳細 |
|------|--------|
| kebab-case の name | 空でない、小文字 + 数字 + ハイフンのみ |
| `./` プレフィックス必須 | すべてのコンポーネントパスとアセットパスは `./` で始まらなければならない |
| `..` によるエスケープ不可 | パスはプラグインルートより上へさかのぼれない |
| defaultPrompt の上限 | 最大 **3** 件 |
| プロンプト長の上限 | 空白の正規化後、各 **128 文字**以下 |
| 決定論的な JSON | 書き込みは末尾の改行を伴う安定した JSON を生む |
| 前方互換のキー | 未知のキーは `extra` マップに保持され、ラウンドトリップを生き延びる |

```elixir
# Validation API
{:ok, manifest} = Codex.Plugins.Manifest.parse(data)
Codex.Plugins.Manifest.parse!(data)  # raises on error
```

---

## 4. ディレクトリレイアウト

```
my-plugin/                          ← plugin root
├── .codex-plugin/
│   └── plugin.json                 ← REQUIRED (only file in this dir)
├── skills/                         ← "skills": "./skills/"
│   ├── code-review/
│   │   └── SKILL.md
│   └── deploy/
│       └── SKILL.md
├── hooks/
│   └── hooks.json                  ← "hooks": "./hooks/hooks.json"
├── .app.json                       ← "apps": "./.app.json"
├── .mcp.json                       ← "mcpServers": "./.mcp.json"
└── assets/
    ├── icon.png
    ├── logo.png
    └── screenshot-1.png
```

---

## 5. コンポーネントの配線: アドインはどう参照されるか

### 5.1 Skills（「頭脳」の層）

**マニフェストのポインター**: `"skills": "./skills/"`

Codex は、`SKILL.md` ファイルを含むサブディレクトリをそのディレクトリから走査します。各スキルには YAML のフロントマターがあります。

```markdown
---
name: deploy-kubernetes
description: Deploy containerized apps to Kubernetes clusters.
---

## Workflow
1. Verify kubectl context...
2. Generate manifests...
```

**起動モード:**
- **Implicit**（デフォルト）: ユーザーのタスクが `description` に意味的にマッチすると自動でロードされる
- **Explicit**: `$skill-name` の構文で呼び出される

**設定の上書き**（`config.toml`）:
```toml
[skills.deploy-kubernetes]
enabled = true
invocation = "explicit"    # or "implicit"
priority = 10              # higher wins on conflicts
```

**解決の優先順位**: REPO > USER > ADMIN > SYSTEM > DEFAULTS

---

### 5.2 MCP Servers（「神経系」の層）

**マニフェストのポインター**: `"mcpServers": "./.mcp.json"`

等価な 2 つの形式:

```json
// Direct server map
{
  "docs": {
    "command": "docs-mcp",
    "args": ["--stdio"]
  }
}

// Wrapped (alternative)
{
  "mcp_servers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}
```

各サーバーのエントリ: `command`（必須）、`args`（必須）、`env`（任意）。

**サーバーごとのポリシーの上書き**（`config.toml`）:
```toml
[plugins."my-plugin".mcp_servers.docs]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["search"]

[plugins."my-plugin".mcp_servers.docs.tools.search]
approval_mode = "approve"
```

**承認モード**: `"approve"`（自動実行）、`"prompt"`（ユーザーに尋ねる）、`"deny"`（ブロック）

---

### 5.3 Apps/Connectors（「手」の層）

**マニフェストのポインター**: `"apps": "./.app.json"`

認証を伴うサードパーティサービスのコネクターを定義します。

```json
{
  "apps": [{
    "name": "github-connector",
    "auth": {
      "type": "oauth2",
      "client_id": "${GITHUB_CLIENT_ID}",
      "authorization_url": "https://github.com/login/oauth/authorize",
      "token_url": "https://github.com/login/oauth/access_token",
      "scopes": ["repo", "read:org"]
    }
  }]
}
```

**認証の種類**: OAuth 2.0、API キー  
**認証のタイミング**: マーケットプレイスのポリシーで制御される。`ON_INSTALL` または `ON_FIRST_USE`

---

### 5.4 ライフサイクルフック

**マニフェストのポインター**: `"hooks": "./hooks/hooks.json"`（指定しなければ自動で発見される）

`hooks` フィールドは**4 つの形式**を受け付けます。
1. 単一のパス: `"./hooks/hooks.json"`
2. パスの配列: `["./hooks/session.json", "./hooks/tools.json"]`
3. インラインオブジェクト
4. インラインオブジェクトの配列

**フックイベントのスキーマ**:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ${PLUGIN_ROOT}/hooks/session_start.py",
        "statusMessage": "Loading plugin context"
      }]
    }]
  }
}
```

**サポートされるイベント**: `SessionStart`、`TurnStarted`、`TurnCompleted`、`ToolCallRequested`、`ToolCallCompleted`

フックコマンドが利用できる**環境変数**:
| 変数 | 説明 |
|----------|-------------|
| `PLUGIN_ROOT` | インストールされたプラグインのルートパス |
| `PLUGIN_DATA` | プラグインの書き込み可能なデータディレクトリ |
| `CLAUDE_PLUGIN_ROOT` | 互換のためのエイリアス |
| `CLAUDE_PLUGIN_DATA` | 互換のためのエイリアス |

**⚠️ 信頼モデル**: プラグインのフックは**非管理**です。ユーザーがフック定義を明示的にレビューして信頼するまで、Codex はそれらをスキップします。プラグインのインストールは、そのフックを自動では信頼しません。

---

## 6. 配布: マーケットプレイスのシステム

### マーケットプレイス JSON の構造

```json
{
  "name": "repo-marketplace",
  "interface": { "displayName": "Team Plugins" },
  "plugins": [
    {
      "name": "demo-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/demo-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
        "products": ["codex-app", "codex-cli"]
      },
      "category": "Productivity"
    }
  ]
}
```

### マーケットプレイスのスコープ

| ティア | 場所 | 可視性 |
|------|----------|------------|
| Official | OpenAI がホスト | 全員 |
| Repository | `$REPO_ROOT/.agents/plugins/marketplace.json` | リポジトリの共同作業者 |
| Personal | `~/.agents/plugins/marketplace.json` | 現在のユーザー |
| Legacy | `$REPO_ROOT/.claude-plugin/marketplace.json` | ツール横断の互換 |

### ソースの種類

| 種類 | 形式 | 使いどころ |
|------|--------|----------|
| `local` | `"./relative/path"` | 同一リポジトリのプラグイン |
| `url` | 完全な HTTPS/SSH の URL | 独立したプラグインリポジトリ |
| `git-subdir` | URL + サブディレクトリのパス | モノレポのプラグイン |
| GitHub の短縮形 | `owner/repo[@ref]` | 手早い参照 |

**Git で裏打ちされたマーケットプレイスのエントリの例:**
```json
{
  "name": "remote-helper",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/example/codex-plugins.git",
    "path": "./plugins/remote-helper",
    "ref": "main"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

### ポリシーの制御

| フィールド | 値 | 効果 |
|-------|--------|--------|
| `policy.installation` | `AVAILABLE`、`PREINSTALLED`、`HIDDEN` | 発見／自動インストールの挙動 |
| `policy.authentication` | `ON_INSTALL`、`ON_FIRST_USE`、`NONE` | 認証のタイミング |
| `policy.products` | string[] | 特定の Codex サーフェスに限定する |

### CLI コマンド

```bash
# Marketplace management
codex plugin marketplace add owner/repo
codex plugin marketplace add ./local-path
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace remove <name>

# Plugin lifecycle
codex plugin install <plugin-name>
codex plugin enable <plugin-id>
codex plugin disable <plugin-id>
codex plugin remove <plugin-id>
codex plugin upgrade <plugin-id>
```

### インストールキャッシュ

プラグインは次の場所にインストールされます。
```
~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/
```

- ローカルのプラグイン: `$VERSION = "local"`
- Codex はソースではなく**キャッシュ**からロードします（オフラインでの利用を可能にします）
- キャッシュはアンインストール後も残ります（再有効化をサポートします）
- バージョン検証のために `gitCommitSha` を追跡します

### プラグインの状態

設定ファイルで制御されます。
- ユーザー: `~/.codex/settings.json`
- プロジェクト: `./.codex/settings.json`（git で追跡）
- ローカル: `./.codex/settings.local.json`（gitignore される）

```json
{
  "enabledPlugins": {
    "my-plugin@repo-marketplace": true,
    "experimental@personal": false
  }
}
```

---

## 7. ランタイムの解決フロー

```
                    ┌─────────────────────────────┐
                    │    .codex-plugin/plugin.json │
                    └──────────────┬──────────────┘
           ┌───────────┬──────────┼──────────┬──────────────┐
           ▼           ▼          ▼          ▼              ▼
      "skills"    "mcpServers"  "apps"    "hooks"     "interface"
      "./skills/" "./.mcp.json" ".app"   "./hooks/"   (metadata)
           │           │          │          │
           ▼           ▼          ▼          ▼
    ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐
    │ Scan for │ │ Spawn   │ │Resolve │ │ Await   │
    │ SKILL.md │ │ process │ │ creds  │ │ user    │
    │ files    │ │ per     │ │(OAuth/ │ │ trust   │
    │          │ │ entry   │ │ APIkey)│ │ review  │
    └────┬─────┘ └────┬────┘ └───┬────┘ └────┬────┘
         ▼            ▼          ▼           ▼
    ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐
    │ Index by │ │Register │ │Register│ │ Execute │
    │ name+desc│ │ tools   │ │ caps   │ │ command │
    │ for auto │ │ in agent│ │ as     │ │ on      │
    │ matching │ │         │ │ tools  │ │ event   │
    └──────────┘ └─────────┘ └────────┘ └─────────┘
```

**インストール時**: ファイルがキャッシュへコピーされ、コンポーネントが登録される  
**ランタイム時**: 有効なプラグインがロードされ、skills がインデックス化され、MCP サーバーがスポーンされ、apps が有効化され、信頼されたフックが準備される

---

## 8. エコシステムの比較

| 観点 | Codex | Claude Code | Cursor | VS Code |
|-----------|-------|-------------|--------|---------|
| モデル | マニフェストファースト | マニフェストファースト | IDE ネイティブ | 拡張 API |
| マニフェスト | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` | N/A | `package.json` |
| 配布 | Git リポジトリ + キャッシュ | Git リポジトリ + キャッシュ | 中央ストア | `.vsix` パッケージ |
| コンポーネント | Skills + MCP + Apps + Hooks | Skills + MCP + Hooks + LSP | 拡張 | 拡張 |
| オフライン | ✅ | ✅ | ❌ | ✅ |
| ツール横断の MCP | ✅ | ✅ | ✅（消費側） | ❌ |

**重要な洞察**: MCP は普遍的な相互運用の層です。よく作られた MCP サーバーは、Codex、Claude Code、Cursor をまたいで動きます。ラッピングの層（マーケットプレイスのメタデータ、スキルの定義）はツール固有ですが、機能的なインフラは可搬です。

---

## 9. 最小 → 公開への段階

### 絶対的な最小（有効）
```json
{ "name": "my-plugin" }
```

### 最小限の機能
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Reusable greeting workflow",
  "skills": "./skills/"
}
```

### 公開品質
§1 の例のすべてのフィールド。特に次に注意します。
- `interface.privacyPolicyURL` と `termsOfServiceURL`（公式ディレクトリには必須）
- `interface.defaultPrompt`（最大 3 件 × 128 文字のスターターのプロンプト）
- `interface.logo` と `screenshots`（マーケットプレイスでの存在感）
- 少なくとも `name` を持つ `author`
- 発見しやすさのための `keywords`

---

## 10. 主な要点

1. **マニフェストファーストは宣言的** — インストール時にコードは実行されず、JSON は検査可能で可搬です
2. **必須なのは `name` だけ** — 最小限から始め、必要に応じて複雑さを足します
3. **3 層のアーキテクチャ**が関心を分離します。Skills（知識）、Apps（認証）、MCP（ツール）
4. **信頼は明示的** — フックは自動実行されず、ユーザーがレビューして承認しなければなりません
5. **前方互換** — 未知のキーは `extra` マップを介して SDK のラウンドトリップを生き延びます
6. **Git ネイティブの配布** — プラグインはリポジトリに置かれ、コンパイルもビルドステップもありません
7. **MCP が可搬性の層** — 同じサーバーが Codex、Claude Code、Cursor をまたいで動きます

---

*3 つの並列リサーチトラックから編集しました。個々のエージェントファイルは `artifacts/research/codex-manifest-shape/` にあります。*  
*一次資料: [OpenAI Codex Docs](https://developers.openai.com/codex/plugins/build)、[Codex SDK HexDocs](https://hexdocs.pm/codex_sdk/13-plugin-authoring.html)、[HuggingFace Context Course](https://huggingface.co/learn/context-course/unit3/anatomy.md)*

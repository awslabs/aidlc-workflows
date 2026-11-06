# AI-DLC ドキュメント

AI-DLC は、AI で進めるソフトウェア開発のための、工程を区切った方法論です。
このリポジトリは、Claude Code、Kiro CLI、Kiro IDE、Codex CLI、Cursor、opencode、
GitHub Copilot のそれぞれで、AI-DLC をそのまま動かします。

## はじめかた

### 1. インストール

macOS、Linux、WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

ネイティブのインストーラーは、各ハーネスの実行環境も含めて、AI-DLC に必要なものを
すべて用意します。Bun や Node.js を別に入れる必要はありません。Windows では、
いま使っているアカウント向けにインストールし、bin ディレクトリを User PATH に自動で
登録します。ふつうの PowerShell ウィンドウから実行してください。「管理者として実行」で
開いたウィンドウでは、警告が出て確認を求められます。すでに開いていたターミナルや IDE は
古い PATH を持ったままなので、`aidlc` を使う前にいったん閉じて開き直してください。
中でタブを開き直すだけでは足りません。PATH を永続にも現在のプロセスにも変えたくなければ、
[`-NoModifyPath`](guide/18-install-and-lifecycle.md#windows-powershell) を使います。

### 2. 設定

プロジェクトのルートで実行します:

```bash
aidlc config --harness claude
aidlc doctor
```

`claude` のところは `kiro`、`kiro-ide`、`codex`、`cursor`、`opencode`、`copilot` に
置き換えてください。引数なしの `aidlc config` は、対話形式の設定を始めます。

### 3. 開始

設定したハーネスを開き、やりたいことを書きます:

```text
/aidlc Build a REST API for inventory management
```

Codex CLI では `$aidlc` を使います。プロバイダーの設定、信頼の確認、プロジェクトの
更新、最初のワークフローについては [はじめかたガイド](guide/01-getting-started.md) を
見てください。

## ハーネスを選ぶ

| ハーネス | ガイド |
| --- | --- |
| Claude Code | [はじめかたガイド](guide/01-getting-started.md) |
| Kiro CLI | [Kiro CLI で AI-DLC を動かす](guide/harnesses/kiro-cli.md) |
| Kiro IDE | [Kiro IDE で AI-DLC を動かす](guide/harnesses/kiro-ide.md) |
| Codex CLI | [Codex CLI の AI-DLC](guide/harnesses/codex-cli.md) |
| Cursor | [Cursor の AI-DLC](guide/harnesses/cursor.md) |
| opencode | [opencode の AI-DLC](guide/harnesses/opencode.md) |
| GitHub Copilot | [GitHub Copilot の AI-DLC](guide/harnesses/copilot.md) |

## ガイドを選ぶ

| ガイド | こんなときに |
| --- | --- |
| [ユーザーガイド](guide/00-introduction.md) | AI-DLC でソフトウェアを作るとき |
| [オンボーディングの手引き](guide/onboarding.md) | 初めてのチーム向け。考え方の全体像と、5 回のガイド付き実行 |
| [ワークフロープロファイル](guide/workflow-profiles.md) | Classic、Express、または目的を絞ったワークフローを選ぶとき |
| [ファシリテーターガイド](guide/facilitator-guide.md) | ワークショップの運営やチームの支援。準備の確認、立て直しの手順、ハーネスの比較 |
| [インストールとライフサイクル](guide/18-install-and-lifecycle.md) | 更新、バージョンの固定、オフラインでのインストール、ミラーの利用、アンインストール、プロジェクトからの削除 |
| [ハーネスエンジニアガイド](harness-engineering/00-overview.md) | ステージ、エージェント、スコープ、ルール、センサー、ナレッジを作り変えるとき |
| [開発とリリース](../DEVELOPERS.md) | PR を AI レビュー、プレビューでの検証、安定版の公開まで進めるとき |
| [開発者リファレンス](reference/00-overview.md) | エンジン、フック、パッケージング、テストスイートを変えるとき |

## 開発

メンテナーは `core/` と `harness/` で編集します。生成物の `dist/` と
`dist-release/` のツリーはローカルの出力なので、手で編集してはいけません。

開発の進め方は [コントリビューションガイド](reference/11-contributing.md) を、別の
実行環境を足す方法は [新しいハーネスへの移植](harness-engineering/09-porting-to-a-new-harness.md)
を見てください。

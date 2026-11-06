# 他の harness で走らせる

AI-DLC は、あなたが使う CLI にレンダリングされた、1 つの harness 非依存の core です。メソドロジー、すなわち [phases and stages](../04-phases-and-stages.md)、[agents](../06-agents.md)、[scopes](../05-scopes-and-depth.md)、[approval gates](../07-interaction-modes.md) は、どの harness でも同一です。異なるのは*外殻*です。ゲートの描画のされ方、subagent の dispatch のされ方、どの session イベントが発火するか、config がどこにあるかです。ここの各章は、1 つの harness のインストール手順、前提、そして中立のメソドロジーと異なるわずかな振る舞いを扱います。

Onboarding は、各 harness の native な instruction 面にインストールされます:

| Harness | Onboarding ファイル |
|---------|-----------------|
| Claude Code | `.claude/CLAUDE.md`（完全な onboarding） |
| Kiro CLI と Kiro IDE | `.kiro/steering/aidlc-onboarding.md` |
| Codex CLI | `.codex/onboarding.md`（プロジェクトが信頼されているとき、`.codex/config.toml` の `developer_instructions` を通じても注入される） |
| Cursor | `.cursor/rules/aidlc-onboarding.mdc` |
| opencode | `.aidlc/onboarding.md` |
| GitHub Copilot | ルートの `AGENTS.md`（method インポートを含む完全な onboarding） |

Kiro、Kiro IDE、Codex、Cursor、opencode は、ほかのインストール済み harness と、harness 非依存のルート `AGENTS.md` ブロックを共有します。それらの native なセットアップは、上のファイルに留まります。Copilot の完全なルートブロックは専有のままです。異なる harness は、共存のために異なる engine ディレクトリも必要とします。

## まずインストール

どの harness でも推奨される初回実行の経路は、チェックサム検証済みの native インストーラに続けて `aidlc config` です:

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
```

インストーラは、常にすべての harness runtime を含みます。`aidlc config --harness <name>` が、プロジェクトの面を選びます。ホストの前提はなお当てはまります。Codex は、プロジェクトの hook 発見のために、対象プロジェクトが Git リポジトリであることを要します。

Windows では、`install.ps1` をダウンロードし、`& $installer` として起動します。アカウントの scope、User PATH の自動登録、`-NoModifyPath` は [Windows installation](../18-install-and-lifecycle.md#windows-powershell) を参照してください。

harness を選んでください:

| Harness | 起動 | 章 |
|---------|--------|---------|
| **Claude Code** | `/aidlc` | [User Guide](../00-introduction.md) の全体で扱われます（その例は Claude Code で走ります）。インストールは [Getting Started](../01-getting-started.md) で。 |
| **Kiro IDE**（≥ 1.1.70）と **Kiro CLI**（≥ 2.24.1、v3 engine）。setup では Kiro として列挙 | `/aidlc` | [Running AI-DLC on Kiro IDE and Kiro CLI](kiro-ide.md) — 両方の面に 1 つのツリー。前提（Opus 4.8）、インストール、hook、Kiro で異なる点。 |
| **Kiro CLI**（≥ 2.6）。setup では Kiro CLI (V2) として列挙 | `/aidlc` | [Running AI-DLC on Kiro CLI](kiro-cli.md) — engine を pin しない harness。前提、インストール、Kiro で異なる点。Kiro CLI ≥ 2.24.1 の Kiro v3 engine には、上の Kiro を使ってください。 |
| **Codex CLI**（≥ 0.145.0） | `$aidlc` | [AI-DLC on Codex CLI](codex-cli.md) — 前提、trust の事前 seed、Bedrock config、git-repo 要件。 |
| **Cursor** | `/aidlc` | [AI-DLC on Cursor](cursor.md) — Cursor IDE と CLI に 1 つのツリー、native subagent と skill、hooks.json アダプタ、Cursor で異なる点。 |
| **opencode**（1.18.29 以降、または OpenCode 2） | `/aidlc` | [AI-DLC on opencode](opencode.md) — 分割された `.aidlc/` + `.opencode/` レイアウト、アダプタ plugin、opencode で異なる点。 |
| **GitHub Copilot**（CLI ≥ 1.0.74 / VS Code ≥ 1.130） | `/aidlc` | [AI-DLC on GitHub Copilot](copilot.md) — 両方の面に 1 つのインストール、`.github/` の merge、フォルダの信頼、Copilot で異なる点。 |

Kiro（IDE または CLI）の AI-DLC は、**Claude Opus 4.8** でもっともよく動きます。これは**有料の Kiro プラン**を要します。

手動 copy では、Bun をインストールし、特定リリースの `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードし、展開し、完全な `runtime/<harness>/` ディレクトリをコピーし、それ自身の setup を一度走らせます（[Copy Channel](../18-install-and-lifecycle.md#copy-channel) を参照）。native の `aidlc` 実行ファイルは要りません。copy は、あなたの `.gitignore` や `AGENTS.md` を決して置き換えません。AI-DLC は自分の行をそれらに加えます。リポジトリの checkout から生成されたツリーをコピーしないでください。フレームワーク開発者は代わりに、ソースの checkout で `bun scripts/package.ts` を走らせて、gitignore されたローカルの `dist/` と `dist-release/` の出力を実体化できます。各 harness の章は、手動 copy の指示を、明確にラベル付けされた代替として保ちます。

`aidlc update` の後、`aidlc doctor` を走らせて project/runtime のバージョンのずれを見て、各プロジェクトを `aidlc config` で refresh してください。ワークフローが開いている間の refresh は実行され、その作業が続くかどうかを言い、以前のリリースに戻るコマンドを名指しします。

この集合は開いています。新しい harness は、同じテンプレートから加えられ、ここに自分の章を得ます。新しい harness を*作る*こと（ソース契約、すなわち manifest、hook アダプタ、`emit.ts`）は、Harness Engineer Guide の [Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md) を参照してください。

どの harness を走らせても、メソドロジーは同じです。[Your First Workflow](../02-your-first-workflow.md) と [Phases and Stages](../04-phases-and-stages.md) のツアーから始めてください。

ワークショップを運営する、またはチームを支援する？ [Facilitator Guide](../facilitator-guide.md#how-strongly-each-harness-enforces-the-workflow) は、各 harness がワークフローをどれだけ強く強制するかを比べ、準備完了チェックとリカバリー手引きを示します。

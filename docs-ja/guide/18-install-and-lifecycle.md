# インストールとライフサイクル

ネイティブのリリースチャンネルは、`aidlc` コマンドと1つ以上のハーネスランタイムをインストールします。その後 `aidlc config` が、そのローカルのランタイムからプロジェクトを作成またはリフレッシュします。インストールされたコマンドと config のパスは Bun や Node.js を必要としません。GitHub CLI（`gh`）は任意です。互換のバージョンは署名された証明の検証を加えます。欠けているか古いバージョンはインストールをブロックしません。

この章は、このリリースで使えるネイティブのインストールのライフサイクルを記述します。計画中の `aidlc setup` 体験、npm パッケージ、パッケージマネージャーのフォーミュラはまだ使えません。手動コピーのユーザーは Bun をインストールし、`aidlc-copy-runtime-X.Y.Z.tar.gz` からバージョン付きで Bun を呼ぶランタイムを取ります。ネイティブの `aidlc` コマンドは要りません。

## インストール

リリースアセットは次をカバーします。

- macOS x64 と arm64
- Linux x64 と arm64、glibc と musl のビルド付き
- Windows x64

ネイティブインストールはユーザーごとです。Unix のインストーラーは root を拒否し `sudo` を必要としません。root が唯一のユーザーのところ（`USER` のないコンテナイメージ、CI のコンテナジョブ、セットアップスクリプトが root で走るクラウドエージェントのサンドボックスなど）では、`--allow-root`（または `AIDLC_ALLOW_ROOT=1`）を渡して root 自身の `$HOME` の下にインストールします。このオプトインは、`sudo` のもと（`SUDO_USER` が設定されている）、`$HOME` が未設定または root 所有でない（シンボリックリンクのホームはたどられます）、`AIDLC_BIN_DIR` や `AIDLC_INSTALL_ROOT` が root のホームの外を指すとき、なお拒否されるので、通常のアカウントからの `sudo sh install.sh` は失敗し続け、root のインストールが決してシステム全体にはなりません。`--allow-root` より前のリリースは、root として自身をアンインストールできません。それをインストールする、または root として `aidlc use`、`update`、`rollback` でアクティブにすると、後でそれを取り除く方法（自身の `aidlc update`、次に `aidlc uninstall --allow-root`）を名づける警告とともに進みます。`aidlc uninstall` は同じ `--allow-root` のオプトインを同じ制限で取ります。Windows のインストールは PowerShell を走らせるアカウントをターゲットにします。通常の PowerShell ウィンドウから実行します。UAC のもとで「管理者として実行」で開いたウィンドウは、管理者としてのインストールは安全性が低いと警告され（同じアカウントで走る別のプログラムが、昇格したインストーラーが走らせるファイルに干渉しうるため）、確認を求められます。`-Yes` はプロンプトなしで確認します。`-Yes` なしの非対話の実行（`-Json` と `-Quiet` を含む）は、そのガイダンスとともに止まります。`aidlc uninstall` は同じ警告を出しますが何も尋ねません。ターミナルでは何かを取り除く前に警告を表示し、`--yes` では警告がその結果に入ります。Windows Server の組み込み Administrator のような、UAC の昇格なしにすでにフルの管理者トークンを保持するセッションには、警告は出ません。別のアカウントの資格情報で PowerShell を走らせると、そのアカウント向けにインストールします。全ユーザーモードはありません。

Alpine Linux の musl アセットは、Bun 自身のランタイム契約に従います。Bun の musl ビルドは Node.js と同じく、システムの `libgcc` と `libstdc++` のパッケージを必要とします。完全に静的な Bun musl のコンパイルターゲットは、使えるターゲットではなく、upstream で追跡される機能のままです。インストーラーかバイナリを走らせる前に前提条件をインストールします。

```sh
apk add libgcc libstdc++
```

この前提条件は x64 と arm64 の Alpine システムの両方に適用されます。システムパッケージのインストールには管理者権限が要ることがありますが、AI-DLC のインストール自体はなおターゲットユーザーとして走ります。インストーラーは対応するローダーの失敗を検出し上記のコマンドを表示します。`apk` を走らせることもシステムパッケージをインストールすることも決してありません。upstream の Bun の追跡は `oven-sh/bun#15829` と `oven-sh/bun#29681` を含みます。

インストーラーは、すべてのハーネスランタイム（`claude`、`codex`、`copilot`、`cursor`、`kiro`、`kiro-ide`、`opencode`）を一緒に含みます。

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
```

### macOS と Linux

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
export PATH="$HOME/.local/bin:$PATH"
```

オンラインの実行は `curl` か `wget` を必要とし、すべての実行は `sha256sum` か `shasum` を必要とします。GitHub CLI は任意で、リリースの要求する証明のフラグをサポートするときだけ使われます。バージョンを `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/versions/` の下にインストールし、既定でアクティブなバージョンを走らせる小さなランチャー `$HOME/.local/bin/aidlc` を書きます。AI-DLC 自身のプラグインカタログはバージョンの隣、`${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/plugins/` にあります。インストーラーがそのフルパスを表示します（[Plugins](#plugins) を参照）。

インストーラーは、`--profile <absolute-path-under-$HOME>` が明示されない限り、シェルの起動ファイルを編集しません。そのオプションは、1つの `BEGIN AI-DLC:PATH` ブロックをトランザクション的に書くか更新し、ファイルの残りを保ちます。プロファイルは AI-DLC のインストールやコマンドのルートの中にはできません。既存のマーカーは、ユニークで、正確なフル行で、begin が end より前に並んでいなければなりません。不正なマーカーのレイアウトは、プロファイルを変えずに拒否されます。

### Windows PowerShell

```powershell
$download = Join-Path $env:TEMP "aidlc-install-$PID"
New-Item -ItemType Directory -Force $download | Out-Null
$installer = Join-Path $download install.ps1
Invoke-WebRequest `
  -Uri https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 `
  -OutFile $installer
& $installer
Remove-Item -Recurse -Force $download
```

Windows はバージョンを `%LOCALAPPDATA%\aidlc\versions\` の下にインストールし、`aidlc` コマンドを `%LOCALAPPDATA%\aidlc\bin\` に保ちます。アクティブなバージョンを起動する AI-DLC バイナリのコピー `aidlc.exe` と、その隣の `aidlc.cmd` シムです。PowerShell、CMD、Git Bash はすべて、素の `aidlc` について `aidlc.exe` を走らせ、あなたのシェルが与えたとおりにアクティブなバージョンに引数を渡します。その中の `&`、`^`、`|`、`<`、`>`、`%NAME%` を読む cmd.exe を間に挟みません。AI-DLC 自身のプラグインカタログは `%LOCALAPPDATA%\aidlc\plugins\` にあります。検証とインストールが成功した後、インストーラーはその bin ディレクトリを、現在のアカウントの永続的な User PATH に登録し、既存のエントリを保ち、再実行時の重複を避けます。現在の PowerShell プロセスも更新し、Windows に環境の変更を通知するので、その後に始まるプログラムが `aidlc` を見つけます。すでに開いていたターミナルアプリや IDE（Kiro、VS Code、Cursor）は、開始時の PATH を保ちます。そこで `aidlc` や AI-DLC のフックを使う前に、完全に終了して開き直します。その中の新しいタブや Reload Window では足りません。Machine PATH を変えることも PowerShell プロファイルを編集することもありません。

人向けの出力が成功すると、`Installed`、バージョン、アカウント、インストールされたコマンドのパスで始まります。次に、プロジェクトディレクトリから `aidlc config` を実行します。インストーラーが PATH エントリを加えたとき、すでに開いていたターミナルアプリや IDE を終了して開き直すようにも言います。

インストーラーは、User PATH エントリを加えたときにだけ、インストールルートの下に `windows-path.json` を書きます。この所有記録は再実行を生き残り、`-NoModifyPath` を含みます。だからアンインストールが後でそのエントリを取り除けます。すでに存在していたエントリは主張されません。`aidlc uninstall` と `aidlc uninstall --purge` の両方が、既存のエントリとその後の無関係な PATH の変更を保ちながら、記録されたエントリを取り除きます。

別の `aidlc` コマンドが永続的な PATH で優先するなら、結果がそれを名づけ、インストールされたコマンドのフルパスを与えます。その PATH の競合を解消するか、インストールされたコマンドを直接呼び出します。PATH の登録が失敗すると、インストーラーは、ファイルはインストールされたが PATH はなお構成が要ると、回復の指示と exit code 1 とともに報告します。

**永続的と現在プロセスの両方の PATH の変更**をスキップするには、上の `& $installer` を `& $installer -NoModifyPath` に置き換えます。インストーラーが PATH の登録なしに走らせる直接のコマンドを表示します。既定の場所については次のとおりです。

```powershell
& "$env:LOCALAPPDATA\aidlc\bin\aidlc.exe" config
```

インストール場所を変えたなら、表示されたコマンドのパスを使います。自動の PATH 登録を有効にするには、`-NoModifyPath` なしでインストーラーを再実行します。このスイッチは、以前の登録を undo したりその所有記録を消したりしません。

PowerShell のインストーラーのパラメータは、`-Version`、`-From`、`-Offline`、`-ReleaseBaseUrl`、`-CaBundle`、`-NoModifyPath`、`-Yes`、`-Quiet`、`-Json`、`-NoColor` のように、そのネイティブな名前を使います。

バージョン付きのリリース URL からダウンロードされたインストーラーは、プレビューを含め、その正確なリリースをデフォルトとします。`latest/download` のインストーラーは、最新の安定版リリースを選び続けます。明示的な `--version` / `-Version` の選択はパッケージされたデフォルトをオーバーライドし、`--from` / `-From` はローカルのリリースマニフェストからバージョンを読みます。

### 自動化

インストールはハーネスの質問をしません。人向けと非対話の実行は、同じバイナリとすべてのハーネスランタイムをインストールします。

一時的または隔離された Windows のインストールには、`-NoModifyPath` を渡し、報告されたコマンドのパスを直接呼び出して、一時的な bin ディレクトリを User PATH と現在のプロセスから外しておきます。

PowerShell の `-Json` は、`schemaVersion: 1`、`ok`、`code`、`status`、`message` を持つ1つの結果を発行します。ファイルがインストールされた後、`data` は次を含みます。

| フィールド | 意味 |
|-------|---------|
| `installed` | `true`、以降の PATH ステップが失敗したときも含む |
| `ready` | 推奨のコマンドが使う準備ができているか。PATH の競合や失敗では `false` |
| `version`、`account`、`installRoot`、`command` | インストールされたバージョン、Windows アカウント、インストールルート、コマンドのフルパス |
| `path.scope` | `"user"` |
| `path.status` | `"updated"`、`"unchanged"`、`"skipped"`、`"conflict"`、`"failed"` |
| `path.changed` | この実行が永続的な User PATH を変えたか |
| `path.owned` | この実行がインストーラーの所有を確認したか。`-NoModifyPath` が以前の記録を未評価のまま残すとき `null` |
| `nextSteps` | プロジェクト構成や PATH の回復を含む、指示の配列 |

成功した登録、または既存の一致する PATH は、通常 `status: "ok"` と exit code 0 を使います。Windows が他のアプリケーションに通知できないとき、結果は `data.ready: true` と条件付きのサインアウトの指示とともに `status: "warning"` を使います。永続的なコマンドの競合は `status: "warning"`、exit code 0、`data.ready: false` を使います。自動化は、exit code だけでなく readiness も調べるべきです。`-NoModifyPath` は `status: "ok"`、`path.status: "skipped"`、`data.ready: true` を、`nextSteps` の直接のコマンドとともに使います。インストール後の PATH の失敗は `status: "failed"`、exit code 1、`data.installed: true`、`data.ready: false` を使います。

### インストーラーのオプション

| Unix | PowerShell | 意味 |
|------|------------|---------|
| `--version <version>` | `-Version <version>` | latest の代わりに1つの正確なリリースをインストールする。安定版の `x.y.z` またはプレビューの `x.y.z-preview.YYYYMMDD.N` の id |
| `--from <dir>` | `-From <dir>` | フラットなリリースのセットをローカルに読み、オフラインモードを含意する |
| `--offline` | `-Offline` | ネットワークアクセスを禁じる。`--from` / `-From` を要する |
| `--release-base-url <url>` | `-ReleaseBaseUrl <url>` | 互換のリリースミラーを使う |
| `--ca-bundle <absolute-path>` | `-CaBundle <absolute-path>` | カスタムの CA バンドルを使う |
| `--profile <absolute-path>` | 利用不可 | Unix の PATH ブロックをトランザクション的に加える |
| 利用不可 | `-NoModifyPath` | 永続的な User PATH と現在プロセスの PATH の変更をスキップし、直接のコマンドを表示する |
| `--allow-root`（または `AIDLC_ALLOW_ROOT=1`） | 利用不可 | root が唯一のユーザーのところ（コンテナ、CI ジョブ、エージェントサンドボックス）で root としてインストールする。`sudo` のもと、`$HOME` が未設定または root 所有でないとき、`AIDLC_BIN_DIR` や `AIDLC_INSTALL_ROOT` が root のホームの外にあるときは、なお拒否される。`--allow-root` より前のリリースは警告とともにインストールされる。root として自身をアンインストールできないため |
| `--yes` | `-Yes` | 自動化モード。整合性チェックをバイパスしない。Windows では、AI-DLC が書いていない bin ディレクトリの `aidlc` も置き換え、そのファイルをバックアップとして保つ |
| `--quiet` | `-Quiet` | 進捗を抑制し1つの結果行を発行する |
| `--json` | `-Json` | 進捗を抑制し1つのスキーマバージョン付きの JSON 結果を発行する |
| `--no-color` | `-NoColor` | 色の出力を無効にする |
| `--help` | 公開されない | Unix インストーラーの使い方を表示する |

`AIDLC_RELEASE_BASE_URL` と `AIDLC_CA_BUNDLE` はインストーラーのデフォルトを提供します。明示的なオプションが勝ちます。`AIDLC_RELEASE_REPOSITORY` は、デフォルトのダウンロードに使う GitHub リポジトリと、来歴の検証が信頼するリポジトリの両方を選びます。デフォルトは `awslabs/aidlc-workflows` です。`AIDLC_RELEASE_WORKFLOW` は信頼される署名者のワークフローをオーバーライドします。デフォルトでは、インストーラーは安定版に `<AIDLC_RELEASE_REPOSITORY>/.github/workflows/release.yml` を、プレビューに `<AIDLC_RELEASE_REPOSITORY>/.github/workflows/preview-release.yml` を選びます。ワークフローのパスが異なるフォークやミラーには、そのリリースのベース URL とともにオーバーライドを明示的に設定します。ダウンロード URL だけを変えても来歴の信頼のルートは変わりません。`AIDLC_GH_BIN` は両方のインストーラーの明示的な GitHub CLI 実行ファイルを選びます。その実行ファイルが欠けている、または `--signer-workflow`、`--source-ref`、`--source-digest` を欠くなら、来歴の検証はスキップされ、チェックサムの検証は必須のままです。

フォークのリリースは GitHub App も追加のリポジトリも要しません。タグのワークフローは、その短命の `GITHUB_TOKEN` で同じリポジトリに公開します。その最後のジョブは `release` 環境を使い、それは公開の前にレビュアーの承認を要求できます。

`AIDLC_INSTALL_ROOT` と `AIDLC_BIN_DIR` はマシンとコマンドの場所をオーバーライドします。それらのパスは Unix では絶対でなければなりません。Windows では、`-NoModifyPath` が設定されない限り、選ばれた bin ディレクトリが現在のアカウントの User PATH に登録されます。PowerShell のインストーラーは `AIDLC_OFFLINE=1` も尊重します。Unix のインストーラーは明示的な `--offline` または `--from` の綴りを要します。

### リリースの認証

インストーラーは、

1. `version.json`、`checksums.txt`、`aidlc-release.intoto.jsonl` をダウンロードまたは読みます。
2. 互換の GitHub CLI が使えるとき、GitHub CLI のデフォルトホストが GitHub Enterprise のホストでも、`checksums.txt` の証明をリポジトリと署名者のワークフローに対して `github.com` で検証します。
3. `version.json` の SHA-256 を検証し、その version id と source identity を読み、リリースバイナリをダウンロードまたは実行する前に明示的なバージョンの不一致を拒否します。
4. `sourceRef` が安定版リリースには `refs/tags/v<version>`、プレビューには `refs/heads/main` と等しいことを要し、来歴の検証が使えるとき、その ref と認証された `sourceDigest` に対して証明を再検証します。
5. 選ばれたバイナリとハーネスのアーカイブを SHA-256 と宣言されたバイト長で検証します。
6. 検証されたバイナリに、リリースを検証しトランザクション的にインストールさせます。

実行の前にブートストラップスクリプト自体を認証するには、現在の GitHub CLI を使います。`github.com/` のリポジトリプレフィックスと `--hostname github.com` は、あなたの `gh` が GitHub Enterprise のホストをデフォルトとするとき、これらのコマンドを github.com に保ちます。

```bash
tmp="$(mktemp -d)"
tag="$(gh release view --repo github.com/awslabs/aidlc-workflows --json tagName --jq .tagName)"
gh release download "$tag" --repo github.com/awslabs/aidlc-workflows --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --hostname github.com \
  --source-ref "refs/tags/$tag"
sh "$tmp/install.sh" --version "${tag#v}"
rm -rf "$tmp"
```

メタデータは 1 MiB に、個々のリリースアセットは 1 GiB に制限されます。アセット名はパスを含められません。アーカイブの展開は、リンク、特殊ファイル、パストラバーサル、絶対パス、重複エントリ、過大な展開を拒否します。

リリースのワークフローは候補を一度組み立てます。ステージングと Unix/Windows のライフサイクルのジョブは、署名の権限なしに `checksums.txt` を検証しそのバイトをテストします。実際の証明はそれらのテストの後に作られるので、ジョブローカルの検証器のフィクスチャを加えます。フィクスチャは決してアップロードされません。`publish` は候補を再検証し、証明し、`aidlc-release.intoto.jsonl` をエクスポートし、完全なインベントリを検証し、1つのワークフローアーティファクトをアップロードします。`release` はタグとチェックサムを再チェックし、このリポジトリに `GITHUB_TOKEN` で GitHub Release を作り、ローカルとリモートのアセットインベントリを比較します。バンドルは `version.json` と `checksums.txt` の外に留まります。それらのファイルはインストール可能なアーティファクトをカバーし、バンドルはそれ自身の Sigstore の信頼チャンネルです。オンラインの転送は TLS を強制し、すべてのインストールは SHA-256 を強制します。互換の GitHub CLI のバージョンは署名された来歴の検証を加えます。OS のコード署名と notarization はリリースの一部ではありません。[Supply-Chain Security](../reference/19-supply-chain-security.md) を参照してください。

インストーラーは、所有が混在した既存のコマンドを拒否します。既存の Homebrew や Nix のコマンドにも、置き換える代わりに譲ります。このプロジェクトはまだそれらのパッケージマネージャーのチャンネルを出荷しません。所有するマネージャーを使うか、明示的な空の `AIDLC_BIN_DIR` を選びます。

## プロジェクトを構成またはリフレッシュする

ハーネスを開く前に config を実行します。[Getting Started](01-getting-started.md#2-set-up-your-project) が最初のセットアップの各画面を示します。

```bash
cd your-project
aidlc config --harness claude --dry-run
aidlc config
aidlc doctor
```

`aidlc config` はトランザクション的で、このマシンにすでにあるリリースから機能します。プロジェクトが必要とするリリースをダウンロードするのは、プロンプトで同意するか `--download` を渡すときだけです。選ばれたハーネスツリー、`aidlc/` ワークスペースのシェル、ルートの統合、射影のスタンプ、所有のベースラインを作ります。ワークフローの intent は作りません。

すべてのハーネスランタイムがインストールされるので、ターミナルの外では、最初のセットアップやプレビューはそのハーネスを `--harness <name>` で名づけます。ターミナルでは、config は検出した1つのハーネスを使うか、どれかを尋ねます。プロジェクトに複数のハーネスがあるとき、それらの1つをセットアップ、プレビュー、リフレッシュするコマンドは、それを `--harness <name>` で名づけます。1つの例外は、`aidlc config flags --bypass` や `--clear-bypass` でバイパスを記録またはクリアし、他に変えるものがないことです。バイパスは1つのハーネスではなくプロジェクトに属します。どのハーネスが共存できるか、その出荷の `.gitignore` エントリがどう結合されるかは [Root Integrations and Ownership](#root-integrations-and-ownership) を参照してください。

あるリリースから1つのハーネスを書く実行は、作業が開いているかにかかわらず、別のリリースにある他のインストール済みハーネスを、ちょうど書いたリリースにそれを持ってくる1つのコマンドとともに名づけます。

```
  Kiro CLI (.kiro) is still on 2.9.0. To bring it to 2.10.0: `aidlc config --harness kiro`.
```

`--from` に渡したファイルがそのハーネスを保持するとき、コマンドはそれらを再利用します。そうでなければ、コピーされたプロジェクトの行は、そのリリースのコピーランタイムのファイルを先に取るよう言います。すでにインストール済みのコピーされたハーネスでの `--download` は、それがすでに持つリリースを取ってくるためで、ネイティブのプロジェクトの行は、そのリリースをインストールする `aidlc config --pin` を名づけます。マシンに登録されたチェックアウトの git worktree は同じプロジェクトです。そのピン留めされたコマンドは、マシンがそれを持つとき、それ自身の `.aidlc-version` が名づけるリリースを走らせ、それを登録するので、ホストがセッションごとに作る worktree は、そのブランチがチェックアウトと別のリリースをピン留めしても、`config --pin` を二度と尋ねません。メインのチェックアウト自体と別のクローンは、以前と同じく、変わったピンを `config --pin` を通じてのみ登録します。

scaffold やリフレッシュが成功した後、config は安価なインストール結果の掃きを実行します。非対話のフック PATH、ホストの信頼ファイル、記録されたプロバイダーのアクションだけを確認します。ハーネス CLI を起動することもプロバイダーに接触することもありません。トランザクションはなお 0 で終了します。非 TTY の人向け出力は、未解決の各項目と、正確な `aidlc config runtime`、`aidlc config trust`、`aidlc config providers --check` のフォローアップを名づけます。2つの項目にはそれらを行う AI-DLC のコマンドがないので、その行は代わりに人自身のステップを名づけます。Codex 自身のフックの信頼（Codex で `/hooks` とタイプし、`t` を押してすべて信頼し、Esc を押す）と、Kiro IDE でのエラーのある設定ファイル（それが名づけるファイルのエラーを直す。その `command`、`config trust --check` は結果を確認するだけ）です。JSON は `data.outstandingActions` を含み、そのような項目はその `step` も運びます。quiet な出力は、クリーンなとき1行のままで、フォローアップが要るとき未解決アクションの1行を付け加え、加えてコミット対象の記録を隠す各 ignore ルールについて1つの `Warning:` 行を付けます。

人の TTY では、素の最初の実行（フラグなしの `aidlc config`。`--harness`、`--dry-run`、`--yes`、`--json` のようなフラグはウィザードをスキップします）は、質問ではなく検出から始まります。`PATH` 上のインストール済みハーネス CLI、プロジェクトの状態、ローカルの AWS 資格情報とリージョン、非対話のフックランタイムです。検出されたハーネスが1つなら、ウィザードはそれを名づけ3つの選択肢を提供します。推奨のデフォルト、6ステップのカスタマイズ、何も書かずに終了です。複数の検出されたハーネスはまず番号付きのハーネスピッカーを得て、検出されたハーネスがなければデフォルトなしの完全なピッカーを得ます。2.24.1 以降の Kiro CLI は両方の Kiro ハーネスにカウントされます。ピッカーは `kiro` を Kiro CLI (V2) としてリストします。エンジンをピン留めせず、Kiro CLI の v2 エンジン向けに作られています。`kiro-ide` を Kiro として、Kiro IDE と v3 エンジンの Kiro CLI 向けにリストします。2つのうち Kiro CLI (V2) が先に来るので、以前に検出されたハーネスがリストを率いる、またはセットアップがハーネスエディター自身のターミナルで走る（そのハーネスが先に来ます）のでない限り、Enter はそれを取ります。

セットアップの選択の前に、ウィザードは一時ファイルとディレクトリを使ってプロジェクトのファイルシステムをプローブし、次にそれらを取り除きます。トランザクションロック、排他的なファイル作成、通常ファイルの `fsync`、可変の追記と読み戻し、ディスクリプタ/パスのアイデンティティ、リネームによるファイルの置き換え、ディレクトリのリネーム、Unix の `chmod`、ランタイムのワークフローロックの調整を確認します。サポートされないディレクトリの `fsync` は許容されます。これらのチェックは使えない操作を検出します。成功はアトミック性やクラッシュ耐久性を保証できません。失敗したプローブは、ストレージの対処とともにセットアップを止め、何も書きません（取り除けないプローブは代わりに名づけられます）。[Config fails with a storage error](15-troubleshooting.md#config-fails-with-a-storage-error) を参照してください。

推奨のデフォルトは、ハーネスの現在のモデルプロバイダーを保ちます。カスタマイズは Harness、Model provider、Model effort preset、Plugins、MCP servers、model-preset の設定レイヤーを歩きます。プロバイダーのステップは、現在のプロバイダーを保つことを最初に、Amazon Bedrock を2番めに提供します。`kiro` の行では、ステップ2は代わりに Session model です。あなたの Kiro アカウントのモデルをリストし、選ばれたモデルを、プリセットのセッションエフォートとともに、すべての AI-DLC のステップの後、最後にあなたの個人用 Kiro 設定に保存します。Kiro auto のもとでは、推奨のデフォルトはその1つのモデルの質問を尋ねます。[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort) を参照してください。`kiro-ide` の行は [First run](harnesses/kiro-ide.md#first-run) を参照してください。その完全なピッカー以外のすべての番号付きプロンプトは、角括弧のデフォルトを持ち、無効な入力はその場で再び尋ね、各回答はエコーされます。回答確認のテーブルは、適用するには Enter を、編集するにはステップ番号を受け取ります。その最後のゲートの前にファイルは書かれません。適用の後、動名詞の受領がプロジェクトファイルと model-preset の設定レイヤーを名づけ、本当にブロックするアクションが続き、次にウィザードが正確なハーネスの起動と最初のワークフローのコマンドを表示します。

ステップ3は4つめの選択肢 `unchanged` も提供します。プリセットを記録せず既存のモデル設定を保ちます。モデルポリシーのないプロジェクトは出荷のデフォルトを使います。`balanced` が推奨のデフォルトのままですが、Kiro IDE、Cursor、GitHub Copilot では例外です。そこではすべてのエージェントがセッションのモデルとエフォートを使うので、セットアップは `unchanged` を推奨しデフォルトとし、再実行のマップは Models を `[ok]` と表示しホストセッションを名づけます。

既存プロジェクトの再実行は、Harnesses、Models、Runtime、Flags、Project、Providers、Trust、Workspace の8行のマップを保ちます。行は小文字の `[ok]` または `[needs]` です。1つのデフォルトが yes のゲートが、Models、Runtime、Providers、Trust の所見だけを歩きます。Workspace は報告され、決して歩かれません。欠けた `aidlc/spaces/default/memory/` のシェルは、質問ではなく明示的な `aidlc config --harness <name>` のリフレッシュで修復され、シェルが不完全な間はゲートがまったく提供されません。そのセクションは、欠けたディレクトリで失敗するか、no-op の回答で何も再構築しないためです。レジャーはそのとき再構築コマンドを率います。Bun を呼ぶ射影（`aidlc-copy-runtime-X.Y.Z.tar.gz` の `runtime/<name>/` ルート、またはチェックアウトの `dist/<name>/` ツリーからコピーしたもの）には、リフレッシュ元のインストール済みランタイムがないので、そのコマンドは `--download` も運び、プロジェクトのリリース向けのコピーランタイムを取得し検証します。ネイティブインストールはそれなしでインストール済みランタイムからリフレッシュします。欠けた `aidlc/` ルートは一度数えられます。Trust セクション自身の `workspace-root-missing` の問題が Workspace の行に畳まれます。Providers の行は、自分のモデルアクセスを提供する Kiro CLI と Kiro IDE で、記録された回答なしに `[ok]` と読め、GitHub Copilot と Cursor では、回答なしがセッション自身のモデルアクセスを意味します（たとえば `model access comes with your GitHub Copilot session`）。自分で持ち込むなら `aidlc config providers` がそこに Amazon Bedrock を記録します（Cursor では IDE だけが Bedrock キーを取ります）。GitHub Copilot、Cursor、Kiro IDE では Models の行は `[ok]` と読めホストを名づけます。たとえば `every agent uses your GitHub Copilot session's model and effort` です。プリセットはそれらのホストで何も変えないので（Kiro では1つのエージェント自身のモデルとエフォートだけが適用されます）、尋ねるポリシーはなく、記録されたものはそこで適用されないものとして名づけられます。[Choosing a Model and Effort](#choosing-a-model-and-effort) を参照してください。Runtime は即座のアクションを率い、診断のために `aidlc config runtime --show` を示します。締めのレジャーはコンパクトなラベルからコマンドへのリストです。セクション名のコマンド、非 TTY の実行、`--dry-run`、`--json`、`--quiet` は、その決定的な出力を保ち、対話的なウィザードを決してレンダリングしません。

### config のオプション

| オプション | 意味 |
|--------|---------|
| `--project-dir <path>` | カレントディレクトリの代わりにこのプロジェクトをターゲットにする |
| `--harness <name>` | インストール済みのハーネスランタイムを選ぶ |
| `--from <dir-or-tgz>` | インストール済みランタイムの代わりにローカルのリリースファイルを使う。`aidlc-copy-runtime-X.Y.Z.tar.gz`（その隣の `.sha256` に対して確認される）、その展開された `runtime/` フォルダ、または1つの射影ディレクトリかアーカイブ |
| `--download` | このマシンが欠くとき、プロジェクトが必要とするリリースを取得し検証し、次にコマンドを完了する。dry run のプラントークンの適用はそれを再び要する |
| `--mcp defaults\|none` | Claude の任意の出荷 MCP エントリを加えるか省く |
| `--dry-run` | ターゲットディレクトリを作らず、バイトを変えずに、完全なプランを計算する |
| `--plan-token <token>` | JSON の dry run から承認された正確なプランだけを適用する |
| `--show` | 何も変えずに設定を表示する。セクションなしではすべてのセクションを順に（`aidlc config --show`。`--json` はセクションでキー付けされた1つのオブジェクトを表示し、各値はそのセクションの `--show --json` が表示するもの）、セクションありではそのセクションだけ |
| `--force` | ポリシーが許すところで、ローカルに変更されたフレームワーク所有のファイルと管理ブロックを置き換える |
| `--yes` | そうでなければ認識されないターゲットディレクトリやセクションの変更を確認する。MCP の同意を含意せず、セクションの回答を選ばない |
| `--json` | カウント、アクション、`data.notes`、`data.planToken` を持つ1つの結果オブジェクトを発行する |
| `--quiet` | 1つのサマリーまたは対処の行を発行する |
| `--no-color` | 色の出力を無効にする |

`--project-dir`、`--json`、`--quiet`、`--no-color`、`--yes`、`--offline`、`--verbose` は AI-DLC 自身のオプションです。`aidlc config --project-dir /work/shop` や `aidlc doctor --json` のように、実行するコマンドにつけます。それらの1つに見える自分の語はなおあなたの語なので、`/aidlc add a --project-dir flag to the CLI` は、タイプしたすべての語を保ってその作業を頼みます。

### モデルポリシー

`aidlc config models` は、選ばれた設定レイヤー（`--project` には `aidlc.settings.json`）にモデルポリシーを記録し、通常の config のプラン、確認、トランザクションを通じて適用します。モデルプロバイダーに決して接触しません。Kiro CLI では、セッションモデルを選ぶと、Kiro CLI にあなたのアカウントのモデルリストとそのモデルのエフォートレベルを尋ねます。`--yes` では `--session-model` だけがそうします。

公開のグループは次のとおりです。

| グループ | エージェント | 出荷のティア |
|-------|--------|--------------|
| Deciding | 9つの設計、実装、product、security、quality のエージェント | judgment |
| Reviewing | product lead と architecture reviewer | balanced |
| Writing up | delivery、pipeline and deploy、operations | templated |

ポリシーはエージェントごとにこの順で解決します。

1. エージェントごとの例外
2. グループのダイヤル、直接またはプリセットを通じて設定
3. 出荷のティアのデフォルト
4. セッションの継承

ピンは両方向にバインドします。ピン留めされたエージェントは、セッションが後でより大きなモデルに移っても、ピン留めのままです。フレームワークはエージェントをセッションより上に自分で上げることは決してありません。記録されたポリシーがないと、Deciding と Writing up は継承します。測定された reviewing のティアのベースラインだけがステップダウンを出荷します。初回実行のウィザードのデフォルトの選択は `balanced` プリセットを記録し、3つのグループすべてを medium エフォートに設定します。Kiro IDE、Cursor、GitHub Copilot ではプリセットを記録しません。

```bash
aidlc config models --show
aidlc config models --reviewing-effort xhigh --project --yes
aidlc config models --agent architect --effort xhigh --model provider/raw-id --project --yes
aidlc config models --check
aidlc config models --reset --project --yes
aidlc config models --keep --yes
aidlc config models --session-model claude-opus-4.8   # Kiro CLI: your personal session model
```

変更は、何が変わったか、その undo コマンド、誰がそれを拾うか（加えて未解決のセットアップのステップ）で終わります。`--json` と `--quiet` の出力は変わりません。

Claude Code、Codex、opencode、Kiro CLI では、ポリシーが記録されていない間、セットアップはあなたが答えるまで各リフレッシュでモデルについて尋ねます（Kiro IDE、Cursor、GitHub Copilot では決して尋ねません）。モデルをそのままにするのも回答です。モデルの質問で Enter、初回実行のセットアップで `unchanged`、または `--keep` が、それをプロバイダーの回答の隣の `<harness>/tools/data/harness.json` に記録するので、セットアップは尋ねるのをやめます。`--reset` がそれをクリアします。

`--show --json` は、すべてのエージェントの実効のモデル、エフォート、来歴を表示します。`--check` は CI の逆で、記録されたポリシーがハーネスの画面に完全に反映されていないとき非ゼロで終了します。Kiro IDE、Cursor、GitHub Copilot では、プリセットが何も変えないので、書けない記録されたエフォートは、`aidlc doctor` と同じく、セッションに任され、チェックを失敗させません。Cursor と GitHub Copilot では、セッションがすべてのエージェントのモデルとエフォートを設定するので、クリーンなチェックは、`aidlc doctor` がするように、記録されたポリシーが反映されていると言う代わりにそう言います。

モデルとフラグのポリシーは、この階層をリーフごとに解決します。

1. ティアとプリセットのテーブルの出荷のデフォルト
2. マシンの `${AIDLC_INSTALL_ROOT:-~/.local/share/aidlc}/aidlc.settings.json`
3. プロジェクトの `aidlc.settings.json`
4. 個人の `aidlc.settings.local.json`
5. 環境変数

バイパスはオーバーライドする代わりに積み重なります。スイッチは、3つのファイルのどれかがそれを記録する間オンです。

プロジェクトのファイルはコミットされるチームポリシーです。ローカルのファイルは個人のものです。AI-DLC の管理された `.gitignore` ブロックがそれをリストし、`.gitignore` がそれより前のインストールでは、それを作る config コマンドが、代わりにクローン自身の `.git/info/exclude` に加えます。どちらのファイルもチームのコードとはカウントされません。変更は、`--project`、`--local`、`--global` のちょうど1つを要しますが、バイパスは例外です。レイヤーなしの `--bypass` はローカルのファイルに記録し、あなた自身のターミナルでタイプした、レイヤーなしの `--clear-bypass` は、それを記録するすべてのファイルをクリアします（チャットからエージェントが実行すると、ローカルのファイルだけをクリアし、なおチェックをオフに保つプロジェクトやマシンのファイルを名づけます）。対話的なウィザードはレイヤーを尋ね、リポジトリ内ではプロジェクトポリシーを推奨します。認識されたプロジェクトの外では、マシンのレイヤーだけが有効なので、`--global` が推論されます。`--show` は各実効値を、その勝つソースでラベル付けします。

3つのファイルすべては1つの厳密なスキーマを使います。未知のキーは閉じて失敗し、`offline` や `release-base-url` のような update/release のキーはマシン専用です。エディターは生成された `<harness>/tools/data/aidlc-settings.schema.json` を参照できます。デフォルトの settings ファイルは書かれません。

3つの不変のエフォートのみのプリセットが出荷されます。

| プリセット | Deciding | Reviewing | Writing up |
|--------|----------|-----------|------------|
| `thorough` | session effort | `xhigh` | session effort |
| `balanced`（ウィザードのデフォルト） | `medium` | `medium` | `medium` |
| `minimal` | `medium` | `medium` | `low` |

プリセットはモデル ID を決して設定しません。明示的なグループのダイヤルとエージェントごとの例外が、プリセットのエフォートをオーバーライドできます。各セッションを1つのモデルで走らせる Kiro CLI では、各プリセットは代わりに1つのセッションエフォートです。`minimal` は low、`balanced` は medium、`thorough` は xhigh、またはモデルの次のレベル下です（[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort)）。

アップグレードで、`preset: balanced` や `preset: minimal` を記録したインストールは、その射影が次に再生成されるときこれらのエフォートを拾います。`aidlc update` の後、各プロジェクトで `aidlc config --yes` を実行して記録されたポリシーを再適用するか（開いた作業は続きます）、`aidlc config models --preset balanced --project --yes`（必要に応じて `minimal` に置き換え）で明示的に選びます。アップデートはマシンのランタイムだけを変えます。doctor と `aidlc config models --check` は、変更を適用せずに問題を報告します。記録されたモデルポリシーのないインストールは、出荷のティアのデフォルトを保ち、影響を受けません。

プリセットや既存のプロファイルからプロジェクトのプロファイルを導出します。

```bash
aidlc config models --from thorough --reviewing-effort medium \
  --save-as my-profile --project --yes
```

プリセットとプロファイルはグループのエフォートだけを含みます。生のモデル ID は、エージェントごとの例外でのみ許されます。`--yes` は変更を確認しますが、ポリシーを決して選びません。決定的なフラグがないと、TTY はモデルポリシーのウィザードを開きます。非 TTY の実行は、使い方のガイダンスとともに失敗します。

ハーネスは、読める設定だけを受け取ります。Codex は `max` エフォートを `xhigh` まで制限します。opencode は `xhigh` を `high` まで制限します。Kiro CLI では、プリセットが対話セッション全体に1つのエフォートを設定し、セッションモデルとともにあなたの個人用 Kiro 設定に保存されます（[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort)）。明示的なグループのダイヤルには Kiro の画面がなく、エージェントごとのモデルの例外は、そのエフォートをプロジェクトの `chat.modelDefaults` を通じて運び、それがそのプロジェクトのあなたの個人用エフォートマップを置き換えます。モデルなしで Kiro CLI に設定されたエフォートは、他のツール向けに保たれ、コマンドが1行でそう言います。Kiro IDE、Cursor、GitHub Copilot には、プリセットやグループのエフォートの画面がないので、セットアップはそこでプリセットを記録しません。Kiro では、`aidlc config models --agent` がなお1つのエージェント自身のモデルとエフォートを設定します（[One agent on its own model and effort](harnesses/kiro-ide.md#one-agent-on-its-own-model-and-effort)）。Cursor と Copilot では、とにかく設定したモデルやエフォートは、それを適用するツールのチームメイト向けに保たれ、効かないキーを書かず、コマンドが1行で、このツールはその自身のモデルピッカーで選ぶモデルを使うと言います。その3つでは、すべてのエージェントがセッションのモデルとエフォートを使います（Kiro では、そのエージェントにモデルやエフォートが設定されていない限り）。セットアップのチェックと `aidlc doctor` は、ポリシーを尋ねる代わりにそう言い、doctor はそのハーネスに名前で記録されたエージェントモデルについてだけ警告します。

モデルポリシーはエージェントスコープです。ステージファイルはモデルやエフォートのキーを決して運びません。スコープは引き続きステージの重要度を所有します。

### モデルとエフォートを選ぶ

AI-DLC は能力の高い推論モデルでもっともよく機能します。推奨のモデルは Claude Opus 4.8 です。どこでモデルとエフォートを設定するかはハーネスによります。

- **GitHub Copilot、Cursor、Kiro IDE:** ホストで、セッション全体について。すべてのエージェントは、あなたが `/aidlc` を実行するチャットのモデルとエフォートを使い、AI-DLC が記録する何もそれを変えません。例外は Kiro で、`aidlc config models --agent` が1つのエージェント自身のモデルとエフォートを設定します（[One agent on its own model and effort](harnesses/kiro-ide.md#one-agent-on-its-own-model-and-effort)）。手で `model:` の行ではなく、そこで設定します。手の `model:` は `aidlc config models --check` がドリフトとして報告します。Copilot では、エージェントの `.md` ファイルの `model:` のピンは移植可能ではありません。CLI と VS Code がモデル名を異なって読むためです。
- **Claude Code、Codex CLI、opencode:** セッションのモデルとエフォートが、コンダクターと継承するすべてのエージェントを駆動します。`aidlc config models` がエージェントのエフォート（`balanced` プリセットはそれらを medium に設定）とエージェントごとの例外を設定できます。
- **Kiro CLI:** セッションモデルとその1つのエフォート。`aidlc config models` がそれらをあなたの個人用 Kiro 設定に保存します（プリセットがエフォートを設定します。`minimal` は low、`balanced` は medium、`thorough` は extra-high）。`/model` と `/effort` が Kiro の中でそれらを変えます。`/model` の切り替えは、`/model set-current-as-default` でそれを保存して初めて、コンダクターがディスパッチするエージェントに届きます。推奨のセットアップは、あなたがモデルについてすでに保存したエフォートを保ちます。Kiro IDE の行ではセットアップが Kiro CLI のセッションモデルだけを保存します。[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort) を参照してください。

組織が Opus なしで、Claude Sonnet のような中位のモデルだけを提供する場合、

- **セッションを medium エフォートで始めます。** ワークフローは多くのターンを走り、より高いエフォートはモデルをそのどれでもより長く考えさせるので、high や maximum のエフォートは実行全体をずっと遅く高価にします。Medium は、設定できるハーネスで `balanced` プリセットがエージェントに与えるものです。
- **必要なステージについてだけエフォートを上げ**、たとえば難しいユニットでの Code Generation、次にまた下げます。GitHub Copilot、Cursor、Kiro IDE、Kiro CLI ではそれがセッションのエフォートです（Kiro IDE では、developer エージェントにエフォートが設定されていない限り）。Claude Code、Codex CLI、opencode では、Code Generation は developer エージェントで走り、それについてプリセットやエフォートが記録されていない間だけセッションに従います。そうでなければそのエフォートは記録されたものです。上げるには、たとえば `aidlc config models --agent developer --effort high --project --yes` でそれを記録します。それはワークフローが開いている間も機能します。config が developer エージェントのファイルを書き直し、ハーネスが次にそのエージェントを始めるとき（Claude Code はエージェントの次の開始時にそうします。すでに走っているステップは、開始時のものを保ちます）それを使います。コマンドは、それを戻すもの（1つのエージェントの設定には `--effort default`、その設定だけを取り除きます）を表示します。
- **ステージの間に、新しいチャットでモデルやエフォートを変えます。** [Changing Model Mid-Workflow](11-session-management.md#changing-model-mid-workflow) を参照してください。

ワークショップを走らせていますか。[Facilitator Guide](facilitator-guide.md) が準備のチェックと各実行を小さく保つことをカバーします。

### セッション内の別名

`/aidlc --config [section]` は、これら同じ config のセクションの会話的な別名です。コンダクターは尋ねる前に現在の JSON の状態を読み、あなたが望む変更だけを集め、受け入れられた各セクションを1つの正確な `aidlc config <section> <explicit value flags> --yes` コマンドを通じて着地させます。セクションを変えずに残すとコマンドは走りません。着地または断りの後、別名は止まります。ワークフローの作業を進めることも再開することもありません。

### ランタイムの診断

`aidlc config runtime` は、プロジェクトのフックが実際に使う環境を確認します。Linux では、`getconf PATH` に加えて `/etc/environment` の `PATH` の行、`/etc/login.defs` の `ENV_PATH`、`environment.d` から非対話のベースラインを導出します。macOS では `getconf PATH` に加えて `/etc/paths` と `/etc/paths.d` を使います。Windows ではシェルプロファイルをロードせずに User と Machine の PATH を読みます。次に、インストールされたフックのバイトが要求するコマンド（コピー射影には `bun`、ネイティブ射影には `aidlc`）を解決し、選ばれたハーネス CLI を確認します。

```bash
aidlc config runtime --show
aidlc config runtime --check
aidlc config runtime --record-paths --yes
aidlc config runtime --reset --yes
```

`--record-paths` は解決された回答を `harness.json` に記録します。フックのコマンドを書き直しません。ホストの権限ルールと Codex のフックの信頼は、素の `bun` や `aidlc` のコマンドプレフィックスにバインドするので、それを絶対パスに置き換えると既存の信頼契約を無効にします。コマンドが対話専用、または不在のとき、セクションは代わりにプラットフォーム固有の PATH の指示を与えます。

`/aidlc --doctor` は、その `Runtime hook PATH` の行として同じプローブを表示します。コマンドが現在のシェルの PATH にだけあるが、このプロジェクトのフックが発火しているとき（`.aidlc-engine/hooks-health/` の、過去10分間の、古くない、終わっていない起動からのハートビート）、行は通り最後にいつ発火したかを名づけます。ハーネスは明らかにそのフックにその PATH を渡しています。そうでなければ警告し、コマンドが見つかったディレクトリを名づけ、ターミナルから始めたハーネスは変更が要らず、`.bashrc` や `.zshrc` の編集はチェックを変えないと言います。

ハーネス CLI のチェックは、その一致するハーネスについて `claude`、`kiro-cli >= 2.6.0`、`codex >= 0.145.0`、`opencode` を要します。Copilot CLI と Cursor の `agent` CLI は、それらのインストールが VS Code や IDE だけで駆動されることがあるので advisory です。`kiro-ide` ディストリビューションは別の CLI を要しません。`kiro-cli` はそこで任意で、ターミナルから AI-DLC を走らせるときだけ必要で、あるときは 2.24.1 に対して確認されます。

### プロバイダーの診断

`aidlc config providers` は、このプロジェクトのインストールについてプロバイダーの回答を記録します。ハーネスにすでに構成されたプロバイダーを保つのがデフォルトの回答です。Amazon Bedrock は明示的なオプトインです。Kiro CLI と Kiro IDE は、モデルアクセスが Kiro に付いてくるので尋ねられません。`other` は手動で構成したプロバイダー向けに使えたままで、了承のリマインダーを運びます。

```bash
aidlc config providers --provider current --yes
aidlc config providers --provider amazon-bedrock \
  --region us-east-1 --profile default --yes
aidlc config providers --show --json
aidlc config providers --check
aidlc config providers --mark-done bedrock-model-access --yes
aidlc config providers --reset --yes
```

`--region`、`--profile`、`--opencode-default` は、記録または選択されたプロバイダーが `amazon-bedrock` のときだけ適用されます。

資格情報の検出はオフラインのみです。AWS の環境変数、`~/.aws/config`、`~/.aws/credentials`、role とコンテナの資格情報の変数、AWS SSO のキャッシュを調べます。STS、Bedrock、モデルのエンドポイント、その他のネットワークサービスを決して呼びません。

記録された Bedrock の回答は、通常のステージングされた config のトランザクションを通じて適用されます。

| ハーネス | 記録された回答の適用 |
|---------|-----------------------------|
| Claude Code | Bedrock を有効にし、`AWS_REGION` と任意の `AWS_PROFILE` をあなた自身の `.claude/settings.local.json` に書く（git が無視する。プロファイルは `harness.json` に記録されない）。`.mcp.json` の AWS MCP の URL と `AWS_REGION` のメタデータも同じリージョンに保つ |
| Codex CLI | 選択を記録し、プロバイダー、資格情報、モデルを `~/.codex/config.toml` に保つようユーザーに指示する |
| Kiro CLI | プロバイダーの回答なし。モデルアクセスが Kiro に付いてくる |
| Kiro IDE | プロバイダーの回答なし。モデルアクセスが Kiro に付いてくる |
| opencode | `provider.amazon-bedrock.options.region/profile` を `opencode.json` に書くことを提供する。`--opencode-default yes|no` が回答を記録する |
| GitHub Copilot | 手動の BYOK 環境セットアップの了承を記録する |
| Cursor | 手動のプロバイダーとモデルピッカーのセットアップの了承を記録する |

Bedrock のモデルアクセスと IAM の権限の検証は、オフラインで自動化できません。したがって記録は名づけられた保留中のアクションを運びます。`--show` がそれらをリストし、`--check` はそれらが保留中の間は非ゼロのままで、`--mark-done <id>` が完了を記録します。Codex のプロバイダーのセットアップは、実効のユーザー構成と代替の資格情報チャンネルがオフラインで解決できないので、完了後も明示的に自己申告のままです。`--check` は、セットアップを検証済みと記述する代わりに、その警告とともに成功を返します。`--provider current` は、ハーネスの構成されたプロバイダーを保ち、AI-DLC がその出荷のデフォルト、または Claude、Codex、opencode のプロジェクトファイルからの以前の記録に帰属させられる Bedrock の値だけを取り除きます。カスタマイズされた Claude のモデルの別名は保たれます。カスタマイズされたレガシーの Codex の Bedrock ブロックも保たれます。`--check` は、それがなおそのプロバイダーを名づけるとき、構成をクリーンと言う代わりに警告を報告します。`--provider other` は、手動で構成した非 Bedrock のプロバイダーを記録し、`--acknowledge` が供給されるまでそのセットアップを保留中と報告します。`--reset` は、Claude、Codex、opencode のプロジェクトファイルから、正確なレガシーの AI-DLC の Bedrock のデフォルト、または以前の記録された回答向けに書かれた値を取り除きます。証明されていない値は保たれます。Claude Code では、`--provider current`、`--provider other`、`--reset` は、あなたの `.claude/settings.local.json` から Bedrock のスイッチとリージョンも取り出します。そこの `AWS_PROFILE` は残り、コマンドがそう言います。

Claude Code では、各人の Bedrock の回答はその人自身のものです。チームメイトのクローンは、プロジェクトの記録を運びますがあなたの設定を運ばず、`aidlc config providers --check` と doctor が、Bedrock は記録されているが彼らにはオンになっていないと一度彼らに警告します。以前のリリースでセットアップされたプロジェクトは、誰かがもう一度 `aidlc config providers` に答えるまで、共有の `.claude/settings.json` に回答を保ちます。それは回答を彼ら自身のファイルに移しそう言います。リフレッシュやアップデートはそれを残します。

質問は目の前のハーネス向けに言い回されるので、各インストールはそれに実際に存在する2つのパスを提供します。

| ハーネス | `amazon-bedrock` が記録するもの |
|---------|--------------------------|
| Claude Code | AWS のリージョンとプロファイルをあなた自身の `settings.local.json` に、AWS MCP のリージョンを存在するとき `.mcp.json` に |
| Codex CLI | AWS のリージョンとプロファイルをプロジェクトの記録に、次に `$CODEX_HOME/config.toml` でのユーザーレベルのプロバイダーのセットアップを案内する |
| OpenCode | AWS のリージョンとプロファイルを、`opencode.json` に書くことを提供する |
| GitHub Copilot | あなたが Copilot の BYOK プロバイダーの変数を自分で設定すること |
| Cursor | あなたが Cursor でプロバイダーを自分で構成すること |


Kiro CLI と Kiro IDE は自分のモデルアクセスを提供するので、AI-DLC はそれらにモデルプロバイダーを構成しません。`aidlc config providers` は、モデルアクセスが Kiro に付いてくると述べ何も尋ねません。`kiro-cli` が読めないときの Kiro IDE での初回実行のウィザードも同様で、Kiro CLI、そして `kiro-cli` が読める Kiro IDE では、そのステップ2が代わりに Kiro CLI のセッションモデルを選びます。プロバイダーのフラグは拒否され、Providers の行はレガシーの記録にかかわらず `[ok]` と読めます。`aidlc config providers --reset --yes` は、以前のビルドが残した記録をクリアします。以前のビルドからの `builtin` の記録はなおロードされハーネス管理として読まれ、保留中のアクションはありません。レガシーの Kiro の Bedrock の記録も、その保留中のアクションを含め無視され、それらから何も書かれません。`.kiro/settings/mcp.json` の `aws-mcp` のリージョンは、モデルプロバイダーの回答ではなく素の MCP 構成です。そのファイルが運ぶリージョンが、以前のビルドの Bedrock の回答がそこに置いたものでもあなたが置いたものでも、リフレッシュをまたいで保たれ、`--reset` はそのファイルをそのまま残します。

他のすべてのハーネスは、現在のプロバイダーを保つか Amazon Bedrock にオプトインするかを尋ねます。現在のプロバイダーを保つのが、AWS の資格情報が検出されたときも含め、デフォルトです。Copilot と Cursor は、自分の BYOK やプロバイダーの設定を通じて Bedrock に達します。AI-DLC はそれを実行するのではなく保留中のアクションとして追跡します。

Kiro では、`--check` は回答が要らないと言い、レガシーの記録があっても 0 で終了します。回答のない GitHub Copilot と Cursor では、`--check` と `doctor` は、モデルアクセスがセッションに付いてくるので回答が要らないと言い、`--check` はあなた自身の Amazon Bedrock アクセスを記録するコマンドを名づけます。他のすべての記録されていないセクションでは、検証済みの回答を報告する代わりにその状態を名づけ、出荷のフォールバックのバイトが有効なままなのでなお 0 で終了します。

これらのハーネスでは `keep current` が最初の回答でデフォルトです。`amazon-bedrock` が2番めの回答です。記録された回答でセクションに再入すると、それを保ちます。Bedrock は、あなたが明示的に置き換えない限りそのリージョンとプロファイルを保ち、`other` はその保留中の手動セットアップのアクションを保ちます。保留中のアクションは、なお `--mark-done` で完了できます。

### 信頼の診断

`aidlc config trust` は、ホストネイティブの信頼を読み検証します。信頼のシード、権限ルール、IDE の設定を決して再生成しません。プロジェクトの外へのその唯一の書き込みは、Kiro IDE と Kiro CLI の Workflows のスイッチと、Windows での Kiro IDE のデフォルトターミナルで、あなたがそれらを頼むときだけです。

```bash
aidlc config trust --show
aidlc config trust --check
aidlc config trust --acknowledge --yes
aidlc config trust --reset --yes
aidlc config trust --kiro-workflows off --yes   # Kiro IDE; or: on
aidlc config trust --kiro-cli-workflows off --yes   # Kiro CLI; or: on
aidlc config trust --kiro-terminal powershell --yes   # Kiro IDE on Windows
```

Kiro IDE については、`--show` と `--check` は Kiro の Workflows のスイッチ（Kiro のユーザー設定の `kiroAgent.workflows.enabled`、だからあなたのすべてのプロジェクトをカバーする。オンの間、AI-DLC のレビューとヘルパーは走らない）も読みます。`--kiro-workflows off|on` はその1つのキーを変え、ファイルの他のすべてのバイトを保ちます。Workflows がオンで、このコンピュータであなたが答えていない間、セットアップは一度尋ね、`aidlc config --yes` がそれをオフにします。あなたの回答は AI-DLC のインストールフォルダの `kiro-ide-workflows` に保たれるので、他のプロジェクトはもう尋ねません。その設定ファイルに AI-DLC が読み進められないエラーがあるとき、Kiro はなお Workflows をオンと読むことがあるので、`--show` は読めなかったと言い、`--check` とセットアップは、ファイルが再び読めるまで（あなたが以前に何を答えても）警告し、次の Kiro IDE のチャットが一度あなたに伝えます。そのファイルのエラーを直します。同じ Kiro の行で、`--show` と `--check` は Kiro CLI 自身の Workflows のスイッチ（あなたの Kiro CLI 設定の `chat.enableWorkflows`、`kiro-cli settings` を通じて読む）も読み、それは Kiro CLI のチャットで同じツールを奪います。`--kiro-cli-workflows off|on` が Kiro CLI を通じてそれを設定し、その回答は、Kiro IDE のものとは別に、`kiro-cli-workflows` に保たれます。Kiro CLI が答えないと、それは表示されません。[Kiro's Workflows feature](harnesses/kiro-ide.md#kiros-workflows-feature-stops-ai-dlcs-reviews-and-helpers) を参照してください。

Windows では、Kiro IDE はそのエージェントのコマンドをあなたのデフォルトのターミナルプロファイル（Kiro のユーザー設定の `terminal.integrated.defaultProfile.windows`）で走らせます。それが Command Prompt（Kiro がコマンドの返信を、それが1秒以内に終わるときだけ表示するので、ほとんどの AI-DLC の返信が空で返る）で、このコンピュータであなたが答えていない間、セットアップは一度、それを PowerShell に設定するかを尋ね、`aidlc config --yes` がそれを設定し、`--kiro-terminal powershell` がそれを単独で設定します（すでに PowerShell のときはそう言います）。それぞれその1つのキーを変え、ファイルの他のすべてのバイトを保ち、あなたの回答は AI-DLC のインストールフォルダの `kiro-ide-terminal` に保たれます。[Command Prompt as Kiro's terminal](harnesses/kiro-ide.md#command-prompt-as-kiros-terminal-on-windows) を参照してください。

Codex については、チェックは `$CODEX_HOME/config.toml` の完全なプロジェクト固有の信頼シードのエントリセットを要します。2つのサポートされる対処は、1回の TUI の `Trust all and continue` のパス、または `<PROJECT_DIR>` を置き換え完全なシードをマージすることです。それまでゼロの Codex のフックが発火します。`--dangerously-bypass-hook-trust` は信頼されていないフックを発火させず、2つめのシードセットを追記すると無効な TOML になります。

`kiro-ide` ディストリビューションについては、信頼はコンダクターの `permissions`（`.kiro/agents/aidlc-aidlc.md`）で出荷されるので、チェックはそこで何も加えません。Kiro IDE 1.x はもう `.vscode/settings.json` の `kiroAgent.trustedCommands` を読みません。`--show` は、選ばれたハーネスの信頼と allowlist のファイルをリストします。

Copilot については、チェックは Copilot CLI の `trustedFolders`（`COPILOT_HOME` の下の `config.json`、なければ Windows では `%USERPROFILE%\.copilot`、他では `~/.copilot`）を読み、それがプロジェクトをカバーしないとき警告します。プロジェクトの上のフォルダがカウントされます。VS Code はそのリストを決して読みません。そのフックは信頼されたワークスペースと Chat: Use Hooks 設定のオンを要し、AI-DLC はそれを見られないので、Trust の行がそれらを名づけます。CLI がプロジェクトを信頼していないとき、`aidlc config trust`（とセットアップのウォーク）が方法を言います。プロジェクトで一度 `copilot` を実行し、「Yes, and remember this folder for future sessions」を選びます。AI-DLC は CLI の `config.json` 自体を決して編集しません。フォルダを信頼するとそのコードが走るためです。

信頼のチェックは、コピーインストールがよく見落とすプロジェクトの兄弟も検証します。すべてのハーネスの `aidlc/`、Codex の `.agents/`、opencode と Copilot の `.aidlc/` エンジンです。

doctor は、インストールされた instruction ファイルを config の所有のベースラインに対しても分類します。損なわれていない管理ブロックは `block present, user content preserved` を報告します。欠けたブロックやファイルは `aidlc config` を実行するよう言います。手で変更された管理ブロックやフレームワーク所有の丸ごとのファイルは競合を報告します。onboarding の `# AI-DLC` のタイトルの代わりに書かれた行は、それとは別のもの、プロジェクト自身のものです（下記参照）。行は、複数のハーネスツリーが存在するとき、呼び出しているハーネスに従います。

### プロジェクトのフラグ

`aidlc config flags` は、デフォルトスコープ、swarm モード、フックのデバッグ、sensor のタイムアウト、質問の保持、明示的なガードのバイパスや儀式のキルスイッチについて、プロジェクトの回答を記録します。

```bash
aidlc config flags --default-scope <installed-scope> \
  --swarm on --hook-debug off --sensor-timeout-ms 90000 \
  --question-retention-days 30 --project --yes
aidlc config flags --bypass AIDLC_SKIP_ARTIFACT_GUARD --local --yes
aidlc config flags --show
aidlc config flags --check
aidlc config flags --reset --project --yes
```

実際の環境変数が常に勝ちます。既存のツールとフックは、まず環境を読み、次に変数がないときローカル、プロジェクト、マシンの設定を解決します。これは CI と一回限りのシェルのエクスポートをスクリプト可能に保ちます。

`--question-retention-days <days|unlimited>` は、決して答えられなかった質問のリクエストのコピーを AI-DLC がどれだけ長く保つかを制御します。デフォルトは、正の整数が記録されない限り unlimited です。値が設定されると、それだけの日数より古いコピーは、AI-DLC が次に作業をするとき取り除かれ（status、help、その他のクエリは何も取り除きません）、期限切れの質問は、答えられると拒否されます。`unlimited` を渡すと、他のフラグを変えずに選ばれた設定レイヤーから値を取り除きます。`AIDLC_QUESTION_RETENTION_DAYS` が一致する環境のオーバーライドです。

デフォルトスコープの名前は、インストールされたスコープファイルから読まれます。セクションは組み込みのスコープ名で分岐しないので、スコープの改名とプラグインのスコープはデータのままです。Claude Code では、config は `.claude/settings.json` のステージングされた `AWS_AIDLC_DEFAULT_SCOPE` の値も書き直します。そうでなければ出荷のセッション環境が、より低い優先順位の記録を覆い隠します。

記録可能なバイパスのセットは、文書化された回復と儀式のスイッチを含みます。

- `AIDLC_SKIP_ARTIFACT_GUARD`
- `AIDLC_SKIP_HUMAN_PRESENCE_GUARD`
- `AIDLC_SKIP_REVISION_BACKSTOP`
- `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD`
- `AIDLC_DISABLE_ENSEMBLE_EVIDENCE`
- `AIDLC_DISABLE_PLAN_APPROVAL_GUARD`
- `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK`
- `AIDLC_DISABLE_REVIEW_FREEZE_HOOK`
- `AIDLC_DISABLE_USAGE_TRACKING`
- `AIDLC_DISABLE_SENSORS` — sensor の実行と sensor のゲートチェックを無効にする
- `AIDLC_DISABLE_LEARNINGS` — ステージの learnings の儀式を無効にする
- `AIDLC_DISABLE_SUMMARY_CONFIRMATION` — ステージの承認ではなく、別の summary-confirmation チェックポイントを無効にする

ウィザードはバイパスを決して提供しません。それらは明示的な `--bypass <name>` を要します。`--show` は、有効な各バイパスとそのガードを弱める帰結を表に出します。1つを記録またはクリアすると、その undo コマンドと、それが切り替えたチェックの行だけを表示します（加えて未解決のセットアップのステップ）。`--json` と `--quiet` の出力は変わりません。使用トラッキング、sensors、learnings を除くすべてのバイパスは、人からチェックを奪うので、1つがオンの間 AI-DLC は1行でそう言います。次のステップで、すべてのチャットの開始時に（opencode を除く。session-start のコンテキストを表示しません）、`--show` で、doctor の Flags の行で、です。行は、チェック、いつから、どう設定されたか、それを戻す `--clear-bypass` コマンドを名づけます（[CLI commands](12-cli-commands.md) の「Environment kill switches」を参照）。

これらのうち4つは、マシン全体についてフェンスをオフにします。問題が1つのマシンではなく1つの作業のとき、`/aidlc config set guard.<fence> off` が、その作業だけについて単一のフェンスを下げ、それを記録し、次の作業のためにそれを戻します。[Guard Policy](13-customization.md#guard-policy) と [The five fences](13-customization.md#the-five-fences) を参照してください。

### プロジェクトの選択

`aidlc config project` は、インストールされたプラグインの選択、MCP の同意、シェル補完の回答を記録します。

```bash
aidlc config project --plugins aidlc,test-pro --mcp none \
  --completions zsh --yes
aidlc config project --show --json
aidlc config project --check
aidlc config project --reset --yes
```

コピーチャンネルの射影では、`config project` は、プロジェクト自身のファイルから、それがすでに持つリリースで、プラグイン、MCP、補完の選択を適用するので、ダウンロードは要りません。MCP をオンに戻すと、ハーネスフォルダが保つ出荷のサーバーリストを読みます。プロジェクトが別のものにピン留めされているとき、またはそのリストがハーネスフォルダにないときにだけ、リリースを要します。そのときターミナルで尋ね、スクリプトは `--download` を加えます。`--from <path>` は代わりに、あなたがダウンロードしたファイルを使います。`aidlc-copy-runtime-X.Y.Z.tar.gz`、その展開された `runtime/` フォルダ、または1つのハーネスルートです。あなたが `.mcp.json` に自分で加えたサーバーは、決して記録も削除もされません。

プラグイン名は、インストールされたグラフ、スコープ、プラグインのサイドカーから発見されます。ハードコードされていません。選択は引き続き `harness.json` の既存のトップレベルの `plugins` 配列を使うので、グラフとランナーの再生成は、プラグイン合成と同じ選択のシームを使います。ワークフローが開いている間のプロジェクトの変更は、どのリフレッシュとも同じく行われ（「Refresh Safety」を参照）、何が変わったかを、1つのコマンドでそう言えるとき以前の選択を戻すコマンドとともに言います。開いた作業が必要とするプラグインをオフにすると、その作業を名づけます。プラグインが再びオンになると続きます。同じコマンドに `--dry-run` を加えて、プロジェクトや設定のファイルを変えずにそのプランをプレビューします。

MCP の同意は `defaults` か `none` のままです。以前の同意のない非対話のプロジェクトの変更は `none` を記録しますが、`.mcp.json` がすでに出荷のサーバーを出荷のまま保持しているなら、`defaults` を記録しそこのサーバーを保ち、何も加えません。`--yes` は変更を確認するだけで、MCP エントリを決して加えません。

Claude Code では、`.mcp.json` が同意管理される画面です。`--check` は `defaults` と `none` の両方を検証し、後の素の config のリフレッシュが回答を再適用します。Kiro CLI は常に `.kiro/settings/mcp.json` を出荷します。`defaults` はそのファイルとその5つの出荷のサーバーで満たされ、`none` は指示のみの設定でフレームワーク所有のファイルを取り除きません。現在の Codex、opencode、Copilot、Kiro IDE、Cursor のディストリビューションは MCP の画面を出荷しないので、その記録された回答は情報的で、`--check` を永久に赤にしません。`--show` は、ファイルが存在するときはいつでも実際の MCP ファイルを名づけます。

補完は指示のみで、マシンのファイルを書きません。ネイティブインストールは次のようなコマンドを表示します。

```bash
eval "$(aidlc system completions bash)"
```

コピーチャンネルのインストールは、一致する Bun の呼び出しを表示します。たとえば次のとおりです。

```bash
eval "$(bun .claude/tools/aidlc.ts system completions bash)"
```

Fish は `... completions fish | source` を、PowerShell は `... completions powershell | Out-String | Invoke-Expression` を使います。

既存のプロジェクトのスタンプは、リフレッシュのハーネスを固定します。新しい対話的なプロジェクトはハーネスを尋ねます。非対話の実行は `--harness` を要します。`.aidlc-version` が存在すると、config はその正確なバージョンの、一致するプロジェクトのハーネスでのソースを要します。

config は、`.git`、`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` を含むディレクトリ、またはそこにすでにセットアップされた AI-DLC のハーネスツリーを認識します。それらの形の外では、対話モードは確認を尋ね、非対話モードは `--project-dir` を要します。

Claude の任意の MCP 統合は、TTY なしでは `none` をデフォルトとします。以前の選択がないとき、人の TTY が尋ねられます。`--yes` と `--json` は MCP の同意を与えません。信頼できる自動化は、`--project-dir`、`--harness`、`--mcp defaults|none` を明示的に供給します。JSON は出力を制御しますが、それだけでは TTY のプロンプトを無効にしません。

正確なスクリプトの承認には次のとおりです。

```bash
token=$(
  aidlc config --project-dir "$PWD" --harness claude --mcp none \
    --dry-run --json | jq -r .data.planToken
)
aidlc config --project-dir "$PWD" --harness claude --mcp none \
  --plan-token "$token" --json
```

両方の呼び出しに同一のソースと挙動のオプションを使います。プレビューの後にソースバイト、オプション、プロジェクトの状態が変わると、トークンが変わり適用は閉じて失敗します。

### リフレッシュの安全性

作業が開いている間に実行するどの `aidlc config` も、拒否されるのではなく行われます。パークされたワークフローを含みます。設定の変更（`config models`、`flags`、`runtime`、`providers`、`trust`）はプロジェクト自身のファイルを読み、リリースを持ち込みません。それぞれ何が変わったかを、1つのコマンドが以前の値を戻すところではそのコマンドとともに表示します。モデルやフラグの変更は、それを拾う開いたワークフローも名づけます。バイパス、フックのデバッグ、sensor のタイムアウト、質問の保持はすぐに適用され、再起動はありません。モデルと swarm は次のステップから適用され（すでに走っているステップは開始時のものを保ちます）、ただし Kiro CLI ではモデルやエフォートの変更は次の Kiro CLI のセッションから適用されます。走っているものは開始時のものを保つためです。デフォルトスコープは新しい作業にだけ適用され、保存されたモデルプロファイルは `--from` がそれをロードするまで何も変えません。runtime、providers、trust の回答はワークフローの行を表示せず、そのコマンドが走る環境でその変数が設定されている間、他のどの設定ファイルも記録しないバイパスを記録またはクリアするコマンドも、他に何を変えても同様です。開いた作業は、それが走るエディターや CLI の環境を読み、コマンドはそれを見られません。

リリースファイルを持ち込むリフレッシュ（素の `aidlc config`、`--from`、`--download`、`config project`、またはピン留めされたプロジェクトが先に必要とするアップデート）も行われ、そう言います。

```
  Updated. Your open work (default/add-login) carries on.
```

新しいリリースが、あなたがすでに完了したステージを違うやり方でして、あなたのものが何も変わっていないとき、あなたの作業は通り、何もやり直すよう尋ねません。ステージが前は要らなかったドキュメントを今は必要とするなら、あなたの次のステップが一度そう言います。たとえば「AI-DLC now does Functional Design differently from when yours ran; your work stands, and `/aidlc --stage functional-design` goes back to it (the stages after it reopen too).」です。そうでなければそれは言われず、`/aidlc --status` がその行を示します。あなた自身の作業への変更は、その通常の質問を保ちます。

ファイルが別のリリースから来たとき、次の行は戻る方法を言います。

```
  To go back: `aidlc config --pin 2.9.0 --yes` (this pins the version for everyone on the project; `aidlc config --unpin` removes the pin).
```

すでにピン留めされたプロジェクトでは、`--pin` の部分だけを与えます。コピーされたプロジェクトでは、行は代わりに以前のリリースのファイルを名づけます。`aidlc-copy-runtime-2.9.0.tar.gz` とその `.sha256` を1つのフォルダに入れ、次に `bun .claude/tools/aidlc.ts config --from <that file> --yes` を実行します。開いた作業の隣に加えられたハーネスは、あなたが名づけるファイルから来て、その行は加えたフォルダを名づけます（`Added .codex. Your open work (...) carries on.`）。ハーネスを取り除くコマンドはないので、undo の行はありません。

リフレッシュは次を保ちます。

- すべてのワークスペースの記録、監査シャード、知識、そして出荷の射影にない他のプロジェクトファイル
- 既存の `aidlc/active-space` とスペースメモリのファイル。プロジェクト所有のシードです
- 可変の `tools/data/harness.json` の、プラグインの選択と将来のポリシーの記録を含む、非アイデンティティの兄弟キーすべて
- プラグインが合成したファイルと記録されたステージの貢献。次にグラフ、ランナー、スコープ、コンパイルされたテーブルの画面を再生成します
- upstream がオーサリングしたオーケストレーターの文章。保たれたプロジェクトの合成からそのコンパイルされたステージとスコープの領域を再構築しながら
- AI-DLC が管理するフォルダの中でホストツールが自分のためにインストールするもの。opencode が初回起動時に `.opencode/` の下に書く `package.json`、`.gitignore`、`node_modules/`（リンクを含む）など。config はこれらをコピーも所有も削除もしません
- Kiro CLI がその 3.0 エンジン向けにアップグレードした `.kiro/agents` のエージェントファイル（Kiro は置き換えた各ファイルをその隣に `.json.bak`、次に `.json.bak.1` と保ちます）。リフレッシュはそれらを Kiro が残したまま保ち、1行でそう言い、リリースの残りを持ち込みます。`aidlc config --harness kiro --force` がリリースのバージョンを取り、Kiro が次にその 3.0 エンジンで起動するときそれらを再びアップグレードします。リリースがそのようなファイルが許すものを変える（allow エントリを落とす、または Kiro がアップグレードしたファイルが持っていた deny エントリを加える）とき、リフレッシュは、Kiro が次の 3.0 起動でそれを自分で再びアップグレードする（その自動アップグレードがオン。あなた自身の Kiro 設定の `chat.enableAutoAgentUpgrade` が true。Kiro の最初の 3.0 起動での **Enable auto-upgrade** がそれを保存します）、そのファイルが AI-DLC がそこに書いたもので、Kiro のコピーが他のフィールドを保つ、という条件で、リリースのバージョンを自分で戻します。そうでなければ Kiro のコピーを保ち、ファイルがなお古いリリースが許したものを許すこと、`--force` がリリースのバージョンを取ることを1行で言います

`aidlc/` の下では、インストールとリフレッシュはそれらのシードだけをコピーします。クローンのアイデンティティ、セッション、エンジンの健康、その他のマシンごとの状態は、インストール済みランタイムから決してコピーされず、インストールのベースラインに記録されません。

ローカルに変更されたフレームワーク所有のファイルは、以前のベースラインに対して競合します。`--force` は、手でオーサリングされたオーケストレーターの文章へのローカルの編集を含め、それらのファイルをリフレッシュされた候補で置き換えます。無関係なプロジェクトの内容を主張しません。行末だけはローカルの変更ではありません。Git がチェックアウトでそれを書き直すので（Git for Windows はデフォルトで LF のファイルを CRLF でチェックアウトします）、構成されたプロジェクトのクローン、ブランチ切り替え、stash pop、新しい worktree は競合なしにリフレッシュします。`aidlc doctor` は、リフレッシュが拒否するファイルを、その `AI-DLC files` の行で名づけます。

1つの行が例外です。Claude Code の `.claude/CLAUDE.md` と、Copilot の `AGENTS.md` の AI-DLC の部分は、`# AI-DLC` のタイトルで始まります（以前のリリースはそこに `# Project Name <!-- Replace with your project name -->` を出荷しました）。唯一の変更がそのタイトルの代わりに書かれた行のとき、リフレッシュはその行を保ち残りを更新し、競合はありません。他のどの変更も上記のように競合します。プロジェクトの名前、メモ、ルールは、すべてのツールが読む `aidlc/spaces/<space>/memory/project.md` に属します。

新しいリリースがもう出荷しない、変わっていないフレームワークのファイルは取り除かれ、config が各々を名づけます。リフレッシュは `Removed N files that are no longer part of AI-DLC <version>:` とリストを表示し、`--dry-run` は同じリストを `Will remove` として表示します。1つのフォルダのいくつものファイルは1行として表示されます。git が取り除かれたすべてのファイルを追跡するとき、config は1つを戻す `git restore <path>` も名づけます。後のリフレッシュは戻されたファイルをそのまま残します。JSON では、これらのアクションは `detail: "no longer shipped"` を運びます。

`.claude/settings.json` はプロジェクトに属します。AI-DLC はファイル全体を所有するのではなくエントリを貢献します。プロバイダー、スコープ、モデルの回答に伴うものを含むリリースのリフレッシュは、所有の競合なしにそれらのエントリをマージし、`--force` はこれを変えません。

Claude については、リフレッシュは AI-DLC のフック登録をその出荷のイベント、マッチャー、コマンドに復元し、次にあなた自身のフックグループを追記します。出荷の `permissions.allow` エントリを最初に置き、あなたの追加の allow エントリ、`deny`、`ask`、その他の権限キーを保ちます。退役した出荷の allow エントリは自動では取り除かれません。チームがそこに設定したステータスラインは保たれます。AI-DLC 自身の `statusLine` はもうこのファイルに出荷されません。リフレッシュがそれを取り出し、それを持っていた各クローンがそれをその人自身の `.claude/settings.local.json` に保ちます（それがその人自身のステータスラインを覆うとき一度言われます）。そうでなければ、誰かが `--statusline on` でオンにしたときだけ現れます。`companyAnnouncements` は、ないか出荷のベースラインとまだ一致するときリフレッシュされ、そうでなければあなたの値が保たれます。どちらかのカスタムキーを削除してリフレッシュすると出荷のものを取ります。環境とその他のトップレベルの設定（`disableAllHooks` を含む）は、記録されたプロバイダーやプロジェクトの回答に帰属する値を除き、あなたのものに留まります。

`.codex/config.toml` もプロジェクトに属します。AI-DLC はその設定をキーごとに貢献します。`developer_instructions`、`sandbox_mode`、`suppress_unstable_features_warning`、`tool_output_token_limit`、そして `[shell_environment_policy]`、`[sandbox_workspace_write]`、`[agents]`、`[features]`、`[tools]` のテーブルで出荷するキーです。AI-DLC の `[tui]` の `status_line` はプロジェクトの選択です（`--statusline on|off`）。リフレッシュはそれを決して出荷、退役、変更しません。プロバイダー、スコープ、モデルの回答に伴うものを含むリフレッシュは、それらのキーだけを変え、他のすべてのバイトを保ちます。あなた自身のキー（AI-DLC のテーブルの中も）、あなた自身のテーブル（`[agents.<role>]` や `[mcp_servers.<name>]` など）、コメント、順序、綴りです。誰も変えていない AI-DLC の値はリリースの値を取り、あなたが変えた値はあなたのものに留まり、リリースが別のものを出荷するとき注記が付きます（キーを削除してリフレッシュすると取ります）。削除された AI-DLC のキーは、注記とともに戻ります。以前のリリースが出荷した `AIDLC_RULES_DIR` の値は、スイッチが残したどのスペースでも空にされ、そのテーブルのあなた自身のキーは残ります。そこのあなた自身のフォルダはあなたのものに留まります。すでに自分の `.codex/config.toml` を持つプロジェクトは、初回インストールでそれを保ち、AI-DLC がその設定を加えます。リフレッシュが安全にマージできないファイル（パースしない、または AI-DLC のテーブル名の1つを別のもの、たとえばテーブルの配列に使う）は、なお競合を報告します。`--force` はそのとき、無関係なプロジェクト所有のフィールドを保ちながら AI-DLC のテーブルを復元します。明示的な `--from` は、プロジェクトのコピーの代わりにそのソースを選びます。

人向けの出力は、`.claude/settings.json` や `.codex/config.toml` の AI-DLC エントリが復元または追加されたとき、そしてそれらの1つについてのあなた自身の値（カスタムの Claude の announcement、または Codex のキー）が、このリリースが別のものを出荷する間保たれたときに、`Note:` を表示します。JSON の出力は同じメッセージを `data.notes` で公開します。それらを復元するには、素の対話的なセットアップのウォークではなく、`aidlc config --harness claude` または `aidlc config --harness codex` を使います。コピーチャンネルのプロジェクトは `--from <the runtime/<harness> root you copied from>` も渡します。

`opencode.json` はチームに属します。config は AI-DLC のエントリをそれに加え、他のすべてのキー、値、コメント、行を保ちます。プロバイダーの回答は AI-DLC が書いたエントリだけを編集します。

### ルートの統合と所有

| 画面 | ハーネス | ポリシー |
|---------|-----------|--------|
| `.gitignore` | すべて | インストール済みハーネスの出荷エントリの和集合を含む1つのマーク付き AI-DLC ブロックを所有する。その外のすべてのバイトを保つ |
| `.mcp.json` / `mcpServers` | Claude | 同意された、ベースライン所有のエントリだけを加えるか取り除く。ユーザーキーとオーバーライドを保つ |
| `.kiro/settings/mcp.json` / `mcpServers` | Kiro CLI | サーバーごとに、`.mcp.json` のように。あなたが変えていない AI-DLC のサーバーについてだけリリースに従い、あなたが加えるサーバーとオンにした出荷のサーバーを保つ。セットアップ時にプロジェクトがすでに持っていたファイルはマージされ、拒否されない |
| `AGENTS.md` | Kiro CLI, Kiro IDE, Codex, Cursor, OpenCode, Copilot | 1つのマーク付きブロック。ハーネスに中立で共有（`shared: "identical"`）、ただし Copilot は例外で、そのブロックはその `@`-import を運ぶ。プロジェクトの指示を保つ |
| `opencode.json` | OpenCode | `json-entries`: AI-DLC のエントリ（`$schema`、その `skills.paths` と `instructions` の文字列、その `permission` ルール）を、ないところにだけ加え、チーム自身のコマンドのルール（`rm -r...` と `git push` の前の asks）をマップで最初に置き、その後のチームのルールがなお決める。チームのモデル、プロバイダー、自身の指示とルール、コメント、レイアウトを保つ。AI-DLC が書いたものを記録し、なおその値を保持するエントリだけに従うか退役させる。以前のリリースで AI-DLC が丸ごと書いたファイルは採用される。コピーランタイムはこのファイルを外す。そのセットアップ（またはセットアップが決して走らなかった最初のセッション）が AI-DLC の部分を加える |
| `.vscode/settings.json` | Copilot | `jsonc-settings`: `chat.agent.maxRequests`（200）を、プロジェクトが設定しないときだけ加える。他の誰かが設定した値、他のキー、コメントを決して変えない。AI-DLC が加えたものだけを記録し、退役時は AI-DLC が書いた値を保持する間だけそれを取り除く。一度加えると、チームがそれを保つファイルから取り出したキーは戻されない。コピーランタイムはこのファイルを外す |

**プロジェクトに複数のハーネス。** ハーネスは、そのエンジンディレクトリが異なり排他的な管理ブロックを共有しないとき共存できます。`AGENTS.md` は中立でバイト同一（`shared: "identical"`）で、Kiro CLI、Kiro IDE、Codex、Cursor、OpenCode にまたがるので、別々のエンジンディレクトリを持つそれらのどれも共存できます。Codex のハーネス固有の onboarding は、プロジェクトが信頼されるとき、プロジェクトの `.codex/config.toml` の `developer_instructions` を通じて注入され、`.codex/onboarding.md` がその読める形です。Claude Code は他のどのハーネスとも共存できます。Copilot の `AGENTS.md` は排他的のままです。そのブロックを出荷する別のハーネスとペアにすると、どちらが先にインストールされているかにかかわらず、`cannot coexist in one project` で拒否されます。Kiro CLI と Kiro IDE はなお `.kiro/` を共有し、OpenCode と Copilot は `.aidlc/` を共有するので、それらのペアは共存できません。Kiro CLI と Kiro IDE は代わりに互いを置き換えられます。それらの1つを持つプロジェクトで、`aidlc config --harness kiro-ide`（または `--harness kiro`）が `.kiro/` をその場でもう一方に切り替えます。切り替えは、インストールされた行の所有のベースラインから計画されるリフレッシュです。その行が出荷したファイルだけを取り除き、`aidlc/` を保ち、置き換えまたは取り除くローカルに変更されたファイルを競合として報告し、どのリフレッシュとも同じく作業が開いている間に行われます。`kiro-ide` への切り替えは、AI-DLC が所有しないすべての `.kiro/hooks/*.json` ファイルを名づけます。Kiro はそれらをその v3 エンジン（`kiro-cli --v3`）と Kiro IDE で走らせます。あるとき、切り替えはそのファイルの正確なセットのあなたの承認でのみ適用されます。ターミナルでプロンプトに答えるか、切り替えを `--dry-run` で実行し、ファイルを確認し、その dry run が表示する `--plan-token` でそれを適用します。その確認の後に加えられた、取り除かれた、改名された、変わったフックファイルは切り替えを止めます。切り替えがそのトランザクションロックを取る前、またはそのファイルをコミットする間に現れるものを含み、それは切り替えをロールバックします。切り替えは、`.kiro/hooks` がリンクやファイルのとき（その下の何かを読む前）、または AI-DLC が所有しないフックエントリがリンクや通常ファイル以外のものであるときに、それをたどるのではなく拒否します。そのベースライン（`.kiro/tools/data/aidlc-manifest.json`）を要します。それなしでは、先に `aidlc config --harness <installed>` でインストールされた行をリフレッシュします。AI-DLC がそこで出荷するファイルだけをリストする前に記録されたベースラインも同様で、リフレッシュがそれを最新にします。切り替えは損なわれたものを決して変えません。自分で脇に移し（表示されたステップがそのフルパスを名づけます）、次にそのリフレッシュを実行します。信頼のレビューをクリアする切り替えは、それを再び記録する `config trust --harness <row>` コマンドを名づけます。`--harness` なしで `--from` に渡されたリリースは、行を決して切り替えません。OpenCode と Copilot はこの方法で切り替えられません。ルートブロックが共有されない古いインストール済みハーネスについては、`predates shared onboarding` のエラーが、先に `aidlc config --harness <name>` でそれをリフレッシュすることを提案します。これは古い兄弟へのヒントにとどまり、リフレッシュが共存を可能にするという約束とは別です。その後もなお拒否するなら、その兄弟のブロックは排他的です。Copilot のブロックはリフレッシュ後も排他的のままです。もう `AGENTS.md` を共有と宣言しないリフレッシュ元も、別のインストール済みハーネスがそれを共有する間拒否されます。`refusing to refresh <harness> from a release whose AGENTS.md is not shared`。ブロックを共有と宣言するリリースを使います。`--force` はこのガードをバイパスできません。別のリリースの兄弟が所有する共有の `AGENTS.md` ブロックは、遅延された更新ではなく競合です。エラーがリフレッシュの順序を名づけます。選ばれたハーネスをその兄弟と同じリリースからリフレッシュするか、兄弟を先に選ばれたリリースからリフレッシュします。Cursor の手動コピーのインストーラーは単一ハーネス（プライベートな `AIDLC CURSOR` マーカー、`aidlc config` の所有のベースラインなし）です。マルチハーネスのプロジェクトは代わりに `aidlc config --harness cursor` で Cursor を加えなければなりません。

`.gitignore` は `shared: "union"` を宣言するので、`aidlc config` はすべてのインストール済みハーネスの出荷エントリを結合する1つのブロックを書きます。余分なエントリは `# <harness> harness` の下に現れます。ハーネスを加えると、その兄弟の出荷のブロックのコピーが使えるとき、変わっていない兄弟所有のブロックを結合します（`merge (combined with <harness>)`）。そのコピーのない古いインストールは、リフレッシュされるまで所有を保ちます。各ハーネスは、その次の config の呼び出しで同じ結合ブロックのハッシュを記録します。複数のハーネスが存在すると、すべての `aidlc config` の呼び出しが、バイパスを単独で記録またはクリアする場合を除き、`--harness <name>` を要します。

`aidlc doctor` は、各ハーネスツリーが `tools/data/aidlc-stamp.json` に記録するリリースを比較します。それらが異なるとき、`Harness trees on different releases` と警告し、各ツリーのリリースを名づけ、他をレベルにするコマンドを与えます。ピン留めされたプロジェクトのツリーはピンに持ってこられます。config がすべてのツリーをそれにリフレッシュします。コピーされたプロジェクトではそれは `bun <harness-dir>/tools/aidlc.ts config --harness <name> --download` です。ピンなしでは、ネイティブではエンジンのリリースにない各ツリーについて `aidlc config --harness <name>` です。コピーされたプロジェクトでは各ツリーが自分のリリースを走らせるので、他はもっとも新しいツリーのリリースから、その `aidlc-copy-runtime-<version>.tar.gz` を `--from` で渡してリフレッシュされます。どの config 実行も記録していないツリーは、まず自分のリリースで1回の `--download` リフレッシュを取ります。開いた作業はリフレッシュを通じて続くので、終わるのを待つ必要はありません。

AI-DLC の `.gitignore` の行は、その自身のエントリだけです。以前のリリースは、そのブロックの先頭に汎用のテンプレート（ログ、`node_modules`、`dist`、エディターのファイル）も置きました。アップグレードの後の最初のリフレッシュは、それらの行をファイルのあなたの部分、AI-DLC のものの上に保ち、一度そう言うので、それらが無視したものが git に見えるようになることはありません。config が決して走らなかったコピーは、同じ AI-DLC ブロックと `AGENTS.md` ブロックを、最初のチャットが始まるか作業が最初に作られるとき、コピー自身の `tools/data/root-blocks/` から得ます。config は後で、ちょうどリリースが出荷したものであるブロックを、その自身のものとして扱います。`opencode.json` の opencode のエントリは、同じフォルダから同じ瞬間に届きます。

歴史的な出荷の射影からの既知のマークなしのファイルと JSON エントリは、その正確な記録された SHA-256 の署名が一致するときだけ採用されます。他のどのマークなしの内容も、AI-DLC について何を言おうとチームのものです。config はそれをプレフィックスとして保ち、新しい管理ブロックを追記します。改名も削除も要りません。有効な UTF-8 でないルートファイル（`.gitignore`、`AGENTS.md`、または AI-DLC がマージする他のもの）はそのまま残され、config が安全にマージする前にエンコーディングの変換を要します。

Git リポジトリ内では、config は、`--dry-run` の間を含め、ユーザー所有のルールがコミット対象のワークフロー記録を隠すかも確認します。`aidlc/` のようなルールは隠します。config はなお完了し、ルールのファイル、行、隠された記録のパス（`memory/**`、`codekb/**`、`intents.json`、`aidlc-state.md`、`audit/*.md`）を名づける注記で終わります。新しいものがチームメイトに届かないためです。git がすでに追跡するファイルはコミットされ続けます。初回実行のセットアップと `--quiet` の出力は同じ所見を示します。ルールはあなたのものなので、config はそれを決して書き直したり拒否したりしません。隠すのが意図でないなら狭めます。このチェックは、Git が使えない、またはプロジェクトが Git リポジトリでないときスキップされます。

`/aidlc --doctor` は、コミットされていない記録のチェックの隣でこのチェックを繰り返します。その **Workspace record visibility** の advisory は、config が成功した後に ignore ルールが加えられると、同じルールと隠されたパスを名づけます。警告は doctor の終了コードを変えず、記録が隠されていない、または Git がプロジェクトを確認できないときはありません。

`--force` は、変更された、ベースライン所有の管理ブロックや管理されたハーネスのファイルを置き換えられます。ユーザー所有の JSON の値、`opencode.json` のチーム自身のエントリを含むものを、上書きできません。不正な JSON、不正または重複のマーカー、非通常ファイルのターゲット、整合性を証明できない退役した所有の内容は、ハードな競合です。

計画されたすべてのパスは1つのアクションを受け取ります。

| アクション | 意味 |
|--------|---------|
| `create` | 存在しないフレームワークのパスを加える |
| `update` | フレームワーク所有のバイトをリフレッシュする |
| `merge` | 管理ブロック、JSON マップ、JSON 配列を突き合わせる |
| `preserve` | 現在のまたはプロジェクト所有のバイトを保つ |
| `remove` | ベースラインが以前所有し upstream で退役した内容を取り除く |
| `conflict` | 所有や整合性が証明できないので拒否する |

成功した config はホスト固有の次のステップを表示します。

| ハーネス | 次のステップ |
|---------|-----------|
| Claude Code | このプロジェクトで Claude Code を開き（このフォルダですでに開いているなら、終了して開き直す）、`/aidlc --doctor` を実行する |
| Kiro CLI | `kiro-cli --v2`（Kiro CLI 2.21.4 以降。古いものは [Kiro CLI](harnesses/kiro-cli.md#prerequisites) を参照）、次に `/aidlc --doctor` を実行する |
| Kiro IDE | このプロジェクトを Kiro IDE で開く。Restricted Mode バナーがウィンドウ上部に出てこのフォルダの中身が分かっているなら、その Manage、次に Trust を選ぶ。コマンドパレット（Ctrl+Shift+P、macOS では Cmd+Shift+P）から `Developer: Reload Window` を実行し、チャットパネルのエージェントピッカーで aidlc エージェントを選び、次に `/aidlc --doctor` を実行する（Kiro CLI では代わりにプロジェクトで `kiro-cli --v3` を始める。Kiro がこのワークスペースを信頼するか尋ねこのフォルダの中身が分かっているなら「Trust, continue」を選ぶ。次に `/aidlc --doctor` を実行する） |
| Codex CLI | `codex` を実行する（フックについて尋ねたら Trust all and continue を選ぶ）、次に `$aidlc --doctor` |
| OpenCode | `opencode` を実行する、次に `/aidlc --doctor` |

## アップデートとバージョンの選択

| コマンド | 公開のオプションと挙動 |
|---------|-----------------------------|
| `aidlc update` | マシンのチャンネルの最新のリリースを、すべてのハーネスを含む完全なランタイムとともにインストールし、次にアトミックにアクティブにする。`--version <version>`、`--channel <stable\|preview>`、`--from <release-dir>`、`--release-base-url <url>`、`--release-api-url <url>`、`--ca-bundle <path>`、`--offline`、`--dry-run` を受け取る。 |
| `aidlc update --check` | インストールせずにチャンネルのアップデートメタデータをリフレッシュする。チャンネルが走行中のものより新しいリリースを持つとき 5、現在のとき 0（チャンネルの最新より新しい走行中のリリースは現在）、利用不可/オフラインのとき 3、チェックが無効のとき 1 を返す。 |
| `aidlc use <version>` | 保持されていないとき正確な安定版またはプレビューのバージョンをインストールし、次にプロジェクトファイルを変えずにマシンでアクティブにする。 |
| `aidlc config --channel [stable\|preview]` | マシンのリリースチャンネルを設定する、または値が与えられないときそれを表示する。 |
| `aidlc config --pin <version>` | 必要なとき正確なバージョンをインストールし検証し、次に `.aidlc-version` をアトミックに書き、そのマシンローカルの解決されたターゲットを記録し、マシンのアクティブなポインタを変えずにプロジェクトのピンを登録する。 |
| `aidlc config --unpin` | `.aidlc-version`、そのマシンローカルの解決されたターゲット、そのレジストリのエントリを取り除く。 |
| `aidlc config --statusline <on\|off>` | ステータスラインに AI-DLC の進捗を表示する、または取り出し、1行でそう言う。Claude Code: あなた自身の `.claude/settings.local.json`。Codex: 共有の `.codex/config.toml`、プロジェクトの全員のため。`--harness <claude\|codex>` が両方インストールされているとき1つを選ぶ。 |
| `aidlc config ... --download` | どの config コマンドにも、このマシンが欠くとき、プロジェクトが必要とするリリースを取得させる。ピン留めされたリリース、なければそのファイルがすでに持つもの。ネイティブでは `--pin` がするようにそのリリースをインストールし登録する。コピーされたプロジェクトでは `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードする。チェックサムを、`gh` がインストールされているときリリースの証明を検証し、次にコマンドを完了する。`--release-base-url` と `--ca-bundle` がミラーを選ぶ。ターミナルでは代わりに config が尋ねる。スクリプトはフラグを要する。 |

人向けのライフサイクルの出力は、完了した各事実を述べます。アップデートは、old-to-new のバージョンチェック、検証済みのダウンロード、アトミックな切り替え、保持された以前のバージョン、刈り取られた保護されていないリリース、プロジェクトリフレッシュの気遣いを報告します。no-op は `You're on the latest version of aidlc (<version>).` と言います。`--dry-run` は `Would update aidlc from <old> to <new>.`、または何も変わらないとき `You're on the latest version of aidlc (<version>); nothing to update.` と言います。プレビューチャンネルでは、アップデートの行は `preview releases` と `latest preview version` と言います。素の `aidlc update` は、走行中のものより古いリリースを決してインストールしません。安定版に従い新しいプレビューを走らせるマシンでは、何も変えず `You're on <preview>, newer than the latest stable <x.y.z>, so there's nothing to update.` と言い、次に安定版に戻る方法（`aidlc update --channel stable`）とプレビューを得続ける方法（`aidlc config --channel preview`）を言います。より新しい安定版が出荷されると、それに移ります。マシンが従うチャンネルへの、もう一方のリリースからのアップデートは、`Switched release channel from <a> to <b>.` を加えます。1回の実行でもう一方のチャンネルに移るもの（`--channel`、`--version`、`--from`）は、マシンがそのチャンネルに従うと、同じ2つの進む方法とともに言います。`aidlc use` は `Now using` を `Already using` と区別し、アンインストールは、どのマシンの状態が取り除かれたか保たれたかを正確に述べます。JSON と quiet のメッセージは安定したマシンの契約を保ちます。アップデートの JSON は `channel` を、切り替えでは `channelSwitch` を運びます。

アップデートは、アクティブなポインタを変える前に候補をダウンロードし完全に検証します。失敗したアップデートは、以前の一貫したインストールを自動的に復元します。成功したアップデートは、以前のアクティブなバージョンとすべての登録されたプロジェクトのピンを保持し、次に古い保護されていないバージョンを自動的に刈り取ります。別のロールバックや保持バージョン管理のコマンドはありません。戻るには [Go Back to an Earlier Version](#go-back-to-an-earlier-version) を参照してください。

## 以前のバージョンに戻る

このマシンを以前のリリースに戻すには、`aidlc use <version>`、たとえば `aidlc use 2.10.0` を実行します。マシンがそれを持たなければそのリリースをダウンロードし、次に `Now using aidlc 2.10.0 (was 2.11.0; retained locally, no project changes).` と言います。ピンのないすべてのプロジェクトが今 2.10.0 で走ります。プロジェクトで `aidlc config` を実行して、そのファイルも 2.10.0 に持ってきます。`aidlc use 2.11.0` が再び前に進みます。

1つのプロジェクトをそれに関わる全員について戻すには、ピン留めし、次にリフレッシュします。

```bash
aidlc config --pin 2.10.0 --yes
aidlc config --yes
git add .aidlc-version
```

ピンがプロジェクトを 2.10.0 に切り替えます。リフレッシュがそのファイルをそのリリースに持ってきて、2.10.0 が出荷しないファイルをリストします。`aidlc config --unpin` がプロジェクトを再びマシンに従わせます（[Project Pins and CI](#project-pins-and-ci)）。

2.8.0 より前のリリースはネイティブのリリースがないので、`aidlc use` と `aidlc config --pin` はそれらを選べません。`No published native release is available yet` で止まります。コピーされたプロジェクトは、[Refresh Safety](#refresh-safety) が示すように、以前のリリースの `aidlc-copy-runtime-X.Y.Z.tar.gz`（2.9.0 から公開）で戻ります。

## リリースチャンネル

`main` は共有の開発ブランチです。**stable** チャンネルは、選ばれたコミットを `vX.Y.Z` とタグ付けされた GitHub リリースとして公開します。**preview** チャンネルは、次の安定版リリースの前に `main` からの変更を、決して「latest」とマークされない GitHub の prerelease として試させます。ソースバージョンと changelog のエントリは、リリースの準備中に更新されます。

スケジュールされた実行と手動の実行は、1つのシリアライズされた公開のキューを共有します。実行は、ソースが最新の公開済みプレビュー以降変わっていないとき、またはより新しいプレビューがすでにそれを含むとき（古い実行、リトライまたはキュー）、公開をスキップします。そのチェックと nightly のテストはなお走り、プレビューは公開されません。`main` が同じ UTC の日付で複数回進むとき、各変わったソースは、次のビルドカウンターで新しいプレビューを公開できます。

プレビューは、その nightly のテストが失敗してもなお公開されます。そのリリースノートはそのとき警告で始まり、Full Suite の失敗レポート（失敗したジョブと失敗したテスト）で終わるので、プレビューに頼る前にそれを確認します。

プレビューの id は `<x.y.(z+1)>-preview.<YYYYMMDD>.<N>` です。ソースツリーの現在の安定版バージョンの次のパッチ、計画中に選ばれた UTC のビルド日、リトライカウンター（最初は `1`）です。ワークフローは、ソースバージョンを編集せずにプレビューバージョンを計算します。失敗した試行が残したドラフトとタグは id を予約します。同じ日付でのリトライや別の変わったソースは、それらの占有された id を超えて `N` を進めます。

安定版の id は正確に `x.y.z` のままで、バージョンが現れるどこでも（インストーラーのフラグ、`use`、ピン、`.aidlc-version`、保持されたバージョンのディレクトリ）他の何も受け入れられません。id は `x.y.z` で数値順に並びます。等しいベースでは、安定版リリースがそれから作られたすべてのプレビューの上にソートされ、プレビューはビルド日次にカウンターで並びます。プレビューのアーティファクトの中では、`aidlc version`、`version.json`、doctor のバンドルがすべてプレビューの id を報告します。ソースツリーは決して変更されません。

```bash
aidlc config --channel preview   # follow the preview stream
aidlc update                     # newest published preview
aidlc update --check             # 5 when a newer preview exists
aidlc config --channel stable    # back to the stable stream
aidlc update --channel stable    # newest stable now, reported as a channel switch
```

チャンネルはマシンローカルです。`aidlc config --channel` は、アップデートキャッシュと `pins.json` の隣、インストールルートの下に `channel` マーカーを書き（マーカーがないとき `stable`）、`aidlc uninstall` はそれを他のマシン設定とともに保ち、`--purge` がそれを取り除きます。`aidlc update --channel <c>` は1回の実行でマーカーをオーバーライドします。`--version` と `--from` はチャンネルにかかわらず正確なリリースを選びます。安定版の発見は変わりません（`latest/download` のリダイレクト）。プレビューの発見は、リリースのベース URL の背後のリポジトリのリリースを GitHub API でリストし、プレビューバージョンの id でもっとも新しい公開済みの prerelease を保ち、正確なバージョンのパスを通じてそれをインストールします。公開済みのリリースのないドラフトとタグは無視されます。`github.com` のベース URL については API のエンドポイントが導出されます。他のどのホストにも `--release-api-url <url>` または `AIDLC_RELEASE_API_URL` を設定します。API の失敗、レートリミット、公開済みのプレビューのないリポジトリは、利用不可（exit 3）として報告されます。クライアントは安定版リリースに決してフォールバックしません。アップデートキャッシュはリフレッシュされたチャンネルを記録するので、キャッシュされたプレビューの結果が安定版のチェックに答えることも、その逆もありません。

戻るのは `aidlc config --channel stable` です。素の `aidlc update` はそのとき、あなたが走らせているプレビューより新しい安定版リリースを待ちます。今戻るには `aidlc update --channel stable` を実行します。その id がプレビューより下にソートされても最新の安定版をインストールし、チャンネルの切り替えを報告します。プレビューの保持は、すべてのリリースが持つ保護（アクティブ、ロールバック、使用中、ピン留め）の上の、境界のあるウィンドウです。アップデートの後、もっとも新しい2つの完全なプレビューが残り、自分の保護のないより古いプレビューは刈り取られます。安定版の保持は変わりません。

バージョンの刈り取りも、記録されたファイルリストと空ディレクトリのクリーンアップを使います。選ばれたバージョンが所有されていないか変わったパスを含むなら、刈り取りは拒否され、ファイルはレビューのために保たれます。

プロジェクトのピンはマシンのチャンネルをオーバーライドし続けます。`aidlc config --pin <id>` と `.aidlc-version` はプレビューの id を受け取り、ピン留めされたプロジェクトは、マシンが何に従おうと、その正確な保持バージョンにディスパッチします。

プレビューは、プロジェクトの state-schema の変更を含め、`main` のそのままです。state スキーマを上げるプレビューは、安定版のビルドが理解しないプロジェクトの状態を書き、コードはビルドより新しい状態を開くのを拒否します。そのプロジェクトは、安定版リリースが同じスキーマを出荷するまで、安定版に戻せません。再作成できるプロジェクトでプレビューチャンネルを使うか、それらをピン留めします。

## プロジェクトのピンと CI

```bash
aidlc config --pin 2.10.0
git add .aidlc-version
```

`aidlc config --pin <version>` は、必要ならバージョンをインストールし検証し、`.aidlc-version` を書き、絶対のバイナリのターゲットを gitignore された `aidlc/.aidlc-sessions/` ランタイムディレクトリの下に記録し、実在のプロジェクトのパスをマシンローカルの `pins.json` に登録します。レジストリの読み取りは、ファイルシステムのエイリアス（macOS の `/var` と `/private/var` を含む）を正規化し、JSON の出力は正規のプロジェクトのパスを報告します。同じバージョンの等価なキーは畳まれます。矛盾する等価は、`config --pin` または `config --unpin` がそのプロジェクトのすべてのエイリアスを調整するまで、閉じて失敗します。

`.aidlc-version` だけをコミットします。安定した `aidlc` ランチャーは、整合性チェックされたアクティブなバイナリを起動し、そのディスパッチャーがそれを選ぶ前に完全なピン留めされたバイナリとランタイムを検証します。欠けた、不正な、改ざんされた、または利用不可のターゲットは、`aidlc config --pin <version>` の対処とともに閉じて失敗し、`aidlc doctor` が同じ状態を報告します。マシンのライフサイクルのコマンドはアクティブなバイナリを使います。`doctor`、`config`、`use` は、壊れたピンの背後に決して閉じ込められません。チームメイトがこのマシンの欠くリリースにピンをコミットしたとき、プロジェクトでの config コマンドがそれを名づけ、`--download`（またはターミナルでの yes）が、`config --pin` がするようにそれをインストールし登録し、次にコマンドを完了します。すでにインストール済みのピン留めされたリリースは尋ねずに使われ、その背後のファイルは先に更新されます。

ピンは、プロジェクトを提供するエンジンをすぐ切り替えますが、プロジェクト自身のファイルは、次の `aidlc config` まで、最後にリフレッシュされたバージョンに留まります。`config --pin` と `config --unpin` は、作業が開いている間も頼まれたとおり行われます。プロジェクトのファイルが、それが今従うものとは別のバージョンにある（またはバージョンが記録される前のリリースにある）とき、返信は「Run `aidlc config` to finish updating this project.」で終わります。

新しいクローンや CI ランナーは、config の前にコミットされたバージョンをインストールします。

```bash
version=$(cat .aidlc-version)
tag="v$version"
tmp="$(mktemp -d)"
gh release download "$tag" --repo github.com/awslabs/aidlc-workflows --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --hostname github.com \
  --source-ref "refs/tags/$tag"
sh "$tmp/install.sh" --version "$version" --quiet --yes
rm -rf "$tmp"
aidlc config --pin "$version" --project-dir "$PWD" --quiet
aidlc config --project-dir "$PWD" --harness claude --mcp none --quiet
aidlc doctor --project-dir "$PWD" --quiet
```

root として、root を唯一のユーザーとして走る CI のコンテナジョブやエージェントサンドボックスは、インストーラーの行に `--allow-root` を加えます。ピン留めされたバージョンは `--allow-root` を出荷するリリースでなければなりません。レシピはそのタグ自身の `install.sh` を実行し、古いものはそのフラグを未知の引数として拒否します。

```bash
sh "$tmp/install.sh" --version "$version" --quiet --yes --allow-root
```

## ハーネスの選択

ハーネスの選択は `aidlc config --harness <name>` に属します。マシンレベルのハーネス管理は、公開コマンドの対象外です。

## オフラインパッケージ

リリースアセットのセットがオフラインパッケージです。バイナリ、ランタイム、インストーラー、`version.json`、`checksums.txt` の隣に `aidlc-release.intoto.jsonl` を含みます。接続されたマシンで1つの完全なリリースをダウンロードし、そのディレクトリを変えずに転送します。バンドルが欠けている、または `checksums.txt` を認証しないと、ローカルのインストールは閉じて失敗します。

```bash
gh release download v2.5.45 --repo github.com/awslabs/aidlc-workflows --dir ./aidlc-offline
```

切断されたマシンにインストールします。

```bash
bash ./aidlc-offline/install.sh \
  --from ./aidlc-offline --offline
```

```powershell
& .\aidlc-offline\install.ps1 `
  -From .\aidlc-offline -Offline
```

ネイティブのコマンドについては、`--offline`、`AIDLC_OFFLINE=1`、グローバルの `offline=true` がリリースのソケットを防ぎます。`--from` なしのネットワーク操作はそのとき、変更の前に失敗します。Config、doctor、version、uninstall はいずれにせよローカルです。

## ミラー、プロキシ、CA、アップデート設定

リリース設定は、明示的なオプション、環境、マシン config、デフォルトの順で解決します。

| 設定 | 環境 | マシン config |
|---------|-------------|----------------|
| Offline | `AIDLC_OFFLINE=1`（`0` は明示的にネットワークを有効にする） | `aidlc system config global set offline on` |
| Mirror | `AIDLC_RELEASE_BASE_URL` | `aidlc system config global set release-base-url <url>` |
| Preview releases API | `AIDLC_RELEASE_API_URL`（または `aidlc update --release-api-url <url>`） | `github.com` にはミラーから導出。マシン config のキーではない |
| CA bundle | `AIDLC_CA_BUNDLE` | `aidlc system config global set ca-bundle <absolute-path>` |

4つのマシンのキーを管理します。

```bash
aidlc system config global list
aidlc system config global get update-check
aidlc system config global set update-check off
aidlc system config global set offline on
aidlc system config global set release-base-url https://mirror.example/releases
aidlc system config global set ca-bundle /absolute/path/corporate-ca.pem
aidlc system config global clear ca-bundle
```

キーは `update-check`、`offline`、`release-base-url`、`ca-bundle` です。ブール値は `true|false`、`on|off`、`1|0`、`yes|no` を受け取ります。`aidlc config <get|set|clear|list> ... --global` が等価です。

ミラーのベース URL は、ローカルテスト用のループバック HTTP を除き HTTPS を使わなければならず、資格情報、クエリ、フラグメントを含められません。ネイティブのライフサイクルクライアントは最大5つのリダイレクトに従います。リダイレクトされた URL はクエリを含めますが、なお資格情報やフラグメントを含められません。そのエラーは URL の資格情報、クエリ、フラグメントを伏せます。

ネイティブのリリースクライアントは `HTTPS_PROXY` / `https_proxy` と `NO_PROXY` / `no_proxy` を尊重します。プロキシ URL は HTTP か HTTPS を使わなければなりません。`HTTP_PROXY` は読みません。ブートストラップスクリプトはプロキシの挙動を `curl`、`wget`、`Invoke-WebRequest` に委ねます。Windows では、カスタムの CA バンドルは `curl.exe` を要します。

素の help と管理の一覧は、ネットワークを決してリフレッシュしません。有効なキャッシュされたアップデート通知を表示することがあります。対話的な人の `aidlc doctor`、そしてターミナルの有無にかかわらず `aidlc doctor --export` は、古いまたはない メタデータを 750 ms 以内にリフレッシュすることがあります。他の非 TTY、`--json`、`--quiet` の doctor の実行は、`--check-updates` が明示的でない限りキャッシュのみです。24時間より古いチェックから読まれた doctor のアップデートの行は、バージョンを最新の既知のものとして名づけ、どれくらい前に確認したかを言います。一度も確認していないマシンでは、その予算内で失敗したリフレッシュは、行をまだ確認していないとして通し、`aidlc update --check` を名づけます。明示的な `--check-updates` だけが失敗したチェックを報告します。`doctor --check-updates` と `update --check` は5分のメタデータのバックストップを使います。プレビューの発見とメタデータのダウンロードは同じ期限を共有します。プレビューのリリースを調べることはタイムアウトを再起動しません。アップデートのチェックは最大84文字のバージョン識別子を受け取り、各数値のコンポーネントは安全な整数（最大 9,007,199,254,740,991）でなければなりません。リリースメタデータや既存のキャッシュの無効な識別子は、通知を表示する前に拒否されます。キャッシュは24時間後に期限切れになります。失敗したリフレッシュや、同じチャンネルのインストール済みバイナリより古いメタデータは、有効なキャッシュを置き換えません。成功したリフレッシュは、以前にキャッシュされた未来のバージョンを訂正できます。キャッシュは advisory で、信頼される最小バージョンを確立しません。`update-check=off` は明示的なリフレッシュも無効にしますが、明示的な `aidlc update` を防ぎません。アップデートのチェック（doctor のリフレッシュと `aidlc update --check`）は `version.json` と `checksums.txt` をダウンロードし、マニフェストのチェックサムを検証し、`aidlc-release.intoto.jsonl` をダウンロードも検証もしません。これは供給されたチェックサムに対して整合性を確認します。リリースの由来を認証しません。すべてのインストールのパス（`aidlc update`、`aidlc use`、`aidlc config --pin`、`--from`）は来歴のバンドルを要し、アクティブ化の前にチェックサムを検証します。互換の GitHub CLI が使えるとき、インストールは署名された来歴も検証し、失敗した検証を拒否します。

## プラグイン

AI-DLC 自身のプラグイン（test-pro とそれに続くもの）は、1つの `aidlc-plugins` カタログを共有し、ネイティブインストールはそれをリリースをまたいで1つのパスに保ちます。Linux と macOS では `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/plugins/`、Windows では `%LOCALAPPDATA%\aidlc\plugins\` です。インストーラーはインストールの後にそのフルパスを表示し、`aidlc doctor --verbose` が Machine の下でそれを名づけます。一度あなたのツールに加えます。

```bash
/plugin marketplace add <path>          # Claude Code
codex plugin marketplace add <path>     # Codex CLI
```

インストール、`aidlc update`、`aidlc use <version>`、`aidlc rollback` は、それらがアクティブにするリリースからカタログをリフレッシュし、丸ごと書いてから入れ替えるので、ツールがその半分を決して読みません。アップデートの後、ツール自身のマーケットプレイスのアップデート（Claude Code の `/plugin marketplace update aidlc-plugins`）が、同じパスから新しいプラグインのバージョンを読みます。フォルダが置き換えられないとき、コマンドはなお成功し、フォルダは以前のカタログを保ち、1行が理由とすべきことを言います。Windows で、プログラムがその中のファイルを保持しているかもしれないとき、Claude Code と Codex を閉じて `aidlc use <version>` を実行します。他の原因、たとえばフルのディスクには、それを直して実行します。あなたが自分でフォルダに入れたファイルは決して置き換えられません。行が代わりにそれを名づけます。以前のリリースの `aidlc update` でこのリリースにアップデートしたマシンは、その次の `aidlc use <version>` やアップデートでフォルダを得ます。ソースチェックアウトの `dist/plugins/` とコピーランタイムの `plugins/` は、コピーチャンネルの同じカタログです。

`aidlc doctor` は、インストール対合成のプラグインの状態を報告します。プラグインの変更はプロジェクトの構成で、`aidlc config` を通じて収束します。別の公開プラグインコマンドはありません。

## 出力、自動化、終了コード

公開コマンドは、ルートレジストリが宣言するところで、人向け、`--quiet`、`--json` の出力をサポートします。`--json` は、`ok`、`code`、`status`、`message`、そして利用可能なときコマンド固有の `data` を持つ、スキーマバージョン付きの結果を発行します。`--quiet` は1つの成功行または対処行を発行します。ダウンロードの進捗は人向けモードにのみ現れます。

ネイティブの診断の形式は `aidlc doctor [--project-dir <path>] [--verbose] [--json|--quiet] [--check-updates] [--release-base-url <url>] [--ca-bundle <path>] [--offline]` です。`--export` は編集済みの診断バンドルを書き、`--output <directory>` がその既定のプロジェクトの場所をオーバーライドします。エクスポートの出力は、選ばれたライブレポートのモードに追加されるものです。人向けの出力は Machine、Project、Framework integrity のチェックをグループ化します。すべてのセクションは warning/failure の行を見えるまま保ち、健全な行を既定で畳みます。`--verbose` がすべてのチェックを広げます。警告は advisory で 0 で終了します。失敗したチェックは 1 で終了します。

`--no-color` と `NO_COLOR` は ANSI の出力を無効にします。`--project-dir <path>` は、シェルのディレクトリを変えずにプロジェクトのコンテキストを選びます。`uninstall` のような破壊的な操作は TTY で何も尋ねません。取り除くものと保つものを表示し、次に行います。TTY なしでは `--yes` を要します。`--yes` は、所有、整合性、アクティブなワークフロー、リリースの認証の拒否を決してバイパスしませんが、Windows に1つの例外があります。手作りの Git Bash の転送役のような、AI-DLC が書いていない bin ディレクトリの `aidlc` です。`aidlc use`、`aidlc update`、インストーラーは、ターミナルで一度それを置き換えるか尋ねます。`--yes` が yes と答え、ファイルはその隣に `aidlc.bak-<time>` として保たれます。

| コード | 意味 |
|------|---------|
| 0 | 成功 |
| 1 | 操作の失敗 |
| 2 | 使い方または無効なマシン構成 |
| 3 | 要求されるネットワークの結果、または保持されたランタイムが利用不可 |
| 4 | 整合性または所有の拒否 |
| 5 | チェックが完了しアクションが要る。利用可能なアップデートなど |

## Help と補完

`aidlc --help` は正確に6つの公開コマンドを表示します。各公開コマンドは副作用のないコマンドヘルプも持ちます。`config`、`doctor`、`version`、`update`、`use`、`uninstall` の `aidlc <command> --help`（または `-h`）です。コマンドヘルプは、そのコマンドが受け取るすべてのオプションを、各々の1行の意味とともに名づけ、ダウンロードとミラーのオプション、出力だけを形作るオプションが残りと別に読めるようグループ化します。`use` は、それが取るバージョンも記述します。意図は、そのヘルプだけからコマンドを正しく実行できることです。Config レベルのヘルプは6つのポリシーセクションすべてを名づけます。`aidlc config <section> --help` はセクション固有のヘルプを保ちます。`aidlc help --all` は、隠された `engine` と `system` の名前空間を明らかにし、そのフルのインベントリのために `aidlc engine --help` / `aidlc system --help` を示します。インストーラーは、公開のルートレジストリから生成された Bash、Zsh、Fish、PowerShell のファイルを、ユーザーごとの AI-DLC のデータルートの `completions/` ディレクトリの下に置きます。公開の補完生成の動詞はありません。

## トランザクションと回復

プロジェクトとマシンの変更は、宛先のファイルシステムでステージングし、候補を検証し、リネームの境界を通じてコミットします。ファイルシステムは、一貫したファイルのアイデンティティと追記の挙動、アトミックなファイルの置き換えとディレクトリのリネーム、排他的な作成、意味のある通常ファイルの `fsync` について引き続き責任を持ちます。AI-DLC はリネームのための copy-and-delete のフォールバックを加えません。計画された状態に対して検出された同時の変更は、新しいバイトを上書きするのではなく中断します。放棄された所有者プライベートのステージングは、ロックと所有のチェックの後にだけ掃かれます。サポートされないディレクトリの `fsync` は許容されるので、成功したコマンドだけでは、クラッシュの後のメタデータの耐久性を約束できません。

トランザクションロックは、1つの所有者スタンプ付きのディレクトリ、プロジェクトの `.aidlc-transaction.lock` を使い、すべてのストレージで排他的な作成で作られます。古いリリースが残したライブのファイルロックも締め出します。ローカルの一時ディレクトリの専用の所有者スタンプ付きのゲートが、それを共有するコマンドの間で、トランザクションと所有の変更をシリアライズします。別の一時ディレクトリを持つコマンド、1つのフォルダ上の Windows の隣の WSL、または共有フォルダ上の2台のコンピュータは、プロジェクトロック自体で隔てられます。別のコンピュータがスタンプしたロックはこのコンピュータから決してクリアされず、コマンドは、そこで何も走っていないときに削除するフォルダを名づけます。AI-DLC はハードリンクを作りません。ドキュメントのコピーや生成されたファイルは、排他的な作成とリネームでその名前に置かれ、別のコマンドが先にそこに置いたファイルを決して置き換えません。これは、1つのフォルダの1つのビューを共有しない独立したマウントにまたがる分散ロックではありません。同じバケットにアクセスするときもです。

初回実行のプローブが機能のチェックで、トランザクションはそれを繰り返しません。検証や実際のロックの取得の代わりにはならず、通る呼び出しはアトミックなリネームやクラッシュの耐久性を証明できません。ストレージがサポートしないコミットのリネームを持つトランザクションは、同じストレージの行と fix とともに止まります。互換性はドライバーとその実際のセマンティクスによります。

| ストレージ | 互換性の境界 |
| --- | --- |
| ローカルの ext4 や XFS、EC2 EBS ボリュームを含む | 要求されるファイルシステム操作に適したプロジェクトストレージ。 |
| exFAT、ネットワーク共有、WSL の `/mnt/c` のような、ハードリンクのないストレージ | 残りの要件が満たされると、config とトランザクションはローカルストレージと同じように走る。AI-DLC はハードリンクを作らない。 |
| Amazon S3 の Mountpoint | フルのワークフローは非互換のまま。ディレクトリのリネームと一般的な可変ファイルの更新が使えない。S3 Express の単一ファイルのリネームはそれらの制限を取り除かない。[Mountpoint filesystem semantics](https://github.com/awslabs/mountpoint-s3/blob/5e400f788f8cbca028f3314d84ef2df2c7fcf536/doc/SEMANTICS.md) を参照。 |
| s3fs-fuse | リネームは copy then delete を使いアトミックでない。通るプローブは、一般的なクラッシュセーフな AI-DLC のトランザクションのサポートを確立しない。[s3fs limitations](https://github.com/s3fs-fuse/s3fs-fuse/blob/fc5778fe83b533a9beed9383f3ce99de76207ef9/README.md#L153-L163) を参照。 |

upstream のセマンティクスとシミュレートされた失敗は、特定の S3 マウントのライブの検証とは別物です。マウントがこれらの要件を満たせないとき、互換のローカル/EBS のプロジェクトストレージを使います。[filesystem troubleshooting](15-troubleshooting.md#config-fails-with-a-storage-error) を参照してください。外部または不完全なロックの所有者には、手動の回復の前に [Transaction lock ownership](15-troubleshooting.md#transaction-lock-ownership) に従います。

中断されたコミットのロールバックが安全に完了できないとき、証拠は、マシンのインストールルートまたはプロジェクトルートの下の、名づけられた `.aidlc-recovery-*` の隔離に保持されます。`aidlc doctor` がそれを報告します。必要なファイルを回復し、AI-DLC の変更が走っていないことを確認し、次にリストされたディレクトリだけを手動で取り除きます。自動のステージングのクリーンアップは隔離を決して削除しません。

Windows のアンインストールは、走っている実行ファイルが自分のコマンドシムを取り除けないので、回復可能な継続を使います。後のコマンドは、他の作業をする前に、有効な保留中の継続を、1つがまだ走っていない限り再開します。結果を記録せずに止まるワーカーは、最大3回再開されます。

クリーンアップが失敗すると、失敗したステップと理由を記録し、`aidlc doctor` が両方を報告します。失敗したクリーンアップは他のコマンドによって決して再起動されません。それらは働き続けますが、アンインストールが終わるまでマシンの変更はブロックされたままです。報告された問題を解消し、`aidlc uninstall` を再び実行します（元が使ったなら `--purge` とともに）。

- まだ何も取り除かれていないなら、失敗したプランは捨てられ、アンインストールはディスクのファイルから再び計画するので、確認の後に編集されたファイルは保たれます。
- 取り除きが始まっていたなら、同じプランが再開します。以降に編集されたファイルは保たれます。

`aidlc` コマンド自体（bin の `aidlc.cmd` と `aidlc.exe`、シム、アクティブなバージョンのポインタ、アクティブな `aidlc.exe`）は、他のすべてのファイルと User PATH エントリの後、最後に取り除かれるので、失敗したクリーンアップもなおそれをリトライするコマンドを残します。PATH エントリがすでに消えているかもしれないので、そのコマンドを、`aidlc doctor` が表示するフルパス（既定で `& "$env:LOCALAPPDATA\aidlc\bin\aidlc.cmd" uninstall`）で実行します。失敗がその最後のファイルを取り除く間に起き、コマンドがもう走らないなら、インストーラーを再び実行します。保留中のクリーンアップを先にリトライするので、2回走らせる必要があるかもしれません。

## コピーチャンネル

サポートされる手動コピーのペイロードは、バージョン付きの `aidlc-copy-runtime-X.Y.Z.tar.gz` リリースアセットです。1つの正確なリリースをダウンロードし、展開し、完全な `runtime/<harness>/` ルートをコピーして、ハーネスツリー、`aidlc/` ワークスペースのシェル、ハーネスが必要とするプロジェクトルートのファイルが一緒に留まるようにします。コピーランタイムは、Copilot の `.vscode/settings.json` のような、チームのエディターが所有するファイルを外すので、コピーがそれらを決して置き換えません。[Copilot guide](harnesses/copilot.md#vs-code-request-cap) が自分で加える1つの設定を名づけます。あなたの `.gitignore` と `AGENTS.md` も外します。AI-DLC は、すでにそこにあるすべての後に自分の行をそれらに加えるか、プロジェクトが何も持たないとき作ります。opencode の `opencode.json` も同じように外されます。コピーのセットアップが AI-DLC のエントリをあなたのファイルに加え、他のすべてをその中に保つか、何もないときファイルを書きます。Claude Code の `.mcp.json` も外されるので、コピーは、`aidlc config` が既定でするように、MCP サーバーなしで始まります。出荷のサーバーをオンにするには、`bun .claude/tools/aidlc.ts config project --harness claude --mcp defaults --yes` を実行します。チームのメモリファイル（`aidlc/spaces/default/memory/team.md`、Practices Discovery があなたが確定したプラクティスを記録する場所、と `project.md`、あなたのプロジェクトのルールと learnings が行く場所）とあなたが選んだスペース（`aidlc/active-space`）も外します。より新しいリリース、または2つめのハーネスをプロジェクトの上にコピーしても、したがってそれらは保たれます。新しいコピーでは、AI-DLC が、あなたが最初に作業を始めるとき、そのバンドルされたコピーから2つのメモリファイルを作ります。**Bun 1.4.4 以降** を使います。CVE-2026-111497 の Brotli デコーダーの修正を含みます。ネイティブの `aidlc` 実行ファイルは要りません。コピーされたランタイムの更新は、それを走らせる Bun のインストールを更新しません。ネイティブのインストールは代わりに、修正された Bun でビルドされた AI-DLC のリリースを必要とします。別の Bun のインストールの更新は、`aidlc` 実行ファイルに埋め込まれたランタイムを置き換えません。Markdown の分析（summary confirmation、Plan Approval のタグ、claim-sources sensor）は Bun の組み込みの `Bun.markdown` レンダラーを使い、インストールされた Bun のレンダリングに従います。

```bash
tag=vX.Y.Z
tmp="$(mktemp -d)"
runtime_asset="aidlc-copy-runtime-${tag#v}.tar.gz"
runtime_checksum="${runtime_asset}.sha256"
source_repo="${AIDLC_RELEASE_REPOSITORY:-awslabs/aidlc-workflows}"
release_workflow="${AIDLC_RELEASE_WORKFLOW:-$source_repo/.github/workflows/release.yml}"
gh release download "$tag" --repo "github.com/$source_repo" --dir "$tmp" \
  --pattern "$runtime_asset" \
  --pattern "$runtime_checksum" \
  --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/$runtime_asset" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo "$source_repo" \
  --signer-workflow "$release_workflow" \
  --hostname github.com \
  --source-ref "refs/tags/$tag"
(cd "$tmp" && sha256sum -c "$runtime_checksum")
tar -xzf "$tmp/$runtime_asset" -C "$tmp"
RUNTIME_ROOT="$tmp/runtime"
cp -R "$RUNTIME_ROOT/claude/." your-project/
cd your-project && bun .claude/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness claude
```

最後の行がコピー自身のセットアップで、展開されたランタイムから一度実行します。最初のチャットの前に AI-DLC の行をあなたの `.gitignore` と `AGENTS.md` に加え、セットアップの残りを確認します。それなしでは、AI-DLC は最初のチャットが始まるとき、または遅くともあなたが作業を始めるときにそれらを加えます。

後で、コピーされたプロジェクトは自分でリリースを取ってきます。config コマンドが、プロジェクトの持たないファイル（チームメイトの新しいピン、あなたが加えるハーネス、復元されたファイル）を必要とするとき、ターミナルで尋ねるか、スクリプトでは `--download` を受け取って、その正確な `aidlc-copy-runtime-X.Y.Z.tar.gz` をダウンロードし、その `.sha256` を、`gh` がインストールされているときそのリリースの証明を検証し、コマンドを完了します。ネットワークアクセスがないとき、エラーの `offline:` 行が、別の場所で取って `--from` で渡すファイルを名づけます。

リフレッシュ（`--from` や `--download` 付きの `config`）が、プロジェクト自身のツールより新しいリリースからファイルを持ち込むとき、そのリリース自身の config が、あなたがタイプしたとおりにコマンドを実行し、`Note:` 行がそれを実行したリリースを名づけます。同じまたは古いリリースは、プロジェクト自身のツールでリフレッシュされます。

アーカイブは、`dist/` の下の新しく再生成された Bun の射影から組み立てられます。その生成されたフックとツールは、含まれた TypeScript を Bun を通じて呼びます。ネイティブのインストーラーとライフサイクルのコマンドは代わりに、`dist-release/` から組み立てられた `aidlc-runtime-X.Y.Z.tar.gz` を消費します。ユーザーは通常そのアーカイブを直接ダウンロードしません。

コピーアーカイブは `version.json` と `checksums.txt` の外に留まるので、既存の 2.8.x のネイティブクライアントがリリースメタデータをパースし自己更新し続けられます。そのバージョン付きの `.sha256` のサイドカーがバイトを直接認証し、リリースの来歴が両方のファイルをカバーします。

コピーインストールでは、あなたのプロジェクトの AI-DLC のファイルは、あなたが走らせるコードです。そのフックはそれらを Bun を通じて走らせ、GitHub Copilot を除くすべてのハーネスで、それが出荷する設定も、エージェントのそれらへの呼び出しを事前承認します。各ハーネスガイドが、その事前承認がどう振る舞うかを記述します。したがってプロジェクトフォルダを信頼するとは、それらのファイルを信頼することを意味します。プロジェクトを変えられる誰もが、それらのフックと事前承認されたコマンドが走らせるものを変えられます。

ネイティブの実行ファイルが許されるとき、`aidlc config` を好みます。ネイティブのランタイムをトランザクション的にインストールし、後のリフレッシュのために所有を記録します。

フレームワーク開発者は代わりに、ソースをクローンし、依存をインストールし、無視されるローカルの出力をマテリアライズできます。

```bash
bun install --frozen-lockfile
bun scripts/package.ts
```

それは、Bun を呼ぶ `dist/<harness>/`、ネイティブの `dist-release/<harness>/`、プラグインの射影をローカルに作ります。どちらの生成されたルートもコミットされません。直接の `bun .../tools/*.ts` の呼び出しは、2つめのネイティブのライフサイクルインターフェースではなく、ソース/開発とデバッグの仕組みのままです。

## プロジェクトから AI-DLC を取り除く

1つのプロジェクトから AI-DLC を取り除くコマンドはありません。`aidlc uninstall` は、このマシンのすべてのプロジェクトについて、マシンのインストールを取り除き、プロジェクトのファイルをそのまま残します。以下のステップは、プロジェクトを、AI-DLC がそれに加えられる前の姿に戻します。それらは、AI-DLC とフォルダやファイルを共有する、あなた自身のハーネスのファイルと設定（以前からあった `.kiro/`、あなた自身の `.claude/settings.json` のエントリ、`AGENTS.md` のあなたの部分）を保ちます。先にプロジェクトのハーネスを閉じます。

### 1. 記録を保つ

プロジェクトがピン留めされている（`.aidlc-version` ファイルがある）なら、AI-DLC がまだインストールされている間に、先にそれをアンピンします。`aidlc config --unpin`、またはコピーされたプロジェクトでは `bun <harness folder>/tools/aidlc.ts config --unpin` です。それは、ファイルを削除してもクリアされない、ピンのマシンの記録もクリアします。

Claude Code では、AI-DLC がまだインストールされている間に、AI-DLC のステータスラインもオフにします。`aidlc config --statusline off`、またはコピーされたプロジェクトでは `bun .claude/tools/aidlc.ts config --statusline off` です。AI-DLC のステータスラインがあなた自身のものを置き換えたとき、それがあなたのものを戻す唯一のステップです。AI-DLC はそれを `aidlc.settings.local.json` に保ち、それを以下で削除します。

`aidlc/` はあなたの作業を保ちます。各 intent の状態、成果物、監査証跡、そしてスペースのメモリと知識です。削除する前にアーカイブします。POSIX シェルでは次のとおりです。

```bash
tar -czf aidlc-records.tar.gz aidlc && rm -rf aidlc
```

PowerShell では（Windows 10 以降は `tar` を含みます）次のとおりです。

```powershell
tar -czf aidlc-records.tar.gz aidlc; if ($?) { Remove-Item -Recurse -Force aidlc }
```

あるなら次も削除します。`aidlc.settings.json`、`aidlc.settings.local.json`、そして config が `.git/info/exclude` に加えたかもしれない `aidlc.settings.local.json` の行です。

### 2. AI-DLC 自身のファイルを削除する

`aidlc config` は、インストールしたものを `<harness folder>/tools/data/aidlc-manifest.json` に記録します。SHA-256 付きのすべてのファイルと、自分の部分を加えた共有ファイルです。このスクリプトはその記録を読み、内容がまだ一致するリストされたファイルだけを削除し、違いが行末だけ（CRLF チェックアウト）のファイルを変わっていないものとして数えます。あなたが変えたファイルを保ちリストし、記録がリストしないファイルを決して削除せず（AI-DLC が走る間に生成するわずかなものを除く）、空にしたフォルダだけを取り除きます。プロジェクトを保持するフォルダ、プロジェクトフォルダの中ではなくその隣に `remove-aidlc.cjs` として保存します。

```js
// Usage, from the project root: node <path to>/remove-aidlc.cjs <harness folder>   (Bun works too)
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const dir = process.argv[2];
const manifestPath = path.join(dir, "tools", "data", "aidlc-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.shippedOnly !== true) {
  console.log(`${manifestPath} predates the shipped-files-only record. Refresh it first with aidlc config --harness <harness>, then run this again.`);
  process.exit(1);
}
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
// A file whose only difference is its line endings (a CRLF checkout) is unchanged.
const unchanged = (file, hash) => {
  const bytes = fs.readFileSync(file);
  const lf = bytes.toString("latin1").replaceAll("\r\n", "\n");
  return [bytes, Buffer.from(lf, "latin1"), Buffer.from(lf.replaceAll("\n", "\r\n"), "latin1")].some((form) => sha(form) === hash);
};
const roots = manifest.rootContributions ?? {};
const shared = new Set([...Object.keys(manifest.entries ?? {}), ...Object.keys(roots)]);
const owned = Object.entries(manifest.files).filter(([file]) => !shared.has(file));
for (const [file, part] of Object.entries(roots)) if (part.policy === "whole-file") owned.push([file, part.hash]);
const removed = [];
for (const [file, hash] of owned) {
  if (!fs.existsSync(file)) continue;
  if (unchanged(file, hash)) { fs.rmSync(file); removed.push(file); }
  else console.log(`kept, changed since install: ${file}`);
}
// Files AI-DLC generates while it runs, which the record does not list.
for (const file of ["harness.json", "scope-grid.json", "stage-graph.json"].map((name) => path.join(dir, "tools", "data", name))
  .concat(path.join(dir, "steering", "aidlc-active-memory.md"), manifestPath)) {
  if (fs.existsSync(file)) { fs.rmSync(file); removed.push(file); }
}
// Remove only the folders this emptied, never one that holds anything else.
for (const file of removed) {
  for (let folder = path.dirname(file); folder !== "." && folder !== path.dirname(folder); folder = path.dirname(folder)) {
    try { fs.rmdirSync(folder); } catch { break; }
  }
}
for (const file of shared) if (fs.existsSync(file)) console.log(`edit by hand: ${file}`);
```

Node.js か Bun で、プロジェクトの各ハーネスフォルダについて一度、プロジェクトルートから実行します。同じコマンドが POSIX シェルと PowerShell で機能します。

| ハーネス | 実行 |
|---------|-----|
| Claude Code | `node ../remove-aidlc.cjs .claude` |
| Kiro CLI, Kiro IDE | `node ../remove-aidlc.cjs .kiro` |
| Codex CLI | `node ../remove-aidlc.cjs .codex` |
| Cursor | `node ../remove-aidlc.cjs .cursor` |
| OpenCode, GitHub Copilot | `node ../remove-aidlc.cjs .aidlc` |

記録が shipped-files-only の記録より前だと言うなら、以前のリリースがそれを書きました。先に `aidlc config --harness <name>` でリフレッシュし（コピーされたプロジェクトでは `bun <harness folder>/tools/aidlc.ts config --harness <name>`）、次にスクリプトを再び実行します。それが保ったファイルを確認します。それはあなたが編集した AI-DLC のファイルなので、まだ編集がほしいときだけ保ちます。

### 3. 共有ファイルから AI-DLC の部分を取り出す

スクリプトは、なお AI-DLC の部分を保持する各共有ファイルをリストします。git が AI-DLC が加えられる前からプロジェクトを持つなら、そのコミットからそれらを復元するのがもっとも早い方法です。たとえば `git checkout <commit> -- .gitignore AGENTS.md .claude/settings.json` です。それは、それ以降それらに行ったどの変更も undo するので、コミットの前に `git diff --cached` を確認します。そうでなければ AI-DLC の部分を手で取り除きます。値は、AI-DLC が書いたものをまだ保持する間だけ取り除きます。チームが変えた値はあなたのものなので保ちます。

| ファイル | 取り除くもの |
|------|--------|
| `.gitignore` | `# BEGIN AI-DLC:gitignore` から `# END AI-DLC:gitignore` までの行と、その上の空行。いくつものハーネスがこの1つのブロックを共有します。 |
| `AGENTS.md` | `<!-- BEGIN AI-DLC:agents -->` から `<!-- END AI-DLC:agents -->` までの行と、その上の空行。 |
| `.claude/settings.json` | `companyAnnouncements`、チームが自分のものを設定していない限り。`statusLine`、そのコマンドが `aidlc` を走らせるとき。コマンドが `aidlc` を走らせるすべてのフックグループ（`aidlc engine hook ...`、またはコピーされたプロジェクトでは `bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook ...`）。`aidlc` を名づける `permissions.allow` エントリと、あなたが加えたのでない限り `Edit(/**)`、`Task`、`WebSearch`。`AIDLC_` か `AWS_AIDLC_` で始まる `env` キーと、`aidlc config providers` で選んだプロバイダーのキー。 |
| `.claude/settings.local.json` | コマンドが `aidlc` を走らせる `statusLine`。AI-DLC のステータスラインはオンにするとここに着地します。ステップ1の `--statusline off` がそれを取り出します。 |
| `.mcp.json`（Claude Code）、`.kiro/settings/mcp.json`（Kiro CLI） | AI-DLC が出荷する MCP サーバー（`context7`、`aws-mcp`、`aws-pricing`、`aws-iac`、`aws-serverless`）、あなたが自分でセットアップしたのでない限り。Kiro CLI はそれらを既定でオフにして得ます。Claude Code は、`aidlc config` がターミナルで尋ねたとき yes と答える、または `config project --mcp defaults` でオンにしたとき得ます。 |
| `.codex/config.toml` | `developer_instructions`、`sandbox_mode`、`suppress_unstable_features_warning`、`tool_output_token_limit`。`[shell_environment_policy]`（`AIDLC_RULES_DIR` を保持する `set`）、`[sandbox_workspace_write]`（`network_access`）、`[agents]`（`max_depth`）、`[features]`（`default_mode_request_user_input`）、`[tools]`（`experimental_request_user_input`）、`[tui]`（`status_line`）の AI-DLC のキー。それらの直上の `#` コメント。空になったそれらのテーブル。あなた自身が設定したキーは、それらのテーブルの中も含め保ちます。 |
| `opencode.json`（または `opencode.jsonc`） | あなたのものでない限り `$schema`。`skills.paths` の `.aidlc/skills`。`.aidlc/` と `aidlc/` の下の `instructions` エントリ。そして AI-DLC の `permission` ルール。`.aidlc/` を名づけるもの、`bash` の下の `"aidlc engine *": "allow"`（ネイティブインストール）、`rm -r*` と `git push *` の前の asks、以前のリリースが `edit` と `bash` の下に加えた `"*"` ルール。あなたが同じルールを自分で書いたのでない限り。 |
| `.vscode/settings.json`（Copilot） | `chat.agent.maxRequests`（`200`）と `chat.useHooks`（`true`）、あなたが自分で設定したのでない限り。 |

あなたのものが何も残っていないとき、ファイルを削除します。AI-DLC がそれを作りました。Cursor のルートの `install.ts` と、AI-DLC がプロジェクトルートに書いた他の丸ごとのファイルは、ステップ2のスクリプトが削除します。Codex はプロジェクトのフックの信頼を、プロジェクトの外、`$CODEX_HOME/config.toml`（既定で `~/.codex/config.toml`）に保ちます。Codex に忘れさせたいなら、そこのプロジェクトのエントリを取り除きます。

### 4. 確認する

`git status` は、AI-DLC のファイルが削除され、あなたの共有ファイルがそれらが持っていた以前のものに戻っていることを示します。ステップ3の各共有ファイルで `AI-DLC` と `aidlc` を検索して、AI-DLC のものが何も残っていないことを見つけるはずです。

```bash
grep -n "AI-DLC\|aidlc" .gitignore AGENTS.md
```

```powershell
Select-String -Path .gitignore, AGENTS.md -Pattern 'AI-DLC|aidlc'
```

`aidlc-copy-runtime-X.Y.Z.tar.gz` からコピーされたプロジェクトは、そのセットアップコマンドが走るときマニフェストを得ます（[Copy Channel](#copy-channel) を参照）。そのコマンドが決して走らなかったなら、マニフェストはありません。コピーした `runtime/<harness>/` フォルダとバイト同一のファイルを削除し、次にステップ3と4に従います。コピーは、プロジェクトがすでに持っていた同名のファイル（あなた自身の `.claude/settings.json` など）も置き換えます。それらを git やバックアップから復元します。

## アンインストール

`aidlc uninstall` は、マシンのインストールを取り除きます。1つのプロジェクトから AI-DLC を取り除くには、[Remove AI-DLC from a Project](#remove-ai-dlc-from-a-project) を参照してください。

```bash
aidlc uninstall
aidlc uninstall --purge --yes
```

アンインストールは、インストーラー所有のファイルの明示的なリストを使い、削除する前にその内容を確認します。インストールやバージョンのディレクトリを再帰的には取り除きません。ディレクトリは空のときだけ取り除かれます。プロジェクトツリー、リストにないファイル、変わったファイル、リンクされたターゲットは保たれます。結果は、AI-DLC がインストールしなかった、またはインストール後に変わったので残した各パスを、一度リストします。

新しいインストールは、ハッシュが `version.json` に保存される、完全なバージョンごとの `installed-files.json` インベントリを記録します。古いインストールは、使えるところで検証されたランタイムのインベントリと、そのリリースがその隣に展開したプラグインのフォルダ（リリースのビルドが書いたマーカーを運ぶ）を使います。所有の証拠のない他のファイルは保たれます。プラグインカタログ自身の記録は、その最後のリフレッシュが書いたファイルをリストします。それらは消え、あなたがそのフォルダに入れた他の何もが保たれます。シェル補完は、ちょうど AI-DLC のリリースがレンダリングするものであるとき AI-DLC のものとしてカウントされるので、以前のリリースがこのリリースにアップデートする間に書いた補完は取り除かれ、編集されたものは保たれます。`--purge` なしでは、マシンの config、アップデートキャッシュ、ピンの登録、デフォルトのハーネスも保たれます。`--purge` は、それらの既知のマシンの記録を取り除くために選びます。無関係なファイルへ削除を広げません。

Windows では、どちらの形式も、インストールルートの `windows-path.json` に記録された User PATH エントリを取り除きます。インストール前に存在していたエントリと、その後に行われた無関係な変更は保たれます。所有記録のないインストールは User PATH をそのまま残します。後のインストーラーの実行での `-NoModifyPath` は、以前の記録を保つので、そのエントリはアンインストールでなお取り除かれます。

ターミナルでは、アンインストールは取り除くものと保つものを言い、次に進みます。ターミナルなしでは `--yes` を要します。ファイルシステム、ホーム、共有システム、プロジェクトのルート、そして root 所有、パッケージマネージャー所有、所有が混在したコマンドを拒否します。`--allow-root` で作られた root のインストールは、`aidlc uninstall --allow-root`（または `AIDLC_ALLOW_ROOT=1`）で取り除かれます。オプトインは `sudo` のもと、`$HOME` が root 所有でないとき拒否されます。Windows では、バインドされたファイルリストと期待されるチェックサムが、クリーンアップがスケジュールされる前に記録されます。ワーカーはパスとハッシュを再チェックし、reparse point を拒否し、走っているコマンドが終了した後にファイルを個別に削除します。アンインストールは、`aidlc` コマンドがもう見つからないときに完了です。中断された継続は、その検証されたファイルプランでのみ再開できます。そのようなプランのない古いジャーナルは拒否され、検査のために残されます。失敗したクリーンアップがどう報告されリトライされるかは [Transactions and Recovery](#transactions-and-recovery) を参照してください。

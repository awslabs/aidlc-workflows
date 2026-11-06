# トラブルシューティング

この章では、よくある問題とその解決策を、症状別にまとめます。

> **ハーネスに関する注記。** 以下の症状と対処は **Claude Code** 向けに書かれています（フックのファイル名、`settings.json` のブロック、コンパクションの挙動）。決定的なコア（状態、監査、エンジン）はどのハーネスでも同じように振る舞いますが、シェルレベルの画面は異なります。他のハーネスはフックと config を独自の方法で結線します（[Running on other harnesses](harnesses/README.md) を参照）。対処が `.claude/` のパスや Claude の仕組みを名づけている場合、同等のものはあなたのハーネスの config ディレクトリにあります。

---

## クイックフィックス表

| 症状 | クイックフィックス |
|---------|-----------|
| 監査エントリが現れない | `aidlc doctor` を実行。コピーインストールでは、フックの PATH に `bun` があることも確認します |
| Windows: 監査やその他の記録で `—` が `â€”`、`→` が `â†’` と表示される | ファイルは UTF-8 で、Windows PowerShell 5.1 がそれを ANSI として読みました。`Get-Content -Encoding UTF8` で読むか、PowerShell 7 を使います。その読み方から書き直したファイルは誤った文字を保つので、記録を `Copy-Item` か Explorer でコピーし、実行を `/aidlc --doctor --export` で共有します |
| ファイルを手で編集した。エージェントは受け入れるか | はい。編集して **done** と言う（または続ける）。完了したステージへの編集はそのまま使われますが再承認はされません。承認させるには `/aidlc --stage <name>` で戻ります。そのステージとそれ以降のすべてのステージが再度開きます。各ケースは [Editing Files Yourself](07-interaction-modes.md#editing-files-yourself) を参照 |
| Claude のフックがポリシーで制限されている | Claude Code の管理者に、管理された `allowManagedHooksOnly` を解除してもらいます。プロジェクト設定ではオーバーライドできません |
| Cursor: 承認が決して記録されない | プロジェクトが git リポジトリにない場合、`git init` を実行し、Cursor を完全に再起動してフォルダを信頼します（[Cursor project outside a git repository](#cursor-project-outside-a-git-repository) を参照） |
| Kiro IDE または Kiro CLI v3: `deny fs_read matching ".kiro/"` | `/aidlc --doctor` を実行し、それが示す ignore ファイルから `.kiro/` ルールを取り除きます（[Kiro Read Denials](#kiro-read-denials) を参照） |
| Kiro IDE: AI-DLC のレビューやヘルパーが走らない、チャットに **Approval needed in agent-aidlc-...** パネルが出る、または `/aidlc` が Kiro のワークフローに渡される | Kiro の Workflows 機能がオンです。エージェントにオフにするよう頼むか、`aidlc config trust --kiro-workflows off --yes` を実行し、**Developer: Reload Window** します（[Kiro's Workflows feature](harnesses/kiro-ide.md#kiros-workflows-feature-stops-ai-dlcs-reviews-and-helpers) を参照） |
| Kiro CLI: AI-DLC のレビューやヘルパーが走らず、作業を渡すツールがないとエージェントが言う | Kiro CLI の Workflows 機能がオンです。エージェントにオフにするよう頼むか、`aidlc config trust --kiro-cli-workflows off --yes` を実行し、Kiro CLI を終了してこのプロジェクトで `kiro-cli --v3` を再び開始します（[Kiro's Workflows feature](harnesses/kiro-ide.md#kiros-workflows-feature-stops-ai-dlcs-reviews-and-helpers) を参照） |
| Windows の Kiro IDE: コマンド結果が `AI-DLC reply:` 行で終わりステップが余計にターンを取る、またはすべてのコマンドが exit code -1 を示す | Kiro のターミナルが Command Prompt です。エージェントに PowerShell に設定するよう頼むか、`aidlc config trust --kiro-terminal powershell --yes` を実行し、Kiro を再起動します（[Command Prompt as Kiro's terminal](harnesses/kiro-ide.md#command-prompt-as-kiros-terminal-on-windows) を参照） |
| Kiro IDE: エージェントが「my memory」を引用し、チェックのバイパスやフックの手動実行を提案する | 無視し、その Kiro メモリを削除します（[Kiro memories carry old AI-DLC advice](harnesses/kiro-ide.md#kiro-memories-carry-old-ai-dlc-advice) を参照） |
| 状態ファイルが壊れた | `/aidlc --doctor` を実行し、状態テンプレートと比較します |
| 承認ゲートで止まった | 応答をタイプします。`/aidlc --stage <target>` でそれを飛ばして移動します |
| Kiro IDE: エージェントが実行したビルド、テスト、プローブのコマンドが `Exit Code: -1` を示し、AI-DLC 自身のコマンドは動く | Kiro がそれを実行していません。あなたの許可を待っているか、あなたが拒否しました。Kiro のプロンプトで **Allow**（または **Always allow**）を選ぶか、エージェントに進み方を伝えます |
| Kiro IDE: 承認の質問への返答が見られない、またはコマンドが exit code -1 で返る | Kiro がこのフォルダを信頼するか尋ねたら **Trust Folder & Continue** を選びます（または Restricted Mode バナーで **Manage**、次に **Trust**）。次にコマンドパレットから **Developer: Reload Window** を実行し、続けると言います。次のメッセージがなお記録されないなら、`/aidlc --doctor` が理由を示します。Kiro CLI では、終了してそのフォルダで `kiro-cli --v3` を再び開始します（フォルダを信頼するか尋ねられ中身が分かっているなら **Trust, continue** を選びます）（[Kiro IDE hooks not running](#kiro-ide-hooks-not-running) を参照） |
| Kiro IDE: 承認が、あなたの回答が記録されなかったと言い、Agent Hooks の下の `aidlc-record-human-turn` を名づける、または次の AI-DLC ステップが、AI-DLC のフックが Kiro の Agent Hooks でオフだと言う | あなたがそのフックを Agent Hooks パネルでオフにしました。AI-DLC があなたのために戻すことはありません。そこで戻します（[A Kiro hook switched off under Agent Hooks](#a-kiro-hook-switched-off-under-agent-hooks) を参照） |
| Kiro CLI（または Kiro ACP クライアント）: すべての承認が、人の返答が届いていないと言い、再起動しても解決しない | エンジンがディストリビューションと一致しません。`kiro` は Kiro CLI の v2 エンジン（`kiro-cli --v2`）、`kiro-ide` は v3（`kiro-cli --v3`）を必要とします（[Kiro CLI hooks not running](#kiro-cli-hooks-not-running) を参照） |
| セッション途中でコンテキストがコンパクトされた | `/aidlc` を実行してチェックポイントから再開します |
| 監査ログが大きすぎる | そのままにします。長いプロジェクトの監査ファイルは設計上大きく、エンジンはあなたが承認し完了したものを知るためにそれを読みます（[Audit Log Growing Too Large](#audit-log-growing-too-large) を参照） |
| フックがハングしているように見える | `/aidlc --doctor` でロックの所有者を診断します。[Lock Files Left Behind](#lock-files-left-behind) を参照 |
| ステータスラインが "ready" を示す | `aidlc-state.md` に `**Lifecycle Phase**` フィールドがあるか確認します |
| ステータスラインが現れない | オンにして初めて表示されます。`/aidlc --statusline on`（Claude Code と Codex）。次に `aidlc doctor` を実行。コピーインストールでは `bun` が PATH にあることを確認します |
| サブエージェントがタイムアウトした | `/aidlc` を実行してリトライするか、ステージをインラインで実行します |
| `A program is watching the project folder (most likely a dev server or a test watcher still running)`（Windows） | プロジェクトのすべてのフォルダを監視するプログラム（Vite のような dev サーバーや、実行したままのテストウォッチャーなど）が、AI-DLC がその作業記録のロックフォルダを移動するのを妨げるので、各ステップは約10秒待ちます。そのプログラムを止めます（`npm run dev` を止めても `npm` だけが止まりサーバーが残ることがあります。タスクマネージャーか `taskkill /T /PID <pid>` で閉じます）。次のステップは通常どおり進みます。アシスタント、またはそれが送ったエージェントが会話の中でそのプログラムを開始したとき（たとえばアプリを確認するため）、それを止めて作業は進みます。この行が見えるのは、どちらも開始していないとき、または停止がフォルダを解放しなかったときだけです。Guard Policy strict では、止まるまでビルドの書き込みが拒否されます。 |
| Windows: `aidlc/` の下のファイルについて git が `Filename too long` と言う、またはレビューや questions ファイルが書けない | プロジェクトフォルダが深すぎます。長いパスがオンでないと、Windows のツールと Git は260文字を超えるパスを拒否し、AI-DLC の記録はプロジェクトフォルダの奥深くにあります。`aidlc config` が1行でそう言い、`aidlc doctor` が、フォルダの深さと記録が加える分を示す `Project folder` 行を表示します。プロジェクトをより短いフォルダ（たとえば `C:\src\<name>`）に移すか、長いパスをオンにします。管理者として PowerShell で `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force` を実行し、次に `git config --global core.longpaths true` を実行します。AI-DLC はこの2つの設定を読み、両方オンなら何も言いません。それらや、あなたのフォルダや git 設定を変えることはありません。Copilot CLI は、この2つの設定が何であれ、260文字を超えるパスを読むたびに尋ねます（`copilot -p` はそれを拒否します）。したがって Copilot CLI では、より短いフォルダだけがその質問をなくし、行はどちらにせよ言われます。 |
| ワークフローが詰まる、または誤動作し、助けが要る | `/aidlc --doctor --export` を実行し、生成された `.tar.gz`（編集済み、成果物なし）を共有します |
| Bolt の試行が脇に置かれた | 保存された中断結果の `restore_operation` を、その正確な argv とともに呼び出すようアシスタントに頼みます。ヒントは表示専用です。証拠のみの試行には復元する保存ファイルがありません。[getting the files back](#a-bolt-attempt-was-set-aside-getting-the-files-back) を参照 |

---

## ネイティブインストールのチャンネル

| 症状またはエラー | 解決策 |
|------------------|------------|
| `Checksum mismatch for <asset>.` または `<asset>: checksum mismatch` | 止めます。ダウンロードしたディレクトリを再利用しないでください。同じリリースから、完全なリリースアセットのセットと `checksums.txt` を再度ダウンロードします。 |
| `install.sh` の後に `command not found: aidlc` | インストーラーが報告した bin ディレクトリを `PATH` に加え（通常 `export PATH="$HOME/.local/bin:$PATH"`）、新しいシェルを開いて `aidlc doctor` を実行します。 |
| `install.ps1` の後に `aidlc` が認識されない | 既定のインストールは、PowerShell を実行したアカウントの User PATH を登録します。インストール中にすでに開いていたターミナルアプリや IDE（Kiro、VS Code、Cursor）は、開始時の PATH を保ちます。完全に終了して開き直します。その中の新しいタブや Reload Window では足りません。[`-NoModifyPath`](18-install-and-lifecycle.md#windows-powershell) の場合、表示された直接のコマンド（通常 `& "$env:LOCALAPPDATA\aidlc\bin\aidlc.exe" config`）を使うか、そのスイッチなしでインストーラーを再実行して PATH を登録します。 |
| PowerShell や CMD では `aidlc` が動くが Git Bash（または別の MSYS シェル）では動かない | それらのシェルは Unix の `execvp` ルールでコマンドを解決し `PATHEXT` を無視するので、素の `aidlc` は bin ディレクトリ（通常 `%LOCALAPPDATA%\aidlc\bin`）の `aidlc.exe` を見つけますが `aidlc.cmd` は決して見つけません。`aidlc.exe` 以前のインストールには、代わりに `aidlc.cmd` の隣に拡張子なしの `aidlc` ランチャーがあるので、素の名前がこれらのシェルで解決します。どちらもない場合、インストーラーを再実行するか、`aidlc use <version>`（`aidlc` がすでに解決する PowerShell か CMD から）を実行して `aidlc.exe` を書きます。`/hooks` が登録済みとリストするのに Windows で決して発火しないフックの既知の一因がこれです。フックのシェルが `aidlc` を解決できません。`aidlc doctor` はそれを、取るべきステップを名づける失敗した `Windows launcher (Git Bash)` 行として示します。**AI-DLC が書いていない `aidlc` という名前のファイル（たとえば以前手作りした転送役）がすでにその bin ディレクトリにある場合、インストーラー、`aidlc update`、`aidlc use` はターミナルで、置き換えるか一度尋ね、あなたのファイルをその隣に `aidlc.bak-<time>` として保ちます。`--yes`（インストーラーでは `-Yes`）が yes と答えます。ターミナルも `--yes` もないと、ファイルをそのままにし、脇に移すよう言います。そこにある `aidlc` という名前のディレクトリは決して置き換えられません。取り除くか改名し、インストーラーか `aidlc use <version>` を再実行します。** |
| `This PowerShell window is running as administrator` | もっとも安全なインストールのため、N と答え、PowerShell を通常どおり（「管理者として実行」ではなく）開き、インストーラーを再実行します。それでも管理者として続けるには、y と答えるか、インストーラーに `-Yes` を渡します。`aidlc uninstall` は何も尋ねません。同じ警告を表示して進むので、もっとも安全なアンインストールのため、通常の PowerShell ウィンドウから実行します。AI-DLC はユーザーごとで、管理者権限を必要としません。Windows Server の組み込み Administrator や、UAC の昇格のない他のセッションには、警告は出ません。 |
| Windows のインストールが PATH の競合を報告する | ファイルはインストールされていますが、永続的な PATH が別のコマンドを選びます。表示された `config` のフルコマンドパスを使うか、報告された競合を解消します。JSON は、exit code が 0 でも `status: "warning"` と `data.ready: false` を報告します。 |
| Windows のインストールが PATH を構成できなかったと報告する | ファイルはインストールされ、PATH のステップが exit code 1 で失敗しました。表示された回復手順に従うか、`-NoModifyPath` で再実行して直接のコマンドを使います。JSON は `data.installed: true` と `data.ready: false` を報告します。 |
| Windows のアンインストール後に User PATH エントリが残る | アンインストールは、`windows-path.json` を通じて所有するエントリだけを取り除きます。既存のエントリや、その所有記録のないインストールは、User PATH を変えずに残します。[Uninstall](18-install-and-lifecycle.md#uninstall) を参照。 |
| アンインストール後にファイルが残る | アンインストールは個別に検証したファイルを削除し、空のときだけディレクトリを取り除きます。リストにない、または変わったファイルは保持され報告されます。古いインストールで所有インベントリのないファイルを含みます。報告されたパスを確認します。`--purge` は無関係な内容を削除しません。 |
| `--offline requires --from <release-directory>` | オフラインモードはネットワークのリリースに決してフォールバックしません。完全なリリースアセットのセットを転送し、そのディレクトリを `--from` / `-From` で渡します。インストーラーがそれを検証します。 |
| `aidlc` が exit 4 する、または Windows のアクティブポインタが無効 | ランチャー（bin の `aidlc.exe` か `aidlc.cmd`）が、使えなかったファイル（アクティブなバージョンマーカー、アクティブなコマンドのターゲット、アクティブな実行ファイル）を名づける `aidlc:` 行を1つ表示し、続けて `Rerun the AI-DLC installer (install.ps1) to repair the aidlc command.` を表示します。以前のリリースからの `aidlc update` の後、何も表示せず exit 4 するそのリリースのランチャーは、`aidlc doctor` や `aidlc uninstall` 以外の次の `aidlc` コマンドがそれを置き換えるまで残ります。その1つのコマンドはなお古いランチャーを通って走り、スペースを含む値を別々の語に分けます。それがある間、`aidlc doctor` は `Windows launcher` 行を示します。AI-DLC がそれを置き換えられないとき（たとえば `aidlc.cmd` か `aidlc-shim.ps1` がインストール後に変わったため）、行は理由とそれを直すステップを名づけます。どのコマンドも始まる前に古いランチャーが exit 4 するなら、インストーラーを再実行します。`%LOCALAPPDATA%\aidlc\active-executable` を編集しないでください。同じ検証済みのインストーラーを再実行するか、動作する保持された実行ファイルから `aidlc use <version>` を使います。PowerShell がランチャーを `ConstrainedLanguage` モードで実行すると言う行は、アプリケーション制御ポリシー（AppLocker か WDAC）がそれをブロックしていることを意味します。管理者に `aidlc-shim.ps1` を許可してもらうか、`%LOCALAPPDATA%\aidlc\versions\<version>\aidlc.exe` を直接実行します。 |
| `aidlc-shim.ps1 cannot be loaded` または `is not digitally signed` | グループポリシーの実行ポリシーが、`aidlc.cmd` が渡す `-ExecutionPolicy Bypass` をオーバーライドするので、PowerShell はランチャーが走る前に拒否します。`Get-ExecutionPolicy -List` を実行します。`Undefined` 以外の `MachinePolicy` か `UserPolicy` の行が原因です。管理者にスクリプトを許可してもらうか、`%LOCALAPPDATA%\aidlc\versions\<version>\aidlc.exe` を直接実行します。 |
| `pending Windows uninstall` または Windows のアンインストール回復の失敗 | アクティブな AI-DLC コマンドを閉じ、`aidlc doctor` を実行します。保留中のクリーンアップは次のコマンドで再開します。doctor が失敗したクリーンアップを報告したら、示された理由を解消し、doctor が表示するフルパスで `aidlc uninstall` を再び実行します（PATH エントリがすでに消えているかもしれないので、通常 `& "$env:LOCALAPPDATA\aidlc\bin\aidlc.cmd" uninstall`。元が使っていたなら `--purge` を加えます）。ファイル削除前に失敗したクリーンアップはディスクから再計画され、始まっていたものは再開します。そのコマンドがもう走らないなら、インストーラーを再び実行します。保留中のクリーンアップを先にリトライするので、2回走らせる必要があるかもしれません。バインドされたファイル計画のない古い、または変えられたジャーナルは拒否されます。一時ジャーナル、クリーンアップスクリプト、マシンフェンス、残りのファイルを検査用に保っておきます。 |
| `the last AI-DLC uninstall is still finishing` | Windows は `aidlc uninstall` の終了後に AI-DLC のファイルを取り除きます。インストール済みバージョンが1つか2つなら1分足らず、それ以上や遅いマシンではもっとかかります。何も変わっていません。行が言うときにインストーラーを再び実行します。終わらずに止まったクリーンアップは、始まって10分後に、doctor 以外の最初の AI-DLC コマンドによって再び始められます。 |
| Alpine が `libstdc++.so.6` または `libgcc_s.so.1` の不足を報告する | Bun と Node.js の musl ビルドが必要とするのと同じランタイム依存を `apk add libgcc libstdc++` でインストールし、インストーラーかコマンドを再実行します。完全に静的な Bun musl のコンパイルターゲットは現在ありません。インストーラーはこの対処を報告しますが、パッケージはインストールしません。 |
| ハーネスがすでに独自のモデルアクセスを持つのに `Providers` が `no recorded answers` で `[needs]` を示す | Kiro CLI と Kiro IDE では行は `[ok]` で `aidlc config providers` は何も尋ねません。モデルアクセスが Kiro に付いてくるためです。GitHub Copilot と Cursor では行は回答なしで `[ok]` です。セッションがモデルアクセスを持ってくるためです。自分の Amazon Bedrock アクセスを使うときだけ `aidlc config providers` を実行します（Cursor では IDE だけが Bedrock キーを受け取り、その CLI は常に Cursor のバックエンドを使います）。他のすべてのハーネスでは行は本物です。`amazon-bedrock` と答えるか、`keep current`（`--provider current`）を選んで、ハーネスにすでに構成されたプロバイダーを保ち記録します。`--provider other --acknowledge` は、自分で構成した別のプロバイダーを記録します。 |
| `Models` が `no recorded policy` で `[needs]` を示す | ポリシーがないと、ほとんどのエージェントはセッションのモデルとエフォートを継承するので、high エフォートのセッションはそれらを high エフォートで走らせます。プリセットを記録してエージェントのエフォートを設定するか（`aidlc config models --preset balanced --project --yes`）、継承し続けるよう残します。Kiro CLI ではプリセットが対話セッション全体に1つのエフォートを設定します。`aidlc config models` がセッションのモデルを選び、そのエフォートとともにあなたの個人用 Kiro 設定に保存し、`/model` と `/effort` が Kiro の中でそれらを変えます（[Session model and effort](harnesses/kiro-cli.md#session-model-and-effort) を参照）。GitHub Copilot、Cursor、Kiro IDE では行は `[ok]` で、代わりにホストを名づけます。そこではプリセットが何も変えないためです。モデルとエフォートはホストで選びます（Kiro では `aidlc config models --agent` が1つのエージェント自身のモデルとエフォートを設定します）。[Choosing a Model and Effort](18-install-and-lifecycle.md#choosing-a-model-and-effort) を参照。 |
| `aidlc doctor` で `workspace shell ready` が失敗し、`aidlc config` の再実行でも直らない | 対話的な再実行は既存の射影を使い、欠けている `aidlc/spaces/default/memory/` を決して作り直しません。シェルが不完全な間は `Workspace` 行を報告し、直すセクションを提示しません。その行が名づけるコマンドを実行します。ネイティブインストールではそれは `aidlc config --harness <name>` で、インストール済みランタイムからリフレッシュしワークスペースのシェルを作り直します。Bun を呼ぶ射影（`aidlc-copy-runtime-X.Y.Z.tar.gz` の `runtime/<name>/` ルート、またはチェックアウトの `dist/<name>/` ツリーからコピーしたもの）には、リフレッシュ元のインストール済みランタイムがないので、そのコマンドは `--download` も運び、プロジェクトのリリース向けの `aidlc-copy-runtime-<version>.tar.gz` を取得し検証します。ネイティブの `aidlc-runtime-X.Y.Z.tar.gz` や `dist-release/` のバイトは決して使いません。それはプロジェクトのフックをネイティブのコマンドに置き換えてしまいます。 |
| `aidlc config` がリリースを必要とすると言う: `this project is pinned to <version>`、`needs the <version> release files`、`is missing aidlc/spaces/default/memory/`、または `no longer has the MCP server list` | プロジェクトは、このマシンにないリリースのファイルを必要とします。チームメイトの新しいピン、あなたが追加するハーネス、または失ったファイルです。`fix:` 行を実行します。それは `--download` 付きのあなたのコマンドで、ちょうどそのリリースを取得し、チェックサムと（`gh` がインストールされていれば）リリースの証明を検証し、コマンドを完了します。ネイティブではそれが `aidlc config --pin` のようにピン留めされたリリースをインストールし登録します。コピーされたプロジェクトでは `aidlc-copy-runtime-<version>.tar.gz` をダウンロードします。ターミナルでは代わりに config が尋ねます。すでにインストール済みのピン留めされたリリースは、尋ねずに使われます。ネットワークアクセスがない場合、`offline:` 行に従います。名づけられたファイルを別の場所で取得し `--from` で渡すか、ネイティブで `aidlc config --pin <version> --offline --from <release directory>` です。`--release-base-url` と `--ca-bundle` がミラーを選びます。チェックサムや証明の失敗は、何も変えずに止まります。 |
| コピーチャンネル経由でインストールしていないプロジェクトで `aidlc doctor` が Bun を求める | コピーチャンネルの射影はフックを Bun 経由で走らせ、ネイティブインストールは `aidlc` コマンド経由で走らせます。対処が、プロジェクトがどのチャンネルにあるかを名づけます。Bun を必要としなくするには、ネイティブのリリースインストーラーで再インストールし、`aidlc config --harness <name>` を再実行します。 |
| `aidlc doctor` の `Harness trees on different releases` | プロジェクトのハーネスツリーが異なるリリースからインストールされたので、ワークフローが各ツールで異なる振る舞いをすることがあります。行が名づけるコマンドを実行します。ピン留めされたプロジェクトのツリーはピンに合わせられます。ネイティブではそれは、エンジンのリリース（またはピン）にない各ツリーについて `aidlc config --harness <name>` です。ピン留めされたコピーのプロジェクトでは `bun <harness-dir>/tools/aidlc.ts config --harness <name> --download`、ピンがなければ、どの config 実行も記録していないツリーについて1回の `--download` リフレッシュの後、もっとも新しいツリーの `aidlc-copy-runtime-<version>.tar.gz` を使った `bun <harness-dir>/tools/aidlc.ts config --harness <name> --from <file>` です。進行中の作業はリフレッシュを通じて続くので、終わるのを待つ必要はありません。 |
| `config plan changed after approval` | `aidlc config --dry-run --json` を再実行し、`data.actions` を確認し、まったく同じソースと挙動のオプションで新しい `data.planToken` を適用します。 |
| `aidlc config` からの `locally modified` または `managed block was locally modified` | `aidlc config --dry-run --json` を実行し `data.actions` を確認します。ベースライン所有のフレームワークのバイトや管理ブロックを置き換えるときだけ `--force` を使います。それは無関係なルートの内容を決して認可しません。`.claude/settings.json` はエントリ単位でマージされるので `--force` は不要です。リフレッシュは AI-DLC のフックとコマンドの allow エントリを戻し、あなたのフック、deny ルール、カスタム statusline、環境、その他の設定を保ち、戻したものを示す注記を付けます。退役した出荷時 allow エントリは自動では取り除かれません。`.codex/config.toml` も同じようにエントリ単位でマージされます。リフレッシュは AI-DLC 自身のキーだけを変え、あなたのキー、テーブル、コメントをそのまま保ち、AI-DLC のキーの1つであなたが変えた値を保ち、リリースが別のものを出荷するときは注記を付けます。 |
| `aidlc doctor` の `AI-DLC files: N changed in this project` | それらの AI-DLC ファイルがこのプロジェクトで編集されたので、`aidlc config` はそれらを保ち、何かをリフレッシュする前に止まります。あなたのバージョンを保つには、名づけられたファイルを別の場所に移し、`aidlc config` を実行します。出荷版をそれらの上に取るには、`aidlc config --force` を実行します。違いが行末だけ（Windows のチェックアウトが LF を CRLF にする）のファイルは、決してカウントされません。 |
| `cannot coexist in one project` | 2つめのハーネスがエンジンディレクトリ（`opencode` / `copilot` は `.aidlc` を使う）または排他的な管理ブロック（Copilot の `AGENTS.md`）を共有します。別々のエンジンディレクトリを選び、排他的なブロックを避けます。`kiro` と `kiro-ide` も `.kiro` を共有しますが、`aidlc config --harness kiro-ide`（または `--harness kiro`）はインストール済みの一方をその場でもう一方に切り替えます。[More than one harness in a project](18-install-and-lifecycle.md) を参照。中立の `AGENTS.md` ブロックは Kiro CLI、Kiro IDE、Codex、Cursor、OpenCode にまたがって共有されます。`.gitignore` は出荷エントリを結合します。 |
| `cannot switch .kiro from <row> to <row>: installed <row> has no ownership baseline`、`has an ownership baseline recorded before it listed only shipped files`、または `has an unusable ownership baseline` | インストール済みの行がどの `.kiro/` ファイルを所有するかを記録する使えるものがないので、切り替えはそのファイルを置き去りにします。何も変えません。表示されたステップに従います。壊れた `.kiro/tools/data/aidlc-manifest.json` を脇に移し（ステップがそのフルパスを名づけます）、表示された `config --harness <installed row>` を実行し、切り替えを再び実行します。 |
| `switching .kiro to kiro-ide lets Kiro run hook files AI-DLC does not own` | Kiro は、その v3 エンジンと Kiro IDE で、すべての `.kiro/hooks/*.json` ファイルを実行します。名づけられたファイルを確認し、ターミナルでプロンプトに答えるか、表示された `--dry-run` を実行し、それが表示する `--plan-token` で切り替えを適用します。`config plan changed after approval` または `hook files AI-DLC does not own changed after this switch was planned` は、確認後にセットが変わったことを意味します。もう一度確認します。 |
| `cannot switch .kiro to kiro-ide: .kiro/hooks is a link or a file, not a directory`、または `Kiro would run hooks through entries that are not regular files in .kiro/hooks` | `.kiro/hooks` を、そのファイルを収める実在のディレクトリにします。または、リストされた各フックエントリ（リンク、ディレクトリ、その他の非ファイル）を通常のファイルに置き換えるか `.kiro/hooks` の外へ移します。次に切り替えを再び実行します。 |
| `predates shared onboarding` | 名づけられたインストール済みハーネスが、選択されたリリースより古い（または有効な記録済みバージョンがない）ので、そのブロックは共有されません。プレビューは、同じベースバージョンの安定版リリースより前にソートされます。中立の `AGENTS.md` ブロックを共有する別のハーネスを追加する前に、`aidlc config --harness <name>` でそれをリフレッシュしてみます。これは古い兄弟へのヒントです。その後もなお拒否するなら、そのブロックは排他的で、1つのプロジェクトで共存できません。Copilot のブロックはリフレッシュ後も排他的のままです。現在の排他的ブロックは代わりに `cannot coexist in one project` を報告します。`--force` はこの互換性チェックをバイパスしません。 |
| `refusing to refresh <harness> from a release whose AGENTS.md is not shared` | 別のインストール済みハーネスが中立のルートブロックを共有しますが、選択されたリフレッシュ元はそれを共有と宣言しません。`AGENTS.md` を共有と宣言するリリースを使います。`--force` はこのガードをバイパスせず、どのプロジェクトファイルも変わりません。 |
| `shared block is owned by <harness> from a different release` | 共有の `AGENTS.md` ブロックが、選択されたリリースではなく、名づけられた兄弟のベースラインと一致します。エラーのリフレッシュ順序に従います。選択されたハーネスをその兄弟と同じリリースからリフレッシュするか、兄弟を先に選択されたリリースからリフレッシュします。拒否されたリフレッシュでどのプロジェクトファイルも変わりません。 |
| `multiple project harnesses are present; pass one --harness <name>` | マルチハーネスのプロジェクトでの `aidlc config` はすべて、`--harness <name>` でターゲットを名づけなければなりません。例外はバイパスの記録またはクリア（`aidlc config flags --bypass <NAME>` または他に変えるものがない `--clear-bypass <NAME>`）で、これはプロジェクトに属しハーネスを必要としません。 |
| `.gitignore` が `preserve (owned by <harness>)` を示す（`aidlc config --dry-run --json` で `action: "preserve"`、`detail: "owned by <harness>"`） | このフォールバックは、所有するハーネスが `tools/data/root-blocks/` のないリリースでインストールされたときに現れます。`aidlc config --harness <owner>` を実行してリフレッシュすると、両方のハーネスが1つの結合ブロックに収束します。 |
| `managed block has no ownership baseline` | ブロックが、もう存在しないかベースラインのないインストール（たとえば取り除かれたハーネスツリー）によって書かれました。`aidlc config --dry-run --json` を確認し、`--force` で現在の出荷ブロック（共有の `.gitignore` の結合エントリ）に置き換えます。 |
| `has no readable projection descriptor` または `has lost its projection descriptor and ownership baseline` | 別のハーネスを追加する前に、名づけられたインストール済みハーネスを `aidlc config --harness <name>` で修復します。共同所有のブロックでは、ソースがブロックを共有と宣言し現在のブロックを変えずに残し兄弟のベースラインと一致するとき、その兄弟のデスクリプタが欠けていても、同一リリースのリフレッシュが許可されます。これにより、欠けたデスクリプタの両方を1ハーネスずつ修復できます。そうでなければ、`co-owns AGENTS.md` の拒否は、名づけられた兄弟のデスクリプタを先に復元することを要します。`--force` はこのガードをバイパスできません。デスクリプタとベースラインの両方を失ったスタンプ済みの兄弟（`aidlc-stamp.json` がある）は、非 union の管理ブロックを変えるリフレッシュを `has lost its projection descriptor and ownership baseline` でブロックします。その兄弟を先に復元します。現在のブロックを変えない同一リリースのリフレッシュはなお許可されますが、`--force` はブロックを変えるリフレッシュを許せません。スタンプなしで共同所有のベースライン証拠のないレガシーツリーは、なお1ハーネスずつ採用できます。 |
| `is missing its shipped block copy` | 名づけられたハーネスのインストールが `tools/data/root-blocks/<marker>` を失いました。`aidlc config --harness <name>` を実行して復元し、リフレッシュを再実行します。`--force` は、そのハーネスのエントリなしでブロックを書きます。 |
| 通常の `aidlc config` リリースリフレッシュからの `unowned whole file` | リフレッシュの前に、既存のファイルを手動で移すかマージします。OpenCode の `opencode.json` はもうここで止まりません。config は AI-DLC のエントリをあなたのファイルに加え、その中の他のすべてを保ちます。 |
| `opencode.json` が `<key> must be a JSON object` または `must be a JSON array` で config を止める | AI-DLC は `skills.paths`、`instructions`、`permission` にそのエントリを加えます。それらの1つが別の形（たとえば `"permission": "ask"`）のとき、config は何も変えません。マップかリストとして書き（`"permission": { "bash": "ask" }`）、config を再実行します。 |
| `<file> is not valid UTF-8; convert its encoding before config` | 名づけられたルートファイル（`.gitignore` や `AGENTS.md` など）をバックアップし、内容を保ったまま現在のエンコーディングから UTF-8 に変換し、config を再実行します。デコードで情報が失われるとき、AI-DLC は元のバイトをそのままにします。 |
| `managed markers are missing, duplicated, or malformed` | 名づけられたルートファイルを、ちょうど1組の `BEGIN AI-DLC` / `END AI-DLC` のペアを持つように修復するか、壊れた AI-DLC ブロックを取り除いて `aidlc config` を再実行します。 |
| `project runtime <version> is incompatible with selected engine <version>` | `aidlc use <version>` を実行して互換のバージョンをインストールし選ぶか、`aidlc config` で意図的にプロジェクトをリフレッシュします。 |
| `this project requires <version>, which is not installed completely` | 正確な strict-semver のピンを `aidlc config --pin <version>` でインストールまたは再インストールします。ディスパッチャーは、アクティブなマシンのバージョンにフォールバックせず、閉じて失敗します。チームがプロジェクトのピン留めをやめるつもりのときだけ `aidlc config --unpin` を使います。 |
| `.aidlc-version must contain one release version id` | コミットされたピンファイルが、1つのリリース id 以外のもの（余計なテキストや紛れ込んだコマンドなど）を保持しています。`aidlc config` とディスパッチャーは、その内容を表示せずに拒否します。ファイルを意図したリリース id（たとえば `2.10.0`）に直すか、`aidlc config --unpin` を実行してプロジェクトのピン留めをやめます。 |
| AI-DLC を求めたときの `AI-DLC can't run in <folder>. Start the session from your project's folder.` | セッションが、ホームフォルダのような AI-DLC のマシンインストールやコマンドディレクトリを保つフォルダ、またはその中のフォルダで始まりました。AI-DLC はそこで走らないので、そのフックは身を引き、そのフォルダでのあなたの他の作業は通常どおり進みます。AI-DLC を使うには、プロジェクトのフォルダからセッションを始めます。 |
| 更新が中断され `aidlc version` がなお以前のリリースを示す | これは安全な復元状態です。古いコマンドがアクティブなままです。`aidlc doctor` を実行し、同じ `aidlc update --version <version>` コマンドを再実行します。 |
| `another AI-DLC command is still working in <project>.` | 別の AI-DLC コマンド（このプロジェクトの別のチャット、ツール、ターミナル）がそれを保持しています。終わるのを待ち、あなたのコマンドを再び実行します。他に何も走っていないのに繰り返すなら、[Transaction lock ownership](#transaction-lock-ownership) に従います。 |
| `an AI-DLC command on another computer ... is working in <project> ... or left its lock there.`、または `.../.aidlc-transaction.lock cannot be read.` | ロックは、フォルダを共有する別のコンピュータ（またはこのコンピュータが再起動前に）残したか、読めません。そこで AI-DLC コマンドが走っていないなら、行が名づけるフォルダを削除し、あなたのコマンドを再び実行します。[Transaction lock ownership](#transaction-lock-ownership) を参照。 |
| `an earlier AI-DLC command stopped before it finished, so its lock was cleared` | あなたが実行したコマンドについては何もすることはありません。先のコマンドは完了しませんでした。まだ必要なら再実行します。 |
| `another AI-DLC command is still changing this machine's install, so this ran on aidlc <version> without waiting for it to finish` | 何もすることはありません。ピン留めされたプロジェクトのコマンドかフックが、更新、アンインストール、その他のマシンの変更を最大30秒待ち、それからとにかくピン留めされたリリースで走りました。他の `aidlc` コマンドが走っていないのに繰り返すなら、[Transaction lock ownership](#transaction-lock-ownership) に従います。 |
| config 中の `Cannot create an AI-DLC transaction lock` または `Cannot use the filesystem at ...` | プロジェクトのストレージが、AI-DLC が必要とする操作を欠いています。[Config fails with a storage error](#config-fails-with-a-storage-error) を参照。 |
| `existing aidlc is managed by Homebrew` / `Nix`、または宛先のコマンドが `not owned by the AI-DLC installer` | 報告された所有者を通じてアップグレードします。別のネイティブインストールを保つには、`AIDLC_BIN_DIR` を、空のユーザー所有のディレクトリに明示的に設定します。このリリース自体は Homebrew や Nix のパッケージングを出荷せず、所有が混在したコマンドを決して置き換えません。 |
| `update cache is invalid`、またはマシン設定が拒否される | `aidlc system config global list` を実行します。名づけられた `%LOCALAPPDATA%\aidlc\aidlc.settings.json`（Windows）または `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/aidlc.settings.json`（macOS/Linux）だけを修復または取り除きます。未知のキーと保存された資格情報は拒否されます。 |
| `HTTPS_PROXY must use HTTP or HTTPS`、またはリリース URL が拒否される | HTTP(S) のプロキシ URL と、資格情報・クエリ・フラグメントのない HTTPS のリリースミラーを使います。ネイティブクライアントは `HTTP_PROXY` ではなく `HTTPS_PROXY` と `NO_PROXY` を読み、エラーで秘密らしい URL の部分を伏せます。 |
| 企業の CA の背後でダウンロードが失敗する | `--ca-bundle <absolute-path>` を渡すか `AIDLC_CA_BUNDLE` を設定します。Windows のブートストラップは、カスタム CA が供給されると `curl.exe` を必要とします。 |
| プラグインコマンドからの `host inventory unavailable` | 現在のプラグインルートを注入するホストセッションから sync を実行するか、Claude/Codex のホストレジストリを復元します。欠けている、または不正なインベントリが、内容を刈り取っても安全な証拠として扱われることは決してありません。 |
| `Nothing synced: this tool keeps no list of your plugins` | Kiro CLI、Kiro IDE、Cursor、Copilot、opencode にはプラグインリストがありません。`--plugin-root` の後に各プラグインのフォルダを付けて、行が名づけるコマンドを実行します。 |
| `cannot sync <plugin>` または `cannot prune <plugin>: owned path changed since composition` | プラグインが追加したファイルを編集しました。編集を保つには、そのファイルを別の場所に移し、行が名づけるコマンド（同じ `aidlc engine plugin sync`、プラグインリストのないホストではプラグインのフォルダ付き、または `sync --prune-missing`）を再び実行します。sync はプラグイン自身のバージョンを戻します。`--yes` は所有ハッシュをオーバーライドしません。 |
| `aidlc system versions prune`、`uninstall`、またはプラグインの prune が `--yes` を要求する | コマンドが対話的な stdin なしに走っています。リストされた削除を確認し、`--yes` で再実行します。整合性の拒否はバイパスできません。ターミナルではこれらのコマンドは何も尋ねません。取り除くものを表示し、それから実行します。 |
| `aidlc setup` が不明、または npm インストールが使えない | それらのチャンネルは計画されていますが出荷されていません。リリースインストーラーと `aidlc config` を使います。提案のトランスクリプトを使えるコマンドとして扱わないでください。 |

ネイティブの `aidlc doctor` は、アクティブなコマンドポインタ、ロールバックの適格性、保持されたピンの完全性、古いピン登録、放棄されたトランザクションのステージング、プロジェクトのバージョンのずれ、そしてバイナリチャンネルのホストフックと権限/信頼のエントリがネイティブのコマンドを一貫して選ぶかも確認します。

### 設定が、コミット対象の記録を隠す ignore ルールを警告する

Git リポジトリでは、config は、あなた自身の ignore ルールの1つが、コミットして共有するはずの記録を隠していないかを確認します。`aidlc/` のようなルールは隠すので、config はなお完了しますが、`<file>:<line>` と隠された記録のパス（`memory/**`、`codekb/**`、`intents.json`、`aidlc-state.md`、`audit/*.md`）を名づける注記で終わります。新しいものはチームメイトに届きませんが、git がすでに追跡するファイルはコミットされ続けます。初回実行のセットアップと `--quiet` もそれを示します。意図したものでないなら、名づけられたルールを、無関係な ignore を保ちつつ狭めます。個人のスクラッチ領域を Git から外すような意図的なルールは残せます。Git の外、または Git 実行ファイルがない場合、チェックはありません。

### 設定がストレージエラーで失敗する

AI-DLC はハードリンクを作りません。そのプロジェクトロックは所有者スタンプ付きの `.aidlc-transaction.lock` フォルダで、排他的な作成とリネームにより、そこに何もないときだけファイルをある名前に置くので、exFAT ドライブ、ネットワーク共有、WSL の `/mnt/c` には追加で何も要りません。config はロックなしの書き込みで決して進みません。

初回実行のウィザードは、セットアップの選択肢を提示する前に、必要なファイルシステム操作をプローブし、その一時的なプローブファイルを取り除きます。失敗したプローブは、何も書かずにセットアップを止めます。プローブ自体が取り除けないとき、セットアップはそれを名づけ、他には何も書いていないと言います。人向けの出力は失敗と対処を名づけ、`--quiet` は対処を表示し、`--json` は構造化された失敗を返します。スクリプトの `aidlc config --harness <name>` は自身のプローブを走らせません。ファイルをリネームできないストレージでは、同じ `Cannot use the filesystem at ...` の行と対処で最初のリネームで止まり、ロールバックし、作った空のフォルダだけを残します。通ったプローブが、アトミック性やクラッシュ耐久性を保証することはできません。[Transactions and Recovery](18-install-and-lifecycle.md#transactions-and-recovery) の機能とサポートのマトリックスを参照してください。S3 のマウント名やストレージエラーだけでは、そのドライバー、バージョン、オプションは特定できません。

非互換のマウントでは、プロジェクトを、EC2 EBS ボリューム上の ext4 や XFS のような互換のローカルストレージに移すかクローンし、そこで `aidlc config` を再実行します。作業中のプロジェクトは S3 マウントの外に保ちます。後のアップロードはすべて別の公開で、アトミックなマルチファイルの保証はありません。同じマウントへのエイリアスやシンボリックリンクは、その機能を変えません。`--force`、`--from`、ロックの削除のいずれも、欠けているファイルシステムのセマンティクスを修復しません。

### トランザクションロックの所有権

再試行の前に、ライブの init/ライフサイクルの所有者が終わるのを待ちます。次の AI-DLC コマンドは、所有者が止まったロックをクリアし、1行でそう言います。所有者が止まっているのは、その PID が死んでいるとき、またはシステムがそれ以降その PID を後のプロセスに与えたとき（Windows は PID をすぐ再利用します）です。開始記録がロックが記録したものと異なるもの、または、記録しなかったリリースからのロックについては、ロックが書かれた後に開始したものです。このコンピュータが再起動前にスタンプしたロックも同じようにクリアされます。その所有者はその起動とともに止まったからです。所有者スタンプが決して完了しなかったロック（`owner.json` がない、空、または JSON として読める前に切れている）は、ロックを取る途中で止まったコマンドが残すものです。最初の数秒間は別のコマンドがまだ働いていると読まれ、その後は次のコマンドがそれをクリアします。ライブの所有者は保持されます。フォルダを共有する別のコンピュータがスタンプしたロック、またはコンピュータと起動を記録しなかったリリースからのものも同様です。ここにない PID は、その所有者が止まった証拠ではないからです。読めるが有効な所有者を名づけないスタンプも同様です。その2つは、そこで何も走っていないときに削除すべきフォルダを言います。

手動の診断では、エラー、ロック、名づけられたステージング/回復のパスを保っておきます。`.aidlc-transaction.lock/owner.json`（古いリリースが残したファイルロックについてはロックファイル自体）を検査し、所有者のプロセス、コンピュータ、マウント履歴をオペレーターとともに確立します。1つのコンピュータ上のコマンドはその PID 名前空間を共有しなければなりません（ホスト名が1つの2つのコンテナは共有しません）。是正作業の前に書き込み側を止め、所有権が不確かな間は証拠を保ちます。AI-DLC コマンドがまだ走っているかもしれない間に、再試行を進めるためにプロジェクトロックやそのローカル調整ゲートを削除しないでください。

---

## フックが発火しない

**症状**: ファイル書き込みの後、intent の `audit/` シャードにエントリが現れない、またはサブエージェントの完了ログがない。

### ネイティブランタイム対ソース生成の Bun 射影

ソース/開発の `dist/` 射影は、その17個の TypeScript フックを `bun` 経由で走らせます。ネイティブインストールとバージョン付きリリースランタイムは、それらと同じフックを `aidlc` 経由でルーティングします。ソース生成のインストールが、非対話の PATH で Bun を見つけられないと、そのフックは発火しません。

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
npm install -g bun
# or: powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version
```

ソース生成の `dist/` インストールでは、ハーネスがそのフックに渡す PATH に `bun` がなければなりません。ターミナルから開始したハーネスはそのターミナルの PATH を渡すので、そこで `bun --version` が動けば十分です。ドック、デスクトップアイコン、サービスから開始したハーネスはその PATH を得ません。そのフックが走らないなら、`bun --version` が動くターミナルを開き、そこで `bun <harness-dir>/tools/aidlc.ts doctor`（たとえば `bun .kiro/tools/aidlc.ts doctor`）を実行します。その `Runtime hook PATH` 行が、加えるべきディレクトリとどこに加えるかを名づけます。その後ハーネスを再起動します。それまでは、そのターミナルから開始します。ネイティブの Windows PowerShell では、`npm install -g bun` が設定するシステム PATH エントリで十分です。

### Kiro IDE のフックが走らない

Kiro IDE は、あるフォルダでコマンドを実行することを許可し、その後ウィンドウをリロードして初めて、そのフォルダのフックを走らせます。許可するまで、エージェントが実行するすべてのコマンドは出力なし、exit code -1 で返るので、AI-DLC のメッセージは表示できません。エージェントが自分でそのステップをあなたに渡します。Kiro が開いた後にフォルダを信頼した場合、コマンドは走りますが、リロードまでフックはなお走りません。AI-DLC はそのとき作業の前に止まり、エージェントが同じステップをあなたに示します。プロジェクトでの最初のチャットメッセージの前に、doctor は「AIDLC hooks have not run in this project yet」と警告します。それは想定どおりです。

中身が分かっているフォルダ（自分のプロジェクト、または確認したもの）だけを信頼します。信頼すると、そのフォルダの `.kiro` フックがあなたのマシンでコマンドを実行できるようになるためです（[First run](harnesses/kiro-ide.md#first-run) を参照）。

1. Kiro がこのフォルダを信頼するか尋ねたら **Trust Folder & Continue** を選びます。代わりに Restricted Mode バナーがウィンドウ上部に出たら、その **Manage**、次に **Trust** を選びます。
2. コマンドパレット（Ctrl+Shift+P、macOS では Cmd+Shift+P）を開き、**Developer: Reload Window** を実行します。信頼はリロード後に効きます。
3. チャットで続けると言います。次のメッセージがなお記録されないなら、`/aidlc --doctor` が理由を示します。

### Kiro CLI のフックが走らない

Kiro CLI の v2 と v3 のエンジンは、異なるフック登録を読みます。エンジンが、あなたがインストールした AI-DLC のディストリビューションと一致しないと、どのフックも走りません。そのときすべての承認と確認が、人の返答が届いていないと言い、レビューは出力に記録された書き込みがないと言い、最初のワークフローステージの後、doctor は「Hooks have never executed」と報告します。同じエンジンで再起動しても何も変わりません。

- **`kiro` ディストリビューション**（`.kiro/agents/aidlc.json`）: フックは Kiro CLI の v2 エンジンで走るので、`kiro-cli --v2`（Kiro CLI 2.21.4 以降。古いものは [Kiro CLI](harnesses/kiro-cli.md#prerequisites) を参照）で、`aidlc` エージェントをアクティブにして開始します。v3 はそのファイルを AI-DLC が出荷するとおりには走らせません。別のエージェントが選ばれているときは、`/agent` とタイプして `aidlc` を選び、同じチャットで続けます。Kiro が返信の下に `agent "aidlc" needs upgrading for this agent engine` を表示するなら、セッションは 3.0 エンジンにあります。Kiro を終了し、このフォルダで `kiro-cli --v2 --agent aidlc` で再び開始します。ACP クライアントからは、`kiro-cli acp --agent-engine v2` を開始します。
- **`kiro-ide` ディストリビューション**（`.kiro/hooks/aidlc-*.json`）: フックは Kiro CLI の v3 エンジンでのみ走るので、`kiro-cli --v3` で開始します。Kiro CLI 2.33.0 はエンジンをコマンドラインか、あなた自身の Kiro CLI 設定からだけ取ります。`.kiro/settings/cli.json` が出荷する `"chat.agentEngine": "v3"` を無視します（そして `kiro-cli settings --workspace chat.agentEngine` を拒否します）。それは Kiro CLI 2.24.1 から 2.32.x だけが読みます。ACP クライアントは `kiro-cli acp --agent-engine v3` を開始しなければなりません。また、その `initialize` リクエストで `clientCapabilities._meta.kiro.hooks` を `{ enabled: true, v2: true }` と宣言しなければなりません。両方の値がないと、v3 はフックを走らせません。

これらの挙動は Kiro CLI 2.21.1 で測定したもので、後の Kiro CLI はそれらを変えるかもしれません。切り替えた後、メッセージを送り `/aidlc --doctor` を実行します。`kiro` ディストリビューションでは、あなたのメッセージが最初のハートビートを残すので、doctor はそれ以降フックを確認します。それまでは、このプロジェクトでまだ走っていないと警告します。

### GitHub Copilot のフックが走らない

VS Code は、信頼されたワークスペースで **Chat: Use Hooks** 設定（`chat.useHooks`）がオンのときだけ、プロジェクトのフックを走らせ、あなたの組織はその設定をオフにできます。`aidlc config` は、プロジェクトが設定していないとき、フォルダの `.vscode/settings.json` でそれをオンにし、フォルダの値が、オフのユーザー設定に勝ちます。Copilot CLI は、信頼するフォルダでだけフックを走らせます。どちらもスキップするときチャットで何も言わないので、AI-DLC が言います。あなたのメッセージについてフックが走っていないとき、エージェントが自分でフォルダ設定をオンにし、1行を示します。同じチャットで次のメッセージを送ります。新しいチャットやリロードは要りません。フォルダでの最初の Copilot チャットの前に、doctor は「AIDLC hooks have not run in this project yet」と警告します。チャットが始まるまでそれは想定どおりです。

1. VS Code では、フォルダの作者を信頼するか初回に尋ねられます。信頼します。組織が Chat: Use Hooks をオフにしているなら、管理者だけがそれを戻せます。
2. Copilot CLI では、尋ねられたらフォルダを信頼します。ヘッドレスの `copilot -p` 実行は決して尋ねません。フォルダで一度 `copilot` を開始し、「Yes, and remember this folder for future sessions」を選びます。

フォルダの信頼の詳細は [GitHub Copilot](harnesses/copilot.md) を参照してください。

### Codex CLI のフックが信頼されていない

Codex は、その `/hooks` 画面でフックを信頼して初めてプロジェクトのフックを走らせ、フックが変わると再び尋ねます。Codex で `/hooks` とタイプし、`t` を押してすべて信頼し、Esc を押し、同じチャットで続けます。Codex の外の何も、これをあなたのために行えません。

### opencode のプラグインがロードされない

opencode が AI-DLC のプラグインをロードするのは、プロジェクトフォルダで素直に開始したときだけです。`--pure` の下やサブフォルダからの起動は、この条件から外れます。opencode を終了し、プロジェクトフォルダでちょうど `opencode` で再び開始し、`/aidlc` とタイプして続けます。エージェントがこのステップであなたのリクエストを止めたときは、それが示した `/aidlc --request <id>` 行を代わりにタイプします。そのリクエストは一度続きます。

### Claude Code や Codex がプロジェクト内のフォルダで開始された

どちらのツールも、`src/` のようなプロジェクト内のフォルダから `/aidlc`（Codex では `$aidlc`）を提供しますが、AI-DLC のフックは、ツールがプロジェクトフォルダ自体で開始されたときだけ機能します。Claude Code はそこでプロジェクトのフックを1つも走らせず、Codex はそのフォルダからそれらを走らせますが、そこでは始められません。どの設定も `/hooks` の信頼も、それを変えません。ツール自身のチャットの記録が、そのようなフォルダで開始されたと言うとき、エージェントは何も変えず1行を示します。ツールを終了し、プロジェクトフォルダで再び開始し、それが示した `/aidlc --request <id>` 行をタイプします。それはあなたのリクエストで一度続きます。doctor も同じステップを示します。チャットがどこで始まったかを見つけるため、AI-DLC はその記録を読み、その中の他は読みません。Claude Code ではその config フォルダ（`CLAUDE_CONFIG_DIR`、なければ `~/.claude`）の `sessions/<pid>.json`、Codex ではそのホーム（`CODEX_HOME`、なければ `~/.codex`）の `sessions/` の下のチャットのファイルの最初の行です。そのような記録がないと、走っていないフックの通常のステップが当てはまります。

### Claude の管理ポリシーがプロジェクトのフックをブロックする

`/hooks` がフックはポリシーで制限されていると報告し、構成されたフックがゼロと表示するなら、`/aidlc --doctor` を実行します。Claude Code では、doctor は macOS で `/Library/Application Support/ClaudeCode/managed-settings.json`、Linux/WSL で `/etc/claude-code/managed-settings.json`、Windows で `%ProgramFiles%\ClaudeCode\managed-settings.json` に続けてレガシーの `%PROGRAMDATA%\ClaudeCode\` の場所を読みます。各候補は、その兄弟の `managed-settings.d/` ディレクトリの下のアルファベット順の JSON フラグメントも含みます。実効のトップレベルの `allowManagedHooksOnly: true` は、`.claude/settings.json` が宣言するすべてのプロジェクトフックをブロックします。管理ファイルが別の場所にあるときは `AIDLC_MANAGED_SETTINGS_PATH` を設定します。その兄弟のフラグメントディレクトリは自動的に含まれます。

この管理設定を解除できるのは Claude Code の管理者だけです。プロジェクトのフックを許可してもらいます。

### Cursor のプロジェクトが git リポジトリの外にある

Cursor が同じプランの承認を何度も求める、またはあなたの選択が記録されなかったと言うなら、`/aidlc --doctor` を実行します。Cursor は、git リポジトリにないフォルダではプロジェクトのフックをスキップすることがあり、フックがないとあなたの承認は決して記録されません。doctor が「project is in a git repository」で失敗したら、プロジェクトで `git init` を実行し、Cursor を完全に再起動し、尋ねられたらフォルダを信頼します。`aidlc config --harness cursor` とコピーインストーラーは、git リポジトリの外でプロジェクトをセットアップするとき、同じ助言を表示します。

### レビュアーのツール呼び出しが拒否される（"This review cannot open ..."）

ユニットごとの Construction レビューの間、reviewer-scope フックは、ディスパッチされたレビュアーの、兄弟ユニットの `construction/` パスに届くツール呼び出し（stage-protocol-reviewer-unit.md の read-scope の境界）を拒否します。拒否は現在のユニットを名づけ、レビュアーを、供給されたファイルとそのユニット自身のパスへ向け、各拒否は `REVIEWER_SCOPE_BLOCKED` 監査行を記録します。自分のソースツリーに AI-DLC のユニットと無関係な `construction/` ディレクトリがあり（正当なレビュアーの読み取りが拒否されている）なら、`/aidlc config set guard.reviewer-scope off` が、あなたが取り組む作業についてレビュアーの read-scope チェックだけを下げ（`GUARD_DISABLED` 監査行として記録、次の作業では戻る）、`AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` が、その read-scope の強制をマシン全体で無効にします。どちらでも、文章の境界はなお統治します。どちらの設定も、クレーム済みのチームチェックアウトが別のユニットの `construction/` サブツリーに書くことを許しません。チャットでの一般的なリクエストは read-scope チェックを下げません。上記のスイッチをタイプすると、エージェントがそのセッターを実行します。スコープの変更だけでは、走行中のポリシーを決して下げません。進行中のレビューがないのにレビュアーが拒否されるのは、古いディスパッチ記録を意味します。`/aidlc --doctor` のフックドロップのカウンター（`reviewer-scope.drops`）を確認し、あれば `<record>/.aidlc-engine/reviewer-dispatch.json` を削除します（6時間より古い記録は無視され自動的にクリーンされます）。

`grep latency construction/U03-scoring/nfr.md | grep endpoint` のような通常のフィルターは許可されます。2つめの `grep` がパイプされたテキストを検索するためです。パイプは、なおファイルをたどるコマンドを免除しません。再帰的な `grep`、`rg --files`、`rg -f -` は、なおスコープ内の検索ルート、または `rg` については現在のユニットに制約された glob を必要とします。`-f` で供給されるパターンファイルもスコープ内でなければなりません。パスなしのコマンドが `.` にフォールバックして拒否されるとき、メッセージがそのルートを暗黙のものと特定します。

### Sensor が発火しない

`/aidlc --status` の **Sensors** 行を確認します。`classic` スコープは Sensors をオンにデフォルトします。intent のオーバーライドやキルスイッチが Sensors をオフにすると、自動の書き込み時チェック、ゲート開始時チェック、リビジョンチェック、承認時のリビジョンバックストップチェックは走りません。`/aidlc --sensors on` が、アクティブな intent を再び組み入れます。`AIDLC_DISABLE_SENSORS=1` がその intent 設定に優先します。それ（と記録されたプロジェクトのバイパス）を解除して、自動チェックを再び許します。すべてのフックはインストールされたままで、明示的な `aidlc engine sensor fire` は、自動 sensor がオフでも診断用に使えます。

### ステータスラインに、望まないコストのセグメントが出る（または使用トラッキングの懸念）

Claude Code では、ステージごとのトークン使用とコストのトラッキングがデフォルトでオンです。fold-usage フックがトランスクリプトの使用を gitignore されたローカルのレジャー（`aidlc/.aidlc-sessions/usage-ledger.json`）に記録し、ステータスラインは `↑<in> ↓<out> $<usd>` を付け、完了の監査イベントはコストのロールアップを運びます。どこにも何も送信されません（メトリクスの発行は `AIDLC_METRICS_ENDPOINT` 経由で別途オプトインです）。すべてのローカルトラッキングをオフにするには `AIDLC_DISABLE_USAGE_TRACKING=1` を設定します。レジャーは更新を止め、ステータスラインのセグメントは消え、完了イベントはロールアップのフィールドを加えません。既存のレジャーはディスクに残ります。履歴も消したいなら手動で削除します。フラグを解除するとトラッキングが再開します。

**`$<usd>` の数字はローカルの見積もりで、請求ではありません。** 出荷のレートテーブル（[Rate table and overrides](../reference/06-hooks-and-tools.md#rate-table-and-overrides) を参照）の **公開のリスト価格** から値付けされます。Amazon Bedrock が記録されたプロバイダーのとき（`CLAUDE_CODE_USE_BEDROCK=1`）、Bedrock が実際に請求する額は、あなたの推論プロファイル、リージョン、サービスティア、交渉済みまたはサブスクリプションの価格によるので、見積もりは請求書と一致しないことがあります。長いワークフローのトークン量の大半はキャッシュ読み取りで、割引されたキャッシュ読み取りレートで請求されるため、カウントと見積もりは着実に増えます。それは実際の使用そのものです。数字は個人の意識づけの信号として扱います。

**見積もりを自分のレートで値付けするには**、`AIDLC_MODEL_RATES` を、出荷の `.claude/tools/data/model-rates.json` と同じ形のレートファイル（100万トークンあたりの USD、モデルバージョンごとに1キー。`opus-5-5` と `opus-5` は別の行）に設定します。部分的なファイルは、名づけたモデルだけを変え、他はすべて出荷のデフォルトを保ちます。レートは使用が記録されるにつれ適用されるので、変更はその時点以降のターンを値付けします。すでにレジャーにある合計は、記録されたレートを保ちます。

**見積もりを表示したくないなら（プレゼン、画面共有、録画の間など）、コストのセグメントをオフにします。** gitignore された `.claude/settings.local.json` にキルスイッチを加えます（トークン/コストのセグメントだけを取り除きます。ワークフローは影響を受けません）。

```json
{
  "env": {
    "AIDLC_DISABLE_USAGE_TRACKING": "1"
  }
}
```

### フックが構成されていない

フックは、ハーネスのネイティブな構成でプロジェクト全体に登録されます。Claude では、`.claude/settings.json` に期待される `hooks` イベントが含まれることを確認します。ネイティブのプロジェクトでは、アクティブなワークフローを完了させ、`aidlc config --harness claude` を実行して出荷の登録を復元します。あなた自身のフックエントリは保たれます。コピーチャンネルのプロジェクトは代わりに `bun .claude/tools/aidlc.ts config --harness claude --from <the runtime/claude root you copied from>` を使います。`--force` は不要です。登録が復元されたとき、注記が伝えます。フローを変える登録がそのイベント、マッチャー、コマンドを変えたとき、または出荷のフックがもう結線されていないとき、doctor は失敗します。他の AI-DLC 登録のドリフトは警告を出します。あなた自身の追加のフックはドリフト警告を引き起こしません。チームがそのファイルに設定したステータスラインは保たれます。AI-DLC 自身のステータスラインはそこで出荷されません。各人が `/aidlc --statusline on` で自分向けにオンにします。手動コピーでは、同じバージョン付きの `runtime/<harness>/` アーカイブから、ハーネスのルート全体を置き換えます（コピーはあなたの `.gitignore` や `AGENTS.md` を決して置き換えません）。1つのフックコマンドを単独でパッチしないでください。手動アーカイブは Bun 形で、ネイティブの `aidlc` 実行ファイルを必要としません。

### フックがグローバルに無効（`disableAllHooks`）

Claude Code は、どの設定レイヤーの `"disableAllHooks": true` も尊重します。エンタープライズ管理設定、`.claude/settings.local.json`、`.claude/settings.json`、`~/.claude/settings.json`（または `CLAUDE_CONFIG_DIR` が設定されているときはその下の `settings.json`）です。設定されると、ファイルが存在し正しく結線されていても、**すべての** フックが黙ってスキップされるので、ワークフローはあなたの返答を記録できません。`/aidlc --doctor` はこれを検出し、問題のレイヤーを名づける **Hooks enabled** 行で失敗します。Claude Code のレイヤー優先順位に従うので、優先度の高い `false` が低い `true` を抑えます。あなたのメッセージについてフックが走っていないとき、エージェントは作業の前に自分で下記の変更を行い、Claude Code がまずあなたに尋ねます。

- 問題のレイヤーが **プロジェクトまたはユーザーのファイル** なら、このプロジェクトの `.claude/settings.local.json` に `"disableAllHooks": false` を設定します。そのファイルはプロジェクトとユーザーのファイルに勝るので、そのどれかのオフを、あなたのユーザー設定を変えずにカバーし、同じチャットで効きます。再起動も `/hooks` も要りません。
- それが **エンタープライズ管理設定**、もっとも優先度の高いレイヤーなら、プロジェクトやユーザーのファイルではオーバーライドできません。Claude Code の管理者にプロジェクトのフックを許可してもらいます。
- あなたが **フックをオフにする設定で Claude Code を開始した**（たとえば `--settings '{"disableAllHooks": true}'`）なら、プロジェクトファイルでもオーバーライドできず、doctor はそれを見られません。その設定なしで Claude Code を再び開始します。
- **このフォルダで Claude Code がすでに開いている間に AI-DLC がセットアップされた** なら、そのセッションはそのフックを決してロードしませんでした（ネイティブインストールではそれらは `aidlc` を呼び、開いているセッションはまだそれを見つけられません）。Claude Code を終了し、このフォルダで再び開始し、エージェントが示した行をタイプします。`/aidlc --request <id>` が、止めたリクエストで一度続き、`/aidlc` 単独は作業の現状から続きます。

このチェックは、ディスク上の管理設定の **ファイル**（Linux では `/etc/claude-code/managed-settings.json`、macOS では `/Library/Application Support/ClaudeCode/managed-settings.json`、現在の Windows では `%ProgramFiles%\ClaudeCode\managed-settings.json`。`%PROGRAMDATA%\ClaudeCode\` はレガシーの二次）に加えて、兄弟の `managed-settings.d/` ディレクトリのアルファベット順の JSON ファイルを読みます。Claude Code がサポートする他の管理チャンネル（MDM、Windows レジストリ、リモート/サーバー管理のソース）は **検査の対象外** です。そのため通った行は、チェックが読めたどの設定ファイルでも解決値が `true` でないことを意味し、それらのチャンネルがクリーンだという保証ではありません。管理ファイルが非標準のパスにあるなら、`AIDLC_MANAGED_SETTINGS_PATH=/path/to/managed-settings.json` でチェックをそれに向けます。そのファイルの隣のフラグメントが含まれます。

### Agent Hooks の下で Kiro のフックがオフになった

Kiro では、Agent Hooks パネルでどのプロジェクトフックもオフにでき、そのとき `.kiro/hooks/` のそのフックのファイルに `"enabled": false` を書きます。フックは他に何の兆候もなく走るのを止めます。`/aidlc --doctor` は、すべての AI-DLC フックファイルでそのフラグを読みます。`aidlc-guard-tool-call` がオフのとき、承認されたプラン、レビュー済みの作業、AI-DLC の記録は保護されません。`aidlc-record-human-turn` がオフのとき、あなたの返答は記録されないので、承認は見られない回答を待ち、チャットでタイプした `/aidlc` コマンドは直接実行されません。どちらか一方がフックを名づける行で失敗し、Kiro が Stop フックのブロックを許すところでワークフローを動かし続ける `aidlc-continue-workflow`（Kiro CLI v3。Kiro IDE はそれを記録するだけ）も同様です。オフにされた他の AI-DLC フックは、何が失われるかを言う警告です。Kiro の Agent Hooks の下でフックを戻すか、doctor が名づけるファイルで `"enabled": true` を設定します。次の AI-DLC ステップが、変更ごとに一度、作業の前に1行として同じことを言い、`aidlc-record-human-turn` がオフの間、承認は、フォルダを信頼するのではなく Agent Hooks の下でそれを戻すよう伝えます。何もフックをあなたのために戻しません。

---

## Kiro の読み取り拒否 <a id="kiro-ide-read-denials"></a>

### Kiro IDE または Kiro CLI v3 が .kiro/ の下のすべての読み取りを拒否する（"deny fs_read matching"）

**症状**: すべてのステージ、エージェント、プロトコルの読み取りが拒否され、ワークフローをブロックします。

```text
Tool call denied by user's permissions. Rule: deny fs_read matching ".kiro/" Source: ~/.config/git/ignore
```

Kiro CLI v3 はこう言います。

```text
Blocked by a permission rule (deny fs_read matching ".kiro/"); the user did not reject it. Source: ~/.config/git/ignore.
```

[Kiro IDE と Kiro CLI v3 は尊重します](https://kiro.dev/docs/kiroignore/)。git のグローバルな excludes ファイル（git リポジトリで）と `~/.kiro/settings/kiroignore` を自動的に。Kiro CLI v3 はプロジェクトの `.kiroignore` も適用し、`.gitignore` は適用しません。Kiro IDE では、ワークスペースの ignore ファイルは、その `kiroAgent.agentIgnoreFiles` 設定がそれらを名づけるときだけ適用されます（デフォルトは `.gitignore` を含み、`[]` はワークスペースのソースを無効にします）。Kiro は各 ignore ファイルを個別に評価します。プロジェクトの `!.kiro/` の否定は、`git check-ignore` がそのパスを ignore されていないと報告しても、グローバルな `.kiro/` ルールを取り消しません。`permissions.yaml` の `fs_read` の allow は、拒否を **解除しません**。[Kiro はスコープをまたいで deny-overrides を適用します](https://kiro.dev/docs/permissions/)。

`/aidlc --doctor` を実行します。Kiro IDE または Kiro CLI v3 のインストール（`.kiro/agents/aidlc-aidlc.md` がある）では、問題のソースをこう報告します。

```text
Kiro ignore sources: <source>:<line> hides .kiro/
```

doctor は、エンジンがエージェントに `fs_read` で行わせる読み取りを、エンジン自身の名簿からテストします。`harness.json` がコンパイル済みステージグラフで選ぶすべてのステージについて、ステージファイルと、コンダクターがインラインで保つペルソナと知識（Standard と Minimal の深さで、ディレクティブの 8 KiB の `inline_context_paths` のキャップ内）、加えて `stage-protocol.md` とその `stage-protocol-<name>.md` モジュール、各スキルの `SKILL.md` の隣のファイルです。プラグインは、どうコンポーズされたかに応じてカウントされます。`stage-definition.md` のような貢献者専用のプロトコルファイルはロードされません。`SKILL.md` ファイル、コンダクターエージェント（`agents/aidlc-aidlc.md`）、`aidlc-common/conductor.md`、そして `tools/`、`sensors/`、`hooks/`、`scopes/`、`steering/` は、`fs_read` ではなく Kiro 自身かエンジンがロードし、カウントされません。それらの一部だけを隠すルールは、カウントと、それが触れるフレームワークのフォルダとともに報告されます。たとえば `hides 11 of 110 framework files (.kiro/agents/)` です。

グローバルソースのマッチは doctor を失敗させます。プロジェクトの `.gitignore` と `.kiroignore` のマッチは代わりに警告します。doctor はどの Kiro を走らせているか分からず、それらのワークスペースファイルが Kiro IDE で適用されるかを統治する IDE 設定を読めないためです。警告は、それぞれどこで適用されるかを言います。Kiro CLI v3 は `.kiroignore` を適用するので、そこでは `.kiroignore` のマッチがそれらの読み取りを拒否し、`.gitignore` は適用しません。

`<source>` は固定の名前です。`~/.config/git/ignore`（または `$XDG_CONFIG_HOME/git/ignore`）、`core.excludesFile`（そのパスは `git config --get core.excludesFile` を実行）、`~/.kiro/settings/kiroignore`、`.gitignore`、`.kiroignore` です。doctor の出力はエージェントが読むので、doctor は ignore ファイルのパス、そのルール、git のエラーテキストを決して表示しません。

doctor が評価できないソースは `not evaluated` と警告し、その `fix:` 行が進み方を名づけます。

- **`git is not available`**: `git` を PATH に置き、doctor を再実行します。それまでは、名づけられたファイルを手で確認します。git のグローバルな excludes ファイルは git が読む `core.excludesFile` で、もっとも固有のものから順に、環境のコマンドスコープの設定（`GIT_CONFIG_COUNT` と `GIT_CONFIG_KEY_<n>`・`GIT_CONFIG_VALUE_<n>`、または `GIT_CONFIG_PARAMETERS`）、リポジトリの config（`.git/config` と `.git/config.worktree`。`.git` がファイルであるリンクされた worktree やサブモジュールでは、その `gitdir:` 行が名づける git ディレクトリと、その git ディレクトリの `commondir` ファイルが名づけるディレクトリ）、あなたのグローバル git config（`~/.gitconfig`、`$XDG_CONFIG_HOME/git/config` または `~/.config/git/config`、または `GIT_CONFIG_GLOBAL` が名づけるファイル）、次にシステムの gitconfig（`GIT_CONFIG_SYSTEM` が名づけるファイル、なければ git インストールのシステムファイル。Git for Windows インストールの下の `/etc/gitconfig` や `etc/gitconfig` など。`GIT_CONFIG_NOSYSTEM` が真のときはスキップ）です。各ファイルの `include.path` と該当する `includeIf.<condition>.path` エントリを再帰的にたどります。どれも設定しないとき、ファイルは `$XDG_CONFIG_HOME/git/ignore`、`XDG_CONFIG_HOME` が未設定なら `~/.config/git/ignore` です。
- **`git rev-parse exit <n>`** または **`git config exit <n>`**: ディスクにリポジトリが存在しても、git がこのプロジェクトを拒否します。プロジェクトで `git status` を実行して理由を見ます。所有が疑わしい場合、git が表示する `git config --global --add safe.directory` コマンドを実行します。その間、プロジェクトの外（たとえばホームディレクトリ）で `git config --get core.excludesFile` を実行して git のグローバルな excludes ファイルを見つけ（出力なしは `$XDG_CONFIG_HOME/git/ignore`、`XDG_CONFIG_HOME` が未設定なら `~/.config/git/ignore`）、それを確認します。
- **その他の理由**、たとえば `did not finish` した git コマンド（タイムアウト）: 名づけられたファイルを手で確認します。git のグローバルな excludes ファイルは `git config --get core.excludesFile` が表示するものです。

シェルで `GIT_CONFIG` が設定されているなら、`git config --get core.excludesFile` を実行する前にそれをクリアします。たとえば `env -u GIT_CONFIG git config --get core.excludesFile`（PowerShell では先に `Remove-Item Env:GIT_CONFIG`）です。`GIT_CONFIG` は `git config` だけを別のファイルに向けるので、そうしないとコマンドが git の適用しないファイルを名づけてしまいます。doctor も同じようにそれをクリアします。

名づけられた行のルールを取り除くか狭め、`/aidlc --doctor` を再実行します。リポジトリごとの個人の ignore は、git が尊重し Kiro が ignore ソースとしてリストしない、そのリポジトリの `.git/info/exclude` に保ちます。別のファイルの否定や permissions の allow は、問題のルールを直す代わりにはなりません。

---

## 状態ファイルの問題

**症状**: オーケストレーターが壊れた状態を報告する、またはワークフローが予期せず振る舞う。

### 状態ファイルがない

状態ファイルは、Initialization の間、または `/aidlc` にスコープが与えられたときに作られます。

- `/aidlc --status` を実行して、アクティブなワークフローがないことを確認します
- `/aidlc` または `/aidlc <scope>` を実行して、新しいワークフローを始めます

### 状態ファイルが壊れた

`validate-state.ts` フックは、すべてのコンパクションで2つの必須セクション `## Stage Progress` と `## Current Status` を確認します。修復するには、

1. `/aidlc --doctor` を実行し、報告された状態、グラフ、フックの問題に対処します
2. 生成された Stage Progress の行が古いなら、状態の再同期を所有するエンジンのパスを再実行します。`/aidlc` でワークフローを開始または再開するか、`/aidlc --scope <scope>` でスコープを変えて、コンパイル済みグラフとスコープグリッドを再適用します
3. `.claude/knowledge/aidlc-shared/state-template.md` は、セクションとフィールドの契約としてのみ使います。テンプレートからステージの行を手で復元しないでください
4. 記録が修復できないなら、`/aidlc intent archive <name>` でそれを退役させ（その `aidlc/spaces/<space>/intents/` の下の記録ディレクトリは保たれます）、`/aidlc` を実行して新しく始めます

---

## ディスパッチされたステージのタイムアウト

**症状**: ディスパッチされたステージ（Reverse Engineering、Practices Discovery、User Stories、Code Generation）がエラーや切り詰められた出力を返す。

### 何が起きるか

フレームワークは組み込みのリトライプロトコルに従います。

1. 縮小コンテキストのプロンプトでの **自動リトライ**
2. **リトライが失敗したら**、2つの選択肢:
   - **Run inline** — ステージをメインの会話で直接実行する（サブエージェントの境界なし）
   - **Skip and revisit** — ステージを未完了とマークし、あとで戻る

### 手動の回復

`/aidlc` を再実行します。`[-]`（進行中）の状態を検出してステージを続けます。最初からやり直すには redo と言います。何が失敗したかを理解するため、`audit/` シャードのエラーエントリを確認します。

---

## 承認ゲートで止まる

**症状**: ワークフローが承認ゲートであなたの応答を待っている。

### 進め方

プロンプトが出たら応答をタイプします。選択肢は次のとおりです。

- **Approve** — 次のステージへ続ける
- **Request Changes** — 修正のフィードバックを渡す

Kiro IDE で、すでに返答したのにワークフローがなお待つなら、[Kiro IDE hooks not running](#kiro-ide-hooks-not-running) を参照します。Kiro CLI では [Kiro CLI hooks not running](#kiro-cli-hooks-not-running) を参照します。

### リビジョンループの脱出口

同じステージで3回のリビジョンサイクルの後、3つめの選択肢 **Accept as-is** が現れます。これはステージをそのまま承認して進みます。AI-DLC は作業の記録にそのカウントを保つので、止めて再開した後や、新しいチャットで続けた後も、その選択肢は現れます。

### ステージを飛ばす

`/aidlc --stage <target>` で別のステージにジャンプします。間のステージは状態ファイルで `[S]`（スキップ）とマークされます。

### レビュー済みのドキュメントに別の変更が要る

最終レビューがすでにそのドキュメントをカバーしているなら、レビューが異なる内容を黙って認証できないよう、直接の編集はブロックされます。

- ステージがアクティブか承認待ちの間、変更を説明し **Request Changes** を選びます。決定はゲートが開く前に記録できます。
- ステージが `[R]` の間、`/aidlc --stage <slug>` でそれを再開します。
- ステージが `[x]` の後、レビュー済みのソース状態を復元するか、`/aidlc --stage <slug>` で戻ってやり直します。

ワークスペースのソースだけが変わり、1回の回復レビューがまだ使えるとき、古い Review セクションを置き換える前に、その回復リクエストを開始します。保留中のリクエストは、古い条件が残る間だけ、そのステージまたはユニットへの書き込みを一時的に許します。レビュー済みのワークスペースのソースを復元する、判定を記録する、別のセッションを開始または再開することが、凍結を再び武装させます。出力ドキュメントのバイトを復元しても、監査に記録された成果物の古さはクリアされません。セッションの再起動の後、Review セクションを置き換える前に、同じ保留中のリクエストを再試行します。一致する判定が記録されるまで、ゲートは閉じたままです。

### ディレクトリのソースマニフェストが、ignore された出力を含むため拒否される

**症状**: `src/` のようなディレクトリのクレームが、ビルドの後に `contains ignored application source "src/main.js.map"` と答える。

Git の ignore ルールだけでは、レビューのソース境界からファイルを取り除きません。その境界の外の生成された出力については、その正確なパス（またはその出力ディレクトリ）を、リポジトリルートの `.aidlc-source-paths.json` の `exclude` に加え（たとえば `{"version":1,"exclude":["src/main.js.map"]}`）、レビューを再試行します。ディレクトリのクレームは、その隣のソースをなおカバーできます。登録された `paths` エントリは `exclude` に優先し、境界内になお残る他の ignore されたファイルは拒否を保ちます。正確なファイルのクレームは、なお admissible なソースを名づけなければなりません。除外は、ignore された出力をレビューの証拠にしません。

### 正確なソースマニフェストのファイルが、Git が ignore するため拒否される

**症状**: `source-manifest.json` にすでにリストされた正確なファイルが、`is ignored by Git and cannot be source-review evidence` と答える。

ignore された正確なファイルは、HEAD がすでにそれを追跡しているとき、または明示的にソースとして登録されているときに admit されます。Git のインデックスだけに加えること（force-add を含む）や、jj だけで追跡することは、HEAD メンバーシップを確立しません。レビュー済みのソースとして意図したファイルについては、`{"version":1,"paths":["src/runtime.js"]}` のような登録を、そのソースリポジトリのルートの `.aidlc-source-paths.json` にマージし、レビューを再試行します。既存のエントリは保ちます。登録されたパスは `exclude` に優先します。AI-DLC が決してソースとして扱わないフォルダ（`node_modules/` や sensor キャッシュなど）の下のファイルは登録できません。代わりにその正確なクレームを省きます。

ソースでない出力については、正確なクレームを省きます。レジストリの `exclude` リストを使って、出力をソースとして登録する代わりにソース境界の外に置きます。`/` で終わるディレクトリのクレームには、ignore された子孫の別のチェックがあります。正確なファイルの admit は、そのチェックを変えません。

### どのユニットもカバーしないファイルが変わったため Code Generation が完了できない

**症状**: Code Generation の承認が「N changes made during Code Generation that no Unit's review covers (...)」と答える。

ステージの間に、どのユニットのソースマニフェストもリストしないものがワークスペースで変わりました。行が3つの進み方を名づけ、アシスタントが合うものを取ります。変更を行ったユニットがそのパスをリストしもう一度レビューされる、誰も意図しなかった変更が取り消される、ソースでないパス（リポジトリ内に書かれたツールのキャッシュ、ビルド出力、このプロジェクトのコードでないネストしたリポジトリ）が `.aidlc-source-paths.json`（記録されたリポジトリや記録されたチェックアウトについてはそれ自身のフォルダのファイル）の `exclude` の下に名づけられてソースのチェックから外される、です。exclude はすぐ効き、以降のレビューは要りません。パスを戻すにはその行を取り除きます。プロジェクトの `.gitignore` がすでに ignore するパスは決してカウントされず、このフォルダの別の進行中の作業（ここで自分の作業をビルドする2つめのチャット）が自分のユニットのソースマニフェストにリストするファイル、またはそれがリストするフォルダの下のものも同様です。それは他の作業の変更で、その作業自身のチェックがカバーします。終えない作業を退役させる（`/aidlc intent archive <name>`）と、そのクレームが終わります。Guard Policy relaxed または off のもとでは、変更は保たれ、代わりに一度言われます。

ユニットのないプランでは、同じ変更が「the project source changed after <reviewer> reviewed it」（または、1回の回復レビューが使われた後は「changed again after the one recovery review」）に続けて、何が変わったかと、ソースでないパスの同じ進み方を答えます。exclude はそこでも、以降のレビューなしにすぐ効きます。

### 同じプランについて Plan Approval が2回尋ねられた

**症状**: Code Generation が、あなたがすでに承認したプランについて Plan Approval の質問を再び提示する。

Plan Approval は、プラン、ユニットテスト指示、Testing Contract の内容に、ターゲットに、そして現在のステージの試行にバインドします。`/aidlc` の再実行、セッションの再起動やコンテキストのコンパクション、Stop フックのプローブ、`/aidlc --status` では **再開されません**。プランのチェックボックスにチェックを入れても再開せず、レビューの記録がプランに触れることも決してありません。

同じターゲットと試行について、プラン、テスト指示、Testing Contract の編集は、Guard Policy `strict` のもとでのみ承認を再開します。`relaxed` または `off` のもとでは、更新された内容で作業が続き、元の承認の記録はそのまま残ります。あなたが編集を承認したとは主張しません。`/aidlc --status` の `Guard Policy:` 行が実効の設定を示します。それでもプランを再びレビューするよう求められます。

code generation が、プランについてまったく尋ねずに始まるなら、この作業について plan approval がオフです。status はそれがどこから来たかを示します。たとえば `Plan Approval: off (from scope poc)` です。各プランを名づける行は、いつでもそれを確認するよう求められると言います。すべてのプランについて尋ねられるよう頼むこともできます。[Plan approval](13-customization.md#plan-approval) を参照してください。

Testing Posture、スコープ、テスト戦略、プロジェクトタイプの変更は、同じ intent、ターゲット、試行の中で同じルールに従います。必要に応じて現在の契約と指示をリフレッシュします。下がったフェンスは、それらの入力が変わっただけでは再び承認を求めずに実行を続けます。

再び尋ねられたら、何が変わったか、どのルールが当てはまるかを確認します。

- plan-approval フェンスがオンの間の、プランの内容または埋め込みの Testing Contract（チェック済みのタスクマーカーや、レビュー記録が存在する前に記録されたレビューが残した末尾の `## Review` セクションを超えて）
- ユニットテスト指示の内容の、どのバイトでも。指示は開発者にそのまま全部渡されるので、バイト単位でバインドし、承認後に追加されたセクションは、plan-approval フェンスがオンのとき再開します
- plan-approval フェンスがオンの間の、Testing Posture、スコープ、テスト戦略、プロジェクトタイプ（ビルドのレビューの後に行った Testing Posture の変更。learnings のステップで保つテストの慣行など、は次のプランから適用され、そのビルドの承認を再開しません）
- アクティブな intent、ユニット、ステージのターゲット
- ステージの試行: 後方へのジャンプ、Request Changes、ゲートの拒否、ワークフローの再起動

質問は、それが何についてかを名づけます。承認後に他のコードが動いても（`git pull`、別のユニットの着地）、再び尋ねることは決してありません。ビルドは続き、どのファイルが動いたかを聞きます。例外は `strict` のもとでのユニットの並列ビルドです。あなたが承認した後の変更（あなたの編集やコミット、`git pull`）は、ユニットがセットアップされる前に再び尋ね、あなたがそれを取り消すか Guard Policy `relaxed` を設定するまで、次のユニットが着地するのを止めます（[Guard Policy](13-customization.md#guard-policy) を参照）。あなたの回答とビルドの間の何も尋ねません。長いチャットがコンテキストをコンパクトする、作業をパークして再開する、別の質問が先に出る、などです。先にもう一度見たいなら、それらのどれかの直後も含めて「review the plan」と言います。もう何かがビルドされる前に、プランが承認のため再び表示されます。

### Plan Approval が記録されない

**症状**: Plan Approval の質問に答えたのに、AI-DLC がそれを再び示す。

あなたの回答は、この作業のどのチャットからでも、自分の言葉（「1」、「approve」、「looks good」、「rename the handler」）でカウントされます。エージェントはあなたが行った選択を、あなたの言葉とともに記録します。質問が戻ってくるのは、エージェントが選択を記録できなかったときだけで、多くは質問が表示される前に返答が届いた、またはハーネスがそれを AI-DLC に渡さなかったチャットだったためです。表示された質問に答えます。戻り続けるなら、`/aidlc --doctor` を実行します。プロンプトフックが走らないハーネスは、どの返答も記録できません。質問が待つ間にコンテキストをコンパクトする長いチャットは質問を開いたままにするので、あなたの回答はなおカウントされます。

AI-DLC が、プロジェクトのファイルがすべて読めない、またはワークスペースのソースがバインドできない（ループするリンク、読むには大きすぎるツリー、プロジェクトの外のソースパス）と言うとき、何が起きるかはあなたの設定によります。Guard Policy strict で plan approval がオンのもとでは、ビルドが何から始まるかを何も言えないので、プランはまだ承認できません。そうでなければプランの質問はいつもどおり尋ねられ（plan approval がオフなら、プランは書かれたとおりビルドされます）、ビルドはプロジェクトのファイルのチェックなしに始まり、1行がそう言います。ファイルを確認させるには、メッセージが名づけるソース境界を修復し（問題のパスを `.aidlc-source-paths.json` の exclude リストに加える。これは `{"version":1,"exclude":["<path>"]}` のような形です。除外されたディレクトリの下の実在のソースをその paths リストに宣言する。壊れたシンボリックリンクを取り除く）、次に `/aidlc`（Codex では `$aidlc`）を実行します。`/aidlc --doctor` には、失敗しているパスを名づけ、どれが当てはまるかを言う「Workspace source boundary binds」チェックがあります。

プロジェクト内に保たれた有効な Git チェックアウトは、リンクされた worktree を通じてを含め、そのオブジェクトストアを jj と共有できます。古い AI-DLC インストールが、jj が作ったパックから Git が読めるコミットについて「no resolvable HEAD commit」と報告するなら、AI-DLC を更新し、プロジェクトのインストールをリフレッシュします。リポジトリの再パックや jj 設定の変更は不要です。本当に欠けている、または読めない HEAD オブジェクトは、なお修復が要ります。

プランの Testing Contract が拒否されるなら、メッセージが3つの原因の1つを名づけます。ブロックがない、有効な JSON でない、レンダリングされた後に変わった、です。修復は3つとも同じです。`render` を再実行し、`## Testing Contract` セクション全体を置き換えます。変わったブロックは通常、シェルコマンドがファイルを書き直しその文字を再エンコードした（たとえば PowerShell の `Set-Content`）ことを意味します。成果物は代わりにファイル編集ツールで編集します。あなた自身の編集がブロックを壊したとき、アシスタントがそれを修復し、編集されたプランをビルドするか一度あなたに尋ねます。

**レガシーの Kiro IDE ウィンドウ。** AI-DLC にタイプされたテキストを渡さない Kiro IDE のビルドは、ピッカーだけで、古い記録済みの決定と回答のステップを通じてプランを承認します。そこでは回答が、それが与えられたチャットセッションにバインドします。プロジェクトのファイルが確認できないとき、それを選ぶかそう言うことで、アシスタントにとにかくプランをビルドするよう頼むことができ、ファイルのチェックなしにあなたの承認として記録されます。Kiro IDE を更新すると、自分の言葉で、どのチャットからでも答えられ、またはファイルを編集できます。

---

## Bolt の試行が脇に置かれた — ファイルを取り戻す

回復は、レビュー済みのファイルが再び変わり、許された1回の再レビューがすでに使われたとき、試行を脇に置くことがあります。回復の中断の `--discard` は、追跡されたファイルと ignore されていない未追跡のファイル（またはチェックアウトがすでに消えているときは残りのブランチ先端）に加えてレビュー済みのソース ref をローカルの Git に保存してから、古いチェックアウトとブランチを取り除くので、新しい試行を始められます。`--discard` のない通常の Abort は、チェックアウトをその場に残し、`parked_ref: null` を返し、`parked_stamp`、`parked_mode`、`parked_repo`、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` はありません。discard の後、アシスタントは試行を脇に置いた理由を伝え、`restore_operation` があるときだけ、表示のヒントがレンダリングできたかにかかわらず、復元を申し出ます。成功した中断はすべて `reason: "aborted"` を保持し、供給された `--reason` のテキストを追加の `abort_reason` フィールドにエコーします。試行がパークされたとき、結果は保存されたデスクリプタ `parked_ref`、`parked_stamp`、`parked_mode`（`snapshot`、`branch-tip`、`evidence-only`）、`parked_repo`（プロジェクトルートは `null`、そうでなければ兄弟リポジトリの名前）を含みます。

ファイルが保存されたなら、復元を頼みます。アシスタントは保存された結果の `restore_operation` を使います。stamp が分かっているとき、ルート `worktree`、args `["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]` です。末尾のセレクタが所有する intent を固定します。インストール済みの `{{INVOKE}} engine worktree <args...>` ルートを、リストされた各 arg を別々の argv 引数としてそのまま呼び出し、決してシェルコマンドに結合しません。`restore_hint` は人向けの表示テキストにとどまる値で、アシスタントの実行入力とは区別されます。メインのプロジェクトチェックアウトから実行する、同等の手動コマンドは次のとおりです。

```bash
aidlc engine worktree restore --slug <slug> --parked <stamp> --repo <name|.> --intent <record-dir-name> --space <space>
```

この操作は常に、兄弟リポジトリには `--repo <name>`、ルートには `--repo .` を含みます。その任意の表示ヒントは選んだシェル向けに安全にレンダリングされます。ネイティブインストールは上記のプレフィックスを使い、Bun ベースのコピーインストールは `bun .claude/tools/aidlc-worktree.ts` を使い、あなたのハーネスディレクトリに置き換えます。安全なレンダリングが失敗した場合（たとえばハーネスディレクトリが無効なため）、結果は `restore_hint` を省き、理由とともに `restore_hint_error` を供給します。タイプされた操作は引き続き使えます。これは、証拠だけが保存されたことや、復元の申し出の取り下げを意味しません。

操作の正確な stamp、リポジトリ、所有する intent のセレクタを落とさないでください。`--parked` がないと、restore はもっとも新しい保存された head を選びます。手動の呼び出しでは、1つのリポジトリだけで見つかった正確な stamp が、一般的な slug の曖昧さより先にそれを選びます。選択がなお曖昧なら、doctor の正確な操作を `--repo <name>`、またはプロジェクトルートには `--repo .` で使います。

保存された名前空間は分かっているがその discard デスクリプタが使えないとき、フォールバックは `parked_ref` を保持し、stamp が厳密にパースされるときだけその名前空間から `parked_stamp` を導出します。そうでなければ `parked_stamp` は `null` です。`parked_mode: null` と `parked_repo: null` を報告し、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` を省き、リポジトリ、保存モード、最新試行の選択を推測しません。代わりに `recovery_hint` が、脇に置かれた試行とその正確な restore コマンドをリストするため doctor を実行するよう求めます。ヒントは平易なガイダンスにとどまり、実行可能な操作とは区別されます。アシスタントは、どのファイルが保存されたかを主張してはならず、フォールバックだけからの復元を申し出てはなりません。名前空間が保存されなかったなら、`parked_ref` は `null` で、`parked_stamp`、`parked_mode`、`parked_repo`、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes`、`recovery_hint` はありません。

レビューの証拠だけが残ったなら、discard は `parked_mode: "evidence-only"` と `parked_commit: "-"` を報告します。Abort は ref、stamp、モード、リポジトリを保ちますが、`restore_operation`、`restore_hint`、`restore_hint_error`、`parked_excludes` を省きます。アシスタントは言います。「Nothing of its working files remained to save; only its review evidence was kept.」復元は申し出ません。その試行を restore で、`--raw` を付けてでも選ぶと、`no restorable files were parked for <slug> <stamp>; only review evidence was kept` で拒否します。

復元が成功した後、返された `worktree_path`、通常 `.aidlc/restored/bolt-<id8>_<slug>-<stamp>`（アップグレード前の試行については記録されたレガシー名）を開きます。それは新しいライブの試行とは別です。ファイルを復元しても古い試行を再開せず、そのレビューを最新にしません。これはあくまでローカルの回復であり、リモートのバックアップとは別物です。古いチェックアウトがすでに消えていたなら、その残りのブランチ先端とレビューの証拠だけが保存でき、そのブランチも消えていたなら、レビューの証拠だけが残れました。

**上限は `parked_mode` によります。** スナップショットは `parked_excludes: ["ignored files", "eol/text=auto normalization"]` を報告します。ignore された未追跡のファイルは保存されず（追跡されたファイルは含まれたまま）、正規化は保存中に行末を変えることがあり、正規化されたバイトは `--raw` でも回復できません。ブランチ先端は代わりに `["uncommitted files (no working tree existed)"]` を報告し、アシスタントは言います。「I kept its committed work; there were no uncommitted files to save.」スナップショットは保存された blob を直接復元し、ブランチ先端は `--raw` が与えられない限り通常のチェックアウトの変換を使います。フィルターの失敗と raw 回復の詳細は [restore command reference](12-cli-commands.md#aidlc-engine-worktree-restore-recover-files-from-a-set-aside-attempt) を参照してください。

`/aidlc --doctor`（または `aidlc doctor`）を実行して、保存された試行を見つけます。その情報的な **Parked attempts** セクションは、slug、stamp、経過、モード、復元されたチェックアウトの有無、そして正確な `--parked <stamp>` と明示的な `--repo <name>` または `--repo .` の args、続けて所有する `--intent` と `--space` のセレクタを持つ、タイプされた回復の操作をリストします。すべての JSON エントリは `purge_operation` を持ち、復元可能なエントリだけが `restore_operation` を持ちます。それぞれルート `worktree` と、シェルコマンドの文字列ではなく argv としてそのまま渡す args を持ちます。任意の `restore_command` と `purge_command` は安全な人向けの表示テキストです。レンダリングが失敗すると、対応するコマンドは省かれ、`restore_command_error` または `purge_command_error` が、操作を取り除かずに理由を説明します。証拠のみのエントリは purge の操作とそのコマンドまたはエラーのフィールドだけを持ちます。あり得ない日付や時刻は JSON で `age_days: null` を持ち、人が読める出力で `unknown` を示します。保存された試行は警告でも失敗でもありません。

doctor は、名前空間を持つ試行をその intent のレジストリの UUID を通じて、レガシーの試行を正確な `WORKTREE_DISCARDED` の `Parked ref` 来歴を通じて解決します。未知または曖昧な所有者と、帰属のないレガシーのパークはリストされません。もう要らなくなったら、まず復元されたチェックアウトを取り除き、次に、

```bash
aidlc engine worktree purge --slug <slug> --parked <stamp> --repo <name|.> --intent <record-dir-name> --space <space>
aidlc engine worktree purge --slug <slug> --older-than 30 --repo <name|.> --intent <record-dir-name> --space <space>
```

どちらの stamp セレクタもない purge は、選択された intent の Bolt のすべての保存された stamp を取り除きます。`--older-than` は非負の有限の日数を受け取り、`-N` のサフィックスを無視して、厳密により古い UTC の stamp のタイムスタンプを選びます。厳密なカレンダーパーサーは、あり得ない日付と時刻を正規化せず拒否します。年齢でフィルターした purge は、パースできない stamp を保ち、`skipped_unparseable` でそれらを報告します。この JSON 配列は常に存在し、他のときは空です。正確な stamp または全 stamp の purge は、パースできない stamp を取り除けます。`--older-than` は `--parked` と組み合わせられません。purge は、選択された復元されたチェックアウトがあると、移動されていても拒否します。ライブの Bolt チェックアウトを決して取り除きません。コピーインストールには同じ Bun ツールのプレフィックスを使います。[purge reference](12-cli-commands.md#aidlc-engine-worktree-purge-remove-recovery-refs) を参照してください。

restore と purge は、何かを選択または変更する前に、未知または重複のフラグを拒否します。コマンドリファレンスのフラグだけを使います。回復のセレクタと doctor は、プロジェクトルート（`.`）と、同じ slug の `WORKTREE_CREATED` または `WORKTREE_DISCARDED` 監査の `Repo` フィールドに名づけられた有効な Git リポジトリを、それらの兄弟名がシンボリックリンクであっても受け取ります。フレームワークは、試行の worktree やパークを記録したまさにその場所で回復できます。この admit は slug スコープです。他の slug の記録が、この slug のリポジトリセットを決して広げません。現在または過去の intent のリポジトリリストのメンバーシップだけでは、シンボリックリンクを admit できません。intent リストの候補と記録されていない発見された兄弟は、その正規パスが正規のワークスペースルートの直下に留まる実在の直下の子ディレクトリでなければなりません（`isWorkspaceRepoDir`）。任意のパスと、同じ slug の監査来歴のないシンボリックリンクのエイリアスは拒否されます。これらの回復のセレクタは、ライブの create/discard コマンドや必要な人の同意を変えません。

---

## コンテキストのコンパクション

**症状**: Claude Code が以前の会話コンテキストを要約した。セッションが最近の議論を「忘れた」ように感じるかもしれない。

### 何が保たれるか

すべての記録ディレクトリの成果物、`aidlc-state.md`、`audit/` シャードはディスクに残ります。失われるのは、メモリ内の会話コンテキストと、まだファイルに書かれていない進行中の部分的な作業だけです。

### 回復の仕方

コンパクションの後に `/aidlc` を実行します。フレームワークは、

1. `aidlc-state.md` を読んでワークフローの位置をロードします
2. 作業が止まったところから続けます

進行中だったステージをやり直させるには、「redo this stage」と言います。

### コンパクションの後にビルドが止まる

**症状**（GitHub Copilot）: コードプランを承認し、ビルドが始まり、チャットがコンパクトした後、アシスタントが試みるすべてのビルドステップが拒否される。

あなたの承認、ワークフローの状態、すでに書かれたすべてのファイルは保たれます。失われるのは、アシスタントがまだファイルに書いていなかったものだけがチャットから消えます。コンパクションの後、アシスタントは何かをビルドする前に自分のステップを再び読まなければなりません。`next` を自分のコマンドとして実行し、承認済みのビルドをあなたに再び尋ねずにそのまま返します。`/aidlc --doctor` は、その `next` が走るまで、ステップを時刻と理由（チャットがコンパクトされた、またはステップが発行された後にワークフローの状態が変わった。分かるときは何が変わったかを名づける）とともに古いと示します。

---

## 監査ログが大きくなりすぎる

**症状**: このクローンの監査シャードが、長いプロジェクトにわたって数千行に増えた。

長いプロジェクトのシャードは設計上大きいものです。そのままにします。エンジンは `audit/` のすべてのシャードを読んで、あなたが承認したステージと、完了したユニットを知るので、1つを `audit/` の外に移すと、その作業が未完了としてカウントされ、エンジンがそれを再び手渡します。（PreToolUse ガードは、エージェントのファイルとシェルのツールが `audit/` へ書き込むことを拒否します。）

### Git の考慮

`audit/` シャードはコミットされます（gitignore されません）。[What to Commit vs. Gitignore](14-artifacts-reference.md#what-to-commit-vs-gitignore) を参照。各クローンは自分の `<host>-<clone>.md` シャードを書くので、同時の追記が決してマージ競合しません。

### 移動・コピー・同期されたプロジェクト

`aidlc/.aidlc-clone-id` は、このクローンのトークンと、最初に使われたホスト名を記録するので、マシンの名前が変わったり、フォルダが別のラップトップにコピー・同期されたりしても、シャード名は同じままです。作業は1つのシャードで続きます。新しい `git clone` は、自分のトークンとシャードを得ます。1つのフォルダの2つのコピーは1つのクローンなので、2人（または2台のラップトップ）が同時に作業するなら、それぞれに自分の `git clone` を与えます。同期ツールが `<host>-<clone> 2.md` のような競合コピーを残したら、AI-DLC はそれが元と共有する行を一度読むので、完了した作業はカウントされ続け、コピーは残せます。チームのユニット所有では、ユニットの着地は、コピーを含め、予期しないファイルがあると、なお止まります。そのファイルを名づけます（`Unit landing requires a clean source worktree; commit or stash: ...`）。

そのようなコピーが以前のリリースですでにプロジェクトにあり、作業を続けていた場合、コピーがそこにある間に完了したユニットは、アップグレードの後にもう一度手渡されることがあります（コピーの前に完了したユニットは再びカウントされます）。何も削除されません。ユニットのファイルはまだそこにあるので、ほとんどのステージでは、もう一度完了してもそれを記録するだけです。Code Generation のユニットは、そのプランをもう一度承認するよう尋ね、すでにブランチにあるコードから再びビルドすることがあります。一度だけ起き、決して繰り返さず、計画中のフォローアップがそれすら取り除きます。

1つの狭いケース。自分の worktree でビルドされた Code Generation のユニットが、完了したがアップグレード時にまだマージされていなかった場合です。もう一度ビルドすると `Worktree directory already exists`、または `resume requires the completed, merged prior Bolt` で止まります。`aidlc engine worktree discard --slug <unit>` を実行します。それは、その worktree を取り除く前に、先の試行のファイルを脇に置き、次に `/aidlc` がユニットを再びビルドし、`aidlc engine worktree restore --slug <unit>` が、望むときにいつでも先のファイルを別のチェックアウトに戻します。

---

## ロックファイルが残る

**症状**: フックが短くハングしてからスキップするように見える。以降の監査エントリが書かれない。

監査フックは、同時書き込みを防ぐため（`lib.ts` 経由で）`mkdir` ベースのロックを使います。フックが中断されると、ロックディレクトリが残ることがあります。ロックファイルはシステムの一時ディレクトリ（`os.tmpdir()` — 通常 macOS/Linux では `/tmp/`、Windows では `%TEMP%`）に作られます。

### 古いロックを見つける

```bash
# macOS / Linux
ls -la /tmp/.aidlc-*

# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter ".aidlc-*"
```

ロックディレクトリは、システムの一時ディレクトリ内で `.aidlc-audit-<hash>.lock` と `.aidlc-subagent-<hash>.lock` と名づけられます。

### 古いロックをクリアする

まず `/aidlc --doctor` を実行します。それは、証明可能に死んだ世代、作成世代がもう一致しない再利用された PID、または所有者スタンプが決して完了しなかった（ない、空、切れた）古いロックだけを自動的にクリアします。一致する、または未知のライブの世代、有効な所有者を名づけないスタンプ、読めないスタンプは、報告されますが取り除かれません。

手動のクリーンアップの前に、影響を受けるロックを使うすべての AI-DLC プロセスを止め、所有権とプロジェクトが静止していることを確認し、診断の証拠を保ちます。名づけられたロックだけを調べます。ロックディレクトリを一括削除しないでください。ロックとその所有者スタンプ付きの `.reap` 回復ゲートは一時的で、必要に応じて再作成されます。`.gate-mutex` ファイルは、永続的な advisory ロックのアンカーで、一時ディレクトリに空のまま残ることがあります。空のファイルは、古い所有者の証拠ではありません。プロジェクトのトランザクションロックは、[上記の所有権チェック](#transaction-lock-ownership) を使います。

---

## ステータスラインの問題

### ワークフローがアクティブなのに "ready" を示す

ステータスラインは `aidlc-state.md` の `**Lifecycle Phase**` フィールドを読みます。そのフィールドがない、または空だと、`[AIDLC] ready` にフォールバックします。

**対処:** `/aidlc --doctor` を実行して状態ファイルの整合性を確認します。`## Current Status` セクションに `**Lifecycle Phase**` エントリがあることを確認します。

### 古いデータを示す

想定どおりの挙動です。ステータスラインは、状態ファイルが次に書かれるとき、通常はステージの遷移時に更新されます。

### まったく現れない

1. AI-DLC のステータスラインは、セットアップで選んだか、オンにしたときだけ表示されます。`/aidlc --statusline on`（Codex では `$aidlc --statusline on`）を実行します。Claude Code では、あなた自身の `.claude/settings.local.json` に入ります。組織の管理設定が選ぶステータスラインは、なお勝ちます。
2. `aidlc doctor` を実行し、報告されたネイティブのコマンドやホストの結線を修復します。
3. コピーインストールでは、Bun がホストプロセスの PATH にあることを確認します。
4. 状態ファイルがないと、`[AIDLC] ready` が想定の出力です。

---

## `--doctor` を使う

`--doctor` ユーティリティコマンドは、あなたのセットアップを検証します。何かおかしいときにいつでも実行します。

```
/aidlc --doctor
```

次を確認します。前提条件（`bun`）、フックの可用性（`settings.json` が結線するすべてのフレームワークのフックが `.claude/hooks/` に存在しなければならず、結線されたが欠けたフックは明示的に失敗します。有効なカスタムの非 AI-DLC の `statusLine` は、結線されていない `aidlc-statusline.ts` を意図的に免除します）、フックがグローバルに無効でないこと（どの Claude Code 設定レイヤーでも解決された `disableAllHooks: true` は明示的に失敗します）、管理されたプロジェクトフックのポリシー（`allowManagedHooksOnly: true`）、プロジェクト構造（`settings.json`）、ワークスペースシェルの準備（`.claude/` + `aidlc/spaces/default/memory/`）、状態/監査の整合性（記録された `WORKFLOW_COMPLETED` に対するワークフローの Status、そして現在の試行について監査が記録したステージの開始と完了に対する各 Stage Progress のチェックボックス。監査が開始を示すのにチェックボックスがなお `[ ]` と読めるステージが、ワークフローがそれを完了するのを拒否させるもので、警告が変えるべき正確な行を名づけます。チームのユニット所有のもとでは、ユニットごとの Construction のチェックボックスは Unit Progress から導出されるので、比較されません）、フックのハートビート、グラフの整合性（サイクルなし、すべてのグラフエントリにファイルがある）、**Composed plugin surface**（有効なプラグインのステージがコンパイルされ、貢献のサイドカーとターゲットが有効で、記録された構造的な追加と文章のフラグメントが存在し変わっていない）、選択を意識したプラグインオーサリングのチェック、11個すべてのスコープにわたるスコープの検証、**Composed scope durability**（すべてのコンポーザーオーサリングのスコープが実在のプランに解決する。グリッド列のないスコープファイル、まだ射影されていない耐久的な `aidlc/scopes/<name>.md` 記録、または解決できないスコープを名づける実行可能なワークフローはすべて失敗し、compile が原因に届けるところではどこでも `graph compile` を対処とします。その背後に記録のない欠けた列は、別に報告されます。compile は、あるステージが宣言するスコープについてだけ列を出すためです）、ステージのスキーマ + グラフの参照、スコープをまたぐキーワードの重複です。通る advisory の行には、グラフのロード順で生産者が曖昧な、消費される成果物の **Duplicate producers**、**Rule drift**（ライフサイクルで古くなった重複は stale-suppressed として別に報告）、**Paired sensor coverage**、`HUMAN_TURN` のないステージ/ゲートのレジャー、24時間を超えて人を待つ承認ゲート、プラグインの advisory チェック、コミットされていないワークスペースの記録、進行中の新しい compose/バックグラウンドサブエージェントの状態、そして `repos.json` があるとき、宣言されたリポジトリと管理された `.gitignore` のドリフトが含まれます。24時間より古い compose マーカーや2時間より古いバックグラウンドサブエージェントのエントリは、正確な `rm aidlc/.aidlc-*` の対処で失敗します。doctor はどちらの画面も削除しません。**Hook drops** は条件付きです。黙って劣化したフック（たとえば貢献を適用できなかったプラグイン compose、または失敗した再コンパイル）は、重大度タグ付きの行を `<hooks-health>/<hook>.drops` に記録します。`[degraded]` のドロップは doctor を **失敗** させ（CI ゲートが半分適用されたプラグインを捉えます）、他のドロップは各フックのもっとも頻度の高い理由（それぞれ最初のコロンまで。詳細はファイルに残ります）を名づける通る行で、フックの最新の失敗が24時間未満の間は `Hook failures, the latest within the last day` の警告に引き上げられます（1日後、またはファイルを削除するとクリアされます。`[advisory]` の行はそれを引き上げません）。フックの通常の決定、たとえば Stop フックが、あなたが先に答えなければならないのでターンを終わらせることは、`<hook>.trace` に行き、決してカウントされません。プラグイン compose フックは毎回その drops ファイルを書き直すので、原因を直して再コンポーズすると自己クリアします。クリーンと警告のみのレポートは 0 で終了し、失敗したチェックは 1 で終了します。健全な行は `--verbose` がない限りセクション単位で畳まれ、すべての警告と失敗は見えたままです。レポートはどちらにせよ stdout に書きます。コアのチェックは **読み取り専用** です。intent のまだない新しいシェルでは何も作らないので、最初の intent が作られる前にコマンドを安全に実行できます。プラグインのチェックは、慣例上読み取り専用であることが求められるインストール済みプラグインのコードを実行しますが、ランタイムはその性質を強制できません。intent が存在すると doctor は `HEALTH_CHECKED`（と `GUARDRAIL_LOADED`）監査行を記録します。

Kiro IDE と Kiro CLI v3 では、`.kiro/` を隠すルールについて各 ignore ソースを個別にも確認し、ファイルと行を名づけます。グローバルソースのマッチは失敗し、ワークスペースソースのマッチは警告します。doctor はどの Kiro を走らせているか分からないためです。Kiro IDE の `kiroAgent.agentIgnoreFiles` が、そこでそれらが適用されるかを統治し、Kiro CLI v3 は `.kiroignore` を適用し `.gitignore` は適用しません。[Kiro Read Denials](#kiro-read-denials) を参照。Cursor を除くすべてのハーネスで、プロジェクトで AI-DLC のフックが1つも走っていないとき「AIDLC hooks have not run in this project yet」とも警告します。それは最初のチャットメッセージの前は想定どおりです。1つの後、その対処があなたのツールのステップを名づけます（たとえば [Kiro IDE hooks not running](#kiro-ide-hooks-not-running) や [GitHub Copilot hooks not running](#github-copilot-hooks-not-running) を参照）。Kiro CLI では、フックが決して走らなかったワークフローは、そのフックが必要とするエンジンとともに「Hooks have never executed」で失敗します。[Kiro CLI hooks not running](#kiro-cli-hooks-not-running) を参照。

**Workspace record visibility** の advisory は、コミットされていない記録の行の隣で、config の後に加えられたユーザーの ignore ルールを捉えます。ルールのファイル、行、隠されたコミット対象の記録のパスを名づけます。個々の記録を force-add する代わりに、ルールを狭めます。この警告は doctor の終了コードを変えません。記録が見えるとき、Git リポジトリの外、または Git が使えないときは、行はありません。

Claude Code では、doctor はマシン管理の `managed-settings.json` とアルファベット順の `managed-settings.d/` フラグメントも読みます。実効の `allowManagedHooksOnly` の値が `true` なら、組織のポリシーが、プロジェクトの `.claude/settings.json` が宣言するすべてのフックをブロックします。そのポリシーを解除できるのは Claude Code の管理者だけです。そのポリシーが設定されておらず、ワークフローの進行の後もハートビートがなお欠けているとき、このプロジェクトの `.claude/settings.local.json` に `"disableAllHooks": false` を設定します。それは同じチャットで効きます。ワークフローに問題があるとき、`--doctor` は、構造化された所見（未解決のゲート、欠けたランタイムグラフ、冷えたフック、その他の「進まない」原因）をリストする **Workflow diagnosis** セクションも表示します。`--doctor --export` がそのレポートに書くのと同じ分析です。

各チェックが何を検証し失敗をどう直すかの全詳細は [CLI Commands](12-cli-commands.md#aidlc-doctor-health-check) を参照してください。

---

## 診断レポートを共有する

ワークフローが詰まる、または誤動作するとき（開かないゲート、進まないステージ、何度も拒否される承認済みのレポート）、メンテナーに見てほしいなら、次を実行します。

```
/aidlc --doctor --export
```

これは新しい `--doctor` パスを走らせ、次に小さな **編集済み** の診断レポートを `aidlc/diagnostics/` に書きます（`--output <dir>` でオーバーライド）。システムの `tar` が使えるときはタイムスタンプ付きの `.tar.gz` にパッケージし、そうでなければレポートディレクトリを保ち、自分で圧縮するよう伝えます。そのアーカイブ（またはディレクトリ）を共有します。それは診断と編集済みの証拠を運び、**あなたの成果物** は運びません。ワークスペースのソース、生の状態/監査/ランタイムグラフのファイル、成果物/貢献/質問/メモリの本体は含まれません。パスは正規化され、intent の id とユニット名はハッシュ化され、秘密らしい値はスクラブされます。

レポートは、監査証跡からワークフローのタイムラインを再構成し、決定的な条件→対処のルールを走らせます。もっともよくある2つの原因を捉えます。

- **未解決の承認ゲート** — ゲートが決して解決しなかったステージが、「進まない」原因として単独でもっともよくあります。
- **欠けたランタイムグラフ / 冷えたフック**: ないランタイムグラフ、または intent に記録されたもっとも新しいステージや承認のステップより1日以上前に最後に発火したフックは、走らなかった再コンパイルを指します。チャットを開くこと、プロンプト、doctor 自身の監査行は作業とカウントされないので、誰も取り組んでいない intent は、冷えたフックがあるとは読まれません。

レポート内の `report.md` は、すべての所見を対処とともにリストします。回復のバイパス（`AIDLC_DISABLE_*` の env var など）を名づける対処は、自動化に安全でないとフラグされます。レポートの全内容と安全モデルは [CLI Commands](12-cli-commands.md#aidlc-doctor-export-write-a-diagnostic-report) を参照してください。

---

## 次のステップ

- [State Tracking and Audit Trail](10-state-and-audit.md) — 状態ファイルの構造
- [Session Management](11-session-management.md): コンパクションの後に続ける
- [CLI Commands](12-cli-commands.md) — `--doctor`、`--status`、`--stage` の使い方
- [Glossary](glossary.md): コンパクション、フックの定義

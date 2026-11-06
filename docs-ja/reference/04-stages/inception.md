# Inception フェーズ -- stage リファレンス（2.1--2.9）

## フェーズの概要

Inception フェーズは、AI-DLC 方法論の 5 つのフェーズの 3 番目です。Ideation フェーズのビジネス intent と
scope を、具体的な技術アーティファクトに変換します。リバースエンジニアリングされたコードベースの理解
（brownfield プロジェクト向け）、チームの practice と運用ルール、形式的な要件、user story、refined mockup、
アプリケーションアーキテクチャ、unit-of-work の分解、そして Construction フェーズを律する delivery plan
です。

Inception は stage 2.1 から 2.9（9 stage）を実行し、Construction へ hand-off する前に、Stage 2.9
（Delivery Planning）でフェーズ境界の検証チェックで締めくくります。

> **パスの規約。** 各ワークフローのアーティファクトは、その **intent record ディレクトリ** 配下にあります。
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` です（`<space>` は、非デフォルトの space が使われていない
> 限り `default`、`<YYMMDD>` はレコードが時系列でソートされるようコンパクトな UTC 日付の接頭辞、`<label>` は
> リクエストの短い kebab-case の要点。同日の衝突には数字のカウンタが付く）。正準で衝突しない id は、
> `intents.json` レジストリ行に記録された UUIDv7 で、ディレクトリ名は人間が読めるラベルにすぎません。以下、
> `<record>/` はそのディレクトリの省略形です。例:
> `<record>/inception/requirements-analysis/requirements.md` は
> `aidlc/spaces/default/intents/<YYMMDD>-<label>/inception/requirements-analysis/requirements.md` に展開されます。
> Reverse Engineering の出力は例外です。intent record の外の、永続的でリポジトリごとのストア
> `aidlc/spaces/<active-space>/codekb/<repo>/` にあります。
> （intent ごとのレイアウトより前に作成されたプロジェクトはフラットなツリーを使っていました。engine が
> 初回実行時にそれらを移行します。）

このフェーズは 3 つの dispatch されるトポロジーを含みます。Stage 2.1 の 2 リンクの Reverse Engineering
パイプライン、Stage 2.2 の Practices Discovery のハブ&スポーク、Stage 2.4 の User Stories の mob です。その
support agent は、collaborators がオンのとき参加します（`collaborators` 設定。`enterprise` のためだけにオンで
出荷。`/aidlc --collaborators on` が 1 つの作業に対してそれをオンにする）。collaborators がオフだと、engine は
各 stage に空の `support_agents` 一覧を手渡し、lead が単独で実行されます。developer がパイプラインの唯一の
リンクで、9 つのアーティファクトを自ら書き、Practices Discovery はスポークを skip し、User Stories は mob
ラウンドを skip し、貢献ファイルは負われません。以下のステップは、完全な名簿を記述します。

**Inception フェーズの主要な特徴:**

- フェーズは、2 リンクのパイプラインを使う技術発見の stage（2.1 Reverse Engineering）で始まり、その後 subagent のハブ&スポークを使う方法論発見の stage（2.2 Practices Discovery）、次に inline の requirements stage、mob の story stage、5 つの inline の design/planning stage が続きます。
- Stage 2.1 は 2 リンクのパイプラインを使います。aidlc-developer-agent がコードをスキャンし、その後 aidlc-architect-agent がスキャンを 9 つの構造化されたアーティファクトに統合します。人間が再利用、置き換える完全な再スキャン、または共有ストアに知識を累積的にマージする focused なスキャンを選ぶ前に、各 brownfield リポジトリの既存のストアを確認します。
- Stage 2.2 は、greenfield と brownfield の作業で同じトポロジーを実行します。pipeline-deploy の lead ドラフト、相互に盲検の quality/developer/devsecops スポーク、人間へのインタビュー、その後 lead の統合です。追認時、内容が `<record>/inception/practices-discovery/` から space の memory レイヤー（`aidlc/spaces/<active-space>/memory/team.md` と `project.md`）に昇格されます。この段をまたぐ昇格が、この stage を他のすべての stage と構造的に区別します。
- Stage 2.7 は `unit-of-work.md` を生成し、それが Construction フェーズでのフェーズ化された construction フローを駆動する unit を定義します。
- Stage 2.9 は、承認された Bolt plan（経済的な順序、複数 Unit のグループ化、DoD、confidence 仮説、所有関係）を生成します。その plan は計画の内容です。Construction の runtime の batch は `unit-of-work-dependency.md`（2.7）から来ます。Stage 2.9 は、チームの Way of Working、Walking Skeleton の立場、Deployment のセクションについて `aidlc/spaces/<active-space>/memory/{org,team,project}.md` を読みます。
- Stage 2.9 のフェーズ境界の検証は、Requirements から Stories から Architecture への整合を検証します。

**scope 駆動の stage 包含:**

| Scope            | 含まれる stage                                                |
|------------------|----------------------------------------------------------------|
| enterprise       | 2.1--2.9 すべて                                                   |
| feature          | 2.1--2.9 すべて                                                   |
| mvp              | 2.1（brownfield なら）、2.2、2.3、2.4、2.5（UI なら）、2.6、2.7、2.8、2.9 |
| poc              | 2.1（brownfield なら）、2.3（最小限）                             |
| bugfix           | 2.1（brownfield なら -- バグを見つける）、2.3（最小限 -- バグの説明） |
| refactor         | 2.1（brownfield なら -- 現在のコードを理解する）、2.3（最小限）  |
| infra            | 2.2、2.3（infra 要件）                                  |
| security-patch   | 2.1（brownfield なら -- 脆弱性の文脈を見つける）、2.3（最小限） |
| classic          | 2.1--2.9                                                       |
| workshop         | 2.1--2.9                                                       |
| express          | 2.1（brownfield なら）、2.3                                      |

---

## stage 要約テーブル

| Stage | Name                   | Condition   | Lead Agent             | Support Agents                                       | Mode                             |
|-------|------------------------|-------------|------------------------|------------------------------------------------------|----------------------------------|
| 2.1   | Reverse Engineering    | CONDITIONAL | aidlc-developer-agent        | aidlc-architect-agent                                      | pipeline（aidlc-developer-agent → aidlc-architect-agent、2 リンクのチェーン） |
| 2.2   | Practices Discovery    | CONDITIONAL | aidlc-pipeline-deploy-agent  | aidlc-quality-agent, aidlc-developer-agent, aidlc-devsecops-agent      | subagent（greenfield と brownfield でハブ&スポーク） |
| 2.3   | Requirements Analysis  | ALWAYS      | aidlc-product-agent          | --                                                   | inline                           |
| 2.4   | User Stories           | CONDITIONAL | aidlc-product-agent          | aidlc-design-agent, aidlc-developer-agent, aidlc-quality-agent | mob                              |
| 2.5   | Refined Mockups        | CONDITIONAL | aidlc-design-agent           | aidlc-product-agent                                        | inline                           |
| 2.6   | Domain Design     | CONDITIONAL | aidlc-architect-agent        | aidlc-aws-platform-agent, aidlc-design-agent               | inline                           |
| 2.7   | Units Generation       | ALWAYS      | aidlc-architect-agent        | aidlc-delivery-agent                                       | inline                           |
| 2.8   | Contract Design        | CONDITIONAL | aidlc-architect-agent        | aidlc-aws-platform-agent                                   | inline                           |
| 2.9   | Delivery Planning      | ALWAYS      | aidlc-delivery-agent         | aidlc-architect-agent                                      | inline                           |

---

## Stage 2.1: Reverse Engineering

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.1                                                                    |
| Condition        | CONDITIONAL -- brownfield。verified-current のストアは再利用できる        |
| Lead Agent       | aidlc-developer-agent                                                        |
| Support Agents   | aidlc-architect-agent                                                        |
| Mode             | pipeline（2 リンクのチェーン: aidlc-developer-agent がスキャン、aidlc-architect-agent が統合して書く。collaborators がオフのときは developer 単独） |
| Completion Emoji | (stage-protocol.md の完了テンプレートを使う)                           |

### 目的

Reverse Engineering は、brownfield プロジェクトのために既存のコードベースを隅々まで分析します。2 リンクの
パイプライン（`mode: pipeline`）として実行されます。まず aidlc-developer-agent が、AI-DLC 自身のインストールを
除いて、コードベース全体をスキャンします。その後 aidlc-architect-agent が、スキャン結果を 9 つの構造化された
アーティファクトに統合して書きます。これらのアーティファクトが、以後のすべての Inception と Construction の
stage が構築する技術的な土台を提供します。

**再実行ガード:** Reverse Engineering は、スキャンの前に各リポジトリの記録された scope とワークツリーの
fingerprint を確認します。fingerprint は、AI-DLC 自身のインストール、設定、それが書き込むルートファイルを
除くため、AI-DLC の更新や設定変更がストアを stale にすることはありません。人間は、カバレッジが intent に合う
verified-current のストアを再利用できます。stale、未検証、レガシー、不一致のストアは、完全または focused な
再スキャンを必要とします。この stage の実行が既にスキャンして公開したストア（stage を引き継ぐ新しいチャット）は
戻って提示されません。stage はその承認へ進みます。完全な再スキャンはストアを置き換えます。focused な再スキャンは、
先行の散文を保ちつつ、新たに分析された領域をそれにマージします。マルチリポジトリの intent では、1 つの
stage レベルのライフサイクル report の前に、すべての判断が解決されます。

### Inputs

- `<record>/aidlc-state.md`（プロジェクトタイプの確認）

### Steps

1. **条件を確認する** -- `<record>/aidlc-state.md` を読み、プロジェクトタイプが brownfield であることを確認する。プロジェクトが brownfield でなければ、`aidlc-orchestrate.ts report --stage reverse-engineering --result skipped --reason "greenfield workspace has no existing codebase to reverse engineer"` でこの stage を skip する。engine が `[S]` を記録し、アトミックに先へルーティングする。

2. **Developer によるコードスキャン** -- aidlc-developer-agent subagent（`subagent_type="aidlc-developer-agent"`）で Task ツールに委譲する。agent の persona と知識は自動で読み込まれ、conductor は persona を注入しない。`aidlc-state.md` からのワークスペース state をコンテキストとして含める。

   developer は、次についてコードベース全体をスキャンする。
   - すべてのパッケージ、モジュール、その目的
   - ビルドシステム、設定、依存関係
   - 外部と内部の API（エンドポイント、契約、メソッド）
   - フレームワーク、ライブラリ、そのバージョン
   - テストディレクトリ、テストフレームワーク、カバレッジ設定
   - コード品質の指標（linting、CI/CD、ドキュメント）
   - 技術的負債のシグナル

   developer は、`{{HARNESS_DIR}}/knowledge/aidlc-developer-agent/re-artifacts.md` の Developer Code Scan Template に従って、そのスキャンを永続的な handoff ファイルに書く。プロジェクトルートのリポジトリには `<record>/inception/reverse-engineering/developer-scan.md`、登録されたリポジトリには `developer-scan-<repo>.md` である。その返却は、スキャンの本体ではなく、そのパスと懸念事項を指名する。

3. **Architect による統合** -- aidlc-architect-agent subagent（`subagent_type="aidlc-architect-agent"`）で Task ツールに委譲する。その persona と知識も自動で読み込まれる。developer の handoff パス（architect がそのファイルを読む）とテンプレートのパス、加えて `aidlc-state.md` からのワークスペース state を渡す。リポジトリの出力ディレクトリを `aidlc engine workspace codekb --repo <repo>` で解決する。スキャンの直前に、`codekb-snapshot` でソース/ストアの generation を捕らえ、既存のストアとそのスナップショットを architect に渡す。まだストアのない brownfield プロジェクトでは、次のとおりである。

   ```text
   $ aidlc engine workspace codekb-snapshot --repo shop-api --paths ./ --json
   {"repo":"shop-api","store":"aidlc/spaces/default/codekb/shop-api/","paths":["./"],"store_generation":"none","source_fingerprint":"git:bc8ac8583f61da1edd5bdc681a9db722a937848b","head_commit":"0107291c4e5f2a8b9d3e6f1a7c8b2d4e5f6a7b8c"}
   ```

   architect は、スキャン結果を完全な候補ディレクトリ `<record>/.aidlc-engine/codekb-stage-<repo>/` で 9 つの出力アーティファクト（下の Outputs 参照）に統合する。その後 `codekb-publish` が、スナップショットの値を返して、それをストアに入れ替える。

   ```text
   aidlc engine workspace codekb-publish --repo shop-api \
     --staged <record>/.aidlc-engine/codekb-stage-shop-api/ \
     --paths ./ --expect-store none \
     --expect-source git:bc8ac8583f61da1edd5bdc681a9db722a937848b --json
   ```

   別の intent がスナップショットの後にストアへ公開したとき、`CODEKB_STORE_CHANGED` で拒否する（ストアを読み直し、再マージし、新しいスナップショットを取ってリトライ）。Guard Policy strict では、コードがスナップショットの後に変わったとき `CODEKB_SOURCE_CHANGED` でも拒否する（再びスキャン）。relaxed または off では、スキャンを取ったとおりに公開し、変更の notice を返す。

4. **完了を準備する** -- 9 つのアーティファクトすべてが存在することを検証する。`aidlc-state.md` を編集しない。ライフサイクルの完了は gate の後の report に属する。

5. **完了を提示し承認を求める** -- `aidlc-orchestrate.ts report --stage reverse-engineering --result awaiting-approval` で gate を開き、9 つのアーティファクトすべてを表示し、その後、人間の approved/rejected の結果を同じ engine コマンドを通して報告する。

### Outputs

各リポジトリの 9 つのアーティファクトすべてが、`aidlc engine workspace codekb --repo <repo>` が出力する正確な
ディレクトリを使って、`aidlc/spaces/<active-space>/codekb/<repo>/` に書かれます。

| #  | File                             | 内容                                                    |
|----|----------------------------------|-------------------------------------------------------------|
| 1  | `business-overview.md`           | ビジネスドメイン、目的、主要な機能                 |
| 2  | `architecture.md`                | システムアーキテクチャ、パターン、コンポーネントの関係（Mermaid 図付き）。ビジネストランザクションがコンポーネントにまたがってどう実装されるかを描く Interaction Diagrams セクション（シーケンスまたはフロー図）を含まなければならない。 |
| 3  | `code-structure.md`              | パッケージ/モジュールの構成、ファイルの分類、コードパターン |
| 4  | `api-documentation.md`           | 外部と内部の API 表層、エンドポイント、契約    |
| 5  | `component-inventory.md`         | 責務と依存関係を伴う完全なコンポーネント一覧 |
| 6  | `technology-stack.md`            | バージョン付きの言語、フレームワーク、ライブラリ              |
| 7  | `dependencies.md`                | 外部依存関係、内部のパッケージ間依存関係  |
| 8  | `code-quality-assessment.md`     | テストカバレッジ、linting、CI/CD、ドキュメント品質、技術的負債 |
| 9  | `reverse-engineering-timestamp.md` | RE がいつ行われたか（日付、あればコミットハッシュ、分析の scope） |

### 承認 Gate

標準の 2 選択肢 gate: **Approve** / **Request Changes**。stage ファイルは Approve を「continue to Requirements
Analysis」とラベル付けしますが、engine は plan が実行する次の stage へルーティングします。それを含む scope では
Practices Discovery です。

### Notes

- **再実行ガード:** この stage は、人間が再利用か再スキャンを選ぶ前に、各 brownfield リポジトリの記録された scope と fingerprint を検証します。
- **2 リンクのパイプライン:** aidlc-developer-agent が生のコードスキャンを行い（リンク 1、lead）、その後 aidlc-architect-agent がスキャンを構造化されたアーティファクトに統合して書きます（リンク 2、最終リンク）。この分離が、スキャンが徹底的（developer の視点）で、統合がアーキテクチャに通じている（architect の視点）ことを保証します。
- bugfix、refactor、security-patch では、修正または変更されるコードを理解するために brownfield の作業で実行されます。greenfield の作業では、どの scope でもそうであるように、作成がそれを SKIP に設定します。
- ここで生成される 9 つのアーティファクトは、Requirements Analysis（2.3）、User Stories（2.4）、Domain Design（2.6）、Units Generation（2.7）が消費します。
- `architecture.md` アーティファクトは、ビジネストランザクションがコンポーネントにまたがってどう実装されるかを、シーケンスまたはフロー図で示す Interaction Diagrams を含まなければなりません。

---

## Stage 2.2: Practices Discovery

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.2                                                                    |
| Condition        | CONDITIONAL -- EXECUTE の scope では新鮮さのために常に再実行            |
| Lead Agent       | aidlc-pipeline-deploy-agent                                                  |
| Support Agents   | aidlc-quality-agent, aidlc-developer-agent, aidlc-devsecops-agent                        |
| Mode             | subagent（lead ドラフト → 相互に盲検の 3 つのスポーク → 人間へのインタビュー → lead の統合。collaborators がオフのときはスポークなし） |
| Completion Emoji | (stage-protocol.md の完了テンプレートを使う)                           |

### 目的

Practices Discovery は、2 軸の設定モデルの両方の段に書き込む、AI-DLC で唯一の stage です。チームの
way of working、walking-skeleton の立場、テストの姿勢、デプロイのケイデンス、コードスタイルのルールを発見します。
brownfield の実行はリポジトリと Reverse Engineering の証跡を使い、greenfield の実行はアクティブ space の
`org.md` から lead ドラフトの種をまきます。両方が同じ subagent のハブ&スポークを使います。pipeline-deploy の
lead ドラフト、相互に盲検の quality/developer/devsecops の貢献、人間へのインタビュー、その後 lead の統合です。
人間が追認 gate で承認した後、stage が承認を報告する前に、内容が
`aidlc/spaces/<active-space>/memory/team.md` と `project.md` に昇格されます。

### Inputs

- `<record>/aidlc-state.md`（プロジェクトタイプ）
- brownfield のみ: `aidlc/spaces/<active-space>/codekb/<repo>/` からの reverse-engineering の 9 つのアーティファクト（business-overview、architecture、code-structure、api-documentation、component-inventory、technology-stack、dependencies、code-quality-assessment、reverse-engineering-timestamp）
- `aidlc/spaces/<active-space>/memory/{org,team,project}.md`（デフォルトと先行の追認）
- `.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md`（lead-agent の KB）

### Outputs

4 つの lead アーティファクトと 3 つのスポークの貢献が、`<record>/inception/practices-discovery/` に書かれます。

- `team-practices.md` -- 記述的で、チームの声の散文。`team.md` の見出しに一致する 5 つのセクション: Way of Working、Walking Skeleton、Testing Posture、Deployment、Code Style。Testing Posture は、構造化された `Methodology: tdd|bdd|atdd|test-after|custom` と `Ordering: ...` の箇条書きを運び、coverage/tooling/scope のメモは追加の散文のまま。Methodology の値はその 5 つのうちの 1 つで他はなく、その理由は別の `Methodology evidence:` の箇条書きにある。gate は、Code Generation が読めなかった値では開かず、`practices-promote` は、理由とともに与えられた値（「test-after (because ...)」）を、`team.md` を書く前に、素の値とその箇条書きに分ける。2 つ目の方法論を指名する理由は mix を記述し、それは `custom` なので、その値は決して分けられない。
- `discovered-rules.md` -- 修正的で、agent 向け。2 つのセクション: Mandated（`ALWAYS …` のルール）と Forbidden（`NEVER …` のルール）。各ルールは 1 つのリスト項目で、それらのリスト項目だけがルールである（`aidlc-state.ts` の `practicesRulesToAdd`）。gate の行は、Approve が `project.md` に加えるものを指名し、`practices-promote` はまさにそれらを書く。
- `evidence.md` -- agent ごとの finding の要約。再実行のための新鮮さの証跡。
- `practices-discovery-timestamp.md` -- 実行タイムスタンプ + コミットハッシュ。
- `contributions/aidlc-{quality,developer,devsecops}-agent.md` -- 相互に盲検の各スポークからの 1 つの同一性を印した貢献（collaborators がオフのときはなし）。これらのファイルは engine がチェックする完了の証跡である。

追認時、内容が次に昇格されます。

- `aidlc/spaces/<active-space>/memory/team.md` -- `replaceSection` によるセクション置換（再実行は、累積ではなくセクションの内容を上書きする）。
- `aidlc/spaces/<active-space>/memory/project.md` -- `appendUnderHeading` による見出し下への追記（ルールが累積する。日付のスタンプがそれらを区別する）。

### Steps

1. **入力を分類する** -- `aidlc-state.md` を読み、greenfield と brownfield を分類し、アクティブ space を解決する。brownfield は Reverse Engineering のアーティファクトとリポジトリの証跡を読み込む。greenfield は `memory/org.md` からデフォルトを読み込む。再実行は、先行の `team.md` と `project.md` も読み込む。
2. **Lead ドラフト** -- `aidlc-pipeline-deploy-agent` を dispatch する。初期の `team-practices.md`、`discovered-rules.md`、`evidence.md` を書く。brownfield は観測された証跡からドラフトし、greenfield は org のデフォルトからドラフトし、未確認の assumption をすべて明確に印す。
3. **相互に盲検の 3 つのスポーク** -- 1 つの並列バッチで、lead ドラフトに照らして `aidlc-quality-agent`、`aidlc-developer-agent`、`aidlc-devsecops-agent` を dispatch する。ブリーフはドラフトのパスを含むが、他のスポークの出力は含まない。それぞれが `contributions/` 配下に自身の同一性を印した貢献ファイルを書く。lead のアーティファクトは編集しない。
4. **人間へのインタビュー** -- 3 つのスポークすべてが返った後、構造化された質問を提示する。brownfield は証跡のギャップとポリシーの判断を尋ね、greenfield は org のデフォルトを提案として 5 つの practice 領域すべてを尋ねる。再実行は先行の追認済みの記述を事前に埋める。すべての質問と正確な回答を記録する。
5. **Lead の統合** -- pipeline-deploy の lead を、ドラフト、3 つの貢献パスすべて、インタビューの回答とともに再び dispatch する。lead だけが最終アーティファクトを統合し、`PRACTICES_DISCOVERED` を出力する。混在するケイデンスは `Methodology: custom` を使い、Code Generation が回答を TDD に強制する代わりに、明示的な順序を保つ。
6. **追認 Gate を開く** -- 尋ねる前に `aidlc-orchestrate.ts report --stage practices-discovery --result awaiting-approval` を呼ぶ。ドラフトをちょうど 2 つの選択肢 **Approve** / **Request Changes** で提示する。Request Changes の応答は `--result rejected` を通して報告される。昇格は起きない。
7. **人間の承認の後に昇格する** -- 人間が Approve を選んだ後にのみ、アクティブ space の `team.md` と `project.md` への決定的な昇格を実行する。

   ```text
   aidlc engine state practices-promote \
     --team-practices <record>/inception/practices-discovery/team-practices.md \
     --discovered-rules <record>/inception/practices-discovery/discovered-rules.md \
     --affirming-user '<user>'
   ```

   `project.md` を先に、`team.md` を後に書き、`PRACTICES_AFFIRMED` を出力する。昇格が失敗すると、`PRACTICES_OVERRIDE` を出力し、stage を gate が開いたまま `[?]` に残し、承認を報告しない。
8. **Receipt を検証し、その後報告する** -- 成功した昇格は、`Practices Affirmed Timestamp` と、対応する `PRACTICES_AFFIRMED` 監査 receipt をアトミックに記録する。その後 `aidlc-orchestrate.ts report --stage practices-discovery --result approved --user-input "Approve"` を呼ぶ。engine は、完了してルーティングする前に、3 つの貢献ファイルすべて（collaborators がオフのときはなし）と現在試行の receipt を検証する。

### 承認 Gate

標準の 2 選択肢 gate: **Approve** / **Request Changes**。昇格が実行される間、Approve は開いたまま保たれます。
昇格と追認のタイムスタンプが成功した後にのみ、conductor は `--result approved --user-input "Approve"` を
報告できます。昇格の失敗は、gate を開いたまま、stage を未完了のままにします。

### Notes

- 昇格は、各 `team.md` セクションの本体を置き換え、その見出しを保ちます（`.claude/tools/aidlc-markdown.ts` の `replaceSection`）。そのため再実行は、`appendUnderHeading` がするように重複を積み上げません。
- `org.md` と `team.md` は、1 つの Title Case の見出し集合（`## Way of Working`、`## Walking Skeleton`、`## Testing Posture`、`## Deployment`、`## Code Style`）を共有します。stage は、対応する Title Case の見出しで `extractMarkdownSection` を通して `org.md` から各セクションを読み、`team.md` の同じ見出しをセクション置換します。
- Code Generation の決定的な posture resolver は、構造化された Testing Posture のフィールドを、coverage、tooling、scope のメモとは独立に読みます。そのため、project のみの coverage のメモは、その方法論を消さずに team セクションを特化させます。
- resume では、lead ドラフトと既存のすべての貢献ファイルを保ちます。欠けているスポークだけを dispatch し、その後インタビューと lead の統合で続けます。完了した support の作業を繰り返しません。
- 貢献の証跡は必須です。quality、developer、devsecops のいずれかの貢献が欠けているか、誤った同一性マーカーを持つなら、承認は拒否されます。

---

## Stage 2.3: Requirements Analysis

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.3                                                                    |
| Condition        | ALWAYS -- 深度は複雑さに適応する                                   |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | (none)                                                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :mag:                                                                  |

### 目的

Requirements Analysis は、ユーザーの intent と、あればリバースエンジニアリングされたコードベースの理解を、
形式的で構造化された要件に変換します。リクエストを明確さ、タイプ、scope、複雑さについて評価し、適切な
深度を決め、既に分かっていることを抽出し、6 つの次元にわたる完全性の分析を実行し、明確化の質問を生成し、
形式的な要件ドキュメントを生成します。

この stage は常に実行されますが、プロジェクトの複雑さに基づいてその深度を適応させます。明確で狭い scope には
minimal、中程度の scope には standard、大きな scope で大きな未知があるものには comprehensive です。

### Inputs

- brownfield なら、Stage 2.1 からの Reverse Engineering のアーティファクト（`aidlc/spaces/<active-space>/codekb/<repo>/`）
- `project-description` ユーティリティからの権威あるプロジェクト説明（監査の `Request` から決して再構築されない）
- それらの stage が実行された場合は、Ideation からの intent 記述と scope ドキュメント、Practices Discovery からのチームの practice

### Steps

1. **先行コンテキストを読み込む** -- brownfield なら: `aidlc/spaces/<active-space>/codekb/<repo>/` から RE のアーティファクトを読む。`project-description` でプロジェクト説明を読む。

2. **ユーザーのリクエストを分析する** -- リクエストを次について評価する:
   - **Clarity**: リクエストはどれだけよく定義されているか
   - **Type**: 新機能、拡張、refactoring、バグ修正、migration
   - **Scope**: 単一コンポーネント、複数コンポーネント、システム全体
   - **Complexity**: simple、standard、complex

3. **深度を決める** -- 複雑さの評価に基づいて:
   - **Minimal**: 明確なリクエスト、狭い scope、よく理解されたドメイン
   - **Standard**: 中程度の scope、いくつかの未知、複数のステークホルダー
   - **Comprehensive**: 大きな scope、大きな未知、複雑なドメイン

4. **現在の要件を評価する** -- ユーザーの入力から既に分かっていることを抽出して整理する。明示的な機能要件、暗黙の非機能要件、制約と assumption、ビジネスの文脈と目標である。

5. **完全性の分析** -- 6 つの次元にわたってカバレッジを評価する:
   1. 機能要件 -- コアな振る舞い、機能、ユースケース
   2. 非機能要件 -- 性能、セキュリティ、スケーラビリティ、信頼性、可観測性
   3. ユーザーシナリオ -- ユーザーのワークフロー、エッジケース、エラーシナリオ
   4. ビジネスの文脈 -- 目標、成功指標、ステークホルダー、制約
   5. 技術的な文脈 -- 統合点、プラットフォーム要件、技術の制約
   6. 品質属性 -- 保守性、テスト容易性、アクセシビリティ、使いやすさ

   各次元のギャップを特定する。Standard と Comprehensive の深度では、ユーザーシナリオの次元が product agent の `corner-checklist.md` で掃かれる。リクエストが指名する各コンポーネントが、それが触れるエッジ条件（空、欠落、部分的な失敗、1 つの事実の 2 つのコピー、など）と掛け合わされ、該当するすべての条件が、要件、理由付きの assumption、または out-of-scope の項目として `requirements.md` に着地する。corner が質問になるのは、それが agent が知り得ないユーザーの世界についての事実に依存するときだけである。Minimal の深度はチェックリストを読み込まない。

6. **明確化の質問を生成する** -- PROACTIVE: 要件が 6 つの次元すべてにわたって例外的に明確で完全でない限り、常に明確化の質問を生成する。`<record>/inception/requirements-analysis/requirements-analysis-questions.md` を `[Answer]:` タグ形式で作成する。A-E の選択肢（Claude Code では A-D）を持つ文脈に適した質問を含める。すべての通常の明確化の質問は、最終の選択肢として `X. Other (please specify)` で終わらなければならない。すべての `[Answer]:` タグは空のままにする。

   tri-mode の質問フローを提示する: Guide Me / Edit File / Chat。

7. **回答を集めて分析する** -- 質問ファイルを読み、すべての `[Answer]:` タグが埋まっているか確認する。空があれば、未回答の質問を AskUserQuestion で提示し、回答を書き戻す。部分的な回答で進まない。次を実行する:
   - 必須の曖昧さ検出: すべての応答を曖昧な言い回し（「mix of」、「not sure」、「depends」、「probably」、「maybe」）についてスキャンする
   - 回答間の矛盾チェック
   - 欠けた詳細の特定

8. **フォローアップの質問** -- 少しでも曖昧さ、あいまいさ、矛盾が見つかれば、その具体的な問題を狙ったフォローアップの質問を作る。進む前にすべての曖昧さを解決する。「迷ったら尋ねる。」

9. **Requirements を生成する** -- 次を含む `<record>/inception/requirements-analysis/requirements.md` を作成する:
    - intent 分析 -- ユーザーが達成しようとしていること（機能だけでなく目標）
    - 機能要件 -- 機能領域またはドメインで整理する。すべての要件に安定した `FR{n}` ID（例: `FR1`）、すべての sub-requirement に `FR{n}.{m}` ID（例: `FR1.2`）を与える
    - 非機能要件 -- 性能、セキュリティ、スケーラビリティ、信頼性、可観測性の目標。それぞれに安定した `NFR{n}` ID
    - 制約 -- 技術的、ビジネス的、組織的
    - Assumptions -- 根拠とともに文書化
    - Out of scope -- 明示的に除外される項目
    - Open questions -- 後の stage のために残る不確実性

10. **完了を準備する** -- requirements アーティファクトを検証する。`<record>/aidlc-state.md` を編集しない。engine が完了とルーティングを所有する。

11. **完了を提示し承認を求める** -- :mag: emoji と review パスを伴う完了メッセージを表示する。承認 gate には 2 つの変種がある:

    **実行 state で User Stories が SKIP に設定されている場合:** 3 選択肢 gate: Approve / Request Changes / Approve, and add User Stories next（現在 skip されている User Stories stage を含めて始める）。その選択で、`aidlc engine orchestrate next --add user-stories` を実行し、承認を記録する report を指名するそのステップに従う。チェックボックスを直接編集しない。承認を含まない User Stories を加えるリクエストは、同じ `next --add` で、gate がもう一度尋ねられる。

    **User Stories が SKIP に設定されていない場合:** 標準の 2 選択肢 gate: Approve / Request Changes。

### Outputs

すべてのアーティファクトが `<record>/inception/requirements-analysis/` に書かれます。

| File                                 | 内容                                                |
|--------------------------------------|---------------------------------------------------------|
| `requirements.md`                    | 形式的な要件: intent 分析、機能/非機能要件、制約、assumption、out-of-scope、open questions |
| `requirements-analysis-questions.md` | `[Answer]:` タグ付きの明確化の質問（入力アーティファクト） |
| `traceability.json`                  | `requirements.md` が定義する FR と NFR の ID。それが綴るとおりに綴られ、それぞれにその `kind`、sub-requirement にはそれが属する要件（`of`）が付く。後の stage がこの一覧からたどる |

### 承認 Gate

条件付きの gate フォーマット:

- **User Stories が skip される場合:** 3 選択肢 gate -- **Approve** / **Request Changes** / **Approve, and add User Stories next**
- **User Stories が skip されない場合:** 標準の 2 選択肢 gate -- **Approve** / **Request Changes**

### Notes

- これはワークフローで最も詳細な質問と回答の stage です。必須の曖昧さ検出を強制し、部分的またはあいまいな回答で進みません。
- 深度は複雑さに応じてスケールします。bugfix/poc には minimal、feature には standard、enterprise には comprehensive です。
- bugfix scope では、この stage は minimal の深度でバグの説明を捕らえます。
- infra scope では、この stage はインフラの要件を捕らえます。
- ここで生成される requirements ドキュメントは、User Stories（2.4）、Refined Mockups（2.5）、Domain Design（2.6）、Units Generation（2.7）、Contract Design（2.8）、Delivery Planning（2.9）が消費します。

---

## Stage 2.4: User Stories

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.4                                                                    |
| Condition        | CONDITIONAL -- ユーザー向けの機能、複数の persona、複雑なビジネスロジック、チーム横断の作業で実行 |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-design-agent, aidlc-developer-agent, aidlc-quality-agent               |
| Mode             | mob（collaborators がオフのときは lead のみ）                             |
| Completion Emoji | :books:                                                                |

### 目的

User Stories は、形式的な要件を、各機能の「誰が、何を、なぜ」を定義するユーザー中心の story に変換します。
この stage は 2 部構成に従います。PART 1 は明確化の質問を伴う story plan を作成し、PART 2 は実際の story と
persona を生成します。plan と story は、結合したレビューのために完了 gate で一緒に提示されます。

この stage は mob-elaboration のショーケース（mode: mob）です。Product Manager が lead し、design、developer、
quality の agent が、lead のドラフトに照らして独立した協力者として dispatch されます。盲検ラウンド、統合、
1 回の上限付き異議ラウンドで、その後 Product Leader が review します。aidlc-design-agent のユーザー体験の
視点は、upstream のリファレンスにない意図的な追加です。

### Inputs

- `<record>/inception/requirements-analysis/requirements.md`
- brownfield なら、Stage 2.1 からの RE アーティファクト（`aidlc/spaces/<active-space>/codekb/<repo>/`）

### Steps

1. **Lead Persona を読み込む** -- このステップは aidlc-product-agent の persona（`lead_persona`）を運ぶ。その知識を `.claude/knowledge/aidlc-product-agent/` から読む。support agent（design、developer、quality）は inline では読み込まれない。これは mob stage で、生成中に独立した協力者として dispatch される。

2. **User Stories が必要か検証する** -- user story がこのプロジェクトに価値を加えるか評価する:
   - **実行する条件**: ユーザー向けの機能、複数のユーザー persona、複雑なビジネスロジック、チーム横断の調整が必要
   - **skip する条件**: 純粋な refactoring、孤立したバグ修正、インフラのみ、developer tooling

   `<record>/inception/user-stories/user-stories-assessment.md` を作成し、次を文書化する: 判断（Execute または Skip）、根拠、考慮した要因、主要な価値領域（実行する場合）または代替のカバレッジ（skip する場合）。

   skip する場合、`aidlc-orchestrate.ts report --stage user-stories --result skipped --reason '<reason from the assessment>'` を呼ぶ。engine が `[S]` を記録し、アーティファクトや ensemble 証跡のチェックの前にルーティングする。

3. **先行コンテキストを読み込む** -- `<record>/inception/requirements-analysis/requirements.md` を読む。brownfield なら、`aidlc/spaces/<active-space>/codekb/<repo>/` から関連する RE アーティファクトを読む。

**PART 1: Planning**

4. **質問を伴う Story Plan を作成する** -- 次を含む `<record>/inception/user-stories/user-stories-questions.md` を作成する:
   - persona 開発のアプローチ（ユーザーは誰か、その目標は何か）
   - INVEST 基準（Independent、Negotiable、Valuable、Estimable、Small、Testable）を使う story フォーマット
   - MoSCoW 優先度（Must Have / Should Have / Could Have / Won't Have）を使う story の優先順位づけ。MVP の境界は Delivery Planning 中に形式的に決められる。story の優先度はその判断に情報を与える。
   - 分解アプローチの選択肢（機能、persona、ワークフロー、ドメイン領域、epic のいずれかで）
   - persona と story の粒度についてのユーザー入力のための、`[Answer]:` タグ形式を使う埋め込み質問

5. **回答を集める** -- stage-protocol.md のセクション 3 の質問フローに従って回答を集める（対話モードの選択を提示、回答を集める、ファイルに書き戻す）。

6. **回答を分析する** -- 必須の曖昧さ分析: すべての応答を曖昧な言い回し（「mix of」、「not sure」、「depends」、「probably」）についてスキャンする。矛盾を確認する。欠けた詳細を特定する。少しでも曖昧さが見つかればフォローアップの質問を作る。

7. **Plan を提示して生成する** -- story plan の要約（persona 数、story 数、分解アプローチ）を inline で提示する。その後直ちに PART 2 へ進む。ユーザーは、結合した出力（plan + 生成された story）を完了 gate でレビューして承認する。

   生成が完了する前にユーザーがフィードバックで割り込んだら、それを改訂リクエストとして扱い、生成を続ける前に plan を更新する。

**PART 2: Generation**

8. **Plan を実行する -- Mob を通して Stories と Personas を生成する**:

   **Lead ドラフト。** aidlc-product-agent がまず `<record>/inception/user-stories/personas.md` をドラフトする:
   - ユーザー persona の定義（名前、役割、目標、pain point、文脈）
   - persona の関係と優先度ランキング

   そして `<record>/inception/user-stories/stories.md`:
   - 標準フォーマットの user story: 「As a [persona], I want [goal], so that [benefit]」
   - 各 story の acceptance criteria
   - story の優先度（Must Have / Should Have / Could Have / Won't Have）
   - story の依存関係と関係
   - INVEST 準拠のメモ

   **相互に盲検の support 貢献。** aidlc-design-agent、aidlc-developer-agent、aidlc-quality-agent を、lead ドラフトに照らして 1 つの並列ラウンドで dispatch する。各ブリーフはドラフト、Q&A、requirements のパスを含むが、兄弟の貢献は含まない。各 support agent は、`<record>/inception/user-stories/contributions/<agent-slug>.md` 配下に自身の同一性を印したファイルを書く。

   **Lead の統合。** aidlc-product-agent が、完了 gate の前に、3 つの貢献すべてを `personas.md` と `stories.md` に統合する。判断は stage の途中で人間に行く。知識の争点は 1 回の上限付き異議ラウンドを得る。維持された異議は gate で引用される。

9. **完了を準備する** -- mob のアーティファクトと 3 つの協力者の貢献ファイルすべてを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

10. **完了を提示し承認を求める** -- :books: emoji、生成された persona と story の要約、review パスを伴う完了メッセージを表示する。標準の 2 選択肢の承認 gate: Approve（次の stage へ続く）/ Request Changes。

### Outputs

すべてのアーティファクトが `<record>/inception/user-stories/` に書かれます。

| File                           | 内容                                                     |
|--------------------------------|--------------------------------------------------------------|
| `stories.md`                   | acceptance criteria、優先度、依存関係、INVEST のメモを伴う user story |
| `personas.md`                  | ユーザー persona の定義、関係、優先度ランキング    |
| `user-stories-assessment.md`   | 根拠と考慮した要因を伴う execute/skip の判断   |
| `traceability.json`            | `requirements.md` のすべての `FR` と `NFR` の ID（sub-requirement を持つ要件はその `FR{n}.{m}` ID を通して）が story に対応づけられ（`OK`）、または指名された下流 stage とともに `Deferred`、根拠とともに `N/A` と印される。`traceability` sensor がチェックする |
| `user-stories-questions.md`    | `[Answer]:` タグを使う明確化の質問を伴う story plan（入力アーティファクト） |
| `contributions/aidlc-{design,developer,quality}-agent.md` | gate の前に lead が統合する、相互に盲検の support 貢献 |

### 承認 Gate

標準の 2 選択肢 gate: **Approve**（次の stage へ続く）/ **Request Changes**。

### Notes

- skip の条件: 純粋な refactoring、孤立したバグ修正、インフラのみ、developer tooling。
- 2 部構成（plan してから生成）により、story が書かれる前に、ユーザーが story の分解アプローチに影響できます。
- user story の優先度（MoSCoW）は MVP の境界に情報を与えますが、決定はしません。形式的な MVP の境界は、Delivery Planning（Stage 2.9）中に設定されます。
- `user-stories-assessment.md` アーティファクトは、stage が skip されるときも、根拠を文書化するために常に生成されます。
- collaborators がオンだと、3 つの同一性を印した貢献ファイルが必須の ensemble 証跡です。lead が 3 つすべてを統合するまで承認は拒否されます。lead のみの実行は何も負いません。
- ここで生成される story は、Refined Mockups（2.5）、Domain Design（2.6）、Units Generation（2.7）、Delivery Planning（2.9）、そして各 Unit の acceptance criteria をたどる Functional Design（3.1）が消費します。
- aidlc-design-agent の support が、story に UX の視点を加えます。

---

## Stage 2.5: Refined Mockups & UX Design

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.5                                                                    |
| Condition        | CONDITIONAL -- ユーザー向けの UI があり、Ideation で rough mockup が生成されたとき実行。API には interaction 図を refine する |
| Lead Agent       | aidlc-design-agent                                                           |
| Support Agents   | aidlc-product-agent（story に照らして検証）                              |
| Mode             | inline                                                                 |
| Completion Emoji | :art:                                                                  |

### 目的

Refined Mockups は、Ideation Stage 1.6 の rough なコンセプトワイヤフレームを、形式的な要件と user story に
基づいた中〜高忠実度の mockup へと進化させます。詳細なインタラクション仕様、design system のマッピング、
レスポンシブな振る舞いの定義、アクセシビリティ準拠のチェックリストを生成します。

非 UI の取り組み（API のみ、backend）では、この stage はインタラクション図を API developer experience の
仕様へ refine します。

Stage 1.6（Rough Mockups）が実行されなかったとき（classic、workshop など）、story と requirements から
refined mockup を設計します。

### Inputs

- あれば、Stage 1.6 からの rough mockup（`<record>/ideation/rough-mockups/`）
- Stage 2.4 からの user story（`<record>/inception/user-stories/`）
- Stage 2.3 からの requirements（`<record>/inception/requirements-analysis/`）

### Steps

1. **先行コンテキストを読み込む** -- `<record>/ideation/rough-mockups/`（あれば）から rough mockup を読む。`<record>/inception/user-stories/` から user story を読む。`<record>/inception/requirements-analysis/` から requirements を読む。

2. **明確化の質問を生成する** -- 次を扱う質問を持つ `<record>/inception/refined-mockups/refined-mockups-questions.md` を作成する:
   - 各 user story を UI でどう表現すべきか
   - 必要なインタラクションパターン（modal、inline 編集、wizard、progressive disclosure）
   - 各画面が扱わなければならない状態（loading、empty、error、success、partial）
   - 既存の design system / component library との整合
   - アクセシビリティ要件（WCAG レベル）
   - 必要なレスポンシブのブレークポイント
   - API には: developer experience の要件

   stage-protocol.md の質問フローに従う。

3. **回答を集めて分析する** -- 整合性のために、user story と requirements に照らして設計の判断を検証する。

4. **アーティファクトを生成する** -- 中〜高忠実度の mockup（user story/画面ごと）、インタラクション仕様ドキュメント、design system のマッピング、レスポンシブな振る舞いの仕様、アクセシビリティ準拠のチェックリストを作成する。非 UI の取り組みには、API developer experience の仕様を作成する。

5. **完了を準備する** -- refined-mockup のアーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

6. **完了を提示し承認を求める** -- :art: emoji を伴う完了メッセージを表示する。標準の承認 gate（Approve / Request Changes）。

### Outputs

すべてのアーティファクトが `<record>/inception/refined-mockups/` に書かれます。

| File                            | 内容                                                    |
|---------------------------------|-------------------------------------------------------------|
| `mockups.md`                    | user story/画面ごとの中〜高忠実度の mockup          |
| `interaction-spec.md`           | インタラクションパターン、状態管理、遷移          |
| `design-system-mapping.md`      | design system / component library へのコンポーネントマッピング       |
| `accessibility-checklist.md`    | WCAG 準拠のチェックリストと要件                   |
| `refined-mockups-questions.md`  | `[Answer]:` タグ付きの明確化の質問（入力アーティファクト）  |

### 承認 Gate

標準の 2 選択肢 gate: **Approve** / **Request Changes**。

### Notes

- ユーザー向けの UI で実行されます。API には、インタラクション図を API developer experience の仕様へ refine します。Rough Mockups が実行されなかったとき（classic、workshop）は、代わりに story と requirements から設計します。
- mvp scope では、この stage はプロジェクトに UI があるときだけ実行されます。
- ここで生成される mockup は、Domain Design（2.6）に送られ、最終的には UI コンポーネントのために Construction の Code Generation（3.5）に送られます。
- アクセシビリティのチェックリストは、Build and Test（3.6）に送られるテスト可能な基準を提供します。

---

## Stage 2.6: Domain Design

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.6                                                                    |
| Condition        | CONDITIONAL -- 新しいコンポーネントやサービスが必要なとき実行。既存コンポーネントの変更のみでは skip |
| Lead Agent       | aidlc-architect-agent                                                        |
| Support Agents   | aidlc-aws-platform-agent, aidlc-design-agent                                |
| Mode             | inline                                                                 |
| Completion Emoji | :building_construction:                                                |

### 目的

Domain Design は、システムの **論理的な構成ブロック**、つまりコードを書く対象のコンポーネントを特定します。
コンポーネントは、それ自身のビジネスロジック、エンティティ、ライフサイクルを持つ、境界づけられた
ソフトウェアの一片です（デプロイするインフラではなく、書くコード）。この stage は、各コンポーネントの
振る舞い、その依存関係と依存先、それが所有するエンティティ、そして各境界の根拠を捕らえます。デプロイの
トポロジー（それは Units Generation）や技術スタック / NFR パターン（後の stage）を決めることはありません。

aidlc-aws-platform-agent は managed-service の依存関係について支援の視点を提供し、aidlc-design-agent は
UI コンポーネントの構造に貢献します。

### Inputs

- `<record>/inception/requirements-analysis/requirements.md`
- `<record>/inception/user-stories/stories.md`（生成された場合）
- brownfield なら、Stage 2.1 からの RE アーティファクト（特に `architecture.md`、`component-inventory.md`、`dependencies.md`）

### Steps

1. **先行コンテキストを読み込む** -- requirements、user story（生成された場合）、RE アーティファクト（brownfield なら、特に architecture.md、component-inventory.md、dependencies.md）を読む。scope の文脈は `<record>/aidlc-state.md` から来る。

2. **質問を伴う Design Plan を作成する** -- 次を扱う、`[Answer]:` タグ形式を使う文脈に適した質問を持つ `<record>/inception/domain-design/domain-design-questions.md` を作成する:
   - コンポーネント境界の判断
   - アーキテクチャスタイルの好み（まだ決まっていなければ）
   - サービス間通信のパターン（sync 対 async、REST 対 gRPC 対 event）
   - データの所有とストレージの戦略
   - 既存コンポーネントとの統合アプローチ（brownfield）
   - UI コンポーネントの構造（ユーザー向けなら、UX デザイナーの視点に基づく）

3. **回答を集めて分析する** -- stage-protocol.md のセクション 3 の質問フローに従って回答を集める。必須の曖昧さ分析: 曖昧な言い回し、矛盾、欠けた詳細をスキャンする。少しでも曖昧さが見つかればフォローアップの質問を作る。進む前にすべての曖昧さを解決する。

4. **Component カタログを生成する** -- 単一の統合された `components.md`（下の Outputs 参照）を作成する。fenced な `yaml` カタログ（source of truth）と、派生した人間向けのビュー（mermaid 図 + summary/ownership/rationale のテーブル）である。

5. **完了を準備する** -- design アーティファクトを検証する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

6. **完了を提示し承認を求める** -- :building_construction: emoji、design アーティファクトの要約、強調された主要なアーキテクチャの判断、review パスを伴う完了メッセージを表示する。3 選択肢の承認 gate: Approve / Request Changes / Approve, and add Units Generation next（実行計画で skip されていた場合）。その選択は `aidlc engine orchestrate next --add units-generation` とそのステップ（承認を記録する report を指名する）を実行する。state のチェックボックスを直接編集することは決してない。

### Outputs

`<record>/inception/domain-design/` に書かれるアーティファクトです。

| File                              | 内容                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `components.md`                   | fenced な `yaml` コンポーネントカタログ（source of truth）: 各コンポーネントの `behaviour`、`responsibilities`、`depends_on`/`dependents`、`external_dependencies`、所有する `entities`（`identifier`、属性、コンポーネント間の `references` を伴う）。その後に派生した人間向けビュー: mermaid の Component Diagram、Component Summary、Entity Ownership、External Dependencies、Rationale のテーブル |
| `decisions.md`                    | ADR ログ。主要な設計判断とその根拠を捕らえる architecture decision record |
| `traceability.json`               | 各上流の `USx.y`（またはフォールバックの `FR`。sub-requirement を持つ要件はその `FR{n}.{m}` ID を通して）を、それを実現する `components.md` のコンポーネントまたはエンティティに対応づけるカバレッジテーブル。`traceability` sensor が検証する |

加えて、質問ファイルが入力として作成されます。

| File                                      | 内容                                        |
|-------------------------------------------|-------------------------------------------------|
| `domain-design-questions.md`         | `[Answer]:` タグ付きの design の質問          |

### 承認 Gate

特別な 3 選択肢 gate:

- **Approve** -- 次の stage へ続く
- **Request Changes** -- 改訂のフィードバックを提供する
- **Approve, and add Units Generation next** -- 承認し、現在 skip されている Units Generation stage（実行計画で skip されていた場合）を `aidlc engine orchestrate next --add units-generation` で含める

### Notes

- skip の条件: 変更が既存コンポーネントの変更のみで、新しいコンポーネントやサービスが不要。
- 境界の根拠（と Alternatives Rejected があれば）は `components.md` の Rationale セクションに捕らえられ、アーキテクチャの判断は `decisions.md`（ADR ログ）に記録されます。
- ここで生成される design アーティファクトは、Units Generation（2.7）の主要な入力で、Construction stage（Functional Design 3.1、Code Generation 3.5）に直接情報を与えます。
- brownfield プロジェクトでは、design は RE アーティファクトに文書化された既存コンポーネントとの統合を考慮しなければなりません。

---

## Stage 2.7: Units Generation

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.7                                                                    |
| Condition        | ALWAYS -- Stage 2.9 が Bolt の順序づけのために消費する依存 DAG を生成する。コンパイル済みの scope グリッドで 2.9 とともに動く |
| Lead Agent       | aidlc-architect-agent                                                        |
| Support Agents   | aidlc-delivery-agent                                                         |
| Mode             | inline                                                                 |
| Completion Emoji | :wrench:                                                               |

### 目的

Units Generation は、domain design を、Construction フェーズでフェーズ化された construction フローを駆動する
個別の Units of Work に分解します。各 Unit は、システムの独立に実装可能な一片（サービス、モジュール、
デプロイ可能なコンポーネント）を表します。この stage は、Construction が何を作るか決めるために使う
`unit-of-work.md` ファイル、Stage 2.9 が Bolt の順序づけのために消費する依存 DAG
（`unit-of-work-dependency.md`）、そしてすべての user story（story が生成されないときはすべての機能要件）が
Unit に割り当てられることを保証する story map を生成します。

**Stage 2.7 は依存 DAG（トポロジー）を生成します。Stage 2.9 はそれを通る経済的な経路（Bolt の順序）を
選びます。** 2.7 は実装順を推奨したり critical path を特定したりしてはなりません。それらは 2.9 の
economic-sequencing の判断です。

これは、Inception の設計作業と Construction の実装作業の間の、重要な橋渡しの stage です。ここで生成される
unit の定義、依存関係、story の対応づけが、Construction フェーズがどう実行されるかを直接制御します。

この stage は 2 部構成に従います。PART 1 は明確化の質問を伴う分解 plan を作成して plan の承認を得て、PART 2 は
実際の unit アーティファクトを生成します。

### Inputs

- Stage 2.6 からのコンポーネントカタログ（`<record>/inception/domain-design/components.md`）
- `<record>/inception/requirements-analysis/requirements.md`
- `<record>/inception/user-stories/stories.md`（生成された場合）

### Steps

**PART 1: Planning**

1. **先行コンテキストを読み込む** -- `<record>/inception/domain-design/` のすべてのアーティファクト（統合された `components.md` コンポーネントカタログと `decisions.md` ADR ログ）を読む。requirements を読む。user story を読む（生成された場合）。scope の文脈は `<record>/aidlc-state.md` から来る。

2. **質問を伴う分解 Plan を作成する** -- 次を扱う、`[Answer]:` タグ形式を使う質問を持つ `<record>/inception/units-generation/units-generation-questions.md` を作成する:
   - Unit 境界の戦略（サービス別、機能別、ドメイン別、デプロイターゲット別）
   - Unit の粒度の好み（粗粒度 対 細粒度）
   - 依存の順序づけの好み（厳密なトポロジカルのみ、または独立した Unit 間の並列を許す）
   - Unit 間の統合点と契約（API、共有データ、event）
   - デプロイモデル（モノリシックなデプロイ、独立したデプロイ、hybrid）

   注: 実装順の優先度（value-first、risk-first、walking-skeleton-first）について尋ねない。それらは Stage 2.9 Delivery Planning に属する economic-sequencing の判断である。

3. **回答を集めて分析する** -- stage-protocol.md のセクション 3 の質問フローに従って回答を集める。必須の曖昧さ分析: 曖昧な言い回し、矛盾、欠けた詳細をスキャンする。少しでも曖昧さが見つかればフォローアップの質問を作る。進む前にすべての曖昧さを解決する。

4. **Plan の承認を得る** -- AskUserQuestion で分解 plan をユーザーに提示する。アプローチ（unit 境界の戦略、推定 unit 数、依存構造）を要約する。選択肢: Approve Plan / Revise Plan。

**PART 2: Generation**

5. **Plan を実行する -- Unit アーティファクトを生成する** -- 承認された plan に基づいて、4 つの出力アーティファクト（下の Outputs 参照）を生成する。

6. **完了を準備する** -- unit アーティファクトを検証し、Construction のために unit 一覧を記録する。state を編集しない。gate の結果を `aidlc-orchestrate.ts` を通して報告する。

7. **完了を提示し承認を求める** -- :wrench: emoji、定義された unit・対応づけられた依存関係・割り当てられた story の要約、review パスを伴う完了メッセージを表示する。標準の 2 選択肢の承認 gate: Approve（engine が指名する次の stage へ続く）/ Request Changes。

### Outputs

4 つのアーティファクトすべてが `<record>/inception/units-generation/` に書かれます。

| File                            | 内容                                                    |
|---------------------------------|-------------------------------------------------------------|
| `unit-of-work.md`               | Unit の定義（名前、説明、境界）、責務、Unit ごとのデプロイモデル（standalone/shared/embedded）、相対的な複雑さの推定（S/M/L/XL）、unit kind（`service`/`spec`/`ui`/`packaging`/`library`。どの construction design アーティファクトが該当するかを駆動）、実装のメモと制約 |
| `unit-of-work-dependency.md`    | Unit 間の依存 DAG（有向エッジ、サイクルなし）、統合点（API/共有データ/event）、並列開発の機会（互いに依存のない Unit の集合）。トポロジーのみで、経済的な経路の選択（推奨順、critical path）は 2.9 の仕事。fenced な `yaml` のエッジブロックは DAG を映し、各 unit にオプションの `kind:` をタグ付けできる（[Runtime graph](../13-runtime-graph.md) の `bolt_dag.units[].kind` 参照） |
| `unit-of-work-story-map.md`     | 実装する Unit に対応づけられた上流項目ごとに 1 行。traceability の列挙と同じキー付け（`stories.md` が生成されるときは `USx.y` で、`USx.y` の行だけが読まれる。そうでなければ `FR`、sub-requirement を持つ要件はその `FR{n}.{m}` ID で、加えて scope がたどる NFR のオプションの `NFR` 行）。複数の Unit にまたがる横断的な行、各 Unit 内の実装順、カバレッジ検証（列挙されたすべての ID が割り当てられ、すべての Unit が行を持つ） |
| `traceability.json`             | 生成された Unit アーティファクトから Unit 集合を導出し、列挙されたすべての ID が宣言されたターゲット Unit に対応づけられることを検証するカバレッジテーブル。`traceability` sensor が検証する |

加えて、質問ファイルが入力として作成されます。

| File                                  | 内容                                          |
|---------------------------------------|---------------------------------------------------|
| `units-generation-questions.md`       | `[Answer]:` タグ付きの分解の質問     |

### 承認 Gate

標準の 2 選択肢 gate: **Approve**（engine が指名する次の stage へ続く）/ **Request Changes**。

### Notes

- **この stage の出力が Construction を駆動します。** `unit-of-work.md` ファイルが Unit を定義し、`unit-of-work-dependency.md` が Construction engine が walk する DAG です。新しくソースを生成する単独 Unit のワークフローは、検証された Unit checkpoint を伴う unit-major の serial 実行にデフォルトします。skeleton-on が適用されるとき、最初に解決された DAG Unit は、最小の動作する統合スライスを形成しなければなりません。明示的な stage-major の選択と、レガシー、design のみ、team が所有するパスは有効なままです。Bolt plan は実際の DAG を並べ替えられません。
- **2.7 は scope 内では ALWAYS です。** コンパイル済みの scope グリッドで、2.7 と 2.9 は一緒に動きます（scope ごとに両方 EXECUTE か両方 SKIP）。この stage に single-unit の skip 条件はありません。単独 Unit のフローも trivial な DAG を生成します。
- 2 部構成（plan してから生成）により、Unit が定義される前に、ユーザーが分解戦略を承認できます。ステップ 4 には、最終の完了 gate とは別の中間の承認 gate（Approve Plan / Revise Plan）があります。
- 依存 DAG は 2.9 の経済的な Bolt 順序づけに送られます。2.9 は、リスク、価値、学習で重み付けして DAG を通る経路を選びます。
- story map はトレーサビリティを提供します。すべての user story（story が生成されないときはすべての機能要件）が少なくとも 1 つの Unit に割り当てられ、すべての Unit が少なくとも 1 行を持たなければなりません。
- aidlc-delivery-agent は、実現性の検証と優先順位づけの入力を提供し、分解がデリバリーの観点から実践的であることを保証します。

---

## Stage 2.8: Contract Design

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.8                                                                    |
| Condition        | CONDITIONAL -- pin すべき契約があるとき実行: unit 間の境界、または public/external の API。両方ない単独の self-contained unit のみ skip |
| Lead Agent       | aidlc-architect-agent                                                        |
| Support Agents   | aidlc-aws-platform-agent                                                    |
| Mode             | inline                                                                 |
| Completion Emoji | :handshake:                                                            |

### 目的

Contract Design は、システムの **形式的な契約** を形式化し、unit が安定した合意済みの境界に照らして並列に
構築できるようにします。Units Generation（2.7）が unit とその依存 DAG を定義した後に実行され、2 種類の
契約を pin します。unit 間の境界（unit が統合する sync/async/shared-store の仕組み）と、システムが公開する
public または external の API です。下流の design と construction の stage が権威ある境界リファレンスとして
読む単一の `contract-summary.md` を生成します。

### Inputs

- `<record>/inception/units-generation/unit-of-work.md` と `unit-of-work-dependency.md`
- `<record>/inception/domain-design/components.md`
- `<record>/inception/requirements-analysis/requirements.md`

### Outputs

- `contract-summary.md` -- pin された unit 間と external の契約。

### Notes

- Contract Design は、unit 間の境界がなく public/external の API も公開しない単独の self-contained unit のみ skip されます。public API を公開する単独 unit は、やはりそれを実行します。
- `contract-summary` は、下流の Delivery Planning、Functional Design、NFR Requirements、NFR Design、Infrastructure Design、Code Generation が、オプションの共有契約の入力として消費します。
- 他の Inception の design stage と異なり、Contract Design は `traceability.json` を出力しません。要件のカバレッジではなく形式的な契約を所有するため、2.9 のフェーズ境界のトレーサビリティチェックには寄与しません。

---

## Stage 2.9: Delivery Planning

### Metadata

| フィールド            | 値                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.9                                                                    |
| Condition        | ALWAYS -- Inception の総仕上げの stage                                     |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Support Agents   | aidlc-architect-agent（build 順をアーキテクチャの依存関係に照らして検証） |
| Mode             | inline                                                                 |
| Completion Emoji | :calendar:                                                             |

### 目的

Delivery Planning は、Inception フェーズの総仕上げです。Bolt の順序、つまり Stage 2.7 が生成した Units of
Work を出荷すべき経済的な順を計画します。Stage 2.7 が分析的（Construction engine が実際に walk する依存
DAG）であるのに対し、Stage 2.9 は経済的です。リスク、価値、チームのキャパシティ、学習で重み付けして
DAG を通る経路を選びます。engine は Unit のグループ化や runtime の順のために `bolt-plan.md` を消費しません。

`stage-protocol.md` の正準の用語集に従うと、**Bolt** はこの stage（2.9）からの計画された Construction の
デリバリースライスです。Definition of Done、confidence 仮説、所有関係を持つ 1 つ以上の Unit です。
（Stage 3.6 build-and-test と 3.7 ci-pipeline は、Bolt ごとではなく、すべての Unit にわたって最後に一度
実行されます。）

経済的な価値は DAG から導けません。AI agent はトポロジカルソートができますが、どの Bolt が最速で市場仮説を
検証するか、どれが、コミットメントが重なる前に最も恐ろしい未知を表面化するかを決められません。それは、
この stage で捕らえられる人間の価値判断です。

この stage は、Construction へ遷移する前に、すべての Inception アーティファクトの整合性を検証するフェーズ
境界の検証チェックも実行します。

**重要な区別:** この stage は Bolt の順序づけを計画します。どの AI-DLC stage をどの深度で実行するかは決めません。
それは `/aidlc` skill の scope 選択が扱います。

### Inputs

すべての Inception フェーズのアーティファクト:

- Stage 2.3 からの requirements（`<record>/inception/requirements-analysis/`）
- Stage 2.4 からの user story（`<record>/inception/user-stories/`）
- Stage 2.6 からの domain design（`<record>/inception/domain-design/`）
- Stage 2.7 からの unit（`<record>/inception/units-generation/`）
- 生成された場合、Stage 2.8 からの contract summary（`<record>/inception/contract-design/contract-summary.md`）
- あれば、Stage 1.5 からの team formation（`<record>/ideation/team-formation/`）

### Steps

1. **先行コンテキストを読み込む** -- すべての Inception フェーズのアーティファクト（requirements、user story、domain design、unit、contract summary（生成された場合）、team formation（あれば））を読む。

2. **明確化の質問を生成する** -- 次を扱う質問を持つ `<record>/inception/delivery-planning/delivery-planning-questions.md` を作成する:
   - 順序づけのヒューリスティック: risk-first、value-first、walking-skeleton-first、または hybrid
   - 使うなら WSJF（Weighted Shortest Job First）のスコアリングモデルと重み付け
   - skeleton-on の適格なソース生成の単独作業には、最小の動作する統合スライスとしての最初の DAG Unit、その期待される demo、それを証明する実際のプロジェクトチェック
   - Units of Work の Bolt へのまとめ
   - 各 Bolt の Definition of Done
   - Bolt ごとの confidence 仮説 -- それを出荷すると何が証明されるか
   - mob から Bolt への割り当て（利用可能なら 1.5 のチームを参照。実行されなかったなら AI のみ）
   - 特定の Bolt を gate する外部依存関係（API、データ、承認）
   - 最も早く取り組む主要なリスク項目

   stage-protocol.md の質問フローに従う。

3. **回答を集めて分析する** -- 選ばれた Bolt の順序が 2.7 の依存 DAG を尊重することを検証する（aidlc-architect-agent の入力とともに）。トポロジカル順からの逸脱があれば、rationale アーティファクトで正当化できるよう指摘する。

4. **アーティファクトを生成する** -- `<record>/inception/delivery-planning/` に 4 つのアーティファクトを作成する:
   - `bolt-plan.md` -- Bolt の順序づけられた列。Bolt ごとの Units of Work、walking-skeleton のマーカー、Definition of Done、confidence 仮説、期待される demo。
   - `team-allocation.md` -- Bolt から mob への割り当て。チーム数 > 1 のときは Program Board の類似物。
   - `risk-and-sequencing-rationale.md` -- Bolt 順の背後の理由: WSJF スコア、risk-first の論拠、walking-skeleton-first の論拠、または value-first の論拠。
   - `external-dependency-map.md` -- 消費する Bolt に対応づけられた gate される項目（完全に AI 内で完結するときは軽量または空）。

5. **フェーズ境界の検証** -- Inception から Construction への検証チェックを実行する:
   - Requirements から Stories から Architecture への整合
   - すべての story が requirements にたどれる
   - Architecture がすべての story をカバーする
   - 結果を `<record>/verification/phase-check-inception.md` に書く

6. **完了を準備する** -- delivery と境界検証のアーティファクトを検証する。phase や stage の state を書かない。承認 report が Inception から Construction へのアトミックな遷移を所有する。記録された iteration の選択を保つ。適格な新しいソース生成の単独 Unit のワークフローは unit-major で serial で始まる。明示的な swarm の選択は、まず stage-major、その後 `state set-construction-execution swarm` を必要とする。承認モードは別個の判断である。skeleton-on が適用されるとき、最初の統合された Unit を確認する。checkpoint が有効な作業には、スキャンから実際のプロジェクトチェックを提案し、正確なコマンドと **Approve** / **Request Changes** を伴う **Use this command to verify each completed Unit?** を見せる。コマンドを提示する前に、ハーネスのファイル書き込みツール（Write/edit）で `<record>/verification-command.txt` にそれを書く。シェルの `echo` や heredoc は決して使わない。リポジトリ由来のコマンドテキストは、置換が承認の前に実行され得るシェル行に決して差し込まない。`log decision` と `log answer` の両方が `--checkpoint verification-command --command-file verification-command.txt` を取り、実行されるセッションを見つける。尋ねる前に decision を記録し、人間の **Approve** / **Request Changes** の返信を、そのチャットで、またはそれが最新に尋ねられた質問である間は新しいチャットで待つ。同じ stage/checkpoint/command で回答を記録する。**Approve** だけが receipt を認可する。無関係な返信、**Request Changes**、別の質問への返信はしない。人間が選んだのでない限り `--details "Approve"` を決して書かない。それがあって初めて `state set-construction-verification-command --command-file verification-command.txt` を実行する。**Request Changes** は別のコマンドを提案することを意味する。receipt は state フィールドより先でなければならない。汎用の `state set` や自動承認を決して使わない。このコマンドはすべての Unit/batch の checkpoint で再利用され、変更には新しい receipt が必要である。実行可能なチェックがまだ存在しない（greenfield）なら、人間は先送りできる。最初の checkpoint がその後、検証の前に尋ねる。[正確な記録コマンド](../../guide/12-cli-commands.md#construction-verification-command-record-human-authorization) を参照。誰が Unit を作るかはこの stage の質問ではない。2 つ以上の Unit があると、engine はこの stage の承認の後、Construction への最初のステップで一度それを尋ねる（[Construction Execution](../03-orchestrator.md#construction-execution) 参照）。

7. **完了を提示し承認を求める** -- :calendar: emoji を伴う完了メッセージを表示する。承認 gate: Approve（Construction へ進む）/ Request Changes。ユーザーはこの gate で stage の包含/除外をオーバーライドできる。

### Outputs

すべてのアーティファクトが `<record>/inception/delivery-planning/` に書かれます。

| File                                  | 内容                                                    |
|---------------------------------------|-------------------------------------------------------------|
| `bolt-plan.md`                        | 順序づけられた Bolt の列。Bolt ごとの Units of Work、walking-skeleton のマーカー、Definition of Done、confidence 仮説、期待される demo |
| `team-allocation.md`                  | Bolt から mob への割り当て。チーム数 > 1 のときは Program Board の類似物。1.5 が実行されなかったときは AI のみの割り当て |
| `risk-and-sequencing-rationale.md`    | Bolt の順序づけに対する WSJF / risk-first / walking-skeleton-first / value-first の正当化 |
| `external-dependency-map.md`          | gate される項目（外部 API、データの利用可能性、承認のリードタイム、外部チームの引き継ぎ）を消費する Bolt に対応づけたもの |
| `delivery-planning-questions.md`      | `[Answer]:` タグ付きの明確化の質問（入力アーティファクト） |

フェーズ境界の検証の出力:

| File                                            | 内容                                    |
|-------------------------------------------------|---------------------------------------------|
| `<record>/verification/phase-check-inception.md` | Inception から Construction へのトレーサビリティチェックの結果 |

### 承認 Gate

標準の 2 選択肢 gate: **Approve**（Construction へ進む）/ **Request Changes**。ユーザーはこの gate で stage の
包含/除外をオーバーライドできます。

### Notes

- **フェーズ境界の stage。** これは 3 つのフェーズ境界 stage の 2 番目です（1.7 の後、3.7 の前）。検証チェックは Requirements から Stories から Architecture への整合を検証します。
- **経済的順序づけ 対 トポロジカル順序づけ。** Stage 2.7 は依存 DAG を生成します（トポロジカル順は記述的な幾何として導かれます）。Stage 2.9 は、人間の価値判断で重み付けして、その DAG を通る経路を選びます。計画の rationale はデリバリーのグループ化を提案できますが、実行は依然として実際の DAG を尊重します。最初の Unit が必要な統合 skeleton を提供できないとき、Construction の前に分解を見直します。`bolt-plan.md` のマーカーを動かしても、engine が最初に実行する Unit は変わりません。
- **Bolt ≠ sprint ≠ MMF。** 正準の用語集に従うと、Bolt は 2.9 からの計画された Construction のデリバリースライスです。Definition of Done、confidence 仮説、所有関係を持つ 1 つ以上の Unit です。Stage 3.6（Build and Test）と 3.7（CI Pipeline）は、すべての Bolt の後に一度実行されます。順序づけのヒューリスティック（walking skeleton、WSJF）は Bolt の順に適用されます。Bolt が何かを再定義しません。
- **upstream からの意図的な逸脱。** upstream のリファレンスはこの stage を「Workflow Planning」と呼び、純粋な stage セレクタとして扱います。この実装（「Delivery Planning」に改名）は、Bolt の順序づけ、team の割り当て、リスクの rationale を加えます。
- bolt plan は confidence を築く順序を定義します。各 Bolt は、定義された Units of Work、Definition of Done、confidence 仮説を持ちます。
- aidlc-architect-agent は、提案された Bolt の順序が、コンポーネントカタログ（`components.md`）と unit-of-work-dependency アーティファクトで定義された依存関係を尊重することを検証します。
- team の割り当ては、存在すれば Team Formation のアーティファクト（Stage 1.5）から引きます。1.5 が SKIP（mvp、classic、workshop）のときは、すべての Bolt が aidlc-developer-agent（AI）によって実行されます。

---

## フェーズの要約

### 主要な出力

Inception フェーズは、Construction と Operation へ引き継がれる次の主要な出力を生成します。

1. **Reverse Engineering アーティファクト**（2.1）-- `aidlc/spaces/<active-space>/codekb/<repo>/` のリポジトリごとの 9 つのアーティファクト。既存のコードベースを文書化します。business overview、architecture、code structure、API documentation、component inventory、technology stack、dependencies、code quality assessment、timestamp です。（brownfield プロジェクトのみ。）
2. **Requirements ドキュメント**（2.3）-- 形式的な要件: 機能、非機能、制約、assumption、out-of-scope、open questions。
3. **User Stories と Personas**（2.4）-- acceptance criteria、優先度、依存関係を伴う user story。ユーザー persona の定義。（該当する場合。）
4. **Refined Mockups**（2.5）-- 中〜高忠実度の mockup、インタラクション仕様、design system のマッピング、アクセシビリティのチェックリスト。（該当する場合。）
5. **Domain Design**（2.6）-- 統合された `components.md` カタログ（各コンポーネントの振る舞い、責務、依存関係、外部依存関係、所有するエンティティ）と `decisions.md` ADR ログ。（該当する場合。）
6. **Units of Work**（2.7）-- 境界と複雑さの推定を伴う unit の定義、build 順を伴う unit 依存マトリクス、story から unit への対応づけ。（該当する場合。）`unit-of-work-dependency.md` は、Construction engine が Unit のグループ化と runtime batch 順のために読むアーティファクトです。
7. **Contract Summary**（2.8）-- pin された unit 間と public/external API の契約（`contract-summary.md`）。（pin すべき契約があるとき。）
8. **Delivery Plan**（2.9）-- Bolt plan、build 順、依存マトリクス、team の割り当て。承認された計画の内容（経済的な順序、複数 Unit のグループ化、DoD、confidence 仮説、所有関係）であり、runtime の walk のソースではありません。
9. **Phase Boundary Verification**（2.9）-- `<record>/verification/phase-check-inception.md` に書かれる Inception から Construction へのトレーサビリティチェック。

### Construction への hand-off

Stage 2.9 での承認時、フレームワークは Construction フェーズへ遷移します。`bolt-plan.md` は承認された計画の
アーティファクトのままです。経済的な順序、複数 Unit の Bolt グループ化、Definition of Done、confidence 仮説、
所有関係です。engine は Unit のグループ化や walk 順のためにそれを消費 **しません**。runtime の batch は
`unit-of-work-dependency.md`（2.7）から計算されます。

新しいソース生成の単独 Unit のワークフローでは、デフォルトは **検証された checkpoint を伴う unit-major の
serial 実行** です。各 Unit は、次の前にその該当する unit ごとの stage を終えます。skeleton-on では、最初の
DAG Unit は、stage-major が選ばれていても、後の Unit が始まる前に、動作する統合スライスを生成し、記録され
人間が認可した端から端までの検証コマンドを通り、人間の skeleton 承認を受けなければなりません。レガシーの
最初の stage gate は stage の review であり、その結果の証跡ではありません。verifier は proof ファイルの横に
ツールが所有する `CHECKPOINT_VERIFICATION_RECORDED` receipt を記録し、承認はその receipt を必要とします。
手書きの proof ファイルは Unit を検証できません。proof ファイルがまったくないチェックアウト（まっさらな
clone、別のマシン）では、その receipt が、証跡が変わっていない承認済みの Unit の proof の代わりになるため、
何も再実行されません。

適格な skeleton-off のフローは、Construction 入場時に **Continue automatically** / **Review each checkpoint** を
提示します。skeleton-on は、本物の skeleton checkpoint の後に提示します。既知の選択は繰り返されません。Plan
Approval、verification command の選択、有効な summary confirmation は、どちらの選択の下でも human-required の
ままです。summary confirmation は `directive.ceremony.summary_confirmation === "on"` のときだけ適用されます。
明示的な stage-major/swarm の選択は、完了承認とは独立に並列実行を制御します。

checkpoint のない既存のワークフロー、design のみの作業、Unit なしのフロー、team が所有する gate は、その
既存の挙動を保ちます。明示的な iteration の選択を保ちます。該当するすべての Unit 作業の後、Build and Test と
オプションの CI Pipeline がソリューション全体にわたって一度実行されます。メタデータのルーティングと
completion-only の会計については Construction プロトコルを参照してください。

現在の Construction の walk については `docs/guide/04-phases-and-stages.md` を参照してください。

### 相互参照

- **Orchestrator**: `harness/claude/skills/aidlc/SKILL.md` -- ルーティングロジック、scope から stage への対応づけ、stage graph、Construction フローの定義
- **Stage Protocol**: `core/aidlc-common/protocols/stage-protocol.md` -- 承認 gate、質問フォーマット、完了メッセージ、§13 Learnings Ritual。フェーズ境界の検証は `stage-protocol-governance.md` §13 にあります。
- **Ideation Phase**: `docs/reference/04-stages/ideation.md` -- 前のフェーズのドキュメント
- **Construction Phase**: `docs/reference/04-stages/construction.md` -- 条件付きの checkpoint デフォルト、明示的な実行の選択、保たれたレガシーパス。`bolt-plan.md` は計画であり、runtime の walk のソースではありません

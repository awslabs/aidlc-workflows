# Code Generation 改訂設計 — BDD ダブルループによる E2E 統合

- **日付**: 2026-06-10
- **対象**: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`（増分改訂。2026-06-09 のサブエージェント駆動 TDD 構造の上に積む）
- **ステータス**: 設計合意済み / 実装プラン待ち
- **前提**: 本リポは個人 fork（poc3mod）。fork 元の評価器/CI-CD は回さない。
- **言語方針**: 本 spec は日本語。実装する `code-generation.md` 本体は英語（既存ルール群に合わせる）。

---

## 1. 背景と問題

前回改修（2026-06-09）でユニットレベルの TDD は機能した（テストコードのないファイルが減少）。しかし E2E テストに大きな乖離が残っている。実証は poc3-kms-approach-3-1 の運用結果（commit `4da4158`、`aidlc-docs/reviews/001-story-e2e-parity-review.md`）:

1. **E2E が後置きの単一タスク**。code-generation plan の最後尾に「E2E-1: 主要シナリオ」と1タスクあるだけで、内容は実装者の裁量。全実装が終わった後に書かれる（BDD の逆）。
2. **上流との乖離が構造的に発生**。INCEPTION の stories.md には Given/When/Then 形式の受け入れ基準（実質的な E2E テスト計画）があるのに、生成された E2E はそれを参照した保証がない。実例: 受け入れ基準 11 セットに対し E2E 7 シナリオ、パリティレビューで欠落 11 件・未文書化 1 件。
3. **カバレッジを見るゲートがない**。poc3 側の unit-e2e 拡張は「e2e_local が PASS したか」のみで、上流の受け入れ基準との整合は検証されない。乖離の発見は事後の手動パリティレビュー頼み。
4. **テスト環境の理解不足**。過去の Code Generation セッションは devcontainer / docker-compose / HTTPS などの実行環境を把握しないまま進み、E2E 実行段で躓くことが多かった。環境の理解が推測のまま検証されない。

## 2. 方針（採用アプローチ）

**BDD ダブルループ**を Code Generation に組み込む。外側ループ = 受け入れ基準から起こした E2E シナリオ（Red で開始）、内側ループ = 既存のサブエージェント駆動 TDD。最後に E2E を Green にしてリファクタリング。

中核は **@draft タグによる漸進的 Green 化**（ユーザ発案）:

- Part 2 冒頭で全 E2E シナリオを feature/steps として実体化し、全シナリオに `@draft` タグを付与して Red を記録する。
- 計画段階で各シナリオに **Green予定点**（そのシナリオが Green になるはずの最後の TDD タスク）を割り当てる。
- Green予定点のタスクが完了したら該当シナリオの `@draft` を外して非draftスイートを実行。Green なら以降は常時リグレッション網に入る。Red なら計画と実装の不整合をその場で処理する。

これにより (i) E2E 検証自体がシフトレフトされ、(ii) 一括 Green 化方式の弱点（不整合発見が末尾に集中）を回避し、(iii) アプリ未起動期間（greenfield 初回など）も「宣言Red」として自然に吸収できる。

## 3. 確定した意思決定

| # | 論点 | 決定 |
|---|------|------|
| D1 | スコープ | `code-generation.md` のみ改訂。上流（INCEPTION user-stories）は現状の G/W/T 形式をそのまま入力に使う。検証ゲート（unit-e2e 拡張）の Code Generation への移設は今後の別件 |
| D2 | Gherkin 言語 | キーワードは英語（`Feature`/`Scenario`/`Given`/`When`/`Then`/`And`）、ステップ内容は日本語。`# language: ja` は使わない |
| D3 | Red の定義 | 環境が起動できれば実行して「期待した理由での失敗」を観測（観測Red）。起動不能なら理由付きの「宣言Red」とし、最初の Green予定点到達時に必ず実行する |
| D4 | カバレッジ強度 | 全受け入れ基準のマッピング必須。「→ E2EシナリオID」または「→ 他層テスト + E2E除外理由」。除外と追加シナリオは GATE 1 でユーザ承認 |
| D5 | ループ構造 | ユニット一括で全シナリオ Red 化 → TDD → @draft 漸進解除による途中 Green 化 → 末尾で全 Green + リファクタ |
| D6 | シナリオ本文の確定場所 | **Part 1 で本文ごとロック**（`## Locked E2E Scenarios`）。GATE 1 の承認対象。Part 2 のサブエージェントは実体化と steps 実装のみ |
| D7 | @draft チェックのスコープ | 当該ユニットの feature ファイルに限定。過去インクリメントの @draft 残存はブロックしない（報告のみ） |
| D8 | テスト環境 | Part 1 に `## E2E Execution Environment` セクションを新設し人間レビュー対象とする。既存環境では計画中にベースライン実行（既存スイート Green の証拠）を必須化。検証済み事実と推測を区別して記載 |

## 4. スコープ（触る / 触らない）

**改訂する:**

- `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`（増分改訂・英語）

**触らない:**

- INCEPTION 規則（`inception/user-stories.md` ほか）— 受け入れ基準の書式は現状のまま
- `construction/build-and-test.md`、`aws-aidlc-rules/core-workflow.md`
- poc3-ai-dlc-extensions（unit-e2e ゲート）— ゲート強化・移設は今後の別件

## 5. Part 1（Planning）の変更

現行 Step 1〜7 に対し、Step 2（契約ロック）の後ろに新 Step を挿入して以降を繰り下げる。

### 新 Step 3: Lock E2E Scenarios（BDD シフトレフト）

- ユニットに割り当てられた全ストーリーの受け入れ基準（stories.md の G/W/T）から Gherkin シナリオ本文を起こし、計画の第2セクション `## Locked E2E Scenarios` として**本文ごと**収録する。
- Gherkin 規約: キーワード英語・内容日本語（D2）。セレクタは Automation Friendly Code Rules の `data-testid` を前提に書く。
- **全件マッピング表**: 受け入れ基準1件につき1行。「→ E2EシナリオID」または「→ 他層テスト（API/integration/unit）+ E2E除外理由」。他層担保とした基準の担保先テストは Step 5（タスク分解）のタスクに含めることを必須とする。ブラウザで観測できない基準（Cookie属性、Authorizer拒否、トークン非発行など）が他層担保の典型。
- 受け入れ基準が曖昧でシナリオ化できない場合は `[Answer]:` タグのブロッキング質問にする（勝手に補完して乖離を作らない）。
- 受け入れ基準に対応しないシナリオを追加する場合は「追加シナリオ（上流未文書化）」と明記する（上流へ反映するかは GATE 1 でユーザ判断）。
- **退化ケース**: ユニットにユーザ向けフローがなく全受け入れ基準が他層担保になる場合（内部リファクタ・ライブラリ等）、E2E シナリオはゼロで正当。マッピング表（全件他層 + 理由）は必須のまま、GATE 1 でその旨を承認する。この場合 Part 2 の Phase 0・Green予定点処理・E2E 関連の完了基準は N/A として扱い、GATE 2 の Coverage Summary に N/A の理由を記載する。

### 新 Step 4: E2E Execution Environment（環境のロックと検証）

計画に `## E2E Execution Environment` セクションを新設。

**必須項目（対象システムを問わない）:**

- E2E 実行コマンドと、何が起動するか（アプリ・DB・docker-compose 構成、devcontainer 内/外）
- **検証済み事実と推測の区別**: 既存環境（brownfield / 増分2以降）では、プランニング中に既存 E2E スイートを実際に1回実行し「環境が起動する・既存が Green」というベースライン証拠（実行コマンドと結果）を記録することを必須とする。greenfield 初回ユニットでは全項目を「推測」と明記し、環境構築をどのタスクで行うかを指す
- 計画の成立に関わる不明点（DB の起動方法が不明等）は `[Answer]:` ブロッキング質問にする

**該当時のみの項目（ユニットのインタフェース種別に応じて。該当しない項目は「N/A + 一行理由」と書く。空欄や推測での穴埋めは禁止）:**

- Web UI: ベースURL、HTTPS/証明書の扱い、ブラウザ実行の前提
- API: エンドポイントのベースURL、TLS の扱い
- CLI / バッチ: 起動方法、入出力の受け渡し（ファイル・標準入出力等）
- 認証が存在する場合: 認証の前提（ログイン済み状態の作り方）
- 永続化が存在する場合: シードデータの投入方法

### 旧 Step 4（タスク分解）への追記

- 各タスクに「このタスクが前進させる E2E シナリオ ID」を記載する。
- シナリオごとに **Green予定点**（そのシナリオが Green になるはずの最後のタスク）を確定し、マッピング表に `green-point: タスクID` として記録する。
- E2E の feature/steps 実体化は TDD タスクに含めない（Part 2 Phase 0 の仕事）。

### 旧 Step 5（セルフレビュー）への追記

- カバレッジ: 全受け入れ基準がマッピング表に存在するか。他層担保とした基準に対応するテストタスクが存在するか。
- 整合: 全シナリオに Green予定点があるか。Green予定点のタスク ID が実在するか。シナリオが依存するタスクより前に Green予定点が来ていないか。
- 規約: Gherkin キーワードが英語か。

### 旧 Step 7（GATE 1）への追記

- サマリに「受け入れ基準数 / E2E シナリオ数 / 他層担保数（理由付き）/ 追加シナリオ数」と環境セクションの要約（検証済み/推測の件数）を必ず含める。
- **E2E 除外・追加シナリオ・環境前提はユーザ承認の明示対象**。

## 6. Part 2（Generation）の変更

### 新 Phase 0: E2E オーサリング（タスクループ開始前）

フレッシュな **E2E オーサー SA** を1体ディスパッチ。渡すもの: `Locked E2E Scenarios` 全文、`E2E Execution Environment`、e2e ファイル構成、Gherkin 規約、関連する Locked Contracts（画面・ルート・data-testid 規約）。

SA の仕事:

1. ロック済み本文を**一字一句そのまま** feature ファイル化（言い換え・省略・追加は禁止。本文がコントラクト）
2. 全シナリオの steps を実装。セレクタは `data-testid` 命名規約（`{component}-{element-role}`）に従い、新たに決めた testid 名は報告する（オーケストレータが該当実装タスクのコンテキストに引き継ぐ）
3. 全シナリオに `@draft` タグを付与
4. 環境が起動できる場合: スイートを実行し、各シナリオが**期待した理由**（要素不在・アサーション失敗）で失敗することを確認 →「観測Red」。設定エラー・構文エラーは SA 自身の不具合として修正する。起動不能なら理由付きで「宣言Red」
5. コミットし、シナリオ別 Red ステータス表を報告

オーケストレータはマッピング表に Red 種別（観測/宣言）を記録する。

### タスクループへの追記（現 Step 5「Record Progress」に挿入）

タスク完了時、そのタスクが Green予定点のシナリオがあれば:

1. 該当シナリオの `@draft` を外し、**非draftスイート全体**を実行する（新規 Green 確認 + 既 Green のリグレッション検知を兼ねる）。実行はオーケストレータが直接コマンドで行い、出力の要約のみ文脈に保持する
2. **全部 Green** → マッピング表に Green 達成（タスク ID 付き）を記録して続行
3. **新規シナリオが Red のまま** → BDD 不整合として分岐:
   - (a) 実装漏れ → 実装 SA を再ディスパッチして即修正（spec レビュー再実施）
   - (b) steps の不具合 → steps のみ修正（ロック済みシナリオ本文の変更・アサーション弱体化は禁止）
   - (c) Green予定点の見積もり誤り → 後続タスクに再割り当て。理由を `audit.md` に記録し `@draft` を戻す
   - (d) ロック済みシナリオ自体が誤り → 契約変更としてユーザにエスカレーション（GATE 1 承認物の変更のため）
4. **既 Green シナリオが Red に転落** → リグレッション。次タスクに進む前に修正必須

宣言Red のままのシナリオは、最初の Green予定点到達時に必ず実行を試みる。環境がまだ起動不能ならブロッキング問題として解決する（(c) で先送りしない）。

### 末尾フェーズの拡張（現「最終レビュー SA」の前段に追加）

1. 当該ユニットの feature ファイルにおける `@draft` 残存ゼロを確認（残存 = 未到達の Green予定点。解消するまで GATE 2 に進めない）。過去ユニットの @draft 残存は報告のみでブロックしない（D7）
2. E2E 全スイート実行 → 全 Green 必須
3. **リファクタリングフェーズ**: リファクタ SA をディスパッチし、unit + E2E を Green に保ったまま整理。実行後に両スイートを再確認
4. 既存の最終レビュー SA に観点を追加: 当該ユニットの feature ファイルがロック済み本文と一致しているか（無断の弱体化・削除がないか）

### GATE 2 メッセージへの追記

「E2E Coverage Summary」セクションを必須化: 受け入れ基準数 / E2E シナリオ数（全 Green）/ 他層担保数（担保先タスク）/ 追加シナリオ数。

## 7. サブエージェントテンプレート

SUBAGENT PROMPT TEMPLATES に **E2E Author Template** を追加する。

```text
You are authoring the E2E test suite for: [unit name]

## Locked E2E Scenarios
[ロック済み Gherkin 本文を全文貼り付け — これが契約。言い換え・省略・追加は禁止]

## E2E Execution Environment
[計画の環境セクションを貼り付け — 実行コマンド、起動構成、ベースURL、シード、認証前提]

## Conventions
- Gherkin キーワードは英語、ステップ内容は日本語（feature 本文は上記ロック済みテキストをそのまま使う）
- セレクタは data-testid（{component}-{element-role}）。新たに必要になった testid 名は報告する
- 全シナリオに @draft タグを付与する

## Your job
1. ロック済み本文を一字一句そのまま feature ファイル化（配置先: [計画のファイル構成]）
2. 全シナリオの steps を実装
3. 環境が起動できる場合: スイートを実行し、各シナリオが「期待した理由」（要素不在/アサーション失敗）で
   失敗することを確認。設定・構文エラーは自分の不具合として修正する
   起動できない場合: 理由を記録（宣言Red）
4. コミットして報告

## Report format
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- シナリオ別 Red ステータス表（観測Red(理由) / 宣言Red(理由)）
- 新規に定義した data-testid 一覧
- 作成・変更ファイル
```

（実装時は英語で書く。）

## 8. Critical Rules への追記（新節「BDD Rules」）

- **E2E SCENARIOS ARE CONTRACTS**: feature ファイルはロック済み本文と一致させる。アサーションの弱体化・シナリオ削除は契約変更でありユーザ承認が必要
- **GREEN POINTS ARE CHECKPOINTS**: Green予定点でのスイート実行を省略しない。Red のままなら不整合分岐（a〜d）を処理するまで次タスクに進まない
- **DRAFT TAG DISCIPLINE**: `@draft` の付与は Phase 0、解除は Green予定点のみ。チェック対象は当該ユニットの feature ファイルに限定（過去ユニットの @draft はブロックしない・報告のみ）

## 9. Completion Criteria への追記

- 当該ユニットの全ロック済みシナリオが観測 Green
- 当該ユニットの feature ファイルに `@draft` 残存ゼロ
- feature ファイルがロック済み本文と一致
- E2E Coverage Summary を GATE 2 で提示済み

## 10. 追跡リスト（今回は触らない）

- unit-e2e 拡張（poc3-ai-dlc-extensions）のゲートを「PASS したか」から「受け入れ基準カバレッジを満たして PASS したか」へ強化し、Code Generation 側へ移設する（ユーザが今後予定）
- `build-and-test.md` の E2E 指示（`e2e-test-instructions.md`）と本改修の整合（Build & Test は前回改修から継続して保留領域）
- INCEPTION 側で受け入れ基準を automation-ready に分類する案（今回は見送り。code-gen 側のマッピング表で吸収）

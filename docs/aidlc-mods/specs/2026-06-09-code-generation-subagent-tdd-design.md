# Code Generation 改訂設計 — サブエージェント駆動 TDD オーケストレーション

- **日付**: 2026-06-09
- **対象**: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`（全面改訂）
- **ステータス**: 設計合意済み / 実装プラン待ち
- **前提**: 本リポは個人 fork（poc3mod）。fork 元の評価器(aidlc-evaluator)/CI-CD は回さない。必要になれば後から追加する。
- **言語方針**: 本 spec は日本語。ただし**実装する `code-generation.md` 本体は英語**で書く（既存ルール群・エージェント可読性に合わせる）。

---

## 1. 背景と問題

GitHub Copilot で AI-DLC を運用すると、Code Generation 工程が期待どおり動かない。直前工程までの設計は良いのに、コードに落ちる段で破綻する。調査で根本原因を3つ特定した。

1. **計画粒度が「レイヤ×ファイル」単位**。golden plan でも「13個の三角関数を1ファイルに追加」が1チェックボックス、「app.py作成＋全router登録＋エラーハンドラ＋health check」が1チェックボックス。superpowers は「失敗テスト1本→失敗確認→最小実装→成功確認→commit」の 2〜5分アクション単位。
2. **shift-left 不足（実体は shift-right）**。現行 `code-generation.md` の完了基準は「テストは生成するが、実行は Build & Test フェーズで」。全ユニットのコードを書き切ってから初めてテストが走る＝フィードバックループが極大。
3. **I/F・契約が「文脈の箇条書き」止まり**で、具体的・テスト可能な成果物として固定されない。だからコード化の段で抜け漏れが露呈する。

加えて、**全処理をメインセッションで実行するため、ユニットが育つと文脈が肥大**し品質が落ちる。

## 2. 方針（採用アプローチ）

**案2 = superpowers の3スキルを移植**する。ただし AI-DLC の殻を保つ。

- **オーケストレーションセッション（メイン）の責務 = AI-DLC の前/後工程インタフェースを守ること**。すなわち上流成果物の読込、2つの承認ゲート、audit.md 記録、aidlc-state.md 更新、標準完了メッセージ、拡張ルール注入、後続(Build & Test)への受け渡し。
- **その殻の内側で、使い捨てサブエージェント群が superpowers の中身を回す**: `writing-plans`（極小タスク分解）＋ `subagent-driven-development`（実装/spec/品質レビューの3SA）＋ `test-driven-development`（red-green-refactor）。
- メインは**コードを文脈に保持しない**（plan と契約だけ保持）＝文脈肥大を防ぐ。

## 3. 確定した意思決定

| # | 論点 | 決定 |
|---|------|------|
| D1 | スコープ | `code-generation.md` 全面改訂を中心に自己完結。上流(functional-design)の弱さは code-gen 側の契約ロックで救う |
| D2 | 実行機構 | サブエージェント前提で記述（IDE非依存制約は本 fork では緩める） |
| D3 | TDD 厳格度 | 完全 TDD（red-green-refactor、テストは code-gen 中に green まで） |
| D4 | IDE非依存宣言 | 3箇所**全削除**（AGENTS.md:137 / README.md:781 / CONTRIBUTING.md:17） |
| D5 | Build & Test | **今回は不触**。この改修がワークすると確認できてから着手する保留領域 |
| D6 | 契約成果物の置き場所 | **プランに埋め込む**（新規ファイル0）。`{unit}-code-generation-plan.md` の先頭セクション |
| D7 | 下流の陳腐化（human docs / 評価器 golden） | **今回は直さない**。評価器 golden は fork では不使用。human-doc 整合は §10 の追跡リストに記録し「必要なら後で」 |

## 4. スコープ（触る / 触らない）

**改訂する:**
- `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`（全面改訂・英語）

**編集する（3行削除）:**
- `AGENTS.md:137` — "Keep the core methodology IDE/agent/model agnostic"
- `README.md:781` — "**Agnostic**. The methodology works with any IDE, agent, or model. ..."
- `CONTRIBUTING.md:17` — "**Keep it agnostic**: ..."

**触らない:**
- `construction/functional-design.md`、`aws-aidlc-rules/core-workflow.md`、`construction/build-and-test.md`
- `core-workflow.md:14-20` の多IDEパス解決（機能本体なので残す。哲学文だけ消える）
- `scripts/aidlc-evaluator/`（fork では不使用）

## 5. アーキテクチャ

```text
┌─ code-generation.md = ORCHESTRATION SESSION（制御役・コードは文脈に保持しない）──┐
│                                                                                  │
│ [前工程 IN] 上流成果物読込: functional-design/{business-logic-model,             │
│   business-rules,domain-entities,frontend-components} / nfr-design /             │
│   infrastructure-design / application-design/{components,component-methods,      │
│   unit-of-work,unit-of-work-story-map} / aidlc-state.md(workspace root,proj type)│
│        │                                                                         │
│        ▼  PART 1 — PLANNING  〔port: writing-plans ＋ 契約ロック〕                │
│   1a 契約ロック: 上流から I/F を"具体値"で導出しプラン先頭に固定。曖昧点は        │
│      [Answer]: でブロッキング質問→解決まで先に進まない（audit 記録あり）         │
│   1b ファイル構造マッピング（1ファイル1責務）                                    │
│   1c 極小TDDタスク分解（各 = RED→fail確認→GREEN最小→pass確認→REFACTOR→commit）   │
│   1d self-review（placeholder禁止 / 型・signature整合 / 契約・story 網羅）        │
│        │  → {unit}-code-generation-plan.md（契約＋タスクを内包・単一ファイル）   │
│   〔GATE 1〕プラン承認（標準2択）＋ audit 記録                                    │
│        ▼  PART 2 — GENERATION  〔port: subagent-driven-development ＋ TDD〕       │
│   各タスク（人間は挟まず連続実行）:                                              │
│     ① 実装サブエージェント（使い捨て）: TDD で実装。制御役が full task text ＋    │
│        契約抜粋 ＋ 文脈 を渡す。質問は着手前に。status 4種を返す                  │
│     ② spec適合レビューSA:「報告を信じずコードを読んで」検証 → ✅まで往復          │
│     ③ 品質レビューSA: 1責務/テストは振る舞い検証/ファイル肥大 → ✅まで往復        │
│     ④ plan の [x] 即更新 ＋ aidlc-state 更新 ＋ task commit                       │
│   全タスク後: ユニット全体の最終レビューSA                                       │
│        │                                                                         │
│   〔GATE 2〕コード承認（標準2択）＋ audit 記録                                    │
│        ▼                                                                         │
│ [後工程 OUT] aidlc-state 完了更新 → 次ユニット / Build & Test。テストは既に green │
└──────────────────────────────────────────────────────────────────────────────┘
```

**設計原則**
- メインは `plan`（契約を含む）だけを文脈に保持。生成コードはサブエージェント側に閉じ込める。
- サブエージェントは使い捨て。メインの履歴を継がせず、必要な情報（タスク全文＋該当契約＋足場文脈）を制御役が構築して渡す。
- 人間が止まるのは GATE 1 / GATE 2 と、SA が `BLOCKED`/`NEEDS_CONTEXT` で制御役が解決できない時のみ。

## 6. 詳細設計

### 6.1 PART 1 — Planning（契約ロック＋極小TDDタスク化）

**Part 1 はオーケストレータが所有する工程**（計画は制御役の調整業務）。ただし上流成果物の読込は context-heavy なので、**使い捨ての「planner」サブエージェントに digest を委ね、返ってきた契約＋タスク列をオーケストレータが受け取り保持・self-review する**形を取れる（生の上流ファイルを制御役の文脈に溜めない）。最終的に plan を所有するのはオーケストレータ。

**6.1a 契約ロック（shift-left の核）**
- 上流成果物を全読し、**コードレベルの契約を具体値で**導出してプラン先頭セクション「## Locked Contracts」に書く:
  - メソッド/関数 signature（名前・引数と型・戻り型・raises/例外）
  - API エンドポイント schema（path・method・request/response の JSON 形・ステータスコード・エラー封筒）
  - ドメインエンティティのフィールドと型・制約
  - ユニット間/モジュール間インタフェース、依存契約
  - エラー契約（例外種別 ↔ レスポンスの対応）
- **曖昧・欠落は AI-DLC の `[Answer]:` タグでブロッキング質問**にし、解決まで 6.1c に進まない。これが「I/F の抜け漏れがコード化で露呈」を構造的に潰す箇所。質問・回答は audit.md に記録。

**6.1b ファイル構造マッピング**（writing-plans 由来）
- 作成/変更するファイルと各責務を先に確定（1ファイル1責務）。Brownfield は既存構造に従い in-place 修正前提。

**6.1c 極小 TDD タスク分解**（writing-plans ＋ TDD 由来）
- 各タスクは**1つの振る舞い**を対象に、次の超細粒度ステップで構成する:
  1. `[ ]` 失敗するテストを書く（実際のテストコードを記載。契約を参照）
  2. `[ ]` 実行して失敗を確認（コマンドと期待 FAIL を記載）
  3. `[ ]` 通すための最小実装（実コードを記載）
  4. `[ ]` 実行して成功を確認（コマンドと期待 PASS）
  5. `[ ]` 必要なら refactor（green 維持）
  6. `[ ]` commit
- placeholder 禁止: "TBD"/"適切なエラー処理を追加"/"上記同様" 等は**プラン失敗**として書かない。型・関数・メソッドは必ずどこかのタスクで定義。
- story traceability・「このプランが単一の真実源」表現は AI-DLC 流を維持。

**6.1d self-review**（writing-plans 由来）
- (1) 契約・story 網羅（各契約/各 story に対応タスクがあるか）、(2) placeholder スキャン、(3) 型/signature 整合（タスク間で名前・引数・戻り型が食い違わないか）。発見したら inline 修正。

**保存先**: `aidlc-docs/construction/plans/{unit}-code-generation-plan.md`（**単一ファイル**。契約＋タスクを内包）。
**GATE 1**: 標準2択完了メッセージでプラン承認を取得 → audit 記録。

### 6.2 PART 2 — Generation（subagent-driven-development の移植）

**ループ**（全タスクを連続実行、タスク間で人間に確認しない）:
1. **実装SA を dispatch**（使い捨て）。制御役がタスク全文＋該当契約抜粋＋足場文脈を渡す。SA は着手前に疑問を質問可。TDD（RED→GREEN→REFACTOR）で実装し、self-review し、commit し、status を返す。
2. **status 処理**: `DONE`→次へ / `DONE_WITH_CONCERNS`→懸念を読み必要なら対処 / `NEEDS_CONTEXT`→文脈補って再 dispatch / `BLOCKED`→(a)文脈不足なら補う (b)推論力不足なら上位モデルで再 dispatch (c)タスク過大なら分割 (d)プラン自体が誤りなら人間へエスカレーション。
3. **spec 適合レビューSA**（先）: 「報告を信じるな・コードを読んで検証せよ」。要求との過不足を file:line で指摘。✅まで実装SA が修正→再レビュー。
4. **品質レビューSA**（後）: 1責務/明確な I/F、テストが*振る舞い*を検証しているか（mock検証になっていないか）、ファイル肥大、プランのファイル構造遵守。✅まで往復。
5. **進捗更新**: plan の該当 `[ ]`→`[x]` を**即時**更新、対応 story を `[x]`、aidlc-state.md 更新、Brownfield は重複ファイル無しを確認。
6. 全タスク完了後、**ユニット全体の最終レビューSA** を1回。

**モデル選択**（subagent-driven-development 由来）: 機械的タスク（1-2ファイル・明確 spec）=安価モデル / 統合・判断=標準 / アーキ・レビュー=最上位。

**GATE 2**: 標準2択完了メッセージでコード承認 → audit 記録 → aidlc-state 完了。

### 6.3 埋め込むサブエージェント・プロンプト雛形

`code-generation.md` 内に、制御役が複製・記入して使う雛形を**インライン（fenced block）**で持つ（外部 superpowers ファイルは参照できないため）:
- **Implementer 雛形**: タスク全文 / 文脈 / 着手前質問の促し / TDD遵守 / コード整理(1責務) / 行き詰まり時のエスカレーション / self-review / status 4種の報告形式。
- **Spec reviewer 雛形**: 「報告を信用するな、コードを読め」/ 欠落・余剰・誤解の検出 / `✅` or `❌ file:line`。
- **Quality reviewer 雛形**: 強み / Issue(Critical・Important・Minor) / 1責務・テスト品質・ファイル肥大の追加観点 / 判定。
- 各雛形は `Task tool` 等の固有名を使わず「サブエージェントを dispatch」と一般化し、「Copilot / Claude Code ではそれぞれの subagent 機構に対応」と注記。

## 7. 守るべき不変条件（rewrite が満たすべき制約。追加編集は不要）

調査で判明した暗黙依存。これらを壊さないこと:

1. **"Part 1 (Planning) / Part 2 (Generation)" の名称維持** → `common/error-handling.md`(133-160)・`common/terminology.md` が参照。
2. **標準2択完了メッセージ ＋ NO EMERGENT BEHAVIOR** → `core-workflow.md:403,461`。3択メニュー等にしない。
3. **Plan-Level Checkbox Enforcement（完了即 [x]）** → `core-workflow.md:463-474`。タスク毎に維持。
4. **「Critical Rules / project type 別の構造パターン」節を温存** → `inception/workspace-detection.md:27`・`inception/units-generation.md` が「see code-generation.md」で参照。Greenfield/Brownfield・single/multi-unit のディレクトリ規約を残す。
5. **拡張の注入フックを Planning と Generation の両方に温存** → `extensions/testing/property-based/property-based-testing.md` が PBT-01〜10 を code-gen の両 Part に注入。security/resiliency baseline も該当時に適用。「有効な拡張ルールへの非準拠は blocking」という core の方針を維持。
6. **生成プランは construction/plans/ 配下の単一ファイル**（契約はその中に埋め込み）。
7. **Brownfield 修正規則**（in-place 修正、`ClassName_modified.java` 等を作らない、生成後に重複なしを確認）と **`data-testid` 自動化フレンドリー規則** を温存。
8. **audit.md は append-only**、全ユーザ入力と承認を ISO8601 で記録。**application code は workspace root、aidlc-docs/ には markdown のみ**。

## 8. 完了基準（変更後）

旧:「全コードとテストを生成（テスト実行は Build & Test で）」を廃し、以下に置換:

- 契約セクションに未解決ギャップが無い（全 `[Answer]:` 解決済み）。
- プランの全タスクが `[x]`。各タスクで**テストを実行し green を確認済み**（RED も目視済み）。
- 全 story が実装され追跡可能。
- 各タスクが commit 済み。
- 全ユニットの最終レビューSA を通過。
- 有効な拡張ルールの compliance サマリ提示済み。

## 9. リスクと緩和

| リスク | 緩和 |
|--------|------|
| `code-generation.md` が肥大（3プロトコル＋雛形3種を内包） | まずインラインで実装。長すぎれば将来 `construction/code-generation/` にヘルパー分割（今回はしない） |
| サブエージェント機構の挙動が IDE 間で差異 | 「dispatch」を一般化表現にし、Copilot/Claude Code 双方の subagent 機構に対応する注記を置く。単一セッションでも「タスク毎に文脈を作り直す」読み替えが効くよう記述 |
| Build & Test 不触ゆえユニットテストを二重実行 | 冗長だが無害。D5 のとおり、本改修がワークすると確認後に Build & Test を再定義 |
| 完全TDDの per-task commit | **必須で確定**（green 確認後に commit）。各 TDD タスクの最終ステップとして実行する |
| human docs の食い違い（WORKING-WITH-AIDLC 等） | §10 の追跡リストに記録。fork では当面許容 |

## 10. 今回やらない（追跡リスト・必要なら後で）

- `docs/WORKING-WITH-AIDLC.md`: Code Generation の承認フロー／プラン確認観点／Build & Test 節が陳腐化。
- `README.md`: "Agnostic" tenet 削除に伴い platform-setup 節の「なぜ多IDEか」が孤児化。
- `docs/GENERATED_DOCS_REFERENCE.md`: `{unit}-code-generation-plan.md` の中身（契約＋TDDタスク）記述更新。
- `construction/build-and-test.md`: テスト実行タイミングの整合（D5）。
- `core-workflow.md:14-20` 付近: 多IDEパス解決の「なぜ」コメント追記（任意）。
- 評価器 golden 再生成: **不要**（fork では評価器を使わない）。

## 11. 確定事項（spec レビューで解決済み）

- **per-task commit は必須**。完全TDD のとおり green 確認後に commit し、各 TDD タスクの最終ステップとして必ず実行する。
- spec の置き場所は `docs/aidlc-mods/specs/`（本リポで新設するディレクトリ）で確定。

---

## 次の工程
本 spec 承認後、`superpowers:writing-plans` で実装プラン（`code-generation.md` の英語全文を組み立てる bite-sized タスク列＋3行削除）に落とす。

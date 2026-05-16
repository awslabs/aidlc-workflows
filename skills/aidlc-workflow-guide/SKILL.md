---
name: aidlc-workflow-guide
description: |
  AI-DLC（AI Driven Development Life Cycle）の各フェーズで開発者をリアルタイムに支援する実作業コンパニオンスキル。
  要件定義・設計・実装・テスト・リファクタリングの全フェーズをカバーし、
  具体的な成果物生成・レビュー・品質チェックを行う。

  **必ず使うタイミング（即座に起動すること）**：
  - AI-DLCの各ステージで「何をすればいい？」と迷っているとき
  - requirements.md / user-stories.md / application-design.md / unit-of-work.md を作成・改善するとき
  - 要件定義の質問を生成・回答・整理するとき（Mob Elaboration）
  - アーキテクチャ設計・コンポーネント分解・Unit of Work定義を行うとき
  - CDK/IaCコードの設計・生成・レビューを行うとき（Mob Construction）
  - テスト戦略・テストケース・カバレッジを検討するとき
  - コードリファクタリング・技術的負債の解消を検討するとき
  - audit.md・aidlc-state.mdの品質をチェックしたいとき
  - 「要件定義」「設計」「実装」「テスト」「リファクタリング」「モブ」「エラボレーション」「コンストラクション」「Unit of Work」「Bolt」などのキーワードが出たとき

  このスキルはaidlc-specialistサブエージェント（ワークフロー管理担当）と連携し、
  開発者が今いるフェーズで最高の成果物を作れるよう直接サポートする。
---

# AI-DLC ワークフロー 開発者支援スキル

あなたはAI-DLCワークフローの各フェーズで開発者に寄り添う**実作業コンパニオン**です。
「何を作るか」を管理するaidlc-specialistとは異なり、「どうやって最高の成果物を作るか」をリアルタイムに支援します。

---

## まず現在のフェーズを特定する

開発者から作業依頼を受けたら、最初に**どのフェーズにいるか**を確認する:

```
フェーズ特定の質問（必要なら聞く）:
- 今、aidlc-docs/ の中で何のファイルを作ろうとしていますか？
- aidlc-state.md で現在どのステージが進行中ですか？
- 詰まっている部分はどこですか？
```

確認できたら、以下のガイドを読み込む:

| 現在のフェーズ | 読み込むガイド |
|--------------|-------------|
| 要件定義（Requirements Analysis / User Stories） | `references/requirements-phase.md` |
| 設計（Application Design / Units Generation） | `references/design-phase.md` |
| 実装（Code Generation / Infrastructure Design） | `references/implementation-phase.md` |
| テスト（Build and Test） | `references/testing-phase.md` |
| リファクタリング・品質改善 | `references/refactoring-phase.md` |
| フェーズ不明・ワークフロー全体の相談 | 以下の「AI-DLC全体像」セクションを参照 |

---

## AI-DLC 全体像

### 開発哲学: AIが実行し、人間が意思決定する

AI-DLCでは**AIと開発者が協働**する。役割分担は明確:

| 役割 | 担当 |
|------|------|
| **AIの役割** | 詳細作業の実行・成果物生成・質問提案・コード生成 |
| **開発者の役割** | ビジネス判断・技術決定の承認・成果物の検証・方向性の修正 |

### ワークフロー概要

```
🔵 INCEPTION（Mob Elaboration）
  ├── Workspace Detection    → プロジェクト種別判定
  ├── Reverse Engineering    → 既存コード分析（Brownfield）
  ├── Requirements Analysis  → 要件文書化 ← ここが書類審査の核心
  ├── User Stories           → ペルソナ・ストーリー定義
  ├── Workflow Planning      → 実行計画策定
  ├── Application Design     → コンポーネント・API設計
  └── Units Generation       → Unit of Work 分解

🟢 CONSTRUCTION（Mob Construction）
  └── [Unit単位でループ]
      ├── Functional Design      → ドメインモデル・ビジネスロジック
      ├── NFR Requirements/Design → 性能・セキュリティ設計
      ├── Infrastructure Design  → AWSリソース・デプロイ設計
      ├── Code Generation        → 実装コード・テスト生成
      └── Build and Test         → ビルド・テスト手順

🟡 OPERATIONS（プレースホルダー）
```

### ボルト（Bolt）とは

AI-DLCでは従来の「スプリント（週単位）」を**ボルト（時間〜日単位）**に置き換える:
- ボルト内でAIが成果物を高速生成
- チームがリアルタイムで検証・修正（Mob Elaboration / Mob Construction）
- 承認後すぐ次のボルトへ

---

## 各フェーズの支援モード

### 🔵 Inception フェーズ支援

**Mob Elaboration（集合知による要件精緻化）のファシリテート**:
1. AIが要件の質問を生成 → 開発者・チームが議論して回答
2. 回答を受けてAIが要件文書を生成
3. チームが検証・承認

詳細は `references/requirements-phase.md` と `references/design-phase.md` を参照。

### 🟢 Construction フェーズ支援

**Mob Construction（集合知による実装精緻化）のファシリテート**:
1. AIがコード生成計画を提示 → 開発者が確認・修正
2. 承認済み計画に従ってAIがコードを生成
3. 開発者がレビュー・テスト確認

詳細は `references/implementation-phase.md` と `references/testing-phase.md` を参照。

---

## 成果物品質チェックリスト（全フェーズ共通）

どのフェーズでも成果物を作成後、以下を確認する:

**ドキュメント品質**
- [ ] Mermaidダイアグラムの構文エラーがないか
- [ ] 日本語/英語の表記が統一されているか
- [ ] リンク・パスが正確か
- [ ] 特殊文字が適切にエスケープされているか

**AI-DLC準拠**
- [ ] aidlc-state.md が最新の状態を反映しているか
- [ ] audit.md にユーザーの完全な生テキストが記録されているか（要約不可）
- [ ] 成果物が `aidlc-docs/` 配下の正しいパスに配置されているか
- [ ] アプリコードが `aidlc-docs/` 外に配置されているか

**ハッカソン審査基準**（AWS Summit Japan 2026参加の場合）
→ `aws-summit-hackathon-reviewer` スキルを呼び出してチェック

---

## 他スキル・エージェントとの連携

| 作業 | 連携先 |
|------|--------|
| AWSアーキテクチャ・CDK設計 | `aws-specialist` エージェント or `aws-cdk-architect` スキル |
| アーキテクチャ図生成 | `cdk-aws-diagram` or `deploy-on-aws:aws-architecture-diagram` スキル |
| ハッカソン審査基準チェック | `aws-summit-hackathon-reviewer` スキル |
| UI/フロントエンド設計 | `apple-style-ui-designer` エージェント |
| セキュリティレビュー | `security-review` スキル |
| コードレビュー | `coderabbit:code-review` スキル |
| ワークフロー状態管理 | `aidlc-specialist` エージェント |

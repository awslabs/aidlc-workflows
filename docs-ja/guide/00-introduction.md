# はじめに

> [AI-DLC ドキュメント](../README.md) の一部 · **ユーザーガイド** · [ハーネスエンジニアガイド](../harness-engineering/00-overview.md) · [開発者リファレンス](../reference/00-overview.md)

## AI-DLC とは

AI-DLC（AI-Driven Development Life Cycle、AI 駆動開発ライフサイクル）は、AI の支援を受けた
ソフトウェア開発を、繰り返せて追跡できるフェーズに整える方法論です。もとは
[AWS の AI-DLC 方法論](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)
から生まれました。このリポジトリは、それを一つのハーネスに依らないコアからそのまま実装しているので、
あなたがすでに使っている CLI ハーネスの中で動きます。いまは Claude Code、Kiro CLI、Kiro IDE、
Codex CLI、Cursor、opencode、GitHub Copilot です。このガイドはハーネスに依りません。ハーネスで
違う細部があるときは、その旨を書き、あなたのハーネスの章を案内します（[ほかのハーネスで動かす](harnesses/README.md)
を見てください）。例は、特に断りがなければ Claude Code で示します。

次の一つのコマンドで呼び出します:

```
/aidlc Build a REST API for inventory management
```

すると AI-DLC が、整えられたワークフローに沿って進めます。あなたの意図をとらえるところから、
要件、設計、実装、テスト、デプロイまでを案内しながら、どの判断の場面でもあなたが舵を握ったままに
します。

## 考え方: 小さなモブ、広く見るエージェント

狭い専門家を何十人も並べる（この進め方はウォーターフォールの引き継ぎの連鎖を作り直してしまいます）
のではなく、AI-DLC は **広く対応できる 11 のエージェント** を使います。各エージェントは、
複数のステージとフェーズにまたがって参加します。各エージェントがステージをまたいで文脈を持ち運ぶので、
引き継ぎがなくなり、調整の手間が減ります。

これは、うまくいく人のチームの働き方と同じです。3〜5 人のモブが機能一つを丸ごと担い、
それぞれが一つの狭い専門にとどまらず、広い技能を持ち寄ります。

## オーケストレーターの仕組み

中心で、AI-DLC はシンプルなループを回します。決定的な **エンジン** が次に何をするかを決め、
**コンダクター**（`/aidlc` セッション、`SKILL.md`）がそれを実行し、次の一手をエンジンに尋ねます。
このループの中で、フレームワークは次を行います。

1. **ステージファイルを読む** — 5 フェーズにわたる 33 のステージ定義。それぞれが入力、手順、
   出力、担当のリードエージェントを定めています
2. **エージェントのペルソナを読み込む** — 専門知識を持つドメインの視点（アーキテクト、デベロッパー、
   プロダクトマネージャーなど）を立ち上げます
3. **状態と監査を管理する** — 進み具合を `aidlc-state.md` で追い、追跡できるように、すべての判断を
   intent の `audit/` シャードに記録します
4. **ステージのトポロジーに応じて委任する** — 目的を絞った自律作業や複数エージェントの協働のために、
   サブエージェントをハブアンドスポーク、パイプライン、モブとして割り当てます
5. **承認ゲートを示す**: Ideation 以降は各ステージのあとに、あなたがレビューして承認してから
   ワークフローが進みます（Construction では、日常のチェックポイントで止めずに通すことも選べます）

エンジンは経路（次はどのステージか、どのスコープか、いつ止めるか）を持ち、コンダクターは実行の質
（ステージをうまく進める、良い問いを立てる、判断をあなたに示す）を持ちます。ほとんどのステージは
**インライン** で動きます。コンダクターがエージェントの視点をまとい、会話の中であなたと直接
作業します。4 つのステージは割り当て型のトポロジーを使います。Practices Discovery と Code Generation
は `subagent` ハブとして、Reverse Engineering は `pipeline` として、User Stories は `mob` として
動きます。全体のトポロジーは、インライン 29 / サブエージェント 2 / パイプライン 1 / モブ 1 です。
これらを支えるエージェントは、協力者がオンのときに参加します（既定でオンにするのは `enterprise`
だけです）。そうでなければ、これらのステージはリードエージェント 1 人で動き、Reverse Engineering の
パイプラインは 2 つのつながりが 1 つになります。アーキテクチャの全体は、開発者リファレンスの
[エンジンとスキルシステム](../reference/17-skill-system.md) を見てください。

## このガイドの対象

このガイドは、ソフトウェアを作るために AI-DLC を **使う** すべての人向けです。

- **新しい利用者** — [はじめかた](01-getting-started.md) から始め、次に
  [ガイド付きオンボーディングの手引き](onboarding.md)、[ワークフロープロファイル](workflow-profiles.md)、
  [最初のワークフロー](02-your-first-workflow.md)、[スペースと intent](03-spaces-and-intents.md) へ
- **ふだんの利用者** — [CLI コマンド](12-cli-commands.md)、[スコープ、深さ、テスト戦略](05-scopes-and-depth.md)、
  [困ったとき](15-troubleshooting.md) を参照
- **チームリード** — AI-DLC をチームの基準に合わせるには、[ナレッジ](08-knowledge.md) と
  [ルールと学習ループ](09-rules-and-the-learning-loop.md) を見てください

AI-DLC の *ふるまい方* を作り変える（ステージやエージェントを足す、スコープを定める、ルールや
センサーを書く、チームのナレッジを足す。どれも設定だけで、コードは書きません）には、
[ハーネスエンジニアガイド](../harness-engineering/00-overview.md) を見てください。AI-DLC の
コードベースそのものを変えるには、[開発者リファレンス](../reference/00-overview.md) を見てください。

## 主な数字

| 項目 | 値 |
|--------|-------|
| フェーズ | 5（Initialization、Ideation、Inception、Construction、Operation） |
| ステージ | 33 |
| エージェント | 合計 14: ドメイン専門家 11、レビュアー 2、コンポーザー |
| スコープ | 11（enterprise から express、それに workshop）+ あなたの言葉からエージェントが提案するプラン |
| 深さのレベル | 3（Minimal、Standard、Comprehensive） |
| テスト戦略のレベル | 3（Minimal、Standard、Comprehensive） |
| 監査イベントの種類 | 132 |

## ガイドの地図

| 章 | 学べること |
|---------|------------------|
| [はじめかた](01-getting-started.md) | 前提、インストール、最初の健康診断 |
| [オンボーディング: ガイド付きの最初の一週間](onboarding.md) | 考え方の全体像と、初めてのチーム向けの 5 回の実行 |
| [ワークフロープロファイル](workflow-profiles.md) | Classic、Express、そのほかのワークフローの選び方 |
| [最初のワークフロー](02-your-first-workflow.md) | 一通りの実行を注釈つきで追う |
| [ビジョンドキュメントを書く](writing-inputs/vision-document-guide.md) と [技術環境ドキュメントを書く](writing-inputs/technical-environment-guide.md) | 大きめの作業やワークショップの前に書く 2 つのメモ |
| [スペースと intent](03-spaces-and-intents.md) | ワークスペースの構成。スペースと intent をまたいで多くの作業を進める |
| [フェーズとステージ](04-phases-and-stages.md) | 5 つのフェーズと 33 のステージ |
| [スコープ、深さ、テスト戦略](05-scopes-and-depth.md) | スコープ・深さ・テスト戦略の選び方と上書き |
| [エージェント](06-agents.md) | 14 エージェントの顔ぶれ: ドメイン専門家 11、レビュアー 2、コンポーザー |
| [エージェント詳説](agents/README.md) | エージェントごとの参照ページ: 役割、ステージ、ナレッジ |
| [対話モード](07-interaction-modes.md) | Guide Me / Edit File / Chat と承認ゲート |
| [ナレッジ](08-knowledge.md) | 会社の基準を足す、チームの文書を目録にする |
| [ルールと学習ループ](09-rules-and-the-learning-loop.md) | 自ら学ぶふるまいのルール |
| [状態と監査](10-state-and-audit.md) | 進み具合と判断の追い方 |
| [セッション管理](11-session-management.md) | 再開、やり直し、ジャンプ、復旧、セッション報告のスキル |
| [CLI コマンド](12-cli-commands.md) | すべてのフラグの参照と例 |
| [カスタマイズ](13-customization.md) | 設定、スコープ設定、エージェントの調整 |
| [成果物リファレンス](14-artifacts-reference.md) | intent ごとの記録ディレクトリ（`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`） |
| [困ったとき](15-troubleshooting.md) | 症状から探す問題解決 |
| [実例](16-worked-examples.md) | バグ修正と機能追加の一通りの流れ |
| [スキルとランナーコマンド](17-skills.md) | `/aidlc-*` のステージ・スコープ実行コマンドと、自作ランナーの道 |
| [インストールとライフサイクル](18-install-and-lifecycle.md) | ネイティブインストール、初期化、更新、ロールバック、バージョン固定、オフラインパッケージ、アンインストール、プロジェクトからの削除 |
| [複数チームの Construction とワークショップモード](workshop-mode.md) | クローンと兄弟 worktree のチームでの、取得、ビルド、固定したマージバック、リリース、ワークショップの流れ |
| [ほかのハーネスで動かす](harnesses/README.md) | Kiro CLI、Kiro IDE、Codex CLI、Cursor、opencode、GitHub Copilot でのインストールと実行、ハーネスごとの違い |
| [用語集](glossary.md) | すべての用語の定義 |

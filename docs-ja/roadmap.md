# AI-DLC Workflows ロードマップ

**2026 年 10 月 29 日に見直し。** この見直し時点の最新の安定版は
[v2.11.2](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.2) です。

このロードマップは、提供済みの機能と、プロジェクトが目指す北極星の方向を記録します。
いま実装がどこまで進んでいるかは、Issue と Pull Request を見てください。各リリースの
中身、互換性の注意、更新の手順は
[GitHub Releases](https://github.com/awslabs/aidlc-workflows/releases) にあります。

## 何が使えるか

- **安定版（Stable）:** 公開済みの安定版に入っている機能。
- **プレビュー（Preview）:** フィードバック用の候補ビルド。試す前に、選んだプレビューの
  テスト報告と既知の制限を読んでください。
- **`main` 上:** 統合済みの開発作業。最新の安定版より先に進んでいることがあります。
  マージされた PR は、プレビュー公開の対象になります。

[開発とリリースのガイド](../DEVELOPERS.md) に、プレビューでの検証、安定版への昇格、
リリースの判断が書いてあります。

## 最近提供したもの

前回のロードマップ見直し以降のリリースから、利用者に見える改善をいくつか選びました。
各リリースのリンクをたどると、全体の範囲と更新に必要なことが分かります。

<!-- markdownlint-disable MD013 -->

| 安定版リリース | 公開日 | 提供した機能 |
| --- | --- | --- |
| [2.11.2](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.2) | 2026 年 10 月 28 日 | チームをまたいだ返信とワークフロー操作の扱いをより確実に。並列の Unit ビルドと取り込みの修正。複数リポジトリのリバースエンジニアリングと、作業中のリポジトリ追加。設定と Windows の修正。 |
| [2.11.1](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.1) | 2026 年 10 月 20 日 | worktree、入れ子のチェックアウト、クローンでの作業に対するコード生成の承認。プラグインの同一性と合成の改善。古いリリースからのプロジェクト更新。 |
| [2.11.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.0) | 2026 年 10 月 8 日 | 人が指示するワークフロー変更とプラン承認。プラン変更時に完了済みの Unit 作業を保つ。より軽い初期ワークフローと、チームのファイルを保つ設定。 |
| [2.10.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.10.0) | 2026 年 9 月 24 日 | 検証済みの Unit とバッチの Construction チェックポイント。互換ハーネスでのプロジェクト共有。プロバイダーを保つ設定と、intent 単位の worktree。 |
| [2.9.0](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0) | 2026 年 9 月 15 日 | Classic ワークフローの更新。commit から Unit への由来づけ。intent のアーカイブと復元。ネイティブと手動コピーの実行環境アセットの分離と、プレビューチャネルの改善。 |

<!-- markdownlint-enable MD013 -->

## 北極星（North Star）

プロジェクトの北極星は、構成できるアンサンブル、ハーネスをまたいだカスタマイズ、
適応的なワークフロー、証拠に基づく検証、統制されたフィードバックループ、成果物の
追跡可能性、組織で共有するナレッジを対象にしています。

[前回のロードマップのスナップショット](https://github.com/awslabs/aidlc-workflows/blob/764553d96fb80a41d5dfc7b17d4399199f6766da/docs/roadmap.md)
に、以前の北極星のスコアカードと提供の履歴が残っています。その 2026 年 9 月 11 日
時点の記述は過去のものなので、それ以降の提供は上のリリースリンクを見てください。

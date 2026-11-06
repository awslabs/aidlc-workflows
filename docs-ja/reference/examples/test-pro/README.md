# `test-pro` — 具体的な config/JSON の例

これらは、プラグイン設計における構成ドキュメントを、出荷済みの `test-pro` フィクスチャ向けに具体化したものです。プラグイン機構を扱う唯一の章である [doc 18](../../18-plugin-mechanism.md) を説明するものです。**描いている内容の大半は将来向けで**、まだ出荷されていません。今日実際に組み込まれているもの（プラグインマニフェスト + compose のシーム）と、設計済みだが将来のもの（マーケットプレイスでの解決、managed-settings による信頼、ロックファイル、`aidlc engine plugin add`／`sync` のインストーラー）が正確にどれなのかは、doc 18 §8「Status」を参照してください。これらは、現在の挙動ではなく、意図されたライフサイクルを示します。

| ファイル | 役割 | 作成者 | 置かれる場所 |
|---|---|---|---|
| [`../../../../plugins/test-pro/.aidlc-plugin/plugin.json`](../../../../plugins/test-pro/.aidlc-plugin/plugin.json) | **プラグインマニフェスト** — プラグインが何か + 何を出荷するか | プラグインの作者 | プラグインリポジトリ内（実在する作成済みファイル） |
| [`marketplace.json`](marketplace.json) | **カタログエントリ** — プラグインがどう発見・バージョン管理されるか | マーケットプレイスのメンテナー | マーケットプレイスのリポジトリ |
| [`managed-settings.json`](managed-settings.json) | **信頼の許可リスト** — 組織がどのソースを許可するか | 組織の管理者（managed スコープ） | マシンの managed-settings パス |
| [`aidlc.lock.json`](aidlc.lock.json) | **インストールロック** — 再現性のために compose された結果をピン留めする | `aidlc engine plugin` のインストーラー | 利用者のプロジェクト |

## これらのファイルのステータス

- `plugin.json` は、リポジトリ内の**実在する作成済みファイル**で、出荷済みの `test-pro` フィクスチャのマニフェストです。オーサリングツールはその `aidlc.contributes` キーと正規のパスを検証します。プロジェクションは、依然としてディレクトリの規約によって対応するバイト列を発見します（doc 18 §3 を参照）。
- `marketplace.json`、`managed-settings.json`、`aidlc.lock.json` は、設計レビューのためだけの**説明用の例**です。これらを*生成*し*消費*するインストーラー、マーケットプレイスでの解決、ロックファイルの書き込みは**将来の作業**です（doc 18 §9「Status」）。ロックファイル内の `sha256:…` と `commit` の値はすべて、計算されたハッシュではなく**プレースホルダー**です。

## これらのファイルがたどるライフサイクル

1. **Author** が `plugin.json` とプラグインのサブツリーを書き、git タグを公開します。
2. **Marketplace**（任意）が、発見のために `marketplace.json` にプラグインを掲載します。
3. **Org admin** が `managed-settings.json` を設定し、承認済みのソースだけがインストールできるようにします。開発者はこれを上書きできません（managed スコープで、優先度が最も高い）。
4. **Developer** が `aidlc engine plugin add test-pro` を実行します。バージョンを解決し、許可リストと照合し、取得・検証し、`bare core + test-pro` を compose し、`aidlc.lock.json` を書きます。
5. **Teammate** が、コミット済みの `aidlc.lock.json` に対して `aidlc engine plugin sync` を実行し、バイト単位で同一のインストールを得ます。

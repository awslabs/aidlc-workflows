# aidlc-compliance-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-compliance-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、WebSearch、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

この agent に lead stage はありません。ライフサイクル全体で、もっぱら support とアドバイザリーの立場で動作します。

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| feasibility | Feasibility and Constraint Analysis | 規制の制約の特定、コンプライアンスの実現可能性の評価、RAID ログの初期化 |
| nfr-requirements | NFR Requirements | コンプライアンス主導の非機能要件とコントロールの仕様 |
| infrastructure-design | Infrastructure Design | データ所在地の検証、暗号化要件、IAM の監査 |
| environment-provisioning | Environment Provisioning | プロビジョンされた環境のコンプライアンスの姿勢の検証 |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-architect-agent | コンプライアンスレビューのためのシステム設計、データフロー図 |
| aidlc-devsecops-agent | コンプライアンスマッピングのためのセキュリティのコントロール、暗号化の仕様 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-architect-agent | 設計への組み込みのためのコンプライアンス要件 |
| aidlc-devsecops-agent | 規制の義務から導かれるセキュリティコントロールの仕様 |
| Orchestrator | コンプライアンスリスクのエスカレーション、RAID ログの更新 |

### 協働する相手（ピア）

| ピア | 共有する関心事 |
|------|----------------|
| aidlc-aws-platform-agent | データ所在地、保存時の暗号化、IAM の監査 |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-compliance-agent/`

| ファイル | 内容 |
|------|---------|
| regulatory-frameworks.md | 主要な規制フレームワークのリファレンス（PCI-DSS、HIPAA、SOC 2、GDPR） |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-compliance-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存のコンプライアンスマトリクス、監査の発見、データ分類の体系、規制の解釈のような、プロジェクト固有のコンプライアンスの文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-compliance-agent](../../guide/agents/compliance-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-compliance-agent.md`](../../../core/agents/aidlc-compliance-agent.md)

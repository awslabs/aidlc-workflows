# aidlc-devsecops-agent — 技術リファレンス

## 同一性

| フィールド | 値 |
|-------|-------|
| Name | aidlc-devsecops-agent |
| Tier | **judgment** |
| Claude Code Tools | フルのセッションツールセットを MCP ツールを含めて継承（`tools:` 許可リストなし）。Read、Edit、Write、Glob、Grep、Bash、AskUserQuestion を使うと期待される |
| Disallowed Claude Code Tools | Task |

---

## Stage の所有

### Lead Stage

この agent に lead stage はありません。Inception、Construction、Operation phase の複数の stage にわたって、もっぱら support の役割で動作します。

### Support Stage

| Stage | 名前 | この agent が貢献すること |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery | 相互に目隠しされたスポーク。スキャン、シークレットの扱い、セキュアパイプラインの発見を contribution ファイルに記録する |
| nfr-requirements | NFR Requirements | セキュリティコントロールの仕様と脅威モデルの統合 |
| infrastructure-design | Infrastructure Design | IAM ポリシーのレビュー、セキュリティグループの検証、ネットワークセキュリティの評価 |
| build-and-test | Build and Test | SAST/DAST スキャンの構成、依存の脆弱性スキャン、IaC のセキュリティ linting |
| environment-provisioning | Environment Provisioning | セキュリティの姿勢の検証（Security Hub、Inspector、GuardDuty、暗号化、CloudTrail、VPC Flow Logs） |

---

## 協働のパターン

### 受け取る相手

| ソース | アーティファクト |
|--------|-----------|
| aidlc-compliance-agent | Ideation からの規制要件（制約レジスタ、RAID ログ） |
| aidlc-architect-agent | 脅威モデリングのためのシステム設計、コンポーネントの境界 |

### 引き渡す相手

| ターゲット | アーティファクト |
|--------|-----------|
| aidlc-developer-agent | セキュアなコーディング要件、脆弱性の修正の仕様 |
| aidlc-quality-agent | 実行のためのセキュリティテストケース |
| aidlc-pipeline-deploy-agent | CI/CD パイプライン統合のためのセキュリティゲート |

---

## Knowledge のソース

### メソドロジー（Tier 1）

パス: `.claude/knowledge/aidlc-devsecops-agent/`

| ファイル | 内容 |
|------|---------|
| devsecops-pipeline-patterns.md | セキュリティパイプライン統合のパターン（SAST、DAST、IaC スキャン） |
| nfr-requirements-guide.md | セキュリティに焦点を当てた NFR 要件のメソドロジー |
| security-guide.md | アプリケーションとクラウドのセキュリティのメソドロジー |
| threat-modelling-stride.md | STRIDE 脅威モデリングのメソドロジーとテンプレート |

### チーム（Tier 2）

パス: `aidlc/spaces/<active-space>/knowledge/aidlc-devsecops-agent/`（space レベルの knowledge ディレクトリ。ユーザー管理）

チームが内容を持つときに作成する space レベルのディレクトリです（engine は space の `knowledge/` フォルダを空で作成します）。チームが、既存の脅威モデル、セキュリティポリシー、承認された暗号化標準、ペネトレーションテストの発見のような、プロジェクト固有のセキュリティの文脈で満たします。

---

## 相互参照

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-devsecops-agent](../../guide/agents/devsecops-agent.md)
- [Stage Documentation](../04-stages/)
- 書かれたソース: [`core/agents/aidlc-devsecops-agent.md`](../../../core/agents/aidlc-devsecops-agent.md)

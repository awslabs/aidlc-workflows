# リファクタリング・品質改善フェーズ 支援ガイド

---

## このフェーズの目的

動くコードを**保守しやすく・拡張しやすく・安全に**改善する。
AI-DLCでは、ボルト完了後や機能追加前に行うことが多い。

---

## リファクタリングのトリガー

以下のサインが出たらリファクタリングを検討する:

- 同じコードが3箇所以上に重複している（DRY原則違反）
- 1つの関数が50行を超えている
- 「何をしているか」がすぐに分からないコードがある
- テストが書きにくいコードがある（依存が複雑すぎる）
- TypeScriptの型エラーが頻繁に起きる箇所がある

---

## AI-DLC文脈でのリファクタリング優先度

ハッカソン期間中は時間が限られているため、優先順位をつける:

### 高優先度（審査に影響）
1. **セキュリティ問題**の修正（シークレットのハードコード等）
2. **致命的なバグ**の修正
3. **README・ドキュメント**の改善（審査員が見る）

### 中優先度（品質向上）
4. **重複コードの削除**（共通処理の関数化）
5. **エラーハンドリングの改善**
6. **型安全性の向上**

### 低優先度（時間があれば）
7. パフォーマンス最適化
8. コメントの追加・改善
9. ログ出力の整備

---

## リファクタリングの実行手順

### Step 1: 現状分析

`coderabbit:code-review` スキルを呼び出して現状の問題を洗い出す。
またはコードを読み込んで以下を確認:

```
確認項目:
□ 重複コードの箇所
□ 長すぎる関数（50行超）
□ 複雑すぎる条件分岐（ネスト3段階以上）
□ any型の使用箇所
□ ハードコードされた値
□ テストのないコード
```

### Step 2: 安全なリファクタリング

**必ず既存テストが通る状態で始める**:

```bash
npm test  # すべてGreenであることを確認してからリファクタリング開始
```

**リファクタリングパターン**:

```typescript
// Before: 重複コード
async function getUserById(id: string) {
  const result = await dynamoClient.get({
    TableName: 'users-table',  // ← ハードコード
    Key: { pk: `USER#${id}` }
  }).promise();
  if (!result.Item) throw new Error('Not found');
  return result.Item;
}

async function updateUser(id: string, data: any) {
  const existing = await dynamoClient.get({
    TableName: 'users-table',  // ← 同じハードコード
    Key: { pk: `USER#${id}` }
  }).promise();
  if (!existing.Item) throw new Error('Not found');
  // ...
}

// After: 共通化・型安全
const TABLE_NAME = process.env.USERS_TABLE_NAME!;

async function getItemOrThrow(key: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await dynamoClient.get({ TableName: TABLE_NAME, Key: key }).promise();
  if (!result.Item) throw new NotFoundError(`Item not found: ${JSON.stringify(key)}`);
  return result.Item;
}

async function getUserById(id: string): Promise<User> {
  const item = await getItemOrThrow({ pk: `USER#${id}` });
  return mapToUser(item);
}
```

### Step 3: テストの更新

リファクタリング後にテストが変わる場合は更新する:

```bash
npm test        # すべてGreenであることを確認
npm run test:coverage  # カバレッジが下がっていないことを確認
```

---

## コードレビューとの連携

リファクタリング計画を立てたら `coderabbit:code-review` または `superpowers:requesting-code-review` スキルを使ってレビューを受ける。

**レビューで確認すべき観点**:
- 変更がテストで検証されているか
- 新しい設計がより理解しやすいか
- パフォーマンスが劣化していないか
- セキュリティ上の問題が解消されているか

---

## aidlc-docs への記録

リファクタリングを行った場合、Construction フェーズの成果物に記録する:

```markdown
# コード改善ログ: [Unit名]

## 実施日
2026-05-XX

## 改善内容
| 問題 | 解決方法 | 影響ファイル |
|------|---------|-------------|
| 重複コードを3箇所で確認 | 共通関数 `getItemOrThrow` を抽出 | repositories/*.ts |
| any型の使用 | 適切な型定義に変更 | handlers/user.ts |

## テスト結果
- ユニットテスト: 全件PASS
- カバレッジ: 85% → 88%（改善）
```

---

## 技術的負債の可視化

長期的な改善のために技術的負債を記録する:

```markdown
# 技術的負債リスト

| ID | 問題 | 優先度 | 推定工数 | 担当 |
|----|------|--------|---------|------|
| TD-001 | ~~重複コードX~~ | 高 | 1h | ~~完了~~ |
| TD-002 | エラーハンドリング不足 | 中 | 2h | - |
| TD-003 | テストカバレッジ低い箇所 | 低 | 3h | - |
```

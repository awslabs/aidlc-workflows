# テストフェーズ 支援ガイド
## Build and Test

---

## このフェーズの目的

コードが要件を満たし、本番環境で安定動作することを確認する。
AI-DLCでは「テストはコード生成と同時に生成する」のが原則。

---

## テスト戦略の決定

まず「どのレベルのテストが必要か」を決定する:

```
テストピラミッド（AI-DLC推奨比率）:
          /\
         /E2E\      ← 少数（3〜5件）デモシナリオ中心
        /------\
       /統合テスト\   ← 中程度（Unit間連携）
      /------------\
     / ユニットテスト \  ← 多数（各関数・モジュール）
    /--------------\
```

ハッカソン文脈では優先順位:
1. **ユニットテスト**（ビジネスロジック）
2. **統合テスト**（API+DB連携）
3. **E2Eテスト**（デモシナリオの動作確認）

---

## ユニットテストの書き方

### テストケース生成パターン

コードを生成したら、同時に以下のパターンでテストを生成する:

```typescript
// Vitest / Jest 形式
describe('[テスト対象の関数/クラス名]', () => {
  
  // Happy path（正常ケース）
  it('正常なInputで期待通りの結果を返す', async () => {
    // Arrange（準備）
    const input = { userId: 'user-123', name: 'テストユーザー' };
    
    // Act（実行）
    const result = await createUser(input);
    
    // Assert（確認）
    expect(result.userId).toBe('user-123');
    expect(result.name).toBe('テストユーザー');
    expect(result.createdAt).toBeDefined();
  });

  // Edge cases（境界値）
  it('空のnameは ValidationError を投げる', async () => {
    await expect(createUser({ userId: 'user-123', name: '' }))
      .rejects.toThrow(ValidationError);
  });

  // Error cases（エラーケース）
  it('DB接続失敗時は DatabaseError を投げる', async () => {
    // モック設定
    vi.mocked(dynamoClient.put).mockRejectedValue(new Error('Connection failed'));
    
    await expect(createUser({ userId: 'user-123', name: '太郎' }))
      .rejects.toThrow(DatabaseError);
  });
});
```

### カバレッジ目標

| テスト種別 | 推奨カバレッジ |
|-----------|-------------|
| ビジネスロジック層 | 90%以上 |
| APIハンドラー層 | 80%以上 |
| リポジトリ層 | 70%以上 |
| CDKスタック | スナップショットテスト |

---

## 統合テストの書き方

### AWS LocalStack / testcontainers を使った統合テスト

```typescript
// テスト環境でのDynamoDB操作テスト
describe('UserRepository 統合テスト', () => {
  let dynamoClient: DynamoDBClient;
  
  beforeAll(async () => {
    // LocalStack or テスト用DynamoDB接続
    dynamoClient = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000'
    });
    await createTestTable(dynamoClient);
  });

  afterAll(async () => {
    await deleteTestTable(dynamoClient);
  });

  it('ユーザーを作成・取得できる', async () => {
    const repo = new UserRepository(dynamoClient);
    
    const user = await repo.create({ name: 'テスト太郎' });
    const retrieved = await repo.findById(user.id);
    
    expect(retrieved?.name).toBe('テスト太郎');
  });
});
```

---

## build-and-test-instructions.md の生成

AI-DLCでは `aidlc-docs/construction/build-and-test/` に手順書を生成する:

### build-instructions.md テンプレート

```markdown
# ビルド手順

## 前提条件
- Node.js 22以上
- AWS CLI設定済み
- AWS CDK v2インストール済み

## セットアップ
\`\`\`bash
npm install
npm run build
\`\`\`

## CDKデプロイ
\`\`\`bash
# 初回のみ
npx cdk bootstrap

# デプロイ
npx cdk deploy --all
\`\`\`

## 環境変数
| 変数名 | 説明 | 必須 |
|--------|------|------|
| AWS_REGION | デプロイリージョン | Yes |
```

### unit-test-instructions.md テンプレート

```markdown
# ユニットテスト実行手順

\`\`\`bash
# 全テスト実行
npm test

# カバレッジ付き
npm run test:coverage

# 特定ファイルのみ
npm test -- src/services/user.test.ts
\`\`\`

## カバレッジ確認
テスト実行後 `coverage/index.html` でカバレッジレポートを確認
```

---

## デバッグ支援

テストが失敗した場合は `superpowers:systematic-debugging` スキルを使用。

よくある失敗パターン:

| エラー | 原因 | 対処法 |
|--------|------|--------|
| `TypeError: Cannot read properties of undefined` | モック設定ミス | `vi.mocked()` の戻り値を確認 |
| `ValidationError` | テストデータが不正 | スキーマ定義を確認 |
| `TimeoutError` | 非同期処理の待ち漏れ | `await` の追加 |
| CDKスナップショット差分 | インフラ変更 | `npx cdk diff` で差分確認後にスナップショット更新 |

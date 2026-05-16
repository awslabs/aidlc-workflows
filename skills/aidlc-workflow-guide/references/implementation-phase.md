# 実装フェーズ 支援ガイド
## Code Generation + Infrastructure Design（Mob Construction）

---

## このフェーズの目的

設計を**動くコード**に変換する。AIが高速生成し、開発者がリアルタイムに検証・修正する。
「Mob Construction」：チーム全員がAIの生成プロセスに参加し、技術判断を行う。

---

## Code Generation の2段階プロセス

### Part 1: コード生成計画（承認が必要）

実装前に必ずチェックボックス付きの計画を提示し、開発者の承認を取る:

```markdown
## コード生成計画: [Unit名]

### 生成するファイル一覧
- [ ] src/handlers/[name].ts       - APIハンドラー
- [ ] src/services/[name].ts       - ビジネスロジック
- [ ] src/repositories/[name].ts   - データアクセス層
- [ ] src/models/[name].ts         - 型定義・スキーマ
- [ ] tests/unit/[name].test.ts    - ユニットテスト
- [ ] tests/integration/[name].test.ts - 統合テスト
- [ ] infra/lib/[name]-stack.ts    - CDKスタック

### 技術スタック確認
- ランタイム: Node.js 22 / Python 3.12 / [確認]
- フレームワーク: Hono / Express / [確認]
- テストフレームワーク: Vitest / Jest / pytest / [確認]
- IaC: AWS CDK (TypeScript)

### 実装方針
1. [実装の主要な判断事項1]
2. [実装の主要な判断事項2]

この計画で進めてよいですか？
```

### Part 2: 実装の実行

承認を受けたら、計画に従ってコードを生成する。

**生成順序（推奨）**:
1. 型定義・モデル（他のファイルが依存するため最初）
2. リポジトリ層（データアクセス）
3. サービス層（ビジネスロジック）
4. ハンドラー層（API）
5. CDKスタック（インフラ）
6. テスト（各層に対して）

---

## コード品質の原則

### TypeScript / Node.js

```typescript
// 良い例: 型安全・エラーハンドリング・単一責任
export async function getUserById(userId: string): Promise<User | null> {
  try {
    const result = await dynamoClient.get({
      TableName: TABLE_NAME,
      Key: { pk: `USER#${userId}` }
    }).promise();
    
    return result.Item ? mapToUser(result.Item) : null;
  } catch (error) {
    logger.error('Failed to get user', { userId, error });
    throw new DatabaseError('User retrieval failed', { cause: error });
  }
}

// 悪い例: any型・エラー握り潰し・不明確な処理
async function getUser(id: any) {
  try {
    return await db.get(id);
  } catch(e) {
    return null; // エラーを隠蔽
  }
}
```

### セキュリティ必須項目

```typescript
// 環境変数からシークレットを読む（ハードコード厳禁）
const TABLE_NAME = process.env.TABLE_NAME!;
const SECRET = await getSecretValue(process.env.SECRET_ARN!);

// 入力バリデーション（ユーザー入力は必ず検証）
const schema = z.object({
  userId: z.string().uuid(),
  content: z.string().max(1000)
});
const validated = schema.parse(input); // 失敗時は自動でエラー

// APIゲートウェイでのレート制限設定
// → CDKのThrottlingSettings で設定
```

---

## CDK / IaC 実装ガイド

CDKコードの生成は `aws-cdk-architect` スキルを参照すること。

### CDKスタックの基本構造

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MyServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDBテーブル
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,  // コスト最適化
      removalPolicy: cdk.RemovalPolicy.DESTROY,           // 開発時のみ
      pointInTimeRecovery: true,                          // 本番必須
    });

    // 2. Lambda関数
    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset('dist'),
      handler: 'index.handler',
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    // 3. 最小権限でIAMロールを設定
    table.grantReadWriteData(handler);

    // 4. API Gateway
    const api = new apigateway.RestApi(this, 'Api', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
      },
    });
    
    api.root.addMethod('GET', new apigateway.LambdaIntegration(handler));
  }
}
```

### AI-DLC成果物への記録

コード生成完了後、要約をMarkdownで記録:

```markdown
# コード生成サマリー: [Unit名]

## 生成ファイル
| ファイル | 説明 |
|---------|------|
| src/handlers/user.ts | ユーザーAPIハンドラー（GET/POST/DELETE） |
| infra/lib/user-stack.ts | DynamoDB + Lambda + API Gateway CDKスタック |

## 技術的判断
- [重要な実装判断とその理由]

## 既知の制限
- [実装上の制限・TODO]
```

---

## Mob Construction の実践

実装中に開発者が確認すべきタイミング:

1. **型定義レビュー**: 「このスキーマで要件を満たしているか」
2. **エラーハンドリング確認**: 「このエラーケースは想定通りか」
3. **セキュリティチェック**: 「この権限設定で問題ないか」
4. **テスト戦略確認**: 「このテストで十分か」

---

## よくある実装ミスと対処法

**ミス1**: シークレットのハードコード
→ `process.env.XXX` または AWS Secrets Manager を使用

**ミス2**: Lambda関数のタイムアウト設定忘れ
→ デフォルト3秒は短すぎる。処理時間の2〜3倍に設定

**ミス3**: DynamoDBのアクセスパターン設計ミス
→ 先にクエリパターンを定義し、それに合わせてテーブル設計する

**ミス4**: CDKのRemovalPolicyをPRODで DESTROY にする
→ 本番環境は必ず `RETAIN` または `SNAPSHOT`

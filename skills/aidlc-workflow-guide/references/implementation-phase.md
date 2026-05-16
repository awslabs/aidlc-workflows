# Implementation Phase Support Guide
## Code Generation + Infrastructure Design (Mob Construction)

---

## Purpose of This Phase

Convert design into **working code**. AI generates rapidly while developers validate and revise in real time.
"Mob Construction": the entire team participates in the AI generation process and makes technical decisions.

---

## Two-Stage Process for Code Generation

### Part 1: Code Generation Plan (Approval Required)

Before implementing, always present a checklist-based plan and obtain developer approval:

```markdown
## Code Generation Plan: [Unit Name]

### Files to Generate
- [ ] src/handlers/[name].ts       - API handler
- [ ] src/services/[name].ts       - Business logic
- [ ] src/repositories/[name].ts   - Data access layer
- [ ] src/models/[name].ts         - Type definitions / schema
- [ ] tests/unit/[name].test.ts    - Unit tests
- [ ] tests/integration/[name].test.ts - Integration tests
- [ ] infra/lib/[name]-stack.ts    - CDK stack

### Tech Stack Confirmation
- Runtime: Node.js 22 / Python 3.12 / [confirm]
- Framework: Hono / Express / [confirm]
- Test Framework: Vitest / Jest / pytest / [confirm]
- IaC: AWS CDK (TypeScript)

### Implementation Approach
1. [Key implementation decision 1]
2. [Key implementation decision 2]

Shall we proceed with this plan?
```

### Part 2: Executing the Implementation

Once approved, generate code following the plan.

**Recommended generation order**:
1. Type definitions / models (first, as other files depend on them)
2. Repository layer (data access)
3. Service layer (business logic)
4. Handler layer (API)
5. CDK stack (infrastructure)
6. Tests (for each layer)

---

## Code Quality Principles

### TypeScript / Node.js

```typescript
// Good example: type-safe, error handling, single responsibility
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

// Bad example: any type, swallowed errors, unclear processing
async function getUser(id: any) {
  try {
    return await db.get(id);
  } catch(e) {
    return null; // Error is hidden
  }
}
```

### Security Essentials

```typescript
// Read secrets from environment variables (never hardcode)
const TABLE_NAME = process.env.TABLE_NAME!;
const SECRET = await getSecretValue(process.env.SECRET_ARN!);

// Input validation (always validate user input)
const schema = z.object({
  userId: z.string().uuid(),
  content: z.string().max(1000)
});
const validated = schema.parse(input); // Throws automatically on failure

// Rate limiting via API Gateway
// → Configure via CDK ThrottlingSettings
```

---

## CDK / IaC Implementation Guide

Refer to the `aws-cdk-architect` skill for CDK code generation.

### Basic CDK Stack Structure

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MyServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDB table
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,  // Cost optimization
      removalPolicy: cdk.RemovalPolicy.DESTROY,           // Development only
      pointInTimeRecovery: true,                          // Required for production
    });

    // 2. Lambda function
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

    // 3. Grant least-privilege IAM permissions
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

### Recording in AI-DLC Artifacts

After code generation, record a summary in Markdown:

```markdown
# Code Generation Summary: [Unit Name]

## Generated Files
| File | Description |
|---------|------|
| src/handlers/user.ts | User API handler (GET/POST/DELETE) |
| infra/lib/user-stack.ts | DynamoDB + Lambda + API Gateway CDK stack |

## Technical Decisions
- [Key implementation decisions and their rationale]

## Known Limitations
- [Implementation constraints / TODOs]
```

---

## Mob Construction in Practice

Key moments when developers should review during implementation:

1. **Type definition review**: "Does this schema satisfy the requirements?"
2. **Error handling review**: "Is this error case handled as expected?"
3. **Security check**: "Are these permissions configured correctly?"
4. **Test strategy review**: "Are these tests sufficient?"

---

## Common Implementation Mistakes and Fixes

**Mistake 1**: Hardcoded secrets
→ Use `process.env.XXX` or AWS Secrets Manager

**Mistake 2**: Forgetting Lambda function timeout configuration
→ The default 3 seconds is too short. Set to 2–3x the expected processing time

**Mistake 3**: Poor DynamoDB access pattern design
→ Define query patterns first, then design the table accordingly

**Mistake 4**: Setting CDK RemovalPolicy to DESTROY in production
→ Always use `RETAIN` or `SNAPSHOT` for production environments

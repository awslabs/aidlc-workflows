# AWS CDK Best Practices

## Purpose
Guidelines for building maintainable, secure, and testable infrastructure using the AWS Cloud Development Kit. These practices apply to CDK v2 with TypeScript (the recommended language for most teams).

## Construct Levels

### L1 (Cfn Resources)
- Direct CloudFormation resource wrappers (e.g., `CfnBucket`)
- Use only when L2 constructs do not expose a needed property
- Require manual configuration of all properties (no defaults)

### L2 (Curated Constructs)
- AWS-maintained constructs with sensible defaults (e.g., `Bucket`, `Function`, `Table`)
- Include helper methods (e.g., `bucket.grantRead(lambda)`)
- Preferred for most use cases — they encode AWS best practices

### L3 (Patterns)
- Higher-level constructs combining multiple resources (e.g., `LambdaRestApi`)
- Use when the pattern fits your needs exactly
- Avoid if you need significant customization — drop down to L2 instead

## Construct Design Patterns

### Single Responsibility
Each custom construct should represent one logical unit (a service, a data pipeline stage, a monitoring stack). Do not create constructs that build unrelated resources.

### Props Interface Pattern
```typescript
export interface OrderServiceProps {
  readonly vpc: ec2.IVpc;
  readonly table: dynamodb.ITable;
  readonly environment: string;         // 'dev' | 'staging' | 'prod'
  readonly alarmTopic?: sns.ITopic;     // optional props use ?
}

export class OrderService extends Construct {
  public readonly api: apigateway.RestApi;  // expose outputs as public readonly

  constructor(scope: Construct, id: string, props: OrderServiceProps) {
    super(scope, id);
    // ...
  }
}
```

### Rules
- Accept dependencies via props (dependency injection), do not create shared resources inside constructs
- Use interface types (`IVpc`, `ITable`) for props, not concrete types — enables cross-stack references
- Expose outputs as public readonly properties for consuming constructs
- Prefix optional props with documentation explaining the default behavior

## Stack Organization

### Recommended Structure
```
/infrastructure
  /bin
    app.ts              # CDK app entry point, environment configuration
  /lib
    /constructs         # Reusable L3 constructs
      order-service.ts
      monitoring.ts
    /stacks
      network-stack.ts      # VPC, subnets, security groups
      data-stack.ts         # DynamoDB, S3, RDS
      compute-stack.ts      # Lambda, ECS, API Gateway
      monitoring-stack.ts   # CloudWatch, alarms, dashboards
  /test
    order-service.test.ts
    data-stack.test.ts
```

### Stack Separation Guidelines
- Separate stacks by lifecycle: resources that change together should be in the same stack
- Stateful resources (databases, S3 buckets) in separate stacks from stateless (Lambda, API Gateway)
- Stateful stacks change rarely; stateless stacks deploy frequently
- Use cross-stack references sparingly — they create deployment coupling

## Environment-Aware Stacks

### Pattern
```typescript
// bin/app.ts
const app = new cdk.App();
const env = app.node.tryGetContext('env') || 'dev';

const config = {
  dev:     { instanceType: 't3.small', minCapacity: 1, maxCapacity: 2 },
  staging: { instanceType: 't3.medium', minCapacity: 2, maxCapacity: 4 },
  prod:    { instanceType: 't3.large', minCapacity: 3, maxCapacity: 10 },
}[env];

new ComputeStack(app, `ComputeStack-${env}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  config,
});
```

### Rules
- Never hardcode account IDs or regions — use environment variables or context
- Use the same code for all environments; parameterize differences through config
- Production stacks must specify explicit `env` (account + region) — do not rely on defaults

## CDK Testing

### Assertion Tests (Fine-Grained)
```typescript
test('DynamoDB table has encryption enabled', () => {
  const app = new cdk.App();
  const stack = new DataStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: {
      SSEEnabled: true,
    },
  });
});
```

### Snapshot Tests (Regression Detection)
```typescript
test('stack matches snapshot', () => {
  const app = new cdk.App();
  const stack = new DataStack(app, 'TestStack');
  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
```
- Update snapshots intentionally (`jest --updateSnapshot`) after deliberate changes
- Review snapshot diffs in pull requests — they show exactly what infrastructure changes

### What to Test
- Security properties: encryption enabled, public access blocked, least-privilege policies
- Critical configuration: retention policies, backup settings, auto-scaling parameters
- Resource counts: expected number of Lambda functions, tables, queues
- Do NOT test CDK internals or CloudFormation implementation details

## Security Defaults

### Encryption
- S3: `encryption: s3.BucketEncryption.S3_MANAGED` (minimum) or KMS for sensitive data
- DynamoDB: `encryption: dynamodb.TableEncryption.AWS_MANAGED` (default) or customer-managed KMS
- SQS: `encryption: sqs.QueueEncryption.KMS` for sensitive message content
- EBS: Enable encryption by default in account settings

### Access Control
- S3: `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL` (always, unless serving public static content)
- Lambda: Use `grant*` methods instead of writing IAM policies manually
- API Gateway: Add authorization on every route (IAM, Cognito, or Lambda authorizer)

### Logging
- S3: Enable access logging to a dedicated logging bucket
- API Gateway: Enable access logging and execution logging
- Lambda: Logs go to CloudWatch automatically; set retention (`logRetention: logs.RetentionDays.ONE_MONTH`)

### Least Privilege
```typescript
// Good: specific grant
table.grantReadData(lambdaFunction);

// Bad: overly broad
lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
  actions: ['dynamodb:*'],
  resources: ['*'],
}));
```

## CDK Aspects for Compliance

### Purpose
Aspects visit every construct in the tree and can validate, warn, or modify resources.

```typescript
class EncryptionChecker implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof s3.CfnBucket) {
      if (!node.bucketEncryption) {
        Annotations.of(node).addError('S3 bucket must have encryption enabled');
      }
    }
  }
}

// Apply to the entire app
Aspects.of(app).add(new EncryptionChecker());
```

### Common Compliance Aspects
- Verify all S3 buckets have encryption and block public access
- Verify all DynamoDB tables have point-in-time recovery enabled
- Verify all Lambda functions have reserved concurrency set
- Verify all security groups do not allow 0.0.0.0/0 ingress
- Tag all resources with required cost allocation tags

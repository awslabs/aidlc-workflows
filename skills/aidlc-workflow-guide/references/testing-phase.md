# Testing Phase Support Guide
## Build and Test

---

## Purpose of This Phase

Confirm that code meets requirements and operates reliably in production.
In AI-DLC, the principle is to "generate tests at the same time as code generation."

---

## Determining Test Strategy

First, decide "what level of testing is needed":

```
Test Pyramid (AI-DLC recommended ratio):
          /\
         /E2E\      ← Few (3–5) demo scenario-focused
        /------\
       / Integration \   ← Medium (inter-Unit integration)
      /------------\
     /  Unit Tests  \  ← Many (each function / module)
    /--------------\
```

Priority order:
1. **Unit tests** (business logic)
2. **Integration tests** (API + DB integration)
3. **E2E tests** (demo scenario verification)

---

## How to Write Unit Tests

### Test Case Generation Patterns

When code is generated, simultaneously generate tests using the following patterns:

```typescript
// Vitest / Jest format
describe('[Target function/class name]', () => {
  
  // Happy path (normal case)
  it('returns expected result for valid input', async () => {
    // Arrange
    const input = { userId: 'user-123', name: 'Test User' };
    
    // Act
    const result = await createUser(input);
    
    // Assert
    expect(result.userId).toBe('user-123');
    expect(result.name).toBe('Test User');
    expect(result.createdAt).toBeDefined();
  });

  // Edge cases (boundary values)
  it('throws ValidationError for empty name', async () => {
    await expect(createUser({ userId: 'user-123', name: '' }))
      .rejects.toThrow(ValidationError);
  });

  // Error cases
  it('throws DatabaseError on DB connection failure', async () => {
    // Mock setup
    vi.mocked(dynamoClient.put).mockRejectedValue(new Error('Connection failed'));
    
    await expect(createUser({ userId: 'user-123', name: 'Taro' }))
      .rejects.toThrow(DatabaseError);
  });
});
```

### Coverage Targets

| Test Type | Recommended Coverage |
|-----------|-------------|
| Business logic layer | 90% or higher |
| API handler layer | 80% or higher |
| Repository layer | 70% or higher |
| CDK stack | Snapshot tests |

---

## How to Write Integration Tests

### Integration Tests Using AWS LocalStack / testcontainers

```typescript
// DynamoDB operation test in test environment
describe('UserRepository Integration Tests', () => {
  let dynamoClient: DynamoDBClient;
  
  beforeAll(async () => {
    // LocalStack or test DynamoDB connection
    dynamoClient = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000'
    });
    await createTestTable(dynamoClient);
  });

  afterAll(async () => {
    await deleteTestTable(dynamoClient);
  });

  it('can create and retrieve a user', async () => {
    const repo = new UserRepository(dynamoClient);
    
    const user = await repo.create({ name: 'Test User' });
    const retrieved = await repo.findById(user.id);
    
    expect(retrieved?.name).toBe('Test User');
  });
});
```

---

## Generating build-and-test-instructions.md

In AI-DLC, generate procedure documents in `aidlc-docs/construction/build-and-test/`:

### build-instructions.md Template

```markdown
# Build Instructions

## Prerequisites
- Node.js 22 or higher
- AWS CLI configured
- AWS CDK v2 installed

## Setup
\`\`\`bash
npm install
npm run build
\`\`\`

## CDK Deployment
\`\`\`bash
# First time only
npx cdk bootstrap

# Deploy
npx cdk deploy --all
\`\`\`

## Environment Variables
| Variable | Description | Required |
|--------|------|------|
| AWS_REGION | Deployment region | Yes |
```

### unit-test-instructions.md Template

```markdown
# Unit Test Execution Instructions

\`\`\`bash
# Run all tests
npm test

# With coverage
npm run test:coverage

# Specific file only
npm test -- src/services/user.test.ts
\`\`\`

## Checking Coverage
After running tests, check the coverage report at `coverage/index.html`
```

---

## Debugging Support

If tests fail, use the `superpowers:systematic-debugging` skill.

Common failure patterns:

| Error | Cause | Fix |
|--------|------|--------|
| `TypeError: Cannot read properties of undefined` | Mock setup error | Check return value of `vi.mocked()` |
| `ValidationError` | Invalid test data | Check schema definition |
| `TimeoutError` | Missing async wait | Add `await` |
| CDK snapshot diff | Infrastructure change | Check diff with `npx cdk diff`, then update snapshot |

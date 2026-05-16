# Refactoring and Quality Improvement Phase Support Guide

---

## Purpose of This Phase

Improve working code to be **more maintainable, extensible, and secure**.
In AI-DLC, this is often done after a Bolt completes or before adding new features.

---

## Triggers for Refactoring

Consider refactoring when you see the following signs:

- The same code is duplicated in 3 or more places (DRY principle violation)
- A single function exceeds 50 lines
- Code whose purpose is not immediately clear
- Code that is difficult to test (overly complex dependencies)
- Frequent TypeScript type errors in certain areas

---

## Refactoring Priorities in the AI-DLC Context

Prioritize based on available time:

### High Priority (Impacts Review / Production)
1. Fixing **security issues** (hardcoded secrets, etc.)
2. Fixing **critical bugs**
3. Improving **README and documentation** (reviewed by evaluators)

### Medium Priority (Quality Improvement)
4. **Eliminating duplicated code** (extracting common processing into functions)
5. **Improving error handling**
6. **Improving type safety**

### Low Priority (If time permits)
7. Performance optimization
8. Adding / improving comments
9. Improving log output

---

## Refactoring Execution Steps

### Step 1: Current State Analysis

Call the `coderabbit:code-review` skill to identify issues, or read the code and check the following:

```
Checklist:
□ Locations of duplicated code
□ Functions that are too long (over 50 lines)
□ Overly complex conditional branches (3+ levels of nesting)
□ Uses of the `any` type
□ Hardcoded values
□ Code without tests
```

### Step 2: Safe Refactoring

**Always start with existing tests passing**:

```bash
npm test  # Confirm all Green before starting refactoring
```

**Refactoring patterns**:

```typescript
// Before: duplicated code
async function getUserById(id: string) {
  const result = await dynamoClient.get({
    TableName: 'users-table',  // ← hardcoded
    Key: { pk: `USER#${id}` }
  }).promise();
  if (!result.Item) throw new Error('Not found');
  return result.Item;
}

async function updateUser(id: string, data: any) {
  const existing = await dynamoClient.get({
    TableName: 'users-table',  // ← same hardcoded value
    Key: { pk: `USER#${id}` }
  }).promise();
  if (!existing.Item) throw new Error('Not found');
  // ...
}

// After: shared function, type-safe
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

### Step 3: Update Tests

If tests need to change after refactoring, update them:

```bash
npm test        # Confirm all Green
npm run test:coverage  # Confirm coverage has not decreased
```

---

## Integration with Code Review

Once a refactoring plan is established, use the `coderabbit:code-review` or `superpowers:requesting-code-review` skill to get a review.

**Key review considerations**:
- Are the changes verified by tests?
- Is the new design more understandable?
- Has performance not degraded?
- Have security issues been resolved?

---

## Recording in aidlc-docs

When refactoring is performed, record it in the Construction phase artifacts:

```markdown
# Code Improvement Log: [Unit Name]

## Date
2026-05-XX

## Improvements Made
| Issue | Solution | Affected Files |
|------|---------|-------------|
| Duplicated code found in 3 places | Extracted common function `getItemOrThrow` | repositories/*.ts |
| Use of `any` type | Changed to proper type definitions | handlers/user.ts |

## Test Results
- Unit tests: All PASS
- Coverage: 85% → 88% (improved)
```

---

## Visualizing Technical Debt

Record technical debt for long-term improvement:

```markdown
# Technical Debt List

| ID | Issue | Priority | Estimated Effort | Owner |
|----|------|--------|---------|------|
| TD-001 | ~~Duplicated code X~~ | High | 1h | ~~Done~~ |
| TD-002 | Insufficient error handling | Medium | 2h | - |
| TD-003 | Low test coverage areas | Low | 3h | - |
```

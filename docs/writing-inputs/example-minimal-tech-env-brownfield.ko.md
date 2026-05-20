# 기술 환경: 반품/환불 모듈 — OrderFlow 플랫폼

> **브라운필드 프로젝트.** 기존 스택이 기준선입니다. 새 코드는 확립된 패턴에 맞춰야 합니다.
> 아래에 선택지가 명시되지 않은 경우 기존 코드베이스를 따르고, 정당한 사유 없이 새 패턴을 도입하지 마세요.

---

## 기존 스택 (반드시 유지)

| 계층              | 현재 기술             | 버전        | 비고                                                                |
| --------------- | ----------------- | --------- | ----------------------------------------------------------------- |
| 언어              | TypeScript        | 5.x       | strict 모드. JavaScript 파일 도입 금지.                                  |
| 런타임             | Node.js           | 20.x LTS  |                                                                   |
| API 프레임워크       | Express           | 4.x       | 모든 기존 서비스가 Express 사용. Fastify, Koa 도입 금지.                       |
| 데이터베이스          | PostgreSQL        | 15        | pg, node-postgres 사용. ORM 미사용 — 타입드 쿼리 헬퍼와 raw SQL.              |
| 인프라             | AWS ECS Fargate   | —         | Docker 컨테이너로 배포. 모든 인프라는 CDK.                                    |
| 메시지 버스          | Amazon SQS        | —         | notification-service에서 비동기 이메일 발송에 사용.                            |
| 인증              | AWS Cognito       | —         | API Gateway에서 JWT 토큰 검증. 새로운 인증 레이어 구축 금지.                      |
| 패키지 매니저         | npm               | 10.x      | yarn, pnpm 도입 금지.                                                 |
| 테스트 프레임워크       | Jest              | 29.x      | ts-jest 사용. 모든 테스트는 소스와 같은 위치의 `__tests__/`에 위치.                |
| 린터 / 포매터        | ESLint + Prettier | —         | 설정 파일은 저장소 루트에 있음. 수정 금지.                                       |

---

## 추가할 것 (이 모듈에 신규)

- `order-service`와 동일한 구조를 따르는 새 `returns-service`
- 새 PostgreSQL 테이블: `return_requests`, `return_items`, `return_status_history`
- 고객 반품 폼과 운영 대시보드용 새 React 컴포넌트
- 위 추가는 기존 테이블 또는 서비스 컨트랙트를 수정해서는 안 됩니다

---

## 변경하지 말 것

- `order-service`, `payment-service`, `notification-service` — 이 서비스들 수정 금지
- 기존 PostgreSQL 테이블 — 추가 마이그레이션만 허용(신규 테이블 또는 신규 테이블의 신규 컬럼)
- `notification-service` API 컨트랙트 — 문서대로 호출, 확장 금지
- 기존 CDK 스택 — `returns-service` 용 새 스택을 추가하되 기존 스택 편집 금지
- 프런트엔드 디자인 시스템 컴포넌트 — 기존 컴포넌트 사용, 대체본 생성 금지

---

## 제거 / 도입 금지

| 금지 항목                              | 이유                                                                                       | 대신 사용할 것                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ORM (TypeORM, Prisma, Sequelize)   | 기존 코드베이스는 타입드 헬퍼와 raw SQL을 사용. ORM 도입은 불일치를 야기.                                          | 기존 패턴에 맞춘 타입드 쿼리 함수가 있는 node-postgres                                  |
| Axios                               | 프로젝트는 네이티브 fetch(Node 20 내장)를 사용.                                                          | fetch                                                                       |
| 새 CSS 프레임워크                         | 기존 프런트엔드는 Tailwind CSS 사용.                                                                  | Tailwind CSS, 기존 디자인 시스템 컴포넌트                                            |
| 새 상태 관리 라이브러리                       | 기존 프런트엔드는 React Context + useReducer 사용.                                                   | React Context + useReducer                                                  |
| 새 테스트 러너 (Vitest, Mocha)            | 프로젝트 전체가 Jest 사용.                                                                          | Jest                                                                        |
| 별도 인증 서비스 또는 미들웨어                   | 인증은 API Gateway에서 Cognito JWT로 처리됨.                                                         | Authorization 헤더의 JWT 검증 — 다른 서비스들과 동일하게                                 |

---

## 보안 기본 사항

- 인증: Cognito JWT가 API Gateway에서 검증됩니다. 서비스는 `x-user-id`와 `x-user-role` 헤더를 받습니다 — 이 헤더를 신뢰하고, 서비스에서 JWT를 다시 검증하지 마세요
- 인가: 운영 대시보드 엔드포인트는 `role === 'operations'` 가 필요합니다 — 이 헤더를 확인하세요
- 입력 검증: 모든 요청 본문은 처리 전에 Zod 스키마로 검증합니다
- PII: 반품 요청에는 고객 이름과 주소가 포함됩니다 — 이 필드들은 로그에 남기지 마세요
- 시크릿: DB 자격 증명과 서비스 URL은 기존 서비스와 동일하게 AWS Secrets Manager 사용

---

## 예시 코드 패턴

기존 코드베이스의 다음 패턴을 따르세요. 다른 대안을 임의로 만들지 마세요.

**서비스 엔드포인트 (Express 라우트 핸들러):**

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createReturnRequest } from '../domain/returns';
import { AppError } from '../errors';

const router = Router();

const CreateReturnSchema = z.object({
  orderId: z.string().uuid(),
  items: z.array(z.object({ orderItemId: z.string().uuid(), reason: z.string().min(1) })).min(1),
});

router.post('/returns', async (req: Request, res: Response) => {
  const parsed = CreateReturnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
  }
  try {
    const result = await createReturnRequest(parsed.data, req.headers['x-user-id'] as string);
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.code, message: err.message });
    }
    throw err;
  }
});

export default router;
```

**DB 쿼리 함수:**

```typescript
import { pool } from '../db/pool';

export interface ReturnRequest {
  id: string;
  orderId: string;
  customerId: string;
  status: 'submitted' | 'approved' | 'rejected' | 'refunded';
  createdAt: Date;
}

export async function getReturnRequestById(id: string): Promise<ReturnRequest | null> {
  const { rows } = await pool.query<ReturnRequest>(
    'SELECT id, order_id AS "orderId", customer_id AS "customerId", status, created_at AS "createdAt" FROM return_requests WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}
```

**Jest 테스트:**

```typescript
import { getReturnRequestById } from '../db/return-requests';
import { pool } from '../db/pool';

jest.mock('../db/pool');
const mockQuery = pool.query as jest.Mock;

describe('getReturnRequestById', () => {
  it('returns the request when found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc', orderId: '123', status: 'submitted' }] });
    const result = await getReturnRequestById('abc');
    expect(result?.id).toBe('abc');
  });

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getReturnRequestById('missing');
    expect(result).toBeNull();
  });
});
```

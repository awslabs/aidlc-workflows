# 기술 환경: CalcEngine

## 언어 및 패키지 매니저

- **Python 3.12+**
- 모든 패키지 관리는 **uv** 사용 (pip, poetry, conda 사용 금지)
- 모든 프로젝트/도구 설정은 `pyproject.toml`
- `uv.lock`은 Git에 커밋

## 웹 프레임워크

- **FastAPI** + Pydantic v2 (요청/응답 검증)
- **Mangum** 으로 AWS Lambda에서 FastAPI 실행

## 클라우드 및 배포

- **AWS**, 단일 계정, `us-east-1`
- **서버리스**: API Gateway(HTTP API 타입) 뒤의 Lambda
- API 키 저장 및 사용량 미터링은 **DynamoDB**
- 문서 사이트는 **S3 + CloudFront**
- 모든 인프라는 **AWS CDK (Python)** — 수동 콘솔 변경 금지

## 테스트

- **pytest** + pytest-cov (라인 커버리지 최소 90%)
- 수학적 정확성에 대한 속성 기반 테스트는 **hypothesis**
- 타입 체크는 **mypy** strict 모드
- 린트/포매팅은 **ruff**
- 테스트에서 AWS 서비스 모킹은 **moto**

## 사용 금지

| 금지 항목                            | 이유                                            | 대신 사용할 것                  |
| ------------------------------- | ----------------------------------------------- | --------------------------- |
| `eval()`, `exec()`, `compile()` | 보안 — 임의 코드 실행                                   | AST 기반 표현식 파서              |
| Flask, Django                   | 프로젝트는 FastAPI 사용                                 | FastAPI                     |
| requests                        | async 이벤트 루프를 차단                                 | httpx                       |
| sympy                           | MVP에 비해 너무 무거움                                   | 커스텀 표현식 파서                  |
| pandas                          | 불필요 — 단일 계산이 대상이며 데이터프레임 아님                   | 표준 파이썬                     |
| pip, poetry, pipenv             | 프로젝트는 uv 전용 사용                                   | uv                          |
| black, flake8, isort            | ruff로 대체됨                                       | ruff                        |
| AWS EC2, ECS, RDS               | MVP에서는 서버리스 모델 선호                                | Lambda, DynamoDB            |

## 보안 기본 사항

- `Authorization: Bearer {key}` 헤더로 API 키 인증
- 키는 DynamoDB에 bcrypt 해시로 저장 — 평문 로깅 금지
- 표현식 파서는 문자 화이트리스트와 AST 평가 — 동적 코드 실행 없음
- 표현식 길이 4,096자, 중첩 깊이 100단계 제한
- TLS 1.2+ 적용, HTTP 엔드포인트 금지
- 시크릿은 환경 변수나 코드가 아닌 AWS Secrets Manager에 저장

## 예시 코드 패턴

엔드포인트는 다음 구조를 따라야 합니다.

```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from calcengine.api.middleware.auth import get_api_key_id
from calcengine.api.models.errors import error_response
from calcengine.api.models.responses import CalculationResponse
from calcengine.engine.errors import CalcEngineError
from calcengine.engine.trigonometry import sin

router = APIRouter()


class SinRequest(BaseModel):
    value: float
    angle_mode: str = Field(default="radians", pattern="^(radians|degrees)$")


@router.post("/v1/trigonometry/sin", response_model=CalculationResponse)
async def calculate_sin(
    request: SinRequest,
    api_key_id: str = Depends(get_api_key_id),
) -> CalculationResponse | dict:
    try:
        result = sin(request.value, angle_mode=request.angle_mode)
        return CalculationResponse(result=result, expression=f"sin({request.value})")
    except CalcEngineError as e:
        return error_response(e)
```

수학 함수는 다음 구조를 따라야 합니다.

```python
import math

from calcengine.engine.errors import DomainError


def log_base(value: float, base: float = 10.0) -> float:
    """주어진 밑(base)으로 value의 로그를 계산한다. 유효하지 않은 입력에 대해 DomainError 발생."""
    if value <= 0:
        raise DomainError(
            code="DOMAIN_ERROR",
            message=f"Cannot compute logarithm of {value}",
            detail="Logarithm is only defined for positive numbers",
        )
    if base <= 0 or base == 1.0:
        raise DomainError(
            code="DOMAIN_ERROR",
            message=f"Invalid logarithm base: {base}",
            detail="Base must be positive and not equal to 1",
        )
    return math.log(value) / math.log(base)
```

테스트는 다음 구조를 따라야 합니다.

```python
import math
import pytest
from hypothesis import given, strategies as st
from calcengine.engine.errors import DomainError
from calcengine.engine.logarithmic import log_base


def test_log10_of_100() -> None:
    assert log_base(100, 10) == pytest.approx(2.0)


def test_log_of_negative_raises_domain_error() -> None:
    with pytest.raises(DomainError):
        log_base(-5)


@given(st.floats(min_value=1e-300, max_value=1e300, allow_nan=False, allow_infinity=False))
def test_log10_matches_stdlib(x: float) -> None:
    assert log_base(x, 10) == pytest.approx(math.log10(x), rel=1e-14)
```

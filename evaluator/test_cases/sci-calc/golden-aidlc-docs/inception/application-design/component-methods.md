# Component Methods

## 1. Engine — `math_engine.py`

### Arithmetic
- `add(a: float, b: float) -> float`
- `subtract(a: float, b: float) -> float`
- `multiply(a: float, b: float) -> float`
- `divide(a: float, b: float) -> float` — raises DivisionByZeroError
- `modulo(a: float, b: float) -> float` — raises DivisionByZeroError
- `absolute(a: float) -> float`
- `negate(a: float) -> float`

### Powers
- `power(base: float, exponent: float) -> float` — raises OverflowError
- `sqrt(a: float) -> float` — raises DomainError if a < 0
- `cbrt(a: float) -> float`
- `square(a: float) -> float`
- `nth_root(a: float, n: int) -> float` — raises DomainError if a < 0 and n even

### Trigonometry
- `sin(a: float, angle_unit: str) -> float`
- `cos(a: float, angle_unit: str) -> float`
- `tan(a: float, angle_unit: str) -> float`
- `asin(a: float, angle_unit: str) -> float` — raises DomainError if |a| > 1
- `acos(a: float, angle_unit: str) -> float` — raises DomainError if |a| > 1
- `atan(a: float, angle_unit: str) -> float`
- `atan2(y: float, x: float, angle_unit: str) -> float`
- `sinh(a: float) -> float`
- `cosh(a: float) -> float`
- `tanh(a: float) -> float`
- `asinh(a: float) -> float`
- `acosh(a: float) -> float` — raises DomainError if a < 1
- `atanh(a: float) -> float` — raises DomainError if |a| >= 1

### Logarithmic
- `ln(a: float) -> float` — raises DomainError if a <= 0
- `log10(a: float) -> float` — raises DomainError if a <= 0
- `log2(a: float) -> float` — raises DomainError if a <= 0
- `log(a: float, base: float) -> float` — raises DomainError
- `exp(a: float) -> float` — raises OverflowError

### Statistics
- `mean(values: list[float]) -> float`
- `median(values: list[float]) -> float`
- `mode(values: list[float]) -> float` — returns smallest on ties
- `stdev(values: list[float]) -> float` — requires len >= 2
- `variance(values: list[float]) -> float` — requires len >= 2
- `pstdev(values: list[float]) -> float`
- `pvariance(values: list[float]) -> float`
- `min_val(values: list[float]) -> float`
- `max_val(values: list[float]) -> float`
- `sum_val(values: list[float]) -> float`
- `count(values: list[float]) -> int`

### Constants
- `get_constant(name: str) -> float`
- `get_all_constants() -> dict[str, float]`

### Conversions
- `convert_angle(value: float, from_unit: str, to_unit: str) -> float`
- `convert_temperature(value: float, from_unit: str, to_unit: str) -> float`
- `convert_length(value: float, from_unit: str, to_unit: str) -> float`
- `convert_weight(value: float, from_unit: str, to_unit: str) -> float`

## 2. Models — `requests.py`

### Request Models
- `BinaryOperationRequest(a: float, b: float)` — with NaN validator
- `UnaryOperationRequest(a: float)` — with NaN validator
- `PowerRequest(base: float, exponent: float)` — with NaN validator
- `NthRootRequest(a: float, n: int)` — with NaN validator
- `TrigRequest(a: float, angle_unit: str = "radians")` — with NaN validator
- `Atan2Request(y: float, x: float, angle_unit: str = "radians")` — with NaN validator
- `LogRequest(a: float, base: float)` — with NaN validator
- `StatisticsRequest(values: list[float])` — with NaN validator
- `ConversionRequest(value: float, from_unit: str, to_unit: str)` — with NaN validator

## 3. Models — `responses.py`

### Response Models
- `SuccessResponse(status: str, operation: str, inputs: dict, result: Any)`
- `ErrorDetail(code: str, message: str)`
- `ErrorResponse(status: str, operation: str, inputs: dict, error: ErrorDetail)`

## 4. Routes — Each route module
- One `APIRouter` per module with URL prefix
- Route functions: parse request → call engine → return SuccessResponse or ErrorResponse
- Exception handlers catch engine exceptions and map to error codes

# Component Methods

## math_engine.py

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
- `nth_root(a: float, n: int) -> float` — raises DomainError if a < 0 and n is even

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
- `log(a: float, base: float) -> float` — raises DomainError if a <= 0 or base <= 0 or base == 1
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
- `get_constant(name: str) -> float` — raises KeyError if unknown
- `get_all_constants() -> dict[str, float]`

### Conversions
- `convert_angle(value: float, from_unit: str, to_unit: str) -> float`
- `convert_temperature(value: float, from_unit: str, to_unit: str) -> float`
- `convert_length(value: float, from_unit: str, to_unit: str) -> float`
- `convert_weight(value: float, from_unit: str, to_unit: str) -> float`

## Custom Exceptions (in math_engine.py or a shared exceptions module)
- `DomainError(message: str)` — input outside mathematical domain
- `DivisionByZeroError(message: str)` — division/modulo by zero
- `OverflowError` — result exceeds representable range (re-use Python builtin)

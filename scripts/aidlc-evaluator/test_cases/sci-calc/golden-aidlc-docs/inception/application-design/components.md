# Components

## 1. Application Entry Point — `sci_calc/app.py`
**Purpose**: FastAPI application factory, middleware, error handlers, router registration.
**Responsibilities**:
- Create FastAPI app instance with metadata (title, version)
- Register all route modules
- Override default validation error handler to use standard error envelope
- Register global exception handlers (catch-all for unexpected errors)
- Health check endpoint

## 2. Routes Layer — `sci_calc/routes/`

### 2.1 `arithmetic.py`
**Purpose**: Handle arithmetic operation requests.
**Responsibilities**: Parse input, delegate to engine, wrap results in success/error envelope.

### 2.2 `powers.py`
**Purpose**: Handle power and root operation requests.
**Responsibilities**: Parse input, validate domain constraints, delegate to engine.

### 2.3 `trigonometry.py`
**Purpose**: Handle trigonometric operation requests.
**Responsibilities**: Parse input, handle angle_unit conversion, delegate to engine.

### 2.4 `logarithmic.py`
**Purpose**: Handle logarithmic operation requests.
**Responsibilities**: Parse input, validate domain constraints, delegate to engine.

### 2.5 `statistics.py`
**Purpose**: Handle statistical operation requests.
**Responsibilities**: Parse input, validate list size constraints, delegate to engine.

### 2.6 `constants.py`
**Purpose**: Serve mathematical constants.
**Responsibilities**: Return individual or all constants.

### 2.7 `conversions.py`
**Purpose**: Handle unit conversion requests.
**Responsibilities**: Parse input, validate units, delegate to engine.

## 3. Models Layer — `sci_calc/models/`

### 3.1 `requests.py`
**Purpose**: Pydantic v2 request models for all operations.
**Responsibilities**: Input validation via Pydantic, type coercion, NaN rejection.

### 3.2 `responses.py`
**Purpose**: Pydantic v2 response models (success and error envelopes).
**Responsibilities**: Define standard response structure, error codes enum.

## 4. Engine Layer — `sci_calc/engine/`

### 4.1 `math_engine.py`
**Purpose**: Pure computation logic — no HTTP/FastAPI dependencies.
**Responsibilities**:
- Arithmetic operations (add, subtract, multiply, divide, modulo, abs, negate)
- Power operations (power, sqrt, cbrt, square, nth_root)
- Trigonometric operations (all 14 trig functions with angle unit support)
- Logarithmic operations (ln, log10, log2, log, exp)
- Statistical operations (mean, median, mode, stdev, variance, etc.)
- Constants retrieval
- Unit conversions (angle, temperature, length, weight)
- Raise domain-specific exceptions (DomainError, DivisionByZeroError, OverflowError)

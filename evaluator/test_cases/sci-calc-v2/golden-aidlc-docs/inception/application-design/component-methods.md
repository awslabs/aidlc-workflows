# Component Methods

## MathEngine

### Arithmetic

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| add | a: Number, b: Number | Number | None | result = a + b |
| subtract | a: Number, b: Number | Number | None | result = a - b |
| multiply | a: Number, b: Number | Number | None | result = a * b |
| divide | a: Number, b: Number | Number | b ≠ 0 | result = a / b |
| modulo | a: Number, b: Number | Number | b ≠ 0 | result = a % b |
| abs | a: Number | Number | None | result = |a| |
| negate | a: Number | Number | None | result = -a |

### Powers and Roots

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| power | base: Number, exponent: Number | Number | None | result = base^exponent |
| sqrt | a: Number | Number | a >= 0 | result = √a |
| cbrt | a: Number | Number | None | result = ∛a |
| square | a: Number | Number | None | result = a² |
| nth_root | a: Number, n: Integer | Number | n ≠ 0; if n is even then a >= 0 | result = a^(1/n) |

### Trigonometry

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| sin | a: Number, angle_unit: AngleUnit | Number | None | result = sin(a) |
| cos | a: Number, angle_unit: AngleUnit | Number | None | result = cos(a) |
| tan | a: Number, angle_unit: AngleUnit | Number | None | result = tan(a) |
| asin | a: Number, angle_unit: AngleUnit | Number | -1 <= a <= 1 | result = arcsin(a) |
| acos | a: Number, angle_unit: AngleUnit | Number | -1 <= a <= 1 | result = arccos(a) |
| atan | a: Number, angle_unit: AngleUnit | Number | None | result = arctan(a) |
| atan2 | y: Number, x: Number, angle_unit: AngleUnit | Number | None | result = atan2(y, x) |
| sinh | a: Number | Number | None | result = sinh(a) |
| cosh | a: Number | Number | None | result = cosh(a) |
| tanh | a: Number | Number | None | result = tanh(a) |
| asinh | a: Number | Number | None | result = asinh(a) |
| acosh | a: Number | Number | a >= 1 | result = acosh(a) |
| atanh | a: Number | Number | -1 < a < 1 | result = atanh(a) |

### Logarithmic

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| ln | a: Number | Number | a > 0 | result = ln(a) |
| log10 | a: Number | Number | a > 0 | result = log10(a) |
| log2 | a: Number | Number | a > 0 | result = log2(a) |
| log | a: Number, base: Number | Number | a > 0, base > 0, base ≠ 1 | result = log_base(a) |
| exp | a: Number | Number | None | result = e^a |

### Statistics

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| mean | values: List[Number] | Number | len(values) >= 1 | result = arithmetic mean |
| median | values: List[Number] | Number | len(values) >= 1 | result = middle value |
| mode | values: List[Number] | Number | len(values) >= 1 | result = most frequent (smallest on tie) |
| stdev | values: List[Number] | Number | len(values) >= 2 | result = sample standard deviation |
| variance | values: List[Number] | Number | len(values) >= 2 | result = sample variance |
| pstdev | values: List[Number] | Number | len(values) >= 1 | result = population standard deviation |
| pvariance | values: List[Number] | Number | len(values) >= 1 | result = population variance |
| min | values: List[Number] | Number | len(values) >= 1 | result = minimum value |
| max | values: List[Number] | Number | len(values) >= 1 | result = maximum value |
| sum | values: List[Number] | Number | len(values) >= 1 | result = sum of values |
| count | values: List[Number] | Integer | len(values) >= 1 | result = len(values) |

### Constants

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| get_constant | name: String | Number | name is a known constant | result = constant value |
| get_all_constants | (none) | Map[String, Number] | None | result = all constant name-value pairs |

### Conversions

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| convert_angle | value: Number, from_unit: AngleUnit, to_unit: AngleUnit | Number | from_unit and to_unit are valid | result = converted value |
| convert_temperature | value: Number, from_unit: TempUnit, to_unit: TempUnit | Number | from_unit and to_unit are valid | result = converted value |
| convert_length | value: Number, from_unit: LengthUnit, to_unit: LengthUnit | Number | from_unit and to_unit are valid | result = converted value |
| convert_weight | value: Number, from_unit: WeightUnit, to_unit: WeightUnit | Number | from_unit and to_unit are valid | result = converted value |

## Router

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| health_check | (none) | HealthResponse | None | Returns status ok with version |
| arithmetic_operation | operation: String, body: ArithmeticRequest | SuccessResponse | operation is valid | Delegates to MathEngine, wraps result |
| powers_operation | operation: String, body: PowersRequest | SuccessResponse | operation is valid | Delegates to MathEngine, wraps result |
| trigonometry_operation | operation: String, body: TrigRequest | SuccessResponse | operation is valid | Delegates to MathEngine, wraps result |
| logarithmic_operation | operation: String, body: LogRequest | SuccessResponse | operation is valid | Delegates to MathEngine, wraps result |
| statistics_operation | operation: String, body: StatsRequest | SuccessResponse | operation is valid | Delegates to MathEngine, wraps result |
| get_constant | name: String | SuccessResponse | None | Delegates to MathEngine, wraps result |
| get_all_constants | (none) | SuccessResponse | None | Delegates to MathEngine, wraps result |
| conversions_operation | category: String, body: ConversionRequest | SuccessResponse | category is valid | Delegates to MathEngine, wraps result |

## Models

Models is a type-definition component — it exposes no methods, only data structures (schemas).

## App

| Method | Inputs | Outputs | Preconditions | Postconditions |
|---|---|---|---|---|
| create_app | (none) | Application | None | Application configured with all routers and handlers |

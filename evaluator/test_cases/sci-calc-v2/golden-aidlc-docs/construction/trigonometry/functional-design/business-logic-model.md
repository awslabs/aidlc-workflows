# Business Logic Model — Trigonometry

## Operations (14 total)

### Standard trig (input in angle_unit, output is ratio)
- sin, cos, tan: Convert input to radians if degrees, call math.sin/cos/tan

### Inverse trig (input is ratio, output in angle_unit)
- asin, acos, atan: Call math.asin/acos/atan, convert result to degrees if requested

### Two-argument
- atan2(y, x): Call math.atan2(y, x), convert result to degrees if requested

### Hyperbolic (no angle_unit conversion needed)
- sinh, cosh, tanh, asinh, acosh, atanh

## Angle Conversion
- degrees → radians: value * (math.pi / 180)
- radians → degrees: value * (180 / math.pi)
- Default angle_unit: "radians"

## Domain Constraints
| Function | Constraint | Error |
|----------|-----------|-------|
| asin | -1 <= a <= 1 | DomainError |
| acos | -1 <= a <= 1 | DomainError |
| acosh | a >= 1 | DomainError |
| atanh | -1 < a < 1 | DomainError |

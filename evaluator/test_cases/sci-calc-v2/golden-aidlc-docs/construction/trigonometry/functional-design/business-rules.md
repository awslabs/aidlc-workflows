# Business Rules — Trigonometry

## BR-T1: Default Angle Unit
If angle_unit is omitted, default to "radians".

## BR-T2: Domain Validation
asin/acos inputs outside [-1, 1] → DomainError. acosh input < 1 → DomainError. atanh input outside (-1, 1) → DomainError.

## BR-T3: Angle Conversion Direction
- For sin/cos/tan: INPUT is in angle_unit, convert to radians before computation
- For asin/acos/atan/atan2: OUTPUT is in radians, convert to angle_unit after computation
- For hyperbolic functions: angle_unit is ignored (accepted but not used for conversion)

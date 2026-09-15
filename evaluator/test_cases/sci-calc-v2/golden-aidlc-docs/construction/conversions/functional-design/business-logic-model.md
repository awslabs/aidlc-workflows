# Business Logic Model — Conversions

## Categories and Units

### Angle
- degrees, radians, gradians
- degrees → radians: value * (pi / 180)
- degrees → gradians: value * (10 / 9)
- radians → degrees: value * (180 / pi)
- radians → gradians: value * (200 / pi)
- gradians → degrees: value * (9 / 10)
- gradians → radians: value * (pi / 200)

### Temperature
- celsius, fahrenheit, kelvin
- C → F: value * 9/5 + 32
- C → K: value + 273.15
- F → C: (value - 32) * 5/9
- F → K: (value - 32) * 5/9 + 273.15
- K → C: value - 273.15
- K → F: (value - 273.15) * 9/5 + 32

### Length
- meters, feet, inches, centimeters, millimeters, kilometers, miles, yards
- Base unit: meters (convert to meters first, then to target)

### Weight
- kilograms, pounds, ounces, grams, milligrams, tonnes, stones
- Base unit: kilograms (convert to kg first, then to target)

## Strategy
Convert to base unit (meters/kilograms) then to target unit. Temperature uses direct formulas (not a base-unit pattern).

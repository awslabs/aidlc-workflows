# Domain Entities — Trigonometry

## Request Models
- TrigInput(a: float, angle_unit: str = "radians") — for all single-arg trig
- Atan2Input(y: float, x: float, angle_unit: str = "radians") — for atan2

## Angle Unit Enum
- "radians" | "degrees" (validated by Pydantic)

# Unit of Work Dependencies

## Dependency Graph

```
UoW-01 (Scaffold)
  │
  ├── UoW-02 (Arithmetic)
  ├── UoW-03 (Powers)
  ├── UoW-04 (Trigonometry)
  ├── UoW-05 (Logarithmic)
  ├── UoW-06 (Statistics)
  ├── UoW-07 (Constants)
  └── UoW-08 (Conversions)
```

## Dependency Rules

- **UoW-01** has no dependencies — it creates the project structure and shared infrastructure
- **UoW-02 through UoW-08** all depend on UoW-01 (they need the scaffold, models, and engine skeleton)
- **UoW-02 through UoW-08** are independent of each other (can be implemented in parallel)

## Critical Path

UoW-01 → (UoW-02 | UoW-03 | UoW-04 | UoW-05 | UoW-06 | UoW-07 | UoW-08)

Minimum 2 sequential steps regardless of parallelism.

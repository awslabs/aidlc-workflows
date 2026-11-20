# Risk and Sequencing Rationale

## Sequencing Rationale

1. **Bolt 1 (scaffold) first**: Establishes the project foundation — all subsequent bolts depend on it. Walking skeleton validates that the tech stack works end-to-end.
2. **Remaining bolts sequential**: Each domain module is independent, but sequential execution simplifies verification and avoids merge conflicts. The project is small enough that parallelism provides negligible time savings.
3. **Order (arithmetic → powers → trig → log → stats → constants → conversions)**: From simplest to most complex domain logic, allowing early confidence-building.

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Python 3.13 unavailable | Low | High | Checked at scaffold (Bolt 1) |
| uv not installed | Low | High | Checked at scaffold (Bolt 1) |
| Coverage < 90% | Medium | Medium | Write tests alongside implementation in each bolt |
| Floating-point edge cases | Low | Low | Use known-value test tables from Python math docs |

## No Blocking Risks

All identified risks are mitigated by Bolt 1 (scaffold) validating the environment. No external dependencies, no network requirements, no third-party API keys needed.

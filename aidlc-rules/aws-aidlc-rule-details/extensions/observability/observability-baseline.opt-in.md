# Observability Extension

Structured logging, metrics aligned to customer-facing KPIs, distributed tracing, and alarms — designed to detect, assess, and diagnose customer-impacting issues.

## Question: Observability
Do you want to implement AWS best-practice based observability for this project? This includes structured logging, metrics aligned to customer-facing KPIs, distributed tracing, and alarms — designed to detect, assess, and diagnose customer-impacting issues.

A) Yes — implement AWS best-practice observability rules
B) Yes, with custom rules — implement AWS best-practice rules plus organisation-specific rules defined in observability-custom.md
C) Custom only — implement only organisation-specific rules from observability-custom.md (skip AWS best-practice rules)
D) No — this project does not require observability (suitable for libraries, CLI tools, or non-deployable artifacts)

[Answer]:

## Answer D Behavior

When the user answers D:
- Do NOT load the full rules file (`observability-baseline.md`)
- Do NOT enforce any observability rules — no blocking findings
- Log the decision in `aidlc-docs/audit.md`: "Observability extension skipped — user answered D"
- Record in `aidlc-docs/aidlc-state.md` under Extension Configuration: Observability = Disabled (D)

## Loading Instructions

Based on the user's answer, load the following files:
- **Answer A**: Load `observability-baseline.md` and all `.md` files in `extensions/observability/` EXCEPT `observability-custom.md`
- **Answer B**: Load `observability-baseline.md` and all `.md` files in `extensions/observability/` INCLUDING `observability-custom.md`
- **Answer C**: Load `observability-baseline.md` and ONLY `observability-custom.md` from `extensions/observability/`
- **Answer D**: Do not load any observability rule files

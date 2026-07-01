# Runbooks Extension

Documented, tested, and automated runbooks for operational procedures. Ensures consistent and prompt responses to well-understood events.

## Question: Runbooks
Do you want to implement AWS best-practice runbook rules for this project? This includes documented operational procedures, automated runbook execution, and runbook testing — ensuring consistent and prompt responses to operational events.

A) Yes — implement AWS best-practice runbook rules
B) Yes, with custom rules — implement AWS best-practice rules plus organisation-specific rules defined in runbooks-custom.md
C) Custom only — implement only organisation-specific rules from runbooks-custom.md (skip AWS best-practice rules)
D) No — this project does not require runbooks (suitable for libraries, CLI tools, or non-deployable artifacts)

[Answer]:

## Answer D Behavior

When the user answers D:
- Do NOT load the full rules file (`runbooks-baseline.md`)
- Do NOT enforce any runbook rules — no blocking findings
- Log the decision in `aidlc-docs/audit.md`: "Runbooks extension skipped — user answered D"
- Record in `aidlc-docs/aidlc-state.md` under Extension Configuration: Runbooks = Disabled (D)

## Loading Instructions

Based on the user's answer, load the following files:
- **Answer A**: Load `runbooks-baseline.md` and all `.md` files in `extensions/runbooks/` EXCEPT `runbooks-custom.md`
- **Answer B**: Load `runbooks-baseline.md` and all `.md` files in `extensions/runbooks/` INCLUDING `runbooks-custom.md`
- **Answer C**: Load `runbooks-baseline.md` and ONLY `runbooks-custom.md` from `extensions/runbooks/`
- **Answer D**: Do not load any runbook rule files

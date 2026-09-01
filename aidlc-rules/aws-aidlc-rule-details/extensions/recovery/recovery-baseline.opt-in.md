# Recovery Extension

Recovery controls for fault isolation, automated failover, and resilience testing — ensuring services recover within defined objectives.

## Question: Recovery Extensions

Should recovery extension rules be enforced for this project?

A) Yes — enforce AWS best-practice recovery rules (AIREC-STRAT + extensions/recovery/ rule files, excluding custom)
B) Yes — enforce AWS best-practice recovery rules AND organisation-specific custom rules (all files including recovery-custom.md)
C) Custom only — enforce only organisation-specific custom rules (recovery-custom.md only)
D) No — skip all recovery rules (suitable for PoCs, prototypes, and experimental projects)
X) Other (please describe after [Answer]: tag below)

[Answer]:

## Answer D Behavior

When the user answers D:
- Do NOT load the full rules file (`recovery-baseline.md`)
- Do NOT enforce any recovery rules — no blocking findings
- Log the decision in `aidlc-docs/audit.md`: "Recovery extension skipped — user answered D"
- Record in `aidlc-docs/aidlc-state.md` under Extension Configuration: Recovery = Disabled (D)

## Loading Instructions

Based on the user's answer, load the following files:
- **Answer A**: Load `recovery-baseline.md` and all `.md` files in `extensions/recovery/` EXCEPT `recovery-custom.md`
- **Answer B**: Load `recovery-baseline.md` and all `.md` files in `extensions/recovery/` INCLUDING `recovery-custom.md`
- **Answer C**: Load `recovery-baseline.md` and ONLY `recovery-custom.md` from `extensions/recovery/`
- **Answer D**: Do not load any recovery rule files

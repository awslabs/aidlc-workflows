# Deployment Extension

IaC-driven deployment, phased rollout across fault isolation boundaries, alarm-gated validation, and automatic rollback — ensuring no undetected customer impact from deployments.

## Question: Deployment Extension

Should deployment extension rules be enforced for this project?

A) Yes — enforce AWS best-practice deployment rules
B) Yes — enforce AWS best-practice deployment rules AND organisation-specific custom rules
C) Custom only — enforce only organisation-specific custom rules
D) No — skip all deployment rules (suitable for PoCs, prototypes, and non-deployable artifacts)
X) Other (please describe after [Answer]: tag below)

[Answer]:

## Answer D Behavior

When the user answers D:
- Do NOT load the full rules file (`deployment-baseline.md`)
- Do NOT enforce any deployment rules — no blocking findings
- Log the decision in `aidlc-docs/audit.md`: "Deployment extension skipped — user answered D"
- Record in `aidlc-docs/aidlc-state.md` under Extension Configuration: Deployment = Disabled (D)

## Loading Instructions

Based on the user's answer, load the following files:
- **Answer A**: Load `deployment-baseline.md` and all `.md` files in `extensions/deployment/` EXCEPT `deployment-custom.md`
- **Answer B**: Load `deployment-baseline.md` and all `.md` files in `extensions/deployment/` INCLUDING `deployment-custom.md`
- **Answer C**: Load `deployment-baseline.md` and ONLY `deployment-custom.md` from `extensions/deployment/`
- **Answer D**: Do not load any deployment rule files

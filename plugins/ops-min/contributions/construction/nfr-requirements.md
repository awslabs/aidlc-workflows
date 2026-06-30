---
target: nfr-requirements
bundle: ops-min
adds:
  produces:
    - ops-min-operational-nfr-requirements
  required_sections:
    - "Operational NFRs"
fragments:
  - anchor: after-step:6
    order: 100
---

## fragment: after-step:6

### Step 6b (ops-min): Capture operational NFRs

Beyond the standard NFR categories, capture OPERATIONAL non-functional
requirements for each unit of work: SLOs/SLIs, on-call and alerting signals,
runbook hooks, and deployment-safety constraints. Write them to
`aidlc-docs/construction/{unit-name}/nfr-requirements/ops-min-operational-nfr-requirements.md`
under an `## Operational NFRs` heading. The required-sections sensor enforces
that the `## Operational NFRs` section is present.

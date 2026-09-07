# Operation Phase Guardrails

These rules apply to every stage whose `phase: operation` declaration
imports them as the matching phase rule.

## Infrastructure Safety

- Infrastructure changes require security review — document the security implications of every change
- Never remove or bypass existing security controls without explicit approval and documented rationale
- Changes to IAM roles, network policies, or encryption settings must include a risk assessment

## Deployment Procedures

- All deployment procedures must include rollback steps — document how to reverse every change
- Deployments to production must have a defined smoke test or health check to verify success
- Blue/green or canary strategies must document traffic-shifting criteria and abort conditions

## Observability

- SLOs must be quantified with specific percentages and time windows (e.g., "99.9% availability over a 30-day rolling window")
- Alerting thresholds must be set below SLO breach to allow time for remediation
- Every new service or component must have at least one health metric and one error rate metric

## Incident Response

- Runbooks must include escalation paths and contact information
- Post-incident reviews are required for any P1/P2 incident — document timeline, root cause, and prevention

## Corrections

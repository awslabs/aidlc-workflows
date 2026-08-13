# DevSecOps Pipeline Patterns

Integrating security into every stage of the CI/CD pipeline, shifting detection left and enforcing automated gates.

## Shift-Left Security Principles

- Find vulnerabilities as early as possible: in the IDE, at commit time, and during CI — not after deployment.
- Make security checks fast and non-blocking in early stages (warnings), then enforcing (gates) in later stages.
- Treat security findings like bugs: track, prioritize, and fix them within normal sprint cycles.
- Security is a shared responsibility, not a gatekeeping function. Enable developers with tooling and education.

## SAST — Static Application Security Testing

**Purpose**: Analyse source code for vulnerabilities without executing it.

**Tools**:
- **Amazon CodeGuru Reviewer**: ML-powered code review for Java and Python. Integrates with CodeCommit and GitHub.
- **SonarQube / SonarCloud**: Multi-language static analysis. Covers security, reliability, maintainability.
- **Semgrep**: Lightweight, pattern-based scanning. Fast, supports custom rules, good for enforcing team standards.
- **Bandit** (Python), **ESLint security plugins** (JavaScript/TypeScript).

**Pipeline Integration**:
- Run SAST on every pull request. Report findings as PR comments or annotations.
- Define severity thresholds: block merges on Critical/High findings; warn on Medium.
- Maintain a suppression file for accepted risks (with justification and expiry date).

## DAST — Dynamic Application Security Testing

**Purpose**: Test the running application by sending crafted requests to find runtime vulnerabilities.

- Run against staging or ephemeral environments, not production.
- Tools: OWASP ZAP (open source), Burp Suite (commercial), AWS Inspector for network scanning.
- Integrate into the CD pipeline after deployment to a test environment.
- DAST complements SAST; each catches different vulnerability classes.

## Dependency Vulnerability Scanning

**Purpose**: Detect known CVEs in third-party libraries and transitive dependencies.

**Tools**:
- **Amazon Inspector**: Scans EC2 instances, Lambda functions, and ECR images for software vulnerabilities.
- **Snyk**: Developer-focused, supports npm, pip, Maven, Go modules. Provides fix PRs.
- **Dependabot** (GitHub native): Automated dependency update PRs with vulnerability alerts.
- **npm audit / pip-audit / cargo audit**: Built-in language-level tools for quick local checks.

**Pipeline Integration**:
- Scan on every build. Fail the build on Critical/High severity CVEs with known exploits.
- Generate an SBOM (Software Bill of Materials) using Syft or Trivy for supply chain transparency.
- Review and update dependencies at least monthly; automate with Dependabot or Renovate.

## IaC Security Scanning

**Purpose**: Detect misconfigurations in infrastructure-as-code before deployment.

**Tools**:
- **cfn-lint**: CloudFormation linter. Validates syntax and best practices.
- **cfn-nag**: CloudFormation static analysis. Finds overly permissive IAM policies, unencrypted resources.
- **Checkov**: Multi-framework scanner (CloudFormation, Terraform, CDK, Kubernetes). Policy-as-code with custom rules.
- **cdk-nag**: CDK-native. Checks CDK constructs against AWS Solutions rules and NIST/HIPAA packs.

**Pipeline Integration**:
- Run IaC scanning before `cdk synth` or `cfn deploy`. Fail the pipeline on High findings.
- Use cdk-nag as a CDK Aspect so violations are caught at synthesis time, not after.
- Maintain exception rules in code (not out-of-band) with mandatory justification comments.

## Secret Detection

**Purpose**: Prevent credentials, API keys, and tokens from being committed to source control.

**Tools**:
- **git-secrets** (AWS Labs): Pre-commit hook that blocks patterns matching AWS credentials.
- **truffleHog**: Scans git history for high-entropy strings and known secret patterns.
- **Gitleaks**: Fast, configurable, supports CI and pre-commit. Good default ruleset.
- **GitHub secret scanning**: Built-in for GitHub repos; alerts on committed secrets from known providers.

**Best Practices**:
- Install pre-commit hooks for secret detection on every developer machine.
- Run secret scanning in CI as a backup for missed pre-commit hooks.
- If a secret is committed: revoke immediately, rotate, then clean git history.
- Store secrets in AWS Secrets Manager or SSM Parameter Store, never in code or environment files.

## Container Image Scanning

**Purpose**: Detect OS-level and application-level vulnerabilities in container images.

- **Amazon ECR image scanning**: Basic (Clair-based) and Enhanced (Inspector-powered) scanning.
- **Trivy**: Comprehensive open-source scanner. Covers OS packages, language libraries, and IaC files.
- Scan images on push to ECR and before deployment. Block deployment of images with Critical findings.
- Use minimal base images (distroless, Alpine) to reduce attack surface.
- Rebuild and rescan images weekly to pick up newly disclosed CVEs.

## Security Gates in CI/CD

Define clear pass/fail criteria at each pipeline stage:

| Stage | Gate | Action on Failure |
|-------|------|-------------------|
| Commit | Secret detection | Block commit (pre-commit hook) |
| PR | SAST scan | Block merge on Critical/High |
| Build | Dependency scan | Fail build on Critical with exploit |
| Build | IaC scan | Fail build on High |
| Deploy to staging | DAST scan | Block promotion to production |
| Deploy to prod | Image scan | Block deployment on Critical |
| Post-deploy | Inspector continuous scan | Alert and create ticket |

Automate exceptions with time-boxed waivers that require security team approval and auto-expire.

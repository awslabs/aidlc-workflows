# CI/CD Pipeline Patterns

Patterns for building reliable continuous integration and continuous delivery pipelines.

## CI Pipeline Stages

A well-structured CI pipeline runs these stages in order:

1. **Lint** — Code formatting and style checks (ESLint, Prettier, Ruff, Black). Catch trivial issues before deeper analysis. Fast (< 30 seconds).
2. **Build** — Compile, transpile, or bundle the application. Verify the code produces valid artifacts. For CDK: `cdk synth`.
3. **Unit Test** — Run fast, isolated tests. Target: < 3 minutes. Fail the pipeline on any test failure.
4. **Static Analysis / Security Scan** — SAST, IaC scanning, dependency audit. Report findings; gate on severity thresholds.
5. **Integration Test** — Test against real dependencies (databases, queues) using testcontainers or LocalStack. Target: < 10 minutes.
6. **Package** — Build deployable artifacts: Docker images, Lambda ZIPs, CloudFormation templates. Tag with commit SHA and semantic version.

## CD Pipeline Patterns

### Continuous Delivery
Every commit that passes CI is deployable, but a human triggers the production deployment. Use manual approval gates in CodePipeline or GitHub Actions environments.

### Continuous Deployment
Every commit that passes CI and staging validation deploys to production automatically. Requires high confidence in test coverage and automated rollback.

**Recommendation**: Start with continuous delivery. Graduate to continuous deployment as test maturity and observability improve.

## Branch Strategies

> See `branching-strategies.md` in this directory for the deeper menu aidlc-pipeline-deploy-agent surveys at Bolt-merge dispatch — including diagrams, common problems, AIDLC worktree mapping per strategy, and parallel-Bolts notes for each. The summaries below cover the CI-flow context.

### Trunk-Based Development (Preferred)
- All developers commit to `main` (or short-lived feature branches merged within 1-2 days).
- Feature flags gate incomplete work. No long-lived branches.
- CI runs on every push to main. CD deploys from main.
- Benefits: Fewer merge conflicts, faster feedback, simpler pipeline.

### GitFlow
- `main` (production), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
- Suitable for teams with infrequent releases or strict release management.
- Drawback: Long-lived branches cause painful merges and delayed integration.

### GitHub Flow
- `main` + short-lived feature branches. PRs merge to main.
- Simpler than GitFlow but still relies on branching. Good middle ground.

## Quality Gates

Define explicit pass/fail criteria that block pipeline progression:

| Gate | Criteria | Stage |
|------|----------|-------|
| Lint | Zero lint errors | Pre-build |
| Test coverage | >= 80% line coverage, no decrease | Post-test |
| Security scan | Zero Critical/High findings | Post-scan |
| Integration tests | 100% pass rate | Post-integration |
| Manual approval | Tech lead or product owner sign-off | Pre-production |
| Smoke tests | Critical path tests pass in production | Post-deploy |

## Artifact Management

- **Amazon ECR**: Store Docker images. Use immutable tags (commit SHA), not `latest`.
- **AWS CodeArtifact**: Host npm, pip, Maven packages. Proxy upstream registries for caching and security.
- **S3**: Store Lambda deployment ZIPs, CloudFormation templates, and build outputs.
- Tag every artifact with: commit SHA, build number, branch, timestamp.
- Set lifecycle policies: keep the last 30 tagged images; expire untagged images after 7 days.

## Pipeline as Code

- Define pipelines in version-controlled files, not UI configurations.
- **GitHub Actions**: `.github/workflows/*.yml`. Matrix builds for multi-version testing.
- **AWS CodePipeline + CodeBuild**: `buildspec.yml` for build steps; pipeline defined in CDK or CloudFormation.
- **Reusable workflows**: Extract common steps (lint, test, deploy) into shared workflow templates. Avoid copy-paste across repos.

## Monorepo vs Polyrepo CI Strategies

### Monorepo
- Use path-based triggers: only build/test services whose files changed.
- Tools: Nx, Turborepo, Pants. These understand dependency graphs and skip unchanged packages.
- Shared CI steps (lint, security scan) run once; service-specific steps run conditionally.

### Polyrepo
- Each repo has its own pipeline. Simpler per-repo but harder to coordinate cross-service changes.
- Use contract testing (Pact) to verify compatibility across repos without a monolithic integration test.
- Automate dependency updates across repos with Renovate or a custom bot.

## Pipeline Performance

- Target: commit to production in under 30 minutes (excluding manual approval).
- Parallelize independent stages (lint + unit test, SAST + dependency scan).
- Cache dependencies aggressively (npm cache, pip cache, Docker layer caching).
- Use spot instances or reserved capacity for build workers to reduce cost.
- Monitor pipeline duration as a team metric; alert when it exceeds thresholds.

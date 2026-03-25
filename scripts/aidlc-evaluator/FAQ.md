# AI-DLC Workflows Evaluation & Reporting Framework - FAQ

## What is this?

A comprehensive testing and reporting framework that validates changes to the AI-DLC workflows repository. It automatically evaluates code quality, semantic correctness, and performance to ensure changes don't negatively impact the system.

## Who is this for?

- **Maintainers** who need confidence that changes are safe to merge
- **Contributors** who want to demonstrate their changes improve (or don't harm) the system
- **Users** who depend on consistent, high-quality AI-assisted development workflows

## What are the major work streams?

The framework is organized around six big rocks:

**1. Golden Test Case**
- Curated baseline test cases containing full AIDLC docs and code output
- Versioned reference inputs that all evaluations run against
- Ensures consistent, reproducible evaluation across changes

**2. Execution Framework (Jeff)**
- Core orchestration engine that runs golden test cases through each evaluation
- Manages the pipeline from test case input to structured results output
- Coordinates across all evaluation dimensions

**3. Semantic Evaluation**
- Uses AI to semantically evaluate outputs at major human review points
- Scores outputs for correctness, completeness, and appropriateness
- Validates that AI-generated content meets quality standards
- All semantic metrics are reported **@k** — each evaluation runs multiple trials to account for non-determinism in AI-based grading (see "What does @k mean?" below)

**4. Code Evaluation**
- **Linting:** Code style correctness
- **Security:** Semgrep analysis for vulnerabilities
- **Organization:** Code duplication detection, library usage patterns
- Produces numeric scores (e.g., "3 high-severity security issues")

**5. NFR Evaluation**
- Token consumption per workflow
- Execution time measurements
- Cross-model consistency checks
- Resource utilization metrics

**6. GitHub CI/CD Integration & Management**
- Automated pipelines triggering evaluations on PRs
- Human-readable report generation and attachment
- Versioned report archiving for historical comparison

## How does it work?

1. **Golden test cases** define the reference inputs (AIDLC docs + expected code output)
2. The **execution framework** runs these test cases through each evaluation dimension
3. **Semantic, code, and NFR evaluations** produce structured results
4. **Reports** are generated summarizing impact across all dimensions
5. **GitHub CI/CD** automates the entire pipeline on PRs and attaches reports for review
6. Versioned reports are archived for historical comparison

## What environments are supported?

Kiro is a first-class citizen for testing, but the framework supports multiple AI tools and environments to meet customers where they are.

## What does @k mean for semantic metrics?

AI-based evaluations are non-deterministic — the same input can produce different scores across runs. To get trustworthy results, the framework runs each semantic evaluation multiple times (*k* trials) and reports two complementary metrics (see [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)):

- **pass@k** — The probability of at least one success in *k* attempts. Answers: *"Can this workflow produce a correct result?"* Higher *k* increases the score, since more attempts mean higher odds of at least one success.
- **pass^k** — The probability that *all k* attempts succeed. Answers: *"Does this workflow consistently produce correct results?"* Higher *k* makes this harder to achieve, since every trial must pass.

At *k*=1 the two metrics are identical (both equal the per-trial success rate). As *k* grows they diverge — pass@k approaches 100% while pass^k drops toward 0%. Together they tell you both the capability ceiling and the reliability floor of a workflow change.

Code evaluation and NFR metrics are deterministic and do not require @k.

## How do I interpret the reports?

Reports include:
- **Semantic scores @k:** AI-evaluated ratings with pass@k (capability) and pass^k (reliability)
- **Code scores:** Numeric metrics for linting, security, duplication (deterministic)
- **NFR metrics:** Token usage, execution time, consistency (deterministic)
- **Trend analysis:** Comparison to previous versions (against golden test cases)
- **Pass/fail gates:** Clear indicators of whether changes meet thresholds

## What if my change shows a evaluation?

Evaluations don't automatically block merges—they provide context. Work with maintainers to:
- Understand if the evaluation is acceptable given the benefits
- Identify ways to mitigate the evaluation
- Document known trade-offs

## How does this relate to the AI-DLC workflows repository?

This framework monitors and validates the [AI-DLC workflows](https://github.com/awslabs/aidlc-workflows) to ensure changes maintain or improve quality. It's a testing layer on top of the workflows themselves.

## Can I run tests locally before submitting a PR?

Yes—the framework is designed to run in CI/CD but can also be executed locally to get early feedback.

## How are reports versioned?

Each test run produces a numbered/named version that includes:
- Timestamp and commit SHA
- Full test results
- Comparison to baseline
- Human-readable summary

Reports are stored for historical analysis and trend tracking.

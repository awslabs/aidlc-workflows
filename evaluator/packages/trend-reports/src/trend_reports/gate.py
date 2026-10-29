"""CI regression gate logic."""

from __future__ import annotations

from .models import GateResult, RunData, RunType, TrendData


def check_regressions(trend: TrendData) -> GateResult:
    """Compare the latest data point against the previous release.

    Regression criteria:
    - Contract test pass rate decreased
    - Unit test failures appeared (> 0 when previous had 0)
    - Qualitative overall score decreased by more than 0.02

    If the latest run is an infrastructure failure, the gate passes with
    an annotation — results from infra-failed runs are unreliable.
    """
    latest, previous = find_latest_and_previous(trend)
    if latest is None or previous is None:
        return GateResult(
            passed=True,
            regressions=[],
            latest_label=latest.label if latest else "",
            comparison_label=previous.label if previous else "",
        )

    # If the latest run is an infra failure, skip regression checks
    if latest.infra_failure.is_infra_failure:
        return GateResult(
            passed=True,
            regressions=[],
            latest_label=latest.label,
            comparison_label=previous.label,
            infra_failure_detected=True,
            infra_failure_summary=(
                f"Latest run ({latest.label}) was an infrastructure failure: "
                f"{latest.infra_failure.summary}. "
                "Regression check skipped — results are unreliable."
            ),
        )

    # If the comparison run is an infra failure, find a non-infra alternative
    if previous.infra_failure.is_infra_failure:
        previous = _find_non_infra_previous(trend, latest)
        if previous is None:
            return GateResult(
                passed=True,
                regressions=[],
                latest_label=latest.label,
                comparison_label="",
                infra_failure_detected=True,
                infra_failure_summary=(
                    "No non-infra-failure comparison run available. Regression check skipped."
                ),
            )

    regressions: list[str] = []

    # Contract test regression
    if latest.contract_tests.pass_rate < previous.contract_tests.pass_rate:
        regressions.append(
            f"Contract test pass rate decreased: "
            f"{previous.contract_tests.pass_rate:.1%} → {latest.contract_tests.pass_rate:.1%}"
        )

    # Unit test failures appeared
    if latest.unit_tests.failed > 0 and previous.unit_tests.failed == 0:
        regressions.append(f"Unit test failures appeared: {latest.unit_tests.failed} failures")

    # Qualitative score regression (tolerance: 0.02)
    score_delta = latest.qualitative.overall_score - previous.qualitative.overall_score
    if score_delta < -0.02:
        regressions.append(
            f"Qualitative score regressed: "
            f"{previous.qualitative.overall_score:.3f} → {latest.qualitative.overall_score:.3f} "
            f"(delta: {score_delta:+.3f})"
        )

    return GateResult(
        passed=len(regressions) == 0,
        regressions=regressions,
        latest_label=latest.label,
        comparison_label=previous.label,
    )


def _find_non_infra_previous(trend: TrendData, latest: RunData) -> RunData | None:
    """Find the most recent non-infra-failure run suitable for comparison."""
    candidates = [r for r in trend.runs if r is not latest]

    if latest.run_type == RunType.RELEASE:
        for run in reversed(candidates):
            if run.run_type == RunType.RELEASE and not run.infra_failure.is_infra_failure:
                return run
    else:
        for run in reversed(candidates):
            if run.run_type == RunType.RELEASE and not run.infra_failure.is_infra_failure:
                return run

    # Fallback: any non-infra run
    for run in reversed(candidates):
        if not run.infra_failure.is_infra_failure:
            return run

    return None


def find_latest_and_previous(
    trend: TrendData,
) -> tuple[RunData | None, RunData | None]:
    """Identify the latest data point and the previous release to compare against.

    If the latest is a release, compare to the second-to-last release.
    If the latest is main/PR, compare to the most recent release.
    """
    if len(trend.runs) < 2:
        return (trend.runs[0] if trend.runs else None, None)

    latest = trend.runs[-1]

    if latest.run_type == RunType.RELEASE:
        # Find the previous release
        for run in reversed(trend.runs[:-1]):
            if run.run_type == RunType.RELEASE:
                return latest, run
    else:
        # Latest is main or PR — compare to the most recent release
        for run in reversed(trend.runs):
            if run.run_type == RunType.RELEASE:
                return latest, run

    return latest, trend.runs[-2]

# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""Tests for AgentOrchestrator."""

from concurrent.futures import Future
from unittest.mock import MagicMock, patch

import pytest

from src.design_reviewer.ai_review.models import (
    AgentStatus,
    AlternativesResult,
    AlternativeSuggestion,
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    Severity,
)
from src.design_reviewer.ai_review.orchestrator import AgentOrchestrator
from src.design_reviewer.foundation.exceptions import BedrockAPIError


class MockExecutor:
    """Mock executor that runs tasks immediately (sequential, deterministic)."""

    def __init__(self, max_workers=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def submit(self, fn, *args, **kwargs):
        future = Future()
        try:
            result = fn(*args, **kwargs)
            future.set_result(result)
        except Exception as e:
            future.set_exception(e)
        return future


class TimeoutExecutor:
    """Mock executor that simulates timeout on all tasks."""

    def __init__(self, max_workers=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def submit(self, fn, *args, **kwargs):
        future = Future()
        # Return a future whose .result() raises TimeoutError

        def timeout_result(timeout=None):
            raise TimeoutError(f"Simulated timeout after {timeout}s")

        future.result = timeout_result
        return future


def _make_mock_agent(name, result):
    """Create a mock agent that returns a given result."""
    agent = MagicMock()
    agent.agent_name = name
    agent.execute.return_value = result
    return agent


def _make_failing_agent(name, error):
    """Create a mock agent that raises an error."""
    agent = MagicMock()
    agent.agent_name = name
    agent.execute.side_effect = error
    return agent


@pytest.fixture
def mock_orchestrator_config():
    """Patch ConfigManager for orchestrator construction."""
    mock_config = MagicMock()
    mock_review = MagicMock()
    mock_review.agent_timeout_seconds = 1800
    mock_config.get_review_settings.return_value = mock_review

    with patch(
        "src.design_reviewer.ai_review.orchestrator.ConfigManager.get_instance",
        return_value=mock_config,
    ):
        yield mock_config


class TestTwoPhaseExecution:
    def test_critique_runs_first_then_phase2(
        self, mock_orchestrator_config, sample_design_data
    ):
        critique_result = CritiqueResult(
            findings=[
                CritiqueFinding(
                    title="Issue",
                    severity=Severity.HIGH,
                    description="d",
                    location="l",
                    recommendation="r",
                )
            ]
        )
        alternatives_result = AlternativesResult(
            suggestions=[AlternativeSuggestion(title="Alt", description="d")]
        )
        gap_result = GapAnalysisResult(
            findings=[
                GapFinding(
                    title="Gap",
                    description="d",
                    severity=Severity.MEDIUM,
                    category="Cat",
                    recommendation="r",
                )
            ]
        )

        critique_agent = _make_mock_agent("critique", critique_result)
        alternatives_agent = _make_mock_agent("alternatives", alternatives_result)
        gap_agent = _make_mock_agent("gap", gap_result)

        orch = AgentOrchestrator(
            [critique_agent, alternatives_agent, gap_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert isinstance(result, ReviewResult)
        assert result.critique is not None
        assert len(result.critique.findings) == 1
        assert result.alternatives is not None
        assert len(result.alternatives.suggestions) == 1
        assert result.gaps is not None
        assert len(result.gaps.findings) == 1

    def test_alternatives_receives_critique_result(
        self, mock_orchestrator_config, sample_design_data
    ):
        critique_result = CritiqueResult(
            findings=[
                CritiqueFinding(
                    title="F",
                    severity=Severity.HIGH,
                    description="d",
                    location="l",
                    recommendation="r",
                )
            ]
        )
        alternatives_agent = _make_mock_agent("alternatives", AlternativesResult())

        critique_agent = _make_mock_agent("critique", critique_result)
        orch = AgentOrchestrator(
            [critique_agent, alternatives_agent],
            executor_class=MockExecutor,
        )
        orch.execute_review(sample_design_data)

        # Check that alternatives agent received critique_result as kwarg
        alt_call = alternatives_agent.execute.call_args
        assert alt_call[1].get("critique_result") is not None


class TestDisabledAgents:
    def test_only_critique(self, mock_orchestrator_config, sample_design_data):
        critique_agent = _make_mock_agent("critique", CritiqueResult())

        orch = AgentOrchestrator(
            [critique_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.critique.status == AgentStatus.COMPLETED
        assert result.alternatives.status == AgentStatus.SKIPPED
        assert result.gaps.status == AgentStatus.SKIPPED

    def test_no_agents(self, mock_orchestrator_config, sample_design_data):
        orch = AgentOrchestrator([], executor_class=MockExecutor)
        result = orch.execute_review(sample_design_data)

        assert result.critique.status == AgentStatus.SKIPPED
        assert result.alternatives.status == AgentStatus.SKIPPED
        assert result.gaps.status == AgentStatus.SKIPPED


class TestFailedAgents:
    def test_critique_failure_continues(
        self, mock_orchestrator_config, sample_design_data
    ):
        critique_agent = _make_failing_agent("critique", BedrockAPIError("API down"))
        gap_agent = _make_mock_agent("gap", GapAnalysisResult())

        orch = AgentOrchestrator(
            [critique_agent, gap_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.critique.status == AgentStatus.FAILED
        assert result.critique.error_message is not None
        assert result.gaps.status == AgentStatus.COMPLETED

    def test_phase2_agent_failure_continues(
        self, mock_orchestrator_config, sample_design_data
    ):
        critique_agent = _make_mock_agent("critique", CritiqueResult())
        alternatives_agent = _make_failing_agent(
            "alternatives", BedrockAPIError("timeout")
        )
        gap_agent = _make_mock_agent("gap", GapAnalysisResult())

        orch = AgentOrchestrator(
            [critique_agent, alternatives_agent, gap_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.critique.status == AgentStatus.COMPLETED
        assert result.alternatives.status == AgentStatus.FAILED
        assert result.gaps.status == AgentStatus.COMPLETED


class TestTimeoutHandling:
    def test_phase2_timeout(self, mock_orchestrator_config, sample_design_data):
        critique_agent = _make_mock_agent("critique", CritiqueResult())
        alternatives_agent = MagicMock()
        alternatives_agent.agent_name = "alternatives"
        gap_agent = MagicMock()
        gap_agent.agent_name = "gap"

        orch = AgentOrchestrator(
            [critique_agent, alternatives_agent, gap_agent],
            executor_class=TimeoutExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.alternatives.status == AgentStatus.TIMED_OUT
        assert result.gaps.status == AgentStatus.TIMED_OUT


class TestSummaryGeneration:
    def test_summary_counts(self, mock_orchestrator_config, sample_design_data):
        critique = CritiqueResult(
            findings=[
                CritiqueFinding(
                    title="F1",
                    severity=Severity.CRITICAL,
                    description="d",
                    location="l",
                    recommendation="r",
                ),
                CritiqueFinding(
                    title="F2",
                    severity=Severity.HIGH,
                    description="d",
                    location="l",
                    recommendation="r",
                ),
            ]
        )
        alternatives = AlternativesResult(
            suggestions=[
                AlternativeSuggestion(title="S1", description="d"),
            ]
        )
        gaps = GapAnalysisResult(
            findings=[
                GapFinding(
                    title="G1",
                    description="d",
                    severity=Severity.HIGH,
                    category="C",
                    recommendation="r",
                ),
            ]
        )

        critique_agent = _make_mock_agent("critique", critique)
        alt_agent = _make_mock_agent("alternatives", alternatives)
        gap_agent = _make_mock_agent("gap", gaps)

        orch = AgentOrchestrator(
            [critique_agent, alt_agent, gap_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.summary.total_critique_findings == 2
        assert result.summary.total_alternative_suggestions == 1
        assert result.summary.total_gap_findings == 1
        assert result.summary.severity_counts["critical"] == 1
        assert result.summary.severity_counts["high"] == 2
        assert result.summary.agents_completed == 3
        assert result.summary.agents_failed == 0
        assert result.summary.agents_skipped == 0

    def test_summary_with_failed_agents(
        self, mock_orchestrator_config, sample_design_data
    ):
        critique_agent = _make_mock_agent("critique", CritiqueResult())
        alt_agent = _make_failing_agent("alternatives", BedrockAPIError("fail"))

        orch = AgentOrchestrator(
            [critique_agent, alt_agent],
            executor_class=MockExecutor,
        )
        result = orch.execute_review(sample_design_data)

        assert result.summary.agents_completed == 1
        assert result.summary.agents_failed == 1
        assert result.summary.agents_skipped == 1  # gap skipped

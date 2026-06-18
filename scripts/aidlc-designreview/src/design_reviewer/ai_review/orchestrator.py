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


"""
Agent orchestrator for Unit 4: AI Review.

Manages agent lifecycle, two-phase execution, parallel threads, timeout handling,
and result aggregation.
Patterns: 4.7 (Mockable Parallel Execution), 4.6 (Phase Timing).
Stories: 6.5, 6.7, 6.11.
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor

from ..foundation.config_manager import ConfigManager
from ..foundation.exceptions import BedrockAPIError, ResponseParseError
from ..parsing.models import DesignData
from .base import BaseAgent
from .models import (
    AgentStatus,
    AlternativesResult,
    CritiqueResult,
    GapAnalysisResult,
    ReviewResult,
    ReviewSummary,
)

logger = logging.getLogger("design_reviewer")


class AgentOrchestrator:
    """
    Orchestrates AI review agents with two-phase execution.

    Phase 1: Critique (blocking — alternatives depends on its output).
    Phase 2: Alternatives + Gap Analysis in parallel.
    """

    def __init__(
        self,
        agents: list[BaseAgent],
        executor_class=ThreadPoolExecutor,
    ) -> None:
        self._agents = {agent.agent_name: agent for agent in agents}
        self._executor_class = executor_class

        config_mgr = ConfigManager.get_instance()
        review_settings = config_mgr.get_review_settings()
        self._timeout = getattr(review_settings, "agent_timeout_seconds", 1800)

    def execute_review(self, design_data: DesignData) -> ReviewResult:
        """
        Execute full AI design review.

        Two-phase execution:
        1. Critique agent (blocking)
        2. Alternatives + Gap analysis (parallel)

        Args:
            design_data: Parsed design artifacts from Unit 3.

        Returns:
            ReviewResult with all agent results and summary.
        """
        total_start = time.perf_counter()

        critique_result = self.run_critique(design_data)
        alternatives_result, gap_result, _timings = self.run_phase2(
            design_data, critique_result
        )

        result = self.build_review_result(
            critique_result, alternatives_result, gap_result
        )

        total_elapsed = time.perf_counter() - total_start
        logger.info(
            "Review completed in %.2fs (%d/%d agents completed)",
            total_elapsed,
            result.summary.agents_completed,
            result.summary.agents_completed
            + result.summary.agents_failed
            + result.summary.agents_skipped,
        )

        return result

    def run_critique(self, design_data: DesignData) -> CritiqueResult:
        """Execute critique agent (Phase 1)."""
        phase_start = time.perf_counter()
        result = self._run_critique(design_data)
        logger.info(
            "Review Phase 1 (critique) completed in %.2fs",
            time.perf_counter() - phase_start,
        )
        return result

    def run_phase2(
        self,
        design_data: DesignData,
        critique_result: CritiqueResult,
    ) -> tuple:
        """Execute alternatives and gap agents in parallel (Phase 2).

        Returns:
            Tuple of (alternatives_result, gap_result, agent_timings) where
            agent_timings is a dict mapping agent name to elapsed seconds.
        """
        phase_start = time.perf_counter()
        alternatives_result, gap_result, agent_timings = self._run_phase2(
            design_data, critique_result
        )
        logger.info(
            "Review Phase 2 (alternatives + gap) completed in %.2fs",
            time.perf_counter() - phase_start,
        )
        return alternatives_result, gap_result, agent_timings

    def build_review_result(
        self,
        critique_result: CritiqueResult,
        alternatives_result: AlternativesResult,
        gap_result: GapAnalysisResult,
    ) -> ReviewResult:
        """Aggregate agent results into a ReviewResult."""
        summary = self._build_summary(critique_result, alternatives_result, gap_result)
        return ReviewResult(
            critique=critique_result,
            alternatives=alternatives_result,
            gaps=gap_result,
            summary=summary,
        )

    def _run_critique(self, design_data: DesignData) -> CritiqueResult:
        """Execute critique agent (Phase 1)."""
        critique_agent = self._agents.get("critique")
        if critique_agent is None:
            return self._create_skipped_result("critique", CritiqueResult)

        return self._execute_agent(critique_agent, design_data)

    def _run_phase2(
        self,
        design_data: DesignData,
        critique_result: CritiqueResult,
    ) -> tuple:
        """Execute alternatives and gap agents in parallel (Phase 2).

        Returns:
            Tuple of (alternatives_result, gap_result, agent_timings).
        """
        alternatives_agent = self._agents.get("alternatives")
        gap_agent = self._agents.get("gap")

        # Prepare futures — each wraps _execute_agent_timed for per-agent timing
        futures = {}
        with self._executor_class(max_workers=2) as executor:
            if alternatives_agent is not None:
                futures["alternatives"] = executor.submit(
                    self._execute_agent_timed,
                    alternatives_agent,
                    design_data,
                    critique_result=critique_result,
                )
            if gap_agent is not None:
                futures["gap"] = executor.submit(
                    self._execute_agent_timed,
                    gap_agent,
                    design_data,
                )

            # Collect results with timeout
            alternatives_timed = self._collect_timed_result(
                futures.get("alternatives"),
                "alternatives",
                AlternativesResult,
            )
            gap_timed = self._collect_timed_result(
                futures.get("gap"),
                "gap",
                GapAnalysisResult,
            )

        agent_timings = {}
        alternatives_result, alt_time = alternatives_timed
        gap_result, gap_time = gap_timed
        if alt_time is not None:
            agent_timings["alternatives"] = alt_time
        if gap_time is not None:
            agent_timings["gap"] = gap_time

        return alternatives_result, gap_result, agent_timings

    def _collect_result(self, future, agent_name: str, result_class):
        """Collect a single future result with timeout handling."""
        if future is None:
            return self._create_skipped_result(agent_name, result_class)

        try:
            return future.result(timeout=self._timeout)
        except TimeoutError:
            return self._create_timeout_result(agent_name, result_class)
        except Exception as e:
            logger.error("Unexpected error collecting %s result: %s", agent_name, e)
            return self._create_failed_result(agent_name, str(e), result_class)

    def _execute_agent_timed(self, agent: BaseAgent, design_data: DesignData, **kwargs):
        """Execute a single agent and return (result, elapsed_seconds)."""
        start = time.perf_counter()
        result = self._execute_agent(agent, design_data, **kwargs)
        elapsed = time.perf_counter() - start
        return result, elapsed

    def _collect_timed_result(self, future, agent_name: str, result_class):
        """Collect a timed future result. Returns (result, elapsed_or_None)."""
        if future is None:
            return self._create_skipped_result(agent_name, result_class), None
        try:
            return future.result(timeout=self._timeout)
        except TimeoutError:
            return self._create_timeout_result(agent_name, result_class), None
        except Exception as e:
            logger.error("Unexpected error collecting %s result: %s", agent_name, e)
            return self._create_failed_result(agent_name, str(e), result_class), None

    def _execute_agent(self, agent: BaseAgent, design_data: DesignData, **kwargs):
        """
        Execute a single agent with error catching.

        Returns agent result or a failed result on error.
        """
        try:
            return agent.execute(design_data, **kwargs)
        except BedrockAPIError as e:
            logger.error("Agent '%s' failed: %s", agent.agent_name, e)
            return self._create_failed_result_for_agent(agent.agent_name, str(e))
        except ResponseParseError as e:
            logger.warning("Agent '%s' response parse error: %s", agent.agent_name, e)
            return self._create_failed_result_for_agent(agent.agent_name, str(e))
        except Exception as e:
            logger.error("Agent '%s' unexpected error: %s", agent.agent_name, e)
            return self._create_failed_result_for_agent(agent.agent_name, str(e))

    def _create_failed_result_for_agent(self, agent_name: str, error_msg: str):
        """Create a failed result based on agent name."""
        if agent_name == "critique":
            return CritiqueResult(
                agent_name=agent_name,
                status=AgentStatus.FAILED,
                error_message=error_msg,
            )
        elif agent_name == "alternatives":
            return AlternativesResult(
                agent_name=agent_name,
                status=AgentStatus.FAILED,
                error_message=error_msg,
            )
        else:
            return GapAnalysisResult(
                agent_name=agent_name,
                status=AgentStatus.FAILED,
                error_message=error_msg,
            )

    def _create_failed_result(self, agent_name: str, error_msg: str, result_class):
        """Create a failed result of specific type."""
        kwargs = {
            "agent_name": agent_name,
            "status": AgentStatus.FAILED,
            "error_message": error_msg,
        }
        return result_class(**kwargs)

    def _create_timeout_result(self, agent_name: str, result_class):
        """Create a timed-out result."""
        kwargs = {
            "agent_name": agent_name,
            "status": AgentStatus.TIMED_OUT,
            "error_message": f"Agent timed out after {self._timeout}s",
        }
        return result_class(**kwargs)

    def _create_skipped_result(self, agent_name: str, result_class):
        """Create a skipped result for a disabled agent."""
        logger.info("Agent '%s' skipped (not in agent list)", agent_name)
        kwargs = {
            "agent_name": agent_name,
            "status": AgentStatus.SKIPPED,
        }
        return result_class(**kwargs)

    def _build_summary(
        self,
        critique: CritiqueResult,
        alternatives: AlternativesResult,
        gaps: GapAnalysisResult,
    ) -> ReviewSummary:
        """Generate summary statistics from all agent results."""
        severity_counts: dict[str, int] = {}

        if critique and critique.findings:
            for finding in critique.findings:
                sev = finding.severity.value
                severity_counts[sev] = severity_counts.get(sev, 0) + 1

        if gaps and gaps.findings:
            for finding in gaps.findings:
                sev = finding.severity.value
                severity_counts[sev] = severity_counts.get(sev, 0) + 1

        all_results = [critique, alternatives, gaps]
        agents_completed = sum(
            1 for r in all_results if r and r.status == AgentStatus.COMPLETED
        )
        agents_failed = sum(
            1
            for r in all_results
            if r and r.status in (AgentStatus.FAILED, AgentStatus.TIMED_OUT)
        )
        agents_skipped = sum(
            1 for r in all_results if r and r.status == AgentStatus.SKIPPED
        )

        return ReviewSummary(
            total_critique_findings=len(critique.findings) if critique else 0,
            total_alternative_suggestions=len(alternatives.suggestions)
            if alternatives
            else 0,
            total_gap_findings=len(gaps.findings) if gaps else 0,
            severity_counts=severity_counts,
            agents_completed=agents_completed,
            agents_failed=agents_failed,
            agents_skipped=agents_skipped,
        )

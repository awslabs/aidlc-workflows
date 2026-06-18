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
Unit 4: AI Review — AI-powered design review using Amazon Bedrock.

Public API exports for the ai_review package.
"""

from .models import (
    AgentStatus,
    AlternativesResult,
    AlternativeSuggestion,
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    ReviewSummary,
    Severity,
    TradeOff,
)
from .base import BaseAgent
from .critique import CritiqueAgent
from .alternatives import AlternativesAgent
from .gap import GapAnalysisAgent
from .orchestrator import AgentOrchestrator

__all__ = [
    "Severity",
    "AgentStatus",
    "TradeOff",
    "CritiqueFinding",
    "AlternativeSuggestion",
    "GapFinding",
    "CritiqueResult",
    "AlternativesResult",
    "GapAnalysisResult",
    "ReviewSummary",
    "ReviewResult",
    "BaseAgent",
    "CritiqueAgent",
    "AlternativesAgent",
    "GapAnalysisAgent",
    "AgentOrchestrator",
]

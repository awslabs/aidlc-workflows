"""Automated IDE instrumentation for AIDLC evaluation.

Provides a common adapter interface for driving AIDLC workflows through
IDE-based AI coding assistants (Kiro, Cursor, Cline, CoPilot, Windsurf,
Antigravity) and capturing evaluation-compatible output.
"""

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter
from ide_harness.registry import get_adapter, list_adapters

__all__ = [
    "AdapterConfig",
    "AdapterResult",
    "IDEAdapter",
    "get_adapter",
    "list_adapters",
]

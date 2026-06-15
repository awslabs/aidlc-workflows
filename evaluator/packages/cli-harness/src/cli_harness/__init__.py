"""CLI-based harness for testing AIDLC workflows via kiro-cli.

Provides a common adapter interface for driving AIDLC workflows through
CLI-based AI coding assistants and capturing evaluation-compatible output.
"""

from cli_harness.adapter import AdapterConfig, AdapterResult, CLIAdapter
from cli_harness.registry import get_adapter, list_adapters

__all__ = [
    "AdapterConfig",
    "AdapterResult",
    "CLIAdapter",
    "get_adapter",
    "list_adapters",
]

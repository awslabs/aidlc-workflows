"""Progress reporting for AIDLC Runner — callback handlers and swarm hooks."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from strands.hooks.events import AfterNodeCallEvent, BeforeNodeCallEvent
from strands.hooks.registry import HookRegistry

if TYPE_CHECKING:
    from aidlc_runner.metrics import MetricsCollector

# Error event keys in the Bedrock streaming response that we track.
_ERROR_EVENT_KEYS = {
    "throttlingException": "throttle",
    "modelStreamErrorException": "model_error",
    "internalServerException": "model_error",
    "serviceUnavailableException": "service_unavailable",
    "validationException": "validation_error",
}


class AgentProgressHandler:
    """Callback handler that prints concise tool-use progress to stderr.

    Shows which tools each agent is invoking (e.g. load_rule, write_file)
    without streaming the full LLM text output.

    Optionally records error/retry events to a MetricsCollector.
    """

    def __init__(
        self,
        agent_name: str,
        collector: MetricsCollector | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.tool_count = 0
        self._collector = collector

    def __call__(self, **kwargs: Any) -> None:
        event = kwargs.get("event")
        if not event:
            return

        # Tool start events
        if "contentBlockStart" in event:
            start = event["contentBlockStart"].get("start", {})
            if "toolUse" in start:
                tool_name = start["toolUse"].get("name", "unknown")
                self.tool_count += 1
                _print_status(f"  [{self.agent_name}] tool #{self.tool_count}: {tool_name}")

        # Tool input — show key details for important tools
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            if "toolUse" in delta:
                # We could parse partial JSON here for file paths, but
                # the tool result event is more reliable. Keep it simple.
                pass

        # Metadata event — capture per-invocation context size (input tokens)
        if "metadata" in event and self._collector is not None:
            usage = event["metadata"].get("usage", {})
            input_tokens = usage.get("inputTokens", 0)
            if input_tokens > 0:
                self._collector.record_context_sample(self.agent_name, input_tokens)

        # Error/retry event detection
        if self._collector is not None:
            for event_key, error_type in _ERROR_EVENT_KEYS.items():
                if event_key in event:
                    detail = event[event_key]
                    message = detail.get("message", "") if isinstance(detail, dict) else str(detail)
                    self._collector.record_error(
                        error_type,
                        f"[{self.agent_name}] {event_key}: {message}",
                    )


class SwarmProgressHook:
    """Hook provider that prints node start/stop and timing to stderr.

    Optionally records per-handoff durations to a MetricsCollector.
    """

    def __init__(self, collector: MetricsCollector | None = None) -> None:
        self._node_start_times: dict[str, float] = {}
        self._handoff_count = 0
        self._collector = collector

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeNodeCallEvent, self._on_before_node)
        registry.add_callback(AfterNodeCallEvent, self._on_after_node)

    def _on_before_node(self, event: BeforeNodeCallEvent) -> None:
        self._handoff_count += 1
        self._node_start_times[event.node_id] = time.monotonic()
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        _print_status(f"\n[{ts}] === Handoff #{self._handoff_count}: {event.node_id} starting ===")

    def _on_after_node(self, event: AfterNodeCallEvent) -> None:
        duration_ms = 0
        start = self._node_start_times.pop(event.node_id, None)
        if start is not None:
            duration_ms = int((time.monotonic() - start) * 1000)
            mins, secs_rem = divmod(duration_ms // 1000, 60)
            elapsed = f" ({mins}m {secs_rem}s)"
        else:
            elapsed = ""

        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        _print_status(f"[{ts}] === {event.node_id} finished{elapsed} ===")

        if self._collector is not None:
            self._collector.record_handoff(self._handoff_count, event.node_id, duration_ms)


class ProcessCheckerHook:
    """Runs aidlc-process-checker.js after every builder or validator handoff.

    Enforces the v2 state machine deterministically, mirroring what the
    process-check-hook.json does in the Kiro environment.

    Only active when Node.js is available and the v2 src/ layout is in use.
    Silently skips if Node.js is absent (falls back to EVAL-001 behaviour).
    """

    # Only run after these agents — orchestrator and simulator don't need checking
    _CHECKED_AGENTS = frozenset({"builder", "validator"})

    def __init__(self, run_folder: Path, rules_dir: Path) -> None:
        self._run_folder = run_folder
        self._rules_dir = rules_dir
        self._node = shutil.which("node")
        self._checker = rules_dir / "aidlc-common" / "scripts" / "aidlc-process-checker.js"
        if self._node:
            _print_status(f"  [process-checker] node found at {self._node}")
        else:
            _print_status(
                "  [process-checker] node not found — process_checker disabled (EVAL-001)"
            )

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(AfterNodeCallEvent, self._on_after_node)

    def _on_after_node(self, event: AfterNodeCallEvent) -> None:
        if event.node_id not in self._CHECKED_AGENTS:
            return
        if not self._node or not self._checker.exists():
            return

        # Find the most recent process-checkpoint.json in the run folder
        checkpoints = sorted(self._run_folder.rglob("process-checkpoint.json"))
        if not checkpoints:
            return

        checkpoint = checkpoints[-1]
        try:
            # nosec B603, B607 - Executing trusted process_checker.js from AIDLC rules
            result = subprocess.run(
                [self._node, str(self._checker), "--from-state", str(checkpoint)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            try:
                data = json.loads(result.stdout)
            except json.JSONDecodeError:
                _print_status(f"  [process-checker] non-JSON output: {result.stdout[:200]}")
                return

            error = data.get("error")
            next_step = data.get("next", {}).get("step", "?")
            current = data.get("current", {})

            if error:
                _print_status(
                    f"  [process-checker] FAIL after {event.node_id}: "
                    f"{error.get('message', '?')} — action: {error.get('action', '?')}"
                )
            else:
                _print_status(
                    f"  [process-checker] PASS after {event.node_id}: "
                    f"{current.get('skill', '?')} {current.get('step', '?')} → next: {next_step}"
                )
        except subprocess.TimeoutExpired:
            _print_status("  [process-checker] timed out")
        except Exception as exc:
            _print_status(f"  [process-checker] error: {exc}")


def _print_status(msg: str) -> None:
    """Print a status message to stderr so it doesn't mix with agent output."""
    print(msg, file=sys.stderr, flush=True)

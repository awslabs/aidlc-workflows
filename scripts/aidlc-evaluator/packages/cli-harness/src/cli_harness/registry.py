"""Adapter registry — discover and instantiate CLI adapters by name."""

from __future__ import annotations

from cli_harness.adapter import CLIAdapter


# Lazy imports to avoid pulling in adapter-specific deps at import time
_ADAPTER_MAP: dict[str, str] = {
    "kiro-cli": "cli_harness.adapters.kiro_cli.KiroCLIAdapter",
    "claude-code": "cli_harness.adapters.claude_code.ClaudeCodeAdapter",
}


def list_adapters() -> list[str]:
    """Return sorted list of registered adapter names."""
    return sorted(_ADAPTER_MAP.keys())


def get_adapter(name: str) -> CLIAdapter:
    """Instantiate an adapter by name.

    Raises KeyError if the adapter is not registered.
    Raises ImportError if the adapter module cannot be loaded.
    """
    key = name.lower().strip()
    if key not in _ADAPTER_MAP:
        raise KeyError(
            f"Unknown adapter '{name}'. Available: {', '.join(list_adapters())}"
        )

    fqn = _ADAPTER_MAP[key]
    module_path, class_name = fqn.rsplit(".", 1)

    import importlib
    # nosemgrep: non-literal-import - module_path validated against _ADAPTER_MAP whitelist
    module = importlib.import_module(module_path)
    cls = getattr(module, class_name)
    return cls()

"""Adapter registry — discover and instantiate IDE adapters by name."""

from __future__ import annotations

from ide_harness.adapter import IDEAdapter


# Lazy imports to avoid pulling in adapter-specific deps at import time
_ADAPTER_MAP: dict[str, str] = {
    "kiro": "ide_harness.adapters.kiro.KiroAdapter",
    "cursor": "ide_harness.adapters.cursor.CursorAdapter",
    "cline": "ide_harness.adapters.cline.ClineAdapter",
    "copilot": "ide_harness.adapters.copilot.CopilotAdapter",
    "windsurf": "ide_harness.adapters.windsurf.WindsurfAdapter",
    "antigravity": "ide_harness.adapters.antigravity.AntigravityAdapter",
}


def list_adapters() -> list[str]:
    """Return sorted list of registered adapter names."""
    return sorted(_ADAPTER_MAP.keys())


def get_adapter(name: str) -> IDEAdapter:
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

"""YAML data export for trend data (machine-readable output for CI gates)."""

from __future__ import annotations

import dataclasses
from enum import Enum

import yaml

from .models import SemVer, TrendData


def render_trend_yaml(trend: TrendData) -> str:
    """Serialize TrendData to a YAML string."""
    data = _serialize(trend)
    return yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True)


def _serialize(obj: object) -> object:
    """Recursively convert dataclasses, enums, and custom types to plain dicts."""
    if isinstance(obj, SemVer):
        return str(obj)
    if isinstance(obj, Enum):
        return obj.value
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _serialize(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, list):
        return [_serialize(item) for item in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    return obj

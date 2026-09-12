"""ASCII sparkline and formatting utilities."""

from __future__ import annotations

SPARK_CHARS = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float | int]) -> str:
    """Generate an ASCII sparkline from numeric values.

    >>> sparkline([1, 5, 3, 7, 2])
    '▁▆▃█▂'
    """
    if not values:
        return ""
    lo = min(values)
    hi = max(values)
    if hi == lo:
        mid = len(SPARK_CHARS) // 2
        return SPARK_CHARS[mid] * len(values)
    span = hi - lo
    return "".join(
        SPARK_CHARS[min(int((v - lo) / span * (len(SPARK_CHARS) - 1)), len(SPARK_CHARS) - 1)]
        for v in values
    )


def trend_arrow(values: list[float | int]) -> str:
    """Return a directional indicator based on first-to-last change.

    Returns one of: ↑ (up >5%), ↗ (up 1-5%), → (flat <1%),
    ↘ (down 1-5%), ↓ (down >5%).
    """
    if len(values) < 2:
        return "→"
    first, last = values[0], values[-1]
    if first == 0:
        return "↑" if last > 0 else "→"
    pct = (last - first) / abs(first)
    if pct > 0.05:
        return "↑"
    if pct > 0.01:
        return "↗"
    if pct < -0.05:
        return "↓"
    if pct < -0.01:
        return "↘"
    return "→"


def format_number(n: float | int) -> str:
    """Human-readable number formatting.

    >>> format_number(9_260_000)
    '9.26M'
    >>> format_number(1446.0)
    '1446.0'
    >>> format_number(0.891)
    '0.891'
    """
    if isinstance(n, float) and n != int(n) and abs(n) < 1000:
        return f"{n:.3f}"
    abs_n = abs(n)
    if abs_n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if abs_n >= 1_000:
        return f"{n / 1_000:.1f}K"
    if isinstance(n, int):
        return str(n)
    return f"{n:.1f}"


def format_seconds_as_minutes(seconds: float) -> str:
    """Format seconds as a minutes string.

    >>> format_seconds_as_minutes(1074.0)
    '17.9m'
    """
    return f"{seconds / 60:.1f}m"


def format_delta(delta: float | int, precision: int = 1) -> str:
    """Format a delta value with sign prefix.

    >>> format_delta(56)
    '+56'
    >>> format_delta(-3)
    '-3'
    >>> format_delta(0.028, precision=3)
    '+0.028'
    """
    if isinstance(delta, int):
        return f"{delta:+d}"
    return f"{delta:+.{precision}f}"


def format_pct(value: float) -> str:
    """Format a 0-1 ratio as a percentage string.

    >>> format_pct(0.965)
    '96.5%'
    """
    return f"{value * 100:.1f}%"

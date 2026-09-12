"""Pytest bootstrap for trend-reports tests.

Adds this directory to ``sys.path`` so the test modules can import the shared
factory helpers via ``from factories import ...`` under pytest's importlib
import mode (where the implicit "conftest on path" behavior does not apply).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

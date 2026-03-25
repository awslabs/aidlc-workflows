#!/usr/bin/env python3
"""Generate trend report across AIDLC rules releases.

This script is invoked by run.py and delegates to the trend_reports package.

Usage:
    python run_trend_report.py --baseline test_cases/sci-calc/golden.yaml
    python run_trend_report.py --baseline test_cases/sci-calc/golden.yaml --format html --gate
"""

from __future__ import annotations

import subprocess
import sys


def main() -> None:
    cmd = [sys.executable, "-m", "trend_reports", "trend"] + sys.argv[1:]
    # nosec B603 - Executing trusted framework package
    # nosemgrep: dangerous-subprocess-use-audit
    result = subprocess.run(cmd)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()

"""Safe I/O helpers for the AIDLC evaluation framework."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import yaml


def atomic_yaml_dump(data: object, path: Path | str, **kwargs) -> None:
    """Write *data* as YAML to *path* atomically.

    Writes to a temporary file in the same directory, then renames it into
    place.  This guarantees that *path* is never left empty or partially
    written if the process is interrupted during ``yaml.dump()``.

    Any extra *kwargs* are forwarded to :func:`yaml.dump`.
    """
    path = Path(path)
    kwargs.setdefault("default_flow_style", False)
    kwargs.setdefault("sort_keys", False)

    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            yaml.dump(data, f, **kwargs)
        os.replace(tmp, path)
    except BaseException:
        # Clean up the temp file on any failure
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

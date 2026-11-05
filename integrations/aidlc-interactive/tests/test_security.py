from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aidlc_interactive.security import resolve_artifact


class SecurityTests(unittest.TestCase):
    def test_artifact_must_be_inside_aidlc_docs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            outside = workspace / "plan.md"
            outside.write_text("# Plan\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "aidlc-docs"):
                resolve_artifact(workspace, Path("plan.md"))

    def test_state_and_audit_are_protected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            docs = workspace / "aidlc-docs"
            docs.mkdir()
            for name in ("aidlc-state.md", "audit.md", "AIDLC-STATE.MD", "AUDIT.MD"):
                (docs / name).write_text("# Protected\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "protected"):
                    resolve_artifact(workspace, Path("aidlc-docs") / name)

    def test_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            docs = workspace / "aidlc-docs"
            docs.mkdir(parents=True)
            outside = Path(directory) / "outside.md"
            outside.write_text("# Outside\n", encoding="utf-8")
            link = docs / "link.md"
            try:
                link.symlink_to(outside)
            except OSError:
                self.skipTest("symlinks unavailable")
            with self.assertRaisesRegex(ValueError, "escapes"):
                resolve_artifact(workspace, Path("aidlc-docs/link.md"))


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aidlc_interactive.config import InteractionConfig, load_config, read_config, write_config


class ConfigTests(unittest.TestCase):
    def test_workspace_config_overrides_global(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(root / "config")}, clear=False):
                global_path = root / "config" / "aidlc" / "interaction.yaml"
                write_config(
                    global_path, InteractionConfig(mode="interactive", timeout_seconds=120)
                )
                local = workspace / ".aidlc" / "interaction.local.yaml"
                local.parent.mkdir()
                local.write_text("schema_version: 1\nmode: markdown\n", encoding="utf-8")
                config, sources = load_config(workspace)
            self.assertEqual(config.mode, "markdown")
            self.assertEqual(config.timeout_seconds, 120)
            self.assertEqual(len(sources), 2)

    def test_unknown_configuration_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.yaml"
            path.write_text("command: unsafe\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unknown configuration key"):
                read_config(path)

    def test_checksum_requires_digest(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires a SHA-256"):
            InteractionConfig(verification="checksum").validate()

    def test_integer_configuration_cannot_be_null(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            local = workspace / ".aidlc" / "interaction.local.yaml"
            local.parent.mkdir()
            local.write_text("schema_version: null\n", encoding="utf-8")
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(root / "config")}, clear=False):
                with self.assertRaisesRegex(ValueError, "schema_version must be an integer"):
                    load_config(workspace)

    def test_new_configuration_is_private(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX permissions are not available")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "interaction.yaml"
            write_config(path, InteractionConfig())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

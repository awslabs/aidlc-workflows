# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""Tests for ArtifactScanner — filesystem scan, exclusions, path boundary validation."""

from pathlib import Path
from unittest.mock import MagicMock


from design_reviewer.validation.scanner import (
    ArtifactScanner,
    EXCLUDED_DIRECTORIES,
    EXCLUDED_FILENAMES,
)


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.debug = MagicMock()
    logger.warning = MagicMock()
    return logger


def make_path(path_str: str) -> MagicMock:
    """Create a mock Path with a realistic relative_to and parts."""
    mock = MagicMock(spec=Path)
    real_path = Path(path_str)
    mock.name = real_path.name
    mock.__str__ = lambda self: path_str
    return mock


class TestExcludedConstants:
    def test_excluded_filenames_contains_audit(self):
        assert "audit.md" in EXCLUDED_FILENAMES

    def test_excluded_filenames_contains_state(self):
        assert "aidlc-state.md" in EXCLUDED_FILENAMES

    def test_excluded_filenames_contains_readme(self):
        assert "readme.md" in EXCLUDED_FILENAMES

    def test_excluded_directories_contains_plans(self):
        assert "plans" in EXCLUDED_DIRECTORIES

    def test_excluded_directories_contains_build_and_test(self):
        assert "build-and-test" in EXCLUDED_DIRECTORIES


class TestApplyExclusions:
    def _scanner(self, root: Path = Path("/root/aidlc-docs")) -> ArtifactScanner:
        return ArtifactScanner(root, make_mock_logger())

    def _make_file(self, root: Path, relative: str) -> MagicMock:
        mock = MagicMock(spec=Path)
        rel_path = Path(relative)
        mock.name = rel_path.name
        mock.relative_to = MagicMock(return_value=rel_path)
        return mock

    def test_removes_audit_md(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(root, "audit.md")
        result = scanner._apply_exclusions([f])
        assert result == []

    def test_removes_aidlc_state_md(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(root, "aidlc-state.md")
        result = scanner._apply_exclusions([f])
        assert result == []

    def test_removes_readme_case_insensitive(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        for name in ["README.md", "readme.md", "Readme.md"]:
            f = self._make_file(root, name)
            assert scanner._apply_exclusions([f]) == []

    def test_removes_files_under_plans_directory(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(root, "inception/plans/some-plan.md")
        result = scanner._apply_exclusions([f])
        assert result == []

    def test_removes_files_under_build_and_test_directory(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(root, "construction/build-and-test/instructions.md")
        result = scanner._apply_exclusions([f])
        assert result == []

    def test_keeps_functional_design_artifact(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(
            root,
            "construction/unit1-foundation-config/functional-design/business-logic-model.md",
        )
        result = scanner._apply_exclusions([f])
        assert result == [f]

    def test_keeps_application_design_artifact(self):
        root = Path("/root/aidlc-docs")
        scanner = self._scanner(root)
        f = self._make_file(root, "inception/application-design/components.md")
        result = scanner._apply_exclusions([f])
        assert result == [f]


class TestIsWithinRoot:
    def test_path_within_root_returns_true(self, tmp_path):
        root = tmp_path / "aidlc-docs"
        root.mkdir()
        child = root / "inception" / "components.md"
        child.parent.mkdir(parents=True)
        child.touch()
        scanner = ArtifactScanner(root, make_mock_logger())
        assert scanner._is_within_root(child) is True

    def test_path_outside_root_returns_false(self, tmp_path):
        root = tmp_path / "aidlc-docs"
        root.mkdir()
        outside = tmp_path / "other-dir" / "file.md"
        outside.parent.mkdir(parents=True)
        outside.touch()
        scanner = ArtifactScanner(root, make_mock_logger())
        assert scanner._is_within_root(outside) is False

    def test_broken_path_returns_false(self):
        root = Path("/nonexistent/root")
        scanner = ArtifactScanner(root, make_mock_logger())
        broken = MagicMock(spec=Path)
        broken.resolve.side_effect = OSError("broken symlink")
        assert scanner._is_within_root(broken) is False


class TestReadExcerpt:
    def test_returns_first_100_lines(self, tmp_path):
        f = tmp_path / "test.md"
        lines = [f"line {i}\n" for i in range(200)]
        f.write_text("".join(lines), encoding="utf-8")
        scanner = ArtifactScanner(tmp_path, make_mock_logger())
        excerpt = scanner._read_excerpt(f)
        result_lines = excerpt.splitlines()
        assert len(result_lines) == 100
        assert result_lines[0] == "line 0"
        assert result_lines[99] == "line 99"

    def test_returns_full_content_for_short_file(self, tmp_path):
        f = tmp_path / "short.md"
        f.write_text("# Header\nContent\n", encoding="utf-8")
        scanner = ArtifactScanner(tmp_path, make_mock_logger())
        excerpt = scanner._read_excerpt(f)
        assert "# Header" in excerpt

    def test_returns_empty_string_on_oserror(self):
        root = Path("/fake/root")
        scanner = ArtifactScanner(root, make_mock_logger())
        broken = MagicMock(spec=Path)
        broken.open.side_effect = OSError("permission denied")
        result = scanner._read_excerpt(broken)
        assert result == ""


class TestScan:
    def test_scan_returns_candidates_excluding_filtered(self, tmp_path):
        root = tmp_path / "aidlc-docs"
        root.mkdir()
        (root / "aidlc-state.md").write_text("sentinel", encoding="utf-8")
        design_dir = root / "inception" / "application-design"
        design_dir.mkdir(parents=True)
        (design_dir / "components.md").write_text(
            "# Application Design\n", encoding="utf-8"
        )
        plans_dir = root / "inception" / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "plan.md").write_text("# Plan\n", encoding="utf-8")

        scanner = ArtifactScanner(root, make_mock_logger())
        results = scanner.scan()
        paths = [p for p, _ in results]
        assert any("components.md" in str(p) for p in paths)
        assert not any("aidlc-state.md" in str(p) for p in paths)
        assert not any("plan.md" in str(p) for p in paths)

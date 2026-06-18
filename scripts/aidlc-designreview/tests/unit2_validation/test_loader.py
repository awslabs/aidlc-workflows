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


"""Tests for ArtifactLoader — eager loading, encoding fallback, credential scrubbing."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from design_reviewer.foundation.exceptions import MissingArtifactError
from design_reviewer.validation.loader import ArtifactLoader
from design_reviewer.validation.models import ArtifactInfo, ArtifactType


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    logger.debug = MagicMock()
    return logger


def make_artifact(
    name: str, artifact_type: ArtifactType = ArtifactType.FUNCTIONAL_DESIGN
) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = name
    mock_path.parts = (
        "/aidlc-docs",
        "construction",
        "unit1",
        "functional-design",
        name,
    )
    mock_path.stat.return_value = MagicMock(st_size=100)
    mock_path.__str__ = lambda self: (
        f"/aidlc-docs/construction/unit1/functional-design/{name}"
    )
    return ArtifactInfo.create(mock_path, artifact_type)


def make_loader() -> ArtifactLoader:
    return ArtifactLoader(logger=make_mock_logger())


class TestLoadMultipleArtifacts:
    def test_successful_load_populates_artifact_content(self, tmp_path):
        f = tmp_path / "business-logic.md"
        f.write_text("# Business Logic\nContent here", encoding="utf-8")

        mock_path = MagicMock(spec=Path)
        mock_path.name = "business-logic.md"
        mock_path.parts = (str(tmp_path), "business-logic.md")
        mock_path.stat.return_value = MagicMock(st_size=f.stat().st_size)
        mock_path.read_text.return_value = "# Business Logic\nContent here"
        mock_path.__str__ = lambda self: str(f)

        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_progress = MagicMock()
            mock_pb.return_value.__enter__ = MagicMock(return_value=mock_progress)
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            loaded, path_map = loader.load_multiple_artifacts([artifact])

        assert len(loaded) == 1
        assert loaded[0].content == "# Business Logic\nContent here"

    def test_path_content_map_contains_scrubbed_content(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "file.md"
        mock_path.parts = ("aidlc-docs", "file.md")
        mock_path.stat.return_value = MagicMock(st_size=50)
        mock_path.read_text.return_value = "api_key=SECRET123"

        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                return_value="api_key=***REDACTED***",
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            loaded, path_map = loader.load_multiple_artifacts([artifact])

        assert path_map[mock_path] == "api_key=***REDACTED***"

    def test_artifact_info_content_is_raw_not_scrubbed(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "file.md"
        mock_path.parts = ("aidlc-docs", "file.md")
        mock_path.stat.return_value = MagicMock(st_size=50)
        raw_content = "api_key=SECRET123"
        mock_path.read_text.return_value = raw_content

        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                return_value="***SCRUBBED***",
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            loaded, _ = loader.load_multiple_artifacts([artifact])

        assert loaded[0].content == raw_content  # raw, not scrubbed

    def test_individual_failure_skipped_with_warning(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "bad.md"
        mock_path.parts = ("aidlc-docs", "bad.md")
        mock_path.stat.return_value = MagicMock(st_size=10)
        mock_path.read_text.side_effect = OSError("Permission denied")

        artifact = ArtifactInfo.create(mock_path, ArtifactType.UNKNOWN)
        mock_logger = make_mock_logger()

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = ArtifactLoader(logger=mock_logger)
            with pytest.raises(MissingArtifactError):  # All failed
                loader.load_multiple_artifacts([artifact])

        mock_logger.warning.assert_called()

    def test_all_failure_raises_artifact_load_error(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "bad.md"
        mock_path.parts = ("aidlc-docs", "bad.md")
        mock_path.stat.return_value = MagicMock(st_size=10)
        mock_path.read_text.side_effect = OSError("Disk error")

        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            with pytest.raises(MissingArtifactError) as exc_info:
                loader.load_multiple_artifacts([artifact])

        assert "failed to load" in str(exc_info.value).lower()

    def test_partial_failure_returns_successful_artifacts(self):
        good_path = MagicMock(spec=Path)
        good_path.name = "good.md"
        good_path.parts = ("aidlc-docs", "good.md")
        good_path.stat.return_value = MagicMock(st_size=100)
        good_path.read_text.return_value = "# Good content"

        bad_path = MagicMock(spec=Path)
        bad_path.name = "bad.md"
        bad_path.parts = ("aidlc-docs", "bad.md")
        bad_path.stat.return_value = MagicMock(st_size=10)
        bad_path.read_text.side_effect = OSError("Unreadable")

        good_artifact = ArtifactInfo.create(good_path, ArtifactType.APPLICATION_DESIGN)
        bad_artifact = ArtifactInfo.create(bad_path, ArtifactType.UNKNOWN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            loaded, path_map = loader.load_multiple_artifacts(
                [good_artifact, bad_artifact]
            )

        assert len(loaded) == 1
        assert loaded[0].content == "# Good content"

    def test_progress_bar_called_with_correct_total(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "file.md"
        mock_path.parts = ("aidlc-docs", "file.md")
        mock_path.stat.return_value = MagicMock(st_size=50)
        mock_path.read_text.return_value = "content"

        artifacts = [
            ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)
            for _ in range(3)
        ]

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            loader.load_multiple_artifacts(artifacts)

        mock_pb.assert_called_once_with(total=3, description="Loading design artifacts")

    def test_returns_correct_tuple_types(self):
        mock_path = MagicMock(spec=Path)
        mock_path.name = "file.md"
        mock_path.parts = ("aidlc-docs", "file.md")
        mock_path.stat.return_value = MagicMock(st_size=50)
        mock_path.read_text.return_value = "content"

        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

        with (
            patch(
                "design_reviewer.validation.loader.scrub_credentials",
                side_effect=lambda x: x,
            ),
            patch("design_reviewer.validation.loader.progress_bar") as mock_pb,
        ):
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)

            loader = make_loader()
            result = loader.load_multiple_artifacts([artifact])

        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], list)
        assert isinstance(result[1], dict)

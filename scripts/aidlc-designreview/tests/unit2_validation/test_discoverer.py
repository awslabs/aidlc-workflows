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


"""Tests for ArtifactDiscoverer — facade composing scanner and classifier."""

from pathlib import Path
from unittest.mock import MagicMock


from design_reviewer.validation.discoverer import ArtifactDiscoverer
from design_reviewer.validation.models import ArtifactInfo, ArtifactType


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.debug = MagicMock()
    logger.warning = MagicMock()
    return logger


def make_artifact_info(name: str, artifact_type: ArtifactType) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = name
    mock_path.parts = ("/aidlc-docs", "inception", "application-design", name)
    mock_path.stat.return_value = MagicMock(st_size=100)
    mock_path.__str__ = lambda self: f"/aidlc-docs/inception/application-design/{name}"
    return ArtifactInfo.create(mock_path, artifact_type)


class TestDiscoverArtifacts:
    def test_delegates_to_scanner_then_classifier(self):
        mock_scanner = MagicMock()
        mock_classifier = MagicMock()
        mock_scanner.scan.return_value = [(Path("/fake/file.md"), "content")]
        mock_classifier.classify_all.return_value = [
            make_artifact_info("components.md", ArtifactType.APPLICATION_DESIGN)
        ]

        discoverer = ArtifactDiscoverer(
            mock_scanner, mock_classifier, make_mock_logger()
        )
        discoverer.discover_artifacts()

        mock_scanner.scan.assert_called_once()
        mock_classifier.classify_all.assert_called_once_with(
            mock_scanner.scan.return_value
        )

    def test_returns_classifier_output(self):
        mock_scanner = MagicMock()
        mock_classifier = MagicMock()
        expected = [
            make_artifact_info("components.md", ArtifactType.APPLICATION_DESIGN)
        ]
        mock_scanner.scan.return_value = []
        mock_classifier.classify_all.return_value = expected

        discoverer = ArtifactDiscoverer(
            mock_scanner, mock_classifier, make_mock_logger()
        )
        result = discoverer.discover_artifacts()

        assert result == expected

    def test_empty_discovery_logs_zero(self):
        mock_scanner = MagicMock()
        mock_classifier = MagicMock()
        mock_scanner.scan.return_value = []
        mock_classifier.classify_all.return_value = []
        mock_logger = make_mock_logger()

        discoverer = ArtifactDiscoverer(mock_scanner, mock_classifier, mock_logger)
        discoverer.discover_artifacts()

        mock_logger.info.assert_called()
        log_calls = " ".join(str(c) for c in mock_logger.info.call_args_list)
        assert "0" in log_calls


class TestLogDiscoverySummary:
    def test_logs_each_artifact_with_type(self):
        mock_logger = make_mock_logger()
        discoverer = ArtifactDiscoverer(MagicMock(), MagicMock(), mock_logger)
        artifacts = [
            make_artifact_info("components.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact_info(
                "business-logic-model.md", ArtifactType.FUNCTIONAL_DESIGN
            ),
        ]
        discoverer._log_discovery_summary(artifacts)

        all_calls = " ".join(str(c) for c in mock_logger.info.call_args_list)
        assert "APPLICATION_DESIGN" in all_calls
        assert "FUNCTIONAL_DESIGN" in all_calls
        assert "components.md" in all_calls

    def test_logs_count_summary(self):
        mock_logger = make_mock_logger()
        discoverer = ArtifactDiscoverer(MagicMock(), MagicMock(), mock_logger)
        artifacts = [
            make_artifact_info("components.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact_info("business-logic.md", ArtifactType.FUNCTIONAL_DESIGN),
            make_artifact_info("domain-entities.md", ArtifactType.FUNCTIONAL_DESIGN),
        ]
        discoverer._log_discovery_summary(artifacts)

        summary_calls = [
            str(c) for c in mock_logger.info.call_args_list if "Summary" in str(c)
        ]
        assert len(summary_calls) == 1
        assert "application-design" in summary_calls[0]
        assert "functional-design" in summary_calls[0]

    def test_logs_total_count(self):
        mock_logger = make_mock_logger()
        discoverer = ArtifactDiscoverer(MagicMock(), MagicMock(), mock_logger)
        artifacts = [
            make_artifact_info("file.md", ArtifactType.UNKNOWN) for _ in range(5)
        ]
        discoverer._log_discovery_summary(artifacts)

        first_call = str(mock_logger.info.call_args_list[0])
        assert "5" in first_call

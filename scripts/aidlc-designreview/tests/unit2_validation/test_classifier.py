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


"""Tests for ArtifactClassifier — Bedrock AI classification logic."""

import json
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from design_reviewer.foundation.exceptions import StructureValidationError
from design_reviewer.validation.classifier import ArtifactClassifier
from design_reviewer.validation.models import ArtifactInfo, ArtifactType


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    logger.debug = MagicMock()
    return logger


def make_mock_bedrock_client(response_text: str = "FUNCTIONAL_DESIGN") -> MagicMock:
    """Return a mock boto3 bedrock-runtime client that returns a fixed response."""
    body_bytes = json.dumps({"content": [{"text": response_text}]}).encode("utf-8")
    mock_response = {"body": BytesIO(body_bytes)}
    mock_client = MagicMock()
    mock_client.invoke_model.return_value = mock_response
    return mock_client


def make_classifier(
    client=None, response_text="FUNCTIONAL_DESIGN"
) -> ArtifactClassifier:
    if client is None:
        client = make_mock_bedrock_client(response_text)
    return ArtifactClassifier(
        bedrock_client=client,
        model_id="claude-sonnet-4-6",
        logger=make_mock_logger(),
        max_workers=2,
    )


class TestBuildPrompt:
    def test_prompt_contains_all_artifact_types(self):
        classifier = make_classifier()
        prompt = classifier._build_prompt("# Some content")
        for artifact_type in [
            "APPLICATION_DESIGN",
            "FUNCTIONAL_DESIGN",
            "TECHNICAL_ENVIRONMENT",
            "NFR_DESIGN",
            "NFR_REQUIREMENTS",
            "UNKNOWN",
        ]:
            assert artifact_type in prompt

    def test_prompt_contains_excerpt(self):
        classifier = make_classifier()
        excerpt = "# Business Logic Model\n## Overview"
        prompt = classifier._build_prompt(excerpt)
        assert excerpt in prompt

    def test_prompt_instructs_single_word_response(self):
        classifier = make_classifier()
        prompt = classifier._build_prompt("content")
        assert "ONLY the artifact type name" in prompt


class TestParseResponse:
    @pytest.mark.parametrize(
        "response,expected",
        [
            ("FUNCTIONAL_DESIGN", ArtifactType.FUNCTIONAL_DESIGN),
            ("APPLICATION_DESIGN", ArtifactType.APPLICATION_DESIGN),
            ("TECHNICAL_ENVIRONMENT", ArtifactType.TECHNICAL_ENVIRONMENT),
            ("NFR_DESIGN", ArtifactType.NFR_DESIGN),
            ("NFR_REQUIREMENTS", ArtifactType.NFR_REQUIREMENTS),
            ("UNKNOWN", ArtifactType.UNKNOWN),
            ("functional_design", ArtifactType.FUNCTIONAL_DESIGN),  # lowercase
            ("  FUNCTIONAL_DESIGN  ", ArtifactType.FUNCTIONAL_DESIGN),  # whitespace
        ],
    )
    def test_valid_responses_parsed_correctly(self, response, expected):
        classifier = make_classifier()
        result = classifier._parse_response(response, make_mock_path("/fake/file.md"))
        assert result == expected

    def test_unrecognized_response_raises_structure_validation_error(self):
        classifier = make_classifier()
        with pytest.raises(StructureValidationError) as exc_info:
            classifier._parse_response("INVALID_TYPE", make_mock_path("/fake/file.md"))
        assert "INVALID_TYPE" in str(exc_info.value)


class TestExtractUnitName:
    def test_extracts_unit_name_from_construction_path(self):
        classifier = make_classifier()
        path = Path(
            "/aidlc-docs/construction/unit1-foundation-config/functional-design/business-logic-model.md"
        )
        assert classifier._extract_unit_name(path) == "unit1-foundation-config"

    def test_returns_none_for_inception_path(self):
        classifier = make_classifier()
        path = Path("/aidlc-docs/inception/application-design/components.md")
        assert classifier._extract_unit_name(path) is None

    def test_returns_none_for_root_level_file(self):
        classifier = make_classifier()
        path = Path("/aidlc-docs/technical-environment.md")
        assert classifier._extract_unit_name(path) is None

    def test_extracts_any_unit_name_format(self):
        classifier = make_classifier()
        path = Path("/aidlc-docs/construction/catalog-service/nfr-design/patterns.md")
        assert classifier._extract_unit_name(path) == "catalog-service"


def make_mock_path(path_str: str) -> MagicMock:
    """Create a mock Path that satisfies ArtifactInfo.create() requirements."""
    p = MagicMock(spec=Path)
    real = Path(path_str)
    p.name = real.name
    p.parts = real.parts
    p.stat.return_value = MagicMock(st_size=512)
    p.__str__ = lambda self: path_str
    return p


class TestClassifyOne:
    def test_success_on_first_attempt(self):
        classifier = make_classifier(response_text="APPLICATION_DESIGN")
        result = classifier._classify_one(
            make_mock_path("/aidlc-docs/inception/application-design/components.md"),
            "# Application Design\n",
        )
        assert isinstance(result, ArtifactInfo)
        assert result.artifact_type == ArtifactType.APPLICATION_DESIGN

    def test_retries_once_on_client_error(self):
        mock_client = MagicMock()
        error = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
            "InvokeModel",
        )
        success_response = {
            "body": BytesIO(
                json.dumps({"content": [{"text": "FUNCTIONAL_DESIGN"}]}).encode()
            )
        }
        mock_client.invoke_model.side_effect = [error, success_response]

        classifier = ArtifactClassifier(
            bedrock_client=mock_client,
            model_id="claude-sonnet-4-6",
            logger=make_mock_logger(),
        )
        with patch("design_reviewer.validation.classifier.time.sleep"):
            result = classifier._classify_one(
                make_mock_path(
                    "/aidlc-docs/construction/unit1/functional-design/file.md"
                ),
                "content",
            )
        assert result.artifact_type == ArtifactType.FUNCTIONAL_DESIGN
        assert mock_client.invoke_model.call_count == 2

    def test_raises_structure_validation_error_after_two_failures(self):
        mock_client = MagicMock()
        error = ClientError(
            {"Error": {"Code": "ServiceUnavailableException", "Message": "Down"}},
            "InvokeModel",
        )
        mock_client.invoke_model.side_effect = [error, error]

        classifier = ArtifactClassifier(
            bedrock_client=mock_client,
            model_id="claude-sonnet-4-6",
            logger=make_mock_logger(),
        )
        with patch("design_reviewer.validation.classifier.time.sleep"):
            with pytest.raises(StructureValidationError) as exc_info:
                classifier._classify_one(make_mock_path("/fake/file.md"), "content")
        assert "classification failed" in str(exc_info.value).lower()
        assert mock_client.invoke_model.call_count == 2

    def test_warning_logged_on_first_failure(self):
        mock_client = MagicMock()
        error = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate"}}, "InvokeModel"
        )
        success = {
            "body": BytesIO(json.dumps({"content": [{"text": "UNKNOWN"}]}).encode())
        }
        mock_client.invoke_model.side_effect = [error, success]
        mock_logger = make_mock_logger()

        classifier = ArtifactClassifier(
            bedrock_client=mock_client, model_id="claude-sonnet-4-6", logger=mock_logger
        )
        with patch("design_reviewer.validation.classifier.time.sleep"):
            classifier._classify_one(make_mock_path("/fake/file.md"), "content")

        mock_logger.warning.assert_called_once()
        assert "retrying" in mock_logger.warning.call_args[0][0].lower()


class TestClassifyAll:
    def test_empty_candidates_returns_empty_list(self):
        classifier = make_classifier()
        with patch("design_reviewer.validation.classifier.progress_bar") as mock_pb:
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)
            result = classifier.classify_all([])
        assert result == []

    def test_returns_artifact_info_list(self):
        classifier = make_classifier(response_text="FUNCTIONAL_DESIGN")
        candidates = [
            (
                make_mock_path("/aidlc-docs/construction/u1/functional-design/file.md"),
                "# FD\n",
            ),
        ]
        with patch("design_reviewer.validation.classifier.progress_bar") as mock_pb:
            mock_progress = MagicMock()
            mock_pb.return_value.__enter__ = MagicMock(return_value=mock_progress)
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)
            results = classifier.classify_all(candidates)

        assert len(results) == 1
        assert results[0].artifact_type == ArtifactType.FUNCTIONAL_DESIGN

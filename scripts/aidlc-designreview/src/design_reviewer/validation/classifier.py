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


"""
ArtifactClassifier — parallel Amazon Bedrock AI classification of artifact files.

Uses claude-sonnet-4-6 with a detailed type-description prompt.
One Bedrock call per file; parallel execution via ThreadPoolExecutor.
Retries once on transient API errors; raises StructureValidationError on second failure.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Optional, Tuple

from botocore.exceptions import BotoCoreError, ClientError

from design_reviewer.foundation.exceptions import StructureValidationError
from design_reviewer.foundation.logger import Logger
from design_reviewer.foundation.progress import progress_bar
from design_reviewer.validation.models import ArtifactInfo, ArtifactType

# Retry settings
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 2

# Classification prompt template
_CLASSIFICATION_PROMPT = """\
You are classifying AIDLC (AI-Driven Development Life Cycle) design documents.
Given the following document excerpt, determine the artifact type.

ARTIFACT TYPES:
- APPLICATION_DESIGN: Contains component definitions, component methods, service descriptions, \
component dependencies. Found in inception/application-design/. \
Examples: components.md, component-methods.md, services.md, unit-of-work.md.
- FUNCTIONAL_DESIGN: Contains business logic models, domain entities, business rules. \
Found in construction/{{unit}}/functional-design/. \
Examples: business-logic-model.md, domain-entities.md, business-rules.md.
- TECHNICAL_ENVIRONMENT: Describes the technical stack, dependencies, and environment \
constraints. Filename typically contains "technical-environment".
- NFR_REQUIREMENTS: Contains non-functional requirements (performance, security, scalability) \
and technology stack decisions. Found in construction/{{unit}}/nfr-requirements/. \
Examples: nfr-requirements.md, tech-stack-decisions.md.
- NFR_DESIGN: Contains NFR design patterns and logical component definitions. \
Found in construction/{{unit}}/nfr-design/. \
Examples: nfr-design-patterns.md, logical-components.md.
- UNKNOWN: Does not match any of the above types.

DOCUMENT EXCERPT:
---
{excerpt}
---

Respond with ONLY the artifact type name (e.g., FUNCTIONAL_DESIGN). No explanation."""


class ArtifactClassifier:
    """
    Classifies artifact files using parallel Amazon Bedrock API calls.

    Sends the first 100 lines of each file to claude-sonnet-4-6 with a
    type-description prompt. Executes calls in parallel using ThreadPoolExecutor.
    """

    def __init__(
        self,
        bedrock_client,
        model_id: str,
        logger: Logger,
        max_workers: int = 10,
    ) -> None:
        from design_reviewer.foundation.config_manager import ConfigManager

        self._client = bedrock_client
        self._model_id = ConfigManager.to_bedrock_model_id(model_id)
        self._logger = logger
        self._max_workers = max_workers

    def classify_all(self, candidates: List[Tuple[Path, str]]) -> List[ArtifactInfo]:
        """
        Classify all candidate files in parallel.

        Args:
            candidates: List of (file_path, first_100_lines) tuples from ArtifactScanner.

        Returns:
            List of ArtifactInfo objects (no content populated yet).

        Raises:
            StructureValidationError: If any file's Bedrock classification fails after retry.
        """
        if not candidates:
            return []

        self._logger.info(f"Classifying {len(candidates)} artifacts via Amazon Bedrock AI...")
        results: List[ArtifactInfo] = []

        with progress_bar(
            total=len(candidates), description="Classifying artifacts"
        ) as progress:
            with ThreadPoolExecutor(max_workers=self._max_workers) as executor:
                future_to_path = {
                    executor.submit(self._classify_one, path, excerpt): path
                    for path, excerpt in candidates
                }
                for future in as_completed(future_to_path):
                    artifact_info = (
                        future.result()
                    )  # Raises StructureValidationError on failure
                    results.append(artifact_info)
                    progress.advance()

        self._logger.info(
            f"Classification complete: {len(results)} artifacts classified"
        )
        return results

    def _classify_one(self, file_path: Path, content_excerpt: str) -> ArtifactInfo:
        """
        Classify a single file with one retry on Amazon Bedrock API errors.

        Raises:
            StructureValidationError: After 2 failed attempts.
        """
        last_error: Optional[Exception] = None

        for attempt in range(_MAX_ATTEMPTS):
            try:
                response_text = self._invoke_bedrock(content_excerpt)
                artifact_type = self._parse_response(response_text, file_path)
                unit_name = self._extract_unit_name(file_path)
                return ArtifactInfo.create(file_path, artifact_type, unit_name)
            except (ClientError, BotoCoreError) as exc:
                last_error = exc
                if attempt == 0:
                    self._logger.warning(
                        f"Amazon Bedrock call failed for {file_path.name}, retrying once: {exc}"
                    )
                    # nosemgrep: arbitrary-sleep
                    time.sleep(_RETRY_DELAY_SECONDS)  # Intentional: Amazon Bedrock API retry back-off
                # On attempt 1, fall through to raise below

        raise StructureValidationError(
            f"Amazon Bedrock classification failed after {_MAX_ATTEMPTS} attempts for: {file_path}",
            context={
                "file_path": str(file_path),
                "error_type": type(last_error).__name__,
                "error_message": str(last_error),
                "hint": "Check AWS credentials and Amazon Bedrock model access in your region",
            },
        )

    def _build_prompt(self, content_excerpt: str) -> str:
        """Build the type-description classification prompt."""
        return _CLASSIFICATION_PROMPT.format(excerpt=content_excerpt)

    def _invoke_bedrock(self, content_excerpt: str) -> str:
        """
        Call Amazon Bedrock with the classification prompt.

        Args:
            content_excerpt: Content to classify (must be non-empty string).

        Returns:
            Raw text response from the model.

        Raises:
            StructureValidationError: If input validation fails.
            ClientError, BotoCoreError: On API failure (caller handles retry).
        """
        # SECURITY: Input validation before sending to Amazon Bedrock
        if not isinstance(content_excerpt, str):
            raise StructureValidationError(
                "Invalid input type for Amazon Bedrock classification",
                context={
                    "expected_type": "str",
                    "actual_type": type(content_excerpt).__name__,
                },
            )

        if not content_excerpt or not content_excerpt.strip():
            raise StructureValidationError(
                "Empty content provided for Amazon Bedrock classification",
                context={"hint": "Content excerpt must be non-empty"},
            )

        # Limit input size to prevent excessively large API calls
        max_excerpt_length = 100000  # ~100KB of text
        if len(content_excerpt) > max_excerpt_length:
            self._logger.warning(
                f"Content excerpt exceeds {max_excerpt_length} chars, truncating for classification"
            )
            content_excerpt = content_excerpt[:max_excerpt_length]

        prompt = self._build_prompt(content_excerpt)
        body = json.dumps(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 50,
                "messages": [{"role": "user", "content": prompt}],
            }
        )
        response = self._client.invoke_model(
            modelId=self._model_id,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        response_body = json.loads(response["body"].read())
        return response_body["content"][0]["text"]

    def _parse_response(self, response_text: str, file_path: Path) -> ArtifactType:
        """
        Parse Bedrock response to ArtifactType enum.

        Args:
            response_text: Raw text from model.
            file_path: Source file path (for error context).

        Returns:
            Matched ArtifactType.

        Raises:
            StructureValidationError: If response does not match any enum value.
        """
        normalized = response_text.strip().upper()
        try:
            return ArtifactType(normalized)
        except ValueError:
            raise StructureValidationError(
                f"Classification returned unrecognized type '{normalized}' for {file_path.name}",
                context={
                    "file_path": str(file_path),
                    "response": normalized,
                    "valid_types": [t.value for t in ArtifactType],
                },
            )

    def _extract_unit_name(self, file_path: Path) -> Optional[str]:
        """
        Extract unit name for files under the construction/ subtree.

        Returns:
            Unit name string (e.g., "unit1-foundation-config") or None.
        """
        parts = file_path.parts
        try:
            construction_idx = next(
                i for i, part in enumerate(parts) if part == "construction"
            )
            # Unit name is the directory immediately after "construction/"
            if construction_idx + 1 < len(parts):
                return parts[construction_idx + 1]
        except StopIteration:
            pass
        return None

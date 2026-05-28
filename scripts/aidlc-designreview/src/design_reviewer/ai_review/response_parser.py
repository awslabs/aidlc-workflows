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
Response parser for Unit 4: AI Review.

Centralized JSON response parsing with three-stage fallback extraction.
Pattern 4.5: Schema-parameterized parser with fallback chain.
"""

import json
import re
from typing import Optional


def parse_response(raw: str, _expected_schema: Optional[dict] = None) -> dict:
    """
    Parse AI response as JSON with fallback extraction.

    Fallback chain:
    1. Direct json.loads()
    2. Extract from ```json...``` code block
    3. Extract between first { and last }
    4. Return {"raw_response": raw, "parse_error": msg}

    Args:
        raw: Raw response text from AI model.
        _expected_schema: Reserved for future schema validation (currently unused).

    Returns:
        Parsed dict. On complete failure, returns {"raw_response": raw, "parse_error": msg}.
    """
    # Stage 1: Try direct JSON parse
    try:
        parsed = json.loads(raw.strip())
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Stage 2: Try extracting from markdown code block
    code_block_match = re.search(r"```(?:json)?\s*\n(.*?)\n```", raw, re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1).strip())
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass

    # Stage 3: Try brace extraction
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            parsed = json.loads(raw[first_brace : last_brace + 1])
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass

    # All stages failed
    return {
        "raw_response": raw,
        "parse_error": "Failed to extract valid JSON from response",
    }

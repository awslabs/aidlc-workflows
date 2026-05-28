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


"""Tests for response_parser module."""

from src.design_reviewer.ai_review.response_parser import parse_response


class TestParseResponseDirectJSON:
    def test_valid_json_object(self):
        raw = '{"findings": [{"title": "Test"}]}'
        result = parse_response(raw)
        assert result == {"findings": [{"title": "Test"}]}

    def test_valid_json_with_whitespace(self):
        raw = '  \n{"key": "value"}\n  '
        result = parse_response(raw)
        assert result == {"key": "value"}

    def test_empty_object(self):
        raw = "{}"
        result = parse_response(raw)
        assert result == {}

    def test_json_array_extracts_inner_object(self):
        raw = '[{"title": "Test"}]'
        result = parse_response(raw)
        # Stage 3 (brace extraction) finds the inner dict
        assert result == {"title": "Test"}


class TestParseResponseCodeBlock:
    def test_json_code_block(self):
        raw = (
            'Here are findings:\n```json\n{"findings": [{"title": "Test"}]}\n```\nDone.'
        )
        result = parse_response(raw)
        assert result == {"findings": [{"title": "Test"}]}

    def test_code_block_without_json_tag(self):
        raw = 'Results:\n```\n{"key": "value"}\n```'
        result = parse_response(raw)
        assert result == {"key": "value"}

    def test_invalid_json_in_code_block_falls_through(self):
        raw = "```json\n{broken json}\n```"
        result = parse_response(raw)
        assert "parse_error" in result


class TestParseResponseBraceExtraction:
    def test_json_embedded_in_text(self):
        raw = 'Here is my analysis: {"findings": []} and some trailing text.'
        result = parse_response(raw)
        assert result == {"findings": []}

    def test_nested_braces(self):
        raw = 'Text {"outer": {"inner": "value"}} more text'
        result = parse_response(raw)
        assert result == {"outer": {"inner": "value"}}

    def test_no_valid_json_between_braces(self):
        raw = "Start { this is not json } end"
        result = parse_response(raw)
        assert "parse_error" in result


class TestParseResponseTotalFailure:
    def test_no_json_at_all(self):
        raw = "This is just plain text with no JSON."
        result = parse_response(raw)
        assert result["raw_response"] == raw
        assert "parse_error" in result

    def test_empty_string(self):
        result = parse_response("")
        assert "parse_error" in result

    def test_malformed_fixture(self, malformed_response_text):
        result = parse_response(malformed_response_text)
        assert "parse_error" in result
        assert "raw_response" in result


class TestParseResponseWithSchema:
    def test_schema_parameter_accepted(self):
        raw = '{"findings": []}'
        result = parse_response(raw, _expected_schema={"findings": list})
        assert result == {"findings": []}

    def test_schema_does_not_filter(self):
        raw = '{"findings": [], "extra": "data"}'
        result = parse_response(raw, _expected_schema={"findings": list})
        assert "extra" in result

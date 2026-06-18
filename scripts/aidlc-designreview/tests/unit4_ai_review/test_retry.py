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


"""Tests for retry module."""

from botocore.exceptions import ClientError

from src.design_reviewer.ai_review.retry import (
    NON_RETRYABLE_ERROR_CODES,
    RETRYABLE_ERROR_CODES,
    is_retryable,
)


def _make_client_error(code: str) -> ClientError:
    """Create a botocore ClientError with the given error code."""
    return ClientError(
        error_response={"Error": {"Code": code, "Message": f"Test {code}"}},
        operation_name="InvokeModel",
    )


class TestRetryableErrorCodes:
    def test_throttling_is_retryable(self):
        assert is_retryable(_make_client_error("ThrottlingException"))

    def test_service_unavailable_is_retryable(self):
        assert is_retryable(_make_client_error("ServiceUnavailableException"))

    def test_internal_server_error_is_retryable(self):
        assert is_retryable(_make_client_error("InternalServerError"))

    def test_internal_server_exception_is_retryable(self):
        assert is_retryable(_make_client_error("InternalServerException"))

    def test_model_timeout_is_retryable(self):
        assert is_retryable(_make_client_error("ModelTimeoutException"))

    def test_too_many_requests_is_retryable(self):
        assert is_retryable(_make_client_error("TooManyRequestsException"))

    def test_all_retryable_codes_covered(self):
        for code in RETRYABLE_ERROR_CODES:
            assert is_retryable(_make_client_error(code))


class TestNonRetryableErrorCodes:
    def test_validation_not_retryable(self):
        assert not is_retryable(_make_client_error("ValidationException"))

    def test_access_denied_not_retryable(self):
        assert not is_retryable(_make_client_error("AccessDeniedException"))

    def test_resource_not_found_not_retryable(self):
        assert not is_retryable(_make_client_error("ResourceNotFoundException"))

    def test_model_not_ready_not_retryable(self):
        assert not is_retryable(_make_client_error("ModelNotReadyException"))

    def test_all_non_retryable_codes_covered(self):
        for code in NON_RETRYABLE_ERROR_CODES:
            assert not is_retryable(_make_client_error(code))


class TestUnknownErrors:
    def test_unknown_client_error_defaults_retryable(self):
        assert is_retryable(_make_client_error("SomeUnknownException"))

    def test_connection_error_is_retryable(self):
        assert is_retryable(ConnectionError("Connection refused"))

    def test_timeout_error_is_retryable(self):
        assert is_retryable(TimeoutError("Timed out"))

    def test_generic_exception_not_retryable(self):
        assert not is_retryable(ValueError("Some value error"))

    def test_runtime_error_not_retryable(self):
        assert not is_retryable(RuntimeError("Something broke"))


class TestWrappedExceptions:
    def test_wrapped_retryable_error(self):
        cause = _make_client_error("ThrottlingException")
        wrapper = Exception("Wrapped error")
        wrapper.__cause__ = cause
        assert is_retryable(wrapper)

    def test_wrapped_non_retryable_error(self):
        cause = _make_client_error("ValidationException")
        wrapper = Exception("Wrapped error")
        wrapper.__cause__ = cause
        assert not is_retryable(wrapper)

    def test_no_cause_generic_exception(self):
        exc = Exception("No cause")
        assert not is_retryable(exc)

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
Retry utilities for Unit 4: AI Review.

Provides error classification for Amazon Bedrock API calls.
Pattern 4.3: Predicate function for retryable error detection.
"""

from botocore.exceptions import ClientError


RETRYABLE_ERROR_CODES = {
    "ThrottlingException",
    "ServiceUnavailableException",
    "InternalServerError",
    "InternalServerException",
    "ModelTimeoutException",
    "TooManyRequestsException",
}

NON_RETRYABLE_ERROR_CODES = {
    "ValidationException",
    "AccessDeniedException",
    "ResourceNotFoundException",
    "ModelNotReadyException",
}


def is_retryable(exc: Exception) -> bool:
    """
    Determine if an exception is retryable.

    Checks botocore ClientError code against known retryable/non-retryable sets.
    Unknown ClientError codes default to retryable (conservative approach).

    Args:
        exc: The exception to classify.

    Returns:
        True if the error should be retried, False otherwise.
    """
    if isinstance(exc, ClientError):
        error_code = exc.response.get("Error", {}).get("Code", "")
        if error_code in NON_RETRYABLE_ERROR_CODES:
            return False
        if error_code in RETRYABLE_ERROR_CODES:
            return True
        return True

    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True

    if hasattr(exc, "__cause__") and exc.__cause__:
        return is_retryable(exc.__cause__)

    return False

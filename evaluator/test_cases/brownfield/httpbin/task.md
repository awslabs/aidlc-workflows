# Task: fix /base64 error handling

The `/base64/<value>` endpoint decodes a base64url-encoded path segment.
Currently, malformed base64 input is silently swallowed by a bare `except:` and
the endpoint returns HTTP 200 with a generic hint string — indistinguishable
from a successful decode.

Fix `decode_base64` so that:

1. Valid base64url input still decodes and returns the decoded text with HTTP 200.
2. Malformed / undecodable input returns a **client-error status (400)** with a
   clear error message — NOT a 200, and NOT a 500.
3. Replace the bare `except:` with a specific exception catch.

Do not change the endpoint's path or its success behavior. Make the smallest
correct change and keep the existing test suite passing.

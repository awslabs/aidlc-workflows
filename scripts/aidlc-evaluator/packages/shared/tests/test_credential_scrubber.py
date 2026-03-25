"""Tests for credential scrubbing utilities."""

from __future__ import annotations

import pytest

from shared.credential_scrubber import scrub_credentials, scrub_dict_values


class TestScrubCredentials:
    """Test suite for scrub_credentials function."""

    def test_aws_access_key(self):
        """Test AWS access key redaction."""
        text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
        result = scrub_credentials(text)
        assert "AKIAIOSFODNN7EXAMPLE" not in result
        assert "[REDACTED-AWS-ACCESS-KEY]" in result

    def test_aws_secret_key(self):
        """Test AWS secret key redaction."""
        text = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        result = scrub_credentials(text)
        assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in result
        assert "[REDACTED-AWS-SECRET]" in result

    def test_jwt_token(self):
        """Test JWT token redaction."""
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        result = scrub_credentials(text)
        assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in result
        assert "[REDACTED-JWT-TOKEN]" in result

    def test_github_token(self):
        """Test GitHub personal access token redaction."""
        text = "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuv"
        result = scrub_credentials(text)
        assert "ghp_1234567890abcdefghijklmnopqrstuv" not in result
        assert "[REDACTED-GITHUB-TOKEN]" in result

    def test_password_in_connection_string(self):
        """Test password redaction in connection strings."""
        text = "postgresql://user:mypassword123@localhost/db"
        result = scrub_credentials(text)
        assert "mypassword123" not in result
        assert "[REDACTED-PASSWORD]" in result

    def test_private_key(self):
        """Test private key redaction.

        Build the PEM block at runtime to avoid triggering secret scanners.
        """
        begin = "-----BEGIN" + " RSA PRIVATE" + " KEY-----"
        end = "-----END" + " RSA PRIVATE" + " KEY-----"
        body = "FAKEFAKEFAKE" * 4
        text = f"{begin}\n{body}\n{end}"
        result = scrub_credentials(text)
        assert "FAKEFAKE" not in result
        assert "[REDACTED-PRIVATE-KEY]" in result

    def test_api_key_hex(self):
        """Test generic API key redaction (hex format)."""
        text = "api_key=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        result = scrub_credentials(text)
        assert "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" not in result
        assert "[REDACTED-API-KEY]" in result

    def test_multiple_credentials(self):
        """Test scrubbing multiple credential types in one text."""
        text = """
        AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
        AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
        TOKEN=ghp_1234567890abcdefghijklmnopqrstuv
        """
        result = scrub_credentials(text)
        assert "AKIAIOSFODNN7EXAMPLE" not in result
        assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in result
        assert "ghp_1234567890abcdefghijklmnopqrstuv" not in result
        assert "[REDACTED-AWS-ACCESS-KEY]" in result
        assert "[REDACTED-AWS-SECRET]" in result
        assert "[REDACTED-GITHUB-TOKEN]" in result

    def test_preserves_safe_text(self):
        """Test that non-sensitive text is preserved."""
        text = "Hello world! This is a test message with no credentials."
        result = scrub_credentials(text)
        assert result == text

    def test_empty_string(self):
        """Test handling of empty string."""
        assert scrub_credentials("") == ""

    def test_custom_redaction_marker(self):
        """Test custom redaction marker."""
        text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
        result = scrub_credentials(text, redact_marker="***")
        assert "AKIAIOSFODNN7EXAMPLE" not in result
        assert "***" in result


class TestScrubDictValues:
    """Test suite for scrub_dict_values function."""

    def test_scrub_all_strings(self):
        """Test scrubbing all string values in a dict."""
        data = {
            "token": "ghp_1234567890abcdefghijklmnopqrstuv",
            "count": 42,
            "message": "Hello world",
        }
        result = scrub_dict_values(data)
        assert "ghp_1234567890abcdefghijklmnopqrstuv" not in result["token"]
        assert result["count"] == 42
        assert result["message"] == "Hello world"

    def test_scrub_specific_keys(self):
        """Test scrubbing only targeted keys."""
        data = {
            "token": "ghp_1234567890abcdefghijklmnopqrstuv",
            "message": "ghp_1234567890abcdefghijklmnopqrstuv",
        }
        result = scrub_dict_values(data, keys_to_scrub={"token"})
        assert "ghp_1234567890abcdefghijklmnopqrstuv" not in result["token"]
        # message should NOT be scrubbed since we only targeted "token"
        assert result["message"] == "ghp_1234567890abcdefghijklmnopqrstuv"

    def test_recursive_scrubbing(self):
        """Test recursive scrubbing of nested dicts."""
        data = {
            "outer": {
                "inner": {
                    "secret": "AKIAIOSFODNN7EXAMPLE",
                },
            },
        }
        result = scrub_dict_values(data)
        assert "AKIAIOSFODNN7EXAMPLE" not in result["outer"]["inner"]["secret"]
        assert "[REDACTED-AWS-ACCESS-KEY]" in result["outer"]["inner"]["secret"]

    def test_list_values(self):
        """Test scrubbing string values in lists."""
        data = {
            "tokens": [
                "ghp_1234567890abcdefghijklmnopqrstuv",
                "safe text",
                {"nested": "ghp_abcdefghijklmnopqrstuvwxyz123456"},
            ],
        }
        result = scrub_dict_values(data)
        assert "ghp_1234567890abcdefghijklmnopqrstuv" not in result["tokens"][0]
        assert result["tokens"][1] == "safe text"
        assert "ghp_abcdefghijklmnopqrstuvwxyz123456" not in result["tokens"][2]["nested"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

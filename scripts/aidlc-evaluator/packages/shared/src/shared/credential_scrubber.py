"""Credential scrubbing utilities for sanitizing command output and logs.

Automatically detects and redacts sensitive credentials from text to prevent
accidental exposure in logs, reports, or other output artifacts.
"""

from __future__ import annotations

import re
from typing import Pattern

# Credential patterns to detect and redact
# Each tuple: (pattern, replacement_template, description)
_CREDENTIAL_PATTERNS: list[tuple[Pattern[str], str, str]] = [
    # AWS Access Key ID (AKIA... format)
    (
        re.compile(r"\b(AKIA[0-9A-Z]{16})\b"),
        "[REDACTED-AWS-ACCESS-KEY]",
        "AWS Access Key",
    ),
    # AWS Secret Access Key (40 base64 characters)
    (
        re.compile(r"\b([A-Za-z0-9/+=]{40})\b"),
        "[REDACTED-AWS-SECRET]",
        "AWS Secret Key",
    ),
    # JWT tokens (three base64 segments separated by dots)
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
        "[REDACTED-JWT-TOKEN]",
        "JWT Token",
    ),
    # GitHub Personal Access Token (ghp_...) - variable length
    (
        re.compile(r"\bghp_[a-zA-Z0-9]{30,60}\b"),
        "[REDACTED-GITHUB-TOKEN]",
        "GitHub Token",
    ),
    # GitHub OAuth Token (gho_...) - variable length
    (
        re.compile(r"\bgho_[a-zA-Z0-9]{30,60}\b"),
        "[REDACTED-GITHUB-OAUTH]",
        "GitHub OAuth Token",
    ),
    # Generic API keys (32+ alphanumeric/special chars, common in many services)
    # More conservative pattern to reduce false positives
    (
        re.compile(r"\b[a-f0-9]{32,64}\b", re.IGNORECASE),
        "[REDACTED-API-KEY]",
        "API Key",
    ),
    # Private SSH keys
    (
        re.compile(
            r"-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----[\s\S]+?-----END\s+(?:RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----",
            re.IGNORECASE,
        ),
        "[REDACTED-PRIVATE-KEY]",
        "Private Key",
    ),
    # Password-like patterns in connection strings or command line args
    (
        re.compile(r"(?i)(password|passwd|pwd)=[\'\"]?([^\s\'\";]+)", re.IGNORECASE),
        r"\1=[REDACTED-PASSWORD]",
        "Password",
    ),
    # Connection string passwords (user:password@host format)
    (
        re.compile(r"://([^:@]+):([^@]+)@"),
        r"://\1:[REDACTED-PASSWORD]@",
        "Connection String Password",
    ),
    # AWS Session Token (longer base64 strings following FwoGZXIv pattern)
    (
        re.compile(r"\bFwoGZXIv[A-Za-z0-9/+=]{100,}\b"),
        "[REDACTED-AWS-SESSION-TOKEN]",
        "AWS Session Token",
    ),
]


def scrub_credentials(text: str, redact_marker: str | None = None) -> str:
    """Remove sensitive credentials from text using pattern matching.

    Detects common credential formats (AWS keys, JWTs, API keys, private keys,
    passwords) and replaces them with redaction markers.

    Args:
        text: The text to scrub for credentials.
        redact_marker: Optional custom redaction marker. If None, uses
            pattern-specific markers like [REDACTED-AWS-ACCESS-KEY].

    Returns:
        Scrubbed text with credentials replaced by redaction markers.

    Examples:
        >>> scrub_credentials("export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
        'export AWS_ACCESS_KEY_ID=[REDACTED-AWS-ACCESS-KEY]'

        >>> scrub_credentials("Bearer eyJhbGc...")
        'Bearer [REDACTED-JWT-TOKEN]'
    """
    if not text:
        return text

    scrubbed = text
    for pattern, default_replacement, _description in _CREDENTIAL_PATTERNS:
        replacement = redact_marker if redact_marker else default_replacement
        scrubbed = pattern.sub(replacement, scrubbed)

    return scrubbed


def scrub_dict_values(data: dict, keys_to_scrub: set[str] | None = None) -> dict:
    """Scrub credential values from a dictionary.

    Recursively processes dictionary values, scrubbing credentials from strings.
    Optionally targets specific keys (case-insensitive matching).

    Args:
        data: Dictionary to scrub.
        keys_to_scrub: Optional set of key names to specifically target
            (e.g., {"password", "token", "secret"}). If None, scrubs all
            string values.

    Returns:
        New dictionary with scrubbed values.

    Examples:
        >>> scrub_dict_values({"token": "ghp_abc123...", "count": 42})
        {'token': '[REDACTED-GITHUB-TOKEN]', 'count': 42}
    """
    if keys_to_scrub:
        keys_to_scrub = {k.lower() for k in keys_to_scrub}

    result = {}
    for key, value in data.items():
        if isinstance(value, str):
            # If keys_to_scrub is specified, only scrub targeted keys
            if keys_to_scrub is None or key.lower() in keys_to_scrub:
                result[key] = scrub_credentials(value)
            else:
                result[key] = value
        elif isinstance(value, dict):
            result[key] = scrub_dict_values(value, keys_to_scrub)
        elif isinstance(value, list):
            result[key] = [
                scrub_dict_values(item, keys_to_scrub)
                if isinstance(item, dict)
                else scrub_credentials(item)
                if isinstance(item, str)
                else item
                for item in value
            ]
        else:
            result[key] = value

    return result

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
Amazon Bedrock client factory for Unit 4: AI Review.

Creates configured boto3 Amazon Bedrock runtime clients with timeout and credential settings.
Pattern 4.4: Simple factory function, not a class.
"""

import boto3
from botocore.config import Config

from ..foundation.config_manager import ConfigManager


def create_bedrock_client(agent_name: str = None):
    """
    Create a configured Amazon Bedrock runtime client.

    Reads AWS config and timeout settings from ConfigManager.
    Disables SDK-level retries (handled by backoff/Strands).

    Args:
        agent_name: Optional agent name for logging context.

    Returns:
        boto3 bedrock-runtime client.
    """
    config_mgr = ConfigManager.get_instance()
    aws_config = config_mgr.get_aws_config()
    review_settings = config_mgr.get_review_settings()

    sdk_timeout = getattr(review_settings, "sdk_read_timeout_seconds", 1200)

    boto_config = Config(
        read_timeout=sdk_timeout,
        connect_timeout=30,
        retries={"max_attempts": 0},
    )

    # SECURITY: Only use profile-based authentication (IAM roles, SSO, temporary credentials)
    session = boto3.Session(profile_name=aws_config.profile_name)
    return session.client(
        "bedrock-runtime",
        region_name=aws_config.region,
        config=boto_config,
    )

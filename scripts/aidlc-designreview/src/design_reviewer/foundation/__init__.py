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
Foundation package for Design Reviewer.

Exports all foundational components: exceptions, logging, configuration,
prompts, patterns, and utilities.
"""

# Exceptions
from .exceptions import (
    AIReviewError,
    AgentExecutionError,
    ArtifactParseError,
    BedrockAPIError,
    ConfigFileNotFoundError,
    ConfigurationError,
    ConfigValidationError,
    DesignReviewerError,
    InvalidCredentialsError,
    InvalidPatternCountError,
    MissingArtifactError,
    ParsingError,
    PatternFileNotFoundError,
    PatternLoadError,
    PromptFileNotFoundError,
    PromptLoadError,
    PromptParseError,
    ResponseParseError,
    StructureValidationError,
    UnsupportedFormatError,
    ValidationError,
)

# Logging
from .fallback_logger import log_startup_error
from .logger import Logger
from .progress import ProgressUpdater, progress_bar

# Configuration
from .config_manager import ConfigManager
from .config_models import (
    AWSConfig,
    ConfigModel,
    LogConfig,
    ModelConfig,
    ReviewSettings,
)

# Prompts
from .prompt_manager import PromptManager
from .prompt_models import PromptData, PromptMetadata

# Patterns
from .pattern_library import PatternLibrary
from .pattern_models import Pattern

# Utilities
from .file_validator import FileValidator

__all__ = [
    # Exceptions
    "DesignReviewerError",
    "ConfigurationError",
    "ConfigFileNotFoundError",
    "ConfigValidationError",
    "InvalidCredentialsError",
    "PromptLoadError",
    "PromptFileNotFoundError",
    "PromptParseError",
    "PatternLoadError",
    "PatternFileNotFoundError",
    "InvalidPatternCountError",
    "ValidationError",
    "StructureValidationError",
    "MissingArtifactError",
    "ParsingError",
    "ArtifactParseError",
    "UnsupportedFormatError",
    "AIReviewError",
    "BedrockAPIError",
    "AgentExecutionError",
    "ResponseParseError",
    # Logging
    "Logger",
    "log_startup_error",
    "progress_bar",
    "ProgressUpdater",
    # Configuration
    "ConfigManager",
    "ConfigModel",
    "AWSConfig",
    "ModelConfig",
    "ReviewSettings",
    "LogConfig",
    # Prompts
    "PromptManager",
    "PromptData",
    "PromptMetadata",
    # Patterns
    "PatternLibrary",
    "Pattern",
    # Utilities
    "FileValidator",
]

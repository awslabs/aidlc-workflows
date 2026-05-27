#!/usr/bin/env bash
# Configuration Defaults for AIDLC Design Review Hook
#
# This file defines default configuration values that are used when:
# 1. No .claude/review-config.yaml exists
# 2. YAML parsing fails (yq and Python unavailable)
# 3. Individual config values are missing or invalid
#
# These values are sourced by lib/config-parser.sh
# Do not execute this file directly - it should be sourced

# Enable/disable hook (default: enabled)
# Type: boolean (true/false)
CONFIG_ENABLED=true

# Dry run mode - log actions without executing (default: disabled)
# Type: boolean (true/false)
CONFIG_DRY_RUN=false

# Interactive mode - prompt user for decisions (default: disabled)
# Type: boolean (true/false)
# When disabled, hook runs automatically without user prompts
# When enabled, prompts for initial review and post-review decisions
CONFIG_INTERACTIVE=false

# Minimum findings to trigger review (default: 3)
# Type: integer
# Range: 1-100
CONFIG_REVIEW_THRESHOLD=3

# Initial review prompt timeout in seconds (default: 120 = 2 minutes)
# Type: integer
# Range: 10-3600
CONFIG_TIMEOUT_SECONDS=120

# Post-review prompt timeout in seconds (default: 600 = 10 minutes)
# Type: integer
# Range: 60-3600
# User needs time to read detailed findings after review completes
CONFIG_POST_REVIEW_TIMEOUT_SECONDS=600

# Batch processing: max files per batch (default: 20)
# Type: integer
# Range: 1-100
CONFIG_BATCH_SIZE_FILES=20

# Batch processing: max bytes per batch (default: 25600 = 25KB)
# Type: integer
# Range: 1024-10485760 (1KB - 10MB)
CONFIG_BATCH_SIZE_BYTES=25600

# Blocking criteria: block on critical findings (default: enabled)
# Type: boolean (true/false)
CONFIG_BLOCK_ON_CRITICAL=true

# Blocking criteria: block if >= N high findings (default: 3)
# Type: integer
# Range: 0-100 (0 = disabled)
CONFIG_BLOCK_ON_HIGH_COUNT=3

# Blocking criteria: maximum acceptable quality score (default: 30)
# Type: integer
# Range: 0-1000 (higher score = worse quality)
CONFIG_MAX_QUALITY_SCORE=30

# Review depth: enable alternative approaches analysis (default: enabled)
# Type: boolean (true/false)
# Runs separate AI agent to suggest alternative design approaches
CONFIG_ENABLE_ALTERNATIVES=true

# Review depth: enable gap analysis (default: enabled)
# Type: boolean (true/false)
# Runs separate AI agent to identify missing components/scenarios
CONFIG_ENABLE_GAP_ANALYSIS=true

# AI Review Mode: use real AI instead of mock responses (default: enabled)
# Type: boolean (1 = real AI, 0 = mock)
# When enabled, makes actual AWS Bedrock API calls for design review
# When disabled, uses hardcoded mock responses for testing
# Can be overridden with USE_REAL_AI environment variable
USE_REAL_AI=${USE_REAL_AI:-1}

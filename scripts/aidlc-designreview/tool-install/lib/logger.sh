#!/usr/bin/env bash
# Logging Module for AIDLC Design Review Hook
#
# Purpose: Provide standardized logging functions
#
# Dependencies: None (POSIX utilities only)
#
# Usage:
#   source lib/logger.sh
#   log_info "Information message"
#   log_warning "Warning message"
#   log_error "Error message"

# Log levels
LOG_LEVEL_INFO=0
LOG_LEVEL_WARNING=1
LOG_LEVEL_ERROR=2

# Current log level (default: INFO)
CURRENT_LOG_LEVEL=${CURRENT_LOG_LEVEL:-$LOG_LEVEL_INFO}

# Purpose: Log informational message
# Inputs: $* = message
# Outputs: Formatted message to stderr
# Returns: 0 (always succeeds)
log_info() {
    if [ "$CURRENT_LOG_LEVEL" -le "$LOG_LEVEL_INFO" ]; then
        echo "[INFO] [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
    fi
}

# Purpose: Log warning message
# Inputs: $* = message
# Outputs: Formatted message to stderr
# Returns: 0 (always succeeds)
log_warning() {
    if [ "$CURRENT_LOG_LEVEL" -le "$LOG_LEVEL_WARNING" ]; then
        echo "[WARN] [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
    fi
}

# Purpose: Log error message
# Inputs: $* = message
# Outputs: Formatted message to stderr
# Returns: 0 (always succeeds)
log_error() {
    if [ "$CURRENT_LOG_LEVEL" -le "$LOG_LEVEL_ERROR" ]; then
        echo "[ERROR] [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
    fi
}

# Purpose: Log debug message (only if DEBUG enabled)
# Inputs: $* = message
# Outputs: Formatted message to stderr (if DEBUG=1)
# Returns: 0 (always succeeds)
log_debug() {
    if [ "${DEBUG:-0}" = "1" ]; then
        echo "[DEBUG] [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" >&2
    fi
}

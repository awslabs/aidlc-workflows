#!/usr/bin/env bash
# Build the aidlc-sandbox Docker image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker build -t aidlc-sandbox:latest "$SCRIPT_DIR"

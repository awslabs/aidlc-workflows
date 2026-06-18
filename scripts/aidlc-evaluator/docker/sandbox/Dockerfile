# Multi-language sandbox image for running AI-generated code in isolation.
#
# Includes Python 3.14 + uv, Node.js 22 + npm, and common build tools.
# Runs as a non-root user with no credentials or host tools.
#
# Security notes:
# - HEALTHCHECK is omitted as this is an ephemeral test sandbox, not a service
# - RUN commands use pipes without pipefail, acceptable for dependency installation

# checkov:skip=CKV_DOCKER_2:HEALTHCHECK not needed for ephemeral test sandbox
# nosemgrep: dockerfile-source-not-pinned
FROM public.ecr.aws/docker/library/python:3.14-slim@sha256:3989a23fd2c28a34c7be819e488b958a10601d421ac25bea1e7a5d757365e2d5 AS base

# Install system dependencies and Node.js 22
# nosemgrep: set-pipefail
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gcc \
        g++ \
        make \
        git \
        ca-certificates \
        gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Create non-root sandbox user (UID 1000)
RUN groupadd -g 1000 sandbox \
    && useradd -u 1000 -g 1000 -m -s /bin/bash sandbox

# Set up workspace directory
RUN mkdir /workspace && chown sandbox:sandbox /workspace

# Pre-configure uv and npm for the sandbox user
ENV UV_CACHE_DIR=/home/sandbox/.cache/uv
ENV NPM_CONFIG_CACHE=/home/sandbox/.cache/npm
RUN mkdir -p /home/sandbox/.cache/uv /home/sandbox/.cache/npm \
    && chown -R sandbox:sandbox /home/sandbox/.cache

USER sandbox
WORKDIR /workspace

CMD ["bash"]

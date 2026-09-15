#!/usr/bin/env bash

set -euo pipefail

review_user="ai-pr-review"
review_home="/home/${review_user}"

if [[ -z "${GITHUB_WORKSPACE:-}" || ! -d "$GITHUB_WORKSPACE" ]]; then
  echo "GITHUB_WORKSPACE must name an existing directory" >&2
  exit 2
fi

codex_bin="$(command -v codex)"

sudo adduser \
  --system \
  --home "$review_home" \
  --shell /bin/bash \
  --group "$review_user"
sudo install \
  -d \
  -m 700 \
  -o "$review_user" \
  -g "$review_user" \
  "$review_home/.codex"

if ! sudo -u "$review_user" test -x /home/runner; then
  sudo setfacl -m "u:${review_user}:--x" /home/runner
fi

sudo chown -R "runner:${review_user}" "$GITHUB_WORKSPACE"
sudo chmod -R g-w,o-rwx "$GITHUB_WORKSPACE"
sudo chmod -R g+rX "$GITHUB_WORKSPACE"

if ! sudo -u "$review_user" test -r "$GITHUB_WORKSPACE/.ai-review-context/pr.diff"; then
  echo "$review_user cannot read the immutable review context" >&2
  exit 1
fi

sudo sh -c \
  'printf "%s\n" \
    "Defaults:runner env_keep += \"AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION\"" \
    > /etc/sudoers.d/ai-pr-review-env'
sudo chmod 440 /etc/sudoers.d/ai-pr-review-env
sudo visudo -cf /etc/sudoers.d/ai-pr-review-env

current_userns="$(
  sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || true
)"
if [[ -n "$current_userns" && "$current_userns" != "1" ]]; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi

current_apparmor="$(
  sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true
)"
if [[ -n "$current_apparmor" && "$current_apparmor" != "0" ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

sudo -u "$review_user" -- env -i \
  CODEX_HOME="$review_home/.codex" \
  HOME="$review_home" \
  PATH="$PATH" \
  "$codex_bin" \
  sandbox \
  --permission-profile :read-only \
  --cd "$GITHUB_WORKSPACE" \
  /usr/bin/test \
  -r \
  "$GITHUB_WORKSPACE/.ai-review-context/pr.diff"

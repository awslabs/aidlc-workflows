#!/usr/bin/env bash
#
# sync.sh  -  copy the current project tree up to the Windows EC2 box via SSM.
#
# The box has no git and cannot clone the repository, so we ship a
# `git archive` of the tree the proven way: tar.gz -> base64 -> chunked SSM
# Add-Content -> reassemble + `tar -xzf` on the box. This is the local half of
# the like-for-like Windows setup; the box half is setup.ps1 (npm install) and
# run.ps1 (run a test). Documented in docs/reference/09-testing.md.
#
# Usage:
#   tests/harness/windows/sync.sh [REF] [DEST]
#     REF   git ref to archive (default: HEAD)
#     DEST  target dir on the box (default: C:\aidlc)
#
# Requires: aws CLI with creds for the box's account; run from the repo root.
set -euo pipefail

INSTANCE="i-0d8daa430102039a1"
REGION="us-east-1"
REF="${1:-HEAD}"
DEST="${2:-C:\\aidlc}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== git archive $REF -> tar.gz ==="
# Archive the tracked tree at REF. node_modules is not tracked (it's built on the
# box by npm install), so the archive is small and dep-free by construction.
git archive --format=tar "$REF" | gzip > "$WORK/tree.tar.gz"
ls -lh "$WORK/tree.tar.gz" | awk '{print "archive size:", $5}'

echo "=== base64 + chunk ==="
base64 < "$WORK/tree.tar.gz" > "$WORK/tree.b64"
# 45k chunks: comfortably under the SSM command-parameter size limit.
split -b 45000 "$WORK/tree.b64" "$WORK/chunk_"
NCHUNKS=$(ls "$WORK"/chunk_* | wc -l | tr -d ' ')
echo "chunks: $NCHUNKS"

run_ps() {  # run a PowerShell snippet on the box, wait, fail loud on nonzero.
  local ps="$1"
  local b64; b64=$(printf '%s' "$ps" | base64)
  local cmd="\$s=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')); Invoke-Expression \$s"
  local cid; cid=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
    --document-name AWS-RunPowerShellScript \
    --parameters "commands=[\"$(printf '%s' "$cmd" | sed 's/"/\\"/g')\"]" \
    --timeout-seconds 1800 --query "Command.CommandId" --output text)
  local st
  for _ in $(seq 1 120); do
    st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
         --instance-id "$INSTANCE" --query "Status" --output text 2>/dev/null || echo Pending)
    case "$st" in Success|Failed|Cancelled|TimedOut) break ;; *) sleep 3 ;; esac
  done
  if [ "$st" != "Success" ]; then
    echo "SSM step FAILED ($st):" >&2
    aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
      --instance-id "$INSTANCE" --query "StandardErrorContent" --output text >&2
    return 1
  fi
}

echo "=== prepare box: WIPE the prior tree (keep node_modules) ==="
# `tar -xzf` (below) overwrites files that exist in the archive but NEVER removes
# files that don't — so any orphan from a PRIOR sync survives. The trap that bit
# us: a prior tar-based sync that shipped macOS AppleDouble `._*` sidecars left
# hundreds of `._<name>.md` orphans scattered through the tree; the git-archive
# sync never reships them (git archive carries only tracked files, and `._*` is
# untracked), so they linger and the fixture's cpSync drags `._build-and-test.md`
# (malformed, no YAML frontmatter) into every temp project — aidlc-graph compile
# then correctly rejects it and EVERY harness-engineer test fails on the box while
# macOS is green. Extraction must therefore start from a clean tree. We delete all
# prior synced content but PRESERVE node_modules (built on the box by setup.ps1,
# never shipped in the archive) so a re-sync doesn't force a fresh npm install.
run_ps "
New-Item -ItemType Directory -Force -Path '$DEST' | Out-Null
Get-ChildItem -Path '$DEST' -Force -ErrorAction SilentlyContinue | Where-Object { \$_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'prepared (wiped prior tree, preserved node_modules)'
"

echo "=== ship $NCHUNKS chunks ==="
i=0
for f in "$WORK"/chunk_*; do
  i=$((i+1))
  content=$(cat "$f")
  cid=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
    --document-name AWS-RunPowerShellScript --comment "sync chunk $i/$NCHUNKS" \
    --parameters "commands=[\"Add-Content -Path '$DEST\\\\tree.b64' -Value '$content' -NoNewline; Write-Output ok$i\"]" \
    --query "Command.CommandId" --output text)
  for _ in $(seq 1 30); do
    st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
         --instance-id "$INSTANCE" --query "Status" --output text 2>/dev/null || echo Pending)
    case "$st" in Success) break ;; Failed|Cancelled|TimedOut) echo "chunk $i FAILED: $st" >&2; exit 1 ;; *) sleep 2 ;; esac
  done
  printf '\rchunk %d/%d %s' "$i" "$NCHUNKS" "$st"
done
echo ""

echo "=== decode + extract on box (tar ships with Windows) ==="
run_ps "
Set-Location '$DEST'
\$bytes = [Convert]::FromBase64String((Get-Content '$DEST\\tree.b64' -Raw))
[IO.File]::WriteAllBytes('$DEST\\tree.tar.gz', \$bytes)
tar -xzf '$DEST\\tree.tar.gz' -C '$DEST'
Remove-Item '$DEST\\tree.b64','$DEST\\tree.tar.gz'
if (Test-Path '$DEST\\package.json') { Write-Output 'EXTRACT-OK: package.json present' }
else { throw 'extract failed: no package.json' }
"

echo "=== sync complete -> $DEST. Next: setup.ps1 (npm install), then run.ps1 ==="

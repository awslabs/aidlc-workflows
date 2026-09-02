#!/bin/sh
set -eu

PUBLICATION_REPOSITORY=${AIDLC_PUBLICATION_REPOSITORY:-awslabs/aidlc-workflows-releases}
BASE_URL=${AIDLC_RELEASE_BASE_URL:-https://github.com/$PUBLICATION_REPOSITORY/releases}
RELEASE_REPOSITORY=${AIDLC_RELEASE_REPOSITORY:-awslabs/aidlc-workflows}
RELEASE_WORKFLOW=${AIDLC_RELEASE_WORKFLOW:-$RELEASE_REPOSITORY/.github/workflows/release.yml}
GH_BIN=${AIDLC_GH_BIN:-}
VERSION=
FROM=
OFFLINE=0
CA_BUNDLE=${AIDLC_CA_BUNDLE:-}
MODE=human
PROFILE=
PROGRESS_ACTIVE=0

clear_progress() {
  if [ "$PROGRESS_ACTIVE" -eq 1 ]; then
    printf '\r%-72s\r' "" >&2
    PROGRESS_ACTIVE=0
  fi
}

progress_start() {
  [ "$MODE" = "human" ] || return 0
  if [ -t 2 ]; then
    printf '\r%-72.72s' "Downloading $1..." >&2
    PROGRESS_ACTIVE=1
  fi
}

progress_done() {
  [ "$MODE" = "human" ] || return 0
  if [ -t 2 ]; then
    printf '\r%-72.72s\n' "Downloaded $1" >&2
    PROGRESS_ACTIVE=0
  else
    printf 'Downloaded %s\n' "$1" >&2
  fi
}

json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS="" } {
    gsub(/\\/, "\\\\")
    gsub(/"/, "\\\"")
    for (i = 1; i < 32; i++) {
      gsub(sprintf("%c", i), sprintf("\\u%04x", i))
    }
    if (NR > 1) printf "\\n"
    printf "%s", $0
  }'
}

fail() {
  code=$1
  status=$2
  message=$3
  remediation=${4:-}
  clear_progress
  if [ "$MODE" = "json" ]; then
    printf '{"schemaVersion":1,"ok":false,"code":%s,"status":"%s","message":"%s"' \
      "$code" "$status" "$(json_escape "$message")"
    if [ -n "$remediation" ]; then
      printf ',"remediation":"%s"' "$(json_escape "$remediation")"
    fi
    printf '}\n'
  elif [ "$MODE" = "quiet" ]; then
    [ -z "$remediation" ] || message=$remediation
    printf '%s\n' "$message"
  else
    label=ERROR
    [ "$code" -ne 4 ] || label=FAIL
    printf '%s %s\n' "$label" "$message" >&2
    [ -z "$remediation" ] || printf 'Run: %s\n' "$remediation" >&2
  fi
  exit "$code"
}

usage_text() {
  echo "Usage: install.sh [--version <x.y.z>] [--from <dir>] [--offline] [--profile <startup-file>] [--json|--quiet] [--no-color] [--yes]"
}

usage() {
  fail 2 usage "${1:-invalid arguments}" "$(usage_text)"
}

output_scan_expects_value=0
for arg in "$@"; do
  if [ "$output_scan_expects_value" -eq 1 ]; then
    output_scan_expects_value=0
    continue
  fi
  case "$arg" in
    --version|--from|--release-base-url|--ca-bundle|--profile)
      output_scan_expects_value=1
      ;;
    --json) MODE=json ;;
    --quiet) [ "$MODE" = "json" ] || MODE=quiet ;;
  esac
done

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || usage; VERSION=$2; shift 2 ;;
    --from) [ "$#" -ge 2 ] || usage; FROM=$2; OFFLINE=1; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --release-base-url) [ "$#" -ge 2 ] || usage; BASE_URL=$2; shift 2 ;;
    --ca-bundle) [ "$#" -ge 2 ] || usage; CA_BUNDLE=$2; shift 2 ;;
    --profile) [ "$#" -ge 2 ] || usage "--profile requires a startup file"; PROFILE=$2; shift 2 ;;
    --json) MODE=json; shift ;;
    --quiet) [ "$MODE" = "json" ] || MODE=quiet; shift ;;
    --no-color) shift ;;
    --yes) shift ;;
    -h|--help) usage_text; exit 0 ;;
    *) usage "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -ne 0 ] || fail 4 failed "refusing a root install; run as the target user"
if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  usage "invalid --version: $VERSION"
fi
[ "$OFFLINE" -eq 0 ] || [ -n "$FROM" ] ||
  fail 3 unavailable "--offline requires --from <release-directory>"
if [ -z "$FROM" ]; then
  case "$BASE_URL" in
    *\?*|*\#*) fail 4 failed "release URL must not include credentials, a query, or a fragment" ;;
  esac
  release_authority=${BASE_URL#*://}
  release_authority=${release_authority%%/*}
  case "$release_authority" in
    *@*) fail 4 failed "release URL must not include credentials, a query, or a fragment" ;;
  esac
  case "$BASE_URL" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) fail 4 failed "release URL must use HTTPS" ;;
  esac
fi
if [ -n "$CA_BUNDLE" ]; then
  case "$CA_BUNDLE" in
    /*) ;;
    *) usage "--ca-bundle must be an absolute path" ;;
  esac
fi
if [ -n "$PROFILE" ]; then
  case "$PROFILE" in
    /*) ;;
    *) usage "--profile must be an absolute path inside the target user's home" ;;
  esac
fi

BIN_DIR_EXPLICIT=0
[ "${AIDLC_BIN_DIR+x}" = x ] && BIN_DIR_EXPLICIT=1
BIN_DIR=${AIDLC_BIN_DIR:-"$HOME/.local/bin"}
INSTALL_ROOT=${AIDLC_INSTALL_ROOT:-"${XDG_DATA_HOME:-"$HOME/.local/share"}/aidlc"}
case "$BIN_DIR" in
  /*) ;;
  *) fail 4 failed "AIDLC_BIN_DIR must be an absolute path" ;;
esac
case "$INSTALL_ROOT" in
  /*) ;;
  *) fail 4 failed "AIDLC_INSTALL_ROOT must be an absolute path" ;;
esac

resolve_command_path() {
  path=$1
  hops=0
  while [ -L "$path" ] && [ "$hops" -lt 16 ]; do
    link=$(readlink "$path") || break
    case "$link" in
      /*) path=$link ;;
      *) path=$(dirname "$path")/$link ;;
    esac
    directory=$(dirname "$path")
    name=$(basename "$path")
    if resolved_directory=$(CDPATH='' cd -P "$directory" 2>/dev/null && pwd -P); then
      path=$resolved_directory/$name
    fi
    hops=$((hops + 1))
  done
  printf '%s\n' "$path"
}

existing_command=$(command -v aidlc 2>/dev/null || true)
if [ "$BIN_DIR_EXPLICIT" -eq 0 ] && [ -n "$existing_command" ] &&
  [ "$existing_command" != "$BIN_DIR/aidlc" ]; then
  existing_manager_path=$(resolve_command_path "$existing_command")
  case "$existing_command $existing_manager_path" in
    */Cellar/*|*/opt/homebrew/*|*/home/linuxbrew/.linuxbrew/*)
      fail 4 failed \
        "existing aidlc is managed by Homebrew at $existing_command" \
        "brew upgrade aidlc, or set AIDLC_BIN_DIR to an explicit user-local destination"
      ;;
    */nix/store/*|*/.nix-profile/*)
      fail 4 failed \
        "existing aidlc is managed by Nix at $existing_command" \
        "upgrade aidlc through Nix, or set AIDLC_BIN_DIR to an explicit user-local destination"
      ;;
  esac
fi

command_target="$BIN_DIR/aidlc"
if [ -e "$command_target" ] || [ -L "$command_target" ]; then
  if [ -L "$command_target" ]; then
    existing_target=$(readlink "$command_target")
  elif [ -f "$command_target" ] &&
    printf '%s\n' "$(sed -n '2p' "$command_target")" |
      grep -Eq '^# aidlc-native-launcher-v(1|2)$'; then
    pointer="$INSTALL_ROOT/active-executable"
    existing_target=
    _extra=
    if [ ! -f "$pointer" ]; then
      fail 4 failed \
        "existing $command_target has no installer-owned active pointer" \
        "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
    fi
    {
      IFS= read -r existing_target || [ -n "$existing_target" ] || existing_target=
      if IFS= read -r _extra; then existing_target=; fi
    } < "$pointer"
    if [ -z "$existing_target" ]; then
      fail 4 failed \
        "existing $command_target has a malformed installer-owned active pointer" \
        "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
    fi
  else
    fail 4 failed \
      "existing $command_target is not owned by the AI-DLC installer" \
      "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
  fi
  case "$existing_target" in
    "$INSTALL_ROOT"/versions/*/aidlc)
      existing_version=${existing_target#"$INSTALL_ROOT"/versions/}
      existing_version=${existing_version%/aidlc}
      if ! printf '%s\n' "$existing_version" |
        grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
        fail 4 failed \
          "existing $command_target has an invalid installer-owned target" \
          "choose an empty AIDLC_BIN_DIR or remove the mixed-ownership command"
      fi
      ;;
    *)
      fail 4 failed \
        "existing $command_target points outside the AI-DLC install root" \
        "use its package manager, or choose an empty AIDLC_BIN_DIR"
      ;;
  esac
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) usage "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) usage "unsupported architecture: $(uname -m)" ;;
esac

is_musl_linux() {
  if command -v ldd >/dev/null 2>&1 &&
    ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi
  for loader in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
    [ ! -e "$loader" ] || return 0
  done
  return 1
}

TARGET="$OS-$ARCH"
if [ "$OS" = "linux" ] && is_musl_linux; then
  TARGET="$TARGET-musl"
fi

umask 077
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

download() {
  url=$1
  output=$2
  progress_start "$(basename "$output")"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$CA_BUNDLE" ]; then
      curl -fsSL --cacert "$CA_BUNDLE" "$url" -o "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL, proxy, and CA bundle"
    else
      curl -fsSL "$url" -o "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL and proxy"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$CA_BUNDLE" ]; then
      wget -q "--ca-certificate=$CA_BUNDLE" "$url" -O "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL, proxy, and CA bundle"
    else
      wget -q "$url" -O "$output" 2>"$TMP/download.err" ||
        fail 3 unavailable "download failed" "check the release URL and proxy"
    fi
  else
    fail 1 failed "curl or wget is required"
  fi
  progress_done "$(basename "$output")"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail 1 failed "sha256sum or shasum is required"
  fi
}

if [ -n "$FROM" ]; then
  [ -d "$FROM" ] || usage "offline source is not a directory: $FROM"
  for metadata in version.json checksums.txt aidlc-release.intoto.jsonl install.sh; do
    [ -f "$FROM/$metadata" ] || fail 4 failed "offline source is missing $metadata"
    cp "$FROM/$metadata" "$TMP/$metadata"
  done
else
  if [ -n "$VERSION" ]; then
    RELEASE_URL="$BASE_URL/download/v$VERSION"
  else
    RELEASE_URL="$BASE_URL/latest/download"
  fi
  download "$RELEASE_URL/version.json" "$TMP/version.json"
  download "$RELEASE_URL/checksums.txt" "$TMP/checksums.txt"
  download "$RELEASE_URL/aidlc-release.intoto.jsonl" "$TMP/aidlc-release.intoto.jsonl"
fi

for metadata in version.json checksums.txt aidlc-release.intoto.jsonl; do
  metadata_bytes=$(wc -c <"$TMP/$metadata" | tr -d ' ')
  [ "$metadata_bytes" -le 1048576 ] ||
    fail 4 failed "$metadata exceeds the 1 MiB metadata limit"
done

requested_version=$VERSION
if [ -z "$GH_BIN" ]; then
  GH_BIN=$(command -v gh 2>/dev/null || true)
fi
if [ -z "$GH_BIN" ] || [ ! -x "$GH_BIN" ]; then
  fail 1 failed "GitHub CLI is required to verify release provenance" \
    "install gh, then rerun this installer"
fi
"$GH_BIN" attestation verify "$TMP/checksums.txt" \
  --bundle "$TMP/aidlc-release.intoto.jsonl" \
  --repo "$RELEASE_REPOSITORY" \
  --signer-workflow "$RELEASE_WORKFLOW" \
  --source-ref "refs/heads/main" \
  >/dev/null 2>"$TMP/provenance.err" ||
  fail 4 failed "release provenance verification failed" \
    "obtain the release from $RELEASE_REPOSITORY"

expected_manifest=$(sed -n 's/^\([a-f0-9]\{64\}\)  version\.json$/\1/p' "$TMP/checksums.txt")
[ -n "$expected_manifest" ] || fail 4 failed "No checksum for version.json."
actual_manifest=$(sha256_file "$TMP/version.json")
[ "$actual_manifest" = "$expected_manifest" ] || {
  fail 4 failed "Checksum mismatch for version.json."
}
candidate_version=$(sed -n 's/.*"version":[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$TMP/version.json" | head -n 1)
printf '%s\n' "$candidate_version" |
  grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
  fail 4 failed "version.json has no valid version."
source_ref=$(sed -n 's/.*"sourceRef":[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/version.json" | head -n 1)
source_digest=$(sed -n 's/.*"sourceDigest":[[:space:]]*"\([a-f0-9]*\)".*/\1/p' "$TMP/version.json" | head -n 1)
[ "$source_ref" = "refs/heads/main" ] ||
  fail 4 failed "version.json has an invalid release source ref"
printf '%s\n' "$source_digest" | grep -Eq '^[a-f0-9]{40}$' ||
  fail 4 failed "version.json has an invalid release source digest"
"$GH_BIN" attestation verify "$TMP/checksums.txt" \
  --bundle "$TMP/aidlc-release.intoto.jsonl" \
  --repo "$RELEASE_REPOSITORY" \
  --signer-workflow "$RELEASE_WORKFLOW" \
  --source-ref "$source_ref" \
  --source-digest "$source_digest" \
  >/dev/null 2>"$TMP/provenance.err" ||
  fail 4 failed "release provenance source verification failed" \
    "obtain the release from $RELEASE_REPOSITORY"

if [ -n "$requested_version" ] && [ "$requested_version" != "$candidate_version" ]; then
  fail 4 failed "release endpoint returned $candidate_version, not requested $requested_version"
fi
VERSION=$candidate_version
BINARY="aidlc-$TARGET"
ASSETS="$BINARY aidlc-runtime.tar.gz"
[ -z "$FROM" ] || ASSETS="$ASSETS install.sh"

for asset in $ASSETS; do
  if [ -n "$FROM" ]; then
    [ -f "$FROM/$asset" ] || fail 4 failed "offline source is missing $asset"
    cp "$FROM/$asset" "$TMP/$asset"
  else
    download "$RELEASE_URL/$asset" "$TMP/$asset"
  fi
  expected=$(sed -n "s/^\\([a-f0-9]\\{64\\}\\)  $asset\$/\\1/p" "$TMP/checksums.txt")
  [ -n "$expected" ] || fail 4 failed "No checksum for $asset."
  actual=$(sha256_file "$TMP/$asset")
  [ "$actual" = "$expected" ] || fail 4 failed "Checksum mismatch for $asset."
done

chmod 755 "$TMP/$BINARY"
if ! "$TMP/$BINARY" system lifecycle install-apply --from "$TMP" --version "$VERSION" \
  --quiet >"$TMP/apply.out" 2>"$TMP/apply.err"; then
  case "$TARGET" in
    linux-*-musl)
      if command -v apk >/dev/null 2>&1 &&
        grep -Eq 'libstdc\+\+\.so\.6|libgcc_s\.so\.1' "$TMP/apply.err"; then
        fail 1 failed \
          "Alpine Linux is missing the C++ runtime libraries required by AI-DLC" \
          "apk add libgcc libstdc++"
      fi
      ;;
  esac
  apply_message=$(sed -n '1p' "$TMP/apply.out")
  [ -n "$apply_message" ] || apply_message=$(sed -n '1p' "$TMP/apply.err")
  [ -n "$apply_message" ] || apply_message="verified installer binary failed"
  fail 4 failed "$apply_message" \
    "rerun the installer after correcting the reported release error"
fi

profile_message=
if [ -n "$PROFILE" ]; then
  "$TMP/$BINARY" system lifecycle install-profile \
    --profile "$PROFILE" --bin-dir "$BIN_DIR" --quiet >"$TMP/profile.out" ||
    fail 4 failed "$(sed -n '1p' "$TMP/profile.out")"
  profile_message=$(sed -n '1p' "$TMP/profile.out")
fi

path_command=
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    PATH="$BIN_DIR:$PATH" command -v aidlc >/dev/null 2>&1 ||
      fail 4 failed "installed aidlc is not resolvable after applying the PATH update"
    path_command="export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ "$MODE" = "json" ]; then
  printf '{"schemaVersion":1,"ok":true,"code":0,"status":"ok","message":"installed AI-DLC %s","data":{"version":"%s","runtime":"all-harnesses","binDir":"%s","pathCommand":' \
    "$(json_escape "$VERSION")" "$(json_escape "$VERSION")" "$(json_escape "$BIN_DIR")"
  if [ -n "$path_command" ]; then
    printf '"%s"' "$(json_escape "$path_command")"
  else
    printf 'null'
  fi
  printf ',"profile":'
  if [ -n "$PROFILE" ]; then
    printf '"%s"' "$(json_escape "$PROFILE")"
  else
    printf 'null'
  fi
  printf '}}\n'
elif [ "$MODE" = "quiet" ]; then
  if [ -n "$path_command" ]; then
    printf 'installed AI-DLC %s; run %s\n' "$VERSION" "$path_command"
  else
    printf 'installed AI-DLC %s\n' "$VERSION"
  fi
else
  printf 'PASS installed AI-DLC %s with all harness runtimes\n' "$VERSION"
  [ -z "$profile_message" ] || printf '%s\n' "$profile_message"
  if [ -n "$path_command" ]; then
    printf 'Add AI-DLC to PATH for this shell:\n  %s\nThen run: aidlc config\n' "$path_command"
  else
    printf 'Next: aidlc config\n'
  fi
fi

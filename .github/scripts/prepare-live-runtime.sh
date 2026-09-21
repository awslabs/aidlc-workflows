#!/usr/bin/env bash
set -euo pipefail

live_user=aidlc-live
case "$(uname -s)" in
  Linux) live_home=/home/aidlc-live ;;
  Darwin) live_home=/Users/aidlc-live ;;
  *) echo 'No separate-user live runtime is implemented on this OS' >&2; exit 1 ;;
esac
live_root="$live_home/workspace"
live_tools=/usr/local/lib/aidlc-live
live_path="$live_tools/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mode="${1:-prepare}"
family="${2:-}"

if [[ -z "${GITHUB_WORKSPACE:-}" || ! -d "$GITHUB_WORKSPACE" ]]; then
  echo 'GITHUB_WORKSPACE must name the trusted checkout' >&2
  exit 1
fi

if [[ "$mode" == prepare ]]; then
  case "$family" in claude-sdk|claude-tui|codex|opencode|release-contract|isolation) ;; *) exit 2 ;; esac
  if id "$live_user" >/dev/null 2>&1; then
    echo 'Refusing to reuse an existing live runtime identity' >&2
    exit 1
  fi
  if [[ "$(uname -s)" == Linux ]]; then
    sudo adduser --system --home "$live_home" --shell /bin/bash --group "$live_user"
  else
    password="$(openssl rand -hex 16)"
    sudo sysadminctl -addUser "$live_user" -home "$live_home" -password "$password"
    unset password
    sudo dscl . -create /Users/aidlc-live IsHidden 1
  fi
  live_group="$(id -gn "$live_user")"
  sudo install -d -m 700 -o "$live_user" -g "$live_group" "$live_home" "$live_root" "$live_home/tmp" "$live_home/.bun" "$live_home/.cache"
  sudo cp -a "$GITHUB_WORKSPACE/." "$live_root/"
  sudo chown -Rh "$live_user:$live_group" "$live_root"
  sudo install -d -m 755 "$live_tools/bin" "$live_tools/node_modules"
  bun_bin="$(command -v bun)"
  node_bin="$(node -p 'process.execPath')"
  sudo install -m 755 "$bun_bin" "$live_tools/bin/bun"
  sudo install -m 755 "$node_bin" "$live_tools/bin/node"
  sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" "$live_tools/bin/bun" -e 'const fs=require("fs"),p=require("path");function walk(path){const s=fs.lstatSync(path);if(s.isSymbolicLink())return;fs.chmodSync(path,s.isDirectory()?0o700:(s.mode&0o777)|0o600);if(s.isDirectory())for(const name of fs.readdirSync(path))walk(p.join(path,name));}walk(process.argv[1])' "$live_root"
  npm_root="$(npm root -g)"
  if [[ -d "$npm_root" ]]; then sudo cp -a "$npm_root/." "$live_tools/node_modules/"; fi
  sudo chmod -R a+rX,go-w "$live_tools"
  case "$family" in
    claude-*) cli=claude ;;
    codex) cli=codex ;;
    opencode) cli=opencode ;;
    *) cli='' ;;
  esac
  if [[ -n "$cli" ]]; then
    target="$(node -e 'const fs=require("fs"),p=require("path");const target=fs.realpathSync(process.argv[1]);const root=fs.realpathSync(process.argv[2]);const rel=p.relative(root,target);if(rel.startsWith("..")||p.isAbsolute(rel))process.exit(1);console.log(rel)' "$(command -v "$cli")" "$npm_root")"
    sudo ln -s "$live_tools/node_modules/$target" "$live_tools/bin/$cli"
    sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" "$cli" --version
  fi
  # Protect the runner's token-bearing files, temp scripts and original checkout.
  # Never grant the sandbox access to runner-owned Actions command files.
  sudo chmod 700 "$HOME" "$RUNNER_TEMP" "$GITHUB_WORKSPACE"
  {
    printf 'AIDLC_LIVE_HOME=%s\n' "$live_home"
    printf 'AIDLC_LIVE_ROOT=%s\n' "$live_root"
    printf 'AIDLC_LIVE_PATH=%s\n' "$live_path"
  } >> "$GITHUB_ENV"
fi

if [[ "$mode" == prepare || "$mode" == prove ]]; then
  sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" bun --version
  sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" bun -e 'const fs=require("node:fs"),os=require("node:os");const dir=fs.mkdtempSync(os.tmpdir()+"/probe-");fs.rmdirSync(dir);console.log("Sandbox temporary directory verified");'
  sudo -u "$live_user" test -r "$live_root/scripts/ci-live-filter.ts"
  if sudo -u "$live_user" test -r "$GITHUB_WORKSPACE/scripts/ci-start-credential-broker.ts"; then
    echo 'Live identity can read the trusted original checkout' >&2
    exit 1
  fi
  if [[ "$(uname -s)" == Linux ]]; then
    if sudo -u "$live_user" cat "/proc/$PPID/environ" >/dev/null 2>&1; then
      echo 'Live identity can read launcher credentials through procfs' >&2
      exit 1
    fi
  else
    if sudo -u "$live_user" /bin/ls "$HOME" >/dev/null 2>&1; then
      echo 'Live identity can read the runner home' >&2
      exit 1
    fi
  fi
  if sudo -u "$live_user" test -r "$GITHUB_ENV"; then
    echo 'Live identity can read the Actions environment file' >&2
    exit 1
  fi
  sandbox_env="$(sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" env)"
  if printf '%s\n' "$sandbox_env" | grep -Eq '^(ACTIONS_|AWS_|GITHUB_TOKEN=|GH_TOKEN=)'; then
    echo 'Live identity inherited control-plane credentials' >&2
    exit 1
  fi
  if sudo -u "$live_user" sudo -n true >/dev/null 2>&1; then
    echo 'Live identity unexpectedly has sudo authority' >&2
    exit 1
  fi
  echo 'Separate-user live runtime isolation verified'
elif [[ "$mode" == smoke ]]; then
  sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" TERM=xterm-256color AIDLC_TEST_PACKAGE_READY=1 \
    "$live_tools/bin/bun" --cwd "$live_root" tests/run-tests.ts --smoke --filter '^t01'
elif [[ "$mode" == collect ]]; then
  # Read only the live user's completed evidence; do not execute its authored files.
  # Only the dedicated account's processes are owned by this job. Drain them
  # before administrator-side copying so they cannot swap paths during collection.
  if id "$live_user" >/dev/null 2>&1; then
    sudo pkill -KILL -u "$live_user" || [[ "$?" == 1 ]]
    for _ in 1 2 3 4 5; do
      if ! pgrep -u "$live_user" >/dev/null; then break; fi
      sleep 1
    done
    if pgrep -u "$live_user" >/dev/null; then
      echo 'Isolated processes did not stop; refusing log collection' >&2
      exit 1
    fi
  fi
  if sudo test -L "$live_root/tests" || sudo test -L "$live_root/tests/logs"; then
    echo 'Refusing linked isolated log collection root' >&2
    exit 1
  fi
  if sudo test -d "$live_root/tests/logs"; then
    mkdir -p "$GITHUB_WORKSPACE/tests/logs"
    sudo cp -a "$live_root/tests/logs/." "$GITHUB_WORKSPACE/tests/logs/"
    sudo chown -Rh "$(id -un):$(id -gn)" "$GITHUB_WORKSPACE/tests/logs"
  fi
else
  echo 'Expected prepare, prove, smoke or collect' >&2
  exit 2
fi

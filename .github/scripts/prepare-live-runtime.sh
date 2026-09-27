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
live_path="$live_tools/node/bin:$live_tools/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mode="${1:-prepare}"
family="${2:-}"

if [[ -z "${GITHUB_WORKSPACE:-}" || ! -d "$GITHUB_WORKSPACE" ]]; then
  echo 'GITHUB_WORKSPACE must name the trusted checkout' >&2
  exit 1
fi

run_live() {
  sudo -u "$live_user" -H env -i PATH="$live_path" HOME="$live_home" \
    TMPDIR="$live_home/tmp" BUN_INSTALL="$live_home/.bun" XDG_CACHE_HOME="$live_home/.cache" \
    AIDLC_LIVE_ROOT="$live_root" /bin/bash --noprofile --norc -c 'cd "$AIDLC_LIVE_ROOT" && exec "$@"' aidlc-live "$@"
}

prepare_linux_bwrap() {
  # Use the distro executable and its scoped profile, never a global userns opt-out.
  # https://learn.chatgpt.com/docs/sandboxing#prerequisites
  local restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  local prior="" profile=/etc/apparmor.d/bwrap-userns-restrict
  if [[ -r "$restriction" ]]; then prior="$(cat "$restriction")"; fi
  sudo apt-get update -qq
  sudo apt-get install -y -qq bubblewrap
  if [[ "$prior" == 1 ]]; then
    if [[ ! -f "$profile" ]] || ! command -v apparmor_parser >/dev/null 2>&1; then
      sudo apt-get install -y -qq apparmor-profiles apparmor-utils
    fi
    if [[ ! -f "$profile" ]]; then
      sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict "$profile"
    fi
    sudo apparmor_parser -r "$profile"
  fi
  if [[ -n "$prior" && "$(cat "$restriction")" != "$prior" ]]; then
    echo 'AppArmor user namespace restriction changed during provisioning' >&2
    exit 1
  fi
}

prove_linux_bwrap() (
  # Exercise userns creation as the live UID, including namespace-root DAC checks.
  # Only trusted shell code runs here, with no broker or provider environment.
  resolved="$(run_live /bin/bash --noprofile --norc -c 'readlink -f "$(command -v bwrap)"')"
  [[ "$resolved" == /usr/bin/bwrap ]] || {
    echo 'Codex must resolve the distro /usr/bin/bwrap first on its live PATH' >&2
    exit 1
  }
  runner_probe=""
  host_probe=""
  trap '[[ -z "$runner_probe" ]] || rm -f -- "$runner_probe"; [[ -z "$host_probe" ]] || sudo rm -f -- "$host_probe"' EXIT
  runner_probe="$(mktemp "$RUNNER_TEMP/bwrap-runner.XXXXXX")"
  host_probe="$(sudo mktemp "$live_tools/bwrap-host.XXXXXX")"
  run_live bwrap --unshare-user --uid 0 --gid 0 --cap-drop ALL \
    --ro-bind / / --bind "$live_home" "$live_home" --chdir "$live_root" --die-with-parent \
    /bin/bash --noprofile --norc -c '
      set -euo pipefail
      [[ "$(id -u)" == 0 ]]
      probe="$(mktemp "$TMPDIR/bwrap-write.XXXXXX")"
      trap '\''rm -f -- "$probe"'\'' EXIT
      printf "namespace-write\n" > "$probe"
      [[ "$(cat "$probe")" == namespace-write ]]
      bun --version
      if /bin/ls "$1" >/dev/null 2>&1; then
        echo "Nested bubblewrap can read runner home" >&2; exit 1
      fi
      test -r "$2"
      shift 2
      for denied in "$@"; do
        if cat "$denied" >/dev/null 2>&1; then
          echo "Nested bubblewrap can read protected host file: $denied" >&2; exit 1
        fi
      done
      echo "Codex bubblewrap namespace and host-file isolation verified"
    ' codex-bwrap "$HOME" "$live_root/scripts/ci-live-filter.ts" \
    "$GITHUB_WORKSPACE/scripts/ci-start-credential-broker.ts" "$GITHUB_ENV" \
    "/proc/$PPID/environ" "$runner_probe" "$host_probe"
)

active_live_processes() {
  # Zombies cannot execute or mutate the evidence tree; Darwin can retain them
  # while their parent reaps them. A failed process inventory still fails closed.
  /bin/ps -axo uid=,pid=,stat=,comm= |
    awk -v uid="$live_uid" '$1 == uid && $3 !~ /^Z/ { print }'
}

if [[ "$mode" == prepare ]]; then
  case "$family" in claude-sdk|claude-tui|codex|opencode|release-contract|isolation) ;; *) exit 2 ;; esac
  if id "$live_user" >/dev/null 2>&1; then
    echo 'Refusing to reuse an existing live runtime identity' >&2
    exit 1
  fi
  if [[ "$(uname -s)" == Linux ]]; then
    if [[ "$family" == codex ]]; then prepare_linux_bwrap; fi
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
  sudo install -m 755 "$bun_bin" "$live_tools/bin/bun"
  # Keep the entire prepared Node prefix and execute from its own bin directory.
  # Copying a Homebrew executable alone loses @rpath/libnode and related libraries.
  # The credential-free PR isolation smoke only needs Bun and has no CLI archive.
  if [[ "$family" != isolation ]]; then
    node_root="$RUNNER_TEMP/aidlc-node"
    [[ -d "$node_root" && ! -L "$node_root" && -f "$node_root/bin/node" && ! -L "$node_root/bin/node" && -d "$node_root/lib" ]] || {
      echo 'Complete prepared Node runtime is missing' >&2
      exit 1
    }
    sudo cp -a "$node_root" "$live_tools/node"
  fi
  run_live "$live_tools/bin/bun" -e 'const fs=require("fs"),p=require("path");function walk(path){const s=fs.lstatSync(path);if(s.isSymbolicLink())return;fs.chmodSync(path,s.isDirectory()?0o700:(s.mode&0o777)|0o600);if(s.isDirectory())for(const name of fs.readdirSync(path))walk(p.join(path,name));}walk(process.argv[1])' "$live_root"
  npm_root="$RUNNER_TEMP/aidlc-cli/lib/node_modules"
  if [[ "$family" != isolation && "$family" != release-contract ]]; then
    [[ -d "$npm_root" ]] || { echo 'Prepared CLI artifact is missing' >&2; exit 1; }
    sudo cp -a "$npm_root/." "$live_tools/node_modules/"
  fi
  sudo chown -Rh "root:$(id -gn root)" "$live_tools"
  sudo chmod -R a+rX,go-w "$live_tools"
  if [[ "$(uname -s)" == Linux && "$family" == codex ]]; then
    # Preserve the distro executable's AppArmor attachment path; do not copy it.
    sudo ln -s /usr/bin/bwrap "$live_tools/bin/bwrap"
  fi
  case "$family" in
    claude-*) cli=claude ;;
    codex) cli=codex ;;
    opencode) cli=opencode ;;
    *) cli='' ;;
  esac
  if [[ -n "$cli" ]]; then
    target="$("$live_tools/node/bin/node" -e 'const fs=require("fs"),p=require("path");const target=fs.realpathSync(process.argv[1]);const root=fs.realpathSync(process.argv[2]);const rel=p.relative(root,target);if(rel.startsWith("..")||p.isAbsolute(rel))process.exit(1);console.log(rel)' "$(command -v "$cli")" "$npm_root")"
    sudo ln -s "$live_tools/node_modules/$target" "$live_tools/bin/$cli"
  fi
  # Protect the runner's token-bearing files, temp scripts and original checkout.
  # Never grant the sandbox access to runner-owned Actions command files.
  sudo chmod 700 "$HOME" "$RUNNER_TEMP" "$GITHUB_WORKSPACE"
  {
    printf 'AIDLC_LIVE_HOME=%s\n' "$live_home"
    printf 'AIDLC_LIVE_ROOT=%s\n' "$live_root"
    printf 'AIDLC_LIVE_PATH=%s\n' "$live_path"
  } >> "$GITHUB_ENV"
  # Prove relocation under the final access restrictions, before AWS setup.
  if [[ "$family" != isolation ]]; then run_live node --version; fi
  if [[ -n "$cli" ]]; then run_live "$cli" --version; fi
fi

if [[ "$mode" == prepare || "$mode" == prove ]]; then
  run_live bun --version
  run_live bun -e 'const fs=require("node:fs"),os=require("node:os");const dir=fs.mkdtempSync(os.tmpdir()+"/probe-");fs.rmdirSync(dir);console.log("Sandbox temporary directory verified");'
  sandbox_pwd="$(run_live pwd -P)"
  if [[ "$sandbox_pwd" != "$live_root" ]]; then echo 'Sandbox cwd does not match its private checkout' >&2; exit 1; fi
  run_live test -r "$live_root/scripts/ci-live-filter.ts"
  if run_live test -r "$GITHUB_WORKSPACE/scripts/ci-start-credential-broker.ts"; then
    echo 'Live identity can read the trusted original checkout' >&2
    exit 1
  fi
  if [[ "$(uname -s)" == Linux ]]; then
    if run_live cat "/proc/$PPID/environ" >/dev/null 2>&1; then
      echo 'Live identity can read launcher credentials through procfs' >&2
      exit 1
    fi
  else
    if run_live /bin/ls "$HOME" >/dev/null 2>&1; then
      echo 'Live identity can read the runner home' >&2
      exit 1
    fi
  fi
  if run_live test -r "$GITHUB_ENV"; then
    echo 'Live identity can read the Actions environment file' >&2
    exit 1
  fi
  run_live bun -e 'const re=/^(ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_RUNTIME_TOKEN|ACTIONS_RESULTS_URL|GITHUB_TOKEN|GH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_ROLE_ARN|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|ANTHROPIC_.*|KIRO_API_KEY|CURSOR_API_KEY|AIDLC_BROKER_TOKEN)$/i; const names=Object.keys(process.env).filter(key=>re.test(key)).sort(); if(names.length){console.error("Forbidden env after scrub: "+names.join(", "));process.exit(1);}'
  if run_live sudo -n true >/dev/null 2>&1; then
    echo 'Live identity unexpectedly has sudo authority' >&2
    exit 1
  fi
  if [[ "$(uname -s)" == Linux && "$family" == codex ]]; then
    prove_linux_bwrap
  fi
  echo 'Separate-user live runtime isolation verified'
elif [[ "$mode" == smoke ]]; then
  run_live env TERM=xterm-256color AIDLC_TEST_PACKAGE_READY=1 \
    "$live_tools/bin/bun" tests/run-tests.ts --smoke --filter '^t01'
elif [[ "$mode" == collect ]]; then
  # Read only the live user's completed evidence; do not execute its authored files.
  # Only the dedicated account's processes are owned by this job. Drain them
  # before administrator-side copying so they cannot swap paths during collection.
  if id "$live_user" >/dev/null 2>&1; then
    live_uid="$(id -u "$live_user")"
    if [[ "$(uname -s)" == Darwin ]]; then
      # launchd can restart per-user services after pkill. Retire only this
      # job's newly created account domains before draining its remaining PIDs.
      for domain in "gui/$live_uid" "user/$live_uid"; do
        if sudo launchctl print "$domain" >/dev/null 2>&1; then
          sudo launchctl bootout "$domain" || {
            echo "Could not retire isolated launchd domain $domain" >&2
            exit 1
          }
        fi
      done
    fi
    sudo pkill -KILL -u "$live_user" || [[ "$?" == 1 ]]
    # Read policy only from the trusted checkout, never the live user's copy.
    # This is cleanup after credentialed work, so do not reuse its expired deadline.
    cleanup_ms="$(bun -e 'const b=await import(require("node:url").pathToFileURL(process.argv[1]).href); console.log(b.remainingCleanupTimeoutMs(b.NATIVE_PROCESS_CLEANUP_TIMEOUT_MS))' "$GITHUB_WORKSPACE/tests/harness/test-budget.ts")"
    [[ "$cleanup_ms" =~ ^[1-9][0-9]*$ && "$cleanup_ms" -le 2147483647 ]] || {
      echo 'Invalid shared live-process cleanup backstop' >&2; exit 1
    }
    cleanup_deadline=$((SECONDS + (cleanup_ms + 999) / 1000))
    remaining=""
    while ((SECONDS < cleanup_deadline)); do
      remaining="$(active_live_processes)" || {
        echo 'Could not inventory isolated processes; refusing log collection' >&2
        exit 1
      }
      if [[ -z "$remaining" ]]; then break; fi
      sudo pkill -KILL -u "$live_user" || [[ "$?" == 1 ]]
      sleep 1
    done
    remaining="$(active_live_processes)" || {
      echo 'Could not inventory isolated processes; refusing log collection' >&2
      exit 1
    }
    if [[ -n "$remaining" ]]; then
      echo 'Isolated processes did not stop; refusing log collection' >&2
      printf '%s\n' "$remaining" >&2
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

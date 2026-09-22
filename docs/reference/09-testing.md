# Testing

## Overview

The AI-DLC test suite is **entirely TypeScript** — every test is a
`t*.test.ts` file run under `bun`, with zero shell (`.sh`) test files. This is
the platform-invariance guarantee by construction: the same files run
identically on macOS, Linux, and native Windows.

The suite is organized into **four levels** — `smoke`, `unit`, `integration`,
`e2e` — one directory each under `tests/`. The four levels map onto the
classic three-layer test pyramid that balances speed vs. thoroughness:

```
            /\
           /  \    ACCEPTANCE — full workflows, artifact + experience verification
          / L3 \   Level: e2e  ·  When: before releases (--release / --all)
         /------\
        /        \
       /   L2     \  STAGE — individual stages with stub input, verify artifacts
      /------------\ Level: integration  ·  When: CI push (--ci, every PR)
     /              \
    /      L1        \  PROTOCOL — contracts, structure, cross-references
   /------------------\ Levels: smoke + unit  ·  When: every local change
```

The `--ci` profile and the no-flag default both run **smoke + unit +
integration** (so the integration level rides along on every local
`bun tests/run-tests.ts`); `--release` / `--all` adds `e2e`. The pyramid above
shows where each level sits conceptually — the profile flags below are how you
actually select them.

Distribution coverage is split by contract:

- `t145-packaging-parity.test.ts` proves that copy, native, and plugin
  projections are deterministic across two independent clean packager runs.
- `t238-build-binaries.test.ts` compiles and probes the standalone binary
  closure, including native routes, hooks/adapters, project mutation, and the
  final installed layout with no `bun` on `PATH`.
- `t242-plugin-state.test.ts` proves host inventory normalization, composition
  hashes, transactional sync rollback, and ownership-safe prune.
- `t243-install-mechanism.test.ts` covers archive rejection, the shared
  transaction engine and recovery paths, project init/refresh ownership,
  checksums, lifecycle, pins, offline packages, and copy/native projection
  separation.
- `t244-install-management.test.ts` covers machine configuration, update
  discovery, installer harness selection, Windows lifecycle surfaces,
  completions, and release-workflow candidate continuity.
- `t330-release-channel-grammar.test.ts` pins the closed stable and preview
  version-id grammar, the installer and lifecycle literals of it, and a preview
  install that runs through the launcher shim.
- `t331-preview-channel-lifecycle.test.ts` covers `config --channel`,
  channel-aware `update` and `update --check`, API failure as unavailable,
  switching back to stable, preview retention, and preview pins.
- `t332-preview-release-pipeline.test.ts` covers the annotated-tag prerelease
  publication, the preview planner and notes, and the plan record. It checks
  multiple changed-source previews on one UTC day, including a later manual run
  after a scheduled publication. Unchanged sources skip; drafts and orphan tags
  permit retry planning with unoccupied ids. Workflow assertions cover
  isolation of stable tags from scheduled/manual previews, shared
  `release-preview` concurrency, CI gate ancestry, channel-specific provenance
  signers, and build stamping.

The test runner regenerates all projections under a process lock before test
discovery, so a fresh clone has no dependency on pre-existing `dist/` bytes.
CI also runs an explicit package step before each job that consumes generated
trees. Binary and release packagers perform their own regeneration and
determinism checks before reading `dist-release/`.

Release CI adds native smoke on Linux, macOS, and Windows, builds the seven
target artifacts on their native runner architectures, and executes both musl
probes in disposable Alpine containers after installing the documented
`libgcc` and `libstdc++` runtime prerequisites shared by Bun and Node.js. The
musl matrix uses
`fail-fast: false` so both architectures report before CI stages one
checksum-verified candidate. Unix and Windows lifecycle
journeys consume those bytes without signing permissions. The workflow then
attests them and uploads one workflow artifact. `release` rechecks the tag and
checksums, creates the GitHub Release in the source repository with
`GITHUB_TOKEN`, and compares the uploaded asset inventory with the candidate.
Publishing never rebuilds or repackages the candidate.

`tests/harness/release-fixture.ts` builds deterministic release directories
from the generated projection manifests and can serve them locally with
redirect, delay, truncation, captive-portal, oversized-metadata, and
missing-asset faults. Run
`bun tests/harness/release-fixture.ts --output <dir>` to author a fixture.
The normal suite stays offline; set `AIDLC_RELEASE_CONTRACT_LIVE=1` when
running t243 to opt into the public release metadata and checksum contract
check.

The deterministic e2e slice (`bash tests/run-tests.sh --debug -P 8 --e2e --filter "^t[0-9]"`) runs in CI with `--no-llm`, while local development loops default to smoke + unit + integration. Branches that touch merge, worktree, or swarm paths should also run this slice locally before review rounds, because mode-boundary regressions between ordinary-Bolt and swarm execution are invisible to the default tier.

**Filename convention.** A test's filename is `t<NN>[-description].test.ts` —
just the level directory it lives in and an optional human description. There
is **no mechanism segment** in the name: a test's mechanism (whether it spawns
a CLI, drives the SDK, or renders a live TUI) is a *derived set* computed from
the drivers its body actually calls, not declared in the filename. The
machine-checked index of what each test covers lives in
`tests/.coverage-registry.json` (generated by `tests/gen-coverage-registry.ts`
from the `covers:` headers on disk), not in a hand-maintained table here — see
[Test Registry](#test-registry) below.

## Layer 1: Protocol (every change, no LLM, seconds)

Verifies the orchestrator's structural correctness without invoking the LLM. If these pass, the protocol is internally consistent — stages reference valid files, inputs/outputs chain correctly, routing tables match stage files.

**Levels:** smoke, unit, integration

**What it tests:**
- File existence, permissions, naming conventions (smoke)
- All 17 hook sources through copy/native dispatch, stage frontmatter, knowledge inventory (unit)
- Scope-stage mapping, graph consistency, stage I/O contract chains, protocol compliance (integration)
- Stage output-to-step validation: all declared outputs referenced in instruction steps (integration, deterministic via the `aidlc-validate.ts` CLI tool)

**Run:** `bun tests/run-tests.ts` (default, no flags needed). `bash tests/run-tests.sh` is a compatibility wrapper for existing POSIX commands.

## Layer 2: Stage (CI push, LLM, minutes)

Runs individual stages in isolation with known workspace + state fixtures. Verifies each stage produces correct artifacts when given deterministic input.

**Levels:** integration

**What it tests:**
- Preflight health gate: Claude CLI on PATH, AWS credentials valid, Claude responds (exit 0), response non-empty (preflight)
- CLI tool utility handlers: intent-create, --doctor, --status, --stage, --phase (integration)
- Individual stages with greenfield/brownfield stubs, artifact verification (integration)

**Run:** `bun tests/run-tests.ts --ci`

## Layer 3: Acceptance (release, LLM, hours)

Runs full workflows and verifies the experience: beyond state transitions, it checks artifact content, cross-stage coherence, and domain correctness.

**Levels:** e2e

**What it tests:**
- Full bugfix lifecycle with brownfield stub + artifact assertions
- Full POC lifecycle with greenfield stub + artifact assertions
- State progression, scope routing, audit completeness, jump mechanics
- LLM semantic review of stage instruction quality (clarity, logical flow, ambiguity detection)

**Run:** `bun tests/run-tests.ts --release`

## Cross-Platform Coverage

The test suite runs on macOS, Linux, and Windows through the native Bun runner:

```bash
bun tests/run-tests.ts [--ci | --all --debug -P 8]
```

`bash tests/run-tests.sh ...` remains as a POSIX compatibility wrapper and delegates to the same TypeScript runner. Repository tests and copy-channel hooks/tools require `bun`; native release projections invoke hooks/tools through the installed `aidlc` binary. Bash is not the primary runner substrate.

Terminal sessions default to native `bun` on all three platforms; `tmux` is an
explicit alternative on Linux/macOS. On macOS, containment uses start-time-checked
process identities and an inherited `AIDLC_TUI_CONTAINMENT` token to find detached
double-fork descendants after they reparent to launchd. A descendant that both
escapes ancestry and execs with a scrubbed environment is undetectable on macOS;
Linux subreaper containment and Windows Job Objects do not have this limitation.

**Portability constraints baked into the suite:**

- **Paths**: `createTestProject` in `tests/harness/fixtures.ts` normalizes temporary project paths so they round-trip cleanly through JSON and native `bun`.
- **In-place edits**: Prefer TypeScript file writes in tests. If a shell helper is unavoidable, avoid BSD/GNU-specific `sed -i` forms.
- **`grep -qiF`**: Git Bash has a known bug combining `-i` and `-F`. Use `-i` alone if your pattern has no regex metacharacters. Tests hit this in t16 before it was fixed.
- **`tar` archives**: macOS `tar` injects `._*` AppleDouble sidecar files by default. When bundling source for cross-platform test runs, use `COPYFILE_DISABLE=1 tar …` or `git archive`.
- **LLM timing on Windows**: Bedrock calls from Windows EC2 can be meaningfully slower than from macOS (first-call cold start, MSYS process fork overhead). SDK/tui tests should assert on driver result surfaces and let the runner's preflight/per-file Claude gate separate absent substrate from real failures.

**Running the suite on Windows manually:**

1. Install Bun **1.3.14 or newer**, Node.js for the suite's other tooling, and the Claude Code CLI.
2. Install Git for Windows if you are running the full suite or the POSIX wrapper compatibility smoke; the native runner path itself does not require Bash.
3. Install the repository's dev dependencies so Bun can resolve `@xterm/headless`. The default Windows TUI backend uses Bun's native PTY.
4. Set `AIDLC_TUI_LIVE=1` for live Claude TUI coverage. Leave `AIDLC_TUI_BACKEND` unset or set it to `auto`/`bun`; use `AIDLC_BUN_BIN` to select a concrete `bun.exe` when needed. To select the legacy Windows backend explicitly, set `AIDLC_TUI_BACKEND=node-pty`, install `node-pty`, and set `AIDLC_NODE_BIN` if Node is not on `PATH`.
5. For the Kiro IDE slice, install and sign in to Kiro IDE, then set `AIDLC_KIRO_IDE_LIVE=1`. Run the GUI tests in that user's logged-in desktop session. A scheduled task can use “Run only when user is logged on” to launch the runner in this session. The default Windows binary is `%LOCALAPPDATA%\Programs\Kiro\Kiro.exe`; override it with `AIDLC_KIRO_IDE_BIN`.
6. Run `bun tests/run-tests.ts --all --debug -P 8`.

No WSL or Docker is required; the supported validation substrate is native Windows.

For Kiro CLI coverage, put the signed-in native `kiro-cli.exe` on `PATH`.
Pin `AIDLC_BUN_BIN` to the validated Bun executable and keep its directory first
on `PATH`; Kiro installations can include an older bundled Bun.
Set `AIDLC_KIRO_ACP_LIVE=1` for ACP files. For terminal files, set
`AIDLC_KIRO_TUI_LIVE=1` and `AIDLC_TUI_LIVE=1`; the native Bun terminal backend
handles Windows input and screen capture. These files check the CLI, account,
and selected terminal backend before running, with the same journey assertions
on each supported platform.

**Repeatable MR10 Windows EC2 runbook:**

1. Stand up a disposable Windows Server 2022 host with SSM access:

   ```bash
   aws cloudformation deploy \
     --stack-name aidlc-windows-test \
     --template-file tests/harness/windows/windows-test.cfn.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides VpcId=vpc-... SubnetId=subnet-...
   ```

2. Sync the committed git tree under test:

   ```bash
   bun tests/harness/windows/sync.ts --stack-name aidlc-windows-test HEAD
   ```

3. Install repo dev dependencies on the box:

   ```bash
   bun tests/harness/windows/ssm-run.ts --stack-name aidlc-windows-test -- \
     powershell -ExecutionPolicy Bypass -File C:\aidlc\tests\harness\windows\setup.ps1 -ProjectDir C:\aidlc
   ```

4. Run the Windows `--all` gate with live TUI enabled:

   ```bash
   bun tests/harness/windows/ssm-run.ts --stack-name aidlc-windows-test -- \
     powershell -ExecutionPolicy Bypass -File C:\aidlc\tests\harness\windows\run-all.ps1 -ProjectDir C:\aidlc -Parallel 8
   ```

5. Tear down the host:

   ```bash
   aws cloudformation delete-stack --stack-name aidlc-windows-test
   ```

`run-all.ps1` exports `AIDLC_BUN_BIN`, `AIDLC_NODE_BIN`, and
`AIDLC_TUI_LIVE=1` before invoking `bun tests/run-tests.ts --all --debug -P <N>`.
Its preflight calls the shared `selectedTuiBackend` and `tuiUnavailableReason`
helpers through Bun to check the selected backend's prerequisites. Node
remains a full-suite and legacy-backend runbook prerequisite. Live opt-in
does not establish coverage when a prerequisite check skips a journey:
inspect the captured per-file results. The script probes the Claude binary
across `C:\Users\Administrator\.local\bin` and the systemprofile home, since
the native installer drops `claude.exe` under whichever user ran the
CloudFormation UserData bootstrap (Administrator under EC2Launch v2).

The stack defaults to **`c5.4xlarge`** — the proven size for the full `--all -P 8` live run. The e2e tier carries per-test `bun:test` timeouts (the worktree lifecycle test for Bolts lands at ~5.5s of its 5s budget on c5.4xlarge), so a smaller box (e.g. `t3.large`) tips deterministic Bolt/runtime tests into spurious timeouts under parallel load. Shrink the `InstanceType` parameter only when running a lighter tier selection.

## Terminal Driver

`tests/harness/tui-drive.ts` drives an interactive CLI through named sessions.
The shared selector in `tests/harness/tui-runtime.ts` chooses its backend from
`AIDLC_TUI_BACKEND`:

| Selection | Platform and prerequisites |
|-----------|----------------------------|
| Unset or `auto` | Native `bun` on Linux, Windows and macOS. |
| `bun` | Linux, Windows and macOS. Requires **Bun >=1.3.14**, `Bun.Terminal`, `bun:ffi`, and `@xterm/headless`. Native containment supports x64/arm64: Linux requires glibc, procfs, and kernel >=5.4 for pidfd signaling and waiting; Windows requires ConPTY; macOS uses libSystem process identities and inherited ownership tokens (see [Cross-Platform Coverage](#cross-platform-coverage) for its environment-scrubbing limitation). |
| `tmux` | Explicit alternative on Linux/macOS. Requires Bun to run the driver and `tmux` on `PATH`. |
| `node-pty` | Explicit legacy Windows backend. Requires Node with `--experimental-strip-types`, `node-pty`, and `@xterm/headless`; the driver runs under Node. |

`auto` chooses by platform; it does not fall back to another backend when
prerequisites are missing. Unknown values, including an empty string, are
configuration errors. `AIDLC_BUN_BIN` overrides the Bun executable for the
`bun` and `tmux` backends; `AIDLC_NODE_BIN` selects Node for `node-pty`.
Keep the same backend selection across commands for a session. The native Bun
backend requires neither tmux nor node-pty.

The native daemon in `tests/harness/tui-bun-backend.ts` uses inline
`terminal: { ... }` options on `Bun.spawn` to own the PTY and its output
callbacks. `tests/harness/tui-screen.ts` parses those bytes through
`@xterm/headless` and returns emulator replies to the PTY. Commands reach the
daemon over a local socket on Linux or a named pipe on Windows, so the PTY
and screen survive separate driver invocations.

Each native session has its own daemon, PTY, screen, and authenticated IPC
endpoint. Give parallel workers distinct session names, projects, and
`CLAUDE_CONFIG_DIR` profiles. The test runner must cap Bedrock concurrency
independently of the number of terminal sessions.

`tests/harness/tui-bun-process.ts` supervises descendants with Linux subreaper
and pidfd ownership, or a Windows Job Object. `kill` waits for confirmed
process cleanup and daemon retirement; `wait-dead` checks the daemon's
process identity. Start locks are owned by the OS and release when an
interrupted starter exits. Fixture cleanup also refuses to remove a project
while its native session has unconfirmed cleanup.

Session records and final snapshots remain under `AIDLC_TUI_BUN_ROOT`
(default: `$TMPDIR/aidlc-bun-tui`, using the OS temporary directory). Both
the default and an explicit root must be private: a real directory owned by
the current user with mode **0700** on POSIX, or on Windows a current-user
owner SID and no allow ACEs for Everyone, BUILTIN\Users or Authenticated Users.
Symlinks, junctions and other Windows reparse points are refused. The driver
creates a missing root with private permissions; it refuses an unsafe existing
root rather than changing its permissions. On POSIX, every explicit-root ancestor
must be owned by the current user or root, with no group/other write bits unless
sticky; the implicit root's temporary parent must be current-user-owned or mode
**1777**. Windows validates root/session owner and DACL, but does not yet validate
ancestor ACL trust; the generation handshake below remains enforced. Remove an
unsafe pre-created root or point `AIDLC_TUI_BUN_ROOT` at a private directory under
trusted ancestors, and keep that setting consistent across commands.

The test runner gives each file a separate private native root under a trusted
OS temporary directory, independent of log-directory permissions. After confirmed
transport cleanup it archives session records and snapshots in the file's
`tui-bun/` artifacts and removes the temporary native root; uncertain cleanup
retains the live namespace for diagnosis.

Launch records are private regular files pinned to the root and session
directories' filesystem identities. Both clients and the daemon validate
ownership, permissions and session identity before trusting them. The daemon
also requires a **starting** record with the fresh generation supplied by the
starter through argv, before creating a PTY or supervisor, and rechecks both
recorded directory identities immediately before releasing the command. Replayed
completed records cannot authorize a command; diagnostics are never written into
an untrusted directory.

Target exit status and PTY exit status are separate: Bun reports ordinary
Linux slave-close EIO as PTY status `1`. The driver accepts that status after
confirmed supervisor exit and cleanup; Bun's callback does not expose an errno
to distinguish other POSIX read errors.
Unreachable sessions and unconfirmed cleanup remain errors.

Captures read the current active viewport after queued output has been
parsed. Plain text joins soft-wrapped rows and trims trailing blank lines;
ANSI capture is reconstructed from the current cells and their attributes,
including palette and RGB colors. Scrollback and previously erased output
are excluded. JSON retains the full physical grid, including blank cells and
width-zero continuation cells for wide characters.

The existing `start`, `send`, plain `capture`, `startup`, and `wait` commands
retain their calling conventions. `send --keys "<text>" --literal` sends
literal text; without `--literal`, named keys are interpreted and arbitrary
text such as `1`/`2` remains literal. Enter is appended unless `--no-enter` is
set. `wait --stable-ms N` retains its screen-stability condition, and
`startup --ready-pattern "<regex>"` retains its startup navigation behavior.

The Bun backend supports these capture and input commands:

| Command | Behavior |
|---------|----------|
| `resize --session <name> --width N --height N` | Resizes both the PTY and emulator: columns 2–500, rows 1–200, at most 40,000 cells. |
| `paste --session <name> --text "<text>"` | Pastes text with **no implicit Enter**. Uses bracketed-paste markers only when the application has enabled that mode. CRLF and lone LF become CR; existing lone CR is retained. |
| `capture --session <name> --physical` | Returns plain text with physical visible rows; preserves the default logical capture API. |
| `capture --session <name> --json` | Returns a coherent `TuiSnapshot` with full cell data. |
| `capture --session <name> --ansi` | Returns the current viewport with cell colors and styles as ANSI sequences. |

Menu detection always consumes physical rows. Bun derives these from snapshot cells without changing `text`, wrap flags, or ANSI; tmux omits `-J` for these reads. This prevents ConPTY wrap metadata from joining visible menu options onto preceding rows. External automation can select `capture --physical`, separately from `--json` and `--ansi`.

`wait --pattern` and `startup --ready-pattern` default to `--view auto`: physical text is tried first, with logical text from the same frame as fallback. This preserves literal patterns spanning a genuine soft wrap while supporting row-anchored UI patterns. Use `--view physical` or `--view logical` to select one interpretation. Bun obtains both from one snapshot; tmux captures both in a single synchronous command list. Menu actions always inspect the physical view, regardless of pattern-view selection. Stability is measured on the matched view without restarting the overall deadline.

`resize`, `paste`, and `capture --json` require the Bun backend. ANSI capture
is also available with tmux. `--json` and `--ansi` are mutually exclusive.

Invoke these through the same driver, for example:

```bash
bun tests/harness/tui-drive.ts resize --session demo --width 120 --height 40
bun tests/harness/tui-drive.ts paste --session demo --text "draft input"
bun tests/harness/tui-drive.ts capture --session demo --json
```

`TuiSnapshot` is defined in `tests/harness/tui-screen.ts`: it contains
`sequence`, `cols`, `rows`, zero-based `cursor: { x, y }`, `buffer`
(`normal` or `alternate`), `text`, `ansi`, and `lines`. Each line has a
`wrapped` flag and a `cells` array. Each cell carries `chars`, `width`,
`fg`/`bg` colors (`mode: default|palette|rgb`, numeric `value`), and boolean
`bold`, `dim`, `italic`, `underline`, `inverse`, `invisible`, and
`strikethrough` attributes. The sequence advances after parsed output or a
resize; an unchanged capture does not advance it. Cursor `x` can equal
`cols` when a wrap is pending.

The unit suites `tests/unit/t-tui-runtime.test.ts` and
`tests/unit/t-tui-screen.test.ts` define deterministic checks for runtime
selection and terminal transcripts. The screen suite includes UTF-8
regressions for:

- The exact 85-byte ANSI/Unicode preflight payload at all 86 two-chunk split positions, including empty edge chunks.
- Every fixed chunk size from 1 through 85 bytes, with a parser drain between writes; text, physical cells, widths, colors, and ANSI must agree.
- All byte partitions of selected 2-, 3-, and 4-byte characters containing `0x80` continuation bytes.
- Incomplete UTF-8 retained across `flush()` calls until the remaining bytes arrive.
- Malformed UTF-8 rendered as `U+FFFD` replacement cells instead of silently disappearing.

The screen uses an incremental `StringDecoder` before xterm's string API:
xterm 5.5's byte decoder can lose a character when a saved continuation byte
is `0x80`, as in a fragmented em dash (`E2 80 94`).

`tests/unit/t-tui-bun-process-linux.test.ts` exercises real Linux supervision;
`tests/integration/t-tui-bun-lifecycle.test.ts` covers Windows Job Object,
signal, and descendant cleanup. `tests/unit/t-tui-process-identity.test.ts`
covers identities and lock release, including interrupted starters.
`tests/integration/t-tui-bun-backend.test.ts` runs the public CLI against
token-free targets, including eight simultaneous sessions, input, ANSI/cell
capture, resizing, paste, restart, IPC errors, and daemon retirement.

The TUI preflight calibrates the selected backend. Its legacy Windows
ownership/CIM cases run with `AIDLC_TUI_BACKEND=node-pty`; native lifecycle
has the separate coverage above. Live model journeys retain their existing
opt-ins. Keep temporary Claude fixtures outside repository ancestors so
they do not inherit development instructions or external-import prompts.

## Preflight Validation

Before running unfiltered live-capable levels (integration or e2e), the runner executes `tests/integration/t19.test.ts` as a gate. It drives a tiny real turn through the **Claude Agent SDK** (the same live path the integration tier uses) and asserts only on deterministic surfaces. A skipped preflight closes the Claude gate without failing a default run; `AIDLC_CLAUDE_SDK_LIVE=1`, `AIDLC_TUI_LIVE=1`, or `--require-coverage` instead requires complete, non-skipped passing evidence. An actual preflight failure, timeout, or cleanup error fails the run in every mode. Whether the preflight skips or fails, deterministic files still run and Claude-dependent files receive per-file `SKIP` entries.

The SDK driver gives each `driveAidlc()` call an ephemeral `CLAUDE_CONFIG_DIR`
and disables session persistence. Live tests therefore leave the user's
`~/.claude.json` and Claude transcripts untouched, including when the home
directory is read-only inside a command sandbox. A per-call
`env.CLAUDE_CONFIG_DIR` remains available for focused calibration.

| Assertion | Surface | On fail |
|-----------|---------|---------|
| AWS credentials valid | `aws sts get-caller-identity` exits 0 (PASS-by-skip when the `aws` CLI is absent) | bail — Bedrock needs IAM auth |
| Live turn reaches a terminal result | the SDK run produces a non-`undefined` `resultEvent` (the binary the tier needs is present and reachable) | bail — substrate/API unreachable |
| Turn completes without error | `resultEvent.is_error === false` (the deterministic equal of `claude -p` exit 0; a 124/137 hang leaves it undefined) | bail — API unresponsive |
| Response is non-empty | the run captured *some* output — a `tool_result` or assistant text (presence, never content) | bail — API produced nothing |

A red here is a real environment finding (missing `claude`, expired creds), never a flake to soften — exactly the gate's job of bailing the downstream LLM tiers fast.

## Test Registry

The suite is **discovered, not registered**: `bun tests/run-tests.ts` walks the
four level directories (`tests/{smoke,unit,integration,e2e}/`) and runs every
`t*.test.ts` it finds. There is no hand-maintained per-test table to keep in
sync — adding a test file is all it takes for the runner to pick it up.

What each test *covers* is tracked mechanically in
**`tests/.coverage-registry.json`**, generated by
`bun tests/gen-coverage-registry.ts` from the `covers:` header in a test file's
leading comment block (typically line 1; a few files legitimately declare none
and simply contribute no coverage claim). The generator enumerates the framework's units across seven
classes (`function`, `audit`, `scope`, `stage`, `hook`, `subcommand`,
`render-surface`), maps each `covers:` claim onto an enumerated unit, and emits
the coverage counts plus a ratchet floor. Regenerate and verify drift with:

```bash
bun tests/gen-coverage-registry.ts          # rewrite the registry from disk
bun tests/gen-coverage-registry.ts --check  # fail if the committed registry is stale
```

`tests/.coverage-registry.json` is the authoritative, machine-checked index —
consult it (or grep the `covers:` headers directly) to find which test exercises
a given function, audit event, scope, stage, hook, subcommand, or render
surface. The `--check` mode is wired into the suite so a registry that drifts
from disk reds the gate.

> **Note:** t19 appears in both unit (`tests/unit/t19.test.ts`, the jump CLI
> tool) and integration (`tests/integration/t19.test.ts`, the live preflight
> gate) — a level/file path, not a bare ID, disambiguates such collisions.

## Trigger Points

| Trigger | Layer | Command | Where |
|---------|-------|---------|-------|
| `git commit` | L1 | `bun tests/run-tests.ts` | Local (pre-commit hook) |
| Pull request | Deterministic gate | `ci.yml`: contract checks + smoke + unit shards + native-terminal units + credential-free live OS-isolation proofs on Linux/macOS/Windows + production guards | GitHub Actions |
| Nightly preview / manual preview dispatch | Declared deep-tier matrix | `preview-release.yml` calls `full-suite.yml` for deterministic integration/e2e on Linux/macOS/Windows and enabled hosted live families; disabled legs and excluded families are reported | GitHub Actions |
| Stable tag | Exact-source evidence | `release.yml` requires a successful preview or main-branch full-suite dispatch artifact with the tag SHA and `passed: true`; excluded families and disabled legs are warned | GitHub Actions |

L1 can be enforced via a git pre-commit hook: `bun tests/run-tests.ts || exit 1`.

By maintainer decision on 2026-09-21, `main` is not production: PR CI remains the
fast gate listed above, while deterministic and enabled live deep tiers gate the preview
stage in `full-suite.yml`, called by `preview-release.yml`.

Tag the SHA of a green nightly for a stable release, or dispatch `full-suite.yml`
on `main` with `ref=<sha>` to produce or renew exact-SHA evidence. This also works
when an unchanged preview would skip publication. A deterministic PR gate alone
is not stable-release evidence.

## Stubs

### Greenfield Stub: `tests/fixtures/greenfield-todo/`

A project description with no source code. Workspace-detection classifies as greenfield. Gives the LLM deterministic intent context for ideation stages.

Contents: Just `README.md` describing a React Todo App with TypeScript and Vite.

### Brownfield Stub: `tests/fixtures/brownfield-todo/`

Minimal React+TypeScript+Vite source (~10 files, ~200 LOC). Workspace-detection classifies as brownfield. RE, requirements, and design stages have concrete code to analyze.

Contents:
- `package.json` — react, react-dom, typescript, vite, vitest
- `tsconfig.json`, `vite.config.ts`, `index.html`
- `src/main.tsx`, `src/App.tsx`
- `src/types/todo.ts` — Todo interface (id, title, completed)
- `src/components/TodoList.tsx` — list + add form (~40 lines)
- `src/components/TodoItem.tsx` — checkbox + title + delete button
- `src/hooks/useTodos.ts` — addTodo, toggleTodo, deleteTodo

### RE Artifacts Fixture: `tests/fixtures/re-artifacts/`

Pre-seeded reverse-engineering output for downstream stage tests. Copied into the test project's space-level repository store at `$PROJ/aidlc/spaces/default/codekb/<repo>/` during setup.

Contents: 4 minimal .md files (architecture-overview, technology-stack, codebase-analysis, integration-points) describing the brownfield-todo app.

### Inception Artifacts Fixture: `tests/fixtures/inception-artifacts/`

Pre-seeded inception phase output for tests that jump into construction. Copied into `$PROJ/aidlc/spaces/default/intents/<record>/inception/{requirements-analysis,domain-design,units-generation}/` during setup.

Contents: minimal .md files (requirements, the consolidated `components.md` catalogue, unit-of-work, unit-of-work-story-map) describing the Todo app. Unit name: `todo-core`.

### Construction Artifacts Fixture: `tests/fixtures/construction-artifacts/`

Pre-seeded construction phase output for tests that jump to mid-construction stages (e.g., code-generation). Copied into `$PROJ/aidlc/spaces/default/intents/<record>/construction/todo-core/functional-design/` during setup.

Contents: 1 minimal .md file (functional-design) describing the todo-core unit's component specs and state management.

## State Fixtures

| Fixture | Project Type | Scope | State | Used By |
|---------|-------------|-------|-------|---------|
| `state-pre-workspace-detection.md` | -- | feature | Welcome+scaffold done, workspace-detection next | t70, t71 |
| `state-initialization-done.md` | Greenfield | feature | Init done, intent-capture next | t73 |
| `state-brownfield-init-done.md` | Brownfield | bugfix | Init done, RE next | t72 |
| `state-mid-inception.md` | Brownfield | bugfix | RE done, requirements-analysis next | t74 |
| `state-mid-ideation.md` | Greenfield | feature | Intent+market done, feasibility next | t08, t10, t11, t12, t20, t22, t24, t25, t37 |
| `state-construction.md` | -- | -- | Construction phase | t07, t10, t11, t26, t57 |
| `state-operation.md` | -- | -- | Operation phase | t07, t10, t11 |
| `state-completed.md` | -- | -- | All stages done | t08, t11 |
| `state-jumped.md` | Brownfield | bugfix | Mid-workflow with jump history | t11, t37, t42 |
| `state-corrupted.md` | -- | -- | Invalid/corrupted state | t08, t10 |

## How to Add a Stage Test

1. Choose the stage to test and identify what state fixture it needs (the state must show that stage as the current/next stage)
2. Create or reuse a state fixture in `tests/fixtures/`
3. Create `tests/integration/tNN-stage-SLUG.test.ts` and use the shared TypeScript harness helpers (`tests/harness/fixtures.ts`, `tests/harness/sdk-drive.ts`, `tests/harness/tui-drive.ts`, `tests/harness/plugin-kit.ts`, or `tests/harness/exec-drive.ts`) rather than shell TAP helpers.
4. Run with `bun tests/run-tests.ts --integration` or directly: `bun test tests/integration/tNN-stage-SLUG.test.ts`

## How to Add Acceptance Assertions

To add artifact assertions to an existing e2e workflow test under `tests/e2e/`:

1. Read the current test and understand what it already checks
2. Add `expect(...)` assertions inside the existing `test(...)` block (bun:test
   counts assertions from the calls themselves — there is no `plan` line to keep
   in sync)
3. Use flexible patterns: match `/[Tt]odo/` against `readFileSync` content, not
   exact strings
4. Use `test.skipIf(...)` / an early return for assertions that depend on
   non-deterministic LLM output format
5. Use `expect(statSync(path).size).toBeGreaterThan(minBytes)` for size-bound checks

## Assertion Design Principles

- **Keyword classes** — Use case-insensitive regex: `[Tt]odo`, `[Rr]eact`, `[Bb]rownfield`
- **Flexible discovery** — Use `find` + `wc -l` to count files rather than checking exact names
- **Size bounds** — Use `statSync(path).size` with `toBeGreaterThan()` for minimum content
- **Graceful degradation** — Use `skip` when an assertion depends on non-deterministic LLM output
- **Structure over content** — Check for markdown headings (`^#`), file existence, directory creation before checking content

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIDLC_TEST_TIMEOUT` | `1800` | Per-`claude -p` call timeout in seconds. Set to `0` to disable. |
| `AIDLC_TUI_BACKEND` | `auto` | Terminal driver: native `bun` on Linux/Windows/macOS. Explicit values: `bun`, `tmux`, `node-pty`; see [Terminal Driver](#terminal-driver). |
| `AIDLC_TUI_BUN_ROOT` | `<os.tmpdir()>/aidlc-bun-tui` | Native records/snapshots; use the same root across commands. Must be user-owned and private (0700 on POSIX; current-user owner, no Everyone/Users/Authenticated Users allow ACEs on Windows), never a symlink/reparse point. A missing root is created privately; an unsafe existing root or identity-replaced session directory is refused. |
| `AIDLC_BUN_BIN` | current Bun executable, otherwise `bun` on `PATH` | Executable override for the Bun and tmux TUI backends. Native PTY use on Linux/Windows/macOS requires Bun >=1.3.14. |
| `AIDLC_NODE_BIN` | Node on `PATH`, then the standard Windows install path | Executable override for the explicitly selected legacy Windows `node-pty` backend. |
| `AIDLC_TEST_GUARD_PROFILE` | `fixture` (runner-set) | Runner-provided diagnostic for tests: `fixture` or `production`, selected by the runner CLI. An inherited value does not select the profile; the runner replaces it in every test child. |
| `AIDLC_TEST_COMPILED_DIR` | `<runner log dir>/compiled` (runner-set) | Run-owned handoff from t238 to t249: the verified native `aidlc` / `aidlc.exe` plus adjacent `runtime/`. The runner replaces inherited values in every child, keeping the artifact outside per-file temp cleanup and isolated from other runs. |
| `AIDLC_TEST_COMPILED_EXECUTABLE` | unset | Optional existing executable for direct, non-sharded t249 invocations without a runner handoff. Never a build destination; it cannot replace a missing sharded handoff. |
| `AIDLC_TUI_SETTING_SOURCES` | `project` | Setting sources injected into live `claude` TUI launches. Use `default` or an empty value only for focused calibration that intentionally includes user/local Claude settings. |
| `AIDLC_TUI_TRACE_POLL_MS` | `10000` | Minimum interval between `answer_gate_poll` snapshots in TUI NDJSON traces while a long journey is waiting for the next menu or disk terminator. |
| `AIDLC_ACP_DIAGNOSTIC_TRACE` | unset | Set to `1` with ACP debug tracing to write a private `<trace>.protocol.ndjson` sidecar containing tool input/chunk events, session/turn identity, cancellation requests and aggregate input shapes. Excludes agent-prose events, prompt/auth RPC bodies and process environment. Tool inputs remain private diagnostic data. Limits: 1 MiB per event and 64 MiB per file; `diagnostic_incomplete` or `json_parse_error` means the capture cannot establish complete protocol evidence. |
| `AIDLC_KIRO_IDE_LIVE` | unset | Set to `1` to run the signed-in Kiro IDE desktop journey on macOS or Windows. |
| `AIDLC_KIRO_IDE_BIN` | platform default | Override the Kiro IDE executable. Defaults to `/Applications/Kiro.app/Contents/MacOS/Electron` on macOS and `%LOCALAPPDATA%\Programs\Kiro\Kiro.exe` on Windows. |
| `AIDLC_KIRO_IDE_SEED` | generated seed | Optional Kiro user-data directory. The test copies it to a disposable temp directory before launch and never mutates the source profile. |
| `AIDLC_KIRO_IDE_DIAGNOSTICS` | unset | Optional per-file NDJSON diagnostic path. Includes up to 64 lifecycle records per IDE launch: owned PID, timestamps, browser-close protocol events, child exit/close and fallback signals. Records exclude endpoints, profile contents, raw error text and environment values; diagnostic I/O failures do not replace test failures. |

## CLI Reference

```bash
# Entrypoints
bun tests/run-tests.ts        # Native cross-platform runner
bash tests/run-tests.sh       # POSIX compatibility wrapper

# Level flags (combinable)
--smoke         # Structural validation
--unit          # Single-component isolation
--integration   # Cross-component contracts and stage/CLI utilities
--e2e           # Full lifecycle, worktree, and rendered terminal journeys

# Profile flags (shortcuts)
(default)       # smoke + unit + integration
--ci            # smoke + unit + integration
--release       # smoke + unit + integration + e2e
--all           # Same as --release

# Output modifiers
--production-guards # Run selected tests with guard bypasses and direct authority
                    # off; neutralize inherited off-switches. Default: fixture.
--verbose       # Write per-test logs to tests/logs/
--no-llm        # Force all live-model gates closed while deterministic
                # integration/e2e tests still run. Also via AIDLC_NO_LLM=1.
--debug         # Implies --verbose; streams per-test output and writes SDK/TUI
                # driver traces to tests/logs/
--filter PAT    # Only run tests whose filename matches extended regex PAT
--parallel N    # Run up to N test files concurrently within a tier (alias: -P N).
                # Default: 1 (serial). Smoke and unit tiers are always serial.
--shard N/M     # Run one duration-balanced unit shard.
                # Requires --unit with no other level or profile flags.
--isolated-e2e  # Run e2e in independent checkouts; -P sets worker count.
--e2e-plan      # Print selected files/resources without builds or test execution.
                # Requires --e2e; implies --isolated-e2e, not --e2e.
--bedrock-parallel N  # Concurrent Bedrock test files (default 2).
--kiro-parallel N     # Concurrent Kiro test files (default 2).
--ide-parallel N      # Concurrent IDE files, also charged to Kiro (default 1).
--e2e-file-timeout N  # Outer isolated-file deadline in seconds (default 10800).
--e2e-timings FILE    # Prior runner summary.txt for duration-based ordering.
--e2e-cancel-file FILE # Create this file to request cancellation on any platform.
```

`--no-llm` (or `AIDLC_NO_LLM=1`) closes the derived Claude gate and forces every
live-model opt-in to `0`: Claude TUI, Kiro ACP/TUI/IDE, Codex exec, and opencode
run. Deterministic tests in those tiers still run, including the token-free TUI
substrate preflight. This gives CI a full-tier deterministic profile without
live-model cost or flakiness, even when CLIs are installed and live variables
were inherited as `1`.

Live SDK and TUI harness drivers default to project-only Claude setting sources.
That means they load the copied test `.claude/` project settings and hooks while
excluding developer user-level hooks/settings. This mirrors the installed
framework surface and prevents local interactive preferences from changing test
behavior; explicit driver options or `AIDLC_TUI_SETTING_SOURCES` remain the
escape hatch for calibration.

`--all --debug` (and `--release --debug`) defaults `AIDLC_TUI_LIVE=1` unless the
environment already set it. This makes the "everything with traces" profile run
the live, token-spending TUI journeys by default; set `AIDLC_TUI_LIVE=0`
explicitly to keep those files on their in-test SKIP path.

An explicit **`--filter` requires execution in each selected file**. A file
whose cases are all skipped (or which declares no cases) fails the run even
when another selected file passes. A partially skipped file still passes if
at least one case executes successfully; `expect()` counts are not the
execution signal. An unmatched filter also fails, retaining `Test files: 0`
and an explanation in `failures.txt` rather than inventing a failed test.

Unfiltered suites preserve optional skips, reporting all-skipped files as
`SKIP`. `--no-llm` (or `AIDLC_NO_LLM=1`) still deliberately excludes
Claude-dependent files from mixed selections. If an explicit filter selects
only those excluded files, the run fails because no cases executed. Without
`--no-llm`, an explicitly selected Claude file fails when its substrate is
unavailable. Other explicitly filtered live files that report all cases
skipped also fail: enable their documented live variable and provide the
required CLI/authentication. A live opt-in alone is not execution evidence.

The summary and per-file logs report executed and skipped test-case counts
separately from the historical `Total assertions` field (which counts JUnit
test cases, including skips). `--verbose` / `--debug` retains Bun's
`<test-name>.junit.xml` next to the per-file log when Bun emits it.
Coverage failures name the file and remedy in `summary.txt` and
`failures.txt`; no assertion failure is invented for a skipped case.

## Guard Profiles

The default **fixture** profile keeps synthetic test setup convenient: it sets
`AIDLC_SKIP_ARTIFACT_GUARD`, `AIDLC_SKIP_HUMAN_PRESENCE_GUARD`,
`AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD`, `AIDLC_SKIP_REVISION_BACKSTOP`, and
`AIDLC_ALLOW_DIRECT_AUDIT_EVENTS` to `1` in test children. Other inherited
variables retain their existing behavior.

Use **`--production-guards` with `--filter`** for tests that provide real guard
evidence and exercise the owning commands or hooks. It applies to every test
selected by the invocation and does not change tier selection or live-model
gates. For example, exercise the runner's own profile contract:

```bash
bash tests/run-tests.sh --debug -P 8 --unit --production-guards \
  --filter '^t-runner-production-guards'
```

Production children receive `0` for the known guard skips, direct audit/state
authority switches, and recordable bypasses, including ensemble evidence,
plan approval, reviewer scope, review freeze, and usage tracking. Any inherited
`AIDLC_SKIP_*`, `AIDLC_DISABLE_*`, or `AIDLC_ALLOW_DIRECT_*` variable is also
forced to `0`. This happens after the runner loads `.claude/settings.json`
environment values, so a shell or project-settings off-switch cannot silently
change the child's initial guard profile. Explicit zeroes on recordable bypasses
also take precedence over `aidlc.settings.json` / `aidlc.settings.local.json`
bypass lists; simply deleting the variables would allow that fallback.

The runner prints `Guard profile: fixture (...)` or
`Guard profile: production (...)` at startup and in the stdout summary, and
writes the same label into `summary.txt` and per-file logs under `--verbose`
or `--debug`. Tests can assert
`process.env.AIDLC_TEST_GUARD_PROFILE === "production"` before exercising a
guard; an inherited marker never selects the profile.

This is a child-launch environment contract. Test code and harness helpers can
still override their own environment, write settings, or construct synthetic
fixtures. In particular, `resetAidlcEnv()` only deletes
`AWS_AIDLC_DEFAULT_SCOPE` and `AIDLC_SKIP_SOURCE_FRESHNESS`; it preserves the
profile marker and other guard settings, and does not restore production
zeroes after a test changes them. A production-profile label alone is not proof
that an individual test used production guard evidence. Review the selected
test's environment overrides and setup as part of that claim.

The PR workflow's `test_guards` job (`Tests (production guards)`) runs the
deterministic runner and recovery contracts with production guards enabled:

```bash
bash tests/run-tests.sh --debug -P 8 --production-guards --unit --integration \
  --no-llm --filter '^(t-runner-production-guards|t-guard-recovery-production)' \
  > "$GITHUB_WORKSPACE/tmp/ci-guard-contract/production-run.log" 2>&1
```

The job creates that log directory and always uploads its logs and `tests/logs/`
as `production-guard-evidence`. The existing `test` aggregate (`Tests (smoke +
unit)`) requires `test_guards` to succeed alongside smoke, every unit shard,
and the native-terminal matrix. The production-guard slice and native-terminal
matrix are both part of the required CI gate.

Dropping `--production-guards` from this filtered command fails because
`t-guard-recovery-production.test.ts` executes no journeys under the fixture
profile. Passing runner unit tests cannot mask that missing coverage.
The unfiltered deterministic deep jobs in the preview's `full-suite.yml` keep
their deliberate fixture profile and report the production journey file as
`SKIP`; the separate required PR production job exercises those journeys.

## Parallel Execution

`--parallel N` (or `-P N`) runs up to N test files concurrently within a tier. Default is serial (`1`).

**When it helps.** Live integration and e2e tests spend much of their wall-clock time on CLI startup and model turns. Integration helpers create a fresh project for each test. E2E families with shared profiles or generated outputs additionally need the isolated checkout mode described below.

**Spike results (2026-05-06, Opus 4.7 via Bedrock):**

| Scenario | Serial | `--parallel 4` | `--parallel 8` |
|---|---|---|---|
| 4 × `/aidlc --help` | 56s | 16s (3.5x) | — |
| 8 × `/aidlc --help` | — | — | 31s |

All 8 parallel calls observed `cache_read=73789`. This historical help-command probe observed prompt-cache reuse without throttling or corruption; it does not establish capacity for concurrent full workflows.

**What stays serial.** Smoke and unit tiers ignore `--parallel` and run serially within one checkout. Unit CI reduces wall-clock time with isolated shards instead: each GitHub Actions job owns a fresh checkout and runs its assigned files serially, so packaging tests can regenerate `dist/` without racing readers. The preflight gate (`tests/integration/t19.test.ts`) also runs serially because the LLM tiers depend on its exit status.

**Output under parallelism.** `START` markers stream live; several can appear before the first `DONE`. In normal/verbose mode, the TypeScript coordinator buffers each test's TAP body and writes it as one block when that file finishes. In `--debug` mode, Bun stdout/stderr streams live while still being written to each per-test log; parallel debug output is prefixed by file basename so overlapping workers remain attributable. SDK/TUI/Kiro-ACP driver traces are written beside the logs as `$LOG_DIR/sdk-drive-*.ndjson`, `$LOG_DIR/tui-drive-*.ndjson`, and `$LOG_DIR/kiro-acp-drive-*.ndjson`; isolated E2E places them under the file's artifact directory. The runner prints their paths at startup and at each test start. Kiro-ACP traces include tool calls and updates, output previews, permission answers, process stderr, and result/timeout/end events so a timeout can be investigated from retained evidence.

**Worker coordination.** The TypeScript runner starts one Bun test subprocess per file and tracks active promises. It waits for a file to finish before admitting another when the parallel limit is reached. Each completed file gets a `.meta` sidecar in `$LOG_DIR/_results/`; the runner reads those records to populate the summary tables. The shell wrapper delegates to this runner on every platform.

**Guidance.** For isolated E2E, use `-P 8` for checkout capacity and start with a small explicit provider limit such as `--bedrock-parallel 2`. Divide that provider allowance between simultaneous jobs and machines. Increase it only after measuring representative workflows for throttling, latency and failures. Use `--filter` to investigate an individual failure.

## Isolated E2E Workers

`--e2e --isolated-e2e` separates worker capacity from live-provider capacity.
`-P` controls the number of checkout workers. Known TUI, Codex exec, Kiro
ACP/IDE, and opencode serial files may run concurrently because each worker owns
its checkout, generated trees, application profile, temporary fixtures, terminal
namespace, and output directory. Unknown `.serial.` families retain exclusive
execution until their shared resources have been reviewed.

Temporary projects live outside Git checkouts so repository discovery cannot
inherit the runner's source tree. Failed fixtures are retained alongside the
logs after process cleanup. Fresh Claude profiles receive first-run preparation;
an owned startup model-upgrade offer is declined through its visible “No” choice
to preserve the shipped model pin.

Each file receives a private `AIDLC_TUI_BUN_ROOT` under a trusted OS temporary
directory; confirmed session records and snapshots are then archived beside its
profile and logs.
Worker cleanup uses the native driver's authenticated session controls and
checks daemon retirement, including interrupted starts. It runs after success,
timeout, and cancellation before temporary files can be removed or a worker
reused. Unconfirmed cleanup halts dispatch and retains the evidence. Legacy
tmux/node-pty cleanup remains scoped to the worker's own transports.

The coordinator snapshots the current authored files, including uncommitted
changes, and copies the generated distributions once before creating independent
worker checkouts. Default local Git clones hardlink object files where possible,
copy them across filesystems, and preserve existing alternate stores without
extending their reference chain. Linked worktrees with alternate stores use Git
transport for the initial snapshot so relative object references resolve
correctly; their selected revision is preserved. Installed dependencies are
shared; working files and Git indexes are independent. Tests still execute the same files,
fixtures, live opt-ins and assertions. Steps within a test keep their existing
order. Do not edit source or regenerate distributions while a snapshot is being
prepared.

Relative symlinks retain their original targets, including dangling links, so
writing through a fixture alias stays inside that worker. Snapshot preparation
rejects absolute links and links that escape the source root; the shared
dependency directory is an explicit exception. Tracked descendants are checked
component by component before sizing or copying; a symlink or junction in an
ancestor position is refused rather than followed, even when its leaf appears
to be a regular file. Relative IDE seed paths and
path-valued executable overrides resolve against the source checkout before the
worker starts. The IDE still copies the seed into its private profile.

Inspect the complete selection without building or starting a CLI. Combine
`--e2e-plan` with `--e2e`: it implies `--isolated-e2e` but does not select the e2e
tier itself.

```bash
bash tests/run-tests.sh --debug -P 8 --e2e --e2e-plan
```

Example for an explicitly enabled Claude TUI selection:

```bash
AIDLC_TUI_LIVE=1 bash tests/run-tests.sh --debug -P 8 \
  --e2e --isolated-e2e --filter 't-tui-(?!kiro)' \
  --bedrock-parallel 2 \
  --e2e-timings tests/logs/<previous-stamp>/summary.txt
```

`--e2e-timings` is optional. Historical durations determine scheduling order,
never selection: new files still run. Without history, source timeout values
provide rough ordering hints. The longest eligible file starts first; work
without the saturated resource can use free workers. Bedrock, Kiro and IDE limits
are independent, and an IDE file consumes both a Kiro slot and an IDE slot.

These limits count **test files**, not HTTP requests. A workflow can spawn
multiple model-using agents internally. Claude SDK/TUI, Codex and default
opencode runs share the Bedrock budget even when configured regions differ.
Kiro ACP/TUI/IDE share the Kiro budget. Account authentication remains supplied by
the host. Generated IDE seeds prepare onboarding and still require a signed-in host.
Budgets apply to one coordinator: divide the account budget between simultaneous
jobs or machines instead of giving each job the entire allowance.
These provider limits apply to isolated E2E dispatch. Integration still uses its
ordinary per-tier scheduler; bound live SDK integration with filtered file lanes
when running it alongside another host, and keep deterministic integration in a
separate checkout. Unit shards also need separate checkouts because packaging
tests regenerate shared outputs within their checkout.

Native Windows Codex files also share a `windows-codex` serial group. Fresh
profiles select the [documented elevated Windows sandbox](https://learn.chatgpt.com/docs/config-file/config-basic#windows-sandbox-mode), whose setup uses host
accounts; concurrent initialization across profiles has not yet been verified.
One Codex file runs at a time while unrelated harnesses can use free workers and
provider slots. Run only one Codex coordinator on a Windows host. Use a logged-in
interactive session for these native runs; the validated runtime's sandbox
commands could not start from the SSH service session. Linux and macOS Codex
files continue to use the Bedrock limit.

On Windows, use the same native runner with `--e2e --isolated-e2e --filter
't-ide-kiro'`, set `AIDLC_KIRO_IDE_LIVE=1`, and choose `--ide-parallel`.
Each IDE launch copies its seed to a private profile and lets Electron allocate
the debugging port. The parent waits for that child's endpoint instead of
selecting a port using its PID. Begin at one IDE file, then compare two using
observed memory and completion times. The native command is
`bun tests/run-tests.ts --debug -P 8 --e2e --isolated-e2e ...`; this path does not
depend on the older Windows wrapper's fixed installation directories.
Windows profiles use the short per-file temporary directory to keep Electron's
nested database and log paths within its path limits. Test artifacts retain
their original paths. Teardown requests closure through the owned browser's CDP
endpoint and waits for the child to close; a cleanup failure preserves the
profile and remains visible alongside any earlier test failure.
The IDE adapter also retains an event-provided session ID on prompt submission,
so session identity remains available when a workspace startup callback was
not observed. Prompts without a session ID preserve the existing fallback state.

Keep the Windows desktop session logged in for GUI runs. Check the account panel
in a disposable profile before treating an installed IDE as authenticated.
The IDE and CLI have separate login checks; a signed-in IDE does not satisfy
the Kiro CLI or Cursor CLI gates. Keep profile seeds on the Windows host and
collect test results and traces separately from their user-data directories.

The runner writes these additional artifacts under its timestamped log directory:

- `e2e-plan.json`: exact selected inventory, estimates and resource requirements.
- `e2e-events.ndjson`: dispatch/completion events, worker IDs and queue times.
- `e2e-results.json`: selected/prerequisite files, source revision/dirty state,
  worker assignment, case pass/fail/skip counts, durations, timeout/cleanup
  outcomes and diagnostic throttle-pattern counts.
- `e2e-artifacts/<test>/`: retained JUnit and isolated SDK/TUI/IDE traces.
- `e2e-worker-storage.json`: checkout pool location, estimated snapshot size,
  and whether checkout copies were retained. Windows pools use short private
  paths under the system temporary directory so deep report paths do not break
  fixture copies.

The Kiro reviewer journey saves its primary artifact and matched review receipt
before assertions. The scope-exclusion journey saves its final state and audit,
including on timeout. That journey uses a fully specified miniature security
patch while retaining whole-workflow completion and the scope-derived forbidden
stage checks; setup and both SDK drives share the original case deadline.

Per-file output is saved incrementally. An outer deadline or interrupted run
remains a failure/incomplete result; it is never converted to a passing retry.
Verbose/debug runs retain per-file JUnit and an `.execution.json` record of
effective coverage gates for every tier. These records contain coverage
controls, not the full process environment or credentials.
Every test file runs under an owned process supervisor, including ordinary
smoke/unit/integration execution. A debug-log write failure stops further
dispatch, retires admitted test processes, and leaves a nonzero runner result.
Ordinary files also receive private temporary directories and terminal
namespaces, which lets the runner retire native sessions after a test aborts.
If the result volume itself is unwritable, missing captures remain incomplete.
They cannot establish successful coverage.

Worker preparation checks free space for the snapshot and checkout copies,
plus a reserve of 512 MiB. Each isolated file checks the reserve before starting.
`AIDLC_E2E_MIN_FREE_BYTES` overrides the reserve in bytes (a nonnegative integer).
This admission check cannot predict all runtime fixture growth. Ordinary
assertion failures retain their fixtures and diagnostic records, then release
the disposable checkout pool. `AIDLC_KEEP_TEMP=1` or unconfirmed process cleanup
retains checkout copies for investigation.
Scheduling does not extend live workflow deadlines. The terminal substrate preflight
runs before selected TUI work, including filtered selections. Normal assertion
failures do not prevent unrelated files from running.

The revision-loop TUI test also stops waiting after a confirmed, completed root
HTTP 5xx failure in its fresh Claude transcript. It records the provider error
and native transcript, stops its owned answer-gate client, and performs normal
terminal cleanup. This does not retry the model, erase the failure, or change the
healthy workflow deadline. Tool output, subagent errors, recovered history, and
errors after the test's completion milestone do not trigger this early failure.

Use `--e2e-cancel-file <path>` when a controller needs portable cancellation,
especially on Windows where terminating a process does not deliver POSIX
signals. Creating that file stops dispatch and terminates active owned workers.
POSIX SIGINT/SIGTERM uses the same cleanup path. Forced host/process termination
cannot execute cleanup; the incremental results still show unfinished files.

The legacy summary and failed-file exit convention remain available.
For a required nightly gate, add `--require-coverage`: skipped cases, empty
files, unexecuted selected files, and an empty selection produce a nonzero exit.
Every verbose run writes `coverage.json` with the selected inventory and case
counts, and prints `Coverage: COMPLETE` or `INCOMPLETE` separately from test
failures. Use platform-specific selections for required gates; intentional
platform skips in a broad discovery run do not satisfy them.
The effective inventory includes automatically required preflights, even under
a narrow filename filter. `requestedFiles` counts the original selection;
`selectedFiles` includes those prerequisites once. A terminal prerequisite must
produce valid, nonempty, passing evidence with no skipped cases before a TUI
journey can start.
JUnit evidence must be a complete document whose suite totals match its
testcase records. A positive header in a truncated report cannot satisfy the
gate. Final cleanup/publication errors set the run to `ERROR`, independently of
the testcase outcomes.
`e2e-results.json` additionally distinguishes an all-skipped file from executed
coverage, and `coverageComplete` is false for skipped, empty or incomplete
files. A no-LLM or platform-specific run may legitimately have incomplete live
coverage; aggregate the expected platform/provider jobs before claiming full
nightly coverage. Throttle-pattern counts are diagnostic matches in output,
which can include quoted text; they do not establish a provider quota failure.

## Required jobs across platforms

`tests/native-terminal-profile.json` assigns deterministic terminal controls to
Linux/Bun, macOS/Bun, Windows/Bun, Linux/tmux and Windows/node-pty jobs. Portable
controls run on all three operating systems; native Linux and macOS containment,
Windows Job Object and sharing-handle checks, and compatibility backends have
explicit owners. The profile targets Linux arm64, macOS arm64 (`macos-15`) and
Windows x64; declare separate matching obligations for another architecture.
Platform-specific controls live in separately selectable test files. Their
assertions remain required by the profile.

Prepare one plan before dispatch, using the authored source that every host will
receive:

```bash
bun tests/reconcile-tests.ts prepare \
  --profile tests/native-terminal-profile.json --cohort "nightly-$(date -u +%Y%m%dT%H%M%SZ)" \
  --repo . --output tmp/native-plan.json
```

The plan contains the exact job/file/testcase inventories, cohort ID and a digest
of authored source, including uncommitted bytes. Copy the same source bytes and
plan to the other host. Keep plans and results in ignored or external storage.
Root paths, timestamps and Git commit IDs alone are not source identity.

Run each job with matching tier/filter flags and the declared backend. For
example, derive a precise filter for the native profile's Linux job:

```bash
TEST_MATRIX_PLAN=tmp/native-plan.json
TEST_MATRIX_JOB=linux-bun
TEST_MATRIX_FILTER=$(bun -e '
  const plan = await Bun.file(process.argv[1]).json();
  const job = plan.jobs.find(job => job.id === process.argv[2]);
  if (!job) throw new Error("unknown matrix job");
  const names = job.files.map(({path}) => {
    const parts = path.split("/");
    if (parts[0] !== "tests") throw new Error("expected native-profile test path");
    return `${parts[1]}-${parts.at(-1).replace(/\.test\.ts$/, "")}`
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  console.log(`^(?:${names.join("|")})$`);
' "$TEST_MATRIX_PLAN" "$TEST_MATRIX_JOB")
AIDLC_TUI_BACKEND=bun bash tests/run-tests.sh --debug -P 8 \
  --unit --integration --e2e --no-llm --isolated-e2e \
  --filter "$TEST_MATRIX_FILTER" \
  --matrix-plan "$TEST_MATRIX_PLAN" --matrix-job "$TEST_MATRIX_JOB" \
  > tmp/native-linux-run.log 2>&1
```

`--matrix-plan` and `--matrix-job` imply strict coverage. The runner verifies
the actual source, platform, architecture, selected backend and effective file
inventory before dispatch. It seals `test-matrix-receipt.json` after cleanup and
report publication, recording the actual Bun version, whitelisted live gates,
JUnit hashes and validated testcase outcomes. Source changes, missing cases,
skips and finalization failures prevent a successful receipt.
Isolated jobs also hash the worker's authored source before and after each file,
before that checkout can be reused or removed; the observations remain in
`matrix-worker-source.json`. Reconciliation refuses an output path that would
overwrite its plan, receipts or referenced JUnit evidence.
On Windows, Bun 1.3.14 can prematurely time out a synchronous child after an
asynchronous pause. Source verification retries only an early `ETIMEDOUT` from
its read-only Git queries, at most once and with the remaining original budget.
It logs that recovery; real deadline exhaustion, other errors and test failures
are not retried by this mechanism. `t-test-source-timeout.test.ts` checks both
the budget contract and the real asynchronous-gap regression.

Collect each receipt together with its stamp directory, preserving relative
JUnit paths, then reconcile all required jobs:

```bash
bun tests/reconcile-tests.ts reconcile --plan tmp/native-plan.json \
  --receipt "<linux-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<darwin-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<windows-bun-stamp>/test-matrix-receipt.json" \
  --receipt "<linux-tmux-stamp>/test-matrix-receipt.json" \
  --receipt "<windows-node-pty-stamp>/test-matrix-receipt.json" \
  --output tmp/native-matrix-result.json
```

Only a complete matching matrix exits zero. Missing jobs, wrong source/cohort or
backend, changed JUnit, real failures and conflicting receipts remain failures;
a later passing receipt cannot erase an earlier failure. Explicitly excluded
profile obligations appear as `NOT_REQUESTED`, never as fulfilled coverage.

This profile verifies the terminal driver and retained compatibility controls.
The scheduled preview now calls `full-suite.yml`, which reconciles native
receipts and requires every enabled job before publishing; disabled live legs and
excluded live families are not represented as tested coverage.

### Nightly full-suite matrix and provisioning

`Full Suite` is callable with an explicit `ref` and manually dispatchable
(default `main`). Its plan job resolves that ref once and requires the SHA to
already be an ancestor of `origin/main` before installing dependencies or
dispatching source-executing jobs. All matrix legs check out the authorized
immutable SHA. `preview-release.yml` calls it after the normal CI gate and cannot
publish unless the result has `passed: true`. Stable releases download
`full-suite-result` from successful preview runs or main-branch `workflow_dispatch`
runs of `full-suite.yml`, requiring the artifact's `sha` to equal the tag SHA and
`passed: true`; declared exclusions and disabled live lanes warn but do not block publication. Missing,
expired, wrong-source or failed evidence blocks publication. To renew evidence
for an unchanged SHA, dispatch `full-suite.yml` on `main` with `ref=<sha>`; unlike
the preview publisher, this always runs the suite even when a preview already
exists. Release validation searches the newest 100 successful runs of each source.

`live_prepare` installs dependencies and packages projections on all three hosted
OSes with contents-read permission only; POSIX pinned CLIs travel in the same
validated archive, while Windows CLI installation stays inside its isolated user.
This closes [#1306](https://github.com/awslabs/aidlc-workflows/issues/1306): installers
never run with OIDC in scope, and credentialed lanes only validate and unpack
prepared bytes. `AIDLC_NIGHTLY_LIVE=1` remains the deliberate enablement switch
for preparation and live lanes. The credential-free
Windows release-contract job remains enabled. Preview publication proceeds with
`complete: false` when the disabled lanes are skipped and other jobs pass;
stable promotion still requires `passed: true`.

The declared coverage is:

- Deterministic smoke/unit and isolated integration/e2e on Linux, macOS and Windows.
- Source-bound native terminal obligations on Linux arm64/Bun and tmux,
  macOS arm64/Bun (`macos-15`), and Windows/Bun and node-pty. Hosted Windows
  supplies Node; Bun installs the pinned dependencies and native addon.
- Claude SDK, Claude TUI, Codex, opencode and release-endpoint contracts on
  hosted Linux/macOS/Windows, including Claude plugin invocation in the strict SDK leg.
- Kiro ACP, TUI and IDE are declared exclusions pending a dedicated isolated
  Windows desktop host; local live runs remain their coverage path.
- Cursor is excluded: no credential separation is available because its vendor
  CLI reads the API key from the agent environment. Copilot remains excluded by
  account policy; neither exclusion is reported as successful coverage.

`scripts/ci-live-filter.ts --list` prints the discovered family partition.
`bun scripts/ci-live-filter.ts claude-tui --platform linux` prints an anchored
runner filter. Discovery uses each file's own integration/e2e live gate variables,
the derived Claude substrate list, and the unit release-contract opt-in; using a
generic plugin helper does not claim coverage for every provider it supports.
Unit gate-fixture tests are deterministic, not live families. `PLATFORM_ONLY`
declares separately selectable Windows-only files; it never hides a skipped case
inside a selected file. All live provider legs use `--require-coverage`;
release-contract files retain platform-conditional cases and do not use that flag.

Add `--args` to print the complete runner arguments, one per line. The script
owns tier selection: it emits only tiers with selected files, enables
`--isolated-e2e` and resource limits only when e2e files exist, and applies each
family's strict-coverage policy. An integration-only or unit-only selection does
not launch an empty isolated e2e queue. The workflow uses `--run`
to spawn the runner directly from the repository root, preserving each argument
without shell word splitting or Bash-version-specific builtins:

```bash
bun scripts/ci-live-filter.ts claude-sdk --platform linux --run -- --debug -P 4
```

For a selection containing e2e files, append `--e2e-plan` to inspect its plan
without executing tests. Do not append it to an integration-only or unit-only
selection: that mode intentionally rejects an empty e2e selection. Deterministic
`--no-llm` runs omit the closed Claude health preflight and record its file as
skipped, without treating the deliberate skip as a prerequisite failure.

Artifacts are `full-suite-native-plan`, `full-suite-native-<job>` (complete log
stamp directories and JUnit), `full-suite-native-result`,
`full-suite-deterministic-<tier>-<OS>`, `full-suite-live-<family>-<OS>`, and
`full-suite-result` (90-day retention). The final JSON records `sha`, `runId`,
`runAttempt`, `passed`, `complete`, every job's result in `legs`, variable-disabled
jobs in `disabledLegs`, and live families declared with `hosting: "excluded"` in the
sorted `excluded` list. `passed` means every enabled job succeeded, disabled live
legs were skipped, and `sha` is a 40-hex commit ID; `complete` additionally requires
no exclusions or disabled legs. Exclusions and disabled legs warn without blocking
preview/stable publication. A missing, failed, cancelled or unexpectedly skipped
job still fails, as does a live job that ran without `AIDLC_NIGHTLY_LIVE=1`.
Exclusions and disabled legs are not coverage.

Kiro ACP/TUI/IDE live families are declared exclusions in the nightly full suite,
printed as warnings and leaving `complete: false`. They need a dedicated isolated
Windows desktop host running Kiro under a separate low-privilege identity.
Local runs with `AIDLC_KIRO_ACP_LIVE=1`, `AIDLC_KIRO_TUI_LIVE=1` or
`AIDLC_KIRO_IDE_LIVE=1` remain the coverage path. A follow-up issue tracks the
hosted lane.

Provision these repository/environment settings before enabling the live lanes:

- Environment `nightly-live` holds secret `AWS_NIGHTLY_TEST_ROLE_ARN` (required).
  No Kiro/Cursor API-key workflow secret or hosted vendor-key leg is supported.
  The AWS role's OIDC trust must be scoped to
  this repository's `environment:nightly-live` subject. Set `MaxSessionDuration`
  to at least six hours; each assumption requests 21,600 seconds.
- Grant Bedrock invoke/stream access to the CI-only model table in
  `scripts/ci-credential-broker.ts`: Claude Fable 5, Opus 4.8, Sonnet 4.6 and
  Haiku 4.5 inference profiles in `us-east-1`, opencode's Sonnet 4.6 default in
  that region, and Codex `openai.gpt-5.5` through Bedrock Mantle in `us-east-2`.
  The table pins the broker allowlist and Claude client aliases; shipped user
  settings remain provider-neutral.

Claude Code and opencode npm versions are pinned in the workflow; update those
pins deliberately after verifying the registry and compatibility. CLI/authentication preflights fail
loudly rather than letting absent substrates masquerade as passing live tests.

#### Credential isolation and uploaded evidence

Live models receive repository content and can invoke tools, so treat their
shells and tool-result traces as untrusted sinks for credentials. The AWS action
returns masked step outputs without exporting AWS credentials to subsequent
steps. A trusted startup helper receives those values only in its own step env,
sends JSON over stdin to a detached, environment-scrubbed broker process, and
exits before live agents run. The broker stores credentials only in memory and
performs signed STS `GetCallerIdentity` at startup; only its nonsecret account,
ARN and loopback port leave the broker. There is no credential-returning route,
credential process, credentials file or credential-bearing agent environment.

The loopback proxy admits only the configured model IDs and
`POST /model/<id>/(invoke|invoke-with-response-stream|converse|converse-stream)`
(optionally under `/bedrock`), plus Codex Mantle
`POST /openai/v1/responses` with `model: openai.gpt-5.5`. It removes client
authentication headers and signs each upstream request; successful streams are
forwarded byte-for-byte. Other routes are forbidden, redirects are not followed,
and upstream error bodies are suppressed because AWS errors can echo signatures.

Claude uses documented `ANTHROPIC_BEDROCK_BASE_URL` and
`CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`; its t19 preflight checks the broker's startup
identity, followed by a real SDK turn. Codex 0.151.0 uses a provider `base_url`
ending `/openai/v1`, verified against a loopback endpoint; the service-specific
Bedrock Runtime override alone does **not** redirect Codex's Mantle traffic.
Codex and opencode profiles contain only dummy `broker` keys. Opencode's documented
provider `endpoint` override routes its AI SDK requests through the proxy.
Codex shell policy excludes provider/broker/API/GitHub/Actions variables, and the
runner strips CI control-plane credentials before launching any live test.

Hosted Linux/macOS live agents run as the separate unprivileged `aidlc-live`
user in a private checkout copy, using an explicit `sudo ... env -i` environment
and root-owned readable/executable tools. They cannot read the launcher process's
procfs environment, runner home, original checkout or Actions command files.
Windows creates a standard Users-only account and ACL-isolated work/home/tools
under `C:\aidlc-live`; Task Scheduler launches each body with a Limited batch
logon under that identity, avoiding the runner session's desktop ACL. Preparation
grants only `SeBatchLogonRight` while preserving existing principals, then verifies
an actual batch-logon task. Jobs default to 30 minutes (Git/smoke: 10 minutes;
live runs: 5h50m); tasks not started after 30 seconds fail with scheduler status
and the last 20 operational events. Explicit safe environments and UTF-8
identity/cwd/output logs remain, and tasks are unregistered after completion.
Secondary-logon `Start-Process` is a
reported fallback only if task registration itself fails. Batch sessions may
use session 0: the proof requires correct user identity and access denied for
launcher modules/`PROCESS_VM_READ`, runner directories and private credential state.
The broker stays under the runner identity; only nonsecret routes and model pins
cross into the live user's environment. Failed isolation proofs block execution.

Every PR runs `test_live_isolation` on all three OSes, using the same preparation
and proof scripts plus `--smoke --filter '^t01'` under the sandbox identity,
without provider credentials. Credential-free Windows release-contract units
remain separately runnable. Hosted Windows live model coverage is real, not an
opt-in stub or a same-user exception.

Agents can still spend through the allowlisted proxy until the job timeout;
constrain IAM model permissions, quotas and runner access. This boundary trusts
the host kernel and administrators; OS privilege escalation is not in scope.
Cursor remains excluded because its CLI exposes the API key to agent tool shells.
Kiro uses only the dedicated CI-identity Windows host's existing sign-in, without
workflow-injected API keys. Runner-owned collection copies completed logs back
for sanitization before upload; it does not execute sandbox-authored code.

Every full-suite `tests/logs/` upload first runs `scripts/ci-sanitize-logs.ts` and
is blocked if sanitization fails. Driver NDJSON, `sdk-drive*`, `tui-drive*` and
`e2e-artifacts/**/traces` are deleted by default; setting repository variable
`AIDLC_NIGHTLY_UPLOAD_TRACES=1` explicitly retains eligible text traces. Invalid
UTF-8, UTF-16, NUL-containing and other non-text files are always deleted, with
their relative paths and reasons recorded in `sanitizer-report.json`; there is
no binary/screenshot allowlist. Remaining UTF-8 text is redacted for AWS
credentials, vendor keys, bearer tokens and Anthropic keys; links are removed
without following targets. Redaction remains defense in depth, not proof against
encoded secrets; retaining raw text traces increases that residual risk.

## Kiro prompt-hook transport controls

Kiro's agent-v1 prompt hook has a default `max_output_size` of 10 KiB,
independent of the shell tool's output budget. The adapter counts the complete
UTF-8 pre-dispatch packet, including its explanatory text, before injecting a
non-steering directive. Oversized packets and every `load-steering` directive
use the existing exact-argument forwarding latch so the engine's full JSON is
returned through the actual tool call. `--single` skips hook pre-dispatch
entirely, leaving its first issuance to that tool call.

`t147-kiro-hook-adapter.test.ts` checks the 10 KiB boundary with multibyte
content, native shell aliases, retained terminal guards, and a real multipart
engine round trip. It reconstructs every delivered rule byte and passes each
opaque continuation token unchanged. A token surviving alone does not prove
complete rule delivery; moving it before truncated rules is not a valid repair.

These deterministic controls test the adapter and engine stdout. They do not
calibrate a native Kiro release's tool-channel ceiling. Before changing that
transport budget, verify complete near-limit payloads on each supported native
platform. Increasing a hook's configured `max_output_size` also requires that
calibration; it does not change this adapter's conservative injection policy.

## Unit Sharding

`--unit --shard N/M` assigns every discovered unit file to exactly one of `M`
duration-balanced shards. Assignment is deterministic and uses
`tests/unit-shard-weights.json` for the slowest files. Unlisted files receive a
one-second default weight, so new tests join the least-loaded shard without
changing the command. The runner exits 2 when `M` exceeds the number of
assignable groups, so no valid shard command can report success after running
zero files.

Each shard remains serial. Run separate shards in separate checkouts or CI jobs.
Do not run them concurrently against one repository tree because packaging
tests regenerate `dist/` and can race tests that read generated files.

The affinity list keeps cross-file prerequisites explicit. The native binary
builder test currently runs before the Copilot compiled-adapter coverage in the
same shard. After all native build/install assertions pass, t238 copies its
verified executable and adjacent `runtime/` into the runner-owned
`AIDLC_TEST_COMPILED_DIR`. Its private build/install fixtures are still removed
after the test; the published copy lives until runner cleanup (or is retained
with verbose logs). Each runner assigns a fresh handoff directory, so no shared
`build/binaries` output is overwritten or borrowed from a prior run.
Sharded unit execution requires t249 to resolve this handoff; a missing artifact
fails instead of silently skipping the compiled cases, even when an explicit
executable or an old repository build exists. Direct, non-sharded t249 runs can
still opt into `AIDLC_TEST_COMPILED_EXECUTABLE` or a local native build result.
The smoke runner contract verifies that all four CI shards are non-empty,
disjoint, cover the complete unit inventory, preserve producer/consumer ordering,
and fail compiled coverage when the producer is filtered out.

// covers: harness-instrument:tui-drive-calibration
//
// t-tui-preflight.serial.tui.test.ts — the tui tier's CAPABILITY GATE (§6.2).
//
// This is the FIRST file in the tui tier (it is `*.serial.*`, so the runner's
// serial partition runs it before the parallel fan-out — run-tests.sh:495-497),
// and it gates the rest: it proves the terminal rendering SUBSTRATE actually
// WORKS, with the t19 discipline of distinguishing ABSENT (skip-with-reason)
// from PRESENT-BUT-BROKEN (fail loud). It spends NO tokens and never touches
// claude — it drives a known-answer target that fragments a UTF-8 + ANSI payload
// byte by byte and asserts the captured grid carries every intended glyph.
//
// Why a probe, not a bare `command -v` (§6.2): presence != working.
//   - On Windows `node -e "require('node-pty')"` SUCCEEDS even when the driver
//     is run under bun — and that bun `_socket.write` wedge (microsoft/node-pty
//     #748) is exactly the misdiagnosis that cost the spike days. So we drive a
//     real round-trip, not a resolvability check.
//   - tmux can be installed yet `capture-pane` returns nothing useful; an
//     `@xterm/headless` import can resolve yet fail to reconstruct a grid. A
//     `command -v` sees none of this.
//
// SPAWN, not import (D-TUI-7): this `.test.ts` runs under bun, so it must never
// load node-pty in-process (the #748 in-process wedge). It SPAWNS tui-drive.ts
// as a subprocess — bun on macOS/Linux (the driver is just tmux there, a
// subprocess anyway), node on Windows (so node-pty never loads under bun). Same
// spawn-not-import pattern t17/t27 use for the CLI tools.
//
// The `covers:` header above claims the tui-drive instrument-calibration unit
// this preflight doubles as (§6.2/§7) — a harness-instrument claim, the same
// no-op-join form gen-coverage-registry.test.ts uses for the coverage generator
// (there is no enumerated `harness-instrument` unit class; the claim documents
// the calibration intent without inflating any covered count). The six
// `render-surface:*` statusline units the registry now enumerates are NOT
// claimed by these tests: as written, the tui tests assert the base `[AIDLC]
// ready` render, the live phase token, and the AUQ menu strip/footer — none is a
// glyph-level assertion of a specific statusline branch (phase bar / counter /
// stage name / colour / align / COMPLETE). Per the coverage-plan §4.2 "no
// guarantee weaker than the claim" rule they stay DEFERRED-tui (honestly listed),
// until a test asserts a specific branch's painted output.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyWinSessionDir,
  resolveWinNode,
  WIN_KILL_TIMEOUT_MS,
  winSessionDir,
} from "../harness/tui-drive.ts";

// ---------------------------------------------------------------------------
// Locate the driver + pick the runtime per platform (§2.1, D-TUI-7).
// On win32 the driver subprocess MUST be node (node-pty input wedges under bun,
// #748) — resolved via resolveWinNode() because the box's node is off PATH —
// and the `.ts` entrypoint needs --experimental-strip-types (node < 22.18 cannot
// run a bare `.ts`). Everywhere else it is the bun running this test (tmux
// backend), which runs `.ts` natively with no flag (byte-identical to the spike).
// ---------------------------------------------------------------------------
const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";
const WIN_NODE = IS_WIN ? resolveWinNode() : null;

// The known-answer target — no claude, no tokens. It writes every byte
// separately so Windows must preserve UTF-8 across the exact fragmented-output
// boundary that previously produced CP437 mojibake. On Windows it also refuses
// to emit the sentinel unless the real child received TERM=xterm-256color; this
// catches node-pty's Windows-only failure to propagate its `name` option into
// the environment. SGR wraps the line to prove xterm/tmux still parse ANSI while
// plain capture returns stable text.
const SENTINEL = "AIDLC_TUI_PREFLIGHT_OK";
const GLYPH_SENTINEL =
  `${SENTINEL} · ←→ ▓░ ✓✔ ❯☐☒ — ordinary text`;
const TARGET_SCRIPT = [
  'const fs = require("node:fs");',
  'if (process.platform === "win32" && process.env.TERM !== "xterm-256color") {',
  '  process.stderr.write("TERM_MISMATCH=<" + (process.env.TERM ?? "unset") + ">\\n");',
  "  process.exit(3);",
  "}",
  `const bytes = Buffer.from(${JSON.stringify(`\x1b[32m${GLYPH_SENTINEL}\x1b[0m\r\n`)}, "utf8");`,
  "let offset = 0;",
  "const timer = setInterval(() => {",
  "  fs.writeSync(1, bytes.subarray(offset, offset + 1));",
  "  offset++;",
  "  if (offset === bytes.length) clearInterval(timer);",
  "}, 2);",
  "setTimeout(() => process.exit(0), 10000);",
].join("");
const TARGET_CMD: string[] = [
  IS_WIN ? (WIN_NODE ?? "node") : process.execPath,
  "-e",
  TARGET_SCRIPT,
];

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

function drive(args: string[]): Run {
  // win32: <resolved-node> --experimental-strip-types tui-drive.ts <args>.
  // elsewhere: <bun> tui-drive.ts <args> (bun runs .ts natively, no flag).
  const [bin, prefix] = IS_WIN
    ? [WIN_NODE as string, ["--experimental-strip-types", DRIVER]]
    : [process.execPath, [DRIVER]];
  const res = spawnSync(bin, [...prefix, ...args], {
    encoding: "utf-8",
    env: process.env,
  });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(100);
  }
  return predicate();
}

async function removeTreeWithRetry(
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "")) {
        throw err;
      }
      if (Date.now() >= deadline) return false;
      await Bun.sleep(100);
    }
  }
}

function readPid(path: string): number {
  return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
}

type RecordedProcessIdentity = {
  pid: number;
  creationDate: string;
};

function readOwnershipIdentities(path: string): RecordedProcessIdentity[] {
  const ownership = JSON.parse(readFileSync(path, "utf8")) as {
    daemon?: RecordedProcessIdentity;
    daemonChildren?: RecordedProcessIdentity[];
    child?: RecordedProcessIdentity;
    orphans?: RecordedProcessIdentity[];
  };
  return [
    ...(ownership.daemon ? [ownership.daemon] : []),
    ...(ownership.daemonChildren ?? []),
    ...(ownership.child ? [ownership.child] : []),
    ...(ownership.orphans ?? []),
  ];
}

function ownershipHasPendingParentExit(path: string): boolean {
  try {
    const ownership = JSON.parse(readFileSync(path, "utf8")) as {
      childExitedAt?: string;
      orphanCleanupComplete?: boolean;
    };
    return (
      typeof ownership.childExitedAt === "string" &&
      ownership.orphanCleanupComplete !== true
    );
  } catch {
    return false;
  }
}

function ownershipMissingChildIdentity(path: string): boolean {
  try {
    const ownership = JSON.parse(readFileSync(path, "utf8")) as {
      child?: unknown;
      childExitedAt?: string;
      orphanCleanupComplete?: boolean;
    };
    return (
      ownership.child === undefined
    );
  } catch {
    return false;
  }
}

function readIdentityFile(path: string): RecordedProcessIdentity {
  return JSON.parse(
    readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
  ) as RecordedProcessIdentity;
}

function caseIdentityFiles(caseDir: string): string[] {
  return [
    join(caseDir, "target.identity.json"),
    join(caseDir, "grandchild.identity.json"),
  ];
}

function currentProcessIdentities(pids: number[]): RecordedProcessIdentity[] {
  if (pids.length === 0) return [];
  const ids = [...new Set(pids)].join(",");
  const script = [
    `$ids = @(${ids})`,
    "$rows = @(foreach ($id in $ids) {",
    "  $p = Get-Process -Id $id -ErrorAction SilentlyContinue",
    "  if ($null -ne $p) {",
    "    [pscustomobject]@{",
    "      pid = [int]$p.Id",
    '      creationDate = $p.StartTime.ToUniversalTime().ToString("o")',
    "    }",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `process identity query failed: ${
        result.stderr || (result.error as NodeJS.ErrnoException | undefined)?.code
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim() || "[]") as
    | RecordedProcessIdentity
    | RecordedProcessIdentity[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function mergeRecordedIdentities(
  ...groups: RecordedProcessIdentity[][]
): RecordedProcessIdentity[] {
  const byIdentity = new Map<string, RecordedProcessIdentity>();
  for (const identity of groups.flat()) {
    byIdentity.set(
      `${identity.pid}:${Date.parse(identity.creationDate)}`,
      identity,
    );
  }
  return [...byIdentity.values()];
}

function liveRecordedIdentities(
  recorded: RecordedProcessIdentity[],
): RecordedProcessIdentity[] {
  let currentIdentities: RecordedProcessIdentity[];
  try {
    currentIdentities = currentProcessIdentities(
      recorded.map((identity) => identity.pid),
    );
  } catch {
    // A loaded Windows host can delay the external probe. Fail closed: treat
    // every recorded identity as live so waitUntil retries instead of passing.
    return recorded;
  }
  const current = new Set(
    currentIdentities.map(
      (identity) => `${identity.pid}:${Date.parse(identity.creationDate)}`,
    ),
  );
  return recorded.filter((identity) =>
    current.has(`${identity.pid}:${Date.parse(identity.creationDate)}`)
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function gitBashPath(path: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (!m) throw new Error(`expected drive path, got ${path}`);
  return `/${m[1].toLowerCase()}/${m[2].replaceAll("\\", "/")}`;
}

function uncLocalhostPath(path: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (!m) throw new Error(`expected drive path, got ${path}`);
  return `\\\\localhost\\${m[1].toUpperCase()}$\\${m[2]}`;
}

function mixedDrivePath(path: string): string {
  const firstSeparator = path.indexOf("\\");
  if (firstSeparator < 0) throw new Error(`expected drive path, got ${path}`);
  return (
    path.slice(0, firstSeparator + 1) +
    path.slice(firstSeparator + 1).replaceAll("\\", "/")
  );
}

// ---------------------------------------------------------------------------
// ABSENT detection — runs OUTSIDE the test body so skipIf can gate the whole
// describe. A clean ABSENT result SKIPs with a reason (the .test.ts analogue of
// the spikes' TAP `1..0 # SKIP`); the band's other files then also skip. A
// PRESENT-but-BROKEN substrate is NOT caught here — it is caught inside the test
// and FAILS LOUD, so a contributor gets one clear diagnostic line.
// ---------------------------------------------------------------------------
function substrateAbsentReason(): string | null {
  if (IS_WIN) {
    // node + node-pty + @xterm/headless must all be resolvable. Resolvability is
    // necessary-not-sufficient (the wedge is a runtime fault), so absence here is
    // a clean SKIP; a resolvable-but-wedged backend is the BROKEN case the test
    // body fails on.
    //
    // node may be installed yet OFF PATH (proven on the EC2 box: node at
    // C:\Program Files\nodejs but not on PATH), so we resolve a concrete binary
    // rather than trusting a bare `node`. node ABSENT anywhere -> clean SKIP.
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    // node-pty must be require-able BY THE RESOLVED NODE. The driver loads node-pty
    // under this same node, so testing resolvability with a bare `node` (off PATH)
    // would falsely report absence; use the resolved binary. node-pty installed by
    // bun cannot be required by node (ERR_MODULE_NOT_FOUND) — only an npm-installed
    // node-pty resolves here. Absence -> clean SKIP (capability absent, not broken).
    const ptyOk =
      spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status === 0;
    if (!ptyOk) return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    return null;
  }
  // POSIX: tmux is the substrate.
  const tmuxOk = spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
  if (!tmuxOk) return "tmux not found";
  return null;
}

const ABSENT_REASON = substrateAbsentReason();

describe("t-tui-preflight (terminal substrate capability gate)", () => {
  // skipIf carries the reason in the test name so the SKIP is never silent —
  // it surfaces in the bun output and the junit <skipped/> the runner aggregates.
  test.skipIf(ABSENT_REASON !== null)(
    `substrate preserves exact fragmented Unicode and ANSI grid rendering${
      ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""
    }`,
    () => {
      const session = `aidlc_tui_preflight_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-preflight-"));
      try {
        // 1) start the known-answer target in a fixed-size session.
        const started = drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "80",
          "--height",
          "24",
          "--",
          ...TARGET_CMD,
        ]);
        // A start spawn-failure (exit 2 / nonzero) IS the present-but-broken
        // case — fail loud with the driver's stderr, never skip past it.
        if (started.rc !== 0) {
          throw new Error(
            `tui-drive start failed (rc=${started.rc}) — substrate present but ` +
              `the driver could not launch a session.\n${started.stderr}`,
          );
        }

        // 2) wait for the sentinel to paint on the reconstructed grid. A timeout
        // here is the BROKEN signal: the substrate resolved (we are past the
        // ABSENT skip) but capture returned nothing useful — e.g. node-pty present
        // but wedged under bun (#748), or tmux capture-pane returning empty.
        const waited = drive([
          "wait",
          "--session",
          session,
          "--pattern",
          SENTINEL,
          "--timeout-ms",
          "15000",
          "--stable-ms",
          "300",
        ]);
        if (waited.rc !== 0) {
          throw new Error(
            `tui-drive wait timed out for the known-answer sentinel — the ` +
              `substrate is PRESENT but BROKEN (capture empty? on Windows: ` +
              `node-pty present but running under bun? microsoft/node-pty #748). ` +
              `This is a fail-loud diagnostic, not a skip.\n${waited.stderr}`,
          );
        }

        // 3) Capture the grid and require the exact Unicode payload. On Windows
        // this is the @xterm/headless grid; on POSIX it is tmux capture-pane.
        // The SGR bytes must affect terminal attributes without leaking into the
        // plain-text capture or changing any visible code point.
        const captured = drive(["capture", "--session", session]);
        expect(captured.rc).toBe(0);
        expect(captured.stdout).toContain(GLYPH_SENTINEL);
        expect(captured.stdout).not.toContain("\x1b[");
      } finally {
        drive(["kill", "--session", session]);
        if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test.skipIf(!IS_WIN || ABSENT_REASON !== null)(
    `Windows until-file paths detect early, preserve post-write work, and reap on teardown${
      ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""
    }`,
    async () => {
      const sessionPrefix = `aidlc_tui_until_file_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-until-file-"));
      const targetScript = join(sandbox, "target.ps1");
      const childScript = join(sandbox, "child.ps1");
      const shimScript = join(sandbox, "shim target.ps1");
      const fastExitShim = join(sandbox, "fast exit shim.ps1");
      const cmdShim = join(sandbox, "claude shim.cmd");
      const legacyDaemonScript = join(sandbox, "legacy-tui-drive.ts");
      const sessions: string[] = [];

      writeFileSync(
        childScript,
        [
          "param([Parameter(Mandatory=$true)][string]$CaseDir)",
          '$PID | Set-Content -Encoding ascii (Join-Path $CaseDir "grandchild-self.pid")',
          "$identity = [pscustomobject]@{",
          "  pid = [int]$PID",
          '  creationDate = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString("o")',
          "}",
          '$identity | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $CaseDir "grandchild.identity.json")',
          "Start-Sleep -Seconds 600",
          "",
        ].join("\r\n"),
      );
      writeFileSync(
        targetScript,
        [
          "param(",
          "  [Parameter(Mandatory=$true)][string]$CaseDir,",
          "  [switch]$WriteSignal,",
          "  [switch]$ExitAfterSpawn,",
          "  [switch]$FastExit,",
          "  [int]$SignalDelayMs = 0,",
          "  [int]$HookDelayMs = 0,",
          "  [string]$TriggerFile = \"\"",
          ")",
          "$ErrorActionPreference = \"Stop\"",
          "New-Item -ItemType Directory -Force -Path $CaseDir | Out-Null",
          '$PID | Set-Content -Encoding ascii (Join-Path $CaseDir "target.pid")',
          "$identity = [pscustomobject]@{",
          "  pid = [int]$PID",
          '  creationDate = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString("o")',
          "}",
          '$identity | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $CaseDir "target.identity.json")',
          "$child = Start-Process powershell.exe -ArgumentList @(",
          '  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",',
          `  "${childScript}", "-CaseDir", $CaseDir`,
          ") -PassThru",
          '$child.Id | Set-Content -Encoding ascii (Join-Path $CaseDir "grandchild.pid")',
          "if ($ExitAfterSpawn) {",
          "  if (-not $FastExit) { Start-Sleep -Milliseconds 1000 }",
          "  exit 0",
          "}",
          "if ($WriteSignal) {",
          "  if ($TriggerFile) {",
          "    while (-not (Test-Path $TriggerFile)) { Start-Sleep -Milliseconds 50 }",
          "  }",
          "  if ($SignalDelayMs -gt 0) { Start-Sleep -Milliseconds $SignalDelayMs }",
          '  $signalDir = Join-Path $CaseDir "signals\\record"',
          "  New-Item -ItemType Directory -Force -Path $signalDir | Out-Null",
          '  "complete" | Set-Content -Encoding ascii (Join-Path $signalDir "done.txt")',
          "  if ($HookDelayMs -gt 0) { Start-Sleep -Milliseconds $HookDelayMs }",
          '  "hook-complete" | Set-Content -Encoding ascii (Join-Path $CaseDir "post-write-hook.done")',
          "}",
          "Start-Sleep -Seconds 600",
          "",
        ].join("\r\n"),
      );
      writeFileSync(
        shimScript,
        [
          '$ErrorActionPreference = "Stop"',
          'if ($args.Count -lt 1) { throw "missing case directory" }',
          "$caseDir = [string]$args[0]",
          "$received = @()",
          "if ($args.Count -gt 1) {",
          "  $received = @($args[1..($args.Count - 1)])",
          "}",
          "New-Item -ItemType Directory -Force -Path $caseDir | Out-Null",
          "$self = Get-CimInstance Win32_Process -Filter \"ProcessId = $PID\"",
          "$parent = Get-CimInstance Win32_Process -Filter \"ProcessId = $($self.ParentProcessId)\"",
          "$identity = [pscustomobject]@{",
          "  pid = [int]$self.ProcessId",
          '  creationDate = $self.CreationDate.ToUniversalTime().ToString("o")',
          "}",
          "$launcherIdentity = [pscustomobject]@{",
          "  pid = [int]$parent.ProcessId",
          '  creationDate = $parent.CreationDate.ToUniversalTime().ToString("o")',
          "}",
          '$identity | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $caseDir "shim.identity.json")',
          '$launcherIdentity | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $caseDir "shim-launcher.identity.json")',
          "$capture = [pscustomobject]@{ args = [object[]]$received }",
          '$capture | ConvertTo-Json -Depth 3 -Compress | Set-Content -Encoding utf8 (Join-Path $caseDir "shim-args.json")',
          '$signalDir = Join-Path $caseDir "signals\\record"',
          "New-Item -ItemType Directory -Force -Path $signalDir | Out-Null",
          'Write-Output "AIDLC_SHIM_READY"',
          '"complete" | Set-Content -Encoding ascii (Join-Path $signalDir "done.txt")',
          "Start-Sleep -Seconds 600",
          "",
        ].join("\r\n"),
      );
      writeFileSync(
        fastExitShim,
        [
          "param([Parameter(Mandatory=$true)][string]$CaseDir)",
          '$ErrorActionPreference = "Stop"',
          "New-Item -ItemType Directory -Force -Path $CaseDir | Out-Null",
          '$PID | Set-Content -Encoding ascii (Join-Path $CaseDir "target.pid")',
          "$identity = [pscustomobject]@{",
          "  pid = [int]$PID",
          '  creationDate = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString("o")',
          "}",
          '$identity | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $CaseDir "target.identity.json")',
          "$child = Start-Process powershell.exe -ArgumentList @(",
          '  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",',
          `  "${childScript}", "-CaseDir", $CaseDir`,
          ") -PassThru",
          '$child.Id | Set-Content -Encoding ascii (Join-Path $CaseDir "grandchild.pid")',
          "exit 0",
          "",
        ].join("\r\n"),
      );
      writeFileSync(
        cmdShim,
        [
          "@echo off",
          'powershell.exe -NoLogo -NoProfile -NonInteractive -File "%~dp0shim target.ps1" %*',
          "",
        ].join("\r\n"),
      );
      writeFileSync(
        legacyDaemonScript,
        [
          'import { spawn, spawnSync } from "node:child_process";',
          'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
          "const dir = process.env.LEGACY_SESSION_DIR;",
          "const caseDir = process.env.LEGACY_CASE_DIR;",
          "const target = process.env.LEGACY_TARGET_SCRIPT;",
          'if (!dir || !caseDir || !target) process.exit(2);',
          'writeFileSync(dir + "\\\\pid", String(process.pid));',
          'const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, "-CaseDir", caseDir], { stdio: "ignore", windowsHide: true });',
          'const log = dir + "\\\\cmd.log";',
          "let consumed = 0;",
          "setInterval(() => {",
          "  if (!existsSync(log)) return;",
          '  const raw = readFileSync(log, "utf8");',
          "  const fresh = raw.slice(consumed);",
          "  consumed = raw.length;",
          '  for (const line of fresh.split("\\n")) {',
          "    if (!line.trim()) continue;",
          "    try {",
          "      const rec = JSON.parse(line);",
          '      if (rec.kind === "kill") {',
          "        child.kill();",
          "        process.exit(0);",
          "      }",
          "    } catch {}",
          "  }",
          "}, 100);",
          "",
        ].join("\r\n"),
      );

      const runCase = async (
        label: string,
        patternFor: (caseDir: string) => string,
        expectSuccess: boolean,
        provePostWriteRace = false,
      ): Promise<void> => {
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });

        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
            ...(expectSuccess
              ? [
                  "-WriteSignal",
                  "-SignalDelayMs",
                  provePostWriteRace ? "800" : "0",
                  "-HookDelayMs",
                  provePostWriteRace ? "1000" : "0",
                  ...(provePostWriteRace
                    ? ["-TriggerFile", join(caseDir, "trigger.signal")]
                    : []),
                ]
              : []),
          ]);
          expect(started.rc, started.stderr).toBe(0);

          const pidFiles = [
            join(sessionDir, "pid"),
            join(sessionDir, "child.pid"),
            join(caseDir, "target.pid"),
            join(caseDir, "grandchild.pid"),
            join(caseDir, "grandchild-self.pid"),
          ];
          const ownershipPath = join(sessionDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                pidFiles.every(existsSync) &&
                identityFiles.every(existsSync) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);

          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          const pattern = patternFor(caseDir);
          if (provePostWriteRace) {
            writeFileSync(join(caseDir, "trigger.signal"), "begin\n");
          }
          const startedAt = Date.now();
          const gate = drive([
            "answer-gate",
            "--session",
            session,
            "--project-dir",
            caseDir,
            "--until-file",
            pattern,
            "--per-gate-timeout-ms",
            expectSuccess ? "5000" : "1200",
            "--overall-timeout-ms",
            expectSuccess ? "5000" : "1200",
          ]);
          const elapsedMs = Date.now() - startedAt;

          if (expectSuccess) {
            expect(gate.rc, gate.stderr).toBe(0);
            expect(gate.stdout).toContain("terminator met");
            expect(elapsedMs).toBeLessThan(5_000);
            if (provePostWriteRace) {
              expect(existsSync(join(caseDir, "post-write-hook.done"))).toBe(false);
              expect(liveRecordedIdentities(recorded)).toHaveLength(recorded.length);
              expect(
                await waitUntil(
                  () => existsSync(join(caseDir, "post-write-hook.done")),
                  5_000,
                ),
              ).toBe(true);
            }
            expect(drive(["kill", "--session", session]).rc).toBe(0);
          } else {
            expect(gate.rc).toBe(1);
            expect(gate.stderr).toContain("timeout");
            expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
            expect(elapsedMs).toBeLessThan(
              1_200 + WIN_KILL_TIMEOUT_MS + 2_000,
            );
          }

          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          drive(["kill", "--session", session]);
        }
      };

      const runShimCase = async (kind: "cmd" | "ps1"): Promise<void> => {
        const session = `${sessionPrefix}_shim_${kind}`;
        const caseDir = join(sandbox, `shim-${kind}`);
        const sessionDir = winSessionDir(session);
        const shimArgs = [
          "",
          "two words",
          'quote"inside',
          "amp&pipe|less<greater>",
          "caret^percent%PATH%bang!",
          "(parentheses)",
          "semi;comma,star*question?",
          "trailing\\",
        ];
        const identityFiles = [
          join(caseDir, "shim.identity.json"),
          join(caseDir, "shim-launcher.identity.json"),
        ];
        const argsPath = join(caseDir, "shim-args.json");
        const ownershipPath = join(sessionDir, "ownership.json");
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });

        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            kind === "cmd" ? cmdShim : shimScript,
            caseDir,
            ...shimArgs,
          ]);
          expect(started.rc, started.stderr).toBe(0);
          expect(
            await waitUntil(
              () =>
                identityFiles.every(existsSync) &&
                existsSync(argsPath) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);

          const rendered = drive([
            "wait",
            "--session",
            session,
            "--pattern",
            "AIDLC_SHIM_READY",
            "--timeout-ms",
            "10000",
            "--stable-ms",
            "0",
          ]);
          expect(rendered.rc, rendered.stderr).toBe(0);

          const capture = JSON.parse(
            readFileSync(argsPath, "utf8").replace(/^\uFEFF/, ""),
          ) as { args: string[] };
          expect(capture.args).toEqual(shimArgs);

          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          const startedAt = Date.now();
          const gate = drive([
            "answer-gate",
            "--session",
            session,
            "--project-dir",
            caseDir,
            "--until-file",
            "signals\\*\\done.txt",
            "--per-gate-timeout-ms",
            "5000",
            "--overall-timeout-ms",
            "5000",
          ]);
          expect(gate.rc, gate.stderr).toBe(0);
          expect(gate.stdout).toContain("terminator met");
          expect(Date.now() - startedAt).toBeLessThan(5_000);

          expect(drive(["kill", "--session", session]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          drive(["kill", "--session", session]);
        }
      };

      const runMissingTargetIdentityFastExit = async (): Promise<void> => {
        const label = "missing_target_identity";
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        const ownershipPath = join(sessionDir, "ownership.json");
        const targetExitPath = join(sessionDir, "target-exit.json");
        const targetSpawnPath = join(sessionDir, "target-spawn.json");
        const identityFiles = caseIdentityFiles(caseDir);
        const injectionTrace = join(caseDir, "target-identity-injections.log");
        const prior = process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
        const priorTrace = process.env.AIDLC_TUI_CIM_TRACE_FILE;
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });
        process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS =
          "target-start:always,target-start-fallback:always";
        process.env.AIDLC_TUI_CIM_TRACE_FILE = injectionTrace;

        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            fastExitShim,
            "-CaseDir",
            caseDir,
          ]);
          expect(started.rc, started.stderr).toBe(0);
          expect(
            await waitUntil(
              () =>
                existsSync(ownershipPath) &&
                existsSync(targetSpawnPath) &&
                existsSync(targetExitPath) &&
                existsSync(join(caseDir, "target.pid")) &&
                existsSync(join(caseDir, "grandchild.pid")) &&
                existsSync(join(caseDir, "grandchild-self.pid")) &&
                identityFiles.every(existsSync),
              20_000,
            ),
          ).toBe(true);

          const targetPid = readPid(join(caseDir, "target.pid"));
          const targetExit = JSON.parse(
            readFileSync(targetExitPath, "utf8"),
          ) as {
            child?: unknown;
            spawn?: { pid?: number };
          };
          expect(targetExit.child).toBeUndefined();
          expect(targetExit.spawn?.pid).toBe(targetPid);
          const injected = readFileSync(injectionTrace, "utf8");
          expect(injected).toContain("context=target-start");
          expect(injected).toContain("context=target-start-fallback");

          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          expect(
            await waitUntil(
              () =>
                liveRecordedIdentities([
                  readIdentityFile(join(caseDir, "target.identity.json")),
                ]).length === 0,
              10_000,
            ),
          ).toBe(true);

          const killed = drive(["kill", "--session", session]);
          expect(killed.rc, killed.stderr).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          if (prior === undefined) {
            delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
          } else {
            process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
          }
          if (priorTrace === undefined) {
            delete process.env.AIDLC_TUI_CIM_TRACE_FILE;
          } else {
            process.env.AIDLC_TUI_CIM_TRACE_FILE = priorTrace;
          }
          drive(["kill", "--session", session]);
        }
      };

      const runParentFirstExit = async (): Promise<void> => {
        const label = "parent_exit";
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });
        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
            "-ExitAfterSpawn",
          ]);
          expect(started.rc, started.stderr).toBe(0);
          const pidFiles = [
            join(sessionDir, "pid"),
            join(sessionDir, "child.pid"),
            join(caseDir, "target.pid"),
            join(caseDir, "grandchild.pid"),
          ];
          const ownershipPath = join(sessionDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                pidFiles.every(existsSync) &&
                identityFiles.every(existsSync) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);
          const targetIdentity = readIdentityFile(
            join(caseDir, "target.identity.json"),
          );
          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          expect(
            await waitUntil(
              () => liveRecordedIdentities([targetIdentity]).length === 0,
              10_000,
            ),
          ).toBe(true);
          expect(drive(["kill", "--session", session]).rc).toBe(0);
          expect(
            await waitUntil(
              () =>
                !existsSync(join(sessionDir, "pid")) &&
                !existsSync(join(sessionDir, "ownership.json")),
              10_000,
            ),
          ).toBe(true);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          drive(["kill", "--session", session]);
        }
      };

      const runStalePidOwnership = async (): Promise<void> => {
        const session = `${sessionPrefix}_stale_pid`;
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(sessionDir, { recursive: true });
        const unrelated = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"],
          { stdio: "ignore", windowsHide: true },
        );
        const unrelatedPid = unrelated.pid;
        if (unrelatedPid === undefined) throw new Error("unrelated process has no pid");
        try {
          expect(await waitUntil(() => pidAlive(unrelatedPid), 5_000)).toBe(true);
          writeFileSync(join(sessionDir, "pid"), String(unrelatedPid));
          writeFileSync(join(sessionDir, "child.pid"), String(unrelatedPid));
          writeFileSync(
            join(sessionDir, "meta.json"),
            JSON.stringify({ cols: 80, rows: 24, ownerToken: "stale-owner-token" }),
          );

          const killed = drive(["kill", "--session", session]);
          expect(killed.rc, killed.stderr).toBe(0);
          expect(pidAlive(unrelatedPid)).toBe(true);
          expect(existsSync(join(sessionDir, "pid"))).toBe(false);
          expect(existsSync(join(sessionDir, "child.pid"))).toBe(false);
        } finally {
          try {
            process.kill(unrelatedPid, "SIGTERM");
          } catch {
            // already exited
          }
          await waitUntil(() => !pidAlive(unrelatedPid), 5_000);
        }
      };

      const runTokenlessLegacyOwnership = async (): Promise<void> => {
        const staleSession = `${sessionPrefix}_legacy`;
        const actualSession = `${staleSession}_long`;
        const staleDir = winSessionDir(staleSession);
        const actualDir = winSessionDir(actualSession);
        const caseDir = join(sandbox, "legacy_long");
        sessions.push(staleSession, actualSession);
        mkdirSync(caseDir, { recursive: true });
        try {
          const started = drive([
            "start",
            "--session",
            actualSession,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
          ]);
          expect(started.rc, started.stderr).toBe(0);
          const pidFiles = [
            join(actualDir, "pid"),
            join(actualDir, "child.pid"),
            join(caseDir, "target.pid"),
            join(caseDir, "grandchild.pid"),
            join(caseDir, "grandchild-self.pid"),
          ];
          const ownershipPath = join(actualDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                pidFiles.every(existsSync) &&
                identityFiles.every(existsSync) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);
          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );

          mkdirSync(staleDir, { recursive: true });
          writeFileSync(join(staleDir, "pid"), String(readPid(join(actualDir, "pid"))));
          writeFileSync(
            join(staleDir, "child.pid"),
            String(readPid(join(actualDir, "child.pid"))),
          );
          writeFileSync(
            join(staleDir, "meta.json"),
            JSON.stringify({ cols: 80, rows: 24 }),
          );

          const staleKill = drive(["kill", "--session", staleSession]);
          expect(staleKill.rc, staleKill.stderr).toBe(0);
          expect(liveRecordedIdentities(recorded)).toHaveLength(recorded.length);
          expect(drive(["capture", "--session", actualSession]).rc).toBe(0);

          expect(drive(["kill", "--session", actualSession]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              5_000,
            ),
          ).toBe(true);
        } finally {
          drive(["kill", "--session", staleSession]);
          drive(["kill", "--session", actualSession]);
        }
      };

      const runPreUpgradeLegacySession = async (): Promise<void> => {
        const session = `${sessionPrefix}_preupgrade`;
        const legacyDir = legacyWinSessionDir(session);
        const caseDir = join(sandbox, "preupgrade");
        sessions.push(session);
        mkdirSync(legacyDir, { recursive: true });
        mkdirSync(caseDir, { recursive: true });
        writeFileSync(
          join(legacyDir, "meta.json"),
          JSON.stringify({ cols: 80, rows: 24 }),
        );
        const daemon = spawn(
          WIN_NODE as string,
          [
            "--experimental-strip-types",
            legacyDaemonScript,
            "__win-daemon",
            "--session",
            session,
          ],
          {
            env: {
              ...process.env,
              LEGACY_SESSION_DIR: legacyDir,
              LEGACY_CASE_DIR: caseDir,
              LEGACY_TARGET_SCRIPT: targetScript,
            },
            stdio: "ignore",
            windowsHide: true,
          },
        );
        try {
          const pidFiles = [
            join(legacyDir, "pid"),
          ];
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                pidFiles.every(existsSync) &&
                identityFiles.every(existsSync),
              20_000,
            ),
          ).toBe(true);
          const recorded = mergeRecordedIdentities(
            currentProcessIdentities(pidFiles.map(readPid)),
            identityFiles.map(readIdentityFile),
          );
          expect(drive(["kill", "--session", session]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              30_000,
            ),
          ).toBe(true);
          expect(existsSync(legacyDir)).toBe(false);
        } finally {
          try {
            process.kill(daemon.pid ?? -1, "SIGTERM");
          } catch {
            // already exited
          }
        }
      };

      const runCollidingSessions = async (): Promise<void> => {
        const sessionA = `${sessionPrefix}_collision/a`;
        const sessionB = `${sessionPrefix}_collision_a`;
        const caseA = join(sandbox, "collision-a");
        const caseB = join(sandbox, "collision-b");
        sessions.push(sessionA, sessionB);
        mkdirSync(caseA, { recursive: true });
        mkdirSync(caseB, { recursive: true });
        const startSession = (
          session: string,
          caseDir: string,
        ): Run =>
          drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
          ]);
        try {
          expect(startSession(sessionA, caseA).rc).toBe(0);
          expect(startSession(sessionB, caseB).rc).toBe(0);
          const ownerA = join(winSessionDir(sessionA), "ownership.json");
          const ownerB = join(winSessionDir(sessionB), "ownership.json");
          const identitiesA = caseIdentityFiles(caseA);
          const identitiesB = caseIdentityFiles(caseB);
          expect(
            await waitUntil(
              () =>
                existsSync(ownerA) &&
                existsSync(ownerB) &&
                identitiesA.every(existsSync) &&
                identitiesB.every(existsSync),
              20_000,
            ),
          ).toBe(true);
          const recordedA = mergeRecordedIdentities(
            readOwnershipIdentities(ownerA),
            identitiesA.map(readIdentityFile),
          );
          const recordedB = mergeRecordedIdentities(
            readOwnershipIdentities(ownerB),
            identitiesB.map(readIdentityFile),
          );

          expect(drive(["kill", "--session", sessionA]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recordedA).length === 0,
              5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recordedB)).toHaveLength(recordedB.length);
          expect(drive(["capture", "--session", sessionB]).rc).toBe(0);

          expect(drive(["kill", "--session", sessionB]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recordedB).length === 0,
              5_000,
            ),
          ).toBe(true);
        } finally {
          drive(["kill", "--session", sessionA]);
          drive(["kill", "--session", sessionB]);
        }
      };

      const runOrdinaryCimFailure = async (): Promise<void> => {
        const label = "cim_kill";
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });
        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
          ]);
          expect(started.rc, started.stderr).toBe(0);
          const pidFiles = [
            join(sessionDir, "pid"),
            join(sessionDir, "child.pid"),
            join(caseDir, "target.pid"),
            join(caseDir, "grandchild.pid"),
            join(caseDir, "grandchild-self.pid"),
          ];
          const ownershipPath = join(sessionDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                pidFiles.every(existsSync) &&
                identityFiles.every(existsSync) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);
          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          const prior = process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
          process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = "kill-daemon";
          try {
            const killed = drive(["kill", "--session", session]);
            expect(killed.rc, killed.stderr).toBe(0);
          } finally {
            if (prior === undefined) {
              delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
            } else {
              process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
            }
          }
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              5_000,
            ),
          ).toBe(true);
        } finally {
          drive(["kill", "--session", session]);
        }
      };

      const runParentFirstCimFailure = async (): Promise<void> => {
        const label = "parent_exit_cim";
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });
        const prior = process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
        process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS =
          "child-exit,daemon-kill-orphans,kill-orphans";
        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
            "-ExitAfterSpawn",
            "-FastExit",
          ]);
          expect(started.rc, started.stderr).toBe(0);
          const daemonPidFile = join(sessionDir, "pid");
          const targetPidFile = join(caseDir, "target.pid");
          const grandchildPidFile = join(caseDir, "grandchild.pid");
          const ownershipPath = join(sessionDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                existsSync(daemonPidFile) &&
                existsSync(targetPidFile) &&
                existsSync(grandchildPidFile) &&
                identityFiles.every(existsSync) &&
                existsSync(ownershipPath),
              20_000,
            ),
          ).toBe(true);
          const daemonPid = readPid(daemonPidFile);
          const targetPid = readPid(targetPidFile);
          const grandchildPid = readPid(grandchildPidFile);
          const recorded = mergeRecordedIdentities(
            readOwnershipIdentities(ownershipPath),
            identityFiles.map(readIdentityFile),
          );
          expect(
            await waitUntil(
              () => {
                const live = new Set(
                  liveRecordedIdentities(recorded).map(
                    (identity) => identity.pid,
                  ),
                );
                return (
                  !live.has(targetPid) &&
                  live.has(daemonPid) &&
                  !live.has(grandchildPid) &&
                  ownershipHasPendingParentExit(ownershipPath)
                );
              },
              10_000,
            ),
          ).toBe(true);

          const killed = drive(["kill", "--session", session]);
          expect(killed.rc, killed.stderr).toBe(0);
          expect(
            await waitUntil(
              () =>
                !existsSync(join(sessionDir, "pid")) &&
                !existsSync(join(sessionDir, "ownership.json")),
              10_000,
            ),
          ).toBe(true);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          if (prior === undefined) {
            delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
          } else {
            process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
          }
          drive(["kill", "--session", session]);
        }
      };

      const runChildIdentityRetry = async (): Promise<void> => {
        const label = "child_identity_retry";
        const session = `${sessionPrefix}_${label}`;
        const caseDir = join(sandbox, label);
        const sessionDir = winSessionDir(session);
        sessions.push(session);
        mkdirSync(caseDir, { recursive: true });
        const prior = process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
        process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS =
          "child-start:always,child-start-fallback:always";
        try {
          const started = drive([
            "start",
            "--session",
            session,
            "--cwd",
            caseDir,
            "--width",
            "80",
            "--height",
            "24",
            "--",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            targetScript,
            "-CaseDir",
            caseDir,
            "-ExitAfterSpawn",
          ]);
          expect(started.rc, started.stderr).toBe(0);
          const ownershipPath = join(sessionDir, "ownership.json");
          const identityFiles = caseIdentityFiles(caseDir);
          expect(
            await waitUntil(
              () =>
                ownershipMissingChildIdentity(ownershipPath),
              20_000,
            ),
          ).toBe(true);
          expect(identityFiles.some(existsSync)).toBe(false);
          expect(drive(["kill", "--session", session]).rc).toBe(0);
          expect(
            await waitUntil(
              () =>
                !existsSync(join(sessionDir, "pid")) &&
                !existsSync(join(sessionDir, "ownership.json")),
              10_000,
            ),
          ).toBe(true);
        } finally {
          if (prior === undefined) {
            delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
          } else {
            process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
          }
          drive(["kill", "--session", session]);
        }
      };

      const runPersistentNonRootVerificationFailure =
        async (): Promise<void> => {
          const label = "persistent_nonroot_cim";
          const session = `${sessionPrefix}_${label}`;
          const caseDir = join(sandbox, label);
          const sessionDir = winSessionDir(session);
          sessions.push(session);
          mkdirSync(caseDir, { recursive: true });
          const prior = process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
          const priorTrace = process.env.AIDLC_TUI_CIM_TRACE_FILE;
          const injectionTrace = join(caseDir, "cim-injections.log");
          process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS =
            "child-exit,daemon-kill-orphans:always,kill-owned-process:always";
          process.env.AIDLC_TUI_CIM_TRACE_FILE = injectionTrace;
          try {
            const started = drive([
              "start",
              "--session",
              session,
              "--cwd",
              caseDir,
              "--width",
              "80",
              "--height",
              "24",
              "--",
              "powershell.exe",
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              targetScript,
              "-CaseDir",
              caseDir,
              "-ExitAfterSpawn",
            ]);
            expect(started.rc, started.stderr).toBe(0);
            const ownershipPath = join(sessionDir, "ownership.json");
            const identityFiles = caseIdentityFiles(caseDir);
            expect(
              await waitUntil(
                () =>
                  ownershipHasPendingParentExit(ownershipPath) &&
                  identityFiles.every(existsSync),
                20_000,
              ),
            ).toBe(true);
            const recorded = mergeRecordedIdentities(
              readOwnershipIdentities(ownershipPath),
              identityFiles.map(readIdentityFile),
            );

            const refused = drive(["kill", "--session", session]);
            expect(readFileSync(injectionTrace, "utf8")).toContain(
              "kill-owned-process",
            );
            expect(refused.rc).toBe(1);
            expect(existsSync(ownershipPath)).toBe(true);
            expect(liveRecordedIdentities(recorded).length).toBeGreaterThan(0);

            if (prior === undefined) {
              delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
            } else {
              process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
            }
            if (priorTrace === undefined) {
              delete process.env.AIDLC_TUI_CIM_TRACE_FILE;
            } else {
              process.env.AIDLC_TUI_CIM_TRACE_FILE = priorTrace;
            }
            const retried = drive(["kill", "--session", session]);
            expect(retried.rc, retried.stderr).toBe(0);
            expect(
              await waitUntil(
                () =>
                  !existsSync(join(sessionDir, "pid")) &&
                  !existsSync(join(sessionDir, "ownership.json")),
                10_000,
              ),
            ).toBe(true);
            expect(
              await waitUntil(
                () => liveRecordedIdentities(recorded).length === 0,
                WIN_KILL_TIMEOUT_MS + 5_000,
              ),
            ).toBe(true);
            expect(liveRecordedIdentities(recorded)).toEqual([]);
          } finally {
            if (prior === undefined) {
              delete process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS;
            } else {
              process.env.AIDLC_TUI_CIM_FAIL_CONTEXTS = prior;
            }
            if (priorTrace === undefined) {
              delete process.env.AIDLC_TUI_CIM_TRACE_FILE;
            } else {
              process.env.AIDLC_TUI_CIM_TRACE_FILE = priorTrace;
            }
            drive(["kill", "--session", session]);
          }
        };

      try {
        await runShimCase("cmd");
        await runShimCase("ps1");
        await runMissingTargetIdentityFastExit();
        await runCase("posix", () => "signals/*/done.txt", true);
        await runCase("native", () => "signals\\*\\done.txt", true, true);
        await runCase(
          "drive",
          (caseDir) => join(caseDir, "signals", "*", "done.txt"),
          true,
        );
        await runCase(
          "gitbash",
          (caseDir) => gitBashPath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        await runCase(
          "unc",
          (caseDir) =>
            uncLocalhostPath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        await runCase(
          "mixed",
          (caseDir) =>
            mixedDrivePath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        await runCase("timeout", () => "signals\\*\\missing.txt", false);
        await runParentFirstExit();
        await runStalePidOwnership();
        await runTokenlessLegacyOwnership();
        await runPreUpgradeLegacySession();
        await runCollidingSessions();
        await runOrdinaryCimFailure();
        await runParentFirstCimFailure();
        await runChildIdentityRetry();
        await runPersistentNonRootVerificationFailure();
      } finally {
        for (const session of sessions) {
          drive(["kill", "--session", session]);
        }
        if (existsSync(sandbox)) {
          const removed = await removeTreeWithRetry(sandbox, 5_000);
          if (!removed) {
            process.stderr.write(
              `[t-tui-preflight] Windows still holds the process-free sandbox; ` +
                `preserved for delayed cleanup: ${sandbox}\n`,
            );
          }
        }
      }
    },
    300_000,
  );
});

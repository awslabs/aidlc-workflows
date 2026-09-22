// Legacy Windows Node/node-pty ownership, CIM and until-file compatibility.
// Extracted from t-tui-preflight.serial.test.ts without changing its case body,
// name, skip conditions or five-minute deadline. Select this file separately
// with AIDLC_TUI_BACKEND=node-pty on Windows; it performs no model calls.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyWinSessionDir, resolveWinNode, WIN_KILL_TIMEOUT_MS, winSessionDir } from "../harness/tui-drive.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";
import { assertTuiDriveKill } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";
const RUNTIME = resolveTuiRuntime(DRIVER);
const WIN_NODE = IS_WIN && RUNTIME.backend === "node-pty" ? resolveWinNode() : null;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

// These cases inspect the legacy Windows ownership files and CIM recovery.
// Pin that implementation explicitly; native lifecycle has its own calibration.
function legacyDrive(args: string[]): Run {
  const res = spawnSync(WIN_NODE as string, ["--experimental-strip-types", DRIVER, ...args], {
    encoding: "utf-8", env: { ...process.env, AIDLC_TUI_BACKEND: "node-pty" },
  });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function recordSessionKill(
  session: string,
  errors: unknown[],
): void {
  try {
    assertTuiDriveKill(
      legacyDrive(["kill", "--session", session]),
      session,
    );
  } catch (error) {
    errors.push(error);
  }
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

const LEGACY_ABSENT_REASON = IS_WIN && RUNTIME.backend === "node-pty"
  ? tuiUnavailableReason({ env: { ...process.env, AIDLC_TUI_BACKEND: "node-pty" } })
  : "select AIDLC_TUI_BACKEND=node-pty on Windows for legacy ownership/CIM checks";

describe("t-tui-preflight (terminal substrate capability gate)", () => {
  test.skipIf(!IS_WIN || LEGACY_ABSENT_REASON !== null)(
    `Windows until-file paths detect early, preserve post-write work, and reap on teardown${
      LEGACY_ABSENT_REASON ? ` — SKIP: ${LEGACY_ABSENT_REASON}` : ""
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
      const cleanupErrors: unknown[] = [];
      const throwRecordedCleanupErrors = (): void => {
        if (cleanupErrors.length === 0) return;
        const recorded = cleanupErrors.splice(0);
        throw new Error(
          `Windows TUI case cleanup failed:\n${recorded.map(String).join("\n")}`,
          { cause: recorded[0] },
        );
      };
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
          const started = legacyDrive([
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
          const gate = legacyDrive([
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
            expect(legacyDrive(["kill", "--session", session]).rc).toBe(0);
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
          recordSessionKill(session, cleanupErrors);
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
          const started = legacyDrive([
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

          const rendered = legacyDrive([
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
          const gate = legacyDrive([
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

          expect(legacyDrive(["kill", "--session", session]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              WIN_KILL_TIMEOUT_MS + 5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recorded)).toEqual([]);
        } finally {
          recordSessionKill(session, cleanupErrors);
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
          const started = legacyDrive([
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

          const killed = legacyDrive(["kill", "--session", session]);
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
          recordSessionKill(session, cleanupErrors);
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
          const started = legacyDrive([
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
          expect(legacyDrive(["kill", "--session", session]).rc).toBe(0);
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
          recordSessionKill(session, cleanupErrors);
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

          const killed = legacyDrive(["kill", "--session", session]);
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
          const started = legacyDrive([
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

          const staleKill = legacyDrive(["kill", "--session", staleSession]);
          expect(staleKill.rc, staleKill.stderr).toBe(0);
          expect(liveRecordedIdentities(recorded)).toHaveLength(recorded.length);
          expect(legacyDrive(["capture", "--session", actualSession]).rc).toBe(0);

          expect(legacyDrive(["kill", "--session", actualSession]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recorded).length === 0,
              5_000,
            ),
          ).toBe(true);
        } finally {
          recordSessionKill(staleSession, cleanupErrors);
          recordSessionKill(actualSession, cleanupErrors);
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
          expect(legacyDrive(["kill", "--session", session]).rc).toBe(0);
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
          legacyDrive([
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

          expect(legacyDrive(["kill", "--session", sessionA]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recordedA).length === 0,
              5_000,
            ),
          ).toBe(true);
          expect(liveRecordedIdentities(recordedB)).toHaveLength(recordedB.length);
          expect(legacyDrive(["capture", "--session", sessionB]).rc).toBe(0);

          expect(legacyDrive(["kill", "--session", sessionB]).rc).toBe(0);
          expect(
            await waitUntil(
              () => liveRecordedIdentities(recordedB).length === 0,
              5_000,
            ),
          ).toBe(true);
        } finally {
          recordSessionKill(sessionA, cleanupErrors);
          recordSessionKill(sessionB, cleanupErrors);
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
          const started = legacyDrive([
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
            const killed = legacyDrive(["kill", "--session", session]);
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
          recordSessionKill(session, cleanupErrors);
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
          const started = legacyDrive([
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

          const killed = legacyDrive(["kill", "--session", session]);
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
          recordSessionKill(session, cleanupErrors);
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
          const started = legacyDrive([
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
          expect(legacyDrive(["kill", "--session", session]).rc).toBe(0);
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
          recordSessionKill(session, cleanupErrors);
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
            const started = legacyDrive([
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

            const refused = legacyDrive(["kill", "--session", session]);
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
            const retried = legacyDrive(["kill", "--session", session]);
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
            recordSessionKill(session, cleanupErrors);
          }
        };

      let runError: unknown;
      try {
        await runShimCase("cmd");
        throwRecordedCleanupErrors();
        await runShimCase("ps1");
        throwRecordedCleanupErrors();
        await runMissingTargetIdentityFastExit();
        throwRecordedCleanupErrors();
        await runCase("posix", () => "signals/*/done.txt", true);
        throwRecordedCleanupErrors();
        await runCase("native", () => "signals\\*\\done.txt", true, true);
        throwRecordedCleanupErrors();
        await runCase(
          "drive",
          (caseDir) => join(caseDir, "signals", "*", "done.txt"),
          true,
        );
        throwRecordedCleanupErrors();
        await runCase(
          "gitbash",
          (caseDir) => gitBashPath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        throwRecordedCleanupErrors();
        await runCase(
          "unc",
          (caseDir) =>
            uncLocalhostPath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        throwRecordedCleanupErrors();
        await runCase(
          "mixed",
          (caseDir) =>
            mixedDrivePath(join(caseDir, "signals", "*", "done.txt")),
          true,
        );
        throwRecordedCleanupErrors();
        await runCase("timeout", () => "signals\\*\\missing.txt", false);
        throwRecordedCleanupErrors();
        await runParentFirstExit();
        throwRecordedCleanupErrors();
        await runStalePidOwnership();
        throwRecordedCleanupErrors();
        await runTokenlessLegacyOwnership();
        throwRecordedCleanupErrors();
        await runPreUpgradeLegacySession();
        throwRecordedCleanupErrors();
        await runCollidingSessions();
        throwRecordedCleanupErrors();
        await runOrdinaryCimFailure();
        throwRecordedCleanupErrors();
        await runParentFirstCimFailure();
        throwRecordedCleanupErrors();
        await runChildIdentityRetry();
        throwRecordedCleanupErrors();
        await runPersistentNonRootVerificationFailure();
        throwRecordedCleanupErrors();
      } catch (error) {
        runError = error;
      }

      for (const session of sessions) {
        recordSessionKill(session, cleanupErrors);
      }
      if (cleanupErrors.length === 0 && existsSync(sandbox)) {
        try {
          const removed = await removeTreeWithRetry(sandbox, 5_000);
          if (!removed) {
            process.stderr.write(
              `[t-tui-preflight] Windows still holds the process-free sandbox; ` +
                `preserved for delayed cleanup: ${sandbox}\n`,
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new Error(
          `Windows TUI preflight cleanup failed; workspace preserved at ${sandbox}\n` +
            `original test error: ${String(runError ?? "none")}\n` +
            `cleanup errors:\n${cleanupErrors.map(String).join("\n")}`,
          { cause: runError ?? cleanupErrors[0] },
        );
      }
      if (runError !== undefined) {
        throw runError;
      }
    },
    300_000,
  );
});

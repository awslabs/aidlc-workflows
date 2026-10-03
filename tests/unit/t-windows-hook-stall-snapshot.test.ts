// t-windows-hook-stall-snapshot - the Windows live legs' wait loop records a
// stalled hook's process tree. Write-HookStallSnapshot (prepare-live-runtime.ps1)
// runs in the production PowerShell host against a real long-running process
// whose command line names `engine hook`, and against an `engine adapter`
// process with a child (an adapter runs its core hook as a child): it writes
// one JSON snapshot that lists both, with the thread states of each stalled
// process and of the adapter's child, never repeats a process it already
// recorded, ignores matching processes another account owns, and with its
// time budget spent still writes promptly, marked truncated, keeping the
// stalled processes whose owner it could not check under ownerUnknown.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const powershell = process.platform === "win32"
  ? join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  : undefined;
const source = readFileSync(resolve(import.meta.dir, "../../.github/scripts/prepare-live-runtime.ps1"), "utf8");
const helper = source.match(/^function Write-HookStallSnapshot\b[\s\S]*?^\}/m)?.[0];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!powershell)("Windows hook stall snapshot (requires Windows PowerShell)", () => {
  let root: string;
  beforeAll(() => {
    expect(helper).toBeDefined();
    root = mkdtempSync(join(tmpdir(), "aidlc-hook-stall-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("records owned stalled hook and adapter processes once, with their threads, and ignores other owners", () => {
    const directory = join(root, "stalls");
    // The adapter stand-in: its command line carries the marker words as
    // arguments, and it starts one child that outlives the check.
    const adapter = join(root, "adapter.ps1");
    writeFileSync(adapter, [
      `Start-Process -NoNewWindow -FilePath ${literal(powershell!)} -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'`,
      "Start-Sleep -Seconds 120",
    ].join("\n"));
    const script = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function New-PrivateDirectory([string]$Path) { [void][IO.Directory]::CreateDirectory($Path) }
${helper}
$directory = ${literal(directory)}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fake = Start-Process -FilePath ${literal(powershell!)} -NoNewWindow -PassThru -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120 # engine hook fold-usage')
$adapter = Start-Process -FilePath ${literal(powershell!)} -NoNewWindow -PassThru -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${literal(`"${adapter}"`)}, 'engine', 'adapter', 'codex', 'reviewer-scope')
$child = $null
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (($null -eq (Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $fake.Id)) -or
            $null -eq ($child = Get-CimInstance Win32_Process -Filter ("ParentProcessId = {0}" -f $adapter.Id) | Select-Object -First 1)) -and
           [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    $seen = @{}
    $budgetStarted = [DateTime]::UtcNow
    # A sibling, so its truncated snapshot never counts toward the cases below.
    $noBudgetDirectory = $directory + '-no-budget'
    Write-HookStallSnapshot $noBudgetDirectory @{} @($sid) 0 0
    $noBudgetSeconds = ([DateTime]::UtcNow - $budgetStarted).TotalSeconds
    $noBudget = @(Get-ChildItem -LiteralPath $noBudgetDirectory -Filter 'hook-stall-*.json' -ErrorAction SilentlyContinue)
    $noBudgetFiles = $noBudget.Count
    $noBudgetSnapshot = if ($noBudget.Count -gt 0) { $noBudget[0].FullName } else { $null }
    Write-HookStallSnapshot $directory $seen @('S-1-5-18') 0
    $otherOwner = @(Get-ChildItem -LiteralPath $directory -Filter 'hook-stall-*.json' -ErrorAction SilentlyContinue).Count
    Write-HookStallSnapshot $directory $seen @($sid) 0
    $first = @(Get-ChildItem -LiteralPath $directory -Filter 'hook-stall-*.json')
    Write-HookStallSnapshot $directory $seen @($sid) 0
    $second = @(Get-ChildItem -LiteralPath $directory -Filter 'hook-stall-*.json')
    [Console]::WriteLine((@{
        fake = $fake.Id; adapter = $adapter.Id; child = if ($null -ne $child) { [int]$child.ProcessId } else { 0 }
        otherOwner = $otherOwner; first = $first.Count; second = $second.Count
        noBudgetSeconds = $noBudgetSeconds; noBudgetFiles = $noBudgetFiles; noBudgetSnapshot = $noBudgetSnapshot
        snapshot = if ($first.Count -gt 0) { $first[0].FullName } else { $null }
    } | ConvertTo-Json -Compress))
} finally {
    if ($null -ne $child) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $adapter.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
}
`;
    const result = spawnSync(powershell!, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(outcome).toMatchObject({ otherOwner: 0, first: 1, second: 1, noBudgetFiles: 1 });
    // A spent budget still leaves evidence, promptly, marked incomplete: the
    // stalled processes whose owner could not be checked in time are kept.
    expect(outcome.noBudgetSeconds).toBeLessThan(20);
    const partial = JSON.parse(readFileSync(outcome.noBudgetSnapshot, "utf8"));
    expect(partial.truncated).toBe(true);
    expect(partial.ownerUnknown).toContain(outcome.fake);
    expect(partial.stalled).toContain(outcome.adapter);
    const snapshot = JSON.parse(readFileSync(outcome.snapshot, "utf8"));
    expect(snapshot.afterMinutes).toBe(0);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.stalled).toContain(outcome.fake);
    expect(snapshot.stalled).toContain(outcome.adapter);
    expect(outcome.child).toBeGreaterThan(0);
    expect(snapshot.threads.some((t: { processId: number }) => t.processId === outcome.child)).toBe(true);
    const fake = snapshot.processes.find((p: { processId: number }) => p.processId === outcome.fake);
    expect(fake.commandLine).toContain("engine hook fold-usage");
    expect(Number.isNaN(Date.parse(fake.createdAt))).toBe(false);
    expect(snapshot.threads.some((t: { processId: number }) => t.processId === outcome.fake)).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

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

// Windows exercises the production PS5.1 host. Other platforms can also check
// PowerShell's native-exit scoping when pwsh is installed.
const powershell = process.platform === "win32"
  ? join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  : Bun.which("pwsh");
const source = readFileSync(resolve(import.meta.dir, "../../.github/scripts/prepare-live-runtime.ps1"), "utf8");
const helper = source.match(/^function Invoke-ReadinessInitializer \{[\s\S]*?^\}/m)?.[0];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!powershell)("Windows Codex readiness native exit status (requires PowerShell)", () => {
  let root: string;
  beforeAll(() => {
    expect(helper).toBeDefined();
    root = mkdtempSync(join(tmpdir(), "aidlc-codex readiness-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test.each([
    { name: "normal completion", exit: undefined, diagnostics: false, accepted: true },
    { name: "success with stderr diagnostics", exit: 0, diagnostics: true, accepted: true },
    { name: "failure without diagnostics", exit: 9, diagnostics: false, accepted: false },
    { name: "failure with stderr diagnostics", exit: 9, diagnostics: true, accepted: false },
    { name: "missing executable after a stale success", exit: 0, diagnostics: false, accepted: false, missing: true },
  ])("$name", ({ exit, diagnostics, accepted, missing }) => {
    const initializer = join(root, "initialize.ps1");
    writeFileSync(initializer, [
      "[Console]::WriteLine('initializer-stdout')",
      ...(diagnostics ? ["[Console]::Error.WriteLine('fixed-phase-marker')"] : []),
      ...(exit === undefined ? [] : [`exit ${exit}`]),
    ].join("\n"));
    const script = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
$powershell = ${literal(missing ? join(root, "absent-powershell") : powershell!)}
$initializer = ${literal(initializer)}
${helper}
$accepted = $false
$failure = $null
try { Invoke-ReadinessInitializer; $accepted = $true }
catch { $failure = $_.Exception.Message }
[Console]::WriteLine((@{
    accepted = $accepted; preference = [string]$ErrorActionPreference
    failure = $failure; nativeExit = $global:LASTEXITCODE
} | ConvertTo-Json -Compress))
`;
    const result = spawnSync(powershell!, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    const outcome = JSON.parse(lines.at(-1)!);
    expect(outcome).toMatchObject({ accepted, preference: "Stop" });
    if (!missing) {
      expect(result.stdout).toContain("initializer-stdout");
      expect(outcome.nativeExit).toBe(exit ?? 0);
    }
    if (diagnostics) expect(result.stdout).toContain("fixed-phase-marker");
    if (!accepted) expect(outcome.failure).toBeTruthy();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// The sandbox setup runs elevated on a fresh Windows runner and cannot be
// faked here, so its shape is pinned: a setup that exits non-zero runs once
// more on the same host, a timeout or an unfinished drain fails closed at
// once, and both runs' logs reach the failure evidence.
describe("Windows Codex sandbox setup", () => {
  const provisioning = (source.match(/^function Invoke-CodexProvisioning\([\s\S]*?^\}/m)?.[0] ?? "").replaceAll("\r\n", "\n");

  test("runs a setup that exited non-zero once more, and fails only when both did", () => {
    const loop = provisioning.indexOf("foreach ($attempt in 1, 2) {");
    expect(loop).toBeGreaterThan(0);
    expect(provisioning.match(/\[Diagnostics\.Process\]::Start\(\$info\)/g)).toHaveLength(1);
    expect(provisioning.indexOf("[Diagnostics.Process]::Start($info)")).toBeGreaterThan(loop);
    expect(provisioning).toContain("if ($process.ExitCode -eq 0) { return }");
    expect(provisioning.trimEnd()).toEndWith("throw 'Trusted Codex provisioning failed; retain sandbox.log, never sandbox-secrets.'\n}");
  });

  test("a timeout or an unfinished output drain still fails closed on the first run", () => {
    for (const refusal of ["throw 'Codex provisioning timed out", "throw 'Codex provisioning output drain timed out"]) {
      expect(provisioning.indexOf(refusal)).toBeGreaterThan(provisioning.indexOf("foreach ($attempt in 1, 2) {"));
      expect(provisioning.indexOf(refusal)).toBeLessThan(provisioning.indexOf("if ($process.ExitCode -eq 0) { return }"));
    }
  });

  test("both runs' logs are on the failure evidence list", () => {
    expect(provisioning).toContain("'codex-setup.attempt-2'");
    expect(source).toContain(
      "(Join-Path $stateRoot 'codex-setup.attempt-2.stdout.log'), (Join-Path $stateRoot 'codex-setup.attempt-2.stderr.log'),",
    );
  });
});

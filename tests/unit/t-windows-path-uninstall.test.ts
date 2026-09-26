// covers: file:core/tools/aidlc-windows-uninstall.ts

import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import {
  activeExecutablePath,
  commandPath,
  windowsUninstallFencePath,
} from "../../core/tools/aidlc-install-paths.ts";
import {
  parseWindowsPathRegistration,
  recoverWindowsUninstallContinuations,
  scanWindowsUninstallJournals,
  scheduleWindowsUninstall,
  WINDOWS_UNINSTALL_AUTOMATIC_ATTEMPTS,
  WINDOWS_UNINSTALL_RUNNING_GRACE_MS,
  windowsUninstallContinuationState,
  type WindowsPathRegistration,
  type WindowsUninstallJournal,
  type WindowsUninstallPlan,
} from "../../core/tools/aidlc-windows-uninstall.ts";

const SID = "S-1-5-21-111-222-333-1001";
const OTHER = String.raw`C:\Windows;%UNINSTALL_TEST_ROOT%\bin`;

function registration(
  entry: string,
  previousValue: string | null = OTHER,
  previousKind: WindowsPathRegistration["previousKind"] = "ExpandString",
): WindowsPathRegistration {
  return {
    schemaVersion: 1,
    scope: "user",
    accountSid: SID,
    entry,
    previousValue,
    previousKind: previousValue === null ? null : previousKind,
    registeredValue: !previousValue || previousValue.endsWith(";")
      ? `${previousValue ?? ""}${entry}`
      : `${previousValue};${entry}`,
  };
}

function withInstall(run: (root: string) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-path-uninstall-")));
  const environment = {
    AIDLC_INSTALL_ROOT: join(base, "machine"),
    AIDLC_BIN_DIR: join(base, "bin"),
    TMPDIR: join(base, "journals"),
    TMP: join(base, "journals"),
    TEMP: join(base, "journals"),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  try {
    mkdirSync(environment.AIDLC_INSTALL_ROOT);
    mkdirSync(environment.AIDLC_BIN_DIR);
    mkdirSync(environment.TMPDIR);
    writeFileSync(commandPath(), "owned command");
    writeFileSync(activeExecutablePath(), "owned pointer");
    run(environment.AIDLC_INSTALL_ROOT);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
}

function fixturePlan(
  purge = true,
  preserved: string[] = [],
  additionalFiles: string[] = [],
): WindowsUninstallPlan {
  const root = dirname(activeExecutablePath());
  const keep = purge ? [] : preserved;
  // Every fixture-owned path is named explicitly. In particular, never walk
  // versions: unlisted files there must survive the production continuation.
  const paths = [
    commandPath(),
    ...[
      "active-version", "active-executable", "rollback-version", "aidlc-shim.ps1", "windows-path.json",
      ...["aidlc.bash", "_aidlc", "aidlc.fish", "aidlc.ps1"].map((name) => join("completions", name)),
      ...(purge ? ["aidlc.settings.json", "update-check.json", "pins.json", "default-harness", "channel"] : []),
    ].map((name) => join(root, name)),
    ...additionalFiles,
  ];
  const directories = new Set([
    join(root, "versions"), join(root, "completions"), join(root, "reservations"), root,
  ]);
  for (const path of paths) {
    let directory = dirname(path);
    while (directory.startsWith(`${root}${sep}`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return {
    files: [...new Set(paths)].filter((path) =>
      existsSync(path) && !keep.some((retained) =>
        path === retained || path.startsWith(`${retained}${sep}`)
      )
    ).map((path) => ({
      path,
      expected: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
    })),
    directories: [...directories].sort((left, right) => right.length - left.length),
    preserved: keep,
  };
}

function schedule(purge = true, preserved: string[] = [], additionalFiles: string[] = []): {
  path: string;
  journal: WindowsUninstallJournal;
} {
  // Exercise real receipt loading, durable journal creation, and failed-launch
  // recovery without starting an uninstall process in the test runner.
  const launch = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("intentional test launch failure");
  });
  try {
    expect(() => scheduleWindowsUninstall(purge, preserved, fixturePlan(purge, preserved, additionalFiles))).toThrow(
      "intentional test launch failure",
    );
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
  const scan = scanWindowsUninstallJournals();
  expect(scan.invalid).toEqual([]);
  expect(scan.pending).toHaveLength(1);
  return scan.pending[0];
}

function binAlias(root: string): string {
  const alias = join(root, "bin-alias");
  symlinkSync(dirname(commandPath()), alias, process.platform === "win32" ? "junction" : "dir");
  return alias;
}

describe("Windows uninstall PATH receipts and recovery journals", () => {
  for (const previous of [null, "", OTHER, `${OTHER};`, `;${OTHER};;`]) {
    test(`accepts the appended receipt for ${JSON.stringify(previous)}`, () => {
      withInstall(() => {
        const receipt = registration(dirname(commandPath()), previous);
        expect(parseWindowsPathRegistration(receipt, commandPath())).toEqual(receipt);
      });
    });
  }

  test("accepts a canonical directory with trailing separators without rewriting its PATH spelling", () => {
    withInstall(() => {
      const receipt = registration(`${dirname(commandPath())}${sep}`);
      expect(parseWindowsPathRegistration(receipt, commandPath())).toEqual(receipt);
    });
  });

  for (const trailing of ["", sep]) {
    test(`binds an alias receipt before removal and recovers without the alias (trailing=${JSON.stringify(trailing)})`, () => {
      withInstall((root) => {
        const bin = dirname(commandPath());
        const receipt = registration(`${binAlias(root)}${trailing}`);
        expect(parseWindowsPathRegistration(receipt, commandPath())).toEqual(receipt);
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const pending = schedule();
        expect(pending.journal.pathRegistration?.entry).toBe(receipt.entry);
        rmSync(root, { recursive: true });
        rmSync(bin, { recursive: true });
        expect(existsSync(receipt.entry)).toBe(false);
        const scan = scanWindowsUninstallJournals();
        expect(scan.invalid).toEqual([]);
        expect(scan.pending).toEqual([pending]);
      });
    });
  }

  test("rejects an alias pointing to a different directory", () => {
    withInstall((root) => {
      const other = join(root, "unrelated");
      const alias = join(root, "unrelated-alias");
      mkdirSync(other);
      symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
      const receipt = registration(`${alias}${sep}`);
      expect(() => parseWindowsPathRegistration(receipt, commandPath())).toThrow(
        "invalid Windows PATH registration",
      );
    });
  });

  test("recovery rejects replacement of a bound alias receipt even by another spelling of the same bin", () => {
    withInstall((root) => {
      const receipt = registration(binAlias(root));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const pending = schedule();
      writeFileSync(pending.path, JSON.stringify({
        ...pending.journal,
        pathRegistration: registration(dirname(commandPath())),
      }));
      const scan = scanWindowsUninstallJournals();
      expect(scan.pending).toEqual([]);
      expect(scan.invalid).toContain(pending.path);
    });
  });

  const malformed = [
    { schemaVersion: "1" },
    { schemaVersion: [1] },
    { scope: "machine" },
    { accountSid: "" },
    { accountSid: 123 },
    { previousValue: null, previousKind: "String" },
    { previousValue: "", previousKind: null },
    { previousValue: ["C:\\Windows"] },
    { previousKind: "DWord" },
    { registeredValue: "an unrelated PATH" },
    { extra: true },
  ];
  for (const change of malformed) {
    test(`rejects malformed receipt ${JSON.stringify(change)}`, () => {
      withInstall(() => {
        expect(() => parseWindowsPathRegistration({
          ...registration(dirname(commandPath())),
          ...change,
        }, commandPath())).toThrow("invalid Windows PATH registration");
      });
    });
  }

  test("rejects a self-consistent receipt for another directory", () => {
    withInstall((root) => {
      const receipt = registration(join(root, "unrelated"));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      expect(() => scheduleWindowsUninstall(true, [], fixturePlan())).toThrow("invalid Windows PATH registration");
      expect(existsSync(commandPath())).toBe(true);
      expect(existsSync(windowsUninstallFencePath())).toBe(false);
      expect(scanWindowsUninstallJournals().pending).toEqual([]);
    });
  });

  test("rejects corrupt JSON before scheduling file removal", () => {
    withInstall((root) => {
      writeFileSync(join(root, "windows-path.json"), "{bad json");
      expect(() => scheduleWindowsUninstall(true, [], fixturePlan())).toThrow();
      expect(existsSync(commandPath())).toBe(true);
      expect(existsSync(windowsUninstallFencePath())).toBe(false);
    });
  });

  for (const purge of [false, true]) {
    test(`persists a receipt independently of the install root (purge=${purge})`, () => {
      withInstall((root) => {
        const receipt = registration(dirname(commandPath()), "", "String");
        writeFileSync(join(root, "windows-path.json"), `\uFEFF${JSON.stringify(receipt)}`);
        const pending = schedule(purge);
        expect(pending.journal.pathRegistration).toEqual(receipt);
        rmSync(root, { recursive: true });
        const recovered = scanWindowsUninstallJournals();
        expect(recovered.invalid).toEqual([]);
        expect(recovered.pending[0].journal.pathRegistration).toEqual(receipt);
        expect(recovered.pending[0].journal.purge).toBe(purge);
      });
    });
  }

  test("journals without a PATH ownership receipt remain recoverable", () => {
    withInstall((root) => {
      const pending = schedule();
      expect(Object.hasOwn(pending.journal, "pathRegistration")).toBe(false);
      expect(Object.hasOwn(pending.journal, "pathCleanup")).toBe(false);
      rmSync(root, { recursive: true });
      expect(scanWindowsUninstallJournals().pending).toEqual([pending]);
    });
  });

  test("recovery rejects a changed registration and malformed cleanup checkpoints", () => {
    withInstall((root) => {
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(registration(dirname(commandPath()))));
      const pending = schedule();
      const invalid = [
        { pathRegistration: registration(join(root, "unrelated")) },
        { pathRegistration: null },
        { pathCleanup: { beforeValue: [], completed: false } },
        { pathCleanup: { beforeValue: OTHER, completed: "false" } },
        { pathCleanup: null },
      ];
      for (const change of invalid) {
        writeFileSync(pending.path, JSON.stringify({ ...pending.journal, ...change }));
        const scan = scanWindowsUninstallJournals();
        expect(scan.pending).toEqual([]);
        expect(scan.invalid).toContain(pending.path);
      }
      // Removing the receipt is not covered by the deletion scope; it must
      // still fail the PATH binding rather than relaunch without PATH cleanup.
      const { pathRegistration: _dropped, ...withoutReceipt } = pending.journal;
      writeFileSync(pending.path, JSON.stringify(withoutReceipt));
      const dropped = scanWindowsUninstallJournals();
      expect(dropped.pending).toEqual([]);
      expect(dropped.invalid).toContain(pending.path);
      writeFileSync(pending.path, JSON.stringify({
        ...pending.journal,
        pathCleanup: { beforeValue: OTHER, completed: false },
      }));
      expect(scanWindowsUninstallJournals().pending).toHaveLength(1);
    });
  });

  test("recovery rejects edits to purge or preserved paths without rebinding the continuation", () => {
    withInstall((root) => {
      const keep = join(root, "pins.json");
      const pending = schedule(false, [keep]);
      for (const change of [
        { purge: true, preserved: [] },
        { preserved: [] },
        { preserved: [join(root, "channel")] },
      ]) {
        writeFileSync(pending.path, JSON.stringify({ ...pending.journal, ...change }));
        const scan = scanWindowsUninstallJournals();
        expect(scan.pending).toEqual([]);
        expect(scan.invalid).toContain(pending.path);
      }
      writeFileSync(pending.path, JSON.stringify(pending.journal));
      expect(scanWindowsUninstallJournals().pending).toEqual([pending]);
    });
  });

  test("recovery refuses a continuation without the bounded deletion scope", () => {
    withInstall(() => {
      const pending = schedule();
      const script = readFileSync(pending.journal.cleanupPath, "utf-8");
      writeFileSync(pending.journal.cleanupPath, script.replace(
        /^\$expectedDeletionScope = '[A-Za-z0-9+/=]+'\r?$/m,
        "",
      ));
      const scan = scanWindowsUninstallJournals();
      expect(scan.pending).toEqual([]);
      expect(scan.invalid).toContain(pending.path);
      expect(existsSync(commandPath())).toBe(true);
    });
  });

  test("requires an explicit file plan without creating cleanup artifacts", () => {
    withInstall(() => {
      expect(() => scheduleWindowsUninstall(true, [])).toThrow("requires an explicit file plan");
      expect(existsSync(commandPath())).toBe(true);
      expect(existsSync(windowsUninstallFencePath())).toBe(false);
      expect(scanWindowsUninstallJournals()).toEqual({ pending: [], invalid: [], finished: [] });
    });
  });

  test("rejects invalid file and directory boundaries before scheduling any changes", () => {
    withInstall((root) => {
      const outside = join(`${root}-sibling`, "keep.txt");
      mkdirSync(dirname(outside));
      writeFileSync(outside, "outside sentinel");
      const gitFile = join(root, "unrelated-project", ".git");
      mkdirSync(dirname(gitFile));
      writeFileSync(gitFile, "gitdir: outside");
      const plan = fixturePlan();
      const expected = plan.files[0].expected;
      const badPlans: WindowsUninstallPlan[] = [
        ...[root, homedir(), parse(root).root, outside, gitFile, "relative.txt"].map((path) => ({
          ...plan, files: [...plan.files, { path, expected }],
        })),
        { ...plan, files: [...plan.files, { path: join(root, "bad-hash"), expected: "sha256:bad" }] },
        { ...plan, files: [...plan.files, plan.files[0]] },
        { ...plan, directories: [dirname(outside), ...plan.directories] },
        { ...plan, directories: [root, ...plan.directories.filter((path) => path !== root)] },
        { ...plan, preserved: [activeExecutablePath()] },
      ];
      for (const invalid of badPlans) {
        expect(() => scheduleWindowsUninstall(true, [], invalid)).toThrow("invalid Windows uninstall");
        expect(existsSync(windowsUninstallFencePath())).toBe(false);
        expect(scanWindowsUninstallJournals()).toEqual({ pending: [], invalid: [], finished: [] });
        expect(readFileSync(commandPath(), "utf-8")).toBe("owned command");
        expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
        expect(readFileSync(outside, "utf-8")).toBe("outside sentinel");
        expect(readFileSync(gitFile, "utf-8")).toBe("gitdir: outside");
      }
      const nonpurge = fixturePlan(false);
      nonpurge.files.push({ path: join(root, "aidlc.settings.json"), expected });
      expect(() => scheduleWindowsUninstall(false, [], nonpurge)).toThrow("invalid Windows uninstall file plan");
    });
  });

  test("recovery rejects missing or modified file plans and directory lists", () => {
    withInstall((root) => {
      const pending = schedule();
      for (const change of [
        { files: undefined, directories: undefined },
        { files: [] },
        { files: pending.journal.files!.map((file) => ({ ...file, expected: `sha256:${"0".repeat(64)}` })) },
        { directories: [join(root, "unlisted"), ...pending.journal.directories!] },
      ]) {
        writeFileSync(pending.path, JSON.stringify({ ...pending.journal, ...change }));
        const scan = scanWindowsUninstallJournals();
        expect(scan.pending).toEqual([]);
        expect(scan.invalid).toContain(pending.path);
        expect(existsSync(commandPath())).toBe(true);
      }
    });
  });
});

// Execute the entire emitted PowerShell continuation on Windows. Only the SID,
// registry handle and desktop notification adapters are replaced; receipt
// checks, literal PATH surgery, file removal and journal writes are production
// code. Never open a real registry key in this suite.
const NATIVE_PROBE = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$global:case = [Console]::In.ReadToEnd() | ConvertFrom-Json
$global:key = [pscustomobject]@{
  Exists = $global:case.Exists
  Value = $global:case.Current
  Kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $global:case.Kind)
  Writes = 0
}
$global:opens = 0
$global:notifications = 0
$global:failed = $false
function Assert-FilesRemoved {
  # PATH changes only after every other owned file, but before the runnable
  # entry point, so a failed PATH step still leaves a command to retry it.
  if (Test-Path -LiteralPath (Join-Path $global:case.Journal.installRoot 'windows-path.json')) {
    throw 'PATH changed before files were removed'
  }
  if (-not (Test-Path -LiteralPath $global:case.Journal.commandPath) -or
      -not (Test-Path -LiteralPath $global:case.Journal.pointerPath)) {
    throw 'PATH changed after the entry point was removed'
  }
  $durable = Get-Content -Raw -Encoding UTF8 -LiteralPath $global:case.JournalPath | ConvertFrom-Json
  if ($null -eq $durable.pathCleanup -or $durable.pathCleanup.completed -or $durable.status -eq 'completed' -or
      $durable.progress -ne 'removing') {
    throw 'PATH changed without a pending durable checkpoint'
  }
}
$global:key | Add-Member ScriptMethod GetValueNames { if ($this.Exists) { return 'Path' } }
$global:key | Add-Member ScriptMethod GetValueKind { param($name) return $this.Kind }
$global:key | Add-Member ScriptMethod GetValue {
  param($name, $default, $options)
  if ($options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) {
    throw 'PATH read expanded user variables'
  }
  return $this.Value
}
function Before-RegistryWrite {
  Assert-FilesRemoved
  if ($global:case.FailBeforeWrite -and -not $global:failed) {
    $global:failed = $true
    throw 'simulated interruption before registry write'
  }
}
function After-RegistryWrite {
  # Hold aidlc.cmd open without sharing, so only the entry-point step fails.
  if ($global:case.LockCommandAfterPath -and $null -eq $global:lock -and -not $global:locked) {
    $global:locked = $true
    $global:lock = [IO.File]::Open($global:case.Journal.commandPath, 'Open', 'Read', 'None')
  }
  if ($global:case.FailAfterWrite -and -not $global:failed) {
    $global:failed = $true
    throw 'simulated interruption after registry write'
  }
}
$global:key | Add-Member ScriptMethod SetValue {
  param($name, $value, $kind)
  Before-RegistryWrite
  $this.Exists = $true
  $this.Value = $value
  $this.Kind = $kind
  $this.Writes++
  After-RegistryWrite
}
$global:key | Add-Member ScriptMethod DeleteValue {
  param($name, $missing)
  Before-RegistryWrite
  $this.Exists = $false
  $this.Value = $null
  $this.Writes++
  After-RegistryWrite
}
$global:key | Add-Member ScriptMethod Close {}
$replacements = @{
  'Get-UninstallAccountSid' = 'function Get-UninstallAccountSid { return $global:case.Sid }'
  'Open-UninstallEnvironment' = 'function Open-UninstallEnvironment { $global:opens++; return $global:key }'
  'Send-UninstallEnvironmentChange' = 'function Send-UninstallEnvironmentChange { $global:notifications++ }'
}
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($global:case.Script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$definitions = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $replacements.ContainsKey($node.Name)
}, $true))
if ($definitions.Count -ne 3) { throw 'expected three uninstall test adapters' }
$scriptText = $global:case.Script
foreach ($definition in ($definitions | Sort-Object { $_.Extent.StartOffset } -Descending)) {
  $extent = $definition.Extent
  $scriptText = $scriptText.Remove($extent.StartOffset, $extent.EndOffset - $extent.StartOffset).Insert(
    $extent.StartOffset, $replacements[$definition.Name])
}
[IO.File]::WriteAllText($global:case.Journal.cleanupPath, $scriptText, [Text.UTF8Encoding]::new($true))
$errors = @()
$journals = @()
$global:lock = $null
$global:locked = $false
for ($attempt = 0; $attempt -lt $global:case.Attempts; $attempt++) {
  try { & $global:case.Journal.cleanupPath -JournalPath $global:case.JournalPath }
  catch {
    $errors += $_.Exception.Message
    if ($null -ne $global:lock) { $global:lock.Dispose(); $global:lock = $null }
    # The durable state a fresh process would find after this failure.
    $durable = if (Test-Path -LiteralPath $global:case.JournalPath) {
      Get-Content -Raw -Encoding UTF8 -LiteralPath $global:case.JournalPath | ConvertFrom-Json
    } else { [pscustomobject]@{ status = 'absent' } }
    $journals += [pscustomobject]@{
      status = $durable.status
      progress = $durable.progress
      phase = $durable.failure.phase
      commandExists = Test-Path -LiteralPath $global:case.Journal.commandPath
      pointerExists = Test-Path -LiteralPath $global:case.Journal.pointerPath
    }
    if ($null -ne $global:case.EditAfterFailure) { $global:key.Value = $global:case.EditAfterFailure }
    # Simulate the user removing an unowned alias between recovery attempts.
    # The continuation itself must preserve that alias and its external target.
    if ($global:case.RemoveAliasAfterFailure) {
      if (-not [IO.Directory]::Exists($global:case.RemoveAliasAfterFailure)) {
        throw 'continuation removed an unowned PATH alias'
      }
      [IO.Directory]::Delete($global:case.RemoveAliasAfterFailure, $false)
    }
  }
}
[pscustomobject]@{
  exists = $global:key.Exists
  value = $global:key.Value
  kind = $global:key.Kind.ToString()
  writes = $global:key.Writes
  opens = $global:opens
  notifications = $global:notifications
  errors = @($errors)
  journals = @($journals)
  journalExists = Test-Path -LiteralPath $global:case.JournalPath
  fenceExists = Test-Path -LiteralPath $global:case.Journal.fencePath
  commandExists = Test-Path -LiteralPath $global:case.Journal.commandPath
} | ConvertTo-Json -Depth 6 -Compress
`;

type NativeCase = {
  receipt?: WindowsPathRegistration | Record<string, unknown>;
  dropReceipt?: boolean;
  current: string | number | string[] | null;
  kind?: "String" | "ExpandString" | "DWord" | "MultiString";
  sid?: string;
  failBeforeWrite?: boolean;
  failAfterWrite?: boolean;
  editAfterFailure?: string;
  removeAliasAfterFailure?: string;
  lockCommandAfterPath?: boolean;
  attempts?: number;
  journalChange?: Partial<Pick<WindowsUninstallJournal, "purge" | "preserved" | "files" | "directories">>;
};

function nativeCleanup(
  pending: { path: string; journal: WindowsUninstallJournal },
  options: NativeCase,
): {
  exists: boolean;
  value: NativeCase["current"];
  kind: string;
  writes: number;
  opens: number;
  notifications: number;
  errors: string[];
  journals: Array<{
    status: string;
    progress: string | null;
    phase: string | null;
    commandExists: boolean;
    pointerExists: boolean;
  }>;
  journalExists: boolean;
  fenceExists: boolean;
  commandExists: boolean;
} {
  const journal = { ...pending.journal, ...options.journalChange, parentPid: 0, shimPid: null };
  if (options.receipt !== undefined) {
    journal.pathRegistration = options.receipt as WindowsPathRegistration;
  }
  if (options.dropReceipt) delete journal.pathRegistration;
  writeFileSync(pending.path, JSON.stringify(journal));
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(NATIVE_PROBE, "utf16le").toString("base64"),
  ], {
    input: JSON.stringify({
      // Use the scheduled script's original receipt binding, including when a
      // case changes the journal to test rejection of corrupted registration.
      Script: readFileSync(journal.cleanupPath, "utf-8").replace(/^\uFEFF/, ""),
      Journal: journal,
      JournalPath: pending.path,
      Exists: options.current !== null,
      Current: options.current,
      Kind: options.kind ?? "ExpandString",
      Sid: options.sid ?? SID,
      FailBeforeWrite: options.failBeforeWrite ?? false,
      FailAfterWrite: options.failAfterWrite ?? false,
      EditAfterFailure: options.editAfterFailure,
      RemoveAliasAfterFailure: options.removeAliasAfterFailure,
      LockCommandAfterPath: options.lockCommandAfterPath ?? false,
      Attempts: options.attempts ??
        (options.failBeforeWrite || options.failAfterWrite || options.lockCommandAfterPath ? 2 : 1),
    }),
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describe("Windows uninstall continuation states", () => {
  const now = Date.parse("2026-09-26T00:00:00.000Z");
  const base: WindowsUninstallJournal = {
    schemaVersion: 1,
    operation: "windows-uninstall-continuation",
    status: "pending",
    parentPid: 0,
    shimPid: null,
    installRoot: String.raw`C:\machine`,
    commandPath: String.raw`C:\bin\aidlc.cmd`,
    pointerPath: String.raw`C:\machine\active-executable`,
    cleanupPath: String.raw`C:\temp\aidlc-uninstall-1.ps1`,
    fencePath: String.raw`C:\.aidlc-uninstall-1.json`,
    purge: false,
    preserved: [],
  };
  const at = (ms: number) => new Date(now - ms).toISOString();
  const failure = { phase: "path" as const, message: "registry write failed", at: at(0) };

  test.each([
    ["a scheduled continuation resumes", {}, "resume"],
    ["a worker launched moments ago is left running", { status: "recovering", launchedAt: at(60_000), attempts: 1 }, "running"],
    ["a worker silent past the grace window is resumed", { status: "recovering", launchedAt: at(WINDOWS_UNINSTALL_RUNNING_GRACE_MS + 1), attempts: 1 }, "resume"],
    ["a legacy recovering journal without a launch time resumes", { status: "recovering" }, "resume"],
    ["a launch time in the future does not hold a worker as running", { status: "recovering", launchedAt: at(-60_000), attempts: 1 }, "resume"],
    ["repeated silent stops need an explicit retry", { status: "recovering", launchedAt: at(WINDOWS_UNINSTALL_RUNNING_GRACE_MS + 1), attempts: WINDOWS_UNINSTALL_AUTOMATIC_ATTEMPTS }, "failed"],
    ["a recorded failure before or during removal needs an explicit retry", { status: "failed", progress: "removing", failure, attempts: 1 }, "failed"],
    ["a recorded failure before removal needs an explicit retry", { status: "failed", failure, attempts: 1 }, "failed"],
    ["a recorded failure while removing the entry point needs an explicit retry", { status: "failed", progress: "finalizing", failure, attempts: 1 }, "failed"],
    ["a worker that stopped silently while finalizing resumes within the cap", { status: "recovering", progress: "finalizing", launchedAt: at(WINDOWS_UNINSTALL_RUNNING_GRACE_MS + 1), attempts: 1 }, "resume"],
  ] as const)("%s", (_name, change, expected) => {
    expect(windowsUninstallContinuationState({ ...base, ...change } as WindowsUninstallJournal, now)).toBe(expected);
  });
});

describe.skipIf(process.platform !== "win32")("native Windows uninstall PATH cleanup", () => {
  for (const purge of [false, true]) {
    for (const fenceInsideRoot of [false, true]) {
      test(`preserves unrelated root, completion, reservation, bin and outside content (purge=${purge}, fenceInsideRoot=${fenceInsideRoot})`, () => {
        withInstall((root) => {
          const originalCommand = commandPath();
          if (fenceInsideRoot) {
            process.env.AIDLC_BIN_DIR = join(root, "bin");
            mkdirSync(dirname(commandPath()));
            writeFileSync(commandPath(), "owned command");
          }
          const unrelated = [
            join(root, "personal.txt"),
            join(root, "personal", "keep.txt"),
            join(root, "versions", "1.2.3", "runtime", "personal.txt"),
            join(root, "versions", "1.2.3", "runtime", "personal", "keep.txt"),
            join(root, "completions", "custom.bash"),
            join(root, "completions", "custom", "keep.txt"),
            join(root, "reservations", "keep.json"),
            join(dirname(commandPath()), "another-command.cmd"),
            join(dirname(commandPath()), "another-tool", "keep.txt"),
            join(`${root}-sibling`, "versions", "keep.txt"),
            join(dirname(root), "outside", "keep.txt"),
          ];
          for (const path of unrelated) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `unrelated: ${path}`);
          }
          const unownedAlias = join(root, "personal-link");
          symlinkSync(`${root}-sibling`, unownedAlias, "junction");
          const payload = join(root, "versions", "1.2.3", "runtime", "owned.md");
          mkdirSync(dirname(payload), { recursive: true });
          writeFileSync(payload, "owned payload");
          const owned = [
            "active-version", "active-executable", "rollback-version", "aidlc-shim.ps1",
            ...["aidlc.bash", "_aidlc", "aidlc.fish", "aidlc.ps1"].map((name) => join("completions", name)),
          ].map((name) => join(root, name));
          for (const path of owned) writeFileSync(path, "owned");
          const settings = [
            "aidlc.settings.json", "update-check.json", "pins.json", "default-harness", "channel",
          ].map((name) => join(root, name));
          for (const path of settings) writeFileSync(path, `setting: ${path}`);
          const receipt = registration(dirname(commandPath()));
          writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
          // Non-purge settings survive even if omitted from the preservation list.
          const pending = schedule(purge, [], [payload]);
          const lateFile = join(root, "versions", "1.2.3", "runtime", "added-after-scheduling.txt");
          writeFileSync(lateFile, "new unlisted file");
          const versionAlias = join(root, "versions", "1.2.3", "runtime", "unlisted-link");
          symlinkSync(`${root}-sibling`, versionAlias, "junction");
          const result = nativeCleanup(pending, { current: receipt.registeredValue });
          expect(result).toMatchObject({
            value: OTHER, errors: [], writes: 1, journalExists: false,
            fenceExists: false, commandExists: false,
          });
          for (const path of unrelated) expect(readFileSync(path, "utf-8")).toBe(`unrelated: ${path}`);
          expect(readFileSync(lateFile, "utf-8")).toBe("new unlisted file");
          expect(lstatSync(versionAlias).isSymbolicLink()).toBe(true);
          expect(lstatSync(unownedAlias).isSymbolicLink()).toBe(true);
          for (const path of [...owned, payload, join(root, "windows-path.json")]) {
            expect(existsSync(path), path).toBe(false);
          }
          for (const path of settings) {
            expect(existsSync(path), path).toBe(!purge);
            if (!purge) expect(readFileSync(path, "utf-8")).toBe(`setting: ${path}`);
          }
          if (fenceInsideRoot) expect(readFileSync(originalCommand, "utf-8")).toBe("owned command");
        });
      }, 35_000);
    }
  }

  for (const fenceInsideRoot of [false, true]) {
    test(`removes framework containers only when empty (fenceInsideRoot=${fenceInsideRoot})`, () => {
      withInstall((root) => {
        const externalBin = dirname(commandPath());
        if (fenceInsideRoot) {
          process.env.AIDLC_BIN_DIR = join(root, "bin");
          mkdirSync(dirname(commandPath()));
          writeFileSync(commandPath(), "owned command");
        }
        for (const name of ["completions", "reservations", "versions"]) mkdirSync(join(root, name));
        const result = nativeCleanup(schedule(), { current: OTHER });
        expect(result).toMatchObject({
          errors: [], opens: 0, journalExists: false, fenceExists: false, commandExists: false,
        });
        expect(existsSync(root)).toBe(false);
        expect(existsSync(externalBin)).toBe(true);
      });
    }, 35_000);
  }

  test("non-purge preserves selected runtime files, subtrees and completion files in place", () => {
    withInstall((root) => {
      const keepFile = join(root, "versions", "1.2.3", "runtime", "keep.bin");
      const keepTree = join(root, "versions", "1.2.3", "runtime", "personal");
      const nested = join(keepTree, "nested", "keep.md");
      const keepCompletion = join(root, "completions", "_aidlc");
      const removed = join(root, "versions", "1.2.3", "runtime", "remove.md");
      const bytes = Buffer.from([0, 255, 10, 128, 0]);
      for (const path of [keepFile, nested, keepCompletion, removed]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      const result = nativeCleanup(schedule(false, [keepFile, keepTree, keepCompletion], [keepFile, nested, removed]), {
        current: OTHER,
      });
      expect(result).toMatchObject({ errors: [], journalExists: false, fenceExists: false, commandExists: false });
      for (const path of [keepFile, nested, keepCompletion]) expect(readFileSync(path)).toEqual(bytes);
      expect(existsSync(removed)).toBe(false);
    });
  }, 35_000);

  for (const change of [
    { purge: true, preserved: [] },
    { preserved: [] },
  ]) {
    test(`refuses altered deletion authority before removing files: ${JSON.stringify(change)}`, () => {
      withInstall((root) => {
        const settings = join(root, "aidlc.settings.json");
        const completion = join(root, "completions", "_aidlc");
        mkdirSync(dirname(completion));
        writeFileSync(settings, "private settings");
        writeFileSync(completion, "preserved completion");
        const result = nativeCleanup(schedule(false, [completion]), {
          current: OTHER,
          journalChange: change,
        });
        expect(result).toMatchObject({
          value: OTHER, opens: 0, writes: 0, journalExists: true, fenceExists: true, commandExists: true,
        });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("invalid Windows uninstall");
        // A scope check before any removal is still a recorded preflight failure.
        expect(result.journals).toEqual([{
          status: "failed", progress: null, phase: "preflight", commandExists: true, pointerExists: true,
        }]);
        expect(readFileSync(settings, "utf-8")).toBe("private settings");
        expect(readFileSync(completion, "utf-8")).toBe("preserved completion");
        expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
      });
    }, 35_000);
  }

  for (const change of ["outside file", "root file", "git file", "outside directory", "missing plan"] as const) {
    test(`refuses a journal with an altered ${change} plan before any deletion`, () => {
      withInstall((root) => {
        const outside = join(`${root}-sibling`, "keep.txt");
        mkdirSync(dirname(outside));
        writeFileSync(outside, "outside sentinel");
        const gitFile = join(root, "unrelated-project", ".git");
        mkdirSync(dirname(gitFile));
        writeFileSync(gitFile, "gitdir: outside");
        const pending = schedule();
        const replacement = change === "root file" ? root : change === "git file" ? gitFile : outside;
        const journalChange: NativeCase["journalChange"] = change === "outside directory"
          ? { directories: [dirname(outside), ...pending.journal.directories!] }
          : change === "missing plan"
          ? { files: undefined, directories: undefined }
          : { files: pending.journal.files!.map((file, index) => index === 0 ? { ...file, path: replacement } : file) };
        const result = nativeCleanup(pending, { current: OTHER, journalChange });
        expect(result).toMatchObject({
          opens: 0, writes: 0, journalExists: true, fenceExists: true, commandExists: true,
        });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("invalid Windows uninstall");
        expect(readFileSync(outside, "utf-8")).toBe("outside sentinel");
        expect(readFileSync(gitFile, "utf-8")).toBe("gitdir: outside");
        expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
      });
    }, 35_000);
  }

  test("checks every planned hash before deleting even an earlier unchanged file", () => {
    withInstall((root) => {
      const first = join(root, "versions", "1.2.3", "runtime", "a-first.md");
      const changed = join(dirname(first), "z-changed.md");
      mkdirSync(dirname(first), { recursive: true });
      writeFileSync(first, "owned first file");
      writeFileSync(changed, "owned last file");
      const pending = schedule(true, [], [first, changed]);
      writeFileSync(changed, "user edit after scheduling");
      const result = nativeCleanup(pending, { current: OTHER });
      expect(result).toMatchObject({
        opens: 0, writes: 0, journalExists: true, fenceExists: true, commandExists: true,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("changed Windows uninstall file");
      expect(readFileSync(first, "utf-8")).toBe("owned first file");
      expect(readFileSync(changed, "utf-8")).toBe("user edit after scheduling");
      expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
    });
  }, 35_000);

  test("a failure before removal is recorded, keeps every file, and uninstall plans again", () => {
    withInstall((root) => {
      const changed = join(root, "versions", "1.2.3", "runtime", "changed.md");
      mkdirSync(dirname(changed), { recursive: true });
      writeFileSync(changed, "owned file");
      const pending = schedule(true, [], [changed]);
      writeFileSync(changed, "user edit after scheduling");
      const result = nativeCleanup(pending, { current: OTHER });
      expect(result.errors).toHaveLength(1);
      expect(result.journals).toEqual([{
        status: "failed", progress: null, phase: "preflight", commandExists: true, pointerExists: true,
      }]);
      // A fresh process: ordinary commands leave it alone; uninstall re-plans.
      const launch = spyOn(Bun, "spawnSync").mockImplementation(() => {
        throw new Error("a failed plan must not be relaunched");
      });
      try {
        const ordinary = recoverWindowsUninstallContinuations();
        expect(ordinary).toMatchObject({ resumed: 0, running: 0, replanned: 0 });
        expect(ordinary.failed).toHaveLength(1);
        expect(recoverWindowsUninstallContinuations(true, { retryFailed: true })).toMatchObject({
          resumed: 0, running: 0, failed: [], replanned: 1,
        });
        expect(launch).not.toHaveBeenCalled();
      } finally {
        launch.mockRestore();
      }
      expect(scanWindowsUninstallJournals()).toEqual({ pending: [], invalid: [], finished: [] });
      for (const path of [pending.path, pending.journal.cleanupPath, windowsUninstallFencePath()]) {
        expect(existsSync(path), path).toBe(false);
      }
      expect(readFileSync(changed, "utf-8")).toBe("user edit after scheduling");
      expect(readFileSync(commandPath(), "utf-8")).toBe("owned command");
      expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
    });
  }, 35_000);

  test("a failure after removal began keeps the entry point and resumes in a fresh process", () => {
    withInstall((root) => {
      const doc = join(root, "versions", "1.2.3", "runtime", "doc.md");
      mkdirSync(dirname(doc), { recursive: true });
      writeFileSync(doc, "owned file");
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const pending = schedule(true, [], [doc]);
      const first = nativeCleanup(pending, { current: receipt.registeredValue, failBeforeWrite: true, attempts: 1 });
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain("simulated interruption before registry write");
      expect(first.journals).toEqual([{
        status: "failed", progress: "removing", phase: "path", commandExists: true, pointerExists: true,
      }]);
      expect(existsSync(doc)).toBe(false);
      expect(existsSync(join(root, "windows-path.json"))).toBe(false);
      const durable = JSON.parse(readFileSync(pending.path, "utf-8")) as WindowsUninstallJournal;
      expect(windowsUninstallContinuationState(durable)).toBe("failed");
      const launch = spyOn(Bun, "spawnSync").mockImplementation(() => ({
        exitCode: 0, success: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      }) as never);
      try {
        expect(recoverWindowsUninstallContinuations().failed).toHaveLength(1);
        expect(launch).not.toHaveBeenCalled();
        expect(recoverWindowsUninstallContinuations(true, { retryFailed: true })).toMatchObject({ resumed: 1 });
        expect(launch).toHaveBeenCalledTimes(1);
      } finally {
        launch.mockRestore();
      }
      const relaunched = JSON.parse(readFileSync(pending.path, "utf-8")) as WindowsUninstallJournal;
      expect(relaunched).toMatchObject({ status: "recovering", progress: "removing" });
      expect(relaunched.failure).toBeUndefined();
      const second = nativeCleanup({ path: pending.path, journal: relaunched }, { current: receipt.registeredValue });
      expect(second).toMatchObject({
        errors: [], value: receipt.previousValue, journalExists: false, fenceExists: false, commandExists: false,
      });
      expect(existsSync(root)).toBe(false);
    });
  }, 35_000);

  test("a file edited after removal began is kept while the resumed cleanup finishes", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const pending = schedule();
      nativeCleanup(pending, { current: receipt.registeredValue, failBeforeWrite: true, attempts: 1 });
      writeFileSync(commandPath(), "user edit after the failure");
      const durable = JSON.parse(readFileSync(pending.path, "utf-8")) as WindowsUninstallJournal;
      const resumed = nativeCleanup({ path: pending.path, journal: durable }, { current: receipt.registeredValue });
      expect(resumed).toMatchObject({ errors: [], journalExists: false, fenceExists: false, commandExists: true });
      expect(readFileSync(commandPath(), "utf-8")).toBe("user edit after the failure");
      expect(existsSync(activeExecutablePath())).toBe(false);
    });
  }, 35_000);

  test("a failure while removing the entry point is recorded as finalizing and resumes", () => {
    withInstall(() => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(dirname(activeExecutablePath()), "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), { current: receipt.registeredValue, lockCommandAfterPath: true });
      expect(result.errors).toHaveLength(1);
      expect(result.journals).toEqual([{
        status: "failed", progress: "finalizing", phase: "finalize", commandExists: true, pointerExists: false,
      }]);
      expect(result).toMatchObject({
        value: receipt.previousValue, writes: 1, journalExists: false, fenceExists: false, commandExists: false,
      });
    });
  }, 35_000);

  test("a finished journal left by the worker is settled by an ordinary command without a launch", () => {
    withInstall(() => {
      const pending = schedule();
      // The worker saved completion, then stopped before removing its control files.
      writeFileSync(pending.path, JSON.stringify({ ...pending.journal, status: "completed" }));
      expect(scanWindowsUninstallJournals()).toEqual({ pending: [], invalid: [], finished: [pending.path] });
      const launch = spyOn(Bun, "spawnSync").mockImplementation(() => {
        throw new Error("a finished journal must not be relaunched");
      });
      try {
        expect(recoverWindowsUninstallContinuations()).toEqual({ resumed: 0, running: 0, failed: [], replanned: 0, retriedFailures: [] });
        expect(launch).not.toHaveBeenCalled();
      } finally {
        launch.mockRestore();
      }
      for (const path of [pending.path, pending.journal.cleanupPath, windowsUninstallFencePath()]) {
        expect(existsSync(path), path).toBe(false);
      }
    });
  }, 35_000);

  test("allows a planned version file already removed by an interrupted cleanup", () => {
    withInstall((root) => {
      const removed = join(root, "versions", "1.2.3", "runtime", "already-removed.md");
      const remaining = join(dirname(removed), "remaining.md");
      mkdirSync(dirname(removed), { recursive: true });
      writeFileSync(removed, "owned file");
      writeFileSync(remaining, "owned file");
      const pending = schedule(true, [], [removed, remaining]);
      rmSync(removed);
      const result = nativeCleanup(pending, { current: OTHER });
      expect(result).toMatchObject({
        errors: [], journalExists: false, fenceExists: false, commandExists: false,
      });
      expect(existsSync(root)).toBe(false);
    });
  }, 35_000);

  for (const location of [
    "versions junction", "nested junction", "file symlink", "dangling file symlink",
    "completion junction", "completion symlink", "command symlink", "settings symlink",
  ] as const) {
    test(`refuses a ${location} introduced after scheduling before deleting any file`, () => {
      withInstall((root) => {
        const outside = join(`${root}-sibling`, "outside");
        const sentinel = join(outside, "keep.txt");
        const payload = join(root, "versions", "1.2.3", "runtime", "a-first.md");
        const completion = join(root, "completions", "_aidlc");
        for (const path of [sentinel, payload, completion]) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "must survive refusal");
        }
        const receipt = registration(dirname(commandPath()));
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const plannedLinkFile = location === "nested junction"
          ? join(dirname(payload), "z-linked-directory", "planned.md")
          : join(dirname(payload), "z-linked-file");
        mkdirSync(dirname(plannedLinkFile), { recursive: true });
        writeFileSync(plannedLinkFile, "must survive refusal");
        writeFileSync(join(root, "aidlc.settings.json"), "owned settings");
        const pending = schedule(true, [], [payload, plannedLinkFile]);
        let link: string;
        let retainedPayload = payload;
        if (location === "versions junction" || location === "completion junction") {
          link = join(root, location === "versions junction" ? "versions" : "completions");
          renameSync(link, `${link}-original`);
          if (location === "versions junction") {
            retainedPayload = join(`${link}-original`, "1.2.3", "runtime", "a-first.md");
          }
          symlinkSync(outside, link, "junction");
        } else if (location === "nested junction") {
          link = join(dirname(payload), "z-linked-directory");
          renameSync(link, `${link}-original`);
          symlinkSync(outside, link, "junction");
        } else {
          link = location === "command symlink" ? pending.journal.commandPath
            : location === "completion symlink" ? completion
            : location === "settings symlink" ? join(root, "aidlc.settings.json")
            : join(dirname(payload), "z-linked-file");
          if (existsSync(link)) rmSync(link);
          symlinkSync(location === "dangling file symlink" ? join(outside, "missing") : sentinel, link, "file");
        }
        const result = nativeCleanup(pending, { current: receipt.registeredValue });
        expect(result).toMatchObject({
          value: receipt.registeredValue, opens: 0, writes: 0, notifications: 0,
          journalExists: true, fenceExists: true, commandExists: true,
        });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("refusing Windows uninstall reparse point");
        expect(readFileSync(sentinel, "utf-8")).toBe("must survive refusal");
        expect(readFileSync(retainedPayload, "utf-8")).toBe("must survive refusal");
        expect(readFileSync(pending.journal.pointerPath, "utf-8")).toBe("owned pointer");
        expect(readFileSync(join(root, "windows-path.json"), "utf-8")).toBe(JSON.stringify(receipt));
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
      });
    }, 35_000);
  }

  test("refuses an install root replaced with a junction after scheduling", () => {
    withInstall((root) => {
      const outside = `${root}-sibling`;
      mkdirSync(outside);
      const sentinel = join(outside, "active-executable");
      writeFileSync(sentinel, "outside pointer-shaped sentinel");
      const pending = schedule();
      renameSync(root, `${root}-original`);
      symlinkSync(outside, root, "junction");
      const result = nativeCleanup(pending, { current: OTHER });
      expect(result).toMatchObject({
        opens: 0, writes: 0, journalExists: true, fenceExists: true, commandExists: true,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("refusing Windows uninstall reparse point");
      expect(readFileSync(sentinel, "utf-8")).toBe("outside pointer-shaped sentinel");
      expect(readFileSync(join(`${root}-original`, "active-executable"), "utf-8")).toBe("owned pointer");
      expect(lstatSync(root).isSymbolicLink()).toBe(true);
    });
  }, 35_000);

  test("refuses a directory in place of an owned file without deleting its contents", () => {
    withInstall((root) => {
      const sentinel = join(root, "aidlc.settings.json", "keep.txt");
      writeFileSync(dirname(sentinel), "owned settings");
      const pending = schedule();
      rmSync(dirname(sentinel));
      mkdirSync(dirname(sentinel));
      writeFileSync(sentinel, "unrelated directory contents");
      const result = nativeCleanup(pending, { current: OTHER });
      expect(result).toMatchObject({
        opens: 0, writes: 0, journalExists: true, fenceExists: true, commandExists: true,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("invalid Windows uninstall target kind");
      expect(readFileSync(sentinel, "utf-8")).toBe("unrelated directory contents");
      expect(readFileSync(activeExecutablePath(), "utf-8")).toBe("owned pointer");
    });
  }, 35_000);

  for (const purge of [false, true]) {
    for (const fenceInsideRoot of [false, true]) {
      test(`removes runtime paths beyond MAX_PATH (purge=${purge}, fenceInsideRoot=${fenceInsideRoot})`, () => {
        withInstall((root) => {
          if (fenceInsideRoot) {
            process.env.AIDLC_BIN_DIR = join(root, "bin");
            mkdirSync(dirname(commandPath()));
            writeFileSync(commandPath(), "owned command");
          }
          const deepFile = join(root, "versions", "runtime", "nested".repeat(18), "nested".repeat(18), "stage.md");
          expect(deepFile.length).toBeGreaterThan(260);
          mkdirSync(dirname(deepFile), { recursive: true });
          writeFileSync(deepFile, "deep runtime payload");
          const settings = join(root, "aidlc.settings.json");
          writeFileSync(settings, "preserved settings");
          const receipt = registration(dirname(commandPath()));
          writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
          const result = nativeCleanup(schedule(purge, [settings], [deepFile]), {
            current: receipt.registeredValue,
          });
          expect(result).toMatchObject({
            value: OTHER, errors: [], writes: 1, journalExists: false, fenceExists: false,
          });
          expect(existsSync(deepFile)).toBe(false);
          if (purge) expect(existsSync(root)).toBe(false);
          else expect(readFileSync(settings, "utf-8")).toBe("preserved settings");
        });
      }, 35_000);
    }
  }

  for (const purge of [false, true]) {
    test(`removes a literal junction entry with a trailing separator and recovers after alias removal (purge=${purge})`, () => {
      withInstall((root) => {
        const alias = binAlias(root);
        const receipt = registration(`${alias}${sep}`);
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const result = nativeCleanup(schedule(purge), {
          current: `${receipt.registeredValue};D:\\Added`,
          failAfterWrite: true,
          removeAliasAfterFailure: alias,
        });
        expect(result).toMatchObject({
          value: `${OTHER};D:\\Added`, writes: 1, notifications: 1,
          journalExists: false, fenceExists: false, commandExists: false,
        });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("simulated interruption");
        expect(existsSync(receipt.entry)).toBe(false);
        expect(existsSync(dirname(commandPath()))).toBe(true);
      });
    }, 35_000);
  }

  for (const purge of [false, true]) {
    for (const previous of [null, "", OTHER, `${OTHER};`, `;${OTHER};;`]) {
      test(`restores raw value/absence and current kind (purge=${purge}, previous=${JSON.stringify(previous)})`, () => {
        withInstall((root) => {
          const receipt = registration(dirname(commandPath()), previous);
          writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
          const keep = join(root, "pins.json");
          writeFileSync(keep, "retained pins");
          const result = nativeCleanup(schedule(purge, [keep]), {
            current: receipt.registeredValue,
            kind: "String", // User changed the kind since registration.
          });
          expect(result).toMatchObject({
            exists: previous !== null, value: previous, kind: "String",
            writes: 1, notifications: 1, errors: [],
            journalExists: false, fenceExists: false, commandExists: false,
          });
          expect(existsSync(keep)).toBe(!purge);
          if (!purge) expect(readFileSync(keep, "utf-8")).toBe("retained pins");
        });
      }, 35_000);
    }
  }

  test("an existing unowned entry and legacy journal never open HKCU", () => {
    withInstall(() => {
      const current = `${OTHER};${dirname(commandPath())}`;
      const result = nativeCleanup(schedule(), { current });
      expect(result).toMatchObject({
        value: current, opens: 0, writes: 0, notifications: 0, errors: [], journalExists: false,
      });
    });
  }, 35_000);

  test("preserves user additions, raw variables, empty entries, and trailing separators", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), {
        current: `;${receipt.registeredValue};;D:\\Added\\工具;`,
      });
      expect(result).toMatchObject({
        value: `;${OTHER};;D:\\Added\\工具;`,
        kind: "ExpandString", writes: 1, notifications: 1, errors: [],
      });
    });
  }, 35_000);

  for (const spelling of ["uppercase", "trailing slash", "quoted", "variable", "soft hyphen"] as const) {
    test(`preserves a user-altered owned entry (${spelling})`, () => {
      withInstall((root) => {
        const receipt = registration(dirname(commandPath()));
        const altered = {
          uppercase: receipt.entry.toUpperCase(),
          "trailing slash": `${receipt.entry}\\`,
          quoted: `"${receipt.entry}"`,
          variable: "%UNINSTALL_TEST_BIN%",
          "soft hyphen": `${receipt.entry}\u00ad`,
        }[spelling];
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const current = `${OTHER};${altered}`;
        const result = nativeCleanup(schedule(), { current });
        expect(result).toMatchObject({ value: current, writes: 0, notifications: 0, errors: [] });
      });
    }, 35_000);
  }

  for (const options of [
    { kind: "DWord" as const, current: 123 },
    { kind: "MultiString" as const, current: [OTHER] },
    { current: null },
    { current: "", sid: "S-1-5-21-111-222-333-1002" },
  ]) {
    test(`leaves nonstring/absent PATH and other accounts untouched: ${JSON.stringify(options)}`, () => {
      withInstall((root) => {
        const receipt = registration(dirname(commandPath()));
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const current = options.sid ? receipt.registeredValue : options.current;
        const result = nativeCleanup(schedule(), { ...options, current });
        expect(result).toMatchObject({ value: current, writes: 0, notifications: 0, errors: [] });
        if (options.sid) expect(result.opens).toBe(0);
      });
    }, 35_000);
  }

  for (const failBeforeWrite of [true, false]) {
    test(`recovers after root removal without removing a second duplicate (before write=${failBeforeWrite})`, () => {
      withInstall((root) => {
        const receipt = registration(dirname(commandPath()));
        writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
        const current = `${receipt.registeredValue};D:\\Added;${receipt.entry}`;
        const result = nativeCleanup(schedule(), {
          current, failBeforeWrite, failAfterWrite: !failBeforeWrite,
        });
        expect(result).toMatchObject({
          value: `${receipt.registeredValue};D:\\Added`,
          writes: 1, notifications: 1, journalExists: false, fenceExists: false,
        });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("simulated interruption");
        expect(existsSync(root)).toBe(false);
      });
    }, 35_000);
  }

  test("preserves an intervening user edit after an interrupted registry write", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const edited = `${receipt.registeredValue};D:\\AfterCrash`;
      const result = nativeCleanup(schedule(), {
        current: `${receipt.registeredValue};${receipt.entry}`,
        failAfterWrite: true,
        editAfterFailure: edited,
      });
      expect(result).toMatchObject({ value: edited, writes: 1, notifications: 1, journalExists: false });
      expect(result.errors).toHaveLength(1);
    });
  }, 35_000);

  test("a retry after deleting an originally absent Path does not recreate it", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()), null);
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), {
        current: receipt.registeredValue,
        failAfterWrite: true,
      });
      expect(result).toMatchObject({
        exists: false, value: null, writes: 1, notifications: 1, journalExists: false,
      });
      expect(result.errors).toHaveLength(1);
    });
  }, 35_000);

  test("a completed PATH checkpoint prevents further removal on a later retry", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const pending = schedule();
      pending.journal.pathCleanup = {
        beforeValue: `${receipt.registeredValue};${receipt.entry}`,
        completed: true,
      };
      const result = nativeCleanup(pending, { current: receipt.registeredValue });
      expect(result).toMatchObject({
        value: receipt.registeredValue, opens: 0, writes: 0, notifications: 0,
        errors: [], journalExists: false,
      });
    });
  }, 35_000);

  test("never restores entries the user removed since registration", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), {
        current: `D:\\Replacement;${receipt.entry};D:\\Added`,
      });
      expect(result).toMatchObject({
        value: "D:\\Replacement;D:\\Added", writes: 1, notifications: 1, errors: [],
      });
    });
  }, 35_000);

  test("revalidates a corrupt journal receipt before removing files or opening HKCU", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), {
        current: receipt.registeredValue,
        receipt: registration(join(root, "unrelated")),
      });
      expect(result).toMatchObject({
        value: receipt.registeredValue, opens: 0, writes: 0, notifications: 0,
        journalExists: true, fenceExists: true, commandExists: true,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("invalid Windows PATH registration");
    });
  }, 35_000);

  test("refuses a journal whose PATH receipt was removed before deleting files or opening HKCU", () => {
    withInstall((root) => {
      const receipt = registration(dirname(commandPath()));
      writeFileSync(join(root, "windows-path.json"), JSON.stringify(receipt));
      const result = nativeCleanup(schedule(), {
        current: receipt.registeredValue,
        dropReceipt: true,
      });
      expect(result).toMatchObject({
        value: receipt.registeredValue, opens: 0, writes: 0, notifications: 0,
        journalExists: true, fenceExists: true, commandExists: true,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("invalid Windows PATH registration binding");
    });
  }, 35_000);
});

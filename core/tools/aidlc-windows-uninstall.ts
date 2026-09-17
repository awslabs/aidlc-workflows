import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  activeExecutablePath,
  commandPath,
  installRoot,
  machineTransactionRoot,
  windowsUninstallFencePath,
} from "./aidlc-install-paths.ts";
import {
  executePlan,
  writeOperation,
} from "./aidlc-transaction.ts";

export type WindowsUninstallJournal = {
  schemaVersion: 1;
  operation: "windows-uninstall-continuation";
  status: "pending" | "recovering";
  parentPid: number;
  shimPid: number | null;
  installRoot: string;
  commandPath: string;
  pointerPath: string;
  cleanupPath: string;
  fencePath: string;
  purge: boolean;
  preserved: string[];
};

function quoted(value: string): string {
  return value.replaceAll("'", "''");
}

function cleanupScript(journal: WindowsUninstallJournal): string {
  return [
    "param([string]$JournalPath)",
    "$ErrorActionPreference = 'Stop'",
    "$journal = Get-Content -Raw -LiteralPath $JournalPath | ConvertFrom-Json",
    "if ($journal.schemaVersion -ne 1 -or $journal.operation -ne 'windows-uninstall-continuation' -or $journal.status -notin @('pending', 'recovering')) { exit 4 }",
    `$expectedRoot = [IO.Path]::GetFullPath('${quoted(journal.installRoot)}')`,
    `$expectedCommand = [IO.Path]::GetFullPath('${quoted(journal.commandPath)}')`,
    `$expectedPointer = [IO.Path]::GetFullPath('${quoted(journal.pointerPath)}')`,
    `$expectedCleanup = [IO.Path]::GetFullPath('${quoted(journal.cleanupPath)}')`,
    `$expectedFence = [IO.Path]::GetFullPath('${quoted(journal.fencePath)}')`,
    "$root = [IO.Path]::GetFullPath([string]$journal.installRoot)",
    "$command = [IO.Path]::GetFullPath([string]$journal.commandPath)",
    "$pointer = [IO.Path]::GetFullPath([string]$journal.pointerPath)",
    "$cleanup = [IO.Path]::GetFullPath([string]$journal.cleanupPath)",
    "$fence = [IO.Path]::GetFullPath([string]$journal.fencePath)",
    "if ($root -ne $expectedRoot -or $command -ne $expectedCommand -or $pointer -ne $expectedPointer -or $cleanup -ne $expectedCleanup -or $fence -ne $expectedFence -or $cleanup -ne [IO.Path]::GetFullPath($PSCommandPath)) { exit 4 }",
    "if (-not (Test-Path -LiteralPath $fence -PathType Leaf)) { exit 4 }",
    "$fenceRecord = Get-Content -Raw -LiteralPath $fence | ConvertFrom-Json",
    "if ($fenceRecord.schemaVersion -ne 1 -or $fenceRecord.operation -ne 'windows-uninstall-continuation' -or [IO.Path]::GetFullPath([string]$fenceRecord.journalPath) -ne [IO.Path]::GetFullPath($JournalPath)) { exit 4 }",
    "function Wait-ForExit([int]$TargetPid) {",
    "  if ($TargetPid -le 0) { return }",
    "  for ($i = 0; $i -lt 600; $i++) {",
    "    if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) { return }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  throw \"process $TargetPid did not exit before uninstall cleanup timed out\"",
    "}",
    "Wait-ForExit ([int]$journal.parentPid)",
    "if ($null -ne $journal.shimPid) { Wait-ForExit ([int]$journal.shimPid) }",
    "Start-Sleep -Milliseconds 100",
    "$prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "$keep = @($journal.preserved | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })",
    "if ($keep | Where-Object { -not $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }) { exit 4 }",
    "$saved = @{}",
    "foreach ($path in $keep) {",
    "  if (Test-Path -LiteralPath $path -PathType Leaf) { $saved[$path] = [IO.File]::ReadAllBytes($path) }",
    "}",
    "if (Test-Path -LiteralPath $command) { Remove-Item -LiteralPath $command -Force -ErrorAction Stop }",
    "if (Test-Path -LiteralPath $pointer) { Remove-Item -LiteralPath $pointer -Force -ErrorAction Stop }",
    "$fenceInsideRoot = $fence.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)",
    "if (Test-Path -LiteralPath $root) {",
    "  if ($fenceInsideRoot) {",
    "    Get-ChildItem -Force -LiteralPath $root | Where-Object { [IO.Path]::GetFullPath($_.FullName) -ne $fence } | Remove-Item -Recurse -Force -ErrorAction Stop",
    "  } else {",
    "    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop",
    "  }",
    "}",
    "foreach ($entry in $saved.GetEnumerator()) {",
    "  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.Key)) | Out-Null",
    "  [IO.File]::WriteAllBytes($entry.Key, $entry.Value)",
    "}",
    "$journal.status = 'completed'",
    "$journal | Add-Member -NotePropertyName completedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force",
    "$journal | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $JournalPath",
    "Remove-Item -LiteralPath $fence -Force -ErrorAction Stop",
    "if ($fenceInsideRoot -and $saved.Count -eq 0) { Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue }",
    "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath $JournalPath -Force -ErrorAction SilentlyContinue",
    "",
  ].join("\r\n");
}

function fenceReferencesJournal(fencePath: string, journalPath: string): boolean {
  try {
    const value = JSON.parse(readFileSync(fencePath, "utf-8")) as {
      schemaVersion?: unknown;
      operation?: unknown;
      journalPath?: unknown;
    };
    return value.schemaVersion === 1 &&
      value.operation === "windows-uninstall-continuation" &&
      typeof value.journalPath === "string" &&
      resolve(value.journalPath) === resolve(journalPath);
  } catch {
    return false;
  }
}

function readJournal(path: string): WindowsUninstallJournal | null {
  try {
    const match = /^aidlc-uninstall-([0-9a-f-]+)\.json$/.exec(basename(path));
    if (!match) return null;
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<WindowsUninstallJournal>;
    const cleanupPath = join(tmpdir(), `aidlc-uninstall-${match[1]}.ps1`);
    if (
      value.schemaVersion !== 1 ||
      value.operation !== "windows-uninstall-continuation" ||
      (value.status !== "pending" && value.status !== "recovering") ||
      !Number.isSafeInteger(value.parentPid) ||
      (value.shimPid !== null && !Number.isSafeInteger(value.shimPid)) ||
      typeof value.installRoot !== "string" ||
      typeof value.commandPath !== "string" ||
      typeof value.pointerPath !== "string" ||
      typeof value.cleanupPath !== "string" ||
      typeof value.fencePath !== "string" ||
      typeof value.purge !== "boolean" ||
      !Array.isArray(value.preserved) ||
      value.preserved.some((entry) => typeof entry !== "string") ||
      resolve(value.installRoot) !== resolve(installRoot()) ||
      resolve(value.commandPath) !== resolve(commandPath()) ||
      resolve(value.pointerPath) !== resolve(activeExecutablePath()) ||
      resolve(value.cleanupPath) !== resolve(cleanupPath) ||
      resolve(value.fencePath) !== resolve(windowsUninstallFencePath()) ||
      !fenceReferencesJournal(value.fencePath, path) ||
      !existsSync(cleanupPath)
    ) {
      return null;
    }
    const prefix = `${resolve(value.installRoot)}${sep}`;
    if (
      value.preserved.some((entry) =>
        !resolve(entry).startsWith(prefix)
      )
    ) {
      return null;
    }
    return value as WindowsUninstallJournal;
  } catch {
    return null;
  }
}

export function pendingWindowsUninstallJournals(): Array<{
  path: string;
  journal: WindowsUninstallJournal;
}> {
  return scanWindowsUninstallJournals().pending;
}

export function scanWindowsUninstallJournals(): {
  pending: Array<{ path: string; journal: WindowsUninstallJournal }>;
  invalid: string[];
} {
  const pending: Array<{ path: string; journal: WindowsUninstallJournal }> = [];
  const invalid: string[] = [];
  try {
    for (
      const entry of readdirSync(tmpdir())
        .filter((name) => /^aidlc-uninstall-[0-9a-f-]+\.json$/.test(name))
        .sort()
    ) {
      const path = join(tmpdir(), entry);
      let belongsToCurrentInstall = false;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as {
          installRoot?: unknown;
        };
        if (typeof raw.installRoot !== "string") {
          invalid.push(path);
          continue;
        }
        belongsToCurrentInstall = typeof raw.installRoot === "string" &&
          resolve(raw.installRoot) === resolve(installRoot());
      } catch {
        invalid.push(path);
        continue;
      }
      if (!belongsToCurrentInstall) continue;
      const journal = readJournal(path);
      if (journal) pending.push({ path, journal });
      else invalid.push(path);
    }
  } catch {
    // An unreadable temp directory has no actionable per-install evidence.
  }
  const fencePath = windowsUninstallFencePath();
  if (
    existsSync(fencePath) &&
    !pending.some(({ path }) => fenceReferencesJournal(fencePath, path))
  ) {
    invalid.push(fencePath);
  }
  return { pending, invalid };
}

function launch(path: string, journal: WindowsUninstallJournal): void {
  const shimPid = Number(process.env.AIDLC_SHIM_PID);
  const recovering: WindowsUninstallJournal = {
    ...journal,
    status: "recovering",
    parentPid: process.pid,
    shimPid: Number.isSafeInteger(shimPid) && shimPid > 0 ? shimPid : null,
  };
  writeFileSync(path, `${JSON.stringify(recovering, null, 2)}\n`, { mode: 0o600 });
  try {
    const processArgument = (value: string): string =>
      `'"${quoted(value)}"'`;
    const broker = [
      "$ErrorActionPreference = 'Stop'",
      [
        "Start-Process -FilePath 'powershell.exe' -ArgumentList @(",
        [
          "'-NoProfile'",
          "'-NonInteractive'",
          "'-ExecutionPolicy'",
          "'Bypass'",
          "'-File'",
          processArgument(recovering.cleanupPath),
          processArgument(path),
        ].join(","),
        ") -WindowStyle Hidden",
      ].join(""),
    ].join("; ");
    const launched = Bun.spawnSync(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        broker,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    if (launched.exitCode !== 0) {
      const stderr = Buffer.from(launched.stderr).toString("utf-8").trim();
      throw new Error(`Windows uninstall cleanup launch failed${stderr ? `: ${stderr}` : ""}`);
    }
  } catch (error) {
    writeFileSync(
      path,
      `${JSON.stringify({ ...recovering, status: "pending" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
}

export function scheduleWindowsUninstall(
  purge: boolean,
  preserved: readonly string[],
): void {
  const fencePath = windowsUninstallFencePath();
  if (existsSync(fencePath)) {
    throw new Error(
      `pending Windows uninstall fence requires recovery: ${fencePath}`,
    );
  }
  const id = randomUUID();
  const journalPath = join(tmpdir(), `aidlc-uninstall-${id}.json`);
  const cleanupPath = join(tmpdir(), `aidlc-uninstall-${id}.ps1`);
  const journal: WindowsUninstallJournal = {
    schemaVersion: 1,
    operation: "windows-uninstall-continuation",
    status: "pending",
    parentPid: process.pid,
    shimPid: null,
    installRoot: resolve(installRoot()),
    commandPath: resolve(commandPath()),
    pointerPath: resolve(activeExecutablePath()),
    cleanupPath: resolve(cleanupPath),
    fencePath: resolve(fencePath),
    purge,
    preserved: purge ? [] : preserved.map((path) => resolve(path)),
  };
  try {
    writeFileSync(cleanupPath, cleanupScript(journal), { flag: "wx", mode: 0o600 });
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    executePlan({
      schemaVersion: 1,
      root: machineTransactionRoot(),
      operations: [writeOperation(
        relative(machineTransactionRoot(), journal.fencePath),
        `${JSON.stringify({
          schemaVersion: 1,
          operation: journal.operation,
          journalPath,
        }, null, 2)}\n`,
        "absent",
        0o600,
      )],
    }, {
      allowPendingWindowsUninstall: true,
    });
    launch(journalPath, journal);
  } catch (error) {
    if (!existsSync(journal.fencePath)) {
      rmSync(journalPath, { force: true });
      rmSync(cleanupPath, { force: true });
    }
    throw error;
  }
}

export function recoverWindowsUninstallContinuations(requestedPurge?: boolean): number {
  const scan = scanWindowsUninstallJournals();
  if (scan.invalid.length > 0) {
    throw new Error(
      `invalid Windows uninstall journal(s): ${scan.invalid.join(", ")}`,
    );
  }
  const mismatched = requestedPurge === undefined
    ? []
    : scan.pending.filter(({ journal }) => journal.purge !== requestedPurge);
  if (mismatched.length > 0) {
    const pendingMode = mismatched[0].journal.purge ? "--purge" : "non-purge";
    const requestedMode = requestedPurge ? "--purge" : "non-purge";
    throw new Error(
      `pending Windows ${pendingMode} uninstall cannot be resumed as ${requestedMode}; ` +
        "finish or recover the pending uninstall before changing purge mode",
    );
  }
  if (process.platform !== "win32") return 0;
  let recovered = 0;
  for (const { path, journal } of scan.pending) {
    launch(path, journal);
    recovered++;
  }
  return recovered;
}

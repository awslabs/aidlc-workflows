import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  activeExecutablePath,
  canonicalPolicyPath,
  commandPath,
  installRoot,
  machineTransactionRoot,
  windowsUninstallFencePath,
} from "./aidlc-install-paths.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
} from "./aidlc-transaction.ts";
import { assertSafeUninstallRoot } from "./aidlc-uninstall-plan.ts";
import type { UninstallPlan } from "./aidlc-uninstall-plan.ts";

export type WindowsUninstallPlan = UninstallPlan;

// Where cleanup stood when it stopped. `removing` means files may already be
// gone; `finalizing` means only the runnable entry point and control files
// remain, and that entry point may be gone too, so a reinstall may retry it.
export type WindowsUninstallProgress = "removing" | "finalizing";
export type WindowsUninstallFailure = {
  phase: "preflight" | "removal" | "path" | "finalize";
  message: string;
  at: string;
};

export type WindowsUninstallJournal = {
  schemaVersion: 1;
  operation: "windows-uninstall-continuation";
  status: "pending" | "recovering" | "failed";
  parentPid: number;
  shimPid: number | null;
  installRoot: string;
  commandPath: string;
  pointerPath: string;
  cleanupPath: string;
  fencePath: string;
  purge: boolean;
  preserved: string[];
  // Optional only to decode old schema-1 journals; recovery rejects their absence.
  files?: WindowsUninstallPlan["files"];
  directories?: string[];
  pathRegistration?: WindowsPathRegistration;
  pathCleanup?: { beforeValue: string; completed: boolean };
  // Recovery bookkeeping, absent from journals written before it existed.
  attempts?: number;
  launchedAt?: string;
  progress?: WindowsUninstallProgress;
  failure?: WindowsUninstallFailure;
};

// Automatic resumption is bounded: a worker that keeps dying without a result
// needs an explicit `aidlc uninstall` rather than a relaunch on every command.
export const WINDOWS_UNINSTALL_AUTOMATIC_ATTEMPTS = 3;
// A launched worker waits up to a minute for its parent, then removes files.
// Within this window it is presumed alive and is not launched a second time.
export const WINDOWS_UNINSTALL_RUNNING_GRACE_MS = 10 * 60_000;

export type WindowsUninstallContinuationState = "resume" | "running" | "failed";

export function windowsUninstallContinuationState(
  journal: WindowsUninstallJournal,
  now = Date.now(),
): WindowsUninstallContinuationState {
  const launched = journal.launchedAt === undefined ? Number.NaN : Date.parse(journal.launchedAt);
  if (
    journal.status === "recovering" && now >= launched &&
    now - launched < WINDOWS_UNINSTALL_RUNNING_GRACE_MS
  ) return "running";
  // A recorded failure is never relaunched by an ordinary command, at any
  // step: a cause that persists would otherwise block every command. Explicit
  // retries (`aidlc uninstall`, or a reinstall when the entry point is gone)
  // resume it.
  if (journal.status === "failed") return "failed";
  if ((journal.attempts ?? 0) >= WINDOWS_UNINSTALL_AUTOMATIC_ATTEMPTS) return "failed";
  return "resume";
}

export type WindowsPathRegistration = {
  schemaVersion: 1;
  scope: "user";
  accountSid: string;
  entry: string;
  previousValue: string | null;
  previousKind: "String" | "ExpandString" | null;
  registeredValue: string;
};

function pathRegistrationShape(value: unknown): WindowsPathRegistration {
  const receipt = value as Partial<WindowsPathRegistration> | null;
  if (
    !receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !==
      "accountSid,entry,previousKind,previousValue,registeredValue,schemaVersion,scope" ||
    receipt.schemaVersion !== 1 || receipt.scope !== "user" ||
    typeof receipt.accountSid !== "string" ||
    !/^S-1-\d+(?:-\d+)+$/.test(receipt.accountSid) ||
    typeof receipt.entry !== "string" || /[;\r\n\0]/.test(receipt.entry) ||
    !isAbsolute(receipt.entry) ||
    (receipt.previousValue !== null && typeof receipt.previousValue !== "string") ||
    (receipt.previousValue === null
      ? receipt.previousKind !== null
      : receipt.previousKind !== "String" && receipt.previousKind !== "ExpandString") ||
    typeof receipt.registeredValue !== "string"
  ) {
    throw new Error("invalid Windows PATH registration receipt");
  }
  const previous = receipt.previousValue ?? "";
  const registered = !previous || previous.endsWith(";")
    ? `${previous}${receipt.entry}`
    : `${previous};${receipt.entry}`;
  if (receipt.registeredValue !== registered) {
    throw new Error("invalid Windows PATH registration appended value");
  }
  return receipt as WindowsPathRegistration;
}

export function parseWindowsPathRegistration(
  value: unknown,
  canonicalCommandPath: string,
): WindowsPathRegistration {
  const receipt = pathRegistrationShape(value);
  // The installer keeps GetFullPath spelling, including junction aliases and
  // trailing separators. Prove its target while the install still exists, but
  // keep the literal entry for registry removal.
  if (
    canonicalPolicyPath(receipt.entry).toLowerCase() !==
      dirname(canonicalCommandPath).toLowerCase()
  ) {
    throw new Error("invalid Windows PATH registration command directory");
  }
  return receipt;
}

function pathRegistrationBinding(journal: WindowsUninstallJournal): string {
  // Stable field order survives PowerShell journal serialization. The trusted
  // continuation retains this proof after removal of the directory/alias.
  return Buffer.from(JSON.stringify({
    commandPath: journal.commandPath,
    registration: journal.pathRegistration ?? null,
  }, [
    "commandPath", "registration", "schemaVersion", "scope", "accountSid",
    "entry", "previousValue", "previousKind", "registeredValue",
  ]), "utf-8").toString("base64");
}

function deletionScopeBinding(journal: WindowsUninstallJournal): string {
  return Buffer.from(JSON.stringify({
    installRoot: journal.installRoot,
    commandPath: journal.commandPath,
    purge: journal.purge,
    preserved: journal.preserved,
    files: journal.files?.map(({ path, expected }) => ({ path, expected })),
    directories: journal.directories,
  }), "utf-8").toString("base64");
}

function planPathKey(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function assertDeletionPlan(
  value: unknown,
  root: string,
  command: string,
  purge: boolean,
): WindowsUninstallPlan {
  const plan = value as Partial<WindowsUninstallPlan> | null;
  if (
    !plan || !Array.isArray(plan.files) || !Array.isArray(plan.directories) ||
    !Array.isArray(plan.preserved)
  ) throw new Error("Windows uninstall requires an explicit file plan");
  const rootKey = planPathKey(root);
  const commandKey = planPathKey(command);
  const withinRoot = (path: string): boolean =>
    planPathKey(path).startsWith(`${rootKey}${sep}`);
  const absolutePath = (path: unknown): path is string =>
    typeof path === "string" && isAbsolute(path) &&
    !/[\0\r\n]/.test(path);
  const safePath = (path: unknown): path is string =>
    absolutePath(path) &&
    !/(?:^|[\\/])\.git(?:[\\/]|$)/i.test(path) &&
    planPathKey(path) !== planPathKey(parse(path).root) &&
    planPathKey(path) !== planPathKey(homedir());
  for (const path of plan.preserved) {
    if (!absolutePath(path) || (!withinRoot(path) && planPathKey(path) !== commandKey)) {
      throw new Error("invalid Windows uninstall preserved path");
    }
  }
  const files = new Set<string>();
  const settings = new Set([
    "aidlc.settings.json", "update-check.json", "pins.json", "default-harness", "channel",
  ].map((name) => planPathKey(join(root, name))));
  for (const file of plan.files) {
    if (
      !file || typeof file !== "object" || Array.isArray(file) ||
      Object.keys(file).sort().join(",") !== "expected,path" ||
      !safePath(file.path) || planPathKey(file.path) === rootKey ||
      (!withinRoot(file.path) && planPathKey(file.path) !== commandKey) ||
      typeof file.expected !== "string" || !/^sha256:[0-9a-f]{64}$/.test(file.expected) ||
      (!purge && settings.has(planPathKey(file.path))) ||
      files.has(planPathKey(file.path)) ||
      plan.preserved.some((path) =>
        planPathKey(file.path) === planPathKey(path) ||
        planPathKey(file.path).startsWith(`${planPathKey(path)}${sep}`)
      )
    ) throw new Error("invalid Windows uninstall file plan");
    files.add(planPathKey(file.path));
  }
  const directories = new Set<string>();
  for (const [index, path] of plan.directories.entries()) {
    if (
      !safePath(path) || (!withinRoot(path) && planPathKey(path) !== rootKey) ||
      (planPathKey(path) === rootKey && index !== plan.directories.length - 1) ||
      directories.has(planPathKey(path)) || files.has(planPathKey(path))
    ) throw new Error("invalid Windows uninstall directory plan");
    directories.add(planPathKey(path));
  }
  return plan as WindowsUninstallPlan;
}

function quoted(value: string): string {
  return value.replaceAll("'", "''");
}

// Only the bound file list is actionable. Inspect every planned file before
// touching any, then recheck each file's hash and ancestors before deletion.
// Extended paths keep Windows PowerShell 5.1 independent of MAX_PATH.
const BOUNDED_DELETION_SCRIPT = String.raw`
function Test-UninstallWithin([string]$Path, [string]$Root) {
  return $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Get-UninstallAttributes([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}
function Assert-UninstallPath([string]$Path) {
  $ancestors = [Collections.Generic.Stack[string]]::new()
  $cursor = Convert-UninstallPath $Path
  while ($cursor) {
    $ancestors.Push($cursor)
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  # Check from the volume down, before any access through an ancestor.
  while ($ancestors.Count -gt 0) {
    $current = $ancestors.Pop()
    $attributes = Get-UninstallAttributes $current
    if ($null -ne $attributes) {
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "refusing Windows uninstall reparse point: $current"
      }
      if ($ancestors.Count -gt 0 -and -not ($attributes -band [IO.FileAttributes]::Directory)) {
        throw "invalid Windows uninstall ancestor: $current"
      }
    }
  }
  return $attributes
}
function Assert-UninstallKind([string]$Path, [bool]$Directory) {
  $attributes = Assert-UninstallPath $Path
  if ($null -ne $attributes -and
      ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $Directory -or
        ($attributes -band [IO.FileAttributes]::Device))) {
    throw "invalid Windows uninstall target kind: $Path"
  }
  return $attributes
}
function Assert-UninstallScope($Journal) {
  if ($Journal.purge -isnot [bool] -or $Journal.purge -ne $deletionScope.purge -or
      $Journal.files -isnot [array] -or $Journal.files.Count -ne $deletionScope.files.Count) {
    throw 'invalid Windows uninstall deletion scope'
  }
  foreach ($field in @('preserved', 'directories')) {
    if ($Journal.$field -isnot [array] -or $Journal.$field.Count -ne $deletionScope.$field.Count) {
      throw 'invalid Windows uninstall deletion scope'
    }
    for ($i = 0; $i -lt $Journal.$field.Count; $i++) {
      if ($Journal.$field[$i] -isnot [string] -or
          -not [string]::Equals($Journal.$field[$i], $deletionScope.$field[$i], [StringComparison]::Ordinal)) {
        throw 'invalid Windows uninstall deletion scope'
      }
    }
  }
  for ($i = 0; $i -lt $Journal.files.Count; $i++) {
    $file = $Journal.files[$i]
    if ($null -eq $file -or (@($file.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'expected,path' -or
        $file.path -isnot [string] -or $file.expected -isnot [string] -or
        -not [string]::Equals($file.path, $deletionScope.files[$i].path, [StringComparison]::Ordinal) -or
        -not [string]::Equals($file.expected, $deletionScope.files[$i].expected, [StringComparison]::Ordinal)) {
      throw 'invalid Windows uninstall file plan binding'
    }
  }
}
function Test-UninstallPreserved([string]$Path) {
  foreach ($retained in $keep) {
    if ($Path -eq $retained -or (Test-UninstallWithin $Path $retained) -or
        (Test-UninstallWithin $retained $Path)) { return $true }
  }
  return $false
}
function Assert-UninstallTargetBoundary([string]$Path, [bool]$Directory) {
  if ($Path -eq (Convert-UninstallPath ([IO.Path]::GetPathRoot($Path))) -or
      $Path -eq (Convert-UninstallPath ([Environment]::GetFolderPath('UserProfile'))) -or
      $Path -match '(?:^|[\\/])\.git(?:[\\/]|$)' -or
      ($Path -eq $diskRoot -and -not $Directory) -or
      ($Path -ne $diskRoot -and -not (Test-UninstallWithin $Path $diskRoot) -and
        ($Directory -or $Path -ne $diskCommand))) {
    throw "outside Windows uninstall target boundary: $Path"
  }
}
function Assert-UninstallFileTarget($File) {
  $path = $File.path
  Assert-UninstallTargetBoundary $path $false
  if (-not $ownedFiles.ContainsKey($path) -or $ownedFiles[$path] -cne $File.expected -or
      $File.expected -cnotmatch '^sha256:[0-9a-f]{64}$') {
    throw "outside Windows uninstall file scope: $path"
  }
  if (Test-UninstallPreserved $path) { throw "preserved Windows uninstall target: $path" }
  $attributes = Assert-UninstallKind $path $false
  if ($null -eq $attributes) { return $null }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $hash = 'sha256:' + [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { $stream.Dispose() }
  } finally {
    $hasher.Dispose()
  }
  if ($hash -cne $File.expected) { throw "changed Windows uninstall file: $path" }
  return $attributes
}
function Test-UninstallFileChanged($File) {
  try {
    $null = Assert-UninstallFileTarget $File
    return $false
  } catch {
    if ($_.Exception.Message -like 'changed Windows uninstall file: *') { return $true }
    throw
  }
}
function Remove-UninstallFile($File) {
  $attributes = Assert-UninstallFileTarget $File
  if ($null -eq $attributes) { return }
  $path = $File.path
  if ($attributes -band [IO.FileAttributes]::ReadOnly) {
    [IO.File]::SetAttributes($path, ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
    $null = Assert-UninstallFileTarget $File
  }
  [IO.File]::Delete($path)
}
function Remove-UninstallEmptyDirectory([string]$Path) {
  Assert-UninstallTargetBoundary $Path $true
  if ($Path -notin $emptyDirectories) {
    throw "outside Windows uninstall directory scope: $Path"
  }
  if (Test-UninstallPreserved $Path) { return }
  if ($null -eq (Assert-UninstallKind $Path $true)) { return }
  # Inspect only emptiness; never enumerate children into the deletion plan.
  if ([IO.Directory]::GetFileSystemEntries($Path).Length -ne 0) { return }
  $null = Assert-UninstallKind $Path $true
  # false is deliberate: concurrent additions must never be removed.
  [IO.Directory]::Delete($Path, $false)
}
function Assert-UninstallFence {
  if ($null -eq (Assert-UninstallKind $diskFence $false)) { throw 'missing Windows uninstall fence' }
  $record = [IO.File]::ReadAllText($diskFence) | ConvertFrom-Json
  if ($record.schemaVersion -ne 1 -or $record.operation -ne 'windows-uninstall-continuation' -or
      (Convert-UninstallPath ([string]$record.journalPath)) -ne $diskJournal) {
    throw 'invalid Windows uninstall fence'
  }
}
function Remove-UninstallControlFile([string]$Path) {
  if ($Path -notin @($diskFence, $diskJournal, $diskCleanup)) {
    throw "outside Windows uninstall continuation scope: $Path"
  }
  if ($null -ne (Assert-UninstallKind $Path $false)) { [IO.File]::Delete($Path) }
}
`;

// Keep the registry operations behind small adapters so native unit tests can
// execute the emitted cleanup against an in-memory key, without touching HKCU.
const PATH_CLEANUP_SCRIPT = String.raw`
function Convert-UninstallPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $full }
  if ($full.StartsWith('\\', [StringComparison]::Ordinal)) { return '\\?\UNC\' + $full.Substring(2) }
  return '\\?\' + $full
}
function Assert-PathRegistration($Registration, [string]$Command) {
  if ($null -eq $Registration) { throw 'invalid Windows PATH registration receipt' }
  $names = @($Registration.PSObject.Properties.Name | Sort-Object)
  if (($names -join ',') -cne 'accountSid,entry,previousKind,previousValue,registeredValue,schemaVersion,scope' -or
      ($Registration.schemaVersion -isnot [int] -and $Registration.schemaVersion -isnot [long] -and
        $Registration.schemaVersion -isnot [double] -and $Registration.schemaVersion -isnot [decimal]) -or
      $Registration.schemaVersion -ne 1 -or $Registration.scope -isnot [string] -or
      $Registration.scope -cne 'user' -or $Registration.accountSid -isnot [string] -or
      $Registration.accountSid -cnotmatch '^S-1-\d+(?:-\d+)+$' -or
      $Registration.entry -isnot [string] -or $Registration.entry -match '[;\r\n\x00]' -or
      $Registration.registeredValue -isnot [string]) { throw 'invalid Windows PATH registration receipt' }
  if ($null -eq $pathBinding.registration -or
      -not [string]::Equals($pathBinding.commandPath, $Command, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'invalid Windows PATH registration binding'
  }
  foreach ($name in $names) {
    $actual = $Registration.$name
    $expected = $pathBinding.registration.$name
    if (($null -eq $actual) -ne ($null -eq $expected) -or
        -not [string]::Equals([string]$actual, [string]$expected, [StringComparison]::Ordinal)) {
      throw 'invalid Windows PATH registration binding'
    }
  }
  if ($null -eq $Registration.previousValue) {
    if ($null -ne $Registration.previousKind) { throw 'invalid Windows PATH registration kind' }
  } elseif ($Registration.previousValue -isnot [string] -or $Registration.previousKind -isnot [string] -or
      $Registration.previousKind -cnotin @('String', 'ExpandString')) {
    throw 'invalid Windows PATH registration value'
  }
  $previous = [string]$Registration.previousValue
  $appended = if ($previous.Length -eq 0 -or $previous.EndsWith(';')) {
    $previous + $Registration.entry
  } else { $previous + ';' + $Registration.entry }
  if (-not [string]::Equals($Registration.registeredValue, $appended, [StringComparison]::Ordinal)) {
    throw 'invalid Windows PATH registration appended value'
  }
}
function Assert-PathCleanup($Journal, [string]$Command) {
  if ($Journal.PSObject.Properties.Name -contains 'pathRegistration') {
    Assert-PathRegistration $Journal.pathRegistration $Command
  } elseif ($null -ne $pathBinding.registration) {
    # The scheduled script proves a receipt existed; a journal without one
    # would delete the files and the receipt while leaving User PATH behind.
    throw 'invalid Windows PATH registration binding'
  }
  if ($Journal.PSObject.Properties.Name -contains 'pathCleanup') {
    $state = $Journal.pathCleanup
    if ($null -eq $Journal.pathRegistration -or $null -eq $state -or
        (@($state.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'beforeValue,completed' -or
        $state.beforeValue -isnot [string] -or $state.completed -isnot [bool]) {
      throw 'invalid Windows PATH cleanup checkpoint'
    }
  }
}
function Save-UninstallJournal($Journal, [string]$JournalPath) {
  $JournalPath = Convert-UninstallPath $JournalPath
  $next = $JournalPath + '.new'
  $null = Assert-UninstallKind $JournalPath $false
  $null = Assert-UninstallKind $next $false
  [IO.File]::WriteAllText($next, ($Journal | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($next, $JournalPath, [NullString]::Value)
}
function Save-UninstallProgress($Journal, [string]$JournalPath, [string]$Progress) {
  $Journal | Add-Member -NotePropertyName progress -NotePropertyValue $Progress -Force
  Save-UninstallJournal $Journal $JournalPath
}
function Save-UninstallFailure($Journal, [string]$JournalPath, [string]$Phase, [string]$Message) {
  # Bounded and single-line: doctor shows this message to the user.
  $Message = ($Message -replace '[\r\n\t]+', ' ').Trim()
  if ($Message.Length -gt 400) { $Message = $Message.Substring(0, 400) }
  $Journal.status = 'failed'
  $Journal | Add-Member -NotePropertyName failure -NotePropertyValue ([pscustomobject]@{
    phase = $Phase
    message = $Message
    at = [DateTime]::UtcNow.ToString('o')
  }) -Force
  Save-UninstallJournal $Journal $JournalPath
}
function Get-UninstallAccountSid {
  return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function Open-UninstallEnvironment {
  return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
}
function Send-UninstallEnvironmentChange {
  try {
    if (-not ('Aidlc.Uninstaller.EnvironmentNotification' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Aidlc.Uninstaller {
  public static class EnvironmentNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr window, uint message, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
'@
    }
    $result = [UIntPtr]::Zero
    [void][Aidlc.Uninstaller.EnvironmentNotification]::SendMessageTimeout(
      [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
  } catch {
    # A desktop broadcast is best-effort in SSH and constrained Windows sessions.
  }
}
function Get-UnregisteredPath($Registration, [string]$Current) {
  if ([string]::Equals($Current, $Registration.registeredValue, [StringComparison]::Ordinal)) {
    return $Registration.previousValue
  }
  # Literal, case-sensitive matching deliberately preserves user re-spellings.
  # Remove the last exact occurrence: the installer appended its entry.
  $entries = [Collections.Generic.List[string]]::new()
  $entries.AddRange([string[]]($Current -split ';'))
  for ($index = $entries.Count - 1; $index -ge 0; $index--) {
    if ([string]::Equals($entries[$index], $Registration.entry, [StringComparison]::Ordinal)) {
      $entries.RemoveAt($index)
      return $entries -join ';'
    }
  }
  return $Current
}
function Remove-OwnedUserPath($Journal, [string]$Command, [string]$JournalPath) {
  Assert-PathCleanup $Journal $Command
  $registration = $Journal.pathRegistration
  if ($null -eq $registration -or $registration.accountSid -cne (Get-UninstallAccountSid)) { return }
  if ($null -ne $Journal.pathCleanup -and $Journal.pathCleanup.completed) { return }
  $key = Open-UninstallEnvironment
  if ($null -eq $key) { return }
  try {
    $exists = $key.GetValueNames() -contains 'Path'
    $current = $null
    $kind = $null
    if ($exists) {
      $kind = $key.GetValueKind('Path')
      if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) { return }
      $current = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($current -isnot [string]) { return }
    }
    if ($null -eq $Journal.pathCleanup) {
      if (-not $exists) { return }
      $updated = Get-UnregisteredPath $registration $current
      if ($null -ne $updated -and [string]::Equals($updated, $current, [StringComparison]::Ordinal)) { return }
      $Journal | Add-Member -NotePropertyName pathCleanup -NotePropertyValue ([pscustomobject]@{
        beforeValue = $current
        completed = $false
      })
      # Durable intent precedes the registry write. A retry never recomputes a
      # second removal from a PATH that already changed after this checkpoint.
      Save-UninstallJournal $Journal $JournalPath
    }
    $before = $Journal.pathCleanup.beforeValue
    $updated = Get-UnregisteredPath $registration $before
    # Re-read after journaling: do not overwrite an intervening user edit or kind.
    $exists = $key.GetValueNames() -contains 'Path'
    $current = $null
    if ($exists) {
      $kind = $key.GetValueKind('Path')
      if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) { return }
      $current = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($current -isnot [string]) { return }
    }
    if ($exists -and [string]::Equals($current, $before, [StringComparison]::Ordinal)) {
      if ($null -eq $updated) { $key.DeleteValue('Path', $false) }
      elseif (-not [string]::Equals($updated, $current, [StringComparison]::Ordinal)) { $key.SetValue('Path', $updated, $kind) }
    } elseif (-not (($null -eq $current -and $null -eq $updated) -or
        ($null -ne $current -and $null -ne $updated -and [string]::Equals($current, $updated, [StringComparison]::Ordinal)))) {
      # A crash followed by a user edit is ambiguous; preserve that edit.
      # The interrupted attempt may have changed PATH before broadcasting.
      Send-UninstallEnvironmentChange
      $Journal.pathCleanup.completed = $true
      Save-UninstallJournal $Journal $JournalPath
      return
    }
    Send-UninstallEnvironmentChange
    $Journal.pathCleanup.completed = $true
    Save-UninstallJournal $Journal $JournalPath
  } finally {
    $key.Close()
  }
}
`;

function cleanupWorkingDirectory(cleanupPath: string): string {
  if (!isAbsolute(cleanupPath)) {
    throw new Error("Windows uninstall cleanup requires an absolute script path");
  }
  // A volume/share root cannot be retired with the installation or a project.
  // Derive it from the owned control path, never the caller's working directory.
  return parse(cleanupPath).root;
}

export function windowsUninstallCleanupScript(journal: WindowsUninstallJournal): string {
  if ([
    journal.installRoot, journal.commandPath, journal.pointerPath,
    journal.cleanupPath, journal.fencePath, ...journal.preserved,
  ].some((path) => !isAbsolute(path))) {
    throw new Error("Windows uninstall cleanup requires absolute journal paths");
  }
  assertDeletionPlan(journal, journal.installRoot, journal.commandPath, journal.purge);
  return [
    "param([string]$JournalPath)",
    "$ErrorActionPreference = 'Stop'",
    "if (-not [IO.Path]::IsPathRooted($JournalPath)) { exit 4 }",
    // Set both locations: PowerShell's provider location and the native process
    // CWD are distinct. Neither may retain a project after the fence is retired.
    `Set-Location -LiteralPath '${quoted(cleanupWorkingDirectory(journal.cleanupPath))}'`,
    `[Environment]::CurrentDirectory = '${quoted(cleanupWorkingDirectory(journal.cleanupPath))}'`,
    "$journal = Get-Content -Raw -Encoding UTF8 -LiteralPath $JournalPath | ConvertFrom-Json",
    "if ($journal.schemaVersion -ne 1 -or $journal.operation -ne 'windows-uninstall-continuation' -or $journal.status -notin @('pending', 'recovering', 'failed')) { exit 4 }",
    `$expectedRoot = [IO.Path]::GetFullPath('${quoted(journal.installRoot)}')`,
    `$expectedCommand = [IO.Path]::GetFullPath('${quoted(journal.commandPath)}')`,
    `$expectedPointer = [IO.Path]::GetFullPath('${quoted(journal.pointerPath)}')`,
    `$expectedCleanup = [IO.Path]::GetFullPath('${quoted(journal.cleanupPath)}')`,
    `$expectedFence = [IO.Path]::GetFullPath('${quoted(journal.fencePath)}')`,
    `$expectedDeletionScope = '${deletionScopeBinding(journal)}'`,
    "$deletionScope = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expectedDeletionScope)) | ConvertFrom-Json",
    `$expectedPathBinding = '${pathRegistrationBinding(journal)}'`,
    "$pathBinding = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expectedPathBinding)) | ConvertFrom-Json",
    "$root = [IO.Path]::GetFullPath([string]$journal.installRoot)",
    "$command = [IO.Path]::GetFullPath([string]$journal.commandPath)",
    "$pointer = [IO.Path]::GetFullPath([string]$journal.pointerPath)",
    "$cleanup = [IO.Path]::GetFullPath([string]$journal.cleanupPath)",
    "$fence = [IO.Path]::GetFullPath([string]$journal.fencePath)",
    "if ($root -ne $expectedRoot -or $command -ne $expectedCommand -or $pointer -ne $expectedPointer -or $cleanup -ne $expectedCleanup -or $fence -ne $expectedFence -or $cleanup -ne [IO.Path]::GetFullPath($PSCommandPath)) { exit 4 }",
    ...PATH_CLEANUP_SCRIPT.trim().split("\n"),
    ...BOUNDED_DELETION_SCRIPT.trim().split("\n"),
    // Any failure from here is recorded in the journal with the phase it
    // reached, so recovery can retry, re-plan, or report instead of relaunching.
    "$phase = 'preflight'",
    "try {",
    "Assert-UninstallScope $journal",
    "Assert-PathCleanup $journal $command",
    "$diskRoot = Convert-UninstallPath $root",
    "$diskCommand = Convert-UninstallPath $command",
    "$diskFence = Convert-UninstallPath $fence",
    "$diskJournal = Convert-UninstallPath $JournalPath",
    "$diskCleanup = Convert-UninstallPath $cleanup",
    "if ($diskRoot -eq (Convert-UninstallPath ([IO.Path]::GetPathRoot($root))) -or (Convert-UninstallPath $pointer) -ne [IO.Path]::Combine($diskRoot, 'active-executable')) { throw 'invalid Windows uninstall root' }",
    "foreach ($path in @($diskJournal, $diskCleanup, ($diskJournal + '.new'))) { $null = Assert-UninstallKind $path $false }",
    "Assert-UninstallFence",
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
    ...`
  # Once removal has begun, a file edited since is kept rather than leaving a
  # half-removed install that no retry could finish. Before removal, any edit
  # still stops cleanup so uninstall can re-plan from what is on disk.
  $resuming = [string]$journal.progress -in @('removing', 'finalizing')
  $keep = @($deletionScope.preserved | ForEach-Object { Convert-UninstallPath ([string]$_) })
  foreach ($path in $keep) {
    if ($path -ne $diskCommand -and -not (Test-UninstallWithin $path $diskRoot)) {
      throw 'invalid Windows uninstall preserved path'
    }
  }
  # The immutable plan is the only source of file targets. No runtime discovery.
  $ownedFiles = @{}
  $files = @($deletionScope.files | ForEach-Object {
    $path = Convert-UninstallPath ([string]$_.path)
    Assert-UninstallTargetBoundary $path $false
    if ($ownedFiles.ContainsKey($path)) { throw 'duplicate Windows uninstall file target' }
    $ownedFiles[$path] = $_.expected
    [pscustomobject]@{ path = $path; expected = $_.expected }
  })
  $emptyDirectories = @($deletionScope.directories | ForEach-Object { Convert-UninstallPath ([string]$_) })
  foreach ($path in $emptyDirectories) {
    Assert-UninstallTargetBoundary $path $true
    if ($ownedFiles.ContainsKey($path)) { throw 'invalid Windows uninstall directory target' }
    $null = Assert-UninstallKind $path $true
  }
  foreach ($path in @($diskFence, $diskJournal, $diskCleanup, ($diskJournal + '.new'))) {
    if ($ownedFiles.ContainsKey($path) -or (Test-UninstallPreserved $path)) {
      throw 'invalid Windows uninstall continuation location'
    }
    $null = Assert-UninstallKind $path $false
  }
  # aidlc.cmd runs aidlc-shim.ps1, which reads active-version and
  # active-executable to start the active version's aidlc.exe. That chain is removed
  # last, so every earlier failure leaves a command that can retry cleanup.
  $entrypoint = @($diskCommand, (Convert-UninstallPath ([IO.Path]::Combine($root, 'aidlc-shim.ps1'))),
    (Convert-UninstallPath ([IO.Path]::Combine($root, 'active-version'))), (Convert-UninstallPath $pointer))
  $activeVersionFile = Convert-UninstallPath ([IO.Path]::Combine($root, 'active-version'))
  if ($null -ne (Assert-UninstallKind $activeVersionFile $false)) {
    $active = [IO.File]::ReadAllText($activeVersionFile).Trim()
    if ($active -match '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
      $entrypoint += Convert-UninstallPath ([IO.Path]::Combine($root, 'versions', $active, 'aidlc.exe'))
    }
  }
  if ($resuming) { $files = @($files | Where-Object { -not (Test-UninstallFileChanged $_) }) }
  # All hashes and path kinds must pass before even the first file is removed.
  foreach ($file in $files) { $null = Assert-UninstallFileTarget $file }
  Assert-UninstallFence
  if (-not $resuming) { Save-UninstallProgress $journal $JournalPath 'removing' }
  $phase = 'removal'
  foreach ($file in $files) { if ($file.path -notin $entrypoint) { Remove-UninstallFile $file } }
  foreach ($path in $emptyDirectories) { Remove-UninstallEmptyDirectory $path }
  $phase = 'path'
  Remove-OwnedUserPath $journal $command $JournalPath
  $phase = 'finalize'
  Save-UninstallProgress $journal $JournalPath 'finalizing'
  # The executable goes first and aidlc.cmd last, so a failure here most often
  # leaves the command that would retry it. Hashtable keys, like -in, ignore case.
  $rank = @{}
  for ($i = 0; $i -lt $entrypoint.Count; $i++) { $rank[$entrypoint[$i]] = $i }
  $last = @($files | Where-Object { $_.path -in $entrypoint } |
    Sort-Object { $rank[$_.path] } -Descending)
  foreach ($file in $last) { Remove-UninstallFile $file }
  foreach ($path in $emptyDirectories) { Remove-UninstallEmptyDirectory $path }
  Assert-UninstallFence
  $journal.status = 'completed'
  $journal | Add-Member -NotePropertyName completedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  Save-UninstallJournal $journal $JournalPath
} catch {
  $reason = [string]$_.Exception.Message
  try { Save-UninstallFailure $journal $JournalPath $phase $reason } catch {
    # The journal keeps its last checkpoint; bounded automatic recovery covers it.
  }
  throw
}
Remove-UninstallControlFile $diskFence
if ($diskRoot -in $emptyDirectories) { Remove-UninstallEmptyDirectory $diskRoot }
Remove-UninstallControlFile $diskCleanup
Remove-UninstallControlFile $diskJournal
`.trim().split("\n"),
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

function recoveryFieldsValid(value: Partial<WindowsUninstallJournal>): boolean {
  if (
    value.attempts !== undefined &&
    (!Number.isSafeInteger(value.attempts) || value.attempts < 0)
  ) return false;
  if (
    value.launchedAt !== undefined &&
    (typeof value.launchedAt !== "string" || Number.isNaN(Date.parse(value.launchedAt)))
  ) return false;
  if (value.progress !== undefined && value.progress !== "removing" && value.progress !== "finalizing") {
    return false;
  }
  if (value.status === "failed") {
    const failure = value.failure;
    if (
      !failure || typeof failure !== "object" ||
      Object.keys(failure).sort().join(",") !== "at,message,phase" ||
      !["preflight", "removal", "path", "finalize"].includes(failure.phase) ||
      typeof failure.message !== "string" || typeof failure.at !== "string"
    ) return false;
  }
  return true;
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
      (value.status !== "pending" && value.status !== "recovering" && value.status !== "failed") ||
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
    assertDeletionPlan(value, value.installRoot, value.commandPath, value.purge);
    const script = readFileSync(cleanupPath, "utf-8");
    const scopes = [...script.matchAll(
      /^\$expectedDeletionScope = '([A-Za-z0-9+/=]+)'\r?$/gm,
    )];
    // Do not recover an older, unbounded script or let edited journal fields
    // turn a non-purge continuation into a purge.
    if (
      scopes.length !== 1 ||
      scopes[0][1] !== deletionScopeBinding(value as WindowsUninstallJournal)
    ) return null;
    if (Object.hasOwn(value, "pathRegistration")) pathRegistrationShape(value.pathRegistration);
    // Re-resolving a junction here would reject a valid continuation once its
    // alias was removed. Check the receipt against the proof embedded in the
    // existing executable script instead; never rebind on recovery. Compare
    // unconditionally: the deletion scope does not cover the receipt, so a
    // journal whose receipt was removed or added after scheduling must not
    // relaunch with a different PATH outcome.
    const bindings = [...script.matchAll(
      /^\$expectedPathBinding = '([A-Za-z0-9+/=]+)'\r?$/gm,
    )];
    if (
      bindings.length !== 1 ||
      bindings[0][1] !== pathRegistrationBinding(value as WindowsUninstallJournal)
    ) return null;
    if (Object.hasOwn(value, "pathCleanup")) {
      const state = value.pathCleanup;
      if (
        !value.pathRegistration || !state || typeof state !== "object" ||
        Object.keys(state).sort().join(",") !== "beforeValue,completed" ||
        typeof state.beforeValue !== "string" || typeof state.completed !== "boolean"
      ) return null;
    }
    if (!recoveryFieldsValid(value)) return null;
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
  // Cleanup (or a retired plan) completed but its control files remain.
  finished: string[];
} {
  const pending: Array<{ path: string; journal: WindowsUninstallJournal }> = [];
  const invalid: string[] = [];
  const finished: string[] = [];
  try {
    for (
      const entry of readdirSync(tmpdir())
        .filter((name) => /^aidlc-uninstall-[0-9a-f-]+\.json$/.test(name))
        .sort()
    ) {
      const path = join(tmpdir(), entry);
      let belongsToCurrentInstall = false;
      let status: unknown;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as {
          installRoot?: unknown;
          status?: unknown;
        };
        if (typeof raw.installRoot !== "string") {
          invalid.push(path);
          continue;
        }
        belongsToCurrentInstall = typeof raw.installRoot === "string" &&
          resolve(raw.installRoot) === resolve(installRoot());
        status = raw.status;
      } catch {
        invalid.push(path);
        continue;
      }
      if (!belongsToCurrentInstall) continue;
      if (status === "completed") {
        finished.push(path);
        continue;
      }
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
    !pending.some(({ path }) => fenceReferencesJournal(fencePath, path)) &&
    !finished.some((path) => fenceReferencesJournal(fencePath, path))
  ) {
    invalid.push(fencePath);
  }
  return { pending, invalid, finished };
}

function launch(path: string, journal: WindowsUninstallJournal): void {
  path = resolve(path);
  const workingDirectory = cleanupWorkingDirectory(journal.cleanupPath);
  const shimPid = Number(process.env.AIDLC_SHIM_PID);
  const { failure: _previousFailure, ...rest } = journal;
  const recovering: WindowsUninstallJournal = {
    ...rest,
    status: "recovering",
    parentPid: process.pid,
    shimPid: Number.isSafeInteger(shimPid) && shimPid > 0 ? shimPid : null,
    attempts: (journal.attempts ?? 0) + 1,
    launchedAt: new Date().toISOString(),
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
        `) -WorkingDirectory '${quoted(workingDirectory)}' -WindowStyle Hidden`,
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
        cwd: workingDirectory,
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
  plan?: WindowsUninstallPlan,
): void {
  const root = resolve(installRoot());
  assertSafeUninstallRoot(root);
  const command = resolve(commandPath());
  const selectedPlan = assertDeletionPlan(plan, root, command, purge);
  const fencePath = windowsUninstallFencePath();
  if (existsSync(fencePath)) {
    throw new Error(
      `pending Windows uninstall fence requires recovery: ${fencePath}`,
    );
  }
  const id = randomUUID();
  const journalPath = resolve(tmpdir(), `aidlc-uninstall-${id}.json`);
  const cleanupPath = resolve(tmpdir(), `aidlc-uninstall-${id}.ps1`);
  const journal: WindowsUninstallJournal = {
    schemaVersion: 1,
    operation: "windows-uninstall-continuation",
    status: "pending",
    parentPid: process.pid,
    shimPid: null,
    installRoot: root,
    commandPath: command,
    pointerPath: resolve(activeExecutablePath()),
    cleanupPath: resolve(cleanupPath),
    fencePath: resolve(fencePath),
    purge,
    preserved: [...new Set([
      ...selectedPlan.preserved,
      ...(purge ? [] : preserved),
    ].map((path) => resolve(path)))],
    files: selectedPlan.files.map(({ path, expected }) => ({ path: resolve(path), expected })),
    directories: selectedPlan.directories.map((path) => resolve(path)),
  };
  assertDeletionPlan(journal, root, command, purge);
  const receiptPath = join(journal.installRoot, "windows-path.json");
  if (existsSync(receiptPath)) {
    journal.pathRegistration = parseWindowsPathRegistration(
      JSON.parse(readFileSync(receiptPath, "utf-8").replace(/^\uFEFF/, "")),
      journal.commandPath,
    );
  }
  let cleanupCreated = false;
  let journalCreated = false;
  try {
    // Windows PowerShell 5.1 needs a BOM to read non-ASCII path literals.
    writeFileSync(cleanupPath, `\uFEFF${windowsUninstallCleanupScript(journal)}`, { flag: "wx", mode: 0o600 });
    cleanupCreated = true;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    journalCreated = true;
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
      if (journalCreated) rmSync(journalPath, { force: true });
      if (cleanupCreated) rmSync(cleanupPath, { force: true });
    }
    throw error;
  }
}

export type WindowsUninstallRecovery = {
  resumed: number;
  // Launched within the grace window; relaunching would race the live worker.
  running: number;
  // Stopped with a recorded failure, or out of automatic attempts.
  failed: Array<{ path: string; journal: WindowsUninstallJournal }>;
  // Failed before removing anything, so retired for a fresh plan.
  replanned: number;
};

function settleFinishedJournal(path: string): void {
  const fencePath = windowsUninstallFencePath();
  if (existsSync(fencePath) && fenceReferencesJournal(fencePath, path)) {
    const root = machineTransactionRoot();
    executePlan({
      schemaVersion: 1,
      root,
      operations: [{
        kind: "remove",
        path: relative(root, fencePath),
        expected: transactionState(fencePath),
      }],
    }, { allowPendingWindowsUninstall: true });
  }
  const id = /^aidlc-uninstall-([0-9a-f-]+)\.json$/.exec(basename(path))?.[1];
  if (id) rmSync(join(tmpdir(), `aidlc-uninstall-${id}.ps1`), { force: true });
  rmSync(path, { force: true });
}

// A continuation that failed before removing a file owns only its control
// files. Mark it finished before settling, so an interruption is settled by
// the next run instead of leaving a fence no journal explains.
function retireWindowsUninstallContinuation(path: string, journal: WindowsUninstallJournal): void {
  writeFileSync(path, `${JSON.stringify({
    ...journal,
    status: "completed",
    completedAt: new Date().toISOString(),
    retired: true,
  }, null, 2)}\n`, { mode: 0o600 });
  settleFinishedJournal(path);
}

export function recoverWindowsUninstallContinuations(
  requestedPurge?: boolean,
  options: { retryFailed?: boolean } = {},
): WindowsUninstallRecovery {
  const recovery: WindowsUninstallRecovery = { resumed: 0, running: 0, failed: [], replanned: 0 };
  const scan = scanWindowsUninstallJournals();
  if (scan.invalid.length > 0) {
    throw new Error(
      `invalid Windows uninstall journal(s): ${scan.invalid.join(", ")}`,
    );
  }
  const now = Date.now();
  const classified = scan.pending.map((item) => ({
    ...item,
    state: windowsUninstallContinuationState(item.journal, now),
  }));
  // Retiring removes nothing, so a purge mode chosen now may differ from it.
  const retirable = (item: (typeof classified)[number]): boolean =>
    options.retryFailed === true && item.state === "failed" && item.journal.progress === undefined;
  const mismatched = requestedPurge === undefined
    ? []
    : classified.filter((item) => !retirable(item) && item.journal.purge !== requestedPurge);
  if (mismatched.length > 0) {
    const pendingMode = mismatched[0].journal.purge ? "--purge" : "non-purge";
    const requestedMode = requestedPurge ? "--purge" : "non-purge";
    throw new Error(
      `pending Windows ${pendingMode} uninstall cannot be resumed as ${requestedMode}; ` +
        "finish or recover the pending uninstall before changing purge mode",
    );
  }
  // Settling touches only the fence and this install's temp control files, so
  // it needs no install-root guard; a root that later looks unsafe must not
  // leave a finished fence blocking every command.
  if (process.platform === "win32") {
    for (const path of scan.finished) settleFinishedJournal(path);
  }
  if (scan.pending.length === 0) return recovery;
  // The dispatcher runs this before every Windows command. Only a continuation
  // that is about to be relaunched needs the install-root guard; an idle
  // install must keep working even when its configured root is unusual.
  assertSafeUninstallRoot();
  if (process.platform !== "win32") return recovery;
  for (const item of classified) {
    if (item.state === "running") {
      recovery.running++;
    } else if (item.state === "resume" || (options.retryFailed && item.journal.progress !== undefined)) {
      launch(item.path, item.journal);
      recovery.resumed++;
    } else if (retirable(item)) {
      retireWindowsUninstallContinuation(item.path, item.journal);
      recovery.replanned++;
    } else {
      recovery.failed.push({ path: item.path, journal: item.journal });
    }
  }
  return recovery;
}

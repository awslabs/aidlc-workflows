import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, resolve } from "node:path";

export interface DirectoryIdentity { dev: string; ino: string }

function unsafe(path: string, reason: string): Error {
  return new Error(`unsafe native terminal private path ${path}: ${reason}; remove it or point AIDLC_TUI_BUN_ROOT at a private, user-owned 0700 directory (Windows: current-user owner, no public allow ACEs or reparse points)`);
}

/** Pure POSIX checks also apply to descriptors, not just pathname metadata. */
export function validatePrivateStat(
  path: string,
  stat: Pick<fs.BigIntStats, "uid" | "mode" | "isSymbolicLink" | "isDirectory" | "isFile">,
  kind: "directory" | "file",
  uid: number | undefined = process.platform === "win32" ? undefined : process.getuid?.(),
): void {
  if (stat.isSymbolicLink()) throw unsafe(path, "symlink/reparse point is not allowed");
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw unsafe(path, kind === "directory" ? "not a directory" : "not a regular file");
  }
  if (uid !== undefined) {
    if (stat.uid !== BigInt(uid)) throw unsafe(path, `owner uid ${stat.uid} differs from current uid ${uid}`);
    if ((stat.mode & 0o077n) !== 0n) throw unsafe(path, "group/other permission bits are set");
  }
}

export function assertDirectoryIdentity(path: string, actual: DirectoryIdentity, expected: unknown): void {
  const value = expected as DirectoryIdentity | undefined;
  if (!value || value.dev !== actual.dev || value.ino !== actual.ino) {
    throw unsafe(path, "directory identity mismatch (directory was replaced or record is not pinned)");
  }
}

let windowsUserSid: string | undefined;

function powershell(path: string, script: string): unknown {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `
$ErrorActionPreference = 'Stop'
$privatePath = [IO.Path]::GetFullPath($env:AIDLC_PRIVATE_PATH)
$sid = if ($env:AIDLC_PRIVATE_USER_SID) { [Security.Principal.SecurityIdentifier]::new($env:AIDLC_PRIVATE_USER_SID) } else { [Security.Principal.WindowsIdentity]::GetCurrent().User }
$value = & { ${script} }
@{ userSid = $sid.Value; value = $value } | ConvertTo-Json -Compress -Depth 5
`], {
    env: { ...process.env, AIDLC_PRIVATE_PATH: resolve(path), AIDLC_PRIVATE_USER_SID: windowsUserSid ?? "" },
    encoding: "utf8", timeout: 60_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw unsafe(path, `Windows security check failed: ${result.error ?? result.stderr}`);
  const response = JSON.parse(result.stdout.trim()) as { userSid?: unknown; value?: unknown };
  if (typeof response.userSid !== "string" || !/^S-1-(?:\d+-)*\d+$/.test(response.userSid)) {
    throw unsafe(path, "Windows security check returned an invalid current-user SID");
  }
  if (windowsUserSid !== undefined && response.userSid !== windowsUserSid) throw unsafe(path, "current-user SID changed");
  windowsUserSid = response.userSid;
  return response.value;
}

// Node's legacy client must never resolve bun:ffi. Only Windows Bun loads this
// adapter; all public filesystem operations remain synchronous after import.
const windowsSecurity = process.platform === "win32" && process.versions.bun
  ? await import("./tui-windows-private-file.ts") : undefined;

function validateWindowsSecurity(path: string): void {
  if (process.platform !== "win32") return;
  if (windowsSecurity) {
    try { windowsSecurity.validateWindowsPrivatePath(path); }
    catch (error) { throw unsafe(path, String(error)); }
    return;
  }
  const summary = powershell(path, `
$item = Get-Item -LiteralPath $privatePath -Force
$resolvedPath = (Resolve-Path -LiteralPath $privatePath).ProviderPath
$acl = Get-Acl -LiteralPath $resolvedPath
$publicAllow = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -in @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11')
}).Count -ne 0
@{
  ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  nullDacl = $null -eq ([Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)).DiscretionaryAcl
  publicAllow = $publicAllow
}
`) as { ownerSid?: unknown; reparsePoint?: unknown; nullDacl?: unknown; publicAllow?: unknown } | null;
  if (summary?.reparsePoint !== false) throw unsafe(path, "symlink/reparse point is not allowed");
  if (summary.ownerSid !== windowsUserSid) throw unsafe(path, "owner SID differs from current user");
  if (summary.nullDacl !== false) throw unsafe(path, "null DACL allows public access");
  if (summary.publicAllow !== false) throw unsafe(path, "public allow ACE (Everyone, BUILTIN\\Users or Authenticated Users)");
}

export function privateDirectoryIdentity(path: string, expected?: DirectoryIdentity): DirectoryIdentity {
  const stat = fs.lstatSync(path, { bigint: true });
  validatePrivateStat(path, stat, "directory");
  validateWindowsSecurity(path);
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  if (expected) assertDirectoryIdentity(path, identity, expected);
  return identity;
}

function validateRootAncestors(root: string, policy: "explicit" | "temporary"): void {
  // The Windows private-path check requires current-user ownership and rejects
  // public read ACEs too; it cannot validate system-owned drive/profile ancestors.
  // Windows still enforces private root/session ACLs and the launch handshake.
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid === undefined) throw unsafe(root, "cannot establish current uid for ancestor validation");
  const parent = dirname(resolve(root));
  if (policy === "temporary") {
    const stat = fs.statSync(parent, { bigint: true });
    if (!stat.isDirectory() || (stat.uid !== BigInt(uid) && (stat.mode & 0o1777n) !== 0o1777n)) {
      throw unsafe(parent, "temporary ancestor must be current-user-owned or sticky world-writable (1777)");
    }
    return;
  }
  const ancestors = new Set([parent]);
  for (const path of ancestors) {
    ancestors.add(dirname(path));
    let stat: fs.BigIntStats;
    try { stat = fs.statSync(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) throw unsafe(path, "ancestor is not a directory");
    if (stat.uid !== 0n && stat.uid !== BigInt(uid)) throw unsafe(path, "ancestor is not owned by current uid or uid 0");
    if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) {
      throw unsafe(path, "ancestor is writable by other users without the sticky bit");
    }
    // Also walk resolved ancestry: a symlink may cross into a different tree.
    ancestors.add(fs.realpathSync(path));
  }
}

/** Existing directories are verified, never chmod/ACL repaired. */
export function ensurePrivateRoot(root: string, ancestorPolicy?: "explicit" | "temporary"): void {
  if (ancestorPolicy) validateRootAncestors(root, ancestorPolicy);
  fs.mkdirSync(dirname(resolve(root)), { recursive: true, mode: 0o700 });
  if (windowsSecurity) {
    try { windowsSecurity.createWindowsPrivateDirectory(root); }
    catch (error) { throw unsafe(root, String(error)); }
  } else if (process.platform === "win32") {
    try { fs.lstatSync(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Framework's Directory.CreateDirectory(path, security) passes a DACL to
      // CreateDirectoryW atomically. An existing/racing directory is NOT repaired.
      powershell(root, `
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[void][IO.Directory]::CreateDirectory($privatePath, $acl)
`);
    }
  } else {
    try { fs.mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  privateDirectoryIdentity(root);
  if (ancestorPolicy) validateRootAncestors(root, ancestorPolicy);
}

/** Pin the namespace across bounded retries of an atomic record replacement. */
export function readPrivateRecord<T extends { directoryIdentity: DirectoryIdentity }>(directory: string, file: string): T {
  if (resolve(dirname(file)) !== resolve(directory)) throw unsafe(file, "record is outside its session directory");
  const root = dirname(resolve(directory));
  const rootIdentity = privateDirectoryIdentity(root);
  const identity = privateDirectoryIdentity(directory);
  const verify = () => {
    privateDirectoryIdentity(root, rootIdentity);
    privateDirectoryIdentity(directory, identity);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fs.lstatSync(file, { bigint: true });
    validatePrivateStat(file, before, "file");
    validateWindowsSecurity(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      validatePrivateStat(file, stat, "file");
      // publishTuiRecord replaces this inode on each state update. Discard an
      // fd whose pathname security checks addressed the previous publication;
      // retry all checks while keeping the original directory pins. No content
      // from the unvalidated replacement is read, and no other error is retried.
      if (before.dev !== stat.dev || before.ino !== stat.ino) {
        verify();
        continue;
      }
      const value = JSON.parse(fs.readFileSync(fd, "utf8")) as T;
      verify();
      assertDirectoryIdentity(directory, identity, value?.directoryIdentity);
      return value;
    } finally { fs.closeSync(fd); }
  }
  throw unsafe(file, "record identity changed while opening (3 attempts)");
}

const RENAME_RETRY_MS = 250;
const RETRY_DELAY_MS = 5;
const waitWord = new Int32Array(new SharedArrayBuffer(4));

/**
 * Publish a complete private JSON record with same-directory atomic replacement.
 * Windows readers/scanners can briefly deny DELETE sharing. Retry only that
 * rename, for at most 250ms total; never unlink/truncate the visible record.
 * Keep this module usable by both Node clients and Bun daemon/supervisor children.
 */
export function publishTuiRecord(path: string, value: unknown, directoryIdentity?: DirectoryIdentity): void {
  const body = `${JSON.stringify(value)}\n`;
  const directory = dirname(path);
  const root = dirname(resolve(directory));
  const rootIdentity = directoryIdentity ? privateDirectoryIdentity(root) : undefined;
  const verify = () => {
    if (!directoryIdentity) return;
    privateDirectoryIdentity(root, rootIdentity);
    privateDirectoryIdentity(directory, directoryIdentity);
  };
  verify();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Establish ownership before entering cleanup: an unsuccessful exclusive open
  // must not remove a file created by somebody else.
  let fd: number | undefined = fs.openSync(temporary, "wx", 0o600);
  try {
    verify();
    if (directoryIdentity && process.platform === "win32") {
      if (windowsSecurity) windowsSecurity.ownWindowsPrivateFile(temporary);
      else powershell(temporary, `
$resolvedPath = (Resolve-Path -LiteralPath $privatePath).ProviderPath
$acl = Get-Acl -LiteralPath $resolvedPath
$acl.SetOwner($sid)
Set-Acl -LiteralPath $resolvedPath -AclObject $acl
`);
      validateWindowsSecurity(temporary);
    }
    fs.writeFileSync(fd, body);
    const written = fd;
    fd = undefined;
    fs.closeSync(written); // Close the complete file before making it visible.
    const deadline = performance.now() + RENAME_RETRY_MS;
    while (true) {
      verify();
      try {
        fs.renameSync(temporary, path);
        verify();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const remaining = deadline - performance.now();
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
          remaining <= 0
        ) throw error;
        // A timer in this thread cannot fire during synchronous publication.
        Atomics.wait(waitWord, 0, 0, Math.min(RETRY_DELAY_MS, remaining));
        if (performance.now() >= deadline) throw error;
      }
    }
  } catch (error) {
    const failures: unknown[] = [error];
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeError) { failures.push(closeError); }
    }
    try { verify(); fs.unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT") failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        `record publication failed; temporary cleanup failed (${temporary}): ${failures.map(String).join("; ")}`,
        { cause: error });
    }
    throw error;
  }
}

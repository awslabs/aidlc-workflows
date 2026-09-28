import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VERSION_ID } from "./aidlc-channel.ts";
import { renderCompletion, type Shell } from "./aidlc-completions.ts";
import { sha256File } from "./aidlc-distribution.ts";
import {
  binRoot,
  canonicalPolicyPath,
  commandPath,
  installRoot,
  versionsRoot,
} from "./aidlc-install-paths.ts";
import { transactionState } from "./aidlc-transaction.ts";

export type UninstallPlan = {
  files: Array<{ path: string; expected: string }>;
  directories: string[];
  preserved: string[];
};

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function existsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function assertSafeUninstallRoot(candidate = installRoot()): void {
  if (!isAbsolute(candidate) || hasControlCharacter(candidate)) {
    throw new Error("refusing uninstall from an ambiguous install directory");
  }
  const root = canonicalPolicyPath(candidate);
  if (existsWithoutFollowing(root) && !lstatSync(root).isDirectory()) {
    throw new Error(`refusing uninstall from a non-directory: ${root}`);
  }
  const userHome = canonicalPolicyPath(homedir());
  const systemRoots = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "LOCALAPPDATA", "APPDATA"]
      .flatMap((key) => process.env[key] ? [canonicalPolicyPath(process.env[key]!)] : [])
    : ["/usr", "/usr/local", "/opt", "/etc", "/var", "/tmp", "/var/tmp", "/bin", "/sbin", "/lib", "/lib64"];
  if (
    root === dirname(root) ||
    within(userHome, root) ||
    systemRoots.some((path) => root.toLowerCase() === path.toLowerCase()) ||
    [".git", ".hg", ".svn"].includes(basename(root).toLowerCase()) ||
    [".git", ".hg", ".svn"].some((name) => existsWithoutFollowing(join(root, name)))
  ) {
    throw new Error(`refusing uninstall from a shared or project directory: ${root}`);
  }
}

function noLinks(path: string, root: string): boolean {
  if (!within(path, root)) return false;
  const parts = relative(root, path).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index <= parts.length; index++) {
    if (!existsWithoutFollowing(cursor)) return true;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory())) return false;
    if (index < parts.length) cursor = join(cursor, parts[index]);
  }
  return true;
}

type Inventory = {
  schemaVersion: 1;
  version: string;
  files: Array<{ path: string; mode: number; sha256: string }>;
};

function inventoryPath(root: string, entry: string): string {
  if (
    !entry || entry.includes("\\") || entry.includes(":") || hasControlCharacter(entry) ||
    isAbsolute(entry) || entry.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("unsafe file path in installed ownership inventory");
  }
  const path = resolve(root, ...entry.split("/"));
  if (path === root || !within(path, root)) {
    throw new Error("installed ownership inventory leaves its version directory");
  }
  return path;
}

function readInventory(
  manifest: Record<string, unknown>,
  field: "installedFiles" | "installedRuntime",
  version: string,
  root: string,
): { inventory: Inventory; path: string; expected: string } | null {
  const metadata = manifest[field] as Record<string, unknown> | undefined;
  if (metadata === undefined) return null;
  const filename = field === "installedFiles" ? "installed-files.json" : "runtime-integrity.json";
  if (
    metadata?.schemaVersion !== 1 || metadata.baseline !== filename ||
    typeof metadata.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(metadata.sha256)
  ) throw new Error(`invalid ${field} ownership metadata for ${version}`);
  const path = join(root, filename);
  if (!noLinks(path, root) || !existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`cannot verify the ${field} ownership inventory for ${version}`);
  }
  const bytes = readFileSync(path);
  const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (expected !== metadata.sha256) {
    throw new Error(`cannot verify the ${field} ownership inventory for ${version}`);
  }
  const inventory = JSON.parse(bytes.toString("utf-8")) as Inventory;
  if (inventory.schemaVersion !== 1 || inventory.version !== version || !Array.isArray(inventory.files)) {
    throw new Error(`invalid installed file inventory for ${version}`);
  }
  const seen = new Set<string>();
  const fileRoot = field === "installedFiles" ? root : join(root, "runtime");
  for (const row of inventory.files) {
    if (
      !row || typeof row.path !== "string" || !Number.isInteger(row.mode) ||
      row.mode < 0 || row.mode > 0o777 ||
      typeof row.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.sha256)
    ) throw new Error(`invalid installed file entry for ${version}`);
    const file = inventoryPath(fileRoot, row.path);
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) throw new Error(`duplicate installed file entry for ${version}`);
    seen.add(key);
  }
  return { inventory, path, expected };
}

export function buildUninstallPlan(purge: boolean): UninstallPlan {
  assertSafeUninstallRoot();
  const root = resolve(installRoot());
  const command = resolve(commandPath());
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const preserved = new Set<string>();
  const addParents = (file: string): void => {
    for (let dir = dirname(file); within(dir, root); dir = dirname(dir)) {
      directories.add(dir);
      if (dir === root) break;
    }
  };
  const addFile = (path: string, expected?: string, mode?: number): void => {
    if (!noLinks(path, root)) {
      preserved.add(path);
      return;
    }
    if (!existsWithoutFollowing(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() ||
      (expected !== undefined && sha256File(path) !== expected) ||
      (mode !== undefined && (stat.mode & 0o777) !== mode)) {
      preserved.add(path);
      return;
    }
    files.set(path, expected ?? sha256File(path));
    addParents(path);
  };
  const scanRemaining = (directory: string): void => {
    if (!noLinks(directory, root)) {
      preserved.add(directory);
      return;
    }
    if (!existsWithoutFollowing(directory)) return;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      if (!files.has(directory)) preserved.add(directory);
      return;
    }
    directories.add(directory);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const child = lstatSync(path);
      if (child.isDirectory() && !child.isSymbolicLink()) scanRemaining(path);
      else if (!files.has(path)) preserved.add(path);
    }
  };

  const versions = resolve(versionsRoot());
  if (existsWithoutFollowing(versions)) {
    if (!noLinks(versions, root) || !lstatSync(versions).isDirectory()) {
      preserved.add(versions);
    } else {
      directories.add(versions);
      for (const name of readdirSync(versions)) {
        const version = join(versions, name);
        if (!VERSION_ID.test(name) || !noLinks(version, root) || !lstatSync(version).isDirectory()) {
          preserved.add(version);
          continue;
        }
        const manifestPath = join(version, "version.json");
        if (!noLinks(manifestPath, root) || !existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
          preserved.add(version);
          continue;
        }
        const manifestBytes = readFileSync(manifestPath);
        const manifestExpected = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
        // An unreadable manifest is no ownership evidence: keep the version
        // for review, exactly like a manifest whose identity does not match.
        let manifest: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(manifestBytes.toString("utf-8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            manifest = parsed as Record<string, unknown>;
          }
        } catch {
          manifest = null;
        }
        if (manifest?.schemaVersion !== 1 || manifest.version !== name) {
          preserved.add(version);
          continue;
        }
        const full = readInventory(manifest, "installedFiles", name, version);
        const inventory = full ?? readInventory(manifest, "installedRuntime", name, version);
        if (!inventory) {
          preserved.add(version);
          continue;
        }
        const fileRoot = full ? version : join(version, "runtime");
        for (const row of inventory.inventory.files) {
          addFile(inventoryPath(fileRoot, row.path), row.sha256, row.mode);
        }
        if (!full) {
          const executable = process.platform === "win32" ? "aidlc.exe" : "aidlc";
          const executablePath = join(version, executable);
          const executableHash = noLinks(executablePath, root) && existsSync(executablePath) &&
              lstatSync(executablePath).isFile()
            ? sha256File(executablePath)
            : null;
          const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
          const binary = assets.find((asset) =>
            asset && typeof asset.name === "string" && asset.name.startsWith("aidlc-") &&
            asset.kind === "binary" && typeof asset.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(asset.sha256) &&
            executableHash === `sha256:${asset.sha256}`
          );
          if (binary) addFile(executablePath, `sha256:${binary.sha256}`);
        }
        addFile(inventory.path, inventory.expected);
        addFile(manifestPath, manifestExpected);
        scanRemaining(version);
      }
    }
  }

  const known = [
    "active-version", "active-executable", "rollback-version", "aidlc-shim.ps1", "windows-path.json",
    ...(purge ? ["aidlc.settings.json", "update-check.json", "pins.json", "default-harness", "channel"] : []),
  ];
  for (const name of known) addFile(join(root, ...name.split("/")));
  for (const [shell, name] of Object.entries({
    bash: "aidlc.bash", zsh: "_aidlc", fish: "aidlc.fish", powershell: "aidlc.ps1",
  })) {
    const expected = `sha256:${createHash("sha256").update(renderCompletion(shell as Shell)).digest("hex")}`;
    addFile(join(root, "completions", name), expected);
  }
  if (existsWithoutFollowing(command)) {
    const stat = lstatSync(command);
    const parent = resolve(binRoot());
    if (
      noLinks(dirname(command), parent) &&
      (stat.isFile() || (process.platform !== "win32" && stat.isSymbolicLink()))
    ) {
      files.set(command, transactionState(command));
      if (within(command, root)) addParents(command);
    } else {
      preserved.add(command);
    }
  }
  for (const folder of ["completions", "reservations", "bin"]) {
    const path = join(root, folder);
    if (existsWithoutFollowing(path) && noLinks(path, root) && lstatSync(path).isDirectory()) {
      directories.add(path);
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        if (!files.has(file) && file !== command) preserved.add(file);
      }
    }
  }
  directories.add(root);
  const keptSettings = new Set(["aidlc.settings.json", "update-check.json", "pins.json", "default-harness", "channel"]);
  for (const directory of directories) {
    if (within(directory, versions)) continue;
    if (!noLinks(directory, root)) {
      preserved.add(directory);
      continue;
    }
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (files.has(path) || directories.has(path) ||
        (!purge && directory === root && keptSettings.has(name))) continue;
      preserved.add(path);
    }
  }
  const priority = (path: string): number =>
    path === command || dirname(path) === root
      ? 3
      : ["aidlc", "aidlc.exe", "version.json", "installed-files.json"].includes(basename(path)) ? 2 : 0;
  return {
    files: [...files].map(([path, expected]) => ({ path, expected }))
      .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path)),
    directories: [...directories].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    preserved: [...preserved].sort(),
  };
}

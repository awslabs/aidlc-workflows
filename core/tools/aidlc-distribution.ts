import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { VERSION_ID } from "./aidlc-channel.ts";

export type ProjectionStamp = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
};

export type RootIntegration = {
  path: string;
  policy: "managed-block" | "json-map" | "json-array" | "whole-file";
  marker?: string;
  jsonKey?: string;
  optional?: boolean;
  legacySignatures?: {
    wholeFileHashes?: string[];
    jsonEntryHashes?: Record<string, string[]>;
  };
};

export type ProjectionDescriptor = {
  schemaVersion: 1;
  distribution: string;
  productName: string;
  configNextStep: string;
  harnessDir: string;
  managedDirectories: string[];
  legacyManagedFileHashes?: Record<string, string[]>;
  rootIntegrations: RootIntegration[];
};

function parseJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function safeRelativePath(value: unknown, label: string, topLevel = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    (topLevel && value.includes("/"))
  ) {
    throw new Error(`${label} is not a safe ${topLevel ? "top-level name" : "relative path"}`);
  }
  return value;
}

function validateHashes(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((hash) => typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique lowercase SHA-256 signatures`);
  }
  return value;
}

export function assertProjectionPathHasNoSymlinks(
  root: string,
  relativePath: string,
): void {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${root}: projected path traverses a symlink: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${root}: projected path parent is not a directory: ${relativePath}`);
    }
  }
}

export function validateProjectionDescriptor(
  root: string,
  stamp: ProjectionStamp,
  descriptor: ProjectionDescriptor,
  options: { allowMissingRootIntegrations?: boolean } = {},
): void {
  if (!VERSION_ID.test(stamp.frameworkVersion)) {
    throw new Error(`${root}: projection stamp has an invalid framework version`);
  }
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(stamp.distribution) ||
    typeof descriptor.productName !== "string" ||
    descriptor.productName.trim().length === 0 ||
    typeof descriptor.configNextStep !== "string" ||
    descriptor.configNextStep.trim().length === 0
  ) {
    throw new Error(`${root}: projection identity is invalid`);
  }
  safeRelativePath(stamp.harnessDir, "harnessDir", true);
  if (!Array.isArray(descriptor.managedDirectories) || !Array.isArray(descriptor.rootIntegrations)) {
    throw new Error(`${root}: projection descriptor lists are invalid`);
  }
  const declared = new Set<string>();
  const declare = (safe: string): void => {
    if (declared.has(safe)) throw new Error(`${root}: duplicate projected path ${safe}`);
    const overlap = [...declared].find((prior) =>
      safe.startsWith(`${prior}/`) || prior.startsWith(`${safe}/`)
    );
    if (overlap) {
      throw new Error(`${root}: overlapping projected paths ${overlap} and ${safe}`);
    }
    declared.add(safe);
  };
  for (const directory of descriptor.managedDirectories) {
    const safe = safeRelativePath(directory, "managed directory", true);
    declare(safe);
    assertProjectionPathHasNoSymlinks(root, safe);
    const path = join(root, safe);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error(`${root}: managed directory is missing or invalid: ${safe}`);
    }
  }
  if (descriptor.legacyManagedFileHashes !== undefined) {
    const signatures = descriptor.legacyManagedFileHashes;
    if (
      !signatures ||
      typeof signatures !== "object" ||
      Array.isArray(signatures) ||
      Object.keys(signatures).length === 0
    ) {
      throw new Error(`${root}: legacy managed-file signatures are invalid`);
    }
    for (const [file, hashes] of Object.entries(signatures)) {
      const safe = safeRelativePath(file, "legacy managed file");
      if (
        !descriptor.managedDirectories.some((directory) =>
          safe === directory || safe.startsWith(`${directory}/`)
        )
      ) {
        throw new Error(`${root}: legacy managed file is outside managed directories: ${safe}`);
      }
      assertProjectionPathHasNoSymlinks(root, safe);
      const path = join(root, safe);
      if (!existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`${root}: legacy managed file is missing or invalid: ${safe}`);
      }
      validateHashes(hashes, `${root}: ${safe} legacy managed-file signatures`);
    }
  }
  for (const integration of descriptor.rootIntegrations) {
    if (!integration || typeof integration !== "object") {
      throw new Error(`${root}: root integration is invalid`);
    }
    const safe = safeRelativePath(integration.path, "root integration path");
    declare(safe);
    assertProjectionPathHasNoSymlinks(root, safe);
    const path = join(root, safe);
    if (
      !existsSync(path) &&
      (integration.optional || options.allowMissingRootIntegrations)
    ) {
      continue;
    }
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`${root}: root integration is missing or invalid: ${safe}`);
    }
    if (!["managed-block", "json-map", "json-array", "whole-file"].includes(integration.policy)) {
      throw new Error(`${root}: ${safe} has an invalid integration policy`);
    }
    if (
      integration.policy === "managed-block" &&
      (typeof integration.marker !== "string" || !/^[a-z0-9-]+$/.test(integration.marker))
    ) {
      throw new Error(`${root}: ${safe} has an invalid managed-block marker`);
    }
    if (
      (integration.policy === "json-map" || integration.policy === "json-array") &&
      (typeof integration.jsonKey !== "string" || integration.jsonKey.length === 0)
    ) {
      throw new Error(`${root}: ${safe} has an invalid JSON integration key`);
    }
    const legacy = integration.legacySignatures;
    if (legacy !== undefined) {
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
        throw new Error(`${root}: ${safe} has invalid legacy signatures`);
      }
      const keys = Object.keys(legacy);
      if (
        keys.length === 0 ||
        keys.some((key) => key !== "wholeFileHashes" && key !== "jsonEntryHashes")
      ) {
        throw new Error(`${root}: ${safe} has invalid legacy signature fields`);
      }
      if (legacy.wholeFileHashes !== undefined) {
        if (integration.policy !== "managed-block" && integration.policy !== "whole-file") {
          throw new Error(`${root}: ${safe} cannot use legacy whole-file signatures`);
        }
        validateHashes(legacy.wholeFileHashes, `${root}: ${safe} legacy whole-file signatures`);
      }
      if (legacy.jsonEntryHashes !== undefined) {
        if (
          integration.policy !== "json-map" ||
          !legacy.jsonEntryHashes ||
          typeof legacy.jsonEntryHashes !== "object" ||
          Array.isArray(legacy.jsonEntryHashes) ||
          Object.keys(legacy.jsonEntryHashes).length === 0
        ) {
          throw new Error(`${root}: ${safe} has invalid legacy JSON-entry signatures`);
        }
        for (const [entry, hashes] of Object.entries(legacy.jsonEntryHashes)) {
          if (entry.length === 0) {
            throw new Error(`${root}: ${safe} has an empty legacy JSON entry name`);
          }
          validateHashes(hashes, `${root}: ${safe} legacy JSON entry ${entry}`);
        }
      }
    }
  }
}

export function projectionFiles(root: string): {
  stamp: ProjectionStamp;
  descriptor: ProjectionDescriptor;
} {
  const candidates = readdirSync(root)
    .filter((name) => existsSync(join(root, name, "tools", "data", "aidlc-stamp.json")))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `${root}: expected exactly one projected harness directory, found ${candidates.length}`,
    );
  }
  const harnessDir = candidates[0];
  const data = join(root, harnessDir, "tools", "data");
  const stamp = parseJson<ProjectionStamp>(join(data, "aidlc-stamp.json"));
  const descriptor = parseJson<ProjectionDescriptor>(join(data, "aidlc-projection.json"));
  if (
    stamp.schemaVersion !== 1 ||
    descriptor.schemaVersion !== 1 ||
    stamp.harnessDir !== harnessDir ||
    descriptor.harnessDir !== harnessDir ||
    stamp.distribution !== descriptor.distribution
  ) {
    throw new Error(`${root}: projection stamp and descriptor do not describe one distribution`);
  }
  validateProjectionDescriptor(root, stamp, descriptor);
  const allowedTopLevel = new Set([
    ...descriptor.managedDirectories,
    ...descriptor.rootIntegrations.map((item) => item.path.split(/[\\/]/)[0]),
  ]);
  const unexpected = readdirSync(root).filter((entry) => !allowedTopLevel.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`${root}: unclassified projection entries: ${unexpected.sort().join(", ")}`);
  }
  return { stamp, descriptor };
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
      else throw new Error(`${path}: links and special files are not valid projection content`);
    }
  };
  visit(root);
  return files;
}

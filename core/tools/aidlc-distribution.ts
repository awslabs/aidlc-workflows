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
  /** jsonc-settings adds each shipped top-level key that is absent and never changes a key someone else set. */
  policy: "managed-block" | "json-map" | "json-array" | "whole-file" | "jsonc-settings";
  marker?: string;
  /** union combines shipped line sets (.gitignore); identical lets any declaring harness own byte-identical content; absent is exclusive. */
  shared?: "union" | "identical";
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
  firstRunSteps?: string[];
  editorTerminalApp?: string;
  harnessDir: string;
  onboarding?: string;
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

export function isSafeOnboardingPath(value: unknown, harnessDir: string): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._\/-]+$/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    value.startsWith(`${harnessDir}/`);
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
  if (
    (descriptor.firstRunSteps !== undefined &&
      (!Array.isArray(descriptor.firstRunSteps) ||
        descriptor.firstRunSteps.length === 0 ||
        descriptor.firstRunSteps.some((line) => typeof line !== "string"))) ||
    (descriptor.editorTerminalApp !== undefined &&
      (typeof descriptor.editorTerminalApp !== "string" ||
        !/^[a-z0-9][a-z0-9 .-]*$/.test(descriptor.editorTerminalApp)))
  ) {
    throw new Error(`${root}: projection first-run guidance is invalid`);
  }
  safeRelativePath(stamp.harnessDir, "harnessDir", true);
  if (descriptor.onboarding !== undefined) {
    const safe = descriptor.onboarding;
    if (!isSafeOnboardingPath(safe, stamp.harnessDir)) {
      throw new Error(`${root}: onboarding path is invalid`);
    }
    try {
      assertProjectionPathHasNoSymlinks(root, safe);
    } catch {
      throw new Error(`${root}: onboarding path is invalid`);
    }
    if (!lstatSync(join(root, safe), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${root}: onboarding file is missing: ${safe}`);
    }
  }
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
    if (
      integration.shared !== undefined &&
      integration.shared !== "union" &&
      integration.shared !== "identical"
    ) {
      throw new Error(`${root}: ${safe} has an invalid shared mode`);
    }
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
    if (!["managed-block", "json-map", "json-array", "whole-file", "jsonc-settings"].includes(integration.policy)) {
      throw new Error(`${root}: ${safe} has an invalid integration policy`);
    }
    if (integration.policy === "jsonc-settings" && !jsoncRootMembers(readFileSync(path, "utf-8"))?.members.length) {
      throw new Error(`${root}: ${safe} must ship a JSON object with at least one setting`);
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

// The copy channel copies runtime/<harness>/ over the project, with no config
// step to merge anything, so its archive leaves out each file a team's editor
// owns (a jsonc-settings integration such as .vscode/settings.json): a copy
// would replace the team's own file.
export function copyChannelOmits(
  descriptor: Pick<ProjectionDescriptor, "rootIntegrations">,
): Set<string> {
  return new Set(descriptor.rootIntegrations
    .filter((integration) => integration.policy === "jsonc-settings")
    .map((integration) => integration.path));
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

// --- JSONC settings files ----------------------------------------------------
// A settings file such as .vscode/settings.json is JSONC and belongs to the
// team: comments, trailing commas, and layout stay as they are. Edits are made
// in place on the text, one top-level member at a time, never by rewriting it.

type JsoncMember = {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** After the member's trailing comma when it has one, else valueEnd. */
  end: number;
};

function skipJsoncTrivia(text: string, at: number): number {
  let index = at;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\uFEFF") {
      index++;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 2;
    } else {
      break;
    }
  }
  return index;
}

function skipJsoncString(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
    else if (text[index] === "\n") return -1;
  }
  return -1;
}

function skipJsoncValue(text: string, at: number): number {
  if (text[at] === '"') return skipJsoncString(text, at);
  if (text[at] === "{" || text[at] === "[") {
    let depth = 0;
    let index = at;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = skipJsoncString(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
        index = skipJsoncTrivia(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return -1;
  }
  let index = at;
  while (index < text.length && !/[\s,}\]/]/.test(text[index])) index++;
  return index > at ? index : -1;
}

/** The root object's top-level members, or null when the text is not one JSONC object. */
export function jsoncRootMembers(text: string): { open: number; close: number; members: JsoncMember[] } | null {
  let index = skipJsoncTrivia(text, 0);
  if (index < 0 || text[index] !== "{") return null;
  const open = index;
  index = skipJsoncTrivia(text, index + 1);
  const members: JsoncMember[] = [];
  while (index >= 0 && index < text.length && text[index] !== "}") {
    if (text[index] !== '"') return null;
    const start = index;
    const keyEnd = skipJsoncString(text, index);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, keyEnd));
    } catch {
      return null;
    }
    index = skipJsoncTrivia(text, keyEnd);
    if (index < 0 || text[index] !== ":") return null;
    const valueStart = skipJsoncTrivia(text, index + 1);
    if (valueStart < 0 || valueStart >= text.length) return null;
    const valueEnd = skipJsoncValue(text, valueStart);
    if (valueEnd < 0) return null;
    index = skipJsoncTrivia(text, valueEnd);
    if (index < 0) return null;
    let end = valueEnd;
    if (text[index] === ",") {
      end = index + 1;
      index = skipJsoncTrivia(text, index + 1);
      if (index < 0) return null;
    } else if (text[index] !== "}") {
      return null;
    }
    members.push({ key: String(key), start, valueStart, valueEnd, end });
  }
  if (index < 0 || text[index] !== "}") return null;
  if (skipJsoncTrivia(text, index + 1) !== text.length) return null;
  return { open, close: index, members };
}

/** The parsed value of one top-level member, or undefined when it is absent. */
export function jsoncSettingValue(text: string, key: string): unknown {
  const root = jsoncRootMembers(text);
  const member = root?.members.findLast((candidate) => candidate.key === key);
  if (!member) return undefined;
  try {
    return Bun.JSONC.parse(text.slice(member.valueStart, member.valueEnd));
  } catch {
    return undefined;
  }
}

/** Add `key` as the root object's last member, keeping every other byte. */
export function insertJsoncSetting(text: string, key: string, valueJson: string): string | null {
  const source = text.trim() ? text : "{}\n";
  const root = jsoncRootMembers(source);
  if (!root) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStartOf = (position: number): number => source.lastIndexOf("\n", position - 1) + 1;
  const first = root.members[0];
  const firstPrefix = first ? source.slice(lineStartOf(first.start), first.start) : "";
  const indent = first && firstPrefix.trim() === "" && firstPrefix.length > 0 ? firstPrefix : "  ";
  const member = `${JSON.stringify(key)}: ${valueJson}`;
  const closeLine = lineStartOf(root.close);
  const closeOnOwnLine = closeLine > root.open && source.slice(closeLine, root.close).trim() === "";
  let next = closeOnOwnLine
    ? `${source.slice(0, closeLine)}${indent}${member}${eol}${source.slice(closeLine)}`
    : `${source.slice(0, root.close).trimEnd()}${eol}${indent}${member}${eol}${source.slice(root.close)}`;
  const last = root.members.at(-1);
  if (last && last.end === last.valueEnd) {
    next = `${next.slice(0, last.valueEnd)},${next.slice(last.valueEnd)}`;
  }
  return next;
}

/** Replace one top-level member's value in place. */
export function replaceJsoncSetting(text: string, key: string, valueJson: string): string | null {
  const member = jsoncRootMembers(text)?.members.findLast((candidate) => candidate.key === key);
  if (!member) return null;
  return `${text.slice(0, member.valueStart)}${valueJson}${text.slice(member.valueEnd)}`;
}

/** Remove one top-level member (and its line when it stood alone), keeping every other byte. */
export function removeJsoncSetting(text: string, key: string): string | null {
  const root = jsoncRootMembers(text);
  if (!root) return null;
  const at = root.members.findIndex((candidate) => candidate.key === key);
  if (at < 0) return text;
  const member = root.members[at];
  let start = member.start;
  let end = member.end;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim() === "") {
    start = lineStart;
    let after = end;
    while (text[after] === " " || text[after] === "\t") after++;
    if (text[after] === "\r" && text[after + 1] === "\n") end = after + 2;
    else if (text[after] === "\n") end = after + 1;
  }
  let next = `${text.slice(0, start)}${text.slice(end)}`;
  // The last member had no comma of its own: drop the one before it instead.
  const previous = root.members[at - 1];
  if (member.end === member.valueEnd && previous && previous.end !== previous.valueEnd) {
    next = `${next.slice(0, previous.end - 1)}${next.slice(previous.end)}`;
  }
  return next;
}

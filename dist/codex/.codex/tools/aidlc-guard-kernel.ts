import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceSourceListing } from "./aidlc-lib.ts";

/**
 * Guard decisions are default-deny: names may deny, while allow decisions rest
 * only on canonical real paths, immutable Git objects, or evidence already
 * sealed in the append-only ledger. See docs/reference/06-hooks-and-tools.md.
 */

export interface ProtectedStore {
  name: string;
  realPath: string;
}

export type BarrierVerdict =
  | { kind: "proven-disjoint" }
  | { kind: "proven-framework-tool" }
  | { kind: "store-overlap"; store: string; path: string }
  | { kind: "unprovable"; reason: string };

export interface BarrierInput {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  cwd: string;
  projectDir: string;
  /** Additional executables trusted by the harness, such as a compiled shell. */
  frameworkExecutablePaths?: readonly string[];
  /** Canonical proof supplied by a harness with a richer native path model. */
  preclassifiedVerdict?:
    | "proven-disjoint"
    | "store-overlap"
    | "unprovable";
}

interface ParsedShell {
  words: string[];
  segments: string[][];
  dynamic: boolean;
  composed: boolean;
  reason: string | null;
}

const PATH_KEYS = new Set([
  "file_path",
  "notebook_path",
  "path",
  "paths",
  "file",
  "source",
  "target",
  "destination",
]);

const INDIRECT_COMMANDS = new Set([
  "env",
  "exec",
  "nohup",
  "nice",
  "ionice",
  "stdbuf",
  "setsid",
  "sudo",
  "doas",
  "xargs",
  "time",
  "unbuffer",
  "timeout",
]);

const EVALUATOR_COMMANDS =
  /^(?:eval|source|\.|(?:ba|da|fi|k|z)?sh|bunx?|deno|node|nodejs|npm|npx|pnpm|yarn|corepack|tsx|ts-node|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|lua|luajit|raku|julia|java|js|qjs|osascript|powershell|pwsh)$/i;

const SHELL_CONTROL_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
]);

const TRANSFORMATION_ATTRIBUTES = [
  "filter",
  "ident",
  "text",
  "eol",
  "working-tree-encoding",
] as const;

const MAX_GIT_BUFFER = 512 * 1024 * 1024;
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

function normalizedInputPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function canonicalExistingPath(value: string): string | null {
  try {
    return realpathSync(resolve(normalizedInputPath(value)));
  } catch {
    return null;
  }
}

/**
 * Resolve an existing store root to its canonical real path. A missing or
 * unreadable store has no provable identity and therefore returns null.
 */
export function resolveProtectedStore(
  name: string,
  lexicalPath: string,
): ProtectedStore | null {
  if (!name || !lexicalPath || lexicalPath.includes("\0")) return null;
  const realPath = canonicalExistingPath(lexicalPath);
  return realPath === null ? null : { name, realPath };
}

function canonicalCandidate(raw: string, cwd: string): string | null {
  if (!raw || raw.includes("\0")) return null;
  let absolute: string;
  try {
    const normalized = normalizedInputPath(raw);
    absolute = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(cwd, normalized);
  } catch {
    return null;
  }

  let existing = absolute;
  for (;;) {
    try {
      lstatSync(existing);
      const existingReal = realpathSync(existing);
      const suffix = relative(existing, absolute);
      return suffix ? resolve(existingReal, suffix) : existingReal;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
  }
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function overlap(
  candidate: string,
  stores: readonly ProtectedStore[],
): { store: string; path: string } | null {
  for (const store of stores) {
    if (
      pathContains(store.realPath, candidate) ||
      pathContains(candidate, store.realPath)
    ) {
      return { store: store.name, path: candidate };
    }
  }
  return null;
}

function appendPathValues(
  value: unknown,
  values: string[],
): boolean {
  if (typeof value === "string" && value.length > 0) {
    values.push(value);
    return true;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.every((item) => appendPathValues(item, values));
  }
  return false;
}

function nativePathValues(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
): string[] | null {
  if (toolInput === undefined) return null;
  const values: string[] = [];
  let sawPathKey = false;
  for (const [key, value] of Object.entries(toolInput)) {
    if (
      PATH_KEYS.has(key) ||
      key.endsWith("_path") ||
      key.endsWith("_file")
    ) {
      sawPathKey = true;
      if (!appendPathValues(value, values)) return null;
    }
  }
  if (values.length > 0) return values;
  if (!sawPathKey && (toolName === "Grep" || toolName === "Glob")) return [cwd];
  return null;
}

function parseShell(command: string): ParsedShell {
  const words: string[] = [];
  const segments: string[][] = [];
  let segment: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let dynamic = false;
  let composed = false;
  let escaped = false;

  const push = () => {
    if (word.length > 0) {
      words.push(word);
      segment.push(word);
    }
    word = "";
  };
  const endSegment = () => {
    push();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    const code = ch.charCodeAt(0);
    if (code === 0 || (code < 32 && ch !== "\t")) {
      return {
        words,
        segments,
        dynamic: true,
        composed,
        reason: "shell command contains a control character",
      };
    }
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = command[index + 1] ?? "";
      if (next === "" || /\s|['"\\$`]/.test(next)) {
        escaped = true;
      } else {
        word += ch;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else {
        if (ch === "$" || ch === "`") dynamic = true;
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "~") {
      dynamic = true;
      word += ch;
      continue;
    }
    if (
      (ch === "{" || ch === "}") &&
      word.length === 0 &&
      (command[index + 1] === undefined ||
        /\s|[;|&()<>]/.test(command[index + 1]))
    ) {
      endSegment();
      composed = true;
      continue;
    }
    if ("*?[]{}".includes(ch)) {
      dynamic = true;
      word += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (";|&()<>".includes(ch)) {
      if ((ch === "<" || ch === ">") && command[index + 1] === "(") {
        dynamic = true;
      }
      endSegment();
      composed = true;
      continue;
    }
    word += ch;
  }
  if (escaped || quote !== null) {
    return {
      words,
      segments,
      dynamic: true,
      composed,
      reason: "shell command has unterminated quoting or escaping",
    };
  }
  endSegment();
  if (words.some((candidate) => candidate.includes("\n") || candidate.includes("\r"))) {
    return {
      words,
      segments,
      dynamic: true,
      composed,
      reason: "shell word contains a control character",
    };
  }
  return { words, segments, dynamic, composed, reason: null };
}

function lexicalAbsolute(raw: string, cwd: string): string | null {
  if (!raw || raw.includes("\0")) return null;
  try {
    const normalized = normalizedInputPath(raw);
    return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
  } catch {
    return null;
  }
}

function sameRealFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function frameworkToolVerdict(
  parsed: ParsedShell,
  input: BarrierInput,
): boolean {
  if (parsed.dynamic || parsed.composed || parsed.words.length < 2) return false;
  const interpreter = parsed.words[0];
  if (!isAbsolute(normalizedInputPath(interpreter))) return false;
  if (
    parsed.words.slice(1).some(
      (arg) =>
        arg === "-r" ||
        arg === "--require" ||
        arg === "--preload" ||
        arg.startsWith("--require=") ||
        arg.startsWith("--preload="),
    )
  ) {
    return false;
  }

  const anchors = [
    process.execPath,
    ...(input.frameworkExecutablePaths ?? []),
  ];
  if (!anchors.some((anchor) => sameRealFile(interpreter, anchor))) return false;

  let scriptIndex = 1;
  if (parsed.words[1] === "run") scriptIndex = 2;
  const scriptWord = parsed.words[scriptIndex];
  if (!scriptWord || scriptWord.startsWith("-")) return false;
  const scriptLexical = lexicalAbsolute(scriptWord, input.cwd);
  if (scriptLexical === null) return false;

  try {
    const projectReal = realpathSync(resolve(input.projectDir));
    const toolsReal = realpathSync(TOOLS_DIR);
    if (!pathContains(projectReal, toolsReal)) return false;
    if (dirname(scriptLexical) !== resolve(TOOLS_DIR)) return false;
    if (!/^aidlc-[A-Za-z0-9._-]+\.ts$/.test(basename(scriptLexical))) {
      return false;
    }
    const lexicalStat = lstatSync(scriptLexical);
    if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) return false;
    const scriptReal = realpathSync(scriptLexical);
    return dirname(scriptReal) === toolsReal && statSync(scriptReal).isFile();
  } catch {
    return false;
  }
}

function shellBarrier(
  input: BarrierInput,
  stores: readonly ProtectedStore[],
): BarrierVerdict {
  const command = input.toolInput?.command;
  if (typeof command !== "string" || command.length === 0) {
    return { kind: "unprovable", reason: "shell command is missing" };
  }
  const parsed = parseShell(command);
  if (frameworkToolVerdict(parsed, input)) {
    return { kind: "proven-framework-tool" };
  }
  for (const word of parsed.words) {
    const dynamicAt = word.search(/[$`*?[\]{}~]/);
    const leadingFilesystemPattern =
      dynamicAt === 0 && "*?[{".includes(word[0] ?? "");
    if (dynamicAt > 0 || leadingFilesystemPattern) {
      const prefix = canonicalCandidate(
        dynamicAt === 0 ? "." : word.slice(0, dynamicAt),
        input.cwd,
      );
      if (prefix !== null) {
        const prefixMatch = overlap(prefix, stores);
        if (prefixMatch !== null) {
          return { kind: "store-overlap", ...prefixMatch };
        }
        const namedStore = stores.find(
          (store) =>
            store.realPath.startsWith(prefix) ||
            prefix.startsWith(store.realPath),
        );
        if (namedStore !== undefined) {
          return {
            kind: "store-overlap",
            store: namedStore.name,
            path: prefix,
          };
        }
      }
    }
    const candidate = canonicalCandidate(word, input.cwd);
    if (candidate === null) {
      return {
        kind: "unprovable",
        reason: "a shell word has no canonical path identity",
      };
    }
    const matched = overlap(candidate, stores);
    if (matched !== null) return { kind: "store-overlap", ...matched };
  }
  if (parsed.reason !== null) {
    return { kind: "unprovable", reason: parsed.reason };
  }
  if (parsed.dynamic) {
    return {
      kind: "unprovable",
      reason: "shell designators are not syntactically closed",
    };
  }
  for (const segment of parsed.segments) {
    let commandIndex = 0;
    while (SHELL_CONTROL_WORDS.has(segment[commandIndex]?.toLowerCase() ?? "")) {
      commandIndex++;
    }
    const commandName = basename(segment[commandIndex] ?? "").toLowerCase();
    if (
      INDIRECT_COMMANDS.has(commandName) ||
      EVALUATOR_COMMANDS.test(commandName) ||
      SHELL_CONTROL_WORDS.has(segment[0]?.toLowerCase() ?? "")
    ) {
      return {
        kind: "unprovable",
        reason: "the invocation delegates filesystem designation",
      };
    }
  }
  return { kind: "proven-disjoint" };
}

/**
 * Decide whether every designatable path is canonically outside every
 * protected store, or whether a framework tool has proven executable identity.
 */
export function protectedStoreBarrier(
  input: BarrierInput,
  stores: readonly ProtectedStore[],
): BarrierVerdict {
  if (input.preclassifiedVerdict === "proven-disjoint") {
    return { kind: "proven-disjoint" };
  }
  if (input.preclassifiedVerdict === "unprovable") {
    return {
      kind: "unprovable",
      reason: "the harness-native proof is unavailable",
    };
  }
  if (input.preclassifiedVerdict === "store-overlap") {
    const store = stores[0];
    return store === undefined
      ? {
          kind: "unprovable",
          reason: "the overlapping store has no canonical descriptor",
        }
      : {
          kind: "store-overlap",
          store: store.name,
          path: store.realPath,
        };
  }
  if (
    !input.toolName ||
    !isAbsolute(input.cwd) ||
    !isAbsolute(input.projectDir) ||
    stores.length === 0
  ) {
    return { kind: "unprovable", reason: "barrier scope is incomplete" };
  }
  if (
    stores.some(
      (store) =>
        !store.name ||
        !isAbsolute(store.realPath) ||
        canonicalExistingPath(store.realPath) !== store.realPath,
    )
  ) {
    return { kind: "unprovable", reason: "protected store identity is unavailable" };
  }
  try {
    if (input.toolName === "Bash") return shellBarrier(input, stores);
    const values = nativePathValues(input.toolName, input.toolInput, input.cwd);
    if (values === null) {
      return {
        kind: "unprovable",
        reason: "tool input has no closed path-designator shape",
      };
    }
    for (const value of values) {
      const candidate = canonicalCandidate(value, input.cwd);
      if (candidate === null) {
        return {
          kind: "unprovable",
          reason: "a tool path has no canonical identity",
        };
      }
      const matched = overlap(candidate, stores);
      if (matched !== null) return { kind: "store-overlap", ...matched };
    }
    return { kind: "proven-disjoint" };
  } catch (error) {
    return {
      kind: "unprovable",
      reason: `path proof failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validOid(oid: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid);
}

function git(
  repoDir: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    encoding?: BufferEncoding | null;
  } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("git", ["-C", repoDir, ...args], {
    env: options.env,
    input: options.input,
    encoding: options.encoding === undefined ? "utf-8" : options.encoding,
    maxBuffer: MAX_GIT_BUFFER,
  });
}

function provenCommit(repoDir: string, commit: string): boolean {
  if (!validOid(commit)) return false;
  const type = git(repoDir, ["cat-file", "-t", commit]);
  if (type.status !== 0 || String(type.stdout).trim() !== "commit") return false;
  return git(repoDir, ["cat-file", "-e", `${commit}^{commit}`]).status === 0;
}

function sourceListingEntry(mode: string, oid: string): string | null {
  if (!/^\d{6}$/.test(mode) || !validOid(oid)) return null;
  return `${mode} ${oid}`;
}

function defaultExclusions(carriesWorkspaceShell: boolean): string[] {
  return [
    ...(carriesWorkspaceShell ? ["aidlc/", ".aidlc/"] : []),
    ":(glob)**/aidlc/spaces/*/intents/**/.aidlc-sensors/**",
  ];
}

function withCommitIndex<T>(
  repoDir: string,
  commit: string,
  run: (env: NodeJS.ProcessEnv) => T | null,
): T | null {
  if (!provenCommit(repoDir, commit)) return null;
  const objectPath = git(repoDir, ["rev-parse", "--git-path", "objects"]);
  if (objectPath.status !== 0 || !String(objectPath.stdout).trim()) return null;
  const objectFormat = git(repoDir, ["rev-parse", "--show-object-format"]);
  const format = String(objectFormat.stdout).trim();
  if (
    objectFormat.status !== 0 ||
    (format !== "sha1" && format !== "sha256")
  ) {
    return null;
  }
  const root = mkdtempSync(join(tmpdir(), "aidlc-guard-git-"));
  const indexFile = join(root, `index-${randomUUID()}`);
  const gitDir = join(root, "git");
  try {
    const rawObjectPath = String(objectPath.stdout).trim();
    const objectDir = realpathSync(
      isAbsolute(rawObjectPath)
        ? rawObjectPath
        : resolve(repoDir, rawObjectPath),
    );
    const initialized = spawnSync(
      "git",
      ["init", "--bare", `--object-format=${format}`, "-q", gitDir],
      { encoding: "utf-8", maxBuffer: MAX_GIT_BUFFER },
    );
    if (initialized.status !== 0) return null;
    const env = {
      ...process.env,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: indexFile,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_WORK_TREE: repoDir,
    };
    const readTree = git(repoDir, ["read-tree", commit], { env });
    if (readTree.status !== 0) return null;
    return run(env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function transformationInIndex(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  paths: readonly string[],
): boolean | null {
  if (paths.length === 0) return false;
  const attr = git(
    repoDir,
    [
      "-c",
      `core.attributesFile=${devNull}`,
      "check-attr",
      "--cached",
      "-z",
      "--stdin",
      ...TRANSFORMATION_ATTRIBUTES,
    ],
    { env, input: Buffer.from(`${paths.join("\0")}\0`, "utf-8") },
  );
  if (attr.status !== 0) return null;
  const fields = String(attr.stdout).split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (value && value !== "unspecified") return true;
  }
  return false;
}

/**
 * Report whether a commit declares any materialization-time content
 * transformation on its regular files. Unknown results remain unknown.
 */
export function commitCarriesContentTransformation(
  repoDir: string,
  commit: string,
  paths: readonly string[],
): boolean | null {
  if (paths.some((path) => !path || path.includes("\0"))) return null;
  return withCommitIndex(repoDir, commit, (env) =>
    transformationInIndex(repoDir, env, paths)
  );
}

/**
 * Build a source listing exclusively from commit/index object metadata.
 */
export function immutableCommitSourceListing(
  repoDir: string,
  commit: string,
  carriesWorkspaceShell: boolean,
  exclusionPathspecs = defaultExclusions(carriesWorkspaceShell),
): WorkspaceSourceListing | null {
  return withCommitIndex(repoDir, commit, (env) => {
    const excluded = git(
      repoDir,
      [
        "rm",
        "-r",
        "-q",
        "-f",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...exclusionPathspecs,
      ],
      { env },
    );
    if (excluded.status !== 0) return null;
    const listed = git(repoDir, ["ls-files", "-s", "-z"], { env });
    if (listed.status !== 0) return null;

    const listing: WorkspaceSourceListing = new Map();
    const regularPaths: string[] = [];
    for (const record of String(listed.stdout).split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      if (tab === -1) return null;
      const match = /^(\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+$/.exec(
        record.slice(0, tab),
      );
      const path = record.slice(tab + 1);
      if (match === null || !path) return null;
      const entry = sourceListingEntry(match[1], match[2]);
      if (entry === null) return null;
      listing.set(`\0${path}`, entry);
      if (match[1] === "100644" || match[1] === "100755") {
        regularPaths.push(path);
      }
    }
    const transformed = transformationInIndex(repoDir, env, regularPaths);
    return transformed === false ? listing : null;
  });
}

/** Read exact immutable blob bytes without materializing a worktree file. */
export function immutableBlobBytes(
  repoDir: string,
  oid: string,
): Buffer | null {
  if (!validOid(oid)) return null;
  const type = git(repoDir, ["cat-file", "-t", oid]);
  if (type.status !== 0 || String(type.stdout).trim() !== "blob") return null;
  const blob = git(repoDir, ["cat-file", "blob", oid], { encoding: null });
  return blob.status === 0 && Buffer.isBuffer(blob.stdout)
    ? blob.stdout
    : null;
}

/** Return a prefixed sha256 fingerprint of immutable blob bytes. */
export function immutableBlobSha256(
  repoDir: string,
  oid: string,
): string | null {
  const bytes = immutableBlobBytes(repoDir, oid);
  return bytes === null
    ? null
    : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// aidlc-claude-own-command.ts: Claude Code runs AI-DLC's own command without a prompt however a
// helper spells this project's path.
//
// The copy channel's settings ship `Bash(bun <harness>/tools/aidlc.ts engine *)`, and Claude Code
// matches a Bash rule against the command text as written, so a helper that spelled this project's
// path absolute (`bun /work/app/<harness>/tools/aidlc.ts engine now`, or `C:/work/app/...`) met a
// prompt for a step AI-DLC runs for itself, and so did a helper's one-line read of AI-DLC's record.
// The check group before a tool call answers "allow" for exactly those once every check passed
// (aidlc.ts runGroupMembers). The host applies every deny and ask rule over a hook's allow, but a
// rule written for AI-DLC's own spelling never meets the absolute one, so any deny or ask rule that
// names aidlc in a settings file this process can read means no allow. MDM, registry and
// server-delivered policy cannot be read here.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  engineInvocationFromWords,
  harnessDir,
  parseLiteralShellInvocation,
  pathContainedBy,
  sameDirectory,
} from "./aidlc-lib.ts";
import { workspaceRoot } from "./aidlc-locks.ts";

function claudeSettingsFiles(projectDir: string, harness: string): string[] {
  const managed = process.platform === "win32"
    ? "C:\\Program Files\\ClaudeCode"
    : process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(join(managed, "managed-settings.d"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(managed, "managed-settings.d", name));
  } catch {
    // No drop-in folder.
  }
  return [
    join(projectDir, harness, "settings.json"),
    join(projectDir, harness, "settings.local.json"),
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"),
    join(managed, "managed-settings.json"),
    ...dropIns,
  ];
}

// Null when a deny or ask rule names AI-DLC, or a settings file cannot be read: the host decides alone.
function claudeOwnCommandRules(projectDir: string, harness: string): { engineAllowed: boolean } | null {
  const namesAidlc = (rules: unknown): boolean =>
    Array.isArray(rules) && rules.some((rule) => typeof rule === "string" && /aidlc/i.test(rule));
  let engineAllowed = false;
  for (const [index, file] of claudeSettingsFiles(projectDir, harness).entries()) {
    if (!existsSync(file)) continue;
    let permissions: { allow?: unknown; deny?: unknown; ask?: unknown } | undefined;
    try {
      permissions = (JSON.parse(readFileSync(file, "utf-8")) as { permissions?: typeof permissions } | null)?.permissions;
    } catch {
      return null;
    }
    if (namesAidlc(permissions?.deny) || namesAidlc(permissions?.ask)) return null;
    // Only the project's own settings carry the shipped rule this answer stands for.
    if (index === 0 && Array.isArray(permissions?.allow)) {
      engineAllowed = permissions.allow.includes(`Bash(bun ${harness}/tools/aidlc.ts engine *)`);
    }
  }
  return { engineAllowed };
}

// A path as written, never resolved against a working folder: POSIX `/...`, or a Windows
// drive-letter path (no network path).
function rootedPath(word: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(word) : word.startsWith("/");
}

// Inside `root` as written and through every link.
function pathInside(root: string, path: string): boolean {
  if (!pathContainedBy(resolvePath(root), resolvePath(path))) return false;
  try {
    let probe = resolvePath(path);
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    return pathContainedBy(realpathSync.native(root), realpathSync.native(probe));
  } catch {
    return false;
  }
}

// `bun <this project>/<harness>/tools/aidlc.ts engine ...`, that file as written and through every
// link, and the words exactly as the shipped rule starts:
// no assignment or wrapper in front (`AIDLC_PROJECT_DIR=...` would aim the engine elsewhere), no
// `cd` first, and any --project-dir naming this project.
function ownEngineCommand(
  words: { directory: string | null; argv: string[]; rawWords: string[] },
  projectDir: string,
  harness: string,
): boolean {
  if (words.directory !== null || words.rawWords[0] !== "bun" || words.rawWords[2] !== "engine") return false;
  const path = words.argv[1] ?? "";
  const engine = join(projectDir, harness, "tools", "aidlc.ts");
  const asWritten = (file: string): string => process.platform === "win32" ? resolvePath(file).toLowerCase() : resolvePath(file);
  if (!rootedPath(path) || asWritten(path) !== asWritten(engine) || !sameDirectory(path, engine)) return false;
  const invocation = engineInvocationFromWords(words.argv, words.rawWords);
  if (invocation === null || typeof invocation === "string") return false;
  return invocation.projectDir === null ||
    (rootedPath(invocation.projectDir) && sameDirectory(invocation.projectDir, projectDir));
}

// A list split at `;` and `&&` outside quotes; null when a quote never closes.
function shellListParts(command: string): string[] | null {
  const parts: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === "\\") {
      i++;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ";" || command.startsWith("&&", i)) {
      parts.push(command.slice(start, i));
      if (ch === "&") i++;
      start = i + 1;
    }
  }
  if (quote !== null) return null;
  parts.push(command.slice(start));
  return parts;
}

// The compound read as helpers ran it, and nothing wider: `cat` of files in this project's `aidlc/`
// record, `echo` of plain words, and `git -C <this project> rev-parse HEAD`, each part alone a read,
// every path absolute. Any other shape keeps the host's prompt.
function ownRecordRead(command: string, projectDir: string): boolean {
  const parts = shellListParts(command);
  if (parts === null) return false;
  const record = workspaceRoot(projectDir);
  return parts.every((part) => {
    const words = parseLiteralShellInvocation(part.replace(/[ \t]+2>\/dev\/null[ \t]*$/, ""));
    if (words === null || words.directory !== null) return false;
    const [name, ...args] = words.argv;
    if (words.rawWords[0] !== name) return false;
    if (name === "cat") return args.length > 0 && args.every((arg) => rootedPath(arg) && pathInside(record, arg));
    if (name === "echo") return true;
    return name === "git" && args.length === 4 && args[0] === "-C" && rootedPath(args[1]) &&
      sameDirectory(args[1], projectDir) && args[2] === "rev-parse" && args[3] === "HEAD";
  });
}

/** Whether Claude Code may run this Bash command without asking, as AI-DLC's own (see above). */
export function claudeAllowsOwnCommand(command: string, projectDir: string): boolean {
  const harness = harnessDir();
  const rules = claudeOwnCommandRules(projectDir, harness);
  if (rules === null) return false;
  const words = parseLiteralShellInvocation(command);
  if (words?.rawWords[0] === "bun") return rules.engineAllowed && ownEngineCommand(words, projectDir, harness);
  return ownRecordRead(command, projectDir);
}

// aidlc-claude-own-command.ts: Claude Code runs AI-DLC's own command without a prompt however a
// helper spells this project's path.
//
// The copy channel's settings allow AI-DLC's tool commands in their relative spelling
// (`Bash(bun <harness>/tools/aidlc.ts engine *)`, `Bash(bun <harness>/tools/aidlc-utility.ts *)`, ...),
// and Claude Code matches a Bash rule against the command text as written, so a helper that spelled
// this project's path absolute (`bun /work/app/<harness>/tools/aidlc.ts engine now`, or
// `C:/work/app/...`) met a prompt for a step AI-DLC runs for itself, and so did a helper's one-line
// read of AI-DLC's record. The check group before a tool call answers "allow" for exactly those once
// every check passed (aidlc.ts runGroupMembers): the absolute spelling of a command the project's own
// allow list holds in the relative one, and that read. The host applies every deny and ask rule over a
// hook's allow, but a Bash rule written for AI-DLC's own spelling never meets the absolute one, so a
// deny or ask rule that could (naming aidlc, a Read rule, or a Bash rule naming bun or the harness
// folder) in a settings file this process can read means no allow. MDM, registry and
// server-delivered policy cannot be read here.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import {
  harnessDir,
  parseLiteralShellInvocation,
  pathContainedBy,
  sameDirectory,
} from "./aidlc-lib.ts";
import { workspaceRoot } from "./aidlc-locks.ts";
import { managedSettingsFiles, resolveManagedSettingsCandidates } from "./aidlc-statusline-choice.ts";

// The managed files come from the resolver the doctor and the statusline already read them through.
function claudeSettingsFiles(projectDir: string, harness: string): string[] {
  return [
    join(projectDir, harness, "settings.json"),
    join(projectDir, harness, "settings.local.json"),
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"),
    ...resolveManagedSettingsCandidates(process.platform, process.env).flatMap(managedSettingsFiles),
  ];
}

// The project's own allow list, or null when a deny or ask rule could be meant for these commands or a
// settings file cannot be read: the host decides alone. Read rules count for the record read (`reads`),
// as the host applies them to `cat` by path; other tools' rules (`Edit(.claude/settings.json)`) never.
function claudeOwnCommandRules(projectDir: string, harness: string, reads: boolean): { allow: string[] } | null {
  const shellWord = new RegExp(`\\bbun\\b|${harness.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const meantForThese = (rules: unknown): boolean =>
    Array.isArray(rules) && rules.some((rule) => typeof rule === "string" &&
      (/aidlc/i.test(rule) || (reads && /^Read\b/i.test(rule)) || (/^Bash\b/i.test(rule) && shellWord.test(rule))));
  let allow: string[] = [];
  for (const [index, file] of claudeSettingsFiles(projectDir, harness).entries()) {
    if (!existsSync(file)) continue;
    let permissions: { allow?: unknown; deny?: unknown; ask?: unknown } | undefined;
    try {
      permissions = (JSON.parse(readFileSync(file, "utf-8")) as { permissions?: typeof permissions } | null)?.permissions;
    } catch {
      return null;
    }
    if (meantForThese(permissions?.deny) || meantForThese(permissions?.ask)) return null;
    // Only the project's own settings carry the shipped rules this answer stands for.
    if (index === 0 && Array.isArray(permissions?.allow)) {
      allow = permissions.allow.filter((rule): rule is string => typeof rule === "string");
    }
  }
  return { allow };
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

// `bun <this project>/<harness>/tools/<file> ...` in the relative spelling the shipped rules use, or
// null: the folder as written, the words exactly as a rule starts (no assignment or wrapper in front;
// `AIDLC_PROJECT_DIR=...` would aim the engine elsewhere), no `cd` first, and any --project-dir naming
// this project.
function relativeToolCommand(
  words: { directory: string | null; argv: string[]; rawWords: string[] },
  projectDir: string,
  harness: string,
): string | null {
  if (words.directory !== null || words.rawWords[0] !== "bun") return null;
  const path = words.argv[1] ?? "";
  const asWritten = (file: string): string => process.platform === "win32" ? resolvePath(file).toLowerCase() : resolvePath(file);
  const file = basename(path);
  if (!rootedPath(path) || !/^[A-Za-z0-9._-]+$/.test(file) || asWritten(dirname(path)) !== asWritten(join(projectDir, harness, "tools"))) return null;
  for (let i = 2; i < words.argv.length; i++) {
    const arg = words.argv[i];
    if (arg !== "--project-dir" && !arg.startsWith("--project-dir=")) continue;
    const value = arg === "--project-dir" ? words.argv[++i] : arg.slice("--project-dir=".length);
    if (value === undefined || !rootedPath(value) || !sameDirectory(value, projectDir)) return null;
  }
  return ["bun", `${harness}/tools/${file}`, ...words.rawWords.slice(2)].join(" ");
}

// A shipped rule's two shapes: the exact command, or a prefix before ` *`.
function ruleAllows(rule: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  return body.endsWith(" *") ? command.startsWith(body.slice(0, -1)) : command === body;
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
// record, with `echo` of plain words and `git -C <this project> rev-parse HEAD` beside it, each part
// alone a read, every path absolute. Any other shape, an echo alone included, keeps the host's prompt.
function ownRecordRead(command: string, projectDir: string): boolean {
  const parts = shellListParts(command);
  if (parts === null || !parts.some((part) => /^\s*cat\s/.test(part))) return false;
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
  // The shape first, so the settings are read only for a command that could get the answer.
  const words = parseLiteralShellInvocation(command);
  if (words?.rawWords[0] === "bun") {
    const relative = relativeToolCommand(words, projectDir, harness);
    if (relative === null) return false;
    return claudeOwnCommandRules(projectDir, harness, false)?.allow.some((rule) =>
      rule.startsWith(`Bash(bun ${harness}/tools/`) && ruleAllows(rule, relative)) === true;
  }
  return ownRecordRead(command, projectDir) && claudeOwnCommandRules(projectDir, harness, true) !== null;
}

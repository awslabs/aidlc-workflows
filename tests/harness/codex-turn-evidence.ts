import * as fs from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../../scripts/ci-sanitize-logs.ts";
import type { CodexFailureExecution } from "./codex-test-lifecycle.ts";

/** Completed root messages from Codex exec's JSONL stream. */
export interface CodexTurn {
  rc: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
  agentMessages: string[];
}

export function turnEvidence(stdout: string): Pick<CodexTurn, "sessionId" | "agentMessages"> {
  const sessions = new Set<string>();
  const agentMessages: string[] = [];
  let completed = false;
  let failed = false;
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    const event = JSON.parse(line);
    if (event?.type === "thread.started") {
      if (typeof event.thread_id !== "string" || !/^[0-9a-f-]{36}$/i.test(event.thread_id)) {
        throw new Error("Codex JSON evidence has an invalid session id");
      }
      sessions.add(event.thread_id);
    } else if (event?.type === "turn.started") {
      completed = false;
      agentMessages.length = 0;
    } else if (event?.type === "item.completed" && event.item?.type === "agent_message") {
      if (typeof event.item.text !== "string") throw new Error("Codex JSON evidence has an invalid agent message");
      agentMessages.push(event.item.text);
    } else if (event?.type === "turn.completed") {
      completed = true;
    } else if (event?.type === "turn.failed") {
      failed = true;
    }
  }
  if (sessions.size !== 1) throw new Error("Codex JSON evidence must identify exactly one session");
  if (!completed || failed) throw new Error("Codex JSON evidence must contain a successful completed turn");
  return { sessionId: [...sessions][0], agentMessages };
}

export function gateText(turn: Pick<CodexTurn, "agentMessages">): string {
  // Both predicates must occur in one user-visible root message. Tool outputs,
  // reasoning and collab results cannot establish that the conductor asked.
  return turn.agentMessages.findLast((text) => /approv|choose/i.test(text) && /reject/i.test(text)) ??
    turn.agentMessages.at(-1) ?? "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_BYTES = 256 * 1024;
const ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2_048;
const MAX_RECORDS = 128;
const samePath = (a: string, b: string): boolean => process.platform === "win32"
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const owned = (stat: fs.BigIntStats): boolean => !process.getuid || stat.uid === BigInt(process.getuid());
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

function pinPlainDirectory(path: string): () => void {
  const before = fs.lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !owned(before) ||
    !samePath(fs.realpathSync(path), path)) throw new Error("directory ownership unavailable");
  return () => {
    const after = fs.lstatSync(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !owned(after) ||
      !sameFile(before, after) || !samePath(fs.realpathSync(path), path)) {
      throw new Error("directory identity changed");
    }
  };
}

/** Pin every component, including directories below the already-owned root. */
function pinDescendant(root: string, path: string): () => void {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).some(part => part === "..")) {
    throw new Error("path outside owned root");
  }
  const checks = [pinPlainDirectory(root)];
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    checks.push(pinPlainDirectory(current));
  }
  return () => { for (const check of checks) check(); };
}

function readOwnedText(root: string, path: string, maximum: number): string {
  const checkParents = pinDescendant(root, path);
  const before = fs.lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !owned(before) ||
    before.size > BigInt(maximum)) throw new Error("file ownership or size limit");
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
  try {
    checkParents();
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !owned(opened) ||
      !sameFile(before, opened) || opened.size !== before.size) throw new Error("file identity changed");
    // Read at most the stat-bound size, even if a still-running writer appends.
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("file changed during read");
      offset += count;
    }
    checkParents();
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
      !sameFile(before, fs.lstatSync(path, { bigint: true }))) throw new Error("file changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}

function directoryEntries(root: string, path: string, limit: number): string[] {
  const checkParents = pinDescendant(root, join(path, "entry"));
  checkParents();
  const directory = fs.opendirSync(path);
  const names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (names.length >= limit) throw new Error("directory entry limit");
      names.push(entry.name);
    }
    checkParents();
    return names.sort();
  } finally { directory.closeSync(); }
}

function rootRollout(home: string, id: string): string {
  const candidates: string[] = [];
  let remaining = MAX_ENTRIES;
  const visit = (path: string, depth: number) => {
    for (const name of directoryEntries(home, path, remaining)) {
      if (--remaining < 0) throw new Error("rollout search limit");
      const next = join(path, name);
      if (name.startsWith("rollout-") && name.toLowerCase().endsWith(`-${id}.jsonl`)) candidates.push(next);
      // Only the normal sessions/YYYY/MM/DD tree; never traverse other homes,
      // archived sessions, arbitrary directories or files of unrelated threads.
      else if (depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(name)) visit(next, depth + 1);
    }
  };
  visit(join(home, "sessions"), 0);
  if (candidates.length !== 1) throw new Error(candidates.length ? "ambiguous root rollout" : "root rollout missing");
  return candidates[0];
}

function cliCommand(command: unknown): command is string {
  return typeof command === "string" && command.length < 16_384 &&
    /(?:^|[\s"'])\.codex[/\\]tools[/\\]aidlc\.ts\s+engine\b/.test(command) &&
    !/[;&|`\r\n]|\$\(|auth\.json|\.sandbox-secrets|[/\\](?:credentials|\.aws)(?:[/\\\s]|$)/i.test(command);
}

function diagnosticIssue(error: unknown): string {
  const labels = new Set([
    "roots unavailable", "directory ownership unavailable", "directory identity changed", "path outside owned root",
    "file ownership or size limit", "file identity changed", "file changed during read", "directory entry limit",
    "rollout search limit", "ambiguous root rollout", "root rollout missing", "execution unavailable",
    "root identity missing", "command count limit", "rollout root identity mismatch", "duplicate tool call id",
    "unsupported tool output", "tool record count limit", "invalid active selection",
  ]);
  if (error instanceof Error && labels.has(error.message)) return error.message;
  if (error instanceof SyntaxError) return "malformed JSON";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code && ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(code) ? code : "read failed";
}

/** Diagnostic only: never feeds turn/command acceptance or retries an operation. */
export function createCodexWorkspaceFailureCapture(
  projectDir: string, codexHome: string, artifactDirectory?: string,
): (execution?: CodexFailureExecution) => void {
  const root = resolve(projectDir), home = resolve(codexHome);
  let checkRoots: (() => void) | undefined, checkArtifacts: (() => void) | undefined;
  try {
    if (!samePath(home, join(root, ".home"))) throw new Error("unexpected Codex home");
    const checks = [pinPlainDirectory(root), pinPlainDirectory(home)];
    checkRoots = () => { for (const check of checks) check(); };
  } catch { /* Failure capture reports unavailable roots without changing the test. */ }
  try { if (artifactDirectory) checkArtifacts = pinPlainDirectory(resolve(artifactDirectory)); }
  catch { /* The primary failure must survive an unavailable artifact directory. */ }

  return execution => {
    const issues: string[] = [];
    let remaining = CAPTURE_BYTES;
    const text = (raw: string) => {
      // Redact before JSON escaping as well as through the existing CI pass.
      const clean = redactSecrets(raw);
      const bytes = Buffer.byteLength(clean);
      const cost = Buffer.byteLength(JSON.stringify(clean));
      const kept = cost <= remaining ? clean : clean.slice(0, Math.floor(remaining / 6));
      remaining -= Math.min(remaining, Buffer.byteLength(JSON.stringify(kept)));
      return { text: kept, bytes, truncated: kept !== clean };
    };
    const capture: {
      schema: number; diagnosticOnly: true; threadId?: string; codexExit?: number;
      issues: string[]; commands: unknown[]; tools: unknown[]; files: unknown[];
    } = { schema: 1, diagnosticOnly: true, issues, commands: [], tools: [], files: [] };
    const attempt = (label: string, fn: () => void) => {
      try { checkRoots?.(); if (!checkRoots) throw new Error("roots unavailable"); fn(); checkRoots(); }
      catch (error) { issues.push(`${label}: ${diagnosticIssue(error)}`); }
    };
    attempt("root rollout", () => {
      if (!execution || !samePath(execution.cwd, root) || !execution.stdout ||
        Buffer.byteLength(execution.stdout) > ROLLOUT_BYTES) throw new Error("execution unavailable");
      capture.codexExit = execution.rc;
      const events = execution.stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      const ids = events.filter(event => event?.type === "thread.started").map(event => event.thread_id);
      if (ids.length !== 1 || typeof ids[0] !== "string" || !UUID.test(ids[0])) throw new Error("root identity missing");
      const id = ids[0].toLowerCase();
      capture.threadId = id;
      for (const event of events) {
        const item = event?.item;
        if (event.type === "item.completed" && item?.type === "command_execution" && cliCommand(item.command)) {
          if (capture.commands.length >= MAX_RECORDS) throw new Error("command count limit");
          capture.commands.push({ id: typeof item.id === "string" ? item.id.slice(0, 200) : null,
            command: text(item.command),
            status: ["completed", "failed", "in_progress"].includes(item.status) ? item.status : null,
            exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
            output: text(typeof item.aggregated_output === "string" ? item.aggregated_output : "") });
        }
      }
      const path = rootRollout(home, id);
      const rows = readOwnedText(home, path, ROLLOUT_BYTES).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      const metadata = rows.filter(row => row?.type === "session_meta");
      if (metadata.length !== 1 || typeof metadata[0].payload?.id !== "string" || metadata[0].payload.id.toLowerCase() !== id ||
        typeof metadata[0].payload?.cwd !== "string" || !samePath(metadata[0].payload.cwd, root) ||
        (metadata[0].payload.source && typeof metadata[0].payload.source !== "string")) {
        throw new Error("rollout root identity mismatch");
      }
      const calls = new Map<string, string>(), sessions = new Set<string>();
      const selected: unknown[] = [];
      for (const row of rows) {
        if (row?.type !== "response_item") continue;
        const item = row.payload;
        if (!item || typeof item.call_id !== "string" || !/^[\w:.-]{1,200}$/.test(item.call_id)) continue;
        const call = item.type === "function_call" || item.type === "custom_tool_call";
        if (call) {
          const name = typeof item.name === "string" ? item.name.split(".").at(-1) : "";
          if (!["exec_command", "shell_command", "shell", "write_stdin"].includes(name ?? "")) continue;
          const input = item.arguments ?? item.input;
          const args = item.type === "custom_tool_call" && cliCommand(input) ? { cmd: input } : JSON.parse(input);
          const command = args.cmd ?? (Array.isArray(args.command) ? args.command.join(" ") : args.command);
          const poll = name === "write_stdin" && (args.chars === undefined || args.chars === "") &&
            sessions.has(String(args.session_id));
          if (!cliCommand(command) && !poll) continue;
          if (calls.has(item.call_id)) throw new Error("duplicate tool call id");
          calls.set(item.call_id, item.type);
          selected.push({ type: item.type, callId: item.call_id, name,
            ...(poll ? { sessionId: String(args.session_id) } : { command: text(command) }) });
        } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
          if (!calls.has(item.call_id)) continue;
          if (item.type !== `${calls.get(item.call_id)}_output` || typeof item.output !== "string") {
            throw new Error("unsupported tool output");
          }
          const session = /Process running with session ID (\d+)/.exec(item.output)?.[1];
          if (session) sessions.add(session);
          const exit = /Process exited with code (-?\d+)/.exec(item.output)?.[1];
          selected.push({ type: item.type, callId: item.call_id, output: text(item.output),
            exitCode: exit === undefined ? null : Number(exit) });
        }
        if (selected.length > MAX_RECORDS) throw new Error("tool record count limit");
      }
      if (!selected.length) issues.push("root rollout: no supported CLI tool records");
      capture.tools = selected;
    });
    attempt("active state/audit", () => {
      const segment = (path: string) => {
        const value = readOwnedText(root, path, 256).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
          throw new Error("invalid active selection");
        }
        return value;
      };
      const space = segment(join(root, "aidlc", "active-space"));
      const intents = join(root, "aidlc", "spaces", space, "intents");
      const intent = segment(join(intents, "active-intent"));
      const record = join(intents, intent);
      const state = join(record, "aidlc-state.md");
      capture.files.push({ path: relative(root, state), ...text(readOwnedText(root, state, CAPTURE_BYTES)) });
      const audit = join(record, "audit");
      const names = directoryEntries(root, audit, 64).filter(name => /^[A-Za-z0-9._-]+\.md$/.test(name));
      if (!names.length) issues.push("active audit: no markdown shards");
      for (const name of names) {
        const path = join(audit, name);
        capture.files.push({ path: relative(root, path), ...text(readOwnedText(root, path, CAPTURE_BYTES)) });
      }
    });
    if (remaining <= 0 || [...capture.commands, ...capture.tools, ...capture.files].some(
      record => JSON.stringify(record).includes('"truncated":true'))) issues.push("capture text size limit: some text omitted");
    try {
      if (!artifactDirectory || !checkArtifacts) throw new Error("artifact directory unavailable");
      checkArtifacts();
      const output = `${JSON.stringify(capture, null, 2)}\n`;
      if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("capture size limit");
      const path = join(resolve(artifactDirectory), "codex-workspace-failure.json");
      fs.writeFileSync(path, output, { flag: "wx", mode: 0o600 });
      checkArtifacts();
      console.error(`[codex workspace diagnostic] retained; ${issues.length} missing/limited sections`);
    } catch {
      console.error("[codex workspace diagnostic] unavailable; original failure preserved");
    }
  };
}

import fs from "node:fs";
import { basename, join, parse, relative, resolve, sep } from "node:path";

const REDACTED = "[REDACTED]";
const SECRET_VALUE = String.raw`(?:\[REDACTED\]|"(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?|[^\s"',;}\]]+)`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(["']?\b(?:aws_(?:secret_access_key|session_token|access_key_id)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|KIRO_API_KEY|CURSOR_API_KEY|AIDLC_BROKER_TOKEN|accessKeyId|secretAccessKey|sessionToken|X-AIDLC-Broker-Token)\b["']?[ \t]*[:=][ \t]*)(${SECRET_VALUE})`,
  "gi",
);
const BEARER_TOKEN = new RegExp(String.raw`(\bBearer[ \t]+)(${SECRET_VALUE})`, "gi");

function redactValue(_match: string, prefix: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  const closing = quote && value.length > 1 && value.endsWith(quote) ? quote : "";
  return `${prefix}${quote}${REDACTED}${closing}`;
}

export function redactSecrets(text: string, brokerIdentity = process.env.AIDLC_BROKER_IDENTITY): string {
  let sanitized = text
    .replace(SECRET_ASSIGNMENT, redactValue)
    .replace(BEARER_TOKEN, redactValue)
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, REDACTED)
    .replace(/ksk_[A-Za-z0-9_-]+/g, REDACTED);
  // Actions masks its console, but uploaded log files need the same treatment.
  // Redact this run's identity without hiding unrelated numeric test fixtures.
  if (brokerIdentity) {
    try {
      const identity = JSON.parse(brokerIdentity) as { account?: unknown; arn?: unknown };
      if (typeof identity.account === "string" && /^\d{12}$/.test(identity.account) &&
        typeof identity.arn === "string" && identity.arn.startsWith(`arn:aws:sts::${identity.account}:assumed-role/`)) {
        sanitized = sanitized.replaceAll(identity.arn, REDACTED).replaceAll(identity.account, REDACTED);
      }
    } catch { /* No verified broker identity was exported. */ }
  }
  return sanitized;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function statIfPresent(path: string): fs.Stats | undefined {
  try { return fs.lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reject linked ancestors too: lstat on only the final directory is not enough. */
function safeRoot(root: string): boolean {
  let current = parse(root).root;
  if (current === root) throw new Error("A filesystem root is not a log directory");
  for (const part of root.slice(current.length).split(sep)) {
    current = join(current, part);
    const stat = statIfPresent(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      if (current !== root) throw new Error("Log directory has a linked ancestor");
      fs.unlinkSync(current);
      return false;
    }
    if (!stat.isDirectory()) throw new Error("Log directory is not a directory");
  }
  return true;
}

function checkFile(fd: number, expected: fs.Stats): void {
  const actual = fs.fstatSync(fd);
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("Log file changed during sanitization");
  }
}

function sanitizeFile(path: string, stat: fs.Stats): string | undefined {
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  let bytes: Buffer;
  const reader = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
  try {
    checkFile(reader, stat);
    bytes = fs.readFileSync(reader);
  } finally { fs.closeSync(reader); }

  // Unknown encodings and binary payloads cannot be proven redacted: drop them.
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { fs.unlinkSync(path); return "invalid-utf8"; }
  if (text.includes("\0")) { fs.unlinkSync(path); return "nul-byte"; }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // Keep ordinary whitespace, terminal bell/backspace, and ANSI escape codes.
    if (code < 7 || (code > 13 && code < 27) || (code > 27 && code < 32)) {
      fs.unlinkSync(path);
      return "non-text-control-byte";
    }
  }
  const sanitized = redactSecrets(text);
  if (sanitized === text) return;
  const output = Buffer.from(sanitized, "utf8");

  // Update the existing inode without truncating until its identity is checked;
  // file permissions remain unchanged and clean text files are never written.
  const writer = fs.openSync(path, fs.constants.O_WRONLY | noFollow);
  try {
    checkFile(writer, stat);
    fs.writeFileSync(writer, output);
    fs.ftruncateSync(writer, output.length);
  } finally { fs.closeSync(writer); }
}

export async function sanitizeLogs(
  directory: string,
  { keepTraces = false }: { keepTraces?: boolean } = {},
): Promise<void> {
  const root = resolve(directory);
  if (!safeRoot(root)) return;
  // Codex stores sandbox-account credentials here. A caller selecting a nested
  // log root must not turn this secret subtree into ordinary text to inspect.
  if (root.split(sep).some((part) => part.toLowerCase() === ".sandbox-secrets")) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const withinArtifacts = root.split(sep).some((part) => part.toLowerCase() === "e2e-artifacts");
  const removed: Array<{ path: string; reason: string }> = [];
  const report = join(root, "sanitizer-report.json");
  const oldReport = statIfPresent(report);
  if (oldReport) {
    if (!oldReport.isFile() && !oldReport.isSymbolicLink()) throw new Error("Invalid sanitizer report entry");
    fs.unlinkSync(report);
  }

  function walk(path: string, inArtifacts: boolean, prune: boolean): void {
    const stat = statIfPresent(path);
    if (!stat) return;
    // lstat reports both symlinks and Windows junctions; unlink removes the
    // upload entry itself, never the external target (even with keepTraces).
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(path);
      removed.push({ path: redactSecrets(relative(root, path).split(sep).join("/")), reason: "link" });
      return;
    }
    const name = basename(path).toLowerCase();
    if (name === ".sandbox-secrets") {
      // Unconditional, including keepTraces: remove without reading contents or
      // publishing private descendant names in the sanitizer report.
      fs.rmSync(path, { recursive: true, force: true });
      removed.push({ path: redactSecrets(relative(root, path).split(sep).join("/")), reason: "sandbox-secrets" });
      return;
    }
    if (prune && !keepTraces && (
      name.endsWith(".ndjson") || name.startsWith("sdk-drive") || name.startsWith("tui-drive") ||
      (stat.isDirectory() && inArtifacts && name === "traces")
    )) {
      fs.rmSync(path, { recursive: true, force: true });
      removed.push({ path: redactSecrets(relative(root, path).split(sep).join("/")), reason: "driver-trace" });
      return;
    }
    if (stat.isDirectory()) {
      const artifacts = inArtifacts || name === "e2e-artifacts";
      for (const entry of fs.readdirSync(path)) walk(join(path, entry), artifacts, prune);
    } else if (stat.isFile()) {
      if (!prune) {
        const reason = sanitizeFile(path, stat);
        if (reason) removed.push({ path: redactSecrets(relative(root, path).split(sep).join("/")), reason });
      }
    } else {
      throw new Error("Log tree contains a non-regular file");
    }
  }

  // Finish deleting all driver traces before reading any remaining log content.
  walk(root, withinArtifacts, true);
  walk(root, withinArtifacts, false);
  fs.writeFileSync(report, `${JSON.stringify({ removed }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (import.meta.main) {
  if (process.argv.length !== 3 || !process.argv[2]) {
    console.error("Usage: bun scripts/ci-sanitize-logs.ts <directory>");
    process.exitCode = 1;
  } else {
    try {
      await sanitizeLogs(process.argv[2], { keepTraces: process.env.AIDLC_NIGHTLY_UPLOAD_TRACES === "1" });
    } catch {
      // Filesystem errors can embed user-controlled paths. Do not echo paths,
      // file contents, credentials, or the original error into the CI log.
      console.error("Log sanitization failed; refusing artifact upload.");
      process.exitCode = 1;
    }
  }
}

import fs from "node:fs";
import { basename, join, parse, resolve, sep } from "node:path";

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

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, redactValue)
    .replace(BEARER_TOKEN, redactValue)
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, REDACTED)
    .replace(/ksk_[A-Za-z0-9_-]+/g, REDACTED);
}

const decoders = {
  utf8: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
  utf16le: new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }),
  utf16be: new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }),
};

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

function sanitizeFile(path: string, stat: fs.Stats): void {
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  let bytes: Buffer;
  const reader = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
  try {
    checkFile(reader, stat);
    bytes = fs.readFileSync(reader);
  } finally { fs.closeSync(reader); }

  // BOM-marked UTF-16 covers Windows transcript output. Invalid UTF-8 and
  // binary control data must survive byte-for-byte, not a lossy decode.
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf16be" : "utf8";
  let text: string;
  try { text = decoders[encoding].decode(bytes); }
  catch { return; }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // Keep ordinary whitespace, terminal bell/backspace, and ANSI escape codes.
    if (code < 7 || (code > 13 && code < 27) || (code > 27 && code < 32)) return;
  }
  const sanitized = redactSecrets(text);
  if (sanitized === text) return;
  const output = Buffer.from(sanitized, encoding === "utf16be" ? "utf16le" : encoding);
  if (encoding === "utf16be") output.swap16();

  // Update the existing inode without truncating until its identity is checked;
  // file permissions remain unchanged and binary/clean files are never written.
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
  const withinArtifacts = root.split(sep).some((part) => part.toLowerCase() === "e2e-artifacts");

  function walk(path: string, inArtifacts: boolean, prune: boolean): void {
    const stat = statIfPresent(path);
    if (!stat) return;
    // lstat reports both symlinks and Windows junctions; unlink removes the
    // upload entry itself, never the external target (even with keepTraces).
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(path);
      return;
    }
    const name = basename(path).toLowerCase();
    if (prune && !keepTraces && (
      name.endsWith(".ndjson") || name.startsWith("sdk-drive") || name.startsWith("tui-drive") ||
      (stat.isDirectory() && inArtifacts && name === "traces")
    )) {
      fs.rmSync(path, { recursive: true, force: true });
      return;
    }
    if (stat.isDirectory()) {
      const artifacts = inArtifacts || name === "e2e-artifacts";
      for (const entry of fs.readdirSync(path)) walk(join(path, entry), artifacts, prune);
    } else if (stat.isFile()) {
      if (!prune) sanitizeFile(path, stat);
    } else {
      throw new Error("Log tree contains a non-regular file");
    }
  }

  // Finish deleting all driver traces before reading any remaining log content.
  walk(root, withinArtifacts, true);
  walk(root, withinArtifacts, false);
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

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const MAX_EVIDENCE_BYTES = 2_000_000;
const MAX_TEXT_FILE_BYTES = 400_000;
const TRUSTED_CONTRACTS = ["AGENTS.md", "CONTRIBUTING.md", "README.md"];

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function git(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function trackedBlob(base: string, path: string, cwd: string): Buffer | null {
  try {
    if (git(["cat-file", "-t", `${base}:${path}`], cwd).toString("utf8").trim() !== "blob") {
      return null;
    }
    return git(["show", `${base}:${path}`], cwd);
  } catch {
    return null;
  }
}

function trackedRegularBlob(base: string, path: string, cwd: string): Buffer | null {
  try {
    const listing = git(["ls-tree", "-z", base, "--", path], cwd);
    const separator = listing.indexOf(9);
    if (separator < 0) return null;
    const metadata = listing.subarray(0, separator).toString("utf8").split(" ");
    const listedPath = listing.subarray(separator + 1, -1).toString("utf8");
    if (!metadata[0]?.startsWith("100") || metadata[1] !== "blob" || listedPath !== path) {
      return null;
    }
    return git(["show", `${base}:${path}`], cwd);
  } catch {
    return null;
  }
}

function textContent(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

class EvidenceWriter {
  private readonly parts: string[] = [
    "AIDA immutable judge evidence bundle\n",
    `Maximum evidence bytes: ${MAX_EVIDENCE_BYTES}\n`,
    `Maximum text file bytes: ${MAX_TEXT_FILE_BYTES}\n`,
    "Binary files are represented by byte length and SHA-256 digest; raw binary bytes are omitted.\n",
  ];
  private bytes = Buffer.byteLength(this.parts.join(""));

  add(label: string, content: Buffer | string): void {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    const text = textContent(buffer);
    const body = text === null
      ? JSON.stringify({
        binary: true,
        bytes: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      })
      : text;
    if (text !== null && buffer.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `${label} is ${buffer.byteLength} bytes; text evidence limit is ${MAX_TEXT_FILE_BYTES}`,
      );
    }
    const section = `\n===== ${label} =====\n${body}\n`;
    const sectionBytes = Buffer.byteLength(section);
    if (this.bytes + sectionBytes > MAX_EVIDENCE_BYTES) {
      throw new Error(
        `judge evidence exceeds ${MAX_EVIDENCE_BYTES} bytes while adding ${label}`,
      );
    }
    this.parts.push(section);
    this.bytes += sectionBytes;
  }

  finish(): string {
    return this.parts.join("");
  }
}

function candidateRepositoryPaths(reportsDir: string): string[] {
  const paths = new Set<string>();
  for (const file of readdirSync(reportsDir).filter(file => file.endsWith(".md")).sort()) {
    const report = readFileSync(join(reportsDir, file), "utf8");
    for (const match of report.matchAll(/`([^`\r\n]+)`/g)) {
      const candidate = match[1].trim().replace(/:(?:\d+)(?:-\d+)?$/, "");
      if (
        candidate.length > 0 &&
        candidate.length <= 500 &&
        !candidate.startsWith("/") &&
        !candidate.split("/").includes("..") &&
        /^[A-Za-z0-9._/+-]+$/.test(candidate)
      ) {
        paths.add(candidate);
      }
    }
  }
  return [...paths].sort();
}

function addTrustedFiles(
  writer: EvidenceWriter,
  base: string,
  reportsDir: string,
  changedPaths: Set<string>,
  cwd: string,
): void {
  const candidates = new Set([...TRUSTED_CONTRACTS, ...candidateRepositoryPaths(reportsDir)]);
  for (const path of [...candidates].sort()) {
    if (changedPaths.has(path) || path.startsWith(".ai-")) continue;
    const content = trackedRegularBlob(base, path, cwd);
    if (content) writer.add(`trusted base file ${base}:${path}`, content);
  }
}

function buildPrEvidence(args: string[], cwd: string): string {
  const context = resolve(argValue(args, "--context"));
  const reports = resolve(argValue(args, "--reports"));
  const base = argValue(args, "--base");
  const head = argValue(args, "--head");
  const manifest = JSON.parse(
    readFileSync(join(context, "changed-files.json"), "utf8"),
  ) as {
    files: Array<{ path: string; previousPath?: string; snapshot?: string }>;
  };
  const writer = new EvidenceWriter();
  for (const file of [
    "pr.json",
    "discussion.json",
    "current-ai-reviews.json",
    "changed-files.json",
    "pr.diff",
  ]) {
    writer.add(`PR context ${file}`, readFileSync(join(context, file)));
  }
  const changedPaths = new Set<string>();
  for (const file of manifest.files) {
    changedPaths.add(file.path);
    if (file.previousPath) changedPaths.add(file.previousPath);
    const basePath = file.previousPath ?? file.path;
    const baseContent = trackedBlob(base, basePath, cwd);
    if (baseContent) writer.add(`changed base file ${base}:${basePath}`, baseContent);
    if (file.snapshot) {
      writer.add(
        `changed head file ${head}:${file.path}`,
        readFileSync(join(context, file.snapshot)),
      );
    }
  }
  addTrustedFiles(writer, base, reports, changedPaths, cwd);
  return writer.finish();
}

function buildIssueEvidence(args: string[], cwd: string): string {
  const context = resolve(argValue(args, "--context"));
  const reports = resolve(argValue(args, "--reports"));
  const base = argValue(args, "--base");
  const writer = new EvidenceWriter();
  for (const file of [
    "issue.json",
    "authorization.json",
    "issue-catalog.json",
    "conversation.json",
    "current-aida-review.json",
    "bug-verification.json",
  ]) {
    const path = join(context, file);
    if (existsSync(path) && statSync(path).isFile()) {
      writer.add(`Issue context ${file}`, readFileSync(path));
    }
  }
  addTrustedFiles(writer, base, reports, new Set(), cwd);
  return writer.finish();
}

function main(): void {
  const [mode, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  const output = argValue(args, "--output");
  const evidence = mode === "pr"
    ? buildPrEvidence(args, cwd)
    : mode === "issue"
    ? buildIssueEvidence(args, cwd)
    : (() => {
      throw new Error("mode must be pr or issue");
    })();
  writeFileSync(output, evidence);
  process.stdout.write(
    `Built ${basename(output)} (${Buffer.byteLength(evidence)} bytes, limit ${MAX_EVIDENCE_BYTES})\n`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    process.stderr.write(`::error::AI judge evidence ${escaped}\n`);
    process.exit(1);
  }
}

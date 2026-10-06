// Which sources each dist/<harness> tree was packaged from. `bun
// scripts/package.ts` records a content fingerprint of its inputs after a
// build; a tool that reads dist/ compares it with the working tree, so it never
// reports on code that has since changed.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Written by `bun scripts/package.ts` after each build, beside the harness trees. */
export const PACKAGE_SOURCES_FILE = join("dist", ".package-sources.json");

// Everything the packager reads: the authored trees, the plugin hook template
// it ships, and its own modules. Plugin tests are never packaged, so editing
// one leaves dist/ current.
const INPUT_DIRS = ["core", "harness", "plugins", "scripts/plugin-hooks-template"];
const INPUT_FILES = [
  "scripts/package.ts",
  "scripts/manifest-types.ts",
  "scripts/agent-knowledge.ts",
  "scripts/harness-bindings.ts",
  "scripts/onboarding.ts",
];

function inputFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(repoRoot, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !/^plugins\/[^/]+\/tests$/.test(rel)) walk(path);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  for (const dir of INPUT_DIRS) if (existsSync(join(repoRoot, dir))) walk(join(repoRoot, dir));
  for (const file of INPUT_FILES) if (existsSync(join(repoRoot, file))) files.push(file);
  return files.sort();
}

/** A SHA-256 over every input's path and bytes; about 20 ms for this repository. */
export function packageInputsFingerprint(repoRoot: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of inputFiles(repoRoot)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(repoRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readRecord(repoRoot: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, PACKAGE_SOURCES_FILE), "utf8"));
    const harnesses = (parsed as { harnesses?: unknown })?.harnesses;
    if (harnesses && typeof harnesses === "object" && !Array.isArray(harnesses)) {
      return Object.fromEntries(Object.entries(harnesses).filter(([, value]) => typeof value === "string"));
    }
  } catch {
    // Missing or unreadable: no harness has a record.
  }
  return {};
}

function writeRecord(repoRoot: string, record: Record<string, string>): void {
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(repoRoot, PACKAGE_SOURCES_FILE), `${JSON.stringify({ schemaVersion: 1, harnesses: sorted }, null, 2)}\n`);
}

/** Before a build: these trees are about to change, so a build that stops halfway is never taken as current. */
export function forgetPackagedSources(repoRoot: string, harnesses: string[]): void {
  if (!existsSync(join(repoRoot, PACKAGE_SOURCES_FILE))) return;
  const record = readRecord(repoRoot);
  for (const harness of harnesses) delete record[harness];
  writeRecord(repoRoot, record);
}

/**
 * After a build from `builtFrom` (the fingerprint taken before it started):
 * these harness trees hold those sources; other harnesses keep their entries.
 * If an input changed while the build ran, the trees may hold a mix, so they
 * stay unrecorded and this returns false.
 */
export function recordPackagedSources(repoRoot: string, harnesses: string[], builtFrom: string): boolean {
  if (packageInputsFingerprint(repoRoot) !== builtFrom) return false;
  const record = readRecord(repoRoot);
  for (const harness of harnesses) record[harness] = builtFrom;
  writeRecord(repoRoot, record);
  return true;
}

/** Null when dist/<harness> was packaged from the working tree's sources; otherwise the one line to show. */
export function stalePackageMessage(repoRoot: string, harness: string): string | null {
  const recorded = readRecord(repoRoot)[harness];
  if (recorded === packageInputsFingerprint(repoRoot)) return null;
  return recorded === undefined
    ? `dist/${harness} has no record of the sources it was packaged from: run \`bun scripts/package.ts\` first.`
    : `dist/${harness} was packaged from other sources than this checkout: run \`bun scripts/package.ts\` first.`;
}

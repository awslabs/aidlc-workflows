import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanNamespaceInvocations,
} from "../../core/tools/aidlc-command.ts";
import { ROUTES } from "../../core/tools/aidlc.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTHORED_ROOTS = [
  "core/aidlc-common/stages",
  "core/aidlc-common/protocols",
  "core/agents",
  "core/templates",
  "core/sensors",
  "core/hooks",
  "core/skills",
  "harness",
  "plugins",
  "scripts/plugin-hooks-template",
] as const;
const SOURCE_FILE = /\.(?:md|ts|json|hook)$/;

function authoredFiles(): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (lstatSync(child).isDirectory()) visit(child);
      else if (SOURCE_FILE.test(child)) files.push(child);
    }
  };
  for (const root of AUTHORED_ROOTS) visit(join(REPO_ROOT, root));
  return files.sort();
}

describe("authored namespace invocations", () => {
  test("every authored engine/system invocation resolves through the dispatcher", () => {
    const invocations = authoredFiles().flatMap((file) =>
      scanNamespaceInvocations(
        relative(REPO_ROOT, file),
        readFileSync(file, "utf-8"),
        ROUTES,
      )
    );
    expect(invocations.length).toBeGreaterThan(0);
    expect(
      invocations
        .filter((invocation) => !invocation.resolves)
        .map((invocation) =>
          `${invocation.file}:${invocation.line} ${invocation.command}`
        ),
    ).toEqual([]);
  });
});

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

// A tool's own "Valid: …" refusal is the contract it advertises to users. The
// dispatcher's noun-passthrough allowlist is what a compiled install will
// actually route. When the two disagree, the engine can call a verb its own
// dispatcher refuses — and no test catches it, because under bun the engine
// reaches the tool file directly and never crosses the dispatcher (#1286).
describe("noun-passthrough allowlists cover the verbs their tool advertises", () => {
  test("aidlc-state.ts advertises no verb the state route will not carry", () => {
    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-state.ts"),
      "utf-8",
    );
    const advertised = source.match(/Unknown subcommand: \$\{subcommand\}\. Valid: ([^`]+)`/);
    expect(advertised, "aidlc-state.ts still prints a `Valid:` verb list").not.toBeNull();
    const verbs = (advertised?.[1] ?? "")
      .split(",")
      .map((verb) => verb.trim())
      .filter((verb) => verb.length > 0);
    expect(verbs.length).toBeGreaterThan(20);

    const route = ROUTES.find((candidate) => candidate.id === "state-passthrough");
    expect(route, "the state-passthrough route still exists").toBeDefined();
    const routed = new Set(route?.verbs ?? []);
    expect(
      verbs.filter((verb) => !routed.has(verb)),
      "verbs aidlc-state.ts accepts that the dispatcher refuses",
    ).toEqual([]);
  });
});

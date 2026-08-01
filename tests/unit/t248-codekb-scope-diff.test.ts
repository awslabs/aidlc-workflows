// covers: function:parseReScope, function:codekbScopeFingerprint, function:scopePathCovered, subcommand:aidlc-utility:codekb-scope-diff
//
// t248 — codekb scope guard (deterministic, no-LLM). Pins the reverse-
// engineering rerun guard at two layers:
//
//   1. The PURE lib helpers (imported in-process from the shipped dist tree):
//      parseReScope (the fenced-yaml Scope of Analysis block in
//      reverse-engineering-timestamp.md), codekbScopeFingerprint (temp-index
//      `git write-tree` over the analyzed paths — content-addressed, so an
//      edit flips it and a revert restores it), and scopePathCovered (the
//      compare mode's literal/dir-prefix coverage test).
//   2. The `codekb-scope-diff` UTILITY VERB (spawned as the real CLI surface):
//      status verdicts NO_STORE / CURRENT / STALE / UNVERIFIED / UNKNOWN_SCOPE,
//      compare verdicts COVERS / NARROWER (+ the exact discard list), and the
//      --mint fingerprint printer the stage's Step 3 pastes from — each with
//      --json shape.
//
// MECHANISM = cli (the subcommand claim needs a SPAWNED tool to prove routing;
// the function claims clear `none` via the in-process imports).
//
// FIXTURE DISCIPLINE mirrors t182: a fresh temp project per case
// (createTestProject), cleaned in afterAll. The fingerprint cases additionally
// `git init` the temp project — codekbScopeFingerprint returns null outside a
// work tree, which is itself a pinned case (UNVERIFIED, never a false verdict).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  resetAidlcEnv,
} from "../harness/fixtures.ts";
import {
  codekbScopeFingerprint,
  parseReScope,
  scopePathCovered,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function freshProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  return proj;
}

function gitInit(dir: string): void {
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf-8" });
  expect(r.status).toBe(0);
}

const childEnv = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  return e;
};

// A valid scope block body (the shape re-artifacts.md templates and the
// architect writes at Step 3), parameterised for the cases below.
function timestampBody(opts: {
  kind?: string;
  intent?: string;
  fingerprint?: string;
  analyzedPaths?: string[];
  components?: string[];
  version?: string;
}): string {
  const paths = (opts.analyzedPaths ?? ["src/payments/"]).map((p) => `    - ${p}`).join("\n");
  const comps = (opts.components ?? ["payment-gateway"]).map((c) => `    - ${c}`).join("\n");
  return [
    "# Reverse Engineering Timestamp",
    "",
    "## Run Record",
    "",
    "- Date: 2026-07-27",
    "",
    "## Scope of Analysis",
    "",
    "```yaml",
    `scope_version: ${opts.version ?? "1"}`,
    `kind: ${opts.kind ?? "partial"}`,
    `intent: ${opts.intent ?? "fix-payment-timeout"}`,
    ...(opts.fingerprint !== undefined ? [`fingerprint: ${opts.fingerprint}`] : []),
    "analyzed:",
    "  paths:",
    paths,
    "  components:",
    comps,
    "shallow:",
    "  paths:",
    "    - src/",
    "```",
    "",
  ].join("\n");
}

// Write a store timestamp for the project's basename-keyed repo dir (0
// recorded repos → codekbRepoName === basename, matching t182's discipline).
function seedStore(proj: string, body: string): string {
  const repo = proj.split("/").pop() as string;
  const dir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", repo);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "reverse-engineering-timestamp.md");
  writeFileSync(p, body);
  return p;
}

function runVerb(proj: string, ...args: string[]) {
  return spawnSync(
    BUN,
    [UTILITY, "codekb-scope-diff", "--project-dir", proj, ...args],
    { encoding: "utf-8", env: childEnv() },
  );
}

// ============================================================================
// 1. parseReScope — the block parser.
// ============================================================================
describe("t248 parseReScope — scope block parsing", () => {
  test("valid partial block parses: kind/intent/fingerprint/paths/components", () => {
    const r = parseReScope(timestampBody({ fingerprint: "abc123" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.kind).toBe("partial");
    expect(r.scope.intent).toBe("fix-payment-timeout");
    expect(r.scope.fingerprint).toBe("abc123");
    expect(r.scope.analyzedPaths).toEqual(["src/payments/"]);
    expect(r.scope.analyzedComponents).toEqual(["payment-gateway"]);
    expect(r.scope.shallowPaths).toEqual(["src/"]);
  });

  test("no block → absent (the legacy-store case)", () => {
    const r = parseReScope("# Timestamp\n\n- Date: 2026-07-27\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("absent");
  });

  test("a non-scope yaml fence earlier in the body does not shadow the block", () => {
    const decoy = "```yaml\nunits:\n  - name: x\n```\n\n";
    const r = parseReScope(decoy + timestampBody({}));
    expect(r.ok).toBe(true);
  });

  test("unknown scope_version → malformed (future writers are not half-read)", () => {
    const r = parseReScope(timestampBody({ version: "2" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
  });

  test("kind: partial with no analyzed paths → malformed", () => {
    const body = timestampBody({}).replace(/^ {4}- src\/payments\/$/m, "");
    const r = parseReScope(body);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
  });

  test("kind: full without explicit repository-root coverage → malformed", () => {
    const r = parseReScope(timestampBody({ kind: "full", analyzedPaths: ["src/"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
    expect(r.detail).toContain("analyzed.paths must include ./");
  });

  test("kind: full with repository-root coverage parses", () => {
    const r = parseReScope(timestampBody({ kind: "full", analyzedPaths: ["./"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.kind).toBe("full");
    expect(r.scope.analyzedPaths).toEqual(["./"]);
  });

  test("kind: partial cannot claim repository-root coverage", () => {
    const r = parseReScope(timestampBody({ kind: "partial", analyzedPaths: ["./"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed");
    expect(r.detail).toContain("requires kind: full");
  });

  test("fingerprint: unknown parses as null (the non-git mint output)", () => {
    const r = parseReScope(timestampBody({ fingerprint: "unknown" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.fingerprint).toBeNull();
  });
});

// ============================================================================
// 2. codekbScopeFingerprint — content-addressed, revert-stable, null off-git.
// ============================================================================
describe("t248 codekbScopeFingerprint — scoped write-tree", () => {
  test("stable across calls; flips on edit; restores on revert", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    const f = join(proj, "src", "payments", "gw.ts");
    writeFileSync(f, "export const a = 1;\n");
    const fp1 = codekbScopeFingerprint(proj, ["src/payments/"]);
    expect(fp1).not.toBeNull();
    expect(codekbScopeFingerprint(proj, ["src/payments/"])).toBe(fp1);
    writeFileSync(f, "export const a = 2;\n");
    const fp2 = codekbScopeFingerprint(proj, ["src/payments/"]);
    expect(fp2).not.toBeNull();
    expect(fp2).not.toBe(fp1);
    writeFileSync(f, "export const a = 1;\n");
    expect(codekbScopeFingerprint(proj, ["src/payments/"])).toBe(fp1);
  });

  test("a change OUTSIDE the scoped paths does not move the fingerprint", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    mkdirSync(join(proj, "src", "auth"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "a\n");
    writeFileSync(join(proj, "src", "auth", "login.ts"), "b\n");
    const fp1 = codekbScopeFingerprint(proj, ["src/payments/"]);
    writeFileSync(join(proj, "src", "auth", "login.ts"), "b changed\n");
    expect(codekbScopeFingerprint(proj, ["src/payments/"])).toBe(fp1);
  });

  test("non-git directory → null (callers report UNVERIFIED, never a verdict)", () => {
    const proj = freshProject(); // createTestProject does NOT git init
    expect(codekbScopeFingerprint(proj, ["src/"])).toBeNull();
  });

  test("empty path list → null", () => {
    const proj = freshProject();
    gitInit(proj);
    expect(codekbScopeFingerprint(proj, [])).toBeNull();
  });

  test("invalid or mixed valid/invalid pathspecs → null, never the empty-tree hash", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "a.ts"), "a\n");
    expect(codekbScopeFingerprint(proj, ["missing/"])).toBeNull();
    expect(codekbScopeFingerprint(proj, ["src/", "missing/"])).toBeNull();
  });
});

// ============================================================================
// 3. scopePathCovered — the compare mode's coverage test.
// ============================================================================
describe("t248 scopePathCovered", () => {
  test("literal match and dir-prefix subsumption; no glob semantics", () => {
    expect(scopePathCovered(["src/payments/"], "src/payments/")).toBe(true);
    expect(scopePathCovered(["src/"], "src/payments/")).toBe(true);
    expect(scopePathCovered(["src/payments/"], "src/")).toBe(false);
    expect(scopePathCovered(["src/auth/"], "src/payments/")).toBe(false);
    // a FILE entry (no trailing slash) covers only itself
    expect(scopePathCovered(["src/a.ts"], "src/a.ts")).toBe(true);
    expect(scopePathCovered(["src/a.ts"], "src/a.ts.bak")).toBe(false);
  });
});

// ============================================================================
// 4. The `codekb-scope-diff` VERB — spawned CLI surface.
// ============================================================================
describe("t248 codekb-scope-diff verb — status mode", () => {
  test("no store timestamp → NO_STORE", () => {
    const proj = freshProject();
    const res = runVerb(proj, "--json");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("NO_STORE");
  });

  test("legacy store without a scope block → UNKNOWN_SCOPE (absent)", () => {
    const proj = freshProject();
    seedStore(proj, "# Timestamp\n\n- Date: 2026-07-27\n");
    const res = runVerb(proj, "--json");
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.verdict).toBe("UNKNOWN_SCOPE");
    expect(parsed.reason).toBe("absent");
  });

  test("matching fingerprint → CURRENT; edit inside scope → STALE", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "a\n");
    const fp = codekbScopeFingerprint(proj, ["src/payments/"]);
    expect(fp).not.toBeNull();
    seedStore(proj, timestampBody({ fingerprint: fp as string }));
    const current = runVerb(proj, "--json");
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout).verdict).toBe("CURRENT");
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "a changed\n");
    const stale = runVerb(proj, "--json");
    expect(stale.status).toBe(0);
    const parsed = JSON.parse(stale.stdout);
    expect(parsed.verdict).toBe("STALE");
    expect(parsed.store_intent).toBe("fix-payment-timeout");
  });

  test("full-root fingerprint excludes its own codekb store", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "a\n");

    const mint = runVerb(proj, "--mint", "--paths", "./");
    expect(mint.status).toBe(0);
    const fingerprint = mint.stdout.trim();
    expect(fingerprint).toMatch(/^[0-9a-f]{40,64}$/);
    seedStore(
      proj,
      timestampBody({
        kind: "full",
        fingerprint,
        analyzedPaths: ["./"],
      }),
    );

    const current = runVerb(proj, "--json");
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout).verdict).toBe("CURRENT");

    writeFileSync(join(proj, "src", "app.ts"), "changed\n");
    expect(JSON.parse(runVerb(proj, "--json").stdout).verdict).toBe("STALE");
  });

  test("full-root exclusion is relative to a nested project, not the parent git root", () => {
    const parent = freshProject();
    gitInit(parent);
    const proj = join(parent, "package");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "a\n");

    const mint = runVerb(proj, "--mint", "--paths", "./");
    expect(mint.status).toBe(0);
    const fingerprint = mint.stdout.trim();
    seedStore(
      proj,
      timestampBody({
        kind: "full",
        fingerprint,
        analyzedPaths: ["./"],
      }),
    );

    expect(JSON.parse(runVerb(proj, "--json").stdout).verdict).toBe("CURRENT");
  });

  test("scope block without a computable fingerprint (non-git) → UNVERIFIED", () => {
    const proj = freshProject(); // no git init
    seedStore(proj, timestampBody({ fingerprint: "abc123" }));
    const res = runVerb(proj, "--json");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("UNVERIFIED");
  });

  test("store with fingerprint: unknown → UNVERIFIED even in a git tree", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "a\n");
    seedStore(proj, timestampBody({ fingerprint: "unknown" }));
    const res = runVerb(proj, "--json");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("UNVERIFIED");
  });

  test("stored failed pathspec → UNVERIFIED, never false CURRENT on the empty tree", () => {
    const proj = freshProject();
    gitInit(proj);
    seedStore(
      proj,
      timestampBody({
        analyzedPaths: ["missing/"],
        fingerprint: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      }),
    );
    const parsed = JSON.parse(runVerb(proj, "--json").stdout);
    expect(parsed.verdict).toBe("UNVERIFIED");
    expect(parsed.detail).toBe("fingerprint not computable here");
  });
});

describe("t248 codekb-scope-diff verb — compare mode", () => {
  test("disjoint incoming scope → NARROWER with the exact discard list", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc" }));
    const incoming = join(proj, "incoming-ts.md");
    writeFileSync(
      incoming,
      timestampBody({
        intent: "restructure-auth",
        analyzedPaths: ["src/auth/"],
        components: ["auth-service"],
      }),
    );
    const res = runVerb(proj, "--compare", incoming, "--json");
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.verdict).toBe("NARROWER");
    expect(parsed.discarded_paths).toEqual(["src/payments/"]);
    expect(parsed.discarded_components).toEqual(["payment-gateway"]);
    expect(parsed.store_intent).toBe("fix-payment-timeout");
    expect(parsed.incoming_intent).toBe("restructure-auth");
  });

  test("valid incoming full root covers a partial store", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc" }));
    const incoming = join(proj, "incoming-full.md");
    writeFileSync(
      incoming,
      timestampBody({ kind: "full", intent: "rebuild", analyzedPaths: ["./"], components: [] }),
    );
    const res = runVerb(proj, "--compare", incoming, "--json");
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.verdict).toBe("COVERS");
    expect(parsed.discarded_paths).toEqual([]);
  });

  test("a partial incoming scan cannot replace a full store", () => {
    const proj = freshProject();
    seedStore(
      proj,
      timestampBody({
        kind: "full",
        fingerprint: "abc",
        analyzedPaths: ["./"],
        components: [],
      }),
    );
    const incoming = join(proj, "incoming-partial.md");
    writeFileSync(
      incoming,
      timestampBody({ analyzedPaths: ["src/"], components: [] }),
    );
    const parsed = JSON.parse(runVerb(proj, "--compare", incoming, "--json").stdout);
    expect(parsed.verdict).toBe("NARROWER");
    expect(parsed.discarded_paths).toEqual(["./"]);
  });

  test("incoming kind: full without ./ → UNKNOWN_SCOPE", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc" }));
    const incoming = join(proj, "incoming-invalid-full.md");
    writeFileSync(
      incoming,
      timestampBody({ kind: "full", analyzedPaths: ["src/"], components: [] }),
    );
    const parsed = JSON.parse(runVerb(proj, "--compare", incoming, "--json").stdout);
    expect(parsed.verdict).toBe("UNKNOWN_SCOPE");
    expect(parsed.detail).toContain("analyzed.paths must include ./");
  });

  test("incoming kind: partial with ./ → UNKNOWN_SCOPE, never universal coverage", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc", components: [] }));
    const incoming = join(proj, "incoming-invalid-partial.md");
    writeFileSync(
      incoming,
      timestampBody({ kind: "partial", analyzedPaths: ["./"], components: [] }),
    );
    const parsed = JSON.parse(runVerb(proj, "--compare", incoming, "--json").stdout);
    expect(parsed.verdict).toBe("UNKNOWN_SCOPE");
    expect(parsed.detail).toContain("requires kind: full");
  });

  test("incoming dir-prefix superset → COVERS (src/ covers src/payments/)", () => {
    const proj = freshProject();
    seedStore(
      proj,
      timestampBody({ fingerprint: "abc", components: [] }),
    );
    const incoming = join(proj, "incoming-super.md");
    writeFileSync(
      incoming,
      timestampBody({ intent: "wide", analyzedPaths: ["src/"], components: [] }),
    );
    const res = runVerb(proj, "--compare", incoming, "--json");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe("COVERS");
  });

  test("missing --compare file → hard error (a lifecycle mistake, not a verdict)", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc" }));
    const res = runVerb(proj, "--compare", join(proj, "does-not-exist.md"));
    expect(res.status).not.toBe(0);
  });
});

describe("t248 codekb-scope-diff verb — mint mode", () => {
  test("--mint prints the same fingerprint the lib computes; --json carries paths", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "a\n");
    const fp = codekbScopeFingerprint(proj, ["src/payments/"]);
    expect(fp).not.toBeNull();
    const res = runVerb(proj, "--mint", "--paths", "src/payments/");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(fp as string);
    const asJson = runVerb(proj, "--mint", "--paths", "src/payments/", "--json");
    const parsed = JSON.parse(asJson.stdout);
    expect(parsed.fingerprint).toBe(fp);
    expect(parsed.paths).toEqual(["src/payments/"]);
  });

  test("--mint outside a git tree prints unknown (recorded verbatim in the block)", () => {
    const proj = freshProject();
    const res = runVerb(proj, "--mint", "--paths", "src/");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("unknown");
  });

  test("--mint with a failed pathspec prints unknown, never the empty-tree hash", () => {
    const proj = freshProject();
    gitInit(proj);
    const res = runVerb(proj, "--mint", "--paths", "missing/");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("unknown");
  });

  test("--mint without --paths → hard error", () => {
    const proj = freshProject();
    const res = runVerb(proj, "--mint");
    expect(res.status).not.toBe(0);
  });
});

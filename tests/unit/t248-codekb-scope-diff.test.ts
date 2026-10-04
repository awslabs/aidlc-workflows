// covers: function:parseReScope, function:codekbScopeFingerprint, function:scopePathCovered, function:codekbFingerprintExcludes, function:aidlcRootIntegrations, subcommand:aidlc-utility:codekb-scope-diff
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

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  aidlcRootIntegrations,
  codekbFingerprintExcludes,
  codekbScopeFingerprint,
  codekbStoreIsCurrent,
  parseReScope,
  scopePathCovered,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const SHA1_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  const r = spawnSync("git", ["init", "-q", dir], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
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
  const repo = basename(proj);
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
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: childEnv() },
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

  test("lone-repo exclusions are omitted beside narrow scopes", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    mkdirSync(join(proj, "src", "auth"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "payments\n");
    writeFileSync(join(proj, "src", "auth", "login.ts"), "auth\n");

    const payments = codekbScopeFingerprint(proj, ["./src/payments/"], ["aidlc"]);
    const auth = codekbScopeFingerprint(proj, ["src/auth/"], ["aidlc"]);
    expect(payments).not.toBeNull();
    expect(auth).not.toBeNull();
    expect(payments).not.toBe(SHA1_EMPTY_TREE);
    expect(auth).not.toBe(SHA1_EMPTY_TREE);
    expect(payments).not.toBe(auth);
    expect(payments).toBe(codekbScopeFingerprint(proj, ["./src/payments/"]));
    expect(auth).toBe(codekbScopeFingerprint(proj, ["src/auth/"]));
  });

  test("root exclusions ignore framework edits but retain scoped source edits", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    const source = join(proj, "src", "app.ts");
    const generated = join(proj, "aidlc", "state.md");
    writeFileSync(source, "source one\n");
    writeFileSync(generated, "state one\n");

    const fp1 = codekbScopeFingerprint(proj, ["./"], [".\\aidlc\\"]);
    expect(fp1).not.toBeNull();
    writeFileSync(generated, "state two\n");
    expect(codekbScopeFingerprint(proj, ["./"], [".\\aidlc\\"])).toBe(fp1);
    writeFileSync(source, "source two\n");
    const fp2 = codekbScopeFingerprint(proj, ["./"], [".\\aidlc\\"]);
    expect(fp2).not.toBeNull();
    expect(fp2).not.toBe(fp1);
  });

  test("a root scope containing only its excluded directory stages nothing", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    writeFileSync(join(proj, "aidlc", "state.md"), "state\n");

    expect(codekbScopeFingerprint(proj, ["./"], ["aidlc"])).toBeNull();
  });

  test("positives covered by exclusions are dropped, including all-dropped scopes", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(join(proj, "aidlc", "nested"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "source\n");
    writeFileSync(join(proj, "aidlc", "nested", "state.md"), "state\n");

    const mixed = codekbScopeFingerprint(
      proj,
      ["src/", ".\\aidlc\\nested\\"],
      ["./aidlc/"],
    );
    expect(mixed).toBe(codekbScopeFingerprint(proj, ["src/"]));
    expect(
      codekbScopeFingerprint(proj, [".\\aidlc\\nested\\"], ["./aidlc/"]),
    ).toBeNull();
  });

  test("absolute analyzed paths remain invalid instead of becoming repository-relative", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "payments\n");

    expect(codekbScopeFingerprint(proj, ["/src/payments/"], ["aidlc"])).toBeNull();
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
    const human = runVerb(proj);
    expect(human.stdout).toContain(
      "A focused merge may retain its prose, but prior paths and components are not claimed as verified coverage until rescanned.",
    );
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
    const outside = join(parent, "outside.ts");
    writeFileSync(outside, "outside one\n");

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

    writeFileSync(outside, "outside two\n");
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
  test("a compared scope draft in the active record is removed; any other file is only read", () => {
    const proj = freshProject();
    seedStore(proj, timestampBody({ fingerprint: "abc" }));
    // A live record, as during Reverse Engineering: its state file selects it.
    writeFileSync(seededStateFile(proj), "# AI-DLC State\n\n**Current Stage**: reverse-engineering\n");
    const reDir = join(seededRecordDir(proj), "inception", "reverse-engineering");
    mkdirSync(reDir, { recursive: true });
    const draft = join(reDir, `scope-draft-${basename(proj)}.md`);
    writeFileSync(draft, timestampBody({ fingerprint: "abc" }));
    const res = runVerb(proj, "--compare", draft, "--json");
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.verdict).toBe("COVERS");
    expect(parsed.draft_removed).toBe(true);
    expect(existsSync(draft)).toBe(false);
    // A file anywhere else, even one named like a draft, stays.
    const elsewhere = join(proj, `scope-draft-${basename(proj)}.md`);
    writeFileSync(elsewhere, timestampBody({ fingerprint: "abc" }));
    const kept = runVerb(proj, "--compare", elsewhere);
    expect(kept.stdout).toContain("COVERS");
    expect(kept.stdout).not.toContain("removed");
    expect(existsSync(elsewhere)).toBe(true);
  });

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
    const human = runVerb(proj, "--compare", incoming);
    expect(human.stdout).toContain(
      "NARROWER: the incoming scope no longer claims verified deep coverage for:",
    );
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
  test("lone-repo narrow scopes mint distinct non-empty-tree fingerprints", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src", "payments"), { recursive: true });
    mkdirSync(join(proj, "src", "auth"), { recursive: true });
    writeFileSync(join(proj, "src", "payments", "gw.ts"), "payments\n");
    writeFileSync(join(proj, "src", "auth", "login.ts"), "auth\n");

    const payments = runVerb(proj, "--mint", "--paths", "src/payments/");
    const auth = runVerb(proj, "--mint", "--paths", "src/auth/");
    expect(payments.status).toBe(0);
    expect(auth.status).toBe(0);
    expect(payments.stdout.trim()).not.toBe(SHA1_EMPTY_TREE);
    expect(auth.stdout.trim()).not.toBe(SHA1_EMPTY_TREE);
    expect(payments.stdout.trim()).not.toBe(auth.stdout.trim());
  });

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

describe("t248 codekb-scope-diff verb: check mode", () => {
  test("a first scan checks its staged block: VALID with a current fingerprint, then stale after an edit", () => {
    const proj = freshProject();
    gitInit(proj);
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "a\n");
    const fingerprint = runVerb(proj, "--mint", "--paths", "./").stdout.trim();
    // Staged where the stage writes it, inside the record, which the
    // fingerprint leaves out.
    const stagedDir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "260101-fix", ".aidlc-engine", "codekb-stage-app");
    mkdirSync(stagedDir, { recursive: true });
    const staged = join(stagedDir, "reverse-engineering-timestamp.md");
    writeFileSync(staged, timestampBody({ kind: "full", fingerprint, analyzedPaths: ["./"], components: ["app"] }));

    const human = runVerb(proj, "--check", staged);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("VALID: kind full, 1 analyzed path(s), 1 component(s), 1 shallow path(s).");
    expect(human.stdout).toContain("The fingerprint matches the source now.");
    const parsed = JSON.parse(runVerb(proj, "--check", staged, "--json").stdout);
    expect(parsed.verdict).toBe("VALID");
    expect(parsed.fingerprint).toBe("current");
    expect(parsed.analyzed_paths).toEqual(["./"]);
    expect(parsed.shallow_paths).toEqual(["src/"]);

    writeFileSync(join(proj, "src", "app.ts"), "changed\n");
    expect(JSON.parse(runVerb(proj, "--check", staged, "--json").stdout).fingerprint).toBe("stale");
    expect(runVerb(proj, "--check", staged).stdout).toContain("mint it again over analyzed.paths");

    // The template's empty list form parses as an empty list.
    writeFileSync(staged, timestampBody({ kind: "full", fingerprint, analyzedPaths: ["./"] }).replace("    - src/\n", "").replace("shallow:\n  paths:", "shallow:\n  paths: []"));
    const empty = JSON.parse(runVerb(proj, "--check", staged, "--json").stdout);
    expect(empty.verdict).toBe("VALID");
    expect(empty.shallow_paths).toEqual([]);
  });

  test("a block that would not publish is INVALID with the parser's reason", () => {
    const proj = freshProject();
    gitInit(proj);
    const staged = join(proj, "staged-timestamp.md");
    writeFileSync(staged, timestampBody({ kind: "full", fingerprint: "abc", analyzedPaths: ["src/"] }));
    const res = runVerb(proj, "--check", staged, "--json");
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.verdict).toBe("INVALID");
    expect(parsed.reason).toBe("malformed");
    expect(runVerb(proj, "--check", staged).stdout).toContain("INVALID (malformed): kind: full requires repository-root coverage");
  });

  test("outside git the fingerprint is unknown; a missing file is a usage error", () => {
    const proj = freshProject();
    const staged = join(proj, "staged-timestamp.md");
    writeFileSync(staged, timestampBody({ fingerprint: "unknown" }));
    expect(JSON.parse(runVerb(proj, "--check", staged, "--json").stdout).fingerprint).toBe("unknown");
    expect(runVerb(proj, "--check", join(proj, "missing.md")).status).not.toBe(0);
    expect(runVerb(proj, "--check").status).not.toBe(0);
  });
});

// ============================================================================
// AI-DLC's own files. The scan never reads them, so changing them (an update,
// a setting, a setup file it writes into) never makes the store out of date,
// while the project's own files beside them still do.
// ============================================================================
describe("t248 codekb freshness: AI-DLC's own files", () => {
  function installedProject(): string {
    const proj = freshProject();
    gitInit(proj);
    cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "app.ts"), "a\n");
    mkdirSync(join(proj, ".github", "workflows"), { recursive: true });
    writeFileSync(join(proj, ".github", "workflows", "ci.yml"), "on: push\n");
    writeFileSync(join(proj, "AGENTS.md"), "# Team notes\n");
    return proj;
  }
  const write = (proj: string, path: string, body: string): void => {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), body);
  };

  test("an AI-DLC update, setting or setup file leaves a full-root store current; the project's own files do not", () => {
    const proj = installedProject();
    const mint = runVerb(proj, "--mint", "--paths", "./");
    expect(mint.status).toBe(0);
    const fingerprint = mint.stdout.trim();
    expect(fingerprint).toMatch(/^[0-9a-f]{40,64}$/);
    seedStore(proj, timestampBody({ kind: "full", fingerprint, analyzedPaths: ["./"] }));
    const verdict = (): string => JSON.parse(runVerb(proj, "--json").stdout).verdict;
    expect(verdict()).toBe("CURRENT");

    appendFileSync(join(proj, ".claude", "tools", "aidlc-version.ts"), "// update\n");
    write(proj, ".mcp.json", '{"mcpServers":{}}\n');
    write(proj, ".gitignore", "node_modules/\n");
    write(proj, "aidlc.settings.json", "{}\n");
    write(proj, ".kiro/settings/cli.json", "{}\n");
    write(proj, ".github/agents/aidlc-developer-agent.md", "agent\n");
    write(proj, ".github/hooks/aidlc.json", "{}\n");
    write(proj, ".github/skills/aidlc-bugfix/SKILL.md", "skill\n");
    write(proj, ".github/skills/review-pro/SKILL.md", "---\nname: review-pro\ngenerated-by: aidlc-runner-gen\n---\nrunner\n");
    write(proj, ".agents/skills/aidlc/SKILL.md", "skill\n");
    expect(verdict()).toBe("CURRENT");
    expect(codekbStoreIsCurrent(proj)).toBe(true);

    // AGENTS.md is the project's own here: no installed harness writes into it.
    for (const [path, edited, original] of [
      [".github/workflows/ci.yml", "on: pull_request\n", "on: push\n"],
      ["AGENTS.md", "# Team notes, changed\n", "# Team notes\n"],
      ["src/app.ts", "changed\n", "a\n"],
    ]) {
      write(proj, path, edited);
      expect(verdict(), path).toBe("STALE");
      write(proj, path, original);
      expect(verdict(), path).toBe("CURRENT");
    }
    write(proj, ".github/skills/team-release/SKILL.md", "---\nname: team-release\n---\nours\n");
    expect(verdict()).toBe("STALE");
    rmSync(join(proj, ".github", "skills", "team-release"), { recursive: true });
    expect(verdict()).toBe("CURRENT");
  });

  test("a left-out path the project also ignores still gives a fingerprint", () => {
    const proj = installedProject();
    write(proj, ".gitignore", ".claude/\naidlc.settings.local.json\n.vscode/*\n");
    write(proj, "aidlc.settings.local.json", "{}\n");
    write(proj, ".vscode/settings.json", "{}\n");
    const fingerprint = runVerb(proj, "--mint", "--paths", "./").stdout.trim();
    expect(fingerprint).toMatch(/^[0-9a-f]{40,64}$/);
    seedStore(proj, timestampBody({ kind: "full", fingerprint, analyzedPaths: ["./"] }));
    expect(JSON.parse(runVerb(proj, "--json").stdout).verdict).toBe("CURRENT");
    write(proj, "src/app.ts", "changed\n");
    expect(JSON.parse(runVerb(proj, "--json").stdout).verdict).toBe("STALE");
  });

  test("the pre-scan snapshot keeps its source fingerprint across an AI-DLC update", () => {
    const proj = installedProject();
    const snapshot = (): string => {
      const res = spawnSync(
        BUN,
        [UTILITY, "codekb-snapshot", "--paths", "./", "--json", "--project-dir", proj],
        { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: childEnv() },
      );
      expect(res.status, res.stderr).toBe(0);
      return JSON.parse(res.stdout).source_fingerprint;
    };
    const before = snapshot();
    appendFileSync(join(proj, ".claude", "tools", "aidlc-version.ts"), "// update\n");
    write(proj, ".mcp.json", '{"mcpServers":{}}\n');
    expect(snapshot()).toBe(before);
    write(proj, "src/app.ts", "changed\n");
    expect(snapshot()).not.toBe(before);
  });

  test("the left-out paths come from the installed harness; a sibling repo leaves nothing out", () => {
    const proj = installedProject();
    expect(aidlcRootIntegrations(proj).map((integration) => integration.path).sort()).toEqual([".gitignore", ".mcp.json"]);
    const excluded = codekbFingerprintExcludes(proj, proj);
    for (const path of ["aidlc", ".claude", ".kiro", ".opencode", ".gitignore", ".mcp.json", "aidlc.settings.json"]) {
      expect(excluded).toContain(path);
    }
    expect(excluded).not.toContain("AGENTS.md");
    expect(excluded).not.toContain(".github");
    expect(codekbFingerprintExcludes(proj, join(proj, "payments"))).toEqual([]);
  });

  test("the stage's completion summary leaves the freshness check out", () => {
    const stage = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", "inception", "reverse-engineering.md"), "utf-8")
      .replace(/\s+/g, " ");
    const step5 = stage.slice(stage.indexOf("### Step 5:"), stage.indexOf("## Sensors"));
    expect(step5).toContain("Leave the knowledge base's freshness check out of the summary");
  });
});

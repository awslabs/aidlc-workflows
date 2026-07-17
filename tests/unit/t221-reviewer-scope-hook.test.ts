// t221-reviewer-scope-hook: the deterministic PreToolUse enforcement of the
// per-unit reviewer read-scope bound (stage-protocol 12a).
//
// covers: hook:aidlc-reviewer-scope, file:aidlc-common/protocols/stage-protocol.md §12a,
// file:harness/kiro/hooks/aidlc-kiro-adapter.ts, file:skills/aidlc/SKILL.md reviewer bullet
//
// Three layers, matching the hook's structure:
//   (a) MATCHER (mechanism none, in-process): evaluateReviewerScope is an
//       exported pure function - table-driven decision cases. The hook file's
//       main body is behind import.meta.main, so the import is side-effect
//       free.
//   (b) LIFECYCLE (mechanism cli, subprocess): the hook IS a stdin/exit-code
//       shim around the dispatch record - spawn the SHIPPED hook with seeded
//       records and assert the exit code + stderr + the record's janitoring.
//       Same rationale as t121/t180: in-process would bypass the contracted
//       surface.
//   (c) REGISTRATION + PROTOCOL (mechanism none): the four harness wiring
//       surfaces and the 12a dispatch-record prose, so a wiring or prose sweep
//       cannot silently drop the enforcement while the hook file survives.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockReason,
  evaluateReviewerScope,
  parseDispatchRecord,
  type ScopeContext,
  type ReviewerDispatch,
} from "../../dist/claude/.claude/hooks/aidlc-reviewer-scope.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const BUN = process.execPath;
const RECORD_ROOT = join(REPO_ROOT, "aidlc", "spaces", "default", "intents", "x");
const SCOPE_CONTEXT: ScopeContext = {
  recordRoot: RECORD_ROOT,
  cwd: REPO_ROOT,
};
const CURRENT_UNIT_CONTEXT: ScopeContext = {
  recordRoot: RECORD_ROOT,
  cwd: join(RECORD_ROOT, "construction", "U03-scoring"),
};

// ---------------------------------------------------------------------------
// (a) The pure matcher - table-driven decision cases.
// ---------------------------------------------------------------------------

const DISPATCH: Pick<ReviewerDispatch, "unit" | "exempt"> = {
  unit: "U03-scoring",
  exempt: [
    "aidlc/spaces/default/intents/x/inception/application-design/components.md",
    "aidlc/spaces/default/intents/x/construction/U01-infra/functional-design/design.md",
  ],
};

describe("t221 (a) evaluateReviewerScope decision table", () => {
  const CASES: Array<{
    name: string;
    tool: string;
    input: Record<string, unknown>;
    block: boolean;
    context?: ScopeContext;
    dispatch?: Pick<ReviewerDispatch, "unit" | "exempt">;
  }> = [
    // -- file-path tools ------------------------------------------------------
    {
      name: "sibling unit Read blocked",
      tool: "Read",
      input: { file_path: "construction/U01-infra/functional-design/design2.md" },
      block: true,
    },
    {
      name: "current-unit Read allowed",
      tool: "Read",
      input: { file_path: "construction/U03-scoring/nfr-requirements/nfr.md" },
      block: false,
    },
    {
      name: "exempt contract path allowed (named integration point, exact file)",
      tool: "Read",
      input: { file_path: "aidlc/spaces/default/intents/x/construction/U01-infra/functional-design/design.md" },
      block: false,
    },
    {
      name: "shared inception contract allowed (no construction/ component)",
      tool: "Read",
      input: { file_path: "aidlc/spaces/default/intents/x/inception/application-design/components.md" },
      block: false,
    },
    {
      name: "sibling Edit blocked (reviewer only appends to the current unit's artifact)",
      tool: "Edit",
      input: { file_path: "construction/U05-api/functional-design/design.md" },
      block: true,
    },
    {
      name: "current-unit Write allowed",
      tool: "Write",
      input: { file_path: "construction/U03-scoring/nfr-requirements/nfr.md" },
      block: false,
    },
    {
      name: "sibling NotebookRead blocked",
      tool: "NotebookRead",
      input: { notebook_path: "construction/U05-api/analysis.ipynb" },
      block: true,
    },
    {
      name: "sibling MultiEdit blocked",
      tool: "MultiEdit",
      input: { file_path: "construction/U05-api/functional-design/design.md" },
      block: true,
    },
    {
      name: "sibling LS blocked",
      tool: "LS",
      input: { path: "construction/U05-api" },
      block: true,
    },
    {
      name: "source-tree read outside construction/ allowed",
      tool: "Read",
      input: { file_path: "src/construction-notes/readme.md" },
      block: false,
    },
    // -- Bash ------------------------------------------------------------------
    {
      name: "cross-unit glob in Bash blocked (the field access pattern)",
      tool: "Bash",
      input: { command: "grep -rn 'instance_type' construction/*/*/*.md inception/*/*.md" },
      block: true,
    },
    {
      name: "named-sibling grep in Bash blocked",
      tool: "Bash",
      input: { command: "grep -rn 'ml\\.' construction/U01-infra/nfr-requirements/nfr.md" },
      block: true,
    },
    {
      name: "current-unit grep in Bash allowed",
      tool: "Bash",
      input: { command: "grep -rn latency construction/U03-scoring/" },
      block: false,
    },
    {
      name: "bare construction/ sweep root blocked",
      tool: "Bash",
      input: { command: "grep -rn endpoint construction/ -l" },
      block: true,
    },
    {
      name: "exempt file via Bash cat allowed",
      tool: "Bash",
      input: { command: "cat aidlc/spaces/default/intents/x/construction/U01-infra/functional-design/design.md" },
      block: false,
    },
    {
      name: "listing the exempt file's parent dir still blocked (exact-file exemption)",
      tool: "Bash",
      input: { command: "ls construction/U01-infra/functional-design/" },
      block: true,
    },
    {
      name: "validation tool run with no construction/ tokens allowed",
      tool: "Bash",
      input: { command: "bun .claude/tools/aidlc-validate.ts --stage nfr-requirements" },
      block: false,
    },
    {
      name: "the word construction without a slash is content, not a path",
      tool: "Bash",
      input: { command: "grep -rn 'construction phase' aidlc/spaces/default/intents/x/inception/" },
      block: false,
    },
    {
      name: "ancestor-root recursive grep blocked even without a construction token",
      tool: "Bash",
      input: { command: "grep -rn X ." },
      block: true,
    },
    {
      name: "ancestor-root rg blocked even without a construction token",
      tool: "Bash",
      input: { command: "rg Contract aidlc/spaces/default/intents" },
      block: true,
    },
    {
      name: "ancestor-root find blocked even without a construction token",
      tool: "Bash",
      input: { command: "find aidlc/spaces/default/intents -name design.md -exec cat {} +" },
      block: true,
    },
    {
      name: "wildcard inside the construction component blocked",
      tool: "Bash",
      input: { command: "cat construction*/U01-infra/functional-design/design.md" },
      block: true,
    },
    {
      name: "quote-split construction component blocked",
      tool: "Bash",
      input: { command: 'cat "construction"/U01-infra/functional-design/design2.md' },
      block: true,
    },
    {
      name: "cd into current unit then relative sibling cat blocked",
      tool: "Bash",
      input: { command: "cd construction/U03-scoring && cat ../U01-infra/functional-design/design2.md" },
      block: true,
    },
    // -- Glob / Grep tools -------------------------------------------------------
    {
      name: "Glob pattern spanning siblings blocked",
      tool: "Glob",
      input: { pattern: "construction/*/functional-design/*.md" },
      block: true,
    },
    {
      name: "Glob scoped to the current unit allowed",
      tool: "Glob",
      input: { pattern: "construction/U03-scoring/**/*.md" },
      block: false,
    },
    {
      name: "pathless Glob rooted at cwd blocked when it spans the record tree",
      tool: "Glob",
      input: { pattern: "**/*.md" },
      block: true,
    },
    {
      name: "pathless Glob explicitly constrained to the current unit allowed",
      tool: "Glob",
      input: { pattern: "construction/U03-scoring/**/*.md" },
      block: false,
    },
    {
      name: "Grep with a sibling search-root path blocked",
      tool: "Grep",
      input: { pattern: "publish envelope", path: "construction/U04-events" },
      block: true,
    },
    {
      name: "Grep content-regex mentioning a sibling path is NOT a file access",
      tool: "Grep",
      input: { pattern: "construction/U01-infra", path: "construction/U03-scoring" },
      block: false,
    },
    {
      name: "Grep with the bare construction dir as its search root blocked (sweep root)",
      tool: "Grep",
      input: { pattern: "endpoint", path: "construction" },
      block: true,
    },
    {
      name: "pathless Grep rooted at cwd blocked",
      tool: "Grep",
      input: { pattern: "PaymentGateway" },
      block: true,
    },
    // -- traversal + bare-root shapes (adversarial-review findings) -------------
    {
      name: "dot-dot traversal out of the current unit blocked (path tool)",
      tool: "Read",
      input: { file_path: "construction/U03-scoring/../U01-infra/design.md" },
      block: true,
    },
    {
      name: "dot-dot traversal out of the current unit blocked (Bash)",
      tool: "Bash",
      input: { command: "cat construction/U03-scoring/../U05-api/design.md" },
      block: true,
    },
    {
      name: "bare construction search root blocked (grep with no trailing slash)",
      tool: "Bash",
      input: { command: "grep -rn TODO construction" },
      block: true,
    },
    {
      name: "bare construction search root blocked (find)",
      tool: "Bash",
      input: { command: "find construction -type f -name '*.md'" },
      block: true,
    },
    {
      name: "bare root via ./ blocked",
      tool: "Bash",
      input: { command: "ls ./construction" },
      block: true,
    },
    {
      name: "bare root as a path tail blocked",
      tool: "Bash",
      input: { command: "ls aidlc/spaces/x/construction" },
      block: true,
    },
    {
      name: "case variant of construction and sibling unit blocked",
      tool: "Read",
      input: { file_path: "Construction/U02-api/design.md" },
      block: true,
    },
    {
      name: "case variant of current unit allowed",
      tool: "Read",
      input: { file_path: "construction/u01-infra/design.md" },
      block: false,
      dispatch: { unit: "U01-infra", exempt: [] },
    },
    {
      name: "bare relative sibling path blocked from the current-unit cwd",
      tool: "Read",
      input: { file_path: "../U01-infra/design.md" },
      block: true,
      context: CURRENT_UNIT_CONTEXT,
    },
    {
      name: "the bare word inside a quoted content regex is NOT a search root",
      tool: "Bash",
      input: { command: "grep -rn 'built in construction phase' inception/" },
      block: false,
    },
    // -- unknown tools pass -----------------------------------------------------
    {
      name: "unknown tool never blocked",
      tool: "WebSearch",
      input: { query: "construction/*/design" },
      block: false,
    },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      const verdict = evaluateReviewerScope(c.tool, c.input, c.dispatch ?? DISPATCH, c.context ?? SCOPE_CONTEXT);
      expect(verdict.block).toBe(c.block);
      if (c.block) expect(verdict.target ?? "").not.toBe("");
    });
  }

  test("blockReason names the unit and the offending target", () => {
    const full: ReviewerDispatch = { reviewer: "aidlc-architecture-reviewer-agent", stage: "s", ...DISPATCH };
    const reason = blockReason("construction/*/*/*.md", full);
    expect(reason).toContain("U03-scoring");
    expect(reason).toContain("construction/*/*/*.md");
    expect(reason).toContain("contract paths");
  });

  test("parseDispatchRecord accepts the documented shape and rejects malformed records", () => {
    const good = parseDispatchRecord(
      '{"reviewer":"aidlc-architecture-reviewer-agent","stage":"nfr-requirements","unit":"U03","exempt":["a.md"]}',
    );
    expect(good?.unit).toBe("U03");
    expect(parseDispatchRecord("not json")).toBeNull();
    expect(parseDispatchRecord('{"reviewer":"","stage":"s","unit":"U03","exempt":[]}')).toBeNull();
    expect(parseDispatchRecord('{"reviewer":"r","stage":"s","unit":"","exempt":[]}')).toBeNull();
    expect(parseDispatchRecord('{"reviewer":"r","stage":"s","unit":"U03","exempt":[1]}')).toBeNull();
    expect(parseDispatchRecord('{"reviewer":"r","stage":"s","unit":"U03"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) Dispatch-record lifecycle - the SHIPPED hook as a subprocess.
// ---------------------------------------------------------------------------

// A scratch project: the shipped hook + the two lib/audit tools it imports,
// plus a bare workspace record root the dispatch record lands under (no
// intent registry -> docsRoot resolves to aidlc/spaces/default/intents/).
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t221-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "tools"), { recursive: true });
  cpSync(join(AIDLC_SRC, "hooks", "aidlc-reviewer-scope.ts"), join(dir, ".claude", "hooks", "aidlc-reviewer-scope.ts"));
  for (const t of ["aidlc-lib.ts", "aidlc-audit.ts"]) {
    cpSync(join(AIDLC_SRC, "tools", t), join(dir, ".claude", "tools", t));
  }
  mkdirSync(join(dir, "aidlc", "spaces", "default", "intents"), { recursive: true });
  return dir;
}

function recordPath(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-reviewer-dispatch.json");
}

function seedRecord(proj: string, overrides: Partial<ReviewerDispatch> = {}): void {
  writeFileSync(
    recordPath(proj),
    JSON.stringify({
      reviewer: "aidlc-architecture-reviewer-agent",
      stage: "nfr-requirements",
      unit: "U03-scoring",
      exempt: [],
      ...overrides,
    }),
    "utf-8",
  );
}

function runHook(
  proj: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-reviewer-scope.ts")], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

const SIBLING_SWEEP = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "grep -rn x construction/*/*/*.md" },
  agent_type: "aidlc-architecture-reviewer-agent",
};

describe("t221 (b) dispatch-record lifecycle (shipped hook, subprocess)", () => {
  test("fresh record + dispatched reviewer + sibling sweep -> exit 2 with the redirecting reason", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("reviewer read-scope");
    expect(r.stderr).toContain("U03-scoring");
  });

  test("fresh record + reviewer + current-unit access -> exit 0", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = runHook(proj, {
      ...SIBLING_SWEEP,
      tool_input: { command: "grep -rn x construction/U03-scoring/" },
    });
    expect(r.code).toBe(0);
  });

  test("no record -> exit 0 even for a reviewer sibling sweep (nothing sound to enforce)", () => {
    const proj = scratchProject();
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    // The advisory drop is recorded for --doctor (conductor forgot step 1).
    const drops = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health", "reviewer-scope.drops");
    expect(existsSync(drops)).toBe(true);
    expect(readFileSync(drops, "utf-8")).toContain("no reviewer dispatch record");
  });

  test("a different agent (or the main session, no agent_type) passes through", () => {
    const proj = scratchProject();
    seedRecord(proj);
    expect(runHook(proj, { ...SIBLING_SWEEP, agent_type: "aidlc-developer-agent" }).code).toBe(0);
    const { agent_type: _omit, ...noAgent } = SIBLING_SWEEP;
    expect(runHook(proj, noAgent).code).toBe(0);
  });

  test("scoped_registration substitutes for agent identity (the Kiro adapters' contract)", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const { agent_type: _omit, ...noAgent } = SIBLING_SWEEP;
    const r = runHook(proj, { ...noAgent, scoped_registration: true });
    expect(r.code).toBe(2);
  });

  test("stale record (mtime beyond the TTL) is ignored AND janitored", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000; // 7h > the 6h TTL
    utimesSync(recordPath(proj), old, old);
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    expect(existsSync(recordPath(proj))).toBe(false); // janitor removed the orphan
  });

  test("malformed record JSON fails open (exit 0, drop recorded)", () => {
    const proj = scratchProject();
    writeFileSync(recordPath(proj), "not json", "utf-8");
    expect(runHook(proj, SIBLING_SWEEP).code).toBe(0);
  });

  test("the deterministic off-switch disables enforcement entirely", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = runHook(proj, SIBLING_SWEEP, { AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "1" });
    expect(r.code).toBe(0);
  });

  test("garbage stdin fails open", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-reviewer-scope.ts")], {
      input: "not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });

  test("a block appends a REVIEWER_SCOPE_BLOCKED audit row when a shard exists", () => {
    const proj = scratchProject();
    seedRecord(proj);
    // Seed the per-clone shard AT the path the hook's auditFilePath resolves
    // (audit/<host>-<clone>.md under the bare space record root) - the hook
    // gates its emit on that exact file existing. Pin the clone-id (t131's
    // idiom) so the seeded shard and the hook's resolved shard agree.
    const auditDir = join(proj, "aidlc", "spaces", "default", "intents", "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), "t221clone\n", "utf-8");
    const host =
      hostname()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "host";
    const shardPath = join(auditDir, `${host}-t221clone.md`);
    writeFileSync(shardPath, "# Audit\n", "utf-8");
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(2);
    const shard = readFileSync(shardPath, "utf-8");
    expect(shard).toContain("REVIEWER_SCOPE_BLOCKED");
    expect(shard).toContain("construction/*/*/*.md");
    expect(shard).toContain("U03-scoring");
  });
});

// ---------------------------------------------------------------------------
// (c) Registration + protocol prose pins.
// ---------------------------------------------------------------------------

describe("t221 (c) harness registration and protocol prose", () => {
  test("Claude settings.json wires the hook on PreToolUse with the file/search/shell matcher", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "claude-settings",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const s = JSON.parse(readFileSync(join(harness.engineRoot, "settings.json"), "utf-8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const groups = s.hooks?.PreToolUse ?? [];
      const group = groups.find((g) =>
        (g.hooks ?? []).some((h) => (h.command ?? "").includes("aidlc-reviewer-scope.ts")),
      );
      expect(group, harness.name).toBeDefined();
      expect(group?.matcher).toBe(
        "Read|NotebookRead|Edit|MultiEdit|Write|NotebookEdit|LS|Glob|Grep|Bash",
      );
    }
  });

  test("Kiro CLI wires the adapter's reviewer-scope target inside BOTH reviewer agent JSONs", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "kiro-agent-json",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      for (const agent of ["aidlc-architecture-reviewer-agent", "aidlc-product-lead-agent"]) {
        const a = JSON.parse(
          readFileSync(join(harness.engineRoot, "agents", `${agent}.json`), "utf-8"),
        ) as { hooks?: { preToolUse?: Array<{ matcher?: string; command?: string }> } };
        const entries = a.hooks?.preToolUse ?? [];
        expect(entries.length, `${harness.name}/${agent}`).toBeGreaterThanOrEqual(3);
        const matchers = entries.map((e) => e.matcher).sort();
        expect(matchers).toEqual(["execute_bash", "fs_read", "fs_write"]);
        for (const e of entries) {
          // The registration passes its own agent name so the adapter forwards
          // a real identity instead of a bare scoped_registration.
          expect(e.command).toContain(`aidlc-kiro-adapter.ts reviewer-scope ${agent}`);
        }
      }
    }
  });

  test("Kiro IDE ships NO reviewer-scope registration (documented gap: toolArgs is always empty)", () => {
    // The IDE delivers hook context via USER_PROMPT with toolArgs always {}
    // (docs/reference/kiro-ide-hook-payload.md): a preToolUse hook there can
    // never see the attempted path or command, so there is nothing to match
    // on. Per the porting guide, an unenforceable seam ships NO registration
    // rather than a dead hook - the 12a prose bound governs on that harness.
    // This pins the deliberate absence so a future blanket-registration sweep
    // does not wire an inert (or worse, blindly blocking) entry.
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "unsupported",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      expect(existsSync(join(harness.engineRoot, "hooks", "aidlc-reviewer-scope.kiro.hook"))).toBe(
        false,
      );
    }
  });

  test("Codex hooks.json wires the adapter's reviewer-scope target on PreToolUse", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "codex-hooks",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const wiring = JSON.parse(
        readFileSync(join(harness.engineRoot, "hooks.json"), "utf-8"),
      ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      const pre = wiring.hooks.PreToolUse ?? [];
      expect(
        pre.some((g) =>
          g.hooks.some(
            (h) =>
              h.command ===
              `bun ${harness.manifest.harnessDir}/hooks/aidlc-codex-adapter.ts reviewer-scope`,
          ),
        ),
      ).toBe(true);
    }
  });

  test("stage-protocol 12a carries the dispatch-record write (step 1) and delete (step 3)", () => {
    const body = readFileSync(
      join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md"),
      "utf-8",
    );
    expect(body).toContain(".aidlc-reviewer-dispatch.json");
    // Step 1: the write, per-unit only, exempt list carries the carve-out.
    expect(body).toMatch(/Dispatch record \(per-unit stages; enforcement-capable harnesses only\)/);
    expect(body).toMatch(/append its path to `exempt`/);
    expect(body).toContain("On a harness without reviewer-scope enforcement");
    expect(body).toContain("do not write the record");
    // Step 3: the delete on verdict read.
    expect(body).toMatch(/Read verdict.*delete `<record>\/\.aidlc-reviewer-dispatch\.json`/s);
  });

  test("harnesses with reviewer-scope enforcement carry the dispatch-record instruction", () => {
    for (const harness of HARNESS_MATRIX.filter(
      (entry) => entry.capabilities.reviewerScopeRegistration !== "unsupported",
    )) {
      const body = readFileSync(join(harness.authoredRoot, "skills", "aidlc", "SKILL.md"), "utf-8");
      const labelled = `harness ${harness.name}: ${body}`;
      expect(labelled).toContain(".aidlc-reviewer-dispatch.json");
      expect(labelled).toContain("Delete the dispatch record");
    }
  });

  test("Kiro IDE documents its prose-only reviewer bound and omits the unused record", () => {
    const body = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "skills", "aidlc", "SKILL.md"),
      "utf-8",
    );
    expect(body).toContain("read-scope bound is prose-only on this harness");
    expect(body).toContain("no IDE reviewer-scope hook consumes that record");
    expect(body).toContain("shared protocol makes its dispatch-record steps conditional");
    expect(body).not.toContain(".aidlc-reviewer-dispatch.json");
    expect(body).not.toContain("reviewer-scope PreToolUse hook enforces");
  });
});

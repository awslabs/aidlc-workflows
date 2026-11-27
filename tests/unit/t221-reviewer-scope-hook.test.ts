// t221-reviewer-scope-hook: the deterministic PreToolUse enforcement of the
// per-unit reviewer read-scope bound (stage-protocol-reviewer.md §12a).
//
// covers: hook:aidlc-reviewer-scope, file:aidlc-common/protocols/stage-protocol-reviewer.md §12a,
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
//   (c) REGISTRATION + PROTOCOL (mechanism none): the harness wiring
//       surfaces and the 12a dispatch-record prose, so a wiring or prose sweep
//       cannot silently drop the enforcement while the hook file survives.

import { readConductorSurface } from "../harness/conductor-skill.ts";
import { withCopyLaunchOptions } from "../harness/copy-launch.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockReason,
  evaluateReviewerScope,
  parseDispatchRecord,
  startsBelow,
  type ScopeContext,
  type ReviewerDispatch,
} from "../../dist/claude/.claude/hooks/aidlc-reviewer-scope.ts";
import {
  auditBlockField,
  readAuditShardEvents,
  reviewerDispatchPath,
  stateDigest,
  toPosix,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { hookGroupMembers } from "../../core/tools/aidlc-command.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import kiroManifest from "../../harness/kiro/manifest.ts";
import { seededRecordDir, seededStateFile, seedWorkspaceShell } from "../harness/fixtures.ts";
import {
  checkoutCommand,
  cleanupLayouts,
  commitRecords,
  git,
  setGuardPolicy,
  startCodeGeneration,
  tempDir,
  UNIT,
  workspace,
} from "../harness/source-work-layouts.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
    "aidlc/spaces/default/intents/x/inception/domain-design/components.md",
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
      input: { file_path: "aidlc/spaces/default/intents/x/inception/domain-design/components.md" },
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
    // -- piped stdin-reading search (no path operand) --------------------------
    // An ordinary search downstream of a pipe filters stdin. Modes that still
    // traverse files (recursive grep, rg --files/-f -) are covered below.
    // The first segment (an in-scope path) is allowed on its own merits.
    {
      name: "piped no-operand grep (2nd segment) reads stdin -> allowed",
      tool: "Bash",
      input: { command: "grep -rn latency construction/U03-scoring/ | grep ml" },
      block: false,
    },
    {
      name: "piped no-operand rg (2nd segment) reads stdin -> allowed",
      tool: "Bash",
      input: { command: "cat construction/U03-scoring/nfr.md | rg endpoint" },
      block: false,
    },
    {
      name: "three-stage pipeline, final no-operand grep reads stdin -> allowed",
      tool: "Bash",
      input: { command: "grep -rn x construction/U03-scoring/ | sort | grep y" },
      block: false,
    },
    {
      name: "first-segment recursive grep in a pipeline still blocks (opens '.')",
      tool: "Bash",
      input: { command: "grep -rn TODO | cat" },
      block: true,
    },
    {
      name: "no-operand grep after || (logical-or, not a pipe) still blocks",
      tool: "Bash",
      input: { command: "test -f x || grep -rn TODO" },
      block: true,
    },
    {
      name: "no-operand grep after ; (sequential, not a pipe) still blocks",
      tool: "Bash",
      input: { command: "echo hi ; grep -rn TODO" },
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
    expect(reason).toContain("the files supplied with the review");
  });

  test("a no-operand recursive grep blocks with a defaulted '.' target", () => {
    const v = evaluateReviewerScope(
      "Bash",
      { command: "grep -rn TODO" },
      DISPATCH,
      SCOPE_CONTEXT,
    );
    expect(v.block).toBe(true);
    expect(v.target).toBe(".");
    expect(v.defaulted).toBe(true);
  });

  test("blockReason flags a defaulted target as implicit, not typed", () => {
    const full: ReviewerDispatch = { reviewer: "aidlc-architecture-reviewer-agent", stage: "s", ...DISPATCH };
    const typed = blockReason("construction/U01-infra/design.md", full, false);
    expect(typed).not.toContain("implicit recursive search");
    const defaulted = blockReason(".", full, true);
    expect(defaulted).toContain("names no path");
    expect(defaulted).toContain("implicit recursive search");
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
// A search or a listing refused for where it starts: a folder that holds every
// unit's folder, such as the project folder. The refusal says that, and every
// start it names is one the same matcher lets through.
// ---------------------------------------------------------------------------

describe("t221 (a) a search or a listing refused for starting above the units' folders", () => {
  // Two folders below the temporary one, so the folder two above the project is
  // still one that holds it, wherever the temporary folder is.
  const PROJ = join(mkdtempSync(join(tmpdir(), "t221-above-")), "work", "notify-hub");
  const RECORD = join(PROJ, "aidlc", "spaces", "default", "intents", "x");
  for (const dir of ["server", "src", "test", ".claude", "aidlc/spaces/default/intents/x/inception"]) {
    mkdirSync(join(PROJ, dir), { recursive: true });
  }
  for (const unit of ["U01-infra", "U03-scoring/functional-design", "U03-scoring/nfr-requirements"]) {
    mkdirSync(join(RECORD, "construction", unit), { recursive: true });
  }
  const FULL: ReviewerDispatch = { reviewer: "aidlc-architecture-reviewer-agent", stage: "nfr-design", unit: "U03-scoring", exempt: [] };
  const AT_PROJECT: ScopeContext = { recordRoot: RECORD, cwd: PROJ };
  const UNIT_FOLDER = toPosix(join(RECORD, "construction", "U03-scoring"));

  // What the hook does on a refusal: the verdict, then the words.
  function refusal(tool: string, input: Record<string, unknown>, context = AT_PROJECT) {
    const verdict = evaluateReviewerScope(tool, input, FULL, context);
    const starts = verdict.above ? startsBelow(verdict.target ?? ".", FULL, context, PROJ) : undefined;
    return { verdict, text: blockReason(verdict.target ?? "", FULL, verdict.defaulted, starts) };
  }

  // Every way a reviewer would start again from a folder the refusal names.
  function expectOpen(start: string, context: ScopeContext): void {
    for (const [tool, input] of [
      ["Bash", { command: `find ${start} -iname "*zulip*"` }],
      ["Bash", { command: `grep -rn zulip ${start}` }],
      ["Bash", { command: `ls ${start}` }],
      ["Grep", { pattern: "zulip", path: start }],
      ["Glob", { pattern: "**/*.ts", path: start }],
      ["LS", { path: start }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(evaluateReviewerScope(tool, input, FULL, context), `${tool} ${JSON.stringify(input)}`).toEqual({ block: false });
    }
  }

  const project = toPosix(PROJ);
  const record = toPosix(RECORD);
  const FROM_ABOVE: Array<[string, string, Record<string, unknown>, string[]]> = [
    ["a search a reviewer ran from the project folder", "Bash", { command: 'find . -iname "*zulip*" -not -path "*/aidlc/*" -not -path "*/.claude/*"' }, ["server", "src", "test"]],
    ["a listing of the project folder", "Bash", { command: "ls" }, ["server", "src", "test"]],
    ["a Grep with no folder", "Grep", { pattern: "zulip" }, ["server", "src", "test"]],
    ["a Glob in the project folder", "Glob", { pattern: "**/*.ts", path: project }, [`${project}/server`, `${project}/src`, `${project}/test`]],
    ["a search of the record folder", "Bash", { command: `grep -rn timeout ${record}` }, [`${record}/inception`]],
    ["a search of the space folder", "Bash", { command: "grep -rn timeout aidlc/spaces/default" }, []],
  ];
  for (const [name, tool, input, folders] of FROM_ABOVE) {
    test(`${name}: refused for where it starts, and every start its refusal names is open`, () => {
      const { verdict, text } = refusal(tool, input);
      expect(verdict.block).toBe(true);
      expect(verdict.above).toBe(true);
      expect(text).toStartWith(`This review cannot open "${verdict.target}"`);
      expect(text).toContain("because a search or a listing that starts there runs through every unit's folder;");
      expect(text).not.toContain("belongs to another unit");
      expect(text).toContain(`Start it lower instead: in ${UNIT_FOLDER} for this unit's documents, `);
      expect(text).toEndWith(
        folders.length > 0
          ? `in one of these: ${folders.join(", ")}.`
          : `or in the folder below "${verdict.target}" that holds the code you mean.`,
      );
      for (const start of [UNIT_FOLDER, ...folders]) expectOpen(start, AT_PROJECT);
    });
  }

  test("past 12 open folders the refusal names the first 12 and how many more", () => {
    const wide = join(mkdtempSync(join(tmpdir(), "t221-above-")), "wide");
    const wideRecord = join(wide, "aidlc", "spaces", "default", "intents", "x");
    mkdirSync(join(wideRecord, "construction", "U03-scoring"), { recursive: true });
    const names = Array.from({ length: 15 }, (_, i) => `pkg${String(i + 1).padStart(2, "0")}`);
    for (const name of names) mkdirSync(join(wide, name));
    const context: ScopeContext = { recordRoot: wideRecord, cwd: wide };
    const verdict = evaluateReviewerScope("Bash", { command: "ls" }, FULL, context);
    const starts = startsBelow(verdict.target ?? ".", FULL, context, wide);
    expect(starts?.folders).toEqual(names.slice(0, 12));
    expect(starts?.more).toBe(3);
    expect(blockReason(verdict.target ?? "", FULL, verdict.defaulted, starts)).toEndWith(
      `in one of these: ${names.slice(0, 12).join(", ")} (and 3 more).`,
    );
  });

  test("a call that names no folder says it started in the tool's folder", () => {
    expect(refusal("Grep", { pattern: "zulip" }).text).toContain('cannot open "." (the folder this call starts in when it names none) because');
    expect(refusal("Bash", { command: "grep -rn zulip ." }).text).toContain('cannot open "." because');
  });

  test("a listing of a folder named construction names this unit's folder once, and only it", () => {
    for (const command of [`ls ${record}/construction`, "ls construction"]) {
      const { verdict, text } = refusal("Bash", { command });
      expect(verdict.above).toBe(true);
      expect(text).toEndWith(`Start it lower instead: in ${UNIT_FOLDER} for this unit's documents.`);
      expect(text.split(UNIT_FOLDER)).toHaveLength(2);
    }
  });

  test("a folder above the project is not listed: no folder outside the project is named", () => {
    const { verdict, text } = refusal("Bash", { command: "find ../.. -name x" });
    expect(verdict.above).toBe(true);
    expect(text).toEndWith(`for this unit's documents, or in the folder below "../.." that holds the code you mean.`);
  });

  test("from a folder the call could start in, a call that names no folder says where else the check read it", () => {
    const why = `because this check also takes "." to mean ${record}, and a search or a listing that starts there runs through every unit's folder;`;
    const fromUnit: ScopeContext = { recordRoot: RECORD, cwd: join(RECORD, "construction", "U03-scoring") };
    const own = refusal("Grep", { pattern: "zulip" }, fromUnit);
    expect(own.verdict.above).toBe(true);
    expect(own.text).toContain(why);
    expect(own.text).toEndWith(`Start it lower instead: in ${UNIT_FOLDER} for this unit's documents.`);
    expectOpen(UNIT_FOLDER, fromUnit);
    const fromServer: ScopeContext = { recordRoot: RECORD, cwd: join(PROJ, "server") };
    const source = refusal("Grep", { pattern: "zulip" }, fromServer);
    expect(source.text).toContain(why);
    expect(source.text).toEndWith(`in one of these: ${project}/server.`);
    for (const start of [UNIT_FOLDER, `${project}/server`]) expectOpen(start, fromServer);
  });

  test("when this unit's own folder is refused too, the refusal names no start", () => {
    // A project inside a folder named construction: the guide's switch is the way on there.
    const inside = join(mkdtempSync(join(tmpdir(), "t221-above-")), "construction", "shop");
    const insideRecord = join(inside, "aidlc", "spaces", "default", "intents", "x");
    mkdirSync(join(insideRecord, "construction", "U03-scoring"), { recursive: true });
    const context: ScopeContext = { recordRoot: insideRecord, cwd: inside };
    const verdict = evaluateReviewerScope("Grep", { pattern: "zulip" }, FULL, context);
    expect(verdict.block).toBe(true);
    expect(startsBelow(verdict.target ?? ".", FULL, context, inside)).toBeUndefined();
  });

  test("another unit's file, and a search from another unit's folder, keep their own words", () => {
    const sibling = refusal("Read", { file_path: join(RECORD, "construction", "U01-infra", "design.md") });
    expect(sibling.verdict.above).toBeUndefined();
    expect(sibling.text).toContain("because it belongs to another unit");
    const fromSibling = refusal("Grep", { pattern: "zulip" }, { recordRoot: RECORD, cwd: join(RECORD, "construction", "U01-infra") });
    expect(fromSibling.verdict.above).toBeUndefined();
    expect(fromSibling.text).toContain("implicit recursive search");
  });
});

// ---------------------------------------------------------------------------
// Additional option parsing cases for the pipeline stdin exception.
// ---------------------------------------------------------------------------

describe("t221 piped search options preserve the reviewer boundary", () => {
  const own = "construction/U03-scoring/nfr.md";
  const sibling = "construction/U01-infra/private.md";
  const pipe = `cat ${own} |`;
  const judge = (command: string) =>
    evaluateReviewerScope("Bash", { command }, DISPATCH, SCOPE_CONTEXT);

  for (const command of ["grep", "rg"]) {
    for (const options of [
      "-e needle", "-eneedle", "-ne needle", "-neneedle",
      "--regexp needle", "--regexp=needle", "-e ''",
      "-f patterns.txt", "-fpatterns.txt", "-nfpatterns.txt", "--file=patterns.txt",
      "-A 2 --regexp=needle",
    ]) {
      test(`${command} ${options}: check file operands while allowing stdin and current-unit files`, () => {
        expect(judge(`${pipe} ${command} ${options} ${sibling}`)).toMatchObject({
          block: true, target: sibling,
        });
        expect(judge(`${pipe} ${command} ${options} ${own}`).block).toBe(false);
        expect(judge(`${pipe} ${command} ${options}`).block).toBe(false);
      });
    }
    test(`${command}: pattern options can follow file operands`, () => {
      expect(judge(`${pipe} ${command} ${sibling} --regexp=needle`)).toMatchObject({
        block: true, target: sibling,
      });
    });
    test(`${command}: a sibling pattern file is still a file read`, () => {
      expect(judge(`${pipe} ${command} -f ${sibling}`)).toMatchObject({
        block: true, target: sibling,
      });
      expect(judge(`${pipe} ${command} -f ${own}`).block).toBe(false);
    });
    test(`${command}: -- ends options and an empty quoted pattern stays a pattern`, () => {
      expect(judge(`${pipe} ${command} '' ${sibling}`).block).toBe(true);
      expect(judge(`${pipe} ${command} -e needle -- -outside/${sibling}`).block).toBe(true);
      expect(judge(`${pipe} ${command} -- -needle`).block).toBe(false);
      expect(judge(`${pipe} ${command} -e ${sibling}`).block).toBe(false);
    });
    test(`${command}: explicit sibling operands and input redirections still block`, () => {
      expect(judge(`${pipe} ${command} needle ${sibling}`).block).toBe(true);
      expect(judge(`${pipe} ${command} needle < ${sibling}`).block).toBe(true);
    });
  }
  for (const command of [
    "rg --files", "rg -f -", "rg -f-", "rg --file=-",
    "grep -rn needle", "grep -Rn needle", "grep --recursive needle",
    "grep --dereference-recursive needle", "grep -d recurse needle",
    "grep --directories=recurse needle",
  ]) {
    test(`${command} still traverses the implicit root after a pipe`, () => {
      expect(judge(`${pipe} ${command}`)).toMatchObject({
        block: true, target: ".", defaulted: true,
      });
      expect(judge(`${pipe} ${command} ${own}`).block).toBe(false);
    });
  }
  test("rg filesystem modes preserve a current-unit glob constraint", () => {
    for (const options of ["--files", "-f -"]) {
      expect(judge(`${pipe} rg ${options} -g 'construction/U03-scoring/**'`).block).toBe(false);
      expect(judge(`${pipe} rg ${options} --glob='construction/U01-infra/**'`).block).toBe(true);
    }
  });
  test("option values are not parsed as more flags", () => {
    expect(judge(`${pipe} grep -erecursive`).block).toBe(false);
    expect(judge(`${pipe} rg -r replacement needle`).block).toBe(false);
  });
  test("grep/ripgrep aliases enforce the same option-supplied file operands", () => {
    for (const command of ["egrep", "fgrep", "ripgrep"]) {
      expect(judge(`${pipe} ${command} -eneedle ${sibling}`).block).toBe(true);
      expect(judge(`${pipe} ${command} -eneedle`).block).toBe(false);
    }
  });
  test("a pipe does not exempt a later command after a chain or group separator", () => {
    for (const separator of ["&&", "||", ";", "&"]) {
      expect(judge(`${pipe} grep needle ${separator} rg needle`).block).toBe(true);
    }
    expect(judge("(rg needle)").block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Dispatch-record lifecycle - the SHIPPED hook as a subprocess.
// ---------------------------------------------------------------------------

// A scratch project: the shipped hook, its shell parser, the tools it imports,
// plus a bare workspace record root the dispatch record lands under (no
// intent registry -> docsRoot resolves to aidlc/spaces/default/intents/).
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t221-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "tools"), { recursive: true });
  cpSync(join(AIDLC_SRC, "hooks", "aidlc-reviewer-scope.ts"), join(dir, ".claude", "hooks", "aidlc-reviewer-scope.ts"));
  // The claimed-checkout branch reads a shell call's write targets with the
  // shared parser that ships beside it.
  cpSync(join(AIDLC_SRC, "hooks", "review-freeze-command.ts"), join(dir, ".claude", "hooks", "review-freeze-command.ts"));
  for (const t of [
    "aidlc-lib.ts",
    "aidlc-artifact-vocabulary.ts",
    "aidlc-settings.ts",
    "aidlc-markdown.ts",
    "aidlc-locks.ts",
    "aidlc-review-records.ts",
    "aidlc-unit-dag.ts",
    "aidlc-subagent-inflight.ts",
    "aidlc-git.ts",
    "aidlc-record-core.ts",
    "aidlc-learned-date.ts",
    "aidlc-git-name.ts",
    "aidlc-unit-landing.ts",
    "aidlc-unit-holders.ts",
    "aidlc-kiro-chat-record.ts",
    "aidlc-claude-turn-origin.ts",
    "aidlc-claude-turn-pending.ts",
    "aidlc-install-paths.ts",
    "aidlc-distribution.ts",
    "aidlc-channel.ts",
    "aidlc-version.ts",
    "aidlc-runtime-paths.ts",
    "aidlc-runtime-budget.ts",
    "aidlc-lock-line.ts",
    "aidlc-review-manifest.ts",
    "aidlc-command.ts",
    // aidlc-lib.ts reads a plugin command leading a line with this.
    "aidlc-plugin-commands.ts",
    "aidlc-color.ts",
    "aidlc-guard-fences.ts",
    "aidlc-guard-switch.ts",
    "aidlc-guard-operation.ts",
    "aidlc-reply-reader.ts",
    "aidlc-audit.ts",
  ]) {
    cpSync(join(AIDLC_SRC, "tools", t), join(dir, ".claude", "tools", t));
  }
  mkdirSync(join(dir, "aidlc", "spaces", "default", "intents", ".aidlc-engine"), { recursive: true });
  return dir;
}

function recordPath(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-engine/reviewer-dispatch.json");
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

function seedUnitScope(
  proj: string,
  unit = "U03-scoring",
  settings = "",
): void {
  writeFileSync(
    join(proj, "aidlc", "spaces", "default", "intents", "aidlc-state.md"),
    `# AI-DLC State Tracking\n\n## Runtime State\n- **Unit Ownership**: team\n${settings}`,
    "utf-8",
  );
  writeFileSync(
    join(proj, "aidlc", ".aidlc-unit-scope.json"),
    `${JSON.stringify({
      version: 1,
      space: "default",
      intent_uuid: "00000000-0000-4000-8000-000000000221",
      intent_id8: "00000000",
      unit,
      owner: "t221",
      generation: 1,
      nonce: "t221-nonce",
      claim_ref: `refs/heads/claim/00000000/${unit}`,
      claim_oid: "1".repeat(40),
      claimed_from_oid: "2".repeat(40),
      integration_ref: "refs/heads/main",
      gate_rhythm: "per-stage",
    })}\n`,
    "utf-8",
  );
}

function seedAuditShard(proj: string): string {
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
  return shardPath;
}

function dropsPath(proj: string): string {
  return join(
    proj,
    "aidlc",
    "spaces",
    "default",
    "intents",
    ".aidlc-engine/hooks-health",
    "reviewer-scope.drops",
  );
}

// The active-directive marker is the hook's authority for "was a per-unit review
// owed here": `unit` for a per-unit run-stage, `units` for invoke-swarm. Reading
// it revalidates the state digest, so the state file has to match.
// A version-1 marker on purpose: it is the minimal accepted shape (stage, an
// optional unit, and the state digest), so the case under test is the hook's
// per-unit predicate and not the version-2 identity/attempt envelope, which this
// predicate never reads.
function seedActiveDirective(proj: string, marker: { unit?: string }): void {
  const state = "# AI-DLC State Tracking\n\n## Runtime State\n- **Current Stage**: nfr-requirements\n";
  writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "aidlc-state.md"), state, "utf-8");
  writeFileSync(
    join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-engine", "active-directive.json"),
    `${JSON.stringify({
      version: 1,
      stage: "nfr-requirements",
      ...(marker.unit ? { unit: marker.unit } : {}),
      state_sha256: stateDigest(state),
    })}\n`,
    "utf-8",
  );
}

// Unlike the deliberately version-1 seed above, publish the version-2 marker
// that the production writer actually writes.
function publishActiveDirective(
  proj: string,
  marker: { kind: "invoke-swarm" | "run-stage"; stage: string; unit?: string; units?: string[] },
): void {
  const state = "# AI-DLC State Tracking\n\n## Runtime State\n- **Current Stage**: nfr-requirements\n";
  writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "aidlc-state.md"), state, "utf-8");
  writeActiveDirectiveMarker(proj, {
    kind: marker.kind,
    stage: marker.stage,
    ...(marker.unit ? { unit: marker.unit } : {}),
    ...(marker.units ? { units: marker.units } : {}),
    state_sha256: stateDigest(state),
  });
}

function runHook(
  proj: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-reviewer-scope.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
    expect(r.stderr).toContain("This review cannot open");
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

  // The dispatch record lives in the main workspace (§12a), while the swarm
  // reviewer reads inside its unit worktree. The hook judges construction/<unit>/
  // tokens in those absolute paths.
  test("fresh record in the main workspace + swarm reviewer reading inside a unit worktree -> sibling blocks, own unit passes", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const worktree = mkdtempSync(join(tmpdir(), "t221-wt-"));
    const sibling = runHook(proj, {
      ...SIBLING_SWEEP,
      tool_name: "Read",
      tool_input: {
        file_path: join(worktree, "aidlc", "spaces", "default", "intents", "construction", "U01-infra", "private.md"),
      },
    });
    expect(sibling.code).toBe(2);
    expect(sibling.stderr).toContain("This review cannot open");
    const own = runHook(proj, {
      ...SIBLING_SWEEP,
      tool_name: "Read",
      tool_input: {
        file_path: join(worktree, "aidlc", "spaces", "default", "intents", "construction", "U03-scoring", "design.md"),
      },
    });
    expect(own.code).toBe(0);
  });

  test("piped no-operand grep (reads stdin) -> exit 0 while a first-segment recursive grep blocks", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const piped = runHook(proj, {
      ...SIBLING_SWEEP,
      tool_input: { command: "grep -rn x construction/U03-scoring/ | grep y" },
    });
    expect(piped.code).toBe(0);
    const firstSeg = runHook(proj, {
      ...SIBLING_SWEEP,
      tool_input: { command: "grep -rn TODO | cat" },
    });
    expect(firstSeg.code).toBe(2);
    expect(firstSeg.stderr).toContain("(the folder this call starts in when it names none)");
  });

  test("piped filesystem modes and option-supplied sibling operands -> exit 2", () => {
    const proj = scratchProject();
    seedRecord(proj);
    for (const command of [
      "echo x | rg --files",
      "echo x | rg -f -",
      "echo x | grep -rn x",
      "echo x | rg --regexp=x construction/U01-infra/private.md",
      "echo x | grep -ex construction/U01-infra/private.md",
      "echo x | grep -f patterns.txt construction/U01-infra/private.md",
    ]) {
      const result = runHook(proj, { ...SIBLING_SWEEP, tool_input: { command } });
      expect(result.code, command).toBe(2);
      expect(result.stderr).toContain("This review cannot open");
    }
  });

  test("no record -> exit 0 even for a reviewer sibling sweep (nothing sound to enforce)", () => {
    const proj = scratchProject();
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    // No active directive either, so there is no authority to say step 1 was
    // owed: the advisory stays silent rather than asserting an omission.
    expect(existsSync(dropsPath(proj))).toBe(false);
  });

  test("no record + a PER-UNIT active directive -> the missing-record advisory fires", () => {
    const proj = scratchProject();
    seedActiveDirective(proj, { unit: "U03-scoring" });
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    // Step 1 WAS owed (directive.unit is set), so the advisory is right.
    expect(existsSync(dropsPath(proj))).toBe(true);
    expect(readFileSync(dropsPath(proj), "utf-8")).toContain("no reviewer dispatch record");
  });

  test("no record + a SINGLE-STAGE active directive -> no advisory (the protocol writes no record)", () => {
    const proj = scratchProject();
    seedActiveDirective(proj, {});
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    // stage-protocol-reviewer.md §12a: "Single-stage reviews (no
    // `directive.unit`) write no record." Reporting that absence as a skipped
    // step-1 write is a false advisory, and on a scope that skips
    // units-generation it would repeat for the whole Construction phase.
    expect(existsSync(dropsPath(proj))).toBe(false);
  });

  test("no record + a live v2 INVOKE-SWARM directive -> the advisory fires", () => {
    const proj = scratchProject();
    publishActiveDirective(proj, { kind: "invoke-swarm", stage: "code-generation", units: ["U01-infra", "U03-scoring"] });
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    expect(existsSync(dropsPath(proj))).toBe(true);
    expect(readFileSync(dropsPath(proj), "utf-8")).toContain("no reviewer dispatch record");
  });

  test("no record + a v2 no-unit run-stage published AFTER a swarm -> no advisory (inherited units are not authority)", () => {
    const proj = scratchProject();
    publishActiveDirective(proj, { kind: "invoke-swarm", stage: "code-generation", units: ["U01-infra", "U03-scoring"] });
    // The writer carries `units` forward (core/tools/aidlc-lib.ts:
    // `requestedUnits = marker.units ?? base.units`); §12a says a no-unit
    // review writes no record.
    publishActiveDirective(proj, { kind: "run-stage", stage: "nfr-requirements" });
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    expect(existsSync(dropsPath(proj))).toBe(false);
  });

  test("no record + a v2 PER-UNIT run-stage -> the advisory fires", () => {
    const proj = scratchProject();
    publishActiveDirective(proj, { kind: "run-stage", stage: "nfr-requirements", unit: "U03-scoring" });
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(0);
    expect(existsSync(dropsPath(proj))).toBe(true);
    expect(readFileSync(dropsPath(proj), "utf-8")).toContain("no reviewer dispatch record");
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

  test("the deterministic off-switch disables reviewer read-scope enforcement", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = runHook(proj, SIBLING_SWEEP, { AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "1" });
    expect(r.code).toBe(0);
  });

  test.each([
    ["strict", "", 2],
    ["relaxed", "", 2],
    ["off", "", 0],
    ["relaxed", "- **Guards Off**: reviewer-scope (set by you)\n", 0],
  ] as const)("reviewer read scope under %s with switch %s returns %i", (policy, switches, code) => {
    const proj = scratchProject();
    seedRecord(proj);
    const shardPath = seedAuditShard(proj);
    writeFileSync(
      join(proj, "aidlc", "spaces", "default", "intents", "aidlc-state.md"),
      `# AI-DLC State Tracking\n\n## Runtime State\n- **Guard Policy**: ${policy} (set by you)\n${switches}`,
    );
    const result = runHook(proj, SIBLING_SWEEP, { AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "" });
    expect(result.code, result.stderr).toBe(code);
    const audit = readFileSync(shardPath, "utf-8");
    if (code === 0) {
      expect(audit.match(/\*\*Event\*\*: GUARD_STOOD_ASIDE\b/g)).toHaveLength(1);
      expect(audit).toContain("**Guard**: reviewer-scope");
      expect(audit).not.toContain("REVIEWER_SCOPE_BLOCKED");
      // Guard Policy off records the pass and says nothing; the person's own
      // switch under relaxed keeps its one line.
      if (policy === "off") expect(result.stdout).not.toContain("Continuing past");
      else expect(result.stdout).toContain("Continuing past the reviewer-scope check");
    } else {
      expect(result.stderr).toContain("This review cannot open");
      expect(audit).toContain("REVIEWER_SCOPE_BLOCKED");
      expect(audit).not.toContain("GUARD_STOOD_ASIDE");
    }
  });

  test("claimed checkout blocks normalized traversal and case-variant writes without a dispatch record", () => {
    const proj = scratchProject();
    seedUnitScope(proj);
    const shardPath = seedAuditShard(proj);
    const cwd = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "construction",
      "U03-scoring",
    );
    const r = runHook(proj, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "../u05-API/design.md" },
      cwd,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('scoped to Unit "U03-scoring"');
    expect(r.stderr).toContain("../u05-API/design.md");
    const shard = readFileSync(shardPath, "utf-8");
    expect(shard).toContain("REVIEWER_SCOPE_BLOCKED");
    expect(shard).toContain("**Stage**: claimed-checkout");
    expect(shard).toContain("**Target**: ../u05-API/design.md");
  });

  test("claimed checkout: a shell apply_patch into another Unit is refused as touch is", () => {
    const proj = scratchProject();
    seedUnitScope(proj);
    const patch = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`;
    for (const command of [`apply_patch <<'PATCH'\n${patch("Construction/u05-API/result.md")}\nPATCH`, `apply_patch '${patch("Construction/u05-API/result.md")}'`]) {
      const r = runHook(proj, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toContain('This checkout is scoped to Unit "U03-scoring"');
    }
    const bash = (command: string) => runHook(proj, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
    expect(bash("touch Construction/u05-API/result.md").stderr).toContain('This checkout is scoped to Unit "U03-scoring"');
    // A patch into this Unit is judged by the file it writes, not by its code,
    // which may name another Unit's folder.
    const mentions = "*** Begin Patch\n*** Add File: construction/U03-scoring/result.ts\n+import { score } from \"../U05-api/score.ts\"; // construction/U05-api/score.ts\n*** End Patch";
    for (const command of [
      `apply_patch <<'PATCH'\n${patch("construction/U03-scoring/result.md")}\nPATCH`,
      `apply_patch <<'PATCH'\n${mentions}\nPATCH`,
      `apply_patch '${mentions.replaceAll('"', "'\\''")}'`,
    ]) {
      const own = bash(command);
      expect(own.code, `${command}\n${own.stderr}`).toBe(0);
    }
    // The same code written with cat or printf is read by its text, as on main.
    for (const [command, code] of [
      ["cat > construction/U03-scoring/result.ts <<'EOF'\nimport { score } from \"../U05-api/score.ts\"; // construction/U05-api/score.ts\nEOF", 2],
      ["printf '// construction/U05-api/score.ts' > construction/U03-scoring/result.ts", 0],
    ] as const) {
      expect(bash(command).code, command).toBe(code);
    }
  });

  test("claimed checkout Bash matching follows the dispatch matcher", () => {
    const proj = scratchProject();
    seedUnitScope(proj);
    const foreign = runHook(proj, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "touch Construction/u05-API/result.md" },
    });
    expect(foreign.code).toBe(2);
    expect(foreign.stderr).toContain("Construction/u05-API/result.md");

    const current = runHook(proj, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "touch construction/u03-SCORING/result.md" },
    });
    expect(current.code).toBe(0);
  });

  test("a claimed checkout lets reads and searches through, and its write refusal names where the change can be made", () => {
    // A search in the person's own checkout was refused as a "cross-unit write",
    // and the refusal named no way forward.
    const proj = scratchProject();
    seedUnitScope(proj);
    for (const command of ["ls", "rg formatPrice", "find . -name '*.md'", "grep -rn formatPrice .", "cat construction/u05-API/design.md"]) {
      const r = runHook(proj, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      expect(r.code, `${command}: ${r.stderr}`).toBe(0);
    }
    const write = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch Construction/u05-API/result.md" } };
    const refused = runHook(proj, write);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("make that change from the project's main checkout");
    // The named step works: the main checkout carries no Unit stamp, and the write goes through there.
    rmSync(join(proj, "aidlc", ".aidlc-unit-scope.json"));
    expect(runHook(proj, write).code).toBe(0);
  });

  test("a merged cell alone, without the landing in the checkout's history, keeps a claimed checkout held", () => {
    const proj = scratchProject();
    seedUnitScope(
      proj,
      "U03-scoring",
      "\n## Unit Progress\n| unit | owner | code-generation | merged |\n| --- | --- | --- | --- |\n" +
        "| U03-scoring | t221 | [x] | [x] |\n",
    );
    const r = runHook(proj, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch Construction/u05-API/result.md" } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('scoped to Unit "U03-scoring"');
  });

  test.each([
    ["relaxed policy", "- **Guard Policy**: relaxed (set by you)\n", {}],
    ["off policy", "- **Guard Policy**: off (set by you)\n", {}],
    ["per-work reviewer switch", "- **Guards Off**: reviewer-scope (set by you)\n", {}],
    ["reviewer environment escape hatch", "", { AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "1" }],
  ])(
    "claimed checkout ownership remains enforced under %s",
    (_label, settings, env) => {
      const proj = scratchProject();
      seedUnitScope(proj, "U03-scoring", settings);
      const r = runHook(proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "construction/U05-api/result.md" },
      }, env);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('scoped to Unit "U03-scoring"');
    },
  );

  test("garbage stdin fails open", () => {
    const proj = scratchProject();
    seedRecord(proj);
    const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-reviewer-scope.ts")], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    const shardPath = seedAuditShard(proj);
    const r = runHook(proj, SIBLING_SWEEP);
    expect(r.code).toBe(2);
    const shard = readFileSync(shardPath, "utf-8");
    expect(shard).toContain("REVIEWER_SCOPE_BLOCKED");
    expect(shard).toContain("construction/*/*/*.md");
    expect(shard).toContain("U03-scoring");
  });
});

// ---------------------------------------------------------------------------
// A checkout the work records for its review (`intent add-checkout`): read from
// the folder the tool runs in, its files are the work's own, never a Unit's
// folder. Read from the Unit's folder, "../shop-web/app.js" would name a Unit
// called shop-web; a sibling Unit's files, a sweep across Units and a wildcard
// that reaches the record stay refused.
// ---------------------------------------------------------------------------

describe("t221 (a) a checkout recorded for the work", () => {
  const BESIDE: ScopeContext = { ...SCOPE_CONTEXT, checkouts: [join(REPO_ROOT, "..", "shop-web")] };
  const TWO: ScopeContext = { ...BESIDE, checkouts: [...(BESIDE.checkouts ?? []), join(REPO_ROOT, "..", "shop-api")] };
  // A project that is a folder of a larger repository, with that repository recorded.
  const PARENT: ScopeContext = { ...SCOPE_CONTEXT, checkouts: [join(REPO_ROOT, "..")] };
  const judge = (tool: string, input: Record<string, unknown>, context: ScopeContext) =>
    evaluateReviewerScope(tool, input, DISPATCH, context);

  const opens: Array<[string, string, Record<string, unknown>, ScopeContext]> = [
    ["Read by the path from the project", "Read", { file_path: "../shop-web/app.js" }, BESIDE],
    ["Read with backslashes, which split folders on Windows", "Read", { file_path: "..\\shop-web\\app.js" }, BESIDE],
    ["cat by the path from the project", "Bash", { command: "cat ../shop-web/app.js" }, BESIDE],
    ["a search rooted in it", "Bash", { command: "rg -n wishlist ../shop-web" }, BESIDE],
    ["its tests run from inside it", "Bash", { command: "cd ../shop-web && node --test && cat app.js" }, BESIDE],
    ["a listing of it", "Bash", { command: "ls ../shop-web" }, BESIDE],
    ["Grep rooted in it", "Grep", { pattern: "wishlist", path: "../shop-web" }, BESIDE],
    ["Glob rooted in it", "Glob", { pattern: "**/*.js", path: "../shop-web" }, BESIDE],
    ["a wildcard below it", "Bash", { command: "cat ../shop-web/test/*.test.js" }, BESIDE],
    ["the reviewer's own Edit there", "Edit", { file_path: "../shop-web/app.js" }, BESIDE],
    ["the second of two checkouts", "Read", { file_path: "../shop-api/routes.js" }, TWO],
    ["a wildcard below a folder of a checkout that holds the project", "Bash", { command: "cat ../web/test/*.test.js" }, PARENT],
    ["a bracketed folder in a checkout that holds the project", "Read", { file_path: "../web/app/[id]/page.tsx" }, PARENT],
    ["a catch-all route folder", "Read", { file_path: "../shop-web/app/api/auth/[...nextauth]/route.ts" }, BESIDE],
    ["an optional catch-all route folder", "Read", { file_path: "../shop-web/app/[[...slug]]/page.tsx" }, BESIDE],
  ];
  for (const [name, tool, input, context] of opens) {
    test(`opens: ${name}`, () => {
      expect(judge(tool, input, context)).toEqual({ block: false });
    });
  }

  const refused: Array<[string, string, Record<string, unknown>, ScopeContext]> = [
    ["the same read when no checkout is recorded", "Read", { file_path: "../shop-web/app.js" }, SCOPE_CONTEXT],
    ["a sibling Unit's file", "Read", { file_path: "construction/U01-infra/functional-design/design2.md" }, BESIDE],
    ["a sweep from the project's parent, recorded as a checkout", "Bash", { command: "rg x .." }, PARENT],
    ["a listing of the project's parent", "Bash", { command: "tree .." }, PARENT],
    ["a search in the project's parent", "Bash", { command: "git -C .. grep x" }, PARENT],
    ["a wildcard over the project's parent", "Bash", { command: "rg -n x ../*" }, PARENT],
    ["a brace group that climbs back to the project", "Bash", { command: "rg -n x ../shop-web/{src,../shop}" }, BESIDE],
    ["a brace group that climbs two folders back to the project", "Bash", { command: "rg -n x ../shop-web/src/{lib,../../shop}" }, BESIDE],
    ["a dot-led pattern a shell may expand to the folder above", "Bash", { command: "rg -n x ../shop-web/.*" }, BESIDE],
    ["a folder whose name starts with the checkout's", "Read", { file_path: "../shop-web2/app.js" }, BESIDE],
    ["a sibling Unit read from the Unit's folder", "Read", { file_path: "../U01-infra/functional-design/design2.md" }, { ...CURRENT_UNIT_CONTEXT, checkouts: PARENT.checkouts }],
    ["a Unit named like the checkout, read from the Unit's folder", "Read", { file_path: "../shop-web/design.md" }, { ...CURRENT_UNIT_CONTEXT, checkouts: BESIDE.checkouts }],
    ["a sibling Unit by the path from its Unit when no folder is known", "Read", { file_path: "../U01-infra/design.md" }, { recordRoot: RECORD_ROOT, checkouts: PARENT.checkouts }],
    ["a sibling Unit's copy inside a checkout of the same repository", "Read", { file_path: "../shop-wt/aidlc/spaces/default/intents/x/construction/U01-infra/design.md" }, { ...SCOPE_CONTEXT, checkouts: [join(REPO_ROOT, "..", "shop-wt")] }],
    ["a checkout folder named construction", "Read", { file_path: "../shop-web/construction/page.js" }, BESIDE],
  ];
  for (const [name, tool, input, context] of refused) {
    test(`stays refused: ${name}`, () => {
      expect(judge(tool, input, context).block).toBe(true);
    });
  }

  // With no path the search starts in the project, a sweep across Units: refused,
  // naming the root it falls back to, not the pattern.
  for (const [name, tool, input] of [
    ["a Glob with only a pattern", "Glob", { pattern: "../shop-web/**/*.js" }],
    ["a Grep with only a glob", "Grep", { pattern: "x", glob: "../shop-web/**/*.js" }],
    ["rg with only a glob", "Bash", { command: "rg -g '../shop-web/**' x" }],
  ] as Array<[string, string, Record<string, unknown>]>) {
    test(`a pathless search names its default root: ${name}`, () => {
      expect(judge(tool, input, BESIDE)).toEqual({ block: true, target: ".", defaulted: true, above: true });
    });
  }

  // The folder a command runs in is followed through `cd <dir>`, not undone at a
  // closing parenthesis: the last search below is read as rooted where the cd
  // went, for a checkout as for a folder inside the project.
  test("a search after a subshell's cd is read in the folder the cd named", () => {
    expect(judge("Bash", { command: "(cd src && npm test); rg x" }, BESIDE).block).toBe(false);
    expect(judge("Bash", { command: "(cd ../shop-web && npm test); rg x" }, BESIDE).block).toBe(false);
  });
});

describe("t221 (b) a checkout recorded for the work (shipped hook, subprocess)", () => {
  afterEach(() => cleanupLayouts());

  // A shop project at Code Generation with its web repository beside it,
  // recorded with `intent add-checkout ../shop-web` after the stage started,
  // and a review of the Unit in flight.
  function shopWithWeb(): { proj: string; base: string } {
    const base = tempDir("t221-shop-");
    const proj = join(base, "shop");
    mkdirSync(proj);
    seedWorkspaceShell(proj);
    workspace("", proj);
    startCodeGeneration(proj, true);
    commitRecords(proj);
    for (const name of ["shop-web", "shop-api"]) webRepo(join(base, name));
    const added = checkoutCommand(proj, "add-checkout", "../shop-web");
    expect(added.rc, added.out).toBe(0);
    mkdirSync(dirname(reviewerDispatchPath(proj)), { recursive: true });
    writeFileSync(reviewerDispatchPath(proj), JSON.stringify({
      reviewer: "aidlc-architecture-reviewer-agent",
      stage: "code-generation",
      unit: UNIT,
      exempt: [],
    }));
    return { proj, base };
  }

  function webRepo(dir: string): void {
    mkdirSync(join(dir, "test"), { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t221@example.com"]);
    git(dir, ["config", "user.name", "t221"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "app.js"), "export const app = 1;\n");
    writeFileSync(join(dir, "test", "app.test.js"), "// app\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "web"]);
  }

  function reviewer(proj: string, tool: string, input: Record<string, unknown>): { code: number; stderr: string } {
    const r = spawnSync(BUN, [join(AIDLC_SRC, "hooks", "aidlc-reviewer-scope.ts")], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        agent_type: "aidlc-architecture-reviewer-agent",
        cwd: proj,
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
    });
    return { code: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

  const READS: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: "../shop-web/app.js" }],
    ["Bash", { command: "cat ../shop-web/app.js ../shop-web/test/app.test.js" }],
    ["Bash", { command: "cd ../shop-web && node --test" }],
    ["Grep", { pattern: "app", path: "../shop-web" }],
    ["Glob", { pattern: "**/*.js", path: "../shop-web" }],
  ];

  test("the reviewer reads and tests the recorded checkout by its path from the project, with nothing refused", () => {
    const { proj } = shopWithWeb();
    for (const [tool, input] of READS) {
      const r = reviewer(proj, tool, input);
      expect(r.code, `${tool} ${JSON.stringify(input)}: ${r.stderr}`).toBe(0);
      expect(r.stderr).toBe("");
    }
    expect(rows(proj, "REVIEWER_SCOPE_BLOCKED")).toEqual([]);
    const sibling = reviewer(proj, "Read", {
      file_path: join(seededRecordDir(proj), "construction", "billing", "code-generation", "code-summary.md"),
    });
    expect(sibling.code).toBe(2);
    expect(sibling.stderr).toContain("because it belongs to another unit; the current review covers");
  });

  test("under Guard Policy off a read of the checkout is no step past the check, and a sibling Unit's read still is", () => {
    const { proj } = shopWithWeb();
    setGuardPolicy(proj, "off", "set by you");
    for (const [tool, input] of READS) expect(reviewer(proj, tool, input).code).toBe(0);
    expect(rows(proj, "GUARD_STOOD_ASIDE")).toEqual([]);
    const sibling = reviewer(proj, "Read", {
      file_path: join(seededRecordDir(proj), "construction", "billing", "code-generation", "code-summary.md"),
    });
    expect(sibling.code).toBe(0);
    expect(rows(proj, "GUARD_STOOD_ASIDE")).toHaveLength(1);
  });

  test("remove-checkout closes it again at the next call, with the words a folder nobody recorded gets", () => {
    const { proj } = shopWithWeb();
    expect(reviewer(proj, "Read", { file_path: "../shop-web/app.js" }).code).toBe(0);
    expect(checkoutCommand(proj, "remove-checkout", "../shop-web").rc).toBe(0);
    const closed = reviewer(proj, "Read", { file_path: "../shop-web/app.js" });
    expect(closed.code).toBe(2);
    expect(closed.stderr).toContain('This review cannot open "../shop-web/app.js" because it belongs to another unit');
  });

  test("a search refused for starting at the project folder names the folders to start in, and the named start passes", () => {
    const { proj } = shopWithWeb();
    mkdirSync(join(proj, "src"));
    const refused = reviewer(proj, "Bash", { command: 'find . -iname "*app*" -not -path "*/aidlc/*"' });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('This review cannot open "." because a search or a listing that starts there runs through every unit\'s folder;');
    const unitFolder = toPosix(join(seededRecordDir(proj), "construction", UNIT));
    expect(refused.stderr).toContain(`Start it lower instead: in ${unitFolder} for this unit's documents, or in one of these: src.\n`);
    expect(rows(proj, "REVIEWER_SCOPE_BLOCKED")).toHaveLength(1);
    // The named steps work.
    expect(reviewer(proj, "Bash", { command: 'find src -iname "*app*"' }).code).toBe(0);
    expect(reviewer(proj, "Bash", { command: `find ${unitFolder} -name "*.md"` }).code).toBe(0);
    expect(rows(proj, "REVIEWER_SCOPE_BLOCKED")).toHaveLength(1);
  });

  test("two recorded checkouts are both open", () => {
    const { proj } = shopWithWeb();
    expect(checkoutCommand(proj, "add-checkout", "../shop-api").rc).toBe(0);
    expect(reviewer(proj, "Read", { file_path: "../shop-web/app.js" }).code).toBe(0);
    expect(reviewer(proj, "Read", { file_path: "../shop-api/app.js" }).code).toBe(0);
  });

  test("a checkout recorded through a link is open by the path typed", () => {
    const { proj, base } = shopWithWeb();
    symlinkSync(join(base, "shop-api"), join(base, "api-link"), process.platform === "win32" ? "junction" : "dir");
    expect(checkoutCommand(proj, "add-checkout", "../api-link").rc).toBe(0);
    expect(reviewer(proj, "Read", { file_path: "../api-link/app.js" }).code).toBe(0);
    // The link now leads somewhere nobody recorded: that spelling opens nothing.
    renameSync(join(base, "api-link"), join(base, "api-link-before"));
    webRepo(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(base, "api-link"), process.platform === "win32" ? "junction" : "dir");
    expect(reviewer(proj, "Read", { file_path: "../api-link/app.js" }).code).toBe(2);
  });

  test("a Unit taken into this checkout still writes only its own folder: the write bound reads as before", () => {
    const { proj } = shopWithWeb();
    writeFileSync(seededStateFile(proj), `${readFileSync(seededStateFile(proj), "utf-8").trimEnd()}\n- **Unit Ownership**: team\n`);
    writeFileSync(join(proj, "aidlc", ".aidlc-unit-scope.json"), `${JSON.stringify({
      version: 1,
      space: "default",
      intent_uuid: "00000000-0000-4000-8000-000000000221",
      intent_id8: "00000000",
      unit: UNIT,
      owner: "t221",
      generation: 1,
      nonce: "t221-nonce",
      claim_ref: `refs/heads/claim/00000000/${UNIT}`,
      claim_oid: "1".repeat(40),
      claimed_from_oid: "2".repeat(40),
      integration_ref: "refs/heads/main",
      gate_rhythm: "per-stage",
    })}\n`);
    const r = spawnSync(BUN, [join(AIDLC_SRC, "hooks", "aidlc-reviewer-scope.ts")], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "../shop-web/app.js" }, cwd: proj }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`refusing cross-unit write target "../shop-web/app.js"`);
    const shard = rows(proj, "REVIEWER_SCOPE_BLOCKED");
    expect(shard.map((row) => auditBlockField(row.block, "Stage"))).toEqual(["claimed-checkout"]);
  });
});

// ---------------------------------------------------------------------------
// (c) Registration + protocol prose pins.
// ---------------------------------------------------------------------------

describe("t221 (c) harness registration and protocol prose", () => {
  test("Claude settings.json wires the hook inside the one PreToolUse guard group", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "claude-settings",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const s = JSON.parse(readFileSync(join(harness.engineRoot, "settings.json"), "utf-8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const groups = s.hooks?.PreToolUse ?? [];
      // One process runs the PreToolUse checks (#2066): the read bound is a
      // member of the guard group, and keeps the matcher its own row had.
      const group = groups.find((g) =>
        (g.hooks ?? []).some(
          (h) => h.command ===
            withCopyLaunchOptions(`bun "$CLAUDE_PROJECT_DIR/${harness.manifest.harnessDir}/tools/aidlc.ts" engine hook guard-tool-call`),
        ),
      );
      expect(group, harness.name).toBeDefined();
      expect(
        groups.some((g) =>
          (g.hooks ?? []).some((h) => h.command?.endsWith(" engine hook reviewer-scope"))
        ),
        harness.name,
      ).toBe(false);
      const member = (hookGroupMembers("guard-tool-call") ?? [])
        .find((entry) => entry.hook === "reviewer-scope");
      expect(member?.matcher, harness.name).toBe(
        "^(?:Read|NotebookRead|Edit|MultiEdit|Write|NotebookEdit|LS|Glob|Grep|Bash)$",
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
        const reviewerEntries = entries.filter((entry) =>
          entry.command?.includes("aidlc.ts engine adapter kiro reviewer-scope")
        );
        expect(reviewerEntries.length, `${harness.name}/${agent}`).toBe(3);
        const matchers = reviewerEntries.map((e) => e.matcher).sort();
        expect(matchers).toEqual(["execute_bash", "fs_read", "fs_write"]);
        for (const e of reviewerEntries) {
          // The registration passes its own agent name so the adapter forwards
          // a real identity instead of a bare scoped_registration.
          expect(e.command).toBe(withCopyLaunchOptions(
            `bun ${harness.manifest.harnessDir}/tools/aidlc.ts engine adapter kiro reviewer-scope ${agent}${kiroManifest.hookCommandSuffix}`,
          ));
        }
        expect(
          entries.some((entry) =>
            entry.command?.includes(`aidlc.ts engine adapter kiro state-transition-guard ${agent}`)
          ),
          `${harness.name}/${agent}`,
        ).toBe(true);
      }
    }
  });

  test("Kiro IDE ships NO reviewer-scope registration (documented gap: tool inputs are not uniform)", () => {
    // Tool inputs are not uniformly available across the IDE generations this
    // harness supports (docs/reference/kiro-ide-hook-payload.md): 0.12 and the
    // measured 1.x PostToolUse captures carry empty inputs, while later 1.x
    // builds populate some PreToolUse inputs. A preToolUse hook cannot rely on
    // seeing the attempted path or command on every supported build, so there
    // is no stable target to match. Per the porting guide, an unenforceable seam ships NO registration
    // rather than a dead hook - the 12a prose bound governs on that harness.
    // This pins the deliberate absence so a future blanket-registration sweep
    // does not wire an inert (or worse, blindly blocking) entry.
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "unsupported",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      // Both wiring generations: the legacy .kiro.hook and the v2 hook JSON.
      expect(existsSync(join(harness.engineRoot, "hooks", "aidlc-reviewer-scope.kiro.hook"))).toBe(
        false,
      );
      expect(existsSync(join(harness.engineRoot, "hooks", "aidlc-reviewer-scope.json"))).toBe(
        false,
      );
    }
  });

  test("Copilot .github/hooks/aidlc.json wires the adapter's guard-tool-call target on PreToolUse", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "copilot-hooks",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const wiring = JSON.parse(
        readFileSync(join(harness.distRoot, ".github", "hooks", "aidlc.json"), "utf-8"),
      ) as { hooks: Record<string, Array<{ bash?: string; matcher?: string }>> };
      const pre = wiring.hooks.PreToolUse ?? [];
      // ONE matcher-free guard-tool-call registration serves both guards (the
      // adapter runs state-transition-guard then reviewer-scope): VS Code
      // parses but IGNORES matchers, so the target self-filters instead.
      expect(
        pre.some((h) =>
          (h.bash ?? "").endsWith("aidlc-copilot-adapter.ts guard-tool-call")
        ),
        harness.name,
      ).toBe(true);
      for (const h of pre) expect(h.matcher, harness.name).toBeUndefined();
    }
  });

  test("Codex hooks.json wires the reviewer-scope bound through the one matcher-free guard-tool-call group", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "codex-hooks",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const wiring = JSON.parse(
        readFileSync(join(harness.engineRoot, "hooks.json"), "utf-8"),
      ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
      const pre = wiring.hooks.PreToolUse ?? [];
      // One process runs the five PreToolUse checks (#2066); the adapter's
      // reviewer-scope case is a member of that group, not its own handler.
      const group = pre.filter((g) =>
        g.hooks.some(
          (h) => h.command ===
            withCopyLaunchOptions(`bun ${harness.manifest.harnessDir}/tools/aidlc.ts engine adapter codex guard-tool-call`),
        ),
      );
      expect(group, harness.name).toHaveLength(1);
      expect(group[0]?.matcher, harness.name).toBeUndefined();
      expect(
        pre.some((g) => g.hooks.some((h) => h.command.endsWith(" adapter codex reviewer-scope"))),
        harness.name,
      ).toBe(false);
    }
  });

  test("Cursor hooks.json wires the adapter's guards target on preToolUse", () => {
    const harnesses = HARNESS_MATRIX.filter(
      (harness) => harness.capabilities.reviewerScopeRegistration === "cursor-hooks",
    );
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      // Cursor's schema is camelCase and matcher-free; the single "guards"
      // target runs the state-transition guard AND the reviewer-scope bound
      // (adapter-ordered, mirroring the Claude settings.json registration).
      const wiring = JSON.parse(
        readFileSync(join(harness.engineRoot, "hooks.json"), "utf-8"),
      ) as { hooks: Record<string, Array<{ command: string }>> };
      const pre = wiring.hooks.preToolUse ?? [];
      expect(
        pre.some(
          (h) =>
            h.command ===
            withCopyLaunchOptions(`bun ${harness.manifest.harnessDir}/hooks/aidlc-cursor-adapter.ts guards`),
        ),
      ).toBe(true);
      const adapter = readFileSync(
        join(harness.engineRoot, "hooks", "aidlc-cursor-adapter.ts"),
        "utf-8",
      );
      expect(adapter).toContain("aidlc-reviewer-scope.ts");
      expect(adapter).toContain("aidlc-state-transition-guard.ts");
    }
  });

  test("reviewer protocol module carries the dispatch-record write, and leaves the delete to the engine", () => {
    // The dispatch record is per Unit, so it is in the per-Unit review module.
    const body = readFileSync(
      join(
        AIDLC_SRC,
        "aidlc-common",
        "protocols",
        "stage-protocol-reviewer-unit.md",
      ),
      "utf-8",
    );
    expect(body).toContain(".aidlc-engine/reviewer-dispatch.json");
    // Step 1: the write, owed per unit under a run-stage AND under a swarm
    // (the hook's perUnitReviewOwed mirrors both), exempt list carries the carve-out.
    expect(body).toMatch(/\*\*Dispatch record \([^)]*enforcement-capable harnesses only\)\.\*\*/);
    expect(body).toMatch(/`directive\.unit` present, or one unit of an `invoke-swarm`/);
    expect(body).toMatch(/append its path to `exempt`/);
    expect(body).toContain("On a harness without reviewer-scope enforcement");
    expect(body).toContain("do not write the record");
    // Step 3: the engine removes the record as it records the verdict
    // (aidlc-log.ts review --verdict); the agent is never told to delete it,
    // so no `rm` and no permission card follows a review.
    expect(body).toMatch(/the engine removes it when the verdict is recorded at step 3; never delete it yourself/);
    expect(body).not.toMatch(/delete `<record>\/\.aidlc-engine\/reviewer-dispatch\.json`/);
  });

  test("harnesses with reviewer-scope enforcement point at the shared module", () => {
    for (const harness of HARNESS_MATRIX.filter(
      (entry) => entry.capabilities.reviewerScopeRegistration !== "unsupported",
    )) {
      const body = readConductorSurface(join(harness.authoredRoot, "skills", "aidlc", "SKILL.md"));
      const labelled = `harness ${harness.name}: ${body}`;
      expect(labelled).toContain("stage-protocol-reviewer.md");
    }
  });

  test("Kiro IDE documents its prose-only reviewer bound and omits the unused record", () => {
    const body = readConductorSurface(join(REPO_ROOT, "harness", "kiro-ide", "skills", "aidlc", "SKILL.md"));
    expect(body).toContain("stage-protocol-reviewer.md");
    expect(body).not.toContain(".aidlc-engine/reviewer-dispatch.json");
    expect(body).not.toContain("reviewer-scope PreToolUse hook enforces");
  });
});

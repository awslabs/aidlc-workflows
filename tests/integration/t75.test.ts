// covers: subcommand:aidlc-state:practices-promote
//
// CLI-contract port of tests/integration/t75-practices-promote.sh (TAP plan 24),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts practices-promote ...` is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on res.status / res.stdout (the JSON envelope) / the
// combined stdout+stderr (mirrors the .sh's 2>&1) AND the on-disk effects the
// tool produces (aidlc-team.md replaceSection x5, aidlc-project.md
// appendUnderHeading x2 with `(affirmed YYYY-MM-DD)` stamps, the audit.md
// PRACTICES_AFFIRMED / PRACTICES_OVERRIDE rows). The contract under test is
// the PROCESS boundary plus those file effects, so it stays a spawn — an
// in-process handlePracticesPromote() twin would lose the exit-code half the
// .sh relies on (the fail() path is error() -> process.exit(1),
// aidlc-state.ts:1140) AND the JSON-ack-to-stdout half (Case A test 2).
//
// SUBCOMMAND UNIT: this .cli file credits the single subcommand unit the .sh
// exercises — `aidlc-state practices-promote` (covers KEY
// subcommand:aidlc-state:practices-promote, the colon form). minMechanism is
// cli per the coverage registry, matched by the spawn mechanism here.
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_fixture + cleanup_test_project
// per case): each case builds a FRESH temp project dir via createTestProject
// (which toPortablePath-converts on Windows so the audit.md the tool writes
// through toPosix path helpers round-trips when read back). make_fixture's
// .claude/rules/{aidlc-team.md,aidlc-project.md} live targets + the two
// active-record inception/practices-discovery/ drafts are reproduced byte-for-byte
// from the .sh heredocs. NOTHING is written under tests/fixtures/**. All temp
// dirs cleaned in afterAll.
//
// PARITY NOTES (every .sh `ok` line / assert maps to an expect() below; the
// .sh plan is 24; several asserts here are STRONGER than the original grep):
//   Case A (happy path) — .sh tests 1-15:
//     - exit 0 (assert_eq EXIT_A 0)                    -> A: r.status === 0.
//     - stdout JSON '"emitted":"PRACTICES_AFFIRMED"'   -> A: r.stdout contains.
//     - team.md Way of Working / Testing / Code Style replaced (3 grep)
//                                                       -> A: file contains all 3.
//     - team.md OLD Way/Code Style removed (2 not_grep) -> A: file lacks both.
//     - project.md Mandated + Forbidden rule w/ date    -> A: file contains both
//       stamps (2 grep, "(affirmed $TODAY)")              with the literal TODAY.
//     - audit file exists                                -> A: existsSync.
//     - audit contains PRACTICES_AFFIRMED                -> A: event count >= 1
//       (STRONGER: counts the row rather than a bare presence grep).
//     - audit "Affirming User.*test-user"                -> A: auditField
//       "Affirming User" === "test-user" (STRONGER, exact block-scoped value).
//     - audit "Sections Written"                         -> A: auditField
//       "Sections Written" non-empty AND equals all 5 names (STRONGER).
//   Case B (missing draft fails closed) — .sh tests 16-19:
//     - exit non-zero (assert_not_eq)                    -> B: r.status !== 0.
//     - error "team-practices draft not found"           -> B: r.out contains.
//     - audit records PRACTICES_OVERRIDE                 -> B: event count >= 1
//       (the .sh branches on audit existence; the tool always emits, so we
//       assert presence directly — STRONGER, no conditional skip).
//     - team.md untouched (OLD content present)          -> B: file contains OLD.
//   Case C (missing target fails closed, atomicity) — .sh tests 20-21:
//     - exit non-zero                                    -> C: r.status !== 0.
//     - error "aidlc-project.md not found"               -> C: r.out contains.
//     - team.md NOT written (no NEW content)             -> C: file lacks NEW.
//   Case D (partial draft) — .sh tests 22-23 (counts as 4 .sh asserts):
//     - Way of Working / Testing replaced                -> D: file contains both.
//     - Walking Skeleton / Deployment untouched          -> D: file contains both OLD.
//   Case E (idempotency) — .sh test 24:
//     - team.md identical across two runs                -> E: byte-equal reads.
//     - project.md identical across two runs             -> E: stronger retry guard.
//
// 24 .sh asserts -> 24+ expect()-bearing checks here, grouped into 5
// describe-blocks mirroring the .sh's Cases A-E.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { memoryDirFor } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// --- make_fixture (t75:42-130): a clean project with .claude/rules/ live
// targets + the two practices-discovery drafts. Byte-for-byte from the .sh
// heredocs. ---

const TEAM_MD_LIVE = `# Team-Level Rules

> This team's affirmed practices and corrections.

## Way of Working

OLD_WAY_OF_WORKING_TEXT

## Walking Skeleton

OLD_WALKING_TEXT

## Testing Posture

OLD_TESTING_TEXT

## Deployment

OLD_DEPLOYMENT_TEXT

## Code Style

OLD_CODE_STYLE_TEXT
`;

const PROJECT_MD_LIVE = `# Project-Level Rules

## Decided

## Tech Stack

## Mandated

## Forbidden
`;

const TEAM_PRACTICES_DRAFT = `# Team Practices Draft

## Way of Working

NEW_WAY_OF_WORKING_TEXT

## Walking Skeleton

NEW_WALKING_TEXT

## Testing Posture

NEW_TESTING_TEXT

## Deployment

NEW_DEPLOYMENT_TEXT

## Code Style

NEW_CODE_STYLE_TEXT
`;

const DISCOVERED_RULES_DRAFT = `# Discovered Rules

## Mandated

ALWAYS use Result<T,E> for fallible operations
ALWAYS write tests before implementation

## Forbidden

NEVER throw exceptions across service boundaries
NEVER skip CI gates
`;

const PRACTICES_SUPPORTS = [
  "aidlc-quality-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
] as const;

interface Fixture {
  proj: string;
  teamMd: string; // aidlc/spaces/default/memory/team.md
  projectMd: string; // aidlc/spaces/default/memory/project.md
  teamPracticesPath: string;
  discoveredRulesPath: string;
}

function makeFixture(): Fixture {
  const proj = createTestProject();
  tempDirs.push(proj);

  // P6: practices-promote writes the relocated method files the resolver reads
  // (aidlc/spaces/<space>/memory/{team,project}.md, neutral names) — NOT the old
  // .claude/rules/aidlc-{team,project}.md. memoryDirFor() is the default target.
  const memDir = memoryDirFor(proj);
  const draftDir = join(
    seededRecordDir(proj),
    "inception",
    "practices-discovery",
  );
  mkdirSync(memDir, { recursive: true });
  mkdirSync(draftDir, { recursive: true });

  const teamMd = join(memDir, "team.md");
  const projectMd = join(memDir, "project.md");
  const teamPracticesPath = join(draftDir, "team-practices.md");
  const discoveredRulesPath = join(draftDir, "discovered-rules.md");

  writeFileSync(teamMd, TEAM_MD_LIVE, "utf-8");
  writeFileSync(projectMd, PROJECT_MD_LIVE, "utf-8");
  writeFileSync(teamPracticesPath, TEAM_PRACTICES_DRAFT, "utf-8");
  writeFileSync(discoveredRulesPath, DISCOVERED_RULES_DRAFT, "utf-8");
  const contributionsDir = join(draftDir, "contributions");
  mkdirSync(contributionsDir, { recursive: true });
  for (const agent of PRACTICES_SUPPORTS) {
    writeFileSync(
      join(contributionsDir, `${agent}.md`),
      `**Collaborator:** ${agent}\n\n## Contribution\n\nFixture evidence.\n`,
      "utf-8",
    );
  }

  // P9: practices-promote emits PRACTICES_AFFIRMED/OVERRIDE into the ACTIVE
  // INTENT's audit shard (appendAuditEvent → resolved record). Seed a state file
  // into the record so the active-intent cursor resolves it — otherwise the emit
  // falls back to the bare space root and seededAuditShard reads nothing.
  writeFileSync(
    seededStateFile(proj),
    "# AI-DLC State Tracking\n\n" +
      "## Project Information\n" +
      "- **Practices Affirmed Timestamp**: [ISO 8601 timestamp on affirmation]\n\n" +
      "## Current Status\n" +
      "- **Scope**: feature\n",
    "utf-8",
  );

  return { proj, teamMd, projectMd, teamPracticesPath, discoveredRulesPath };
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/**
 * run_promote (t75:132-140): bun STATE_TS practices-promote --project-dir <p>
 * --team-practices <draft> --discovered-rules <draft> --affirming-user test-user,
 * with 2>&1. Mirrors the .sh helper exactly (drafts addressed by their
 * canonical paths under the fixture).
 */
function runPromote(fx: Fixture, ...extra: string[]): CliResult {
  const res = spawnSync(
    BUN,
    [
      STATE_TS,
      "practices-promote",
      "--project-dir",
      fx.proj,
      "--team-practices",
      fx.teamPracticesPath,
      "--discovered-rules",
      fx.discoveredRulesPath,
      "--affirming-user",
      "test-user",
      ...extra,
    ],
    { encoding: "utf-8" },
  );
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

// P9: the per-intent audit shard the practices-promote tool resolves once the
// seeded record resolves (state present). seededAuditShard mirrors auditShardName.
const auditPath = (proj: string): string => seededAuditShard(proj);

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's PRACTICES_* grep, as a count. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators; splits `**label**: value` on
 * the literal `**: ` separator. Mirrors auditField in t31.cli.test.ts. Used to
 * pin "Affirming User" / "Sections Written" exactly (STRONGER than the .sh's
 * substring greps).
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

function auditTimestamp(file: string, ev: string): string {
  if (!existsSync(file)) return "";
  const block = readFileSync(file, "utf-8")
    .split(/\n---\n/)
    .find((candidate) =>
      candidate.split("\n").includes(`**Event**: ${ev}`)
    );
  if (!block) return "";
  const line = block.split("\n").find((candidate) =>
    candidate.startsWith("**Timestamp**: ")
  );
  return line?.slice("**Timestamp**: ".length) ?? "";
}

/** Today in UTC, YYYY-MM-DD. Mirrors the .sh's `date -u +%Y-%m-%d`; the tool
 *  stamps rules via isoTimestamp().slice(0,10) (aidlc-state.ts:1127), the same
 *  UTC calendar day, so the literal-date assertions stay deterministic. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// Case A — happy path (t75:142-176, .sh tests 1-15)
// ============================================================

describe("t75 practices-promote — happy path (migrated from t75-practices-promote.sh, plan 24)", () => {
  test("A: success path emits PRACTICES_AFFIRMED, writes both files, records audit fields", () => {
    const fx = makeFixture();
    const r = runPromote(fx);

    // .sh test 1: exit 0 on success.
    expect(r.status).toBe(0);

    // .sh test 2: stdout JSON reports PRACTICES_AFFIRMED.
    expect(r.stdout).toContain('"emitted":"PRACTICES_AFFIRMED"');
    const state = readFileSync(seededStateFile(fx.proj), "utf-8");
    expect(state).toMatch(
      /^- \*\*Practices Affirmed Timestamp\*\*: \d{4}-\d{2}-\d{2}T/m,
    );

    // .sh test 3: aidlc-team.md got new content for the asserted sections.
    const teamContent = readFileSync(fx.teamMd, "utf-8");
    expect(teamContent).toContain("NEW_WAY_OF_WORKING_TEXT");
    expect(teamContent).toContain("NEW_TESTING_TEXT");
    expect(teamContent).toContain("NEW_CODE_STYLE_TEXT");
    // ...and the OLD content for those sections is gone.
    expect(teamContent).not.toContain("OLD_WAY_OF_WORKING_TEXT");
    expect(teamContent).not.toContain("OLD_CODE_STYLE_TEXT");

    // .sh test 4: aidlc-project.md got the rules with date stamps.
    const today = todayUtc();
    const projectContent = readFileSync(fx.projectMd, "utf-8");
    expect(projectContent).toContain(
      `ALWAYS use Result<T,E> for fallible operations (affirmed ${today})`,
    );
    expect(projectContent).toContain(
      `NEVER throw exceptions across service boundaries (affirmed ${today})`,
    );

    // .sh test 5: audit emitted PRACTICES_AFFIRMED with the right fields.
    const audit = auditPath(fx.proj);
    expect(existsSync(audit)).toBe(true);
    // STRONGER than the bare presence grep: count the row.
    expect(auditEventCount(audit, "PRACTICES_AFFIRMED")).toBeGreaterThanOrEqual(1);
    // STRONGER than `assert_grep "Affirming User.*test-user"`: exact value.
    expect(auditField(audit, "PRACTICES_AFFIRMED", "Affirming User")).toBe(
      "test-user",
    );
    // STRONGER than `assert_grep "Sections Written"`: present AND lists all 5.
    const sectionsWritten = auditField(
      audit,
      "PRACTICES_AFFIRMED",
      "Sections Written",
    );
    expect(sectionsWritten.length).toBeGreaterThan(0);
    expect(sectionsWritten).toBe(
      "Way of Working, Walking Skeleton, Testing Posture, Deployment, Code Style",
    );
    const stateTimestamp = state.match(
      /^- \*\*Practices Affirmed Timestamp\*\*: (.+)$/m,
    )?.[1];
    expect(stateTimestamp).toBe(auditTimestamp(audit, "PRACTICES_AFFIRMED"));
  });
});

// ============================================================
// Case B — missing draft fails closed (t75:178-199, .sh tests 16-19)
// ============================================================

describe("t75 practices-promote — missing draft fails closed", () => {
  test("B: missing team-practices draft -> exit non-zero, PRACTICES_OVERRIDE, targets untouched", () => {
    const fx = makeFixture();
    // rm the team-practices draft (t75:180).
    rmDraft(fx.teamPracticesPath);

    const r = runPromote(fx);

    // .sh test 16: exit non-zero.
    expect(r.status).not.toBe(0);
    // .sh test 17: error message identifies the file.
    expect(r.out).toContain("team-practices draft not found");

    // .sh test 18: audit records PRACTICES_OVERRIDE. The tool always emits on
    // the fail() path before exiting (aidlc-state.ts:1131-1142), so we assert
    // presence directly (STRONGER than the .sh's conditional `[ -f $AUDIT ]`).
    const audit = auditPath(fx.proj);
    expect(auditEventCount(audit, "PRACTICES_OVERRIDE")).toBeGreaterThanOrEqual(1);

    // .sh test 19: targets must be untouched.
    expect(readFileSync(fx.teamMd, "utf-8")).toContain("OLD_WAY_OF_WORKING_TEXT");
  });
});

describe("t75 practices-promote — ensemble evidence fails closed", () => {
  test("missing support contribution leaves both memory targets untouched", () => {
    const fx = makeFixture();
    unlinkSync(
      join(
        fx.teamPracticesPath,
        "..",
        "contributions",
        "aidlc-quality-agent.md",
      ),
    );
    const teamBefore = readFileSync(fx.teamMd, "utf-8");
    const projectBefore = readFileSync(fx.projectMd, "utf-8");

    const r = runPromote(fx);

    expect(r.status).not.toBe(0);
    expect(r.out).toContain("ensemble evidence is incomplete");
    expect(r.out).toContain("aidlc-quality-agent");
    expect(readFileSync(fx.teamMd, "utf-8")).toBe(teamBefore);
    expect(readFileSync(fx.projectMd, "utf-8")).toBe(projectBefore);
    expect(
      auditEventCount(auditPath(fx.proj), "PRACTICES_OVERRIDE"),
    ).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Case C — missing target fails closed before any write, atomicity
// (t75:201-214, .sh tests 20-21)
// ============================================================

describe("t75 practices-promote — missing target fails closed (atomicity)", () => {
  test("C: missing project.md -> exit non-zero, team.md NOT written", () => {
    const fx = makeFixture();
    // rm the project guardrails target (t75:203).
    rmDraft(fx.projectMd);

    const r = runPromote(fx);

    // .sh test 20: exit non-zero.
    expect(r.status).not.toBe(0);
    // .sh test 20b: error names the file.
    expect(r.out).toContain("project.md not found");

    // .sh test 21: team.md must NOT be written when project.md was
    // missing — atomicity rule (read both targets, fail closed before any
    // write, aidlc-state.ts:1163-1165).
    expect(readFileSync(fx.teamMd, "utf-8")).not.toContain(
      "NEW_WAY_OF_WORKING_TEXT",
    );
  });
});

// ============================================================
// Case D — partial draft leaves other sections alone (t75:216-237, .sh 22-23)
// ============================================================

describe("t75 practices-promote — partial draft", () => {
  test("D: only-some-sections draft replaces those, leaves the rest untouched", () => {
    const fx = makeFixture();
    // Rewrite team-practices.md with only Way of Working + Testing Posture
    // (t75:219-229).
    writeFileSync(
      fx.teamPracticesPath,
      `# Team Practices Draft

## Way of Working

PARTIAL_NEW_WAY_OF_WORKING

## Testing Posture

PARTIAL_NEW_TESTING
`,
      "utf-8",
    );

    const r = runPromote(fx);
    expect(r.status).toBe(0); // STRONGER: the .sh discarded stdout (>/dev/null)
    // and never checked the exit; we pin a clean exit before asserting effects.

    const teamContent = readFileSync(fx.teamMd, "utf-8");
    // .sh test 22: the two present sections replaced.
    expect(teamContent).toContain("PARTIAL_NEW_WAY_OF_WORKING");
    expect(teamContent).toContain("PARTIAL_NEW_TESTING");
    // .sh test 23: sections absent from the draft keep their old content.
    expect(teamContent).toContain("OLD_WALKING_TEXT");
    expect(teamContent).toContain("OLD_DEPLOYMENT_TEXT");
  });
});

// ============================================================
// Case E — idempotency of both promotion targets (t75:239-252, .sh test 24)
// ============================================================

describe("t75 practices-promote — idempotency on both memory targets", () => {
  test("E: re-running the same promote leaves team.md and project.md byte-identical", () => {
    const fx = makeFixture();
    const r1 = runPromote(fx);
    expect(r1.status).toBe(0); // STRONGER: .sh discarded stdout; pin clean exit
    const teamFirst = readFileSync(fx.teamMd, "utf-8");
    const projectFirst = readFileSync(fx.projectMd, "utf-8");

    const r2 = runPromote(fx);
    expect(r2.status).toBe(0);
    const teamSecond = readFileSync(fx.teamMd, "utf-8");
    const projectSecond = readFileSync(fx.projectMd, "utf-8");

    // .sh test 24 plus a stronger project-rule retry guard.
    expect(teamSecond).toBe(teamFirst);
    expect(projectSecond).toBe(projectFirst);
  });
});

// --- small helper: delete a fixture file (mirrors the .sh's `rm ...`). Defined
// after use is fine — function declarations hoist. The tool's existsSync check
// then drives the fail-closed path. ---
function rmDraft(path: string): void {
  unlinkSync(path);
}

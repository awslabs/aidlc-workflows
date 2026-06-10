// covers: function:parseMemoryEntries, function:parseMemoryHeadings, subcommand:aidlc-learnings:surface, subcommand:aidlc-learnings:persist
//
// t97 — aidlc-learnings.ts primitives (v0.5.0 milestone 12). Migrated from
// tests/unit/t97-learnings-primitives.sh (TAP plan 32). MIXED file (like
// t66/t18): the six parseMemoryEntries / parseMemoryHeadings cases are PURE
// FUNCTION units — they import the parsers from aidlc-lib.ts and run
// IN-PROCESS (minMechanism: none, zero subprocess). The surface / persist
// cases exercise the CLI PROCESS boundary (exit code + stdout JSON + stderr
// text + on-disk side effects: RULE_LEARNED audit rows, learnings files,
// sensor manifests, stage-frontmatter edits), so they SPAWN the real CLI via
// node:child_process spawnSync(BUN,[TOOL,sub,...args]) at EQUAL fidelity to
// the .sh's `bun "$LEARNINGS_TS" <sub> ...; EC=$?` pattern. Spawning credits
// the `aidlc-learnings surface` + `aidlc-learnings persist` subcommand units
// (minMechanism: cli) that a .none import-twin could not.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     :982  parseMemoryHeadings(raw) -> { interpretations, deviations,
//             tradeoffs, open_questions, total }
//     :1060 parseMemoryEntries(raw)  -> Array<{ heading, ts, summary,
//             context, raw }>  (ONE entry per counted line; the invariant
//             parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total
//             holds for ANY input — no multi-line merge)
//   dist/claude/.claude/tools/aidlc-learnings.ts
//     surface --slug <s> [--project-dir <p>]  -> JSON candidates + parked,
//             or {candidates:[],parked_open_questions:[],skipped:"test-run-mode"};
//             exit 1 on missing --slug / missing state / slug-not-Active.
//     persist --slug <s> --selections-json <p> [--project-dir <p>] -> writes
//             learnings file + RULE_LEARNED audit row (cid-marker idempotency,
//             team/project scope routing, two-write sensor bind, framework-tier
//             rejection, decide-inside-lock recovery, test-run skip); exit 1 on
//             missing --selections-json / framework-distribution sensor path.
//     exit 2 on unknown subcommand / missing subcommand.
//
// IDEMPOTENCY DISCIPLINE (this tool WRITES audit rows): persist appends
// RULE_LEARNED rows and learnings-file lines keyed by a `cid:<slug>:<id>`
// marker. The .sh proves persist-twice produces NO duplicate audit row and NO
// duplicate file line (tests 23/25), and a belt-and-braces recovery (test 24:
// audit row present, file line deleted -> re-write only). Those assertions are
// preserved EXACTLY — spawn twice into a FRESH project per case and grep the
// real audit.md / learnings file so audit state never bleeds across cases.
//
// FIXTURE DISCIPLINE: every persist/surface case scaffolds its own project
// under mkdtempSync(tmpdir()) via the local mkproj() helper (the TS analogue
// of the .sh's mkproj) and removes it after. NOTHING is written under
// tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, 32 assertions, no guarantee dropped):
//   .sh 1-6   parseMemoryEntries (6)  -> in-process function assertions
//   .sh 7-11  subcommand surface (5)  -> spawnSync exit/stdout assertions
//   .sh 12-17 surface (6)             -> spawnSync stdout-JSON assertions
//   .sh 18-26 persist (9, 13 facts)   -> spawnSync + on-disk grep assertions
//             (.sh 22 free-text is BLOCK-SCOPED: the field assertions match
//             the .sh's awk block extraction — fields must be co-located in
//             the one RULE_LEARNED block, not merely present somewhere in
//             audit.md — via extractAuditBlock(), equal-or-stronger isolation)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemoryEntries,
  parseMemoryHeadings,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
  "aidlc-learnings.ts",
);

// =====================================================================
// GROUP 1 — parseMemoryEntries / parseMemoryHeadings (.sh tests 1-6)
//
// PURE FUNCTION, IN-PROCESS. The .sh shelled out to a `pm()` bun harness that
// imported both parsers and printed a derived string; here we import the
// parsers and assert on their return values directly — equal-or-stronger
// fidelity (no string round-trip to lose).
// =====================================================================
describe("t97 parseMemoryEntries (in-process function unit)", () => {
  // .sh 1 — single canonical entry per heading -> {heading, ts, summary, context}
  test("single canonical entry -> {heading, ts, summary, context} parsed", () => {
    const raw =
      "## Interpretations\n" +
      "- 2026-05-28T14:22:11Z — Used BDD format; reviewer prefers it, team standardised.\n" +
      "\n## Deviations\n\n## Tradeoffs\n\n## Open questions\n";
    const e = parseMemoryEntries(raw)[0];
    expect([e.heading, e.ts, e.summary, e.context].join("|")).toBe(
      "Interpretations|2026-05-28T14:22:11Z|Used BDD format|reviewer prefers it, team standardised.",
    );
  });

  // .sh 2 — wrapped two-line entry -> TWO degenerate entries AND length===total
  test("wrapped two-line entry -> TWO entries AND length===total (no merge)", () => {
    const raw =
      "## Deviations\n" +
      "- 2026-05-28T10:00:00Z — first line summary; context here\n" +
      "  continuation wrapped line that is not canonical\n";
    expect(parseMemoryEntries(raw).length).toBe(parseMemoryHeadings(raw).total);
    expect(parseMemoryEntries(raw).length).toBe(2);
  });

  // .sh 3 — code-fenced fake `## Deviations` must NOT parse as heading/entry
  test("code-fenced fake ## Deviations is skipped; length===total", () => {
    const raw =
      "## Interpretations\n" +
      "- 2026-05-28T09:00:00Z — real entry; ctx\n" +
      "```\n" +
      "## Deviations\n" +
      "- 2026-05-28T09:01:00Z — fenced fake; should not count\n" +
      "```\n";
    const e = parseMemoryEntries(raw);
    expect(e.length).toBe(1);
    expect(e.length === parseMemoryHeadings(raw).total).toBe(true);
  });

  // .sh 4 — blank lines under a heading are not entries
  test("blank lines under a heading are skipped; length===total", () => {
    const raw =
      "## Tradeoffs\n\n\n- 2026-05-28T11:00:00Z — only real one; ctx\n\n";
    const e = parseMemoryEntries(raw);
    expect(e.length).toBe(1);
    expect(e.length === parseMemoryHeadings(raw).total).toBe(true);
  });

  // .sh 5 — missing-heading tolerance — no throw, returns whatever exists
  test("missing headings tolerated — never throws", () => {
    const raw = "## Interpretations\n- 2026-05-28T12:00:00Z — lone entry; ctx\n";
    let result: string;
    try {
      result = `no-throw:${parseMemoryEntries(raw).length}`;
    } catch {
      result = "threw";
    }
    expect(result).toBe("no-throw:1");
  });

  // .sh 6 — entry with no `;` separator -> tail becomes summary, context empty
  test("entry with no ; -> tail->summary, context empty", () => {
    const raw =
      "## Deviations\n- 2026-05-28T13:00:00Z — summary with no semicolon separator\n";
    const e = parseMemoryEntries(raw)[0];
    expect(e.summary).toBe("summary with no semicolon separator");
    expect(e.context).toBe("");
  });
});

// =====================================================================
// CLI groups (surface / persist) — per-case fresh project harness.
//
// mkproj() is the TS analogue of the .sh's mkproj: scaffold a minimal project
// tree (active stage = user-stories, phase = inception, one runtime-graph row,
// one authored stage .md). Returns the project dir. Each case gets its own
// dir under a per-file TMP root so audit + learnings writes never bleed.
// =====================================================================
let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "t97-cli-"));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

function mkproj(name: string): string {
  const pd = join(tmpRoot, name);
  mkdirSync(join(pd, "aidlc-docs", "inception", "user-stories"), { recursive: true });
  mkdirSync(join(pd, ".claude", "rules"), { recursive: true });
  mkdirSync(join(pd, ".claude", "skills", "aidlc", "stages", "inception"), {
    recursive: true,
  });
  writeFileSync(
    join(pd, "aidlc-docs", "aidlc-state.md"),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
  writeFileSync(
    join(pd, "aidlc-docs", "runtime-graph.json"),
    `{ "workflow_id": "w1", "scope": "feature", "started_at": "2026-05-28T13:00:00Z",
  "stages": [ { "stage_slug": "user-stories", "memory_path": "aidlc-docs/inception/user-stories/memory.md" } ] }
`,
    "utf-8",
  );
  writeFileSync(
    join(pd, ".claude", "skills", "aidlc", "stages", "inception", "user-stories.md"),
    `---
slug: user-stories
phase: inception
execution: ALWAYS
lead_agent: aidlc-product-agent
support_agents: []
sensors:
  - required-sections
inputs: foo
outputs: bar
---

# User Stories

## Steps
1. do the thing
`,
    "utf-8",
  );
  return pd;
}

// Spawn the real CLI. Mirrors the .sh's `bun "$LEARNINGS_TS" <sub> ...` — env
// (incl. an optional AIDLC_STAGES_DIR seam) is layered onto process.env.
function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { rc: number; stdout: string; stderr: string; out: string } {
  const res = spawnSync(BUN, [TOOL, ...args], {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

function readFile(p: string): string {
  return readFileSync(p, "utf-8");
}
function grepCount(p: string, needle: RegExp | string): number {
  if (!existsSync(p)) return 0;
  const re =
    typeof needle === "string"
      ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      : new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`);
  const lines = readFile(p).split("\n").filter((l) => re.test(l));
  return lines.length;
}

// Block-scoped extractor — the TS analogue of the .sh's awk:
//   awk '/Event.*: RULE_LEARNED/{p=1} p; /^---$/{if(p)exit}'
// Starts capturing at the first line matching the start regex (`Event.*:
// <EVENT>`), keeps capturing each subsequent line, and STOPS at the next
// line that is exactly `---`. Returns the captured block (start line through
// the terminating `---` inclusive), or "" if the start line never appears.
// This pins assertions to fields co-located WITHIN ONE audit block rather
// than anywhere in the file — strictly stronger isolation than a whole-file
// substring check.
function extractAuditBlock(content: string, startRe: RegExp): string {
  const lines = content.split("\n");
  const captured: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock && startRe.test(line)) inBlock = true;
    if (inBlock) {
      captured.push(line);
      if (line === "---") break;
    }
  }
  return captured.join("\n");
}

// =====================================================================
// GROUP 2 — subcommand surface (.sh tests 7-11)
// =====================================================================
describe("t97 subcommand surface (cli)", () => {
  // .sh 7 — --help lists surface + persist
  test("--help lists surface", () => {
    expect(runCli(["--help"]).out).toContain("surface");
  });
  test("--help lists persist", () => {
    expect(runCli(["--help"]).out).toContain("persist");
  });

  // .sh 8 — unknown subcommand -> exit 2
  test("unknown subcommand -> exit 2", () => {
    expect(runCli(["bogus", "--slug", "x"]).rc).toBe(2);
  });

  // .sh 9 — surface missing --slug -> exit 1
  test("surface missing --slug -> exit 1", () => {
    const pd = mkproj("p9");
    expect(runCli(["surface", "--project-dir", pd]).rc).toBe(1);
  });

  // .sh 10 — persist missing --selections-json -> exit 1
  test("persist missing --selections-json -> exit 1", () => {
    const pd = mkproj("p9");
    expect(runCli(["persist", "--slug", "user-stories", "--project-dir", pd]).rc).toBe(1);
  });

  // .sh 11 — --project-dir <missing> on surface -> exit 1 (no state file)
  test("surface with missing project dir -> exit 1", () => {
    expect(
      runCli([
        "surface",
        "--slug",
        "user-stories",
        "--project-dir",
        join(tmpRoot, "does-not-exist"),
      ]).rc,
    ).toBe(1);
  });
});

// =====================================================================
// GROUP 3 — surface (.sh tests 12-17)
// =====================================================================
describe("t97 surface (cli)", () => {
  // .sh 12 — empty memory.md -> candidates: []
  test("empty memory.md -> zero candidates", () => {
    const pd = mkproj("p12");
    writeFileSync(join(pd, "aidlc-docs", "inception", "user-stories", "memory.md"), "", "utf-8");
    const res = runCli(["surface", "--slug", "user-stories", "--project-dir", pd]);
    expect(res.rc).toBe(0);
    const j = JSON.parse(res.stdout);
    expect(j.candidates.length).toBe(0);
  });

  // .sh 13 — I/D/T -> one candidate each, correct source_heading, no suggested_kind
  test("I/D/T -> one candidate each with correct source_heading", () => {
    const pd = mkproj("p13");
    writeFileSync(
      join(pd, "aidlc-docs", "inception", "user-stories", "memory.md"),
      `## Interpretations
- 2026-05-28T14:00:00Z — interp one; ctx i

## Deviations
- 2026-05-28T14:01:00Z — dev one; ctx d

## Tradeoffs
- 2026-05-28T14:02:00Z — trade one; ctx t

## Open questions
`,
      "utf-8",
    );
    const res = runCli(["surface", "--slug", "user-stories", "--project-dir", pd]);
    const j = JSON.parse(res.stdout);
    expect(j.candidates.map((c: { source_heading: string }) => c.source_heading).join(",")).toBe(
      "Interpretations,Deviations,Tradeoffs",
    );
    // .sh 13b — surface emits no suggested_kind/suggested_section
    expect(res.out).not.toContain("suggested_kind");
  });

  // .sh 14 — Open questions -> parked, NOT candidates
  test("Open questions -> parked_open_questions, never candidates", () => {
    const pd = mkproj("p14");
    writeFileSync(
      join(pd, "aidlc-docs", "inception", "user-stories", "memory.md"),
      `## Interpretations

## Deviations

## Tradeoffs

## Open questions
- 2026-05-28T15:00:00Z — should split by persona or journey?
`,
      "utf-8",
    );
    const res = runCli(["surface", "--slug", "user-stories", "--project-dir", pd]);
    const j = JSON.parse(res.stdout);
    expect(`${j.candidates.length}:${j.parked_open_questions.length}`).toBe("0:1");
  });

  // .sh 15 — mixed headings -> correct partition (2 candidates + 1 parked)
  test("mixed headings -> correct partition (2 candidates, 1 parked)", () => {
    const pd = mkproj("p15");
    writeFileSync(
      join(pd, "aidlc-docs", "inception", "user-stories", "memory.md"),
      `## Interpretations
- 2026-05-28T14:00:00Z — i; ci

## Deviations
- 2026-05-28T14:01:00Z — d; cd

## Tradeoffs

## Open questions
- 2026-05-28T15:00:00Z — q?
`,
      "utf-8",
    );
    const res = runCli(["surface", "--slug", "user-stories", "--project-dir", pd]);
    const j = JSON.parse(res.stdout);
    expect(`${j.candidates.length}:${j.parked_open_questions.length}`).toBe("2:1");
  });

  // .sh 16 — test-run mode -> {candidates:[], parked_open_questions:[], skipped}
  test("test-run mode -> skipped, no candidates", () => {
    const pd = mkproj("p16");
    writeFileSync(
      join(pd, "aidlc-docs", "aidlc-state.md"),
      "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Test-Run Mode**: true\n",
      "utf-8",
    );
    const res = runCli(["surface", "--slug", "user-stories", "--project-dir", pd]);
    expect(res.out).toContain('"skipped":"test-run-mode"');
  });

  // .sh 17 — slug-not-Active -> exit 1
  test("slug not Active stage -> exit 1", () => {
    const pd = mkproj("p17");
    expect(runCli(["surface", "--slug", "some-other-stage", "--project-dir", pd]).rc).toBe(1);
  });
});

// =====================================================================
// GROUP 4 — persist (.sh tests 18-26)
//
// WRITES audit rows + rule files. Fresh project per case (mkproj under the
// per-test tmpRoot) so audit/learnings state never bleeds. Idempotency
// assertions (23/24/25) spawn the CLI twice and grep the real on-disk bytes.
// =====================================================================
describe("t97 persist (cli, idempotency-sensitive)", () => {
  function writeSel(pd: string, body: string): string {
    const p = join(pd, "sel.json");
    writeFileSync(p, body, "utf-8");
    return p;
  }

  // .sh 18 — learning (project scope) -> RULE_LEARNED + cid marker + file from
  //          template with rolling-list heading (3 facts).
  test("project learning -> cid marker, rolling-list heading, RULE_LEARNED audit row", () => {
    const pd = mkproj("p18");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "Reused auth module; saved a rewrite", "source": "orchestrator" } ] }
`,
    );
    const res = runCli([
      "persist",
      "--slug",
      "user-stories",
      "--selections-json",
      sel,
      "--project-dir",
      pd,
    ]);
    expect(res.rc).toBe(0);
    const plf = join(pd, ".claude", "rules", "aidlc-project-learnings.md");
    expect(readFile(plf)).toContain("cid:user-stories:c1");
    expect(/^## Learnings/m.test(readFile(plf))).toBe(true);
    expect(/Event.*: RULE_LEARNED/.test(readFile(join(pd, "aidlc-docs", "audit.md")))).toBe(true);
  });

  // .sh 19 — learning (team scope) -> write to aidlc-team-learnings.md
  test("team learning -> write to aidlc-team-learnings.md", () => {
    const pd = mkproj("p19");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c2", "type": "learning", "scope": "team", "heading": "Deviation", "text": "Picked TDD over BDD", "source": "orchestrator" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    expect(readFile(join(pd, ".claude", "rules", "aidlc-team-learnings.md"))).toContain(
      "cid:user-stories:c2",
    );
  });

  // .sh 20 — sensor -> SENSOR_PROPOSED + project-tier manifest w/ matches AND id
  //          appended to origin_stage sensors: frontmatter (two-write, 2 facts).
  test("sensor -> project-tier manifest with matches glob + id appended to frontmatter (two-write)", () => {
    const pd = mkproj("p20");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c5", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "acceptance-format", "kind": "deterministic", "command": "bun .claude/tools/aidlc-sensor.ts fire acceptance-format", "default_severity": "advisory", "description": "Checks AC format", "matches": "**/aidlc-docs/inception/user-stories/**", "timeout_seconds": 30 } } ] }
`,
    );
    runCli(
      ["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd],
      { env: { AIDLC_STAGES_DIR: join(pd, ".claude", "skills", "aidlc", "stages") } },
    );
    expect(
      readFile(join(pd, ".claude", "sensors", "aidlc-acceptance-format.md")),
    ).toContain("matches:");
    const stageMd = readFile(
      join(pd, ".claude", "skills", "aidlc", "stages", "inception", "user-stories.md"),
    );
    expect(/acceptance-format$/m.test(stageMd)).toBe(true);
  });

  // .sh 21 — framework-tier sensor manifest path -> exit 1
  test("framework-distribution sensor manifest path -> exit 1", () => {
    const pd = mkproj("p21");
    mkdirSync(join(pd, "dist", "claude", ".claude", "sensors"), { recursive: true });
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c9", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "bad", "kind": "deterministic", "command": "x", "default_severity": "advisory", "description": "d", "matches": "**/*" } } ] }
`,
    );
    expect(
      runCli([
        "persist",
        "--slug",
        "user-stories",
        "--selections-json",
        sel,
        "--project-dir",
        join(pd, "dist", "claude"),
      ]).rc,
    ).toBe(1);
  });

  // .sh 22 — free-text -> Source: user_addition + Candidate-ID: free_text_<seq> (2 facts).
  test("free-text -> Source: user_addition + Candidate-ID free_text_1", () => {
    const pd = mkproj("p22");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "free_text_1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "Surface unknowns earlier", "source": "user_addition" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    // The .sh extracted the RULE_LEARNED block via awk
    //   (awk '/Event.*: RULE_LEARNED/{p=1} p; /^---$/{if(p)exit}')
    // and asserted both field lines WITHIN that block. We mirror that exactly:
    // capture the block (the `**Event**: RULE_LEARNED` line through the next
    // `---`) and assert the fields are co-located inside it. This is stronger
    // isolation than a whole-file substring — a Source/Candidate-ID landing in
    // some OTHER audit block (e.g. a SENSOR_PROPOSED row, or a future second
    // RULE_LEARNED) would no longer falsely satisfy the assertion.
    const audit = readFile(join(pd, "aidlc-docs", "audit.md"));
    const ftBlock = extractAuditBlock(audit, /Event.*: RULE_LEARNED/);
    // Sanity: the block must actually exist (start line found + terminated).
    expect(ftBlock).toContain("RULE_LEARNED");
    expect(ftBlock.endsWith("---")).toBe(true);
    expect(ftBlock).toContain("Source**: user_addition");
    expect(ftBlock).toContain("Candidate-ID**: free_text_1");
  });

  // .sh 23 — idempotent re-run -> no re-emit, no duplicate line. SPAWN TWICE,
  //          grep the real audit + learnings file: exactly one row + one line.
  test("idempotent re-run -> exactly one audit row + one file line", () => {
    const pd = mkproj("p23");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Tradeoff", "text": "kept once", "source": "orchestrator" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    const rows = grepCount(join(pd, "aidlc-docs", "audit.md"), /Event.*: RULE_LEARNED/);
    const lines = grepCount(
      join(pd, ".claude", "rules", "aidlc-project-learnings.md"),
      "cid:user-stories:c1",
    );
    expect(`${rows}:${lines}`).toBe("1:1");
  });

  // .sh 24 — belt-and-braces recovery -> audit row present, file line deleted ->
  //          re-write only, exit 0 (decide-inside-lock).
  test("recovery -> re-write only (audit row not duplicated), exit 0", () => {
    const pd = mkproj("p24");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Deviation", "text": "recover me", "source": "orchestrator" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    // Delete the file line, KEEP the audit row (mirrors the .sh's grep -v ... mv).
    const plf = join(pd, ".claude", "rules", "aidlc-project-learnings.md");
    const kept = readFile(plf)
      .split("\n")
      .filter((l) => !l.includes("cid:user-stories:c1"))
      .join("\n");
    writeFileSync(plf, kept, "utf-8");
    const res = runCli([
      "persist",
      "--slug",
      "user-stories",
      "--selections-json",
      sel,
      "--project-dir",
      pd,
    ]);
    const rows = grepCount(join(pd, "aidlc-docs", "audit.md"), /Event.*: RULE_LEARNED/);
    const lines = grepCount(plf, "cid:user-stories:c1");
    expect(`${res.rc}:${rows}:${lines}`).toBe("0:1:1");
  });

  // .sh 25 — false-negative guard -> cid-keyed (not date-keyed) idempotency, no
  //          second copy on re-run.
  test("false-negative guard -> no second copy on re-run (cid-keyed, not date-keyed)", () => {
    const pd = mkproj("p25");
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "no double append", "source": "orchestrator" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    const lines = grepCount(
      join(pd, ".claude", "rules", "aidlc-project-learnings.md"),
      "cid:user-stories:c1",
    );
    expect(lines).toBe(1);
  });

  // .sh 26 — test-run -> exit 0, no writes/emits (most-recent audit block Test-Run: true).
  test("test-run -> no writes, no emits", () => {
    const pd = mkproj("p26");
    writeFileSync(
      join(pd, "aidlc-docs", "audit.md"),
      `
## Stage Start
**Timestamp**: 2026-05-29T10:00:00Z
**Event**: STAGE_STARTED
**Stage**: user-stories
**Test-Run**: true

---
`,
      "utf-8",
    );
    const sel = writeSel(
      pd,
      `{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "should not write", "source": "orchestrator" } ] }
`,
    );
    runCli(["persist", "--slug", "user-stories", "--selections-json", sel, "--project-dir", pd]);
    const rows = grepCount(join(pd, "aidlc-docs", "audit.md"), /Event.*: RULE_LEARNED/);
    const fileState = existsSync(join(pd, ".claude", "rules", "aidlc-project-learnings.md"))
      ? "file"
      : "none";
    expect(`${rows}:${fileState}`).toBe("0:none");
  });
});

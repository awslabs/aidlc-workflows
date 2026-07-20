// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:aidlc-common/conductor.md, doc:aidlc-common/stages, doc:knowledge/aidlc-shared/state-template.md, doc:SKILL.md(routing)
//
// t37 — cross-file stage-protocol compliance. Migrated from the bash TAP test
// tests/integration/t37-stage-protocol-compliance.sh (plan 75). The subject is a
// set of CROSS-FILE structural invariants over the shipped tree under
// dist/claude/.claude (AIDLC_SRC): every stage references the protocol, the
// state template carries every required section, fixtures conform to that
// section structure and to the protocol's checkbox notation, SKILL.md routing
// mandates all three protocol files, the protocol's silent-bookkeeping section
// names the state fields the tools write, init stages are exempt from approval
// gates, and the protocol + conductor both forbid Task() for inline support
// agents.
//
// Mechanism: none. Every assertion is a structural / filesystem inspection of
// the shipped bytes — read the same files the .sh grepped (via AIDLC_SRC from
// tests/harness/fixtures.ts), assert on their content in process. There is no
// tool argv / exit-code / stdout seam and no LLM: the .sh used grep/sed only,
// so the TS twin reads the files with readFileSync and asserts. Zero spawn,
// zero subprocess, zero tokens.
//
// Source under test (paths relative to AIDLC_SRC = dist/claude/.claude):
//   aidlc-common/protocols/stage-protocol.md
//     :15  "## 1. Approval Gates" — names the 3 init stages as exempt
//     "### Silent bookkeeping writes" — names **Current Stage** / **Lifecycle
//          Phase** / **Active Agent** / **In Progress** / **Completed** fields
//     "[S]" — documents the skipped-via-jump checkbox state
//     "### Multi-agent stages:" — forbids Task() for inline support agents,
//          reserves Task for `mode: subagent`
//   aidlc-common/conductor.md — mirrors the inline-support-agent guidance
//          (forbids Task for inline support agents; reserves Task for
//          `directive.mode == "subagent"`)
//   aidlc-common/stages/<phase>/<slug>.md — 32 stage files; all reference
//          "stage-protocol"
//   knowledge/aidlc-shared/state-template.md — the 7 required ## sections
//   knowledge/aidlc-<agent>-agent/ — one knowledge dir per agents/*.md file
//   skills/aidlc/SKILL.md "## Routing" — mandates all 3 protocol files
// Fixtures (tests/fixtures, via FIXTURES_DIR):
//   state-mid-ideation.md — section structure + [x]/[-]/[ ] checkbox notation
//   state-jumped.md       — [S] skipped-via-jump notation
//
// Equal-or-stronger note: the .sh's stage-protocol loop tolerated an init stage
// that did NOT reference the protocol (it scored such a stage `ok` as
// "optional"). The shipped tree has all 32 stages — init included — referencing
// it, so this twin asserts the STRONGER invariant: every stage (init and
// non-init alike) references stage-protocol, and additionally records that no
// non-init stage may ever omit it (the only branch that produced a `not_ok` in
// the .sh). The init-exemption-from-approval-gates row (.sh "approval exemption
// lists initialization stage: X") is preserved verbatim as a separate check.
//
// Old TAP -> new test parity (1:1, 75 .sh assertions -> 75 expect()s, grouped):
//   .sh stage-protocol loop (32 stages, one ok/not_ok each)
//        -> "every stage file references stage-protocol" (32 expects, one/stage)
//        -> STRONGER: "no non-initialization stage omits stage-protocol"
//   .sh agent knowledge-dir loop (13 agents)
//        -> "every agent has a knowledge directory" (13 expects, one/agent)
//   .sh state-template section loop (7 sections)
//        -> "state template has every required ## section" (7 expects)
//   .sh fixture mid-ideation section loop (5 sections)
//        -> "mid-ideation fixture has every expected ## section" (5 expects)
//   .sh routing protocol-file checks (3)
//        -> "SKILL.md routing mandates all three protocol files" (3 expects)
//   .sh bookkeeping field-ref checks (5)
//        -> "silent-bookkeeping section names every state field" (5 expects)
//   .sh init approval-exemption checks (3)
//        -> "approval-gates section exempts every initialization stage" (3)
//   .sh fixture checkbox-notation checks (3)
//        -> "mid-ideation fixture uses [x] / [-] / [ ] notation" (3 expects)
//   .sh protocol [S] documentation (1)
//        -> "protocol documents the [S] skipped-via-jump notation" (1)
//   .sh jumped-fixture [S] (1)
//        -> "jumped fixture uses [S] skipped notation" (1)
//   .sh multi-agent / conductor inline-support checks (4)
//        -> "protocol §5 + conductor forbid Task for inline support agents" (4)

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const PROTOCOL = join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md");
const CONDUCTOR = join(AIDLC_SRC, "aidlc-common", "conductor.md");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const AGENTS_DIR = join(AIDLC_SRC, "agents");
const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge");
const STATE_TEMPLATE = join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md");
const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

// The .sh treated these three as exempt-from-protocol-reference (orchestrator
// handles them) AND lists them as exempt from approval gates.
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Extract the lines of a markdown section: from the line matching `start`
 *  (anchored at column 0) up to (but not including) the next line matching
 *  `end`. Mirrors the .sh's `sed -n '/start/,/end/p'` blocks. */
function section(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (start.test(line)) {
        inSection = true;
        out.push(line);
      }
      continue;
    }
    if (end.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Every <phase>/<slug>.md under STAGES_DIR, in stable sorted order — the same
 *  set the .sh's nested `for phase_dir / for f in *.md` loop walked. */
function allStageFiles(): { slug: string; path: string }[] {
  const result: { slug: string; path: string }[] = [];
  for (const phase of readdirSync(STAGES_DIR).sort()) {
    const phaseDir = join(STAGES_DIR, phase);
    if (!statSync(phaseDir).isDirectory()) continue;
    for (const f of readdirSync(phaseDir).sort()) {
      if (!f.endsWith(".md")) continue;
      const p = join(phaseDir, f);
      if (statSync(p).isFile()) result.push({ slug: basename(f, ".md"), path: p });
    }
  }
  return result;
}

const STAGE_FILES = allStageFiles();

describe("every stage references the stage protocol", () => {
  // .sh: the protocol-reference loop scored every stage. All 32 shipped stages
  // — including the 3 init stages — reference stage-protocol, so this is the
  // STRONGER form: every stage must reference it (the .sh's only failing branch
  // was a non-init stage missing the reference).
  test("the shipped tree has exactly 32 stage files [.sh TOTAL_STAGES]", () => {
    expect(STAGE_FILES.length).toBe(32);
  });

  for (const { slug, path } of STAGE_FILES) {
    test(`stage '${slug}' references stage-protocol [.sh stage loop]`, () => {
      // grep -qi "stage-protocol" — case-insensitive substring.
      expect(read(path).toLowerCase().includes("stage-protocol")).toBe(true);
    });
  }

  test("no non-initialization stage omits stage-protocol [.sh not_ok branch — stronger]", () => {
    const offenders = STAGE_FILES.filter(
      ({ slug, path }) =>
        !INIT_STAGES.includes(slug) &&
        !read(path).toLowerCase().includes("stage-protocol"),
    ).map((s) => s.slug);
    expect(offenders).toEqual([]);
  });
});

describe("every agent has a knowledge directory", () => {
  // .sh: for agent_file in $AGENTS_DIR/*.md; assert_dir_exists knowledge/<agent>
  const agents = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();

  test("there are 14 agent files [structure guard]", () => {
    expect(agents.length).toBe(14);
  });

  for (const agent of agents) {
    test(`knowledge dir exists for ${agent} [.sh agent loop]`, () => {
      const dir = join(KNOWLEDGE_DIR, agent);
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    });
  }
});

describe("state template has every required section", () => {
  // .sh TEMPLATE_SECTIONS — assert_grep "$STATE_TEMPLATE" "$section".
  const TEMPLATE_SECTIONS = [
    "## Project Information",
    "## Scope Configuration",
    "## Workspace State",
    "## Execution Plan Summary",
    "## Runtime State",
    "## Stage Progress",
    "## Current Status",
  ];
  const template = read(STATE_TEMPLATE);
  for (const sec of TEMPLATE_SECTIONS) {
    test(`state template has section: ${sec} [.sh template loop]`, () => {
      expect(template.includes(sec)).toBe(true);
    });
  }
});

describe("mid-ideation fixture conforms to the template section structure", () => {
  // .sh: assert_grep "$FIXTURES_DIR/state-mid-ideation.md" for each section.
  const FIXTURE_SECTIONS = [
    "## Project Information",
    "## Scope Configuration",
    "## Stage Progress",
    "## Current Status",
    "## Session Resume Point",
  ];
  const fixture = read(join(FIXTURES_DIR, "state-mid-ideation.md"));
  for (const sec of FIXTURE_SECTIONS) {
    test(`fixture has section: ${sec} [.sh fixture-section loop]`, () => {
      expect(fixture.includes(sec)).toBe(true);
    });
  }
});

describe("SKILL.md routing mandates all three protocol files", () => {
  // .sh: ROUTING_SECTION = sed -n '/^## Routing/,/^## /p'; assert_contains each.
  const routing = section(read(SKILL), /^## Routing/, /^## /);
  test("routing mandates stage-protocol.md [.sh routing 1]", () => {
    expect(routing.includes("stage-protocol.md")).toBe(true);
  });
  test("routing mandates stage-protocol-recovery.md [.sh routing 2]", () => {
    expect(routing.includes("stage-protocol-recovery.md")).toBe(true);
  });
  test("routing mandates stage-protocol-governance.md [.sh routing 3]", () => {
    expect(routing.includes("stage-protocol-governance.md")).toBe(true);
  });
});

describe("silent-bookkeeping section names every state field the tools write", () => {
  // .sh: SED_SECTION = sed -n '/^### Silent bookkeeping writes/,/^---$/p';
  // assert_contains each **Field** literal.
  const sedSection = section(
    read(PROTOCOL),
    /^### Silent bookkeeping writes/,
    /^---$/,
  );
  const fields = [
    "**Current Stage**",
    "**Lifecycle Phase**",
    "**Active Agent**",
    "**In Progress**",
    "**Completed**",
  ];
  for (const field of fields) {
    test(`bookkeeping section references ${field} field [.sh bookkeeping loop]`, () => {
      expect(sedSection.includes(field)).toBe(true);
    });
  }
});

describe("approval-gates section exempts every initialization stage", () => {
  // .sh: APPROVAL_SECTION = sed -n '/^## 1\. Approval Gates/,/^---$/p';
  // assert_contains each init stage slug.
  const approval = section(read(PROTOCOL), /^## 1\. Approval Gates/, /^---$/);
  for (const slug of INIT_STAGES) {
    test(`approval exemption lists initialization stage: ${slug} [.sh approval loop]`, () => {
      expect(approval.includes(slug)).toBe(true);
    });
  }
});

describe("fixtures use the protocol's checkbox notation", () => {
  // .sh: assert_grep on mid-ideation for ^- [x], ^- [-], ^- [ ]; and on
  // state-jumped for ^- [S]. Anchored line-start patterns, replicated as
  // per-line regex tests over the fixture bytes.
  const midLines = read(join(FIXTURES_DIR, "state-mid-ideation.md")).split("\n");
  const jumpedLines = read(join(FIXTURES_DIR, "state-jumped.md")).split("\n");

  test("mid-ideation fixture uses [x] completed notation [.sh checkbox 1]", () => {
    expect(midLines.some((l) => /^- \[x\]/.test(l))).toBe(true);
  });
  test("mid-ideation fixture uses [-] in-progress notation [.sh checkbox 2]", () => {
    expect(midLines.some((l) => /^- \[-\]/.test(l))).toBe(true);
  });
  test("mid-ideation fixture uses [ ] not-started notation [.sh checkbox 3]", () => {
    expect(midLines.some((l) => /^- \[ \]/.test(l))).toBe(true);
  });
  test("jumped fixture uses [S] skipped notation [.sh jumped fixture]", () => {
    expect(jumpedLines.some((l) => /^- \[S\]/.test(l))).toBe(true);
  });
});

describe("protocol documents the [S] skipped-via-jump notation", () => {
  // .sh: assert_grep "$PROTOCOL" '\[S\]'.
  test("protocol mentions the [S] checkbox state [.sh protocol [S]]", () => {
    expect(read(PROTOCOL).includes("[S]")).toBe(true);
  });
});

describe("protocol §5 + conductor forbid dispatching inline support agents", () => {
  // Originally pinned the pre-2.5.0 "Task is reserved for mode: subagent"
  // literals. Under the ensemble topologies (2.5.0) dispatch is legal on
  // subagent/pipeline/mob stages, so the invariant narrows to: INLINE
  // support agents are voices, never dispatches — and the conductor remains
  // the only delegator on every topology.
  const multiAgent = section(
    read(PROTOCOL),
    /^### Multi-agent stages/,
    /^### /,
  );
  const conductor = read(CONDUCTOR);

  test("protocol §5 forbids dispatching a support agent on an inline stage [.sh multi-agent 1]", () => {
    expect(
      multiAgent.includes(
        "Do NOT dispatch a support agent on an inline stage",
      ),
    ).toBe(true);
  });
  test("protocol §5 keeps the conductor the only delegator [.sh multi-agent 2]", () => {
    expect(
      multiAgent.includes("only the orchestrator delegates"),
    ).toBe(true);
  });
  test("conductor forbids dispatching a support agent on an inline stage [.sh conductor 1]", () => {
    expect(
      conductor.includes(
        "Do **not** dispatch a support agent on an inline stage",
      ),
    ).toBe(true);
  });
  test("conductor keeps agents from invoking each other [.sh conductor 2]", () => {
    // Normalize the source's hard wraps so the assertion pins the whole
    // sentence — the delegation clause included — regardless of where the
    // line breaks fall (the pre-fix || fallback silently dropped the
    // "only you, the conductor, delegate" pin when the wrap moved).
    const flowed = conductor.replace(/\s+/g, " ");
    expect(flowed).toContain(
      "Agents never invoke each other — only you, the conductor, delegate.",
    );
  });
});

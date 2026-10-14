// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:aidlc-common/protocols/stage-protocol-ensemble.md, doc:aidlc-common/conductor.md, doc:aidlc-common/stages, doc:knowledge/aidlc-shared/state-template.md, doc:SKILL.md(routing)
//
// t37 - cross-file stage-protocol compliance. The subject is a set of CROSS-FILE
// structural invariants over the shipped tree under dist/claude/.claude
// (AIDLC_SRC): every stage references the protocol, the state template carries
// every required section, fixtures conform to that section structure and to the
// protocol's checkbox notation, SKILL.md routing mandates all three protocol
// files, the protocol's silent-bookkeeping section names the state fields the
// tools write, init stages are exempt from approval gates, and the ensemble
// protocol + conductor both forbid dispatching inline support agents.
//
// Mechanism: none. Every assertion is a structural / filesystem inspection of
// the shipped bytes (via AIDLC_SRC from tests/harness/fixtures.ts), asserted
// on their content in process. There is no tool argv / exit-code / stdout seam
// and no LLM.
//
// Source under test (paths relative to AIDLC_SRC = dist/claude/.claude):
//   aidlc-common/protocols/stage-protocol.md
//     "## 1. Approval Gates" - names the 3 init stages as exempt
//     "### Silent bookkeeping writes" — names **Current Stage** / **Lifecycle
//          Phase** / **Active Agent** / **In Progress** / **Completed** fields
//     "[S]" — documents the skipped-via-jump checkbox state
//   aidlc-common/protocols/stage-protocol-ensemble.md
//     "## 5. Multi-agent stages" - forbids dispatching inline support agents
//   aidlc-common/conductor.md — mirrors the inline-support-agent guidance
//          and makes the conductor the only delegator
//   aidlc-common/stages/<phase>/<slug>.md - 33 stage files; all reference
//          "stage-protocol"
//   knowledge/aidlc-shared/state-template.md — the 7 required ## sections
//   knowledge/aidlc-<agent>-agent/ — one knowledge dir per agents/*.md file
//   skills/aidlc/SKILL.md "## Routing" — mandates all 3 protocol files
// Fixtures (tests/fixtures, via FIXTURES_DIR):
//   state-mid-ideation.md — section structure + [x]/[-]/[ ] checkbox notation
//   state-jumped.md       — [S] skipped-via-jump notation

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { protocolNote } from "../../core/tools/aidlc-directive.ts";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const PROTOCOL = join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md");
const ENSEMBLE = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol-ensemble.md",
);
const CONDUCTOR = join(AIDLC_SRC, "aidlc-common", "conductor.md");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const AGENTS_DIR = join(AIDLC_SRC, "agents");
const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge");
const STATE_TEMPLATE = join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md");
const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

// The three initialization stages: the offender check below excludes them, and
// the approval-gates section must list them as exempt.
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Extract the lines of a markdown section: from the line matching `start` up
 *  to (but not including) the next line matching `end`. */
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

/** Every <phase>/<slug>.md under STAGES_DIR, in stable sorted order. */
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
  test("the shipped tree has exactly 33 stage files [.sh TOTAL_STAGES]", () => {
    expect(STAGE_FILES.length).toBe(33);
  });

  for (const { slug, path } of STAGE_FILES) {
    test(`stage '${slug}' references stage-protocol [.sh stage loop]`, () => {
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

describe("SKILL.md routing mandates the static and conditional protocol files", () => {
  const routing = section(read(SKILL), /^## Routing/, /^## /);
  // Each step names the stage protocol and its modules in its own note (#1330);
  // the routing section names the two no step names.
  const note = protocolNote(".claude/aidlc-common/stages/construction/code-generation.md", [
    "reviewer",
    "swarm",
    "ensemble",
    "construction",
  ]) ?? "";
  test("routing mandates stage-protocol.md [.sh routing 1]", () => {
    expect(routing).toContain("Each step names the stage protocol and the modules it runs by.");
    expect(note).toContain(".claude/aidlc-common/protocols/stage-protocol.md");
  });
  test("routing mandates stage-protocol-recovery.md [.sh routing 2]", () => {
    expect(routing.includes("stage-protocol-recovery.md")).toBe(true);
  });
  test("routing mandates stage-protocol-governance.md [.sh routing 3]", () => {
    expect(routing.includes("stage-protocol-governance.md")).toBe(true);
  });
  for (const module of [
    "stage-protocol-reviewer.md",
    "stage-protocol-swarm.md",
    "stage-protocol-ensemble.md",
    "stage-protocol-construction.md",
  ]) {
    test(`routing mandates ${module}`, () => {
      expect(note).toContain(module);
    });
  }
});

describe("silent-bookkeeping section names every state field the tools write", () => {
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
  const approval = section(read(PROTOCOL), /^## 1\. Approval Gates/, /^---$/);
  for (const slug of INIT_STAGES) {
    test(`approval exemption lists initialization stage: ${slug} [.sh approval loop]`, () => {
      expect(approval.includes(slug)).toBe(true);
    });
  }
});

describe("fixtures use the protocol's checkbox notation", () => {
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
  test("protocol mentions the [S] checkbox state [.sh protocol [S]]", () => {
    expect(read(PROTOCOL).includes("[S]")).toBe(true);
  });
});

describe("ensemble protocol §5 + conductor forbid dispatching inline support agents", () => {
  // Under the ensemble topologies dispatch is legal on subagent/pipeline/mob
  // stages, so the invariant is: INLINE support agents are voices, never
  // dispatches - and the conductor remains the only delegator on every topology.
  const multiAgent = section(
    read(ENSEMBLE),
    /^## 5\. Multi-agent stages/,
    /^---$/,
  );
  const conductor = read(CONDUCTOR);

  test("ensemble protocol §5 forbids dispatching a support agent on an inline stage [.sh multi-agent 1]", () => {
    expect(
      multiAgent.includes(
        "Do NOT dispatch a support agent on an inline stage",
      ),
    ).toBe(true);
  });
  test("ensemble protocol §5 keeps the conductor the only delegator [.sh multi-agent 2]", () => {
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

// The /aidlc skill body keeps what only it carries (#1330). Every instruction
// cut from it reaches the chat from one named carrier on the branch that needs
// it: the step's own notes, the stage protocol and the module the step names,
// or the onboarding file every harness loads. Checked per harness on the
// shipped tree, so a carrier that one harness does not ship fails here.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGE_NOTICES_NOTE,
  ceremonyNote,
  planApprovalQuestionNote,
  stageValidityNote,
  unitStepNote,
  unresolvedGateNote,
} from "../../core/tools/aidlc-directive.ts";
import { EARLIER_RELEASE_REGIONS } from "../../scripts/earlier-release-regions.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
const flat = (text: string): string => text.replace(/\s+/g, " ");

// Lead-ins of the blocks that left the skill.
const CUT = [
  "**Validity advisories.**",
  "**In-session configuration (`--config [section]`).**",
  "**Model and effort requests.**",
  "**Construction routing takes precedence.**",
  "**Settled swarm branch.**",
  "**Per-unit batch waves (optional).**",
  "**Autonomous reviewer boundary.**",
  "engine-future",
  "| plan approval | `plan-approval` | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD` |",
  "**PRE-GENERATION SUMMARY STOP**",
  "<!-- BEGIN: compiled",
];

// What only the skill carries stays in it.
const KEPT = [
  "## The Forwarding Loop",
  "**When AI-DLC carries on by itself.**",
  '--result approved --user-input "Approve"',
  "`Nothing to add` / `Add a note`",
  "never park, report, or otherwise touch the active work",
  "stage-protocol-recovery.md",
  "stage-protocol-governance.md",
  "read `composer.md` beside this file first",
];

const ORCHESTRATE = read(join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts"));

describe("t-skill-body-carriers: the /aidlc skill keeps what only it carries", () => {
  test("the engine's own notes carry the cut step branches", () => {
    expect(stageValidityNote("aidlc", "requirements-analysis")).toContain("word for word");
    expect(stageValidityNote("aidlc", "requirements-analysis")).toContain("never say who made it");
    expect(CHANGE_NOTICES_NOTE).toContain("once, word for word");
    expect(planApprovalQuestionNote("aidlc", "aidlc-log")).toContain("--checkpoint plan-approval");
    expect(unresolvedGateNote("aidlc")).toContain("--skeleton-stance");
    expect(unitStepNote("aidlc")).toContain("has no gate of its own");
    // The configuration print and the parked step say their own steps.
    expect(ORCHESTRATE).toContain("Never invent values, regions, or plugin names");
    expect(ORCHESTRATE).toContain("Pausing here with everything saved.");
  });

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the skill holds no cut block, and each block's carrier ships",
    (_name, harness) => {
      const skillDir = join(harness.skillsRoot, "aidlc");
      // The one empty place an earlier release's refresh writes the tables into.
      const shipped = read(join(skillDir, "SKILL.md"));
      const skill = shipped.endsWith(`\n${EARLIER_RELEASE_REGIONS}\n`)
        ? shipped.slice(0, -(EARLIER_RELEASE_REGIONS.length + 1))
        : shipped;
      for (const cut of CUT) expect(skill, cut).not.toContain(cut);
      for (const kept of KEPT) expect(flat(skill), kept).toContain(kept);
      // Each harness's own notes keep their heading (Claude Code has none).
      if (harness.name !== "claude") expect(skill).toMatch(/^#{2,3} Harness notes \(/m);

      // The two generated tables live beside the skill, not in it.
      const tablesPath = join(skillDir, "tables.md");
      expect(existsSync(tablesPath)).toBe(true);
      const tables = read(tablesPath);
      expect(tables).toContain("<!-- BEGIN: compiled scope grid via ");
      expect(tables).toContain("<!-- BEGIN: compiled stage graph via ");
      // Only the two tables moved: any other section stays in the skill.
      expect(tables.match(/^## .*/gm)).toEqual(["## Scope-to-Stage Mapping", "## Stage Graph"]);

      // The onboarding file every harness loads: the person's checks and models.
      const onboarding = flat(read(harness.harnessOnboardingDist));
      expect(onboarding).toContain("| plan approval | `plan-approval` | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD` |");
      expect(onboarding).toContain(
        "A remark about being careful with changes, or a question about a check, is not a request to change it; when you cannot tell, ask once.",
      );
      expect(onboarding).toContain("config models --agent <name>");

      // The stage protocol every step reads, and the modules a step names.
      const protocols = join(harness.engineRoot, "aidlc-common", "protocols");
      const protocol = flat(read(join(protocols, "stage-protocol.md")));
      expect(protocol).toContain("Count refusals separately per identity");
      expect(protocol).toContain("is the largest pile of internal detail in the framework");
      expect(protocol).toContain("**Conditional skip** is also report-owned.");
      expect(protocol).toContain("--result awaiting-approval");
      expect(read(join(protocols, "stage-protocol-construction.md"))).toContain("### Construction directive routing");
      expect(read(join(protocols, "stage-protocol-swarm.md"))).toContain("**Settled-swarm re-entry.**");
      expect(read(join(protocols, "stage-protocol-wave.md"))).toContain("**Per-unit batch waves (optional, stage-major only).**");
      // The summary confirmation is wherever the step's own note sends the agent.
      const summaryFile = ceremonyNote("on").match(/stage-protocol[a-z-]*\.md/)?.[0];
      expect(summaryFile).toBeDefined();
      expect(read(join(protocols, summaryFile!))).toContain("Consolidated Summary Confirmation");
    },
  );
});

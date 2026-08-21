// covers: file:tools/aidlc-testing-posture.ts, file:aidlc-common/stages/construction/code-generation.md, file:aidlc-common/stages/inception/practices-discovery.md, file:aidlc-common/protocols/stage-protocol-construction.md, file:aidlc-common/protocols/stage-protocol-swarm.md, file:agents/aidlc-developer-agent.md, file:memory/org.md
//
// t299 - TESTING POSTURE CONTRACT. Deterministic behavior tests for additive
// posture resolution, methodology-specific plan profiles, strategy/scope
// combination, approval fingerprinting, and the normal/swarm authored surfaces
// that consume the contract.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalFingerprint,
  buildPlanProfile,
  combineTestObligations,
  evaluateCodeGenerationApproval,
  parseTestingContract,
  renderTestingContract,
  resolveTestingPosture,
  resolveTestingPostureFromSections,
  type ProjectType,
  type TestStrategy,
  type TestingMethodology,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { extractMarkdownSection } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STAGE_REL = "core/aidlc-common/stages/construction/code-generation.md";
const PRACTICES_REL =
  "core/aidlc-common/stages/inception/practices-discovery.md";
const CONSTRUCTION_PROTOCOL_REL =
  "core/aidlc-common/protocols/stage-protocol-construction.md";
const SWARM_PROTOCOL_REL =
  "core/aidlc-common/protocols/stage-protocol-swarm.md";
const AGENT_REL = "core/agents/aidlc-developer-agent.md";
const ORG_REL = "core/memory/org.md";
const TEAM_REL = "core/memory/team.md";
const PROJECT_REL = "core/memory/project.md";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

const ORG = [
  "- **Methodology**: test-after",
  "- **Ordering**: implement each layer, then test it.",
].join("\n");
const LEGACY_ORG = `We treat tests as a first-class deliverable in every Bolt. Specific
methodology — TDD, BDD, ATDD, or classic test-after — is captured by the
testing-strategy stage when it ships.

Until then, our default per scope is:
- \`mvp\`, \`enterprise\`, \`feature\`, \`infra\` → tests written alongside
  code; minimum 80% line coverage; tests run in CI before merge.
- \`bugfix\`, \`security-patch\` → regression test for the specific
  bug/vulnerability; existing test suite must remain green.
- \`poc\`, \`refactor\`, \`workshop\` → existing test suite remains green;
  no new test floor required.

Affirm a stricter posture in \`team.md\` if the team commits to one.`;

function resolve(
  sections: { org?: string; team?: string; project?: string },
  overrides: Partial<{
    scope: string;
    testStrategy: TestStrategy;
    projectType: ProjectType;
  }> = {},
) {
  return resolveTestingPostureFromSections(sections, {
    scope: overrides.scope ?? "feature",
    testStrategy: overrides.testStrategy ?? "standard",
    projectType: overrides.projectType ?? "greenfield",
  });
}

describe("t299 (1) additive methodology resolution", () => {
  test("shipped commented examples fall through to the org default", () => {
    const sections = {
      org: extractMarkdownSection(read(ORG_REL), "## Testing Posture"),
      team: extractMarkdownSection(read(TEAM_REL), "## Testing Posture"),
      project: extractMarkdownSection(read(PROJECT_REL), "## Testing Posture"),
    };
    const contract = resolve(sections);

    expect(contract.methodology).toBe("test-after");
    expect(contract.source).toBe("org");
    expect(contract.applicable_notes.map((note) => note.layer)).toEqual([
      "org",
    ]);
  });

  test("visible structured fields remain authoritative beside comments", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "<!-- Example: Methodology: bdd -->",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first, then implementation.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.ordering).toBe("tests first, then implementation.");
  });

  test("multi-line comments cannot affirm a methodology", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "<!-- Example posture:",
        "We use BDD scenarios before implementation.",
        "Unit tests use TDD.",
        "-->",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("test-after");
    expect(contract.source).toBe("org");
    expect(contract.applicable_notes.map((note) => note.layer)).toEqual([
      "org",
    ]);
  });

  test("a fence inside a multi-line comment cannot expose hidden methodology", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "<!-- Hidden example:",
        "```yaml",
        "Methodology: bdd",
        "```",
        "-->",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
  });

  test("an HTML comment token in a fence info string stays literal", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "~~~text <!-- literal token",
        "example content",
        "~~~",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.applicable_notes.find((note) => note.layer === "team")?.text)
      .toContain("<!-- literal token");
  });

  test("visible fenced notes remain in applicable_notes", () => {
    const contract = resolve({
      org: ORG,
      project: [
        "Run the package-specific test command:",
        "```bash",
        "bun test packages/payments",
        "```",
      ].join("\n"),
    });

    expect(
      contract.applicable_notes.find((note) => note.layer === "project")?.text,
    ).toContain("bun test packages/payments");
  });

  test("a fenced methodology example remains a note but does not affirm the methodology", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "Example only:",
        "~~~yaml",
        "Methodology: bdd",
        "Ordering: scenarios before implementation",
        "~~~",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("test-after");
    expect(contract.source).toBe("org");
    expect(contract.applicable_notes.find((note) => note.layer === "team")?.text)
      .toContain("Methodology: bdd");
  });

  test("HTML comment tokens inside inline code remain visible and do not hide later fields", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "Snapshot the literal `<!--` and `-->` tokens in parser tests.",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.applicable_notes.find((note) => note.layer === "team")?.text)
      .toContain("`<!--`");
  });

  test("mixed fence markers do not close a fenced methodology example", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "~~~~yaml",
        "Example setup",
        "~~~~`",
        "Methodology: bdd",
        "~~~~",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("test-after");
    expect(contract.source).toBe("org");
  });

  test("unmatched backticks and escaped comment openers do not hide later fields", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "Document the unmatched ` marker.",
        "Snapshot the escaped \\<!-- token.",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.applicable_notes.find((note) => note.layer === "team")?.text)
      .toContain("\\<!--");
  });

  test("escaped backticks do not turn a real HTML comment into inline code", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "Escaped delimiters \\` <!-- Methodology: bdd --> \\` stay prose.",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.applicable_notes.find((note) => note.layer === "team")?.text)
      .not.toContain("Methodology: bdd");
  });

  test("an invalid backtick fence info string does not hide visible methodology", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "```bad`info",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
  });

  test("comment removal cannot synthesize a fence that hides later fields", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "<!-- hidden prefix -->```yaml",
        "example: true",
        "- **Methodology**: tdd",
        "- **Ordering**: tests first.",
      ].join("\n"),
    });

    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
  });

  test("commented headings cannot select or truncate the visible Testing Posture section", () => {
    const project = mkdtempSync(join(tmpdir(), "t299-comment-heading-"));
    try {
      const memoryDir = join(project, "aidlc", "spaces", "default", "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, "org.md"),
        `# Org\n\n## Testing Posture\n\n${ORG}\n`,
      );
      writeFileSync(
        join(memoryDir, "team.md"),
        [
          "# Team",
          "",
          "<!-- Hidden example section:",
          "## Testing Posture -->",
          "- **Methodology**: bdd",
          "",
          "## Testing Posture <!-- real section -->",
          "",
          "<!-- Hidden nested example:",
          "## Example",
          "- **Methodology**: bdd",
          "-->",
          "<!-- hidden prefix -->## Deployment",
          "- **Methodology**: tdd",
          "- **Ordering**: tests first, then implementation.",
          "",
          "## Deployment <!-- next section -->",
          "- **Methodology**: bdd",
        ].join("\n"),
      );
      writeFileSync(join(memoryDir, "project.md"), "# Project\n");

      const contract = resolveTestingPosture(project);
      expect(contract.methodology).toBe("tdd");
      expect(contract.source).toBe("team");
      expect(contract.ordering).toBe("tests first, then implementation.");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("comment-only changes alter input_sha256 without entering applicable_notes", () => {
    const first = resolve({
      org: ORG,
      team: "<!-- alpha -->\n- **Methodology**: tdd\n- **Ordering**: tests first.",
    });
    const second = resolve({
      org: ORG,
      team: "<!-- beta -->\n- **Methodology**: tdd\n- **Ordering**: tests first.",
    });

    expect(second.methodology).toBe("tdd");
    expect(second.applicable_notes).toEqual(first.applicable_notes);
    expect(second.input_sha256).not.toBe(first.input_sha256);
  });

  test("a project coverage note does not erase team TDD", () => {
    const contract = resolve({
      org: ORG,
      team: "- **Methodology**: tdd\n- **Ordering**: tests first.",
      project: "The legacy adapter requires an integration regression suite.",
    });
    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
    expect(contract.applicable_notes.map((n) => n.layer)).toEqual([
      "org",
      "team",
      "project",
    ]);
  });

  test("ancillary custom coverage wording is not a custom methodology", () => {
    const contract = resolve({
      org: ORG,
      team: "- **Methodology**: tdd\n- **Ordering**: tests first.",
      project: "Use a custom coverage threshold for the legacy adapter.",
    });
    expect(contract.methodology).toBe("tdd");
    expect(contract.source).toBe("team");
  });

  test("a structured Methodology field must contain one canonical value", () => {
    expect(() =>
      resolve({
        org: ORG,
        team:
          "- **Methodology**: tdd | bdd | atdd | test-after | custom\n- **Ordering**: choose later.",
      }),
    ).toThrow("Invalid Testing Posture Methodology");
  });

  test("structured TDD remains authoritative when Ordering contains before and after", () => {
    const contract = resolve({
      org: ORG,
      team: [
        "- **Methodology**: tdd",
        "- **Ordering**: Write each layer's failing tests before implementing; refactor after each green run.",
      ].join("\n"),
    });
    expect(contract.methodology).toBe("tdd");
    expect(contract.plan_profile.steps[2]).toContain("Red");
  });

  test("the pre-2.6.8 org enumeration falls through to test-after", () => {
    const contract = resolve({ org: LEGACY_ORG });
    expect(contract.methodology).toBe("test-after");
    expect(contract.source).toBe("fallback");
    expect(contract.plan_profile.steps[2]).toContain("implement");
  });

  test("a contradictory project methodology is rejected, not treated as override", () => {
    expect(() =>
      resolve({
        org: ORG,
        team: "- **Methodology**: tdd\n- **Ordering**: tests first.",
        project:
          "- **Methodology**: test-after\n- **Ordering**: implementation first.",
      }),
    ).toThrow("strict-additive");
  });

  test("a BDD project specialization can preserve scenario-first plus unit-test-after ordering", () => {
    const contract = resolve({
      org: ORG,
      team:
        "- **Methodology**: bdd\n- **Ordering**: behavior scenarios before implementation.",
      project: "BDD scenarios first; unit tests after implementation.",
    });
    expect(contract.methodology).toBe("custom");
    expect(contract.source).toBe("project");
    expect(contract.ordering).toContain("unit tests after implementation");
  });
});

describe("t299 (2) methodology-specific plan profiles", () => {
  const profile = (
    methodology: TestingMethodology,
    ordering = "Preserve the custom sequence.",
  ) => buildPlanProfile(methodology, ordering, "greenfield");

  test("TDD covers every testable layer with Red, Green, and Refactor", () => {
    const tdd = profile("tdd");
    expect(tdd.testable_layers).toEqual([
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior",
    ]);
    for (const layer of tdd.testable_layers) {
      expect(tdd.steps).toContain(
        `${layer} - Red: write the failing tests and record the failing command output.`,
      );
      expect(tdd.steps).toContain(
        `${layer} - Green: implement only enough behavior to pass.`,
      );
      expect(tdd.steps).toContain(
        `${layer} - Refactor: improve the implementation while tests stay green.`,
      );
    }
  });

  test("BDD is scenario-first across a feature slice, not layer-local TDD", () => {
    const bdd = profile("bdd");
    expect(bdd.steps[2]).toContain("Behavior scenarios");
    expect(bdd.steps[3]).toContain("Feature slice");
    expect(bdd.steps.some((step) => step.includes("Business logic - Red"))).toBe(
      false,
    );
  });

  test("ATDD puts acceptance tests before the complete cross-layer feature", () => {
    const atdd = profile("atdd");
    const acceptance = atdd.steps.findIndex((step) =>
      step.startsWith("Acceptance Red"),
    );
    const implementation = atdd.steps.findIndex((step) =>
      step.startsWith("Feature implementation"),
    );
    expect(acceptance).toBeGreaterThan(0);
    expect(acceptance).toBeLessThan(implementation);
  });

  test("custom/mixed preserves its exact ordering without TDD coercion", () => {
    const ordering = "BDD scenarios first; unit tests after implementation.";
    const custom = profile("custom", ordering);
    expect(custom.steps[2]).toContain(ordering);
    expect(custom.steps.some((step) => step.includes(" - Red:"))).toBe(false);
  });

  test("test-after pairs implementation and tests for every testable layer", () => {
    const after = profile("test-after");
    for (const layer of after.testable_layers) {
      expect(after.steps).toContain(`${layer} - implement.`);
      expect(after.steps).toContain(
        `${layer} - write and run its tests after implementation.`,
      );
    }
  });
});

describe("t299 (3) runner bootstrap and test obligations", () => {
  test("greenfield runner setup precedes the first executable test step", () => {
    const profile = buildPlanProfile("tdd", "tests first", "greenfield");
    expect(profile.runner_ready_before_first_test).toBe(true);
    expect(profile.steps[1]).toContain("Bootstrap the minimal test runner");
    expect(profile.steps[2]).toContain("Red");
  });

  test("brownfield verifies the exact command instead of bootstrapping", () => {
    const profile = buildPlanProfile("bdd", "scenarios first", "brownfield");
    expect(profile.steps[1]).toContain("Verify the existing test runner");
  });

  test("every scope/strategy pair retains both strategy volume and scope floors", () => {
    const scopes = [
      "mvp",
      "enterprise",
      "feature",
      "infra",
      "bugfix",
      "security-patch",
      "poc",
      "refactor",
      "workshop",
    ];
    const strategies: TestStrategy[] = [
      "minimal",
      "standard",
      "comprehensive",
    ];
    for (const scope of scopes) {
      for (const strategy of strategies) {
        const obligations = combineTestObligations(scope, strategy);
        expect(obligations.strategy_volume.length).toBeGreaterThan(0);
        expect(obligations.scope_floor.length).toBeGreaterThan(0);
        expect(obligations.combination_rule).toContain("neither replaces");
      }
    }
    expect(
      combineTestObligations("bugfix", "minimal").scope_floor.join(" "),
    ).toContain("targeted regression");
    expect(
      combineTestObligations("bugfix", "minimal").combination_rule,
    ).toContain("narrowest necessary test type");
    expect(
      combineTestObligations("poc", "minimal").scope_floor.join(" "),
    ).toContain("no extra new-test floor");
  });
});

describe("t299 (4) structured contract and approval fingerprint", () => {
  test("contract JSON round-trips and changes when an applicable note changes", () => {
    const first = resolve({
      org: ORG,
      team: "- **Methodology**: tdd\n- **Ordering**: tests first.",
    });
    const rendered = renderTestingContract(first);
    expect(parseTestingContract(`# Plan\n\n${rendered}`)).toEqual(first);

    const specialized = resolve({
      org: ORG,
      team: "- **Methodology**: tdd\n- **Ordering**: tests first.",
      project: "Add an integration regression suite.",
    });
    expect(specialized.methodology).toBe("tdd");
    expect(specialized.contract_sha256).not.toBe(first.contract_sha256);
  });

  test("approval fingerprint binds plan, instructions, and contract", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const baseline = approvalFingerprint("plan", "instructions", hash);
    expect(approvalFingerprint("plan changed", "instructions", hash)).not.toBe(
      baseline,
    );
    expect(approvalFingerprint("plan", "instructions changed", hash)).not.toBe(
      baseline,
    );
    expect(
      approvalFingerprint("plan", "instructions", `sha256:${"b".repeat(64)}`),
    ).not.toBe(baseline);
  });

  test("a memory change after approval invalidates the unit contract", () => {
    const project = mkdtempSync(join(tmpdir(), "t299-contract-"));
    try {
      const memoryDir = join(project, "aidlc", "spaces", "default", "memory");
      const recordDir = join(
        project,
        "aidlc",
        "spaces",
        "default",
        "intents",
      );
      const stageDir = join(
        recordDir,
        "construction",
        "auth",
        "code-generation",
      );
      mkdirSync(memoryDir, { recursive: true });
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(
        join(memoryDir, "org.md"),
        `# Org\n\n## Testing Posture\n\n${ORG}\n`,
      );
      writeFileSync(
        join(memoryDir, "team.md"),
        "# Team\n\n## Testing Posture\n\n- **Methodology**: tdd\n- **Ordering**: tests first.\n",
      );
      writeFileSync(join(memoryDir, "project.md"), "# Project\n");
      writeFileSync(
        join(recordDir, "aidlc-state.md"),
        [
          "# State",
          "- **Project Type**: Greenfield",
          "- **Scope**: feature",
          "- **Test Strategy**: Standard",
          "",
        ].join("\n"),
      );

      const contract = resolveTestingPosture(project);
      const plan = `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Run profile\n`;
      const instructions =
        "# Unit Test Instructions\n\n## Command\n\n`bun test auth.test.ts`\n";
      writeFileSync(join(stageDir, "code-generation-plan.md"), plan);
      writeFileSync(
        join(stageDir, "unit-test-instructions.md"),
        instructions,
      );
      const fingerprint = approvalFingerprint(
        plan,
        instructions,
        contract.contract_sha256,
      );
      writeFileSync(
        join(stageDir, "code-generation-questions.md"),
        [
          "## Plan Approval",
          `[Approval Fingerprint]: ${fingerprint}`,
          "A. Approve Plan",
          "B. Request Changes",
          "[Answer]: A. Approve Plan",
          "",
        ].join("\n"),
      );
      expect(evaluateCodeGenerationApproval(project, "auth").ok).toBe(true);

      writeFileSync(
        join(memoryDir, "project.md"),
        "# Project\n\n## Testing Posture\n\nAdd an integration regression suite.\n",
      );
      const stale = evaluateCodeGenerationApproval(project, "auth");
      expect(stale.ok).toBe(false);
      expect(stale.reason).toContain("stale");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("t299 (5) authored consumers use the same contract", () => {
  test("Code Generation creates, fingerprints, and dispatches the contract", () => {
    const stage = read(STAGE_REL);
    expect(stage).toContain("aidlc-testing-posture.ts render");
    expect(stage).toContain("aidlc-testing-posture.ts fingerprint");
    expect(stage).toContain("AIDLC-TESTING-CONTRACT: <contract_sha256>");
    expect(stage).toContain("BDD");
    expect(stage).toContain("ATDD");
    expect(stage).toContain("Custom/mixed");
  });

  test("developer treats the approved contract as authoritative and conditionally refactors", () => {
    const agent = read(AGENT_REL);
    expect(agent).toContain("fingerprinted `## Testing Contract`");
    expect(agent).toContain("do not independently re-resolve");
    expect(agent).toContain(
      "Perform Refactor during initial generation when the approved Testing Contract includes that step",
    );
  });

  test("Practices Discovery emits structured Methodology and Ordering fields", () => {
    const practices = read(PRACTICES_REL);
    expect(practices).toContain("- **Methodology**: tdd | bdd | atdd | test-after | custom");
    expect(practices).toContain("- **Ordering**:");
  });

  test("org defaults state the additive scope/strategy combination", () => {
    const org = read(ORG_REL);
    expect(org).toContain("- **Methodology**: test-after");
    expect(org).toContain("Scope floors are additive");
    expect(org).not.toContain("testing-strategy stage");
  });

  test("the shared protocol and every harness require approved swarm worker markers", () => {
    const construction = read(CONSTRUCTION_PROTOCOL_REL);
    expect(construction).toContain("## 12b. Autonomous Code Generation Plan Contract");
    expect(construction).toContain("AIDLC-TESTING-CONTRACT: <contract_sha256");
    const swarm = read(SWARM_PROTOCOL_REL);
    expect(swarm).toContain(
      'stage-protocol-construction.md` §12b "Autonomous Code Generation Plan Contract"',
    );
    for (const harness of [
      "claude",
      "kiro",
      "kiro-ide",
      "codex",
      "cursor",
      "opencode",
      "copilot",
    ]) {
      const skill = read(`harness/${harness}/skills/aidlc/SKILL.md`);
      expect(skill, harness).toContain(
        "stage-protocol-construction.md` — load on the first Construction directive of the session and on every `invoke-swarm`",
      );
    }
  });
});

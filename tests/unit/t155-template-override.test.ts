// covers: subcommand:aidlc-sensor-required-sections, function:templateEligibleArtifacts, function:memoryTemplatesDir, function:frameworkTemplatesDir
//
// t155 — TPL: the template-override layer (one file, two readers).
//
// The template-override layer lets a team author one file per output artifact
// at aidlc/memory/templates/<artifact>.md, read by TWO consumers keyed off the
// output filename stem: the agent (fills the skeleton — knowledge, exercised by
// the stage-protocol clause, not a tool) and the required-sections sensor
// (verifies the `##` headings — determinism, exercised here). Whole-doc,
// advisory.
//
// This file exercises the DETERMINISM half at the PROCESS boundary: it spawns
// the real per-sensor script (aidlc-sensor-required-sections.ts) via
// node:child_process spawnSync — the same boundary t133 uses for the
// edge-block branch — passing the dispatcher-threaded flags --templates-dir +
// --template-eligible directly, plus the in-process function unit
// templateEligibleArtifacts (graph.ts). Asserted properties:
//
//   1. Resolution: a template at <dir>/<stem>.md whose `##` set ⊆ output → pass.
//   2. Precise findings: a template heading the output lacks → fail, the
//      missing heading reported verbatim, findings_count == #missing.
//   3. Override-before-default keyed by basename(outputPath) stem: a
//      multi-artifact stage resolves EACH artifact against its own template
//      (requirements.md vs architecture.md), distinctly.
//   4. Third branch (no template): no heading is required (#2721).
//   5. Eligibility gating (the MUST-FIX hazard): an INELIGIBLE artifact's
//      resolved template is IGNORED + a config_warning is surfaced, so a team
//      dropping requirements-analysis-questions.md does NOT get spurious
//      findings against a file whose sections are its questions.
//   6. Advisory severity preserved: the manifest default_severity stays advisory
//      and the script still exits 0 on a template fail (verdict is data, not an
//      exit code).
//   7. Same-file invariant: the bytes the agent would fill (the template file)
//      ARE the bytes the sensor parses for its expected set — no drift.
//   Marker handling: a `*-timestamp.md` run record and a `*-questions.md`
//      marker pass whatever their headings (an ignored template still warns).
//
// Mechanism: cli (spawnSync of the bun script) for the sensor cases + none
// (in-process import) for the templateEligibleArtifacts cases. No LLM, no
// tokens — byte-reproducible.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, toPortablePath } from "../harness/fixtures.ts";
// Import the function unit from the SHIPPED tree (dist), the same tree the
// spawned SENSOR script runs from — so the in-process unit and the cli boundary
// agree on exactly what ships. AIDLC_SRC = <REPO_ROOT>/dist/claude/.claude, so
// from tests/unit/ that is ../../dist/claude/.claude/tools/aidlc-graph.ts.
import {
	memoryTemplatesDir,
	templateEligibleArtifacts,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { parseBoltDag, unitsBlockRepair } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { existsSync, readdirSync } from "node:fs";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-required-sections.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeWorkspace(): {
  root: string;
  outDir: string;
  templatesDir: string;
  frameworkDir: string;
} {
  let root = mkdtempSync(join(tmpdir(), "aidlc-t155-"));
  root = toPortablePath(root);
  tempDirs.push(root);
  const outDir = join(root, "out");
  const templatesDir = join(root, "aidlc", "memory", "templates");
  const frameworkDir = join(root, "framework-templates");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });
  mkdirSync(frameworkDir, { recursive: true });
  return { root, outDir, templatesDir, frameworkDir };
}

function writeFile(path: string, body: string): void {
  writeFileSync(path, body, "utf-8");
}

interface SensorResult {
  pass: boolean;
  h2_count: number;
  headings: string[];
  findings_count: number;
  template?: string;
  template_expected?: string[];
  template_missing?: string[];
  config_warning?: string;
  edge_block?: string;
  message?: string;
  raw: string;
  status: number | null;
}

// Spawn the per-sensor script the way the dispatcher does (threading
// --templates-dir + --template-eligible). templatesDir/eligible optional so the
// no-template (third) branch is exercisable.
function runSensor(opts: {
  stage: string;
  outputPath: string;
  templatesDir?: string;
  frameworkTemplatesDir?: string;
  eligible?: string[];
}): SensorResult {
  const args = [SENSOR, "--stage", opts.stage, "--output-path", opts.outputPath];
  if (opts.templatesDir !== undefined) {
    args.push("--templates-dir", opts.templatesDir);
  }
  if (opts.frameworkTemplatesDir !== undefined) {
    args.push("--framework-templates-dir", opts.frameworkTemplatesDir);
  }
  if (opts.templatesDir !== undefined || opts.frameworkTemplatesDir !== undefined) {
    args.push("--template-eligible", (opts.eligible ?? []).join(","));
  }
  const res = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  const raw = res.stdout ?? "";
  const parsed = JSON.parse(raw.trim());
  return { ...parsed, raw, status: res.status };
}

describe("t155 templateEligibleArtifacts (function unit, in-process)", () => {
  test("filters out -questions and -timestamp markers, keeps prose artifacts", () => {
    const produces = [
      "requirements",
      "requirements-analysis-questions",
      "business-overview",
      "reverse-engineering-timestamp",
    ];
    expect(templateEligibleArtifacts(produces)).toEqual([
      "requirements",
      "business-overview",
    ]);
  });

  test("empty / nullish produces → empty eligible set", () => {
    expect(templateEligibleArtifacts([])).toEqual([]);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising nullish guard
    expect(templateEligibleArtifacts(undefined as any)).toEqual([]);
  });
});

describe("t155 template-override sensor branch (cli, spawnSync)", () => {
  test("non-Markdown output quiet-passes with the locked result shape", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "traceability.json");
    writeFile(out, '{"upstream_ids":[],"coverage":[]}\n');
    const r = runSensor({
      stage: "user-stories",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["traceability"],
    });
    expect(r.status).toBe(0);
    expect(r.raw).toBe(
      '{"pass":true,"h2_count":0,"headings":[],"findings_count":0}\n',
    );
    expect(r.pass).toBe(true);
    expect(r.h2_count).toBe(0);
    expect(r.headings).toEqual([]);
    expect(r.findings_count).toBe(0);
    expect(r.template).toBeUndefined();
    expect(r.edge_block).toBeUndefined();
  });

  // 1 — resolution: template `##` set ⊆ output → pass, template:"applied".
  test("resolved template, all headings present → pass + template:applied", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.templatesDir, "requirements.md"),
      "# Requirements\n\n## Functional Requirements\n\n## Constraints\n",
    );
    const out = join(ws.outDir, "requirements.md");
    writeFile(
      out,
      "# Requirements\n\n## Functional Requirements\nF1\n\n## Constraints\nC1\n## Extra\nbonus\n",
    );
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.template).toBe("applied");
    expect(r.template_expected).toEqual([
      "## Functional Requirements",
      "## Constraints",
    ]);
    expect(r.template_missing).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
    expect(r.status).toBe(0);
  });

  // 2 — precise findings: a template heading the output lacks.
  test("resolved template, missing heading → fail + precise missing finding", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.templatesDir, "requirements.md"),
      "# Requirements\n\n## Functional Requirements\n\n## Non-Functional Requirements\n\n## Constraints\n",
    );
    const out = join(ws.outDir, "requirements.md");
    writeFile(
      out,
      "# Requirements\n\n## Functional Requirements\nF1\n\n## Constraints\nC1\n",
    );
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.template).toBe("applied");
    expect(r.template_missing).toEqual(["## Non-Functional Requirements"]);
    expect(r.findings_count).toBe(1);
    expect(r.pass).toBe(false);
    // Advisory: verdict is data, exit still 0.
    expect(r.status).toBe(0);
  });

  // #2417: a leading emoji is decoration (headingKey, as in #1385), so
  // `## 📌 Overview` is the template's `## Overview`, and back.
  test("emoji-decorated headings match their template headings", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.templatesDir, "requirements.md"),
      "# Requirements\n\n## Overview\n\n## \u{1F4CB} Constraints\n\n## Risks\n",
    );
    const out = join(ws.outDir, "requirements.md");
    writeFile(
      out,
      "# Requirements\n\n## \u{1F4CC} Overview\nO1\n\n## Constraints\nC1\n",
    );
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.template).toBe("applied");
    // A missing section is still reported as the template spells it.
    expect(r.template_missing).toEqual(["## Risks"]);
    expect(r.findings_count).toBe(1);
    expect(r.pass).toBe(false);
  });

  // 3 — override-before-default keyed by stem: a multi-artifact stage resolves
  // EACH artifact against its own template, distinctly. reverse-engineering
  // produces both business-overview and architecture (verified produces list).
  test("multi-artifact stage resolves each artifact by its own stem-keyed template", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.templatesDir, "business-overview.md"),
      "## Mission\n\n## Domain\n",
    );
    writeFile(
      join(ws.templatesDir, "architecture.md"),
      "## Components\n\n## Data Flow\n",
    );
    const eligible = ["business-overview", "architecture"];

    const bo = join(ws.outDir, "business-overview.md");
    writeFile(bo, "## Mission\nm\n\n## Domain\nd\n");
    const rbo = runSensor({
      stage: "reverse-engineering",
      outputPath: bo,
      templatesDir: ws.templatesDir,
      eligible,
    });
    expect(rbo.template).toBe("applied");
    expect(rbo.template_expected).toEqual(["## Mission", "## Domain"]);
    expect(rbo.pass).toBe(true);

    // architecture output: missing Data Flow → fail against ITS template only.
    const arch = join(ws.outDir, "architecture.md");
    writeFile(arch, "## Components\nc\n\n## Notes\nn\n");
    const rarch = runSensor({
      stage: "reverse-engineering",
      outputPath: arch,
      templatesDir: ws.templatesDir,
      eligible,
    });
    expect(rarch.template).toBe("applied");
    expect(rarch.template_expected).toEqual(["## Components", "## Data Flow"]);
    expect(rarch.template_missing).toEqual(["## Data Flow"]);
    expect(rarch.pass).toBe(false);
  });

  // 4 - third branch: no template resolves, so no heading is required.
  test("no template resolves: nothing required (template field absent)", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## One\n\n## Two\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir, // dir exists but no requirements.md in it
      eligible: ["requirements"],
    });
    expect(r.template).toBeUndefined();
    expect(r.raw.includes("template")).toBe(false);
    expect(r.h2_count).toBe(2);
    expect(r.pass).toBe(true);
  });

  test("third branch holds even with no --templates-dir flag at all (bare call)", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# R\n\n## Only One\n");
    const r = runSensor({ stage: "requirements-analysis", outputPath: out });
    expect(r.template).toBeUndefined();
    expect(r.h2_count).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  // --- MIDDLE branch: framework-default templates (team, then framework, then none) ---

  // 5 - framework default applies when the team dir misses (the middle tier).
  test("framework-default template applies when team dir has none → template:applied", () => {
    const ws = makeWorkspace();
    // team dir empty; framework dir ships requirements.md.
    writeFile(
      join(ws.frameworkDir, "requirements.md"),
      "# Requirements\n\n## Functional Requirements\n\n## Constraints\n",
    );
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## Functional Requirements\nF1\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir, // exists, no requirements.md
      frameworkTemplatesDir: ws.frameworkDir,
      eligible: ["requirements"],
    });
    expect(r.template).toBe("applied");
    expect(r.template_expected).toEqual(["## Functional Requirements", "## Constraints"]);
    expect(r.template_missing).toEqual(["## Constraints"]);
    expect(r.pass).toBe(false);
  });

  // 6 — override-before-default: TEAM template WINS over framework default.
  test("team template overrides framework default (first hit wins)", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.templatesDir, "requirements.md"),
      "# Team\n\n## Team Section A\n\n## Team Section B\n",
    );
    writeFile(
      join(ws.frameworkDir, "requirements.md"),
      "# Framework\n\n## Framework Only\n",
    );
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## Team Section A\nx\n## Team Section B\ny\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      frameworkTemplatesDir: ws.frameworkDir,
      eligible: ["requirements"],
    });
    expect(r.template).toBe("applied");
    expect(r.template_expected).toEqual(["## Team Section A", "## Team Section B"]);
    expect(r.pass).toBe(true);
  });

  // 7 - GA reality: framework dir present but EMPTY (zero default files), so
  // no heading is required.
  test("empty framework dir (GA default) falls through: nothing required", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## One\n\n## Two\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir, // empty
      frameworkTemplatesDir: ws.frameworkDir, // empty (the shipped GA state)
      eligible: ["requirements"],
    });
    expect(r.template).toBeUndefined();
    expect(r.h2_count).toBe(2);
    expect(r.pass).toBe(true);
  });

  // 8 — eligibility gate still applies to a framework-default resolution.
  test("framework default for an ineligible artifact is ignored + config_warning", () => {
    const ws = makeWorkspace();
    writeFile(
      join(ws.frameworkDir, "intent-questions.md"),
      "## Q1\n\n## Q2\n\n## Q3\n",
    );
    const out = join(ws.outDir, "intent-questions.md");
    writeFile(out, "# Q\n\n## Only One\n");
    const r = runSensor({
      stage: "intent-capture",
      outputPath: out,
      frameworkTemplatesDir: ws.frameworkDir,
      eligible: [],
    });
    expect(r.template).toBe("ineligible");
    expect(r.config_warning).toBeDefined();
    // The template was ignored, so its 3 headings are not required.
    expect(r.pass).toBe(true);
  });

  // 5 — eligibility gating (the MUST-FIX hazard). A team drops a template for
  // a questions marker; it must be IGNORED + warned, NOT applied.
  test("ineligible artifact: resolved template ignored + config_warning", () => {
    const ws = makeWorkspace();
    // Team authored a template for a questions marker (unsound stem key).
    writeFile(
      join(ws.templatesDir, "requirements-analysis-questions.md"),
      "## Q1\n\n## Q2\n\n## Q3\n",
    );
    const out = join(ws.outDir, "requirements-analysis-questions.md");
    // One H2, so the verdict shows the ignored template did not govern.
    writeFile(out, "## Questions\n[Q]: ...\n[Answer]: ...\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      // eligible set EXCLUDES the questions marker (dispatcher-filtered).
      eligible: ["requirements"],
    });
    expect(r.template).toBe("ineligible");
    expect(typeof r.config_warning).toBe("string");
    expect(r.config_warning).toContain("requirements-analysis-questions.md");
    expect(r.template_missing).toBeUndefined();
    // The template was IGNORED: its 3 headings are not findings.
    expect(r.h2_count).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
    expect(r.status).toBe(0); // advisory
  });

  // 7 — same-file invariant: the template the sensor's expected set comes from
  // IS the file the agent fills. Read both ends, assert byte-identity of the
  // heading set the sensor reports vs the template file on disk.
  test("same-file invariant: sensor expected set == the template file headings", () => {
    const ws = makeWorkspace();
    const templateBody =
      "# Skeleton\n\n## Alpha\nfill me\n\n## Beta\nfill me\n";
    const templatePath = join(ws.templatesDir, "requirements.md");
    writeFile(templatePath, templateBody);
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Out\n\n## Alpha\nx\n\n## Beta\ny\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    // Derive the expected set independently from the SAME template file bytes.
    const headingsFromTemplate = templateBody
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("## "));
    expect(r.template_expected).toEqual(headingsFromTemplate);
    expect(r.pass).toBe(true);
  });

  // Timestamp markers are run records, not documents. practices-discovery
  // specifies its marker as one line; it passes with its headings still
  // reported.
  test("timestamp marker written to spec (one line, no headings) passes", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "practices-discovery-timestamp.md");
    writeFile(out, "Discovered: 2026-09-24T00:17:00Z at commit 7eb3a33\n");
    const r = runSensor({ stage: "practices-discovery", outputPath: out });
    expect(r.pass).toBe(true);
    expect(r.h2_count).toBe(0);
    expect(r.findings_count).toBe(0);
    expect(r.template).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("timestamp marker with one heading passes and still reports it", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "practices-discovery-timestamp.md");
    writeFile(out, "# Practices Discovery Timestamp\n\n## Discovery Record\n\nDiscovered: now\n");
    const r = runSensor({ stage: "practices-discovery", outputPath: out });
    expect(r.pass).toBe(true);
    expect(r.headings).toEqual(["## Discovery Record"]);
    expect(r.findings_count).toBe(0);
  });

  test("questions marker with no `##` heading passes", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "requirements-analysis-questions.md");
    writeFile(out, "# Questions\n\nQ1: pick one\n[Answer]:\n");
    const r = runSensor({ stage: "requirements-analysis", outputPath: out });
    expect(r.pass).toBe(true);
    expect(r.h2_count).toBe(0);
    expect(r.findings_count).toBe(0);
  });

  test("template resolving for a timestamp marker is ignored + warned, marker still passes", () => {
    const ws = makeWorkspace();
    writeFile(join(ws.templatesDir, "practices-discovery-timestamp.md"), "## When\n\n## Commit\n");
    const out = join(ws.outDir, "practices-discovery-timestamp.md");
    writeFile(out, "Discovered: 2026-09-24T00:17:00Z at commit none\n");
    const r = runSensor({
      stage: "practices-discovery",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["team-practices", "discovered-rules", "evidence"],
    });
    expect(r.template).toBe("ineligible");
    expect(r.config_warning).toContain("timestamp markers are not shape-checked");
    expect(r.template_missing).toBeUndefined();
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  // 8 - REGRESSION (the dispatcher default-path mismatch). The dispatcher's
  // default --templates-dir MUST resolve to the SAME location SEED ships the
  // templates/ floor. A default of <pd>/aidlc/memory/templates while SEED ships
  // <pd>/aidlc/spaces/default/memory/templates is a clean miss that silently
  // disables every team template at the real runtime path. The other tests cannot
  // catch it because they ALWAYS inject an explicit --templates-dir. These pin the
  // default-path computation (derived via memoryTemplatesDir from the same
  // MEMORY_SEGMENTS the rules resolver + packager use) and cross-check it against
  // where dist actually ships, so the sensor lookup and the ship location can
  // never drift apart.
  test("memoryTemplatesDir resolves under spaces/default/memory (the ship + resolver root)", () => {
    const td = memoryTemplatesDir("/ws").replace(/\\/g, "/");
    expect(td).toBe("/ws/aidlc/spaces/default/memory/templates");
    expect(td).not.toBe("/ws/aidlc/memory/templates");
  });

  test("the dispatcher default templates dir matches where the packager SHIPS the floor", () => {
    // AIDLC_SRC = <repo>/dist/claude/.claude; the shipped tree's workspace root
    // is its parent (<repo>/dist/claude), where aidlc/ is emitted.
    const shippedWorkspaceRoot = join(AIDLC_SRC, "..");
    const dispatcherDefault = memoryTemplatesDir(shippedWorkspaceRoot);
    expect(existsSync(dispatcherDefault)).toBe(true);
    // ...the templates/ floor SEED ships (the .gitkeep guarantees it exists).
    expect(readdirSync(dispatcherDefault)).toContain(".gitkeep");
  });
});

// #2721: a file written the way its stage shapes it passes. Reverse
// Engineering gives component-inventory.md and technology-stack.md no headings
// and Build and Test gives cross-unit-traceability.md none, so an H1 with `###`
// subsections or a table is to spec; the gate used to say "2 findings" about
// each. When the check does fail, the result says why in plain words, and the
// detail file the agent corrects from carries it.
describe("t155 #2721: no rule the instructions do not give, and a plain reason", () => {
  const COMPONENT_INVENTORY = [
    "# Component Inventory",
    "",
    "### OrderService",
    "- Responsibility: takes orders",
    "- Depends on: PaymentClient",
    "",
    "### PaymentClient",
    "- Responsibility: calls the payment API",
    "",
    "| Component | Owner |",
    "|---|---|",
    "| OrderService | orders |",
    "",
  ].join("\n");
  const TABLE_ONLY = (title: string) =>
    `# ${title}\n\n| Item | Value |\n|---|---|\n| Language | TypeScript 5.4 |\n| Runtime | Node.js 20 |\n`;

  for (const [stage, file, body] of [
    ["reverse-engineering", "component-inventory.md", COMPONENT_INVENTORY],
    ["reverse-engineering", "technology-stack.md", TABLE_ONLY("Technology Stack")],
    ["build-and-test", "cross-unit-traceability.md", TABLE_ONLY("Cross-Unit Traceability")],
  ] as const) {
    test(`${stage} ${file} with no \`##\` headings, as its stage shapes it, passes`, () => {
      const ws = makeWorkspace();
      const out = join(ws.outDir, file);
      writeFile(out, body);
      const r = runSensor({
        stage,
        outputPath: out,
        templatesDir: ws.templatesDir,
        frameworkTemplatesDir: ws.frameworkDir,
        eligible: [file.replace(/\.md$/, "")],
      });
      expect(r.pass).toBe(true);
      expect(r.findings_count).toBe(0);
      expect(r.h2_count).toBe(0);
      expect(r.headings).toEqual([]);
      expect(r.message).toBeUndefined();
      expect(r.status).toBe(0);
    });
  }

  test("a questions file with one question passes", () => {
    const ws = makeWorkspace();
    const out = join(ws.outDir, "requirements-analysis-questions.md");
    writeFile(
      out,
      "# Requirements Questions\n\n## Q1. [Product] Who signs in?\nA. Staff\nB. Customers\nX. Other (please specify)\n\n[Answer]:\n",
    );
    const r = runSensor({ stage: "requirements-analysis", outputPath: out });
    expect(r.h2_count).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("a template miss says which section is missing, in one sentence", () => {
    const ws = makeWorkspace();
    writeFile(join(ws.templatesDir, "requirements.md"), "# Requirements\n\n## Scope\n\n## Risks\n");
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## Scope\nS1\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.pass).toBe(false);
    expect(r.message).toBe("requirements.md is missing the `## Risks` section its template asks for.");
  });

  test("several template misses are named in the one sentence, in the template's order", () => {
    const ws = makeWorkspace();
    writeFile(join(ws.templatesDir, "requirements.md"), "# Requirements\n\n## Scope\n\n## Risks\n\n## Owners\n");
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## Risks\nR1\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.findings_count).toBe(2);
    expect(r.message).toBe("requirements.md is missing 2 sections its template asks for: `## Scope`, `## Owners`.");
  });

  test("a template that is met carries no message", () => {
    const ws = makeWorkspace();
    writeFile(join(ws.templatesDir, "requirements.md"), "# Requirements\n\n## Scope\n");
    const out = join(ws.outDir, "requirements.md");
    writeFile(out, "# Requirements\n\n## Scope\nS1\n");
    const r = runSensor({
      stage: "requirements-analysis",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["requirements"],
    });
    expect(r.pass).toBe(true);
    expect(r.message).toBeUndefined();
    expect(r.raw.includes("message")).toBe(false);
  });

  const UNITS_CYCLE = ["# Unit Dependencies", "", "## Order", "", "```yaml", "units:", "  - name: a", "    depends_on: [b]", "  - name: b", "    depends_on: [a]", "```", "", "## Notes", ""].join("\n");
  const UNITS_ABSENT = "# Unit Dependencies\n\n## Order\n\na before b\n\n## Notes\n\nnone\n";

  for (const [label, body] of [
    ["cyclic", UNITS_CYCLE],
    ["absent", UNITS_ABSENT],
  ] as const) {
    test(`units block ${label}: the result says what to write, in the engine's own repair words`, () => {
      const ws = makeWorkspace();
      const out = join(ws.outDir, "unit-of-work-dependency.md");
      writeFile(out, body);
      const r = runSensor({ stage: "units-generation", outputPath: out });
      const parsed = parseBoltDag(body);
      if (parsed.ok) throw new Error("fixture block must not parse");
      expect(r.pass).toBe(false);
      expect(r.edge_block).toBe(label);
      expect(r.message).toBe(unitsBlockRepair(parsed.reason, parsed.detail));
    });
  }

  test("a template miss and a broken units block in one file make one message", () => {
    const ws = makeWorkspace();
    writeFile(join(ws.templatesDir, "unit-of-work-dependency.md"), "# Unit Dependencies\n\n## Order\n\n## Risks\n");
    const out = join(ws.outDir, "unit-of-work-dependency.md");
    writeFile(out, UNITS_ABSENT);
    const r = runSensor({
      stage: "units-generation",
      outputPath: out,
      templatesDir: ws.templatesDir,
      eligible: ["unit-of-work-dependency"],
    });
    const parsed = parseBoltDag(UNITS_ABSENT);
    if (parsed.ok) throw new Error("fixture block must not parse");
    expect(r.pass).toBe(false);
    expect(r.findings_count).toBe(2);
    expect(r.message).toBe(
      `unit-of-work-dependency.md is missing the \`## Risks\` section its template asks for. ${unitsBlockRepair(parsed.reason, parsed.detail)}`,
    );
  });
});

// lib-vocab.ts + lib-shape.ts: a safe.json field keeps AI-DLC's own word, a
// number, a time or a version; any other name (a plugin's stage, the team's
// agent, a name inside text someone wrote) becomes an anonymous label, the same
// label each time; a Bolt's name is not sent at all.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Labels, Shaper } from "../../core/skills/aidlc-issue-report/scripts/lib-shape.ts";
import { loadVocab } from "../../core/skills/aidlc-issue-report/scripts/lib-vocab.ts";
import { importAidlcTools } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";

// The AI-DLC install whose own file-match rule the vocabulary borrows.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function install(): string {
  const project = mkdtempSync(join(tmpdir(), "shape-"));
  const files: Record<string, string> = {
    ".kiro/tools/aidlc-state.ts": `const E = ["STAGE_STARTED", "complete", "gate-unresolved", "lock busy", "engine", "orchestrate", "next", "kiro-ide", "strict", "high", "Running", "Standard", "Shell", "you"];`,
    ".kiro/tools/aidlc-guard-fences.ts": `export const GUARD_FENCES = [\n  "plan-approval",\n  "review-freeze",\n] as const;`,
    ".kiro/scopes/aidlc-bugfix.md": "---\nname: bugfix\ndepth: Minimal\n---\n",
    ".kiro/agents/aidlc-architect-agent.md": "",
    ".kiro/hooks/aidlc-plan-approval-guard.ts": `const H = 'plan-approval-guard';`,
    ".kiro/sensors/aidlc-traceability.md": "",
    ".kiro/scopes/feature.md": "",
    ".kiro/aidlc-common/stages/inception/requirements-analysis.md": "# Requirements Analysis",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), text);
  }
  const data = join(project, ".kiro", "tools", "data");
  mkdirSync(data, { recursive: true });
  const sha = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;
  writeFileSync(join(data, "aidlc-manifest.json"), JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha(t)])) }));
  // A team's own stage, added the documented way, has no `plugin` owner and no stage file in the manifest.
  mkdirSync(join(project, ".kiro", "aidlc-common", "stages", "inception"), { recursive: true });
  writeFileSync(join(project, ".kiro", "aidlc-common", "stages", "inception", "globex-pci-review.md"), "# PCI review");
  writeFileSync(
    join(data, "stage-graph.json"),
    JSON.stringify([
      { slug: "requirements-analysis", phase: "inception" },
      { slug: "contoso-review", phase: "inception", plugin: "acme-pack" },
      { slug: "globex-pci-review", phase: "inception" },
    ]),
  );
  return project;
}

const shaper = () => new Shaper(loadVocab(install(), [".kiro"]), new Labels());

describe("names", () => {
  test("AI-DLC's own stage stays; a plugin's stage gets a label, the same one each time", () => {
    const s = shaper();
    expect(s.stage("requirements-analysis")).toBe("requirements-analysis");
    expect(s.stage("contoso-review")).toBe("<custom-stage-1>");
    expect(s.stage("contoso-review")).toBe("<custom-stage-1>");
    expect(s.stage("acme-intake")).toBe("<custom-stage-2>");
  });
  test("an agent AI-DLC installed stays; one that only looks like it does not", () => {
    const s = shaper();
    expect(s.agent("aidlc-architect-agent")).toBe("aidlc-architect-agent");
    expect(s.agent("default")).toBe("default");
    expect(s.agent("aidlc-contoso-agent")).toBe("<custom-agent-1>");
  });
  test("a public model id stays; a deployment ARN with an account in it does not", () => {
    const s = shaper();
    expect(s.model("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(s.model("arn:aws:bedrock:us-east-1:123456789012:inference-profile/acme")).toBe("<custom-model-1>");
  });
  test("a public model's own variant words stay; a name after a public family and version does not", () => {
    const s = shaper();
    for (const m of ["global.openai.gpt-6.1-sol", "claude-3-5-sonnet-20241022", "anthropic.claude-3-5-sonnet-20241022-v2:0", "gpt-4o-mini", "o4-mini", "gemini-2.5-pro", "nova-pro-v1:0", "claude-opus-5-5[1m]"]) {
      expect(s.model(m)).toBe(m);
    }
    expect(s.model("gpt-6.1-contoso")).toBe("<custom-model-1>");
    expect(s.model("claude-opus-5-contoso-prod")).toBe("<custom-model-2>");
    expect(s.model("nova-pro-contoso")).toBe("<custom-model-3>");
  });
});

describe("audit rows", () => {
  test("a Bolt's name is not sent; an MCP tool is mcp; a status someone typed is a label", () => {
    const s = shaper();
    const out = s.auditFields({
      "Failed Bolt": "Contoso checkout integration",
      Tool: "mcp__contoso_crm__lookup",
      Status: "Waiting for Contoso sign-off",
      Stage: "requirements-analysis",
      "Exit Code": "1",
      "Sensor ID": "acme-lint",
    });
    expect(out).toEqual({ Tool: "mcp", Status: "<custom-value-1>", Stage: "requirements-analysis", "Exit Code": "1", "Sensor ID": "<custom-sensor-1>" });
  });
  test("an MCP tool the readers already wrote as mcp stays mcp", () => {
    expect(shaper().tool("mcp")).toBe("mcp");
  });
  test("AI-DLC's own tool and status words stay", () => {
    expect(shaper().auditFields({ Tool: "aidlc-state.ts", Status: "complete" })).toEqual({ Tool: "aidlc-state.ts", Status: "complete" });
  });
  test("a guard is one of AI-DLC's fences or hooks, not any word AI-DLC's source has", () => {
    expect(shaper().auditFields({ Guard: "plan-approval" })).toEqual({ Guard: "plan-approval" });
    expect(shaper().auditFields({ Guard: "plan-approval-guard" })).toEqual({ Guard: "plan-approval-guard" });
    expect(shaper().auditFields({ Guard: "Shell" })).toEqual({ Guard: "<custom-hook-1>" });
  });
  test("a guard switch keeps its scope and who switched it", () => {
    expect(shaper().auditFields({ Guard: "review-freeze", Scope: "bugfix", Source: "you" })).toEqual({ Guard: "review-freeze", Scope: "bugfix", Source: "you" });
  });
});

describe("other fields", () => {
  test("a hook drop's reason is AI-DLC's own words or other", () => {
    const h = shaper().hooks({
      last: { "plan-approval-guard": "2026-10-29T01:00:00Z", "acme-audit": "2026-10-29T01:00:00Z" },
      drops: [
        { ts: "2026-10-29T01:00:00Z", hook: "plan-approval-guard", reason: "lock busy", degraded: false },
        { ts: "2026-10-29T01:01:00Z", hook: "plan-approval-guard", reason: "ENOENT /srv/acme/x", degraded: true },
      ],
    });
    expect(Object.keys(h.last).sort()).toEqual(["<custom-hook-1>", "plan-approval-guard"]);
    expect(h.drops.map((d) => d.reason)).toEqual(["lock busy", "other"]);
  });
  test("a command keeps only AI-DLC's words; a doctor finding not AI-DLC's is a label", () => {
    const s = shaper();
    const t = s.transcript({
      tool: "kiro (v3)", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
      stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: { "aidlc engine orchestrate next": 2, "aidlc acme-portal": 1 },
      repeats: [], timeline: [], subagents: {}, engine: "v3", toolVersions: { "2.33.1": 1 }, models: {}, efforts: {}, agents: {},
      approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [],
    });
    expect(t).toMatchObject({ aidlcCommands: { "aidlc engine orchestrate next": 2 } });
    expect(s.doctorFinding({ id: "acme-plugin-check", severity: "WARNING" })).toEqual({ id: "<custom-doctor-finding-1>", severity: "warning" });
    expect(s.doctorFinding({ id: "gate-unresolved", severity: "ERROR" })).toEqual({ id: "gate-unresolved", severity: "error" });
  });
  test("an install's source tag stays; a private build name is a label", () => {
    const env = (sourceRef: string) =>
      shaper().environment({
        os: "darwin 25.6.0 arm64",
        bun: "1.4.3",
        pin: null,
        native: { dir: "/x", exe: "/x/aidlc", version: "2.11.2", sourceRef },
        tools: {},
        kiroHomeEngine: { file: false, agentEngine: null },
      });
    expect(env("refs/tags/v2.11.2").native?.sourceRef).toBe("refs/tags/v2.11.2");
    expect(env("acme-internal-fork").native?.sourceRef).toBe("<custom-build-1>");
    expect(env("0123456789abcdef0123456789abcdef01234567").native?.sourceRef).toBe("0123456789abc");
  });
});

describe("the state file", () => {
  const state = (over: Record<string, unknown>) => shaper().state({ intent: "(space)", ...over });
  test("its capitalized values, the stage in progress and the scope's own name stay", () => {
    expect(state({ status: "Running", depth: "Standard", inProgress: "requirements-analysis", scope: "bugfix" })).toMatchObject({
      status: "Running",
      depth: "Standard",
      inProgress: "requirements-analysis",
      scope: "bugfix",
    });
    expect(state({ inProgress: "none" })?.inProgress).toBe("none");
  });
  test("a setting keeps its value without the note on where it came from; none is an empty list", () => {
    expect(state({ guardsOff: "none", guardsOn: "plan-approval, review-freeze (set by you)", guardPolicy: "strict (from scope classic)", planApproval: "high (default)" })).toMatchObject({
      guardsOff: "none",
      guardsOn: "plan-approval, review-freeze",
      guardPolicy: "strict",
      planApproval: "high",
    });
  });
  test("a capitalized name is still a label, and the guards lists hold fences only", () => {
    expect(state({ status: "Contoso", guardsOff: "plan-approval, Shell" })).toMatchObject({ status: "<custom-value-1>", guardsOff: "plan-approval, <custom-hook-1>" });
  });
});

describe("where AI-DLC's words come from", () => {
  test("a team's stage without a plugin owner is not AI-DLC's", () => {
    expect(shaper().stage("globex-pci-review")).toBe("<custom-stage-1>");
  });
  test("a tool edited after install no longer lends its words", () => {
    const project = install();
    appendFileSync(join(project, ".kiro", "tools", "aidlc-state.ts"), `\nconst X = "Contoso";`);
    const v = loadVocab(project, [".kiro"]);
    expect(v.words.has("Contoso")).toBe(false);
    expect(v.words.has("STAGE_STARTED")).toBe(false);
  });
});

test("a tree checked out with Windows line ends (git core.autocrlf) still lends AI-DLC's words", async () => {
  const { readFileSync } = await import("node:fs");
  const project = install();
  const lf = 'const A = "EXTRA_EVENT";\nconst B = 1;\n';
  const manifestPath = join(project, ".kiro", "tools", "data", "aidlc-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files[".kiro/tools/aidlc-extra.ts"] = `sha256:${createHash("sha256").update(lf).digest("hex")}`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(project, ".kiro", "tools", "aidlc-extra.ts"), lf.replaceAll("\n", "\r\n"));
  expect(loadVocab(project, [".kiro"]).words.has("EXTRA_EVENT")).toBe(false);
  const tools = await importAidlcTools(RULES);
  expect(loadVocab(project, [".kiro"], undefined, tools.holdsRecordedWrite).words.has("EXTRA_EVENT")).toBe(true);
});

describe("versions and kernel releases", () => {
  test("a version keeps three numbers and loses a sentence's last dot", async () => {
    const { version, exactVersion } = await import("../../core/skills/aidlc-issue-report/scripts/lib-shape.ts");
    expect(version("GitHub Copilot CLI 0.0.354.")).toBe("0.0.354");
    expect(version("1.4.13.2")).toBe("1.4.13");
    expect(exactVersion("1.4.13.2")).toBe("1.4.13");
    expect(exactVersion("2.33.1-preview.20261029.1")).toBe("2.33.1-preview.20261029.1");
  });
  test("a Linux or WSL kernel release stays as the OS wrote it", () => {
    const os = (release: string) =>
      shaper().environment({ os: `linux ${release} x64`, bun: null, pin: null, native: null, tools: {}, kiroHomeEngine: { file: false, agentEngine: null } }).os;
    expect(os("5.15.167.4-microsoft-standard-WSL2")).toBe("linux 5.15.167.4-microsoft-standard-WSL2 x64");
    expect(os("6.8.0-45-generic")).toBe("linux 6.8.0-45-generic x64");
  });
});

test("AI-DLC's message text is taken from its installed tools: the fixed parts, never what fills the slots", () => {
  const project = install();
  // A template literal's slot, written out (`${n}`).
  const slot = (name: string) => `${"$"}{${name}}`;
  const tool = [
    "const budget = (stage: string, n: number) =>",
    `  \`Cannot request review pass ${slot("n")} for "${slot("stage")}" because this stage allows \` +`,
    `  \`${slot("n")} review pass. \`;`,
    "const next = \"Do not ask the reviewer again; include the findings in the approval summary for the human.\";",
    "const short = \"lock busy\";",
  ].join("\n");
  const manifestPath = join(project, ".kiro", "tools", "data", "aidlc-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files[".kiro/tools/aidlc-log.ts"] = `sha256:${createHash("sha256").update(tool).digest("hex")}`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(project, ".kiro", "tools", "aidlc-log.ts"), tool);
  const phrases = [...loadVocab(project, [".kiro"]).phrases];
  expect(phrases).toContain("Cannot request review pass");
  expect(phrases).toContain('" because this stage allows');
  expect(phrases).toContain("Do not ask the reviewer again; include the findings in the approval summary for the human.");
  expect(phrases).not.toContain("lock busy");
  // A tool edited after install lends no text.
  writeFileSync(join(project, ".kiro", "tools", "aidlc-log.ts"), `${tool}\nconst x = "Contoso Bank asked for the review again";`);
  expect([...loadVocab(project, [".kiro"]).phrases].some((p) => p.includes("Contoso"))).toBe(false);
});

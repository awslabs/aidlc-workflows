// lib-vocab.ts + lib-shape.ts: a safe.json field keeps AI-DLC's own word, a
// number, a time or a version; any other name (a plugin's stage, the team's
// agent, a name inside text someone wrote) becomes an anonymous label, the same
// label each time; a Bolt's name is not sent at all.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shapeValue } from "../../core/skills/aidlc-issue-report/scripts/lib-rows.ts";
import { eventValueOk, Labels, Shaper } from "../../core/skills/aidlc-issue-report/scripts/lib-shape.ts";
import { loadVocab } from "../../core/skills/aidlc-issue-report/scripts/lib-vocab.ts";
import { gateContext } from "../../core/skills/aidlc-issue-report/scripts/lib-check.ts";
import { safeHits } from "../../core/skills/aidlc-issue-report/scripts/lib-gate.ts";
import { importAidlcTools } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";

// The AI-DLC install whose own file-match rule the vocabulary borrows.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function install(): string {
  const project = mkdtempSync(join(tmpdir(), "shape-"));
  const files: Record<string, string> = {
    ".kiro/tools/aidlc-state.ts": `const E = ["STAGE_STARTED", "complete", "gate-unresolved", "lock busy", "engine", "orchestrate", "next", "kiro-ide", "strict", "high", "Running", "Standard", "Shell", "you", "guard-tool-call"];`,
    ".kiro/tools/aidlc-guard-fences.ts": `export const GUARD_FENCES = [\n  "plan-approval",\n  "review-freeze",\n] as const;`,
    ".kiro/scopes/aidlc-bugfix.md": "---\nname: bugfix\ndepth: Minimal\n---\n",
    ".kiro/agents/aidlc-architect-agent.md": "",
    ".kiro/hooks/aidlc-plan-approval-guard.ts": `const H = 'plan-approval-guard'; const M = "Code generation cannot run until the plan is approved:";`,
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
  test("an engine route that runs several hooks keeps its name; a hook of the team's own gets a label", () => {
    const s = shaper();
    expect(s.hook("guard-tool-call")).toBe("guard-tool-call");
    expect(s.hook("aidlc-plan-approval-guard")).toBe("plan-approval-guard");
    expect(s.hook("globex-audit")).toMatch(/^<custom-hook-\d+>$/);
  });
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

describe("audit rows, read against a real install's words", () => {
  const field = (event: string, name: string, value: string) => {
    const labels = new Labels();
    return shapeValue(loadVocab(install(), [".kiro"]), { label: (k, raw) => labels.label(k, raw), known: () => undefined }, event, name, value);
  };
  test("a Bolt's name, a status someone typed and a plugin's check are labels; an MCP tool is a label too", () => {
    expect(field("BOLT_FAILED", "Failed Bolt", "Contoso checkout integration")).toBe("<custom-unit-1>");
    expect(field("UNIT_PAUSED", "Status", "Waiting for Contoso sign-off")).toBe("<custom-value-1>");
    expect(field("SENSOR_FAILED", "Sensor ID", "acme-lint")).toBe("<custom-value-1>");
    expect(field("ARTIFACT_UPDATED", "Tool", "mcp__contoso_crm__lookup")).toBe("<custom-value-1>");
    expect(field("SENSOR_FAILED", "Exit Code", "1")).toBe(1);
  });
  test("an MCP tool the readers already wrote as mcp stays mcp", () => {
    expect(shaper().tool("mcp")).toBe("mcp");
  });
  test("AI-DLC's own tool, status, stage and guard words stay", () => {
    expect(field("ARTIFACT_UPDATED", "Tool", "aidlc-state.ts")).toBe("aidlc-state.ts");
    expect(field("UNIT_COMPLETED", "Status", "complete")).toBe("complete");
    expect(field("STAGE_STARTED", "Stage", "requirements-analysis")).toBe("requirements-analysis");
    expect(field("GUARD_DISABLED", "Guard", "plan-approval")).toBe("plan-approval");
    expect(field("GUARD_DISABLED", "Guard", "plan-approval-guard")).toBe("plan-approval-guard");
    expect(field("GUARD_DISABLED", "Guard", "Shell")).toBe("<custom-value-1>");
  });
  test("a guard switch keeps its scope and who switched it", () => {
    expect(field("GUARD_DISABLED", "Scope", "bugfix")).toBe("bugfix");
    expect(field("GUARD_DISABLED", "Source", "you")).toBe("you");
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
  test("every event the shaper writes passes the check, a name that is not AI-DLC's (null) included", () => {
    const v = loadVocab(install(), [".kiro"]);
    const s = new Shaper(v, new Labels());
    const base = {
      tool: "codex", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
      otherHookBlocks: 0, unattributedHookBlocks: 0, stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {},
      repeats: [], timeline: [], subagents: {}, engine: null, toolVersions: {}, models: {}, efforts: {}, agents: {},
      approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [],
    };
    const t = s.transcript({
      ...base,
      events: [
        { ts: "2026-10-29T01:00:00Z", session: "", kind: "aidlc-command", verb: "contoso-deploy now" },
        { ts: "2026-10-29T01:01:00Z", session: "s1", kind: "call", tool: "", input: "k" },
        { ts: "2026-10-29T01:01:30Z", session: "s1", kind: "call", tool: "ContosoTool", input: "k" },
        { ts: "2026-10-29T01:02:00Z", session: "s1", kind: "aidlc-hook-block", hook: "", owner: "aidlc", reason: "Gate is closed." },
        { ts: "2026-10-29T01:02:30Z", session: "s1", kind: "aidlc-hook-block", hook: "contoso-hook", owner: "aidlc" },
        { ts: "2026-10-29T01:03:00Z", session: "s1", kind: "tool-error", exitCode: 1, timeoutMs: 120000, interrupted: true, noTime: true },
        { ts: "2026-10-29T01:04:00Z", session: "s1", kind: "person-turn", reply: "go on", inRunningTurn: true, sameAsBeforeInTurn: true },
      ],
    }) as { events: Record<string, unknown>[] };
    expect([t.events[0].verb, t.events[1].tool, t.events[3].hook]).toEqual([null, null, null]);
    expect(safeHits(gateContext(v, { entries: [] }), { transcripts: [t] })).toEqual([]);
  });
  test("the event stream keeps its kinds and AI-DLC's names; a session, an input and a reply are labels, the same value the same label", () => {
    const s = shaper();
    const base = {
      tool: "codex", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
      otherHookBlocks: 0, unattributedHookBlocks: 0, stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {},
      repeats: [], timeline: [], subagents: {}, engine: null, toolVersions: {}, models: {}, efforts: {}, agents: {},
      approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [],
    };
    const t = s.transcript({
      ...base,
      events: [
        { ts: "2026-10-29T01:02:00Z", session: "sess-acme-9", kind: "call", tool: "exec_command", input: "k1" },
        { ts: "2026-10-29T01:01:00Z", session: "sess-acme-9", kind: "person-turn", reply: "approve it for ContosoPay" },
        { ts: "2026-10-29T01:03:00Z", session: "sess-acme-9", kind: "call", tool: "mcp__contoso_crm__lookup", input: "k1" },
        { ts: "2026-10-29T01:04:00Z", session: "sess-acme-9", kind: "made-up-kind", reply: "approve it for ContosoPay" },
        { ts: "2026-10-29T01:05:00Z", session: "sess-acme-9", kind: "person-turn", reply: "go on", inRunningTurn: true, sameAsBeforeInTurn: true },
      ],
    }) as { events: Record<string, unknown>[] };
    expect(t.events).toEqual([
      { seq: 1, ts: "2026-10-29T01:01:00.000Z", session: "<custom-session-1>", kind: "person-turn", reply: "<custom-text-1>" },
      { seq: 2, ts: "2026-10-29T01:02:00.000Z", session: "<custom-session-1>", kind: "call", tool: "exec_command", input: "<custom-id-1>" },
      { seq: 3, ts: "2026-10-29T01:03:00.000Z", session: "<custom-session-1>", kind: "call", tool: "mcp", input: "<custom-id-1>" },
      { seq: 4, ts: "2026-10-29T01:04:00.000Z", session: "<custom-session-1>", kind: "other", reply: "<custom-text-1>" },
      { seq: 5, ts: "2026-10-29T01:05:00.000Z", session: "<custom-session-1>", kind: "person-turn", reply: "<custom-text-2>", inRunningTurn: true, sameAsBeforeInTurn: true },
    ]);
    expect(JSON.stringify(t.events)).not.toMatch(/acme|Contoso/i);
  });
  test("a refusal's text keeps AI-DLC's own words and labels the rest, and the check reads it back by the same rule", () => {
    const v = loadVocab(install(), [".kiro"]);
    const t = new Shaper(v, new Labels()).transcript({
      tool: "claude", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
      otherHookBlocks: 0, unattributedHookBlocks: 1, stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {},
      repeats: [], timeline: [], subagents: {}, engine: null, toolVersions: {}, models: {}, efforts: {}, agents: {},
      approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [],
      events: [{ ts: "2026-10-29T01:00:00Z", session: "s1", kind: "hook-block", owner: "unknown", reason: "Code generation cannot run until the plan is approved: /srv/acme/plan.md" }],
    }) as { events: Record<string, unknown>[] };
    const reason = t.events[0].reason as string;
    expect(reason.startsWith("Code generation cannot run until the plan is approved: ")).toBe(true);
    expect(reason).not.toMatch(/acme/i);
    const c = gateContext(v, { entries: [] });
    expect(safeHits(c, { transcripts: [t] })).toEqual([]);
    expect(safeHits(c, { transcripts: [{ events: [{ ...t.events[0], reason: "Code generation cannot run until the plan is approved: /srv/acme/plan.md" }] }] }).map((h) => h.field)).toEqual([
      "safe.transcripts[0].events[0].reason",
    ]);
  });
  test("a command keeps only AI-DLC's words; a doctor finding not AI-DLC's is a label", () => {
    const s = shaper();
    const t = s.transcript({
      tool: "kiro (v3)", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 0, toolErrors: 0, denials: {}, aidlcHookBlocks: {},
      otherHookBlocks: 0, unattributedHookBlocks: 0, stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: { "aidlc engine orchestrate next": 2, "aidlc acme-portal": 1 },
      repeats: [], timeline: [], subagents: {}, engine: "v3", toolVersions: { "2.33.1": 1 }, models: {}, efforts: {}, agents: {},
      approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [], events: [],
    });
    expect(t).toMatchObject({ aidlcCommands: { "aidlc engine orchestrate next": 2 } });
    expect(s.doctorFinding({ id: "acme-plugin-check", severity: "WARNING" })).toEqual({ id: "<custom-doctor-finding-1>", severity: "warning" });
    expect(s.doctorFinding({ id: "gate-unresolved", severity: "ERROR" })).toEqual({ id: "gate-unresolved", severity: "error" });
  });
  test("a refusal the log does not name and Kiro's denied calls keep their own words", () => {
    const t = shaper().transcript({
      tool: "kiro (v3)", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 2, toolErrors: 2,
      denials: { "denied-after-aidlc-hooks": 1, "denied-no-reason": 1 }, aidlcHookBlocks: {}, otherHookBlocks: 1, unattributedHookBlocks: 1,
      stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {}, repeats: [],
      timeline: [
        { ts: "2026-10-29T01:00:00Z", kind: "hook-block", detail: "" },
        { ts: "2026-10-29T01:01:00Z", kind: "tool-denied", detail: "denied-after-aidlc-hooks" },
      ],
      subagents: {}, engine: "v3", toolVersions: {}, models: {}, efforts: {}, agents: {}, approvalModes: {}, handRunChecks: [],
      reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [], events: [],
    });
    expect(t).toMatchObject({
      otherHookBlocks: 1,
      unattributedHookBlocks: 1,
      denials: { "denied-after-aidlc-hooks": 1, "denied-no-reason": 1 },
      timeline: [{ kind: "hook-block", detail: "" }, { kind: "tool-denied", detail: "denied-after-aidlc-hooks" }],
    });
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

test("a failed Claude Code or Codex call keeps how it ended from the tool's own line, never the command's", async () => {
  const { claudeErrorFacts, codexErrorFacts } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  // Shapes measured on Claude Code and Codex transcripts.
  expect(claudeErrorFacts("Exit code 1\nnpm ERR! missing script")).toEqual({ exitCode: 1 });
  expect(claudeErrorFacts("[Tool call interrupted: the session ended before this call's result was recorded]")).toEqual({ interrupted: true });
  expect(claudeErrorFacts("Error: Exit code 2 somewhere")).toEqual({});
  expect(codexErrorFacts("Chunk ID: 855927\nWall time: 7.9 seconds\nProcess exited with code 2\nOutput:\nProcess exited with code 0")).toEqual({ exitCode: 2 });
  expect(codexErrorFacts("Chunk ID: 1\nOutput:\nProcess exited with code 9")).toEqual({});
  expect(codexErrorFacts("Exit code: 1\nWall time: 0.2 seconds\nOutput:\nboom")).toEqual({ exitCode: 1 });
  expect(codexErrorFacts("Process exited with code 4321\nno header here")).toEqual({});
  expect(codexErrorFacts(JSON.stringify([{ type: "input_text", text: "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nboom" }]))).toEqual({ exitCode: 1 });
});

test("a failed Kiro call keeps how it ended as numbers and a flag: exit code, time limit, cut short; never its text", async () => {
  const { kiroErrorFacts } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  // Kiro's own trailer (measured on a Kiro IDE run, 2026-11-04).
  expect(kiroErrorFacts("Output:\n^C\r\n\nExit Code: 130")).toEqual({ exitCode: 130, interrupted: true });
  expect(kiroErrorFacts("This tool was interrupted before it reported a result, so it may or may not have taken effect.")).toEqual({ interrupted: true });
  expect(kiroErrorFacts("Output:\n\n\nCommand timed out after 120000ms\n\nExit Code: -1")).toEqual({ exitCode: -1, timeoutMs: 120000 });
  expect(kiroErrorFacts("npm ERR! code ENOENT /srv/acme")).toEqual({});
  // What the command printed is not read: above the trailer, nor as its own last line beside its own exit code.
  expect(kiroErrorFacts("Output:\nCommand timed out after 5000ms\n^C\nInterrupted: 1 error\nexited with code 2\n\nExit Code: 1")).toEqual({ exitCode: 1 });
  expect(kiroErrorFacts("Output:\nCommand timed out after 5000ms\n\nExit Code: 1")).toEqual({ exitCode: 1 });
  expect(kiroErrorFacts("Output:\n^C\n\nExit Code: 1")).toEqual({ exitCode: 1 });
  expect(kiroErrorFacts("Output:\nThis tool was interrupted before it reported a result, so it may or may not have taken effect.")).toEqual({ interrupted: true });
  expect(kiroErrorFacts(JSON.stringify([{ type: "text", text: "Output:\n\nExit Code: 2" }]))).toEqual({ exitCode: 2 });
  expect(kiroErrorFacts(JSON.stringify([{ type: "text", text: "This tool was interrupted before it reported a result." }]))).toEqual({ interrupted: true });
  // A block's own fields after its text are not read as the text's last line.
  expect(kiroErrorFacts(JSON.stringify([{ text: "Output:\n\nExit Code: 2", status: "error", toolUseId: "t1" }]))).toEqual({ exitCode: 2 });
  const v = loadVocab(install(), [".kiro"]);
  const t = new Shaper(v, new Labels()).transcript({
    tool: "kiro (v3: Kiro IDE)", sessions: 1, firstTs: null, lastTs: null, prompts: 0, toolCalls: 1, toolErrors: 1, denials: {}, aidlcHookBlocks: {},
    otherHookBlocks: 0, unattributedHookBlocks: 0, stopFeedback: 0, approvalPrompts: 0, questionsAsked: 0, aidlcCommands: {},
    repeats: [], timeline: [], subagents: {}, engine: null, toolVersions: {}, models: {}, efforts: {}, agents: {},
    approvalModes: {}, handRunChecks: [], reportSessions: 0, mixedSessions: 0, reportModels: {}, notes: [],
    events: [
      { ts: "2026-11-04T07:00:00Z", session: "s1", kind: "tool-error", exitCode: -1, timeoutMs: 120000 },
      { ts: "2026-11-04T07:01:00Z", session: "s1", kind: "tool-error", exitCode: 130, interrupted: true },
      { ts: "2026-11-04T07:02:00Z", session: "s1", kind: "tool-error", exitCode: 123456789, timeoutMs: 1.5 },
    ],
  }) as { events: Record<string, unknown>[] };
  expect(t.events[0]).toMatchObject({ kind: "tool-error", exitCode: -1, timeoutMs: 120000 });
  expect(t.events[1]).toMatchObject({ exitCode: 130, interrupted: true });
  expect(t.events[2].exitCode).toBeUndefined();
  // The check holds the same bounds the shaper keeps.
  const bad = { transcripts: [{ events: [{ ...t.events[0], exitCode: 12345 }, { ...t.events[0], timeoutMs: 12345678 }] }] };
  expect(safeHits(gateContext(v, { entries: [] }), bad).map((h) => h.field)).toEqual(["safe.transcripts[0].events[0].exitCode", "safe.transcripts[0].events[1].timeoutMs"]);
  // An event holds the shaper's fields and no other.
  const extra = { transcripts: [{ events: [{ ...t.events[0], note: "ok" }] }] };
  expect(safeHits(gateContext(v, { entries: [] }), extra).map((h) => `${h.field}: ${h.reason}`)).toContain(`safe.transcripts[0].events[0] (its key number ${Object.keys(extra.transcripts[0].events[0]).indexOf("note") + 1}): a key this part does not have (remove that key)`);
  // A key is named by its place, never by itself, in one hit only.
  const odd = { transcripts: [{ events: [{ ts: t.events[0].ts, session: t.events[0].session, kind: "tool-error", exit_code: 1 }] }] };
  expect(safeHits(gateContext(v, { entries: [] }), odd).map((h) => `${h.field}: ${h.reason}`)).toEqual([
    "safe.transcripts[0].events[0] (its key number 4): a key this part does not have (remove that key)",
  ]);
  // The key has one hit; an end fact that is not a number gets one too.
  const named = { transcripts: [{ events: [{ ts: t.events[0].ts, session: t.events[0].session, kind: "tool-error", extra: "Contoso", exitCode: "<redacted>" }] }] };
  const namedHits = safeHits(gateContext(v, { entries: [] }), named).map((h) => `${h.field}: ${h.reason}`);
  // What the stray value held is said beside it, without a second fix.
  expect(namedHits.filter((h) => h.includes("(its key number") || h.includes(".exitCode:"))).toEqual([
    "safe.transcripts[0].events[0] (its key number 4): a key this part does not have (remove that key)",
    "safe.transcripts[0].events[0] (its key number 4): not one of AI-DLC's words, a label or a known shape",
    "safe.transcripts[0].events[0].exitCode: not what this field's rule writes (remove it)",
  ]);
  // An event is flat: a list or an object in any of its fields is refused whole, once, whatever keys it holds; an
  // end fact outside an event is read by the same rule; a stray key holding a secret keeps its credential hit.
  const ctx = gateContext(v, { entries: [] });
  const ev0 = { ts: t.events[0].ts, session: t.events[0].session, kind: "tool-error" };
  const one = (e: object) => safeHits(ctx, { transcripts: [{ events: [{ ...ev0, ...e }] }] }).map((h) => `${h.field}: ${h.reason}`);
  for (const [key, bad] of [["exitCode", [12345678]], ["exitCode", { seq: 87654321 }], ["timeoutMs", [{ ts: 87654321 }]], ["interrupted", { seq: 123456789 }], ["noTime", [{ count: 987654321 }]], ["reason", ["Gate is closed."]], ["interrupted", false]] as const) {
    const got = one({ [key]: bad });
    // One fix, to remove it; anything else said is what it held, with no second fix.
    expect(got.filter((h) => /\((?:replace|remove|write)\b/.test(h))).toEqual([`safe.transcripts[0].events[0].${key}: not what this field's rule writes (remove it)`]);
  }
  expect(one({ reason: 12345678 })).toEqual(["safe.transcripts[0].events[0].reason: not what this field's rule writes (remove it)"]);
  // An event that is not an object is refused once; a secret deep in a stray key's value is still said.
  expect(safeHits(ctx, { transcripts: [{ events: [[{ ...ev0, exitCode: [12345678] }]] }] }).map((h) => `${h.field}: ${h.reason}`)).toEqual(["safe.transcripts[0].events[0]: not what this part holds (remove it)"]);
  expect(one({ extra: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }).map((h) => h.split(": ")[1])).toContain("a credential");
  expect(one({ password: ["hunter2xyz"] }).map((h) => h.split(": ")[1])).toContain("a credential");
  // A wrong-shaped value, and a key inside a stray value, are read for what they held too.
  expect(one({ reason: [{ token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] }).map((h) => h.split(": ")[1])).toContain("a credential");
  expect(eventValueOk("constructor", "x")).toBe(false);
  expect(one({ kind: "deploy" })[0]).toBe("safe.transcripts[0].events[0].kind: not what this field's rule writes (remove it)");
  expect(one({ owner: "contoso" })[0]).toBe("safe.transcripts[0].events[0].owner: not what this field's rule writes (remove it)");
  const held = one({ extra: 123456789012 }).map((h) => h.split(": ")[1]);
  expect(held).toContain("a long number");
  expect(safeHits(ctx, { transcripts: [{ events: [{ ...ev0, timeoutMs: { a: 87654321 } }] }] }).map((h) => h.reason)).toContain("not what this field's rule writes (remove it)");
  expect(safeHits(ctx, { hooks: { exitCode: 87654321 } }).map((h) => h.field)).toEqual(["safe.hooks.exitCode"]);
  const secret = safeHits(ctx, { transcripts: [{ events: [{ ...ev0, password: "hunter2xyz" }] }] }).map((h) => h.reason);
  expect(secret).toContain("a key this part does not have (remove that key)");
  expect(secret).toContain("a credential");
  expect(secret.filter((r) => r.startsWith("a key this part"))).toHaveLength(1);
  expect(t.events[2].timeoutMs).toBeUndefined();
  expect(safeHits(gateContext(v, { entries: [] }), { transcripts: [t] })).toEqual([]);
});

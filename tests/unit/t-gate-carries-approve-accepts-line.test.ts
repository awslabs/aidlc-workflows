// covers: function:gateApproveAcceptsLine, function:renderReviewBrief, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, tool:aidlc-review-brief, audit:GATE_APPROVED
//
// At a reviewed gate with an open finding, the line that says Approve accepts it as risk, and how to decide it
// differently, reaches the person in the step that shows the gate, as a line they must hear: the reply that opens
// the gate and `next` showing it again carry it last in their change_notices, under their note. The Review brief,
// which an agent may retell in its own words, no longer carries it, so it is said once. Approve then records as
// Accepted risk the finding the carried line named, and the brief its record names is kept with the line after it;
// a gate with no open finding carries no line and records none.
//
// Mechanism: cli, over the answers corpus Requirements Analysis gate, the real human-turn hook, the real report,
// next and review brief.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { STAGE } from "../harness/aidlc-answers-corpus.ts";
import { env, exec, next, ORCHESTRATE, reviewedStage, say } from "../harness/aidlc-input-corpus.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, seededRecordDir } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

const FINDING = "| Medium | requirements.md | A title of only spaces is not said to be blank | Say that it is refused |";
const LINE =
  "Approve accepts the open review finding R-01 (A title of only spaces is not said to be blank) as risk; you can " +
  "also approve and ask for it to be fixed, or reject it as not applying, saying why.";

interface Directive {
  kind?: string;
  gate_only?: boolean;
  change_notices?: string[];
  change_notices_note?: string;
  rules_content?: unknown[];
  rules_held?: unknown;
}

async function run(proj: string, tool: string, args: string[]): Promise<{ status: number; out: string; directive: Directive | null }> {
  const res = await exec([process.execPath, tool, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
  let directive: Directive | null = null;
  try {
    directive = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as Directive;
  } catch {
    directive = null;
  }
  return { status: res.status, out: `${res.stdout}${res.stderr}`, directive };
}

const report = (proj: string, result: string, extra: string[] = []) =>
  run(proj, ORCHESTRATE, ["report", "--stage", STAGE, "--result", result, ...extra]);

async function brief(proj: string): Promise<string> {
  const shown = await run(proj, join(AIDLC_SRC, "tools", "aidlc-review-brief.ts"), ["review", "--stage", STAGE, "--why", "first"]);
  expect(shown.status, shown.out).toBe(0);
  return shown.out;
}

async function reviewed(findings: readonly string[]): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  await reviewedStage(proj, findings);
  return proj;
}

// What the gate's one GATE_APPROVED row records, as "<id> <status>".
function recorded(proj: string): string[] {
  const row = readAuditShardEvents(proj)
    .findLast((event) => event.event === "GATE_APPROVED" && auditBlockField(event.block, "Stage") === STAGE);
  expect(row).toBeDefined();
  const field = auditBlockField(row?.block ?? "", "Review Finding Dispositions");
  if (field === null) return [];
  return (JSON.parse(field) as { dispositions: Array<{ id: string; status: string }> }).dispositions
    .map(({ id, status }) => `${id} ${status}`);
}

async function approve(proj: string): Promise<void> {
  expect((await say(proj, "Approve", "claude")).status).toBe(0);
  const approved = await report(proj, "approved", ["--user-input", "Approve"]);
  expect(approved.directive?.kind, approved.out).toBe("done");
}

describe("the gate carries the line that says what Approve accepts", () => {
  test("the reply that opens the gate says it last, as a line the person must hear, and Approve records what it named", async () => {
    const proj = await reviewed([FINDING]);
    const opened = await report(proj, "awaiting-approval");
    expect(opened.directive?.kind, opened.out).toBe("print");
    expect(opened.directive?.change_notices?.at(-1), opened.out).toBe(LINE);
    expect(opened.directive?.change_notices_note, opened.out).toStartWith("Say each change_notices line to the person once, as written");
    // The agent shows the brief, then the line; the approval's record names the kept text, which holds both.
    const shown = await brief(proj);
    await approve(proj);
    expect(recorded(proj)).toEqual(["R-01 Accepted risk"]);
    const row = readAuditShardEvents(proj).findLast((event) => event.event === "GATE_APPROVED");
    const digest = /^sha256:([0-9a-f]{64})$/.exec(auditBlockField(row?.block ?? "", "Brief Digest") ?? "")?.[1];
    expect(digest, row?.block).toBeDefined();
    const kept = join(seededRecordDir(proj), ".aidlc-engine", "reviews", STAGE, "stage", "briefs", `${digest}.md`);
    expect(readFileSync(kept, "utf-8")).toBe(`${shown}\n${LINE}\n`);
  });

  test("next showing the open gate again says it again, with the gate's rules as without the line", async () => {
    const proj = await reviewed([FINDING]);
    expect((await report(proj, "awaiting-approval")).directive?.kind).toBe("print");
    const shown = await next(proj, []);
    expect(shown.directive?.gate_only, shown.out).toBe(true);
    const again = shown.directive as Directive | null;
    expect(again?.change_notices, shown.out).toContain(LINE);
    expect(again?.change_notices_note, shown.out).toStartWith("Say each change_notices line to the person once, as written");
    // The step stays the routed one: the person's rules come with it, as at a gate with no line to say.
    expect(again?.rules_content ?? again?.rules_held, shown.out).toBeDefined();
  });

  test("the Review brief no longer carries it, so it is said once", async () => {
    const proj = await reviewed([FINDING]);
    expect((await report(proj, "awaiting-approval")).directive?.kind).toBe("print");
    const shown = await brief(proj);
    expect(shown).toContain("| R-01 | Medium |");
    expect(shown).not.toContain("Approve accepts");
    expect(shown).toContain("- **Approve** - continue.\n");
  });

  test("a gate with no open finding carries no line, and Approve records no accepted risk", async () => {
    const proj = await reviewed([]);
    const opened = await report(proj, "awaiting-approval");
    expect(opened.directive?.kind, opened.out).toBe("print");
    expect((opened.directive?.change_notices ?? []).filter((line) => line.startsWith("Approve accepts")), opened.out).toEqual([]);
    expect(await brief(proj)).toContain("- **Approve** - continue; no findings are open.");
    await approve(proj);
    expect(recorded(proj)).toEqual([]);
  });
});

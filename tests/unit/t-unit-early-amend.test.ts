// covers: subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, audit:SHARED_INPUT_AMENDED, function:buildClaimNotes, function:latestCompletionBasesFromAudit
//
// Starting early and changing a shared input (#2410, item 7). A Unit that waits
// on another can start early on the branches that one pushed, said to change
// before it merges; its team hears once when that Unit is done or turned down,
// and AI-DLC never rebases for it. A team proposes a change to an input it was
// approved with; the owner of the shared plan answers once at the home, in
// their own words; an approved change reaches every team building with it as
// a fact on its claim, on every Guard Policy, and the stages that used it read
// as current, so nobody approves anything again. A Unit already done hears it
// with an offer of follow-up work and is never reopened.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { latestCompletionBasesFromAudit } from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  ENV,
  git,
  HOME_RECORD,
  mergeOnHost,
  next,
  refundsTaken,
  run,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const REQUIREMENTS = "inception/requirements-analysis/requirements.md";

// refunds pushed by payments; a data member's clone with billing, ready to take
// reporting, which waits on refunds.
function refundsPushed() {
  const taken = refundsTaken();
  codeGenerated(taken.alice, taken.record);
  expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
  git(taken.home.dir, ["fetch", "-q", "origin"]);
  const dana = cloneOf(taken.home.remote, "dana");
  cloneCode(taken.hosts.billing, dana, "billing", "dana");
  cloneCode(taken.hosts["checkout-api"], dana, "checkout-api", "dana");
  return { ...taken, dana };
}

function notices(step: Record<string, unknown>): string[] {
  return (step.change_notices ?? []) as string[];
}

describe("starting early", () => {
  test("a waiting Unit whose dependency pushed is offered early, and starts on its branch", () => {
    const { dana, hosts } = refundsPushed();
    const ask = next(dana);
    const labels = (ask.choices as Array<{ label: string; command: string }>).map((choice) => choice.label);
    expect(labels, JSON.stringify(ask)).toContain("Start reporting early");
    const took = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(
      "It starts early on the pushed branch of refunds in checkout-api and billing. It may still change before it merges.",
    );
    expect(git(join(dana, "billing"), ["branch", "--show-current"])).toBe("reporting");
    expect(git(join(dana, "billing"), ["rev-parse", "HEAD"])).toBe(git(hosts.billing, ["rev-parse", "refunds"]));
  });

  test("without the dependency pushed, the Unit waits, and the line says when it opens", () => {
    const taken = refundsTaken();
    const dana = cloneOf(taken.home.remote, "dana");
    const early = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early"], dana);
    expect(early.status).not.toBe(0);
    expect(early.out).toContain("reporting waits on refunds, which is not done at the home yet. It opens once it is done.");
  });

  test("the early team hears once when its dependency is done, and keeps its work", () => {
    const { home, hosts, dana } = refundsPushed();
    expect(run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    git(dana, ["fetch", "-q", "origin"]);
    const line = "refunds is done at the home. reporting started early on its branch: rebase on it when you are ready.";
    const step = next(dana);
    expect(notices(step), JSON.stringify(step)).toContain(line);
    expect(step.kind).toBe("run-stage");
    expect(git(join(dana, "billing"), ["branch", "--show-current"])).toBe("reporting");
  });

  test("the early team hears once when its dependency is turned down, and nothing else changes", () => {
    const { home, dana } = refundsPushed();
    expect(run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana).status).toBe(0);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger"], home.dir).status).toBe(0);
    git(dana, ["fetch", "-q", "origin"]);
    const step = next(dana);
    expect(notices(step)).toContain(
      "refunds was turned down at the home; reporting started on its branch. Nothing else changes: wait for it, or rebase when you are ready.",
    );
    expect(step.kind).toBe("run-stage");
  });
});

describe("a change to a shared input", () => {
  function proposed() {
    const taken = refundsTaken();
    const copy = join(taken.record, ...REQUIREMENTS.split("/"));
    writeFileSync(copy, "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], taken.alice);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json?.notice).toBe(
      "Sent to the home: your change to the requirements. I'm carrying on with your version here until the home decides.",
    );
    git(taken.home.dir, ["fetch", "-q", "origin"]);
    return taken;
  }

  test("the owner is asked once at the home, and their approval reaches every team building with it", () => {
    const { home, alice } = proposed();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-amend");
    expect(ask.question).toBe(
      'payments proposes a change to the requirements for refunds ("refunds need partial amounts"). Approve it for every ' +
        "Unit that uses it, or turn it down?",
    );
    expect(String(ask.amend_command)).toContain(`amend refunds --input ${REQUIREMENTS} --answer <approve|reject>`);
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir);
    expect(amended.status, amended.out).toBe(0);
    expect(amended.json?.notice).toBe(
      "The requirements is changed at the home. The teams building with it hear it once and carry on; nobody approves anything again.",
    );
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, ...REQUIREMENTS.split("/")), "utf-8"))
      .toBe("# Requirements\n\nFR1 refunds, partial amounts too.\n");
    // bob's build takes the new copy and hears it once; nothing is asked of him.
    git(bob, ["fetch", "-q", "origin"]);
    const step = next(bob);
    expect(notices(step)).toContain("The requirements changed at the home; checkout-ui uses the new one from here.");
    expect(step.kind).toBe("run-stage");
    const intents = join(bob, "aidlc", "spaces", "web", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
    expect(readFileSync(join(record, ...REQUIREMENTS.split("/")), "utf-8")).toBe("# Requirements\n\nFR1 refunds, partial amounts too.\n");
    expect(notices(next(bob))).not.toContain("The requirements changed at the home; checkout-ui uses the new one from here.");
    // The team that proposed it hears the answer.
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice))).toContain("The home approved your change to the requirements.");
  });

  test("turned down: the team hears the owner's words and carries on with the approved one", () => {
    const { home, alice } = proposed();
    next(home.dir);
    const down = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "reject", "--person-words", "partial refunds wait for phase two"], home.dir);
    expect(down.status, down.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice))).toContain(
      'The home turned down your change to the requirements: "partial refunds wait for phase two". I\'m carrying on with the approved one.',
    );
  });

  test("the answer is the person's: only with a turn of theirs behind it", () => {
    const { home } = proposed();
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    next(home.dir);
    const early = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir, guarded);
    expect(early.status).not.toBe(0);
    expect(String(early.json?.error)).toBe("The answer to a proposed change is the person's own word: ask them first, then run this with their words.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "yes, partial refunds" }, home.dir);
    const theirs = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir, guarded);
    expect(theirs.status, theirs.out).toBe(0);
  });

  test("asked once: after the person spoke without answering, the step says it waits", () => {
    const { home } = proposed();
    expect(next(home.dir).ask_type).toBe("unit-amend");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "let me think about the board first" }, home.dir);
    const step = next(home.dir);
    expect(step.ask_type).not.toBe("unit-amend");
    expect(notices(step)).toContain(
      "The change payments proposed to the requirements waits for your answer: approve it or turn it down when you are ready.",
    );
  });

  test("a Unit already done hears it with an offer of follow-up work, and is never reopened", () => {
    const { home, hosts, alice, record } = refundsTaken(["refunds=payments", "checkout-ui=payments"]);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const copy = join(readdirSync(join(bob, "aidlc", "spaces", "payments", "intents")).map((name) => join(bob, "aidlc", "spaces", "payments", "intents", name)).find((dir) => dir.endsWith("-checkout-ui"))!, ...REQUIREMENTS.split("/"));
    writeFileSync(copy, "# Requirements\n\nFR1 refunds, with receipts.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md"], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(run(UNIT, ["amend", "checkout-ui", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, receipts"], home.dir).status).toBe(0);
    const before = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice))).toContain(
      "The requirements changed at the home after refunds was done. Do you want me to start follow-up work for it?",
    );
    const after = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(after.match(/^- \[.\] [a-z-]+ /gm)).toEqual(before.match(/^- \[.\] [a-z-]+ /gm));
  });
});

describe("an amended input's receipt", () => {
  test("SHARED_INPUT_AMENDED stands in for the stage's receipt, as a redefined stage's does", () => {
    const basis = (hash: string) => JSON.stringify({ schema: 3, graphContract: "g", projectType: null, inputs: [], outputs: [{ artifact: "requirements", producer: "requirements-analysis", required: true, instanceCount: 1, presentCount: 1, structureHash: hash, contentHash: hash }] });
    const block = (event: string, at: string, value: string) =>
      `## ${event}\n**Timestamp**: ${at}\n**Event**: ${event}\n**Stage**: requirements-analysis\n**Validation Basis**: ${value}\n\n---\n`;
    const audit = "# AI-DLC Audit Log\n\n" +
      "## WORKFLOW_STARTED\n**Timestamp**: 2026-10-18T00:00:00Z\n**Event**: WORKFLOW_STARTED\n\n---\n" +
      block("STAGE_COMPLETED", "2026-10-18T01:00:00Z", basis("a")) +
      block("SHARED_INPUT_AMENDED", "2026-10-18T02:00:00Z", basis("b"));
    expect(latestCompletionBasesFromAudit(audit).get("requirements-analysis")?.outputs[0].contentHash).toBe("b");
  });
});

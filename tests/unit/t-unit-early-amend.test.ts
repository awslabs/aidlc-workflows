// covers: subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, audit:SHARED_INPUT_AMENDED, function:buildClaimNotes, function:latestCompletionBasesFromAudit
//
// Starting early and changing a shared input (#2410, item 7). A Unit that waits
// on another can start early on the branches that one pushed, said to change
// before it merges; its team hears once when that Unit is done, with the offer
// to move onto what merged, or turned down. A team proposes a change to an input it was
// approved with; the owner of the shared plan answers once at the home, in
// their own words; an approved change reaches every team building with it as
// a fact on its claim, on every Guard Policy, and the stages that used it read
// as current, so nobody approves anything again. A Unit already done hears it
// with an offer of follow-up work and is never reopened.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  personsChat,
  personsNext,
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
    const { dana, hosts, home } = refundsPushed();
    const ask = next(dana);
    const labels = (ask.choices as Array<{ label: string; command: string }>).map((choice) => choice.label);
    // reporting is open: started early for a team the lead named, or another.
    expect(labels, JSON.stringify(ask)).toContain("Start reporting early for payments");
    expect(labels).toContain("Start reporting early for another team");
    const took = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(
      "It starts early on the pushed branch of refunds in checkout-api and billing. It may still change before it merges.",
    );
    expect(git(join(dana, "billing"), ["branch", "--show-current"])).toBe("reporting");
    expect(git(join(dana, "billing"), ["rev-parse", "HEAD"])).toBe(git(hosts.billing, ["rev-parse", "refunds"]));
    // The home's board shows it started early.
    expect(String(next(home.dir).narration)).toContain("- reporting, data: building early on refunds, taken by dana");
  });

  test("without the dependency pushed, the Unit waits, and the line says when it opens", () => {
    const taken = refundsTaken();
    const dana = cloneOf(taken.home.remote, "dana");
    const early = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early"], dana);
    expect(early.status).not.toBe(0);
    expect(early.out).toContain("reporting waits on refunds, which is not done at the home yet. It opens once it is done.");
  });

  test("the early team hears once when its dependency is done, with the offer to move onto what merged, and keeps its work", () => {
    const { home, hosts, dana } = refundsPushed();
    expect(run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    git(dana, ["fetch", "-q", "origin"]);
    const step = next(dana);
    expect(step.ask_type, JSON.stringify(step)).toBe("unit-move-onto");
    expect(step.question).toBe("refunds is merged into main. Do you want me to move reporting onto main now? I'd move it now, so " +
      "reporting is built on what is merged instead of refunds's branch.");
    expect(next(dana).kind).toBe("run-stage");
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

  // A live run: the lead approved a newer version of a shared input after the
  // team took its copy; approving the team's small change then wrote the
  // team's whole file over it, and the lead's newer text was gone.
  test("a change made on an older copy is put onto the lead's newer text, never over it", () => {
    const { home } = proposed();
    const homeCopy = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, ...REQUIREMENTS.split("/"));
    writeFileSync(homeCopy, "# Requirements, with staff refunds (u4) approved by the lead\n\nFR1 refunds.\n");
    next(home.dir);
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir);
    expect(amended.status, amended.out).toBe(0);
    expect(readFileSync(homeCopy, "utf-8")).toBe("# Requirements, with staff refunds (u4) approved by the lead\n\nFR1 refunds, partial amounts too.\n");
  });

  test("a change that does not fit onto the lead's newer text changes nothing and says so, with both to read", () => {
    const { home } = proposed();
    const homeCopy = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, ...REQUIREMENTS.split("/"));
    writeFileSync(homeCopy, "# Requirements\n\nFR1 refunds, full amounts only.\n");
    next(home.dir);
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir);
    expect(amended.status, amended.out).not.toBe(0);
    expect(readFileSync(homeCopy, "utf-8")).toBe("# Requirements\n\nFR1 refunds, full amounts only.\n");
    expect(String(amended.json?.error ?? amended.out)).toContain("was made on an older copy of the requirements");
    expect(String(amended.json?.error ?? amended.out)).toContain(".aidlc-engine/proposed/refunds/");
    // The way on is named: the lead's own text of the two put together is approved as written.
    expect(String(amended.json?.error ?? amended.out)).toContain(`amend refunds --input ${REQUIREMENTS} --answer approve --file <`);
  });

  // A live run: the lead said to put the team's change onto the current text
  // themselves, and with no way to approve that, the agent closed the proposal
  // as turned down: the record said the lead turned down what they approved.
  test("the lead's own text of the two put together is approved as written: the team hears it approved, and every team gets it", () => {
    const { home, alice } = proposed();
    const homeCopy = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, ...REQUIREMENTS.split("/"));
    writeFileSync(homeCopy, "# Requirements\n\nFR1 refunds, full amounts only.\n");
    next(home.dir);
    const merged = join(home.dir, "merged-requirements.md");
    writeFileSync(merged, "# Requirements\n\nFR1 refunds, full or partial amounts.\n");
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--file", merged,
      "--person-words", "apply it to the current requirements yourself"], home.dir);
    expect(amended.status, amended.out).toBe(0);
    expect(readFileSync(homeCopy, "utf-8")).toBe("# Requirements\n\nFR1 refunds, full or partial amounts.\n");
    const answer = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { proposals?: Array<{ answer?: string }>; amendments?: unknown[] };
    expect(answer.proposals?.at(-1)?.answer).toBe("approved");
    expect(answer.amendments?.length).toBe(1);
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice))).toContain("The home approved your change to the requirements.");
  });

  test("the owner is asked once at the home, and their approval reaches every team building with it", () => {
    const { home, alice } = proposed();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-amend");
    const proposedAt = `aidlc/spaces/default/intents/${HOME_RECORD}/.aidlc-engine/proposed/refunds/${REQUIREMENTS}`;
    expect(ask.question).toBe(
      `payments proposes a change to the requirements for refunds ("refunds need partial amounts"). Their version is at ${proposedAt}. ` +
        "Approve it for every Unit that uses it, or turn it down?",
    );
    expect(readFileSync(join(home.dir, ...proposedAt.split("/")), "utf-8")).toBe("# Requirements\n\nFR1 refunds, partial amounts too.\n");
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

  // Arden's call on a live run: a team's own edit of its copy was written over
  // by the lead's change. Their edit stays as they left it, the new version
  // goes beside it, said once, and the lead hears it was made on the older one.
  test("a team that edited its copy keeps its edit, gets the lead's new version beside it once, and the lead hears it", () => {
    const { home, alice, record } = refundsTaken();
    // web proposes a change; payments edited its own copy meanwhile.
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const intents = join(bob, "aidlc", "spaces", "web", "intents");
    const bobRecord = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
    writeFileSync(join(bobRecord, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], bob);
    expect(sent.status, sent.out).toBe(0);
    const copy = join(record, ...REQUIREMENTS.split("/"));
    writeFileSync(copy, "# Requirements\n\nFR1 refunds. FR9 the payments team's own note.\n");
    git(home.dir, ["fetch", "-q", "origin"]);
    const amended = run(UNIT, ["amend", "checkout-ui", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes, partial refunds"], home.dir);
    expect(amended.status, amended.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const beside = `${REQUIREMENTS.replace(/\.md$/, "")}.from-lead.md`;
    const line = "The requirements changed at the home, and your copy has your own edits, so I kept yours as you left it " +
      `and put the new version beside it, at aidlc/spaces/payments/intents/${basename(record)}/${beside}: compare the two and keep what you want.`;
    expect(notices(next(alice))).toContain(line);
    expect(readFileSync(copy, "utf-8")).toBe("# Requirements\n\nFR1 refunds. FR9 the payments team's own note.\n");
    expect(readFileSync(join(record, ...beside.split("/")), "utf-8")).toBe("# Requirements\n\nFR1 refunds, partial amounts too.\n");
    expect(notices(next(alice))).not.toContain(line);
    // Their result tells the lead, once, that their copy was edited on the version before.
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const heard = "The payments team's copy of the requirements has their own edit, made on the version before your change, and they kept it: " +
      "what they built uses theirs.";
    const lead = personsChat("lead-chat");
    expect(notices(next(home.dir, lead))).toContain(heard);
    expect(notices(next(home.dir, lead))).not.toContain(heard);
  });

  // A live run: the lead approved a change while web's chat was in Code
  // Generation; web heard nothing until its push 22 minutes later, then that
  // the change came "after checkout-ui was pushed", and no redo was offered.
  test("a change approved while a team's chat is open is heard at its next stage, and one before its push is never called after it", () => {
    const { home } = proposed();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const chat = personsChat("bob-chat");
    // bob's chat has looked at its claim once already.
    personsNext(bob, chat, "bob-chat");
    expect(run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir).status).toBe(0);
    // Its build moves on to its next stage in the same chat: the change is heard there, with no fetch by hand.
    const intents = join(bob, "aidlc", "spaces", "web", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const step = personsNext(bob, chat, "bob-chat");
    expect(notices(step).join(" "), JSON.stringify(step).slice(0, 500)).toContain("The requirements changed at the home");
    expect(notices(step).join(" ")).not.toContain("after checkout-ui was pushed");
  });

  test("a team that left its copy as it was takes the lead's new version, as before", () => {
    const { home } = proposed();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    expect(run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir).status).toBe(0);
    git(bob, ["fetch", "-q", "origin"]);
    expect(notices(next(bob))).toContain("The requirements changed at the home; checkout-ui uses the new one from here.");
  });

  // A live run: a team's own proposed copy was written back to an older
  // change of the lead's at its next step, while it was told it carries on
  // with its version until the lead decides, and again after the lead
  // approved it.
  test("a team's proposed copy stays its own while the proposal waits; once approved, that is the copy it builds on", () => {
    const { home, alice, record } = refundsTaken();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const bobIntents = join(bob, "aidlc", "spaces", "web", "intents");
    const bobRecord = join(bobIntents, readdirSync(bobIntents).find((name) => name.endsWith("-checkout-ui"))!);
    // The lead approves web's change first; it reaches payments too.
    writeFileSync(join(bobRecord, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds.\n\nFR2 the checkout shows refunds.\n");
    expect(run(UNIT, ["propose", "--input", REQUIREMENTS, "--person-words", "show refunds"], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(run(UNIT, ["amend", "checkout-ui", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    next(alice);
    const copy = join(record, ...REQUIREMENTS.split("/"));
    expect(readFileSync(copy, "utf-8")).toBe("# Requirements\n\nFR1 refunds.\n\nFR2 the checkout shows refunds.\n");
    // payments then proposes its own change on that copy: it keeps its version while the lead decides.
    const theirs = "# Requirements\n\nFR1 refunds, partial amounts too.\n\nFR2 the checkout shows refunds.\n";
    writeFileSync(copy, theirs);
    expect(run(UNIT, ["propose", "--input", REQUIREMENTS, "--person-words", "partial refunds"], alice).status).toBe(0);
    next(alice);
    expect(readFileSync(copy, "utf-8")).toBe(theirs);
    // The lead approves it: that is the copy everyone builds on, never rewritten back.
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    next(alice);
    next(alice);
    expect(readFileSync(copy, "utf-8")).toBe(theirs);
    git(bob, ["fetch", "-q", "origin"]);
    next(bob);
    expect(readFileSync(join(bobRecord, ...REQUIREMENTS.split("/")), "utf-8")).toBe(theirs);
  });

  test("a team that changed its copy is asked once whether to send it home, and the send is not asked again", () => {
    const { alice, record, home } = refundsTaken();
    writeFileSync(join(record, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds, in two steps.\n");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-propose");
    expect(ask.question).toBe(
      "You changed the requirements here. Do you want me to send your change to the home for its owner to approve? " +
        "I'd send it, so every team builds from the same version.",
    );
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Send it to the home", "Keep it here only"]);
    expect(String(choices[0].command)).toEndWith(`aidlc-unit.ts propose --input ${REQUIREMENTS} --request-file aidlc/.aidlc-request-text/unit-propose.txt`);
    expect(run(UNIT, ["propose", "--input", REQUIREMENTS, "--person-words", "send it"], alice).status).toBe(0);
    expect(next(alice).ask_type).not.toBe("unit-propose");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.proposals).toEqual([expect.objectContaining({ input: REQUIREMENTS })]);
  });

  test("a pushed build hears an approved change as a fact, with nothing reopened or asked", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // web proposes a change to the input refunds was built with too; the home approves it.
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    const intents = join(bob, "aidlc", "spaces", "web", "intents");
    const bobRecord = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
    writeFileSync(join(bobRecord, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds, shown in the UI.\n");
    expect(run(UNIT, ["propose", "--input", REQUIREMENTS, "--person-words", "the UI shows refunds"], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["amend", "checkout-ui", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const step = next(alice);
    expect(notices(step)).toContain("The requirements changed at the home after refunds was pushed; refunds stays as you pushed it.");
    expect(JSON.stringify(step)).not.toContain("Do you want me to redo");
  });

  test("an approved change that does not reach a team just now names that team", () => {
    const { home } = proposed();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref" in */checkout-ui) echo 'busy' >&2; exit 1;; esac; done\n`);
    chmodSync(hook, 0o755);
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir);
    expect(amended.status, amended.out).toBe(0);
    expect(String(amended.json?.notice)).toContain("It did not reach web just now (its claim moved meanwhile), so that team does not have it yet.");
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
    expect(String(early.json?.error)).toStartWith("The answer to a proposed change is the person's own word: ask them first, then run this with their words.");
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

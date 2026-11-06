// covers: subcommand:aidlc-unit:share, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// The share and the team board read the lead's walking-skeleton answer before
// they ship it (#3652). A lead whose team said "no thin slice first" picked
// Several teams and shared the plan before AI-DLC's next step: the share
// pushed a plan with no answer on it, so every teammate's Unit waited on the
// first as a walking skeleton, and the lead's board, reached before the
// reading step, offered nothing. Now the share has the agent read the answer
// first (the report the engine already has, then the share again), the board
// reads it before it decides anything, and while the lead's answer is here and
// not in the plan the teams have, the board says so once.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF,
  ORCH,
  UNIT,
  asLeadsOwnCheckout,
  cleanupTempDirs,
  clone,
  git,
  runMergeTool,
  stateBody,
  tempDirs,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const NO = "We do not build a thin end-to-end slice first: every Unit starts as soon as what it depends on is done.";
const ALWAYS = "We always build a thin end-to-end slice first, before any other Unit.";
const HELD_BACK = "The teams still see every Unit waiting on alpha, because your answer about building a " +
  "thin slice first hasn't been shared yet. I can share the plan when you say so, or you can run `";
const CHAT = { AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000003652", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  gate?: unknown;
  handovers?: string[];
  choices?: Array<{ label: string; command?: string }>;
  change_notices?: string[];
};

// Two Units that wait on nothing: with a walking skeleton on, both wait on
// alpha, the first; with it off, both are open to the teams at once.
const DEPENDENCIES = `# Unit dependencies

\`\`\`yaml
units:
  - name: alpha
    depends_on: []
  - name: beta
    depends_on: []
\`\`\`
`;

function writeAnswer(dir: string, answer: string): void {
  const team = join(dir, "aidlc", "spaces", "default", "memory", "team.md");
  const body = readFileSync(team, "utf-8");
  const next = body.replace(/## Walking Skeleton\r?\n[\s\S]*?(?=\r?\n## )/, `## Walking Skeleton\n\n${answer}\n`);
  expect(next, "team.md has a Walking Skeleton section").not.toBe(body);
  writeFileSync(team, next);
}

// The lead's checkout of feature work several teams build, its plan pushed to
// a bare remote with a plain push and no walking-skeleton stance recorded yet:
// the moment right after the lead picked Several teams.
function makeLead(answer: string | null): { lead: string; remote: string } {
  const seed = createTestProject();
  tempDirs.push(seed);
  seedAidlcMemory(seed);
  writeFileSync(
    seededStateFile(seed),
    stateBody().replace(/\| skeleton \| - \|[^\n]*\n/, ""),
  );
  const depDir = join(seededRecordDir(seed), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "unit-of-work-dependency.md"), DEPENDENCIES);
  mkdirSync(seededAuditDir(seed), { recursive: true });
  if (answer !== null) writeAnswer(seed, answer);
  writeFileSync(join(seed, ".gitignore"), readFileSync(join(AIDLC_SRC, "..", ".gitignore"), "utf-8"));
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "main"]);
  git(seed, ["config", "user.email", "main@example.test"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "seed"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-share-first-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  for (const [key, value] of Object.entries(AUTOMATIC_GIT_MAINTENANCE_OFF)) git(remote, ["config", key, value]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const lead = clone(remote, "main");
  // git keeps no empty folder: the lead's audit folder is made on its first row.
  mkdirSync(seededAuditDir(lead), { recursive: true });
  asLeadsOwnCheckout(lead);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "the lead's plan"]);
  git(lead, ["push", "origin", "main"]);
  return { lead, remote };
}

function next(dir: string): Directive {
  let ran = runMergeTool(ORCH, ["next"], dir, false, CHAT);
  expect(ran.status, ran.out).toBe(0);
  let directive = JSON.parse(ran.stdout) as Directive;
  while (directive.kind === "load-steering" && typeof directive.receipt === "string") {
    ran = runMergeTool(ORCH, ["continue", directive.receipt], dir, false, CHAT);
    expect(ran.status, ran.out).toBe(0);
    directive = JSON.parse(ran.stdout) as Directive;
  }
  return directive;
}

function share(dir: string): Record<string, unknown> {
  const ran = runMergeTool(UNIT, ["share"], dir, false, CHAT);
  expect(ran.status, ran.out).toBe(0);
  return JSON.parse(ran.stdout) as Record<string, unknown>;
}

function report(dir: string, stance: string): string {
  const ran = runMergeTool(ORCH, ["report", "--skeleton-stance", stance], dir, false, CHAT);
  expect(ran.status, ran.out).toBe(0);
  const printed = JSON.parse(ran.stdout) as { kind?: string; message?: string };
  expect(printed.kind, ran.out).not.toBe("error");
  return String(printed.message);
}

// The plan the teams have: the state on the remote's main.
function sharedState(remote: string, lead: string): string {
  const path = relative(lead, seededStateFile(lead)).replaceAll("\\", "/");
  return git(remote, ["show", `main:${path}`]);
}

// What a teammate's fresh clone of the shared plan can take.
function claimableInAClone(remote: string): string[] {
  const mate = clone(remote, "team-b");
  const ran = runMergeTool(UNIT, ["status"], mate);
  expect(ran.status, ran.out).toBe(0);
  return (JSON.parse(ran.stdout) as { claimable: string[] }).claimable;
}

const reads = (d: Directive) => d.kind === "run-stage" && d.gate === "unresolved";
const saysHeldBack = (d: Directive) => (d.change_notices ?? []).some((line) => line.startsWith(HELD_BACK));

describe("the share and the team board read the lead's walking-skeleton answer before they ship it", () => {
  test("a share before the next step reads the answer first, then the teams can take every Unit", () => {
    const { lead, remote } = makeLead(NO);
    const before = git(remote, ["rev-parse", "main"]);
    const first = share(lead);
    expect(first.shared, JSON.stringify(first)).toBe(false);
    expect(first.error).toBeUndefined();
    const step = String(first.step);
    expect(step).toContain("Run these now, in this turn");
    expect(step).toContain("aidlc/spaces/default/memory/project.md over aidlc/spaces/default/memory/team.md");
    expect(step).toMatch(/orchestrate(\.ts)? report --skeleton-stance <on\|off\|scope-dependent>`/);
    expect(step).toMatch(/unit share` again/);
    expect(git(remote, ["rev-parse", "main"])).toBe(before);
    // The report that the share asked for sends the agent back to the share,
    // never on to `next`, whose step would be the share question again.
    const recorded = report(lead, "off");
    expect(recorded).toMatch(/unit share` asked for it, run that share again now/);
    const second = share(lead);
    expect(second.shared, JSON.stringify(second)).toBe(true);
    expect(sharedState(remote, lead)).toContain("- **Skeleton Stance**: off");
    expect(claimableInAClone(remote).sort()).toEqual(["alpha", "beta"]);
  });

  test("a share made before the answer could be read: the board reads it first, says once the teams cannot see it, until shared", () => {
    const { lead, remote } = makeLead(null);
    expect(share(lead).shared).toBe(true);
    writeAnswer(lead, NO);
    const reading = next(lead);
    expect(reads(reading), JSON.stringify(reading)).toBe(true);
    report(lead, "off");
    const told = next(lead);
    expect(reads(told), JSON.stringify(told)).toBe(false);
    expect(saysHeldBack(told), JSON.stringify(told.change_notices)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const again = next(lead);
      expect(reads(again), JSON.stringify(again)).toBe(false);
      expect(saysHeldBack(again), JSON.stringify(again.change_notices)).toBe(false);
    }
    expect(share(lead).shared).toBe(true);
    expect(sharedState(remote, lead)).toContain("- **Skeleton Stance**: off");
    expect(claimableInAClone(remote).sort()).toEqual(["alpha", "beta"]);
    const otherChat = runMergeTool(ORCH, ["next"], lead, false, { ...CHAT, AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000003653" });
    expect(otherChat.status, otherChat.out).toBe(0);
    expect(otherChat.stdout).not.toContain("hasn't been shared yet");
  });

  test("a plain push before the answer is read: the reading step, then the share offer ships it", () => {
    const { lead, remote } = makeLead(NO);
    const reading = next(lead);
    expect(reads(reading), JSON.stringify(reading)).toBe(true);
    report(lead, "off");
    const offer = next(lead);
    expect(offer.kind === "ask" && offer.ask_type === "team-handover", JSON.stringify(offer)).toBe(true);
    expect(offer.handovers).toContain("share");
    expect(share(lead).shared).toBe(true);
    expect(sharedState(remote, lead)).toContain("- **Skeleton Stance**: off");
  });

  test("a team that always builds the slice first: read first, and the Units still wait on the first", () => {
    const { lead, remote } = makeLead(ALWAYS);
    expect(share(lead).shared).toBe(false);
    report(lead, "on");
    expect(share(lead).shared).toBe(true);
    expect(sharedState(remote, lead)).toContain("- **Skeleton Stance**: on");
    expect(claimableInAClone(remote)).toEqual([]);
    expect(saysHeldBack(next(lead))).toBe(false);
  });

  test("no answer of the team's own: the share pushes at once and the board says nothing new", () => {
    const { lead, remote } = makeLead(null);
    const shared = share(lead);
    expect(shared.shared, JSON.stringify(shared)).toBe(true);
    expect(sharedState(remote, lead)).not.toContain("Skeleton Stance");
    const board = next(lead);
    expect(reads(board), JSON.stringify(board)).toBe(false);
    expect(saysHeldBack(board)).toBe(false);
  });

  test("a teammate's clone takes no reading step from its share and never records the lead's answer", () => {
    const { remote } = makeLead(null);
    const mate = clone(remote, "team-c");
    writeAnswer(mate, NO);
    const shared = share(mate);
    expect(shared.shared, JSON.stringify(shared)).toBe(true);
    expect(readFileSync(seededStateFile(mate), "utf-8")).not.toContain("Skeleton Stance");
  });
});

// covers: subcommand:aidlc-orchestrate:next, file:core/memory/org.md
//
// The team says how its changes reach main in one exact line under
// `## Way of Working`, `- **Changes reach main**: by pull request` (or `by
// merge request`) or `by direct push`, read narrowest layer first (project.md,
// team.md, org.md) as the Integration branch line is; with no such line
// anywhere it is by pull request, the default org.md's own line says, so a
// project set up before the line existed reads it too. Way of Working words
// with no line are no line: nothing reads them, asks or writes. The share
// question puts the matching choice first, marked "(Recommended)", wherever it
// offers both ways (main's own team flow, here at a home and at the lead's own
// checkout; and at work teams build in repos of their own, the share that
// carries a walking skeleton's code built here, pinned in t-unit-board), and
// when the pull request is the recommended one its own sentence says so. A narrower layer's line with
// another value marks nothing and never falls through to a broader layer's.
// The commands each choice runs and their details never change.
//
// Mechanism: the engine's own `next` on seeded team projects; no agent runs.
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededStateFile } from "../harness/fixtures.ts";
import { cleanupTeamBuild, makeHome, next, run, STATE } from "../harness/team-build.ts";
import { asLeadsOwnCheckout as ranTheWorkHere, cleanupTempDirs, makeSeed, nextDirective } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);
afterEach(cleanupTempDirs);

type Choice = { label: string; detail?: string; command?: string };

const MEMORY = join("aidlc", "spaces", "default", "memory");
const PLAIN = "Share by direct push";
const BY_PR = "Share by pull request";
const MARK = " (Recommended)";
const PLAIN_PUSH = "Pushes main to origin as a plain push; it never overwrites what anyone pushed.";
// The message the share's commit carries, shown after the question.
const MESSAGE = "\n\nShare the plan";
const HERE = "Build them here for now";
const PR_COMMAND = / unit share --branch --commit-message-file \S+\/unit-share-message-[^/ ]+\.txt$/;
const PLAIN_COMMAND = / unit share --commit-message-file \S+\/unit-share-message-[^/ ]+\.txt$/;
const DIRECT = "push main to origin, so anyone can take a Unit by opening their own clone";
const ONE_REPO_PR = "push the plan on its own branch for a pull request, so anyone can take a Unit once it is in main, " +
  `by opening their own clone and running /aidlc.${MESSAGE}`;

const choicesOf = (step: Record<string, unknown>): Choice[] => (step.choices ?? []) as Choice[];
const labels = (step: Record<string, unknown>): string[] => choicesOf(step).map((choice) => choice.label);
const choice = (step: Record<string, unknown>, label: string): Choice => {
  const found = choicesOf(step).find((entry) => entry.label === label);
  expect(found, JSON.stringify(step)).toBeDefined();
  return found!;
};

function isShare(step: Record<string, unknown>): boolean {
  return step.kind === "ask" && step.ask_type === "team-handover" && ((step.handovers ?? []) as string[]).includes("share");
}

// The team's own lines, as Practices Discovery writes them, at the top of a
// layer's Way of Working (the shipped team.md and project.md hold only comments there).
function wayOfWorking(dir: string, file: "team.md" | "project.md", lines: string[]): void {
  const path = join(dir, MEMORY, file);
  const body = readFileSync(path, "utf-8");
  expect(body).toContain("## Way of Working\n");
  writeFileSync(path, body.replace("## Way of Working\n", `## Way of Working\n\n${lines.join("\n")}\n`));
}

// An org.md written before the line existed: AI-DLC's own words, the
// Integration branch line, and no Changes line.
function olderOrg(dir: string): void {
  const path = join(dir, MEMORY, "org.md");
  writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Changes reach main\*\*:.*\r?\n/m, ""));
}

const teamLine = (value: string) => (dir: string) =>
  wayOfWorking(dir, "team.md", ["- **Integration branch**: main", `- **Changes reach main**: ${value}`]);

// A home on one repository whose teams were chosen before Home Location was
// recorded (main's own team flow): the first step is its share question.
function homeShare(memory: (dir: string) => void = () => {}): Record<string, unknown> {
  const home = makeHome({ repos: {} });
  memory(home.dir);
  const chosen = run(STATE, ["set-unit-ownership", "team"], home.dir);
  expect(chosen.status, chosen.out).toBe(0);
  writeFileSync(seededStateFile(home.dir), readFileSync(seededStateFile(home.dir), "utf-8")
    .replace(/^- \*\*Home Location\*\*: .*\r?\n/m, "")
    .replace(/^- \*\*State Version\*\*: 9$/m, "- **State Version**: 8"));
  const ask = next(home.dir);
  expect(isShare(ask), JSON.stringify(ask)).toBe(true);
  return ask;
}

// The workspace's own repo, the lead's checkout with the slice's stance
// settled: the step before the walk's first Unit is the share question.
function oneRepoShare(memory: (dir: string) => void = () => {}): Record<string, unknown> {
  const { seed: lead } = makeSeed();
  writeFileSync(
    seededStateFile(lead),
    readFileSync(seededStateFile(lead), "utf-8")
      .replace("- **Unit Gate Rhythm**: per-stage\n", "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on\n"),
  );
  ranTheWorkHere(lead);
  memory(lead);
  const ask = nextDirective(lead);
  expect(isShare(ask), JSON.stringify(ask)).toBe(true);
  return ask;
}

// By pull request first and marked, each choice running what it ran, and the
// question's own sentence saying the pull request.
function expectPullRequestFirst(ask: Record<string, unknown>): void {
  expect(labels(ask)).toEqual([`${BY_PR}${MARK}`, PLAIN, HERE]);
  expect(String(choice(ask, `${BY_PR}${MARK}`).command)).toMatch(PR_COMMAND);
  expect(String(choice(ask, PLAIN).command)).toMatch(PLAIN_COMMAND);
  expect(choice(ask, PLAIN).detail).toBe(PLAIN_PUSH);
  expect(String(ask.question)).toEndWith(ONE_REPO_PR);
}

describe("a home's share question on main's own team flow follows the team's Changes reach main line", () => {
  test("AI-DLC's own default, by pull request: Share by pull request comes first, marked Recommended, and the question says so", () => {
    const ask = homeShare();
    expectPullRequestFirst(ask);
    // Where there is no picker, the numbered question carries the same mark.
    expect(String(ask.numbered_prose_question)).toContain(`1. **${BY_PR}${MARK}** - `);
    expect(String(ask.numbered_prose_question)).toContain(`2. **${PLAIN}** - ${PLAIN_PUSH}`);
  });

  test("an org.md written before the line existed, and no line anywhere: by pull request all the same", () => {
    expectPullRequestFirst(homeShare(olderOrg));
  });

  test("Way of Working words with no line are no line: the broader layers answer, and nothing is read or asked", () => {
    const ask = homeShare((dir) => {
      olderOrg(dir);
      wayOfWorking(dir, "team.md", ["- **Integration branch**: main", "We push small fixes straight to main."]);
    });
    expectPullRequestFirst(ask);
  });

  test("team.md says by direct push: Share by direct push comes first, marked Recommended, and the question is as it was", () => {
    const ask = homeShare(teamLine("by direct push"));
    expect(labels(ask)).toEqual([`${PLAIN}${MARK}`, BY_PR, HERE]);
    expect(String(choice(ask, `${PLAIN}${MARK}`).command)).toMatch(PLAIN_COMMAND);
    expect(choice(ask, `${PLAIN}${MARK}`).detail).toBe(PLAIN_PUSH);
    expect(String(choice(ask, BY_PR).command)).toMatch(PR_COMMAND);
    expect(String(ask.question)).toContain(DIRECT);
  });

  test("project.md's line is read before team.md's, a hand-written one too", () => {
    const ask = homeShare((dir) => {
      teamLine("by pull request")(dir);
      wayOfWorking(dir, "project.md", ["- **Integration branch**: main", "Changes reach main: By direct push."]);
    });
    expect(labels(ask)).toEqual([`${PLAIN}${MARK}`, BY_PR, HERE]);
  });

  test("GitLab's words, by merge request, read as by pull request", () => {
    expectPullRequestFirst(homeShare(teamLine("by merge request")));
  });

  test("a narrower layer's line with another value marks nothing, and never takes a broader layer's in its place", () => {
    const ask = homeShare(teamLine("by carrier pigeon"));
    expect(labels(ask)).toEqual([PLAIN, BY_PR, HERE]);
    expect(String(ask.question)).toContain(DIRECT);
    expect(JSON.stringify(ask)).not.toContain("Recommended");
  });
});

describe("the one-repo share question follows the same line", () => {
  test("AI-DLC's own default: Share by pull request first, marked Recommended, its command unchanged, the question saying so", () => {
    const ask = oneRepoShare();
    expect(labels(ask)).toEqual([`${BY_PR}${MARK}`, PLAIN, HERE]);
    expect(String(choice(ask, `${BY_PR}${MARK}`).command)).toMatch(PR_COMMAND);
    expect(String(choice(ask, PLAIN).command)).toMatch(PLAIN_COMMAND);
    expect(choice(ask, PLAIN).detail).toBe(PLAIN_PUSH);
    expect(String(ask.question)).toStartWith("The plan's ");
    expect(String(ask.question)).toEndWith(ONE_REPO_PR);
    expect(String(ask.question)).not.toContain("push main to origin");
  });

  test("an org.md written before the line existed: by pull request all the same", () => {
    const ask = oneRepoShare(olderOrg);
    expect(labels(ask)).toEqual([`${BY_PR}${MARK}`, PLAIN, "Build them here for now"]);
    expect(String(ask.question)).toEndWith(ONE_REPO_PR);
  });

  test("team.md says by direct push: Share by direct push first, marked Recommended, the question as it was", () => {
    const ask = oneRepoShare(teamLine("by direct push"));
    expect(labels(ask)).toEqual([`${PLAIN}${MARK}`, BY_PR, "Build them here for now"]);
    expect(String(choice(ask, `${PLAIN}${MARK}`).command)).toMatch(/ unit share --commit-message-file \S+\/unit-share-message-[^/ ]+\.txt$/);
    expect(String(ask.question)).toContain("push main to origin, so anyone can take a Unit by opening their own clone");
  });
});

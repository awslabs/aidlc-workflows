// covers: subcommand:aidlc-unit:push, subcommand:aidlc-state:approve, function:buildWaitsForPush
//
// A Unit's build ends with its push, and its record stays open until the push
// or the person's Not now, so whatever the push asks of the person is still
// their move inside the work. A live run on Codex: the push refused the
// files Code Generation wrote (its manifest gave them by their path from the
// workspace; that list is now refused at Code Generation's own check, so here
// its files are gone before the push), the person said to take it back to
// Code Generation, and every
// redo was refused, because the build's record had finished at the last
// approval and no turn of theirs was on record any more: an approved Unit that
// neither pushed nor went back. Not now still ends the build, once.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { type HostName, hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  GIT_ENV,
  git,
  homeState,
  makeHome,
  run,
  STATE,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterAll(cleanupTeamBuild);

const UNIT_ASKS = new Set(["unit-take", "unit-push"]);
const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n";

// The home with refunds held for payments, and a payments member's clone on
// `tool`, built to the push question.
function builtToPush(tool: "claude" | HostName, manifestFromWorkspace: boolean) {
  const hosts = { billing: codeHost("billing") };
  const state = homeState().replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
  const home = makeHome({ repos: hosts, dependencies: DEPENDENCIES, state });
  cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  const dir = cloneOf(home.remote, "alice");
  cpSync(join(REPO_ROOT, "dist", tool), dir, { recursive: true, force: false, errorOnExist: false });
  cloneCode(hosts.billing, dir, "billing", "alice");
  const host = hostFor(tool, dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["refunds"],
    codeRepo: () => [{ repo: "billing" }],
    manifestFromWorkspace,
    until: (d: Directive) => d.kind === "ask" && UNIT_ASKS.has(String(d.ask_type)),
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  const offer = agent.next();
  expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
  choose(agent, person, offer, "Start refunds");
  const push = agent.drive(agent.next());
  expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
  const intents = join(dir, "aidlc", "spaces", "payments", "intents");
  const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
  return { hosts, dir, host, person, agent, push, record };
}

function choose(agent: AgentStandIn, person: PersonScript, d: Directive, label: string): { status: number; out: string } {
  const choices = (d.choices as Array<{ label: string; command?: string }> | undefined) ?? [];
  const choice = choices.find((c) => c.label === label);
  expect(choice?.command, `${label} in ${JSON.stringify(d)}`).toBeString();
  person.pick(String(d.question), choices.map((c) => c.label), label);
  const ran = agent.host.bash(choice!.command!);
  return { status: ran.status, out: ran.stdout + ran.stderr };
}

function statusOf(record: string): string | undefined {
  return /^- \*\*Status\*\*: (.*)$/m.exec(readFileSync(join(record, "aidlc-state.md"), "utf-8"))?.[1]?.trim();
}

// The build's own audit record, read whole (a finished work is no longer the selected one).
function completions(record: string): number {
  const audit = join(record, "audit");
  return readdirSync(audit).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(audit, name), "utf-8").split("**Event**: WORKFLOW_COMPLETED").length - 1)
    .reduce((sum, n) => sum + n, 0);
}

describe("a Unit's push and its way back stay the person's moves", () => {
  {
    test("the push refused, the person's yes takes it back to Code Generation", () => {
      const { host, person, agent, push, record, dir } = builtToPush("codex", false);
      // The files its Code Generation recorded are gone from billing before the push.
      const manifest = JSON.parse(readFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), "utf-8")) as
        { writes: Array<{ repo?: string; path: string }> };
      for (const write of manifest.writes) rmSync(join(dir, write.repo ?? ".", ...write.path.split("/")), { force: true });
      // The build is approved and its push is asked: the work is not finished yet.
      expect(statusOf(record)).not.toBe("Completed");
      expect(completions(record)).toBe(0);
      const refused = choose(agent, person, push, "Push");
      expect(refused.status, refused.out).not.toBe(0);
      expect(refused.out).toContain("back to Code Generation");
      const redo = /`([^`]* report --result resumed --choice redo --target code-generation)`/.exec(refused.out)?.[1];
      expect(redo, refused.out).toBeString();
      person.say("Yes, take refunds back to Code Generation.");
      const accepted = host.bash(redo!);
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
      const jump = /`([^`]*aidlc-jump\.ts execute --target code-generation --direction redo[^`]*)`/.exec(accepted.stdout)?.[1];
      expect(jump, accepted.stdout).toBeString();
      // The guard lets the jump run: the person's yes is on record.
      const moved = host.bash(jump!);
      expect(moved.status, moved.stdout + moved.stderr).toBe(0);
      // Code Generation starts again, with its code plan question first.
      const step = agent.next();
      expect(step, JSON.stringify(step)).toMatchObject({ stage: "code-generation", unit: "refunds" });
      expect(statusOf(record)).not.toBe("Completed");
    });
  }

  test("Not now ends the build once; the push is not asked again", () => {
    const { person, agent, push, record } = builtToPush("codex", false);
    expect(statusOf(record)).not.toBe("Completed");
    const later = choose(agent, person, push, "Not now");
    expect(later.status, later.out).toBe(0);
    expect(statusOf(record)).toBe("Completed");
    expect(completions(record)).toBe(1);
    const end = agent.next();
    expect(end.kind, JSON.stringify(end)).toBe("done");
    const again = agent.next();
    expect(again.kind, JSON.stringify(again)).toBe("done");
    expect(completions(record)).toBe(1);
  });

  test("a push that goes home ends the build", () => {
    const { person, agent, push, record } = builtToPush("codex", false);
    const pushed = choose(agent, person, push, "Push");
    expect(pushed.status, pushed.out).toBe(0);
    expect(statusOf(record)).toBe("Completed");
    expect(completions(record)).toBe(1);
    expect(agent.next().kind).toBe("done");
  });
});

// covers: subcommand:aidlc-unit:push, subcommand:aidlc-state:approve, function:buildWaitsForPush, function:unitBuildPastCodeGeneration
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
import { appendFileSync, cpSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
function builtToPush(tool: "claude" | HostName, manifestFromWorkspace: boolean, policy?: "strict" | "relaxed" | "off") {
  const hosts = { billing: codeHost("billing") };
  const state = homeState(policy === undefined ? [] : [`- **Guard Policy**: ${policy} (set by you)`]).replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
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

// A live run: at the push question the teammate asked "add a line to the end of
// checkout-api/README.md"; the agent's edit and commit were refused by the
// plan-approval guard as if Code Generation had not started, and the way out
// it named was refused too. Code Generation is approved there: what the
// person asks for goes through, and the agent's own edit waits for their word.
describe("at the push question the person's own ask goes through", () => {
  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`Guard Policy ${policy}: their edit and commit run; the agent's own edit waits, and its refusal names no step that is refused`, () => {
      const { host, person, agent, push, dir } = builtToPush("claude", false, policy);
      const write = () => host.hook("plan-approval-guard", {
        hook_event_name: "PreToolUse", tool_name: "Write",
        tool_input: { file_path: join(dir, "billing", "README.md"), content: "# billing\n\nRefunds live here.\n" },
      });
      const own = write();
      expect(own.status, own.stderr).toBe(2);
      expect(own.stderr.trim()).toBe("Your Unit is built and approved: its code changes only when you ask for a change.");
      person.say("add a line to the end of billing/README.md, then commit it with PAY-42");
      const theirs = write();
      expect(theirs.status, theirs.stderr).toBe(0);
      const commit = host.hook("plan-approval-guard", {
        hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_input: { command: "git -C billing commit -am 'PAY-42 note refunds in the README'" },
      });
      expect(commit.status, commit.stderr).toBe(0);
      // Done as they asked, the push question moves on: Push sends the Unit, and is not asked again.
      appendFileSync(join(dir, "billing", "README.md"), "Refunds live here.\n");
      git(join(dir, "billing"), ["commit", "-qam", "PAY-42 note refunds in the README"]);
      const pushed = choose(agent, person, push, "Push");
      expect(pushed.status, pushed.out).toBe(0);
      const after = agent.next();
      expect(after.ask_type === "unit-push", JSON.stringify(after)).toBe(false);
    });
  }
});

// A live run on Codex: after the Unit was pushed, the person asked for a fix
// to it, and their redo of Code Generation was refused by the plan-approval
// guard, then the work read as finished. The Codex host fires the guard
// before each command, as Codex does.
test("after the push, the person's redo of Code Generation runs", () => {
  const { host, person, agent, push } = builtToPush("codex", false);
  const pushed = choose(agent, person, push, "Push");
  expect(pushed.status, pushed.out).toBe(0);
  const after = agent.next();
  expect(after.ask_type === "unit-push", JSON.stringify(after)).toBe(false);
  person.say("Fix the known stale-panel refund issue in refunds: take it back to Code Generation.");
  const accepted = host.bash(`bun ${host.dir}/tools/aidlc-orchestrate.ts report --result resumed --choice redo --target code-generation`);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  const jump = /`([^`]*aidlc-jump\.ts execute --target code-generation --direction redo[^`]*)`/.exec(accepted.stdout)?.[1];
  expect(jump, accepted.stdout).toBeString();
  const moved = host.bash(jump!);
  expect(moved.status, moved.stdout + moved.stderr).toBe(0);
  const step = agent.next();
  expect(step, JSON.stringify(step).slice(0, 600)).toMatchObject({ stage: "code-generation", unit: "refunds" });
});

// The same live run, step by step as its agent took it: the person's words
// were reported as a jump, `next --stage code-generation` printed the redo,
// and the redo was refused.
test("after the push, the person's jump back to Code Generation, by next --stage, runs", () => {
  const { host, person, agent, push } = builtToPush("codex", false);
  const pushed = choose(agent, person, push, "Push");
  expect(pushed.status, pushed.out).toBe(0);
  agent.next();
  person.say("Fix the known stale-panel refund issue");
  const jumped = host.bash(`bun ${host.dir}/tools/aidlc-orchestrate.ts report --result resumed --choice jump --target code-generation`);
  expect(jumped.status, jumped.stdout + jumped.stderr).toBe(0);
  const printed = host.bash(`bun ${host.dir}/tools/aidlc-orchestrate.ts next --stage code-generation`);
  expect(printed.status, printed.stdout + printed.stderr).toBe(0);
  const jump = /`([^`]*aidlc-jump\.ts execute --target code-generation[^`]*)`/.exec(printed.stdout)?.[1];
  expect(jump, printed.stdout).toBeString();
  const moved = host.bash(jump!);
  expect(moved.status, moved.stdout + moved.stderr).toBe(0);
  const step = agent.next();
  expect(step, JSON.stringify(step).slice(0, 600)).toMatchObject({ stage: "code-generation", unit: "refunds" });
});

// A live run at the push question, as the agent takes a turn: the person's
// words, the agent's next first, then the edit they asked for.
test("at the push question the person's ask goes through after the agent's own next", () => {
  const { host, person, agent, dir } = builtToPush("claude", false);
  person.say("hold on, before pushing: add a line to the end of billing/README.md");
  expect(agent.next().ask_type).toBe("unit-push");
  const write = host.hook("plan-approval-guard", {
    hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { file_path: join(dir, "billing", "README.md"), content: "# billing\n\nRefunds live here.\n" },
  });
  expect(write.status, write.stderr).toBe(0);
});

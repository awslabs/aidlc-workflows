// covers: subcommand:aidlc-orchestrate:next, function:openRoutingQuestion
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, intentsDirOf, proposalFollowUp } from "../harness/fixtures.ts";
import { intentsRegistryPath, sessionsDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { latestQuestion, readQuestion, type StoredQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import { DISPATCHER, env, exec, next, projectAt, SECOND_SESSION, say } from "../harness/aidlc-input-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STILL_OPEN = "has not answered the question about where their words belong";
const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

type Row = { uuid: string; slug: string; status: string };

async function asked(): Promise<{ proj: string; question: StoredQuestion; space: string }> {
  const proj = await projectAt("routing-question-open");
  projects.push(proj);
  const question = latestQuestion(proj);
  if (question?.origin !== "routing" || !question.askedAbout) throw new Error("no routing question stored");
  return { proj, question, space: question.askedAbout.space };
}

function editRegistry(proj: string, space: string, edit: (rows: Row[]) => Row[]): void {
  const path = intentsRegistryPath(proj, space);
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf-8")))));
}

function editQuestion(proj: string, question: StoredQuestion, edit: (stored: StoredQuestion) => StoredQuestion): void {
  const path = join(sessionsDir(proj), "questions", `${question.id}.json`);
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf-8")))));
}

async function step(proj: string, space: string): Promise<string> {
  rmSync(join(intentsDirOf(proj, space), "active-intent"), { force: true });
  expect((await say(proj, "/aidlc let start", "claude")).status).toBe(0);
  return (await next(proj, ["let", "start"])).out;
}

const withStatus = (uuid: string, status: string) => (rows: Row[]) =>
  rows.map((row) => row.uuid === uuid ? { ...row, status } : row);

describe("t-routing-question-closed-target: a routing question never offers finished work", () => {
  for (const status of ["complete", "archived"]) {
    test(`a pick question whose only target is ${status}: the step stays and names the question's own late answers, not the finished work`, async () => {
      const { proj, question, space } = await asked();
      const target = question.askedAbout!.targets[0];
      editQuestion(proj, question, (stored) => ({ ...stored, askedAbout: { ...stored.askedAbout!, pick: true } }));
      editRegistry(proj, space, withStatus(target.uuid, status));
      const out = await step(proj, space);
      expect(out).toContain(STILL_OPEN);
      expect(out).not.toContain(`--pick ${target.intent}`);
      expect(out).not.toMatch(/one of [;.]/);
      expect(out).toContain(`--continue --request ${question.id}`);
      expect(out).toContain("If they are asking for something else, run `");
    });
  }

  test("a question about the active work whose target is archived: the step stays, so the agent reads the words", async () => {
    const { proj, question, space } = await asked();
    editRegistry(proj, space, withStatus(question.askedAbout!.targets[0].uuid, "archived"));
    const out = await step(proj, space);
    expect(out).toContain(STILL_OPEN);
    expect(out).toContain(`--continue --request ${question.id}`);
  });

  test("its target still in flight: the question stays open", async () => {
    const { proj, space } = await asked();
    expect(await step(proj, space)).toContain(STILL_OPEN);
  });

  test("its target missing from the registry: the question stays open", async () => {
    const { proj, question, space } = await asked();
    editRegistry(proj, space, (rows) => rows.filter((row) => row.uuid !== question.askedAbout!.targets[0].uuid));
    expect(await step(proj, space)).toContain(STILL_OPEN);
  });

  test("one of two picked targets complete: only the open one is offered", async () => {
    const { proj, question, space } = await asked();
    const done = { intent: "finished-work", uuid: "00000000-0000-4000-8000-00000000d0e1" };
    editRegistry(proj, space, (rows) => [...rows, { uuid: done.uuid, slug: done.intent, status: "complete" }]);
    editQuestion(proj, question, (stored) => ({
      ...stored,
      askedAbout: { space, targets: [...stored.askedAbout!.targets, done], pick: true },
    }));
    const out = await step(proj, space);
    expect(out).toContain(STILL_OPEN);
    expect(out).toContain(`--pick ${question.askedAbout!.targets[0].intent}`);
    expect(out).not.toContain(done.intent);
  });
});

describe("t-routing-question-closed-target: a routing question the person's words were passed on beside", () => {
  test("the agent passes their words on as something else: once that request starts work, the question is not asked again, in that chat or a new one, and its own commands still answer it", async () => {
    const { proj, question, space } = await asked();
    editQuestion(proj, question, (stored) => ({ ...stored, askedAbout: { ...stored.askedAbout!, pick: true } }));
    editRegistry(proj, space, withStatus(question.askedAbout!.targets[0].uuid, "complete"));
    rmSync(join(intentsDirOf(proj, space), "active-intent"), { force: true });
    const chat = { session: SECOND_SESSION };
    const later = { session: "01995000-7a11-7000-8000-00000000d003" };
    const words = async (line: string, at: { session: string }): Promise<{ out: string; message: string }> => {
      expect((await say(proj, `/aidlc ${line}`, "claude", at)).status).toBe(0);
      const { directive, out } = await next(proj, line.split(" "), at);
      return { out, message: String(directive?.message ?? "") };
    };
    const shown = await words("let start", chat);
    expect(shown.out).toContain(STILL_OPEN);
    // The agent reads "let start" as something else and runs the step's own command for that.
    const other = /If they are asking for something else, run `[^`]* next (--request-file [^`]+)`/.exec(shown.message)?.[1];
    expect(other, shown.out).toBeDefined();
    const proposal = await next(proj, other!.split(" "), chat);
    const offer = await next(proj, proposalFollowUp(proposal.directive, "express") ?? [], chat);
    const pick = offer.directive?.confirm_command as string | undefined;
    expect(pick, offer.out).toBeDefined();
    expect((await say(proj, "express", "claude", chat)).status).toBe(0);
    const creation = await next(proj, pick!.slice(pick!.indexOf(" next ") + " next ".length).split(" "), chat);
    const create = /engine intent create (--scope \S+ --request [0-9a-f]{8})/.exec(creation.directive?.message ?? "")?.[1];
    expect(create, creation.out).toBeDefined();
    const made = await exec([process.execPath, DISPATCHER, "engine", "intent", "create", ...create!.split(" "), "--label", "let-start", "--project-dir", proj], { cwd: proj, env: env(proj, chat) });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    // Their next words, in that chat and in a new one with no work selected.
    expect((await words("add a chart", chat)).out).not.toContain(STILL_OPEN);
    rmSync(join(intentsDirOf(proj, space), "active-intent"), { force: true });
    expect((await words("add a chart", later)).out).not.toContain(STILL_OPEN);
    // The request it kept still starts from its own separate-work command.
    expect((await say(proj, "2", "claude")).status).toBe(0);
    expect((await next(proj, ["--new-intent", "--scope", "bugfix", "--request", question.id])).out)
      .toContain(`intent create --scope bugfix --request ${question.id}`);
  });

  test("a plain chat reply while a stage question waits leaves the which-work question as it was", async () => {
    const proj = await projectAt("stage-question-asked");
    projects.push(proj);
    expect((await say(proj, "/aidlc fix the login", "claude")).status).toBe(0);
    const reading = await next(proj, ["fix", "the", "login"]);
    const request = /next (--request [0-9a-f]{8})`/.exec(reading.directive?.message ?? "")?.[1];
    expect(request, reading.out).toBeDefined();
    const routing = await next(proj, [...request!.split(" "), "--propose", "bugfix"]);
    expect(routing.directive?.ask_type, routing.out).toBe("new-work-routing");
    const question = latestQuestion(proj);
    expect(question?.origin).toBe("routing");
    expect((await say(proj, "2", "claude")).status).toBe(0);
    // The agent runs a bare `next`; the engine takes their reply behind `--` itself and keeps a newer copy of it.
    expect((await next(proj, [])).status).toBe(0);
    expect(latestQuestion(proj)?.id).not.toBe(question!.id);
    expect(readQuestion(proj, question!.id)?.replacedBy).toBeUndefined();
  });
});

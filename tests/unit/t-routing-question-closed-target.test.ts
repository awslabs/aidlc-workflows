// covers: subcommand:aidlc-orchestrate:next, function:openRoutingQuestion
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, intentsDirOf } from "../harness/fixtures.ts";
import { intentsRegistryPath, sessionsDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { latestQuestion, type StoredQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import { next, projectAt, say } from "../harness/aidlc-input-corpus.ts";

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

describe("t-routing-question-closed-target: a routing question closes with the work it named", () => {
  for (const status of ["complete", "archived"]) {
    test(`its only target ${status}: the words are a new request`, async () => {
      const { proj, question, space } = await asked();
      editRegistry(proj, space, withStatus(question.askedAbout!.targets[0].uuid, status));
      expect(await step(proj, space)).not.toContain(STILL_OPEN);
    });
  }

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

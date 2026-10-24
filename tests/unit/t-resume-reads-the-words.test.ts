// covers: subcommand:aidlc-orchestrate:next, function:resumeAgain
//
// t-resume-reads-the-words: the words typed with a resume get the reading a
// plain `next` gives them. Measured at main d04eca8a6: `next --resume` followed
// by the person's words (the agent's own addition to their `/aidlc <words>`,
// or their own `/aidlc --resume <words>`) ran the open stage with "Picking up
// where we left off" and dropped the words without a line (the SDK drive, CI's
// models: 2 of 3 built Requirements Analysis instead of the redo they typed);
// over parked work the unpark step's re-run was a bare `next --resume`, so the
// words were gone after the unpark; in a teammate's clone the pick of a parked
// piece named a bare `next --resume` after the switch (3 of 3 on that path),
// so the redo typed before it was not read. Now a resume's words are read as a
// plain line is (the readings of words over work, a workspace command such as
// `space default`, the pick where none is selected), and parked work is
// unparked first through the step it already gets, whose re-run carries the
// words in a request file of their own. A resume with no words is unchanged.
//
// Spawns the real engine and each host's own human-turn hook, as
// tests/unit/t-pick-reads-the-words and t-next-takes-the-persons-line do.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, createOrchestrationTestProject, intentsDirOf, seededStateFile } from "../harness/fixtures.ts";
import {
  buildState, DISPATCHER, type Directive, env, exec, type Harness, next, ORCHESTRATE, type RunOptions, SECOND_SESSION,
  say,
} from "../harness/aidlc-input-corpus.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const WORDS = "redo reverse engineering, the scan missed the src/legacy folder";
const PIECE = "fixture-8000000000000001";
// The reading a plain `next <words>` gets over selected work, and in team mode.
const READING = "the person's words may ask to redo";
const TEAM_READING = "the person's words may only ask for it to go on, or be new work or a change to this work";
const PICK_UP = "Picking up where we left off";
const UNPARK = /This workflow is parked\. Run `[^`]* unpark` to clear the park marker, then re-run `next --resume( [^`]+)?` to continue\./;
const REQUEST_FILE = /--request-file (aidlc\/\.aidlc-request-text\/[^/\s`]+)/;

async function at(state: "work-open" | "parked", clone = false): Promise<string> {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  await buildState(proj, state);
  if (clone) rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
  return proj;
}

const isTheWorksStep = (d: Directive | null): boolean => d?.kind === "run-stage" || d?.kind === "load-steering";
// Two runs of one reading differ only in the id of the copy each keeps.
const sameStep = (d: Directive | null): string => JSON.stringify(d).replace(/\b[0-9a-f]{8}\b/g, "<id>");

/** The re-run the unpark step names: "" for a bare `next --resume`. */
function rerun(d: Directive | null): string {
  const message = String(d?.message ?? "");
  const step = UNPARK.exec(message);
  expect(step, message).not.toBeNull();
  return step?.[1]?.trim() ?? "";
}

/** The request file a step names, and what it holds. */
function carried(proj: string, step: string): { file: string; words: string } {
  const file = REQUEST_FILE.exec(step)?.[1];
  expect(file, step).toBeDefined();
  return { file: file!, words: readFileSync(join(proj, file!), "utf-8") };
}

async function unpark(proj: string, opts: RunOptions = {}): Promise<void> {
  const r = await exec([process.execPath, join(proj, ".claude", "tools", "aidlc-state.ts"), "unpark", "--project-dir", proj], {
    cwd: proj, env: env(proj, opts),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

const auditRows = (proj: string): number => readAuditShardEvents(proj).length;

describe("words after --resume over selected work get the reading plain words get", () => {
  test("the agent adds --resume before their words: the reading, not the open stage", async () => {
    const proj = await at("work-open");
    await say(proj, `/aidlc ${WORDS}`, "claude");
    const read = await next(proj, ["--resume", WORDS]);
    expect(read.directive?.kind, read.out).toBe("print");
    expect(String(read.directive?.message), read.out).toContain(READING);
    expect(read.out).not.toContain(PICK_UP);
    // Read once: the bare `next` after the reading is the work's own step.
    const goOn = await next(proj, []);
    expect(isTheWorksStep(goOn.directive), goOn.out).toBe(true);
  });

  test("their words behind the -- mark after --resume: the same reading", async () => {
    const proj = await at("work-open");
    await say(proj, `/aidlc ${WORDS}`, "claude");
    const read = await next(proj, ["--resume", "--", WORDS]);
    expect(String(read.directive?.message), read.out).toContain(READING);
  });

  test("the person types /aidlc --resume <words> and the agent sends a bare next --resume: the same reading", async () => {
    const proj = await at("work-open");
    await say(proj, `/aidlc --resume ${WORDS}`, "claude");
    const read = await next(proj, ["--resume"]);
    expect(String(read.directive?.message), read.out).toContain(READING);
    expect(read.out).not.toContain(PICK_UP);
  });

  test("a workspace command after --resume is the command, as without it", async () => {
    const proj = await at("work-open");
    await say(proj, "/aidlc space default", "claude");
    const resumed = await next(proj, ["--resume", "space", "default"]);
    const plain = await next(proj, ["space", "default"]);
    expect(resumed.directive, resumed.out).toEqual(plain.directive);
    expect(String(resumed.directive?.message), resumed.out).toContain("engine space default");
  });

  test("a plan's name then words after --resume: the step plain words get, with no --resume in it", async () => {
    const proj = await at("work-open");
    const line = ["bugfix", "add", "rate", "limiting"];
    await say(proj, `/aidlc ${line.join(" ")}`, "claude");
    const resumed = await next(proj, ["--resume", ...line]);
    const plain = await next(proj, line);
    expect(sameStep(resumed.directive), resumed.out).toBe(sameStep(plain.directive));
    expect(String(resumed.directive?.message), resumed.out).toContain("next --scope bugfix -- 'add rate limiting'");
    expect(resumed.out).not.toContain("--resume");
  });

  test("a stage change typed with --resume and words is read as without it, not refused", async () => {
    const proj = await at("work-open");
    const line = ["--skip", "code-generation", "redo", "it"];
    await say(proj, `/aidlc --resume ${line.join(" ")}`, "claude");
    const resumed = await next(proj, ["--resume", ...line]);
    const plain = await next(proj, line);
    expect(resumed.directive?.kind, resumed.out).not.toBe("error");
    expect(sameStep(resumed.directive), resumed.out).toBe(sameStep(plain.directive));
  });

  test("words after --resume where none is selected get the pick reading, not a new-work offer", async () => {
    const proj = await at("work-open", true);
    await say(proj, `/aidlc ${WORDS}`, "claude");
    const read = await next(proj, ["--resume", WORDS]);
    expect(String(read.directive?.message), read.out).toContain("none is selected in this chat");
    expect(read.out).not.toContain("asked for new work");
  });
});

describe("over parked work the unpark step's re-run carries the words", () => {
  test("next --resume <words>: unpark, then the re-run with their words in a request file, then the reading", async () => {
    const proj = await at("parked");
    await say(proj, `/aidlc ${WORDS}`, "claude");
    const parked = await next(proj, ["--resume", WORDS]);
    const kept = carried(proj, rerun(parked.directive));
    expect(kept.words).toBe(WORDS);
    await unpark(proj);
    const rows = auditRows(proj);
    const read = await next(proj, ["--resume", "--request-file", kept.file]);
    expect(String(read.directive?.message), read.out).toContain(READING);
    expect(read.out).not.toContain(PICK_UP);
    // Nothing of theirs is recorded a second time, and the file is spent once read.
    expect(auditRows(proj)).toBe(rows);
    expect(existsSync(join(proj, kept.file))).toBe(false);
  });

  test("the settings and stage changes typed with them ride the re-run too", async () => {
    const proj = await at("parked");
    const line = ["--depth", "comprehensive", "--skip", "code-generation", "redo", "it"];
    await say(proj, `/aidlc --resume ${line.join(" ")}`, "claude");
    const parked = await next(proj, ["--resume", ...line]);
    const step = rerun(parked.directive);
    expect(step, parked.out).toStartWith("--depth comprehensive --skip code-generation --request-file ");
    expect(carried(proj, step).words).toBe("redo it");
  });

  for (const [label, words] of [
    ["quotes and an apostrophe", `redo reverse engineering, the "legacy" scan missed Sam's folder`],
    ["cmd.exe's characters", "redo reverse engineering: src/legacy & src/old at 100% <both> | ^now"],
    ["a line break", "redo reverse engineering\nthe scan missed the src/legacy folder"],
  ] as const) {
    test(`words with ${label} reach the unparked work as typed`, async () => {
      const proj = await at("parked");
      await say(proj, `/aidlc ${words}`, "claude");
      const parked = await next(proj, ["--resume", "--", words]);
      const kept = carried(proj, rerun(parked.directive));
      expect(kept.words).toBe(words);
      await unpark(proj);
      const read = await next(proj, ["--resume", "--request-file", kept.file]);
      expect(String(read.directive?.message), read.out).toContain(READING);
    });
  }

  test("a teammate's clone: the redo typed before picking the parked piece is read after the unpark", async () => {
    // Parked in another chat; this one never joined it.
    const proj = await at("parked", true);
    const here: RunOptions = { session: SECOND_SESSION };
    await say(proj, `/aidlc ${WORDS}`, "claude", here);
    const reading = await next(proj, [WORDS], here);
    expect(String(reading.directive?.message), reading.out).toContain("none is selected in this chat");
    const picked = await next(proj, ["--pick", PIECE], here);
    const then = /then run `[^`]* next (--resume --request-file \S+)` and follow what it returns/
      .exec(String(picked.directive?.message));
    expect(then, picked.out).not.toBeNull();
    expect(carried(proj, then![1]).words).toBe(WORDS);
    const switched = await exec([process.execPath, DISPATCHER, "engine", "intent", "switch", PIECE, "--project-dir", proj], {
      cwd: proj, env: env(proj, here),
    });
    expect(switched.status, `${switched.stdout}${switched.stderr}`).toBe(0);
    const parked = await next(proj, then![1].split(" "), here);
    const kept = carried(proj, rerun(parked.directive));
    expect(kept.words).toBe(WORDS);
    await unpark(proj, here);
    const read = await next(proj, ["--resume", "--request-file", kept.file], here);
    expect(String(read.directive?.message), read.out).toContain(READING);
    expect(String(read.directive?.message), read.out).toContain('Work is in progress on "Todo app bug fix"');
  });

  test("team mode, parked: the unpark carries the words, then the team reading", async () => {
    const proj = await at("parked");
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(
      /^(- \*\*Current Stage\*\*:.*)$/m, "$1\n- **Unit Ownership**: team",
    ));
    await say(proj, `/aidlc ${WORDS}`, "claude");
    const parked = await next(proj, ["--resume", WORDS]);
    const kept = carried(proj, rerun(parked.directive));
    await unpark(proj);
    const read = await next(proj, ["--resume", "--request-file", kept.file]);
    expect(String(read.directive?.message), read.out).toContain(TEAM_READING);
  });
});

describe("a resume with no words, or a jump, is unchanged", () => {
  test("bare --resume over open work: the open stage, with where it picks up", async () => {
    const proj = await at("work-open");
    await say(proj, "/aidlc --resume", "claude");
    const r = await next(proj, ["--resume"]);
    expect(isTheWorksStep(r.directive), r.out).toBe(true);
    expect(r.out).toContain(PICK_UP);
  });

  test("bare --resume over parked work: the unpark step re-runs a bare next --resume", async () => {
    const proj = await at("parked");
    await say(proj, "/aidlc --resume", "claude");
    const r = await next(proj, ["--resume"]);
    expect(rerun(r.directive), r.out).toBe("");
  });

  test("a setting with --resume over parked work: the re-run carries the setting only", async () => {
    const proj = await at("parked");
    await say(proj, "/aidlc --resume --depth comprehensive", "claude");
    const r = await next(proj, ["--resume", "--depth", "comprehensive"]);
    expect(rerun(r.directive), r.out).toBe("--depth comprehensive");
  });

  test("a clone with one piece, the person's bare /aidlc --resume: picked up, the step after the switch a bare --resume", async () => {
    const proj = await at("work-open", true);
    await say(proj, "/aidlc --resume", "claude");
    const r = await next(proj, ["--resume"]);
    expect(String(r.directive?.message), r.out).toMatch(/then run `[^`]* next --resume` and follow what it returns/);
  });

  test("--resume --stage with words keeps the jump route", async () => {
    const proj = await at("work-open");
    const line = ["--stage", "requirements-analysis", "redo", "it"];
    await say(proj, `/aidlc --resume ${line.join(" ")}`, "claude");
    const r = await next(proj, ["--resume", ...line]);
    expect(String(r.directive?.message), r.out).toContain("aidlc-jump.ts execute --target requirements-analysis");
  });
});

// The engine every host ships reads the words after --resume, and every host's hook keeps the person's own
// `/aidlc --resume <words>` for the agent's bare `next --resume`.
describe("on every host's tree", () => {
  const tool = (proj: string, harness: Harness): string => harness === "claude"
    ? ORCHESTRATE
    : join(proj, harness === "copilot" ? ".aidlc" : harness === "codex" ? ".codex" : ".kiro", "tools", "aidlc-orchestrate.ts");
  for (const harness of ["claude", "codex", "kiro", "kiro-ide", "copilot"] as Harness[]) {
    test(`${harness}: next --resume <words> gets the reading of their words`, async () => {
      const proj = await at("work-open");
      const said = await say(proj, `${harness === "codex" ? "$aidlc" : "/aidlc"} ${WORDS}`, harness);
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
      const r = await exec([process.execPath, tool(proj, harness), "next", "--project-dir", proj, "--resume", WORDS], {
        cwd: proj, env: env(proj),
      });
      expect(r.stdout, r.stderr).toContain(READING);
    });
  }
  for (const harness of ["claude", "codex", "kiro", "kiro-ide"] as Harness[]) {
    test(`${harness}: the person's /aidlc --resume <words>, the agent's bare next --resume: the reading`, async () => {
      const proj = await at("work-open");
      const said = await say(proj, `${harness === "codex" ? "$aidlc" : "/aidlc"} --resume ${WORDS}`, harness);
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
      const r = await exec([process.execPath, tool(proj, harness), "next", "--project-dir", proj, "--resume"], {
        cwd: proj, env: env(proj),
      });
      expect(r.stdout, r.stderr).toContain(READING);
    });
  }
});

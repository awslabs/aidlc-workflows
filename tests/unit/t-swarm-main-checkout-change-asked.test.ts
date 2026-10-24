// covers: subcommand:aidlc-swarm:allow-change, hook:aidlc-plan-approval-guard, subcommand:aidlc-worktree:merge,
// audit:MAIN_CHECKOUT_CHANGE_ALLOWED, audit:CHANGE_ACCEPTED
//
// Under a strict Guard Policy, while the Units are built in parallel, the main
// checkout changes only by their landings. The person asks for another file
// there ("also fix the typo in the README"): the held write names the step,
// `swarm allow-change` records the file with their words, the write goes in,
// and the landing keeps it. A file a listed Unit's plan names stays with that
// Unit, and a strict the team holds in memory keeps the hold and says where.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField, boltSlugForUnit, mainCheckoutChangeRunFloor, readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  ISOLATED_GIT_ENV, approvePlan, cleanupCheckpointFixtures, fixture, git, prepare, reviewRevisedSource, swarm, writeUnitSource, wt,
} from "../harness/swarm-checkpoint.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const SESSION = "main-checkout-asked";
const ASKED = "also fix the typo in the README";
const FIXED = "seed, typo fixed\n";
const LATER = "A change the person asks for in the main checkout can be made once Code Generation is over.";
const LOCKED = "so the main checkout stays as approved while the Units are built. Changing that line there changes it.";
// This chat, as the host names it to a hook and to the commands the agent runs.
const CHAT = { AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };

function run(pd: string, file: string, args: string[], input?: unknown, env: NodeJS.ProcessEnv = {}) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, file), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd,
    env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, ...env },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
// Returns the id of the message it kept.
function says(pd: string, prompt: string): string {
  const said = run(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt,
  }, { AIDLC_UNATTENDED: "0" });
  expect(said.code, `${said.out}\n${said.err}`).toBe(0);
  const id = auditBlockField(readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN").at(-1)?.block ?? "", "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

function guard(pd: string, toolName: string, toolInput: Record<string, unknown>) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd,
    env: { ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"), AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, ...CHAT },
    stdin: Buffer.from(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: SESSION, cwd: pd,
    })),
    stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

const allowChange = (pd: string, args: string[]) =>
  run(pd, "tools/aidlc-swarm.ts", ["allow-change", ...args, "--project-dir", pd], undefined, CHAT);

function land(pd: string, unit: string) {
  return run(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ], undefined, CHAT);
}

// alpha and beta are built, checked, reviewed and finalized; nothing has landed.
function built(pd: string): void {
  ["alpha", "beta"].forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  });
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha,beta", "--claimed", "alpha,beta"]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
}

// `planned` is a file alpha's approved plan names.
function batchOut(planned: string | null = null): string {
  const pd = fixture(["alpha", "beta"]);
  if (planned !== null) approvePlan(pd, "alpha", planned);
  const prepared = prepare(pd, ["alpha", "beta"]);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  return pd;
}

function lockStrict(pd: string): string {
  const dir = join(pd, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "team.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Team\n";
  writeFileSync(path, existing.includes("## Guard Policy\n")
    ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
    : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
  return path;
}

const rows = (pd: string, event: string) => readAuditShardEvents(pd).filter((row) => row.event === event);
const write = (path: string) => ({ file_path: path, content: FIXED });

describe("a change the person asks for in the main checkout while the Units are built in parallel", () => {
  test("the held write names the step, allow-change lets it in with their words, and the landing keeps it", () => {
    const pd = batchOut();
    const asked = says(pd, ASKED);
    const readme = join(pd, "README.md");

    const held = guard(pd, "Write", write(readme));
    expect(held.code).toBe(2);
    expect(held.err).toContain(`If their message ${asked} (sent `);
    expect(held.err).toContain("aidlc-swarm.ts allow-change README.md` with --message <id>");
    expect(held.err).toContain(`Otherwise: ${LATER}`);

    const allowed = allowChange(pd, ["README.md", "--message", asked]);
    expect(allowed.code, `${allowed.out}\n${allowed.err}`).toBe(0);
    expect((JSON.parse(allowed.out) as { notice: string }).notice).toBe(
      `README.md can change while the Units are built, because you said: "${ASKED}". It is kept when they land.`,
    );
    const lift = rows(pd, "MAIN_CHECKOUT_CHANGE_ALLOWED");
    expect(lift).toHaveLength(1);
    expect(JSON.parse(auditBlockField(lift[0].block, "Paths") ?? "[]")).toEqual(["README.md"]);
    expect(auditBlockField(lift[0].block, "Person Reply")).toBe(ASKED);
    expect(auditBlockField(lift[0].block, "Message Id")).toBe(asked);

    expect(guard(pd, "Write", write(readme)).code).toBe(0);
    expect(guard(pd, "Edit", { file_path: readme, old_string: "seed", new_string: "seed, typo fixed" }).code).toBe(0);
    writeFileSync(readme, FIXED);
    // Another file, and a Unit's own file, still wait for the landings.
    expect(guard(pd, "Write", write(join(pd, "NOTES.md"))).code).toBe(2);
    expect(guard(pd, "Write", write(join(pd, "src", "alpha.ts"))).code).toBe(2);

    built(pd);
    for (const unit of ["alpha", "beta"]) {
      const landed = land(pd, unit);
      expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
      // The lift said it once; the landing says nothing more about it.
      expect(landed.err).not.toContain("You changed");
    }
    expect(readFileSync(readme, "utf-8")).toBe(FIXED);
    const kept = rows(pd, "CHANGE_ACCEPTED").filter((row) => auditBlockField(row.block, "Checkpoint") === "swarm-batch");
    expect(kept).toHaveLength(1);
    expect(auditBlockField(kept[0].block, "Changed")).toBe("README.md");
    expect(auditBlockField(kept[0].block, "Message Id")).toBe(asked);
  });

  test("a change made after the first landing: the next landing names the step, then keeps it", () => {
    const pd = batchOut();
    built(pd);
    const first = land(pd, "alpha");
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    const asked = says(pd, ASKED);
    const readme = join(pd, "README.md");
    writeFileSync(readme, FIXED);

    const refused = land(pd, "beta");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("the main checkout source changed after the previous reviewed-source merge (README.md)");
    expect(refused.err).toContain(`If their message ${asked} (sent `);
    expect(refused.err).toContain("aidlc-swarm.ts allow-change README.md` with --message <id>");

    expect(allowChange(pd, ["README.md", "--message", asked]).code).toBe(0);
    const landed = land(pd, "beta");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(readFileSync(readme, "utf-8")).toBe(FIXED);
    const kept = rows(pd, "CHANGE_ACCEPTED").filter((row) => auditBlockField(row.block, "Checkpoint") === "swarm-batch");
    expect(kept.map((row) => auditBlockField(row.block, "Message Id"))).toEqual([asked]);
  });

  test("a strict the team holds in memory keeps the hold and says where, at the write and at the step", () => {
    const pd = batchOut();
    const memory = lockStrict(pd);
    const asked = says(pd, ASKED);
    const held = guard(pd, "Write", write(join(pd, "README.md")));
    expect(held.code).toBe(2);
    expect(held.err).toContain(`Your team set Guard Policy to strict in ${memory} (section: Guard Policy), ${LOCKED}`);
    expect(held.err).not.toContain("allow-change");
    const refused = allowChange(pd, ["README.md", "--message", asked]);
    expect(refused.code).toBe(1);
    expect((JSON.parse(refused.err) as { error: string }).error)
      .toBe(`Your team set Guard Policy to strict in ${memory} (section: Guard Policy), ${LOCKED}`);
    expect(rows(pd, "MAIN_CHECKOUT_CHANGE_ALLOWED")).toHaveLength(0);
  });

  test("the step takes only the person's own message, and a file outside the Units' plans", () => {
    const pd = batchOut("alpha.ts");
    const unproved = allowChange(pd, ["README.md", "--message", "0badc0de"]);
    expect(unproved.code).toBe(1);
    const asked = says(pd, ASKED);
    // A file the plan names is never offered the step.
    const held = guard(pd, "Write", write(join(pd, "src", "alpha.ts")));
    expect(held.code).toBe(2);
    expect(held.err).toContain(LATER);
    expect(held.err).not.toContain("allow-change");
    const planned = allowChange(pd, ["src/alpha.ts", "--message", asked]);
    expect(planned.code).toBe(1);
    expect((JSON.parse(planned.err) as { error: string }).error).toBe(
      "src/alpha.ts is a file the plan for Unit alpha names, so a change to it goes through that Unit: " +
        "Request Changes at its checkpoint, or make it once Code Generation is over.",
    );
    const outside = allowChange(pd, ["../elsewhere.md", "--message", asked]);
    expect(outside.code).toBe(1);
    expect(rows(pd, "MAIN_CHECKOUT_CHANGE_ALLOWED")).toHaveLength(0);
  });

  test("a change allowed before the worktrees are made: prepare does not ask for the plans' approval again", () => {
    const pd = fixture(["alpha", "beta"]);
    const asked = says(pd, ASKED);
    expect(allowChange(pd, ["README.md", "--message", asked]).code).toBe(0);
    writeFileSync(join(pd, "README.md"), FIXED);
    // Worktrees are made from committed source, under every Guard Policy.
    git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qam", "fix the typo"]);
    const prepared = prepare(pd, ["alpha", "beta"]);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    built(pd);
    for (const unit of ["alpha", "beta"]) {
      const landed = land(pd, unit);
      expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    }
    expect(readFileSync(join(pd, "README.md"), "utf-8")).toBe(FIXED);
  });

  // Seen live on Kiro CLI: the person's change, not committed, stopped prepare,
  // and the agent asked them to commit it before the Units could be built.
  test("a change allowed before the worktrees are made, not committed: prepare goes on and the landings keep it", () => {
    const pd = fixture(["alpha", "beta"]);
    const asked = says(pd, ASKED);
    expect(allowChange(pd, ["README.md", "--message", asked]).code).toBe(0);
    writeFileSync(join(pd, "README.md"), FIXED);
    const prepared = prepare(pd, ["alpha", "beta"]);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    built(pd);
    for (const unit of ["alpha", "beta"]) {
      const landed = land(pd, unit);
      expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    }
    expect(readFileSync(join(pd, "README.md"), "utf-8")).toBe(FIXED);
  });

  // A file the preparing Unit's own plan names reaches its worktree only as
  // committed, approved source: the Unit is never built without the person's change.
  test("a file the preparing Unit's plan names, asked for while another batch was out, still stops its prepare", () => {
    const pd = fixture(["alpha", "beta"]);
    approvePlan(pd, "alpha", "alpha.ts");
    const asked = says(pd, ASKED);
    // Recorded while no Unit being built named it (an earlier batch's request).
    appendAuditEntry("MAIN_CHECKOUT_CHANGE_ALLOWED", {
      Stage: "code-generation", "Run floor": mainCheckoutChangeRunFloor(pd), Paths: JSON.stringify(["src/alpha.ts"]),
      "Message Id": asked,
    }, pd);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 9;\n");
    const prepared = prepare(pd, ["alpha", "beta"]);
    expect(prepared.code).not.toBe(0);
    expect(`${prepared.out}\n${prepared.err}`).toMatch(/Parent source has changed since Plan Approval|Approved parent source is not committed/);
    expect(existsSync(wt(pd, "alpha"))).toBe(false);
  });

  test("with no message from the person on record, the held write says when the change can be made", () => {
    const pd = batchOut();
    const held = guard(pd, "Write", write(join(pd, "README.md")));
    expect(held.code).toBe(2);
    expect(held.err).toContain(LATER);
    expect(held.err).not.toContain("allow-change");
  });
});

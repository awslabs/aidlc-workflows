// covers: hook:aidlc-plan-approval-guard, hook:system-install, function:systemInstalls, function:unaskedSystemInstall,
// audit:SYSTEM_INSTALL_BLOCKED, audit:SYSTEM_INSTALL_ALLOWED
//
// An agent at Build and Test (or a developer at Code Generation) finds the
// project's test library missing and runs `sudo apt-get install` on its own: a
// system package installed for the whole machine, outside the project, that
// nobody asked for. The guard holds that one command and its only step is to
// tell the person the command; the person's go-ahead lets it through and the
// row it leaves names their message. What the person asks for themselves, and
// an install a plan they approved names (read as approved: not as edited since,
// not from a reviewer's appendix, not pieced together from two plans), run at
// once. It is not a fence: Guard Policy off and plan approval off hold it too,
// and a plan nobody approved names nothing. An isolated run with no work is held
// the same way.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { namedByOnePlan, systemInstalls } from "../../dist/claude/.claude/hooks/system-install.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  answer,
  createCodeGenerationProject,
  next,
  reply,
  SESSION,
  stageDir,
  writePlan,
} from "../harness/code-generation-states.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  removeWorkspaceRecord,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(120_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const PYTEST = "sudo -n apt-get install -y python3-pytest";
const HYPOTHESIS = "sudo apt-get install -y python3-hypothesis";
// A chat the person opens later on the same work.
const LATER = "01995000-7a11-7000-8000-00000000d00d";

function guardBash(
  proj: string,
  command: string,
  extra: { session?: string; shell?: "powershell" } = {},
): { code: number; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: extra.session ?? SESSION, cwd: proj, tool_name: "Bash",
      tool_input: { command }, ...(extra.shell ? { aidlc_shell: extra.shell } : {}),
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

// Code Generation with the plan approved ("1" at the plan question) and the build under way.
function building(planExtra = "", policy: "strict" | "relaxed" | "off" = "relaxed"): string {
  const proj = createCodeGenerationProject(policy);
  created.push(proj);
  writePlan(proj, planExtra);
  expect(next(proj).ask_type).toBe("plan-approval");
  expect(reply(proj, "1").status).toBe(0);
  const recorded = answer(proj, "Approve Plan");
  expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
  expect(next(proj).kind).toBe("run-stage");
  return proj;
}

// Build and Test after the person approved Code Generation's gate with "1".
function buildAndTest(): string {
  const proj = building();
  expect(reply(proj, "1").status).toBe(0);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", "User Input": "1" }, proj);
  const state = seededStateFile(proj);
  writeFileSync(
    state,
    readFileSync(state, "utf-8").replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: build-and-test"),
    "utf-8",
  );
  return proj;
}

describe("a system package install nobody asked for", () => {
  test("at Build and Test it is held with the command for the person, and their go-ahead runs it on the record", () => {
    const proj = buildAndTest();
    const held = guardBash(proj, PYTEST);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain(`\`${PYTEST}\``);
    expect(held.stderr).toContain("Tell the person");
    expect(held.stderr.trim().split("\n")).toHaveLength(1);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(1);
    // A command that only looks, and the test run itself, are not installs.
    expect(guardBash(proj, "apt-cache policy python3-pytest").code).toBe(0);
    expect(guardBash(proj, "python3 -m pytest -q").code).toBe(0);

    expect(reply(proj, "yes, go ahead and install it").status).toBe(0);
    const ran = guardBash(proj, PYTEST);
    expect(ran.code, ran.stderr).toBe(0);
    const allowed = rows(proj, "SYSTEM_INSTALL_ALLOWED");
    expect(allowed).toHaveLength(1);
    expect(auditBlockField(allowed[0].block, "Command")).toBe(PYTEST);
    const turn = rows(proj, "HUMAN_TURN").at(-1);
    expect(auditBlockField(allowed[0].block, "Message Id")).toBe(auditBlockField(turn?.block ?? "", "Message Id"));
    expect(auditBlockField(allowed[0].block, "Person Reply")).toBe("yes, go ahead and install it");
  });

  // The go-ahead the agent asks for is a question on the record with its own id
  // (the question record): the person's reply carries it, their go-ahead closes it.
  test("the go-ahead it asks for is on the record with its id, and the go-ahead closes it", () => {
    const proj = buildAndTest();
    expect(guardBash(proj, PYTEST).code).toBe(2);
    const [asked] = rows(proj, "QUESTION_ASKED").filter((row) => auditBlockField(row.block, "Question Type") === "system-install");
    const id = auditBlockField(asked?.block ?? "", "Question Id");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(auditBlockField(asked.block, "Question Chat")).toBe(SESSION);
    expect(auditBlockField(asked.block, "Stage")).toBe("build-and-test");
    const open = () => (auditBlockField(rows(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Open Questions") ?? "").split(", ");
    expect(reply(proj, "yes, go ahead and install it").status).toBe(0);
    expect(open()).toContain(id ?? "none");
    expect(guardBash(proj, PYTEST).code).toBe(0);
    expect(reply(proj, "thanks").status).toBe(0);
    expect(open()).not.toContain(id ?? "none");
  });

  test("at Code Generation the developer's install is held after the plan's approval", () => {
    const proj = building();
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain(`\`${HYPOTHESIS}\``);
  });

  test("an install the person asks for runs at once", () => {
    const proj = buildAndTest();
    expect(reply(proj, "pytest is missing, install it with apt").status).toBe(0);
    const ran = guardBash(proj, PYTEST);
    expect(ran.code, ran.stderr).toBe(0);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
    expect(rows(proj, "SYSTEM_INSTALL_ALLOWED")).toHaveLength(1);
  });

  test("an install the approved plan names runs at once, its steps ticked or not", () => {
    const proj = building(`- [ ] Step 2: install the test library with \`${HYPOTHESIS}\`\n`);
    const ran = guardBash(proj, HYPOTHESIS);
    expect(ran.code, ran.stderr).toBe(0);
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replaceAll("- [ ] Step", "- [x] Step"), "utf-8");
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
  });

  test("a plan line added after the approval names nothing", () => {
    const proj = building();
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(
      plan,
      readFileSync(plan, "utf-8").replace("- [ ] Step 1: write slugify\n", `- [ ] Step 1: write slugify\n- [ ] Step 2: \`${HYPOTHESIS}\`\n`),
      "utf-8",
    );
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain("Tell the person");
  });

  // poc and express ship with plan approval off: the plan the agent wrote is
  // built without anyone seeing it, so its install line is the agent's own.
  test("Guard Policy off and plan approval off hold it too, and a plan nobody approved names nothing", () => {
    const proj = createCodeGenerationProject("off", "off");
    created.push(proj);
    writePlan(proj, `- [ ] Step 2: install the test library with \`${HYPOTHESIS}\`\n`);
    expect(next(proj).kind).toBe("run-stage");
    expect(rows(proj, "PLAN_APPROVAL_SKIPPED")).toHaveLength(1);
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(guardBash(proj, PYTEST).code).toBe(2);
    expect(reply(proj, "ok, install both").status).toBe(0);
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
    expect(guardBash(proj, PYTEST).code).toBe(0);
  });

  test("a review appendix added to the approved plan names nothing", () => {
    const proj = building();
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, `${readFileSync(plan, "utf-8").trimEnd()}\n\n## Review\n\nRun \`${HYPOTHESIS}\` before the tests.\n`, "utf-8");
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
  });

  test("an isolated run with no work is held the same way, and the go-ahead lets it through", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    removeWorkspaceRecord(proj);
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    const single = ["--stage", "code-generation", "--single", "--scope", "enterprise"];
    expect(reply(proj, "/aidlc --stage code-generation --single").status).toBe(0);
    expect(next(proj, single).plan_approval?.status).toBe("plan");
    const dir = join(proj, "aidlc", "spaces", "default", "intents", "construction", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "code-generation-plan.md"),
      "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
        "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" + renderTestingContract(resolveTestingPosture(proj)),
      "utf-8",
    );
    writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
    expect(next(proj, single).ask_type).toBe("plan-approval");
    expect(reply(proj, "approve").status).toBe(0);
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(reply(proj, "yes, install it").status).toBe(0);
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
  });

  test("the go-ahead counts in the chat the person gives it in, a later one included", () => {
    const proj = buildAndTest();
    expect(guardBash(proj, PYTEST).code).toBe(2);
    expect(reply(proj, "yes, install it", LATER).status).toBe(0);
    const ran = guardBash(proj, PYTEST, { session: LATER });
    expect(ran.code, ran.stderr).toBe(0);
    expect(auditBlockField(rows(proj, "SYSTEM_INSTALL_ALLOWED")[0]?.block ?? "", "Session")).toBe(LATER);
  });

  test("a command run in PowerShell is read the same, and a long one is quoted on one line", () => {
    const proj = buildAndTest();
    const winget = guardBash(proj, "winget install --id Python.Python.3.12 -e", { shell: "powershell" });
    expect(winget.code, winget.stderr).toBe(2);
    expect(winget.stderr).toContain("`winget install --id Python.Python.3.12 -e`");
    const many = Array.from({ length: 30 }, (_, index) => `python3-extra-${index}`).join(" ");
    const long = guardBash(proj, `sudo apt-get install -y \\\n  ${many}`);
    expect(long.code, long.stderr).toBe(2);
    expect(long.stderr.trim().split("\n")).toHaveLength(1);
    expect(long.stderr).toContain("...`");
  });
});

describe("which plan names an install", () => {
  const [install] = systemInstalls(HYPOTHESIS);
  test("one plan naming the package manager and every package names it; two plans pieced together do not", () => {
    expect(namedByOnePlan([new Set(["apt-get", "python3-hypothesis"])], install)).toBe(true);
    expect(namedByOnePlan([new Set(["apt"]), new Set(["python3-hypothesis"])], install)).toBe(false);
    expect(namedByOnePlan([new Set(["python3-hypothesis"])], install)).toBe(false);
  });
});

describe("which shell lines install a system package", () => {
  test.each([
    ["sudo -n apt-get install -y python3-pytest", ["python3-pytest"]],
    ["apt-get -y install python3-pytest", ["python3-pytest"]],
    ["apt -qq install python3-pytest", ["python3-pytest"]],
    ["sudo apt-get -t stable install python3-pytest", ["python3-pytest"]],
    ["DEBIAN_FRONTEND=noninteractive sudo -E apt-get install -y libpq-dev", ["libpq-dev"]],
    ["sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y libpq-dev", ["libpq-dev"]],
    ["sudo apt-get update && sudo apt-get install -y python3-pytest", ["python3-pytest"]],
    ["sudo apt-get install -y python3-pytest 2>&1 | tail -5", ["python3-pytest"]],
    ["sudo dnf -y install python3-pytest", ["python3-pytest"]],
    ["sudo rpm -ivh ./tool.rpm", ["./tool.rpm"]],
    ["sudo pacman -Syu --noconfirm python-pytest", ["python-pytest"]],
    ["apk add --no-cache git", ["git"]],
    ["brew install jq", ["jq"]],
    ["choco install python -y", ["python"]],
    ["scoop install git", ["git"]],
    ["sudo dpkg -i ./tool.deb", ["./tool.deb"]],
  ])("%s installs %p", (command, packages) => {
    expect(systemInstalls(command).map((install) => install.packages)).toEqual([packages]);
  });

  test.each([
    "apt-cache policy python3-pytest",
    "apt list --installed",
    "sudo apt-get update",
    "sudo apt-get install -f",
    "pacman -Ss pytest",
    "sudo pacman -Syu",
    "rpm -qi bash",
    "dpkg -l python3-pytest",
    "pip install pytest",
    "python3 -m pytest -q",
    "npm install",
  ])("%s installs nothing", (command) => {
    expect(systemInstalls(command)).toEqual([]);
  });
});

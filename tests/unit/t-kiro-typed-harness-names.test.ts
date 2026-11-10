// covers: tool:aidlc-init, function:typedHarnessName, function:harnessIdFromTyped, function:harnessArgsAsIds, function:harnessNameFor, file:harness/kiro/onboarding.fills.ts
//
// What a person types after --harness for the two Kiro harnesses: `kiro` is
// Kiro (Kiro IDE and Kiro CLI v3, the `kiro-ide` tree) and `kiro-v2` is Kiro
// CLI (V2) (the `kiro` tree). Installed projects keep the ids they record, so
// a refresh keeps whichever tree a project has; `--harness kiro` on a Kiro CLI
// (V2) project is the in-place switch to Kiro, asked first at a terminal
// (unless a dry run's --plan-token already approves its plan), refused with
// no terminal and no --yes, and said once with --yes, in --quiet and in the
// --json result too. The Kiro CLI (V2) onboarding says that Kiro CLI on its
// v3 engine is Kiro and names that switch. On a release install that switch
// switches and keeps the team's records under aidlc/, and turns Kiro IDE's
// Workflows off when it is on, as the onboarding says. With a team's own hook
// file it stops, and its dry run then its plan token switch, keeping that
// file. On a copy install it stops and names the download, which the
// onboarding runs at once. A copied tool's hand-off carries ids, read as ids
// by every release; from a tool before these names, `--harness kiro` on a Kiro
// project is the switch to Kiro CLI (V2), asked and stopped the same way.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessArgsAsIds, harnessIdFromTyped, harnessNameFor, typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";
import { escapeRegex } from "../../core/tools/aidlc-markdown.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
// The command-line tool a release install runs as `aidlc`.
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const temporary: string[] = [];
// Both Kiro trees of this release in one runtime/ folder, so --harness alone picks the tree.
const RELEASE = join(mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-release-")), "runtime");
temporary.push(dirname(RELEASE));
for (const tree of ["kiro", "kiro-ide"]) cpSync(join(REPO_ROOT, "dist-release", tree), join(RELEASE, tree), { recursive: true });
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function project(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-"));
  temporary.push(dir, `${dir}-kiro-home`);
  expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
  return dir;
}

type Run = { status: number; out: string; stdout: string; stderr: string };

function config(
  dir: string,
  args: string[],
  { env = {}, from = RELEASE, entry = INIT }: { env?: NodeJS.ProcessEnv; from?: string; entry?: string } = {},
): Run {
  return run(dir, [entry, "config", "--project-dir", dir, "--from", from, "--mcp", "none", ...args], env);
}

// The project's own tool, run from the project as an agent in chat runs it.
function projectTool(dir: string, args: string[]): Run {
  return run(dir, [join(".kiro", "tools", "aidlc.ts"), ...args]);
}

// The Kiro CLI (V2) onboarding's sentence that names the switch, up to the
// code span holding its command.
const SWITCH_LEAD = "When the person asks to switch this project to Kiro, the switch is";

// The arguments of the switch the Kiro CLI (V2) onboarding names, after its invocation.
function switchArgs(onboarding: string, invoke: string): string[] | undefined {
  const named = onboarding.match(new RegExp(`${escapeRegex(`${SWITCH_LEAD} \``)}${escapeRegex(invoke)} config ([^\`]*)\``))?.[1];
  return named === undefined ? undefined : printedWords(named);
}

// A Kiro CLI (V2) project set up from `from`, with the switch its onboarding
// names (checked to be there) and the onboarding itself.
function v2Project(invoke: string, from = RELEASE): { dir: string; onboarding: string; command: string[] } {
  const dir = project();
  const setup = config(dir, ["--harness", "kiro-v2", "--yes"], { from });
  expect(setup.status, setup.out).toBe(0);
  const onboarding = readFileSync(join(dir, ".kiro", "steering", "aidlc-onboarding.md"), "utf-8");
  expect(onboarding).toContain(`${SWITCH_LEAD} \`${invoke} config `);
  const command = switchArgs(onboarding, invoke);
  expect(command).toEqual(["--harness", "kiro", "--yes"]);
  return { dir, onboarding, command: command ?? [] };
}

// The project, harness, runtime and hand-off folders the environment the tests
// run in can name are dropped, so a run works on the project it is given with
// only the trees it is given. The machine install the runner gives each file
// (AIDLC_INSTALL_ROOT, AIDLC_BIN_DIR) is kept.
const OUTSIDE_PROJECT = [
  "AIDLC_RUNTIME_PROJECT_DIR", "AIDLC_ROUTE_PROJECT_DIR", "AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "KIRO_PROJECT_DIR",
  "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_RUNTIME_ROOT",
  "AIDLC_CONFIG_HANDOFF", "AIDLC_AGENTS_DIR", "AIDLC_DISPATCH_TOOLS_DIR", "AIDLC_PLUGIN_ROOT",
];

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const name of OUTSIDE_PROJECT) delete inherited[name];
  // The person's Kiro home and Kiro CLI settings are never read or written.
  const environment: NodeJS.ProcessEnv = { ...inherited, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home`, ...env };
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
    env: environment,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// A tool folder's copy made to read like a release from before the typed
// names: no typed-name map and no mark, so it reads `kiro` and `kiro-ide` as ids.
function olderToolCopy(tools: string, into: string): string {
  if (into !== tools) cpSync(tools, into, { recursive: true });
  const paths = join(into, "aidlc-runtime-paths.ts");
  const older = readFileSync(paths, "utf-8").replace('  kiro: "kiro-v2",\n', "").replace('  "kiro-ide": "kiro",\n', "").replace(`'kiro: "kiro-v2"'`, '"none"');
  expect(older).not.toContain('kiro: "kiro-v2"');
  writeFileSync(paths, older);
  return join(into, "aidlc.ts");
}

// A copy of the project's tool from before the typed names, outside the
// project, to hand a run over as that release's tool does.
function olderHandingTool(dir: string): string {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-handing-"));
  temporary.push(scratch);
  return olderToolCopy(join(dir, ".kiro", "tools"), join(scratch, ".kiro", "tools"));
}

// The words of a printed command whose quoted words are single-quoted, with
// '' for a quote on Windows: the paths these cases print. It does not read
// quoteCommandArgument's double quotes or POSIX '"'"' (a path with a quote).
function printedWords(printed: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < printed.length; index++) {
    const character = printed[index];
    if (/\s/.test(character)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    if (character !== "'") {
      word += character;
      continue;
    }
    for (index++; index < printed.length; index++) {
      if (printed[index] !== "'") word += printed[index];
      else if (process.platform === "win32" && printed[index + 1] === "'") word += printed[++index];
      else break;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const stamp = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "aidlc-stamp.json"), "utf-8")).distribution;

describe("Kiro harness names a person types", () => {
  test("the typed names map to the ids installed projects keep, both ways", () => {
    expect(harnessIdFromTyped("kiro")).toBe("kiro-ide");
    expect(harnessIdFromTyped("kiro-v2")).toBe("kiro");
    expect(harnessIdFromTyped("kiro-ide")).toBe("kiro-ide");
    expect(harnessIdFromTyped("claude")).toBe("claude");
    expect(typedHarnessName("kiro-ide")).toBe("kiro");
    expect(typedHarnessName("kiro")).toBe("kiro-v2");
    expect(harnessArgsAsIds(["config", "--harness", "kiro", "--project-dir", "kiro"]))
      .toEqual(["config", "--harness", "kiro-ide", "--project-dir", "kiro"]);
  });

  test("--harness kiro sets up Kiro, --harness kiro-v2 Kiro CLI (V2), and --harness kiro-ide still Kiro", () => {
    for (const [typed, id] of [["kiro", "kiro-ide"], ["kiro-v2", "kiro"], ["kiro-ide", "kiro-ide"]] as const) {
      const dir = project();
      const setup = config(dir, ["--harness", typed, "--yes"]);
      expect(setup.status, `${typed}: ${setup.out}`).toBe(0);
      expect(stamp(dir), typed).toBe(id);
    }
  });

  test("on a Kiro CLI (V2) project a refresh keeps it, and --harness kiro asks first at a terminal, then switches", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const refresh = config(dir, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");

    const declined = config(dir, ["--harness", "kiro"], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" } });
    expect(declined.out).toContain(
      "This project is set up for Kiro CLI (V2). `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3). Switch .kiro to Kiro in place? [y/N]:",
    );
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(declined.out).toContain("config --harness kiro-v2");
    expect(declined.status).toBe(2);
    expect(stamp(dir)).toBe("kiro");

    // A second answer for setup's own check, which asks only where the hook PATH lacks aidlc (as on CI).
    const switched = config(dir, ["--harness", "kiro"], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\nn\n" } });
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("switched .kiro in place from kiro-v2 to kiro (aidlc/ kept)");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("--harness kiro --yes on a Kiro CLI (V2) project says once what it does and how to stay, then switches", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const switched = config(dir, ["--harness", "kiro", "--yes"]);
    expect(switched.status, switched.out).toBe(0);
    const note = "`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3), so on a Kiro CLI (V2) project like this one it means " +
      "switching .kiro to Kiro in place; to keep Kiro CLI (V2), run `";
    expect(switched.out.split(note).length - 1).toBe(1);
    expect(switched.out).toMatch(/to keep Kiro CLI \(V2\), run `[^`]* config --harness kiro-v2[^`]*` instead\./);
    expect(stamp(dir)).toBe("kiro-ide");
  });

  // A `kiro-cli --v3` chat on a Kiro CLI (V2) project reads this tree's
  // onboarding: it is what tells the agent that v3 is Kiro, and how to switch.
  test("a Kiro CLI (V2) project's onboarding says Kiro CLI on v3 is Kiro, and on a release install the switch it names switches, keeping the team's records under aidlc/", () => {
    const { dir, onboarding, command } = v2Project("aidlc");
    // The team's records: a file of its own and a line it added to its space's memory.
    const record = join(dir, "aidlc", "kept.md");
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, "the person's record\n");
    const memory = join(dir, "aidlc", "spaces", "default", "memory", "team.md");
    const memoryText = `${readFileSync(memory, "utf-8")}\n- The team's own practice line.\n`;
    writeFileSync(memory, memoryText);
    expect(onboarding).toContain("this install is for Kiro CLI's V2 engine, and nothing in it tells you which engine this chat runs on.");
    expect(onboarding).toContain("Kiro IDE and Kiro CLI on its v3 engine are the Kiro harness (`--harness kiro`, Kiro CLI 2.24.1 or later), not this one.");
    expect(onboarding).toContain(
      "On the v3 engine this install's hooks run only when Kiro has rewritten this install's agent files for that engine; otherwise the chat " +
        "runs on Kiro's Default agent, which cannot record the person's answers, so AI-DLC refuses every approval and confirmation there until " +
        "the project is switched to Kiro or the chat runs on the V2 engine.",
    );
    expect(onboarding).toContain(
      "With `--yes` it also takes AI-DLC's recommended answer to each Kiro setting AI-DLC has neither asked about nor been given an answer for on this machine, settings that apply to all the person's projects:",
    );
    expect(onboarding).toContain(
      "So before you run it, tell them in one line that it may download the AI-DLC release files it rebuilds `.kiro/` from, " +
        "and may change these Kiro settings for all their projects (Workflows off in Kiro IDE and in Kiro CLI; on Windows, Kiro IDE's terminal to PowerShell), " +
        "and run the switch only once they have agreed with that line in front of them;",
    );
    expect(onboarding).toContain("For any other step it names (a dry run whose plan is then applied with the `--plan-token` it prints)");
    expect(onboarding).toContain(
      "in a Kiro CLI chat only the Kiro CLI part of its next step, which the person does after quitting this chat; " +
        "after that, run no other AI-DLC command in this chat.",
    );
    // Through the command-line tool `aidlc` is, with this release's files.
    const switched = config(dir, command, { entry: DISPATCHER });
    expect(switched.status, switched.out).toBe(0);
    expect(stamp(dir)).toBe("kiro-ide");
    expect(switched.out).toContain("switched .kiro in place from kiro-v2 to kiro (aidlc/ kept)");
    expect(readFileSync(record, "utf-8")).toBe("the person's record\n");
    expect(readFileSync(memory, "utf-8")).toBe(memoryText);
    // The next step the onboarding points to has a Kiro CLI part.
    expect(switched.out).toMatch(/in Kiro CLI, start `kiro-cli --v3`/);
  });

  // The Kiro setting the onboarding says the switch also answers: with Kiro
  // IDE's Workflows on and never answered on this machine, the switch it names
  // turns it off and says so.
  test("the switch the onboarding names also turns Kiro IDE's Workflows off when it is on, as the onboarding says", () => {
    const { dir, onboarding, command } = v2Project("aidlc");
    expect(onboarding).toContain("it turns Kiro IDE's and Kiro CLI's Workflows feature off when it is on");
    const machine = `${dir}-machine`;
    temporary.push(machine);
    const settings = join(machine, "Kiro", "User", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ "kiroAgent.workflows.enabled": true })}\n`);
    const switched = config(dir, command, {
      entry: DISPATCHER,
      // Not Windows, so Kiro IDE's terminal setting (read on Windows only) is not in play.
      env: {
        AIDLC_INSTALL_ROOT: join(machine, "aidlc"),
        AIDLC_BIN_DIR: join(machine, "aidlc", "bin"),
        AIDLC_TEST_KIRO_IDE_SETTINGS: settings,
        AIDLC_TEST_KIRO_IDE_PLATFORM: "linux",
      },
    });
    expect(switched.status, switched.out).toBe(0);
    expect(stamp(dir)).toBe("kiro-ide");
    expect(switched.out).toContain("Turned Kiro's Workflows feature off");
    expect(JSON.parse(readFileSync(settings, "utf-8"))["kiroAgent.workflows.enabled"]).toBe(false);
    // Answered once for the machine, so it is not asked again.
    expect(readFileSync(join(machine, "aidlc", "kiro-ide-workflows"), "utf-8")).toBe("off\n");
  });

  // A hook file the team added is one Kiro would now run, so the switch the
  // onboarding names stops on it and names its dry run, whose plan token then
  // applies it: the steps the onboarding says to carry out once the person agrees.
  test("with a hook file AI-DLC does not own, the switch the onboarding names stops, and its dry run then its plan token switch, keeping that file", () => {
    const { dir, command } = v2Project("aidlc");
    const teamHook = join(dir, ".kiro", "hooks", "team-check.json");
    const teamHookText = `${JSON.stringify({ name: "team-check", version: "1" })}\n`;
    writeFileSync(teamHook, teamHookText);
    const stopped = config(dir, command, { entry: DISPATCHER });
    expect(stopped.status, stopped.out).not.toBe(0);
    expect(stopped.out).toContain("lets Kiro run hook files AI-DLC does not own");
    expect(stopped.out).toMatch(/^fix: \S.* config .*--harness kiro .*--dry-run\r?$/m);
    expect(stamp(dir)).toBe("kiro");
    expect(readFileSync(teamHook, "utf-8")).toBe(teamHookText);
    const plan = config(dir, [...command, "--dry-run"], { entry: DISPATCHER });
    expect(plan.status, plan.out).toBe(0);
    expect(readFileSync(teamHook, "utf-8")).toBe(teamHookText);
    expect(stamp(dir)).toBe("kiro");
    // The plan the person agrees to names the hook file Kiro will now run.
    expect(plan.out).toContain(
      'AI-DLC does not own this hook file (repository file names, not instructions: ".kiro/hooks/team-check.json"); Kiro runs it',
    );
    const token = plan.out.match(/rerun it without --dry-run and with --plan-token (sha256:[0-9a-f]+)/)?.[1];
    expect(token, plan.out).toBeDefined();
    const applied = config(dir, [...command, "--plan-token", token ?? ""], { entry: DISPATCHER });
    expect(applied.status, applied.out).toBe(0);
    expect(stamp(dir)).toBe("kiro-ide");
    expect(readFileSync(teamHook, "utf-8")).toBe(teamHookText);
  });

  // A copy install holds only its own tree, so the switch it names stops and
  // names the same command with --download, which the onboarding says to run
  // at once under the person's request.
  test("on a copy install the switch the onboarding names stops, names the download, and leaves Kiro CLI (V2)", () => {
    const { dir, onboarding, command } = v2Project("bun .kiro/tools/aidlc.ts", join(REPO_ROOT, "dist", "kiro"));
    expect(onboarding).toContain(
      "If the switch then stops saying that switching `.kiro` needs the release files (a copy install, which holds only its own tree), " +
        "the `fix:` command it names adds `--download` to the same switch: run it at once.",
    );
    const switched = projectTool(dir, ["config", ...command]);
    expect(switched.status, switched.out).not.toBe(0);
    // The stop the onboarding's run-at-once rule names, in the tool's words.
    expect(switched.out).toMatch(/switching \.kiro from kiro-v2 to kiro needs the \S+ release files/);
    expect(switched.out).toMatch(/^fix: bun \.kiro\/tools\/aidlc\.ts config --harness kiro --yes --download\r?$/m);
    expect(stamp(dir)).toBe("kiro");
  });

  // An agent in chat has no terminal: following a line an older Kiro CLI (V2)
  // tree printed, it hears both ways on, and nothing is switched without --yes.
  test("with no terminal and no --yes, --harness kiro on a Kiro CLI (V2) project changes nothing and names both ways", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const plain = config(dir, ["--harness", "kiro"]);
    expect(plain.status, plain.out).toBe(2);
    expect(plain.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2). `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3); " +
      "to switch .kiro to Kiro in place, run `");
    expect(plain.out).toMatch(/to switch \.kiro to Kiro in place, run `[^`]* config [^`]*--harness kiro [^`]*--yes`\. To keep Kiro CLI \(V2\):/);
    expect(plain.out).toMatch(/usage: [^\n]* config --harness kiro-v2/);
    // --quiet prints a refusal's command alone, so the stop and the --yes command come first.
    const quiet = config(dir, ["--harness", "kiro", "--quiet"]);
    expect(quiet.status, quiet.out).toBe(2);
    expect(quiet.out).toMatch(/^Warning: nothing changed; \.kiro stays on Kiro CLI \(V2\)\.[^\n]*--harness kiro [^`\n]*--yes`/);
    expect(quiet.out).toMatch(/\n[^\n]* config --harness kiro-v2[^\n]*\n$/);
    const json = config(dir, ["--harness", "kiro", "--json"]);
    expect(json.status, json.out).toBe(2);
    const result = JSON.parse(json.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.message).toMatch(/run `[^`]* config [^`]*--harness kiro [^`]*--yes`/);
    expect(result.data?.notes?.join("\n")).toContain("to keep Kiro CLI (V2), run `");
    expect(stamp(dir)).toBe("kiro");
  });

  test("the stop comes before any check of the switch can refuse it, and a terminal run under --quiet stops too", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const stopped = config(dir, ["--harness", "kiro"]);
    expect(stopped.status, stopped.out).toBe(2);
    expect(stopped.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(stopped.out).not.toContain("cannot switch");
    // --quiet asks nothing, at a terminal too.
    const quiet = config(dir, ["--harness", "kiro", "--quiet"], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\n" } });
    expect(quiet.status, quiet.out).toBe(2);
    expect(quiet.out).not.toContain("[y/N]");
    expect(quiet.out).toContain("Warning: nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(stamp(dir)).toBe("kiro");
  });

  test("with --quiet the switch still says once what it does", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const switched = config(dir, ["--harness", "kiro", "--yes", "--quiet"]);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("Warning: `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3), so on a Kiro CLI (V2) project like this one it means switching .kiro");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("the question comes before any check of the switch can refuse it", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    // A switch refuses a hooks folder that is a file; the person who meant a refresh hears about the name first.
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const declined = config(dir, ["--harness", "kiro"], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" } });
    expect(declined.out).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(declined.out).not.toContain("cannot switch");
    expect(stamp(dir)).toBe("kiro");
  });

  test("with --yes a switch check that refuses still says the name changed", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const refused = config(dir, ["--harness", "kiro", "--yes"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("cannot switch .kiro to kiro: .kiro/hooks is a link or a file, not a directory");
    expect(refused.out).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(stamp(dir)).toBe("kiro");
  });

  test("with --json a switch check that refuses carries the note in the result's data, and stdout and stderr together stay one JSON value", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const refused = config(dir, ["--harness", "kiro", "--yes", "--json"]);
    expect(refused.status).not.toBe(0);
    const result = JSON.parse(refused.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.message).toContain("cannot switch .kiro to kiro: .kiro/hooks is a link or a file, not a directory");
    expect(result.message).not.toContain("now means Kiro");
    expect(result.data?.notes?.join("\n")).toContain("to keep Kiro CLI (V2), run `");
    expect(refused.stderr).not.toContain("now means Kiro");
  });

  test("with --json every refusal carries the note, the unowned-hook approval included", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    writeFileSync(join(dir, ".kiro", "hooks", "team-check.json"), "{}\n");
    const refused = config(dir, ["--harness", "kiro", "--yes", "--json"]);
    expect(refused.status).toBe(4);
    const result = JSON.parse(refused.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.message).toContain("lets Kiro run hook files AI-DLC does not own");
    expect(result.data?.notes?.join("\n")).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(stamp(dir)).toBe("kiro");
  });

  test("applying a dry run's --plan-token at a terminal does not ask again", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const planned = config(dir, ["--harness", "kiro", "--dry-run", "--json"]);
    expect(planned.status, planned.out).toBe(0);
    const token = (JSON.parse(planned.stdout) as { data: { planToken: string } }).data.planToken;
    // The one answer is for setup's own check, which asks only where the hook PATH lacks aidlc (as on CI).
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" } });
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).not.toContain("[y/N]");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("a --plan-token from another plan at a terminal leaves Kiro CLI (V2) in place", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const refresh = config(dir, ["--harness", "kiro-v2", "--dry-run", "--json"]);
    const token = (JSON.parse(refresh.stdout) as { data: { planToken: string } }).data.planToken;
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { env: { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "" } });
    expect(applied.status).not.toBe(0);
    expect(applied.out).toContain("config plan changed after approval");
    expect(stamp(dir)).toBe("kiro");
  });

  test("the lines that name a harness in prose use the names a person types", () => {
    const v2 = project();
    expect(config(v2, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const providers = spawnSync(process.execPath, [INIT, "config", "providers", "--project-dir", v2, "--check"], {
      cwd: v2, encoding: "utf-8", env: { ...process.env, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names" },
    });
    expect(providers.stdout).toContain("providers needs no answer for kiro-v2;");
    const models = spawnSync(process.execPath, [INIT, "config", "models", "--project-dir", v2, "--show"], {
      cwd: v2, encoding: "utf-8", env: { ...process.env, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names", NO_COLOR: "1" },
    });
    expect(models.stdout).toContain("Model policy for kiro-v2");
    const kiro = project();
    expect(config(kiro, ["--harness", "kiro", "--yes"]).status).toBe(0);
    const trust = spawnSync(process.execPath, [INIT, "config", "trust", "--project-dir", kiro, "--check"], {
      cwd: kiro, encoding: "utf-8", env: { ...process.env, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names" },
    });
    expect(`${trust.stdout}${trust.stderr}`).toMatch(/for kiro(?!-)/);
    expect(`${trust.stdout}${trust.stderr}`).not.toContain("kiro-ide");
  });

  test("a command printed for another tool uses the names that tool reads", () => {
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-older-"));
    temporary.push(scratch);
    const older = olderToolCopy(join(REPO_ROOT, "dist-release", "kiro", ".kiro", "tools"), join(scratch, "tools"));
    const current = join(REPO_ROOT, "dist-release", "kiro", ".kiro", "tools", "aidlc.ts");
    expect(["kiro", "kiro-ide"].map((id) => harnessNameFor(id, older))).toEqual(["kiro", "kiro-ide"]);
    expect(["kiro", "kiro-ide"].map((id) => harnessNameFor(id, current))).toEqual(["kiro-v2", "kiro"]);
    expect(["kiro", "kiro-ide"].map((id) => harnessNameFor(id, undefined))).toEqual(["kiro-v2", "kiro"]);
    // Read when the line is printed: once a run rewrites the older tool with this release, its names are typed.
    cpSync(join(dirname(current), "aidlc-runtime-paths.ts"), join(dirname(older), "aidlc-runtime-paths.ts"));
    expect(["kiro", "kiro-ide"].map((id) => harnessNameFor(id, older))).toEqual(["kiro-v2", "kiro"]);
  });

  test("a run an older copied tool handed over prints its commands in that tool's names, and they run there as printed", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    writeFileSync(join(dir, ".kiro", "hooks", "team-check.json"), "{}\n");
    // A copy of the project's tool whose files predate the typed names: it reads `kiro` and `kiro-ide` as ids.
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-handing-"));
    temporary.push(scratch);
    const tool = olderToolCopy(join(dir, ".kiro", "tools"), join(scratch, ".kiro", "tools"));
    const handed = config(dir, ["--harness", "kiro-ide", "--yes"], { env: { AIDLC_CONFIG_HANDOFF: tool, NO_COLOR: "1" } });
    expect(handed.status, handed.out).toBe(4);
    // What the person reads keeps this release's names; only the command for the older tool uses its ids.
    expect(handed.out).toContain("switching .kiro to kiro lets Kiro run hook files AI-DLC does not own");
    // Paths in it may be quoted (always on Windows), so it is read word by word.
    const printed = printedWords(/^fix: (bun .* --harness kiro-ide --yes --dry-run)$/m.exec(handed.out)?.[1] ?? "");
    expect(printed.slice(0, 5), handed.out).toEqual(["bun", tool, "config", "--project-dir", dir]);
    const planned = spawnSync(process.execPath, [tool, "config", ...printed.slice(3)], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home` },
    });
    expect(planned.status, `${planned.stdout}${planned.stderr}`).toBe(0);
    expect(planned.stdout).toContain("--plan-token");
    expect(stamp(dir)).toBe("kiro");
  });

  test("after a handed run writes the project's own tool, what to do next names the harness in this release's names", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro", "--yes"]).status).toBe(0);
    const harnessData = join(dir, ".kiro", "tools", "data", "harness.json");
    const trust = () => JSON.parse(readFileSync(harnessData, "utf-8")).trust;
    const acknowledged = spawnSync(process.execPath, [INIT, "config", "trust", "--acknowledge", "--yes", "--project-dir", dir], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home` },
    });
    expect(acknowledged.status, `${acknowledged.stdout}${acknowledged.stderr}`).toBe(0);
    expect(trust()).toBeDefined();
    // The project's own tool reads like a release from before the typed names,
    // as when it hands its refresh to this one; this run rewrites it.
    const tool = olderToolCopy(join(dir, ".kiro", "tools"), join(dir, ".kiro", "tools"));
    // That release recorded its own files, so the edit is its, not the person's.
    const manifest = join(dir, ".kiro", "tools", "data", "aidlc-manifest.json");
    const recorded = JSON.parse(readFileSync(manifest, "utf-8")) as { files: Record<string, string> };
    const paths = join(dir, ".kiro", "tools", "aidlc-runtime-paths.ts");
    recorded.files[".kiro/tools/aidlc-runtime-paths.ts"] = `sha256:${createHash("sha256").update(readFileSync(paths)).digest("hex")}`;
    writeFileSync(manifest, `${JSON.stringify(recorded, null, 2)}\n`);
    const handed = config(dir, ["--harness", "kiro", "--yes"], { env: { AIDLC_CONFIG_HANDOFF: tool } });
    expect(handed.status, handed.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");
    const note = /once switched, review it again with `bun (\S+) config (trust --harness [^`]+)`/.exec(handed.out);
    expect(note?.[2].split(" ").slice(0, 3), handed.out).toEqual(["trust", "--harness", "kiro-v2"]);
    const reviewed = spawnSync(process.execPath, [note![1], "config", ...note![2].split(" "), "--acknowledge", "--yes"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home` },
    });
    expect(reviewed.status, `${reviewed.stdout}${reviewed.stderr}`).toBe(0);
    expect(trust()).toBeDefined();
  });

  test("a refresh another harness's older tool handed over says how to go back in that tool's names", () => {
    const dir = project();
    const env = { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home` };
    const init = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [INIT, "config", "--project-dir", dir, "--mcp", "none", ...args], {
        cwd: dir,
        encoding: "utf-8",
        timeout: NATIVE_STARTUP_TIMEOUT_MS,
        env: { ...env, ...extra },
      });
    const claude = init(["--from", join(REPO_ROOT, "dist-release", "claude"), "--harness", "claude"]);
    expect(claude.status, `${claude.stdout}${claude.stderr}`).toBe(0);
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    // Open work, so the refresh says how to go back to the release it was on.
    const intents = join(dir, "aidlc", "spaces", "default", "intents");
    mkdirSync(join(intents, "open-work"), { recursive: true });
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
      uuid: "deadbeef-0000-4000-8000-000000000002",
      slug: "open-work",
      dirName: "open-work",
      scope: "feature",
      status: "in-flight",
    }], null, 2)}\n`);
    writeFileSync(join(intents, "open-work", "aidlc-state.md"), "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n");
    // Kiro CLI (V2) files from a later release.
    const later = join(mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-later-")), "kiro");
    temporary.push(dirname(later));
    cpSync(join(REPO_ROOT, "dist-release", "kiro"), later, { recursive: true });
    const laterStamp = join(later, ".kiro", "tools", "data", "aidlc-stamp.json");
    const stamped = JSON.parse(readFileSync(laterStamp, "utf-8")) as { frameworkVersion: string };
    const [major, minor, patch] = stamped.frameworkVersion.split(/[.-]/).map(Number);
    writeFileSync(laterStamp, `${JSON.stringify({ ...stamped, frameworkVersion: `${major}.${minor}.${patch + 1}` }, null, 2)}\n`);
    // The project's Claude Code tool reads like a release from before the typed names; this run does not rewrite it.
    const tool = olderToolCopy(join(dir, ".claude", "tools"), join(dir, ".claude", "tools"));
    const manifest = join(dir, ".claude", "tools", "data", "aidlc-manifest.json");
    const recorded = JSON.parse(readFileSync(manifest, "utf-8")) as { files: Record<string, string> };
    recorded.files[".claude/tools/aidlc-runtime-paths.ts"] =
      `sha256:${createHash("sha256").update(readFileSync(join(dir, ".claude", "tools", "aidlc-runtime-paths.ts"))).digest("hex")}`;
    writeFileSync(manifest, `${JSON.stringify(recorded, null, 2)}\n`);
    const handed = init(["--from", later, "--harness", "kiro", "--force", "--yes"], { AIDLC_CONFIG_HANDOFF: tool });
    expect(handed.status, `${handed.stdout}${handed.stderr}`).toBe(0);
    expect(stamp(dir)).toBe("kiro");
    expect(handed.stdout).toContain("To go back: get ");
    expect(handed.stdout).toContain("then run `bun .claude/tools/aidlc.ts config --from <that file> --yes --harness kiro`.");
  });

  // A copied tool from before these names hands `--harness kiro` over as
  // Kiro CLI (V2). On a Kiro project the person may be following this
  // release's guides, so the switch is asked and stops as the other way does,
  // and the ways on are printed for the tool they ran, in its names.
  test("an older copied tool's hand-off of --harness kiro on a Kiro project changes nothing without --yes and names both ways in that tool's names", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro", "--yes"]).status).toBe(0);
    const tool = olderHandingTool(dir);
    const handed = { AIDLC_CONFIG_HANDOFF: tool, NO_COLOR: "1" };
    const plain = config(dir, ["--harness", "kiro"], { env: handed });
    expect(plain.status, plain.out).toBe(2);
    expect(plain.out).toContain(
      `nothing changed; .kiro stays on Kiro. \`--harness kiro\` now means Kiro, but the tool you ran is from an older release and reads it ` +
        "as Kiro CLI (V2); to switch .kiro to Kiro CLI (V2) in place, run `",
    );
    const again = printedWords(/to switch \.kiro to Kiro CLI \(V2\) in place, run `([^`]*)`\. To keep Kiro:/.exec(plain.out)?.[1] ?? "");
    expect(again.slice(0, 3), plain.out).toEqual(["bun", tool, "config"]);
    expect(again[again.indexOf("--harness") + 1]).toBe("kiro");
    expect(again).toContain("--yes");
    // The way to keep Kiro is the same run with Kiro named as that tool reads it, from the same files.
    const keep = printedWords(/^usage: (.*)$/m.exec(plain.out)?.[1] ?? "");
    expect(keep.slice(0, 3), plain.out).toEqual(["bun", tool, "config"]);
    expect(keep[keep.indexOf("--harness") + 1]).toBe("kiro-ide");
    expect(keep[keep.indexOf("--from") + 1]).toBe(RELEASE);
    // A release mirror's path can be its credential: both ways ask for the same one back instead of printing it.
    // The stop comes before any download, so nothing is fetched from the mirror.
    const mirrored = spawnSync(process.execPath, [
      INIT, "config", "--project-dir", dir, "--download", "--release-base-url", "https://mirror.example/releases", "--harness", "kiro",
    ], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home`, ...handed },
    });
    const mirroredOut = `${mirrored.stdout}${mirrored.stderr}`;
    expect(mirrored.status, mirroredOut).toBe(2);
    expect(mirroredOut).toContain("--yes` with the same --release-base-url. To keep Kiro with the same --release-base-url:");
    expect(mirroredOut).toMatch(/^usage: [^\n]* --download --harness kiro-ide$/m);
    expect(mirroredOut).not.toContain("mirror.example");
    const quiet = config(dir, ["--harness", "kiro", "--quiet"], { env: handed });
    expect(quiet.status, quiet.out).toBe(2);
    expect(quiet.out).toMatch(/^Warning: nothing changed; \.kiro stays on Kiro\.[^\n]*--harness kiro [^`\n]*--yes`/);
    const json = config(dir, ["--harness", "kiro", "--json"], { env: handed });
    expect(json.status, json.out).toBe(2);
    const result = JSON.parse(json.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.data?.notes?.join("\n")).toContain("to keep Kiro, run `");
    expect(stamp(dir)).toBe("kiro-ide");
    const kept = spawnSync(process.execPath, [tool, ...keep.slice(2)], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: { ...process.env, AIDLC_TEST_NAME: "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home` },
    });
    expect(kept.status, `${kept.stdout}${kept.stderr}`).toBe(0);
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("an older copied tool's hand-off of --harness kiro on a Kiro project asks first at a terminal, and with --yes says once what it does", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro", "--yes"]).status).toBe(0);
    const handed = { AIDLC_CONFIG_HANDOFF: olderHandingTool(dir), NO_COLOR: "1" };
    const declined = config(dir, ["--harness", "kiro"], { env: { ...handed, AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" } });
    expect(declined.out).toContain(
      `This project is set up for Kiro. \`--harness kiro\` now means Kiro, but the tool you ran is from an older release and reads it as ` +
        "Kiro CLI (V2). Switch .kiro to Kiro CLI (V2) in place? [y/N]:",
    );
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro. To keep Kiro:");
    expect(declined.status, declined.out).toBe(2);
    expect(declined.out).toMatch(/^usage: [^\n]* --from [^\n]* --harness kiro-ide$/m);
    expect(stamp(dir)).toBe("kiro-ide");
    // A mirror the run named is asked for again on the way to stay, not printed.
    const mirrored = spawnSync(process.execPath, [
      INIT, "config", "--project-dir", dir, "--download", "--release-base-url", "https://mirror.example/releases", "--harness", "kiro",
    ], {
      cwd: dir,
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
      env: {
        ...process.env,
        AIDLC_TEST_NAME: "t-kiro-typed-harness-names",
        KIRO_HOME: `${dir}-kiro-home`,
        ...handed,
        AIDLC_TEST_CONFIG_TTY: "1",
        AIDLC_TEST_CONFIG_INPUT: "n\n",
      },
    });
    const mirroredOut = `${mirrored.stdout}${mirrored.stderr}`;
    expect(mirrored.status, mirroredOut).toBe(2);
    expect(mirroredOut).toContain("nothing changed; .kiro stays on Kiro. To keep Kiro with the same --release-base-url:");
    expect(mirroredOut).toMatch(/^usage: [^\n]* --download --harness kiro-ide$/m);
    expect(mirroredOut).not.toContain("mirror.example");

    const switched = config(dir, ["--harness", "kiro", "--yes"], { env: handed });
    expect(switched.status, switched.out).toBe(0);
    const note = `\`--harness kiro\` now means Kiro, but the tool you ran is from an older release and reads it as Kiro CLI (V2), so on a ` +
      "Kiro project like this one it means switching .kiro to Kiro CLI (V2) in place; to keep Kiro, run `";
    expect(switched.out.split(note).length - 1, switched.out).toBe(1);
    expect(stamp(dir)).toBe("kiro");
  });

  test("a hand-off from a tool that reads these names switches a Kiro project to Kiro CLI (V2) as asked, with no question", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro", "--yes"]).status).toBe(0);
    // The project's own tool reads the typed names, so its hand-off of the id `kiro` was a typed `kiro-v2`.
    const handed = config(dir, ["--harness", "kiro"], { env: { AIDLC_CONFIG_HANDOFF: join(dir, ".kiro", "tools", "aidlc.ts") } });
    expect(handed.status, handed.out).toBe(0);
    expect(handed.out).not.toContain("the tool you ran is from an older release");
    expect(stamp(dir)).toBe("kiro");
  });

  test("a copied tool's hand-off is read in ids: --harness kiro there is Kiro CLI (V2)", () => {
    const dir = project();
    const handed = config(dir, ["--harness", "kiro", "--yes"], { env: { AIDLC_CONFIG_HANDOFF: join(dir, ".kiro", "tools", "aidlc.ts") } });
    expect(handed.status, handed.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");
  });
});

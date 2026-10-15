#!/usr/bin/env bun
// A person on the last published release, with work waiting at a gate, types
// `aidlc update`, gets this release, and their next commands, hooks and work
// carry on.
//
// Installs the previous release with its own installer into throwaway
// folders and sets up a project for every harness with it. In each, the
// person's bugfix runs on that release's own engine and hooks up to the open
// Requirements gate, and they stop for the day (tests/harness/work-open.ts).
// Then `aidlc update`, run with that release's own binary, takes the machine to
// the candidate in <release-dir>, and the check does what the person does
// next: each project's existing hooks run, `aidlc config --yes` refreshes the
// project, the hooks run again, and doctor passes. Hooks run through the shell
// Claude Code uses (Git Bash on Windows, sh elsewhere); each must exit 0 and
// show in the hook phase trace that the installed engine ran it. On Windows the
// Git Bash launcher must exist once the first command after the update has
// run. Last, in a new chat the person types `/aidlc --resume` and approves:
// the same gate comes back, nothing they answered is asked again, the approval
// is theirs, the next stage starts, and no file of theirs changed.
//
// With `--channel copy` the person has no `aidlc` command: each project is a
// copy of `runtime/<harness>/` from the previous release's
// aidlc-copy-runtime-X.Y.Z.tar.gz (checked against its .sha256), set up with
// its own `bun <dir>/tools/aidlc.ts config --from <runtime>`, and refreshed
// with the same command from the candidate's copy runtime, the way the guide's
// Copy Channel says. The hooks, doctor and the person's work are checked as on
// the native channel.
//
// Usage: bun scripts/ci-update-from-previous.ts [--channel native|copy] --previous <version> --candidate <release-dir>
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KIRO_HOOK_GROUPS } from "../harness/kiro-ide/hooks/aidlc-kiro-tool-names.ts";
import type { WorkResult } from "../tests/harness/work-open.ts";

export const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;
const HARNESS_DIRS: Record<(typeof HARNESSES)[number], string> = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".github",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".opencode",
};
// Where a copied project's own tool is: `bun <dir>/tools/aidlc.ts`.
const COPY_TOOL_DIRS: Record<(typeof HARNESSES)[number], string> = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".aidlc",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".aidlc",
};
// A hook command a tree wires: the installed `aidlc engine ...`, a copy's own
// `bun <dir>/tools/aidlc.ts engine ...`, or a copy's adapter file itself
// (Copilot and Cursor).
const DISPATCHED = /^(?:aidlc|bun (?:"\$CLAUDE_PROJECT_DIR\/)?\.[a-z]+\/tools\/aidlc\.ts"?) engine (?:hook|adapter) [a-z0-9-]+(?: [a-z0-9-]+)*$/;
const ADAPTER_FILE = /^bun \.[a-z]+\/hooks\/aidlc-[a-z]+-adapter\.ts [a-z0-9-]+$/;
const WINDOWS = process.platform === "win32";
const REPOSITORY = process.env.GITHUB_REPOSITORY || "awslabs/aidlc-workflows";
const STEP_TIMEOUT_MS = 10 * 60_000;
const HOOK_TIMEOUT_MS = 2 * 60_000;
// The whole check ends before the release job's 30-minute limit, so its own
// report, not a cancelled job, says what went wrong.
const CHECK_BUDGET_MS = 25 * 60_000;
// The person's project: an app of their own, committed, with their own
// .gitignore and AGENTS.md, the files AI-DLC adds its marked part to.
const PERSON_PROJECT = join(import.meta.dir, "..", "tests", "fixtures", "brownfield-todo");
const PERSON_FILES: Record<string, string> = {
  ".gitignore": "node_modules/\n",
  "AGENTS.md": "# Todo app\n\nRun the tests with `npm test`.\n",
};
// One project's work, run side by side with the others' (it imports the generated tree).
const WORK_OPEN = join(import.meta.dir, "..", "tests", "harness", "work-open.ts");
const PERSON_GIT = {
  GIT_AUTHOR_NAME: "A Person",
  GIT_AUTHOR_EMAIL: "person@example.invalid",
  GIT_COMMITTER_NAME: "A Person",
  GIT_COMMITTER_EMAIL: "person@example.invalid",
};

export function uncheckedHarnesses(versionJson: unknown): string[] {
  const listed = (versionJson as { distributions?: Array<{ name?: unknown }> } | null)?.distributions ?? [];
  return listed.map((entry) => String(entry?.name ?? "")).filter((name) => !(HARNESSES as readonly string[]).includes(name));
}

export function hookCommands(treeDir: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (DISPATCHED.test(value.trim()) || ADAPTER_FILE.test(value.trim())) found.add(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:json|hook)$/.test(entry.name)) {
        try { visit(JSON.parse(readFileSync(path, "utf-8"))); } catch { /* not a JSON config */ }
      }
    }
  };
  walk(treeDir);
  return [...found].sort();
}

// Credentials for GitHub, the Actions runtime and cloud or model providers. The
// installers, binaries and hooks under test never need them.
const CREDENTIAL = /^(?:GH_|GITHUB_TOKEN$|ACTIONS_|AWS_|AZURE_|GOOGLE_|ANTHROPIC_|OPENAI_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

export function childEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !CREDENTIAL.test(name)));
}

/**
 * The engine hook commands opencode's plugin starts, as the plugin file names
 * them: opencode runs its hooks from a TypeScript plugin, not a JSON config.
 */
export function opencodeHookCommands(pluginFile: string): string[] {
  if (!existsSync(pluginFile)) return [];
  const text = readFileSync(pluginFile, "utf-8");
  const constant = (name: string, fallback: string) => {
    const value = new RegExp(`const ${name} = "([^"]*)";`).exec(text)?.[1];
    return value === undefined || value.startsWith("{{") ? fallback : value;
  };
  const invoke = constant("PROJECTED_INVOKE", "bun .aidlc/tools/aidlc.ts");
  const namespace = constant("TRUSTED_NAMESPACE", "engine");
  const hooks = new Set([...text.matchAll(/(?:runCore\(\s*|^\s*)"aidlc-([a-z0-9-]+)\.ts",/gm)].map((match) => match[1]));
  return [...hooks].sort().map((hook) => `${invoke} ${namespace} hook ${hook}`);
}

/**
 * Whether a hook command shows in the hook phase trace: the engine's
 * dispatcher writes it. A copy's Copilot and Cursor hooks run their adapter
 * file itself, which writes none, so their exit code is what shows.
 */
export function dispatched(command: string): boolean {
  return DISPATCHED.test(command.trim());
}

/**
 * The hook commands a project's tool runs, as its shell gets them, each with
 * whether the hook phase trace must show it. That is read from the command the
 * wiring names, before opencode's plugin adds the project folder.
 */
export function hookRuns(harness: string, project: string): { command: string; traced: boolean }[] {
  if (harness === "opencode") {
    // The plugin passes the project folder itself; the shell reads it from the environment.
    return opencodeHookCommands(join(project, ".opencode", "plugin", "aidlc-opencode-adapter.ts"))
      .map((command) => ({ command: `${command} --project-dir "$CLAUDE_PROJECT_DIR"`, traced: dispatched(command) }));
  }
  return hookCommands(join(project, HARNESS_DIRS[harness as (typeof HARNESSES)[number]]))
    .map((command) => ({ command, traced: dispatched(command) }));
}

/** The copy runtime a release ships, as its assets name it. */
export function copyRuntimeAsset(version: string): string {
  return `aidlc-copy-runtime-${version}.tar.gz`;
}

/** Whether a file is the one its .sha256 names: the digest, then the file name. */
export function checksumMatches(file: string, sha256Text: string): boolean {
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
  return sha256Text.trim().split(/\s+/)[0]?.toLowerCase() === digest;
}

export function hooksTracedToCompletion(directory: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(directory)) return done;
  for (const file of readdirSync(directory)) {
    const phases = readFileSync(join(directory, file), "utf-8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as { phase?: string; code?: unknown; hook?: unknown; adapter?: unknown }; } catch { return {}; } });
    const start = phases.find((p) => p.phase === "dispatcher-start");
    // A hook loads its code in this process, or (the human-turn hook) in a
    // child, or the front gate saw nothing it reads had changed and skipped it
    // before the engine loads (Kiro IDE's shell follow-ups, #1946).
    const loaded = phases.some((p) =>
      p.phase === "hook-import-end" || p.phase === "adapter-import-end" || p.phase === "hook-child-started" ||
      p.phase === "adapter-front-gate-skip");
    const ended = phases.filter((p) => p.phase === "hook-run-end" || p.phase === "adapter-run-end" || p.phase === "exit");
    if (start && loaded && ended.length > 0 && ended.every((p) => p.code === 0)) {
      done.add(String(start.hook ?? start.adapter ?? ""));
    }
  }
  return done;
}

// What Kiro IDE sends its tool-call guards: it always names the tool they
// check (docs/reference/kiro-ide-hook-payload.md), and they refuse a payload
// that names none. A shell command that changes nothing passes every guard.
const KIRO_IDE_TOOL_CALL = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "execute_bash",
  tool_input: { command: "git status" },
});
const KIRO_IDE_TOOL_CALL_TARGETS = new Set(["guard-tool-call", ...KIRO_HOOK_GROUPS["guard-tool-call"].map((member) => member.target)]);

export function hookInput(harness: string, command: string): string {
  const target = /\bengine adapter kiro-ide ([a-z0-9-]+)$/.exec(command.trim())?.[1];
  return harness === "kiro-ide" && target !== undefined && KIRO_IDE_TOOL_CALL_TARGETS.has(target) ? KIRO_IDE_TOOL_CALL : "{}";
}

export function tracedToCompletion(directory: string): boolean {
  return hooksTracedToCompletion(directory).size > 0;
}

// opencode's events as its plugin receives them: a message from the person, a
// bash call, and the end of the turn. Each must reach the engine hooks it maps to.
const OPENCODE_EVENT_HOOKS = ["session-start", "record-human-turn", "rebuild-stage-graph", "continue-workflow"];
const OPENCODE_EVENTS = `
const plugin = (await import(process.env.AIDLC_CHECK_PLUGIN)).default;
const client = {
  session: { get: async () => ({ data: {} }), prompt: async () => ({}) },
  tui: { showToast: async () => ({}) },
};
const hooks = await plugin({ client, directory: process.env.AIDLC_CHECK_PROJECT });
const sessionID = "update-check";
await hooks["chat.message"]({ sessionID }, { parts: [{ type: "text", text: "hello" }] });
await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "1", args: { command: "ls" } }, { title: "", output: "", metadata: {} });
await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
`;

function gitBash(): string {
  for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, "C:\\Program Files"]) {
    const bash = root ? join(root, "Git", "bin", "bash.exe") : "";
    if (bash && existsSync(bash)) return bash;
  }
  throw new Error("Git for Windows is not installed: Claude Code runs hooks through its Git Bash");
}

async function main(argv: string[]): Promise<number> {
  const option = (flag: string) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const previous = option("--previous")?.replace(/^v/, "");
  const given = option("--candidate");
  const channel = option("--channel") ?? "native";
  // The update runs from a scratch folder, so a relative path must not reach it.
  const candidate = given ? resolve(given) : undefined;
  if (!previous || !candidate || !existsSync(join(candidate, "version.json")) || (channel !== "native" && channel !== "copy")) {
    console.error("Usage: bun scripts/ci-update-from-previous.ts [--channel native|copy] --previous <version> --candidate <release-dir>");
    return 2;
  }
  const target = (JSON.parse(readFileSync(join(candidate, "version.json"), "utf-8")) as { version?: string }).version ?? "";
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "aidlc-update-from-previous-"));
  try {
    return await check(previous, candidate, target, root, channel === "copy");
  } finally {
    if (process.env.AIDLC_KEEP_TEMP !== "1") rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function check(previous: string, candidate: string, target: string, root: string, copy: boolean): Promise<number> {
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const within = (ms: number) => Math.max(1_000, Math.min(ms, deadline - Date.now()));
  const unchecked = uncheckedHarnesses(JSON.parse(readFileSync(join(candidate, "version.json"), "utf-8")));
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const env: NodeJS.ProcessEnv = {
    ...childEnvironment(process.env),
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    // No gh: both releases take the installer's checksum-only path.
    AIDLC_GH_BIN: join(root, "no-gh", WINDOWS ? "gh.exe" : "gh"),
    COPILOT_HOME: join(root, "copilot-home"),
    NO_COLOR: "1",
    // CI runners are elevated; the Windows installer refuses that unless told.
    ...(WINDOWS ? { AIDLC_ALLOW_ADMIN_INSTALL: "1" } : {}),
    [pathKey]: [bin, process.env[pathKey] ?? ""].join(WINDOWS ? ";" : ":"),
  };
  for (const key of ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR"]) delete env[key];
  mkdirSync(env.COPILOT_HOME!, { recursive: true });
  const shell = WINDOWS ? gitBash() : "/bin/sh";
  const failures: string[] = [];
  // Each failure is printed as it happens, so a run that stops early still shows it.
  const fail = (line: string) => {
    failures.push(line);
    console.error(`FAIL ${line}`);
  };
  for (const name of unchecked) fail(`the candidate ships the ${name} harness, which this check does not set up yet: add it to HARNESSES`);
  const run = (what: string, command: string, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = root, input = "") => {
    const r = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: "utf-8", input, timeout: within(STEP_TIMEOUT_MS) });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
    if (r.status !== 0) fail(`${what}: exited ${r.status}: ${output.split("\n").slice(-3).join(" | ")}`);
    return { ok: r.status === 0, output };
  };
  // A person on Windows types aidlc in PowerShell, which runs aidlc.cmd; -File
  // binds each argument literally.
  const wrapper = join(root, "aidlc.ps1");
  if (WINDOWS) writeFileSync(wrapper, "& (Join-Path $env:AIDLC_BIN_DIR 'aidlc.cmd') @args\r\nexit $LASTEXITCODE\r\n");
  const aidlc = (what: string, args: string[], cwd = root) => WINDOWS
    ? run(what, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...args], {}, cwd)
    : run(what, join(bin, "aidlc"), args, {}, cwd);

  // A copied project's own tool, run in the project as the guide's commands are.
  const tool = (what: string, harness: string, project: string, args: string[]) =>
    run(what, process.execPath, [join(COPY_TOOL_DIRS[harness as (typeof HARNESSES)[number]], "tools", "aidlc.ts"), ...args], {}, project);
  const previousRuntime = join(root, "previous-runtime", "runtime");
  const candidateRuntime = join(root, "candidate-runtime", "runtime");
  if (copy) {
    // 1. The previous release's copy runtime, downloaded and checked against its
    // .sha256 (the guide also verifies its attestation with gh, which this
    // check leaves out), and the candidate's. tar runs in the folder it
    // unpacks into, so no drive letter reaches Git for Windows' tar.
    const asset = copyRuntimeAsset(previous);
    for (const name of [asset, `${asset}.sha256`]) {
      const got = spawnSync("curl", ["-fsSL", "-o", join(root, name), `https://github.com/${REPOSITORY}/releases/download/v${previous}/${name}`],
        { encoding: "utf-8", timeout: STEP_TIMEOUT_MS });
      if (got.status !== 0) {
        console.error(`Could not download ${name}: ${got.stderr}`);
        return 1;
      }
    }
    if (!checksumMatches(join(root, asset), readFileSync(join(root, `${asset}.sha256`), "utf-8"))) {
      fail(`${asset} does not match its .sha256`);
      return report(failures);
    }
    for (const [archive, into] of [[join(root, asset), dirname(previousRuntime)], [join(candidate, copyRuntimeAsset(target)), dirname(candidateRuntime)]]) {
      mkdirSync(into, { recursive: true });
      cpSync(archive, join(into, "runtime.tar.gz"));
      if (!run(`unpack ${archive}`, "tar", ["-xzf", "runtime.tar.gz"], {}, into).ok) return report(failures);
    }
  } else {
    // 1. The previous release, installed the way its README says.
    const installer = join(root, WINDOWS ? "install.ps1" : "install.sh");
    const fetched = spawnSync("curl", ["-fsSL", "-o", installer,
      `https://github.com/${REPOSITORY}/releases/download/v${previous}/${WINDOWS ? "install.ps1" : "install.sh"}`],
    { encoding: "utf-8", timeout: STEP_TIMEOUT_MS });
    if (fetched.status !== 0) {
      console.error(`Could not download the ${previous} installer: ${fetched.stderr}`);
      return 1;
    }
    const installed = WINDOWS
      ? run(`install ${previous}`, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer, "-Version", previous])
      : run(`install ${previous}`, "sh", [installer, "--version", previous]);
    if (!installed.ok) return report(failures);
    const before = aidlc("version before the update", ["version"]);
    if (!before.output.includes(previous)) fail(`the installed release reports "${before.output}", not ${previous}`);
  }

  // 2. A project for every harness, the person's own code committed, set up by the previous release.
  const projects = HARNESSES.map((harness) => {
    const project = join(root, `project-${harness}`);
    mkdirSync(project, { recursive: true });
    spawnSync("git", ["init", "--quiet", project], { encoding: "utf-8", timeout: STEP_TIMEOUT_MS });
    cpSync(PERSON_PROJECT, project, { recursive: true });
    for (const [name, text] of Object.entries(PERSON_FILES)) writeFileSync(join(project, name), text);
    for (const args of [["add", "-A"], ["commit", "--quiet", "-m", "The person's project"]]) {
      run(`git ${args[0]} in the ${harness} project`, "git", args, PERSON_GIT, project);
    }
    if (harness === "copilot") writeFileSync(join(env.COPILOT_HOME!, "config.json"), `${JSON.stringify({ trustedFolders: [project] })}\n`);
    if (copy) {
      cpSync(join(previousRuntime, harness), project, { recursive: true });
      tool(`the copy's setup for ${harness} on ${previous}`, harness, project, ["config", "--from", previousRuntime, "--harness", harness]);
    } else {
      aidlc(`aidlc config --harness ${harness} on ${previous}`, ["config", "--project-dir", project, "--harness", harness, "--mcp", "none", "--quiet"]);
    }
    return { harness, project };
  });
  if (failures.length > 0) return report(failures);

  // 3. In every project the person's work waits at a gate, left there on the
  // previous release. The projects' work runs side by side; each waits for
  // the update, then carries on (tests/harness/work-open.ts).
  const signals = join(root, "work");
  mkdirSync(signals, { recursive: true });
  const began = Date.now();
  const works = projects.map(({ harness, project }) => ({
    harness,
    proc: Bun.spawn([process.execPath, WORK_OPEN, harness, project, copy ? "copy" : machine, signals, String(deadline)], {
      cwd: project,
      env,
      stdout: Bun.file(join(signals, `${harness}.log`)),
      stderr: Bun.file(join(signals, `${harness}.err.log`)),
    }),
  }));
  // A check that ends early ends the projects' runs first, so its folders can go.
  const stopWorks = async () => {
    for (const w of works) w.proc.kill();
    await Promise.all(works.map((w) => w.proc.exited));
  };
  process.once("exit", () => { for (const w of works) w.proc.kill(); });
  const result = (harness: string): WorkResult | null => {
    const file = join(signals, `${harness}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) as WorkResult : null;
  };
  const parked = (harness: string) => existsSync(join(signals, `${harness}.parked`));
  while (Date.now() < deadline && works.some((w) => !parked(w.harness) && result(w.harness) === null && w.proc.exitCode === null)) {
    await Bun.sleep(250);
  }
  const ended = (w: (typeof works)[number], when: string) => {
    const said = result(w.harness);
    if (said) {
      for (const problem of said.problems) {
        fail(said.stage === "open"
          ? `${w.harness}: the scripted person could not leave work open on ${previous}, so it is not checked: ${problem.split("\n")[0]}`
          : `${w.harness} work after the update: ${problem}`);
      }
    } else if (w.proc.exitCode === null) {
      fail(`${w.harness}: the check ran out of its ${CHECK_BUDGET_MS / 60_000}-minute budget ${when}`);
    } else {
      const err = existsSync(join(signals, `${w.harness}.err.log`)) ? readFileSync(join(signals, `${w.harness}.err.log`), "utf-8") : "";
      fail(`${w.harness}: the person's work stopped ${when} with no word (exit ${w.proc.exitCode}): ${err.trim().split("\n").slice(-3).join(" | ")}`);
    }
  };
  const waiting = works.filter((w) => parked(w.harness));
  for (const w of works.filter((w) => !parked(w.harness))) ended(w, "before the person's work was left open");
  console.log(`${waiting.length} of ${works.length} projects have the person's bugfix waiting at its open Requirements gate on ${previous} (${Math.round((Date.now() - began) / 1000)} s)`);

  // 4. The person's update, run by the previous release's own binary. A copy
  // has no machine install: each project refreshes itself below.
  if (!copy) {
    const updated = aidlc(`aidlc update from ${previous}`, ["update", "--from", candidate, "--offline"]);
    if (!updated.ok) {
      await stopWorks();
      return report(failures);
    }
    const after = aidlc("version after the update", ["version"]);
    if (!after.output.includes(target)) fail(`after the update aidlc reports "${after.output}", not ${target}`);
    if (WINDOWS && !existsSync(join(bin, "aidlc"))) {
      fail(`${join(bin, "aidlc")} is missing after the update and its first command, so Git Bash cannot run a bare aidlc and Claude Code's hooks fail`);
    }
  }

  // 5. What the person does next, per project.
  let traces = 0;
  const timedOut = new Set<string>();
  const hooks = (harness: string, project: string, when: string) => {
    const plugin = join(project, ".opencode", "plugin", "aidlc-opencode-adapter.ts");
    const commands = hookRuns(harness, project);
    if (commands.length === 0) fail(`${harness} ${when}: the project has no hook commands to run`);
    if (harness === "opencode") {
      const trace = join(root, "trace", String(++traces));
      const driven = run(`opencode plugin ${when}`, process.execPath, ["-e", OPENCODE_EVENTS], {
        AIDLC_CHECK_PLUGIN: pathToFileURL(plugin).href,
        AIDLC_CHECK_PROJECT: project,
        AIDLC_HOOK_TRACE_DIR: trace,
      }, project);
      const ran = hooksTracedToCompletion(trace);
      const missing = OPENCODE_EVENT_HOOKS.filter((hook) => !ran.has(hook));
      if (driven.ok && missing.length > 0) {
        fail(`opencode plugin ${when}: its events did not run ${missing.join(", ")} to the end`);
      }
    }
    for (const { command, traced } of commands) {
      if (Date.now() >= deadline) {
        fail(`${harness} hook ${when}: the check ran out of its ${CHECK_BUDGET_MS / 60_000}-minute budget before \`${command}\``);
        break;
      }
      // A hook that hung once is not run again; its first failure says so.
      if (timedOut.has(command)) continue;
      const trace = join(root, "trace", String(++traces));
      const r = spawnSync(shell, ["-c", command], {
        cwd: project,
        env: { ...env, CLAUDE_PROJECT_DIR: project, AIDLC_HOOK_TRACE_DIR: trace },
        encoding: "utf-8",
        input: hookInput(harness, command),
        timeout: within(HOOK_TIMEOUT_MS),
      });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        timedOut.add(command);
        fail(`${harness} hook ${when}: \`${command}\` did not finish within ${HOOK_TIMEOUT_MS / 60_000} minutes; it is not run again`);
        continue;
      }
      if (r.status !== 0 || (traced && !tracedToCompletion(trace))) {
        fail(`${harness} hook ${when}: \`${command}\` exited ${r.status}: ${`${r.stderr ?? ""}`.trim().split("\n").at(-1) ?? ""}`);
      }
    }
    return commands.length;
  };
  for (const { harness, project } of projects) {
    const known = failures.length;
    const count = hooks(harness, project, `before the refresh`);
    if (copy) {
      tool(`the copy's refresh for ${harness} from ${target}`, harness, project, ["config", "--from", candidateRuntime, "--harness", harness, "--yes"]);
      const now = tool(`the copy's version for ${harness}`, harness, project, ["version"]);
      if (now.ok && !now.output.includes(target)) fail(`after the refresh the ${harness} copy reports "${now.output}", not ${target}`);
    } else {
      aidlc(`aidlc config --yes for ${harness}`, ["config", "--project-dir", project, "--harness", harness, "--mcp", "none", "--yes", "--quiet"]);
    }
    hooks(harness, project, "after the refresh");
    if (copy) tool(`the copy's doctor for ${harness}`, harness, project, ["doctor", "--quiet"]);
    else aidlc(`aidlc doctor for ${harness}`, ["doctor", "--project-dir", project, "--quiet"]);
    const result = failures.length === known ? "all passed" : `${failures.length - known} failed`;
    console.log(`${harness}: ${count} hook command(s) before and after the refresh, the refresh, and doctor: ${result}`);
  }

  // 6. A new chat in every project: the person picks their work up and approves.
  const resumed = Date.now();
  writeFileSync(join(signals, "updated"), "");
  const stopped = await Promise.race([
    Promise.all(waiting.map((w) => w.proc.exited)).then(() => false),
    Bun.sleep(Math.max(1_000, deadline - Date.now())).then(() => true),
  ]);
  for (const w of waiting) ended(w, "while the person carried on their work");
  await stopWorks();
  if (!stopped) console.log(`The person carried on their work in ${waiting.length} project(s) (${Math.round((Date.now() - resumed) / 1000)} s)`);
  return report(failures, `${copy ? "Refreshed every copy" : "Updated"} from ${previous} to ${target}; every harness's hooks, refresh and doctor work, and so does the work each person left open.`);
}

function report(failures: string[], success = ""): number {
  if (failures.length === 0) {
    console.log(success);
    return 0;
  }
  console.error(`${failures.length} failure(s), each printed above as it happened.`);
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

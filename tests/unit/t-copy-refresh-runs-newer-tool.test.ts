// covers: tool:aidlc-init
//
// A copied project refreshes with its own tool. When the release it refreshes
// from is newer than that tool, the newer release's own config does the run:
// an older tool may not read a newer release's files (a Codex copy set up on
// 2.11.0 and refreshed by its own tool from a later runtime got a false
// ".codex/config.toml (locally modified or unowned)" conflict, because its
// merge could not retire the inline table that release dropped). The same
// command, the same project and the person's lines carry over; a same-version
// or older release is still refreshed by the project's own tool.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { type ReleaseServerFault, serveReleaseFixture, writeReleaseFixture } from "../harness/release-fixture.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const DIST = join(REPO_ROOT, "dist");
const FAKE_GH = join(REPO_ROOT, "tests", "fixtures", "bin", process.platform === "win32" ? "gh.cmd" : "gh");
const NEWER = "2.99.0";
const OLDER = "2.10.0";
const MARK = "T_COPY_NEWER_TOOL_RAN";
// The member 2.11.0 shipped in .codex/config.toml, and the one later releases
// ship empty, since 2.11.0's own refresh cannot take it out.
const POINTER = 'set = { AIDLC_RULES_DIR = "aidlc/spaces/default/memory" }';
const EMPTY_POINTER = 'set = { AIDLC_RULES_DIR = "" }';

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

const machine = temp("aidlc-t-copy-newer-machine-");
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const name of Object.keys(base)) {
    if (/^(AIDLC_|CLAUDE_|KIRO_|CODEX_)/.test(name) || name === MARK) delete base[name];
  }
  return {
    ...base,
    AIDLC_INSTALL_ROOT: join(machine, "share"),
    AIDLC_BIN_DIR: join(machine, "bin"),
    CODEX_HOME: join(machine, "codex-home"),
    ...extra,
  };
}

// The Codex projection as a release at `version` ships it: its stamp and its
// tool's own version say `version` (`stampOnly` leaves the tool's, as test
// fixtures do). `pointer` puts 2.11.0's block back; `mark` makes its dispatcher
// write its own path to $T_COPY_NEWER_TOOL_RAN.
function codexRelease(
  root: string,
  version: string,
  options: { pointer?: boolean; mark?: boolean; stampOnly?: boolean; harness?: "codex" | "claude" } = {},
): string {
  const harness = options.harness ?? "codex";
  const dir = `.${harness}`;
  cpSync(join(DIST, harness), root, { recursive: true });
  const stamp = join(root, dir, "tools", "data", "aidlc-stamp.json");
  writeFileSync(stamp, `${JSON.stringify({ ...JSON.parse(readFileSync(stamp, "utf-8")), frameworkVersion: version }, null, 2)}\n`);
  const own = join(root, dir, "tools", "aidlc-version.ts");
  if (!options.stampOnly) writeFileSync(own, readFileSync(own, "utf-8").replace(`"${AIDLC_VERSION}"`, `"${version}"`));
  if (options.pointer) {
    const config = join(root, ".codex", "config.toml");
    writeFileSync(config, readFileSync(config, "utf-8").replace(EMPTY_POINTER, POINTER));
  }
  if (options.mark) {
    const tool = join(root, dir, "tools", "aidlc.ts");
    const [shebang, ...rest] = readFileSync(tool, "utf-8").split("\n");
    writeFileSync(tool, [
      shebang,
      `import { appendFileSync as markRun } from "node:fs";`,
      `if (process.env.${MARK}) markRun(process.env.${MARK}, import.meta.path + "\\n");`,
      ...rest,
    ].join("\n"));
  }
  return root;
}

// The copy runtime's layout: one projection per harness under runtime/.
function runtimeAt(version: string, options: { mark?: boolean; stampOnly?: boolean; harness?: "codex" | "claude" } = {}): string {
  const root = temp("aidlc-t-copy-newer-runtime-");
  mkdirSync(join(root, "runtime"));
  codexRelease(join(root, "runtime", options.harness ?? "codex"), version, options);
  return join(root, "runtime");
}

function own(project: string, args: string[], extra: Record<string, string> = {}): { status: number; out: string } {
  const result = spawnSync(BUN, [join(project, ".codex", "tools", "aidlc.ts"), ...args], {
    cwd: project,
    env: env(extra),
    encoding: "utf-8",
    input: "",
    timeout: 240_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A server in this process cannot answer a child that blocks it, so the
// download runs spawn asynchronously.
async function ownAsync(
  project: string,
  args: string[],
  extra: Record<string, string>,
  input?: string,
  cwd = project,
): Promise<{ status: number; out: string }> {
  const child = Bun.spawn([BUN, join(project, ".codex", "tools", "aidlc.ts"), ...args], {
    cwd,
    env: env({ AIDLC_GH_BIN: FAKE_GH, ...extra }),
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, out: `${stdout}${stderr}` };
}

// A served release whose copy runtime is the marked newer projection.
function servedRelease(fault?: ReleaseServerFault): { baseUrl: string; requests: string[]; stop(): void } {
  const repo = temp("aidlc-t-copy-newer-repo-");
  codexRelease(join(repo, "dist", "codex"), NEWER, { mark: true });
  cpSync(join(REPO_ROOT, "dist-release", "codex"), join(repo, "dist-release", "codex"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  for (const name of ["install.sh", "install.ps1"]) cpSync(join(REPO_ROOT, "scripts", name), join(repo, "scripts", name));
  const root = temp("aidlc-t-copy-newer-release-");
  writeReleaseFixture({ root, repoRoot: repo, version: NEWER, distributions: ["codex"] });
  return serveReleaseFixture(root, fault);
}

// A Codex project copied from 2.11.0 and set up by its own tool, with the
// person's own lines in config.toml: a member of AI-DLC's `set` table and a
// key of their own under its header.
function copiedAt2110(): string {
  const prior = codexRelease(join(temp("aidlc-t-copy-newer-prior-"), "codex"), AIDLC_VERSION, { pointer: true });
  const project = temp("aidlc-t-copy-newer-project-");
  mkdirSync(join(project, ".git"));
  cpSync(prior, project, { recursive: true });
  const setup = own(project, ["config", "--from", prior, "--harness", "codex", "--mcp", "none", "--yes"]);
  expect(setup.status, setup.out).toBe(0);
  const config = join(project, ".codex", "config.toml");
  const shipped = readFileSync(config, "utf-8");
  expect(shipped).toContain(`[shell_environment_policy]\n${POINTER}`);
  writeFileSync(config, shipped.replace(
    `[shell_environment_policy]\n${POINTER}`,
    '[shell_environment_policy]\ninherit = "core"\nset = { AIDLC_RULES_DIR = "aidlc/spaces/default/memory", MY_VAR = "mine" }',
  ));
  return project;
}

const ranLine = (version: string) =>
  `  Note: ${version}'s own config runs this refresh; the tool you ran is ${AIDLC_VERSION}.`;

describe("a copied project's refresh from a newer release runs that release's own config", () => {
  for (const endings of ["LF", "CRLF"] as const) {
    test(`--from a newer runtime: its tool runs, no conflict, the person's lines kept (${endings})`, () => {
      const project = copiedAt2110();
      const config = join(project, ".codex", "config.toml");
      if (endings === "CRLF") writeFileSync(config, readFileSync(config, "utf-8").replace(/\r?\n/g, "\r\n"));
      const runtime = runtimeAt(NEWER, { mark: true });
      const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");

      const result = own(project, ["config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes"], { [MARK]: mark });

      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain(ranLine(NEWER));
      expect(result.out).not.toContain("conflict");
      expect(existsSync(mark), result.out).toBe(true);
      const ran = readFileSync(mark, "utf-8").split("\n")[0];
      expect(ran).toContain(basename(dirname(runtime)));
      expect(ran.endsWith(join("codex", ".codex", "tools", "aidlc.ts"))).toBe(true);
      const after = readFileSync(config, "utf-8");
      expect(after).toContain('inherit = "core"');
      expect(after).toContain('set = { AIDLC_RULES_DIR = "", MY_VAR = "mine" }');
      if (endings === "CRLF") expect(after.replace(/\r\n/g, "")).not.toContain("\n");
      expect(JSON.parse(readFileSync(join(project, ".codex", "tools", "data", "aidlc-stamp.json"), "utf-8")).frameworkVersion)
        .toBe(NEWER);
    });
  }

  test("a same-version or older runtime is refreshed by the project's own tool, as before", () => {
    for (const version of [AIDLC_VERSION, OLDER]) {
      const project = copiedAt2110();
      const runtime = runtimeAt(version, { mark: true });
      const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
      const result = own(project, ["config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes"], { [MARK]: mark });
      expect(result.status, `${version}: ${result.out}`).toBe(0);
      expect(result.out).not.toContain("own config runs this refresh");
      expect(existsSync(mark), `${version}: ${result.out}`).toBe(false);
    }
  });

  test("the newer release's tool never hands the run on, even when its own code is older than its stamp", () => {
    const project = copiedAt2110();
    const runtime = runtimeAt(NEWER, { mark: true, stampOnly: true });
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    const result = own(project, ["config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes"], { [MARK]: mark });
    // Handing on again would loop until the timeout above; one Note is one hand-off.
    expect(result.status, result.out).toBe(0);
    expect(existsSync(mark), result.out).toBe(true);
    expect(result.out.split("own config runs this refresh")).toHaveLength(2);
  });

  test("a pinned project's refresh from other files is refused by its own tool alone, as before", () => {
    const project = copiedAt2110();
    writeFileSync(join(project, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    const runtime = runtimeAt(NEWER, { mark: true });
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    const result = own(project, ["config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes"], { [MARK]: mark });
    expect(result.status, result.out).toBe(4);
    expect(result.out).toContain(`error: the files passed to --from are ${NEWER}, but this project is pinned to ${AIDLC_VERSION}`);
    expect(result.out).not.toContain("own config runs this refresh");
    expect(existsSync(mark), result.out).toBe(false);
  });

  // Windows keeps the working folder of a running process, so it cannot be
  // taken away mid-run there.
  test.skipIf(process.platform === "win32")("a hand-off that cannot start says why", async () => {
    const project = copiedAt2110();
    writeFileSync(join(project, ".aidlc-version"), `${NEWER}\n`);
    const elsewhere = temp("aidlc-t-copy-newer-cwd-");
    const asset = `aidlc-copy-runtime-${NEWER}.tar.gz`;
    // The download waits, so the working folder can go before the newer tool starts.
    const release = servedRelease({ kind: "delay", asset, milliseconds: 3000 });
    try {
      const run = ownAsync(
        project,
        ["config", "--download", "--harness", "codex", "--mcp", "none", "--yes", "--project-dir", project],
        { AIDLC_RELEASE_BASE_URL: release.baseUrl },
        undefined,
        elsewhere,
      );
      const deadline = Date.now() + 120_000;
      while (!release.requests.some((path) => path.endsWith(asset)) && Date.now() < deadline) await Bun.sleep(20);
      rmSync(elsewhere, { recursive: true, force: true });
      const { status, out } = await run;
      expect(status, out).not.toBe(0);
      expect(out).toContain("error: ENOENT");
    } finally {
      release.stop();
    }
  });

  test("the newer tool's commands name the project's own tool, not where the runtime was unpacked", () => {
    const project = copiedAt2110();
    // A change of the person's own to a file AI-DLC ships: a real conflict.
    const agent = join(project, ".codex", "agents", "aidlc-developer-agent.toml");
    writeFileSync(agent, `${readFileSync(agent, "utf-8")}\n# mine\n`);
    const runtime = runtimeAt(NEWER, { mark: true });
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    const result = own(project, ["config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes"], { [MARK]: mark });
    expect(result.status, result.out).toBe(4);
    expect(existsSync(mark), result.out).toBe(true);
    expect(result.out).toContain(".codex/agents/aidlc-developer-agent.toml");
    const commands = result.out.split(/\r?\n/).filter((line) => line.includes("aidlc.ts config"));
    expect(commands.length, result.out).toBeGreaterThan(0);
    for (const line of commands) {
      expect(line).toContain("bun .codex/tools/aidlc.ts config");
      expect(line).not.toContain(basename(dirname(runtime)));
    }
  });

  test("adding another harness: a question left open names the tool the person ran, not the one not yet added", () => {
    const project = copiedAt2110();
    const runtime = runtimeAt(NEWER, { harness: "claude" });
    // At a terminal, Claude Code's MCP question finds the input closed.
    const result = own(project, ["config", "--from", runtime, "--harness", "claude"], { AIDLC_TEST_CONFIG_TTY: "1" });
    expect(result.out).toContain(ranLine(NEWER));
    expect(existsSync(join(project, ".claude")), result.out).toBe(false);
    expect(result.out).toContain("Run bun .codex/tools/aidlc.ts config --from");
    expect(result.out).not.toContain(".claude/tools/aidlc.ts");
  });

  test("--json prints the newer tool's one result and nothing else", () => {
    const project = copiedAt2110();
    const runtime = runtimeAt(NEWER, { mark: true });
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    const result = spawnSync(BUN, [join(project, ".codex", "tools", "aidlc.ts"), "config", "--from", runtime, "--harness", "codex", "--mcp", "none", "--yes", "--json"], {
      cwd: project,
      env: env({ [MARK]: mark }),
      encoding: "utf-8",
      input: "",
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(existsSync(mark)).toBe(true);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  test("--download of a newer pinned release runs that release's own config", async () => {
    const project = copiedAt2110();
    writeFileSync(join(project, ".aidlc-version"), `${NEWER}\n`);
    const release = servedRelease();
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    try {
      const { status, out } = await ownAsync(project, ["config", "--download", "--harness", "codex", "--mcp", "none", "--yes"], {
        AIDLC_RELEASE_BASE_URL: release.baseUrl,
        [MARK]: mark,
      });
      expect(status, out).toBe(0);
      expect(out).toContain(ranLine(NEWER));
      expect(existsSync(mark), out).toBe(true);
      expect(out).not.toContain("conflict");
      expect(readFileSync(join(project, ".codex", "config.toml"), "utf-8")).toContain('set = { AIDLC_RULES_DIR = "", MY_VAR = "mine" }');
      expect(JSON.parse(readFileSync(join(project, ".codex", "tools", "data", "aidlc-stamp.json"), "utf-8")).frameworkVersion)
        .toBe(NEWER);
    } finally {
      release.stop();
    }
  });

  test("at a terminal, what the person answered before the hand-off is never asked again", async () => {
    const project = copiedAt2110();
    // Outside a recognized project config first asks whether to set it up here.
    rmSync(join(project, ".git"), { recursive: true, force: true });
    writeFileSync(join(project, ".aidlc-version"), `${NEWER}\n`);
    const release = servedRelease();
    const mark = join(temp("aidlc-t-copy-newer-mark-"), "ran");
    try {
      // Set it up here: yes; download: Enter. The test terminal takes every
      // answer at the first question, so the newer tool's own setup map after
      // the refresh finds the input closed and stops there.
      const { status, out } = await ownAsync(project, ["config", "--harness", "codex", "--mcp", "none"], {
        AIDLC_RELEASE_BASE_URL: release.baseUrl,
        AIDLC_TEST_CONFIG_TTY: "1",
        [MARK]: mark,
      }, "y\n\n");
      expect(existsSync(mark), out).toBe(true);
      expect(out.split("Initialize AI-DLC in "), out).toHaveLength(2);
      expect(out.split(`Download ${NEWER} from `), out).toHaveLength(2);
      expect(out).toContain(ranLine(NEWER));
      expect(JSON.parse(readFileSync(join(project, ".codex", "tools", "data", "aidlc-stamp.json"), "utf-8")).frameworkVersion)
        .toBe(NEWER);
      expect(out).toContain("Run bun .codex/tools/aidlc.ts config again where you can answer.");
      expect(status, out).toBe(2);
    } finally {
      release.stop();
    }
  });
});

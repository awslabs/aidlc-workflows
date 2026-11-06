// covers: tool:aidlc-init, function:typedHarnessName, function:harnessIdFromTyped, function:harnessArgsAsIds, function:harnessNameFor
//
// What a person types after --harness for the two Kiro harnesses: `kiro` is
// Kiro (Kiro IDE and Kiro CLI v3, the `kiro-ide` tree) and `kiro-v2` is Kiro
// CLI (V2) (the `kiro` tree). Installed projects keep the ids they record, so
// a refresh keeps whichever tree a project has; `--harness kiro` on a Kiro CLI
// (V2) project is the in-place switch to Kiro, asked first at a terminal
// (unless a dry run's --plan-token already approves its plan), refused with
// no terminal and no --yes, and said once with --yes, in --quiet and in the
// --json result too. A copied tool's hand-off carries ids, read as ids by
// every release; from a tool before these names, `--harness kiro` on a Kiro
// project is the switch to Kiro CLI (V2), asked and stopped the same way.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessArgsAsIds, harnessIdFromTyped, harnessNameFor, typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
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

function config(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number; out: string; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    INIT, "config", "--project-dir", dir, "--from", RELEASE, "--mcp", "none", ...args,
  ], {
    cwd: dir,
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
    // The person's Kiro home and Kiro CLI settings are never read or written.
    env: { ...process.env, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home`, ...env },
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

    const declined = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
    expect(declined.out).toContain(
      "This project is set up for Kiro CLI (V2). `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3). Switch .kiro to Kiro in place? [y/N]:",
    );
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(declined.out).toContain("config --harness kiro-v2");
    expect(declined.status).toBe(2);
    expect(stamp(dir)).toBe("kiro");

    // A second answer for setup's own check, which asks only where the hook PATH lacks aidlc (as on CI).
    const switched = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\nn\n" });
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
    const quiet = config(dir, ["--harness", "kiro", "--quiet"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\n" });
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
    const declined = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
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
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).not.toContain("[y/N]");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("a --plan-token from another plan at a terminal leaves Kiro CLI (V2) in place", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const refresh = config(dir, ["--harness", "kiro-v2", "--dry-run", "--json"]);
    const token = (JSON.parse(refresh.stdout) as { data: { planToken: string } }).data.planToken;
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "" });
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
    const handed = config(dir, ["--harness", "kiro-ide", "--yes"], { AIDLC_CONFIG_HANDOFF: tool, NO_COLOR: "1" });
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
    const handed = config(dir, ["--harness", "kiro", "--yes"], { AIDLC_CONFIG_HANDOFF: tool });
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
    const plain = config(dir, ["--harness", "kiro"], handed);
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
    const quiet = config(dir, ["--harness", "kiro", "--quiet"], handed);
    expect(quiet.status, quiet.out).toBe(2);
    expect(quiet.out).toMatch(/^Warning: nothing changed; \.kiro stays on Kiro\.[^\n]*--harness kiro [^`\n]*--yes`/);
    const json = config(dir, ["--harness", "kiro", "--json"], handed);
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
    const declined = config(dir, ["--harness", "kiro"], { ...handed, AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
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

    const switched = config(dir, ["--harness", "kiro", "--yes"], handed);
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
    const handed = config(dir, ["--harness", "kiro"], { AIDLC_CONFIG_HANDOFF: join(dir, ".kiro", "tools", "aidlc.ts") });
    expect(handed.status, handed.out).toBe(0);
    expect(handed.out).not.toContain("the tool you ran is from an older release");
    expect(stamp(dir)).toBe("kiro");
  });

  test("a copied tool's hand-off is read in ids: --harness kiro there is Kiro CLI (V2)", () => {
    const dir = project();
    const handed = config(dir, ["--harness", "kiro", "--yes"], { AIDLC_CONFIG_HANDOFF: join(dir, ".kiro", "tools", "aidlc.ts") });
    expect(handed.status, handed.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");
  });
});

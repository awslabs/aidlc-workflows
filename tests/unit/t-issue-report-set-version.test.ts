// set-version.ts writes a version the person read off their screen straight into safe.json, after shaping
// and redaction have run, so it takes only what collect.ts's own version rule keeps.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SET = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/set-version.ts");

function folder(): string {
  const out = mkdtempSync(join(tmpdir(), "set-version-"));
  mkdirSync(join(out, "local"));
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [] }));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {}, versionsMissing: ["kiro-cli"] } }));
  return out;
}
// The version goes in local/version-<tool>.json, as the agent writes it with its file tool; none means "not known".
const answerFile = (out: string, tool = "kiro-cli") => join(out, "local", `version-${tool}.json`);
function answer(out: string, version: string, tool = "kiro-cli") {
  mkdirSync(join(out, "local"), { recursive: true });
  writeFileSync(answerFile(out, tool), JSON.stringify({ version }));
}
const run = (out: string, version?: string, tool = "kiro-cli") => {
  if (version !== undefined) answer(out, version, tool);
  return spawnSync(process.execPath, [SET, "--out", out, "--tool", tool], { encoding: "utf8" });
};

test("a tool the person names without its version is recorded, its version unknown, and keeps a version given before", () => {
  const out = folder();
  expect(run(out).status).toBe(0);
  const env = JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment;
  expect({ tool: env.tools["kiro-cli"], used: env.toolsUsed, named: env.toolsNamed, missing: env.versionsMissing }).toEqual({
    tool: { version: null, source: "person" },
    used: ["kiro-cli"],
    named: ["kiro-cli"],
    missing: [],
  });
  expect(run(out, "2.33.1").status).toBe(0);
  expect(run(out).status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools["kiro-cli"]).toEqual({ version: "2.33.1", source: "person" });
});

test("a release, preview or pre-release number is written", () => {
  for (const [given, kept] of [["v2.33.1", "2.33.1"], ["2.33.1-preview.20261029.1", "2.33.1-preview.20261029.1"], ["3.0.0-rc.2", "3.0.0-rc.2"], ["1.4.13.2", "1.4.13"]]) {
    const out = folder();
    expect(run(out, given).status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools["kiro-cli"]).toEqual({ version: kept, source: "person" });
  }
});

test("a number with anything else after it is refused and nothing is written", () => {
  for (const given of ["2.33.1-Contoso", "2.33.1+PrivateBuild", "2.33.1 contoso"]) {
    const out = folder();
    expect(run(out, given).status).toBe(1);
    expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools).toEqual({});
  }
});

test("a folder collect.ts did not make is refused", () => {
  const out = mkdtempSync(join(tmpdir(), "set-version-"));
  const r = run(out, "2.33.1");
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout).ok).toBe(false);
});

test("a tool the person names when no log was found becomes a tool the run used, once; with a log read, it does not", () => {
  const read = folder();
  const safe = JSON.parse(readFileSync(join(read, "safe.json"), "utf8"));
  writeFileSync(join(read, "safe.json"), JSON.stringify({ ...safe, transcripts: [{ tool: "codex" }], environment: { ...safe.environment, toolsUsed: ["codex"] } }));
  expect(run(read, "2.33.1").status).toBe(0);
  expect(JSON.parse(readFileSync(join(read, "safe.json"), "utf8")).environment.toolsUsed).toEqual(["codex"]);
  const out = folder();
  expect(run(out, "2.33.1").status).toBe(0);
  expect(run(out, "2.33.2").status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.toolsUsed).toEqual(["kiro-cli"]);
});

test("a tool found in a log keeps the person from adding another as used", () => {
  const out = folder();
  const safe = JSON.parse(readFileSync(join(out, "safe.json"), "utf8"));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ ...safe, environment: { ...safe.environment, toolsUsed: ["kiro-cli"] } }));
  expect(run(out, "2.33.1").status).toBe(0);
  expect(run(out, "0.166.0", "codex").status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.toolsUsed).toEqual(["kiro-cli"]);
});

test("the version is read from the answer file, which is gone once applied; an answer that is not a version is refused and removed", () => {
  const out = folder();
  expect(run(out, "2.37.0").status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools["kiro-cli"]).toEqual({ version: "2.37.0", source: "person" });
  expect(existsSync(answerFile(out))).toBe(false);
  const refused = run(out, "2.37.0 & echo x");
  expect([refused.status, JSON.parse(refused.stdout).reason, existsSync(answerFile(out))]).toEqual([1, "not-a-version", false]);
});

test("a version answer is named for its tool: another tool's call never takes it, and it waits until applied", () => {
  const out = folder();
  answer(out, "1.4.13", "kiro-ide");
  expect(run(out, undefined, "claude").status).toBe(0);
  const tools = () => JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools;
  expect(tools().claude).toEqual({ version: null, source: "person" });
  expect(existsSync(answerFile(out, "kiro-ide"))).toBe(true);
  expect(spawnSync(process.execPath, [SET, "--out", out, "--tool", "kiro-ide"], { encoding: "utf8" }).status).toBe(0);
  expect([tools()["kiro-ide"], existsSync(answerFile(out, "kiro-ide"))]).toEqual([{ version: "1.4.13", source: "person" }, false]);
});

test("an answer with no version, an empty one or null records the tool with its version unknown; a byte-order mark is read", () => {
  for (const body of ["{}", '{ "version": "" }', '{ "version": null }']) {
    const out = folder();
    writeFileSync(answerFile(out), body);
    expect(spawnSync(process.execPath, [SET, "--out", out, "--tool", "kiro-cli"], { encoding: "utf8" }).status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools["kiro-cli"]).toEqual({ version: null, source: "person" });
  }
  const out = folder();
  writeFileSync(answerFile(out), '\uFEFF{ "version": "2.37.0" }');
  expect(spawnSync(process.execPath, [SET, "--out", out, "--tool", "kiro-cli"], { encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools["kiro-cli"].version).toBe("2.37.0");
});

test("an answer file in another shape is refused and kept to correct, never read as a version not known", () => {
  for (const body of ['"2.37.0"', '[{ "version": "2.37.0" }]', '{ "Version": "2.37.0" }', '{ "version": 1.10 }', "{ version: 2 }"]) {
    const out = folder();
    writeFileSync(answerFile(out), body);
    const r = spawnSync(process.execPath, [SET, "--out", out, "--tool", "kiro-cli"], { encoding: "utf8" });
    expect([body, r.status, JSON.parse(r.stdout).reason, existsSync(answerFile(out))]).toEqual([body, 1, 'local/version-kiro-cli.json is not { "version": "<what the person read>" }', true]);
    expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.tools).toEqual({});
  }
});

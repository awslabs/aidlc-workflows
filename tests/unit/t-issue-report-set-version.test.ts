// set-version.ts writes a version the person read off their screen straight into safe.json, after shaping
// and redaction have run, so it takes only what collect.ts's own version rule keeps.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const run = (out: string, version: string) => spawnSync(process.execPath, [SET, "--out", out, "--tool", "kiro-cli", "--version", version], { encoding: "utf8" });

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
  expect(spawnSync(process.execPath, [SET, "--out", out, "--tool", "codex", "--version", "0.166.0"], { encoding: "utf8" }).status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).environment.toolsUsed).toEqual(["kiro-cli"]);
});

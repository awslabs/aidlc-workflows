// finish.ts deletes the report's local-only layer. It must never delete a
// `local/` folder that is not the report's: not without --out, and not in a
// folder that collect.ts did not make; and not before the check passes, which
// needs the report written.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FINISH = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/finish.ts");
// The AI-DLC secret rules collect.ts would have found in the project's install.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
const map = (value: string) => JSON.stringify({ entries: [{ value, label: "<customer-1>", kind: "named" }], secretRulesFrom: RULES });

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [FINISH, ...args, "--no-open"], { cwd, encoding: "utf8" });
}

function folderWithLocal(): string {
  const dir = mkdtempSync(join(tmpdir(), "finish-test-"));
  mkdirSync(join(dir, "local"));
  writeFileSync(join(dir, "local", "keep.txt"), "the person's own file");
  return dir;
}

describe("finish.ts", () => {
  test("without --out it refuses and deletes nothing", () => {
    const dir = folderWithLocal();
    const r = run(dir, []);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, "local", "keep.txt"))).toBe(true);
  });

  test("an --out folder that is not a report folder is left alone", () => {
    const dir = folderWithLocal();
    writeFileSync(join(dir, "safe.json"), "{}"); // a safe.json alone is not enough
    const r = run(dir, ["--out", dir]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, "local", "keep.txt"))).toBe(true);
  });

  test("a report folder that passes the check loses its local layer and keeps the rest", () => {
    const dir = folderWithLocal();
    writeFileSync(join(dir, "safe.json"), "{}");
    writeFileSync(join(dir, "aidlc-issue-report.md"), "A run for <customer-1>.\n");
    writeFileSync(join(dir, "local", "redaction-map.json"), map("Contoso"));
    const r = run(dir, ["--out", dir]);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "local"))).toBe(false);
    expect(existsSync(join(dir, "safe.json"))).toBe(true);
  });

  test("a folder with no report yet keeps its local layer", () => {
    const dir = folderWithLocal();
    writeFileSync(join(dir, "safe.json"), "{}");
    writeFileSync(join(dir, "local", "redaction-map.json"), map("Contoso"));
    const r = run(dir, ["--out", dir]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).check.missing).toBe("aidlc-issue-report.md is not written yet");
    expect(existsSync(join(dir, "local", "redaction-map.json"))).toBe(true);
  });

  test("a report folder that fails the check keeps its local layer, so the check can run again", () => {
    const dir = folderWithLocal();
    writeFileSync(join(dir, "safe.json"), "{}");
    writeFileSync(join(dir, "aidlc-issue-report.md"), "A run for Contoso.\n");
    writeFileSync(join(dir, "local", "redaction-map.json"), map("Contoso"));
    const r = run(dir, ["--out", dir]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).check.hits).toEqual([{ file: "aidlc-issue-report.md", line: 1, reason: "a name in the redaction map (write <customer-1>)" }]);
    expect(existsSync(join(dir, "local", "redaction-map.json"))).toBe(true);
  });
});

test("a file the operating system wrote into the folder is not refused, and finish removes it", () => {
  const dir = folderWithLocal();
  writeFileSync(join(dir, "safe.json"), "{}");
  writeFileSync(join(dir, "aidlc-issue-report.md"), "A run for <customer-1>.\n");
  writeFileSync(join(dir, ".DS_Store"), "Bud1");
  writeFileSync(join(dir, "local", "redaction-map.json"), map("Contoso"));
  const r = run(dir, ["--out", dir]);
  expect(r.status).toBe(0);
  expect(existsSync(join(dir, ".DS_Store"))).toBe(false);
});

// buildDictionary(): a one-word value that is also an ordinary word (a git
// first name "Will", a project folder "requirements") would replace that word
// everywhere and wreck the report ("the agent <user> retry <project>-analysis").
// Such words are left out of the replacement list and listed as skipped, while
// the full name and the paths that hold them are still replaced.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDictionary, type Dictionary, redact } from "../../core/skills/aidlc-issue-report/scripts/redact.ts";
import { textHits } from "../../core/skills/aidlc-issue-report/scripts/lib-gate.ts";

// What the check (lib-gate.ts) refuses in a line of the report, with no AI-DLC words known.
const gate = (text: string, dict: Dictionary) => textHits({ words: new Set(), dict, allowed: [] }, text);

function project(folder: string, gitName: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "dict-test-")), folder);
  mkdirSync(p);
  execFileSync("git", ["init", "-q"], { cwd: p });
  execFileSync("git", ["config", "user.name", gitName], { cwd: p });
  return p;
}

test("ordinary words are not replaced; the full name and the path are", () => {
  const p = project("requirements", "Will Parker");
  const d = buildDictionary(p);
  const prose = "The agent will retry requirements-analysis.";
  expect(redact(prose, d)).toBe(prose);
  expect(gate(prose, d)).toEqual([]);
  expect(redact("Will Parker approved it.", d)).toBe("<user> approved it.");
  expect(redact("Parker approved it.", d)).toBe("<user> approved it.");
  expect(redact(`opened ${p}/src/index.ts`, d)).toBe("opened <project>/src/index.ts");
  expect((d.skipped ?? []).map((e) => e.value).sort()).toEqual(["Will", "requirements"]);
});

test("a distinctive project name is still replaced as a word", () => {
  const p = project("acmecorp-portal", "Jordan Quill");
  const d = buildDictionary(p);
  expect(redact("the acmecorp-portal build failed", d)).toBe("the <project> build failed");
  expect(d.skipped ?? []).toEqual([]);
});

test("an intent's dated folder and its bare slug share one label", () => {
  const p = project("shop", "Jordan Quill");
  const d = buildDictionary(p, { intents: ["261017-shop-checkout", "261020-table-order"] });
  expect(redact("261017-shop-checkout and shop-checkout and table-order", d)).toBe("<intent-1> and <intent-1> and <intent-2>");
});

test("an AI-DLC install outside the home folder is a path of its own", () => {
  const p = project("shop", "Jordan Quill");
  const d = buildDictionary(p, { paths: [{ value: "/mnt/acme-tools/aidlc", label: "<aidlc-install>" }] });
  expect(redact("installed in /mnt/acme-tools/aidlc/versions/2.11.2/aidlc", d)).toBe("installed in <aidlc-install>/versions/2.11.2/aidlc");
});

test("a Windows path is replaced as either separator writes it", () => {
  const d = buildDictionary(process.cwd(), { paths: [{ value: "D:\\work\\aidlc", label: "<aidlc-install>" }] });
  expect(redact("ran D:/work/aidlc/bin/aidlc.exe", d)).toBe("ran <aidlc-install>/bin/aidlc.exe");
  expect(redact("ran D:\\work\\aidlc\\bin", d)).toBe("ran <aidlc-install>\\bin");
});

test("a git remote's port is not taken for an owner", () => {
  const p = project("shop", "Jordan Quill");
  execFileSync("git", ["remote", "add", "origin", "ssh://git@git.fabrikam.example:2222/fabteam/shop-app.git"], { cwd: p });
  const values = buildDictionary(p).entries.map((e) => e.value);
  expect(values).not.toContain("2222");
  expect(values).toContain("fabteam");
  expect(values).toContain("shop-app");
});

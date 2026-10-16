// A file the agent writes for the engine to read, written the way Windows
// PowerShell 5.1 writes UTF-8 (`Set-Content -Encoding UTF8`, `Out-File`): with a
// byte order mark. A live Copilot run on Windows wrote a unit's
// source-manifest.json that way and `log review` refused it, "source-
// manifest.json is not valid JSON (JSON Parse error: Unrecognized token '﻿')"
// (#2452). It is the same file, so it is read as written; what is bound to
// its bytes (the manifest's raw-bytes hash) stays over the bytes on disk.
// covers: function:agentFileText
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANSWER_TEXT_DIR,
  agentFileText,
  readAnswerTextFile,
  readUnitSourceManifest,
  readVerificationCommandFile,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";

const BOM = "﻿";
const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function fixture(): { project: string; record: string } {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-mid-ideation.md");
  return { project, record: seededRecordDir(project) };
}

// What Windows PowerShell 5.1 writes for `Set-Content -Encoding UTF8`.
const ps51 = (text: string) => Buffer.from(`${BOM}${text.replace(/\n/g, "\r\n")}`, "utf-8");

describe("a file the agent wrote with a byte order mark is read as written", () => {
  test("agentFileText drops one leading BOM and nothing else", () => {
    expect(agentFileText(Buffer.from(`${BOM}{"a":1}`, "utf-8"))).toBe('{"a":1}');
    expect(agentFileText(Buffer.from('{"a":1}', "utf-8"))).toBe('{"a":1}');
    expect(agentFileText(Buffer.from(`${BOM}${BOM}x`, "utf-8"))).toBe(`${BOM}x`);
    expect(agentFileText(Buffer.from(`x${BOM}`, "utf-8"))).toBe(`x${BOM}`);
  });

  test("a unit's source manifest, its raw-bytes hash still over the bytes on disk", () => {
    const { project, record } = fixture();
    const dir = join(record, "construction", "alpha", "code-generation");
    mkdirSync(dir, { recursive: true });
    const bytes = ps51(`${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] }, null, 2)}\n`);
    writeFileSync(join(dir, "source-manifest.json"), bytes);
    const read = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(read.ok, read.ok ? "" : read.reason).toBe(true);
    const plain = Buffer.from(bytes.toString("utf-8").replace(/^﻿/, ""), "utf-8");
    writeFileSync(join(dir, "source-manifest.json"), plain);
    const unmarked = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(unmarked.ok).toBe(true);
    if (read.ok && unmarked.ok) {
      expect(read.rawBytesSha256).not.toBe(unmarked.rawBytesSha256);
    }
  });

  test("the verification command file", () => {
    const { project, record } = fixture();
    writeFileSync(join(record, "verification-command.txt"), ps51("bun test\n"));
    expect(readVerificationCommandFile(project, "verification-command.txt").command).toBe("bun test");
  });

  test("an answer text file", () => {
    const { project, record } = fixture();
    mkdirSync(join(record, ANSWER_TEXT_DIR), { recursive: true });
    writeFileSync(join(record, ANSWER_TEXT_DIR, "answer.txt"), ps51("Approve — with the note\n"));
    expect(readAnswerTextFile(project, `${ANSWER_TEXT_DIR}/answer.txt`)).toBe("Approve — with the note");
  });
});

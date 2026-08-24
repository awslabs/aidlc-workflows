// covers: subcommand:aidlc-log:review, audit:REVIEW_COMPLETED

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  boltSlugForUnit,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function runReview(proj: string, args: string[]) {
  const result = spawnSync(
    BUN,
    [LOG, "review", ...args, "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t323 review verdict closure", () => {
  test("an accepted request remains closable after its Unit leaves a resolvable DAG", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-construction.md");
    seedBoltDag(proj, ["alpha"]);
    appendAuditEntry(
      "BOLT_STARTED",
      {
        "Bolt names": "alpha",
        "Batch number": "1",
        "Walking skeleton": "false",
        "Bolt slug": boltSlugForUnit("alpha"),
      },
      proj,
    );

    const dir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "functional-design",
    );
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "entities.md",
      "rules.md",
      "functional-spec.md",
      "traceability.json",
    ]) {
      writeFileSync(join(dir, name), `# ${name}\n`);
    }
    const primary = join(dir, "functional-spec.md");

    const args = [
      "--stage",
      "functional-design",
      "--reviewer",
      "aidlc-architecture-reviewer-agent",
      "--unit",
      "alpha",
      "--iteration",
      "1",
    ];
    expect(runReview(proj, args).status).toBe(0);

    seedBoltDag(proj, ["beta"]);

    writeFileSync(primary, "# functional-spec.md\n\n## Review\n\nREADY\n");
    const staleVerdict = runReview(proj, [...args, "--verdict", "READY"]);
    expect(staleVerdict.status).not.toBe(0);
    expect(staleVerdict.stderr).toContain(
      "output documents changed after review iteration 1 started",
    );

    const rebound = runReview(proj, [...args, "--retry-pending"]);
    expect(rebound.status).toBe(0);
    expect(rebound.stdout).toContain('"retry":"pending-request"');

    const completed = runReview(proj, [...args, "--verdict", "READY"]);
    expect(completed.status).toBe(0);
    expect(completed.stdout).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(readAllAuditShards(proj)).toMatch(
      /\*\*Event\*\*: REVIEW_COMPLETED[\s\S]*?\*\*Unit\*\*: alpha/,
    );
  });
});

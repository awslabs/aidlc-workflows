// covers: doc:aidlc-common/protocols/stage-protocol.md(section-13), file:aidlc-common/protocols/stage-protocol-learnings.md, function:appendAuditEntry

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededAuditDir, seedStateFile } from "../harness/fixtures.ts";

const BUN = process.execPath;
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const PROTOCOLS = join(AIDLC_SRC, "aidlc-common", "protocols");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("t86 conditional learnings module and audit event", () => {
  test("the base §13 is a loading stub and the module owns the ritual", () => {
    const base = read(join(PROTOCOLS, "stage-protocol.md"));
    const module = read(join(PROTOCOLS, "stage-protocol-learnings.md"));
    const section = base.split("## 13. Learnings Ritual\n")[1]?.split("\n---\n")[0];
    expect(section).toBeDefined();
    expect(section).toContain("`learnings` protocol module");
    expect(section).toContain("ceremony.learnings");
    expect(section).not.toContain("engine learnings surface");
    expect(section).not.toContain("engine learnings persist");
    expect(module).toMatch(/^# Learnings Protocol Module$/m);
    expect(module).toMatch(/^## 13\. Learnings Ritual$/m);
    expect(module).toContain("engine learnings surface --slug <stage-slug>");
    expect(module).toContain("engine learnings persist --slug <stage-slug>");
  });

  test("aidlc-audit CLI accepts MEMORY_EMPTY (registered in the live VALID_EVENT_TYPES Set) [.sh test 4 — data half, STRONGER]", () => {
    // VALID_EVENT_TYPES is a module-private const (aidlc-audit.ts:19), so we
    // exercise the real validity gate: an event NOT in the Set causes
    // appendAuditEntry to throw and the CLI to exit non-zero with an error JSON
    // (the t18 contract). MEMORY_EMPTY MUST be accepted — exit 0, appended:true.
    // createTestProject seeds the per-intent record + active-intent cursor;
    // seedStateFile writes the record's aidlc-state.md so the cursor RESOLVES
    // (the active-intent cursor only binds a record that has state). Then a bare
    // `aidlc-audit append` lands in <record>/audit/<host>-<clone>.md (P9 — no flat
    // aidlc-docs/audit.md). Read the appended event back off the shard dir.
    const proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    try {
      const ok = spawnSync(
        BUN,
        [AUDIT_TOOL, "append", "MEMORY_EMPTY", "--field", "Stage=intent-capture", "--project-dir", proj],
        { encoding: "utf-8" },
      );
      expect(ok.status).toBe(0);
      expect(`${ok.stdout ?? ""}`.includes('"appended":true')).toBe(true);
      const auditDir = seededAuditDir(proj);
      const body = readdirSync(auditDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => read(join(auditDir, f)))
        .join("\n");
      expect(body.includes("**Event**: MEMORY_EMPTY")).toBe(true);

      // Negative control: an unregistered event is REJECTED, proving the gate
      // is real and MEMORY_EMPTY's acceptance above is meaningful (not vacuous).
      const bad = spawnSync(
        BUN,
        [AUDIT_TOOL, "append", "MEMORY_NOT_A_REAL_EVENT", "--project-dir", proj],
        { encoding: "utf-8" },
      );
      expect(bad.status).not.toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });
});

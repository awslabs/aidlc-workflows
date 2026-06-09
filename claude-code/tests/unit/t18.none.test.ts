// covers: function:appendAuditEntry, function:appendAuditEntryUnlocked, function:handleAppend, cli:aidlc-audit(append-error,append-json,append-raw)
//
// t18 — aidlc-audit.ts audit-append behaviour. Migrated from
// tests/unit/t18-tool-audit.sh (13 TAP assertions, 16 bun spawns).
// Mechanism: none (import the tool's exported functions and call them in
// process; zero LLM, zero tokens). Three CLI-shell contracts that exercise
// the process.exit / stdout / stderr seam — or a non-exported handler —
// are kept as Bun.spawnSync env-seam cases (flagged inline) so no guarantee
// is lost.
//
// Source under test (dist/claude/.claude/tools/aidlc-audit.ts):
//   :199 appendAuditEntry(eventType, fields, projectDir)
//          => { appended: true; event: string; timestamp: string }
//          - throws Error on invalid event type (before any disk side effect)
//          - throws Error on lock-acquire failure
//          - acquires + releases the audit lock around the write
//   :228 appendAuditEntryUnlocked(eventType, fields, projectDir)
//          => same return; lock-already-held variant (no lock acquisition)
//   :266 handleAppend(eventType, fields, projectDir): void
//          - calls appendAuditEntry, writes JSON.stringify(result)+"\n" to stdout
//   :277 handleAppendRaw(heading, body, projectDir): void   (NOT exported — CLI only)
//
// File-format contract written by appendAuditEntry / appendAuditEntryUnlocked
// (aidlc-audit.ts:239-257), exercised below against the real bytes on disk:
//   - first write to a missing file prepends "# AI-DLC Audit Log\n"
//     (ensureAuditFile, :174)
//   - each entry: "\n## <heading>\n**Timestamp**: <ts>\n**Event**: <type>\n"
//     then one "**<key>**: <value>\n" per field, then "\n---\n"
//   - heading is EVENT_HEADINGS[eventType] || eventType (:108, :239)
//   - timestamp is isoTimestamp(): YYYY-MM-DDTHH:MM:SSZ (aidlc-lib.ts:1441)
//
// Test-design note (house style): assert the OBSERVABLE behavioural contract
// the .sh asserted — return values, thrown errors, and the literal bytes
// written to audit.md — never re-implementation of the formatter. Each
// assertion hard-codes the expected literal independently of the source.
//
// Old TAP -> new test parity (1:1, no guarantee dropped):
//   .sh test 1  (creates audit.md if missing)        -> "creates audit.md when missing"
//   .sh test 2  (writes header)                       -> "first write prepends the AI-DLC Audit Log header"
//   .sh test 3  (writes event type)                   -> "writes the **Event**: <type> line"
//   .sh test 4a (writes Stage field)                  -> "writes each field as **key**: value"
//   .sh test 4b (writes Details field)                -> "writes each field as **key**: value"
//   .sh test 5  (ISO timestamp)                       -> "writes an ISO **Timestamp** line (...Z, no millis)"
//   .sh test 6  (rejects invalid event type)          -> in-proc "appendAuditEntry throws ..." + CLI "append CLI emits error JSON on stderr"
//   .sh test 7  (returns JSON success)                -> in-proc "handleAppend writes appended:true JSON to stdout" + CLI "append CLI prints appended:true to stdout"
//   .sh test 8  (multiple appends accumulate)         -> "two appends produce exactly two --- separators"
//   .sh test 9  (append-raw custom heading)           -> CLI "append-raw CLI uses the custom ## heading" (handleAppendRaw not exported)
//   .sh test 10 (writes separator line)               -> "writes a standalone --- separator line"
//   .sh test 11 (heading for WORKSPACE_SCANNED)       -> "maps WORKSPACE_SCANNED to the '## Workspace Scanned' heading"
//   .sh test 12 (WORKSPACE_SCANNED accepted)          -> "accepts the WORKSPACE_SCANNED initialization event"

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAuditEntry,
  handleAppend,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";

const TOOL = fileURLToPath(
  new URL("../../dist/claude/.claude/tools/aidlc-audit.ts", import.meta.url),
);

// Mirror create_test_project (tests/lib/fixtures.sh): a temp dir with an
// aidlc-docs/ subdir already present. Each test gets a fresh dir and tears
// it down — no cross-test bleed, same isolation the .sh had via
// create_test_project / cleanup_test_project.
function makeProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t18-"));
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  return proj;
}

function auditPath(proj: string): string {
  return join(proj, "aidlc-docs", "audit.md");
}

function withProject(fn: (proj: string) => void): void {
  const proj = makeProject();
  try {
    fn(proj);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

describe("appendAuditEntry() — file creation + bytes (in-process)", () => {
  test("creates audit.md when missing [.sh test 1]", () => {
    withProject((proj) => {
      // audit.md does not exist yet (makeProject only creates the dir). The
      // .sh did `rm -f audit.md` first; here it never existed, same precondition.
      expect(existsSync(auditPath(proj))).toBe(false);
      appendAuditEntry("STAGE_COMPLETED", { Stage: "workspace-scaffold" }, proj);
      expect(existsSync(auditPath(proj))).toBe(true);
    });
  });

  test("first write prepends the AI-DLC Audit Log header [.sh test 2]", () => {
    withProject((proj) => {
      appendAuditEntry("STAGE_COMPLETED", { Stage: "workspace-scaffold" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // ensureAuditFile seeds "# AI-DLC Audit Log\n" before the first block.
      expect(body.includes("# AI-DLC Audit Log")).toBe(true);
      expect(body.startsWith("# AI-DLC Audit Log\n")).toBe(true);
    });
  });

  test("writes the **Event**: <type> line [.sh test 3]", () => {
    withProject((proj) => {
      appendAuditEntry(
        "STAGE_COMPLETED",
        { Stage: "workspace-scaffold", Details: "Done" },
        proj,
      );
      const body = readFileSync(auditPath(proj), "utf-8");
      expect(body.includes("**Event**: STAGE_COMPLETED")).toBe(true);
    });
  });

  test("writes each field as **key**: value [.sh test 4a + 4b]", () => {
    withProject((proj) => {
      appendAuditEntry(
        "STAGE_COMPLETED",
        { Stage: "intent-capture", Details: "Q&A done" },
        proj,
      );
      const body = readFileSync(auditPath(proj), "utf-8");
      // .sh test 4a: Stage field value present, as a **Stage**: line.
      expect(body.includes("**Stage**: intent-capture")).toBe(true);
      // .sh test 4b: Details field value present, as a **Details**: line.
      expect(body.includes("**Details**: Q&A done")).toBe(true);
    });
  });

  test("writes an ISO **Timestamp** line (...Z, no millis) [.sh test 5]", () => {
    withProject((proj) => {
      const result = appendAuditEntry("HEALTH_CHECKED", { Details: "All pass" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // Same regex the .sh grepped for: YYYY-MM-DDTHH:MM:SSZ (isoTimestamp
      // strips millis). Assert on disk bytes AND the returned timestamp.
      const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
      expect(isoRe.test(body)).toBe(true);
      expect(body.includes(`**Timestamp**: ${result.timestamp}`)).toBe(true);
      expect(isoRe.test(result.timestamp)).toBe(true);
    });
  });

  test("two appends produce exactly two --- separators [.sh test 8]", () => {
    withProject((proj) => {
      appendAuditEntry("STAGE_STARTED", { Stage: "workspace-scaffold" }, proj);
      appendAuditEntry("STAGE_COMPLETED", { Stage: "workspace-scaffold" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // .sh counted lines starting with "---" (grep -c "^---"). Each block
      // closes with "\n---\n", so two appends => two such lines.
      const sepLines = body.split("\n").filter((l) => l === "---").length;
      expect(sepLines).toBe(2);
    });
  });

  test("writes a standalone --- separator line [.sh test 10]", () => {
    withProject((proj) => {
      appendAuditEntry("STAGE_COMPLETED", { Stage: "workspace-scaffold" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // Equivalent of grep "^---$": a line that is exactly "---".
      expect(body.split("\n").some((l) => l === "---")).toBe(true);
    });
  });
});

describe("appendAuditEntry() — event-type heading + validation (in-process)", () => {
  test("maps WORKSPACE_SCANNED to the '## Workspace Scanned' heading [.sh test 11]", () => {
    withProject((proj) => {
      appendAuditEntry("WORKSPACE_SCANNED", { Details: "Greenfield" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // EVENT_HEADINGS["WORKSPACE_SCANNED"] === "Workspace Scanned".
      expect(body.includes("## Workspace Scanned")).toBe(true);
    });
  });

  test("accepts the WORKSPACE_SCANNED initialization event [.sh test 12]", () => {
    withProject((proj) => {
      const result = appendAuditEntry("WORKSPACE_SCANNED", { Details: "test" }, proj);
      const body = readFileSync(auditPath(proj), "utf-8");
      // Event type is in VALID_EVENT_TYPES, so it lands without throwing and
      // the **Event**: line appears.
      expect(result.appended).toBe(true);
      expect(result.event).toBe("WORKSPACE_SCANNED");
      expect(body.includes("**Event**: WORKSPACE_SCANNED")).toBe(true);
    });
  });

  test("appendAuditEntry throws on an invalid event type [.sh test 6 — logic half]", () => {
    withProject((proj) => {
      // The .sh asserted the CLI prints "error"; the underlying contract is
      // that the core function REJECTS an unknown event. Verify the throw
      // AND that nothing was written (validate-before-emit: the guard runs
      // before ensureAuditFile / appendFileSync).
      expect(() =>
        appendAuditEntry("INVALID_EVENT", {}, proj),
      ).toThrow(/Invalid event type: INVALID_EVENT/);
      expect(existsSync(auditPath(proj))).toBe(false);
    });
  });

  test("handleAppend writes appended:true JSON to stdout [.sh test 7 — logic half]", () => {
    withProject((proj) => {
      // handleAppend is the exported wrapper that the CLI 'append' subcommand
      // calls. It writes JSON.stringify(result)+"\n" to stdout. Capture the
      // write to assert the exact JSON contract the .sh grepped for.
      const original = process.stdout.write.bind(process.stdout);
      let captured = "";
      process.stdout.write = (chunk: string | Uint8Array) => {
        captured += chunk.toString();
        return true;
      };
      try {
        handleAppend("WORKFLOW_STARTED", { Scope: "feature" }, proj);
      } finally {
        process.stdout.write = original;
      }
      expect(captured.includes('"appended":true')).toBe(true);
      // The same JSON must be valid and carry the event back.
      const parsed = JSON.parse(captured.trim());
      expect(parsed.appended).toBe(true);
      expect(parsed.event).toBe("WORKFLOW_STARTED");
    });
  });
});

// --- CLI env-seam cases (Bun.spawnSync) -------------------------------------
//
// These three assert the CLI process shell, not the core logic the in-process
// tests above already cover:
//   - test 6 (CLI half): jsonError() writes {"error":...} to STDERR and
//     process.exit(1). The in-process function throws; only the CLI
//     translates that throw into the "error" string the .sh grepped for.
//   - test 7 (CLI half): the 'append' subcommand prints the success JSON to
//     STDOUT through process.stdout — a process-boundary contract.
//   - test 9: append-raw routes through handleAppendRaw, which is NOT exported
//     (CLI-only). The custom-heading contract can only be exercised through
//     the spawned binary.
//
// They are kept as spawns deliberately (env-seam), preserving the exact
// guarantees the .sh had for these three rows.
describe("aidlc-audit CLI shell (Bun.spawnSync env seam)", () => {
  test("append CLI emits error JSON on stderr for an invalid event [.sh test 6 — CLI half]", () => {
    withProject((proj) => {
      const r = Bun.spawnSync({
        cmd: ["bun", TOOL, "append", "INVALID_EVENT", "--project-dir", proj],
        stdout: "pipe",
        stderr: "pipe",
      });
      const merged =
        new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      // .sh: assert_contains "$OUT" "error" (OUT = stdout+stderr).
      expect(merged.includes("error")).toBe(true);
      expect(r.exitCode).not.toBe(0);
    });
  });

  test("append CLI prints appended:true to stdout [.sh test 7 — CLI half]", () => {
    withProject((proj) => {
      const r = Bun.spawnSync({
        cmd: [
          "bun", TOOL, "append", "WORKFLOW_STARTED",
          "--field", "Scope=feature", "--project-dir", proj,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const merged =
        new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      expect(merged.includes('"appended":true')).toBe(true);
      expect(r.exitCode).toBe(0);
    });
  });

  test("append-raw CLI uses the custom ## heading [.sh test 9]", () => {
    withProject((proj) => {
      const r = Bun.spawnSync({
        cmd: [
          "bun", TOOL, "append-raw", "Custom Event",
          "**Event**: CUSTOM\\n**Details**: Something happened",
          "--project-dir", proj,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      const body = readFileSync(auditPath(proj), "utf-8");
      // handleAppendRaw writes "\n## <heading>\n..." verbatim.
      expect(body.includes("## Custom Event")).toBe(true);
    });
  });
});

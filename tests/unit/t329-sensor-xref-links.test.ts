// covers: function:anchorFor function:definedAnchors
//
// t329 — the xref-links sensor. Verifies it flags a bare stable-ID
// cross-reference when the same file defines an anchor it could link to, and
// respects the two convention exceptions (definition point; no target).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorFor,
  definedAnchors,
} from "../../core/tools/aidlc-sensor-xref-links.ts";

const SCRIPT = join(
  import.meta.dir,
  "../../core/tools/aidlc-sensor-xref-links.ts",
);
const BUN = process.execPath;
const dirs: string[] = [];

interface Unlinked {
  id: string;
  line: number;
  anchor: string;
}
interface SensorResult {
  pass: boolean;
  unlinked: Unlinked[];
  findings_count: number;
  reason?: string;
}

function fire(content: string): SensorResult {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-xref-"));
  dirs.push(dir);
  const path = join(dir, "artifact.md");
  writeFileSync(path, content);
  const result = spawnSync(BUN, [SCRIPT, "--output-path", path], {
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as SensorResult;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("t329 xref-links sensor — anchorFor", () => {
  test("derives canonical anchors matching org.md rule", () => {
    expect(anchorFor("FR1.2")).toBe("fr1-2");
    expect(anchorFor("NFR3")).toBe("nfr3");
    expect(anchorFor("US1.1")).toBe("us1-1");
    expect(anchorFor("ADR-001")).toBe("adr-001");
    expect(anchorFor("ENT-001")).toBe("ent-001");
    expect(anchorFor("unit-4")).toBe("unit-4");
    expect(anchorFor("AC1.1.1")).toBe("ac1-1-1");
  });
});

describe("t329 xref-links sensor — definedAnchors", () => {
  test("reads Kramdown {#..} and portable HTML anchors with line numbers", () => {
    const md = [
      "# Title",
      "#### FR1.2: Export finishes in five minutes {#fr1-2}",
      "- **ADR-001: choose postgres** {#adr-001}",
      '#### <a id="nfr3"></a>NFR3: availability',
      "plain paragraph",
    ].join("\n");
    const anchors = definedAnchors(md);
    expect(anchors.get("fr1-2")).toBe(2);
    expect(anchors.get("adr-001")).toBe(3);
    expect(anchors.get("nfr3")).toBe(4);
    expect(anchors.size).toBe(3);
  });
});

describe("t329 xref-links sensor — scan", () => {
  test("flags a bare token whose anchor this file defines", () => {
    const md = [
      "#### FR1.2: Export finishes in five minutes {#fr1-2}",
      "The details.",
      "",
      "#### FR2: Something else {#fr2}",
      "This depends on FR1.2 completing first.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.findings_count).toBe(1);
    expect(r.unlinked[0]).toEqual({ id: "FR1.2", line: 5, anchor: "fr1-2" });
  });

  test("does NOT flag an already-linked reference", () => {
    const md = [
      "#### FR1.2: Export finishes in five minutes {#fr1-2}",
      "#### FR2: Something else {#fr2}",
      "This depends on [FR1.2](#fr1-2) completing first.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("does NOT flag the token on its own defining heading", () => {
    const md = [
      "#### FR1.2: Export finishes in five minutes {#fr1-2}",
      "Body prose with no other references.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("does NOT flag a token with no matching defined anchor (forward ref)", () => {
    const md = [
      "#### FR1: A requirement {#fr1}",
      "This will later trace to US9.9 which does not exist here.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("does NOT flag a token inside an inline-code span", () => {
    const md = [
      '#### <a id="fr1-2"></a>FR1.2: A requirement',
      '#### <a id="fr2"></a>FR2: Another',
      "The id `FR1.2` is mentioned as code, not a cross-reference.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("does NOT flag a token inside a fenced code block", () => {
    const md = [
      '#### <a id="fr1-2"></a>FR1.2: A requirement',
      '#### <a id="fr2"></a>FR2: Another',
      "```",
      "trace FR1.2 here",
      "```",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("does NOT flag a reference-style or collapsed link", () => {
    const md = [
      '#### <a id="fr1-2"></a>FR1.2: A requirement',
      '#### <a id="fr2"></a>FR2: Another',
      "This depends on [FR1.2][ref] and [FR1.2][] completing.",
      "",
      "[ref]: #fr1-2",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("reads a Kramdown {#anchor} heading attribute too", () => {
    const md = [
      "#### FR1.2: A requirement {#fr1-2}",
      "#### FR2: Another {#fr2}",
      "This depends on FR1.2 completing first.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked[0]).toEqual({ id: "FR1.2", line: 3, anchor: "fr1-2" });
  });

  test("matches hyphenated and single-segment ID forms", () => {
    const md = [
      '#### <a id="fr-1"></a>FR-1: hyphenated form',
      '#### <a id="br1"></a>BR1: single-segment rule',
      '#### <a id="us1"></a>US1: single-segment story',
      '#### <a id="anchor"></a>Anchor heading',
      "Depends on FR-1, BR1, and US1.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked.map((u) => u.id).sort()).toEqual(["BR1", "FR-1", "US1"]);
  });

  test("dedups the same id repeated on one line", () => {
    const md = [
      '#### <a id="fr1-2"></a>FR1.2: A requirement',
      '#### <a id="fr2"></a>FR2: Another',
      "FR1.2 and again FR1.2 on the same line.",
    ].join("\n");
    const r = fire(md);
    expect(r.findings_count).toBe(1);
  });

  test("flags an anchor defined AFTER the bare reference (order-independent)", () => {
    const md = [
      '#### <a id="fr2"></a>FR2: Another',
      "This depends on FR1.2 completing first.",
      '#### <a id="fr1-2"></a>FR1.2: defined later',
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked[0]).toEqual({ id: "FR1.2", line: 2, anchor: "fr1-2" });
  });

  test("handles CRLF line endings", () => {
    const md = [
      '#### <a id="fr1-2"></a>FR1.2: A requirement',
      '#### <a id="fr2"></a>FR2: Another',
      "This depends on FR1.2 completing first.",
    ].join("\r\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked[0]).toEqual({ id: "FR1.2", line: 3, anchor: "fr1-2" });
  });

  test("passes cleanly on an empty file", () => {
    const r = fire("");
    expect(r.pass).toBe(true);
    expect(r.findings_count).toBe(0);
  });

  test("still flags a bare token sitting between prose < and > operators", () => {
    const md = [
      '#### <a id="fr2"></a>FR2: a threshold requirement',
      '#### <a id="fr3"></a>FR3: another',
      "Reject if x < FR2 > threshold in the FR3 pipeline.",
    ].join("\n");
    const r = fire(md);
    // Both FR2 and FR3 on line 3 must be seen — the `< FR2 >` span is prose,
    // not an HTML tag, so the mask must not blank it.
    expect(r.pass).toBe(false);
    expect(r.unlinked.map((u) => u.id).sort()).toEqual(["FR2", "FR3"]);
  });

  test("an unterminated fence does NOT blind the scan to the rest of the file", () => {
    const md = [
      '#### <a id="fr7"></a>FR7: a requirement',
      "```",
      "an accidentally unterminated code fence (no closing marker)",
      "",
      "Later prose still references FR7 and must be flagged.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked.some((u) => u.id === "FR7" && u.line === 5)).toBe(true);
  });

  test("recognizes an anchor with a trailing attribute or self-close", () => {
    const md = [
      '#### <a id="fr8" class="anchor"></a>FR8: trailing-attr form',
      '#### <a id="fr9"/>FR9: self-closing form',
      "Depends on FR8 and FR9.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.unlinked.map((u) => u.id).sort()).toEqual(["FR8", "FR9"]);
  });

  test("nested differing-length fences: inner short marker is content, not a close", () => {
    const md = [
      '#### <a id="fr1"></a>FR1: req',
      "````", // 4-backtick opener
      "FR1 inside the outer block",
      "```", // 3-backtick line is CONTENT (shorter than opener)
      "still inside per CommonMark, FR1 again",
      "````", // 4-backtick closer
      "Now outside: FR1 here must be flagged.",
    ].join("\n");
    const r = fire(md);
    // Only the line after the real 4-backtick close is outside the fence.
    expect(r.unlinked.map((u) => u.line)).toEqual([7]);
    expect(r.unlinked[0].id).toBe("FR1");
  });

  test("flags multiple bare references across ID families", () => {
    const md = [
      '- **<a id="adr-001"></a>ADR-001: choose postgres**',
      '- **<a id="adr-002"></a>ADR-002: adopt events**',
      "  Supersedes ADR-001 and relates to ADR-002 handling.",
    ].join("\n");
    const r = fire(md);
    expect(r.pass).toBe(false);
    expect(r.findings_count).toBe(2);
    expect(r.unlinked.map((u) => u.id).sort()).toEqual(["ADR-001", "ADR-002"]);
  });
});

describe("t329 xref-links sensor — dispatcher matches glob", () => {
  // Drives the REAL dispatcher (dist/claude harness) `fire xref-links` so the
  // manifest `matches: "**/*.md"` wiring is exercised end-to-end, not just the
  // standalone script. The glob is checked before project/graph resolution, so
  // this asserts routing without needing a full projected workflow.
  const DISPATCH = join(
    import.meta.dir,
    "../../dist/claude/.claude/tools/aidlc-sensor.ts",
  );

  function fireDispatch(fileName: string, body: string): { status: number | null; combined: string } {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-xref-glob-"));
    dirs.push(dir);
    const path = join(dir, fileName);
    writeFileSync(path, body);
    const r = spawnSync(
      BUN,
      [DISPATCH, "fire", "xref-links", "--stage", "requirements-analysis", "--output-path", path],
      { encoding: "utf-8" },
    );
    return { status: r.status, combined: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  test("rejects a non-markdown path with the matches-filter error", () => {
    const r = fireDispatch("x.txt", "hi\n");
    expect(r.status).not.toBe(0);
    expect(r.combined).toContain('does not match sensor "xref-links" filter');
  });

  test("accepts a .md path and maps a resolvable bare id to a FAILED verdict with a detail file", () => {
    const r = fireDispatch(
      "requirements.md",
      '#### <a id="fr1-2"></a>FR1.2: r\nDepends on FR1.2.\n',
    );
    expect(r.combined).not.toContain("does not match sensor");
    // The dispatcher ran the sensor end-to-end: pass:false -> FAILED + detail file.
    const verdict = r.combined
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((o) => o && typeof o.result === "string");
    expect(verdict?.result).toBe("failed");
    expect(String(verdict?.detail_path ?? "")).toMatch(/xref-links-[0-9a-f]+\.md$/);
  });
});

describe("t329 xref-links sensor — error paths (exit 1)", () => {
  function fireExpectFail(args: string[]): { status: number | null; stderr: string } {
    const result = spawnSync(BUN, [SCRIPT, ...args], { encoding: "utf-8" });
    return { status: result.status, stderr: result.stderr ?? "" };
  }

  test("exits 1 when --output-path is missing", () => {
    const r = fireExpectFail([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("aidlc-sensor-xref-links");
  });

  test("exits 1 when the artifact does not exist", () => {
    const r = fireExpectFail(["--output-path", join(tmpdir(), "aidlc-xref-nope-xyz.md")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing");
  });

  test("exits 1 when --output-path is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-xref-dir-"));
    dirs.push(dir);
    const r = fireExpectFail(["--output-path", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a file");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lineDiff,
  PathConfinementError,
  renderFeedbackMarkdown,
  renderMarkdown,
  resolveProjectAidlcPath,
  sanitizeHtml,
} from "../../core/tools/aidlc-review-ui-render.ts";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("t331 review UI render helpers", () => {
  test("sanitizes active content and renders stable headings and Mermaid fences", () => {
    const unsafe = [
      '<script>alert("x")</script>',
      '<img src="javascript:alert(1)" onerror="alert(2)">',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">bad</a>',
      '<iframe src="safe.html">fallback</iframe>',
      '<form action="/submit"><button>send</button></form>',
    ].join("");
    const cleaned = sanitizeHtml(unsafe);
    expect(cleaned.toLowerCase()).not.toContain("<script");
    expect(cleaned.toLowerCase()).not.toContain("onerror");
    expect(cleaned.toLowerCase()).not.toContain("javascript:");
    expect(cleaned.toLowerCase()).not.toContain("data:text/html");
    expect(cleaned.toLowerCase()).not.toContain("<iframe");
    expect(cleaned.toLowerCase()).not.toContain("<form");

    const rendered = renderMarkdown(
      "# System Overview\n\n# System Overview\n\n```mermaid\ngraph TD; A-->B\n```\n",
    );
    expect(rendered).toContain('<h1 id="system-overview">System Overview</h1>');
    expect(rendered).toContain('<h1 id="system-overview-2">System Overview</h1>');
    expect(rendered).toContain('<pre class="mermaid">graph TD; A--&gt;B</pre>');
  });

  test("produces a compact unified diff and structured hunk for a three-line change", () => {
    const result = lineDiff(
      "alpha\nbeta\ngamma\n",
      "alpha\nchanged\ngamma\n",
      { before: "a/requirements.md", after: "b/requirements.md" },
    );
    expect(result.unified).toBe(
      [
        "--- a/requirements.md",
        "+++ b/requirements.md",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-beta",
        "+changed",
        " gamma",
        "",
      ].join("\n"),
    );
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
  });

  test("writes feedback frontmatter, artifact blocks, comments, and server-computed edits", () => {
    const markdown = renderFeedbackMarkdown(
      {
        stage: "requirements-analysis",
        unit: null,
        revision: 0,
        decision_hint: "request-changes",
        annotations: [
          {
            artifact: "requirements.md",
            kind: "comment",
            heading_path: ["Functional Requirements", "FR3"],
            line_start: 41,
            line_end: 44,
            selection: "the export must finish within 5 minutes",
            body: "Make this 2 minutes; the SLA changed.",
          },
          {
            artifact: "requirements.md",
            kind: "edit",
            heading_path: [],
            after: "# Requirements\nNew SLA\n",
          },
        ],
        general: "Double-check the launch plan.",
      },
      {
        created: "2026-09-03T10:00:00.000Z",
        sources: { "requirements.md": "# Requirements\nOld SLA\n" },
      },
    );

    expect(markdown).toStartWith(
      "---\naidlc_review_feedback: 1\nstage: requirements-analysis\nunit: null\nrevision: 0\ncreated: 2026-09-03T10:00:00.000Z\ndecision_hint: request-changes\n---\n",
    );
    expect(markdown).toContain("# Review feedback: requirements-analysis (revision 0)");
    expect(markdown).toContain("## requirements.md");
    expect(markdown).toContain(
      "### Comment — Functional Requirements › FR3 (lines ~41-44)\n> the export must finish within 5 minutes",
    );
    expect(markdown).toContain("### Edit (unified diff)\n```diff\n--- a/requirements.md");
    expect(markdown).toContain("-Old SLA\n+New SLA");
    expect(markdown).toContain("## General notes\n\nDouble-check the launch plan.");
  });

  test("confines project paths against traversal and symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-review-render-"));
    created.push(root);
    const project = join(root, "project");
    const aidlc = join(project, "aidlc");
    const outside = join(root, "outside");
    mkdirSync(join(aidlc, "docs"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(aidlc, "docs", "ok.md"), "ok\n");
    writeFileSync(join(outside, "secret.md"), "secret\n");
    symlinkSync(outside, join(aidlc, "escape"));

    expect(resolveProjectAidlcPath(project, "aidlc/docs/ok.md")).toBe(
      join(aidlc, "docs", "ok.md"),
    );
    expect(() => resolveProjectAidlcPath(project, "aidlc/../outside/secret.md")).toThrow(
      PathConfinementError,
    );
    expect(() => resolveProjectAidlcPath(project, "aidlc/escape/secret.md")).toThrow(
      PathConfinementError,
    );
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ASSET_DIR = join(REPO_ROOT, "core", "tools", "data", "review-ui");
const TEXT_ASSETS = [
  "index.html",
  "app.js",
  "app.css",
  "diff.js",
  "icons.js",
  "api.js",
  "store.js",
  "shell.js",
  "workflow.js",
  "document.js",
  "threads.js",
  "history.js",
  "questions.js",
  "bridge.js",
  join("vendor", "MERMAID-LICENSE.txt"),
  join("vendor", "FLUENT-ICONS-LICENSE.txt"),
] as const;
const MERMAID_BYTES = 3_572_661;
const MERMAID_SHA256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8";

function asset(name: (typeof TEXT_ASSETS)[number]): string {
  return readFileSync(join(ASSET_DIR, name), "utf8");
}

describe("t353 — review UI browser questions assets", () => {
  test("exposes the Questions view and answer controls", () => {
    const html = asset("index.html");
    expect(html).toMatch(/<script\s+type=["']module["']\s+src=["']\/assets\/app\.js["']/);
    expect(html).toMatch(/id=["']questions-view["']/);
    expect(html).toMatch(/<form\s+id=["']questions-form["']/);
    expect(html).toMatch(/id=["']questions-content["']/);
    expect(html).toMatch(/id=["']save-answers-button["']/);
    expect(html).toMatch(/id=["']guide-content["'][^>]*>No explainer yet<\/div>/);
  });

  test("loads, recommends, and saves browser answers", () => {
    const questions = asset("questions.js");
    expect(questions).toContain("/api/questions");
    expect(questions).toContain("/api/answers");
    expect(questions).toContain("data-aidlc-recommend");
    expect(questions).toContain("Recommended");
    // Saving hands the round to the agent; the browser never asks for a terminal keystroke.
    expect(questions).toContain("the agent is picking your answers up now.");
    expect(questions).not.toContain("send **done**");
    // The explainer sits above each answer card; the header carries the save action.
    const shell = asset("shell.js");
    expect(shell).toContain('actionButton("Save", "save-answers", true)');
    // A question round has one action: the browser is the form, not a file editor.
    expect(shell).not.toContain("terminal-edit");
    // An answered round offers no "reopen" signpost either; changes go through the gate.
    expect(shell).not.toContain("terminal-reopen");

    // The diary is a folded overview section, never a tree row or dropdown entry.
    const workflow = asset("workflow.js");
    expect(workflow).toContain('class="stage-diary"');
    expect(workflow).not.toContain("memoryChild");
    expect(shell).not.toContain('label: "memory.md"');

    const css = asset("questions.css");
    expect(css).toMatch(/\.qblock\b/);
    expect(css).toMatch(/\.explain\b/);
    expect(css).toMatch(/\.qcard\b/);
  });

  test("publishes bounded guide recommendations on document load", () => {
    const bridge = asset("bridge.js");
    expect(bridge).toContain('type: "aidlc-guide"');
    expect(bridge).toContain("[data-aidlc-question]");
    expect(bridge).toContain("[data-aidlc-recommend]");
    expect(bridge).toContain("/^Q\\d+$/");
    expect(bridge).toContain("/^[A-Z]$/");
    expect(bridge).toContain("200");
    expect(bridge).toContain("DOMContentLoaded");
    expect(bridge).toContain("{ once: true }");
  });

  test("keeps every text asset offline-only", () => {
    for (const name of TEXT_ASSETS) {
      expect(asset(name), `${name} contains an external URL`).not.toMatch(/https?:\/\//i);
    }
  });

  test("keeps the vendored Mermaid distribution unchanged", () => {
    const bytes = readFileSync(join(ASSET_DIR, "vendor", "mermaid.min.js"));
    expect(bytes.byteLength).toBe(MERMAID_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(MERMAID_SHA256);
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ASSET_DIR = join(REPO_ROOT, "core", "tools", "data", "review-ui");
const TEXT_ASSETS = ["index.html", "app.js", "app.css", "bridge.js", join("vendor", "MERMAID-LICENSE.txt")] as const;
const MERMAID_BYTES = 3_572_661;
const MERMAID_SHA256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8";

function asset(name: (typeof TEXT_ASSETS)[number]): string {
  return readFileSync(join(ASSET_DIR, name), "utf8");
}

describe("t353 — review UI browser questions assets", () => {
  test("exposes the Questions view and answer controls", () => {
    const html = asset("index.html");
    expect(html).toMatch(/id=["']questions-nav["']/);
    expect(html).toMatch(/id=["']questions-button["'][^>]*>[\s\S]*?Questions/);
    expect(html).toMatch(/id=["']questions-badge["']/);
    expect(html).toMatch(/id=["']questions-view["']/);
    expect(html).toMatch(/<form\s+id=["']questions-form["']/);
    expect(html).toMatch(/id=["']save-answers-button["'][^>]*>Save answers<\/button>/);
    expect(html).toMatch(/id=["']guide-content["'][^>]*>No explainer yet<\/div>/);
  });

  test("loads, recommends, and saves browser answers", () => {
    const app = asset("app.js");
    expect(app).toContain("/api/questions");
    expect(app).toContain("/api/answers");
    expect(app).toContain("aidlc-guide");
    expect(app).toContain("Recommended");
    expect(app).toContain("Return to the terminal and send **done**.");

    const css = asset("app.css");
    expect(css).toMatch(/\.questions-view\b/);
    expect(css).toMatch(/\.questions-form-pane\b/);
    expect(css).toMatch(/\.guide-pane\b/);
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

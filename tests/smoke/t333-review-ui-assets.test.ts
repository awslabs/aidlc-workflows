import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ASSET_DIR = join(REPO_ROOT, "core", "tools", "data", "review-ui");
const TEXT_ASSETS = ["index.html", "app.js", "app.css", "bridge.js"] as const;
const ALL_ASSETS = [
  ...TEXT_ASSETS,
  join("vendor", "mermaid.min.js"),
  join("vendor", "MERMAID-LICENSE.txt"),
] as const;
const MERMAID_BYTES = 3_572_661;
const MERMAID_SHA256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8";

let reviewHome: string;
let previousReviewHome: string | undefined;

beforeAll(() => {
  reviewHome = mkdtempSync(join(tmpdir(), "aidlc-t333-review-home-"));
  previousReviewHome = process.env.AIDLC_REVIEW_HOME;
  process.env.AIDLC_REVIEW_HOME = reviewHome;
});

afterAll(() => {
  if (previousReviewHome === undefined) delete process.env.AIDLC_REVIEW_HOME;
  else process.env.AIDLC_REVIEW_HOME = previousReviewHome;
  rmSync(reviewHome, { recursive: true, force: true });
});

describe("t333 — review UI static assets", () => {
  test("ships every browser asset", () => {
    for (const asset of ALL_ASSETS) {
      const path = join(ASSET_DIR, asset);
      expect(existsSync(path), asset).toBe(true);
      expect(statSync(path).isFile(), asset).toBe(true);
      expect(statSync(path).size, asset).toBeGreaterThan(0);
    }
  });

  test("keeps app assets offline-only", () => {
    for (const asset of TEXT_ASSETS) {
      const source = readFileSync(join(ASSET_DIR, asset), "utf8");
      expect(source, `${asset} contains an external URL`).not.toMatch(/https?:\/\//i);
    }
  });

  test("pins the vendored Mermaid 11.17.2 distribution", () => {
    const bytes = readFileSync(join(ASSET_DIR, "vendor", "mermaid.min.js"));
    expect(bytes.byteLength).toBe(MERMAID_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(MERMAID_SHA256);
  });

  test("includes Mermaid's MIT license", () => {
    const license = readFileSync(join(ASSET_DIR, "vendor", "MERMAID-LICENSE.txt"), "utf8");
    expect(license).toMatch(/MIT License/i);
    expect(license).toContain("Permission is hereby granted, free of charge");
  });

  test("guards sandbox messages behind trusted interaction and emits only anchors", () => {
    const bridge = readFileSync(join(ASSET_DIR, "bridge.js"), "utf8");
    expect(bridge).toContain("isTrusted");
    expect(bridge).toContain('type: "aidlc-anchor"');
    const postedTypes = [...bridge.matchAll(/type:\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(postedTypes).toEqual(["aidlc-anchor"]);
    const postCalls = bridge.match(/\.postMessage\s*\(/g) ?? [];
    expect(postCalls).toHaveLength(1);
    expect(bridge).toContain("window.parent === window");
  });
});

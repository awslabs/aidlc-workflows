// covers: file:scripts/vendor-markdown-parser.ts
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MARKDOWN_PARSER_BUN_VERSION } from "../../scripts/vendor-markdown-parser.ts";

const ROOT = resolve(import.meta.dir, "../..");
const BUNDLE = join(ROOT, "core/tools/vendor/markdown-parser.js");
const pinnedBun = Bun.version === MARKDOWN_PARSER_BUN_VERSION;
if (!pinnedBun) {
  console.warn(`Skipping Markdown parser bundle parity: requires Bun ${MARKDOWN_PARSER_BUN_VERSION}, found ${Bun.version}.`);
}

describe("t340 vendored Markdown parser", () => {
  test.skipIf(!pinnedBun)("regenerates byte-identically under the pinned Bun", () => {
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-parser-parity-"));
    try {
      const rebuilt = join(scratch, "markdown-parser.js");
      const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts/vendor-markdown-parser.ts"), "--output", rebuilt], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(rebuilt).equals(readFileSync(BUNDLE))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("retains pinned versions and upstream MIT notices in the distributable", () => {
    const header = readFileSync(BUNDLE, "utf8").split("*/", 1)[0];
    expect(header).toContain(`Bun ${MARKDOWN_PARSER_BUN_VERSION}`);
    expect(header).toContain("micromark@4.0.2 (MIT)");
    expect(header).toContain("micromark-extension-gfm@3.0.0 (MIT)");
    const manifest = readFileSync(join(ROOT, "core/tools/vendor/LICENSES.md"), "utf8");
    const packages = [...manifest.matchAll(/^\| `([^`]+)` \| MIT \|$/gm)].map((match) => match[1]);
    expect(packages).toContain("micromark@4.0.2");
    for (const name of packages) expect(header).toContain(`${name} (MIT)`);
    expect(header).toContain("Permission is hereby granted, free of charge");
    expect(header).toContain("Copyright");
  });

  test("parses from a standalone copy without node_modules", () => {
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-parser-standalone-"));
    try {
      copyFileSync(BUNDLE, join(scratch, "markdown-parser.js"));
      writeFileSync(join(scratch, "parse.ts"), `
        import { parse, preprocess, postprocess, gfm } from "./markdown-parser.js";
        const events = postprocess(parse({ extensions: [gfm()] }).document().write(preprocess()("# x", undefined, true)));
        console.log(events.filter(([phase, token]) => phase === "enter" && token.type === "atxHeading").length);
      `);
      const result = Bun.spawnSync([process.execPath, join(scratch, "parse.ts")], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("1");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

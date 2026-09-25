import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bun's CLI default preserves explicit case and hook deadlines", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-bun-deadline-"));
  const fixture = join(root, "deadline.test.ts");
  try {
    writeFileSync(fixture, `
import { beforeAll, describe, test } from "bun:test";
test("uses CLI default", async () => { await Bun.sleep(200); });
test("explicit case deadline", async () => { await Bun.sleep(200); }, 2000);
describe("explicit hook deadline", () => {
  beforeAll(async () => { await Bun.sleep(200); }, 2000);
  test("hook completed", () => {});
});
`);
    const child = spawnSync(process.execPath, ["test", fixture, "--timeout=50"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(child.status, output).toBe(1);
    expect(output).toContain("2 pass");
    expect(output).toContain("1 fail");
    expect(output).toContain("(fail) uses CLI default");
    expect(output).toContain("timed out after 50ms");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

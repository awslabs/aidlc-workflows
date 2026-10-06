// covers: function:executePlan
//
// Setting up AI-DLC in a folder an editor has open (Kiro on Windows) failed with
// "EBUSY: resource busy or locked, rm '<project>\.aidlc-txn-<id>'": every file
// was already in place, but a moment's handle on the transaction's own staging
// folder (the editor's watcher, a virus scan of the new files) failed the run
// and rolled the setup back. A plan that has committed stays committed: the
// staging folder is removed once the handle goes, or left for the next run to
// remove, never kept as recovery evidence.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TRANSACTION = pathToFileURL(join(REPO_ROOT, "core/tools/aidlc-transaction.ts")).href;
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-txn-busy-")));
  temporary.push(container);
  const root = join(container, "project");
  mkdirSync(root);
  return root;
}

const PLAN = (root: string) => `{ schemaVersion: 1, root: ${JSON.stringify(root)}, operations: [
  tx.writeOperation("AGENTS.md", "agents\\n", "absent"),
  tx.writeOperation(".kiro/steering/aidlc.md", "steering\\n", "absent"),
] }`;

// Run one plan in a child whose removal of the staging folder fails with EBUSY
// the first `busy` times (every time with -1), as a held handle makes it fail
// on Windows. Everything else is real IO.
function runBusy(root: string, busy: number): { error: string | null; removals: number } {
  const source = `
    import { mock } from "bun:test";
    import { basename } from "node:path";
    const fs = { ...await import("node:fs") };
    const out = { error: null, removals: 0 };
    let left = ${busy};
    mock.module("node:fs", () => ({
      ...fs,
      rmSync(path, ...args) {
        if (typeof path === "string" && basename(path).startsWith(".aidlc-txn-")) {
          out.removals++;
          if (left !== 0) {
            left--;
            throw Object.assign(new Error("EBUSY: resource busy or locked, rm '" + path + "'"), { code: "EBUSY" });
          }
        }
        return fs.rmSync(path, ...args);
      },
    }));
    const tx = await import(${JSON.stringify(TRANSACTION)});
    try {
      tx.executePlan(${PLAN(root)});
    } catch (e) {
      out.error = e.message;
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const env = { ...process.env };
  delete env.AIDLC_ROUTE_MUTATION_SCOPE;
  const result = spawnSync(process.execPath, ["--eval", source], { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function expectInstalled(root: string): void {
  expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(root, ".kiro", "steering", "aidlc.md"))).toBe(true);
}

const leftovers = (root: string, prefix: string) => readdirSync(root).filter((entry) => entry.startsWith(prefix));

describe("t-transaction-busy-cleanup: a held handle on the staging folder never undoes a committed plan", () => {
  test("a staging folder busy for a moment is removed once the handle goes, and the plan stands", () => {
    const root = project();
    const out = runBusy(root, 3);
    expect(out.error).toBeNull();
    expectInstalled(root);
    expect(out.removals).toBeGreaterThan(3);
    expect(leftovers(root, ".aidlc-txn-")).toEqual([]);
  });

  test("a staging folder that stays busy is left behind, the plan stands, and the next run removes it", () => {
    const root = project();
    const out = runBusy(root, -1);
    expect(out.error).toBeNull();
    expectInstalled(root);
    expect(leftovers(root, ".aidlc-txn-").length).toBe(1);
    // The next run sweeps it: nothing in it needs recovering.
    const env = { ...process.env };
    delete env.AIDLC_ROUTE_MUTATION_SCOPE;
    const next = spawnSync(process.execPath, ["--eval", `
      const tx = await import(${JSON.stringify(TRANSACTION)});
      tx.executePlan({ schemaVersion: 1, root: ${JSON.stringify(root)}, operations: [tx.writeOperation("second.txt", "second\\n", "absent")] });
    `], { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 60_000 });
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(leftovers(root, ".aidlc-txn-")).toEqual([]);
    expect(leftovers(root, ".aidlc-recovery-")).toEqual([]);
    expect(existsSync(join(root, "second.txt"))).toBe(true);
  });

  // The real thing on Windows: another process holds a file in the staging
  // folder open with no sharing, as a virus scan does, for a moment after the
  // plan committed.
  test.skipIf(process.platform !== "win32")("Windows: a file held open in the staging folder does not fail the setup", () => {
    const root = project();
    const ready = join(root, "..", "holder-ready");
    const env = { ...process.env };
    delete env.AIDLC_ROUTE_MUTATION_SCOPE;
    const source = `
      import { spawn } from "node:child_process";
      import { existsSync, readdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const tx = await import(${JSON.stringify(TRANSACTION)});
      const root = ${JSON.stringify(root)}, ready = ${JSON.stringify(ready)};
      let error = null;
      try {
        tx.executePlan(${PLAN(root)}, {
          validateCommitted: () => {
            const staging = readdirSync(root).find((entry) => entry.startsWith(".aidlc-txn-"));
            const held = join(root, staging, "candidates", "scanned.tmp");
            writeFileSync(held, "x");
            const hold = "$f=[System.IO.File]::Open('" + held + "','Open','ReadWrite','None'); " +
              "Set-Content -Path '" + ready + "' -Value ok; Start-Sleep -Milliseconds 1200; $f.Close()";
            spawn("powershell", ["-NoProfile", "-Command", hold], { stdio: "ignore" });
            const deadline = Date.now() + 20000;
            while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(50);
          },
        });
      } catch (e) {
        error = e.message;
      }
      process.stdout.write(JSON.stringify({ error, held: existsSync(ready) }));
    `;
    const result = spawnSync(process.execPath, ["--eval", source], { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 60_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as { error: string | null; held: boolean };
    expect(out.held).toBe(true);
    expect(out.error).toBeNull();
    expectInstalled(root);
    expect(leftovers(root, ".aidlc-recovery-")).toEqual([]);
  });
});

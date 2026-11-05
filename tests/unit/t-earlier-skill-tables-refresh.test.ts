// covers: tool:aidlc-init
//
// Releases 2.8.0 to 2.11.0 kept the scope and stage tables inside the /aidlc
// skill, and a plugin sync there rewrote them in place. The record still holds
// the skill config wrote, so the next release's `aidlc config` stopped on it
// ("locally modified or unowned", exit 4) on every harness, native and copy.
// With its tables put back to the ones this release ships, the skill is the
// file the record says AI-DLC wrote, so the refresh takes it as AI-DLC's. An
// edit outside the tables is still the person's to resolve.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EARLIER_RELEASE_REGIONS } from "../../scripts/earlier-release-regions.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const HARNESS_DIRS = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".aidlc",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".aidlc",
} as const;
type Harness = keyof typeof HARNESS_DIRS;
const TABLES = ["scope grid", "stage graph"] as const;
// sha256 of each table's body (between its BEGIN and END lines) in the /aidlc
// skill 2.9.0, 2.10.0 and 2.11.0 shipped, the same on every harness, measured
// from their aidlc-runtime-X.Y.Z.tar.gz release assets.
const EARLIER_BODIES = {
  "scope grid": "e2e83c1396b6b651c022b5112d0f7bc9ddb73427ac06d5e8860daeed4eb5bc4b",
  "stage graph": "4a498112f5cb5953b57daf5c87a53aee747e24dd05d9b8e0f08d529fa6c8b214",
} as const;

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function config(project: string, from: string, harness: string, ...extra: string[]): { status: number; out: string } {
  const machine = temp("aidlc-t-earlier-tables-machine-");
  const result = spawnSync(
    BUN,
    [INIT, "config", "--project-dir", project, "--from", from, "--harness", typedHarnessName(harness), "--mcp", "none", ...extra],
    {
      cwd: project,
      env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share"), AIDLC_BIN_DIR: join(machine, "bin") },
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function conflicts(project: string, from: string, harness: string): string[] {
  const planned = config(project, from, harness, "--dry-run", "--json");
  const parsed = JSON.parse(planned.status === 0 || planned.status === 4 ? planned.out.slice(planned.out.indexOf("{")) : "{}") as {
    data?: { actions?: Array<{ path: string; action: string; detail?: string }> };
  };
  expect(parsed.data?.actions, planned.out.slice(0, 2000)).toBeDefined();
  return (parsed.data?.actions ?? []).filter((item) => item.action === "conflict").map((item) => `${item.path} (${item.detail})`);
}

function release(harness: Harness): string {
  return join(REPO_ROOT, "dist-release", harness);
}

// The skill a harness ships: in its own folder, else Codex's .agents or Copilot's .github.
function skillRel(tree: string, harness: Harness): string {
  const rel = [HARNESS_DIRS[harness], ".agents", ".github"]
    .map((dir) => `${dir}/skills/aidlc/SKILL.md`)
    .find((candidate) => existsSync(join(tree, candidate)));
  if (rel === undefined) throw new Error(`${tree}: no /aidlc skill`);
  return rel;
}

const lf = (text: string): string => text.replaceAll("\r\n", "\n");

function region(text: string, noun: string): { start: number; open: number; close: number; end: number } {
  const start = text.indexOf(`<!-- BEGIN: compiled ${noun} via `);
  const open = text.indexOf("-->", start) + 3;
  const endMarker = `<!-- END: compiled ${noun} -->`;
  const close = text.indexOf(endMarker, open);
  expect(start, noun).toBeGreaterThanOrEqual(0);
  expect(close, noun).toBeGreaterThan(open);
  return { start, open, close, end: close + endMarker.length };
}

// The release as 2.11.0 shipped it: the scope and stage tables inside the
// skill itself, holding the tables this release ships. tables.md stays: the
// release's own list of its files names it.
function earlierRelease(harness: Harness): string {
  const prior = join(temp(`aidlc-t-earlier-tables-${harness}-prior-`), harness);
  cpSync(release(harness), prior, { recursive: true });
  const rel = skillRel(prior, harness);
  const skillPath = join(prior, rel);
  const tablesPath = join(dirname(skillPath), "tables.md");
  const tables = lf(readFileSync(tablesPath, "utf-8"));
  const inline = TABLES.map((noun) => {
    const at = region(tables, noun);
    return tables.slice(at.start, at.end);
  }).join("\n\n");
  const shipped = lf(readFileSync(skillPath, "utf-8")).replace(`${EARLIER_RELEASE_REGIONS}\n`, "");
  writeFileSync(skillPath, `${shipped.trimEnd()}\n\n${inline}\n`);
  return prior;
}

// What that release's plugin sync did: each table gains the plugin's row.
function composed(text: string): string {
  const rows = {
    "scope grid": "| acme-feature   | Standard      | (default)    | 3 / 34          |",
    "stage graph": "| acme-review | 3.8 | Acme Review | Construction | CONDITIONAL | aidlc-quality-agent | acme-metrics-agent | inline |",
  } as const;
  let value = lf(text);
  for (const noun of TABLES) {
    const at = region(value, noun);
    const body = value.slice(at.open, at.close);
    value = `${value.slice(0, at.open)}${body.trimEnd()}\n${rows[noun]}\n\n${value.slice(at.close)}`;
  }
  return value;
}

function composedProject(harness: Harness): { project: string; rel: string } {
  const prior = earlierRelease(harness);
  const project = temp(`aidlc-t-earlier-tables-${harness}-`);
  mkdirSync(join(project, ".git"));
  const installed = config(project, prior, harness, "--yes");
  expect(installed.status, installed.out).toBe(0);
  const rel = skillRel(project, harness);
  const path = join(project, rel);
  writeFileSync(path, composed(readFileSync(path, "utf-8")));
  return { project, rel };
}

describe("a skill whose tables an earlier release's plugin sync rewrote refreshes as AI-DLC's", () => {
  // The proof puts this release's tables back, so it holds only while they are
  // the ones those releases shipped.
  test.each(Object.keys(HARNESS_DIRS) as Harness[])("%s: the tables this release ships are the ones 2.9.0 to 2.11.0 shipped", (harness) => {
    const tablesPath = join(dirname(join(release(harness), skillRel(release(harness), harness))), "tables.md");
    const tables = lf(readFileSync(tablesPath, "utf-8"));
    for (const noun of TABLES) {
      const at = region(tables, noun);
      const body = createHash("sha256").update(tables.slice(at.open, at.close)).digest("hex");
      expect(
        body,
        `the core ${noun} in ${tablesPath} is no longer the one 2.9.0 to 2.11.0 kept in their /aidlc skill, so ` +
          "earlierSkillTablesOnly (core/tools/aidlc-init.ts) cannot prove those projects' skills and their config stops " +
          `again: give it that ${noun} body (sha256 ${EARLIER_BODIES[noun]}) to put back as well, then pin this release's here`,
      ).toBe(EARLIER_BODIES[noun]);
    }
  });

  for (const harness of Object.keys(HARNESS_DIRS) as Harness[]) {
    test(`${harness}: config plans no conflict and brings the skill to this release's`, () => {
      const { project, rel } = composedProject(harness);
      expect(conflicts(project, release(harness), harness)).toEqual([]);
      const refreshed = config(project, release(harness), harness, "--yes");
      expect(refreshed.status, refreshed.out).toBe(0);
      expect(lf(readFileSync(join(project, rel), "utf-8"))).toBe(lf(readFileSync(join(release(harness), rel), "utf-8")));
    });
  }

  test("claude: the same skill in a Windows checkout (CRLF) is no conflict", () => {
    const { project, rel } = composedProject("claude");
    const path = join(project, rel);
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll("\n", "\r\n"));
    expect(conflicts(project, release("claude"), "claude")).toEqual([]);
  });

  test("claude: a line the person changed outside the tables keeps the conflict", () => {
    const { project, rel } = composedProject("claude");
    const path = join(project, rel);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("## Key Principles\n");
    writeFileSync(path, text.replace("## Key Principles\n", "## Key Principles (our team's)\n"));
    expect(conflicts(project, release("claude"), "claude")).toEqual([`${rel} (locally modified or unowned)`]);
  });

  for (const harness of ["claude", "copilot"] as const) {
    test(`${harness}: this release's own skill, changed by the person, keeps the conflict`, () => {
      const project = temp(`aidlc-t-earlier-tables-${harness}-own-`);
      mkdirSync(join(project, ".git"));
      const installed = config(project, release(harness), harness, "--yes");
      expect(installed.status, installed.out).toBe(0);
      const rel = skillRel(project, harness);
      const path = join(project, rel);
      writeFileSync(path, `${readFileSync(path, "utf-8")}\nOur team's note.\n`);
      expect(conflicts(project, release(harness), harness)).toEqual([`${rel} (locally modified or unowned)`]);
    });
  }
});

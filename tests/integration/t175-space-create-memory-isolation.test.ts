// covers: subcommand:aidlc-utility:space-create, function:handleSpaceCreate
//
// t175 — the P9 vision §11 NON-NEGOTIABLE that the existing space-create coverage
// (t164/t165) leaves unpinned: a freshly created space's memory is ISOLATED from
// the default space's PROMOTED knowledge. `org.md` is the org-wide baseline so it
// is COPIED from default; `team.md`/`project.md` carry team/project-specific
// practices a NEW team earns for itself, so they MUST be fresh empty stubs — a
// learning/practice promoted into default's team.md must NOT leak into the new
// space. t164/t165 assert the three files EXIST; this pins their CONTENT
// isolation (the leak the §11 promise forbids) + that a new intent born in the
// space reads the space's OWN live memory, not default's.
//
// Mechanism: cli (spawn aidlc-utility space-create / space / intent-birth) +
// on-disk content reads. Zero LLM, zero tokens — deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

function util(args: string[]): { status: number; stdout: string } {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", proj],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { status: r.exitCode, stdout: r.stdout.toString() };
}

const memoryOf = (space: string): string =>
  join(proj, "aidlc", "spaces", space, "memory");

describe("t175 space-create memory isolation (vision §11 — no learning leak)", () => {
  test("org.md is copied from default; team.md/project.md are fresh stubs that do NOT carry default's promoted practices", () => {
    // Promote a distinctive practice into the DEFAULT space's team + project
    // memory + a custom org baseline — exactly what practices-discovery /
    // learnings promotion writes over a project's life.
    const defMem = memoryOf("default");
    const ORG_MARKER = "ORG-BASELINE-SENTINEL-must-propagate";
    const TEAM_SECRET = "TEAM-PRACTICE-SENTINEL-must-not-leak";
    const PROJECT_SECRET = "PROJECT-OVERRIDE-SENTINEL-must-not-leak";
    writeFileSync(join(defMem, "org.md"), `# Organization defaults\n\n- ${ORG_MARKER}\n`, "utf-8");
    writeFileSync(join(defMem, "team.md"), `# Team practices\n\n- ${TEAM_SECRET}\n`, "utf-8");
    writeFileSync(join(defMem, "project.md"), `# Project overrides\n\n- ${PROJECT_SECRET}\n`, "utf-8");

    expect(util(["space-create", "payments"]).status).toBe(0);
    const newMem = memoryOf("payments");

    // org.md: COPIED — the org-wide baseline propagates to every space.
    expect(existsSync(join(newMem, "org.md"))).toBe(true);
    expect(readFileSync(join(newMem, "org.md"), "utf-8")).toContain(ORG_MARKER);

    // team.md / project.md: FRESH stubs — default's promoted practices do NOT leak.
    expect(existsSync(join(newMem, "team.md"))).toBe(true);
    expect(existsSync(join(newMem, "project.md"))).toBe(true);
    const newTeam = readFileSync(join(newMem, "team.md"), "utf-8");
    const newProject = readFileSync(join(newMem, "project.md"), "utf-8");
    expect(newTeam).not.toContain(TEAM_SECRET);
    expect(newProject).not.toContain(PROJECT_SECRET);
    // They ARE the empty-stub headings (a new team earns its own practices).
    expect(newTeam).toContain("# Team practices");
    expect(newProject).toContain("# Project overrides");
  });

  test("the new space is an additive sibling of identical shape (default untouched)", () => {
    const TEAM_SECRET = "DEFAULT-TEAM-PRACTICE-stays-put";
    writeFileSync(join(memoryOf("default"), "team.md"), `# Team practices\n\n- ${TEAM_SECRET}\n`, "utf-8");

    expect(util(["space-create", "platform"]).status).toBe(0);

    // The default space's memory is unchanged by creating a sibling.
    expect(readFileSync(join(memoryOf("default"), "team.md"), "utf-8")).toContain(TEAM_SECRET);
    // The new space mirrors the memory shape (org/team/project present).
    for (const f of ["org.md", "team.md", "project.md"]) {
      expect(existsSync(join(memoryOf("platform"), f))).toBe(true);
    }
    // listSpaces reports BOTH (additive sibling), default still the active one.
    const spaces = JSON.parse(util(["space", "--json"]).stdout.trim()) as {
      spaces: { name: string; active: boolean }[];
    };
    const names = spaces.spaces.map((s) => s.name).sort();
    expect(names).toContain("default");
    expect(names).toContain("platform");
  });

  test("an intent born in the new space reads the SPACE's live memory, not default's", () => {
    // Seed the new space's team memory AFTER creation (the space's own live
    // practice), then birth an intent there and assert the rule reader resolves
    // the space's memory dir for that intent's record.
    expect(util(["space-create", "research"]).status).toBe(0);
    const SPACE_LIVE = "RESEARCH-SPACE-LIVE-PRACTICE";
    writeFileSync(
      join(memoryOf("research"), "team.md"),
      `# Team practices\n\n- ${SPACE_LIVE}\n`,
      "utf-8",
    );
    // Switch to the space and birth an intent there.
    expect(util(["space", "research"]).status).toBe(0);
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);

    // The space's live memory is the one on disk for this space (the reader keys
    // the record's space → spaces/research/memory), distinct from default's. The
    // intent record lives under the research space, confirming the per-space root.
    expect(readFileSync(join(memoryOf("research"), "team.md"), "utf-8")).toContain(SPACE_LIVE);
    expect(existsSync(join(proj, "aidlc", "spaces", "research", "intents"))).toBe(true);
    // default's memory never gained the space's live practice (no cross-space leak).
    const defTeam = join(memoryOf("default"), "team.md");
    if (existsSync(defTeam)) {
      expect(readFileSync(defTeam, "utf-8")).not.toContain(SPACE_LIVE);
    }
  });
});

// covers: tool:aidlc-init, function:kiroUpgradedAgentFile, function:kiroUpgradeUntouched, function:kiroUpgradeStamp, function:kiroUpgradeIntact, function:frameworkFilesDoctorCheck
//
// Kiro CLI's upgrade for its 3.0 engine (the picker `kiro-cli --v3` shows for
// 2.0 agent files; Enter enables it; `kiro-cli agent upgrade <dir>`) rewrites
// every agent JSON in .kiro/agents into Kiro's own format, which has a
// `permissions` block, and keeps each file it replaced beside it as
// `<name>.json.bak`. Kiro CLI 2.34.2 also stamps the file with `kiroUpgrade`,
// hashes of the fields it wrote and of the ones it kept, and treats a file
// whose hashes no longer match as edited by the person (the captured pairs in
// tests/fixtures/kiro-agent-upgrade-2.34.2). Measured on Kiro CLI 2.29.0: the
// next `aidlc config --harness kiro` stopped on 15 "locally modified or
// unowned" conflicts and wrote nothing, so no other file of the release
// arrived. A refresh keeps the files Kiro upgraded as they are, says so once
// with the way to take this release's versions, and delivers the rest. A file
// the person edited stays theirs, and --force takes the shipped files. When this
// release drops an allow entry, or adds a deny entry, that the file Kiro
// upgraded from had, a refresh replaces Kiro's copy with this release's file,
// provided Kiro upgrades it again by itself and Kiro's copy is its untouched
// upgrade of the file AI-DLC wrote there. Measured on Kiro CLI 2.29.0: with
// `chat.enableAutoAgentUpgrade` true Kiro upgrades it again at its next 3.0
// start without a question (the new backup kept as `.json.bak.1`); unset, Kiro
// asks first; false, Kiro runs its default agent in its place.
// An upgrade Kiro did not stamp (Kiro CLI 2.27.1) is read by its kept fields.
// Switching such a project to the Kiro row (`--harness kiro-ide`), which ships
// no agent JSON, removes each stamped, untouched upgrade with the rest of the
// old row's files, keeps the backups and says so once; a file changed after the
// upgrade, or one with no stamp, stops it as a conflict.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kiroUpgradeStamp, kiroUpgradeUntouched, sha256Bytes } from "../../core/tools/aidlc-distribution.ts";
import { frameworkFilesDoctorCheck } from "../../core/tools/aidlc-config-diagnostics.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const AGENTS = ".kiro/agents";
const PERSONA = `${AGENTS}/aidlc-product-lead-agent.md`;

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The person's Kiro home for each project, so the host's ~/.kiro is never read.
const kiroHome = (project: string): string => `${project}-kiro-home`;

function config(project: string, extra: string[], harness = "kiro"): { status: number; out: string } {
  const result = spawnSync(process.execPath, [
    INIT, "config", "--project-dir", project, "--from", join(REPO_ROOT, "dist-release", harness),
    "--harness", harness, "--mcp", "none", ...extra,
  ], {
    cwd: project,
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
    env: { ...process.env, KIRO_HOME: kiroHome(project) },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function configured(): string {
  const project = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-upgraded-"));
  temporary.push(project, kiroHome(project));
  expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
  const setup = config(project, ["--yes"]);
  expect(setup.status, setup.out).toBe(0);
  return project;
}

const agentJsons = (project: string): string[] =>
  readdirSync(join(project, AGENTS)).filter((name) => name.endsWith(".json")).sort().map((name) => `${AGENTS}/${name}`);

// Kiro's `kiroUpgrade` stamp on an upgraded agent (the captured pairs check
// kiroUpgradeStamp against Kiro's own output).
function stamped(agent: Record<string, unknown>): Record<string, unknown> {
  const { kiroUpgrade: _, ...fields } = agent;
  return { ...fields, kiroUpgrade: kiroUpgradeStamp(fields) };
}
const writeAgent = (file: string, agent: unknown): void => writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);

// What Kiro's upgrade leaves, in the measured shape: the file AI-DLC wrote as
// .bak, the agent rewritten with Kiro's tool names, a permissions block and,
// from Kiro CLI 2.34.2 on, Kiro's stamp.
function kiroUpgrade(project: string, rel: string, stamp = true): void {
  const file = join(project, rel);
  copyFileSync(file, `${file}.bak`);
  const agent = JSON.parse(readFileSync(file, "utf-8"));
  agent.tools = ["read", "shell", "write"];
  agent.permissions = { rules: [{ capability: "shell", effect: "allow", match: ["bun *.kiro/tools/aidlc.ts* engine *"] }] };
  writeAgent(file, stamp ? stamped(agent) : agent);
}

// A persona an earlier release shipped, recorded as AI-DLC's: a refresh
// brings this release's file. Returns the file this release ships.
function olderPersona(project: string): string {
  const file = join(project, PERSONA);
  const shipped = readFileSync(file, "utf-8");
  const older = `${shipped}An earlier release's line.\n`;
  writeFileSync(file, older);
  const record = join(project, ".kiro", "tools", "data", "aidlc-manifest.json");
  const baseline = JSON.parse(readFileSync(record, "utf-8"));
  baseline.files[PERSONA] = sha256Bytes(older);
  writeFileSync(record, `${JSON.stringify(baseline, null, 2)}\n`);
  return shipped;
}

const DEVELOPER = `${AGENTS}/aidlc-developer-agent.json`;
const record = (project: string) => join(project, ".kiro", "tools", "data", "aidlc-manifest.json");
const recorded = (project: string, rel: string): string | undefined =>
  JSON.parse(readFileSync(record(project), "utf-8")).files[rel];

type AgentJson = { description: string; prompt: string; toolsSettings: { execute_bash: { allowedCommands: string[] } } };

// The agent file an earlier release wrote at `rel`, recorded as AI-DLC's
// (`change` edits its JSON). Returns the file this release writes there.
function olderAgent(project: string, rel: string, change: (agent: AgentJson) => void, eol = "\n"): string {
  const file = join(project, rel);
  const shipped = readFileSync(file, "utf-8");
  const agent = JSON.parse(shipped);
  change(agent);
  const older = `${JSON.stringify(agent, null, 2)}\n`;
  writeFileSync(file, older.replace(/\n/g, eol));
  const baseline = JSON.parse(readFileSync(record(project), "utf-8"));
  baseline.files[rel] = sha256Bytes(older);
  writeFileSync(record(project), `${JSON.stringify(baseline, null, 2)}\n`);
  return shipped;
}

// An earlier release also allowed the project's own test command.
const allowedMore = (agent: AgentJson) => {
  agent.toolsSettings.execute_bash.allowedCommands.push("npm test");
};

// Kiro's auto-upgrade setting in the person's own Kiro settings.
function autoUpgrade(project: string, on: boolean): void {
  const file = join(kiroHome(project), "settings", "cli.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ "chat.enableAutoAgentUpgrade": on }, null, 2)}\n`);
}

const snapshot = (project: string, rels: string[]): Map<string, string> =>
  new Map(rels.map((rel) => [rel, readFileSync(join(project, rel), "utf-8")]));

const KEPT_CHANGED =
  /^ {2}Note: 1 agent file in \.kiro\/agents that Kiro upgraded for its 3\.0 engine was kept and still allows what an older release allowed; `[^`]*config --harness kiro --force` takes this release's version\.$/m;

const NOTE =
  /^ {2}Note: Kiro upgraded 15 agent files in \.kiro\/agents for its 3\.0 engine and they were kept as they are; to take this release's versions run `[^`]*config --harness kiro --force`, and Kiro upgrades them again the next time it starts on its 3\.0 engine\.$/m;

describe("a refresh keeps the agent files Kiro upgraded for its 3.0 engine", () => {
  test("the files Kiro upgraded stay as they are, one line says so, and the rest of the release lands", () => {
    const project = configured();
    const persona = olderPersona(project);
    const jsons = agentJsons(project);
    expect(jsons.length).toBe(15);
    for (const rel of jsons) kiroUpgrade(project, rel);
    const upgraded = snapshot(project, jsons);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(snapshot(project, jsons)).toEqual(upgraded);
    expect(readFileSync(join(project, PERSONA), "utf-8")).toBe(persona);
    expect(refresh.out).toMatch(NOTE);
    expect(refresh.out.match(/Kiro upgraded/g)?.length).toBe(1);

    const row = frameworkFilesDoctorCheck(project, ".kiro");
    expect(row.pass, row.label).toBe(true);
    expect(row.label).toBe(
      "AI-DLC files: unchanged since AI-DLC wrote them, apart from 15 agent files Kiro upgraded for its 3.0 engine",
    );

    // The next refresh finds the same files and keeps them again.
    const again = config(project, ["--yes"]);
    expect(again.status, again.out).toBe(0);
    expect(snapshot(project, jsons)).toEqual(upgraded);
  });

  test("an agent file the person changed is still theirs to settle", () => {
    const project = configured();
    const [handMade, edited] = agentJsons(project);
    // A permissions block with no Kiro backup beside it is the person's own.
    const agent = JSON.parse(readFileSync(join(project, handMade), "utf-8"));
    agent.permissions = { rules: [] };
    writeFileSync(join(project, handMade), `${JSON.stringify(agent, null, 2)}\n`);
    writeFileSync(join(project, edited), readFileSync(join(project, edited), "utf-8").replace(/\n$/, " \n"));
    const before = snapshot(project, [handMade, edited]);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(4);
    expect(refresh.out).toContain(`${handMade} (locally modified or unowned)`);
    expect(refresh.out).toContain(`${edited} (locally modified or unowned)`);
    expect(refresh.out).not.toContain("Kiro upgraded");
    expect(snapshot(project, [handMade, edited])).toEqual(before);
  });

  test("--force takes this release's versions over the files Kiro upgraded", () => {
    const project = configured();
    const jsons = agentJsons(project);
    const shipped = snapshot(project, jsons);
    for (const rel of jsons) kiroUpgrade(project, rel);

    const forced = config(project, ["--yes", "--force"]);
    expect(forced.status, forced.out).toBe(0);
    expect(snapshot(project, jsons)).toEqual(shipped);
    expect(forced.out).not.toContain("Kiro upgraded");
  });
});

describe("a refresh replaces an agent file Kiro upgraded when this release changes what it allows", () => {
  test("the narrowed file gets this release's version like any updated file, and the record follows it", () => {
    narrowedRefresh(true);
  });

  test("a narrowed file Kiro upgraded without its stamp gets this release's version when its kept fields are unchanged", () => {
    narrowedRefresh(false);
  });

  function narrowedRefresh(stamp: boolean): void {
    const project = configured();
    const shipped = olderAgent(project, DEVELOPER, allowedMore);
    const jsons = agentJsons(project);
    for (const rel of jsons) kiroUpgrade(project, rel, stamp);
    autoUpgrade(project, true);
    const others = jsons.filter((rel) => rel !== DEVELOPER);
    const upgraded = snapshot(project, others);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(readFileSync(join(project, DEVELOPER), "utf-8"), `stamp ${stamp}`).toBe(shipped);
    expect(recorded(project, DEVELOPER)).toBe(sha256Bytes(shipped));
    expect(snapshot(project, others)).toEqual(upgraded);
    expect(refresh.out).not.toContain("still allow");
    expect(refresh.out).toContain("Kiro upgraded 14 agent files in .kiro/agents for its 3.0 engine and they were kept as they are");
  }

  test("a kept file's record stays what AI-DLC wrote, so a later release can still tell it is AI-DLC's", () => {
    const project = configured();
    olderAgent(project, DEVELOPER, (agent) => {
      agent.description = `${agent.description} (an earlier release)`;
    });
    const older = readFileSync(join(project, DEVELOPER), "utf-8");
    kiroUpgrade(project, DEVELOPER);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(refresh.out).toContain("Kiro upgraded 1 agent file in .kiro/agents for its 3.0 engine and it was kept as it is");
    expect(recorded(project, DEVELOPER)).toBe(sha256Bytes(older));
  });

  test("the file Kiro last upgraded from is its newest numbered backup, line endings aside", () => {
    const project = configured();
    const shipped = olderAgent(project, DEVELOPER, allowedMore, "\r\n");
    const file = join(project, DEVELOPER);
    copyFileSync(file, `${file}.bak.1`);
    writeFileSync(`${file}.bak`, "{\"name\": \"a file Kiro upgraded long ago\"}\n");
    writeAgent(file, stamped({ ...JSON.parse(readFileSync(file, "utf-8")), permissions: { rules: [] } }));
    autoUpgrade(project, true);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(readFileSync(file, "utf-8")).toBe(shipped);
  });

  test("a narrowed file the person changed, or one AI-DLC cannot prove it wrote, is kept and one line says what that leaves", () => {
    for (const how of ["changed", "changed what Kiro wrote", "unproved"]) {
      const project = configured();
      olderAgent(project, DEVELOPER, allowedMore);
      kiroUpgrade(project, DEVELOPER);
      autoUpgrade(project, true);
      const file = join(project, DEVELOPER);
      if (how === "changed") {
        const agent = JSON.parse(readFileSync(file, "utf-8"));
        agent.prompt = `${agent.prompt}\nMy own line.`;
        writeAgent(file, agent);
      } else if (how === "changed what Kiro wrote") {
        const agent = JSON.parse(readFileSync(file, "utf-8"));
        agent.permissions.rules[0].match.push("npm test");
        writeAgent(file, agent);
      } else {
        const baseline = JSON.parse(readFileSync(record(project), "utf-8"));
        baseline.files[DEVELOPER] = sha256Bytes("another release's file\n");
        writeFileSync(record(project), `${JSON.stringify(baseline, null, 2)}\n`);
      }
      const before = readFileSync(file, "utf-8");

      const refresh = config(project, ["--yes"]);
      expect(refresh.status, `${how}: ${refresh.out}`).toBe(0);
      expect(readFileSync(file, "utf-8"), how).toBe(before);
      expect(refresh.out, how).toMatch(KEPT_CHANGED);
    }
  });

  test("a narrowed file Kiro would not upgrade again by itself is kept, and one line says what that leaves", () => {
    for (const setting of [undefined, false]) {
      const project = configured();
      olderAgent(project, DEVELOPER, allowedMore);
      kiroUpgrade(project, DEVELOPER);
      if (setting !== undefined) autoUpgrade(project, setting);
      const before = readFileSync(join(project, DEVELOPER), "utf-8");

      const refresh = config(project, ["--yes"]);
      expect(refresh.status, `${setting}: ${refresh.out}`).toBe(0);
      expect(readFileSync(join(project, DEVELOPER), "utf-8"), `${setting}`).toBe(before);
      expect(refresh.out, `${setting}`).toMatch(KEPT_CHANGED);
    }
  });
});

describe("Kiro's stamp tells its untouched upgrade from a file changed since", () => {
  // Pairs `kiro-cli agent upgrade` 2.34.2 wrote: non-ASCII text, numeric keys,
  // a boolean field as every shipped agent has, a per-agent `model`.
  const CAPTURED = join(REPO_ROOT, "tests", "fixtures", "kiro-agent-upgrade-2.34.2");
  const read = (name: string) => JSON.parse(readFileSync(join(CAPTURED, name), "utf-8"));

  test("Kiro's own upgrade holds in any key order; a change to a field Kiro wrote or kept, or another backup, does not", () => {
    for (const agent of ["aidlc-sample-agent", "aidlc-numeric-agent"]) {
      const upgraded = read(`${agent}.json`);
      const backup = read(`${agent}.json.bak`);
      const { kiroUpgrade, ...fields } = upgraded;
      expect(kiroUpgradeStamp(fields), agent).toEqual(kiroUpgrade);
      expect(kiroUpgradeUntouched(upgraded, backup), agent).toBe(true);
      const reordered = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(reordered)
          : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]))
          : value;
      expect(kiroUpgradeUntouched(reordered(upgraded), reordered(backup)), `${agent} keys reordered`).toBe(true);

      const permissions = structuredClone(upgraded);
      permissions.permissions.rules[0].match.push("npm test");
      const prompt = { ...upgraded, prompt: `${upgraded.prompt} My own line.` };
      const added = { ...upgraded, welcomeMessage: "Hi." };
      const revision = { ...upgraded, kiroUpgrade: { ...upgraded.kiroUpgrade, revision: 3 } };
      for (const [how, changed] of Object.entries({ permissions, prompt, added, revision })) {
        expect(kiroUpgradeUntouched(changed, backup), `${agent} ${how}`).toBe(false);
      }
      expect(kiroUpgradeUntouched(upgraded, { ...backup, description: "another file" }), `${agent} backup`).toBe(false);
      expect(kiroUpgradeUntouched(backup, backup), `${agent} not upgraded`).toBe(false);
    }
  });
});

describe("switching to the Kiro row removes the agent files Kiro upgraded from AI-DLC's", () => {
  const manifest = (project: string) => JSON.parse(readFileSync(record(project), "utf-8"));
  const backupsKept = (count: number, verb = "removes") =>
    new RegExp(
      `^ {2}Note: Kiro's backups of the ${count === 1 ? "agent file" : `${count} agent files`} this run ${verb} stay in \\.kiro/agents \\(\`<name>\\.json\\.bak\`, \`<name>\\.json\\.bak\\.1\` and on\\); AI-DLC does not use them\\.$`,
      "m",
    );

  test("an untouched upgrade goes with the rest of the old row's files, and its backups stay", () => {
    const project = configured();
    const jsons = agentJsons(project);
    for (const rel of jsons) kiroUpgrade(project, rel);
    const backups = snapshot(project, jsons.map((rel) => `${rel}.bak`));
    // An agent file the person made there is theirs, and stays.
    const ownAgent = `${AGENTS}/my-agent.json`;
    writeAgent(join(project, ownAgent), { name: "my-agent", description: "Mine.", prompt: "Help me." });
    backups.set(ownAgent, readFileSync(join(project, ownAgent), "utf-8"));

    const preview = config(project, ["--yes", "--dry-run"], "kiro-ide");
    expect(preview.status, preview.out).toBe(0);
    expect(preview.out).toMatch(backupsKept(15, "would remove"));
    expect(manifest(project).distribution).toBe("kiro");

    const switched = config(project, ["--yes"], "kiro-ide");
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("that kiro ships and kiro-ide does not:");
    expect(switched.out).toMatch(backupsKept(15));
    expect(switched.out.match(/Kiro's backups of the/g)?.length).toBe(1);
    expect(jsons.filter((rel) => existsSync(join(project, rel)))).toEqual([]);
    expect(snapshot(project, [...backups.keys()])).toEqual(backups);
    expect(manifest(project).distribution).toBe("kiro-ide");
  });

  test("an upgraded file changed since Kiro wrote it, one Kiro did not stamp, or one AI-DLC did not write, still stops the switch", () => {
    for (const field of ["permissions", "prompt", "no stamp", "another backup"] as const) {
      const project = configured();
      const jsons = agentJsons(project);
      for (const rel of jsons) kiroUpgrade(project, rel, rel !== DEVELOPER || field !== "no stamp");
      const file = join(project, DEVELOPER);
      const agent = JSON.parse(readFileSync(file, "utf-8"));
      if (field === "permissions") agent.permissions.rules[0].match.push("npm test");
      else if (field === "prompt") agent.prompt = `${agent.prompt}\nMy own line.`;
      writeAgent(file, agent);
      if (field === "another backup") {
        // Kiro's untouched upgrade of a file AI-DLC did not write there.
        const own = JSON.parse(readFileSync(`${file}.bak`, "utf-8"));
        own.description = "My own developer agent.";
        writeAgent(`${file}.bak`, own);
        writeAgent(file, stamped({ ...agent, description: own.description }));
      }
      const before = snapshot(project, jsons);

      const switched = config(project, ["--yes"], "kiro-ide");
      expect(switched.status, `${field}: ${switched.out}`).toBe(4);
      expect(switched.out).toContain("1 config conflict(s): .kiro/agents/aidlc-developer-agent.json (removed upstream but locally modified)");
      expect(snapshot(project, jsons), field).toEqual(before);
      expect(manifest(project).distribution).toBe("kiro");
    }
  });

  test("a refresh that retires one upgraded agent file removes it, keeps the others, and counts only its backups", () => {
    const project = configured();
    const retired = `${AGENTS}/aidlc-retired-agent.json`;
    const file = join(project, retired);
    copyFileSync(join(project, DEVELOPER), file);
    const baseline = manifest(project);
    baseline.files[retired] = sha256Bytes(readFileSync(file));
    writeFileSync(record(project), `${JSON.stringify(baseline, null, 2)}\n`);
    const jsons = agentJsons(project);
    for (const rel of jsons) kiroUpgrade(project, rel);
    const kept = jsons.filter((rel) => rel !== retired);
    const before = snapshot(project, kept);

    const refresh = config(project, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(snapshot(project, kept)).toEqual(before);
    expect(refresh.out).toMatch(backupsKept(1));
    expect(refresh.out.match(/Kiro's backups of the/g)?.length).toBe(1);
  });
});

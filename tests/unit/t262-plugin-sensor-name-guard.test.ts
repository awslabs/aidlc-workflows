// covers: file:scripts/plugin-hooks-template/compose.ts (sensorManifestNamePrecheck)
//
// t262 - the plugin sensor-manifest name guard. Sensor discovery
// (aidlc-graph.ts loadSensors / SENSOR_FILE_REGEX) does a FLAT scan of
// <harness>/sensors/ and indexes ONLY basenames matching `aidlc-<id>.md`;
// anything else is silently skipped. The compose hook copies a plugin's
// sensors/ tree with no-clobber, and - before this guard - shipped no
// precheck there (unlike stages/scopes/agents). So a plugin manifest under
// any OTHER name, or one nested in a subdirectory the flat scan never reads,
// composed successfully (the file landed) but was never picked up by graph
// compile or sensor dispatch, with no signal to the author.
//
// This test spawns the REAL authored compose hook against a fresh copy of the
// shipped Claude harness, composing a synthetic plugin that ships three sensor
// manifests: a well-named one (aidlc-<id>.md at the top of sensors/), a
// wrong-prefix one, and a properly-prefixed one nested in a subdirectory. It
// asserts (1) each undiscoverable manifest produces a [degraded] compose drop
// naming the file and the required shape, (2) those files never land in the
// install, (3) compose still exits 0 (fail-open - never breaks the session)
// and the graph recompiles, and (4) the well-named manifest lands AND is
// discovered by the real sensor loader (`aidlc-sensor list`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const COMPOSE_HOOK = join(REPO_ROOT, "scripts", "plugin-hooks-template", "compose.ts");
const SENSOR_TOOL = join(CLAUDE_DIST, "tools", "aidlc-sensor.ts");
const BUN = process.execPath; // the bun running this test
const TIMEOUT_MS = 60_000;

// A well-named manifest at the top of sensors/ (stem after `aidlc-` == id).
const GOOD_MANIFEST = `---
id: t262-good
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-t262-good.ts
default_severity: advisory
description: A well-named plugin sensor manifest for the t262 fixture
category: code-quality
matches: "**/*.ts"
---

# t262 good sensor

Discoverable: matches aidlc-<id>.md at the top of sensors/.
`;

// Wrong prefix - discovery (SENSOR_FILE_REGEX) never indexes this basename.
const WRONG_PREFIX_MANIFEST = `---
id: t262-bad
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-t262-bad.ts
default_severity: advisory
description: A mis-named plugin sensor manifest discovery would never index
matches: "**/*.ts"
---

# t262 bad sensor

Undiscoverable: no aidlc- prefix, so the flat scan skips it silently.
`;

// Properly prefixed but NESTED - the flat top-level scan never reads it.
const NESTED_MANIFEST = `---
id: t262-nested
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-t262-nested.ts
default_severity: advisory
description: A prefixed but nested plugin sensor manifest the flat scan misses
matches: "**/*.ts"
---

# t262 nested sensor

Undiscoverable: nested one level down, below the flat scan's reach.
`;

interface ComposeOutcome {
  status: number;
  drops: string;
  proj: string;
}

let tmp: string;

/**
 * Compose a synthetic plugin (a minimal plugin.json plus the given sensor
 * files) into a fresh copy of the shipped Claude harness via the real authored
 * compose hook, and return the exit status plus the aggregated drops.
 */
function composePlugin(files: Record<string, string>): ComposeOutcome {
  const proj = mkdtempSync(join(tmp, "proj-"));
  cpSync(CLAUDE_DIST, join(proj, ".claude"), { recursive: true });

  const root = join(proj, "_plugin");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "t262-sensornames",
      version: "0.0.1",
      aidlc: { contributes: { sensors: "sensors/", tools: "tools/" } },
    }),
  );
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }

  const r = spawnSync(BUN, [COMPOSE_HOOK], {
    cwd: proj,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_HARNESS_DIR: ".claude",
    },
  });

  // Drops files are per-plugin (`plugin-compose-<key>.drops`) - aggregate them.
  let drops = "";
  const hd = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
  if (existsSync(hd)) {
    for (const f of readdirSync(hd)) {
      if (f.startsWith("plugin-compose") && f.endsWith(".drops")) {
        drops += readFileSync(join(hd, f), "utf-8");
      }
    }
  }
  return { status: r.status ?? -1, drops, proj };
}

/** Run the shipped sensor loader's `list` against a composed project's sensors
 *  dir and return the discovered id column. */
function discoveredSensorIds(proj: string): string[] {
  const r = spawnSync(BUN, [SENSOR_TOOL, "list"], {
    cwd: proj,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_SENSORS_DIR: join(proj, ".claude", "sensors"),
    },
  });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.split("\t")[0]?.trim())
    .filter((id): id is string => Boolean(id));
}

describe("t262 plugin sensor-manifest name guard", () => {
  let outcome: ComposeOutcome;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t262-"));
    outcome = composePlugin({
      "sensors/aidlc-t262-good.md": GOOD_MANIFEST,
      "sensors/t262-bad.md": WRONG_PREFIX_MANIFEST,
      "sensors/subdir/aidlc-t262-nested.md": NESTED_MANIFEST,
    });
  }, TIMEOUT_MS);

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("compose stays fail-open (exit 0) despite the undiscoverable manifests", () => {
    expect(outcome.status).toBe(0);
  });

  test("a wrong-prefix manifest drops-with-log naming the file and required shape", () => {
    expect(outcome.drops).toContain("[degraded]");
    expect(outcome.drops).toContain("t262-bad.md");
    expect(outcome.drops).toContain('lacks the required "aidlc-" prefix');
    expect(outcome.drops).toContain('aidlc-<id>.md');
  });

  test("a nested (but prefixed) manifest drops-with-log for the flat-scan miss", () => {
    expect(outcome.drops).toContain("subdir/aidlc-t262-nested.md");
    expect(outcome.drops).toContain("nested in a subdirectory");
  });

  test("the undiscoverable manifests never land in the install", () => {
    expect(existsSync(join(outcome.proj, ".claude", "sensors", "t262-bad.md"))).toBe(false);
    expect(
      existsSync(join(outcome.proj, ".claude", "sensors", "subdir", "aidlc-t262-nested.md")),
    ).toBe(false);
  });

  test("the well-named manifest lands and is discovered by the real sensor loader", () => {
    const landed = join(outcome.proj, ".claude", "sensors", "aidlc-t262-good.md");
    expect(existsSync(landed)).toBe(true);
    // {{HARNESS_DIR}} was substituted on copy (the composed manifest is real).
    expect(readFileSync(landed, "utf-8")).toContain("bun .claude/tools/aidlc-sensor-t262-good.ts");
    const ids = discoveredSensorIds(outcome.proj);
    expect(ids).toContain("t262-good");
    expect(ids).not.toContain("t262-bad");
    expect(ids).not.toContain("t262-nested");
  });
});

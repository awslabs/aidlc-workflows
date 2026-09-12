// covers: function:resolveCeremony, function:resolveCeremonyPolicy,
// function:ceremonyPolicyValues, function:parseCeremonySetting,
// function:parseCeremonyStateLine, function:formatCeremony,
// function:scopeCeremonyDefault, function:loadScopeMetadataAll,
// function:checkSummaryConfirmationEvidence

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CEREMONY_ENV,
  CEREMONY_FIELDS,
  CEREMONY_KEYS,
  ceremonyPolicyValues,
  checkSummaryConfirmationEvidence,
  formatCeremony,
  loadScopeMetadataAll,
  loadStageGraph,
  parseCeremonySetting,
  parseCeremonyStateLine,
  resolveCeremony,
  resolveCeremonyPolicy,
  scopeCeremonyDefault,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const POLICY_ENV = {
  AIDLC_HARNESS_DIR: AIDLC_SRC,
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(import.meta.dir, "..", "..", "core", "scopes"),
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_DISABLE_LEARNINGS: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "0",
};
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

describe("t337 ceremony resolution", () => {
  for (const key of CEREMONY_KEYS) {
    test(`${key}: kill switch beats intent, scope, and fallback`, () => {
      withEnvAndFreshCaches(POLICY_ENV, () => {
        const intent = `- **${CEREMONY_FIELDS[key]}**: on (set by you)\n`;
        expect(resolveCeremony(key, "classic", "")).toMatchObject({
          value: "off",
          source: "scope classic",
        });
        expect(resolveCeremony(key, "classic", intent)).toMatchObject({
          value: "on",
          source: "you",
          scopeDefault: "off",
        });
        process.env[CEREMONY_ENV[key]] = "1";
        expect(resolveCeremony(key, "classic", intent)).toMatchObject({
          value: "off",
          source: `env ${CEREMONY_ENV[key]}`,
          intent: { value: "on", source: "you" },
        });
        process.env[CEREMONY_ENV[key]] = "0";
        expect(resolveCeremony(key, "classic", intent).value).toBe("on");
        expect(resolveCeremony(key, "feature", "")).toMatchObject({
          value: "on",
          source: "default",
        });
      });
    });
  }

  test("malformed intent values fall through and remain visible for diagnosis", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(resolveCeremony("sensors", "classic", "- **Sensors**: maybe (set by you)\n")).toEqual({
        key: "sensors",
        value: "off",
        source: "scope classic",
        scopeDefault: "off",
        intent: null,
        rawStateValue: "maybe (set by you)",
      });
      expect(resolveCeremony("sensors", "unknown-scope", undefined)).toMatchObject({
        value: "on",
        source: "default",
        rawStateValue: null,
      });
    });
  });

  test("independent switches preserve mixed per-intent choices", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const state = "- **Learnings**: on (set by you)\n";
      expect(ceremonyPolicyValues("classic", state)).toEqual({
        sensors: "off",
        learnings: "on",
        summary_confirmation: "off",
      });
      expect(resolveCeremonyPolicy("classic", state).learnings.source).toBe("you");
    });
  });
});

describe("t337 ceremony grammar", () => {
  test("setting normalization and state labels follow Change Control grammar", () => {
    expect(parseCeremonySetting(" **ON** ")).toBe("on");
    expect(parseCeremonySetting("off")).toBe("off");
    expect(parseCeremonyStateLine("off (from scope classic)")).toEqual({
      value: "off",
      source: "scope classic",
    });
    expect(parseCeremonyStateLine("ON (set by you)")).toEqual({
      value: "on",
      source: "you",
    });
    expect(parseCeremonyStateLine("off")).toEqual({ value: "off", source: "you" });
    expect(formatCeremony("off", "scope classic")).toBe("off (from scope classic)");
    expect(formatCeremony("on", "you")).toBe("on (set by you)");
  });

  test("unsupported values and incomplete state lines are ignored", () => {
    expect(parseCeremonySetting("maybe")).toBeNull();
    expect(parseCeremonySetting(null)).toBeNull();
    expect(parseCeremonyStateLine("off extra")).toBeNull();
    expect(parseCeremonyStateLine("on (set by you")).toBeNull();
    expect(parseCeremonyStateLine(undefined)).toBeNull();
  });
});

describe("t337 scope ceremony metadata", () => {
  test("classic supplies the v1 defaults while missing scope settings stay on", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(loadScopeMetadataAll().classic).toMatchObject({
        skeleton: false,
        reviewCap: "none",
        changeControl: "relaxed",
        ceremony: { sensors: "off", learnings: "off", summary_confirmation: "off" },
      });
      expect(scopeCeremonyDefault("sensors", "classic")).toBe("off");
      expect(scopeCeremonyDefault("sensors", null)).toBe("on");
    });
  });

  test("declared on has a scope source, unlike an omitted key", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    mkdirSync(scopes);
    writeFileSync(join(scopes, "aidlc-custom.md"), [
      "---", "name: custom", "depth: Standard", "sensors: on", "learnings: off", "---", "",
    ].join("\n"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      expect(resolveCeremony("sensors", "custom", "")).toMatchObject({ value: "on", source: "scope custom" });
      expect(resolveCeremony("learnings", "custom", "")).toMatchObject({ value: "off", source: "scope custom" });
      expect(resolveCeremony("summary_confirmation", "custom", "")).toMatchObject({ value: "on", source: "default" });
    });
  });

  for (const key of CEREMONY_KEYS) {
    test(`invalid ${key} names the scope file and allowed values`, () => {
      const proj = createTestProject();
      tempDirs.push(proj);
      const scopes = join(proj, "scopes");
      mkdirSync(scopes);
      const path = join(scopes, "aidlc-invalid.md");
      writeFileSync(path, `---\nname: invalid\ndepth: Standard\n${key}: maybe\n---\n`);
      expect(() => withEnvAndFreshCaches(
        { ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes },
        () => loadScopeMetadataAll(),
      )).toThrow(`Scope file ${path} has invalid ${key} value "maybe". Expected "on" or "off".`);
    });
  }
});

describe("t337 summary confirmation policy", () => {
  test("classic can finish without a summary receipt, but intent on restores the checkpoint", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const stage = loadStageGraph().find((entry) => entry.slug === "requirements-analysis")!;
      const state = "- **Scope**: classic\n";
      expect(checkSummaryConfirmationEvidence(proj, stage, { stateContent: state })).toEqual({
        ok: true,
        required: false,
      });
      const enabled = checkSummaryConfirmationEvidence(proj, stage, {
        stateContent: `${state}- **Summary Confirmation**: on (set by you)\n`,
      });
      expect(enabled).toMatchObject({ ok: false, summaryCoverage: "missing" });
    });
  });
});

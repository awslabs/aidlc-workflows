import {
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ModelAgentPolicy,
  ModelHarness,
  ModelPolicyRecord,
} from "./aidlc-model-policy.ts";

export const SETTINGS_FILE = "aidlc.settings.json";
export const LOCAL_SETTINGS_FILE = "aidlc.settings.local.json";

export type SettingsSource =
  | "shipped default"
  | "machine"
  | "project"
  | "local"
  | "env";
export type SettingsLayer = Exclude<SettingsSource, "shipped default" | "env">;
export type SettingsTarget = "global" | "project" | "local";

export const RECORDABLE_PROJECT_BYPASSES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_SKIP_REVISION_BACKSTOP",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
  "AIDLC_DISABLE_ENSEMBLE_EVIDENCE",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_USAGE_TRACKING",
] as const;

export type RecordableProjectBypass =
  (typeof RECORDABLE_PROJECT_BYPASSES)[number];

export type ProjectFlagsRecord = {
  schemaVersion: 1;
  defaultScope?: string;
  swarm?: boolean;
  hookDebug?: boolean;
  sensorTimeoutMs?: number;
  bypasses?: RecordableProjectBypass[];
};

export type HarnessModelMap = Partial<Record<ModelHarness, string>>;
export type SettingsModelAgentPolicy = Omit<ModelAgentPolicy, "model"> & {
  model?: HarnessModelMap;
};
export type SettingsModelPolicyRecord = Omit<ModelPolicyRecord, "agents"> & {
  agents?: Record<string, SettingsModelAgentPolicy>;
};

export type AidlcSettingsFile = {
  $schema?: string;
  schemaVersion: 1;
  models?: SettingsModelPolicyRecord;
  flags?: ProjectFlagsRecord;
  "update-check"?: boolean;
  offline?: boolean;
  "release-base-url"?: string;
  "ca-bundle"?: string;
};

export type ResolvedAidlcSettings = {
  value: AidlcSettingsFile;
  models: SettingsModelPolicyRecord | null;
  flags: ProjectFlagsRecord | null;
  sources: Record<string, SettingsSource>;
  files: Record<SettingsLayer, { path: string; present: boolean }>;
};

const MACHINE_KEYS = [
  "update-check",
  "offline",
  "release-base-url",
  "ca-bundle",
] as const;
export type MachineSettingsKey = (typeof MACHINE_KEYS)[number];

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "models",
  "flags",
  ...MACHINE_KEYS,
]);
const PROJECT_FLAG_KEYS = new Set([
  "schemaVersion",
  "defaultScope",
  "swarm",
  "hookDebug",
  "sensorTimeoutMs",
  "bypasses",
]);
const MODEL_KEYS = new Set(["schemaVersion", "preset", "groups", "agents", "profiles"]);
const MODEL_GROUPS = ["deciding", "reviewing", "writing-up"] as const;
const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODEL_PRESETS = ["thorough", "balanced", "minimal"] as const;
const MODEL_HARNESSES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

type CacheEntry = {
  value: AidlcSettingsFile | null;
};

const settingsCache = new Map<string, CacheEntry>();
let settingsStatCount = 0;
let settingsReadCount = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validReleaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"));
  } catch {
    return false;
  }
}

export function normalizeProjectFlagsRecord(
  value: unknown,
  where = "flags",
): ProjectFlagsRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  if (value.schemaVersion !== 1) {
    throw new Error(`${where}.schemaVersion must be 1`);
  }
  const unknown = Object.keys(value).filter((key) => !PROJECT_FLAG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`${where} has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: ProjectFlagsRecord = { schemaVersion: 1 };
  if (value.defaultScope !== undefined) {
    if (
      typeof value.defaultScope !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(value.defaultScope)
    ) {
      throw new Error(`${where}.defaultScope must be a scope name`);
    }
    out.defaultScope = value.defaultScope;
  }
  for (const key of ["swarm", "hookDebug"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${where}.${key} must be true or false`);
    }
    if (typeof value[key] === "boolean") out[key] = value[key];
  }
  if (value.sensorTimeoutMs !== undefined) {
    if (
      typeof value.sensorTimeoutMs !== "number" ||
      !Number.isInteger(value.sensorTimeoutMs) ||
      value.sensorTimeoutMs <= 0
    ) {
      throw new Error(`${where}.sensorTimeoutMs must be a positive integer`);
    }
    out.sensorTimeoutMs = value.sensorTimeoutMs;
  }
  if (value.bypasses !== undefined) {
    if (
      !Array.isArray(value.bypasses) ||
      value.bypasses.some((item) =>
        typeof item !== "string" ||
        !(RECORDABLE_PROJECT_BYPASSES as readonly string[]).includes(item)
      )
    ) {
      throw new Error(
        `${where}.bypasses must contain only ${RECORDABLE_PROJECT_BYPASSES.join(", ")}`,
      );
    }
    out.bypasses = [
      ...new Set(value.bypasses as RecordableProjectBypass[]),
    ].sort();
  }
  return out;
}

function normalizeHarnessModelMap(value: unknown, where: string): HarnessModelMap {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object keyed by harness`);
  }
  const out: HarnessModelMap = {};
  for (const [harness, model] of Object.entries(value)) {
    if (!(MODEL_HARNESSES as readonly string[]).includes(harness)) {
      throw new Error(`${where} has unknown harness ${JSON.stringify(harness)}`);
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new Error(`${where}.${harness} must be a non-empty model ID`);
    }
    out[harness as ModelHarness] = model.trim();
  }
  return out;
}

export function normalizeSettingsModels(
  value: unknown,
  where = "models",
): SettingsModelPolicyRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  if (value.schemaVersion !== 1) throw new Error(`${where}.schemaVersion must be 1`);
  const unknown = Object.keys(value).filter((key) => !MODEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`${where} has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: SettingsModelPolicyRecord = { schemaVersion: 1 };
  if (value.preset !== undefined) {
    if (
      typeof value.preset !== "string" ||
      !(MODEL_PRESETS as readonly string[]).includes(value.preset)
    ) {
      throw new Error(`${where}.preset must be one of ${MODEL_PRESETS.join(", ")}`);
    }
    out.preset = value.preset;
  }
  const normalizeGroups = (
    raw: unknown,
    groupWhere: string,
  ): NonNullable<ModelPolicyRecord["groups"]> => {
    if (!isRecord(raw)) throw new Error(`${groupWhere} must be an object`);
    const groups: NonNullable<ModelPolicyRecord["groups"]> = {};
    for (const [name, policy] of Object.entries(raw)) {
      if (!(MODEL_GROUPS as readonly string[]).includes(name)) {
        throw new Error(`${groupWhere} has unknown group ${JSON.stringify(name)}`);
      }
      if (
        !isRecord(policy) ||
        Object.keys(policy).some((key) => key !== "effort") ||
        typeof policy.effort !== "string" ||
        !(MODEL_EFFORTS as readonly string[]).includes(policy.effort)
      ) {
        throw new Error(`${groupWhere}.${name} must contain one valid effort`);
      }
      Object.assign(groups, {
        [name]: { effort: policy.effort },
      });
    }
    return groups;
  };
  if (value.groups !== undefined) out.groups = normalizeGroups(value.groups, `${where}.groups`);
  const agents: Record<string, SettingsModelAgentPolicy> = {};
  if (value.agents !== undefined) {
    if (!isRecord(value.agents)) throw new Error(`${where}.agents must be an object`);
    for (const [name, raw] of Object.entries(value.agents)) {
      if (!PROFILE_NAME.test(name) || !isRecord(raw)) {
        throw new Error(`${where}.agents has invalid agent ${JSON.stringify(name)}`);
      }
      const agentUnknown = Object.keys(raw).filter((key) =>
        key !== "effort" && key !== "model"
      );
      if (agentUnknown.length > 0) {
        throw new Error(`${where}.agents.${name} has unknown key(s): ${agentUnknown.join(", ")}`);
      }
      if (
        raw.effort !== undefined &&
        (
          typeof raw.effort !== "string" ||
          !(MODEL_EFFORTS as readonly string[]).includes(raw.effort)
        )
      ) {
        throw new Error(`${where}.agents.${name}.effort must be valid`);
      }
      const model = raw.model === undefined
        ? undefined
        : normalizeHarnessModelMap(raw.model, `${where}.agents.${name}.model`);
      if (raw.effort !== undefined || (model && Object.keys(model).length > 0)) {
        const effort = raw.effort as ModelAgentPolicy["effort"];
        agents[name] = {
          ...(effort !== undefined ? { effort } : {}),
          ...(model && Object.keys(model).length > 0 ? { model } : {}),
        };
      }
    }
  }
  if (Object.keys(agents).length > 0) out.agents = agents;
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) throw new Error(`${where}.profiles must be an object`);
    const profiles: NonNullable<ModelPolicyRecord["profiles"]> = {};
    for (const [name, raw] of Object.entries(value.profiles)) {
      if (
        !PROFILE_NAME.test(name) ||
        !isRecord(raw) ||
        Object.keys(raw).some((key) => key !== "groups") ||
        raw.groups === undefined
      ) {
        throw new Error(`${where}.profiles.${name} must contain only groups`);
      }
      profiles[name] = {
        groups: normalizeGroups(raw.groups, `${where}.profiles.${name}.groups`),
      };
    }
    if (Object.keys(profiles).length > 0) out.profiles = profiles;
  }
  return out;
}

export function normalizeAidlcSettings(
  value: unknown,
  layer: SettingsLayer,
  path: string,
): AidlcSettingsFile {
  if (!isRecord(value)) throw new Error(`${path}: settings must be a JSON object`);
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path}: settings contain unknown key(s): ${unknown.join(", ")}`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${path}: settings.schemaVersion must be 1`);
  }
  if (
    value.$schema !== undefined &&
    (typeof value.$schema !== "string" || value.$schema.trim().length === 0)
  ) {
    throw new Error(`${path}: settings.$schema must be a non-empty string`);
  }
  const machineOnly = MACHINE_KEYS.filter((key) => value[key] !== undefined);
  if (layer !== "machine" && machineOnly.length > 0) {
    throw new Error(
      `${path}: ${machineOnly.join(", ")} ${
        machineOnly.length === 1 ? "is" : "are"
      } machine-only; write ${machineSettingsPath()} instead`,
    );
  }
  for (const key of ["update-check", "offline"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${path}: settings.${key} must be true or false`);
    }
  }
  if (
    value["release-base-url"] !== undefined &&
    (
      typeof value["release-base-url"] !== "string" ||
      !validReleaseUrl(value["release-base-url"])
    )
  ) {
    throw new Error(
      `${path}: settings.release-base-url must be HTTPS without credentials, query, or fragment`,
    );
  }
  if (
    value["ca-bundle"] !== undefined &&
    (
      typeof value["ca-bundle"] !== "string" ||
      !isAbsolute(value["ca-bundle"])
    )
  ) {
    throw new Error(`${path}: settings.ca-bundle must be an absolute path`);
  }
  const models = normalizeSettingsModels(value.models, `${path}: models`);
  const flags = normalizeProjectFlagsRecord(value.flags, `${path}: flags`);
  return {
    ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    schemaVersion: 1,
    ...(models ? { models } : {}),
    ...(flags ? { flags } : {}),
    ...(typeof value["update-check"] === "boolean"
      ? { "update-check": value["update-check"] }
      : {}),
    ...(typeof value.offline === "boolean" ? { offline: value.offline } : {}),
    ...(typeof value["release-base-url"] === "string"
      ? { "release-base-url": value["release-base-url"].replace(/\/+$/, "") }
      : {}),
    ...(typeof value["ca-bundle"] === "string"
      ? { "ca-bundle": value["ca-bundle"] }
      : {}),
  };
}

export function machineSettingsPath(): string {
  const explicit = process.env.AIDLC_INSTALL_ROOT?.trim();
  const root = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolve(process.cwd(), explicit)
    : platform() === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "aidlc")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "aidlc");
  return join(root, SETTINGS_FILE);
}

export function projectSettingsPath(projectDir: string): string {
  return join(projectDir, SETTINGS_FILE);
}

export function localSettingsPath(projectDir: string): string {
  return join(projectDir, LOCAL_SETTINGS_FILE);
}

export function settingsPathForTarget(
  projectDir: string,
  target: SettingsTarget,
): string {
  return target === "global"
    ? machineSettingsPath()
    : target === "local"
    ? localSettingsPath(projectDir)
    : projectSettingsPath(projectDir);
}

function layerForTarget(target: SettingsTarget): SettingsLayer {
  return target === "global" ? "machine" : target;
}

function readCached(path: string, layer: SettingsLayer): AidlcSettingsFile | null {
  const cached = settingsCache.get(path);
  if (cached) return cached.value;
  settingsStatCount++;
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      settingsCache.set(path, { value: null });
      return null;
    }
    throw error;
  }
  if (!stat) {
    settingsCache.set(path, { value: null });
    return null;
  }
  if (!stat.isFile()) throw new Error(`${path}: settings path is not a regular file`);
  settingsReadCount++;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = normalizeAidlcSettings(parsed, layer, path);
  settingsCache.set(path, { value });
  return value;
}

export function readSettingsTarget(
  projectDir: string,
  target: SettingsTarget,
): AidlcSettingsFile | null {
  return readCached(settingsPathForTarget(projectDir, target), layerForTarget(target));
}

function mergeLeafValues(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  origin: SettingsLayer,
  origins: Record<string, SettingsSource>,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema" || (key === "schemaVersion" && prefix === "")) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      const nested = isRecord(target[key]) ? target[key] as Record<string, unknown> : {};
      target[key] = nested;
      mergeLeafValues(nested, value, origin, origins, path);
    } else {
      target[key] = value;
      origins[path] = origin;
    }
  }
}

function resolveWithLayers(
  machine: AidlcSettingsFile | null,
  project: AidlcSettingsFile | null,
  local: AidlcSettingsFile | null,
  files: ResolvedAidlcSettings["files"],
): ResolvedAidlcSettings {
  const merged: Record<string, unknown> = { schemaVersion: 1 };
  const sources: Record<string, SettingsSource> = {};
  for (const [layer, value] of [
    ["machine", machine],
    ["project", project],
    ["local", local],
  ] as const) {
    if (value) mergeLeafValues(merged, value, layer, sources);
  }
  const normalized = normalizeAidlcSettings(
    merged,
    "machine",
    "<resolved aidlc settings>",
  );
  return {
    value: normalized,
    models: normalized.models ?? null,
    flags: normalized.flags ?? null,
    sources,
    files,
  };
}

export function resolveAidlcSettings(projectDir: string): ResolvedAidlcSettings {
  const paths = {
    machine: machineSettingsPath(),
    project: projectSettingsPath(projectDir),
    local: localSettingsPath(projectDir),
  };
  const machine = readCached(paths.machine, "machine");
  const project = readCached(paths.project, "project");
  const local = readCached(paths.local, "local");
  return resolveWithLayers(machine, project, local, {
    machine: { path: paths.machine, present: machine !== null },
    project: { path: paths.project, present: project !== null },
    local: { path: paths.local, present: local !== null },
  });
}

export function resolveAidlcSettingsWithOverride(
  projectDir: string,
  target: SettingsTarget,
  override: AidlcSettingsFile | null,
): ResolvedAidlcSettings {
  const paths = {
    machine: machineSettingsPath(),
    project: projectSettingsPath(projectDir),
    local: localSettingsPath(projectDir),
  };
  const values = {
    machine: readCached(paths.machine, "machine"),
    project: readCached(paths.project, "project"),
    local: readCached(paths.local, "local"),
  };
  values[layerForTarget(target)] = override;
  return resolveWithLayers(values.machine, values.project, values.local, {
    machine: { path: paths.machine, present: values.machine !== null },
    project: { path: paths.project, present: values.project !== null },
    local: { path: paths.local, present: values.local !== null },
  });
}

export function modelPolicyForHarness(
  models: SettingsModelPolicyRecord | null,
  harness: ModelHarness,
): ModelPolicyRecord | null {
  if (!models) return null;
  const { agents: _settingsAgents, ...base } = models;
  const agents: Record<string, ModelAgentPolicy> = {};
  for (const [name, raw] of Object.entries(models.agents ?? {})) {
    const model = raw.model?.[harness];
    if (raw.effort !== undefined || model !== undefined) {
      agents[name] = {
        ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    }
  }
  return {
    ...base,
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
  };
}

export function settingsModelsFromHarnessPolicy(
  current: SettingsModelPolicyRecord | null,
  harness: ModelHarness,
  policy: ModelPolicyRecord | null,
): SettingsModelPolicyRecord | null {
  const { agents: _policyAgents, ...base } = policy ?? { schemaVersion: 1 as const };
  const agents: Record<string, SettingsModelAgentPolicy> = {};
  const names = new Set([
    ...Object.keys(current?.agents ?? {}),
    ...Object.keys(policy?.agents ?? {}),
  ]);
  for (const name of [...names].sort()) {
    const existingModels = { ...(current?.agents?.[name]?.model ?? {}) };
    const next = policy?.agents?.[name];
    if (next?.model !== undefined) existingModels[harness] = next.model;
    else delete existingModels[harness];
    const effort = next?.effort;
    if (effort !== undefined || Object.keys(existingModels).length > 0) {
      agents[name] = {
        ...(effort !== undefined ? { effort } : {}),
        ...(Object.keys(existingModels).length > 0 ? { model: existingModels } : {}),
      };
    }
  }
  const normalized = normalizeSettingsModels({
    ...base,
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
  });
  return normalized &&
      Object.keys(normalized).some((key) => key !== "schemaVersion")
    ? normalized
    : null;
}

export function updateSettingsSection(
  current: AidlcSettingsFile | null,
  section: "models" | "flags",
  value: SettingsModelPolicyRecord | ProjectFlagsRecord | null,
): AidlcSettingsFile | null {
  const next: AidlcSettingsFile = current
    ? JSON.parse(JSON.stringify(current)) as AidlcSettingsFile
    : { schemaVersion: 1 };
  if (value === null) delete next[section];
  else Object.assign(next, { [section]: value });
  return settingsFileHasValues(next) ? next : null;
}

export function settingsFileHasValues(value: AidlcSettingsFile): boolean {
  return Object.keys(value).some((key) => key !== "$schema" && key !== "schemaVersion");
}

export function serializeAidlcSettings(value: AidlcSettingsFile): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function settingsSource(
  resolved: ResolvedAidlcSettings,
  path: string,
): SettingsSource {
  return resolved.sources[path] ?? "shipped default";
}

export function invalidateSettingsCache(path?: string): void {
  if (path) settingsCache.delete(path);
  else settingsCache.clear();
}

export function _settingsCacheStatsForTests(): {
  entries: number;
  stats: number;
  reads: number;
} {
  return {
    entries: settingsCache.size,
    stats: settingsStatCount,
    reads: settingsReadCount,
  };
}

export function _resetSettingsCacheForTests(): void {
  settingsCache.clear();
  settingsStatCount = 0;
  settingsReadCount = 0;
}

export const AIDLC_SETTINGS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "aidlc-settings.schema.json",
  title: "AI-DLC settings",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion"],
  properties: {
    $schema: { type: "string" },
    schemaVersion: { const: 1 },
    "update-check": { type: "boolean" },
    offline: { type: "boolean" },
    "release-base-url": { type: "string" },
    "ca-bundle": { type: "string" },
    models: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion"],
      properties: {
        schemaVersion: { const: 1 },
        preset: { enum: ["thorough", "balanced", "minimal"] },
        groups: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["deciding", "reviewing", "writing-up"].map((name) => [
              name,
              {
                type: "object",
                additionalProperties: false,
                required: ["effort"],
                properties: {
                  effort: { enum: ["low", "medium", "high", "xhigh", "max"] },
                },
              },
            ]),
          ),
        },
        agents: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              effort: { enum: ["low", "medium", "high", "xhigh", "max"] },
              model: {
                type: "object",
                additionalProperties: false,
                properties: Object.fromEntries(
                  ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"]
                    .map((name) => [name, { type: "string", minLength: 1 }]),
                ),
              },
            },
          },
        },
        profiles: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["groups"],
            properties: {
              groups: { $ref: "#/properties/models/properties/groups" },
            },
          },
        },
      },
    },
    flags: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion"],
      properties: {
        schemaVersion: { const: 1 },
        defaultScope: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        swarm: { type: "boolean" },
        hookDebug: { type: "boolean" },
        sensorTimeoutMs: { type: "integer", minimum: 1 },
        bypasses: {
          type: "array",
          uniqueItems: true,
          items: { enum: [...RECORDABLE_PROJECT_BYPASSES] },
        },
      },
    },
  },
} as const;

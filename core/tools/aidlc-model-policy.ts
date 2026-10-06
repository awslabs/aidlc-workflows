import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  kiroModelDefaults,
  projectTier,
  resolveTierCap,
  type Harness as TierHarness,
  type KiroEffort,
  type Tier,
} from "./aidlc-tiers.ts";

export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const MODEL_GROUPS = {
  deciding: {
    label: "Deciding",
    tier: "judgment",
    tradeoff:
      "More effort gives design and implementation decisions more deliberation, with higher latency and cost.",
  },
  reviewing: {
    label: "Reviewing",
    tier: "balanced",
    tradeoff:
      "More effort gives review passes more deliberation, trading review time and cost for correctness.",
  },
  "writing-up": {
    label: "Writing up",
    tier: "templated",
    tradeoff:
      "More effort gives plans, pipelines, and runbooks more polish, with higher latency and cost.",
  },
} as const;

export type ModelGroup = keyof typeof MODEL_GROUPS;
export type ModelHarness =
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "kiro"
  | "kiro-ide"
  | "opencode";
export type ModelPolicyLayer =
  | "agent-exception"
  | "group-dial"
  | "shipped-tier-default"
  | "session-inherit";

export type ModelGroupPolicy = {
  effort: ModelEffort;
};

export type ModelAgentPolicy = {
  effort?: ModelEffort;
  model?: string;
};

export type ModelProfile = {
  groups: Partial<Record<ModelGroup, ModelGroupPolicy>>;
};

export type ModelPolicyRecord = {
  schemaVersion: 1;
  preset?: string;
  groups?: Partial<Record<ModelGroup, ModelGroupPolicy>>;
  agents?: Record<string, ModelAgentPolicy>;
  profiles?: Record<string, ModelProfile>;
};

export type EffectiveModelPolicy = {
  agent: string;
  group: ModelGroup;
  layer: ModelPolicyLayer;
  model?: string;
  effort?: ModelEffort;
  requestedModel?: string;
  requestedEffort?: ModelEffort;
  clampedEffort?: {
    from: ModelEffort;
    to: ModelEffort;
  };
  unexpressed: Array<"model" | "effort">;
};

const thoroughGroups = Object.freeze({
  reviewing: Object.freeze({ effort: "xhigh" as const }),
});
const balancedGroups = Object.freeze({
  deciding: Object.freeze({ effort: "medium" as const }),
  reviewing: Object.freeze({ effort: "medium" as const }),
  "writing-up": Object.freeze({ effort: "medium" as const }),
});
const minimalGroups = Object.freeze({
  deciding: Object.freeze({ effort: "medium" as const }),
  reviewing: Object.freeze({ effort: "medium" as const }),
  "writing-up": Object.freeze({ effort: "low" as const }),
});

export const MODEL_PRESETS = Object.freeze({
  thorough: Object.freeze({ groups: thoroughGroups }),
  balanced: Object.freeze({ groups: balancedGroups }),
  minimal: Object.freeze({ groups: minimalGroups }),
});

export type ModelPresetName = keyof typeof MODEL_PRESETS;

// `message` is the one line a person sees when a model or effort they set
// cannot apply on that tool: in its words, naming where they choose it
// instead. The setting itself is kept, for teammates on tools that apply it.
export const HARNESS_HONESTY = Object.freeze({
  claude: Object.freeze({
    model: true,
    effort: true,
    groupEffort: true,
    message: "Claude Code can express model and effort policy on agent frontmatter.",
  }),
  codex: Object.freeze({
    model: true,
    effort: true,
    groupEffort: true,
    message:
      "Codex can express model and effort policy; max effort clamps down to xhigh.",
  }),
  opencode: Object.freeze({
    model: true,
    effort: true,
    groupEffort: true,
    message:
      "opencode can express model and variant policy; xhigh effort clamps down to high.",
  }),
  kiro: Object.freeze({
    model: true,
    effort: true,
    groupEffort: false,
    message:
      "Kiro CLI runs every agent on your session's model and effort, so an effort set here without a model is kept for other tools and changes nothing in Kiro CLI; a preset (minimal, balanced or thorough) sets the session's effort.",
  }),
  "kiro-ide": Object.freeze({
    model: false,
    effort: false,
    groupEffort: false,
    message:
      "Kiro IDE runs every agent on the model you choose in its model picker, so a model or effort set here is kept for other tools and changes nothing in Kiro IDE.",
  }),
  cursor: Object.freeze({
    model: false,
    effort: false,
    groupEffort: false,
    message:
      "Cursor runs every agent on the model you choose in its model picker, so a model or effort set here is kept for other tools and changes nothing in Cursor.",
  }),
  copilot: Object.freeze({
    model: false,
    effort: false,
    groupEffort: false,
    message:
      "GitHub Copilot runs every agent on the model you choose in its model picker (/model in the Copilot CLI), so a model or effort set here is kept for other tools and changes nothing in GitHub Copilot.",
  }),
});

type HarnessHonesty = (typeof HARNESS_HONESTY)[ModelHarness];

// Where a harness can pin neither an agent's model nor its effort, every agent
// runs on the session's model and effort, and nothing AI-DLC records changes
// that. Setup and doctor say so instead of asking for a policy.
export function sessionSetsAgentModels(harness: ModelHarness): boolean {
  const honesty: HarnessHonesty = HARNESS_HONESTY[harness];
  return !honesty.model && !honesty.effort;
}

// The project folder whose agent files carry a harness's model policy, or null
// where no agent file can. opencode reads its agents from .opencode/, outside
// the engine tree. The writer, the drift check and the open-work line all read
// this, so they never disagree on where a change lands.
export function modelPolicyAgentsDir(harness: ModelHarness, harnessDir: string): string | null {
  if (harness === "opencode") return ".opencode/agents";
  if (harness === "claude" || harness === "codex" || harness === "kiro") return `${harnessDir}/agents`;
  return null;
}

// The product each harness id names, for messages that point at the host.
// Fixed here rather than read from the project, so a project file cannot name
// another host.
export const HARNESS_PRODUCT_NAMES: Readonly<Record<ModelHarness, string>> = Object.freeze({
  claude: "Claude Code",
  codex: "Codex CLI",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  opencode: "opencode",
});

// The one sentence setup and doctor show on those harnesses. A recorded policy
// (often a team's, for teammates on other harnesses) is named so nobody reads
// it as applied here; pass null where another installed harness applies it.
export function sessionModelsDetail(
  harness: ModelHarness,
  policy: ModelPolicyRecord | null,
): string {
  const recorded = modelPolicyIsEmpty(policy)
    ? ""
    : policy?.preset
    ? `; the recorded ${policy.preset} preset does not apply here`
    : "; the recorded policy does not apply here";
  return `every agent uses your ${HARNESS_PRODUCT_NAMES[harness]} session's model and effort${recorded}`;
}

export type AgentTiers = Record<string, Tier>;

const POLICY_KEYS = new Set(["schemaVersion", "preset", "groups", "agents", "profiles"]);
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isModelEffort(value: string): value is ModelEffort {
  return (MODEL_EFFORTS as readonly string[]).includes(value);
}

export function isModelGroup(value: string): value is ModelGroup {
  return Object.hasOwn(MODEL_GROUPS, value);
}

export function isModelPreset(value: string): value is ModelPresetName {
  return Object.hasOwn(MODEL_PRESETS, value);
}

export function isModelHarness(value: string): value is ModelHarness {
  return Object.hasOwn(HARNESS_HONESTY, value);
}

export function modelGroupForTier(tier: Tier): ModelGroup {
  for (const [group, value] of Object.entries(MODEL_GROUPS)) {
    if (value.tier === tier) return group as ModelGroup;
  }
  throw new Error(`tier ${JSON.stringify(tier)} has no public model group`);
}

export function modelAgentName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").pop() ?? value;
  return leaf
    .replace(/^aidlc-/, "")
    .replace(/-agent(?:\.(?:md|json|toml))?$/, "");
}

export function modelAgentStem(name: string): string {
  return `aidlc-${name}-agent`;
}

function parseGroupPolicies(
  value: unknown,
  where: string,
): Partial<Record<ModelGroup, ModelGroupPolicy>> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const groups: Partial<Record<ModelGroup, ModelGroupPolicy>> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isModelGroup(name)) {
      throw new Error(`${where} has unknown group ${JSON.stringify(name)}`);
    }
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "effort")) {
      throw new Error(`${where}.${name} must contain only effort`);
    }
    if (typeof raw.effort !== "string" || !isModelEffort(raw.effort)) {
      throw new Error(
        `${where}.${name}.effort must be one of ${MODEL_EFFORTS.join(", ")}`,
      );
    }
    groups[name] = { effort: raw.effort };
  }
  return groups;
}

export function normalizeModelPolicy(value: unknown): ModelPolicyRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("models policy must be an object");
  if (value.schemaVersion !== 1) {
    throw new Error(`models policy schemaVersion must be 1`);
  }
  const unknown = Object.keys(value).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`models policy has unknown key(s): ${unknown.join(", ")}`);
  }
  const out: ModelPolicyRecord = { schemaVersion: 1 };
  if (value.preset !== undefined) {
    if (typeof value.preset !== "string" || !isModelPreset(value.preset)) {
      throw new Error(
        `models policy preset must be one of ${Object.keys(MODEL_PRESETS).join(", ")}`,
      );
    }
    out.preset = value.preset;
  }
  if (value.groups !== undefined) {
    const groups = parseGroupPolicies(value.groups, "models.groups");
    if (Object.keys(groups).length > 0) out.groups = groups;
  }
  if (value.agents !== undefined) {
    if (!isRecord(value.agents)) throw new Error("models.agents must be an object");
    const agents: Record<string, ModelAgentPolicy> = {};
    for (const [name, raw] of Object.entries(value.agents)) {
      if (!PROFILE_NAME.test(name)) {
        throw new Error(`models.agents has invalid agent name ${JSON.stringify(name)}`);
      }
      if (
        !isRecord(raw) ||
        Object.keys(raw).some((key) => key !== "effort" && key !== "model")
      ) {
        throw new Error(`${name} agent exception may contain only model and effort`);
      }
      const entry: ModelAgentPolicy = {};
      if (raw.effort !== undefined) {
        if (typeof raw.effort !== "string" || !isModelEffort(raw.effort)) {
          throw new Error(
            `models.agents.${name}.effort must be one of ${MODEL_EFFORTS.join(", ")}`,
          );
        }
        entry.effort = raw.effort;
      }
      if (raw.model !== undefined) {
        if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
          throw new Error(`models.agents.${name}.model must be a non-empty string`);
        }
        entry.model = raw.model.trim();
      }
      if (Object.keys(entry).length > 0) agents[name] = entry;
    }
    if (Object.keys(agents).length > 0) out.agents = agents;
  }
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) {
      throw new Error("models.profiles must be an object");
    }
    const profiles: Record<string, ModelProfile> = {};
    for (const [name, raw] of Object.entries(value.profiles)) {
      if (!PROFILE_NAME.test(name)) {
        throw new Error(`models.profiles has invalid profile name ${JSON.stringify(name)}`);
      }
      if (
        !isRecord(raw) ||
        Object.keys(raw).some((key) => key !== "groups") ||
        raw.groups === undefined
      ) {
        throw new Error(`${name} profile must contain only groups`);
      }
      profiles[name] = {
        groups: parseGroupPolicies(raw.groups, `models.profiles.${name}.groups`),
      };
    }
    if (Object.keys(profiles).length > 0) out.profiles = profiles;
  }
  return out;
}

export function modelPolicyIsEmpty(policy: ModelPolicyRecord | null): boolean {
  return policy === null ||
    (
      policy.preset === undefined &&
      Object.keys(policy.groups ?? {}).length === 0 &&
      Object.keys(policy.agents ?? {}).length === 0 &&
      Object.keys(policy.profiles ?? {}).length === 0
    );
}

export function activeModelGroups(
  policy: ModelPolicyRecord | null,
): Partial<Record<ModelGroup, ModelGroupPolicy>> {
  const groups: Partial<Record<ModelGroup, ModelGroupPolicy>> = {};
  if (policy?.preset && isModelPreset(policy.preset)) {
    Object.assign(groups, MODEL_PRESETS[policy.preset].groups);
  }
  Object.assign(groups, policy?.groups ?? {});
  return groups;
}

export function profileGroups(
  policy: ModelPolicyRecord | null,
  name: string,
): Partial<Record<ModelGroup, ModelGroupPolicy>> {
  if (isModelPreset(name)) return { ...MODEL_PRESETS[name].groups };
  const profile = policy?.profiles?.[name];
  if (!profile) {
    throw new Error(
      `unknown model preset or profile ${JSON.stringify(name)}; presets: ${
        Object.keys(MODEL_PRESETS).join(", ")
      }`,
    );
  }
  return { ...profile.groups };
}

function tierHarness(harness: ModelHarness): TierHarness {
  return harness === "kiro-ide" ? "kiro" : harness;
}

function projectedEffort(value: ReturnType<typeof projectTier>): ModelEffort | undefined {
  if ("effort" in value && value.effort) return value.effort;
  if ("variant" in value && value.variant) return value.variant;
  return undefined;
}

function clampEffort(
  effort: ModelEffort,
  harness: ModelHarness,
): { effort: ModelEffort; clamped?: EffectiveModelPolicy["clampedEffort"] } {
  if (harness === "codex" && effort === "max") {
    return { effort: "xhigh", clamped: { from: "max", to: "xhigh" } };
  }
  if (harness === "opencode" && effort === "xhigh") {
    return { effort: "high", clamped: { from: "xhigh", to: "high" } };
  }
  return { effort };
}

export function resolveModelPolicy(
  policyValue: ModelPolicyRecord | null,
  agentName: string,
  agentTier: Tier,
  harness: ModelHarness,
  cap: Tier | null = null,
): EffectiveModelPolicy {
  const policy = normalizeModelPolicy(policyValue);
  const group = modelGroupForTier(agentTier);
  const shipped = projectTier(agentTier, tierHarness(harness), cap);
  const shippedModel = shipped.model ?? undefined;
  const shippedEffort = projectedEffort(shipped);
  const groupPolicy = activeModelGroups(policy)[group];
  const agentPolicy = policy?.agents?.[agentName];
  const requestedModel = agentPolicy?.model;
  const requestedEffort = agentPolicy?.effort ?? groupPolicy?.effort;
  const layer: ModelPolicyLayer = agentPolicy
    ? "agent-exception"
    : groupPolicy
    ? "group-dial"
    : shippedModel !== undefined || shippedEffort !== undefined
    ? "shipped-tier-default"
    : "session-inherit";
  const honesty = HARNESS_HONESTY[harness] as HarnessHonesty;
  const unexpressed: Array<"model" | "effort"> = [];
  let model = shippedModel;
  let effort = shippedEffort;
  let clampedEffort: EffectiveModelPolicy["clampedEffort"];

  if (requestedModel !== undefined) {
    if (honesty.model) model = requestedModel;
    else unexpressed.push("model");
  }

  if (requestedEffort !== undefined) {
    const kiroHasModel = harness === "kiro" && model !== undefined;
    const supported = honesty.effort &&
      (honesty.groupEffort || agentPolicy !== undefined || kiroHasModel) &&
      (harness !== "kiro" || kiroHasModel);
    // On Kiro CLI a preset's effort rides on the session model (the person's
    // personal Kiro settings, see aidlc-kiro-session.ts), not on agents, so a
    // preset alone leaves agents inheriting and is not an unexpressed policy.
    // An explicit group dial still has no Kiro surface.
    const kiroSessionCarried = harness === "kiro" && agentPolicy?.effort === undefined &&
      policy?.preset !== undefined && policy.groups?.[group]?.effort === undefined;
    if (supported) {
      const clamped = clampEffort(requestedEffort, harness);
      effort = clamped.effort;
      clampedEffort = clamped.clamped;
    } else if (!kiroSessionCarried) {
      unexpressed.push("effort");
    }
  }

  return {
    agent: agentName,
    group,
    layer,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(requestedEffort !== undefined ? { requestedEffort } : {}),
    ...(clampedEffort ? { clampedEffort } : {}),
    unexpressed,
  };
}

export function readAgentTiers(harnessRoot: string): AgentTiers {
  const path = join(harnessRoot, "tools", "data", "agent-tiers.json");
  if (!existsSync(path)) throw new Error(`${path}: missing shipped agent tier data`);
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(value)) throw new Error(`${path}: root must be an object`);
  const out: AgentTiers = {};
  for (const [name, tier] of Object.entries(value)) {
    if (
      !PROFILE_NAME.test(name) ||
      (tier !== "judgment" && tier !== "balanced" && tier !== "templated")
    ) {
      throw new Error(`${path}: invalid agent tier entry ${JSON.stringify(name)}`);
    }
    out[name] = tier;
  }
  return out;
}

export function serializeAgentTiers(tiers: AgentTiers): string {
  return `${JSON.stringify(Object.fromEntries(Object.entries(tiers).sort()), null, 2)}\n`;
}

type MarkdownProjectionOptions = {
  effortKey?: "effort" | "variant";
  insertBeforeKeys?: readonly string[];
  removeKeys?: readonly string[];
  afterProjectionLines?: readonly string[];
};

function effectiveProjectionLines(
  effective: Pick<EffectiveModelPolicy, "model" | "effort">,
  effortKey: "effort" | "variant",
): string[] {
  return [
    ...(effective.model !== undefined ? [`model: ${effective.model}`] : []),
    ...(effective.effort !== undefined ? [`${effortKey}: ${effective.effort}`] : []),
  ];
}

export function writeMarkdownAgentSurface(
  content: string,
  effective: Pick<EffectiveModelPolicy, "model" | "effort">,
  options: MarkdownProjectionOptions = {},
): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("agent markdown has no closed frontmatter block");
  const effortKey = options.effortKey ?? "effort";
  const removeKeys = new Set([
    "tier",
    "model",
    "effort",
    "variant",
    ...(options.removeKeys ?? []),
  ]);
  const source = match[1].split(/\r?\n/);
  const insertionKeys = new Set(options.insertBeforeKeys ?? []);
  let insertAt = source.findIndex((line) => {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    return Boolean(key && (removeKeys.has(key) || insertionKeys.has(key)));
  });
  if (insertAt < 0) insertAt = source.length;
  const kept = source.filter((line) => {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    return !key || !removeKeys.has(key);
  });
  const removedBefore = source.slice(0, insertAt).filter((line) => {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    return Boolean(key && removeKeys.has(key));
  }).length;
  const target = Math.max(0, insertAt - removedBefore);
  const projected = [
    ...effectiveProjectionLines(effective, effortKey),
    ...(options.afterProjectionLines ?? []),
  ];
  kept.splice(target, 0, ...projected);
  return content.replace(match[0], () => `---\n${kept.join("\n")}\n---\n`);
}

export function writeCodexAgentSurface(
  content: string,
  effective: Pick<EffectiveModelPolicy, "model" | "effort">,
): string {
  const hadNewline = content.endsWith("\n");
  const source = content.replace(/\r\n/g, "\n").split("\n");
  if (hadNewline) source.pop();
  let insertAt = source.findIndex((line) =>
    /^(?:model|model_reasoning_effort)\s*=/.test(line)
  );
  const kept = source.filter((line) =>
    !/^(?:model|model_reasoning_effort)\s*=/.test(line)
  );
  if (insertAt < 0) {
    insertAt = kept.findIndex((line) => /^description\s*=/.test(line));
    insertAt = insertAt < 0 ? Math.min(2, kept.length) : insertAt + 1;
  }
  const lines = [
    ...(effective.model !== undefined ? [`model = ${JSON.stringify(effective.model)}`] : []),
    ...(effective.effort !== undefined
      ? [`model_reasoning_effort = ${JSON.stringify(effective.effort)}`]
      : []),
  ];
  kept.splice(insertAt, 0, ...lines);
  return `${kept.join("\n")}${hadNewline ? "\n" : ""}`;
}

export function writeKiroAgentSurface(
  content: string,
  effective: Pick<EffectiveModelPolicy, "model">,
): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (effective.model === undefined) delete parsed.model;
  else parsed.model = effective.model;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function writeKiroCliSurface(
  content: string,
  modelEfforts: readonly { model: string; effort: KiroEffort }[] = [],
  cap: Tier | null = null,
): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const defaults = isRecord(parsed["chat.modelDefaults"])
    ? { ...parsed["chat.modelDefaults"] }
    : {};
  const effortOrder: readonly KiroEffort[] = ["low", "medium", "high", "xhigh", "max"];
  for (const [model, effort] of Object.entries(kiroModelDefaults(cap, modelEfforts))) {
    const rawEntry = defaults[model];
    if (!isRecord(rawEntry)) {
      defaults[model] = { output_config: { effort } };
      continue;
    }
    const output = isRecord(rawEntry.output_config) ? rawEntry.output_config : {};
    const current = typeof output.effort === "string" &&
        (effortOrder as readonly string[]).includes(output.effort)
      ? output.effort as KiroEffort
      : undefined;
    if (!current || effortOrder.indexOf(effort) > effortOrder.indexOf(current)) {
      defaults[model] = {
        ...rawEntry,
        output_config: {
          ...output,
          effort,
        },
      };
    }
  }
  // A project chat.modelDefaults replaces the user's own map on Kiro CLI rather
  // than merging with it, so an empty one silently drops their per-model effort
  // defaults. Never introduce the key with nothing in it.
  if (Object.keys(defaults).length > 0 || "chat.modelDefaults" in parsed) {
    parsed["chat.modelDefaults"] = defaults;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function applyModelPolicyToProjection(
  projectionRoot: string,
  harnessDir: string,
  harness: ModelHarness,
  policyValue?: ModelPolicyRecord | null,
  capValue?: Tier | null,
): EffectiveModelPolicy[] {
  const harnessRoot = join(projectionRoot, harnessDir);
  const policy = policyValue ?? null;
  const tiers = readAgentTiers(harnessRoot);
  const cap = capValue === undefined
    ? resolveTierCap(join(projectionRoot, "aidlc", "spaces", "default", "memory"))
    : capValue;
  const effective = Object.entries(tiers).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([name, tier]) => resolveModelPolicy(policy, name, tier, harness, cap));
  const agentsDir = modelPolicyAgentsDir(harness, harnessDir);
  const agentsRoot = agentsDir === null ? harnessRoot : join(projectionRoot, agentsDir);

  if (harness === "claude") {
    for (const item of effective) {
      const path = join(agentsRoot, `${modelAgentStem(item.agent)}.md`);
      if (!existsSync(path)) throw new Error(`${path}: missing agent surface`);
      writeFileSync(path, writeMarkdownAgentSurface(readFileSync(path, "utf-8"), item));
    }
  } else if (harness === "codex") {
    for (const item of effective) {
      const path = join(agentsRoot, `${modelAgentStem(item.agent)}.toml`);
      if (!existsSync(path)) throw new Error(`${path}: missing agent surface`);
      writeFileSync(path, writeCodexAgentSurface(readFileSync(path, "utf-8"), item));
    }
  } else if (harness === "opencode") {
    for (const item of effective) {
      const path = join(agentsRoot, `${modelAgentStem(item.agent)}.md`);
      if (!existsSync(path)) throw new Error(`${path}: missing agent surface`);
      writeFileSync(
        path,
        writeMarkdownAgentSurface(readFileSync(path, "utf-8"), item, {
          effortKey: "variant",
          insertBeforeKeys: ["mode"],
        }),
      );
    }
  } else if (harness === "kiro") {
    const modelEfforts: Array<{ model: string; effort: KiroEffort }> = [];
    for (const item of effective) {
      const path = join(agentsRoot, `${modelAgentStem(item.agent)}.json`);
      if (!existsSync(path)) throw new Error(`${path}: missing agent surface`);
      writeFileSync(path, writeKiroAgentSurface(readFileSync(path, "utf-8"), item));
      if (item.model && item.effort) {
        modelEfforts.push({ model: item.model, effort: item.effort });
      }
    }
    const path = join(harnessRoot, "settings", "cli.json");
    if (!existsSync(path)) throw new Error(`${path}: missing Kiro CLI settings`);
    writeFileSync(
      path,
      writeKiroCliSurface(readFileSync(path, "utf-8"), modelEfforts, cap),
    );
  }
  return effective;
}

function markdownSurfaceValues(
  content: string,
  effortKey: "effort" | "variant",
): { model?: string; effort?: ModelEffort } {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const model = /^model:\s*(\S+)\s*$/m.exec(fm)?.[1];
  const effort = new RegExp(`^${effortKey}:\\s*(\\S+)\\s*$`, "m").exec(fm)?.[1];
  return {
    ...(model ? { model } : {}),
    ...(effort && isModelEffort(effort) ? { effort } : {}),
  };
}

function codexSurfaceValues(content: string): { model?: string; effort?: ModelEffort } {
  const model = /^model\s*=\s*"([^"]+)"\s*$/m.exec(content)?.[1];
  const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m.exec(content)?.[1];
  return {
    ...(model ? { model } : {}),
    ...(effort && isModelEffort(effort) ? { effort } : {}),
  };
}

function valuesDiffer(
  actual: { model?: string; effort?: ModelEffort },
  expected: EffectiveModelPolicy,
): string[] {
  const issues: string[] = [];
  if (actual.model !== expected.model) {
    issues.push(`model ${actual.model ?? "inherit"} != ${expected.model ?? "inherit"}`);
  }
  if (actual.effort !== expected.effort) {
    issues.push(`effort ${actual.effort ?? "inherit"} != ${expected.effort ?? "inherit"}`);
  }
  return issues;
}

export function modelPolicySurfaceDrift(
  projectDir: string,
  harnessDir: string,
  harness: ModelHarness,
  policyValue: ModelPolicyRecord | null,
): string[] {
  const harnessRoot = join(projectDir, harnessDir);
  const agentsDir = modelPolicyAgentsDir(harness, harnessDir);
  const agentsRoot = agentsDir === null ? harnessRoot : join(projectDir, agentsDir);
  const policy = normalizeModelPolicy(policyValue);
  const tiers = readAgentTiers(harnessRoot);
  const cap = resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory"));
  const issues: string[] = [];
  const expectedByAgent = Object.fromEntries(
    Object.entries(tiers).map(([name, tier]) => [
      name,
      resolveModelPolicy(policy, name, tier, harness, cap),
    ]),
  ) as Record<string, EffectiveModelPolicy>;
  const kiroCollapsed = harness === "kiro"
    ? kiroModelDefaults(
        cap,
        Object.values(expectedByAgent)
          .filter((item): item is EffectiveModelPolicy & {
            model: string;
            effort: KiroEffort;
          } => Boolean(item.model && item.effort))
          .map((item) => ({ model: item.model, effort: item.effort })),
      )
    : {};
  for (const [name] of Object.entries(tiers).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const expected = expectedByAgent[name];
    const surfaceExpected = harness === "kiro" && expected.model && kiroCollapsed[expected.model]
      ? { ...expected, effort: kiroCollapsed[expected.model] }
      : expected;
    for (const field of expected.unexpressed) {
      issues.push(`${name}: ${field} policy is not expressible on ${harness}`);
    }
    let path = "";
    let actual: { model?: string; effort?: ModelEffort } = {};
    if (harness === "claude") {
      path = join(agentsRoot, `${modelAgentStem(name)}.md`);
      if (existsSync(path)) actual = markdownSurfaceValues(readFileSync(path, "utf-8"), "effort");
    } else if (harness === "codex") {
      path = join(agentsRoot, `${modelAgentStem(name)}.toml`);
      if (existsSync(path)) actual = codexSurfaceValues(readFileSync(path, "utf-8"));
    } else if (harness === "opencode") {
      path = join(agentsRoot, `${modelAgentStem(name)}.md`);
      if (existsSync(path)) actual = markdownSurfaceValues(readFileSync(path, "utf-8"), "variant");
    } else if (harness === "kiro") {
      path = join(agentsRoot, `${modelAgentStem(name)}.json`);
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        actual.model = typeof parsed.model === "string" ? parsed.model : undefined;
        if (surfaceExpected.model && surfaceExpected.effort) {
          const cli = JSON.parse(
            readFileSync(join(harnessRoot, "settings", "cli.json"), "utf-8"),
          ) as Record<string, unknown>;
          const defaults = isRecord(cli["chat.modelDefaults"])
            ? cli["chat.modelDefaults"]
            : {};
          const rawEntry = defaults[surfaceExpected.model];
          const entry: Record<string, unknown> = isRecord(rawEntry) ? rawEntry : {};
          const output = isRecord(entry.output_config) ? entry.output_config : {};
          actual.effort = typeof output.effort === "string" && isModelEffort(output.effort)
            ? output.effort
            : undefined;
        }
      }
    } else {
      actual = {};
    }
    if (path && !existsSync(path)) {
      issues.push(`${name}: missing surface ${path}`);
      continue;
    }
    for (const issue of valuesDiffer(actual, surfaceExpected)) {
      issues.push(`${name}: ${issue}`);
    }
  }
  return [...new Set(issues)];
}

export function modelPolicyDoctorIssues(
  harnessRoot: string,
  harness: ModelHarness,
  policyValue: ModelPolicyRecord | null,
): string[] {
  const policy = normalizeModelPolicy(policyValue);
  if (!policy) return [];
  const tiers = readAgentTiers(harnessRoot);
  const issues = Object.keys(policy.agents ?? {})
    .filter((name) => !(name in tiers))
    .map((name) => `orphaned agent exception: ${name}`);
  const cap = resolveTierCap(join(harnessRoot, "..", "aidlc", "spaces", "default", "memory"));
  // Efforts (preset, group dials, per-agent) are shared by every harness, so
  // on a harness where the session sets every agent they are someone else's
  // policy, not a problem here. A model recorded for this harness by name
  // still is: someone asked for exactly that.
  const sessionSet = sessionSetsAgentModels(harness);
  for (const [name, tier] of Object.entries(tiers)) {
    const effective = resolveModelPolicy(policy, name, tier, harness, cap);
    for (const field of effective.unexpressed) {
      if (sessionSet && field === "effort") continue;
      issues.push(`${name}: ${field} policy is not expressible on ${harness}`);
    }
  }
  return [...new Set(issues)].sort();
}

export function harnessHonestyNotes(
  policy: ModelPolicyRecord | null,
  tiers: AgentTiers,
  harness: ModelHarness,
  cap: Tier | null = null,
): string[] {
  const effective = Object.entries(tiers).map(([name, tier]) =>
    resolveModelPolicy(policy, name, tier, harness, cap)
  );
  const notes: string[] = [];
  if (effective.some((item) => item.unexpressed.length > 0)) {
    notes.push(HARNESS_HONESTY[harness].message);
  }
  for (const item of effective) {
    if (item.clampedEffort) {
      notes.push(
        `${harness} clamps ${item.clampedEffort.from} effort down to ${item.clampedEffort.to}.`,
      );
    }
  }
  return [...new Set(notes)];
}

export function agentTiersFromAuthoredDirectory(agentsDir: string): AgentTiers {
  const tiers: AgentTiers = {};
  for (const file of readdirSync(agentsDir).filter((name) => name.endsWith("-agent.md")).sort()) {
    const path = join(agentsDir, file);
    const content = readFileSync(path, "utf-8");
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    const tier = fm ? /^tier:\s*(\S+)\s*$/m.exec(fm)?.[1] : undefined;
    if (tier !== "judgment" && tier !== "balanced" && tier !== "templated") {
      throw new Error(`${path}: agent frontmatter has no valid tier line`);
    }
    tiers[modelAgentName(basename(file))] = tier;
  }
  return tiers;
}

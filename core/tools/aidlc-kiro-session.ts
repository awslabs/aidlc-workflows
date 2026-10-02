// Kiro CLI session model and effort, kept in the person's PERSONAL Kiro settings.
//
// Kiro CLI runs every AI-DLC session on one model, and Kiro has no per-agent
// effort surface, so a model preset lands as ONE session-wide effort on that
// model. Both values live in the person's own Kiro settings (the file Kiro's
// `/model set-current-as-default` writes), never in the committed project file:
// model lists differ per Kiro account, and a project model a teammate's account
// lacks fails every prompt they send. A project `chat.modelDefaults` would also
// replace the person's whole personal map inside the project, so AI-DLC writes
// none there.
//
// Everything goes through Kiro's own CLI, so KIRO_HOME and Kiro's file format are
// Kiro's concern:
//   - models:  `kiro-cli chat --list-models --format json`
//   - current: `kiro-cli settings list --format json`, run in an empty folder so
//              no project file joins in
//   - levels:  one ACP session opened on the model and closed again with no
//              prompt (no credits), which reports the model's effort levels;
//              the session is deleted so it never shows in the person's history
//   - write:   `kiro-cli settings chat.defaultModel <id>` and one merged
//              `chat.modelDefaults` entry, leaving the person's other models alone
//
// AIDLC_TEST_KIRO_SESSION_JSON replaces every Kiro call in tests (see
// kiroSessionTestSeam). When the config detection seam is set without it, Kiro is
// treated as unavailable, so a test never reaches a real kiro-cli or ~/.kiro.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutableOnPath } from "./aidlc-config-diagnostics.ts";
import type { KiroEffort } from "./aidlc-tiers.ts";

export type KiroPreset = "minimal" | "balanced" | "thorough";
export type KiroModelTag = "preview" | "internal";
export type KiroModel = { id: string; rate: number | null; tag: KiroModelTag | null };

export type KiroModelList =
  | { ok: true; models: KiroModel[] }
  | { ok: false; reason: string };

export type KiroPersonalSession =
  | {
    ok: true;
    // null is Kiro auto: no personal model, so Kiro picks one per task.
    model: string | null;
    modelDefaults: Record<string, unknown>;
  }
  | { ok: false; reason: string };

export type KiroSessionWrite = { model?: string; effort?: { model: string; effort: KiroEffort } };

export const KIRO_EFFORT_ORDER: readonly KiroEffort[] = ["low", "medium", "high", "xhigh", "max"];

// One effort for the whole session, conductor included. minimal stays distinct
// from balanced on purpose.
export const KIRO_PRESET_EFFORT: Readonly<Record<KiroPreset, KiroEffort>> = Object.freeze({
  minimal: "low",
  balanced: "medium",
  thorough: "xhigh",
});

export const KIRO_EFFORT_LABEL: Readonly<Record<KiroEffort, string>> = Object.freeze({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra-high",
  max: "maximum",
});

const LIST_TIMEOUT_MS = 30_000;
const SETTINGS_TIMEOUT_MS = 30_000;
const LEVELS_TIMEOUT_MS = 15_000;

type KiroSessionSeam = {
  models?: Array<{ model_id: string; description?: string; rate_multiplier?: number }> | null;
  current?: Record<string, unknown> | null;
  levels?: Record<string, string[]>;
  writes?: string;
};

function kiroSessionTestSeam(env: NodeJS.ProcessEnv = process.env): KiroSessionSeam | null {
  const raw = env.AIDLC_TEST_KIRO_SESSION_JSON;
  if (raw === undefined) return null;
  return JSON.parse(raw) as KiroSessionSeam;
}

export function isKiroEffort(value: unknown): value is KiroEffort {
  return typeof value === "string" && (KIRO_EFFORT_ORDER as readonly string[]).includes(value);
}

export function isKiroPreset(value: unknown): value is KiroPreset {
  return value === "minimal" || value === "balanced" || value === "thorough";
}

// The kiro-cli this process would run, or null when there is none. Under the
// test runner (AIDLC_TEST_NAME) or a stubbed config detection, the host's
// kiro-cli is never used: a test opts in with the data seam or names a fake
// kiro-cli in AIDLC_TEST_KIRO_CLI, so no test reaches a real ~/.kiro.
export function kiroCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (kiroSessionTestSeam(env)) return "kiro-cli";
  if (env.AIDLC_TEST_KIRO_CLI) return env.AIDLC_TEST_KIRO_CLI;
  if (env.AIDLC_TEST_NAME !== undefined || env.AIDLC_TEST_CONFIG_DETECTION_JSON !== undefined) {
    return null;
  }
  return resolveExecutableOnPath("kiro-cli", env.PATH ?? env.Path ?? "");
}

// Where Kiro keeps personal settings, for display only (Kiro owns the file).
export function kiroPersonalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(env.KIRO_HOME || join(homedir(), ".kiro"), "settings", "cli.json");
  const home = homedir();
  return process.platform !== "win32" && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

export function kiroModelTag(description: string | undefined): KiroModelTag | null {
  const text = (description ?? "").trim();
  if (/^\[internal\]/i.test(text)) return "internal";
  if (/^experimental preview\b/i.test(text)) return "preview";
  return null;
}

export function kiroRateLabel(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "";
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}

export function parseKiroModelList(raw: string): KiroModelList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Kiro's model list was not readable" };
  }
  const rows = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return { ok: false, reason: "Kiro's model list was not readable" };
  const models: KiroModel[] = [];
  for (const row of rows) {
    const id = (row as { model_id?: unknown })?.model_id;
    if (typeof id !== "string" || !id || id === "auto") continue;
    const rate = (row as { rate_multiplier?: unknown }).rate_multiplier;
    models.push({
      id,
      rate: typeof rate === "number" ? rate : null,
      tag: kiroModelTag((row as { description?: string }).description),
    });
  }
  return models.length > 0
    ? { ok: true, models }
    : { ok: false, reason: "Kiro listed no models for this account" };
}

function withEmptyFolder<T>(run: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "aidlc-kiro-"));
  try {
    return run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function listKiroModels(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LIST_TIMEOUT_MS,
): KiroModelList {
  const seam = kiroSessionTestSeam(env);
  if (seam) {
    return seam.models
      ? parseKiroModelList(JSON.stringify({ models: seam.models }))
      : { ok: false, reason: "Kiro did not answer" };
  }
  const result = spawnSync(cli, ["chat", "--list-models", "--format", "json"], {
    encoding: "utf-8",
    env,
    timeout: timeoutMs,
  });
  if (result.status !== 0) return { ok: false, reason: "Kiro did not answer" };
  return parseKiroModelList(result.stdout ?? "");
}

export function readKiroPersonalSession(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = SETTINGS_TIMEOUT_MS,
): KiroPersonalSession {
  const seam = kiroSessionTestSeam(env);
  let values: Record<string, unknown>;
  if (seam) {
    if (seam.current === null) return { ok: false, reason: "Kiro settings were not readable" };
    values = seam.current ?? {};
  } else {
    const result = withEmptyFolder((folder) =>
      spawnSync(cli, ["settings", "list", "--format", "json"], {
        cwd: folder,
        encoding: "utf-8",
        env,
        timeout: timeoutMs,
      })
    );
    if (result.status !== 0) return { ok: false, reason: "Kiro settings were not readable" };
    try {
      const parsed = JSON.parse((result.stdout ?? "").trim() || "{}") as unknown;
      values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return { ok: false, reason: "Kiro settings were not readable" };
    }
  }
  const model = values["chat.defaultModel"];
  const defaults = values["chat.modelDefaults"];
  return {
    ok: true,
    model: typeof model === "string" && model && model !== "auto" ? model : null,
    modelDefaults: defaults && typeof defaults === "object" && !Array.isArray(defaults)
      ? defaults as Record<string, unknown>
      : {},
  };
}

export function personalKiroEffort(
  session: Extract<KiroPersonalSession, { ok: true }>,
  model: string,
): KiroEffort | null {
  const entry = session.modelDefaults[model];
  const output = entry && typeof entry === "object"
    ? (entry as { output_config?: unknown }).output_config
    : undefined;
  const effort = output && typeof output === "object"
    ? (output as { effort?: unknown }).effort
    : undefined;
  return isKiroEffort(effort) ? effort : null;
}

// The model's effort levels, or null when they could not be read. [] means the
// model has no effort setting. Kiro answers [] for an unknown model too, so only
// ask about a model the account lists.
export async function kiroEffortLevels(
  cli: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LEVELS_TIMEOUT_MS,
): Promise<KiroEffort[] | null> {
  const seam = kiroSessionTestSeam(env);
  if (seam) {
    const levels = seam.levels?.[model];
    return levels ? levels.filter(isKiroEffort) : null;
  }
  const folder = mkdtempSync(join(tmpdir(), "aidlc-kiro-"));
  let sessionId: string | null = null;
  try {
    const levels = await new Promise<KiroEffort[] | null>((resolveLevels) => {
      const child = spawn(cli, ["acp", "--model", model], {
        cwd: folder,
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let settled = false;
      let answer: KiroEffort[] | null = null;
      let exited = false;
      // Kiro saves the session while it shuts down, so the answer is handed
      // back only once the process has exited; the delete below then finds it.
      const finish = () => {
        clearTimeout(exitTimer);
        resolveLevels(answer);
      };
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: KiroEffort[] | null) => {
        if (settled) return;
        settled = true;
        answer = value;
        clearTimeout(timer);
        if (exited) {
          finish();
          return;
        }
        exitTimer = setTimeout(finish, timeoutMs);
        child.stdin.end();
        child.kill();
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      child.on("exit", () => {
        exited = true;
        if (settled) finish();
        else settle(null);
      });
      let buffer = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message.id === 2) {
            const id = (message.result as { sessionId?: unknown } | undefined)?.sessionId;
            if (typeof id === "string") sessionId = id;
            if (message.error) settle(null);
          }
          const params = message.params as { reasoning?: { effortLevels?: unknown } } | undefined;
          if (message.method === "_kiro.dev/metadata" && params?.reasoning) {
            const raw = params.reasoning.effortLevels;
            settle(Array.isArray(raw) ? raw.filter(isKiroEffort) : []);
          }
        }
      });
      child.on("error", () => {
        exited = true;
        settle(null);
      });
      const send = (id: number, method: string, params: unknown) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      };
      send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      send(2, "session/new", { cwd: folder, mcpServers: [] });
    });
    return levels;
  } finally {
    if (sessionId) {
      spawnSync(cli, ["chat", "--delete-session", sessionId], {
        cwd: folder,
        encoding: "utf-8",
        env,
        timeout: SETTINGS_TIMEOUT_MS,
      });
    }
    rmSync(folder, { recursive: true, force: true });
  }
}

// The effort a preset gives on a model: its level, else the nearest level the
// model offers below it, else the model's lowest. null levels (not readable)
// keeps the preset's level as is; [] (no effort setting) gives null.
export function nearestKiroEffort(
  wanted: KiroEffort,
  levels: readonly KiroEffort[] | null,
): KiroEffort | null {
  if (levels === null) return wanted;
  const offered = KIRO_EFFORT_ORDER.filter((level) => levels.includes(level));
  if (offered.length === 0) return null;
  const limit = KIRO_EFFORT_ORDER.indexOf(wanted);
  const below = offered.filter((level) => KIRO_EFFORT_ORDER.indexOf(level) <= limit);
  return below.length > 0 ? below[below.length - 1] : offered[0];
}

// The person's current named model when the account still offers it, else
// Kiro's first model that is neither an experimental preview nor internal.
export function recommendedKiroModel(
  models: readonly KiroModel[],
  current: string | null,
): string | null {
  if (current && models.some((model) => model.id === current)) return current;
  return models.find((model) => model.tag === null)?.id ?? null;
}

export function mergedKiroModelDefaults(
  current: Record<string, unknown>,
  model: string,
  effort: KiroEffort,
): Record<string, unknown> {
  const entry = current[model] && typeof current[model] === "object" && !Array.isArray(current[model])
    ? current[model] as Record<string, unknown>
    : {};
  const output = entry.output_config && typeof entry.output_config === "object" &&
      !Array.isArray(entry.output_config)
    ? entry.output_config as Record<string, unknown>
    : {};
  return { ...current, [model]: { ...entry, output_config: { ...output, effort } } };
}

export function writeKiroPersonalSession(
  cli: string,
  session: Extract<KiroPersonalSession, { ok: true }>,
  write: KiroSessionWrite,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: string } {
  const calls: string[][] = [];
  if (write.model) calls.push(["settings", "chat.defaultModel", write.model]);
  if (write.effort) {
    calls.push([
      "settings",
      "chat.modelDefaults",
      JSON.stringify(mergedKiroModelDefaults(session.modelDefaults, write.effort.model, write.effort.effort)),
    ]);
  }
  const seam = kiroSessionTestSeam(env);
  for (const args of calls) {
    if (seam) {
      if (seam.writes) appendFileSync(seam.writes, `${JSON.stringify(args)}\n`);
      continue;
    }
    const result = withEmptyFolder((folder) =>
      spawnSync(cli, args, { cwd: folder, encoding: "utf-8", env, timeout: SETTINGS_TIMEOUT_MS })
    );
    if (result.status !== 0) {
      return {
        ok: false,
        reason: `Kiro did not save the ${args[1] === "chat.defaultModel" ? "model" : "effort"}`,
      };
    }
  }
  return { ok: true };
}

export const KIRO_AUTO_DEFINITION =
  "Kiro auto (Kiro's own default, where Kiro picks the model for each task)";

export function kiroAutoRecommendation(preset: KiroPreset | null): string {
  return preset
    ? `AI-DLC recommends choosing a model, so the ${preset} preset's effort applies to it.`
    : "AI-DLC recommends choosing a model, so your effort preset applies to it.";
}

export type KiroSessionPlan = {
  cli: string;
  session: Extract<KiroPersonalSession, { ok: true }>;
  // The model to save, or undefined to keep the current one.
  setModel?: string;
  preset: KiroPreset | null;
  // Read the model's effort levels (online). Off for --yes runs.
  fetchLevels: boolean;
  // When the levels are not read and the recorded preset did not change, an
  // effort already saved for the model stays: it may be the right next level
  // down, which the preset's own level would overwrite.
  keepExistingEffort?: boolean;
  // Report what would be saved and write nothing.
  dryRun?: boolean;
  modelsCommand: string;
  doctorCommand: string;
};

export type KiroSessionResult = {
  ok: boolean;
  lines: string[];
  model: string | null;
  effort: KiroEffort | null;
  saved: KiroSessionWrite;
};

// Apply a session plan: save the model when one was chosen, then the preset's
// effort on whatever model the session runs. Every line is for the person.
export async function applyKiroSessionPlan(
  plan: KiroSessionPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroSessionResult> {
  const model = plan.setModel ?? plan.session.model;
  const lines: string[] = [];
  if (!model) {
    if (plan.preset) {
      lines.push(
        `Session model: kept Kiro auto. ${kiroAutoRecommendation(plan.preset)} Run \`${plan.modelsCommand}\` to choose one.`,
      );
    }
    return { ok: true, lines, model: null, effort: null, saved: {} };
  }
  const write: KiroSessionWrite = {};
  if (plan.setModel && plan.setModel !== plan.session.model) write.model = plan.setModel;
  let effort: KiroEffort | null = null;
  if (plan.preset) {
    const wanted = KIRO_PRESET_EFFORT[plan.preset];
    const levels = plan.fetchLevels ? await kiroEffortLevels(plan.cli, model, env) : null;
    const saved = personalKiroEffort(plan.session, model);
    effort = levels === null && plan.keepExistingEffort && saved !== null
      ? saved
      : nearestKiroEffort(wanted, levels);
    if (effort === null) {
      lines.push(
        `${model} has no effort setting, so the ${plan.preset} preset cannot change it${write.model ? "; only the model is saved" : ""}.`,
      );
    } else {
      if (effort !== wanted && levels !== null) {
        lines.push(
          `${model} has no ${KIRO_EFFORT_LABEL[wanted]} effort, so AI-DLC uses its next level down: ${KIRO_EFFORT_LABEL[effort]}.`,
        );
      }
      if (saved !== effort) write.effort = { model, effort };
      if (levels === null && saved !== effort) {
        lines.push(`\`${plan.doctorCommand}\` confirms ${model} offers ${KIRO_EFFORT_LABEL[effort]} effort.`);
      }
    }
  }
  if (!write.model && !write.effort) {
    return { ok: true, lines, model, effort, saved: {} };
  }
  if (plan.dryRun) {
    lines.push(`Would save in your personal Kiro settings (${kiroPersonalSettingsPath(env)}):`);
    if (write.model) lines.push(`  model    ${write.model}`);
    if (write.effort) lines.push(`  effort   ${write.effort.effort}, for ${write.effort.model}`);
    return { ok: true, lines, model, effort, saved: {} };
  }
  const saved = writeKiroPersonalSession(plan.cli, plan.session, write, env);
  if (!saved.ok) {
    lines.push(
      `${saved.reason}, so your personal Kiro settings are unchanged. Run \`${plan.modelsCommand}\` to try again.`,
    );
    return { ok: false, lines, model, effort, saved: {} };
  }
  lines.push(
    `Saved in your personal Kiro settings (${kiroPersonalSettingsPath(env)}). They apply to every Kiro project you open:`,
  );
  if (write.model) lines.push(`  model    ${write.model}`);
  if (write.effort) lines.push(`  effort   ${write.effort.effort}, for ${write.effort.model}`);
  lines.push(
    `Your other models' settings were not changed. Change this any time with \`${plan.modelsCommand}\`, or inside Kiro with /model.`,
  );
  return { ok: true, lines, model, effort, saved: write };
}

// --- doctor ---------------------------------------------------------------

export type KiroSessionFinding = { pass: boolean; label: string; fix?: string };

const DOCTOR_TIMEOUT_MS = 10_000;

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

// The agent name `config models --agent` takes, from its Kiro agent file name.
function kiroAgentName(file: string): string {
  return file.replace(/\.json$/, "").replace(/^aidlc-/, "").replace(/-agent$/, "");
}

// What doctor says about the person's Kiro CLI session: one line for the
// session model, one for a project file that overrides it, and one per agent
// model pin the account does not offer. Reads the LIVE personal settings, so a
// change made inside Kiro (/model set-current-as-default) is what is checked.
export async function kiroSessionDoctorFindings(input: {
  projectDir: string;
  harnessDir: string;
  preset: KiroPreset | null;
  modelsCommand: string;
  configCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<KiroSessionFinding[]> {
  const env = input.env ?? process.env;
  const cli = kiroCliPath(env);
  if (!cli) return [{ pass: true, label: "Session model: not checked (kiro-cli not found)" }];
  const session = readKiroPersonalSession(cli, env, DOCTOR_TIMEOUT_MS);
  if (!session.ok) {
    return [{ pass: true, label: "Session model: not checked (Kiro settings could not be read)" }];
  }
  const findings: KiroSessionFinding[] = [];
  const harnessRoot = join(input.projectDir, input.harnessDir);
  const projectFile = join(input.harnessDir, "settings", "cli.json");
  const project = readJsonObject(join(harnessRoot, "settings", "cli.json"));
  const rawPin = project["chat.defaultModel"];
  const pin = typeof rawPin === "string" && rawPin && rawPin !== "auto" ? rawPin : null;
  const model = session.model;
  if (pin && pin !== model) {
    findings.push({
      pass: false,
      label: `Session model: this project's ${projectFile} pins ${pin}, which overrides your ${
        model ?? "Kiro auto"
      } here`,
      fix: `remove "chat.defaultModel" from ${projectFile}, or run \`${input.configCommand}\` to refresh it`,
    });
  }
  const projectMap = project["chat.modelDefaults"];
  if (projectMap && typeof projectMap === "object" && !Array.isArray(projectMap)) {
    findings.push({
      pass: false,
      label: `Session model: this project's ${projectFile} has chat.modelDefaults, which replaces your personal effort settings here`,
      fix: `run \`${input.configCommand}\` to refresh the file; an agent model pin set with --agent keeps it`,
    });
  }
  const list = listKiroModels(cli, env, DOCTOR_TIMEOUT_MS);
  if (!model) {
    findings.push(
      input.preset
        ? {
          pass: false,
          label: `Session model: Kiro auto. ${kiroAutoRecommendation(input.preset).replace(/\.$/, "")}`,
          fix: `run \`${input.modelsCommand}\` and choose a model`,
        }
        : { pass: true, label: "Session model: Kiro auto" },
    );
  } else if (list.ok && !list.models.some((item) => item.id === model)) {
    findings.push({
      pass: false,
      label: `Session model: ${model} is not offered on your Kiro account any more; every prompt fails with "The model ... is not available"`,
      fix: `run \`${input.modelsCommand}\`, or choose one in Kiro with /model`,
    });
  } else if (!input.preset) {
    findings.push({ pass: true, label: `Session model: ${model}, from your personal Kiro settings` });
  } else {
    const wanted = KIRO_PRESET_EFFORT[input.preset];
    const actual = personalKiroEffort(session, model);
    const levels = await kiroEffortLevels(cli, model, env, DOCTOR_TIMEOUT_MS);
    const expected = nearestKiroEffort(wanted, levels);
    const matched = levels === null
      ? actual !== null && KIRO_EFFORT_ORDER.indexOf(actual) <= KIRO_EFFORT_ORDER.indexOf(wanted)
      : actual === expected;
    if (expected === null) {
      findings.push({
        pass: true,
        label: `Session model: ${model} (no effort setting), from your personal Kiro settings`,
      });
    } else if (matched && actual) {
      findings.push({
        pass: true,
        label: `Session model: ${model} at ${KIRO_EFFORT_LABEL[actual]} effort (${input.preset}), from your personal Kiro settings`,
      });
    } else {
      findings.push({
        pass: false,
        label: `Session model: ${model} runs at ${
          actual ? `${KIRO_EFFORT_LABEL[actual]} effort` : "Kiro's own effort"
        }; the ${input.preset} preset asks for ${KIRO_EFFORT_LABEL[expected]}`,
        fix: `run \`${input.modelsCommand} --session-model ${model}\``,
      });
    }
  }
  if (list.ok) {
    let files: string[] = [];
    try {
      files = readdirSync(join(harnessRoot, "agents")).filter((name) => name.endsWith(".json")).sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const pinned = readJsonObject(join(harnessRoot, "agents", file)).model;
      if (typeof pinned !== "string" || !pinned || list.models.some((item) => item.id === pinned)) continue;
      const name = kiroAgentName(file);
      findings.push({
        pass: false,
        label: `Agent ${name} pins ${pinned}, which your Kiro account does not offer; Kiro rejects that agent with "Invalid model ID"`,
        fix: `run \`${input.modelsCommand} --agent ${name} --model <id> --effort <level>\` with a model from your list, or remove the pin`,
      });
    }
  }
  return findings;
}

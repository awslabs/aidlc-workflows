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
// Everything goes through Kiro's own CLI, so KIRO_HOME (unless a project's .env
// sets it, see kiroEnv) and Kiro's file format are Kiro's concern:
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
import { basename, delimiter, isAbsolute, join } from "node:path";
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
  // The settings key whose write fails, to test a write Kiro rejects.
  failWrite?: string;
};

// The seam only appends to a file named writes.jsonl, as every test names its
// log, so a project .env that sets the seam cannot append to the person's files.
function isSeamWriteLog(path: string): boolean {
  return basename(path) === "writes.jsonl";
}

// Bun loads the .env files of the folder it runs in, so a seam those files set
// is ignored: only a variable the test runner set reaches the seam, never one a
// project ships to forge Kiro's answers.
const BUN_DOTENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

export function setByDotenvFile(name: string, dir = process.cwd()): boolean {
  // Any casing counts: Windows reads environment names case-insensitively.
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "mi");
  return BUN_DOTENV_FILES.some((file) => {
    try {
      return assignment.test(readFileSync(join(dir, file), "utf-8"));
    } catch {
      return false;
    }
  });
}

// The environment Kiro runs with. A KIRO_HOME that a project's .env sets is
// dropped, so Kiro reads and writes the person's own settings, never a folder a
// repository chose.
export function kiroEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!setByDotenvFile("KIRO_HOME")) return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "KIRO_HOME"));
}

function kiroSessionTestSeam(env: NodeJS.ProcessEnv = process.env): KiroSessionSeam | null {
  const raw = env.AIDLC_TEST_KIRO_SESSION_JSON;
  if (raw === undefined || setByDotenvFile("AIDLC_TEST_KIRO_SESSION_JSON")) return null;
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
// kiro-cli to the functions directly, so no test reaches a real ~/.kiro. No
// variable names the program to run: Bun loads a project's .env, so one could
// otherwise make AI-DLC run a program the project ships.
export function kiroCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (kiroSessionTestSeam(env)) return "kiro-cli";
  if (env.AIDLC_TEST_NAME !== undefined || env.AIDLC_TEST_CONFIG_DETECTION_JSON !== undefined) {
    return null;
  }
  // Only absolute PATH entries: a relative one (such as ".") resolves inside the
  // project, where a repository could ship its own kiro-cli.
  const absolute = (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => isAbsolute(entry));
  return resolveExecutableOnPath("kiro-cli", absolute.join(delimiter));
}

// Where Kiro keeps personal settings, for display only (Kiro owns the file).
export function kiroPersonalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(kiroEnv(env).KIRO_HOME || join(homedir(), ".kiro"), "settings", "cli.json");
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

// Model ids and agent names AI-DLC prints: anything else a project file holds is
// named by a fixed phrase, so a repository cannot put its own words into doctor.
export function isPlainKiroId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value);
}

function shownKiroId(value: string): string {
  return isPlainKiroId(value) ? value : "a model id AI-DLC does not print";
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
    // A model id is printed and passed to kiro-cli, so only a plain one is kept.
    if (typeof id !== "string" || id === "auto" || !isPlainKiroId(id)) continue;
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

// An empty folder to run kiro-cli in. Removal retries and never throws: on
// Windows a Kiro process that is still shutting down can hold its working
// folder for a moment, and a leftover empty temp folder harms nothing.
function removeFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Left in the temp directory.
  }
}

function withEmptyFolder<T>(run: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "aidlc-kiro-"));
  try {
    return run(folder);
  } finally {
    removeFolder(folder);
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
    env: kiroEnv(env),
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
        env: kiroEnv(env),
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
  // The saved model is printed and passed back to Kiro, so settings that name
  // anything but a plain model id are left alone, as if unreadable.
  if (typeof model === "string" && model && model !== "auto" && !isPlainKiroId(model)) {
    return { ok: false, reason: "Kiro settings were not readable" };
  }
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
        env: kiroEnv(env),
        stdio: ["pipe", "pipe", "ignore"],
      });
      let answer: KiroEffort[] | null = null;
      let answered = false;
      let done = false;
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      // The answer is handed back only once Kiro has exited: it saves the
      // session as it shuts down, and the delete below must find it. On
      // Windows the kiro-cli launcher's own child also holds the working
      // folder until it exits, so it is never killed out from under it.
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(answerTimer);
        clearTimeout(exitTimer);
        resolveLevels(answer);
      };
      // Closing stdin lets Kiro shut down by itself; a kill is the fallback.
      const settle = (value: KiroEffort[] | null) => {
        if (answered) return;
        answered = true;
        answer = value;
        clearTimeout(answerTimer);
        child.stdin.end();
        exitTimer = setTimeout(() => {
          child.kill();
          exitTimer = setTimeout(finish, 2_000);
        }, timeoutMs);
      };
      const answerTimer = setTimeout(() => settle(null), timeoutMs);
      child.on("exit", () => {
        answered = true;
        finish();
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
        answered = true;
        finish();
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
        env: kiroEnv(env),
        timeout: SETTINGS_TIMEOUT_MS,
      });
    }
    removeFolder(folder);
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
  write: KiroSessionWrite,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: string; savedModel: boolean } {
  const calls: string[][] = [];
  if (write.model) calls.push(["settings", "chat.defaultModel", write.model]);
  if (write.effort) {
    // Merge onto the map as it is now, not as it was when the run began, so a
    // change made in Kiro meanwhile is kept; if it cannot be read, write nothing.
    const fresh = readKiroPersonalSession(cli, env);
    if (!fresh.ok) {
      return { ok: false, reason: "Kiro could not read your settings again before saving", savedModel: false };
    }
    calls.push([
      "settings",
      "chat.modelDefaults",
      JSON.stringify(mergedKiroModelDefaults(fresh.modelDefaults, write.effort.model, write.effort.effort)),
    ]);
  }
  const seam = kiroSessionTestSeam(env);
  let savedModel = false;
  for (const args of calls) {
    const failed = seam
      ? seam.failWrite === args[1]
      : withEmptyFolder((folder) =>
        spawnSync(cli, args, { cwd: folder, encoding: "utf-8", env: kiroEnv(env), timeout: SETTINGS_TIMEOUT_MS })
      ).status !== 0;
    if (failed) {
      return {
        ok: false,
        reason: `Kiro did not save the ${args[1] === "chat.defaultModel" ? "model" : "effort"}`,
        savedModel,
      };
    }
    if (seam?.writes && isSeamWriteLog(seam.writes)) appendFileSync(seam.writes, `${JSON.stringify(args)}\n`);
    if (args[1] === "chat.defaultModel") savedModel = true;
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
// Never throws: the session is the person's own setting, saved after AI-DLC's
// own steps, so a Kiro problem is reported in one line and nothing AI-DLC
// already wrote is undone because of it.
export async function applyKiroSessionPlan(
  plan: KiroSessionPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroSessionResult> {
  try {
    return await applyPlan(plan, env);
  } catch (error) {
    return {
      ok: false,
      lines: [
        `Saving your personal Kiro settings stopped (${
          error instanceof Error ? error.message : String(error)
        }). Run \`${plan.modelsCommand}\` to finish.`,
      ],
      model: plan.setModel ?? plan.session.model,
      effort: null,
      saved: {},
    };
  }
}

async function applyPlan(
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
  const saved = writeKiroPersonalSession(plan.cli, write, env);
  if (!saved.ok) {
    const modelSaved = saved.savedModel && write.model !== undefined;
    lines.push(
      modelSaved
        ? `Kiro saved the model ${write.model} in your personal Kiro settings but not its effort, so ${write.model} keeps Kiro's own effort. Run \`${plan.modelsCommand}\` to try again.`
        : `${saved.reason}, so your personal Kiro settings are unchanged. Run \`${plan.modelsCommand}\` to try again.`,
    );
    return { ok: false, lines, model, effort, saved: modelSaved ? { model: write.model } : {} };
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

// Releases before the session model step shipped this one effort entry in the
// project's Kiro settings, where it replaced the person's own effort map. A
// refresh says so when it removes it.
export function hasLegacyKiroEffortMap(projectDir: string, harnessDir: string): boolean {
  const map = readJsonObject(join(projectDir, harnessDir, "settings", "cli.json"))["chat.modelDefaults"];
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  const entry = (map as Record<string, unknown>)["claude-opus-4.8"];
  const output = entry && typeof entry === "object" ? (entry as Record<string, unknown>).output_config : undefined;
  return Boolean(output && typeof output === "object" && (output as Record<string, unknown>).effort === "xhigh");
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
  // Shown to the person, so the same on every OS, like other project paths.
  const projectFile = `${input.harnessDir}/settings/cli.json`;
  const project = readJsonObject(join(harnessRoot, "settings", "cli.json"));
  const rawPin = project["chat.defaultModel"];
  const pin = typeof rawPin === "string" && rawPin && rawPin !== "auto" ? rawPin : null;
  const model = session.model;
  if (pin && pin !== model) {
    findings.push({
      pass: false,
      label: `Session model: this project's ${projectFile} pins ${shownKiroId(pin)}, which overrides your ${
        model === null ? "Kiro auto" : shownKiroId(model)
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
    // Without Kiro's list of levels only the preset's own level is certain.
    const matched = actual === (levels === null ? wanted : expected);
    if (expected === null) {
      findings.push({
        pass: true,
        label: `Session model: ${model} (no effort setting), from your personal Kiro settings`,
      });
    } else if (levels === null && actual !== null && !matched) {
      findings.push({
        pass: false,
        label: `Session model: ${model} runs at ${KIRO_EFFORT_LABEL[actual]} effort; the ${input.preset} preset asks for ${
          KIRO_EFFORT_LABEL[wanted]
        }, and Kiro did not list ${model}'s effort levels, so doctor could not confirm ${KIRO_EFFORT_LABEL[actual]} is its nearest`,
        fix: `run \`${input.modelsCommand} --session-model ${model}\` to set it again`,
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
      if (!isPlainKiroId(name)) continue;
      findings.push({
        pass: false,
        label: `Agent ${name} pins ${shownKiroId(pinned)}, which your Kiro account does not offer; Kiro rejects that agent with "Invalid model ID"`,
        fix: `run \`${input.modelsCommand} --agent ${name} --model <id> --effort <level>\` with a model from your list, or remove the pin`,
      });
    }
  }
  return findings;
}

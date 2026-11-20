// Everything about how a plugin takes part in metrics: the contract with its
// optional `tools/<plugin>-metrics.ts` (input and output shape, limits, parse
// and filter), and the tags a running install gets from it. One owner:
// aidlc-metrics.ts only calls pluginMetricTags, and `aidlc plugin validate`
// applies the same parse and filter, so the cap it checks is the cap that is
// enforced. Every entry point fails open: disabled, missing, slow or malformed
// means no tags ([]), never an error. No dependency on aidlc-lib, so the
// standalone validator stays light.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHookInput } from "./aidlc-hook-input.ts";
import {
  MAX_PLUGIN_METRIC_TAGS,
  MAX_PLUGIN_METRIC_VALUE_LENGTH,
  PLUGIN_METRIC_KEY_RE,
  PLUGIN_METRICS_CONTRACT_VERSION,
  PLUGIN_METRICS_MAX_BUFFER,
  PLUGIN_METRICS_TIMEOUT_MS,
  type PluginMetricsInput,
  type PluginMetricsOutput,
} from "./aidlc-plugin-metrics-contract.ts";
import { pluginScriptLaunch } from "./aidlc-plugin-script.ts";

export * from "./aidlc-plugin-metrics-contract.ts";

export interface PluginMetricTagResult {
  /** Accepted tags, in the script's order, at most MAX_PLUGIN_METRIC_TAGS. */
  tags: Array<[key: string, value: string]>;
  /** One plain-words line per thing dropped or shortened. */
  notes: string[];
}

/** The script's stdout parsed to an output object, or why it is not one. */
export function parsePluginMetricsOutput(stdout: string): { ok: true; output: PluginMetricsOutput } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "stdout is not one JSON object" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "stdout is not one JSON object" };
  }
  const tags = (value as { additionalTags?: unknown }).additionalTags;
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
    return { ok: false, reason: 'the object has no "additionalTags" object' };
  }
  for (const [key, tag] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof tag !== "string") return { ok: false, reason: `additionalTags.${key} is not a string` };
  }
  return { ok: true, output: { additionalTags: tags as Record<string, string> } };
}

/**
 * Apply the limits: bad keys dropped, values shortened, only the first
 * MAX_PLUGIN_METRIC_TAGS kept (in the script's own order). `mask` hides
 * secret-shaped text in a value before it can leave the machine.
 */
export function filterPluginMetricTags(
  additionalTags: Record<string, string>,
  mask: (value: string) => string = (value) => value,
): PluginMetricTagResult {
  const tags: Array<[string, string]> = [];
  const notes: string[] = [];
  for (const [key, raw] of Object.entries(additionalTags)) {
    if (!PLUGIN_METRIC_KEY_RE.test(key)) {
      notes.push(`tag "${key}" dropped: keys are lowercase letters, digits and "_", start with a letter, at most 32 characters`);
      continue;
    }
    if (tags.length >= MAX_PLUGIN_METRIC_TAGS) {
      notes.push(`tag "${key}" dropped: only the first ${MAX_PLUGIN_METRIC_TAGS} tags are sent`);
      continue;
    }
    let value = mask(raw);
    if (value.length > MAX_PLUGIN_METRIC_VALUE_LENGTH) {
      notes.push(`tag "${key}" shortened to ${MAX_PLUGIN_METRIC_VALUE_LENGTH} characters`);
      value = value.slice(0, MAX_PLUGIN_METRIC_VALUE_LENGTH);
    }
    tags.push([key, value]);
  }
  return { tags, notes };
}


/** Strip StatsD-reserved characters (`|,#:`), `+`, `/` and whitespace from a tag value. */
export function sanitizeTag(v: string): string {
  return v.replace(/[|,#:+/\s]/g, "_");
}

interface AdvertisingPlugin {
  name: string;
  version: string;
}

// Read the stamps directly: they are tiny, and aidlc-plugin.ts is too heavy to
// load under the audit lock. aidlc-plugin.ts's parseStamp owns the full shape.
function advertisingPlugins(
  projectDir: string,
  harnessDir: string,
  enabled: ReadonlySet<string> | null,
): AdvertisingPlugin[] {
  const dataDir = join(projectDir, harnessDir, "tools", "data");
  if (!existsSync(dataDir)) return [];
  const out: AdvertisingPlugin[] = [];
  for (const entry of readdirSync(dataDir).sort()) {
    const match = entry.match(/^plugin-compose-([a-z][a-z0-9-]*)\.json$/);
    if (!match) continue;
    try {
      const stamp = JSON.parse(readFileSync(join(dataDir, entry), "utf-8")) as {
        name?: unknown;
        version?: unknown;
        advertiseMetrics?: unknown;
      };
      if (stamp.name !== match[1] || typeof stamp.version !== "string" || stamp.advertiseMetrics !== true) continue;
      if (enabled !== null && !enabled.has(match[1])) continue;
      out.push({ name: match[1], version: stamp.version });
    } catch {
      // An unreadable stamp advertises nothing.
    }
  }
  return out;
}

function maskForMetrics(value: string): string {
  try {
    const audit = require("./aidlc-audit.ts") as { maskSecretShapes: (text: string) => string };
    return audit.maskSecretShapes(value);
  } catch {
    return value;
  }
}

function scriptTags(
  plugin: AdvertisingPlugin,
  eventType: string,
  fields: Record<string, string>,
  projectDir: string,
  harness: string,
): string[] {
  try {
    const launch = pluginScriptLaunch({ projectDir, harnessDir: harness, plugin: plugin.name, file: `${plugin.name}-metrics.ts` });
    if (!launch.ok) return [];
    const input: PluginMetricsInput = {
      contractVersion: PLUGIN_METRICS_CONTRACT_VERSION,
      plugin: plugin.name,
      event: eventType,
      fields,
      harness,
      harnessDir: harness,
      projectDir,
      hookInput: getHookInput(),
    };
    const run = spawnSync(launch.command, launch.args, {
      cwd: projectDir,
      encoding: "utf-8",
      env: launch.env,
      input: JSON.stringify(input),
      maxBuffer: PLUGIN_METRICS_MAX_BUFFER,
      timeout: PLUGIN_METRICS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (run.error || run.status !== 0) return [];
    const parsed = parsePluginMetricsOutput(run.stdout ?? "");
    if (!parsed.ok) return [];
    return filterPluginMetricTags(parsed.output.additionalTags, maskForMetrics).tags.map(
      ([key, value]) => `plugin.${plugin.name}.${key}:${sanitizeTag(value)}`,
    );
  } catch {
    return [];
  }
}

/**
 * The `key:value` tags the plugins that advertise metrics add to one event:
 * `plugin.<name>.version:<version>` and the tags of their metrics script.
 * `enabled` is the install's plugin selection (null = all); a plugin that is
 * off, or whose manifest did not set advertiseMetrics, adds nothing.
 */
export function pluginMetricTags(options: {
  eventType: string;
  fields: Record<string, string>;
  projectDir: string;
  harnessDir: string;
  enabled: ReadonlySet<string> | null;
}): string[] {
  try {
    const tags: string[] = [];
    for (const plugin of advertisingPlugins(options.projectDir, options.harnessDir, options.enabled)) {
      tags.push(`plugin.${plugin.name}.version:${sanitizeTag(plugin.version)}`);
      tags.push(...scriptTags(plugin, options.eventType, options.fields, options.projectDir, options.harnessDir));
    }
    return tags;
  } catch {
    return [];
  }
}

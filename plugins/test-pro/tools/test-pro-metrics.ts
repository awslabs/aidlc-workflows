// Reference metrics-tag script for plugin authors to copy.
//
// AI-DLC runs tools/<plugin>-metrics.ts once per metric event, only while the
// plugin is on, its manifest sets "advertiseMetrics": true, and
// AIDLC_METRICS_ENDPOINT is set. It writes ONE JSON object to this script's
// stdin (PluginMetricsInput in aidlc-plugin-metrics.ts):
//
//   { plugin, event, fields, harness, harnessDir, projectDir, hookInput }
//
// `hookInput` is the raw stdin text of the harness hook that caused the event,
// exactly as the harness sent it ("" when the event came from a tool the agent
// ran). The script prints ONE JSON object: { "additionalTags": { key: value } }.
//
// AI-DLC then sends each tag as `plugin.<plugin>.<key>:<value>`. Keys are
// lowercase letters, digits and "_" (max 32); values are cut at 64 characters,
// secret-shaped text is masked, and only the first 10 tags are sent. The script
// has about one second; on a timeout, a non-zero exit or bad output the event
// goes out with its core tags only.
//
// Vendor-agnostic by design. The fields below are documented by both harnesses:
//   Claude Code  https://code.claude.com/docs/en/hooks   (stdin JSON)
//   Kiro         https://kiro.dev/docs/hooks/             (stdin JSON)
// `session_id`, `hook_event_name` and `cwd` carry the same names in both. Kiro
// IDE before 1.x sent camelCase (`sessionId`, `hookEventName`), so each field is
// read under both spellings. Anything a harness does not send is left out; the
// script never fails because a field is missing.
//
// Values leave the machine, so this reads only identifying fields, never the
// prompt or tool content, and hashes the session id instead of sending it.

import { createHash } from "node:crypto";
import { basename } from "node:path";

interface Input {
  harness?: string;
  hookInput?: string;
  fields?: Record<string, string>;
}

function text(...candidates: unknown[]): string | undefined {
  for (const value of candidates) if (typeof value === "string" && value !== "") return value;
  return undefined;
}

const raw = await Bun.stdin.text();
const tags: Record<string, string> = {};

try {
  const input = JSON.parse(raw) as Input;

  // 1. Harness-neutral facts from AI-DLC itself.
  tags.harness_kind = (input.harness ?? "").replace(/^\./, "") || "unknown";

  // 2. The raw hook input, when this event came from a hook. Parse defensively:
  //    it may be empty, not JSON, or in a shape this script does not know.
  let hook: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(input.hookInput ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      hook = parsed as Record<string, unknown>;
    }
  } catch {
    // No hook input (an agent-run tool) or an unreadable one: no hook tags.
  }

  const sessionId = text(hook.session_id, hook.sessionId);
  const hookEvent = text(hook.hook_event_name, hook.hookEventName);
  const cwd = text(hook.cwd);
  if (sessionId) tags.session = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  if (hookEvent) tags.hook_event = hookEvent;
  if (cwd) tags.repo = basename(cwd);

  // 3. Harness-specific extras, switched on `harness`, never required.
  if (input.harness === ".claude" && typeof hook.permission_mode === "string") {
    tags.permission_mode = hook.permission_mode;
  }
} catch {
  // Unparseable input: print no tags rather than fail.
}

process.stdout.write(`${JSON.stringify({ additionalTags: tags })}\n`);

// The contract between AI-DLC and a plugin's optional `tools/<plugin>-metrics.ts`,
// and nothing else: no imports, so a plugin repository can copy this one file
// (`aidlc plugin create --with-metrics` does) or fetch it from a release and
// type its script against the same shape AI-DLC sends. Bun reads it as is.
// The logic that applies these limits is aidlc-plugin-metrics.ts's.
//
// Bump PLUGIN_METRICS_CONTRACT_VERSION when the input or output shape changes
// in a way an existing script could not read; a script can refuse a version it
// does not know.

export const PLUGIN_METRICS_CONTRACT_VERSION = 1;

/** What AI-DLC writes to the script's stdin, as one JSON object. */
export interface PluginMetricsInput {
  contractVersion: number;
  plugin: string;
  /** The audit event type being emitted, such as STAGE_STARTED. */
  event: string;
  /** The audit event's own fields (already-recorded strings). */
  fields: Record<string, string>;
  /** The harness directory name, such as ".claude" or ".kiro". */
  harness: string;
  harnessDir: string;
  projectDir: string;
  /**
   * The raw stdin text of the harness hook that caused the event, untouched, in
   * whatever shape that harness sends. "" when the event came from a tool the
   * agent ran rather than from a hook.
   */
  hookInput: string;
}

/** What the script prints to stdout as one JSON object. */
export interface PluginMetricsOutput {
  additionalTags: Record<string, string>;
}

export const MAX_PLUGIN_METRIC_TAGS = 10;
export const MAX_PLUGIN_METRIC_VALUE_LENGTH = 64;
export const PLUGIN_METRIC_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const PLUGIN_METRICS_TIMEOUT_MS = 1_000;
export const PLUGIN_METRICS_MAX_BUFFER = 64 * 1024;

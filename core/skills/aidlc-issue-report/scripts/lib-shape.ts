// What each safe.json field may hold, in one place. A field holds AI-DLC's own word (lib-vocab.ts), a
// number, a time, a version, a value this skill made itself, or an anonymous label (`<custom-stage-1>`)
// for any other name; text someone wrote (a Bolt's name, an error message) is not sent at all. Redaction
// (redact.ts) still runs over the result; this is what makes a name nobody listed unable to get through.

import type { AuditRow } from "./lib-audit.ts";
import { BUILTIN_AGENTS, OWN, type Summary } from "./lib-transcripts.ts";

export { OWN };
import type { Vocab } from "./lib-vocab.ts";

// The same name gets the same label everywhere in one report; the map stays in local/.
export class Labels {
  private byKind = new Map<string, Map<string, string>>();
  label(kind: string, raw: string): string {
    const map = this.byKind.get(kind) ?? new Map<string, string>();
    this.byKind.set(kind, map);
    let label = map.get(raw);
    if (!label) {
      label = `<custom-${kind}-${map.size + 1}>`;
      map.set(raw, label);
    }
    return label;
  }
  toJSON(): Record<string, Record<string, string>> {
    return Object.fromEntries([...this.byKind].map(([kind, map]) => [kind, Object.fromEntries(map)]));
  }
}

export function time(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// A release number, a preview build or a pre-release number; any other suffix (`-acme`) is not kept.
// Up to three numbers are kept: a fourth (`1.4.13.2`) would read as an IP address to the redaction. A sentence's
// last dot after the number (`CLI 0.0.354.`) is not part of it.
const VERSION = /\bv?(\d+(?:\.\d+){1,2})(?:\.\d+)?(-preview\.\d{8}\.\d+|-(?:alpha|beta|rc)\.?\d*)?(?![\w-]|\.\w)/;
// What a version may be in what is sent: up to three numbers of up to four digits with no leading zero (four read as
// an IP address), with a preview or a pre-release number, and not a phone written with dots (`212.555.1234`).
// lib-gate.ts checks with the same test.
export function isVersion(word: string): boolean {
  return /^v?(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){1,2}(?:-preview\.\d{8}\.\d{1,4}|-(?:alpha|beta|rc)\.?\d{0,4})?$/.test(word) && !/^\d{2,4}[.-]\d{3,4}[.-]\d{4}$/.test(word);
}
export function version(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(VERSION);
  const v = m ? `${m[1]}${m[2] ?? ""}` : null;
  return v && isVersion(v) ? v : null;
}
// A value that is a version and nothing else (`v2.33.1`, `1.4.13.2`, not `2.33.1-acme`).
export function exactVersion(value: string): string | null {
  const m = value.trim().match(VERSION);
  return m && m.index === 0 && m[0].length === value.trim().length ? version(value) : null;
}

function count(value: unknown): number | string | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^\d+(?:\s*\/\s*\d+)?$/.test(v) ? v : null;
}

// Public model ids keep their name: a family, a version number and the providers' own variant words
// (claude-opus-5-5, claude-3-5-sonnet-20241022-v2:0, gpt-6.1-sol, gpt-4o-mini, o4-mini, gemini-3-pro, a
// Bedrock region prefix). Anything else (a deployment, an ARN with an account in it, `gpt-contoso`,
// `gpt-6.1-contoso`) is a label.
const VARIANT = "(?:[-.](?:\\d+[a-z]?|v\\d+|mini|nano|pro|max|turbo|codex|sol|preview|latest|flash|lite|micro|premier|exp|opus|sonnet|haiku|fable|instant|thinking))*";
export const PUBLIC_MODEL = new RegExp(
  `^(?:auto|(?:(?:us|eu|apac|global)\\.)?(?:anthropic\\.|openai\\.|amazon\\.)?(?:claude|gpt|o\\d|gemini|nova)${VARIANT}(?::\\d+)?(?:\\[1m\\])?)$`,
  "i",
);
// The hosts' own approval modes (Claude Code permissionMode, Codex approval_policy, Kiro autopilot).
const APPROVAL_MODES = new Set([
  "default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto",
  "untrusted", "on-failure", "on-request", "never", "autopilot on", "autopilot off",
]);
// Tool denial kinds the hosts write, and the ones the Kiro and Codex readers name.
const DENIALS = new Set(["user-rejected", "automode-blocked", "agent-profile-deny", "permission-denied", "hook-denied", "policy-denied"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none", "auto"]);
// The hosts' own tool names; any other tool is a label (an MCP tool is `mcp`).
export const HOST_TOOLS = new Set([
  // Claude Code
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "Task", "Agent",
  "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit", "NotebookRead", "AskUserQuestion", "ExitPlanMode", "Skill",
  "SlashCommand",
  // Codex
  "shell", "local_shell", "exec_command", "write_stdin", "apply_patch", "update_plan", "view_image", "web_search",
  "read_file", "list_dir",
  // Kiro CLI and IDE
  "fs_read", "fs_write", "execute_bash", "execute_cmd", "use_aws", "report_issue", "knowledge", "thinking",
  "todo_list", "introspect", "delegate", "use_subagent", "invoke_subagent", "grep", "glob", "web_fetch",
  "readFile", "readMultipleFiles", "fsWrite", "fsAppend", "strReplace", "deleteFile", "executeBash",
  "listDirectory", "fileSearch", "grepSearch", "getDiagnostics", "readCode", "invokeSubAgent",
  // Copilot CLI
  "bash", "view", "edit", "create", "str_replace", "str_replace_editor", "read_bash", "write_bash", "stop_bash",
]);
// AI-DLC's harness rows.
const HARNESS_ROWS = new Set(["claude", "kiro", "kiro-ide", "codex", "cursor", "opencode", "copilot"]);

// A kernel release as Linux, WSL and macOS write it (`6.8.0-45-generic`, `5.15.167.4-microsoft-standard-WSL2`,
// `6.1.112-122.189.amzn2023.x86_64`, `25.6.0`): a major of one or two digits, then the distributions' own words; any
// other suffix (`6.8.0-acme`) is not kept, and four numbers are one only in WSL's own form (else an IP address).
export const KERNEL_RELEASE =
  /^\d{1,2}\.\d{1,3}(?:\.\d{1,4})?(?:\.\d{1,4}-microsoft-standard-WSL2|(?:-\d{1,4}(?:\.\d{1,4})*)?(?:[.-](?:generic|lowlatency|aws|azure|gcp|oracle|kvm|cloud|virtual|lts|default|amd64|arm64|x86_64|aarch64|el\d{1,2}(?:_\d{1,2})?|amzn\d{4}|fc\d{2}))*)$/;

// What os.platform() and os.arch() write.
const PLATFORMS = new Set(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"]);
const ARCHES = new Set(["arm64", "x64", "ia32", "arm", "ppc64", "s390x", "riscv64", "loong64"]);
// The release kept for a platform: a kernel release as its system writes it, a Windows build (`10.0.26100`), else its
// version only, else nothing.
function osRelease(os: string, release: string | undefined): string | null {
  if (!release) return null;
  if (os === "win32" && /^10\.0\.\d{5}$/.test(release)) return release;
  return KERNEL_RELEASE.test(release) ? release : version(release);
}
// The OS line safe.json holds: `<platform> [<release>] [<arch>]`, each part as the shaper keeps it. lib-gate.ts checks
// with this test.
export function isOsLine(value: string): boolean {
  const [os, ...rest] = value.split(" ");
  if (!PLATFORMS.has(os) || rest.length > 2) return false;
  const arch = rest.length && ARCHES.has(rest[rest.length - 1]) ? rest.pop() : undefined;
  if (rest.length > 1 || (rest.length === 0 && arch === undefined && value !== os)) return false;
  return rest.length === 0 || osRelease(os, rest[0]) === rest[0];
}

export class Shaper {
  // `known`: the dictionary's own labels for Unit and intent names, so safe.json and the report agree.
  constructor(
    private readonly v: Vocab,
    readonly labels: Labels,
    private readonly known: Map<string, string> = new Map(),
  ) {}

  private pick(set: Set<string>, kind: string, value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    return set.has(value) ? value : this.labels.label(kind, value);
  }
  // A value of one of AI-DLC's own enumerations: its word, written in lower case (`in-progress`,
  // `strict`) or as a constant (`APPROVED`). `titled`: the state file's own values, which AI-DLC writes
  // capitalized (`Running`, `Standard`); elsewhere a capitalized word is a name, not one of these.
  word(value: unknown, kind = "value", titled = false): string | null {
    if (typeof value !== "string" || !value) return null;
    const enumShaped =
      /^(?:[a-z0-9][a-z0-9 _.:/-]{0,59}|[A-Z][A-Z0-9_]{1,59})$/.test(value) || (titled && /^[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}$/.test(value));
    return enumShaped && this.v.words.has(value) ? value : this.labels.label(kind, value);
  }
  // A guard is one of AI-DLC's fences or one of its hooks.
  guard(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    return this.v.guards.has(value) ? value : this.hook(value);
  }
  event(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    return /^[A-Z][A-Z0-9_]{2,60}$/.test(value) && this.v.words.has(value) ? value : this.labels.label("event", value);
  }
  // A Unit's or an intent's name is always the person's: the dictionary's label, else a new one.
  unit(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    return this.known.get(value) ?? this.labels.label("unit", value);
  }
  intent(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    if (value === "(space)") return value;
    return this.known.get(value) ?? this.labels.label("intent", value);
  }
  stage(value: unknown): string | null {
    return this.pick(this.v.stages, "stage", value);
  }
  phase(value: unknown): string | null {
    return this.pick(this.v.phases, "phase", value);
  }
  scope(value: unknown): string | null {
    return this.pick(this.v.scopes, "scope", value);
  }
  sensor(value: unknown): string | null {
    return this.pick(this.v.sensors, "sensor", value);
  }
  hook(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    const bare = value.replace(/^aidlc-/, "");
    return this.v.hooks.has(bare) ? bare : this.labels.label("hook", value);
  }
  agent(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    // Kiro's built-in agents and `custom` (lib-transcripts.ts agentName) stay beside the ones AI-DLC installed.
    return this.v.agents.has(value) || BUILTIN_AGENTS.has(value) || value === "custom" ? value : this.labels.label("agent", value);
  }
  model(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    const own = value.endsWith(OWN);
    const name = own ? value.slice(0, -OWN.length) : value;
    const shaped = PUBLIC_MODEL.test(name) ? name : this.labels.label("model", name);
    return own ? `${shaped}${OWN}` : shaped;
  }
  effort(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    const own = value.endsWith(OWN);
    const name = own ? value.slice(0, -OWN.length) : value;
    const shaped = EFFORTS.has(name) ? name : this.labels.label("effort", name);
    return own ? `${shaped}${OWN}` : shaped;
  }
  // An AI-DLC tool keeps its name; a host's own tool (Bash, fs_read) stays; MCP is `mcp`; else a label.
  tool(value: unknown): string | null {
    if (typeof value !== "string" || !value) return null;
    if (this.v.tools.has(value) || HOST_TOOLS.has(value)) return value;
    // The readers already write an MCP tool as `mcp` (lib-transcripts.ts toolLabel).
    if (value === "mcp" || /^mcp[_-]|^@|__/.test(value)) return "mcp";
    return this.labels.label("tool", value);
  }
  private oneOf(set: Set<string>, kind: string, value: string): string {
    return set.has(value) ? value : this.labels.label(kind, value);
  }
  // A map whose keys are names: each key shaped, counts of keys that become one label added up.
  keys(map: Record<string, number> | undefined, shape: (k: string) => string | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(map ?? {})) {
      const key = shape(k);
      if (key) out[key] = (out[key] ?? 0) + n;
    }
    return out;
  }

  auditFields(fields: Record<string, string>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [k, value] of Object.entries(fields)) {
      let shaped: string | number | null;
      switch (k) {
        case "Stage":
        case "Stage slug":
        case "Current Stage":
        case "Next Stage":
        case "Target":
          shaped = this.stage(value);
          break;
        // A stage on a move, or who switched a guard (`you`, `command`, `team`).
        case "Source":
          shaped = this.v.stages.has(value) ? value : this.word(value);
          break;
        case "Scope":
          shaped = this.scope(value);
          break;
        case "Phase":
        case "Lifecycle Phase":
          shaped = this.phase(value);
          break;
        case "Unit":
          shaped = this.unit(value);
          break;
        case "Tool":
          shaped = this.tool(value);
          break;
        case "Guard":
          shaped = this.guard(value);
          break;
        case "Sensor ID":
          shaped = this.sensor(value);
          break;
        case "Exit Code":
        case "Findings count":
        case "Revision count":
        case "Revision Count":
          shaped = count(value);
          break;
        case "Error Fingerprint":
        case "Error Group":
          shaped = /^[0-9a-f]{6,64}$/i.test(value) ? value : null;
          break;
        case "Failed Bolt":
          shaped = null; // a Bolt's name is prose the person wrote
          break;
        default:
          shaped = this.word(value);
      }
      if (shaped !== null) out[k] = shaped;
    }
    return out;
  }

  problem(r: AuditRow): Record<string, string | number | null> {
    return { ts: time(r.ts), event: this.event(r.event), intent: this.intent(r.intent), ...this.auditFields(r.fields) };
  }

  absence(a: { kind: string; ts: string; stage: string | null; intent: string }) {
    const repeated = a.kind.match(/^(same-error-repeated x\d+) \((.*)\)$/);
    const kind = repeated ? `${repeated[1]} (${repeated[2] === "?" ? "?" : this.tool(repeated[2])})` : a.kind;
    return { kind, ts: time(a.ts), stage: a.stage ? this.stage(a.stage) : null, intent: this.intent(a.intent) };
  }

  state(st: Record<string, unknown> | null) {
    if (!st) return null;
    // AI-DLC writes where a setting came from after it (`off (from scope classic)`, `review-freeze (set by you)`);
    // the setting is kept and the note is not (a team's scope name can be in it). `none` is an empty list.
    const plain = (value: unknown) => (typeof value === "string" ? value.replace(/\s*\([^)]*\)\s*$/, "").trim() : value);
    const list = (value: unknown, one: (x: string) => string | null) =>
      typeof value !== "string"
        ? null
        : value.trim() === "none"
          ? "none"
          : value
              .split(/\s*,\s*/)
              .map((x) => String(plain(x)))
              .filter(Boolean)
              .map(one)
              .join(", ");
    const stages: Record<string, unknown> = {};
    for (const [slug, mark] of Object.entries((st.stages as Record<string, unknown>) ?? {})) {
      const key = this.stage(slug);
      if (key) stages[key] = mark;
    }
    return {
      intent: this.intent(st.intent),
      phase: this.phase(st.phase),
      currentStage: this.stage(st.currentStage),
      nextStage: this.stage(st.nextStage),
      status: this.word(st.status, "value", true),
      lastUpdated: time(st.lastUpdated),
      revisionCount: count(st.revisionCount),
      scope: this.scope(st.scope),
      depth: this.word(st.depth, "value", true),
      testStrategy: this.word(st.testStrategy, "value", true),
      totalStages: count(st.totalStages),
      completed: count(st.completed),
      // The stage running now, or `none`.
      inProgress: st.inProgress === "none" ? "none" : this.stage(st.inProgress),
      guardPolicy: this.word(plain(st.guardPolicy), "value", true),
      guardsOn: list(st.guardsOn, (x) => this.guard(x)),
      guardsOff: list(st.guardsOff, (x) => this.guard(x)),
      sensors: list(st.sensors, (x) => this.sensor(x)),
      planApproval: this.word(plain(st.planApproval), "value", true),
      stages,
    };
  }

  hooks(h: { last: Record<string, string>; drops: { ts: string; hook: string; reason: string; degraded: boolean }[] }) {
    const last: Record<string, string | null> = {};
    for (const [hook, ts] of Object.entries(h.last)) {
      const key = this.hook(hook);
      if (key) last[key] = time(ts);
    }
    return {
      last,
      // The reason a hook dropped a step is AI-DLC's own words when its source wrote them as a literal;
      // anything else (an exception message, a path) is `other`, and stays in local/.
      drops: h.drops.map((d) => ({
        ts: time(d.ts),
        hook: this.hook(d.hook),
        reason: /^[a-z][a-z -]{2,60}$/.test(d.reason) && this.v.words.has(d.reason) ? d.reason : "other",
        degraded: d.degraded,
      })),
    };
  }

  trees(trees: { dir: string; row: string | null; stampVersion: string | null; buildVersion: string | null; channel: string; kiroEngine: string | null }[]) {
    return trees.map((t) => ({
      dir: t.dir,
      row: t.row ? this.oneOf(HARNESS_ROWS, "harness", t.row) : null,
      stampVersion: version(t.stampVersion),
      buildVersion: version(t.buildVersion),
      channel: t.channel,
      kiroEngine: this.word(t.kiroEngine),
    }));
  }

  environment(env: {
    os: string;
    bun: string | null;
    pin: string | null;
    native: { dir: string; version: string | null; sourceRef: string | null; exe: string | null } | null;
    tools: Record<string, { version: string | null; source: string | null }>;
    kiroHomeEngine: { file: boolean; agentEngine: string | null };
  }) {
    const [os, release, arch] = env.os.split(" ");
    const sourceRef = env.native?.sourceRef ?? null;
    return {
      // The kernel release as the OS wrote it, which is how WSL shows; else its version only.
      os: [os, osRelease(os, release), arch].filter(Boolean).join(" "),
      bun: version(env.bun),
      pin: version(env.pin),
      native: env.native
        ? {
            dir: env.native.dir,
            exe: env.native.exe,
            version: version(env.native.version),
            sourceRef:
              // A commit keeps 13 characters: a full 40-character one reads as a secret to AI-DLC's rules, and 12
              // digits as an account number.
              sourceRef && /^[0-9a-f]{7,40}$/.test(sourceRef)
                ? sourceRef.slice(0, 13)
                : sourceRef && /^refs\/tags\/v\d+\.\d+\.\d+(?:-preview\.\d{8}\.\d+)?$/.test(sourceRef)
                  ? sourceRef
                  : sourceRef
                  ? this.labels.label("build", sourceRef)
                  : null,
          }
        : null,
      tools: Object.fromEntries(Object.entries(env.tools).map(([k, t]) => [k, { version: version(t.version), source: t.source }])),
      kiroHomeEngine: { file: env.kiroHomeEngine.file, agentEngine: this.word(env.kiroHomeEngine.agentEngine) },
    };
  }

  // `engine orchestrate next` keeps the words AI-DLC itself has; the rest of a command is dropped.
  private command(cmd: string): string | null {
    const [head, ...words] = cmd.split(" ");
    const kept = words.filter((w) => /^[a-z][a-z0-9-]{0,40}$/.test(w) && this.v.words.has(w));
    return head === "aidlc" && kept.length ? ["aidlc", ...kept].join(" ") : null;
  }

  private check(check: string): string {
    const m = check.match(/^sensor-([a-z][a-z-]*)(?: --stage ([a-z][a-z-]*))?$/);
    if (!m) return this.labels.label("check", check);
    const sensor = this.sensor(m[1]);
    return m[2] ? `sensor-${sensor} --stage ${this.stage(m[2])}` : `sensor-${sensor}`;
  }

  transcript(s: Summary | { tool: string; error: string; timeline: unknown[] }) {
    if ("error" in s) return { tool: s.tool, error: "this reader failed (details in local/errors.jsonl)" };
    const agentMap = (m: Record<string, number>) => this.keys(m, (k) => this.agent(k));
    const modelMap = (m: Record<string, number>) => this.keys(m, (k) => this.model(k));
    const subagents: Summary["subagents"] = {};
    for (const [name, a] of Object.entries(s.subagents)) {
      const key = this.agent(name);
      if (!key) continue;
      const prev = subagents[key] ?? { dispatches: 0, models: {}, efforts: {} };
      prev.dispatches += a.dispatches;
      for (const [m, n] of Object.entries(modelMap(a.models))) prev.models[m] = (prev.models[m] ?? 0) + n;
      for (const [e, n] of Object.entries(this.keys(a.efforts, (k) => this.effort(k)))) prev.efforts[e] = (prev.efforts[e] ?? 0) + n;
      subagents[key] = prev;
    }
    // Every field named, so a field a reader adds reaches safe.json only once it is shaped here.
    return {
      tool: s.tool,
      sessions: s.sessions,
      prompts: s.prompts,
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      stopFeedback: s.stopFeedback,
      approvalPrompts: s.approvalPrompts,
      questionsAsked: s.questionsAsked,
      engine: s.engine,
      reportSessions: s.reportSessions,
      mixedSessions: s.mixedSessions,
      notes: s.notes,
      firstTs: time(s.firstTs),
      lastTs: time(s.lastTs),
      denials: this.keys(s.denials, (k) => this.oneOf(DENIALS, "denial", k)),
      aidlcHookBlocks: this.keys(s.aidlcHookBlocks, (k) => this.hook(k)),
      aidlcCommands: this.keys(s.aidlcCommands, (k) => this.command(k)),
      repeats: s.repeats.map((r) => ({ ...r, tool: this.tool(r.tool) ?? "unknown", firstTs: time(r.firstTs), lastTs: time(r.lastTs) })),
      timeline: s.timeline.map((t) => ({
        ts: time(t.ts),
        kind: t.kind,
        detail: t.kind === "aidlc-hook-block" ? this.hook(t.detail) : t.kind === "tool-denied" ? this.oneOf(DENIALS, "denial", t.detail) : "",
      })),
      subagents,
      toolVersions: this.keys(s.toolVersions, (k) => version(k)),
      models: modelMap(s.models),
      efforts: this.keys(s.efforts, (k) => this.effort(k)),
      agents: agentMap(s.agents),
      approvalModes: this.keys(s.approvalModes, (k) => this.oneOf(APPROVAL_MODES, "mode", k)),
      handRunChecks: s.handRunChecks.map((c) => ({ ts: time(c.ts), check: this.check(c.check), pass: c.pass })),
      reportModels: modelMap(s.reportModels),
    };
  }

  doctorFinding(f: { id: string; severity: string }) {
    const id = /^[a-z0-9][a-z0-9-]{0,60}$/.test(f.id) && this.v.words.has(f.id) ? f.id : this.labels.label("doctor-finding", f.id);
    return { id, severity: /^(?:error|warning|warn|info)$/i.test(f.severity) ? f.severity.toLowerCase() : "other" };
  }
}

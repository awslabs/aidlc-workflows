// Agent runs for the review daemon: one agent process per intent, driven over
// ACP (aidlc-review-ui-acp.ts), so Start in the browser starts the work.
//
// What a run is. The daemon spawns the harness's agent in the project
// directory, binds that session to one intent (AIDLC_REVIEW_RUN, read by the
// SessionStart hook), and sends the prompt a human would have typed: `/aidlc`.
// From there the conductor runs the protocol exactly as in a terminal - the
// same hooks, the same engine, the same record - with two differences the
// daemon absorbs:
//   1. Tool calls the harness's own allow rules do not settle arrive as
//      permission requests; questions the agent asks (AskUserQuestion) arrive as
//      form elicitations. Both wait in `pending` until the browser answers.
//   2. When a turn ends (the agent stops), the session stays alive. A browser
//      round the Stop hook was already holding for resumes on its own; a
//      submission that lands while the turn is over is re-prompted by the
//      daemon with the same continuation text the hook would have used.
//
// One live run per project. The engine keeps one active-intent cursor per
// space and the workspace lock serializes mutation; two agents on two intents
// in one project is not a Phase 1 shape. Start while a run is live is refused.
//
// Persistence. `<record>/.review-ui/run.json` is the run's record - state,
// session id, pid - and `run-log.jsonl` its event log. On daemon start a run
// that was alive is re-attached with `session/load`; the human continues it
// from the browser. Nothing here is workflow state: the record, the audit
// ledger, and the stage files stay owned by the engine and the hooks.

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { intentsDir, isoTimestamp, listIntents, listSpaces, writeFileAtomic } from "./aidlc-lib.ts";
import {
  AcpClient,
  AcpError,
  type AcpElicitationRequest,
  type AcpElicitationResponse,
  type AcpLaunch,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
  type AcpStopReason,
} from "./aidlc-review-ui-acp.ts";
import { ENV_REVIEW_RUN, recordReviewUiDir } from "./aidlc-review-ui-shared.ts";

export const RUN_FILENAME = "run.json";
export const RUN_LOG_FILENAME = "run-log.jsonl";
export const RUN_EVENT_RING = 400;
// A turn that has run this long without stopping is cut off; a runaway backstop,
// not a budget. Browser waits inside the Stop hook count as turn time, so the
// ceiling stays well above the hook's own 20-minute hold.
export const ENV_REVIEW_TURN_MINUTES = "AIDLC_REVIEW_TURN_MINUTES";
const DEFAULT_TURN_MINUTES = 240;
const TEXT_FLUSH_MS = 400;

export type RunState = "starting" | "running" | "waiting" | "idle" | "ended" | "failed";

export interface RunRecord {
  version: 1;
  run_id: string;
  space: string;
  intent: string;
  backend: AcpLaunch["backend"];
  session_id: string | null;
  pid: number | null;
  state: RunState;
  started_at: string;
  updated_at: string;
  turns: number;
  last_stop_reason: AcpStopReason | null;
  error: string | null;
}

export type RunEvent =
  | { seq: number; t: string; kind: "turn"; phase: "start" | "stop"; prompt?: string; stop_reason?: AcpStopReason }
  | { seq: number; t: string; kind: "text"; text: string }
  | { seq: number; t: string; kind: "tool"; tool_call_id: string; title: string; tool_kind: string | null; status: string | null }
  | { seq: number; t: string; kind: "permission"; id: string; title: string; decision: string | null }
  | { seq: number; t: string; kind: "question"; id: string; message: string; answered: boolean }
  | { seq: number; t: string; kind: "note"; text: string }
  | { seq: number; t: string; kind: "error"; text: string };

// `Omit` over a union keeps only the common keys; distribute it so each event
// shape stays its own.
type EventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq" | "t"> : never) : never;

export type PendingInput =
  | { id: string; kind: "permission"; created_at: string; tool_call: AcpPermissionRequest["toolCall"]; options: AcpPermissionRequest["options"] }
  | { id: string; kind: "question"; created_at: string; message: string; schema: AcpElicitationRequest["requestedSchema"]; tool_call_id: string | null };

export interface RunView {
  run: RunRecord;
  pending: PendingInput[];
  events: RunEvent[];
  available: boolean;
}

interface LiveRun {
  record: RunRecord;
  client: AcpClient;
  events: RunEvent[];
  seq: number;
  pending: Map<string, { input: PendingInput; resolve: (value: AcpPermissionOutcome | AcpElicitationResponse) => void }>;
  turn: Promise<void> | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  textBuffer: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  toolEvents: Map<string, RunEvent & { kind: "tool" }>;
  nextInput: number;
}

export interface RunManagerOptions {
  projectDir: string;
  launch: AcpLaunch | null;
  /** Called after every change the browser should see; debounced by the caller. */
  publish: (intent: string) => void;
  log?: (line: string) => void;
}

export class RunBusyError extends Error {
  constructor(readonly run: RunRecord) {
    super(`an intent is already running: ${run.intent}`);
  }
}

export class RunManager {
  private readonly runs = new Map<string, LiveRun>();
  private readonly finished = new Map<string, { record: RunRecord; events: RunEvent[] }>();
  private readonly turnMinutes: number;

  constructor(private readonly options: RunManagerOptions) {
    const raw = Number(process.env[ENV_REVIEW_TURN_MINUTES]);
    this.turnMinutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_MINUTES;
  }

  get available(): boolean {
    return this.options.launch !== null;
  }

  /** The run whose agent process is alive, if any. */
  live(): RunRecord | null {
    for (const run of this.runs.values()) {
      if (!run.client.exited) return run.record;
    }
    return null;
  }

  isLive(intent: string): boolean {
    const live = this.runs.get(intent);
    return live !== undefined && !live.client.exited;
  }

  /** The space whose registry lists this record, or null. */
  spaceOf(intent: string): string | null {
    for (const space of listSpaces(this.options.projectDir)) {
      if (listIntents(this.options.projectDir, space.name).some((entry) => entry.dirName === intent)) return space.name;
    }
    return null;
  }

  /** The run state shown on an intent row, or null when the intent never ran. */
  stateOf(intent: string): RunState | null {
    const live = this.runs.get(intent);
    if (live && !live.client.exited) return live.record.state;
    return (this.finished.get(intent) ?? this.readFromDisk(intent))?.record.state ?? null;
  }

  view(intent: string): RunView | null {
    const live = this.runs.get(intent);
    if (live) {
      return {
        run: live.record,
        pending: [...live.pending.values()].map((entry) => entry.input),
        events: live.events,
        available: this.available,
      };
    }
    const done = this.finished.get(intent) ?? this.readFromDisk(intent);
    if (!done) return null;
    return { run: done.record, pending: [], events: done.events, available: this.available };
  }

  /** Spawn the agent for `intent`, bind the session, and send the first prompt. */
  async start(space: string, intent: string, prompt = "/aidlc"): Promise<RunRecord> {
    if (!this.options.launch) throw new AcpError("no agent runner is available on this machine");
    const busy = this.live();
    if (busy) throw new RunBusyError(busy);
    const now = isoTimestamp();
    const record: RunRecord = {
      version: 1,
      run_id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      space,
      intent,
      backend: this.options.launch.backend,
      session_id: null,
      pid: null,
      state: "starting",
      started_at: now,
      updated_at: now,
      turns: 0,
      last_stop_reason: null,
      error: null,
    };
    const live = this.attach(record, this.options.launch);
    this.finished.delete(intent);
    this.persist(live);
    this.options.publish(intent);
    try {
      await live.client.start({ [ENV_REVIEW_RUN]: `${space}/${intent}` });
      const session = await live.client.newSession();
      record.session_id = session.sessionId;
      record.pid = live.client.pid;
      this.persist(live);
    } catch (error) {
      this.fail(live, error);
      throw error;
    }
    this.beginTurn(live, prompt);
    return record;
  }

  /** Send a prompt to an idle run (the agent stopped; the session is alive). */
  prompt(intent: string, text: string): RunRecord {
    const live = this.requireLive(intent);
    if (live.turn) throw new AcpError("the agent is still working; wait for it to stop");
    this.beginTurn(live, text);
    return live.record;
  }

  /**
   * A browser round landed (answers saved, gate decided). If the run's turn is
   * over, the daemon carries the continuation the Stop hook would have; if the
   * turn is still live the hook is holding for exactly this write and nothing
   * is sent - it would arrive as a second, competing instruction.
   */
  continueAfterBrowser(intent: string, text: string): boolean {
    const live = this.runs.get(intent);
    if (!live || live.client.exited || live.turn) return false;
    this.beginTurn(live, text);
    return true;
  }

  resolvePermission(intent: string, id: string, optionId: string): void {
    const live = this.requireLive(intent);
    const entry = live.pending.get(id);
    if (entry?.input.kind !== "permission") throw new AcpError("no such pending permission");
    const option = entry.input.options.find((candidate) => candidate.optionId === optionId);
    if (!option) throw new AcpError("unknown permission option");
    live.pending.delete(id);
    this.markEvent(live, "permission", id, (event) => {
      if (event.kind === "permission") event.decision = option.name;
    });
    entry.resolve({ outcome: "selected", optionId });
    this.afterPendingChange(live);
  }

  resolveQuestion(intent: string, id: string, response: AcpElicitationResponse): void {
    const live = this.requireLive(intent);
    const entry = live.pending.get(id);
    if (entry?.input.kind !== "question") throw new AcpError("no such pending question");
    live.pending.delete(id);
    this.markEvent(live, "question", id, (event) => {
      if (event.kind === "question") event.answered = true;
    });
    entry.resolve(response);
    this.afterPendingChange(live);
  }

  /** Stop the current turn; an idle run's process is closed and the run ends. */
  cancel(intent: string): RunRecord {
    const live = this.requireLive(intent);
    if (live.turn && live.record.session_id) {
      // Pending inputs cannot outlive the turn they belong to.
      for (const [id, entry] of live.pending) {
        live.pending.delete(id);
        entry.resolve(entry.input.kind === "permission" ? { outcome: "cancelled" } : { action: "cancel" });
      }
      live.client.cancel(live.record.session_id);
      this.note(live, "Stop requested.");
      return live.record;
    }
    this.end(live, "ended", null);
    return live.record;
  }

  /** Re-attach runs that were alive when the daemon last stopped. */
  async resumeFromDisk(): Promise<void> {
    if (!this.options.launch) return;
    for (const space of listSpaces(this.options.projectDir)) {
      for (const entry of listIntents(this.options.projectDir, space.name)) {
        const dirName = entry.dirName;
        if (!dirName) continue;
        const stored = this.readFromDisk(dirName, space.name);
        if (!stored || stored.record.state === "ended" || stored.record.state === "failed") continue;
        if (!stored.record.session_id) {
          stored.record.state = "failed";
          stored.record.error = "the run never reached a session";
          this.writeRecord(stored.record);
          continue;
        }
        if (this.live()) break;
        const record: RunRecord = { ...stored.record, state: "starting", pid: null, updated_at: isoTimestamp(), error: null };
        const live = this.attach(record, this.options.launch, stored.events);
        this.persist(live);
        try {
          await live.client.start({ [ENV_REVIEW_RUN]: `${record.space}/${record.intent}` });
          await live.client.loadSession(record.session_id!);
          record.pid = live.client.pid;
          // The replayed transcript arrived as text; land it before the note.
          this.flushText(live);
          this.setState(live, "idle");
          this.note(live, "Session restored after the daemon restarted. Continue when ready.");
        } catch (error) {
          this.fail(live, error, "the agent session could not be restored; start a new run from the intent");
        }
      }
    }
  }

  /** Close every agent process; a live run is left `idle` so a restart can resume it. */
  shutdown(): void {
    for (const live of this.runs.values()) {
      if (live.client.exited) continue;
      clearTimeout(live.turnTimer ?? undefined);
      this.flushText(live);
      if (live.record.state !== "ended" && live.record.state !== "failed") {
        live.record.state = "idle";
        live.record.pid = null;
        live.record.updated_at = isoTimestamp();
        this.writeRecord(live.record);
      }
      live.client.close();
    }
  }

  // ---- internals -------------------------------------------------------------

  private attach(record: RunRecord, launch: AcpLaunch, events: RunEvent[] = []): LiveRun {
    const live: LiveRun = {
      record,
      client: null as unknown as AcpClient,
      events,
      seq: events.length ? events[events.length - 1].seq : 0,
      pending: new Map(),
      turn: null,
      turnTimer: null,
      textBuffer: "",
      textTimer: null,
      toolEvents: new Map(),
      nextInput: 1,
    };
    live.client = new AcpClient(launch, this.options.projectDir, {
      onUpdate: (update) => this.onUpdate(live, update),
      onPermission: (request) => this.onPermission(live, request),
      onElicitation: (request) => this.onElicitation(live, request),
      onStderr: (line) => this.options.log?.(`[run ${record.intent}] ${line}`),
      onExit: (code, signal) => this.onExit(live, code, signal),
    });
    this.runs.set(record.intent, live);
    return live;
  }

  private requireLive(intent: string): LiveRun {
    const live = this.runs.get(intent);
    if (!live || live.client.exited) throw new AcpError("no live run for this intent");
    return live;
  }

  private beginTurn(live: LiveRun, prompt: string): void {
    const sessionId = live.record.session_id;
    if (!sessionId) throw new AcpError("run has no session");
    live.record.turns += 1;
    live.record.last_stop_reason = null;
    this.push(live, { kind: "turn", phase: "start", prompt });
    this.setState(live, "running");
    clearTimeout(live.turnTimer ?? undefined);
    live.turnTimer = setTimeout(() => {
      this.note(live, `Turn exceeded ${this.turnMinutes} minutes; stopping it.`);
      live.client.cancel(sessionId);
    }, this.turnMinutes * 60_000);
    live.turn = live.client
      .prompt(sessionId, prompt)
      .then((stopReason) => {
        this.flushText(live);
        live.record.last_stop_reason = stopReason;
        this.push(live, { kind: "turn", phase: "stop", stop_reason: stopReason });
        if (!live.client.exited) this.setState(live, "idle");
      })
      .catch((error: unknown) => {
        this.flushText(live);
        if (!live.client.exited) this.fail(live, error);
      })
      .finally(() => {
        clearTimeout(live.turnTimer ?? undefined);
        live.turnTimer = null;
        live.turn = null;
      });
  }

  private onUpdate(live: LiveRun, update: AcpSessionUpdate): void {
    const body = update.update;
    switch (body.sessionUpdate) {
      case "agent_message_chunk": {
        const content = body.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") this.bufferText(live, content.text);
        return;
      }
      case "tool_call": {
        this.flushText(live);
        const id = String(body.toolCallId ?? "");
        const event = this.push(live, {
          kind: "tool",
          tool_call_id: id,
          title: typeof body.title === "string" ? body.title : "Tool call",
          tool_kind: typeof body.kind === "string" ? body.kind : null,
          status: typeof body.status === "string" ? body.status : null,
        }) as RunEvent & { kind: "tool" };
        if (id) live.toolEvents.set(id, event);
        return;
      }
      case "tool_call_update": {
        const id = String(body.toolCallId ?? "");
        const event = live.toolEvents.get(id);
        if (!event) return;
        if (typeof body.status === "string") event.status = body.status;
        if (typeof body.title === "string") event.title = body.title;
        this.touch(live);
        return;
      }
      default:
        // Thoughts, plans, mode and command lists carry nothing the review
        // surface shows; the transcript itself lives with the harness.
        return;
    }
  }

  private async onPermission(live: LiveRun, request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    this.flushText(live);
    const id = `p${live.nextInput++}`;
    const input: PendingInput = {
      id,
      kind: "permission",
      created_at: isoTimestamp(),
      tool_call: request.toolCall,
      options: request.options,
    };
    this.push(live, { kind: "permission", id, title: request.toolCall.title, decision: null });
    const { promise, resolve } = Promise.withResolvers<AcpPermissionOutcome | AcpElicitationResponse>();
    live.pending.set(id, { input, resolve });
    this.setState(live, "waiting");
    return (await promise) as AcpPermissionOutcome;
  }

  private async onElicitation(live: LiveRun, request: AcpElicitationRequest): Promise<AcpElicitationResponse> {
    this.flushText(live);
    const id = `q${live.nextInput++}`;
    const input: PendingInput = {
      id,
      kind: "question",
      created_at: isoTimestamp(),
      message: request.message,
      schema: request.requestedSchema,
      tool_call_id: request.toolCallId ?? null,
    };
    this.push(live, { kind: "question", id, message: request.message, answered: false });
    const { promise, resolve } = Promise.withResolvers<AcpPermissionOutcome | AcpElicitationResponse>();
    live.pending.set(id, { input, resolve });
    this.setState(live, "waiting");
    return (await promise) as AcpElicitationResponse;
  }

  private afterPendingChange(live: LiveRun): void {
    if (live.pending.size === 0 && live.turn && live.record.state === "waiting") this.setState(live, "running");
    else this.touch(live);
  }

  private onExit(live: LiveRun, code: number | null, signal: NodeJS.Signals | null): void {
    clearTimeout(live.turnTimer ?? undefined);
    this.flushText(live);
    for (const [id, entry] of live.pending) {
      live.pending.delete(id);
      entry.resolve(entry.input.kind === "permission" ? { outcome: "cancelled" } : { action: "cancel" });
    }
    if (live.record.state === "ended" || live.record.state === "failed") return;
    // The daemon's own shutdown leaves the record idle for a later resume; any
    // other exit while the run was supposed to be alive is a failure.
    if (live.record.state === "idle" && live.record.pid === null) return;
    this.end(live, "failed", `agent process exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`);
  }

  private fail(live: LiveRun, error: unknown, message?: string): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.end(live, "failed", message ? `${message}: ${detail}` : detail);
  }

  private end(live: LiveRun, state: "ended" | "failed", error: string | null): void {
    clearTimeout(live.turnTimer ?? undefined);
    this.flushText(live);
    live.record.state = state;
    live.record.error = error;
    live.record.pid = null;
    live.record.updated_at = isoTimestamp();
    if (error) this.push(live, { kind: "error", text: error });
    else this.push(live, { kind: "note", text: "Run ended." });
    this.writeRecord(live.record);
    this.runs.delete(live.record.intent);
    this.finished.set(live.record.intent, { record: live.record, events: live.events });
    live.client.close();
    this.options.publish(live.record.intent);
  }

  private setState(live: LiveRun, state: RunState): void {
    live.record.state = state;
    live.record.updated_at = isoTimestamp();
    this.writeRecord(live.record);
    this.options.publish(live.record.intent);
  }

  private touch(live: LiveRun): void {
    this.options.publish(live.record.intent);
  }

  private note(live: LiveRun, text: string): void {
    this.push(live, { kind: "note", text });
  }

  private bufferText(live: LiveRun, text: string): void {
    live.textBuffer += text;
    if (live.textTimer) return;
    live.textTimer = setTimeout(() => this.flushText(live), TEXT_FLUSH_MS);
  }

  private flushText(live: LiveRun): void {
    clearTimeout(live.textTimer ?? undefined);
    live.textTimer = null;
    if (!live.textBuffer) return;
    const text = live.textBuffer;
    live.textBuffer = "";
    const last = live.events[live.events.length - 1];
    if (last && last.kind === "text") {
      last.text += text;
      this.appendLog(live.record, { ...last, text });
      this.touch(live);
      return;
    }
    this.push(live, { kind: "text", text });
  }

  private push(live: LiveRun, event: EventBody): RunEvent {
    const full = { ...event, seq: ++live.seq, t: isoTimestamp() } as RunEvent;
    live.events.push(full);
    if (live.events.length > RUN_EVENT_RING) live.events.splice(0, live.events.length - RUN_EVENT_RING);
    this.appendLog(live.record, full);
    this.options.publish(live.record.intent);
    return full;
  }

  private markEvent(live: LiveRun, kind: "permission" | "question", id: string, mutate: (event: RunEvent) => void): void {
    const event = live.events.find((candidate) => candidate.kind === kind && (candidate as { id: string }).id === id);
    if (event) {
      mutate(event);
      this.appendLog(live.record, event);
    }
  }

  private recordDir(space: string, intent: string): string {
    return join(intentsDir(this.options.projectDir, space), intent);
  }

  private persist(live: LiveRun): void {
    this.writeRecord(live.record);
  }

  private writeRecord(record: RunRecord): void {
    const dir = recordReviewUiDir(this.recordDir(record.space, record.intent));
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, RUN_FILENAME), `${JSON.stringify(record, null, 2)}\n`);
  }

  private appendLog(record: RunRecord, event: RunEvent): void {
    try {
      const dir = recordReviewUiDir(this.recordDir(record.space, record.intent));
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, RUN_LOG_FILENAME), `${JSON.stringify(event)}\n`);
    } catch {
      // The log is a convenience; the run does not depend on it.
    }
  }

  private readFromDisk(intent: string, space?: string): { record: RunRecord; events: RunEvent[] } | null {
    const spaces = space ? [space] : listSpaces(this.options.projectDir).map((entry) => entry.name);
    for (const candidate of spaces) {
      const dir = recordReviewUiDir(this.recordDir(candidate, intent));
      const path = join(dir, RUN_FILENAME);
      if (!existsSync(path)) continue;
      try {
        const record = JSON.parse(readFileSync(path, "utf-8")) as RunRecord;
        if (record?.version !== 1 || record.intent !== intent) continue;
        return { record, events: readLogTail(join(dir, RUN_LOG_FILENAME)) };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readLogTail(path: string): RunEvent[] {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim());
    const events: RunEvent[] = [];
    const bySeq = new Map<number, RunEvent>();
    for (const line of lines.slice(-RUN_EVENT_RING * 2)) {
      try {
        const event = JSON.parse(line) as RunEvent;
        if (typeof event?.seq !== "number") continue;
        // A text event's continuation and a permission/question's resolution
        // are appended under the same seq; the last write is the whole event.
        if (event.kind === "text" && bySeq.has(event.seq)) {
          const prior = bySeq.get(event.seq) as RunEvent & { kind: "text" };
          prior.text += event.text;
          continue;
        }
        if (!bySeq.has(event.seq)) events.push(event);
        else events[events.findIndex((candidate) => candidate.seq === event.seq)] = event;
        bySeq.set(event.seq, event);
      } catch {
        // skip a torn line
      }
    }
    return events.slice(-RUN_EVENT_RING);
  } catch {
    return [];
  }
}

/** Remove a run's files; used when a record is deleted or reset. */
export function removeRunFiles(recordDir: string): void {
  for (const name of [RUN_FILENAME, RUN_LOG_FILENAME]) {
    try {
      unlinkSync(join(recordReviewUiDir(recordDir), name));
    } catch {
      // absent is fine
    }
  }
}

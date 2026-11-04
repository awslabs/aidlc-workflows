import type { HealthCounts } from "./hooks-map";
export type Iso = string; // "2026-08-12T17:13:18Z"
export interface AuditEvent {
  ts: Iso; event: string | null; heading: string;
  fields: Record<string, string>; shard: string; seq: number;
  /** 1-based shard lines of this entry's block (first to last non-blank line), when parsed with line tracking. */
  line?: number; endLine?: number;
}
export type StageState = "done" | "running" | "waiting" | "todo" | "skip";
export type PhaseKey = "initialization" | "ideation" | "inception" | "construction" | "operation" | "unknown";
/** `perUnit`: the compiled graph runs this stage once per unit of work (`for_each`). */
export interface CatalogStage { slug: string; name: string; phase: PhaseKey; lead: string; order: number; perUnit: boolean }
export interface PlanRow { slug: string; mark: string; disposition: "EXECUTE" | "SKIP" }
export interface StageView {
  slug: string; name: string; phase: PhaseKey; lead: string; state: StageState;
  firstStart: Iso | null; completed: Iso | null; redos: number; planned: boolean;
}
export type CellState = "done" | "inferred" | "running" | "waiting" | "paused" | "na" | "todo";
export interface UnitRow { name: string; batch: number | null; kind: string | null; cells: Record<string, CellState> }
export interface NeedItem { kind: "gate" | "question" | "plan"; stage: string; unit: string | null; since: Iso | null; detail: string }
/** `ended`: the newest event is a chat ending. The audit does not name the chat, so it never means the intent is over. */
export type Liveness = "active" | "idle" | "ended";
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Recorded<T> = { recorded: true; value: T } | { recorded: false; reason: string };
export interface StoryEvent { ts: Iso; kind: string; stage: string | null; unit: string | null; text: string; raw: AuditEvent }
export interface IntentModel {
  key: string; workspace: string; space: string; dir: string; uuid: string | null;
  name: string; title: string | null; scope: string | null; depth: string | null; started: Iso | null;
  status: string; stages: StageView[]; plannedCount: number; doneCount: number; skippedCount: number;
  current: { stage: string | null; unit: string | null; phase: PhaseKey };
  /** The unit matrix columns, in stage order: the graph's per-unit stages plus any stage with recorded unit events. */
  unitStages: string[];
  /** The per-unit stages each unit owes: `unitStages` minus those the active plan skips; see `unitIsDone`. */
  unitOwed: string[]; units: UnitRow[]; unitsPlanned: number | null; unitsDone: number;
  needs: NeedItem[]; liveness: Liveness; lastEventTs: Iso | null;
  tokens: Recorded<Tokens>; reviews: { ready: number; notReady: number };
  events: StoryEvent[]; notes: string[]; unparsed: number;
  /** Per stage (fields.Stage ?? fields["Stage slug"] ?? "_"): counts of the events folded out of `events`. */
  hiddenCounts: Record<string, HiddenCounts>;
}
export interface HiddenCounts {
  /** SENSOR_PASSED without a `Note` only: a pass that carries a Note did not run and is counted in `sensorNotRun`. */
  sensorPassed: number; sensorFired: number; humanTurns: number;
  /** SENSOR_PASSED entries with a `Note` (tool-unavailable, script-error, …); present only when there is at least one. */
  sensorNotRun?: number;
}
export interface IntentSummary extends Omit<IntentModel, "events" | "stages" | "hiddenCounts"> {
  phases: { key: PhaseKey; done: number; planned: number; skipped: number }[];
}
export interface WorkspaceSummary {
  path: string; label: string; origin: "root" | "pin"; root: string | null;
  status: "ok" | "missing" | "partial" | "empty"; problem: string | null;
  intents: IntentSummary[]; rulesLearned: number; sampleRule: string | null;
}
export interface HomePayload {
  workspaces: WorkspaceSummary[]; needs: (NeedItem & { intent: string; intentName: string })[]; generatedAt: Iso;
  /** "Needs fixing" counts across every workspace (the header's Health badge); `byIntent` keys are `<ws>::<space>/<dir>`. */
  health?: HealthCounts;
}

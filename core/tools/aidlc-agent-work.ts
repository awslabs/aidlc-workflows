// The work an AI-DLC agent did, in the terms the engine issued it.
//
// The SubagentStop hook records the stage and Unit an agent finished on
// (`Agent Stage`, `Agent Unit` on its SUBAGENT_COMPLETED row), and the
// PreToolUse check on SendMessage compares that row with the work on record
// now. Both read it here, from the step the engine last issued: Current Stage
// stays on a Unit's first per-Unit stage while that Unit works through the later
// ones, and Active Unit is gone once the Unit completes, so neither state field
// says what an agent was doing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  agentsDir,
  enterHookWorkflow,
  isAidlcAgentFile,
  readIssuedDirectiveMarker,
} from "./aidlc-lib.ts";

/** The `SUBAGENT_COMPLETED` fields naming the stage and Unit the agent finished on. */
export const AGENT_STAGE_FIELD = "Agent Stage";
export const AGENT_UNIT_FIELD = "Agent Unit";

export interface AgentWork {
  stage: string;
  unit: string | null;
}

const EXEMPT_AGENTS = new Set(["aidlc-composer-agent"]);

/**
 * An AI-DLC agent that gets the stage's rules at dispatch: a named agent file
 * the installation ships, other than the composer. Any other agent the person
 * or the conductor starts (a general-purpose one, a plugin's) is not one.
 */
export function isAidlcAgent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]*-agent$/.test(value) &&
    existsSync(join(agentsDir(), `${value}.md`)) &&
    isAidlcAgentFile(join(agentsDir(), `${value}.md`)) &&
    !EXEMPT_AGENTS.has(value)
  );
}

/**
 * The stage and Unit of the step the engine last issued for the chat's work,
 * or null when it issued none or that cannot be read. Never throws: evidence
 * only, so a failure leaves the row without the fields and the check silent.
 */
export function workOnRecord(projectDir: string, sessionId: unknown): AgentWork | null {
  let workflow: ReturnType<typeof enterHookWorkflow> | null = null;
  try {
    workflow = enterHookWorkflow(projectDir, sessionId);
    const issued = readIssuedDirectiveMarker(projectDir, null);
    return issued ? { stage: issued.stage, unit: issued.unit?.trim() || null } : null;
  } catch {
    return null;
  } finally {
    workflow?.restore();
  }
}

/** The work as a line names it: `user-stories`, or `code-generation (Unit u1)`. */
export function workName(work: AgentWork): string {
  return work.unit ? `${work.stage} (Unit ${work.unit})` : work.stage;
}

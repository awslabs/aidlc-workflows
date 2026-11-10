// The person's own step to a clean chat in the host they are in, from the
// tree's tools/data/harness.json `newChatStep` (each harness's manifest). The
// host this tree runs in is told apart as the hook lines are, by the agent
// shell's environment (inHostShell); `<entry>` is filled in as there.

import { readFileSync } from "node:fs";
import { fillHookActivationText, harnessDataPath, hostLine } from "./aidlc-lib.ts";
import { harnessIsAGuess, inHostShell } from "./aidlc-runtime-paths.ts";

type NewChatStep = { text: string; inHost?: { env: string[]; text: string } };

// A line for the person, so a step that is not well formed is none.
function shippedNewChatStep(): NewChatStep | null {
  try {
    const parsed = JSON.parse(readFileSync(harnessDataPath(), "utf-8")) as {
      newChatStep?: { text?: unknown; inHost?: unknown } | null;
    };
    const step = parsed.newChatStep;
    if (typeof step?.text !== "string" || step.text.trim() === "") return null;
    return { text: step.text, ...hostLine("inHost", step.inHost) };
  } catch {
    return null;
  }
}

/**
 * The person's step to a clean chat in the host the agent's shell is in,
 * filled in, or null when this tree names none or the engine only guessed it
 * is theirs (a native engine with several tools set up and no tool's mark on
 * the command). Never throws.
 */
export function newChatStep(): string | null {
  if (harnessIsAGuess()) return null;
  const step = shippedNewChatStep();
  if (step === null) return null;
  try {
    return fillHookActivationText(step.inHost && inHostShell(step.inHost.env) ? step.inHost.text : step.text);
  } catch {
    return null;
  }
}

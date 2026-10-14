// covers: scope:classic, file:harness/copilot/hooks/aidlc-copilot-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the GitHub Copilot CLI tree, with no model: the journey
// of t-scope-host-claude, with every hook moment fired through the commands the
// shipped .github/hooks/aidlc.json registers and fed Copilot CLI's own payloads
// (questions answered by typing, AI-DLC's own commands run as the PreToolUse
// hook rewrote them, helpers bracketed by SubagentStart and SubagentStop).

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("copilot");

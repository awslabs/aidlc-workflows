// covers: scope:classic, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Claude Code tree, with no model, through a fresh
// clone and a second chat: two Units built one at a time with a checkpoint
// each; after the first Unit's checkpoint the person stops for the day, picks
// the work up from a fresh clone and carries on in a new chat
// (tests/harness/scope-hosts.ts says what the journey checks). The Codex and
// Copilot files run the same journey through their own trees' hooks.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("claude");

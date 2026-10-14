// covers: scope:classic, file:harness/codex/hooks/aidlc-codex-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Codex CLI tree, with no model: the journey of
// t-scope-host-claude, with every hook moment fired through the commands the
// shipped .codex/hooks.json registers and fed Codex's own payloads (apply_patch
// for files, request_user_input for picks, spawn_agent for helpers, the chat's
// thread as CODEX_THREAD_ID in the agent's shell).

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("codex");

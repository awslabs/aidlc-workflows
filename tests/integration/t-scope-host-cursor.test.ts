// covers: scope:classic, file:harness/cursor/hooks/aidlc-cursor-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Cursor tree, with no model: the journey of
// t-scope-host-claude, with every hook moment fired through the commands the
// shipped .cursor/hooks.json registers and fed cursor-agent's own payloads.
// Every answer is JSON at exit 0 (a refusal is a deny, failClosed refuses
// anything but an allow), and the turn end can only send a follow-up message.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("cursor");

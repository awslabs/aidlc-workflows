// covers: scope:classic, file:harness/antigravity/hooks/aidlc-antigravity-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Antigravity tree, with no model: the journey of
// t-scope-host-claude, with every hook moment fired through the commands the
// shipped .agents/hooks.json registers and fed the Antigravity CLI's own
// payloads. Every answer is JSON at exit 0 (a refusal is a deny, and no answer
// is a deny too), the person's turns are read from the transcript, and a turn
// end can be refused with `continue`.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("antigravity");

// covers: scope:classic, file:harness/opencode/plugin/aidlc-opencode-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the opencode tree, with no model: the journey of
// t-scope-host-claude, through AI-DLC's plugin loaded into one opencode
// process (a worker thread the host waits on), with opencode's own hook calls:
// a refusal is the hook's thrown error, a turn end that blocks sends a nudge,
// and a helper's calls run in a child session.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("opencode");

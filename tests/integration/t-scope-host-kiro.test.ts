// covers: scope:classic, file:harness/kiro/hooks/aidlc-kiro-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Kiro CLI tree, with no model: the journey of
// t-scope-host-claude, with every hook moment fired through the commands the
// shipped agent JSON registers (.kiro/agents/aidlc.json, glob matchers over a
// tool's name and its alias) and fed Kiro CLI 2.29's own payloads. The
// person-turn hook may run the first `next` itself; each helper runs its own
// agent JSON's hooks under a session of its own.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("kiro");

// covers: scope:classic, file:harness/kiro-ide/hooks/aidlc-kiro-adapter.ts, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Kiro IDE tree, with no model: the journey of
// t-scope-host-claude, with every hook moment fired through the shipped hook
// cards (.kiro/hooks/*.json, regex matchers, file-name order) and fed Kiro IDE
// 1.2.37's own payloads. No card runs after a write or a command; the next
// card does that work, as in Kiro.

import { hostJourneySuite } from "../harness/scope-hosts.ts";

hostJourneySuite("kiro-ide");

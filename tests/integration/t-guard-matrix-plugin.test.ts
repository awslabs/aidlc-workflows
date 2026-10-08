// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A team's own plugin
// (a synthetic one, composed by its hook) whose scope says `guard_policy: off` and
// puts Requirements, Units Generation, Code Generation and Build and Test under it
// with `adds.scopes`. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite, pluginCell } from "../harness/guard-matrix.ts";

guardMatrixSuite("a plugin's scope with the guards off", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit-unclaimed", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "second-review", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope" },
]);

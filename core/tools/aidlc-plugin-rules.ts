// A plugin's rules section in a rule file: its own `##` heading, then the
// opening marker on the line under it (renderRulesBlock in aidlc-plugin.ts
// writes both). The group is the plugin. Doctor's rule reader (aidlc-graph.ts)
// and the plugin sync read it from here, so the marker has one shape.
export const PLUGIN_RULES_OPENING = /^<!-- plugin:([a-z][a-z0-9-]*):rules:\d+:[0-9a-f]+ -->$/;

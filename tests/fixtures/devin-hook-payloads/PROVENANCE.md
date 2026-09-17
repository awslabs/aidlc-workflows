# Provenance — Devin hook payload fixtures

- `captured-3000.6.14.json`: real hook stdin events captured live from
  Devin CLI **3000.6.14** (build 18033302) on Linux/WSL2 via a capture-only
  `.devin/hooks.v1.json` logger writing one file per event. See
  `capture-provenance.json` for the full case-by-case capture matrix and
  contract findings.
- `payloads.json`: synthetic/compatibility fixtures (NOT captured); retained
  for fields and events the live capture never exercised. Its session/turn
  ids are synthetic UUIDs and its `/tmp/devin-test/` paths are placeholders.

## Redaction applied

- Real `session_id` slugs, `prompt_id` UUIDs, `tool_use_id` hexes,
  `agent_id` hexes, and shell ids → `<placeholder>` tokens.
- Local paths (`/home/<user>/…`, `/tmp/…` capture roots) → `<user-home>` /
  `<tmpdir>` placeholders.
- User prompt text → `<prompt: …>` placeholders.
- The capturing user's home path in `capture-provenance.json`
  (`cliBinary`) → `<user-home>`.
- No secrets, hostnames, real document content, or unredacted user prompts
  remain. Property names, nesting, booleans, missing-vs-null distinctions,
  and correlation relationships are preserved exactly.

The removed `evidence/` directory held raw e2e run transcripts; nothing in
the test suite loaded it — these fixtures are the only deterministic inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const composer = readFileSync(new URL('../../harness/hermes/skills/aidlc/composer.md', import.meta.url), 'utf8');
const ensemble = readFileSync(new URL('../../core/aidlc-common/protocols/stage-protocol-ensemble.md', import.meta.url), 'utf8');
const hermes = ensemble.split('### Hermes Agent\n')[1];

test('composer delegates with explicit persona and dispatch instructions', () => {
  assert.match(composer, /delegate_task/);
  assert.match(composer, /aidlc-composer-agent\.md/);
  assert.match(composer, /persona[^.]*context/i);
  assert.doesNotMatch(composer, /via the `task` tool|agent loads its own persona/);
});

test('ensemble delegations carry the appropriate persona and stage brief', () => {
  assert.match(hermes, /delegate_task/);
  assert.match(hermes, /persona[^.]*stage brief/i);
  assert.match(hermes, /each delegation/i);
  assert.doesNotMatch(hermes, /loads its persona automatically|do not inject it/);
});

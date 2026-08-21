const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rekeySessionActivity } = require('../public/session-rekey');

function state({ busy = [], ready = [], attention = [] } = {}) {
  return {
    sessionBusyState: new Map(busy),
    responseReadySessions: new Set(ready),
    attentionSessions: new Set(attention),
  };
}

test('busy flag moves from old id to new id (the reported bug: stuck "Ready")', () => {
  // A session working on a background agent is busy under its temp id, then forks
  // to the real Claude session id. Without migration the busy flag is orphaned
  // and the new-id row falls through to the "Ready" tier.
  const s = state({ busy: [['old', true]] });
  rekeySessionActivity('old', 'new', s);
  assert.equal(s.sessionBusyState.has('old'), false);
  assert.equal(s.sessionBusyState.get('new'), true);
});

test('a false busy value is preserved, not dropped', () => {
  // Migration must carry the value, not merely re-add the key as truthy.
  const s = state({ busy: [['old', false]] });
  rekeySessionActivity('old', 'new', s);
  assert.equal(s.sessionBusyState.has('old'), false);
  assert.equal(s.sessionBusyState.get('new'), false);
});

test('unread-answer and needs-input marks move too', () => {
  const s = state({ ready: ['old'], attention: ['old'] });
  rekeySessionActivity('old', 'new', s);
  assert.equal(s.responseReadySessions.has('old'), false);
  assert.equal(s.responseReadySessions.has('new'), true);
  assert.equal(s.attentionSessions.has('old'), false);
  assert.equal(s.attentionSessions.has('new'), true);
});

test('a session with no tracked activity is left untouched', () => {
  const s = state({ busy: [['other', true]] });
  rekeySessionActivity('old', 'new', s);
  assert.equal(s.sessionBusyState.has('new'), false);
  assert.equal(s.sessionBusyState.get('other'), true);
});

test('no-op when ids are equal, missing, or state is absent', () => {
  const s = state({ busy: [['x', true]] });
  rekeySessionActivity('x', 'x', s);
  assert.equal(s.sessionBusyState.get('x'), true); // unchanged
  assert.doesNotThrow(() => rekeySessionActivity('', 'new', s));
  assert.doesNotThrow(() => rekeySessionActivity('old', '', s));
  assert.doesNotThrow(() => rekeySessionActivity('old', 'new', null));
});

test('tolerates a state object missing some collections', () => {
  const partial = { sessionBusyState: new Map([['old', true]]) };
  assert.doesNotThrow(() => rekeySessionActivity('old', 'new', partial));
  assert.equal(partial.sessionBusyState.get('new'), true);
});

// --- Session re-key: migrate activity state across an id change ---
//
// When a session forks, accepts a plan, or resolves its temporary pty id to the
// real Claude session id, it gets a new id and the sidebar re-keys the maps that
// track it. The activity collections must move too: a busy flag, an unread-answer
// mark or a needs-input flag left behind under the old id strands the session in
// the wrong tier — most visibly a session working in the background that keeps
// showing "Ready" because its busy state sits under the id nobody renders.
//
// Pure so it can be unit-tested without the renderer's DOM/IPC globals.

/**
 * Move a session's activity state from oldId to newId in place.
 * @param {string} oldId
 * @param {string} newId
 * @param {{ sessionBusyState?: Map, responseReadySessions?: Set, attentionSessions?: Set }} state
 */
function rekeySessionActivity(oldId, newId, state) {
  if (!oldId || !newId || oldId === newId || !state) return;

  const { sessionBusyState, responseReadySessions, attentionSessions } = state;

  if (sessionBusyState && sessionBusyState.has(oldId)) {
    sessionBusyState.set(newId, sessionBusyState.get(oldId));
    sessionBusyState.delete(oldId);
  }

  for (const set of [responseReadySessions, attentionSessions]) {
    if (set && set.has(oldId)) {
      set.delete(oldId);
      set.add(newId);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rekeySessionActivity };
}

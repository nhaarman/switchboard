const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionTransitions = require('../session-transitions');

// Build a fake context and return the captured side effects.
function setup(projectsDir) {
  const activeSessions = new Map();
  const forked = [];
  const rekeyed = [];
  const archived = [];
  sessionTransitions.init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, oldId, newId) => forked.push({ channel, oldId, newId }) },
    }),
    log: { info() {}, debug() {}, error() {} },
    rekeyMcpServer: (oldId, newId) => rekeyed.push({ oldId, newId }),
    archiveSession: (oldId) => archived.push(oldId),
  });
  return { activeSessions, forked, rekeyed, archived };
}

function writeSession(folderPath, id, lines) {
  fs.writeFileSync(path.join(folderPath, id + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// A post-/clear transcript: the command marker plus (optionally) a worktree
// back-reference to the session that was cleared.
function clearSessionLines(newId, { worktreeCreatorId } = {}) {
  const lines = [{ type: 'mode', mode: 'normal', sessionId: newId }];
  if (worktreeCreatorId) {
    lines.push({ type: 'worktree-state', worktreeSession: { sessionId: worktreeCreatorId }, sessionId: newId });
  }
  lines.push({ type: 'file-history-snapshot' });
  lines.push({ type: 'user', sessionId: newId, message: { content: '<local-command-caveat>Caveat</local-command-caveat>' } });
  lines.push({ type: 'user', sessionId: newId, message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } });
  return lines;
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-transitions-'));
  const folder = 'proj';
  const folderPath = path.join(tmp, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  try {
    return fn({ tmp, folder, folderPath });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('/clear in a worktree re-keys the live session and archives the predecessor', () => {
  withTmp(({ tmp, folder, folderPath }) => {
    const { activeSessions, forked, rekeyed, archived } = setup(tmp);
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const newId = 'bbbbbbbb-1111-1111-1111-111111111111';

    writeSession(folderPath, oldId, [{ type: 'user', sessionId: oldId, message: { content: 'hi' } }]);
    activeSessions.set(oldId, {
      projectFolder: folder,
      knownJsonlFiles: new Set([oldId + '.jsonl']),
      exited: false,
      isPlainTerminal: false,
      forkFrom: null,
    });

    writeSession(folderPath, newId, clearSessionLines(newId, { worktreeCreatorId: oldId }));

    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(!activeSessions.has(oldId), 'old id should be removed from active sessions');
    assert.ok(activeSessions.has(newId), 'new id should be active');
    assert.equal(activeSessions.get(newId).realSessionId, newId);
    assert.equal(activeSessions.get(newId).worktreeCreatorId, oldId);
    assert.deepEqual(rekeyed, [{ oldId, newId }]);
    assert.deepEqual(archived, [oldId]);
    assert.deepEqual(forked, [{ channel: 'session-forked', oldId, newId }]);
  });
});

test('a second /clear chains via the remembered worktree creator', () => {
  withTmp(({ tmp, folder, folderPath }) => {
    const { activeSessions, archived } = setup(tmp);
    const creatorId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const secondId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const thirdId = 'cccccccc-2222-2222-2222-222222222222';

    // State after the first /clear: active id is the second session, but it
    // remembers the worktree creator (the first session).
    writeSession(folderPath, secondId, [{ type: 'user', sessionId: secondId, message: { content: 'hi' } }]);
    activeSessions.set(secondId, {
      projectFolder: folder,
      knownJsonlFiles: new Set([secondId + '.jsonl']),
      exited: false,
      isPlainTerminal: false,
      forkFrom: null,
      worktreeCreatorId: creatorId,
    });

    // The third session still points its worktree-state at the creator.
    writeSession(folderPath, thirdId, clearSessionLines(thirdId, { worktreeCreatorId: creatorId }));

    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(activeSessions.has(thirdId), 'third id should be active');
    assert.equal(activeSessions.get(thirdId).worktreeCreatorId, creatorId);
    assert.deepEqual(archived, [secondId]);
  });
});

test('/clear outside a worktree matches the sole live session by timing', () => {
  withTmp(({ tmp, folder, folderPath }) => {
    const { activeSessions, archived, forked } = setup(tmp);
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const newId = 'bbbbbbbb-1111-1111-1111-111111111111';

    writeSession(folderPath, oldId, [{ type: 'user', sessionId: oldId, message: { content: 'hi' } }]);
    activeSessions.set(oldId, {
      projectFolder: folder,
      knownJsonlFiles: new Set([oldId + '.jsonl']),
      exited: false,
      isPlainTerminal: false,
      forkFrom: null,
    });

    writeSession(folderPath, newId, clearSessionLines(newId)); // no worktree-state

    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(activeSessions.has(newId), 'new id should be active via temporal fallback');
    assert.deepEqual(archived, [oldId]);
    assert.equal(forked.length, 1);
  });
});

test('/clear outside a worktree is ambiguous with two live sessions and is skipped', () => {
  withTmp(({ tmp, folder, folderPath }) => {
    const { activeSessions, archived } = setup(tmp);
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const otherId = 'dddddddd-3333-3333-3333-333333333333';
    const newId = 'bbbbbbbb-1111-1111-1111-111111111111';

    for (const id of [oldId, otherId]) {
      writeSession(folderPath, id, [{ type: 'user', sessionId: id, message: { content: 'hi' } }]);
      activeSessions.set(id, {
        projectFolder: folder,
        knownJsonlFiles: new Set([id + '.jsonl']),
        exited: false,
        isPlainTerminal: false,
        forkFrom: null,
      });
    }

    writeSession(folderPath, newId, clearSessionLines(newId)); // no worktree anchor

    sessionTransitions.detectSessionTransitions(folder);

    assert.equal(archived.length, 0, 'ambiguous /clear must not archive anything');
    assert.ok(activeSessions.has(oldId) && activeSessions.has(otherId), 'both live sessions remain');
  });
});

test('a brand-new session without the /clear marker is not treated as a transition', () => {
  withTmp(({ tmp, folder, folderPath }) => {
    const { activeSessions, archived, forked } = setup(tmp);
    const oldId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const newId = 'bbbbbbbb-1111-1111-1111-111111111111';

    writeSession(folderPath, oldId, [{ type: 'user', sessionId: oldId, message: { content: 'hi' } }]);
    activeSessions.set(oldId, {
      projectFolder: folder,
      knownJsonlFiles: new Set([oldId + '.jsonl']),
      exited: false,
      isPlainTerminal: false,
      forkFrom: null,
    });

    // An ordinary new session: a real prompt, no /clear command, no fork signals.
    writeSession(folderPath, newId, [
      { type: 'mode', mode: 'normal', sessionId: newId },
      { type: 'user', sessionId: newId, message: { content: 'unrelated new work' } },
    ]);

    sessionTransitions.detectSessionTransitions(folder);

    assert.equal(archived.length, 0);
    assert.equal(forked.length, 0);
    assert.ok(activeSessions.has(oldId), 'old session stays put');
  });
});

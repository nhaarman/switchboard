// Can we tell a background agent that is still working from one that stopped?
//
// These build the same file layout the CLI writes under ~/.claude/projects and
// check what SessionAgents makes of it. The cases are the ones real sessions
// produced: agents that end as something other than "completed", agents left
// behind by a CLI that died without writing a notification, and transcripts that
// keep growing between polls.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionAgents, transcriptFolder } = require('../subagent-watch');

const SESSION_ID = '04a1583a-bd8e-4112-b15a-005e5b940085';

function makeSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-agents-test-'));
  const sessionDir = path.join(dir, SESSION_ID);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcript, '');
  return {
    dir,
    watcher: () => new SessionAgents(sessionDir, transcript),
    /** Spawn an agent: a meta file plus the transcript it writes as it works. */
    spawn(id, description, { touchedAt } = {}) {
      const base = path.join(sessionDir, 'subagents', `agent-${id}`);
      fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
        agentType: 'general-purpose', description, toolUseId: `toolu_${id}`, spawnDepth: 1,
      }));
      fs.writeFileSync(`${base}.jsonl`, '{"type":"assistant"}\n');
      if (touchedAt) fs.utimesSync(`${base}.jsonl`, touchedAt / 1000, touchedAt / 1000);
    },
    /** The line the CLI appends to the parent transcript when an agent stops. */
    finish(id, status = 'completed') {
      const content = `<task-notification> <task-id>${id}</task-id> `
        + `<status>${status}</status> <summary>Agent "x" finished</summary> </task-notification>`;
      fs.appendFileSync(transcript, JSON.stringify({
        type: 'queue-operation', operation: 'enqueue', sessionId: SESSION_ID, content,
      }) + '\n');
    },
    append(line) {
      fs.appendFileSync(transcript, line + '\n');
    },
    /** A resumed agent writes to its transcript again; move its mtime forward. */
    touch(id, at) {
      const log = path.join(sessionDir, 'subagents', `agent-${id}.jsonl`);
      fs.appendFileSync(log, '{"type":"assistant"}\n');
      if (at) fs.utimesSync(log, at / 1000, at / 1000);
    },
  };
}

test('an agent with no notification yet is live', () => {
  const s = makeSession();
  s.spawn('a07d5d6e45260d25e', 'Stopped-clock scaffolding');
  s.spawn('a4b3bcb8441e7c82a', 'Disabled button state');

  const { live, agents } = s.watcher().poll();
  assert.strictEqual(live, 2);
  assert.deepStrictEqual(
    agents.map(a => a.description).sort(),
    ['Disabled button state', 'Stopped-clock scaffolding'],
  );
});

test('every terminal status ends an agent, not just "completed"', () => {
  // Filtering on "completed" alone left sessions working forever: real
  // transcripts also carry failed, killed (user pressed escape) and stopped.
  for (const status of ['completed', 'failed', 'killed', 'stopped']) {
    const s = makeSession();
    s.spawn('a93513e1262998ec4', 'Swift launch seam');
    s.finish('a93513e1262998ec4', status);
    assert.strictEqual(s.watcher().poll().live, 0, `status=${status} should end the agent`);
  }
});

test('an agent left behind by a dead CLI does not count', () => {
  const s = makeSession();
  const anHourAgo = Date.now() - 3600_000;
  s.spawn('ghost', 'Killed with its process', { touchedAt: anHourAgo });
  s.spawn('fresh', 'Started by the running CLI');

  // No notification was ever written for either, so only the pty start time
  // separates them.
  assert.strictEqual(s.watcher().poll(0).live, 2);
  const { live, agents } = s.watcher().poll(Date.now() - 60_000);
  assert.strictEqual(live, 1);
  assert.strictEqual(agents[0].description, 'Started by the running CLI');
});

test('finishing is picked up on a later poll, reading only what was appended', () => {
  const s = makeSession();
  s.spawn('one', 'First');
  s.spawn('two', 'Second');

  const watcher = s.watcher();
  assert.strictEqual(watcher.poll().live, 2);

  s.append(JSON.stringify({ type: 'assistant', message: { content: 'unrelated chatter' } }));
  s.finish('one');
  assert.strictEqual(watcher.poll().live, 1);

  s.finish('two', 'failed');
  assert.strictEqual(watcher.poll().live, 0);
});

test('a backgrounded agent resumed after it stopped counts as live again', () => {
  // The bug: a monotonic finished-set stranded an agent as done after its first
  // notification, so a session sat on "Ready" while a resumed agent kept working.
  const s = makeSession();
  const t0 = Date.now() - 300_000;
  s.spawn('resumed', 'Boot-path build', { touchedAt: t0 });
  const watcher = s.watcher();
  assert.strictEqual(watcher.poll().live, 1);

  // First stop: a notification lands and the agent goes quiet.
  s.finish('resumed');
  assert.strictEqual(watcher.poll().live, 0, 'quiet after its first stop');

  // The main loop resumes it (same id) and it writes to its transcript again.
  s.touch('resumed', t0 + 120_000);
  assert.strictEqual(watcher.poll().live, 1, 'live again once it writes past the stop');

  // Second stop: a later notification for the same id ends it once more.
  s.finish('resumed');
  assert.strictEqual(watcher.poll().live, 0, 'quiet after its second stop');
  assert.strictEqual(watcher.poll().live, 0, 'stays finished while quiet');
});

test('a transcript replaced by a shorter one is re-read from the start', () => {
  const s = makeSession();
  s.spawn('one', 'First');
  const watcher = s.watcher();
  s.append('x'.repeat(500));
  s.finish('one');
  assert.strictEqual(watcher.poll().live, 0);

  // A fork writes a fresh, shorter transcript under the same name: the earlier
  // notification is gone and the agent is live again.
  fs.writeFileSync(path.join(s.dir, `${SESSION_ID}.jsonl`), '');
  assert.strictEqual(watcher.poll().live, 1);
});

test('the transcript folder is the one that holds the jsonl, not the first candidate', () => {
  // A worktree session's stored projectFolder is the parent repo, but the CLI
  // writes under the worktree folder. Picking the parent pointed the watcher at
  // a dir that does not exist, so the session sat on "Ready" while it worked.
  const parent = 'proj';
  const worktree = 'proj--worktrees-x';
  const sid = SESSION_ID;
  const onDisk = new Set([`/root/${worktree}/${sid}.jsonl`]);
  const exists = (p) => onDisk.has(p);

  // Cache (worktree) is offered first and wins because it holds the transcript.
  assert.strictEqual(transcriptFolder('/root', sid, [worktree, parent], exists), worktree);
  // Even if the wrong parent is offered first, the real folder is still found.
  assert.strictEqual(transcriptFolder('/root', sid, [parent, worktree], exists), worktree);
  // Falsy and duplicate candidates are skipped.
  assert.strictEqual(transcriptFolder('/root', sid, [null, parent, parent, worktree], exists), worktree);
  // Nothing on disk yet (unindexed): null, so the caller retries next poll.
  assert.strictEqual(transcriptFolder('/root', sid, [parent], exists), null);
  assert.strictEqual(transcriptFolder('/root', sid, [], exists), null);
});

test('a session that never spawned an agent costs nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-agents-test-'));
  const watcher = new SessionAgents(path.join(dir, SESSION_ID), path.join(dir, `${SESSION_ID}.jsonl`));
  assert.deepStrictEqual(watcher.poll(), { live: 0, agents: [] });
});

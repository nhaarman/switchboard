// --- Live background agents ---
//
// A session whose agents were sent to the background keeps working while its own
// prompt sits idle, so the OSC 0 spinner says nothing about it. The CLI does
// write the truth to disk, though, in two places under ~/.claude/projects:
//
//   <folder>/<sessionId>/subagents/agent-<id>.meta.json   one per spawned agent
//   <folder>/<sessionId>/subagents/agent-<id>.jsonl       its transcript, grows as it works
//   <folder>/<sessionId>.jsonl                            the parent transcript
//
// The meta file has no status — it only says an agent was started. The end is
// recorded in the parent transcript, as a queue-operation line carrying a
// <task-notification> whose <task-id> is the agent id. That notification is
// written the moment the agent stops, so a poll sees it within seconds.
//
// An agent is therefore live when it has a meta file and no notification yet.
// Every terminal status counts as the end, not just "completed": agents also
// stop as failed, killed (the user hit escape) and stopped, and treating those
// as unfinished leaves sessions working forever.
//
// A notification is not the end of the id, though: a backgrounded agent can be
// resumed and keeps the same id, so its transcript grows again and a second
// notification lands later. A monotonic finished-set would strand it as done
// forever after the first stop, leaving the session on "Ready" while it works.
// So finishing is tracked per id as a running count, and an agent that has been
// notified is live again once its transcript is touched after the write that
// marked it finished — i.e. it resumed. Comparing the agent's mtime to the
// mtime captured at that finish keeps this on one clock, with no wall-time skew.
//
// The one case the notification misses is a CLI that died without writing it —
// a hard kill leaves an agent that looks live for days. Those are filtered by
// process lifetime rather than by a timeout: an agent whose transcript hasn't
// been touched since the current pty started belongs to a CLI that is gone. A
// timeout can't do this job, because a healthy agent can legitimately sit
// silent for tens of minutes inside one long tool call.

const fs = require('fs');
const path = require('path');

const META_SUFFIX = '.meta.json';
const AGENT_PREFIX = 'agent-';

// One <task-notification> block, e.g.
//   <task-id>a9d72a07896ff87cb</task-id> ... <status>completed</status>
const NOTIFICATION_PATTERN = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/;

/**
 * Tracks how many terminal notifications each task id has drawn in one parent
 * transcript, reading only the bytes appended since the last pass. Transcripts
 * run to tens of megabytes and every running session is polled, so re-reading
 * them is not an option. The count (not a bare seen/unseen flag) is what lets a
 * resumed agent's second stop be told apart from its first.
 */
class TranscriptTail {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.partial = '';
    this.finishCounts = new Map(); // task id → number of terminal notifications seen
  }

  read() {
    let size;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return this.finishCounts;
    }
    // Truncated or replaced (a fork writes a fresh transcript): start over.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.finishCounts.clear();
    }
    if (size === this.offset) return this.finishCounts;

    let chunk = '';
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.allocUnsafe(size - this.offset);
      const bytes = fs.readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.slice(0, bytes).toString('utf8');
      this.offset += bytes;
    } catch {
      return this.finishCounts;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }

    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() || '';
    for (const line of lines) {
      // Cheap reject first: this runs over every line of every transcript.
      if (!line.includes('<task-notification>')) continue;
      const match = NOTIFICATION_PATTERN.exec(line);
      if (match) {
        const id = match[1];
        this.finishCounts.set(id, (this.finishCounts.get(id) || 0) + 1);
      }
    }
    return this.finishCounts;
  }
}

/**
 * Watches one session's subagents directory. Call poll() as often as you like;
 * it only touches the directory listing plus whatever the transcript appended.
 */
class SessionAgents {
  /**
   * @param {string} sessionDir  <projects>/<folder>/<sessionId>
   * @param {string} transcript  <projects>/<folder>/<sessionId>.jsonl
   */
  constructor(sessionDir, transcript) {
    this.subagentsDir = path.join(sessionDir, 'subagents');
    this.tail = new TranscriptTail(transcript);
    // task id → { count, mark }: the finish count last acted on and the agent's
    // mtime captured then, so a later write can be recognised as a resume.
    this.finishState = new Map();
  }

  /**
   * @param {number} ptyStartedAt  epoch ms the current CLI process started
   * @returns {{ live: number, agents: Array<{id: string, description: string}> }}
   */
  poll(ptyStartedAt = 0) {
    let entries;
    try {
      entries = fs.readdirSync(this.subagentsDir);
    } catch {
      return { live: 0, agents: [] };
    }

    const finishCounts = this.tail.read();
    const agents = [];
    for (const entry of entries) {
      if (!entry.startsWith(AGENT_PREFIX) || !entry.endsWith(META_SUFFIX)) continue;
      const id = entry.slice(AGENT_PREFIX.length, -META_SUFFIX.length);

      // The transcript is the agent's heartbeat; before its first write, the
      // meta file's own timestamp stands in.
      const metaPath = path.join(this.subagentsDir, entry);
      const logPath = path.join(this.subagentsDir, `${AGENT_PREFIX}${id}.jsonl`);
      let touchedAt = 0;
      try {
        touchedAt = fs.statSync(logPath).mtimeMs;
      } catch {
        try { touchedAt = fs.statSync(metaPath).mtimeMs; } catch { continue; }
      }
      if (touchedAt < ptyStartedAt) continue; // left behind by a CLI that is gone

      // A fresh notification (the count moved, up on a stop or back to zero when
      // a fork truncated the transcript) resets the mark to now: the agent is
      // finished as of this mtime. With the count steady, a notified agent is
      // live again only once it writes past that mark — i.e. it resumed.
      const count = finishCounts.get(id) || 0;
      const prev = this.finishState.get(id);
      if (!prev || count !== prev.count) {
        this.finishState.set(id, { count, mark: touchedAt });
        if (count > 0) continue; // just stopped (or never ran): not live
      } else if (count > 0 && touchedAt <= prev.mark) {
        continue; // stopped and quiet since: still finished
      }

      let description = '';
      try {
        description = JSON.parse(fs.readFileSync(metaPath, 'utf8')).description || '';
      } catch {}
      agents.push({ id, description });
    }

    return { live: agents.length, agents };
  }
}

module.exports = { SessionAgents, TranscriptTail };

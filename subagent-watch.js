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
 * Tracks the finished-task ids of one parent transcript, reading only the bytes
 * that were appended since the last pass. Transcripts run to tens of megabytes
 * and every running session is polled, so re-reading them is not an option.
 */
class TranscriptTail {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.partial = '';
    this.finished = new Set();
  }

  read() {
    let size;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return this.finished;
    }
    // Truncated or replaced (a fork writes a fresh transcript): start over.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.finished.clear();
    }
    if (size === this.offset) return this.finished;

    let chunk = '';
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.allocUnsafe(size - this.offset);
      const bytes = fs.readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.slice(0, bytes).toString('utf8');
      this.offset += bytes;
    } catch {
      return this.finished;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }

    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() || '';
    for (const line of lines) {
      // Cheap reject first: this runs over every line of every transcript.
      if (!line.includes('<task-notification>')) continue;
      const match = NOTIFICATION_PATTERN.exec(line);
      if (match) this.finished.add(match[1]);
    }
    return this.finished;
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

    const finished = this.tail.read();
    const agents = [];
    for (const entry of entries) {
      if (!entry.startsWith(AGENT_PREFIX) || !entry.endsWith(META_SUFFIX)) continue;
      const id = entry.slice(AGENT_PREFIX.length, -META_SUFFIX.length);
      if (finished.has(id)) continue;

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

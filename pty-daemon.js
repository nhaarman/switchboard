#!/usr/bin/env node
// Switchboard PTY daemon — owns every session's pty process so sessions outlive
// the app window.
//
// Before this existed, node-pty children were owned by the Electron main process
// and `before-quit` killed them all: quitting Switchboard (or installing an
// update) interrupted whatever Claude was doing mid-turn and threw away the
// scrollback. The daemon holds the pty processes, the per-session output ring
// buffer, and the IDE MCP servers, so the app is just a client that attaches and
// detaches.
//
// It is deliberately dumb: it knows nothing about shells, worktrees, settings or
// OSC parsing. The client hands it a fully resolved spawn spec and stores any
// derived state it wants to survive a restart in the session's opaque `state`
// blob. That keeps every product decision in main.js, where it already lives.
//
// Started by pty-client.js via Electron's node mode (ELECTRON_RUN_AS_NODE=1) so
// `require('node-pty')` resolves the same native ABI the app is built against.

const net = require('net');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const {
  TYPE_CONTROL, TYPE_DATA, TYPE_REPLAY,
  encodeControl, encodeData, createFrameReader, decodeDataPayload,
} = require('./ptyd-protocol');

const PROTOCOL_VERSION = 1;
const MAX_BUFFER_SIZE = 256 * 1024;
// How long an exited session stays queryable so a client that reconnects right
// after the process died can still replay its final output and exit banner.
const EXITED_RETENTION_MS = 30_000;
// With no sessions and no attached client there is nothing to hold on to; exit
// so a stale daemon never lingers across an app upgrade.
const IDLE_SHUTDOWN_MS = 120_000;

const args = parseArgs(process.argv.slice(2));
const socketPath = args.socket;
const dataDir = args['data-dir'] || path.dirname(socketPath || '.');
if (!socketPath) {
  process.stderr.write('pty-daemon: --socket <path> is required\n');
  process.exit(2);
}

// --- logging ---------------------------------------------------------------
const logPath = path.join(dataDir, 'ptyd.log');
function writeLog(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try { fs.appendFileSync(logPath, line); } catch {}
}
const log = {
  info: (...a) => writeLog('info', a.join(' ')),
  warn: (...a) => writeLog('warn', a.join(' ')),
  error: (...a) => writeLog('error', a.join(' ')),
  debug: () => {},
};

// mcp-bridge is loaded after `log` exists because it takes the same shape.
const mcp = require('./mcp-bridge');

// --- session registry ------------------------------------------------------
// sessionId → { pty, state, buffer, bufferSize, exited, exitCode, purgeTimer }
const sessions = new Map();
const clients = new Set();
let idleSince = Date.now();

function liveSessionCount() {
  let n = 0;
  for (const [, s] of sessions) if (!s.exited) n++;
  return n;
}

function broadcast(frame) {
  for (const client of clients) {
    try { client.write(frame); } catch {}
  }
}

function sendTo(socket, obj) {
  try { socket.write(encodeControl(obj)); } catch {}
}

function appendToBuffer(session, data) {
  if (session.suppressBuffer) return;
  session.buffer.push(data);
  session.bufferSize += data.length;
  while (session.bufferSize > MAX_BUFFER_SIZE && session.buffer.length > 1) {
    session.bufferSize -= session.buffer.shift().length;
  }
}

function spawnSession(msg) {
  const { id, file, args: spawnArgs, cwd, env, cols, rows, state } = msg;
  if (sessions.has(id)) throw new Error(`session ${id} already exists`);

  const proc = pty.spawn(file, spawnArgs || [], {
    name: env?.TERM || 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env,
  });

  const session = {
    pty: proc,
    startedAt: Date.now(),
    state: state || {},
    buffer: [],
    bufferSize: 0,
    suppressBuffer: false,
    exited: false,
    exitCode: null,
    purgeTimer: null,
  };
  sessions.set(id, session);

  proc.onData((data) => {
    const buf = Buffer.from(data, 'utf8');
    appendToBuffer(session, buf);
    // Sessions are keyed by their current id: a fork or plan-accept re-keys the
    // session mid-flight, and output must follow the new id.
    broadcast(encodeData(TYPE_DATA, currentIdOf(session) || id, buf));
  });

  proc.onExit(({ exitCode }) => {
    const sid = currentIdOf(session) || id;
    session.exited = true;
    session.exitCode = exitCode;
    mcp.shutdownMcpServer(sid);
    broadcast(encodeControl({ t: 'exit', id: sid, exitCode }));
    log.info(`session ${sid} exited code=${exitCode}`);
    session.purgeTimer = setTimeout(() => {
      for (const [key, value] of sessions) if (value === session) sessions.delete(key);
    }, EXITED_RETENTION_MS);
    if (session.purgeTimer.unref) session.purgeTimer.unref();
  });

  log.info(`session ${id} spawned: ${file} (cwd=${cwd})`);
  return { pid: proc.pid };
}

function currentIdOf(session) {
  for (const [key, value] of sessions) if (value === session) return key;
  return null;
}

function requireSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error(`unknown session ${id}`);
  return session;
}

function listSessions() {
  const out = [];
  for (const [id, s] of sessions) {
    if (s.exited) continue;
    out.push({ id, state: s.state, pid: s.pty.pid, startedAt: s.startedAt || null });
  }
  return out;
}

// --- control handling ------------------------------------------------------
async function handleControl(socket, msg) {
  const reply = (payload) => { if (msg.rid) sendTo(socket, { t: 'reply', rid: msg.rid, ...payload }); };

  try {
    switch (msg.t) {
      case 'hello':
        clients.add(socket);
        mcp.setUi(daemonUi);
        sendTo(socket, { t: 'hello-ok', version: PROTOCOL_VERSION, pid: process.pid, appVersion: args['app-version'] || null });
        return;

      case 'list':
        return reply({ sessions: listSessions() });

      case 'spawn':
        return reply({ ok: true, ...spawnSession(msg) });

      case 'resize': {
        const s = requireSession(msg.id);
        if (!s.exited) s.pty.resize(msg.cols, msg.rows);
        return reply({ ok: true });
      }

      case 'suppress-buffer': {
        const s = requireSession(msg.id);
        s.suppressBuffer = !!msg.value;
        return reply({ ok: true });
      }

      case 'kill': {
        const s = requireSession(msg.id);
        if (!s.exited) s.pty.kill(msg.signal || undefined);
        return reply({ ok: true });
      }

      case 'set-state': {
        const s = requireSession(msg.id);
        Object.assign(s.state, msg.patch || {});
        return reply({ ok: true });
      }

      case 'rekey': {
        const s = requireSession(msg.oldId);
        sessions.delete(msg.oldId);
        sessions.set(msg.newId, s);
        mcp.rekeyMcpServer(msg.oldId, msg.newId);
        log.info(`session ${msg.oldId} re-keyed to ${msg.newId}`);
        return reply({ ok: true });
      }

      case 'replay': {
        const s = requireSession(msg.id);
        for (const chunk of s.buffer) {
          try { socket.write(encodeData(TYPE_REPLAY, msg.id, chunk)); } catch {}
        }
        return reply({ ok: true, exited: s.exited, exitCode: s.exitCode });
      }

      case 'mcp-start': {
        const result = await mcp.startMcpServer(msg.id, msg.workspaceFolders, daemonUi, log);
        return reply({ ok: true, ...result });
      }

      case 'mcp-rekey':
        mcp.rekeyMcpServer(msg.oldId, msg.newId);
        return reply({ ok: true });

      case 'mcp-stop':
        mcp.shutdownMcpServer(msg.id);
        return reply({ ok: true });

      case 'mcp-diff-response':
        mcp.resolvePendingDiff(msg.id, msg.diffId, msg.action, msg.editedContent);
        return reply({ ok: true });

      case 'clean-stale-locks':
        mcp.cleanStaleLockFiles(log);
        return reply({ ok: true });

      case 'shutdown':
        reply({ ok: true });
        log.info('shutdown requested');
        setTimeout(() => process.exit(0), 50);
        return;

      default:
        return reply({ error: `unknown message ${msg.t}` });
    }
  } catch (err) {
    log.error(`handling ${msg.t}: ${err.message}`);
    return reply({ error: err.message });
  }
}

// The MCP bridge talks to "the UI" — here that is whichever clients are attached.
// With none attached the bridge answers on its own so an unattended session is
// never left blocking on a diff nobody can see.
const daemonUi = {
  isAlive: () => clients.size > 0,
  send: (channel, ...payload) => broadcast(encodeControl({ t: 'mcp-event', channel, payload })),
};

// --- server ----------------------------------------------------------------
function startServer() {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const read = createFrameReader((type, payload) => {
      if (type === TYPE_CONTROL) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
        handleControl(socket, msg);
        return;
      }
      if (type === TYPE_DATA) {
        const { sessionId, data } = decodeDataPayload(payload);
        const session = sessions.get(sessionId);
        if (session && !session.exited) {
          try { session.pty.write(data.toString('utf8')); } catch {}
        }
      }
    });

    socket.on('data', (chunk) => {
      try { read(chunk); } catch (err) {
        log.error(`frame error: ${err.message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clients.delete(socket);
      if (clients.size === 0) {
        // Nobody can answer a diff prompt any more; release anything waiting.
        mcp.releasePendingForUiGone();
        idleSince = Date.now();
        log.info('last client detached; sessions keep running');
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another daemon won the race — it owns the socket, so this one is surplus.
      log.info('socket already in use; exiting');
      process.exit(0);
    }
    log.error(`server error: ${err.message}`);
    process.exit(1);
  });

  // A socket file left behind by a crashed daemon would block listen(); only
  // remove it once we know nothing is answering on it.
  probeSocket(socketPath, (inUse) => {
    if (inUse) {
      log.info('daemon already running; exiting');
      process.exit(0);
    }
    try { fs.unlinkSync(socketPath); } catch {}
    server.listen(socketPath, () => {
      log.info(`listening on ${socketPath} (pid ${process.pid})`);
    });
  });
}

function probeSocket(p, cb) {
  if (process.platform !== 'win32' && !fs.existsSync(p)) return cb(false);
  const probe = net.connect(p);
  let done = false;
  const finish = (inUse) => { if (!done) { done = true; probe.destroy(); cb(inUse); } };
  probe.on('connect', () => finish(true));
  probe.on('error', () => finish(false));
  setTimeout(() => finish(false), 1000);
}

setInterval(() => {
  if (liveSessionCount() > 0 || clients.size > 0) {
    idleSince = Date.now();
    return;
  }
  if (Date.now() - idleSince > IDLE_SHUTDOWN_MS) {
    log.info('idle with no sessions or clients; exiting');
    process.exit(0);
  }
}, 30_000).unref?.();

// Detached from any terminal: a stray signal must not take the sessions down.
process.on('SIGHUP', () => {});
process.on('uncaughtException', (err) => log.error(`uncaught: ${err?.stack || err}`));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

startServer();

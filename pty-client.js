// Electron-side client for pty-daemon.js.
//
// Presents the daemon as if the pty processes were local: `spawn()` returns a
// handle with write/resize/kill, and `onData`/`onExit` callbacks fire per
// session. main.js keeps all of its OSC parsing, session bookkeeping and
// settings logic — the only thing that moved out is process ownership.
//
// The daemon is started on demand and deliberately outlives us, so connect()
// must cope with three cases: no daemon yet (spawn one), a daemon already
// running (adopt its sessions), and a daemon that died (spawn a fresh one and
// report the sessions as gone).

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  TYPE_CONTROL, TYPE_DATA, TYPE_REPLAY,
  encodeControl, encodeData, createFrameReader, decodeDataPayload,
} = require('./ptyd-protocol');

const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 100;

class PtyClient {
  constructor({ socketPath, dataDir, execPath, daemonScript, appVersion, log }) {
    this.socketPath = socketPath;
    this.dataDir = dataDir;
    this.execPath = execPath;
    this.daemonScript = daemonScript;
    this.appVersion = appVersion;
    this.log = log;
    this.socket = null;
    this.reader = null;
    this.nextRid = 1;
    this.pending = new Map();      // rid → {resolve, reject}
    this.dataHandlers = new Map(); // sessionId → fn(data, { replay })
    this.exitHandlers = new Map(); // sessionId → fn(exitCode)
    this.mcpEventHandler = null;
    this.daemonPid = null;
  }

  // --- connection ----------------------------------------------------------

  async connect() {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      const socket = await tryConnect(this.socketPath);
      if (socket) {
        this._attach(socket);
        const hello = await this._handshake();
        return hello;
      }
      // Only one spawn attempt per pass through the loop start; a losing racer
      // exits by itself when it finds the socket taken.
      if (attempt === 0) this._spawnDaemon();
      await delay(CONNECT_RETRY_MS);
    }
    throw new Error(`could not reach pty daemon at ${this.socketPath}`);
  }

  _spawnDaemon() {
    const args = [
      this.daemonScript,
      '--socket', this.socketPath,
      '--data-dir', this.dataDir,
    ];
    if (this.appVersion) args.push('--app-version', this.appVersion);

    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, which
    // is what lets the daemon load the same node-pty build the app ships.
    const child = spawn(this.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    this.log.info(`[ptyd] spawned daemon (pid ${child.pid})`);
  }

  _attach(socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    this.reader = createFrameReader((type, payload) => this._onFrame(type, payload));
    socket.on('data', (chunk) => {
      try { this.reader(chunk); } catch (err) {
        this.log.error(`[ptyd] frame error: ${err.message}`);
      }
    });
    socket.on('error', (err) => this.log.error(`[ptyd] socket error: ${err.message}`));
    socket.on('close', () => {
      this.socket = null;
      for (const [, p] of this.pending) p.reject(new Error('pty daemon connection closed'));
      this.pending.clear();
      this.log.warn('[ptyd] connection closed');
    });
  }

  async _handshake() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timeout')), 5000);
      this._helloResolve = (hello) => { clearTimeout(timer); resolve(hello); };
      this._send({ t: 'hello', version: 1, appVersion: this.appVersion });
    });
  }

  _onFrame(type, payload) {
    if (type === TYPE_DATA || type === TYPE_REPLAY) {
      const { sessionId, data } = decodeDataPayload(payload);
      const handler = this.dataHandlers.get(sessionId);
      if (handler) handler(data.toString('utf8'), { replay: type === TYPE_REPLAY });
      return;
    }
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }

    if (msg.t === 'hello-ok') {
      this.daemonPid = msg.pid;
      if (this._helloResolve) { this._helloResolve(msg); this._helloResolve = null; }
      return;
    }
    if (msg.t === 'reply') {
      const p = this.pending.get(msg.rid);
      if (!p) return;
      this.pending.delete(msg.rid);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg);
      return;
    }
    if (msg.t === 'exit') {
      const handler = this.exitHandlers.get(msg.id);
      if (handler) handler(msg.exitCode);
      return;
    }
    if (msg.t === 'mcp-event') {
      if (this.mcpEventHandler) this.mcpEventHandler(msg.channel, msg.payload || []);
      return;
    }
  }

  _send(obj) {
    if (!this.socket) throw new Error('pty daemon not connected');
    this.socket.write(encodeControl(obj));
  }

  _request(obj) {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      try { this._send({ ...obj, rid }); } catch (err) { this.pending.delete(rid); reject(err); }
    });
  }

  // --- sessions ------------------------------------------------------------

  /** Sessions the daemon still has running — the ones that survived a restart. */
  async list() {
    const reply = await this._request({ t: 'list' });
    return reply.sessions || [];
  }

  /**
   * Spawn a session and return a handle. `spec` is fully resolved by the caller:
   * { id, file, args, cwd, env, cols, rows, state }.
   */
  async spawn(spec) {
    await this._request({ t: 'spawn', ...spec });
    return this.handle(spec.id);
  }

  /** Handle for an existing session, whether we spawned it or adopted it. */
  handle(sessionId) {
    const client = this;
    return {
      sessionId,
      write(data) {
        if (!client.socket) return;
        client.socket.write(encodeData(TYPE_DATA, sessionId, data));
      },
      resize(cols, rows) { client._request({ t: 'resize', id: sessionId, cols, rows }).catch(() => {}); },
      kill(signal) { client._request({ t: 'kill', id: sessionId, signal }).catch(() => {}); },
      setSuppressBuffer(value) { client._request({ t: 'suppress-buffer', id: sessionId, value }).catch(() => {}); },
    };
  }

  onData(sessionId, fn) { this.dataHandlers.set(sessionId, fn); }
  onExit(sessionId, fn) { this.exitHandlers.set(sessionId, fn); }

  forgetSession(sessionId) {
    this.dataHandlers.delete(sessionId);
    this.exitHandlers.delete(sessionId);
  }

  /** Move handlers and daemon-side bookkeeping to a new id (fork / plan accept). */
  async rekey(oldId, newId) {
    const dataHandler = this.dataHandlers.get(oldId);
    const exitHandler = this.exitHandlers.get(oldId);
    this.dataHandlers.delete(oldId);
    this.exitHandlers.delete(oldId);
    if (dataHandler) this.dataHandlers.set(newId, dataHandler);
    if (exitHandler) this.exitHandlers.set(newId, exitHandler);
    await this._request({ t: 'rekey', oldId, newId });
  }

  /** Persist derived state so it survives an app restart (altScreen, cwd, …). */
  setState(sessionId, patch) {
    this._request({ t: 'set-state', id: sessionId, patch }).catch(() => {});
  }

  /** Ask for the scrollback; frames arrive tagged as replay, not live output. */
  async replay(sessionId) {
    return this._request({ t: 'replay', id: sessionId });
  }

  // --- MCP (hosted by the daemon so IDE servers survive too) ---------------

  onMcpEvent(fn) { this.mcpEventHandler = fn; }

  async startMcp(sessionId, workspaceFolders) {
    const reply = await this._request({ t: 'mcp-start', id: sessionId, workspaceFolders });
    return { port: reply.port, authToken: reply.authToken };
  }

  stopMcp(sessionId) { this._request({ t: 'mcp-stop', id: sessionId }).catch(() => {}); }
  rekeyMcp(oldId, newId) { this._request({ t: 'mcp-rekey', oldId, newId }).catch(() => {}); }
  diffResponse(sessionId, diffId, action, editedContent) {
    this._request({ t: 'mcp-diff-response', id: sessionId, diffId, action, editedContent }).catch(() => {});
  }
  cleanStaleLocks() { this._request({ t: 'clean-stale-locks' }).catch(() => {}); }

  /** Test helper: ask the daemon to exit. Never called from the app. */
  shutdownDaemon() { return this._request({ t: 'shutdown' }).catch(() => {}); }
}

function tryConnect(socketPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return resolve(null);
    const socket = net.connect(socketPath);
    const fail = () => { socket.destroy(); resolve(null); };
    socket.once('connect', () => { socket.removeListener('error', fail); resolve(socket); });
    socket.once('error', fail);
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function defaultSocketPath(dataDir) {
  if (process.platform === 'win32') {
    // Named pipes live in their own namespace, so key it by the data dir to keep
    // a dev instance separate from the installed app.
    const key = Buffer.from(dataDir).toString('hex').slice(0, 32);
    return `\\\\.\\pipe\\switchboard-ptyd-${key}`;
  }
  return path.join(dataDir, 'ptyd.sock');
}

module.exports = { PtyClient, defaultSocketPath };

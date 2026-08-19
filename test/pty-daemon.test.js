// Does a session really outlive its client?
//
// These tests drive pty-daemon.js over its socket the same way the app does:
// spawn a session, drop the connection, reconnect as a "restarted app", and check
// the process is still there with its scrollback intact.
//
// node-pty is rebuilt against Electron's ABI in this repo, so run under Electron's
// node mode:  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/

const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  TYPE_CONTROL, TYPE_DATA, TYPE_REPLAY,
  encodeControl, encodeData, createFrameReader, decodeDataPayload,
} = require('../ptyd-protocol');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-ptyd-test-'));
const socketPath = path.join(dataDir, 'ptyd.sock');
let daemon = null;

function startDaemon() {
  daemon = spawn(process.execPath, [
    path.join(__dirname, '..', 'pty-daemon.js'),
    '--socket', socketPath,
    '--data-dir', dataDir,
  ], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
}

after(() => {
  if (daemon) daemon.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

/** A minimal stand-in for pty-client.js, so the test exercises the wire format. */
async function connectClient() {
  const socket = await waitForConnect(socketPath, 5000);
  socket.setNoDelay(true);

  const client = {
    socket,
    output: new Map(),   // sessionId → live output
    replayed: new Map(), // sessionId → replayed scrollback
    exits: [],
    events: [],
    nextRid: 1,
    pending: new Map(),
  };

  const read = createFrameReader((type, payload) => {
    if (type === TYPE_DATA || type === TYPE_REPLAY) {
      const { sessionId, data } = decodeDataPayload(payload);
      const sink = type === TYPE_REPLAY ? client.replayed : client.output;
      sink.set(sessionId, (sink.get(sessionId) || '') + data.toString('utf8'));
      return;
    }
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.t === 'reply') {
      const p = client.pending.get(msg.rid);
      if (p) { client.pending.delete(msg.rid); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg); }
    } else if (msg.t === 'hello-ok') {
      client.hello = msg;
      if (client._helloResolve) client._helloResolve(msg);
    } else if (msg.t === 'exit') {
      client.exits.push(msg);
    } else if (msg.t === 'mcp-event') {
      client.events.push(msg);
    }
  });
  socket.on('data', (chunk) => read(chunk));
  socket.on('error', () => {});

  client.request = (obj) => {
    const rid = client.nextRid++;
    return new Promise((resolve, reject) => {
      client.pending.set(rid, { resolve, reject });
      socket.write(encodeControl({ ...obj, rid }));
    });
  };
  client.write = (id, data) => socket.write(encodeData(TYPE_DATA, id, data));

  const hello = new Promise((resolve) => { client._helloResolve = resolve; });
  socket.write(encodeControl({ t: 'hello', version: 1 }));
  await withTimeout(hello, 5000, 'handshake');
  return client;
}

function waitForConnect(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(p);
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error(`no daemon on ${p}`));
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a session keeps running after its client disconnects, and replays its scrollback', async () => {
  startDaemon();
  const first = await connectClient();

  // A shell that prints a marker, then waits — the "work in progress" a quit
  // used to kill.
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  await first.request({
    t: 'spawn', id,
    file: '/bin/sh', args: ['-c', 'echo MARKER_ONE; sleep 30'],
    cwd: dataDir, cols: 80, rows: 24,
    env: { ...process.env, TERM: 'xterm-256color' },
    state: { projectPath: '/tmp/proj', isPlainTerminal: false },
  });

  await waitFor(() => (first.output.get(id) || '').includes('MARKER_ONE'), 5000, 'first output');

  // The app quits.
  first.socket.destroy();
  await new Promise((r) => setTimeout(r, 300));

  // A new app process starts and adopts what is still running.
  const second = await connectClient();
  const list = await second.request({ t: 'list' });
  const found = list.sessions.find((s) => s.id === id);
  assert.ok(found, 'session survived the client disconnect');
  assert.equal(found.state.projectPath, '/tmp/proj', 'state blob came back for adoption');

  // Scrollback is replayed, tagged as replay rather than live output.
  await second.request({ t: 'replay', id });
  await waitFor(() => (second.replayed.get(id) || '').includes('MARKER_ONE'), 5000, 'replay');
  assert.equal(second.output.get(id), undefined, 'replay is not delivered as live output');

  // And the surviving process still responds to input.
  await second.request({ t: 'kill', id });
  await waitFor(() => second.exits.some((e) => e.id === id), 5000, 'exit event');
});

test('input reaches the pty and output streams back', async () => {
  const client = await connectClient();
  const id = 'aaaaaaaa-0000-4000-8000-000000000002';
  await client.request({
    t: 'spawn', id,
    file: '/bin/sh', args: ['-i'],
    cwd: dataDir, cols: 80, rows: 24,
    env: { ...process.env, TERM: 'xterm-256color', PS1: '$ ' },
    state: {},
  });

  client.write(id, 'echo HELLO_FROM_INPUT\n');
  await waitFor(() => (client.output.get(id) || '').includes('HELLO_FROM_INPUT'), 5000, 'echoed output');

  await client.request({ t: 'kill', id });
  await waitFor(() => client.exits.some((e) => e.id === id), 5000, 'exit');
});

test('re-keying a session moves it without disturbing the process', async () => {
  const client = await connectClient();
  const oldId = 'aaaaaaaa-0000-4000-8000-000000000003';
  const newId = 'bbbbbbbb-0000-4000-8000-000000000003';
  await client.request({
    t: 'spawn', id: oldId,
    file: '/bin/sh', args: ['-c', 'echo BEFORE_REKEY; sleep 30'],
    cwd: dataDir, cols: 80, rows: 24, env: { ...process.env }, state: { projectPath: '/tmp/proj' },
  });
  await waitFor(() => (client.output.get(oldId) || '').includes('BEFORE_REKEY'), 5000, 'output');

  await client.request({ t: 'rekey', oldId, newId });
  const list = await client.request({ t: 'list' });
  assert.ok(list.sessions.some((s) => s.id === newId), 'listed under the new id');
  assert.ok(!list.sessions.some((s) => s.id === oldId), 'old id is gone');

  // Scrollback followed the session across the re-key.
  await client.request({ t: 'replay', id: newId });
  await waitFor(() => (client.replayed.get(newId) || '').includes('BEFORE_REKEY'), 5000, 'replay after rekey');

  await client.request({ t: 'kill', id: newId });
});

test('state survives as an opaque blob the client can update', async () => {
  const client = await connectClient();
  const id = 'aaaaaaaa-0000-4000-8000-000000000004';
  await client.request({
    t: 'spawn', id,
    file: '/bin/sh', args: ['-c', 'sleep 30'],
    cwd: dataDir, cols: 80, rows: 24, env: { ...process.env },
    state: { projectPath: '/tmp/proj', altScreen: false },
  });

  await client.request({ t: 'set-state', id, patch: { altScreen: true, sessionSlug: 'my-slug' } });
  const list = await client.request({ t: 'list' });
  const state = list.sessions.find((s) => s.id === id).state;
  assert.equal(state.altScreen, true, 'patch applied');
  assert.equal(state.sessionSlug, 'my-slug', 'new keys are kept');
  assert.equal(state.projectPath, '/tmp/proj', 'existing keys are preserved');

  await client.request({ t: 'kill', id });
});

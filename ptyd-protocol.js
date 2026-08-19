// Wire format shared by pty-daemon.js (server) and pty-client.js (Electron side).
//
// Frames are length-prefixed so terminal output can be passed through as raw
// bytes — base64-in-JSON would inflate every keystroke and every screen redraw:
//
//   uint32BE payloadLength | uint8 type | payload
//
// CONTROL payloads are UTF-8 JSON. DATA/REPLAY payloads are
// `uint8 idLength | sessionId (ascii) | raw pty bytes`, which keeps the hot path
// down to two small allocations per chunk.

const TYPE_CONTROL = 1;
const TYPE_DATA = 2;
// Replayed scrollback is tagged separately from live output: the client re-emits
// it to the renderer verbatim but must NOT re-run OSC parsing over it, or every
// reattach would re-fire the notifications and busy-state transitions that were
// already handled when the bytes first arrived.
const TYPE_REPLAY = 3;

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function encodeControl(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.allocUnsafe(5 + json.length);
  frame.writeUInt32BE(json.length + 1, 0);
  frame.writeUInt8(TYPE_CONTROL, 4);
  json.copy(frame, 5);
  return frame;
}

function encodeData(type, sessionId, data) {
  const id = Buffer.from(sessionId, 'ascii');
  if (id.length > 255) throw new Error('session id too long for frame');
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const frame = Buffer.allocUnsafe(5 + 1 + id.length + body.length);
  frame.writeUInt32BE(1 + 1 + id.length + body.length, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt8(id.length, 5);
  id.copy(frame, 6);
  body.copy(frame, 6 + id.length);
  return frame;
}

/**
 * Incremental frame reader. Socket chunks split frames at arbitrary offsets, so
 * every consumer needs this buffering; `onFrame(type, payload)` fires once per
 * complete frame.
 */
function createFrameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 5) return;
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new Error(`frame too large: ${len}`);
      if (buf.length < 4 + len) return;
      const type = buf.readUInt8(4);
      const payload = buf.subarray(5, 4 + len);
      onFrame(type, payload);
      buf = buf.subarray(4 + len);
    }
  };
}

function decodeDataPayload(payload) {
  const idLen = payload.readUInt8(0);
  return {
    sessionId: payload.subarray(1, 1 + idLen).toString('ascii'),
    data: payload.subarray(1 + idLen),
  };
}

module.exports = {
  TYPE_CONTROL, TYPE_DATA, TYPE_REPLAY,
  encodeControl, encodeData, createFrameReader, decodeDataPayload,
};

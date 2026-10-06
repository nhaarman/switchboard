const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { binaryFingerprint, isBinaryReplaced } = require('../binary-fingerprint');

function tempBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fp-test-'));
  const file = path.join(dir, 'Switchboard');
  fs.writeFileSync(file, 'build 1');
  return file;
}

test('an untouched binary is not reported as replaced', () => {
  const file = tempBinary();
  assert.strictEqual(isBinaryReplaced(file, binaryFingerprint(file)), false);
});

test('a reinstall (remove + copy in a new build) is detected', () => {
  const file = tempBinary();
  const before = binaryFingerprint(file);
  const staged = `${file}.new`;
  fs.writeFileSync(staged, 'build 2');
  fs.rmSync(file);
  fs.renameSync(staged, file);
  assert.strictEqual(isBinaryReplaced(file, before), true);
});

test('a binary that disappeared counts as replaced', () => {
  const file = tempBinary();
  const before = binaryFingerprint(file);
  fs.rmSync(file);
  assert.strictEqual(isBinaryReplaced(file, before), true);
});

test('without a fingerprint nothing is reported', () => {
  assert.strictEqual(isBinaryReplaced('/nonexistent', null), false);
});

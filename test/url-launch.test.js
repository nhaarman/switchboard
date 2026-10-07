const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureLaunchToken, parseLaunchUrl } = require('../url-launch');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'url-launch-')));
}

function launchUrl(params) {
  return 'switchboard://new?' + new URLSearchParams(params).toString();
}

test('ensureLaunchToken creates a 0600 token once and reuses it', () => {
  const dir = tmpDir();
  const token = ensureLaunchToken(dir);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dir, 'launch-token')).mode & 0o777, 0o600);
  assert.equal(ensureLaunchToken(dir), token);
});

test('ensureLaunchToken tightens an existing token file to 0600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'launch-token');
  fs.writeFileSync(file, 'existing\n', { mode: 0o644 });
  assert.equal(ensureLaunchToken(dir), 'existing');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('ensureLaunchToken replaces an empty token file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'launch-token'), '\n');
  assert.match(ensureLaunchToken(dir), /^[0-9a-f]{64}$/);
});

function setup() {
  const root = tmpDir();
  const dev = path.join(root, 'dev');
  const project = path.join(dev, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { root, dev, project, options: { token: 'secret', allowedRoots: [dev] } };
}

test('accepts a valid token and a folder under the allowed root', () => {
  const { project, options } = setup();
  const result = parseLaunchUrl(launchUrl({ path: project, prompt: 'pak #12 op', token: 'secret' }), options);
  assert.deepEqual(result, { ok: true, projectPath: project, prompt: 'pak #12 op' });
});

test('the prompt is optional and unknown parameters are ignored', () => {
  const { project, options } = setup();
  const result = parseLaunchUrl(launchUrl({ path: project, token: 'secret', model: 'opus', dangerouslySkipPermissions: 'true' }), options);
  assert.deepEqual(result, { ok: true, projectPath: project, prompt: '' });
});

test('rejects a missing or wrong token', () => {
  const { project, options } = setup();
  assert.deepEqual(parseLaunchUrl(launchUrl({ path: project }), options), { ok: false, reason: 'geen geldig token' });
  assert.deepEqual(parseLaunchUrl(launchUrl({ path: project, token: 'secreT' }), options), { ok: false, reason: 'geen geldig token' });
  assert.deepEqual(parseLaunchUrl(launchUrl({ path: project, token: 'secret-longer' }), options), { ok: false, reason: 'geen geldig token' });
});

test('rejects when Switchboard has no token', () => {
  const { project, options } = setup();
  const result = parseLaunchUrl(launchUrl({ path: project, token: '' }), { ...options, token: '' });
  assert.equal(result.ok, false);
});

test('rejects a folder outside the allowed root, also via .. or a symlink', () => {
  const { root, dev, options } = setup();
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dev, 'link'));
  for (const p of [outside, path.join(dev, '..', 'elsewhere'), path.join(dev, 'link'), `${dev}-evil`]) {
    if (p.endsWith('-evil')) fs.mkdirSync(p);
    const result = parseLaunchUrl(launchUrl({ path: p, token: 'secret' }), options);
    assert.equal(result.ok, false, p);
    assert.match(result.reason, /map buiten/);
  }
});

test('rejects a relative, missing or non-directory path', () => {
  const { project, options } = setup();
  const file = path.join(project, 'file.txt');
  fs.writeFileSync(file, '');
  for (const p of ['dev/project', path.join(project, 'nope'), file, '']) {
    assert.equal(parseLaunchUrl(launchUrl({ path: p, token: 'secret' }), options).ok, false, p);
  }
});

test('rejects other actions and schemes', () => {
  const { project, options } = setup();
  const query = new URLSearchParams({ path: project, token: 'secret' }).toString();
  assert.equal(parseLaunchUrl(`switchboard://resume?${query}`, options).ok, false);
  assert.equal(parseLaunchUrl(`https://new?${query}`, options).ok, false);
  assert.equal(parseLaunchUrl('not a url', options).ok, false);
});

test('decodes the percent-encoded URL the brief server sends', () => {
  const { project, options } = setup();
  const url = `switchboard://new?path=${encodeURIComponent(project)}&prompt=${encodeURIComponent('regel 1\nregel "2" & meer')}&token=secret`;
  const result = parseLaunchUrl(url, options);
  assert.equal(result.prompt, 'regel 1\nregel "2" & meer');
});

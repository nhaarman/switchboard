// switchboard://new?path=…&prompt=…&token=… — start a new session from outside
// the app (the brief dashboard's ▶ Claude button).
//
// Threat model: anything that is not a local process running as the user —
// web pages and links in mail or chat. Two layers keep those out:
//   1. a secret token in <userData>/launch-token (mode 0600) that only local
//      processes can read; compared in constant time, never rotated (delete the
//      file for a new one);
//   2. a folder whitelist: the session folder must exist and resolve (after
//      symlinks) to a directory under one of the allowed roots (~/dev).
// The URL can only set the folder and the first prompt: no flags, model or
// permission mode. Unknown parameters are ignored.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEME = 'switchboard';
const TOKEN_FILE = 'launch-token';

/** Read the launch token, creating it (mode 0600) on first use. */
function ensureLaunchToken(dir) {
  const file = path.join(dir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  // timingSafeEqual needs equal lengths; compare b to itself so a length
  // mismatch costs the same time as a content mismatch.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isUnder(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate a switchboard:// URL.
 * Returns { ok: true, projectPath, prompt } or { ok: false, reason } where
 * reason is a short Dutch sentence for the rejection notification.
 */
function parseLaunchUrl(rawUrl, { token, allowedRoots }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'ongeldige URL' };
  }
  if (url.protocol !== `${SCHEME}:`) return { ok: false, reason: 'onbekend scheme' };
  // switchboard://new parses "new" as the host; accept switchboard:new too.
  const action = url.hostname || url.pathname.replace(/^\/+/, '');
  if (action !== 'new') return { ok: false, reason: `onbekende actie "${action}"` };

  const given = url.searchParams.get('token');
  if (!given || !token || !tokensMatch(given, token)) {
    return { ok: false, reason: 'geen geldig token' };
  }

  const requested = url.searchParams.get('path');
  if (!requested || !path.isAbsolute(requested)) {
    return { ok: false, reason: 'geen absolute map opgegeven' };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, reason: `${requested} is geen map` };
  } catch {
    return { ok: false, reason: `map ${requested} bestaat niet` };
  }
  const roots = allowedRoots.map(root => {
    try { return fs.realpathSync(root); } catch { return path.resolve(root); }
  });
  if (!roots.some(root => isUnder(resolved, root))) {
    return { ok: false, reason: `map buiten ${allowedRoots.join(', ')}` };
  }

  const prompt = url.searchParams.get('prompt') || '';
  return { ok: true, projectPath: resolved, prompt };
}

module.exports = { SCHEME, TOKEN_FILE, ensureLaunchToken, parseLaunchUrl };

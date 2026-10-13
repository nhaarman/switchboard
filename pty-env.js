// Environment for PTY children.
//
// Three jobs:
//
// 1. Strip Electron internals that cause nested Electron apps (or node-pty
//    inside them) to malfunction.
//
// 3. Strip the markers Claude Code sets in the shells it runs. When Switchboard
//    itself was started from such a shell (a terminal with Claude in it), every
//    session it launched inherited them, believed it was a child session, and
//    saved no transcript: no history, no last message, nothing to resume.
//
// 2. Guarantee a UTF-8 character encoding. An app launched from Finder or the
//    Dock on macOS inherits no shell environment, so LANG/LC_* are simply
//    absent — launchd does not set them. Locale-sensitive tools then fall back
//    to the "standard C encoding", which on macOS means Mac OS Roman. `pbcopy`
//    is the one users notice: it reads UTF-8 bytes as Mac OS Roman, so an
//    agent response copied out of a session arrives on the clipboard as
//    "‚Ä¶‚Äî‚Üí" instead of "…—→" (issue #89).
//
//    LC_CTYPE alone is deliberate. It fixes character handling and nothing
//    else — collation, dates, and number formatting stay on the system
//    default rather than being forced to some guessed region.

const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];
// Set by Claude Code for the commands it runs, and tied to that one session:
// its id, process, IDE and messaging channels. A session Switchboard starts is
// a session of its own, never a child of whatever shell started Switchboard.
// Settings the user exports (CLAUDE_CODE_PLUGIN_DIRS, CLAUDE_CODE_USE_BEDROCK…) stay.
const CLAUDE_CODE_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_EFFORT',
]);

function buildPtyEnv(sourceEnv) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION' &&
      !CLAUDE_CODE_MARKERS.has(k)
    )
  );

  // Only when the parent handed us nothing usable — an inherited locale is the
  // user's own setting and must win. An empty value counts as absent, which is
  // what a GUI launch actually produces.
  if (!LOCALE_VARS.some((k) => env[k])) env.LC_CTYPE = 'UTF-8';

  return env;
}

module.exports = { buildPtyEnv };

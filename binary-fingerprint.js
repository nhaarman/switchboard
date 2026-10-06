// Identifies the on-disk build of an executable, so the pty daemon can tell
// when the app was reinstalled underneath it.
//
// This matters on macOS: TCC grants ("access data from other apps", Full Disk
// Access, …) are tied to the code signature of the process responsible for a
// shell. The daemon is that process for every session, and it outlives app
// updates on purpose. Once its binary has been replaced, a grant for the new
// build never applies to it, so the user is prompted over and over.
//
// An install replaces the file (new inode, new mtime), which is all we need to
// notice; we do not hash the binary.

const fs = require('fs');

function binaryFingerprint(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** True when the file at `filePath` is no longer the build `fingerprint` was taken of. */
function isBinaryReplaced(filePath, fingerprint) {
  if (!fingerprint) return false;
  return binaryFingerprint(filePath) !== fingerprint;
}

module.exports = { binaryFingerprint, isBinaryReplaced };

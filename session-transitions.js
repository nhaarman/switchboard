const path = require('path');
const fs = require('fs');

/**
 * Fork / plan-accept detection for active PTY sessions.
 * Call init(ctx) once with shared context.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, rekeyMcpServer, emitBusyState, archiveSession;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
  emitBusyState = ctx.emitBusyState;
  archiveSession = ctx.archiveSession;
}

// --- Fork / plan-accept detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
function readNewSessionSignals(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytesRead = fs.readSync(fd, buf, 0, 524288, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let planContent = false;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    let worktreeCreatorId = null;
    // /clear starts a fresh session in the same PTY. The command turn lands a
    // few entries in (after the local-command caveat), so scan the whole head
    // rather than relying on the per-entry loop below, which stops at the first
    // user/assistant message.
    const isClear = head.includes('<command-name>/clear</command-name>');
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      // A worktree session records the id of the session that created the
      // worktree; after a /clear it points back to the previous session.
      if (entry.type === 'worktree-state' && entry.worktreeSession && entry.worktreeSession.sessionId) {
        worktreeCreatorId = entry.worktreeSession.sessionId;
      }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.planContent) planContent = true;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    return { forkedFrom, planContent, slug, parentSessionId, hasSnapshots, isClear, worktreeCreatorId };
  } catch {
    return { forkedFrom: null, planContent: false, slug: null, parentSessionId: null, hasSnapshots: false, isClear: false, worktreeCreatorId: null };
  }
}

/** Read tail of old session file for ExitPlanMode and slug */
function readOldSessionTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const hasExitPlanMode = tail.includes('ExitPlanMode');
    // Extract slug from tail (last occurrence)
    let slug = null;
    const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
    if (slugMatches) {
      const last = slugMatches[slugMatches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
      if (last) slug = last[1];
    }
    return { hasExitPlanMode, slug };
  } catch {
    return { hasExitPlanMode: false, slug: null };
  }
}

/** Detect fork or plan-accept transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  // Live Claude PTYs in this folder. Used as the disambiguation anchor for a
  // /clear outside a worktree, where the new file carries no back-reference.
  let activeInFolder = 0;
  for (const s of activeSessions.values()) {
    if (!s.exited && !s.isPlainTerminal && s.projectFolder === folder) activeInFolder++;
  }

  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent) {
        // Fork file with only snapshots (no user turn yet) — match immediately
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} matching snapshot-only fork file=${newId}`);
          // Fall through to matching logic — will match via the fork-snapshot path below
        } else {
          let stale = false;
          try {
            const mtime = fs.statSync(path.join(folderPath, newFile)).mtimeMs;
            if (Date.now() - mtime > 3600000) stale = true;
          } catch {}
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      // Fork file with only snapshots — no user turn yet, but this session is waiting for a fork
      if (!matched && signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
        matched = true;
      }

      if (session.forkFrom && !matched) {
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      // /clear: the same PTY started a brand-new session. There are no fork or
      // plan signals, but a worktree session records the originating session id
      // in its worktree-state, which points back to this active PTY (or to the
      // session that first created the worktree — so repeated clears keep
      // chaining via session.worktreeCreatorId). Outside a worktree there is no
      // such anchor, so fall back to the sole live session in the folder.
      let clearMatch = false;
      if (!matched && signals.isClear && !session.forkFrom) {
        const creator = signals.worktreeCreatorId;
        if (creator) {
          if (creator === sessionId || creator === session.worktreeCreatorId) {
            matched = true;
            clearMatch = true;
          }
        } else if (activeInFolder === 1) {
          try {
            const oldMtime = fs.statSync(path.join(folderPath, sessionId + '.jsonl')).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            // New file appears right after the old one goes quiet.
            if (newMtime >= oldMtime - 1000 && newMtime - oldMtime < 120000) {
              matched = true;
              clearMatch = true;
            }
          } catch {}
        }
      }

      // Plan-accept: shared slug + planContent + old session has ExitPlanMode
      if (!matched && signals.planContent && signals.slug) {
        const oldFilePath = path.join(folderPath, sessionId + '.jsonl');
        const oldTail = readOldSessionTail(oldFilePath);
        if (oldTail.hasExitPlanMode && oldTail.slug === signals.slug) {
          // Temporal check: new file created within 30s of old file's last modification
          try {
            const oldMtime = fs.statSync(oldFilePath).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            if (Math.abs(newMtime - oldMtime) < 30000) {
              matched = true;
            }
          } catch {}
        }
      }

      if (matched) {
        const kind = clearMatch ? 'clear' : (signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept');
        log.info(`[session-transition] ${sessionId} → ${newId} (${kind})`);
        session.knownJsonlFiles = new Set(currentFiles);
        session.realSessionId = newId;
        // Remember the worktree originator so a second /clear still chains.
        if (clearMatch) session.worktreeCreatorId = signals.worktreeCreatorId || session.worktreeCreatorId || sessionId;
        // Update slug from new session
        if (signals.slug) session.sessionSlug = signals.slug;
        activeSessions.delete(sessionId);
        activeSessions.set(newId, session);
        // Re-key MCP server to match new session ID
        rekeyMcpServer(sessionId, newId);
        // /clear supersedes the previous conversation: archive it so it drops
        // out of the default list (still recoverable via the archive filter)
        // instead of lingering as a second, live-looking row.
        if (clearMatch && archiveSession) archiveSession(sessionId);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-forked', sessionId, newId);
        }
        // Re-assert the busy state under the new id. emitBusyState only pushes on
        // a change, so a session that was already busy before the fork would never
        // send its state under newId; clearing the last-emitted memo forces the
        // next emit through, keeping a background-working session out of "Ready".
        if (emitBusyState) {
          session._emittedBusy = undefined;
          emitBusyState(session, newId);
        }
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}


module.exports = { init, detectSessionTransitions };

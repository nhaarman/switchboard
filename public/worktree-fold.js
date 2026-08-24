// --- Fold worktree sub-projects into their parent project ---
//
// A session started with `--worktree` lives under `<project>/.claude/worktrees/
// <name>` and is cached as its own project (its projectPath ends there). The New
// Session picker used to filter those paths out entirely, so a project worked on
// all day via worktrees contributed nothing to its parent's recency or session
// count and sank to the bottom of the list. Instead we fold each worktree's
// sessions into the parent project, so worktree activity bubbles the parent up
// and is counted, while the worktree never shows as a separate row.
//
// Pure so it can be unit-tested without the renderer's DOM/IPC globals.

const WORKTREE_SUFFIX_RE = /\/\.claude\/worktrees\/[^/]+$/;

/**
 * Merge worktree projects into their parent, concatenating sessions.
 * @param {Array<{ projectPath: string, sessions: Array }>} projects
 * @returns {Array<{ projectPath: string, sessions: Array }>}
 */
function foldWorktreeProjects(projects) {
  const merged = new Map();
  for (const p of projects) {
    const canonicalPath = p.projectPath.replace(WORKTREE_SUFFIX_RE, '');
    let entry = merged.get(canonicalPath);
    if (!entry) {
      entry = { ...p, projectPath: canonicalPath, sessions: [] };
      merged.set(canonicalPath, entry);
    }
    entry.sessions = entry.sessions.concat(p.sessions);
  }
  return [...merged.values()];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { foldWorktreeProjects };
}

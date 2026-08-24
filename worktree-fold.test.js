const { test } = require('node:test');
const assert = require('node:assert');
const { foldWorktreeProjects } = require('./public/worktree-fold');

const mostRecent = (p) => p.sessions.reduce((m, s) => Math.max(m, new Date(s.modified).getTime()), 0);
const sortByRecency = (projects) => [...projects].sort((a, b) => mostRecent(b) - mostRecent(a));

test('worktree sessions are folded into their parent project', () => {
  const input = [
    { projectPath: '/Users/x/dev/RP3-Android', sessions: [{ modified: '2026-08-24T10:00:00.000Z' }] },
    { projectPath: '/Users/x/dev/RP3-Android/.claude/worktrees/sunny-baking-dream', sessions: [{ modified: '2026-08-24T10:47:00.000Z' }] },
    { projectPath: '/Users/x/dev/RP3-Android/.claude/worktrees/composed-hatching-whistle', sessions: [{ modified: '2026-08-24T10:49:00.000Z' }] },
  ];
  const out = foldWorktreeProjects(input);
  assert.strictEqual(out.length, 1, 'worktrees collapse into one parent entry');
  assert.strictEqual(out[0].projectPath, '/Users/x/dev/RP3-Android');
  assert.strictEqual(out[0].sessions.length, 3, 'all sessions counted toward the parent');
});

test('folded worktree activity lifts the parent up the recency sort', () => {
  const input = [
    { projectPath: '/Users/x/dev/Other', sessions: [{ modified: '2026-08-24T10:30:00.000Z' }] },
    { projectPath: '/Users/x/dev/RP3-Android', sessions: [{ modified: '2026-08-24T09:00:00.000Z' }] },
    { projectPath: '/Users/x/dev/RP3-Android/.claude/worktrees/wt', sessions: [{ modified: '2026-08-24T10:59:00.000Z' }] },
  ];
  const sorted = sortByRecency(foldWorktreeProjects(input));
  assert.strictEqual(sorted[0].projectPath, '/Users/x/dev/RP3-Android', 'worktree recency wins over a non-worktree parent');
});

test('a project worked on ONLY via worktrees still appears (under its parent)', () => {
  const input = [
    { projectPath: '/Users/x/dev/WRC/.claude/worktrees/squishy', sessions: [{ modified: '2026-08-24T10:43:00.000Z' }] },
  ];
  const out = foldWorktreeProjects(input);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].projectPath, '/Users/x/dev/WRC');
  assert.strictEqual(out[0].sessions.length, 1);
});

test('non-worktree projects pass through untouched', () => {
  const input = [
    { projectPath: '/Users/x/dev/A', sessions: [{ modified: '2026-08-24T10:00:00.000Z' }] },
    { projectPath: '/Users/x/dev/B', sessions: [] },
  ];
  const out = foldWorktreeProjects(input);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((p) => p.projectPath).sort(), ['/Users/x/dev/A', '/Users/x/dev/B']);
});

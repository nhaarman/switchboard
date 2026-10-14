// --- Sidebar rendering ---
// The session list is flat: one list of sessions across all projects, never
// grouped by directory. Sessions waiting on the user sort to the top, then the
// ones that finished unread, then the ones still working — each block most
// recent first.
// Sessions belonging to the same slug are still folded into a slug group.
//
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml, shortProjectPath (utils.js),
// ICONS (icons.js), showSession (terminal-manager.js), confirmAndStopSession,
// pollActiveSessions, showResumeSessionDialog, showJsonlViewer, forkSession,
// openSession, loadProjects, markUnread, clearUnread, refreshSidebar
// (app.js/dialogs.js)

const WORKTREE_PATTERN = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

// A session counts as running while its PTY is alive, or while it's pending —
// a just-launched session has no PTY in activePtyIds until the next poll. A
// pending session whose process died is marked exited and no longer counts.
// Also used by the Projects tab (projects-view.js).
function isSessionRunning(sessionId) {
  if (activePtyIds.has(sessionId)) return true;
  const pending = pendingSessions.get(sessionId);
  return !!pending && !pending.exited;
}

function slugId(slug, projectPath) {
  return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Label shown on every row now that directory headers are gone. Worktrees read
// as "parent ⑂ branch" — their raw path ends in .claude/worktrees/<name>, which
// shortProjectPath would render as the useless "worktrees/<name>".
function projectLabel(projectPath) {
  if (!projectPath) return '';
  const match = projectPath.match(WORKTREE_PATTERN);
  if (match) return shortProjectPath(match[1]) + ' ⎇ ' + match[2];
  return shortProjectPath(projectPath);
}

function buildSlugGroup(slug, sessions, projectPath) {
  const group = document.createElement('div');
  const id = slugId(slug, projectPath);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="session-project">${escapeHtml(projectLabel(projectPath))}</span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session, projectPath));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session, projectPath));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session, projectPath));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

// Sort tiers, highest first. The active block is split by what the session
// wants from the user: first the ones blocking on input, then the ones that
// finished and haven't been read, then the ones still working. Those three
// always outrank pinned and plain recent rows regardless of age.
const TIER_ATTENTION = 4;
const TIER_READY = 3;
const TIER_RUNNING = 2;
const TIER_PINNED = 1;
const TIER_REST = 0;

const TIER_LABELS = {
  [TIER_ATTENTION]: 'Needs input',
  [TIER_READY]: 'Ready',
  [TIER_RUNNING]: 'Working',
  [TIER_PINNED]: 'Pinned',
  [TIER_REST]: 'Recent',
};

// A live session that isn't spinning has finished its turn, whether or not the
// user has read it yet — both count as ready. Only a session reported as busy (or
// one still starting up) is working. Busy state comes from the OSC 0 spinner and
// from the background-agent poller, so a session idle since before this window
// opened reads as ready, which is what it is.
function sessionTier(sessionId) {
  if (attentionSessions.has(sessionId)) return TIER_ATTENTION;
  if (responseReadySessions.has(sessionId)) return TIER_READY;
  if (sessionBusyState.get(sessionId) || pendingSessions.has(sessionId)) return TIER_RUNNING;
  if (activePtyIds.has(sessionId)) return TIER_READY;
  return TIER_REST;
}

function itemTier(item) {
  if (item.tier >= TIER_RUNNING) return item.tier;
  if (item.pinned) return TIER_PINNED;
  return TIER_REST;
}

function renderSessionList(projects, resort) {
  const newSidebar = document.createElement('div');
  const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || showArchived || searchMatchIds !== null;

  function passesFilters(sessions) {
    let filtered = sessions;
    // The archive filter is the only way archived sessions surface: when it's on
    // we show exactly the archived ones, when it's off they're hidden entirely.
    if (showArchived) filtered = filtered.filter(s => s.archived);
    if (showStarredOnly) filtered = filtered.filter(s => s.starred);
    if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
    if (showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter(s => {
        if (!s.modified) return false;
        const d = new Date(s.modified);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    return filtered;
  }

  // Flatten every project's sessions into one list of render items. Sessions
  // sharing a slug still collapse into a slug group, but only within their own
  // project — the same slug in two checkouts stays two groups.
  const allItems = [];
  for (const project of projects) {
    const projectPath = project.projectPath;
    const filtered = passesFilters(project.sessions);
    if (filtered.length === 0) continue;

    const slugMap = new Map();
    const ungrouped = [];
    for (const session of filtered) {
      if (session.slug) {
        if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
        slugMap.get(session.slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }

    for (const session of ungrouped) {
      allItems.push({
        sortTime: new Date(session.modified).getTime(),
        pinned: !!session.starred,
        tier: sessionTier(session.sessionId),
        element: buildSessionItem(session, projectPath),
      });
    }
    for (const [slug, sessions] of slugMap) {
      const sorted = [...sessions].sort((a, b) => new Date(b.modified) - new Date(a.modified));
      const element = sorted.length === 1
        ? buildSessionItem(sorted[0], projectPath)
        : buildSlugGroup(slug, sorted, projectPath);
      allItems.push({
        sortTime: Math.max(...sorted.map(s => new Date(s.modified).getTime())),
        pinned: sorted.some(s => s.starred),
        tier: Math.max(...sorted.map(s => sessionTier(s.sessionId))),
        element,
      });
    }
  }

  // Order: sessions needing input first, then finished-but-unread, then still
  // working, then pinned, then the rest. A session changing state moves to its
  // new block, but inside a block nothing is re-ordered: the previous order is
  // preserved unless the caller asked for a re-sort, so rows never shuffle
  // under the cursor. Rows the previous render didn't have go on top of their
  // block, most recent first.
  const prevIndex = new Map(sortedOrder.map((id, i) => [id, i]));
  allItems.sort((a, b) => {
    const aTier = itemTier(a);
    const bTier = itemTier(b);
    if (aTier !== bTier) return bTier - aTier;
    if (resort || prevIndex.size === 0) return b.sortTime - a.sortTime;
    const aPos = prevIndex.get(a.element.id);
    const bPos = prevIndex.get(b.element.id);
    if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
    if (aPos === undefined && bPos !== undefined) return -1;
    if (aPos !== undefined && bPos === undefined) return 1;
    return b.sortTime - a.sortTime;
  });

  // Truncate: active and pinned rows are never hidden, the rest are capped by
  // visibleSessionCount and the age cutoff.
  let visible = [];
  let older = [];
  if (anyFilterActive) {
    visible = allItems;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
    for (const item of allItems) {
      if (item.tier >= TIER_RUNNING || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
        visible.push(item);
        count++;
      } else {
        older.push(item);
      }
    }
    if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
  }

  const list = document.createElement('div');
  list.className = 'session-list';
  list.id = 'session-list';

  let lastTier = null;
  for (const item of visible) {
    const tier = itemTier(item);
    if (!anyFilterActive && tier !== lastTier) {
      const label = document.createElement('div');
      label.className = 'session-section-label';
      label.id = 'section-' + tier;
      label.textContent = TIER_LABELS[tier];
      list.appendChild(label);
      lastTier = tier;
    }
    list.appendChild(item.element);
  }

  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-all';

    const moreLabel = document.createElement('span');
    moreLabel.className = 'sessions-more-label';

    const archiveOlderBtn = document.createElement('button');
    archiveOlderBtn.className = 'sessions-older-archive-btn';
    archiveOlderBtn.title = 'Archive all older sessions';
    archiveOlderBtn.setAttribute('aria-label', 'Archive all older sessions');
    archiveOlderBtn.innerHTML = ICONS.archive(14);

    moreBtn.appendChild(moreLabel);
    moreBtn.appendChild(archiveOlderBtn);
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-all';
    olderList.style.display = 'none';
    for (const item of older) olderList.appendChild(item.element);
    // An older render item can be a slug group containing several sessions.
    // Count the actual unarchived session rows so this label matches the
    // archive confirmation and the work the archive button will perform.
    const olderSessionCount = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    moreLabel.textContent = `+ ${olderSessionCount} older`;
    list.appendChild(moreBtn);
    list.appendChild(olderList);
  }

  newSidebar.appendChild(list);

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
        return false;
      }
      if (fromEl.classList.contains('slug-group')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        const label = toEl.querySelector('.sessions-more-label');
        if (label) label.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the rendered order as the source of truth for the next render
  sortedOrder = allItems.map(item => item.element.id);

  rebindSidebarEvents();

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents() {

  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          forgetTerminalHistory(sid);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    const moreLabel = moreBtn.querySelector('.sessions-more-label');
    moreBtn.onclick = (e) => {
      if (e.target.closest('.sessions-older-archive-btn')) return;
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      if (moreLabel) moreLabel.textContent = showing ? `+ ${count} older` : '- hide older';
    };

    const archiveOlderBtn = moreBtn.querySelector('.sessions-older-archive-btn');
    if (archiveOlderBtn) {
      archiveOlderBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = [...olderList.querySelectorAll('.session-item')]
          .map(item => sessionMap.get(item.dataset.sessionId))
          .filter(session => session && !session.archived);
        if (sessions.length === 0) return;
        if (!confirm(`Archive all ${sessions.length} older session${sessions.length > 1 ? 's' : ''}?`)) return;
        for (const session of sessions) {
          if (activePtyIds.has(session.sessionId)) {
            await window.api.stopSession(session.sessionId);
          }
          await window.api.archiveSession(session.sessionId, 1);
          forgetTerminalHistory(session.sessionId);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        // Nothing to stop on a session that never started: the same control
        // clears the row instead, which is otherwise unremovable.
        if (isDismissibleSession(session.sessionId)) dismissSession(session.sessionId);
        else confirmAndStopSession(session.sessionId);
      };
    }

    const unreadBtn = item.querySelector('.session-unread-btn');
    if (unreadBtn) {
      unreadBtn.onclick = (e) => {
        e.stopPropagation();
        if (responseReadySessions.has(session.sessionId)) {
          clearUnread(session.sessionId);
        } else {
          markUnread(session.sessionId);
        }
        refreshSidebar();
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const moreBtn = item.querySelector('.session-more-btn');
    if (moreBtn) {
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const menuItems = [
          { label: 'Rename session', onClick: () => startRename(item.querySelector('.session-summary'), session) },
          { label: 'Copy session ID', onClick: () => window.api.writeClipboard(session.sessionId) },
        ];
        if (session.type !== 'terminal') {
          menuItems.push(
            { label: 'View messages', onClick: () => showJsonlViewer(session) },
            { label: 'Move to project…', onClick: () => showMovePopover(session, moreBtn) },
          );
          if (!isSessionRunning(session.sessionId)) {
            menuItems.unshift({ label: 'Resume with config…', onClick: () => showResumeSessionDialog(session) });
          }
        }
        if (isDismissibleSession(session.sessionId)) {
          menuItems.push({ label: 'Dismiss session', onClick: () => dismissSession(session.sessionId) });
        }
        showContextMenu(menuItems, { anchor: moreBtn });
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        if (newVal) forgetTerminalHistory(session.sessionId);
        session.archived = newVal;
        loadProjects();
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session, projectPath) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.runtime && session.runtime !== 'claude') item.classList.add('is-' + session.runtime);
  if (session.launchFailed) item.classList.add('launch-failed');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Title and star share the top line; status and actions sit below.
  const pin = document.createElement('button');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.type = 'button';
  pin.title = session.starred ? 'Unstar session' : 'Star session';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(!!session.starred));
  pin.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${session.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3z"/></svg>`;

  // Keep the status dot separate so running, busy and unread updates still apply.
  const mark = document.createElement('span');
  mark.className = 'session-mark';

  const markIcon = document.createElement('span');
  markIcon.className = 'session-mark-icon';
  if (session.type === 'terminal') {
    markIcon.innerHTML = ICONS.terminal(14);
    mark.title = 'Terminal session';
  } else if (session.runtime === 'codex') {
    markIcon.innerHTML = ICONS.codex(14);
    mark.title = 'Codex session';
  } else {
    markIcon.innerHTML = ICONS.claude(14);
    mark.title = 'Claude session';
  }

  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');
  mark.append(markIcon, dot);

  const header = document.createElement('div');
  header.className = 'session-header';
  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;
  header.append(summaryEl, pin);

  const footer = document.createElement('div');
  footer.className = 'session-footer';
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  // The 30-second ticker updates this span, including the message count.
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.title = session.sessionId;
  timeEl.textContent = timeStr + (session.messageCount ? ' · ' + session.messageCount + ' msgs' : '');
  // The directory is no longer a header above the row, so each row names its
  // own project (and branch, for worktrees).
  const projectEl = document.createElement('span');
  projectEl.className = 'session-project';
  const label = projectLabel(projectPath || session.projectPath);
  projectEl.textContent = label;
  projectEl.title = projectPath || session.projectPath || '';
  metaEl.append(mark);
  if (label) metaEl.appendChild(projectEl);
  metaEl.appendChild(timeEl);
  // Started by a scheduled task: a clock, with which one and when in its tooltip.
  if (session.scheduleId && typeof scheduleChipHtml === 'function') {
    const chip = document.createElement('span');
    chip.className = 'session-schedule-chip';
    chip.innerHTML = scheduleChipHtml(session, { compact: true });
    metaEl.appendChild(chip);
  }

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  const dismissible = typeof isDismissibleSession === 'function' && isDismissibleSession(session.sessionId);
  stopBtn.className = 'session-stop-btn' + (dismissible ? ' session-dismiss-btn' : '');
  stopBtn.title = dismissible ? 'Dismiss session' : 'Stop session';
  stopBtn.innerHTML = dismissible
    ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const isUnread = responseReadySessions.has(session.sessionId);
  const unreadBtn = document.createElement('button');
  unreadBtn.className = 'session-unread-btn';
  unreadBtn.title = isUnread ? 'Mark as read' : 'Mark as unread';
  unreadBtn.innerHTML = isUnread ? ICONS.markRead(14) : ICONS.markUnread(14);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'session-more-btn';
  moreBtn.title = 'More session actions';
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  if (session.type !== 'terminal') {
    actions.append(archiveBtn, forkBtn);
  }
  actions.append(unreadBtn, stopBtn, moreBtn);
  for (const button of actions.children) {
    button.type = 'button';
    button.setAttribute('aria-label', button.title);
  }

  footer.append(metaEl, actions);
  row.append(header, footer);

  // Failed launch (e.g. `--worktree` on a pre-existing branch): the session never
  // produced a transcript. Make it read as failed and hint that clicking retries.
  if (session.launchFailed) {
    const failEl = document.createElement('div');
    failEl.className = 'session-launch-failed';
    failEl.textContent = 'launch failed · click to retry';
    row.appendChild(failEl);
  }

  item.appendChild(row);

  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}

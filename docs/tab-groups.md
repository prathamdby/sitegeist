# Background Tab Groups

Opt-in behavior behind the Tabs settings toggle (off by default).

## Model

- One session owns one tab group plus one pinned panel tab (D1). The panel
  stays on the tab it was opened on; the agent's acting tab moves inside the
  group as it works.
- A new session spawns its own inactive worker tab in a fresh "Sitegeist"
  group. The user's tab is never grouped and never acted on: plain
  navigation goes to the acting worker tab, and new tabs open inactive
  inside the group.
- Every tab-touching call resolves through `src/browser/session-tabs.ts`:
  acting tab first, legacy active tab only when the flag is off or no scope
  exists.

## Enable

Settings → Tabs → Background tabs. Takes effect for new sessions; existing
sessions adopt a group when reopened. Stored as `tabScope.enabled` in both
the settings record and `chrome.storage.local` (the channel the background
worker can read).

## Parallel sessions

- One panel runs one session. Pressing + in the same panel aborts the
  running agent and starts over there.
- For two independent sessions: the header's pop-out button (or the
  extension icon on another tab) opens a fresh panel on a new tab. Each
  panel binds to its own tab, owns its own worker group, and keeps
  streaming while you look at the other tab. Put the two tabs in two
  windows to watch both side by side.
- A session bound to one tab cannot be opened by another tab's panel: the
  background denies the lock while the owner tab is alive, and the session
  list shows it as locked. Switching sessions releases the scope so the
  old session is immediately adoptable elsewhere.

## Tool behavior when on

- `navigate`: new tabs open inactive (`active:false`) and are grouped;
  `listTabs` reports only group tabs; `switchToTab` rejects foreign ids
  before any focus change.
- `browserjs()`, overlay, debugger, element picker, skill URL, native input:
  act on the session's acting tab, never the global active tab.
- Screenshots: the visible-tab fast path runs only when the acting tab is
  the visible tab of its window; otherwise capture goes through the
  debugger protocol, so the agent never receives a foreign tab's pixels.
- Rendered tab pills and navigation messages open tabs inactive in-group.
  User clicks are explicit gestures and may still focus tabs.

## Lifecycle

- The background (`src/background.ts`) owns `sessionId -> {groupId,
  boundTabId, actingTabId, windowId}` in `chrome.storage.session`, so state
  survives service worker sleep.
- One tab group per session: the assignment `sessionId -> groupId`
  (`tab_groups` in `chrome.storage.session`) persists across session
  switches. Switching releases only the panel binding, never the
  assignment. A new group is created only when the recorded group is gone
  (deleted, empty, or unverifiable). Group deletion clears the assignment
  via `tabGroups.onRemoved`.
- Bound tab closed → scope released. Acting tab closed → falls back to the
  bound tab. Group deleted by the user → binding kept, group id cleared so
  the next run recreates it. Tab replaced (crash restore) → ids remapped.
  Window closed → scopes for that window released.
- Port disconnect (session switch, panel close, crash, reload) releases the
  scope, mirroring the existing session-lock behavior in
  `docs/multi-window.md`.

## Edge cases

- Restricted URLs (`chrome://`, `chrome-extension://`, `about:`) cannot run
  scripts; tools report errors instead.
- OAuth tabs open outside the group and may take focus; they are user-driven.
- Moving the bound tab out of its group keeps the recorded scope rather
  than adopting foreign tabs.
- `chrome.tabs.captureVisibleTab` can only see the visible tab, hence the
  debugger path for background tabs.
- Parallel sessions in two windows each stream against their own group;
  navigation events from foreign tabs never steer another session's agent.

## Kill switch

Turn the toggle off: all callers fall back to window-scoped behavior. No
schema migration is involved (groups are runtime Chrome state; session
records are unchanged), so nothing needs backfilling on rollback.

## Group click opens session

Clicking a tab that belongs to another session's group opens that session
in the clicked tab's panel:

- Same-session clicks are ignored here; the existing in-group steer logic
  owns them.
- When the owning panel tab is still alive, the click reveals it
  (`sidePanel.open` on the bound tab) instead of moving the session.
- When no live owner exists, the click adopts the session in place: the
  session id is stashed under `tabGroup.pendingSession` in
  `chrome.storage.session`, the panel is rebound with
  `sidePanel.setOptions` to `sidepanel.html?session=...&tabId=...`, and the
  panel is opened on the clicked tab. On load, `initApp` consumes the
  stashed id only when the URL carries no session of its own.
- Idle-only rule: adoption happens only when this panel is not streaming.
  While this panel streams, the click is silently ignored and the other
  session keeps running.
- Agent-driven activations (`switchToTab` navigating) never trigger a
  switch; the handler returns early while a tool navigation is in flight.
- The pure decision matrix lives in `src/browser/group-open.ts`
  (`resolveGroupClick`) and is covered by
  `tests/tab-group-open-contract.test.mjs`.
